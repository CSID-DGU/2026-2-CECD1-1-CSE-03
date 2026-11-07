'use strict';
// 보안 경계 — 시작 검사, 보안 헤더, 헬스체크·상태, 미러 페이로드 거부, 신뢰 안 되는 수신 필드, 접속기록, 웹훅 시크릿·실발송 수신자 도메인 허용 목록, 인증 헤더.
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const accesslog = require('../server/accesslog');
const { createServer, preflight } = require('../server/index');
const mail = require('../server/mail');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-security-'));
const ENV = ['AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'MAIL_PROVIDER', 'SHADOW_CHANNELS', 'NODE_ENV', 'ENABLE_TEST_INJECT'];
before(() => { db.init(':memory:'); });
beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; process.env.AUTO_SEND = '0'; });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SECRETS = { INBOUND_SECRET: 's', AUTH_USER_HEADER: 'x-forwarded-user', PROXY_SHARED_SECRET: 'p' };
const U = { 'x-forwarded-user': 'kim' };
const JSON_H = { 'content-type': 'application/json' };
async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
}
const pendingDraft = async (from) => {
  const r = cases.addInbound({ channel: 'support', from, name: '김민지', subject: '영수증', body: '영수증 발급 방법 알려주세요' });
  await loop.runCycle(r.caseId, r.messageId);
  return { caseId: r.caseId, draftId: db.get("SELECT id FROM drafts WHERE case_id=? AND status='PENDING'", r.caseId).id };
};

test('preflight: production은 세 시크릿을 각각 요구(mock 허용이어도), 개발은 빈 배열', () => {
  const e = preflight({ NODE_ENV: 'production', MAIL_PROVIDER: 'smtp' }).errors;
  assert.equal(e.length, 3);
  for (const k of Object.keys(SECRETS)) assert.ok(e.some((x) => x.includes(k)), k);
  assert.ok(e.every((x) => /NODE_ENV를 비운다/.test(x)), '해법(발송 없는 시연은 NODE_ENV 비움)을 알려 준다');
  assert.equal(preflight({ NODE_ENV: 'production', MAIL_PROVIDER: 'mock', ALLOW_MOCK_MAIL: '1' }).errors.length, 3);
  assert.deepEqual(preflight({ NODE_ENV: 'production', MAIL_PROVIDER: 'smtp', ADMIN_USERS: 'admin', ...SECRETS }), { errors: [], warnings: [] });
  assert.deepEqual(preflight({}), { errors: [], warnings: [] });
  assert.deepEqual(preflight({ MAIL_PROVIDER: 'smtp' }), { errors: [], warnings: [] });
});

test('preflight: NODE_ENV를 비워도 smtp + 루프백 아닌 HOST면 세 시크릿을 요구, 루프백 smtp·mock LAN 시연은 그대로', () => {
  for (const HOST of ['0.0.0.0', '::', '192.168.0.10']) {
    const e = preflight({ NODE_ENV: '', MAIL_PROVIDER: 'smtp', HOST }).errors; // Docker -e NODE_ENV= 는 이미지의 smtp·0.0.0.0을 그대로 둔다
    assert.equal(e.length, 3, HOST);
    for (const k of Object.keys(SECRETS)) assert.ok(e.some((x) => x.includes(k) && x.includes(`HOST=${HOST}`)), `${HOST} ${k}`);
    assert.deepEqual(preflight({ MAIL_PROVIDER: 'smtp', HOST, ...SECRETS }).errors, []);
    assert.deepEqual(preflight({ MAIL_PROVIDER: 'mock', HOST }).errors, [], 'mock 메일 LAN 시연');
  }
  for (const HOST of [undefined, '', '127.0.0.1', '::1', 'localhost']) assert.deepEqual(preflight({ MAIL_PROVIDER: 'smtp', HOST }).errors, [], `루프백 smtp(로컬 메일 E2E) ${HOST}`);
});

