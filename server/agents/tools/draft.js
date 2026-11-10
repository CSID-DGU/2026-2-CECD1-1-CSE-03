'use strict';
// 초안 툴: 검사·제출·사람에게 넘김. 제출과 넘김이 사이클을 끝낸다. 발송 여부는 여기서 정하지 않는다(코드 정책과 사람 승인).
const guard = require('../../guard');
const { SYSTEM_REASONS } = require('../../policy');
const { prop, obj, out, sectionKeys } = require('./schema');

// 코드가 붙이는 사유(llm_error·round_limit·discarded 등)는 모델이 고르지 못하게 뺀다. 모델이 판단할 수 있는 시스템 사유만 남긴다.
const MODEL_SYSTEM_REASONS = ['out_of_knowledge', 'unclear', 'low_confidence', 'language_unsupported', 'guard_failed'];
const modelReasons = (pack) => pack.handoffReasons.filter((r) => !SYSTEM_REASONS.includes(r) || MODEL_SYSTEM_REASONS.includes(r));

function defs(ctx) {
  const usedFacts = sectionKeys(ctx, '본문에 실제로 쓴 사실의 지식베이스 절 키. 이번 사이클에 읽은 절만 넣는다. 사실 없이 인사·감사만 하는 답이면 빈 배열.');
  const body = prop('string', '고객에게 보낼 본문 전체(인사부터 끝맺음까지). 고객의 언어로 쓴다.');
  return [{
    name: 'check_draft',
    strict: true,
    description: '초안을 코드 검사기로 검사하고 위반 목록을 돌려준다: 금액·날짜 약속·연락처·지식베이스에 없는 링크·금지어·길이·이모지·빈 자리표시·근거 절(없는 절, 이 문의 유형에 허용되지 않은 절, 이번에 읽지 않은 절). 초안을 다 쓴 뒤 내기 전에 쓴다. 위반이 있으면 지적 전부를 고쳐 다시 검사한다. 문체·사실 정확성은 보지 않는다(그건 뒤의 검수 단계).',
    input_schema: obj({ body, usedFacts }),
  }, {
    name: 'submit_draft',
    strict: true,
    description: '최종 초안을 낸다. 받아들여지면 이 사이클이 끝난다. 내기 직전에 검사기와 같은 검사를 다시 돌려, 위반이 있으면 받지 않고 위반 목록을 돌려준다(그때는 고쳐서 다시 낸다). 내고 나면 발송 여부는 코드 정책과 사람 승인이 정한다.',
    input_schema: obj({ body, usedFacts, humanCommitments: prop('array', '대화에서 담당자(사람)가 이미 한 약속 중 이 본문이 이어받아 언급한 것. 없으면 빈 배열.', { items: { type: 'string' } }) }),
  }, {
    name: 'request_handoff',
    strict: true,
    description: '답장을 쓰지 않고 사람 담당자에게 넘긴다. 받아들여지면 이 사이클이 끝난다. 답에 필요한 사실이 지식베이스에 없거나, 고객이 사람을 원하거나, 정책상 사람이 맡아야 할 신호(환불·분쟁·법적 언급 등)가 있을 때 쓴다. 지식베이스로 답할 수 있는 질문이면 쓰지 않는다. 일부만 답할 수 있으면 답할 수 있는 부분으로 초안을 내고 나머지는 본문에서 담당자가 이어서 안내한다고 쓴다.',
    input_schema: obj({ reason: prop('string', '넘기는 사유. 가장 구체적인 것 하나.', { enum: modelReasons(ctx.pack) }) }),
  }];
}

function handlers(ctx, state) {
  const violations = ({ body, usedFacts }) => {
    const v = guard.check({ body, usedFacts, pack: ctx.pack, kb: ctx.kb, intent: ctx.triage?.intent });
    const unread = (usedFacts || []).filter((k) => ctx.kb?.sections?.[k] && !state.read.has(k));
    if (unread.length) v.push({ code: 'fact_not_read', quote: unread.join(',') }); // 읽지 않은 절을 근거로 댔다
    return v;
  };
  const fix = (v) => (v.length ? { violations: v, next: '지적 전부를 고친 본문으로 다시 검사하거나 낸다. 고칠 수 없으면 사람에게 넘긴다.' } : {});
  return {
    check_draft(input) {
      state.drafted = true;
      const v = violations(input);
      if (!v.length) state.lastPassed = { body: input.body, usedFacts: input.usedFacts || [], humanCommitments: [] };
      return out({ ok: !v.length, ...fix(v) });
    },
    submit_draft({ body, usedFacts = [], humanCommitments = [] }) {
      state.drafted = true;
      const v = violations({ body, usedFacts });
      // 검사에 걸리면 받지 않고 위반을 돌려준다 — 모델이 고쳐서 다시 낸다(걸음 상한 안에서).
      if (v.length) return out({ accepted: false, ...fix(v) }, true);
      return { ...out({ accepted: true }), done: { body, usedFacts, humanCommitments, needsHandoff: false, handoffReason: null } };
    },
    request_handoff({ reason }) {
      if (!modelReasons(ctx.pack).includes(reason)) return out({ error: `쓸 수 없는 사유: ${reason}`, next: `다음 중 하나로 다시 부른다: ${modelReasons(ctx.pack).join(', ')}` }, true);
      return { ...out({ accepted: true }), done: { body: null, usedFacts: [], humanCommitments: [], needsHandoff: true, handoffReason: reason } };
    },
  };
}

module.exports = { defs, handlers, modelReasons };
