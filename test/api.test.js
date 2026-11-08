'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const { createServer } = require('../server/index');
const cases = require('../server/cases');
const loop = require('../server/loop');
const fs = require('node:fs');
const path = require('node:path');
const prefilter = require('../server/prefilter');

const ROOT = path.join(__dirname, '..');

let server; let base;
before(async () => {
  db.init(':memory:'); llm.use('mock');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const api = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };

test('health · policy · stats · status', async () => {
  const h = await api('GET', '/api/health'); assert.equal(h.status, 200); assert.deepEqual(h.data, { ok: true, config: 'ok' });
  const ss = await api('GET', '/api/status'); assert.equal(ss.status, 200); assert.equal(ss.data.provider.llm, 'mock');
  const p = await api('GET', '/api/policy'); assert.equal(p.data.length, 3);
  const s = await api('GET', '/api/stats'); assert.equal(typeof s.data.awaitingApproval, 'number');
  const st = await api('GET', '/api/agent/status'); assert.equal(st.data.running, false);
});

test('inbound → SSE agent.step 수신 → 목록 → 승인 → 상세', async () => {
  // SSE 먼저 연다
  const ac = new AbortController();
  const sseRes = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = sseRes.body.getReader(); const dec = new TextDecoder(); let buf = '';
  const gotStep = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return false; buf += dec.decode(value, { stream: true }); if (/event: agent\.step/.test(buf)) return true; } })();

  const inb = await api('POST', '/api/inbound', { channel: 'support', from: 'api@example.com', name: '테스터', subject: '탈퇴', body: '계정을 탈퇴하고 싶습니다.' });
  assert.equal(inb.status, 200); assert.ok(inb.data.caseId); assert.equal(inb.data.created, true);
  const row = await until(async () => (await api('GET', '/api/cases?state=AWAITING_APPROVAL')).data.find((c) => c.id === inb.data.caseId && c.pendingDraftId));
  assert.equal(row.state, 'AWAITING_APPROVAL'); assert.equal(row.threadId, inb.data.threadId);
  assert.equal(await gotStep, true); ac.abort();

  const bad = await api('POST', `/api/drafts/${row.pendingDraftId}/approve`, {}); assert.equal(bad.status, 400);
  const ok = await api('POST', `/api/drafts/${row.pendingDraftId}/approve`, { by: 'tester' }); assert.equal(ok.status, 200); assert.ok(ok.data.dispatchId);
  const again = await api('POST', `/api/drafts/${row.pendingDraftId}/approve`, { by: 'tester' }); assert.equal(again.status, 409); assert.equal(again.data.error, 'not_pending');

  const det = await api('GET', `/api/cases/${inb.data.caseId}`);
  assert.equal(det.data.case.state, 'WAITING_CUSTOMER');
  assert.ok(det.data.messages.some((m) => m.direction === 'out'));
  assert.ok(det.data.decisions.length >= 6);
  assert.deepEqual(det.data.activities.map((a) => a.type), ['approve']);

  // 같은 스레드 재회신 → 새 회차, 상세에 메시지 3개
  const re = await api('POST', '/api/inbound', { channel: 'support', from: 'api@example.com', subject: 'Re: 탈퇴', body: '감사합니다. 확인했습니다.', threadId: inb.data.threadId });
  assert.equal(re.data.created, false);
  await until(async () => (await api('GET', `/api/cases/${inb.data.caseId}`)).data.decisions.some((d) => d.step === 'execute' && d.message_id === re.data.messageId));
  const det2 = await api('GET', `/api/cases/${inb.data.caseId}`);
  assert.equal(det2.data.messages.length, 3);
  assert.equal(det2.data.case.state, 'WAITING_CUSTOMER'); // ack는 무시, 상태 유지
});

test('잘못된 channel → 400, 없는 케이스 → 404, 정적 루트 응답', async () => {
  assert.equal((await api('POST', '/api/inbound', { channel: 'nope', from: 'a@b.c', body: 'x' })).status, 400);
  assert.equal((await api('GET', '/api/cases/none')).status, 404);
  const r = await fetch(`${base}/`); assert.equal(r.status, 200);
});

describe('프롬프트·KB 버전 조회', () => {
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); process.env.AUTO_SEND = '0'; for (const k of ['SHADOW_CHANNELS', 'AUTH_USER_HEADER', 'NODE_ENV', 'AUTO_CLOSE_DAYS', 'ENABLE_TEST_INJECT', 'INBOUND_SECRET']) delete process.env[k]; });

  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `cf-${n}`; const from = `cf${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }
  async function withServer(fn) {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, p, body, headers = {}) => {
      const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    try { return await fn(api); } finally { server.close(); }
  }

  test('버전: 프롬프트 원본·KB 본문이 해시로 저장되고 API로 되찾는다', async () => {
    const r = await thread().run('영수증 발급 방법 알려주세요');
    const tri = db.get("SELECT prompt_version, kb_version FROM decisions WHERE case_id=? AND step='triage'", r.caseId);
    await withServer(async (api) => {
      const pv = await api('GET', `/api/versions/${tri.prompt_version}`);
      assert.equal(pv.status, 200); assert.equal(pv.data.kind, 'prompt:triage'); assert.match(pv.data.content, /냉정한 접수 담당자/);
      const kv = await api('GET', `/api/versions/${tri.kb_version}`);
      assert.equal(kv.data.kind, 'kb:support:ko'); assert.match(kv.data.content, /## kb:receipt/);
      assert.equal((await api('GET', '/api/versions/deadbeef')).status, 404);
    });
  });
});

describe('정책 팩 원문 버전 기록', () => {
  const ENV = ['LLM_MOCK_DELAY_MS', 'MAIL_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL', 'AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'LLM_RETRY_SCALE'];
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; });

  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `f2-${n}`; const from = `f2-${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }

  test('정책 팩 원문을 versions에 저장, responder_human·failSafe 판단 행도 버전을 남긴다', async () => {
    const t = thread();
    const r = await t.run('영수증 발급 방법 알려주세요');
    const pv = db.get("SELECT policy_version FROM decisions WHERE case_id=? AND step='gate1'", r.caseId).policy_version;
    const v = db.get('SELECT * FROM versions WHERE hash=?', pv);
    assert.equal(v.kind, 'policy:support');
    assert.equal(v.content, fs.readFileSync(path.join(ROOT, 'policy/support.json'), 'utf8'));
    await t.run('환불해 주세요'); await t.run('답이 없네요'); // 두 번째는 responder_human
    const orig = prefilter.check;
    prefilter.check = () => { throw new Error('boom'); }; // 회차 밖 예외 → failSafe
    try { await thread().run('구독 해지 방법'); } finally { prefilter.check = orig; }
    const rows = db.all("SELECT step, reason FROM decisions WHERE policy_version IS NULL OR kb_version IS NULL");
    assert.deepEqual(rows, [], '버전 없는 판단 행 없음');
  });
});

