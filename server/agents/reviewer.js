'use strict';
// 검수 에이전트 — ReviewResult(spec §3.1). 코드 guard를 통과한 본문만 받는다.
const { persona, factsBlock, promptSource, call } = require('./common');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'reasons'],
  properties: {
    pass: { type: 'boolean' },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'quote'],
        properties: {
          code: { type: 'string', enum: ['unsupported_claim', 'forbidden_content', 'not_answered', 'commitment_touched', 'tone', 'no_bridge', 'reasked_known'] },
          quote: { type: 'string' },
        },
      },
    },
  },
};

const system = (pack) => `${persona('reviewer')}

채널: ${pack.label}. 금지어: ${pack.guard.forbiddenWords.join(', ')}. ${pack.guard.allowDates ? '절차 안내의 날짜는 허용(기한 약속은 금지).' : ''}
pass가 true면 reasons는 빈 배열. 출력은 JSON만.`;

const user = (ctx) => {
  const used = (ctx.usedFacts || []).map((k) => ctx.kb.sections[k]?.raw).filter(Boolean).join('\n\n');
  return `근거 자료(답장에 쓸 수 있는 사실은 이것뿐이다):
<<<KB
${used || ctx.kb.text || '(없음)'}
KB>>>

고객이 이번 메시지에서 물은 것: ${ctx.triage?.questionSummary || '(요약 없음)'}
${ctx.triage?.handoffTopic ? `(담당자에게 넘길 것: ${ctx.triage.handoffTopic} — 본문이 "담당자가 이어서 안내"로 넘겼으면 답한 것이다)` : ''}

알려진 사실(데이터):
<<<FACTS
${factsBlock(ctx.knownFacts)}
FACTS>>>

사람 담당자가 이미 약속한 것(반복·변경 금지):
${(ctx.humanCommitments || []).map((c) => `- ${c}`).join('\n') || '(없음)'}

검사할 답장 본문:
<<<BODY
${ctx.body}
BODY>>>`;
};

const SOURCE = promptSource('reviewer', system, user);

async function run(ctx) {
  const out = await call({ agent: 'reviewer', system: system(ctx.pack), user: user(ctx), schema: SCHEMA, ctx, source: SOURCE });
  return { ...out, result: { pass: !!out.result.pass, reasons: out.result.reasons || [] } };
}

module.exports = { run, SCHEMA };
