'use strict';
// 네 에이전트가 공유하는 것: 페르소나 로더, 프롬프트 버전, 입력 블록 포맷, LLM 호출 래퍼.
const fs = require('node:fs');
const path = require('node:path');
const llm = require('../llm');
const db = require('../db');
const { sha } = require('../kb');
const report = require('../report');

const PERSONAS_PATH = path.join(__dirname, 'personas.md');
const personas = (() => {
  const text = fs.readFileSync(PERSONAS_PATH, 'utf8');
  const out = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...rest] = part.split('\n');
    out[head.trim()] = rest.join('\n').trim();
  }
  return out;
})();

const persona = (name) => personas[name] || '';

const factsBlock = (facts = {}) => {
  const entries = Object.entries(facts || {});
  return entries.length ? entries.map(([k, v]) => `${k}: ${v === '' || v == null ? '미기재' : v}`).join('\n') : '(없음)';
};

// 사람이 고쳐 승인한 에이전트 답장(edited)은 사람이 쓴 것으로 본다 — 그 안의 약속은 사람 약속이다.
const who = (m) => (m.direction === 'in' ? '고객' : m.sent_by === 'human' ? '담당자' : m.edited ? '담당자(에이전트 초안 수정)' : '에이전트');
const historyBlock = (history = []) => (history.length
  ? history.map((m) => `[${who(m)}] ${String(m.body_clean || '').slice(0, 600)}`).join('\n---\n')
  : '(첫 메시지)');

/** 이 케이스의 최근 판단 3개(게이트 결과) — 같은 실수를 반복하지 않게 맥락으로 준다. */
const decisionsBlock = (recent = []) => (recent.length
  ? recent.map((d) => `- ${d.step} ${d.action || '-'}${d.reason ? ` (${d.reason})` : ''}`).join('\n')
  : '(없음)');

/** 프롬프트 버전 = 템플릿 원본(페르소나 + system·user 템플릿 함수 소스)의 해시. 렌더 결과가 아니라 "어떤 프롬프트였나"를 가리킨다. */
const promptSource = (agent, ...fns) => [persona(agent), ...fns.map((f) => f.toString())].join('\n---\n');

let budgetWarnedDay = null;

/**
 * LLM 호출 + 소요 시간 + 프롬프트 버전 + 사용량. ctx는 mock provider가 쓴다(규칙 기반이라 구조화 입력 필요).
 * 일일 토큰 예산(LLM_DAILY_TOKEN_BUDGET)을 다 쓴 날은 부르지 않고 code 'llm_budget'으로 던진다 — 루프가 재시도 없이 넘긴다.
 * 단순화: 예산 조회와 호출 사이가 원자적이지 않아 동시 회차가 있으면 예산을 몇 호출 넘길 수 있다.
 * 호출마다 성공·실패 모두 llm_calls 한 행(오류는 코드·HTTP 상태만 — 응답 본문은 넣지 않는다).
 * 단순화: provider 재시도 1회(llm/index.js)는 같은 meta를 덮어써 앞 시도의 토큰은 세지 않는다.
 */
async function call({ agent, system, user, schema, ctx, source, maxTokens, timeoutMs, effort, breaker }) {
  const promptVersion = sha(source);
  db.saveVersion(promptVersion, `prompt:${agent}`, source);
  const b = report.budget();
  if (b.limit != null && b.used >= b.limit) {
    const day = db.now().slice(0, 10);
    if (budgetWarnedDay !== day) { budgetWarnedDay = day; console.warn(`[llm] 일일 토큰 예산 소진(${b.used}/${b.limit}) — 오늘(UTC) 남은 회차는 LLM 없이 담당자에게 넘긴다`); }
    throw Object.assign(new Error('llm_budget'), { code: 'llm_budget' });
  }
  const meta = {};
  const t0 = Date.now();
  let error = null;
  try {
    // maxTokens·timeoutMs·effort·breaker는 넘긴 호출만 provider로 간다(기존 호출자의 요청 모양은 그대로).
    const extra = Object.fromEntries(Object.entries({ maxTokens, timeoutMs, effort, breaker }).filter(([, v]) => v !== undefined));
    const result = await llm.json({ agent, system, user, schema, ctx, meta, ...extra });
    return { result, latencyMs: Date.now() - t0, promptVersion, usage: meta };
  } catch (e) {
    error = String(e?.code || e?.status || e?.name || 'error');
    throw e;
  } finally {
    db.insert('llm_calls', {
      id: db.uuid(), case_id: ctx?.caseId, message_id: ctx?.messageId, agent, provider: llm.name(), model: meta.model,
      input_tokens: meta.inputTokens || 0, output_tokens: meta.outputTokens || 0, latency_ms: Date.now() - t0, ok: error ? 0 : 1, error, created_at: db.now(),
    });
  }
}

module.exports = { persona, factsBlock, historyBlock, decisionsBlock, promptSource, call, sha };
