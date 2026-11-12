'use strict';
// 회차(고객 메일 한 통)별 처리 시간·토큰·정확도 기록과 그 집계. 순수 함수만 둔다(입출력·DB·네트워크 없음).
// 입력은 turns.jsonl 한 줄 모양(run.js rowsOf)이라 지난 실행 폴더의 기록으로도 같은 집계를 다시 낸다.
const crypto = require('node:crypto');
const grade = require('./grade');

const AGENTS = ['triage', 'responder'];
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sumOf(xs) / xs.length : null);
const ratio = (a, b) => (b ? a / b : null);
// 최근접 순위 백분위(grade.js와 같은 정의)
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};
const parse = (o) => { if (typeof o !== 'string') return o ?? null; try { return JSON.parse(o); } catch { return null; } };

/* ---------------- 회차 하나 ---------------- */

/** 리포트 llm 칸(total·byAgent)을 에이전트별 {input, output, calls}로 편다. */
function usageSnapshot(llm) {
  const by = Object.fromEntries(asList(llm?.byAgent).map((r) => [r.agent, { input: r.inputTokens || 0, output: r.outputTokens || 0, calls: r.calls || 0 }]));
  return Object.fromEntries(AGENTS.map((a) => [a, by[a] ?? { input: 0, output: 0, calls: 0 }]));
}

/** 두 스냅숏 차이 = 그 회차에 쓴 에이전트별 토큰. */
function usageDelta(before, after) {
  return Object.fromEntries(AGENTS.map((a) => {
    const b = before?.[a] ?? {}; const x = after?.[a] ?? {};
    return [a, { input: (x.input || 0) - (b.input || 0), output: (x.output || 0) - (b.output || 0), calls: (x.calls || 0) - (b.calls || 0) }];
  }));
}

/**
 * 이 메일의 판정 기록에서 시간을 꺼낸다. decisions는 그 메시지 행만, receivedAt은 메시지 occurred_at.
 * 전체 = 접수 시각 → 마지막 execute 행 시각(초안 저장·넘김·무시 결정). execute가 없으면(재시도 대기·시간 초과) null.
 * 답장 걸음·LLM·툴 시간은 respond 행의 trace 합(재작성 포함). trace가 없으면(single 방식·답장 안 씀) null.
 */
function timingOf(decisions, receivedAt) {
  const of = (step) => decisions.filter((x) => x.step === step);
  const exec = of('execute').at(-1) ?? null;
  const ms = (rows) => (rows.length ? sumOf(rows.map((x) => num(x.latency_ms) ?? 0)) : null);
  const responds = of('respond');
  const traces = responds.map((x) => parse(x.output)?.trace).filter(Array.isArray);
  const steps = traces.flat();
  const t0 = Date.parse(receivedAt ?? ''); const t1 = Date.parse(exec?.created_at ?? '');
  const triage = parse(of('triage').at(-1)?.output);
  return {
    receivedAt: receivedAt ?? null, decidedAt: exec?.created_at ?? null,
    totalMs: Number.isFinite(t0) && Number.isFinite(t1) ? t1 - t0 : null,
    triageMs: ms(of('triage')), responderMs: ms(responds),
    responderSteps: traces.length ? steps.length : null,
    responderLlmMs: traces.length ? sumOf(steps.map((s) => num(s.llmMs) ?? 0)) : null,
    responderToolMs: traces.length ? sumOf(steps.flatMap((s) => asList(s.calls).map((c) => num(c.toolMs) ?? 0))) : null,
    kbHit: triage && 'kbHit' in triage ? triage.kbHit : null,
    retrieval: retrievalOf(of('retrieve').at(-1) ?? null),
  };
}

/**
 * KB_MODE=rag 회차의 retrieve 판정 행 → 기록 칸. full 회차(행 없음)는 null.
 * ms = 색인 맞춤 + 질문 임베딩 + 검색(전체 처리 시간 안에 이미 들어 있다 — 원인 분석용 보조 값).
 */
function retrievalOf(row) {
  const o = row && parse(row.output);
  if (!o) return null;
  const hits = asList(o.hits);
  return {
    requestedMode: o.requestedMode ?? 'rag', mode: o.mode ?? null, fallbackReason: o.fallbackReason ?? null,
    topK: o.topK ?? null, toc: o.toc ?? null, keys: hits.map((h) => h.key), scores: hits.map((h) => h.score),
    kbVersion: o.kbVersion ?? null, kbLanguage: o.kbLanguage ?? null, kbKeys: o.kbKeys ?? null,
    embed: o.embed ?? null, store: o.store ?? null,
    ms: num(row.latency_ms), embedMs: num(o.ms?.embed), searchMs: num(o.ms?.search), indexMs: num(o.ms?.index), indexEmbedded: o.index?.embedded ?? null,
  };
}

