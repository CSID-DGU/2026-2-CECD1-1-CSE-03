'use strict';
// LLM provider 선택. 기본: ANTHROPIC_API_KEY 있으면 anthropic, 없으면 mock. LLM_PROVIDER로 강제.
// json({agent, system, user, schema, ctx}) — 한 번 묻고 JSON. chat({agent, system, messages, tools, ctx}) — 툴 호출 한 걸음. 재시도는 5xx·네트워크·타임아웃 1회, 429는 retry-after(최대 10초) 뒤 1회.
// 전역 차단기: 연속 5번 실패하면 60초(LLM_RETRY_SCALE 배율) 동안 바로 실패(llm_unavailable) — 장애 중에 요청을 쌓지 않는다.
const providers = { mock: require('./mock'), anthropic: require('./anthropic') };

let forced = null;
const name = () => forced || process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock');
/** use('mock') 또는 use({name, json}) — 테스트가 "현실적인" 응답을 내는 stub을 끼울 수 있다. */
const use = (p) => {
  if (p && typeof p === 'object') { providers[p.name] = p; forced = p.name; } else forced = p;
  breaker.failures = 0; breaker.openUntil = 0; breaker.halfOpen = false;
};

const FAILS_TO_OPEN = 5;
const OPEN_MS = 60_000;
const scale = () => Number(process.env.LLM_RETRY_SCALE) || 1;
const breaker = { failures: 0, openUntil: 0, halfOpen: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(p, method, req) {
  try { return await p[method](req); } catch (e) {
    if (e.noRetry) throw e;
    if (e.status === 429) {
      const ra = e.retryAfter == null ? NaN : Number(e.retryAfter);
      await sleep(Math.min(Number.isFinite(ra) ? ra : 1, 10) * 1000);
      return p[method](req);
    }
    if (e.status && e.status < 500) throw e; // 4xx는 재시도 의미 없음
    return p[method](req);
  }
}

// json·chat 공통: 재시도 + 전역 차단기. chat(툴 호출 한 걸음)은 대화 전체를 매번 보내므로 걸음 단위 재시도가 안전하다.
async function guarded(method, req) {
  const p = providers[name()];
  if (!p) throw new Error(`알 수 없는 LLM_PROVIDER: ${name()}`);
  if (typeof p[method] !== 'function') throw Object.assign(new Error(`${name()} provider에 ${method} 없음`), { noRetry: true });
  if (req.breaker === false) return attempt(p, method, req); // 변환 같은 긴 작업: 전역 차단기를 보지도, 실패를 세지도 않는다
  if (Date.now() < breaker.openUntil) { const e = new Error('llm_unavailable'); e.code = 'llm_unavailable'; throw e; }
  if (breaker.openUntil) { breaker.openUntil = 0; breaker.halfOpen = true; } // 열린 시간이 지나면 한 번 시험해 본다
  try {
    const r = await attempt(p, method, req);
    breaker.failures = 0; breaker.halfOpen = false;
    return r;
  } catch (e) {
    breaker.failures += 1;
    if (breaker.halfOpen || breaker.failures >= FAILS_TO_OPEN) { breaker.openUntil = Date.now() + OPEN_MS * scale(); breaker.failures = 0; breaker.halfOpen = false; }
    throw e;
  }
}

const json = (req) => guarded('json', req);
const chat = (req) => guarded('chat', req);

/** provider가 입력 토큰을 셀 수 있으면 그 수, 아니면 null (mock 등). */
const countTokens = async (req) => {
  const p = providers[name()];
  return p && p.countTokens ? p.countTokens(req) : null;
};

/** ok | degraded(최근 실패 있음) | open(차단 중) */
const health = () => (Date.now() < breaker.openUntil ? 'open' : (breaker.failures > 0 || breaker.halfOpen ? 'degraded' : 'ok'));

module.exports = { json, chat, countTokens, name, use, health, breaker };
