'use strict';
// 네 에이전트가 공유하는 것: 페르소나 로더, 프롬프트 버전, 입력 블록 포맷, LLM 호출 래퍼.
const fs = require('node:fs');
const path = require('node:path');
const llm = require('../llm');
const db = require('../db');
const { sha } = require('../kb');

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

/**
 * LLM 호출 + 소요 시간 + 프롬프트 버전. ctx는 mock provider가 쓴다(규칙 기반이라 구조화 입력 필요).
 */
async function call({ agent, system, user, schema, ctx, source }) {
  const promptVersion = sha(source);
  db.saveVersion(promptVersion, `prompt:${agent}`, source);
  const t0 = Date.now();
  const result = await llm.json({ agent, system, user, schema, ctx });
  return { result, latencyMs: Date.now() - t0, promptVersion };
}

module.exports = { persona, factsBlock, historyBlock, decisionsBlock, promptSource, call, sha };
