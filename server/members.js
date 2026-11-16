'use strict';
// 회원 저장소 어댑터 — 탈퇴 확인 코드, soft delete, 복구, 완전 삭제. 지금 구현은 SQLite 시험용 테이블(members)이다.
// 고객사 회원 DB·API에 붙일 때는 이 파일만 바꾼다(툴·라우터·API는 그대로).
// 흐름: requestCode(코드 발급, 해시만 저장) → confirm(맞으면 disabled + 유예 기간) → restore 또는 purge(유예가 지난 뒤 관리자 승인).
const crypto = require('node:crypto');
const db = require('./db');
const { contactKey } = require('./crm');

const CODE_TTL_MS = 24 * 3600e3;
const MAX_TRIES = 5;
const GRACE_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const later = (ms) => new Date(Date.parse(db.now()) + ms).toISOString();

function get(email) {
  const k = contactKey(email);
  if (!k) return null;
  return db.get('SELECT * FROM members WHERE email=?', k);
}

/** 탈퇴 확인 코드 발급(6자리, 24시간). 다시 부르면 새 코드로 바꾼다. 이미 꺼졌거나 삭제됐으면 already. */
function requestCode(email, { caseId }) {
  const k = contactKey(email);
  if (!k) return { ok: false, error: 'no_email' };
  if (get(k)?.status === 'disabled') return { ok: true, already: true }; // 완전 삭제된 주소는 행이 없다 — 다시 가입한 회원이면 새로 받는다
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const t = db.now();
  db.run(`INSERT INTO members (email, status, confirm_hash, confirm_expires_at, confirm_tries, confirm_case_id, updated_at) VALUES (?, 'active', ?, ?, 0, ?, ?)
    ON CONFLICT(email) DO UPDATE SET confirm_hash=excluded.confirm_hash, confirm_expires_at=excluded.confirm_expires_at, confirm_tries=0,
      confirm_case_id=excluded.confirm_case_id, updated_at=excluded.updated_at`, k, sha(`${k}:${code}`), later(CODE_TTL_MS), caseId, t);
  return { ok: true, code };
}

/** 유효한(24시간 안) 확인 코드가 걸려 있으면 그 행. 만료된 코드는 없는 것으로 본다 — 몇 달 뒤 주문번호 메일을 코드로 오인하지 않게. */
const pending = (email) => { const m = get(email); return m && m.status === 'active' && m.confirm_hash && m.confirm_expires_at > db.now() ? m : null; };

/** 코드 확인. 맞으면 soft delete. 틀리면 mismatch(left), 5번 틀리면 locked, 24시간 지나면 expired — 둘 다 코드를 지운다. */
function confirm(email, code) {
  const m = get(email);
  if (!m || m.status !== 'active' || !m.confirm_hash) return { ok: false, error: 'none' };
  const clear = () => db.run('UPDATE members SET confirm_hash=NULL, confirm_expires_at=NULL, updated_at=? WHERE email=?', db.now(), m.email);
  if (m.confirm_expires_at <= db.now()) { clear(); return { ok: false, error: 'expired' }; }
  if (!crypto.timingSafeEqual(Buffer.from(m.confirm_hash, 'hex'), Buffer.from(sha(`${m.email}:${code}`), 'hex'))) {
    const tries = m.confirm_tries + 1;
    db.run('UPDATE members SET confirm_tries=?, updated_at=? WHERE email=?', tries, db.now(), m.email);
    if (tries >= MAX_TRIES) { clear(); return { ok: false, error: 'locked' }; }
    return { ok: false, error: 'mismatch', left: MAX_TRIES - tries };
  }
  const t = db.now();
  db.run(`UPDATE members SET status='disabled', confirm_hash=NULL, confirm_expires_at=NULL, disabled_at=?, deleted_at=?, deleted_by='customer:confirm_code',
    delete_case_id=confirm_case_id, purge_after=?, updated_at=? WHERE email=?`, t, t, later(GRACE_DAYS * 86400e3), t, m.email);
  return { ok: true, caseId: m.confirm_case_id };
}

/** 복구(유예 기간 안). disabled가 아니면 not_disabled. */
function restore(email, { by }) {
  const m = get(email);
  if (!m || m.status !== 'disabled') return { ok: false, error: 'not_disabled' };
  const t = db.now();
  db.run("UPDATE members SET status='active', deleted_at=NULL, purge_after=NULL, restored_at=?, restored_by=?, updated_at=? WHERE email=?", t, by, t, m.email);
  return { ok: true };
}

/** 탈퇴 처리된 회원 — 관리자 검토 목록. due = 유예가 지나 완전 삭제할 수 있다. */
function listDisabled() {
  const now = db.now();
  return db.all("SELECT email, disabled_at, purge_after, delete_case_id FROM members WHERE status='disabled' ORDER BY purge_after, email")
    .map((m) => ({ email: m.email, disabledAt: m.disabled_at, purgeAfter: m.purge_after, caseId: m.delete_case_id, due: m.purge_after <= now }));
}

/** 완전 삭제(관리자 승인). 유예가 안 지났으면 not_due. 주소는 해시로 바꾸고 상태·시각만 남긴다. */
function purge(email, { by }) {
  const m = get(email);
  if (!m || m.status !== 'disabled') return { ok: false, error: 'not_disabled' };
  if (!m.purge_after || m.purge_after > db.now()) return { ok: false, error: 'not_due' };
  const t = db.now();
  // 주소는 되돌릴 수 없는 임의 키로 바꾼다(해시는 주소 목록으로 맞춰 볼 수 있어 쓰지 않는다). 상태·시각·케이스 id만 감사용으로 남는다
  db.run("UPDATE members SET email=?, status='purged', purged_at=?, purged_by=?, updated_at=? WHERE email=?", `purged:${crypto.randomUUID()}`, t, by, t, m.email);
  return { ok: true };
}

module.exports = { get, requestCode, pending, confirm, restore, listDisabled, purge, GRACE_DAYS, MAX_TRIES };
