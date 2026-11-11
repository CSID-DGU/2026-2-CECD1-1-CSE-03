'use strict';
// 회차별 처리 시간·정확도 기록과 집계(scripts/sim/perf.js) — 순수 함수는 손으로 만든 행으로, 실행기 연결은 mock 공급자로 본다.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../scripts/sim/perf');
const R = require('../scripts/sim/run');
const db = require('../server/db');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-perf-')); dirs.push(d); return d; };
// 실행기가 연 run.db를 먼저 놓는다(Windows는 열린 파일을 지우지 못한다)
after(() => { db.init(':memory:'); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/* ---------------- 회차 하나 ---------------- */

const at = (ms) => new Date(Date.UTC(2026, 10, 1, 0, 0, 0, ms)).toISOString();

test('timingOf: 접수→execute 시각, 접수·답장 시간 합(재작성 포함), trace 걸음·LLM·툴 시간 합, kbHit', () => {
  const trace = (n) => Array.from({ length: n }, (_, i) => ({ step: i + 1, llmMs: 10, calls: [{ tool: 'x', ok: true, toolMs: 3 }, { tool: 'y', ok: false, toolMs: 1 }] }));
  const rows = [
    { step: 'triage', latency_ms: 40, output: JSON.stringify({ intent: 'receipt', kbHit: false }), created_at: at(50) },
    { step: 'respond', latency_ms: 100, output: JSON.stringify({ trace: trace(2) }), created_at: at(200) },
    { step: 'respond', latency_ms: 60, output: { trace: trace(1) }, created_at: at(300) }, // 재작성(이미 객체인 출력도 받는다)
    { step: 'execute', latency_ms: null, output: '{}', created_at: at(320) },
  ];
  const t = P.timingOf(rows, at(0));
  assert.equal(t.totalMs, 320);
  assert.equal(t.decidedAt, at(320));
  assert.equal(t.triageMs, 40);
  assert.equal(t.responderMs, 160);
  assert.equal(t.responderSteps, 3);
  assert.equal(t.responderLlmMs, 30);
  assert.equal(t.responderToolMs, 12, '실패한 툴 호출 시간도 툴 시간이다');
  assert.equal(t.kbHit, false);

  const none = P.timingOf([{ step: 'triage', latency_ms: 5, output: '{"kbHit":true}', created_at: at(5) }], at(0));
  assert.equal(none.totalMs, null, 'execute가 없으면(재시도 대기·시간 초과) 전체 시간 없음');
  assert.equal(none.responderMs, null);
  assert.equal(none.responderSteps, null, '답장을 안 썼으면 걸음 수 없음');
  const single = P.timingOf([{ step: 'respond', latency_ms: 9, output: '{"body":"x"}', created_at: at(9) }, { step: 'execute', output: '{}', created_at: at(10) }], at(0));
  assert.equal(single.responderMs, 9);
  assert.equal(single.responderSteps, null, 'trace가 없는 single 방식은 걸음 수를 비운다');
  assert.equal(single.kbHit, null, '접수를 안 거친 회차');
});

test('usageSnapshot·usageDelta: 리포트 byAgent 누적 차이가 회차 몫이다', () => {
  const a = P.usageSnapshot({ byAgent: [{ agent: 'triage', inputTokens: 100, outputTokens: 10, calls: 1 }] });
  const b = P.usageSnapshot({ byAgent: [{ agent: 'triage', inputTokens: 250, outputTokens: 30, calls: 2 }, { agent: 'responder', inputTokens: 900, outputTokens: 80, calls: 3 }, { agent: 'reviewer', inputTokens: 5, outputTokens: 5, calls: 1 }] });
  assert.deepEqual(P.usageDelta(a, b), { triage: { input: 150, output: 20, calls: 1 }, responder: { input: 900, output: 80, calls: 3 } });
});

const scenario = {
  id: 'sup-x-a-01', channel: 'support',
  steps: [{ id: 's1', expect: { intent: 'receipt', outcome: 'auto' } }, { id: 's2', expect: { intent: ['refund', 'billing_dispute'], outcome: 'handoff' } }, { id: 's3', expect: { intent: null, outcome: 'ignore' } }],
};
const pack = { intents: { receipt: { kb: ['receipt'] }, refund: { kb: null }, billing_dispute: {} } };
const graded = (label, outcome, match) => ({ label, outcome, match });

test('turnPerf: 기대 intent는 첫 단계(없으면 포인터), kbHit 오판은 kb 절이 있는 기대 intent에서만, 결과 분류는 grade.keyOf', () => {
  const t = (over) => ({ stepIds: ['s1'], pointer: 's1', triageIntent: 'receipt', timing: { totalMs: 10, kbHit: false }, agentUsage: null, ...over });
  const a = P.turnPerf({ scenario, turn: t(), graded: graded({ outcome: 'auto', reasons: null }, { kind: 'auto', reason: null }, true), pack, pass: true });
  assert.equal(a.channel, 'support');
  assert.equal(a.expectedIntent, 'receipt');
  assert.equal(a.intentMatch, true);
  assert.equal(a.kbMiss, true, 'receipt는 kb 절이 있는데 kbHit=false');
  assert.equal(a.expectedOutcome, 'auto');
  assert.equal(a.outcomeMatch, true);

  const b = P.turnPerf({ scenario, turn: t({ stepIds: [], pointer: 's2', triageIntent: 'billing_dispute', timing: { kbHit: false } }),
    graded: graded({ outcome: 'approve', reasons: ['refund_request'] }, { kind: 'approve', reason: 'refund_request' }, true), pack, pass: false });
  assert.deepEqual(b.expectedIntent, ['refund', 'billing_dispute'], '고객이 단계를 적지 않으면 포인터');
  assert.equal(b.intentMatch, true, '기대가 목록이면 그중 하나');
  assert.equal(b.kbMiss, null, 'kb 절이 없는 intent는 오판 판단에서 뺀다');
  assert.equal(b.expectedOutcome, 'approve_r', '답장+넘김 승인 대기');
  assert.equal(b.actualOutcome, 'approve_r');

  const c = P.turnPerf({ scenario, turn: t({ stepIds: ['s3'], triageIntent: null, timing: { kbHit: null } }), graded: graded(null, { kind: 'infra', reason: 'llm_error' }, null), pack, pass: false });
  assert.equal(c.intentMatch, null, '기대 intent 없음');
  assert.equal(c.outcomeMatch, null, 'infra 턴은 grade가 match를 비운다');
  assert.equal(c.totalMs, null);
});

/* ---------------- 집계 ---------------- */

// turns.jsonl 한 줄 모양
const row = (scenarioId, trial, turn, p, body = `${scenarioId} 본문 ${turn}`) => ({ scenario: scenarioId, trial, turn, customer: { body },
  perf: { channel: 'support', totalMs: null, triageMs: null, responderMs: null, responderSteps: null, tokens: null,
    intentMatch: null, outcomeMatch: null, kbMiss: null, pass: true, actualOutcome: 'auto', expectedOutcome: 'auto', ...p } });
const use = (ti, to, ri, ro) => ({ triage: { input: ti, output: to, calls: ti ? 1 : 0 }, responder: { input: ri, output: ro, calls: ri ? 2 : 0 } });

test('summarize: 처리 시간 p50·p95·평균(전체·채널별), 토큰 평균은 부른 회차만, 비율은 판정 있는 회차만, 통과율은 시행 단위', () => {
  const rows = [
    row('a', 1, 1, { totalMs: 100, triageMs: 10, responderMs: 50, responderSteps: 2, tokens: use(1000, 100, 3000, 300), intentMatch: true, outcomeMatch: true, kbMiss: false, pass: true }),
    row('a', 1, 2, { totalMs: 300, triageMs: 30, responderMs: 70, responderSteps: 4, tokens: use(2000, 200, 5000, 500), intentMatch: false, outcomeMatch: true, kbMiss: true, pass: true }),
    row('b', 1, 1, { channel: 'sales', totalMs: 200, triageMs: 20, tokens: use(3000, 300, 0, 0), intentMatch: true, outcomeMatch: false, pass: false }),
    row('c', 1, 1, { channel: 'sales', totalMs: null, outcomeMatch: null, pass: false }), // 시간 초과 회차
    { scenario: 'old', trial: 1, turn: 1 }, // perf 칸이 없던 실행의 행은 집계에서 뺀다
  ];
  const s = P.summarize(rows);
  assert.equal(s.turns, 4);
  assert.equal(s.trials, 1);
  assert.equal(s.spread, null, '시행이 하나면 최소·최대 없음');
  assert.deepEqual(s.counts, { timed: 3, intent: 3, outcome: 3, kbMiss: 2 });
  const o = s.overall;
  assert.equal(o.totalP50, 200);
  assert.equal(o.totalP95, 300);
  assert.equal(o.totalMean, 200);
  assert.equal(o.triageP50, 20);
  assert.equal(o.responderP50, 50);
  assert.equal(o.responderSteps, 3);
  assert.equal(o.triageIn, 2000);
  assert.equal(o.triageOut, 200);
  assert.equal(o.responderIn, 4000, '답장을 안 부른 회차(b)는 평균에서 뺀다');
  assert.equal(o.responderOut, 400);
  assert.equal(o.intentAccuracy, 2 / 3);
  assert.equal(o.outcomeAccuracy, 2 / 3);
  assert.equal(o.kbMissRate, 0.5);
  assert.equal(o.passRate, 1 / 3, '시나리오 시행 a·b·c 중 a만');
  assert.deepEqual(Object.keys(s.byChannel), ['sales', 'support']);
  assert.deepEqual(s.byChannel.sales, { turns: 2, totalP50: 200, totalP95: 200, totalMean: 200 });
  assert.deepEqual(s.byChannel.support, { turns: 2, totalP50: 100, totalP95: 300, totalMean: 200 });
});

test('summarize: 시행이 2회 이상이면 지표마다 시행 간 최소·최대', () => {
  const rows = [
    row('a', 1, 1, { totalMs: 100, outcomeMatch: true, pass: true }), row('b', 1, 1, { totalMs: 300, outcomeMatch: false, pass: false }),
    row('a', 2, 1, { totalMs: 500, outcomeMatch: true, pass: true }), row('b', 2, 1, { totalMs: 700, outcomeMatch: true, pass: true }),
  ];
  const s = P.summarize(rows);
  assert.equal(s.trials, 2);
  assert.deepEqual(s.spread.totalP50, { min: 100, max: 500 });
  assert.deepEqual(s.spread.totalMean, { min: 200, max: 600 });
  assert.deepEqual(s.spread.outcomeAccuracy, { min: 0.5, max: 1 });
  assert.deepEqual(s.spread.passRate, { min: 0.5, max: 1 });
  assert.equal(s.spread.triageP50, null, '어느 시행에도 값이 없으면 null');
  assert.deepEqual(Object.keys(s.spread), P.METRICS.map((m) => m[0]));
  const md = P.toMarkdown(s);
  assert.match(md, /\| 지표 \| 값 \| 시행 간 최소 \| 시행 간 최대 \|/);
  assert.match(md, /\| 전체 처리 시간 p50\(ms\) \| 300 \| 100 \| 500 \|/, '값 칸은 전 시행을 합친 p50');
});

/* ---------------- 비교 ---------------- */

const meta = (over = {}) => ({ runId: 'R', set: { version: 'v2', name: 'scenarios.v2.jsonl', sha256: 'h' }, split: 'test', models: { agent: 'a', customer: 'c', judge: 'j' }, ...over });

test('compareRuns: 세트·split·모델 id가 다르면 경고, 지표 차이, 같은 입력 짝의 결과 변화, 결과가 같은 짝만의 p50·p95', () => {
  const prev = [
    row('a', 1, 1, { totalMs: 100, actualOutcome: 'auto', outcomeMatch: true }),
    row('b', 1, 1, { totalMs: 200, actualOutcome: 'handoff', outcomeMatch: true }),
    row('c', 1, 1, { totalMs: 300, actualOutcome: 'approve', outcomeMatch: true }),
    row('d', 1, 2, { totalMs: 400, actualOutcome: 'auto' }, '이전 실행의 둘째 메일'),
  ];
  const cur = [
    row('a', 1, 1, { totalMs: 150, actualOutcome: 'auto', outcomeMatch: true }),
    row('b', 1, 1, { totalMs: 900, actualOutcome: 'auto', expectedOutcome: 'handoff', outcomeMatch: false }),
    row('c', 1, 1, { totalMs: 350, actualOutcome: 'approve', outcomeMatch: true }),
    row('d', 1, 2, { totalMs: 10, actualOutcome: 'handoff' }, '이번 실행의 다른 둘째 메일'), // 고객 본문이 달라 짝에서 뺀다
    row('e', 1, 1, { totalMs: 10, actualOutcome: 'auto' }), // 이전에 없던 시나리오
  ];
  const same = P.compareRuns({ meta: meta(), rows: cur }, { meta: meta({ runId: 'P' }), rows: prev });
  assert.deepEqual(same.warnings, [], '조건이 같으면 경고 없음');
  assert.equal(same.prevRunId, 'P');
  assert.equal(same.pairs, 3);
  assert.deepEqual(same.changed, [{ scenario: 'b', trial: 1, turn: 1, expected: 'handoff', prev: 'handoff', cur: 'auto' }]);
  assert.equal(same.changedRate, 1 / 3);
  assert.deepEqual(same.sameOutcome, { pairs: 2, p50: { prev: 100, cur: 150, delta: 50 }, p95: { prev: 300, cur: 350, delta: 50 } });
  const m = Object.fromEntries(same.metrics.map((x) => [x.key, x]));
  assert.equal(m.totalP50.prev, 200);
  assert.equal(m.totalP50.cur, 150);
  assert.equal(m.totalP50.delta, -50);
  assert.equal(m.outcomeAccuracy.delta, 2 / 3 - 1);

  const diff = P.compareRuns({ meta: meta({ split: 'dev', models: { agent: 'a2', customer: 'c', judge: 'j2' } }), rows: cur },
    { meta: meta({ set: { version: 'v1', name: 'scenarios.v1.jsonl', sha256: 'g' } }), rows: prev });
  assert.equal(diff.warnings.length, 4);
  assert.match(diff.warnings[0], /세트가 다르다: scenarios\.v1\.jsonl → scenarios\.v2\.jsonl/);
  assert.match(diff.warnings[1], /split이 다르다: test → dev/);
  assert.match(diff.warnings[2], /agent 모델 id가 다르다: a → a2/);
  assert.match(diff.warnings[3], /judge 모델 id가 다르다: j → j2/);

  const md = P.toMarkdown(P.summarize(cur), diff);
  assert.match(md, /> 경고: split이 다르다/);
  assert.match(md, /\| 전체 처리 시간 p50\(ms\) \| 200 \| 150 \| -50 ▲ \|/, '처리 시간은 낮을수록 나음');
  assert.match(md, /결과 종류가 바뀐 짝 1개 \(비율 0\.333\)/);
  assert.match(md, /b 시행 1 턴 1: handoff → auto \(기대 handoff\)/);
  assert.match(md, /결과가 같은 짝 2개만: 처리 시간 p50 100 → 150 \(\+50\), p95 300 → 350 \(\+50\) ms/);

  const empty = P.compareRuns({ meta: meta(), rows: cur }, { meta: meta(), rows: [] });
  assert.match(empty.warnings.at(-1), /perf\)이 없다/);
  assert.equal(empty.pairs, 0);
  assert.equal(empty.changedRate, null);
});

/* ---------------- 실행기 연결(mock) ---------------- */

const rec = (id, body, intent, outcome, doneWhen, reasons = null) => ({
  id, family: id.replace(/-\d{2}$/, ''), bundle: 'A', split: 'test', channel: 'support', difficulty: 1, tags: [], persona: 'p01-formal-calm',
  customer: { name: '가상고객' }, opening: { subject: '문의', body, stepIds: ['s1'] }, formFacts: null, hiddenGoal: '답을 받고 싶다.', facts: [], unknown: [],
  steps: [{ id: 's1', ask: 's1 질문', expect: { intent, outcome, reasons }, doneWhen }], end: outcome === 'handoff' ? { kind: 'handoff', reasons } : { kind: 'resolved' },
  grade: 'turns', maxTurns: 2, mock: {}, adversarial: null, source: { origin: 'handwritten', dataset: 'own', license: 'own', use: 'handwritten', ref: 'card' },
});
const SET = [
  rec('sup-receipt-a-01', '지난달 결제 건 영수증이 필요합니다. 회사 경비 처리용인데 발급 방법 알려주세요.', 'receipt', 'auto', { mentions: ['결제 내역'] }),
  rec('sup-refund-a-01', '이번 달 결제 하나 환불해 주세요.', 'refund', 'handoff', { handoff: true }, ['refund_request']),
];
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
async function run(args) {
  const out = tmp();
  const log = console.log; console.log = () => {};
  let code; try { code = await R.main(['--provider=mock', '--auto-send=1', `--out=${out}`, ...args]); } finally { console.log = log; }
  const [dir] = fs.readdirSync(out);
  return { code, dir: dir && path.join(out, dir) };
}

test('실행기(mock): 회차마다 perf·config 칸, summary에 요약·시행 간 최소·최대, --compare-to면 비교 표', async () => {
  const f = path.join(tmp(), 'set.jsonl');
  fs.writeFileSync(f, SET.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const a = await run([`--file=${f}`, '--repeat=2']);
  assert.equal(a.code, 0);
  const turns = readJsonl(path.join(a.dir, 'turns.jsonl'));
  assert.equal(turns.length, 4);
  for (const t of turns) {
    assert.ok(Number.isInteger(t.perf.totalMs) && t.perf.totalMs >= 0, '전체 처리 시간');
    assert.ok(Date.parse(t.perf.decidedAt) >= Date.parse(t.perf.receivedAt));
    assert.ok(Number.isInteger(t.perf.triageMs), '접수 시간');
    assert.equal(t.perf.tokens.triage.calls, 1, '접수는 회차마다 한 번');
    assert.deepEqual(Object.keys(t.config), ['set', 'split', 'trial', 'kbMode', 'kbTopK', 'kbSections', 'models']);
    assert.equal(t.config.trial, t.trial);
    assert.equal(t.config.split, 'test');
    assert.equal(t.config.kbMode, 'full', 'KB_MODE가 없으면 full');
    assert.ok(t.config.kbSections > 0);
    assert.deepEqual(t.config.models, { agent: 'mock', customer: 'mock', judge: 'mock' });
  }
  const receipt = turns.find((t) => t.scenario === 'sup-receipt-a-01');
  assert.equal(receipt.perf.expectedIntent, 'receipt');
  assert.equal(receipt.perf.intentMatch, true);
  assert.equal(receipt.perf.actualOutcome, 'auto');
  assert.equal(receipt.perf.outcomeMatch, true);
  assert.equal(receipt.perf.kbMiss, false);
  assert.ok(receipt.perf.responderSteps >= 1 && receipt.perf.tokens.responder.calls >= 1, '답장 Agent trace 걸음');
  const refund = turns.find((t) => t.scenario === 'sup-refund-a-01');
  assert.equal(refund.perf.actualOutcome, 'handoff');
  assert.equal(refund.perf.kbMiss, null, '환불 intent는 kb 절이 없다');

  const s = readJson(path.join(a.dir, 'summary.json'));
  assert.equal(s.perf.turns, 4);
  assert.equal(s.perf.trials, 2);
  assert.ok(s.perf.spread.totalP50.min <= s.perf.spread.totalP50.max);
  assert.equal(s.perf.overall.outcomeAccuracy, 1);
  assert.equal(s.perfCompare, null);
  assert.deepEqual(readJson(path.join(a.dir, 'meta.json')).perfConfig.models, { agent: 'mock', customer: 'mock', judge: 'mock' });
  assert.match(fs.readFileSync(path.join(a.dir, 'summary.md'), 'utf8'), /## 회차별 처리 시간·정확도[\s\S]*시행 간 최소/);

  const b = await run([`--file=${f}`, '--repeat=2', `--compare-to=${a.dir}`]);
  assert.equal(b.code, 0);
  const c = readJson(path.join(b.dir, 'summary.json')).perfCompare;
  assert.deepEqual(c.warnings, []);
  assert.equal(c.prevRunId, path.basename(a.dir));
  assert.equal(c.pairs, 4);
  assert.deepEqual(c.changed, [], 'mock은 결정적이다');
  assert.equal(c.sameOutcome.pairs, 4);
  assert.match(fs.readFileSync(path.join(b.dir, 'summary.md'), 'utf8'), /## 이전 실행과 비교/);
});
