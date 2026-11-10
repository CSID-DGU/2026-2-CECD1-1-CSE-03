'use strict';
// 답장 Agent(ReAct)가 골라 부르는 툴. 기능별로 파일을 나눴다 — 목록·노출 조건·안전 규칙은 docs/tools.md.
//   knowledge.js  지식베이스 찾기·읽기·빈 곳 남기기
//   customer.js   지난 케이스·고객 기록(고객 본인 + 인증 pass일 때만)
//   orders.js     주문 조회 ┐ 원본 business.js(BUSINESS_DATA_FILE — 목 데이터 또는 고객사 시스템)
//   billing.js    결제·구독 조회 ┤ 파일이 있고 고객 본인 + 인증 pass일 때만
//   account.js    계정 상태 조회 ┘
//   meeting.js    담당자 빈 시간 후보(같은 원본, 날짜를 허용하는 채널에서만 — 고객 정보 없음)
//   web.js        고객사 공식 사이트 페이지 읽기(OFFICIAL_SITE_DOMAINS가 있을 때만, 맥락용)
//   draft.js      초안 검사·제출·사람에게 넘김
// 설계 규칙:
//   - 발송·승인·정책 판정은 툴로 열지 않는다(코드 게이트에 남는다). 환불·해지·결제 취소도 열지 않는다. 쓰기는 매뉴얼 보강 목록 하나뿐이고 판정 기록에 남는다.
//   - 고객 범위는 케이스로 고정한다. 모델이 이메일·케이스 id·주문번호를 인자로 넣지 못한다.
//   - 지금 쓸 수 없는 툴은 목록에서 뺀다. 목록 밖 호출은 실행하지 않는다.
//   - 결과는 짧게: 건수·글자 수 상한, 고객 유래 텍스트는 maskPii.
//   - 설명은 계약이다 — 무엇을 하는지, 언제 쓰는지·쓰지 않는지, 무엇을 돌려주지 않는지. 실제 동작과 어긋나면 안 된다.
const GROUPS = [require('./knowledge'), require('./customer'), require('./orders'), require('./billing'), require('./account'), require('./meeting'), require('./web'), require('./draft')];
const { out } = require('./schema');
const { modelReasons } = require('./draft');

/** 이 회차에 노출할 툴 정의(기능 순서: 지식베이스 → 고객 이력 → 주문 → 결제 → 계정 → 담당자 일정 → 공식 사이트 → 초안). */
const defs = (ctx) => GROUPS.flatMap((g) => g.defs(ctx));

/**
 * 툴 실행기. 상태: 읽은 절, 검사를 통과한 마지막 초안, 초안을 써 봤는지, 남긴 지식베이스 빈 곳.
 * lastPassed는 check_draft를 통과한 초안만 — 걸음 상한에 닿았을 때 돌려줄 수 있는 것은 이것뿐이다(걸린 초안은 절대 돌려주지 않는다).
 * run(name, input) → {(동기 툴) 또는 그 Promise(네트워크 툴)  content: string, isError: boolean, done?: result } — done이 있으면 루프가 끝난다.
 */
function runner(ctx) {
  const state = { read: new Set(), lastPassed: null, drafted: false, gaps: [], pages: 0 };
  const exposed = new Set(defs(ctx).map((d) => d.name));
  const handlers = Object.assign({}, ...GROUPS.map((g) => g.handlers(ctx, state)));
  return {
    state,
    run(name, input) {
      if (!exposed.has(name)) return out({ error: `이 사이클에 없는 툴: ${name}`, next: `쓸 수 있는 툴: ${[...exposed].join(', ')}` }, true);
      const fail = (e) => out({ error: String(e?.message || e) }, true);
      try {
        const r = handlers[name](input || {});
        return typeof r?.then === 'function' ? r.catch(fail) : r; // 네트워크 툴은 Promise를 돌려준다
      } catch (e) { return fail(e); }
    },
  };
}

module.exports = { defs, runner, modelReasons };