test('preflight: 미러는 환경과 무관하게 mock 메일·자동 발송 끔·섀도 채널 셋 다 필요', () => {
  const ok = { IMAP_MODE: 'mirror', MAIL_PROVIDER: 'mock', AUTO_SEND: '0', SHADOW_CHANNELS: 'support' };
  assert.deepEqual(preflight(ok).errors, []);
  assert.deepEqual(preflight({ ...ok, IMAP_CHANNEL: 'sales', SHADOW_CHANNELS: 'sales' }).errors, []);
  for (const bad of [{ MAIL_PROVIDER: 'smtp' }, { AUTO_SEND: '' }, { AUTO_SEND: '1' }, { SHADOW_CHANNELS: '' }, { IMAP_CHANNEL: 'sales' }]) {
    assert.equal(preflight({ ...ok, ...bad }).errors.length, 1, JSON.stringify(bad));
  }
  assert.deepEqual(preflight({ ...ok, NODE_ENV: 'production', ALLOW_MOCK_MAIL: '1', ...SECRETS }).errors, []);
});

test('preflight: RETENTION_DAYS·LLM_DAILY_TOKEN_BUDGET은 비었거나 1 이상 정수', () => {
  for (const k of ['RETENTION_DAYS', 'LLM_DAILY_TOKEN_BUDGET']) {
    for (const v of ['abc', '0', '-1', '1.5', '30d']) assert.equal(preflight({ [k]: v }).errors.length, 1, `${k}=${v}`);
    for (const v of ['', '1', '365']) assert.deepEqual(preflight({ [k]: v }).errors, [], `${k}=${v}`);
  }
});

test('보안 헤더 네 개가 JSON·정적·SSE·401에 모두. /api/health는 {ok:true}만, /api/status는 인증 대상', async () => {
  process.env.AUTH_USER_HEADER = 'x-forwarded-user';
  const want = { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  await withServer(async (base) => {
    const ac = new AbortController();
    const res = {
      health: await fetch(`${base}/api/health`),
      static: await fetch(`${base}/`),
      sse: await fetch(`${base}/api/events`, { headers: U, signal: ac.signal }),
      denied: await fetch(`${base}/api/status`),
    };
    ac.abort();
    for (const [name, r] of Object.entries(res)) for (const [h, v] of Object.entries(want)) assert.equal(r.headers.get(h), v, `${name} ${h}`);
    assert.equal(res.sse.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.health.text(), '{"ok":true,"config":"ok"}');
    assert.equal(res.denied.status, 401);
    const st = await fetch(`${base}/api/status`, { headers: U });
    assert.equal(st.status, 200);
    assert.equal((await st.json()).auth, 'header');
  });
});

test('미러 페이로드: 서버가 mock 메일·자동 발송 끔·섀도 채널이 아니면 저장 없이 503, 셋 다면 받는다', async () => {
  const count = () => [db.get('SELECT COUNT(*) n FROM cases').n, db.get('SELECT COUNT(*) n FROM messages').n];
  let n = 0;
  await withServer(async (base) => {
    const post = () => { n += 1; return fetch(`${base}/api/inbound`, { method: 'POST', headers: JSON_H, body: JSON.stringify({ channel: 'support', from: `mirror${n}@example.com`, subject: '문의', body: '로그인이 안 됩니다', mirror: true }) }); };
    for (const env of [{ MAIL_PROVIDER: 'smtp', SHADOW_CHANNELS: 'support' }, { AUTO_SEND: '1', SHADOW_CHANNELS: 'support' }, {}]) {
      Object.assign(process.env, env);
      const before = count();
      const r = await post();
      assert.equal(r.status, 503, JSON.stringify(env));
      assert.deepEqual(await r.json(), { error: 'mirror_unsafe' });
      assert.deepEqual(count(), before, '케이스·메시지 0행');
      for (const k of ['MAIL_PROVIDER', 'SHADOW_CHANNELS']) delete process.env[k];
      process.env.AUTO_SEND = '0';
    }
    process.env.SHADOW_CHANNELS = 'support';
    const ok = await post();
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).created, true);
  });
});

