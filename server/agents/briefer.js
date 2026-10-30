'use strict';
// 브리핑 에이전트 — Briefing(spec §3.1). 넘김·답장+넘김 때 사람 담당자용 노트를 쓴다.
const { persona, factsBlock, historyBlock, promptSource, call } = require('./common');
const { maskContacts } = require('../guard');
const labels = require('../labels');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'request', 'knownFacts', 'recommendedReply', 'nextAction'],
  properties: {
    summary: { type: 'string' },
    request: { type: 'string' },
    knownFacts: { type: 'array', items: { type: 'string' } },
    recommendedReply: { type: 'string' },
    nextAction: { type: 'string' },
  },
};

const system = (pack) => `${persona('briefer')}

채널: ${pack.label}. 출력은 JSON만.`;

const user = (ctx) => `넘기는 이유: ${ctx.reason}
분류 결과: ${ctx.triage ? JSON.stringify({ intent: ctx.triage.intent, questionSummary: ctx.triage.questionSummary, riskSignals: ctx.triage.riskSignals, handoffTopic: ctx.triage.handoffTopic }) : '(코드 규칙으로 바로 넘김)'}
${ctx.draftBody ? `에이전트가 함께 보내는 답장 본문(이미 승인 큐에 있음):\n<<<DRAFT\n${ctx.draftBody}\nDRAFT>>>` : ''}

지식 베이스(추천 답안에 쓸 수 있는 사실):
<<<KB
${ctx.kb.text || '(없음)'}
KB>>>

알려진 사실:
<<<FACTS
${factsBlock(ctx.knownFacts)}
FACTS>>>

스레드 대화(오래된 순):
<<<THREAD
${historyBlock(ctx.history)}
THREAD>>>`;

const SOURCE = promptSource('briefer', system, user);

/** 담당자용 노트도 연락처는 가린다 — 대시보드·알림으로 퍼진다. */
const clean = (r = {}) => ({
  summary: maskContacts(r.summary || ''), request: maskContacts(r.request || ''), knownFacts: (r.knownFacts || []).map(maskContacts),
  recommendedReply: maskContacts(r.recommendedReply || ''), nextAction: maskContacts(r.nextAction || ''),
});

async function run(ctx) {
  const out = await call({ agent: 'briefer', system: system(ctx.pack), user: user(ctx), schema: SCHEMA, ctx, source: SOURCE });
  return { ...out, result: clean(out.result) };
}

/** LLM 없이 만드는 브리핑 — LLM 장애·내부 오류·폐기 때. */
function fallback({ reason, message, knownFacts, note }) {
  return clean({
    summary: note || `에이전트가 넘김(${labels.reason(reason)}). 자동 브리핑 없이 코드가 작성했다.`,
    request: String(message?.body_clean || '').slice(0, 200),
    knownFacts: Object.entries(knownFacts || {}).map(([k, v]) => `${k}: ${v}`),
    recommendedReply: '', nextAction: '담당자가 메시지를 읽고 직접 응대',
  });
}

module.exports = { run, fallback, SCHEMA };
