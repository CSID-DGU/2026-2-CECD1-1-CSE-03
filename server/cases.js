'use strict';
// 케이스·스레드·메시지 서비스. 수신(addInbound)과 조회(list/get/stats). 상태 전이는 setState 하나로만.
const db = require('./db');
const events = require('./events');
const policy = require('./policy');
const kbLoader = require('./kb');
const mail = require('./mail');
const { CONTACT_RE } = require('./guard');
const prefilter = require('./prefilter');
const collections = require('./collections');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

// 인용 머리. 한국어 날짜 머리는 끝 콜론이 있어도 없어도 된다 — Gmail 한국어는 "…님이 작성:"으로 끝난다.
const QUOTE_HEAD_RE = /^(On .+wrote:|-{2,}\s*Original Message\s*-{2,}|_{5,}|\d{4}년 \d{1,2}월 \d{1,2}일 .+(작성|쓴 글|wrote):?|보낸 사람: .+|From: .+)$/;
const SEND_CHECK_MS = 2 * 60 * 1000; // SENDING이 이보다 오래 남으면 "발송 확인 필요"

/** 인용·서명 제거. `>` 줄은 버리고 인용 머리·서명 구분선부터는 자른다. */
function stripQuotes(body) {
  const out = [];
  for (const line of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^-- ?$/.test(line) || QUOTE_HEAD_RE.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 표시 이름은 메일 인사말에 그대로 들어간다 — 글자·숫자·공백·.-만, 30자. 비면 "고객". */
const sanitizeName = (n) => String(n || '').replace(/[^\p{Script=Hangul}A-Za-z0-9 .-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 30).trim() || '고객';

const parseFrom = (from, name) => {
  const m = String(from || '').match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  return m ? { email: m[2].trim().toLowerCase(), name: name || m[1].trim() || null } : { email: String(from || '').trim().toLowerCase(), name: name || null };
};

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/**
 * 문의 폼 메일(backlog B17)의 고객 주소·이름 — Reply-To → 제목의 주소 → 본문 이메일 칸 순. 폼 도메인 주소는 고르지 않는다.
 * 이름은 본문 이름 칸(줄 머리의 `이름:`·`성함:`·`name:`).
 */
function formSender({ replyTo, subject, body }) {
  const pick = (s) => (String(s || '').match(EMAIL_RE) || []).map((e) => e.toLowerCase()).find((e) => !policy.isFormAddress(e));
  const field = String(body || '').match(/(?:이메일|e-?mail|메일\s*주소)\s*[:：]\s*([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i)?.[1];
  const name = String(body || '').match(/^\s*(?:이름|성함|name)\s*[:：]\s*(.+)$/im)?.[1].trim();
  return { email: pick(replyTo) || pick(subject) || pick(field), name: name || null };
}

const CONTACT_KEY_RE = /이메일|메일\s*주소|email|e-mail|전화|연락처|phone|휴대폰|핸드폰|mobile|^\s*(hp|tel|cell)\s*$|cell\s*phone/i;
/** 폼 값에서 연락처는 뺀다 — LLM 입력·브리핑에 개인정보가 들어가지 않게. 키 이름과 값 모양 둘 다 본다. */
function sanitizeFacts(facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts || {})) {
    if (CONTACT_KEY_RE.test(k) || CONTACT_RE.test(String(v))) continue;
    out[k] = v;
  }
  return out;
}

function claim(key) {
  try { db.insert('claims', { key, created_at: db.now() }); return true; } catch (e) { if (db.isUnique(e)) return false; throw e; }
}
const releaseClaim = (key) => db.run('DELETE FROM claims WHERE key=?', key);

/** 원문을 파기한 케이스는 어떤 상태·담당·메모도 바꾸지 않는다 — HTTP 409와 별개로 서비스 함수가 직접 막는다. */
function assertNotPurged(caseId) {
  if (db.get('SELECT purged_at FROM cases WHERE id=?', caseId)?.purged_at) throw new HttpError(409, 'purged');
}

function setState(caseId, state, patch = {}) {
  assertNotPurged(caseId);
  const extra = Object.keys(patch);
  // 종결 케이스는 closed_at을 비우는 호출(회신 재오픈·reopenCase)로만 연다. 회차 시작(AGENT_ACTIVE)·LLM 재시도 예약(OPEN)은 그 사이 종결된
  // 케이스를 건드리지 않는다 — 종결 케이스에 붙은 자동 회신·종결 뒤 늦게 돈 회차는 실행 단계가 closed로 멈춘다
  const keepClosed = (state === 'AGENT_ACTIVE' || state === 'OPEN') && patch.closed_at !== null ? " AND state<>'CLOSED'" : '';
  db.run(`UPDATE cases SET state=?, updated_at=?${extra.map((k) => `, ${k}=?`).join('')} WHERE id=?${keepClosed}`, state, db.now(), ...extra.map((k) => patch[k]), caseId);
  const c = db.get('SELECT state, responder FROM cases WHERE id=?', caseId);
  events.emit('case.updated', { caseId, state: c.state, responder: c.responder });
}

function setResponder(caseId, responder, { by, reason }) {
  assertNotPurged(caseId);
  db.run('UPDATE cases SET responder=?, responder_changed_at=?, responder_changed_by=?, responder_change_reason=?, updated_at=? WHERE id=?', responder, db.now(), by, reason, db.now(), caseId);
}

const hasPending = (caseId) => !!db.get("SELECT 1 FROM drafts WHERE case_id=? AND status='PENDING' LIMIT 1", caseId);
const hasSending = (caseId) => !!db.get("SELECT 1 FROM drafts WHERE case_id=? AND status='SENDING' LIMIT 1", caseId);
const hasOut = (caseId) => !!db.get("SELECT 1 FROM messages WHERE case_id=? AND direction='out' LIMIT 1", caseId);

/** 에이전트 쪽 케이스의 "쉬는" 상태 — 승인 대기 초안이 있으면 AWAITING_APPROVAL, 답한 적 있으면 고객 회신 대기, 아니면 신규. */
const restingState = (caseId) => (hasPending(caseId) ? 'AWAITING_APPROVAL' : hasOut(caseId) ? 'WAITING_CUSTOMER' : 'OPEN');

/** 불변식: AWAITING_APPROVAL인데 PENDING 초안이 없으면 안 된다. 상태를 되돌리는 모든 곳이 이걸 거친다. */
function settle(caseId) {
  const c = db.get('SELECT state FROM cases WHERE id=?', caseId);
  if (c && c.state === 'AWAITING_APPROVAL' && !hasPending(caseId)) setState(caseId, restingState(caseId));
}

// In-Reply-To/References 값 → 비교 키(`<id>`·`id` 둘 다). 어댑터마다 꺾쇠를 붙이기도 떼기도 한다.
const refKeys = (...v) => [...new Set(v.flat().filter(Boolean).flatMap((x) => String(x).split(/[\s,]+/))
  .map((x) => x.replace(/^<|>$/g, '')).filter(Boolean))].slice(-50).flatMap((x) => [x, `<${x}>`]);

/**
 * 메일 수신. 스레드 id 또는 In-Reply-To/References가 아는 메일이면 그 케이스에 붙이고, 없으면 케이스를 연다. 루프는 돌리지 않는다(호출자가 runCycle).
 * 찾은 케이스가 종결이면 같은 케이스를 다시 연다(응대 주체는 그대로 — 사람 전담이면 사람 전담). 종결 사유·상세는 비우고 재오픈 활동에 남긴다
 * (감사 인사뿐이면 recloseCourtesy가 되돌린다). 자동 회신·빈 본문(회차의 1차 거르기와 같은 판정)은 종결 케이스에 붙기만 하고 열지 않는다.
 * occurredAt은 신뢰할 수 있는 수신 어댑터(INBOUND_SECRET 검증)만 넘긴다 — index.js가 걸러 준다. senderAuth도 같다(`pass`·`fail`만 저장, 그 밖은 NULL = 정보 없음).
 * 문의 폼 발신(FORM_SENDER_DOMAINS)이면 고객 주소를 뽑아 케이스·메시지 모두 그 주소로 둔다(폼 주소로 남기면 첫 메시지부터 sender_changed).
 * 뽑은 주소는 고객이 친 값이라 누구 주소든 넣을 수 있다 → sender_auth='form'(자동 메일 없음). 못 뽑으면 폼 주소 그대로 — 회차가 unclear로 넘긴다.
 * 인증 실패(fail)는 폼 메일이어도 그대로 둔다 — form으로 덮으면 sender_unverified 넘김을 건너뛰고 위조 메일이 LLM에 간다.
 * 수신 이벤트 문서(CRM)는 메시지와 같은 트랜잭션에서 넣는다. system = 'test'면 테스트 주입(index.js).
 * @returns {{caseId, messageId, threadId, created, reopened?} | {duplicate: true}} reopened = 기존 케이스에 붙었을 때만(다시 열었으면 true)
 */
function addInbound({ channel, from, name, subject, body, threadId, knownFacts, providerMessageId, occurredAt, autoSubmitted, inReplyTo, references, senderAuth, replyTo, system }) {
  if (!channel || !from || !body) throw new HttpError(400, 'channel, from, body 필수');
  if (!policy.load(channel)) throw new HttpError(400, `알 수 없는 channel: ${channel}`);
  const pmid = providerMessageId || `local:${db.uuid()}`;
  let tid = threadId ? String(threadId) : null;
  const refs = refKeys(inReplyTo, references);
  let { email, name: cname } = parseFrom(from, name);
  let auth = ['pass', 'fail'].includes(senderAuth) ? senderAuth : null;
  const form = policy.isFormAddress(email);
  if (form) {
    const f = formSender({ replyTo, subject, body });
    if (f.email) { email = f.email; if (auth !== 'fail') auth = 'form'; }
    cname = f.name || cname;
  }
  const now = db.now();
  return db.tx(() => {
    // 수신 claim은 메시지 insert와 같은 트랜잭션 — 중간에 실패하면 claim도 롤백돼 같은 메일 재전송이 처리된다
    if (!claim(`mailbox:${pmid}`)) return { duplicate: true, providerMessageId: pmid };
    let created = false; let method = 'new_case'; let reopened = null;
    let caseId = tid ? db.get('SELECT case_id FROM case_threads WHERE thread_id=?', tid)?.case_id : undefined;
    if (caseId) method = 'thread';
    if (!caseId && refs.length) {
      // 모르는 스레드 id의 회신 — In-Reply-To/References가 우리가 받거나 보낸 메일을 가리키면 그 케이스(보낸 사람이 바뀌면 prefilter가 sender_changed로 넘긴다)
      const hit = db.get(`SELECT case_id, thread_id FROM messages WHERE provider_message_id IN (${refs.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT 1`, ...refs);
      if (hit) {
        caseId = hit.case_id; method = 'in_reply_to';
        if (tid) db.run('INSERT INTO case_threads (thread_id, case_id, created_at) VALUES (?,?,?) ON CONFLICT(thread_id) DO NOTHING', tid, caseId, now);
        else tid = hit.thread_id;
      }
    }
    tid = tid || `t_${db.uuid()}`;
    const bodyClean = stripQuotes(body) || String(body).trim();
    if (caseId) {
      const c = db.get('SELECT state, responder, close_reason, close_detail FROM cases WHERE id=?', caseId);
      if (c.state === 'CLOSED' && !prefilter.isAutoReply({ body: bodyClean, subject, autoSubmitted })) { // 종결 뒤 회신 → 같은 케이스 재오픈
        setState(caseId, 'OPEN', { closed_at: null, close_reason: null, close_detail: null });
        reopened = c;
      }
    } else {
      caseId = db.uuid();
      db.insert('cases', {
        id: caseId, channel, customer_email: email, customer_name: sanitizeName(cname), subject: subject || null, state: 'OPEN', responder: 'agent',
        known_facts: JSON.stringify(sanitizeFacts(knownFacts)), created_at: now, updated_at: now,
      });
      db.insert('case_threads', { thread_id: tid, case_id: caseId, created_at: now });
      db.insert('loops', { case_id: caseId, state: 'IDLE', updated_at: now });
      created = true;
    }
    const messageId = db.uuid(); const eventId = db.uuid();
    const row = {
      id: messageId, case_id: caseId, thread_id: tid, direction: 'in', sent_by: null, sender: email, subject: subject || null,
      body, body_clean: bodyClean, provider_message_id: pmid, occurred_at: occurredAt || now, auto_submitted: autoSubmitted ? 1 : 0,
      sender_auth: auth, event_id: eventId,
    };
    db.insert('messages', row);
    if (reopened) {
      db.insert('activities', { id: db.uuid(), case_id: caseId, type: 'reopen', actor: 'system', created_at: now,
        payload: JSON.stringify({ messageId, closeReason: reopened.close_reason, closeDetail: reopened.close_detail }) });
    }
    collections.ingest({ ...row, from, name: name ?? null, parsedName: cname || null, replyTo, inReplyTo, references, knownFacts }, { id: caseId, channel },
      { method, reasonCode: reopened ? 'reopened_by_reply' : null, form, system: system === 'test' ? 'test' : 'inbound_api', recordedAt: now });
    db.run('UPDATE cases SET updated_at=? WHERE id=?', now, caseId);
    events.emit('message.created', { caseId, messageId, direction: 'in' });
    if (created) events.emit('case.updated', { caseId, state: 'OPEN', responder: 'agent' });
    if (reopened) events.emit('case.reopened', { caseId, responder: reopened.responder }); // 사람 전담 케이스면 알림(notify.js)
    return { caseId, messageId, threadId: tid, created, ...(created ? {} : { reopened: !!reopened }) };
  });
}

const parseCols = (row, cols) => {
  if (!row) return row;
  for (const c of cols) if (typeof row[c] === 'string') { try { row[c] = JSON.parse(row[c]); } catch { /* 문자열 그대로 */ } }
  return row;
};

function getCase(id) {
  const c = parseCols(db.get('SELECT * FROM cases WHERE id=?', id), ['known_facts']);
  if (!c) return null;
  const old = Date.now() - SEND_CHECK_MS;
  const drafts = db.all('SELECT * FROM drafts WHERE case_id=? ORDER BY created_at, rowid', id).map((d) => {
    parseCols(d, ['edit_tags', 'used_facts']);
    if (d.status === 'PENDING') {
      // 승인 화면: 실제로 나갈 메일 전체 + 근거 KB 문장
      const kb = kbLoader.load(c.channel, mail.langOf(d.original_body));
      d.preview = mail.renderAgent({ name: c.customer_name, body: d.original_body });
      d.kbPassages = Object.fromEntries((d.used_facts || []).map((k) => [k, kb.sections[k]?.text ?? '(KB에 없음 — 기한 지남 또는 삭제)']));
    }
    if (d.status === 'SENDING' && d.approved_at && Date.parse(d.approved_at) < old) d.needs_send_check = true;
    return d;
  });
  return {
    case: c,
    threadIds: db.all('SELECT thread_id FROM case_threads WHERE case_id=? ORDER BY created_at', id).map((r) => r.thread_id),
    messages: db.all('SELECT * FROM messages WHERE case_id=? ORDER BY occurred_at, rowid', id),
    drafts,
    needsSendCheck: drafts.some((d) => d.needs_send_check),
    decisions: db.all('SELECT * FROM decisions WHERE case_id=? ORDER BY created_at, rowid', id).map((d) => parseCols(d, ['output'])),
    handoffs: db.all('SELECT * FROM handoffs WHERE case_id=? ORDER BY created_at', id).map((h) => parseCols(h, ['briefing'])),
    activities: db.all('SELECT * FROM activities WHERE case_id=? ORDER BY created_at, rowid', id).map((a) => parseCols(a, ['payload'])),
    loop: parseCols(db.get('SELECT * FROM loops WHERE case_id=?', id), ['queue']),
  };
}

/** 케이스별 최신 접수 판단의 감정 신호 { sentiment, urgency, threat } — 한 번의 쿼리(SQLite는 max() 행의 다른 열을 같이 돌려준다). 목록 두 곳(/api/cases, /api/crm/cases)이 같이 쓴다. */
function signalsFor(ids) {
  const sig = new Map();
  if (!ids.length) return sig;
  for (const d of db.all(`SELECT case_id, output, max(rowid) FROM decisions WHERE step='triage' AND case_id IN (${ids.map(() => '?').join(',')}) GROUP BY case_id`, ...ids)) {
    try { const o = JSON.parse(d.output); sig.set(d.case_id, { sentiment: o.sentiment ?? null, urgency: o.urgency ?? null, threat: o.threat ?? null }); } catch { /* 깨진 출력은 신호 없음 */ }
  }
  return sig;
}

function listCases({ state, channel, q, limit = 50 } = {}) {
  const where = []; const params = [];
  if (state) { where.push(`c.state IN (${state.split(',').map(() => '?').join(',')})`); params.push(...state.split(',')); }
  if (channel) { where.push('c.channel=?'); params.push(channel); }
  if (q) { where.push('(c.subject LIKE ? OR c.customer_email LIKE ? OR c.customer_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const lim = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 500);
  const rows = db.all(`
    SELECT c.*,
      (SELECT thread_id FROM case_threads t WHERE t.case_id=c.id ORDER BY created_at LIMIT 1) AS threadId,
      (SELECT occurred_at FROM messages m WHERE m.case_id=c.id ORDER BY occurred_at DESC, rowid DESC LIMIT 1) AS lastMessageAt,
      (SELECT direction FROM messages m WHERE m.case_id=c.id ORDER BY occurred_at DESC, rowid DESC LIMIT 1) AS lastMessageDirection,
      (SELECT substr(body_clean,1,120) FROM messages m WHERE m.case_id=c.id ORDER BY occurred_at DESC, rowid DESC LIMIT 1) AS lastMessagePreview,
      (SELECT id FROM drafts d WHERE d.case_id=c.id AND d.status='PENDING' ORDER BY created_at DESC LIMIT 1) AS pendingDraftId,
      (SELECT COUNT(*) FROM cases c2 WHERE c2.customer_email=c.customer_email AND c2.id<>c.id AND c2.state<>'CLOSED') AS sameEmailOpenCases,
      -- 고객 재문의: 사람이 맡은(넘김·인수·직접 답장) 뒤에 고객 메시지가 또 왔다
      (c.state='HANDED_OFF' AND EXISTS (SELECT 1 FROM messages m WHERE m.case_id=c.id AND m.direction='in' AND m.occurred_at >
        max(COALESCE((SELECT MAX(created_at) FROM handoffs h WHERE h.case_id=c.id), ''), COALESCE(c.responder_changed_at, '')))) AS reaskedAfterHandoff
    FROM cases c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.updated_at DESC LIMIT ?`, ...params, lim);
  const sig = signalsFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...parseCols(r, ['known_facts']), reaskedAfterHandoff: !!r.reaskedAfterHandoff, signals: sig.get(r.id) || null }));
}

/** 채널별 L0→L1 승격 지표 — 발송된 에이전트 초안(무수정 = final_body 없음) + 섀도 초안 평가. 기준은 policy.PROMOTION. */
function promotion(channel) {
  const s = db.get(`SELECT COUNT(*) n, COALESCE(SUM(d.final_body IS NULL), 0) ok, COALESCE(SUM(COALESCE(d.edit_tags, '') LIKE '%critical%'), 0) crit
    FROM drafts d JOIN cases c ON c.id=d.case_id WHERE c.channel=? AND d.status='SENT' AND COALESCE(d.action, '') NOT IN ('HUMAN_REPLY','ACK') AND COALESCE(d.approved_by, '')<>'agent:auto'`, channel);
  const ratings = new Map(); // 초안당 마지막 평가만
  for (const a of db.all("SELECT a.payload FROM activities a JOIN cases c ON c.id=a.case_id WHERE c.channel=? AND a.type='shadow_rating' ORDER BY a.created_at, a.rowid", channel)) {
    const p = JSON.parse(a.payload || '{}'); if (p.draftId) ratings.set(p.draftId, p.rating);
  }
  const rated = [...ratings.values()];
  const reviewed = s.n + rated.length;
  const good = s.ok + rated.filter((r) => r === 'good').length;
  const criticalCount = s.crit + rated.filter((r) => r === 'critical').length;
  const approvedNoEditRate = reviewed ? Math.round((good / reviewed) * 1000) / 1000 : 0;
  const P = policy.PROMOTION;
  return { reviewed, approvedNoEditRate, criticalCount, eligible: reviewed >= P.minReviewed && approvedNoEditRate >= P.minNoEditRate && criticalCount <= P.maxCritical, criteria: P };
}

function stats() {
  const by = {};
  for (const r of db.all('SELECT state, COUNT(*) n FROM cases GROUP BY state')) by[r.state] = r.n;
  const today = new Date().toISOString().slice(0, 10);
  const dr = db.get(`SELECT COUNT(*) total, SUM(status='SENT' AND final_body IS NULL) noEdit, SUM(status='SENT' AND final_body IS NOT NULL) edited, SUM(status='DISCARDED') discarded
    FROM drafts WHERE COALESCE(action, '') NOT IN ('HUMAN_REPLY','ACK') AND COALESCE(approved_by, '')<>'agent:auto'`);
  // 1차 응대 3분류(케이스 단위): 완전 자동응대(L2 자동 발송, 사람 손 없음) · 사람에게 넘김(접수 안내·답장+넘김·승인 대기 초안 포함) · 응대 못함(에이전트가 보낸 답·접수 안내도, 승인 대기 초안도 없음 — 사람 직접 답장은 에이전트 응대가 아니다)
  // `+d.status` — 상태 조건이 drafts_status 인덱스를 고르면 케이스마다 그 상태 초안 전부를 훑는다(케이스당 drafts_case로 찾게 둔다).
  // 분모 = 응대가 필요했던 케이스: 무엇이든 나갔거나, 무시(자동 회신·감사 인사) 말고 다른 판단이 한 번이라도 있었다. 닫혀도 빠지지 않는다.
  const fr = db.get(`SELECT
      COUNT(*) n,
      SUM(c.responder='agent'
        AND EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=c.id AND +d.status='SENT' AND d.approved_by='agent:auto' AND COALESCE(d.action, '')<>'ACK')
        AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.case_id=c.id AND a.type IN ('approve','edit_approve','discard','human_reply','takeover','return'))) auto,
      SUM(EXISTS (SELECT 1 FROM messages m WHERE m.case_id=c.id AND m.direction='out' AND m.sent_by IN ('agent','ack')) OR EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=c.id AND +d.status='PENDING')) responded,
      SUM(c.responder='human') human
    FROM cases c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.case_id=c.id AND m.direction='out')
      OR EXISTS (SELECT 1 FROM decisions x WHERE x.case_id=c.id AND x.step='execute' AND COALESCE(x.action, '')<>'IGNORE')`);
  const firstResponse = { base: fr.n || 0, auto: fr.auto || 0, handedOff: (fr.responded || 0) - (fr.auto || 0), none: (fr.n || 0) - (fr.responded || 0), human: fr.human || 0 };
  firstResponse.rate = firstResponse.base ? Math.round((1000 * (fr.responded || 0)) / firstResponse.base) / 1000 : null;
  const byChannel = {};
  for (const r of db.all('SELECT channel, state, COUNT(*) n FROM cases GROUP BY channel, state')) {
    byChannel[r.channel] ??= { total: 0 };
    byChannel[r.channel][r.state] = r.n;
    byChannel[r.channel].total += r.n;
  }
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  return {
    total, unresolved: total - (by.CLOSED || 0), open: (by.OPEN || 0) + (by.AGENT_ACTIVE || 0), agentActive: by.AGENT_ACTIVE || 0, awaitingApproval: by.AWAITING_APPROVAL || 0,
    handedOff: by.HANDED_OFF || 0, waitingCustomer: by.WAITING_CUSTOMER || 0, closed: by.CLOSED || 0,
    todayInbound: db.get("SELECT COUNT(*) n FROM messages WHERE direction='in' AND occurred_at>=?", today).n,
    agentDrafts: dr.total || 0, approvedNoEdit: dr.noEdit || 0, approvedEdited: dr.edited || 0, discarded: dr.discarded || 0, byChannel, firstResponse,
    promotion: Object.fromEntries(policy.all().map((p) => [p.channel, promotion(p.channel)])),
  };
}

const COURTESY = ['ack', 'auto_reply_or_empty'];
/**
 * 회신으로 다시 연 에이전트 케이스에 그 뒤로 감사 인사·자동 회신만 왔으면(회차가 모두 IGNORE로 끝냄, 나간 메일·대기 초안 없음) 다시 닫는다 — 답도 알림도 없다.
 * 종결 사유·상세는 재오픈 활동에 남긴 값으로 되돌린다. 회차가 어디서 돌았든(수신 API·스위퍼 재시도·재시작 복구·스크립트) 실행 기록 이벤트에서 부른다.
 */
function recloseCourtesy(caseId) {
  db.tx(() => {
    const c = db.get('SELECT state, responder, purged_at FROM cases WHERE id=?', caseId);
    if (!c || c.state === 'CLOSED' || c.responder !== 'agent' || c.purged_at || hasPending(caseId) || hasSending(caseId)) return;
    const p = JSON.parse(db.get("SELECT payload FROM activities WHERE case_id=? AND type='reopen' ORDER BY rowid DESC LIMIT 1", caseId)?.payload || '{}');
    const from = p.messageId && db.get('SELECT rowid r FROM messages WHERE id=? AND case_id=?', p.messageId, caseId)?.r;
    if (!from) return; // 회신으로 다시 연 케이스가 아니다
    for (const m of db.all('SELECT id, direction FROM messages WHERE case_id=? AND rowid >= ?', caseId, from)) {
      const x = m.direction === 'in' && db.get("SELECT action, reason FROM decisions WHERE message_id=? AND step='execute' ORDER BY rowid DESC LIMIT 1", m.id);
      if (x?.action !== 'IGNORE' || !COURTESY.includes(x.reason)) return; // 그 뒤로 메일이 나갔거나, 아직 판단 전이거나, 진짜 문의
    }
    setState(caseId, 'CLOSED', { closed_at: db.now(), close_reason: p.closeReason ?? null, close_detail: p.closeDetail ?? null });
    db.insert('activities', { id: db.uuid(), case_id: caseId, type: 'auto_close', actor: 'system', payload: JSON.stringify({ reason: 'courtesy_reply' }), created_at: db.now() });
  });
  collections.markDirty(caseId); // 활동이 상태 변경(emit) 뒤에 온다
}
// 실행 기록은 회차 도중(발송 트랜잭션 포함)에 emit된다 — 여기서는 예약만 한다
events.subscribe(({ name, data }) => {
  if (name !== 'agent.step' || data?.step !== 'execute' || data.action !== 'IGNORE' || !COURTESY.includes(data.reason)) return;
  setImmediate(() => { try { recloseCourtesy(data.caseId); } catch (e) { console.error('[cases] 감사 인사 재종결 실패', data.caseId?.slice(0, 8), e.message); } });
});

module.exports = { signalsFor,
  HttpError, SEND_CHECK_MS, stripQuotes, sanitizeFacts, sanitizeName, claim, releaseClaim, assertNotPurged, setState, setResponder, hasPending, hasSending, restingState, settle,
  addInbound, getCase, listCases, stats, promotion,
};