test('신뢰 안 되는 수신은 occurredAt·senderAuth를 지운다(replyTo는 둔다), 시크릿 맞는 웹훅은 그대로', async () => {
  const seen = []; const orig = cases.addInbound;
  cases.addInbound = (b) => { seen.push(b); return orig(b); };
  process.env.INBOUND_SECRET = 's';
  const b = { channel: 'support', from: 'sa@example.com', body: '감사합니다', senderAuth: 'pass', occurredAt: '2026-01-01T00:00:00.000Z', replyTo: 'r@example.com' };
  try {
    await withServer(async (base) => {
      const post = (p, h = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { ...JSON_H, ...h }, body: JSON.stringify(b) });
      assert.equal((await post('/api/test/inbound')).status, 200);
      assert.equal((await post('/api/inbound', { 'x-inbound-secret': 's' })).status, 200);
    });
  } finally { cases.addInbound = orig; }
  assert.deepEqual([seen[0].senderAuth, seen[0].occurredAt, seen[0].replyTo], [undefined, undefined, 'r@example.com']);
  assert.deepEqual([seen[1].senderAuth, seen[1].occurredAt], ['pass', b.occurredAt]);
});

test('접속기록: 상세·목록(검색어 원값 없음)·401·발송이 한 줄씩, 모든 줄에 ip, start 두 번이어도 한 줄', async () => {
  const file = path.join(tmp, 'access.jsonl');
  const stop = accesslog.start(file);
  accesslog.start(file);
  const email = 'al@example.com';
  try {
    const { caseId, draftId } = await pendingDraft(email);
    process.env.AUTH_USER_HEADER = 'x-forwarded-user';
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/cases/${caseId}`, { headers: U })).status, 200);
      assert.equal((await fetch(`${base}/api/cases?q=${encodeURIComponent(email)}&limit=5`, { headers: U })).status, 200);
      assert.equal((await fetch(`${base}/api/cases`)).status, 401);
      assert.equal((await fetch(`${base}/api/drafts/${draftId}/approve`, { method: 'POST', headers: { ...JSON_H, ...U }, body: '{"by":"x"}' })).status, 200);
    });
  } finally { stop(); }
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(email), '검색어·고객 주소 원값 없음');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.action), ['case.view', 'case.list', 'auth.fail', 'send']);
  for (const l of lines) assert.ok(l.at && 'user' in l && 'ip' in l, JSON.stringify(l));
  for (const l of lines.slice(0, 3)) assert.ok(l.ip, 'HTTP 요청 줄은 소켓 주소');
  assert.deepEqual(lines[1].filters, { limit: '5', hasQuery: true, qLen: email.length });
  assert.equal(lines[1].count, 1);
  assert.deepEqual([lines[2].reason, lines[2].method, lines[2].path], ['user', 'GET', '/api/cases']);
  assert.deepEqual([lines[3].by, lines[3].auto, lines[3].user], ['kim', false, 'kim']);
});

test('접속기록 쓰기가 실패해도 승인 발송은 정상(SENT)', async () => {
  const stop = accesslog.start(tmp); // 폴더라 덧붙이기가 EISDIR로 던진다
  const errs = []; const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const { draftId } = await pendingDraft('al2@example.com');
    const out = await loop.approveDraft(draftId, { by: 'h' });
    assert.ok(out.dispatchId);
    assert.equal(db.get('SELECT status FROM drafts WHERE id=?', draftId).status, 'SENT');
  } finally { console.error = orig; stop(); }
  assert.ok(errs.some((e) => e.startsWith('[accesslog]')), errs.join('\n'));
});

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
function startServer(env, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server/index.js')], {
      cwd, env: { PATH: process.env.PATH, LLM_PROVIDER: 'mock', MAIL_MOCK_LOG: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`시작 안 됨: ${out}`)); }, 5000);
    p.stdout.on('data', (d) => { out += d; if (/cs-agent http/.test(out)) { clearTimeout(timer); resolve(() => new Promise((r) => { p.once('exit', r); p.kill(); })); } });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exit ${code}: ${out}`)); });
  });
}

test('접속기록 파일은 DB 폴더에만 — 작업 폴더(cwd)에는 안 생기고 :memory:면 없다', async () => {
  const dbDir = fs.mkdtempSync(path.join(tmp, 'db-'));
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  for (const [DB_PATH, dir] of [[path.join(dbDir, 'cs.db'), cwd], [':memory:', ROOT]]) {
    const port = await freePort();
    const stop = await startServer({ DB_PATH, PORT: String(port) }, dir);
    try { assert.equal((await fetch(`http://127.0.0.1:${port}/api/cases`)).status, 200); } finally { await stop(); }
  }
  assert.match(fs.readFileSync(path.join(dbDir, 'access.jsonl'), 'utf8'), /"action":"case\.list"/);
  assert.equal(fs.existsSync(path.join(cwd, 'access.jsonl')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'access.jsonl')), false);
});

