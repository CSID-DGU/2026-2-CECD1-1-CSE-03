'use strict';
// 계정 툴. 조회 원본은 business.js(목 데이터 또는 고객사 계정 시스템), 탈퇴 상태는 members.js(회원 저장소 어댑터).
// 조회는 읽기 전용. 탈퇴 요청 툴은 ACCOUNT_DELETE_TOOL=1이고, 고객 본인(발신 인증 pass)이고, 접수 Agent가 account_deletion으로 분류했을 때만 열린다.
// 탈퇴 요청 툴은 계정을 끄지 않는다 — 등록된 주소로 확인 코드를 보낼 뿐이고, 고객이 코드로 회신하면 코드(deletion.js)가 끈다.
// 팀 소유자(owner) 계정은 팀원 전체가 영향을 받으므로 코드를 보내지 않고 사람에게 넘긴다.
// 잠금 해제·권한 변경은 툴로 열지 않는다(사람 담당자).
// 날짜·금액은 돌려주지 않는다: 탈퇴 완료일 같은 날짜를 답장에 옮기면 기한 약속이 된다.
const crm = require('../../crm');
const { obj, out, prop } = require('./schema');
const { customerScoped } = require('./customer');
const biz = require('./business');
const members = require('../../members');
const deletion = require('../../deletion');

const STATUS = ['active', 'locked', 'suspended', 'pending_deletion', 'closed', 'disabled'];
const ROLE = ['owner', 'admin', 'member'];
// 이유·단계는 정해진 값만 내보낸다 — 실제 시스템의 자유 문구("12/01까지 잠김")가 날짜·연락처를 실어 나르지 않게
const LOCK_REASON = ['failed_attempts', 'admin_lock', 'security', 'unknown'];
const DELETION_STAGE = ['requested', 'processing', 'unknown'];
const pickOf = (v, list, d = null) => (list.includes(v) ? v : d);

// 고객이 탈퇴를 요청했다는 인용이 이 메일에 실제로 있는지 — 모델이 지어낸 요청으로 계정을 끄지 않게. 공백만 무시하고 그대로 들어 있어야 한다.
const DELETE_WORDS = /탈퇴|계정\s*(을\s*)?삭제|회원\s*(정보\s*)?삭제|delete|close my account/i;
const squash = (t) => String(t || '').replace(/\s+/g, '');
const quoted = (ctx, quote) => squash(quote).length >= 6 && DELETE_WORDS.test(quote) && squash(ctx.message?.body_clean || ctx.rawMessage?.body_clean).includes(squash(quote));
// 섀도 채널은 아무 메일도 보내지 않는다 — 확인 코드 메일도
const deleteOn = (ctx) => process.env.ACCOUNT_DELETE_TOOL === '1' && !!biz.file() && customerScoped(ctx) && ctx.triage?.intent === 'account_deletion' && !ctx.pack?.shadow;

/** 이 케이스 고객에게 탈퇴 확인 코드를 보낸다. 툴과 결정 모델 라우터가 같이 쓴다. 보낸 사실은 state.actions에 남는다(코드는 남지 않는다). */
async function requestFor(ctx, state, by) {
  const email = crm.contactKey(ctx.case.customer_email);
  const a = biz.load().accounts.find((x) => crm.contactKey(x.email) === email);
  if (!a) return { ok: false, error: 'no_account' };
  if (a.role === 'owner') return { ok: false, error: 'owner' };
  if (a.status === 'closed') return { ok: true, already: true };
  const r = await deletion.request(email, { caseId: ctx.caseId, by });
  if (r.ok && !r.already) state?.actions?.push({ type: 'deletion_code_sent', by });
  return r;
}

