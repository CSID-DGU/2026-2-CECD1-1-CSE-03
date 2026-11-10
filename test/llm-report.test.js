'use strict';
// LLM 계량(llm_calls)·일일 토큰 예산·운영 리포트(사용량·비용·intent별 승격·CSV·미평가 섀도 목록).
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach, afterEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const mock = require('../server/llm/mock');
const anthropic = require('../server/llm/anthropic');
const common = require('../server/agents/common');
const cases = require('../server/cases');
const loop = require('../server/loop');
const report = require('../server/report');
const policy = require('../server/policy');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accesslog = require('../server/accesslog');
const { createServer } = require('../server/index');

const ENV = ['LLM_DAILY_TOKEN_BUDGET', 'LLM_PRICE_INPUT_PER_MTOK', 'LLM_PRICE_OUTPUT_PER_MTOK', 'SHADOW_CHANNELS', 'AUTO_SEND'];
before(() => db.init(':memory:'));
beforeEach(() => { for (const k of ENV) delete process.env[k]; process.env.AUTO_SEND = '0'; llm.use('mock'); });
afterEach(() => { for (const k of ENV) delete process.env[k]; });

let seq = 0;
const inbound = (body, channel = 'support') => cases.addInbound({ channel, from: `r${++seq}@example.com`, body, threadId: `rep-${seq}` });
const run = async (body, channel) => { const r = inbound(body, channel); await loop.runCycle(r.caseId, r.messageId); return r; };
const callRows = () => db.get('SELECT COUNT(*) n FROM llm_calls').n;
const direct = (extra = {}) => common.call({ agent: 'triage', system: 's', user: 'u', schema: null, ctx: { caseId: 'c-direct', messageId: 'm-direct' }, source: 'src', ...extra });

test('한 회차의 LLM 호출마다 llm_calls 한 행 — 토큰·모델·지연, 실패 호출도 ok=0', async () => {
  let n = 0;
  const meta = (req) => { n += 1; Object.assign(req.meta, { model: 'stub-1', inputTokens: 100, outputTokens: 20 }); };
  llm.use({ name: 'stub', json: async (req) => { meta(req); return mock.json(req); }, chat: async (req) => { meta(req); return mock.chat(req); } });
  const r = await run('영수증 발급 방법 알려주세요');
  const rows = db.all('SELECT * FROM llm_calls WHERE case_id=?', r.caseId);
  assert.ok(n >= 3, `호출 ${n}`); assert.equal(rows.length, n);
  for (const x of rows) {
    assert.equal(x.provider, 'stub'); assert.equal(x.model, 'stub-1'); assert.equal(x.message_id, r.messageId);
    assert.equal(x.input_tokens, 100); assert.equal(x.output_tokens, 20); assert.equal(x.ok, 1); assert.equal(x.error, null);
    assert.ok(Number.isInteger(x.latency_ms) && x.latency_ms >= 0);
  }
  assert.deepEqual([...new Set(rows.map((x) => x.agent))].slice(0, 3), ['triage', 'responder', 'reviewer']); // 답장 Agent는 툴 루프 걸음마다 한 행

  llm.use({ name: 'down', json: async () => { throw Object.assign(new Error('bad request: 고객 본문이 담긴 응답'), { status: 400 }); } });
  await assert.rejects(direct(), (e) => e.status === 400);
  const f = db.get("SELECT * FROM llm_calls WHERE case_id='c-direct' ORDER BY created_at DESC, rowid DESC LIMIT 1");
  assert.equal(f.ok, 0); assert.equal(f.error, '400'); assert.equal(f.provider, 'down'); assert.equal(f.input_tokens, 0);
});

test('mock provider 호출도 계량된다(토큰 0, 모델 없음), call 반환에 usage', async () => {
  const r = await run('탈퇴하고 싶어요');
  const rows = db.all('SELECT * FROM llm_calls WHERE case_id=?', r.caseId);
  assert.ok(rows.length >= 1);
  for (const x of rows) { assert.equal(x.provider, 'mock'); assert.equal(x.model, null); assert.equal(x.input_tokens, 0); assert.equal(x.ok, 1); }
  llm.use({ name: 'stub', json: async (req) => { Object.assign(req.meta, { model: 'stub-1', inputTokens: 3, outputTokens: 4 }); return { ok: true }; } });
  const out = await direct();
  assert.deepEqual(out.result, { ok: true }); assert.deepEqual(out.usage, { model: 'stub-1', inputTokens: 3, outputTokens: 4 });
});

