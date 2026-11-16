'use strict';
// 회원 저장소 어댑터 — 탈퇴(soft delete)와 복구. 지금 구현은 SQLite 시험용 테이블(members)이다.
// 고객사 회원 DB·API에 붙일 때는 이 파일의 get·softDelete·restore만 바꾼다(툴과 API는 그대로).
// soft delete = 행을 지우지 않고 status를 disabled로 바꾸고 disabled_at·deleted_at·누가·어느 케이스를 적는다. restore로 되돌린다.
const db = require('./db');
const { contactKey } = require('./crm');

function get(email) {
  const k = contactKey(email);
  return k ? db.get('SELECT * FROM members WHERE email=?', k) : null;
}

/** 탈퇴 처리. 이미 disabled면 바꾸지 않고 already:true. 반환에 날짜는 넣지 않는다(답장에 옮기면 기한 약속이 된다). */
function softDelete(email, { by, caseId = null }) {
  const k = contactKey(email);
  if (!k) return { ok: false, error: 'no_email' };
  if (get(k)?.status === 'disabled') return { ok: true, already: true };
  const t = db.now();
  db.run(`INSERT INTO members (email, status, disabled_at, deleted_at, deleted_by, delete_case_id, updated_at) VALUES (?, 'disabled', ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET status='disabled', disabled_at=excluded.disabled_at, deleted_at=excluded.deleted_at,
      deleted_by=excluded.deleted_by, delete_case_id=excluded.delete_case_id, updated_at=excluded.updated_at`, k, t, t, by, caseId, t);
  return { ok: true, already: false };
}

/** 복구. disabled가 아니면 not_disabled. */
function restore(email, { by }) {
  const m = get(email);
  if (!m || m.status !== 'disabled') return { ok: false, error: 'not_disabled' };
  const t = db.now();
  db.run("UPDATE members SET status='active', deleted_at=NULL, restored_at=?, restored_by=?, updated_at=? WHERE email=?", t, by, t, m.email);
  return { ok: true };
}

module.exports = { get, softDelete, restore };
