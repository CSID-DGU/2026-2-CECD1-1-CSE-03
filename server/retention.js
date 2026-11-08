'use strict';
// 원문 파기 — 종결 케이스를 제자리 가명화한다(행은 남기고 본문·주소·이름·자유 텍스트를 비운다). 무수정 승인률·승격 지표는 파기 전후가 같다.
// 지우는 행은 case_threads와 회차 claim(`loop:<케이스>:…`)뿐이다 — 옛 스레드·In-Reply-To로 온 회신이 파기된 케이스에 붙지 않고 새 케이스가 되고,
// 재시작 복구가 판단이 안 끝난 메시지로 보고 파기된 케이스에 회차를 다시 돌리지 않는다.
// 남는 것: claims의 `mailbox:<Message-ID>`(중복 수신 방지에 필요, 발신 도메인 정도), 상태·행동·intent·edit_tags·승인자, final_body의 NULL 여부.
// CRM 문서(server/collections.js)도 같은 트랜잭션에서 비운다 — 이벤트 원문, 케이스 문서의 제목·이름·주소, 활동 본문, 그 주소의 마지막 케이스면 문의자까지.
const db = require('./db');
const collections = require('./collections');

/** RETENTION_DAYS → 일 수. 비었거나 1 이상 정수가 아니면 null(끔) — 잘못된 값으로 지우는 쪽보다 안 지우는 쪽이 안전하다. */
function days(env = process.env) {
  const n = Number(env.RETENTION_DAYS);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// activities.payload에서 남기는 키 — 지표·감사에 쓰는 코드 값뿐. 메모·평가 메모·발송 오류 문구는 빠진다.
const KEEP = ['draftId', 'rating', 'editTags', 'expiredFacts', 'outcome', 'ack', 'days', 'reason'];

function scrubPayload(type, payload) {
  if (payload == null) return null;
  let p; try { p = JSON.parse(payload); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  // 폐기 사유는 담당자가 API로 넣은 자유 텍스트다
  return JSON.stringify(Object.fromEntries(KEEP.filter((k) => k in p && !(k === 'reason' && type === 'discard')).map((k) => [k, p[k]])));
}

/**
 * 케이스 하나를 한 트랜잭션으로 파기한다. 종결·미파기가 아니거나 회차가 도는 중이면 아무것도 안 하고 false.
 * 첫 문장이 상태를 다시 확인한다 — "종결인가" 검사와 파기 사이에 회신이 케이스를 다시 열면 새 고객 메시지까지 지워진다.
 * 리스(lease_until)가 살아 있으면 회차가 원문을 들고 LLM을 기다리는 중이다 — 끝나면서 파기된 케이스에 판단·초안을 쓴다. 다음 번에 다시 본다.
 */
function purge(caseId, { reason, actor }) {
  const now = db.now();
  return db.tx(() => {
    const email = db.get('SELECT customer_email FROM cases WHERE id=?', caseId)?.customer_email;
    if (!db.run(`UPDATE cases SET customer_email='', customer_name=NULL, subject=NULL, known_facts='{}', close_detail=NULL, hold_note=NULL, purged_at=?
      WHERE id=? AND state='CLOSED' AND purged_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM loops l WHERE l.case_id=cases.id AND l.lease_until > ?)`, now, caseId, now).changes) return false;
    db.run("UPDATE messages SET body='', body_clean='', sender='', subject=NULL, provider_message_id=NULL WHERE case_id=?", caseId);
    db.run("UPDATE drafts SET original_body='', final_body=CASE WHEN final_body IS NULL THEN NULL ELSE '' END, error=NULL WHERE case_id=?", caseId);
    // SMTP 거부 문구에는 수신 주소가 들어 있다
    db.run('UPDATE dispatches SET error=NULL WHERE draft_id IN (SELECT id FROM drafts WHERE case_id=?)', caseId);
    db.run("UPDATE decisions SET input_summary=NULL, output='{}' WHERE case_id=?", caseId);
    db.run("UPDATE handoffs SET briefing='{}' WHERE case_id=?", caseId);
    for (const a of db.all('SELECT id, type, payload FROM activities WHERE case_id=?', caseId)) {
      db.run('UPDATE activities SET payload=? WHERE id=?', scrubPayload(a.type, a.payload), a.id);
    }
    // LLM 장애 재시도 예약도 지운다 — 남으면 스위퍼가 파기된 케이스에 회차를 돌려 다시 연다
    db.run("UPDATE loops SET last_outbound_gist=NULL, queue='[]', next_retry_at=NULL, retry_count=0, retry_message_id=NULL WHERE case_id=?", caseId);
    db.run('DELETE FROM claims WHERE key LIKE ?', `loop:${caseId}:%`);
    db.run('DELETE FROM case_threads WHERE case_id=?', caseId);
    db.insert('activities', { id: db.uuid(), case_id: caseId, type: 'purge', actor, payload: JSON.stringify({ reason }), created_at: now });
    collections.anonymizeCase(caseId, email); // 이후 flush는 같은 결과라 아무것도 쓰지 않는다
    return true;
  });
}

/**
 * 파기 묶음 뒤 — WAL에 남은 옛 페이지(원문)를 DB 파일로 옮기고 WAL을 비운다. 지운 자리는 secure_delete(db.init)가 0으로 덮는다. :memory:는 할 일이 없다.
 * 단순화: 다른 연결이 읽는 중이면 WAL을 다 못 비운다(busy) — 남은 프레임은 뒤의 체크포인트가 덮어 쓴다.
 */
const checkpoint = () => db.get('PRAGMA wal_checkpoint(TRUNCATE)');

/** 종결 뒤 보존 기간이 지난 케이스를 케이스마다 짧은 트랜잭션으로 파기한다. 보존 기간이 꺼져 있으면 0. */
function purgeExpired(now = Date.now(), n = days()) {
  if (!n) return 0;
  const cutoff = new Date(now - n * 86_400_000).toISOString();
  const ids = db.all("SELECT id FROM cases WHERE state='CLOSED' AND purged_at IS NULL AND closed_at < ?", cutoff);
  const done = ids.filter(({ id }) => purge(id, { reason: 'retention', actor: 'system' })).length;
  if (done) checkpoint();
  return done;
}

/** 정보주체 요청 대상 — 케이스 주소 또는 받은 메시지 발신 주소가 그 이메일인 케이스(폼 메일은 발신 주소가 다를 수 있다). */
function findSubject(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  return db.all(`SELECT id, state FROM cases c WHERE c.customer_email=?
    OR EXISTS (SELECT 1 FROM messages m WHERE m.case_id=c.id AND m.sender=?) ORDER BY c.created_at, c.rowid`, e, e);
}

module.exports = { days, purge, purgeExpired, findSubject, checkpoint, scrubPayload };
