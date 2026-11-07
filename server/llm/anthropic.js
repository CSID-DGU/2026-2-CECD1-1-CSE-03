'use strict';
// Claude Messages API를 fetch로 직접 호출(SDK·의존성 없음). JSON은 output_config.format(json_schema)으로 강제한다.
// anthropic-version 2026-10-21은 temperature를 받지 않는다 — 결정성은 effort:'low' + 스키마로 잡는다.
const api = () => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
const model = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS) || 30_000;

function parseJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  return JSON.parse(s >= 0 && e > s ? t.slice(s, e + 1) : t);
}

const fail = (msg, extra = {}) => Object.assign(new Error(msg), extra);
// 누적 사용량 — npm run smoke:llm 기록용(케이스 앞뒤 차이로 케이스별 토큰을 센다). 응답 usage 필드 그대로.
const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// meta: 호출자(agents/common.call)가 넘긴 빈 객체에 이 호출의 모델·토큰을 채운다(llm_calls 계량). 거절·잘림으로 던지기 전에 채운다 — 토큰은 이미 썼다.
async function json({ system, user, schema, maxTokens = 4096, timeoutMs: timeout, effort = 'low', meta = {} }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw fail('ANTHROPIC_API_KEY 없음', { noRetry: true });
  const body = {
    model: model(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };
  const res = await fetch(api(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout || timeoutMs()), // 걸린 요청이 케이스 리스를 잡고 있지 않게
  });
  if (!res.ok) throw fail(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`, { status: res.status, retryAfter: res.headers.get('retry-after') });
  const data = await res.json();
  usage.calls += 1;
  const u = (k) => Number(data.usage?.[k]) || 0;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) usage[k] += u(k);
  meta.model = data.model || model();
  meta.inputTokens = u('input_tokens') + u('cache_creation_input_tokens') + u('cache_read_input_tokens');
  meta.outputTokens = u('output_tokens');
  if (data.stop_reason === 'refusal') throw fail(`anthropic refusal: ${data.stop_details?.category ?? ''}`, { noRetry: true });
  if (data.stop_reason === 'max_tokens') throw fail('anthropic max_tokens — 출력이 잘렸다', { noRetry: true });
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(text);
}

/** POST /v1/messages/count_tokens — json()과 같은 model·system·messages로 입력 토큰 수만 잰다(생성 없음). */
async function countTokens({ system, user }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw fail('ANTHROPIC_API_KEY 없음', { noRetry: true });
  const res = await fetch(`${api()}/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    body: JSON.stringify({ model: model(), system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!res.ok) throw fail(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`, { status: res.status });
  return Number((await res.json()).input_tokens);
}

module.exports = { json, countTokens, parseJson, model, usage };