/**
 * 검색 평가(정책 팩 intent→kb 매핑을 정답 절의 대용으로 쓴다 — 완전한 정답 라벨이 아니다).
 * 정답 = 기대 intent의 kb 절 중 지금 KB에 있는 절(유효 정답). Recall@K = 검색된 유효 정답 수 / 유효 정답 수, Hit@K = 하나라도 검색됐는가.
 * rag로 검색한 회차만 본다(full·폴백 회차는 null). 평가할 수 없으면 {na: 사유}.
 */
function retrievalScore(exp, pack, r) {
  if (!r || r.mode !== 'rag') return null;
  const intents = asList(exp);
  if (!intents.length) return { na: 'no_expected_intent' };
  if (intents.length > 1) return { na: 'ambiguous_intent' };
  const gold = asList(pack?.intents?.[intents[0]]?.kb);
  if (!gold.length) return { na: 'no_gold_section' };
  const valid = r.kbKeys ? gold.filter((k) => r.kbKeys.includes(k)) : gold;
  if (!valid.length) return { na: 'gold_not_in_kb' };
  const found = valid.filter((k) => r.keys.includes(k));
  return { na: null, gold: valid, found, recall: found.length / valid.length, hit: found.length > 0 };
}

/** 이 턴의 기대 intent — grade.js 첫 턴 intent 판정과 같은 규칙(고객이 적은 첫 단계, 없으면 포인터 단계). */
function expectedIntent(scenario, { stepIds, pointer } = {}) {
  const id = asList(stepIds)[0] ?? pointer;
  return scenario.steps.find((s) => s.id === id)?.expect?.intent ?? null;
}

/**
 * turns.jsonl 한 줄의 perf 칸. turn = runScenario 턴 로그, graded = grade 턴 행, pack = 그 채널 정책 팩.
 * kbMiss: 기대 intent 중 정책 팩 kb 절이 있는 것이 있고 기대 결과가 답장(auto·approve)인데 접수 Agent가 kbHit=false로 판단.
 *   기대 결과가 넘김·답장+넘김·무시면 kbHit=false가 안전한 넘김일 수 있어 판단하지 않는다(null). kb 절이 없거나 접수를 안 거쳤어도 null.
 */
// requestedMode = 실행 설정(KB_MODE), kbMode = 이 회차 접수 Agent가 실제로 받은 KB(rag·full, rag 실행에서 접수를 안 거친 회차는 null)
function turnPerf({ scenario, turn, graded, pack, pass, runMode = 'full' }) {
  const t = turn.timing ?? {};
  const exp = expectedIntent(scenario, turn);
  const kbIntent = asList(exp).some((i) => asList(pack?.intents?.[i]?.kb).length > 0);
  const answerExpected = ['auto', 'approve'].includes(grade.keyOf(graded.label));
  const r = t.retrieval ?? null;
  return {
    requestedMode: r?.requestedMode ?? runMode, kbMode: r ? r.mode : runMode === 'rag' ? null : 'full', fallbackReason: r?.fallbackReason ?? null,
    retrieval: r, retrievalScore: retrievalScore(exp, pack, r),
    channel: scenario.channel, totalMs: t.totalMs ?? null, receivedAt: t.receivedAt ?? null, decidedAt: t.decidedAt ?? null,
    triageMs: t.triageMs ?? null, responderMs: t.responderMs ?? null,
    responderSteps: t.responderSteps ?? null, responderLlmMs: t.responderLlmMs ?? null, responderToolMs: t.responderToolMs ?? null,
    tokens: turn.agentUsage ?? null,
    expectedIntent: exp, actualIntent: turn.triageIntent ?? null,
    intentMatch: exp == null ? null : asList(exp).includes(turn.triageIntent),
    expectedOutcome: grade.keyOf(graded.label), actualOutcome: grade.keyOf(graded.outcome),
    outcomeMatch: graded.match, // grade.js gradeScenario의 match(infra 턴은 null)
    kbHit: t.kbHit ?? null, kbMiss: !kbIntent || !answerExpected || t.kbHit == null ? null : t.kbHit === false,
    pass,
  };
}

