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

async function json({ system, user, schema, maxTokens = 4096 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw fail('ANTHROPIC_API_KEY 없음', { noRetry: true });
  const body = {
    model: model(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low', ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };
  const res = await fetch(api(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs()), // 걸린 요청이 케이스 리스를 잡고 있지 않게
  });
  if (!res.ok) throw fail(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`, { status: res.status, retryAfter: res.headers.get('retry-after') });
  const data = await res.json();
  usage.calls += 1;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) usage[k] += Number(data.usage?.[k]) || 0;
  if (data.stop_reason === 'refusal') throw fail(`anthropic refusal: ${data.stop_details?.category ?? ''}`, { noRetry: true });
  if (data.stop_reason === 'max_tokens') throw fail('anthropic max_tokens — 출력이 잘렸다', { noRetry: true });
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(text);
}

module.exports = { json, parseJson, model, usage };