test('일일 토큰 예산 = 오늘 합계 → 호출 없이 llm_budget, 행이 늘지 않음, 경고는 한 번', async () => {
  let n = 0;
  llm.use({ name: 'stub', json: async (req) => { n += 1; Object.assign(req.meta, { inputTokens: 10, outputTokens: 5 }); return mock.json(req); } });
  await direct();
  const used = report.budget().used;
  assert.ok(used >= 15);
  process.env.LLM_DAILY_TOKEN_BUDGET = String(used + 1);
  await direct(); // 아직 남았다 — 부른다(넘기는 것은 그다음부터)
  process.env.LLM_DAILY_TOKEN_BUDGET = String(report.budget().used);
  const before = callRows(); const calls = n;
  const warn = console.warn; const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    await assert.rejects(direct(), (e) => e.code === 'llm_budget' && e.message === 'llm_budget');
    await assert.rejects(direct(), (e) => e.code === 'llm_budget');
    process.env.LLM_DAILY_TOKEN_BUDGET = 'abc'; // 잘못된 값 = 0 = 전부 차단
    await assert.rejects(direct(), (e) => e.code === 'llm_budget');
  } finally { console.warn = warn; }
  assert.equal(callRows(), before); assert.equal(n, calls);
  assert.equal(warned.length, 1); assert.match(warned[0], /예산/);
  delete process.env.LLM_DAILY_TOKEN_BUDGET;
  await direct();
  assert.equal(callRows(), before + 1);
});

test('anthropic provider가 meta에 모델·토큰(캐시 포함)을 채운다 — 잘림으로 던질 때도', async () => {
  const fetch0 = globalThis.fetch; const key0 = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const reply = (stop) => ({ ok: true, json: async () => ({ model: 'm-x', stop_reason: stop, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 7 }, content: [{ type: 'text', text: '{"a":1}' }] }) });
  try {
    globalThis.fetch = async () => reply('end_turn');
    const meta = {};
    assert.deepEqual(await anthropic.json({ system: 's', user: 'u', meta }), { a: 1 });
    assert.deepEqual(meta, { model: 'm-x', inputTokens: 17, outputTokens: 7 });
    globalThis.fetch = async () => reply('max_tokens');
    const cut = {};
    await assert.rejects(anthropic.json({ system: 's', user: 'u', meta: cut }), /max_tokens/);
    assert.deepEqual(cut, { model: 'm-x', inputTokens: 17, outputTokens: 7 });
  } finally {
    globalThis.fetch = fetch0;
    if (key0 === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key0;
  }
});

test('llmUsage: 오늘·누적·케이스당·에이전트별, 단가가 있을 때만 비용', () => {
  db.init(':memory:');
  const row = (case_id, agent, input_tokens, output_tokens, latency_ms, ok, created_at) => db.insert('llm_calls', { id: db.uuid(), case_id, agent, provider: 'anthropic', model: 'm-1', input_tokens, output_tokens, latency_ms, ok, error: ok ? null : '503', created_at });
  row('a', 'triage', 1000, 200, 100, 1, '2026-10-31T01:00:00.000Z');
  row('a', 'responder', 2000, 400, 300, 1, '2026-10-31T02:00:00.000Z');
  row('b', 'triage', 1000, 0, 200, 0, '2026-10-31T23:59:59.000Z');
  row('c', 'triage', 1_000_000, 0, 400, 1, '2026-10-30T23:59:59.000Z'); // 어제(UTC)
  const now = new Date('2026-10-31T12:00:00Z');

  let u = report.llmUsage(now);
  assert.deepEqual(u.today, { calls: 3, inputTokens: 4000, outputTokens: 600, costUsd: null });
  assert.deepEqual(u.budget, { limit: null, used: 4600 });
  assert.deepEqual(u.perCase, { cases: 3, avgTokens: 334867, avgCostUsd: null, avgLatencyMs: 333 });
  assert.deepEqual(u.models.map((m) => ({ ...m })), [{ provider: 'anthropic', model: 'm-1', calls: 4 }]); // node:sqlite 행은 null 프로토타입

  process.env.LLM_PRICE_INPUT_PER_MTOK = '3'; process.env.LLM_PRICE_OUTPUT_PER_MTOK = '15'; process.env.LLM_DAILY_TOKEN_BUDGET = '5000';
  u = report.llmUsage(now);
  assert.equal(u.today.costUsd, 0.021);
  assert.deepEqual(u.total, { calls: 4, inputTokens: 1_004_000, outputTokens: 600, costUsd: 3.021 });
  assert.equal(u.perCase.avgCostUsd, 1.007);
  assert.deepEqual(u.budget, { limit: 5000, used: 4600 });
  assert.deepEqual(u.byAgent, [
    { agent: 'responder', calls: 1, inputTokens: 2000, outputTokens: 400, failures: 0, avgLatencyMs: 300, costUsd: 0.012 },
    { agent: 'triage', calls: 3, inputTokens: 1_002_000, outputTokens: 200, failures: 1, avgLatencyMs: 233, costUsd: 3.009 },
  ]);
  process.env.LLM_PRICE_OUTPUT_PER_MTOK = ''; // 하나만 있으면 비용을 내지 않는다
  assert.equal(report.llmUsage(now).today.costUsd, null);
});