test('HTTP: 깨진 URI 400 · 경로 탈출 차단 · JSON 아니면 415 · limit 범위 · 500에 내부 메시지 없음', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    assert.ok([403, 404].includes((await fetch(`${base}/..%2f..%2fpackage.json`)).status));
    assert.equal((await fetch(`${base}/api/test/inbound`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    for (let i = 0; i < 3; i += 1) cases.addInbound({ channel: 'support', from: `lim${i}@example.com`, body: '영수증' });
    assert.equal((await (await fetch(`${base}/api/cases?limit=-1`)).json()).length, 1);
  } finally { server.close(); }
});

describe('예산 소진 넘김과 /api/status 운영 필드', () => {
  const ENV = ['AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'MAIL_PROVIDER', 'SHADOW_CHANNELS', 'NODE_ENV', 'ENABLE_TEST_INJECT',
    'REQUIRE_SENDER_AUTH', 'RETENTION_DAYS', 'LLM_DAILY_TOKEN_BUDGET'];
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; process.env.AUTO_SEND = '0'; });
  after(() => { for (const k of ENV) delete process.env[k]; });

  const JSON_H = { 'content-type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } };
  // 수신 응답 뒤에 도는 회차가 끝날 때까지(판단 기록이 생기고 활성 목록에서 빠짐)
  const idle = (caseId) => until(() => db.get('SELECT COUNT(*) n FROM decisions WHERE case_id=?', caseId).n && !loop.status().activeCases.includes(caseId));
  const n = (sql, ...p) => db.get(sql, ...p).n;
  async function withServer(fn) {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
  }
  const post = (base, p, body, h = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { ...JSON_H, ...h }, body: JSON.stringify(body) });

  test('예산 소진: 오늘 사용량이 상한에 닿으면 새 문의는 LLM 없이 재시도 없이 넘김, /api/report에 상한·사용량', async () => {
    db.insert('llm_calls', { id: db.uuid(), agent: 'triage', provider: 'mock', input_tokens: 70, output_tokens: 30, ok: 1, created_at: db.now() });
    process.env.LLM_DAILY_TOKEN_BUDGET = '100';
    const errs = []; const warn = console.warn; console.warn = (...a) => errs.push(a.join(' '));
    try {
      await withServer(async (base) => {
        const r = await (await post(base, '/api/test/inbound', { channel: 'support', from: 'bud@example.com', subject: '영수증', body: '영수증 발급 방법 알려주세요' })).json();
        await idle(r.caseId);
        assert.equal(db.get('SELECT state FROM cases WHERE id=?', r.caseId).state, 'HANDED_OFF');
        assert.equal(db.get('SELECT next_retry_at FROM loops WHERE case_id=?', r.caseId).next_retry_at, null);
        assert.equal(n('SELECT COUNT(*) n FROM llm_calls WHERE case_id=?', r.caseId), 0);
        assert.equal(JSON.parse(db.get("SELECT output FROM decisions WHERE case_id=? AND step='error'", r.caseId).output).budget, true);
        const rep = await (await fetch(`${base}/api/report`)).json();
        assert.deepEqual(rep.llm.budget, { limit: 100, used: 100 });
      });
    } finally { console.warn = warn; }
    assert.ok(errs.some((e) => e.includes('예산')), errs.join('\n'));
  });

  test('/api/status 운영 필드: 발신자 인증 요구·자동 발송·보존·예산이 env를 따른다', async () => {
    await withServer(async (base) => {
      const st = async () => (await fetch(`${base}/api/status`)).json();
      const pick = ({ autoSend, senderAuth, retentionDays, tokenBudget }) => ({ autoSend, senderAuth, retentionDays, tokenBudget });
      const s0 = await st();
      assert.equal(s0.ok, true);
      assert.deepEqual(pick(s0), { autoSend: false, senderAuth: 'optional', retentionDays: null, tokenBudget: null });
      process.env.NODE_ENV = 'production';
      assert.equal((await st()).senderAuth, 'required');
      process.env.REQUIRE_SENDER_AUTH = '0';
      assert.equal((await st()).senderAuth, 'optional');
      Object.assign(process.env, { NODE_ENV: '', REQUIRE_SENDER_AUTH: '1', AUTO_SEND: '1', RETENTION_DAYS: '30', LLM_DAILY_TOKEN_BUDGET: '5000' });
      assert.deepEqual(pick(await st()), { autoSend: true, senderAuth: 'required', retentionDays: 30, tokenBudget: 5000 });
    });
  });
});