describe('웹훅 시크릿·실발송 수신자 도메인 허용 목록', () => {
  let server; let base;
  before(async () => {
    db.init(':memory:'); llm.use('mock');
    server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${server.address().port}`;
  });
  after(() => { server.close(); delete process.env.INBOUND_SECRET; delete process.env.MAIL_PROVIDER; delete process.env.MAIL_ALLOWED_DOMAINS; });
  const inbound = (headers = {}) => fetch(`${base}/api/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ channel: 'support', from: 'sec@example.com', subject: '테스트', body: '감사합니다. 확인했습니다.' }),
  });

  test('INBOUND_SECRET 설정 시 헤더 없으면 401, 맞으면 200, 비어 있으면 검사 안 함', async () => {
    process.env.INBOUND_SECRET = 's3cret';
    assert.equal((await inbound()).status, 401);
    assert.equal((await inbound({ 'x-inbound-secret': 'wrong' })).status, 401);
    assert.equal((await inbound({ 'x-inbound-secret': 's3cret' })).status, 200);
    process.env.INBOUND_SECRET = '';
    assert.equal((await inbound()).status, 200);
  });

  test('실발송 provider는 허용 목록 비어 있으면 전체 차단, 목록 밖 도메인 차단', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.MAIL_ALLOWED_DOMAINS = '';
    await assert.rejects(mail.send({ to: 'a@example.com', subject: 's', body: 'b', idempotencyKey: 'k' }), /recipient_not_allowed/);
    process.env.MAIL_ALLOWED_DOMAINS = 'example.com, partner.co.kr';
    await assert.rejects(mail.send({ to: 'a@evil.com', subject: 's', body: 'b', idempotencyKey: 'k' }), /recipient_not_allowed/);
    // 허용 도메인(대소문자 무관)은 허용 목록을 통과한다 — 실제 발송은 smtp 어댑터 몫
    assert.doesNotThrow(() => mail.assertRecipientAllowed('a@Example.com'));
    process.env.MAIL_PROVIDER = 'mock';
    const r = await mail.send({ to: 'a@evil.com', subject: 's', body: 'b', idempotencyKey: 'k' });
    assert.equal(r.provider, 'mock'); // mock은 허용 목록 무관
  });
});

describe('인증 헤더·테스트 주입 엔드포인트', () => {
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

  test('인증 헤더: 켜지면 POST는 헤더 필수, by는 헤더 값으로 덮인다. 웹훅 수신은 예외', async () => {
    process.env.AUTH_USER_HEADER = 'x-forwarded-user';
    const r = await thread().run('영수증 발급 방법 알려주세요');
    const d = pending(r.caseId)[0];
    await withServer(async (api) => {
      assert.equal((await api('GET', '/api/status', null, { 'x-forwarded-user': 'kim' })).data.auth, 'header');
      assert.equal((await api('POST', `/api/drafts/${d.id}/approve`, { by: 'fake' })).status, 401);
      assert.deepEqual((await api('GET', '/api/me', null, { 'x-forwarded-user': 'kim' })).data, { user: 'kim', auth: 'header' });
      const ok = await api('POST', `/api/drafts/${d.id}/approve`, { by: 'fake' }, { 'x-forwarded-user': 'kim' });
      assert.equal(ok.status, 200);
      assert.equal(db.get('SELECT approved_by FROM drafts WHERE id=?', d.id).approved_by, 'kim');
      assert.equal((await api('POST', '/api/inbound', { channel: 'support', from: 'w@example.com', body: '감사합니다' })).status, 200);
    });
  });

  test('테스트 주입 엔드포인트: 개발+mock 메일이면 켜짐(시크릿 무시), 개발+smtp·운영은 ENABLE_TEST_INJECT=1일 때만', async () => {
    process.env.INBOUND_SECRET = 's';
    try {
      await withServer(async (api) => {
        const body = { channel: 'support', from: 'ti@example.com', body: '감사합니다' };
        assert.equal((await api('POST', '/api/inbound', body)).status, 401);
        assert.equal((await api('POST', '/api/test/inbound', body)).status, 200);
        process.env.MAIL_PROVIDER = 'smtp';
        assert.equal((await api('POST', '/api/test/inbound', body)).status, 404, 'NODE_ENV가 빠진 실발송 서버');
        process.env.ENABLE_TEST_INJECT = '1';
        assert.equal((await api('POST', '/api/test/inbound', body)).status, 200);
        delete process.env.MAIL_PROVIDER; delete process.env.ENABLE_TEST_INJECT;
        process.env.NODE_ENV = 'production';
        assert.equal((await api('POST', '/api/test/inbound', body)).status, 404);
        process.env.ENABLE_TEST_INJECT = '1';
        assert.equal((await api('POST', '/api/test/inbound', body)).status, 200);
      });
    } finally { delete process.env.MAIL_PROVIDER; }
  });
});