test('promotionByIntent: 채널별 합이 cases.promotion과 같다(발송 초안 + 초안당 마지막 섀도 평가)', async () => {
  db.init(':memory:');
  const pend = (caseId) => db.get("SELECT id FROM drafts WHERE case_id=? AND status='PENDING'", caseId).id;
  const shadowOf = (caseId) => db.get("SELECT id FROM drafts WHERE case_id=? AND status='SHADOW'", caseId).id;
  const r1 = await run('영수증 발급 방법 알려주세요');
  await loop.approveDraft(pend(r1.caseId), { by: 'h' });
  const r2 = await run('로그인이 안 돼요. 비밀번호 재설정 방법 알려주세요');
  await loop.approveDraft(pend(r2.caseId), { by: 'h', finalBody: '고친 답장입니다. 비밀번호 재설정은 로그인 화면에서 합니다.', editTags: ['critical'] });
  process.env.SHADOW_CHANNELS = 'support,sales';
  const s1 = await run('구독 해지 방법 알려주세요');
  loop.rateShadow(shadowOf(s1.caseId), { by: 'h', rating: 'good' });
  loop.rateShadow(shadowOf(s1.caseId), { by: 'h', rating: 'needs_edit' }); // 마지막만 센다
  const s2 = await run('영수증 다시 받을 수 있나요?');
  loop.rateShadow(shadowOf(s2.caseId), { by: 'h', rating: 'critical' });
  const s3 = await run('회사 소개서 자료 보내주세요', 'sales');
  loop.rateShadow(shadowOf(s3.caseId), { by: 'h', rating: 'good' });

  const p = report.promotionByIntent();
  assert.deepEqual(p.criteria, { minReviewed: 50, minNoEditRate: 0.9, maxCritical: 0 });
  for (const ch of ['support', 'sales']) {
    const rows = p.rows.filter((r) => r.channel === ch);
    const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
    const want = cases.promotion(ch);
    assert.ok(want.reviewed > 0, ch);
    assert.equal(sum((r) => r.reviewed), want.reviewed, `${ch} reviewed`);
    assert.equal(sum((r) => Math.round(r.approvedNoEditRate * r.reviewed)), Math.round(want.approvedNoEditRate * want.reviewed), `${ch} good`);
    assert.equal(sum((r) => r.criticalCount), want.criticalCount, `${ch} critical`);
  }
  const receipt = p.rows.find((r) => r.channel === 'support' && r.intent === 'receipt');
  // 섀도로 도는 채널은 팩 등급(L2)이 아니라 실제 등급 L0
  assert.deepEqual(receipt, { channel: 'support', intent: 'receipt', level: 'L0', reviewed: 2, approvedNoEditRate: 0.5, criticalCount: 1, eligible: false });
  assert.ok(p.rows.every((r) => Object.keys(r).join() === 'channel,intent,level,reviewed,approvedNoEditRate,criticalCount,eligible'));
  delete process.env.SHADOW_CHANNELS;
  const lv = (ch, intent) => report.promotionByIntent().rows.find((r) => r.channel === ch && r.intent === intent).level;
  assert.equal(lv('support', 'receipt'), 'L1'); // AUTO_SEND=0이면 L2 intent도 사람 승인
  process.env.AUTO_SEND = '1';
  assert.equal(lv('support', 'receipt'), 'L2');
  assert.equal(lv('support', 'login_issue'), 'L1');
});

