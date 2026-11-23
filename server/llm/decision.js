'use strict';
// 결정 모델 클라이언트 — Gemini Decision API(POST /v1beta/decisions, gemini-decision-1). 답장 Agent 툴 라우터(TOOL_ROUTER=decision)만 쓴다.
// 실패·시간 초과·키 없음이면 null을 돌려준다. 부르는 쪽은 원래 경로(LLM이 툴을 고르는 ReAct)로 간다.
// 무료 등급은 입력을 제품 개선에 쓸 수 있다 — 실제 고객 메일을 보내는 운영에서는 유료 등급만(server/index.js가 시작 때 막는다).
const URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const MODEL = 'gemini-decision-1';
const timeoutMs = () => Math.max(1, Math.trunc(Number(process.env.DECISION_TIMEOUT_MS)) || 3000);

let impl = null; // 시험이 끼우는 가짜 — use(fn)
const use = (fn) => { impl = fn; };

/** questions: {키: {type:'choice'|'noul'|'score', instructions, criteria}} → {answers, ms, tokens} 또는 null */
async function decide({ input, questions }) {
  const t0 = Date.now();
  try {
    if (impl) { const r = await impl({ input, questions }); return r?.answers ? { ...r, ms: Date.now() - t0 } : null; }
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input, questions }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.answers || !Object.keys(j.answers).length) return null; // 안전 차단이면 answers가 비어 온다
    return { answers: j.answers, ms: Date.now() - t0, tokens: j.usage?.total_input_tokens ?? null };
  } catch { return null; }
}

module.exports = { decide, use, MODEL };