/* ---------------- 집계 ---------------- */

const perfRows = (rows) => asList(rows).filter((r) => r && r.perf);
const evaluable = (rs) => rs.filter((r) => r.perf.retrievalScore && r.perf.retrievalScore.na === null);
const nums = (rs, f) => rs.map(f).filter((v) => num(v) !== null);
const tok = (rs, agent, k) => mean(rs.filter((r) => (r.perf.tokens?.[agent]?.calls || 0) > 0).map((r) => r.perf.tokens[agent][k]));
const rate = (rs, k) => { const xs = rs.filter((r) => typeof r.perf[k] === 'boolean'); return ratio(xs.filter((r) => r.perf[k]).length, xs.length); };
// 채점 통과는 시나리오 시행 단위(같은 시행의 턴은 같은 값)
const passRate = (rs) => {
  const by = new Map();
  for (const r of rs) if (typeof r.perf.pass === 'boolean') by.set(`${r.scenario}|${r.trial}`, r.perf.pass);
  return ratio([...by.values()].filter(Boolean).length, by.size);
};

// [키, 이름, 좋은 방향(-1 낮을수록 · +1 높을수록), 값]
const METRICS = [
  ['totalP50', '전체 처리 시간 p50(ms)', -1, (rs) => pct(nums(rs, (r) => r.perf.totalMs), 50)],
  ['totalP95', '전체 처리 시간 p95(ms)', -1, (rs) => pct(nums(rs, (r) => r.perf.totalMs), 95)],
  ['totalMean', '전체 처리 시간 평균(ms)', -1, (rs) => mean(nums(rs, (r) => r.perf.totalMs))],
  ['triageP50', '접수 시간 p50(ms)', -1, (rs) => pct(nums(rs, (r) => r.perf.triageMs), 50)],
  ['responderP50', '답장 시간 p50(ms)', -1, (rs) => pct(nums(rs, (r) => r.perf.responderMs), 50)],
  ['responderSteps', '답장 걸음 수 평균', -1, (rs) => mean(nums(rs, (r) => r.perf.responderSteps))],
  ['triageIn', '접수 입력 토큰 평균', -1, (rs) => tok(rs, 'triage', 'input')],
  ['triageOut', '접수 출력 토큰 평균', -1, (rs) => tok(rs, 'triage', 'output')],
  ['responderIn', '답장 입력 토큰 평균', -1, (rs) => tok(rs, 'responder', 'input')],
  ['responderOut', '답장 출력 토큰 평균', -1, (rs) => tok(rs, 'responder', 'output')],
  ['intentAccuracy', 'intent 정확도', 1, (rs) => rate(rs, 'intentMatch')],
  ['outcomeAccuracy', '결과 정확도', 1, (rs) => rate(rs, 'outcomeMatch')],
  ['kbMissRate', 'kbHit 오판 비율', -1, (rs) => rate(rs, 'kbMiss')],
  ['passRate', '채점 통과율', 1, passRate],
  // rag 회차만(full 실행이면 -). 검색 시간은 전체 처리 시간 안에 들어 있는 원인 분석용 보조 값
  ['fallbackRate', 'rag 폴백 비율', -1, (rs) => { const xs = rs.filter((r) => r.perf.retrieval); return ratio(xs.filter((r) => r.perf.kbMode !== 'rag').length, xs.length); }],
  ['retrieveP50', '검색 시간 p50(ms, 보조)', -1, (rs) => pct(nums(rs.filter((r) => r.perf.kbMode === 'rag'), (r) => r.perf.retrieval.ms), 50)],
  ['recallAtK', 'Recall@K', 1, (rs) => mean(evaluable(rs).map((r) => r.perf.retrievalScore.recall))],
  ['hitAtK', 'Hit@K', 1, (rs) => { const xs = evaluable(rs); return ratio(xs.filter((r) => r.perf.retrievalScore.hit).length, xs.length); }],
];
const CHANNEL_METRICS = ['totalP50', 'totalP95', 'totalMean'];
// 모드별(정상 rag · 폴백 · full) 요약에 쓰는 지표
const MODE_METRICS = ['totalP50', 'totalP95', 'totalMean', 'intentAccuracy', 'outcomeAccuracy', 'passRate'];
const MODE_GROUPS = [
  ['rag', '정상 rag', (r) => r.perf.kbMode === 'rag'],
  ['fallback', 'rag 폴백(full로 돔)', (r) => r.perf.requestedMode === 'rag' && r.perf.kbMode === 'full'],
  ['noTriage', 'rag 실행·접수 안 거침', (r) => r.perf.requestedMode === 'rag' && r.perf.kbMode == null],
  ['full', 'full', (r) => (r.perf.requestedMode ?? 'full') === 'full'],
];