test('promotionByIntent 등급 = 실제로 도는 등급: H 우선, 섀도 L0, 팩 maxLevel이 깎는다, 자동 발송이 꺼지면 L2도 L1, 등급 없는 intent는 null', () => {
  db.init(':memory:');
  process.env.AUTO_SEND = '1';
  const r = inbound('아무 문의');
  for (const intent of ['a2', 'a1', 'ah', 'none']) {
    db.insert('drafts', { id: db.uuid(), case_id: r.caseId, trigger_message_id: r.messageId, status: 'SENT', intent, action: 'DRAFT', original_body: 'x', idempotency_key: db.uuid(), approved_by: 'h', created_at: db.now() });
  }
  const real = policy.load;
  const levels = (pack) => {
    policy.load = () => ({ intents: { a2: { level: 'L2' }, a1: { level: 'L1' }, ah: { level: 'H' }, none: {} }, ...pack });
    try { return Object.fromEntries(report.promotionByIntent().rows.map((x) => [x.intent, x.level])); } finally { policy.load = real; }
  };
  assert.deepEqual(levels({ maxLevel: 'L2', shadow: false }), { a1: 'L1', a2: 'L2', ah: 'H', none: null });
  assert.deepEqual(levels({ maxLevel: 'L2', shadow: true }), { a1: 'L0', a2: 'L0', ah: 'H', none: null });
  assert.deepEqual(levels({ maxLevel: 'L1', shadow: false }), { a1: 'L1', a2: 'L1', ah: 'H', none: null });
  assert.deepEqual(levels({ maxLevel: 'L0', shadow: false }), { a1: 'L0', a2: 'L0', ah: 'H', none: null });
  assert.deepEqual(levels({ maxLevel: 'H', shadow: false }), { a1: 'H', a2: 'H', ah: 'H', none: null });
  process.env.AUTO_SEND = '0';
  assert.deepEqual(levels({ maxLevel: 'L2', shadow: false }), { a1: 'L1', a2: 'L1', ah: 'H', none: null });
});

test('promotionCsv: 머리줄·행 수, 수식 주입 칸(= + - @ TAB CR)은 \' 접두, 따옴표·쉼표 이스케이프', () => {
  db.init(':memory:');
  const r = inbound('아무 문의');
  const intents = ['=1+1', '@SUM(A1)', '\tx', '\rx', '+cmd', '-2', 'a,"b"', null];
  for (const intent of intents) {
    db.insert('drafts', { id: db.uuid(), case_id: r.caseId, trigger_message_id: r.messageId, status: 'SENT', intent, action: 'DRAFT', original_body: 'x', idempotency_key: db.uuid(), approved_by: 'h', created_at: db.now() });
  }
  const csv = report.promotionCsv();
  assert.ok(csv.endsWith('\r\n'));
  const lines = csv.slice(0, -2).split('\r\n');
  assert.equal(lines[0], 'channel,intent,level,reviewed,approvedNoEditRate,criticalCount,eligible');
  assert.equal(lines.length, 1 + intents.length);
  for (const cellText of ["support,'=1+1,", "support,'@SUM(A1),", "support,'\tx,", `support,"'\rx",`, "support,'+cmd,", "support,'-2,", 'support,"a,""b""",', 'support,(없음),']) {
    assert.ok(lines.some((l) => l.startsWith(cellText)), JSON.stringify(cellText));
  }
  assert.ok(lines.slice(1).every((l) => l.endsWith(',1,1,0,false')));
});

