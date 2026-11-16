'use strict';
// 회원 탈퇴 본인 확인 — 에이전트는 탈퇴를 실행하지 않고 확인 코드만 보낸다.
// ① request: 회원 원본에 등록된 주소로 6자리 코드(24시간)를 보낸다. 코드는 답장 초안·판정 기록·LLM에 들어가지 않는다.
// ② matchReply → members.confirm: 그 주소에서(발신 인증 pass) 코드로 회신하면 코드가 맞춰 soft delete한다. 모델은 관여하지 않는다.
// ③ 완전 삭제는 유예(members.GRACE_DAYS)가 지난 뒤 관리자가 승인한다(POST /api/console/members/purge).
const db = require('./db');
const mail = require('./mail');
const members = require('./members');
const { contactKey } = require('./crm');
const prefilter = require('./prefilter');

const CODE_RE = /(?<!\d)(\d{3})[\s-]?(\d{3})(?!\d)/;

const codeMail = (code) => [
  '안녕하세요.',
  '',
  `요청하신 계정 탈퇴의 확인 코드는 ${code} 입니다.`,
  '24시간 안에 이 코드를 적어 이 메일에 회신하시면 탈퇴가 진행됩니다.',
  '직접 요청하지 않으셨다면 이 메일을 무시해 주세요. 계정은 그대로 유지됩니다.',
].join('\n');

/** 확인 코드를 보낸다. to는 회원 원본의 주소(메일 헤더가 아니라). */
async function request(to, { caseId, by }) {
  const r = members.requestCode(to, { caseId });
  if (!r.ok || r.already) return r;
  try {
    await mail.send({ to, subject: '[계정 탈퇴 확인] 확인 코드', body: codeMail(r.code), idempotencyKey: `deletion:${caseId}:${Date.now()}` });
  } catch (e) {
    return { ok: false, error: 'send_failed' };
  }
  db.insert('activities', { id: db.uuid(), case_id: caseId, type: 'deletion_code_sent', actor: by, payload: null, created_at: db.now() });
  return { ok: true };
}

/**
 * 고객 회신이 탈퇴 확인 코드인가. 아니면 null(보통 회차로 간다).
 * 조건: 유효한 코드가 걸린 주소, 발신 인증 pass, 자동 회신·반송이 아님, 6자리 숫자,
 * 그리고 코드를 요청한 케이스이거나 새 케이스의 첫 메일(코드 메일에 회신하면 새 케이스가 된다). 다른 진행 중 케이스의 주문번호를 코드로 보지 않게.
 */
function matchReply({ sender, senderAuth, body, subject, autoSubmitted, caseId, firstInCase }) {
  const email = contactKey(sender);
  if (!email || senderAuth !== 'pass') return null;
  const p = members.pending(email);
  if (!p || (p.confirm_case_id !== caseId && !firstInCase)) return null;
  if (prefilter.isAutoReply({ body, subject, autoSubmitted })) return null;
  const m = String(body || '').match(CODE_RE);
  return m ? { email, code: `${m[1]}${m[2]}` } : null;
}

const NOTICE = {
  ok: () => `요청하신 계정 탈퇴를 처리했습니다. 지금부터 이 계정으로 로그인할 수 없습니다.\n${members.GRACE_DAYS}일 안에 복구를 원하시면 이 메일에 회신해 주세요. 담당자가 확인합니다. 그 뒤에는 담당자 확인을 거쳐 회원 정보를 삭제합니다.`,
  mismatch: (r) => `확인 코드가 맞지 않습니다. 탈퇴 확인 메일의 6자리 코드를 다시 확인해 회신해 주세요. (남은 횟수 ${r.left}번)`,
  expired: () => '확인 코드의 유효 시간(24시간)이 지났습니다. 탈퇴를 원하시면 다시 요청해 주세요.',
  locked: () => '확인 코드가 여러 번 맞지 않아 이 탈퇴 요청을 멈췄습니다. 담당자가 확인합니다.',
};
const notice = (r) => (r.ok ? NOTICE.ok() : (NOTICE[r.error] || NOTICE.expired)(r));

module.exports = { request, matchReply, notice, CODE_RE };
