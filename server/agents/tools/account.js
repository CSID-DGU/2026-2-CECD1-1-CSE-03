'use strict';
// 계정 상태 조회 툴. 원본은 business.js(목 데이터 또는 고객사 계정 시스템). 읽기 전용 — 잠금 해제·탈퇴 처리·권한 변경은 툴로 열지 않는다(사람 담당자).
// 날짜·금액은 돌려주지 않는다: 탈퇴 완료일 같은 날짜를 답장에 옮기면 기한 약속이 된다.
const crm = require('../../crm');
const { obj, out } = require('./schema');
const { customerScoped } = require('./customer');
const biz = require('./business');

const STATUS = ['active', 'locked', 'suspended', 'pending_deletion', 'closed'];
const ROLE = ['owner', 'admin', 'member'];
// 이유·단계는 정해진 값만 내보낸다 — 실제 시스템의 자유 문구("12/01까지 잠김")가 날짜·연락처를 실어 나르지 않게
const LOCK_REASON = ['failed_attempts', 'admin_lock', 'security', 'unknown'];
const DELETION_STAGE = ['requested', 'processing', 'unknown'];
const pickOf = (v, list, d = null) => (list.includes(v) ? v : d);

function defs(ctx) {
  if (!biz.file() || !customerScoped(ctx)) return [];
  return [{
    name: 'lookup_account',
    strict: true,
    description: '이 고객(현재 케이스의 주소)의 계정 상태를 고객사 계정 시스템에서 찾아 돌려준다: 계정 상태(active·locked·suspended·pending_deletion·closed), 역할(owner·admin·member), 로그인 잠김 여부와 그 이유, 2단계 인증 사용 여부, 회사 SSO 로그인 여부, 탈퇴 신청 진행 단계. 로그인이 안 된다, 계정이 잠겼다, 탈퇴 신청이 진행되고 있는지, 관리자 권한이 있는지처럼 이 고객의 계정에 따라 안내가 달라지는 질문에 쓴다. 일반 절차 질문에는 쓰지 않는다. 날짜·금액·연락처는 돌려주지 않고, 잠금 해제·탈퇴 처리·권한 변경을 실행하지 않는다 — 그런 요청은 사람에게 넘긴다. 이 고객의 상태를 답장에 쓰면 근거에 tool:lookup_account을 넣는다. 절차·조건의 근거는 지식베이스다.',
    input_schema: obj(),
  }];
}

function lookup(ctx) {
  const email = crm.contactKey(ctx.case.customer_email);
  const a = biz.load().accounts.find((x) => crm.contactKey(x.email) === email);
  if (!a) return { found: false };
  return {
    found: true,
    status: pickOf(a.status, STATUS),
    role: pickOf(a.role, ROLE),
    login: { locked: a.login?.locked === true, reason: a.login?.locked === true ? pickOf(a.login.reason, LOCK_REASON, 'unknown') : null },
    twoFactor: a.twoFactor === true,
    sso: a.sso === true,
    deletion: a.deletion ? { requested: true, stage: pickOf(a.deletion.stage, DELETION_STAGE, 'unknown') } : { requested: false, stage: null },
  };
}

function handlers(ctx) {
  return { lookup_account: () => out(lookup(ctx)) };
}

module.exports = { defs, handlers };