test('unratedShadow: 평가 전 1건 → 평가 후 0건, 채널 필터, 파기된 케이스 제외', async () => {
  db.init(':memory:');
  process.env.SHADOW_CHANNELS = 'support,sales';
  const a = await run('구독 해지 방법 알려주세요');
  const b = await run('회사 소개서 자료 보내주세요', 'sales');
  const all = report.unratedShadow();
  assert.equal(all.length, 2);
  const [item] = report.unratedShadow({ channel: 'support' });
  const d = db.get("SELECT * FROM drafts WHERE case_id=? AND status='SHADOW'", a.caseId);
  assert.deepEqual(Object.keys(item), ['draftId', 'caseId', 'channel', 'intent', 'createdAt', 'subject', 'question', 'body']);
  assert.equal(item.draftId, d.id); assert.equal(item.caseId, a.caseId); assert.equal(item.channel, 'support');
  assert.equal(item.intent, 'cancel_subscription'); assert.equal(item.question, '구독 해지 방법 알려주세요'); assert.equal(item.body, d.original_body);
  assert.equal(report.unratedShadow({ channel: 'sales' }).length, 1);
  assert.equal(report.unratedShadow({ channel: 'onboarding' }).length, 0);
  assert.equal(report.unratedShadow({ limit: 1 }).length, 1);

  loop.rateShadow(d.id, { by: 'h', rating: 'good' });
  assert.equal(report.unratedShadow({ channel: 'support' }).length, 0);
  db.run('UPDATE cases SET purged_at=? WHERE id=?', db.now(), b.caseId);
  assert.equal(report.unratedShadow().length, 0);

  const long = await run(`구독 해지 ${'가'.repeat(1500)}`);
  assert.equal(report.unratedShadow()[0].caseId, long.caseId);
  assert.equal(report.unratedShadow()[0].question.length, 1000);
});

describe('섀도 평가와 채널 승격 지표', () => {
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); process.env.AUTO_SEND = '0'; for (const k of ['SHADOW_CHANNELS', 'AUTH_USER_HEADER', 'NODE_ENV', 'AUTO_CLOSE_DAYS', 'ENABLE_TEST_INJECT', 'INBOUND_SECRET']) delete process.env[k]; });

  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `cf-${n}`; const from = `cf${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }
  const pending = (id) => db.all("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", id);

  test('섀도: SHADOW_CHANNELS는 좁히기만, 섀도 초안 평가 → 채널 승격 지표', async () => {
    process.env.SHADOW_CHANNELS = 'support';
    assert.equal(policy.load('support').shadow, true); assert.equal(policy.load('sales').shadow, false);
    const r = await thread().run('구독 해지 방법 알려주세요');
    const sd = db.get("SELECT * FROM drafts WHERE case_id=? AND status='SHADOW'", r.caseId);
    assert.ok(sd); assert.equal(pending(r.caseId).length, 0);
    const before = cases.promotion('support');
    loop.rateShadow(sd.id, { by: 'h', rating: 'good' });
    loop.rateShadow(sd.id, { by: 'h', rating: 'critical', note: '틀린 경로' }); // 마지막 평가만 센다
    const p = cases.promotion('support');
    assert.equal(p.reviewed, before.reviewed + 1); assert.equal(p.criticalCount, before.criticalCount + 1); assert.equal(p.eligible, false);
    assert.deepEqual(p.criteria, { minReviewed: 50, minNoEditRate: 0.9, maxCritical: 0 });
    assert.throws(() => loop.rateShadow(sd.id, { by: 'h', rating: 'meh' }), (e) => e.status === 400);
    delete process.env.SHADOW_CHANNELS;
    const r2 = await thread().run('영수증 발급 방법 알려주세요');
    assert.throws(() => loop.rateShadow(pending(r2.caseId)[0].id, { by: 'h', rating: 'good' }), (e) => e.status === 409);
    assert.ok(cases.stats().promotion.support);
  });
});

test('anthropic provider: 4xx 재시도 안 함 · 429 재시도 · 타임아웃 · max_tokens · 정상', async () => {
  let calls = 0; let mode = 'ok';
  const srv = http.createServer((req, res) => {
    calls += 1;
    req.resume();
    if (mode === 'hang') return; // 응답 안 함
    if (mode === '400') { res.writeHead(400); return res.end('bad'); }
    if (mode === '429' && calls === 1) { res.writeHead(429, { 'retry-after': '0' }); return res.end('slow down'); }
    const stop = mode === 'max' ? 'max_tokens' : 'end_turn';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stop_reason: stop, content: [{ type: 'text', text: '{"ok":true}' }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${srv.address().port}/v1/messages`, ANTHROPIC_API_KEY: 'test', LLM_TIMEOUT_MS: '100' });
  const call = async (m) => { mode = m; calls = 0; llm.use('anthropic'); return llm.json({ agent: 'triage', system: 's', user: 'u' }); };
  try {
    assert.deepEqual(await call('ok'), { ok: true }); assert.equal(calls, 1);
    await assert.rejects(call('400'), /anthropic 400/); assert.equal(calls, 1);
    assert.deepEqual(await call('429'), { ok: true }); assert.equal(calls, 2);
    await assert.rejects(call('max'), /max_tokens/); assert.equal(calls, 1);
    await assert.rejects(call('hang'), (e) => /timeout|abort/i.test(`${e.name} ${e.message}`)); assert.equal(calls, 2);
  } finally {
    srv.closeAllConnections(); srv.close();
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'LLM_TIMEOUT_MS']) delete process.env[k];
  }
});