describe('깨진 요청·인증 헤더·운영 기동 거부', () => {
  const ENV = ['LLM_MOCK_DELAY_MS', 'MAIL_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL', 'AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'LLM_RETRY_SCALE'];
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `f2-${n}`; const from = `f2-${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }
  const pending = (id) => db.all("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", id);
  async function withServer(fn) {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const api = async (method, p, body, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json().catch(() => null), res };
    };
    try { await fn(api, port); } finally { server.closeAllConnections(); server.close(); }
  }
  /** 요청 줄을 그대로 보낸다(fetch는 깨진 요청 대상을 못 만든다). 응답 첫 줄. */
  const raw = (port, line) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let b = ''; s.on('data', (d) => { b += d; }); s.on('close', () => resolve(b.split('\r\n')[0] || '(빈 응답)')); s.on('error', (e) => resolve(`ERR ${e.code}`));
  });
  /** 서버 프로세스를 띄워 시작 로그 또는 종료 코드를 기다린다. */
  function startProcess(env) {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server/index.js')], {
        env: { PATH: process.env.PATH, PORT: '0', DB_PATH: ':memory:', LLM_PROVIDER: 'mock', MAIL_MOCK_LOG: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const done = (r) => { clearTimeout(timer); p.kill(); resolve({ ...r, out }); };
      const timer = setTimeout(() => done({ timeout: true }), 5000);
      p.stdout.on('data', (d) => { out += d; if (/cs-agent http/.test(out)) done({ started: true }); });
      p.stderr.on('data', (d) => { out += d; });
      p.on('exit', (code) => done({ code }));
    });
  }

  test('깨진 요청 대상(`GET http://[`)은 400, 서버 프로세스는 산다', async () => {
    const seen = []; const onRej = (e) => seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      await withServer(async (api, port) => {
        for (const line of ['GET http://[ HTTP/1.1', 'GET http://a:999999/ HTTP/1.1']) assert.match(await raw(port, line), /^HTTP\/1\.1 400/, line);
        assert.equal((await api('GET', '/api/health')).status, 200);
      });
      await sleep(20);
      assert.deepEqual(seen, [], 'unhandled rejection 없음');
    } finally { process.off('unhandledRejection', onRej); }
  });

  test('AUTH_USER_HEADER: GET·SSE도 헤더 필수, 웹훅·헬스체크만 예외. PROXY_SHARED_SECRET 없는 직결 요청은 401', async () => {
    process.env.AUTH_USER_HEADER = 'x-forwarded-user';
    const r = await thread().run('영수증 발급 방법 알려주세요');
    const U = { 'x-forwarded-user': 'kim' };
    await withServer(async (api) => {
      assert.equal((await api('GET', '/api/cases')).status, 401);
      assert.equal((await api('GET', `/api/cases/${r.caseId}`)).status, 401);
      assert.equal((await api('GET', '/api/stats')).status, 401);
      assert.equal((await api('GET', '/api/events')).status, 401);
      assert.equal((await api('GET', '/api/cases', null, U)).status, 200);
      assert.equal((await api('GET', '/api/health')).status, 200);
      assert.equal((await api('POST', '/api/inbound', { channel: 'support', from: 'c4@example.com', body: '감사합니다' })).status, 200);
      process.env.PROXY_SHARED_SECRET = 'p-secret';
      assert.equal((await api('GET', '/api/cases', null, U)).status, 401, '프록시를 거치지 않은 위조 사용자 헤더');
      const d = pending(r.caseId)[0];
      assert.equal((await api('POST', `/api/drafts/${d.id}/approve`, { by: 'x' }, { 'x-forwarded-user': 'ceo-forged' })).status, 401);
      assert.equal((await api('GET', '/api/cases', null, { ...U, 'x-proxy-secret': 'wrong' })).status, 401);
      assert.equal((await api('GET', '/api/cases', null, { ...U, 'x-proxy-secret': 'p-secret' })).status, 200);
      assert.equal((await api('GET', '/api/health')).status, 200, '헬스체크는 컨테이너 안에서 직접 부른다');
      assert.equal((await api('POST', '/api/inbound', { channel: 'support', from: 'c4b@example.com', body: '감사합니다' })).status, 200, '웹훅은 INBOUND_SECRET으로 지킨다');
    });
  });

  test('production + mock 메일은 ALLOW_MOCK_MAIL=1 없으면 시작 거부, Dockerfile 기본은 mock 아님', async () => {
    const no = await startProcess({ NODE_ENV: 'production', MAIL_PROVIDER: 'mock' });
    assert.equal(no.code, 1, no.out); assert.match(no.out, /ALLOW_MOCK_MAIL/);
    // production은 세 시크릿도 필수 — 시작하는 경우를 보려면 같이 준다
    const yes = await startProcess({ NODE_ENV: 'production', MAIL_PROVIDER: 'mock', ALLOW_MOCK_MAIL: '1', INBOUND_SECRET: 's', AUTH_USER_HEADER: 'x-forwarded-user', PROXY_SHARED_SECRET: 'p' });
    assert.equal(yes.started, true, yes.out);
    // 비교 실험 스위치(CS_ABLATE)가 남은 환경에선 장치가 꺼진 채 돌 수 있다 — 서버는 아예 시작하지 않는다
    const abl = await startProcess({ MAIL_PROVIDER: 'mock', CS_ABLATE: 'guard' });
    assert.equal(abl.code, 1, abl.out); assert.match(abl.out, /CS_ABLATE/);
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.doesNotMatch(docker, /^\s*MAIL_PROVIDER=mock/m); assert.match(docker, /^\s*MAIL_PROVIDER=smtp/m);
  });
});