const metricsOf = (rs, keys = METRICS.map((m) => m[0])) => Object.fromEntries(METRICS.filter((m) => keys.includes(m[0])).map(([k, , , f]) => [k, f(rs)]));

/** 요약: 전체 지표, 채널별 처리 시간, 시행이 2회 이상이면 지표마다 시행 간 최소·최대. */
function summarize(rows) {
  const rs = perfRows(rows);
  const trials = [...new Set(rs.map((r) => r.trial))].sort((a, b) => a - b);
  const channels = [...new Set(rs.map((r) => r.perf.channel).filter(Boolean))].sort();
  let spread = null;
  if (trials.length >= 2) {
    const per = trials.map((t) => metricsOf(rs.filter((r) => r.trial === t)));
    spread = Object.fromEntries(METRICS.map(([k]) => {
      const vs = per.map((m) => m[k]).filter((v) => v !== null);
      return [k, vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : null];
    }));
  }
  return {
    turns: rs.length, trials: trials.length,
    counts: { timed: nums(rs, (r) => r.perf.totalMs).length, intent: rs.filter((r) => r.perf.intentMatch !== null).length,
      outcome: rs.filter((r) => typeof r.perf.outcomeMatch === 'boolean').length, kbMiss: rs.filter((r) => r.perf.kbMiss !== null).length },
    overall: metricsOf(rs),
    byChannel: Object.fromEntries(channels.map((c) => { const x = rs.filter((r) => r.perf.channel === c); return [c, { turns: x.length, ...metricsOf(x, CHANNEL_METRICS) }]; })),
    byMode: Object.fromEntries(MODE_GROUPS.flatMap(([k, , pick]) => { const x = rs.filter(pick); return x.length ? [[k, { turns: x.length, ...metricsOf(x, MODE_METRICS) }]] : []; })),
    retrieval: retrievalCounts(rs),
    spread,
  };
}

/** 검색 회차 수 — 정상 rag, 폴백(사유별), 검색 평가 가능·제외(사유별). rag 실행이 아니면 null. */
function retrievalCounts(rs) {
  const tried = rs.filter((r) => r.perf.retrieval);
  if (!tried.length) return null;
  const tally = (xs) => xs.reduce((a, x) => { a[x] = (a[x] || 0) + 1; return a; }, {});
  const rag = tried.filter((r) => r.perf.kbMode === 'rag');
  const scored = rag.map((r) => r.perf.retrievalScore).filter(Boolean);
  return {
    turns: tried.length, rag: rag.length, fallback: tried.length - rag.length,
    fallbackBy: tally(tried.filter((r) => r.perf.kbMode !== 'rag').map((r) => r.perf.fallbackReason || 'unknown')),
    evaluable: scored.filter((x) => x.na === null).length, excluded: scored.filter((x) => x.na !== null).length,
    excludedBy: tally(scored.filter((x) => x.na !== null).map((x) => x.na)),
    topK: [...new Set(tried.map((r) => r.perf.retrieval.topK))],
  };
}

/* ---------------- 비교 ---------------- */

const bodyKey = (r) => crypto.createHash('sha256').update(String(r.customer?.body ?? '')).digest('hex');
const pairKey = (r) => `${r.scenario}|${r.trial}|${r.turn}`;

/**
 * 이전 실행과 비교. cur·prev = {meta, rows}. 짝은 (시나리오, 시행, 턴)이 같고 고객 메일 본문도 같은 턴만 — 입력이 같아야 결과를 나란히 놓을 수 있다.
 * 반환: 조건 경고, 지표 차이, 결과 종류가 바뀐 짝 목록·비율, 결과가 같은 짝만의 처리 시간 p50·p95.
 */