describe('운영 리포트·CSV·섀도 API', () => {
  const ENV = ['AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'MAIL_PROVIDER', 'SHADOW_CHANNELS', 'NODE_ENV', 'ENABLE_TEST_INJECT',
    'REQUIRE_SENDER_AUTH', 'RETENTION_DAYS', 'LLM_DAILY_TOKEN_BUDGET'];
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; process.env.AUTO_SEND = '0'; });
  after(() => { for (const k of ENV) delete process.env[k]; });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-report-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const JSON_H = { 'content-type': 'application/json' };
  const U = { 'x-forwarded-user': 'kim' };
  async function withServer(fn) {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
  }
  const post = (base, p, body, h = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { ...JSON_H, ...h }, body: JSON.stringify(body) });

  test('리포트·CSV·업무 대체·섀도 API: 모양, 인증 켜면 넷 다 401, 섀도 목록은 접속기록, 평가하면 목록에서 빠지고 CSV에 행', async () => {
    process.env.SHADOW_CHANNELS = 'support';
    const r = cases.addInbound({ channel: 'support', from: 'sh@example.com', subject: '영수증', body: '영수증 발급 방법 알려주세요' });
    await loop.runCycle(r.caseId, r.messageId);
    const draftId = db.get("SELECT id FROM drafts WHERE case_id=? AND status='SHADOW'", r.caseId).id;
    const file = path.join(tmp, 'access.jsonl');
    const stop = accesslog.start(file);
    process.env.AUTH_USER_HEADER = 'x-forwarded-user';
    try {
      await withServer(async (base) => {
        for (const p of ['/api/report', '/api/report/promotion.csv', '/api/report/workload', '/api/shadow']) assert.equal((await fetch(`${base}${p}`)).status, 401, p);
        const rep = await (await fetch(`${base}/api/report`, { headers: U })).json();
        assert.deepEqual(Object.keys(rep), ['llm', 'promotion']);
        assert.deepEqual(Object.keys(rep.llm), ['today', 'budget', 'total', 'perCase', 'byAgent', 'models']);
        assert.deepEqual(rep.promotion.criteria, policy.PROMOTION);
        const sh = await (await fetch(`${base}/api/shadow?channel=support`, { headers: U })).json();
        assert.deepEqual(sh.items.map((i) => i.draftId), [draftId]);
        assert.deepEqual(Object.keys(sh.items[0]), ['draftId', 'caseId', 'channel', 'intent', 'createdAt', 'subject', 'question', 'body']);
        assert.deepEqual((await (await fetch(`${base}/api/shadow?channel=sales`, { headers: U })).json()).items, []);
        assert.equal((await post(base, `/api/drafts/${draftId}/rate`, { rating: 'good' }, U)).status, 200);
        assert.deepEqual((await (await fetch(`${base}/api/shadow`, { headers: U })).json()).items, []);
        const csv = await fetch(`${base}/api/report/promotion.csv`, { headers: U });
        assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
        assert.match(csv.headers.get('content-disposition'), /^attachment/);
        const lines = (await csv.text()).trim().split('\r\n');
        assert.equal(lines[0], 'channel,intent,level,reviewed,approvedNoEditRate,criticalCount,eligible');
        assert.ok(lines.some((l) => l.startsWith('support,')), lines.join('\n'));
      });
    } finally { stop(); }
    const logs = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.action === 'shadow.list');
    assert.equal(logs.length, 3);
    assert.deepEqual([logs[0].user, logs[0].channel, logs[0].count, !!logs[0].ip], ['kim', 'support', 1, true]);
  });
});
