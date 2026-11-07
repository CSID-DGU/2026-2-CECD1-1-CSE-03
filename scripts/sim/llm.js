'use strict';
// 시뮬레이터 쪽 모델 호출(가상 고객·채점 모델·재분류 모델). 에이전트 몫은 서버가 부른다.
// mock: 역할별 규칙 함수. 토큰 = ceil(길이/2)라 mock으로도 예산 중단을 시험할 수 있다.
// anthropic: 역할마다 다른 모델 id를 써야 해서 서버 provider(모델이 env 하나로 고정)를 쓰지 않고 fetch를 직접 부른다.
const crypto = require('node:crypto');
const { parseJson } = require('../../server/llm/anthropic');

const API = 'https://api.anthropic.com/v1/messages';
const ROLES = ['customer', 'judge', 'relabel', 'author'];
// 채점 모델 mock의 약속 표현: 금액·비율, 기한
const PROMISE_RE = /\d[\d,]*\s*(원|%)|\d+\s*(일|시간)\s*(이내|안에|까지)/;

const MOCKS = {
  customer: (ctx) => require('./customer').mockTurn(ctx),
  // 감점이면 근거 quote를 답장에서 옮긴다(실모델 규칙과 같다)
  judge: (ctx) => { const m = PROMISE_RE.exec(ctx.reply); return { grounded: 2, noPromise: m ? 0 : 2, answered: 2, tone: 2, quote: m ? m[0] : '' }; },
  // 서버 mock 접수 Agent 규칙으로 다시 분류한다(결정적)
  relabel: (ctx) => {
    const pack = require('../../server/policy').load(ctx.channel);
    const kb = require('../../server/kb').load(ctx.channel, /[가-힣]/.test(ctx.body) ? 'ko' : 'en');
    const t = require('../../server/llm/mock').triage({ message: { body_clean: ctx.body }, pack, kb, history: [] });
    return { intent: t.intent, why: 'mock' };
  },
  // 생성 모델: 카드 id 해시로 결정적인 한국어 자리 문장(카드마다 음절 열이 달라 중복 제거에 덜 걸린다)
  author: ({ card } = {}) => {
    const n = [...crypto.createHash('sha256').update(String(card?.id ?? '')).digest('hex')].slice(0, 24).map((h) => '가나다라마바사아자차카타파하고노'[parseInt(h, 16)]).join('');
    const steps = Array.isArray(card?.steps) ? card.steps : [];
    const first = card?.opening?.stepIds ?? [];
    return {
      customer: { name: `가상 ${n.slice(0, 3)}` },
      opening: { subject: `문의 ${n.slice(3, 7)}`, body: `안녕하세요. ${steps.filter((s) => first.includes(s.id)).map((s) => s.ask).join(' ')} ${n.slice(7)} 답변 부탁드립니다.` },
      hiddenGoal: '문의한 일을 끝내고 싶다.', facts: [], unknown: [],
      mock: Object.fromEntries(steps.filter((s) => !first.includes(s.id)).map((s) => [s.id, [`이어서 묻습니다. ${s.ask}`]])),
      mentions: {},
    };
  },
};

async function callAnthropic({ model, system, user, schema, maxTokens }) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2026-10-21' },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    }),
    signal: AbortSignal.timeout(60_000),
    redirect: 'error', // 리다이렉트로 키를 다른 곳에 보내지 않는다
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  return res.json();
}

function create({ provider = 'mock', models = {}, mocks = {} } = {}) {
  const usage = Object.fromEntries(ROLES.map((r) => [r, { input: 0, output: 0 }]));
  const fns = { ...MOCKS, ...mocks };
  async function ask({ role, system, user, schema, ctx, maxTokens = 1024 }) {
    if (!ROLES.includes(role)) throw new Error(`알 수 없는 역할: ${role}`);
    const t0 = Date.now();
    let result; let data = null; let inputTokens; let outputTokens;
    if (provider === 'mock') {
      result = await fns[role](ctx);
      inputTokens = Math.ceil((system + user).length / 2);
      outputTokens = Math.ceil(JSON.stringify(result).length / 2);
    } else {
      data = await callAnthropic({ model: role === 'relabel' ? models.judge : models[role], system, user, schema, maxTokens });
      const u = (k) => Number(data.usage?.[k]) || 0;
      inputTokens = u('input_tokens') + u('cache_creation_input_tokens') + u('cache_read_input_tokens');
      outputTokens = u('output_tokens');
    }
    // 거절·잘림·JSON 오류여도 쓴 토큰은 센다
    usage[role].input += inputTokens; usage[role].output += outputTokens;
    if (data) {
      if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') throw new Error(`anthropic ${data.stop_reason}`);
      result = parseJson((data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    }
    return { result, inputTokens, outputTokens, latencyMs: Date.now() - t0 };
  }
  return { ask, usage };
}

module.exports = { create };