function compareRuns(cur, prev) {
  const warnings = [];
  const cm = cur.meta ?? {}; const pm = prev.meta ?? {};
  if (cm.set?.version !== pm.set?.version || cm.set?.name !== pm.set?.name || cm.set?.sha256 !== pm.set?.sha256) warnings.push(`세트가 다르다: ${pm.set?.name ?? '-'} → ${cm.set?.name ?? '-'}`);
  if (cm.split !== pm.split) warnings.push(`split이 다르다: ${pm.split ?? '-'} → ${cm.split ?? '-'}`);
  for (const k of ['agent', 'customer', 'judge']) if (cm.models?.[k] !== pm.models?.[k]) warnings.push(`${k} 모델 id가 다르다: ${pm.models?.[k] ?? '-'} → ${cm.models?.[k] ?? '-'}`);
  const crs = perfRows(cur.rows); const prs = perfRows(prev.rows);
  if (!prs.length) warnings.push('이전 실행에 회차별 처리 기록(perf)이 없다 — 지표 차이를 낼 수 없다.');
  const a = summarize(prs).overall; const b = summarize(crs).overall;
  const metrics = METRICS.map(([k, name, dir]) => ({ key: k, name, dir, prev: a[k], cur: b[k], delta: a[k] == null || b[k] == null ? null : b[k] - a[k] }));

  const prevBy = new Map(prs.map((r) => [pairKey(r), r]));
  const pairs = crs.flatMap((r) => { const p = prevBy.get(pairKey(r)); return p && bodyKey(p) === bodyKey(r) ? [[p, r]] : []; });
  const changed = pairs.filter(([p, r]) => p.perf.actualOutcome !== r.perf.actualOutcome)
    .map(([p, r]) => ({ scenario: r.scenario, trial: r.trial, turn: r.turn, expected: r.perf.expectedOutcome, prev: p.perf.actualOutcome, cur: r.perf.actualOutcome }));
  const same = pairs.filter(([p, r]) => p.perf.actualOutcome === r.perf.actualOutcome);
  const t = (xs) => nums(xs, (r) => r.perf.totalMs);
  const sp = same.map(([p]) => p); const sc = same.map(([, r]) => r);
  const sameOutcome = { pairs: same.length,
    p50: { prev: pct(t(sp), 50), cur: pct(t(sc), 50) }, p95: { prev: pct(t(sp), 95), cur: pct(t(sc), 95) } };
  for (const q of ['p50', 'p95']) sameOutcome[q].delta = sameOutcome[q].prev == null || sameOutcome[q].cur == null ? null : sameOutcome[q].cur - sameOutcome[q].prev;
  // 접수 KB 방식(full·rag)은 비교하려는 차이라 경고가 아니라 따로 적는다. KB_TOPK·목차가 다르면 같은 rag라도 조건이 다르다
  const mode = (m) => (m.perfConfig ? `${m.perfConfig.kbMode ?? 'full'}${m.perfConfig.kbMode === 'rag' ? `(K=${m.perfConfig.kbTopK ?? '-'}, 목차 ${m.perfConfig.triageToc === false ? '없음' : '있음'})` : ''}` : 'full');
  const kbModes = { prev: mode(pm), cur: mode(cm) };
  return { prevRunId: pm.runId ?? null, warnings, kbModes, metrics, pairs: pairs.length, changed, changedRate: ratio(changed.length, pairs.length), sameOutcome };
}

/* ---------------- 표 ---------------- */