function defs(ctx) {
  if (!biz.file() || !customerScoped(ctx)) return [];
  const d = [{
    name: 'lookup_account',
    strict: true,
    description: '이 고객(현재 케이스의 주소)의 계정 상태를 고객사 계정 시스템에서 찾아 돌려준다: 계정 상태(active·locked·suspended·pending_deletion·closed), 역할(owner·admin·member), 로그인 잠김 여부와 그 이유, 2단계 인증 사용 여부, 회사 SSO 로그인 여부, 탈퇴 신청 진행 단계. 로그인이 안 된다, 계정이 잠겼다, 탈퇴 신청이 진행되고 있는지, 관리자 권한이 있는지처럼 이 고객의 계정에 따라 안내가 달라지는 질문에 쓴다. 일반 절차 질문에는 쓰지 않는다. 날짜·금액·연락처는 돌려주지 않고, 잠금 해제·탈퇴 처리·권한 변경을 실행하지 않는다 — 그런 요청은 사람에게 넘긴다. 이 고객의 상태를 답장에 쓰면 근거에 tool:lookup_account을 넣는다. 절차·조건의 근거는 지식베이스다.',
    input_schema: obj(),
  }];
  if (deleteOn(ctx)) {
    d.push({
      name: 'request_account_deletion',
      strict: true,
      description: '이 고객(현재 케이스의 주소) 본인 계정의 탈퇴를 접수하고, 회원 정보에 등록된 메일 주소로 본인 확인 코드를 보낸다. 계정은 아직 꺼지지 않는다 — 고객이 24시간 안에 그 코드로 회신해야 탈퇴(비활성화)가 된다. 고객이 이 메일에서 자기 계정의 탈퇴·삭제를 지금 해 달라고 분명히 요청했을 때만 쓴다. 탈퇴 방법·조건·진행 상황만 묻거나, 다른 사람 계정이거나, 망설이는 말이면 쓰지 않는다. customerQuote에는 그 요청 문장을 메일에서 그대로 옮긴다 — 메일에 없는 문장이면 실행하지 않는다. 팀 소유자 계정이면 코드를 보내지 않고 사람에게 넘긴다. 답장에는 등록된 주소로 확인 코드를 보냈다는 것만 쓰고, 탈퇴가 끝났다고 쓰지 않는다. 날짜는 약속하지 않는다.',
      input_schema: obj({ customerQuote: prop('string', '고객이 탈퇴를 요청한 문장. 메일 본문에서 그대로 옮긴다.') }),
    });
  }
  return d;
}

function lookup(ctx) {
  const email = crm.contactKey(ctx.case.customer_email);
  const a = biz.load().accounts.find((x) => crm.contactKey(x.email) === email);
  if (!a) return { found: false };
  const m = members.get(email);
  return {
    found: true,
    status: m?.status === 'disabled' ? 'disabled' : pickOf(a.status, STATUS),
    role: pickOf(a.role, ROLE),
    login: { locked: a.login?.locked === true, reason: a.login?.locked === true ? pickOf(a.login.reason, LOCK_REASON, 'unknown') : null },
    twoFactor: a.twoFactor === true,
    sso: a.sso === true,
    deletion: a.deletion ? { requested: true, stage: pickOf(a.deletion.stage, DELETION_STAGE, 'unknown') } : { requested: false, stage: null },
  };
}

function handlers(ctx, state) {
  return {
    lookup_account: () => out(lookup(ctx)),
    async request_account_deletion({ customerQuote }) {
      if (!deleteOn(ctx)) return out({ error: '이 사이클에는 탈퇴 요청을 받을 수 없다' }, true);
      if (!quoted(ctx, customerQuote)) return out({ error: '메일에 그대로 있는 탈퇴 요청 문장이 아니다', next: '고객이 탈퇴를 분명히 요청하지 않았으면 절차를 안내하거나 사람에게 넘긴다.' }, true);
      const r = await requestFor(ctx, state, 'agent:responder');
      // 소유자 계정은 모델 판단에 맡기지 않고 여기서 넘긴다
      if (r.error === 'owner') return { ...out({ handedOff: true, why: '팀 소유자 계정' }), done: { body: null, usedFacts: [], humanCommitments: [], needsHandoff: true, handoffReason: 'human_request' } };
      if (!r.ok) return out({ error: r.error === 'no_account' ? '이 주소의 계정이 없다' : '확인 코드를 보내지 못했다', next: '사람에게 넘긴다.' }, true);
      return out({ codeSent: !r.already, already: !!r.already, next: r.already ? '이미 탈퇴 처리된 계정이다. 계정 상태 조회로 확인한다.' : '답장에는 회원 정보에 등록된 메일 주소로 확인 코드를 보냈고, 24시간 안에 그 코드로 회신하면 탈퇴가 진행된다고 쓴다. 아직 탈퇴된 것이 아니다. 코드는 모른다.' });
    },
  };
}

module.exports = { defs, handlers, requestFor, deleteOn };