function startLog(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server/index.js')], {
      cwd: tmp, env: { PATH: process.env.PATH, PORT: '0', LLM_PROVIDER: 'mock', MAIL_MOCK_LOG: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const done = (r) => { clearTimeout(timer); p.kill(); resolve({ ...r, out }); };
    const timer = setTimeout(() => done({ timeout: true }), 5000);
    p.stdout.on('data', (d) => { out += d; if (/cs-agent http/.test(out)) done({ started: true }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => done({ code }));
  });
}

test('기동 로그: production(세 시크릿·파일 DB)은 sender_auth=required·retention·budget, smtp+인증 요구 꺼짐·anthropic+예산 없음은 경고', async () => {
  const base = { NODE_ENV: 'production', MAIL_PROVIDER: 'smtp', INBOUND_SECRET: 's', AUTH_USER_HEADER: 'x-forwarded-user', PROXY_SHARED_SECRET: 'p', ADMIN_USERS: 'admin' };
  const a = await startLog({ ...base, DB_PATH: path.join(fs.mkdtempSync(path.join(tmp, 'boot-')), 'cs.db'), RETENTION_DAYS: '30', LLM_DAILY_TOKEN_BUDGET: '5000' });
  assert.equal(a.started, true, a.out);
  assert.match(a.out, /sender_auth=required retention=30 budget=5000/);
  assert.doesNotMatch(a.out, /경고:/);
  const b = await startLog({ ...base, DB_PATH: path.join(fs.mkdtempSync(path.join(tmp, 'boot-')), 'cs.db'), REQUIRE_SENDER_AUTH: '0', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'x' });
  assert.equal(b.started, true, b.out);
  assert.match(b.out, /sender_auth=optional retention=off budget=none/);
  assert.match(b.out, /경고: MAIL_PROVIDER=smtp인데 REQUIRE_SENDER_AUTH가 꺼져 있다/);
  assert.match(b.out, /경고: 일일 토큰 예산이 없습니다/);
});