const f = (v, d = 3) => (v === null || v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));
const signed = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${f(v)}`);

function toMarkdown(s, cmp = null, config = null) {
  const L = ['## 회차별 처리 시간·정확도', ''];
  if (config) {
    L.push(`- 세트 ${config.set ?? '-'} · split ${config.split} · 반복 ${config.repeat} · KB_MODE ${config.kbMode} · KB_TOPK ${config.kbTopK ?? '-'}${config.kbMode === 'rag' ? ` · 목차 ${config.triageToc === false ? '없음' : '있음'}` : ''}`,
      `- KB 절 수: ${Object.entries(config.kbSections).map(([c, n]) => `${c} ${n}`).join(', ')}`);
    if (config.kbMode === 'rag') {
      L.push(`- 임베딩 ${config.embed ? `${config.embed.provider}/${config.embed.model} ${config.embed.dim}차원` : '-'} · 저장소 ${config.vectorStore ?? '-'}`,
        `- 미리 색인(질문→답변 시간과 별도): ${asList(config.index).map((c) => (c.error ? `${c.channel} 실패(${c.error})` : `${c.channel} ${c.embedded}/${c.embedded + c.kept}절 ${c.ms}ms`)).join(', ') || '-'}`);
    }
    L.push(
      `- 모델: 에이전트 ${config.models.agent ?? '-'} · 고객 ${config.models.customer ?? '-'} · 채점 ${config.models.judge ?? '-'}`, '');
  }
  L.push(`- 회차 ${s.turns}(시간 있는 회차 ${s.counts.timed}) · 시행 ${s.trials}`, '');
  const spread = !!s.spread;
  L.push(`| 지표 | 값 |${spread ? ' 시행 간 최소 | 시행 간 최대 |' : ''}`, `| --- | --- |${spread ? ' --- | --- |' : ''}`);
  for (const [k, name] of METRICS) L.push(`| ${name} | ${f(s.overall[k])} |${spread ? ` ${f(s.spread[k]?.min)} | ${f(s.spread[k]?.max)} |` : ''}`);
  L.push('', '| 채널 | 회차 | p50(ms) | p95(ms) | 평균(ms) |', '| --- | --- | --- | --- | --- |');
  for (const [c, m] of Object.entries(s.byChannel)) L.push(`| ${c} | ${m.turns} | ${f(m.totalP50)} | ${f(m.totalP95)} | ${f(m.totalMean)} |`);
  if (s.byMode && Object.keys(s.byMode).length) {
    L.push('', '| 접수 KB | 회차 | p50(ms) | p95(ms) | 평균(ms) | intent 정확도 | 결과 정확도 | 채점 통과율 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [k, label] of MODE_GROUPS) {
      const m = s.byMode[k];
      if (m) L.push(`| ${label} | ${m.turns} | ${f(m.totalP50)} | ${f(m.totalP95)} | ${f(m.totalMean)} | ${f(m.intentAccuracy)} | ${f(m.outcomeAccuracy)} | ${f(m.passRate)} |`);
    }
  }
  const rc = s.retrieval;
  if (rc) {
    const by = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(', ') || '없음';
    L.push('', `- 검색: 회차 ${rc.turns} · 정상 rag ${rc.rag} · 폴백 ${rc.fallback} (${by(rc.fallbackBy)}) · K=${rc.topK.join('/')}`,
      `- 검색 평가(정책 팩 intent→kb 매핑을 정답 대용으로): 평가 ${rc.evaluable} · 제외(N/A) ${rc.excluded} (${by(rc.excludedBy)})`);
  }
  L.push('', '- 전체 처리 시간 = 고객 메일 접수 → 초안 저장·넘김·무시 결정(rag면 질문 임베딩·검색 포함). 토큰 평균은 그 에이전트를 부른 회차만. 채점 통과율은 시나리오 시행 단위.',
    '- kbHit 오판은 기대 결과가 답장(auto·approve)인 회차만 센다. 넘김이 기대인 회차의 kbHit=false는 안전한 넘김일 수 있다.');
  if (cmp) {
    L.push('', `## 이전 실행과 비교 (${cmp.prevRunId ?? '-'})`, '');
    if (cmp.kbModes) L.push(`- 접수 KB 방식: ${cmp.kbModes.prev} → ${cmp.kbModes.cur}`, '');
    for (const w of cmp.warnings) L.push(`> 경고: ${w}`);
    if (cmp.warnings.length) L.push('');
    L.push('| 지표 | 이전 | 이번 | 차이 |', '| --- | --- | --- | --- |');
    for (const m of cmp.metrics) L.push(`| ${m.name} | ${f(m.prev)} | ${f(m.cur)} | ${signed(m.delta)}${m.delta ? (m.delta * m.dir > 0 ? ' ▲' : ' ▼') : ''} |`);
    L.push('', '▲ 이전보다 나음 · ▼ 나쁨', '',
      `- 같은 입력 짝(시나리오·시행·턴·고객 본문 같음) ${cmp.pairs}개 중 결과 종류가 바뀐 짝 ${cmp.changed.length}개 (비율 ${f(cmp.changedRate)})`);
    for (const c of cmp.changed) L.push(`  - ${c.scenario} 시행 ${c.trial} 턴 ${c.turn}: ${c.prev ?? '-'} → ${c.cur ?? '-'} (기대 ${c.expected ?? '-'})`);
    const so = cmp.sameOutcome;
    L.push(`- 결과가 같은 짝 ${so.pairs}개만: 처리 시간 p50 ${f(so.p50.prev)} → ${f(so.p50.cur)} (${signed(so.p50.delta)}), p95 ${f(so.p95.prev)} → ${f(so.p95.cur)} (${signed(so.p95.delta)}) ms`);
  }
  L.push('');
  return L.join('\n');
}

module.exports = { METRICS, MODE_GROUPS, usageSnapshot, usageDelta, timingOf, retrievalOf, retrievalScore, expectedIntent, turnPerf, summarize, compareRuns, toMarkdown };
