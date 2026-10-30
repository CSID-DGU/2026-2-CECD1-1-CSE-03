'use strict';
// 수정 패스 2(서버 코어) — 재검증이 재현 스크립트로 확인한 결함을 테스트로 둔다.
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../server/db');
const llm = require('../server/llm');
const mock = require('../server/llm/mock');
const cases = require('../server/cases');
const loop = require('../server/loop');
const sweeper = require('../server/sweeper');
const kbLoader = require('../server/kb');
const mail = require('../server/mail');
const prefilter = require('../server/prefilter');
const { createServer } = require('../server/index');

const ROOT = path.join(__dirname, '..');
const ENV = ['LLM_MOCK_DELAY_MS', 'MAIL_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL', 'AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'LLM_RETRY_SCALE'];
before(() => { db.init(':memory:'); });
beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } };
let n = 0;
function thread(channel = 'support') {
  n += 1;
  const tid = `f2-${n}`; const from = `f2-${n}@example.com`;
  const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
  return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
}
const st = (id) => ({ ...db.get('SELECT state, responder FROM cases WHERE id=?', id) });
const pending = (id) => db.all("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", id);
const lastExec = (id) => ({ ...db.get("SELECT action, reason FROM decisions WHERE case_id=? AND step='execute' ORDER BY rowid DESC LIMIT 1", id) });
const rejects = (p, status, code) => p.then(() => assert.fail('throw 기대'), (e) => { assert.equal(e.status, status); if (code) assert.equal(e.message, code); return e; });
const outs = (id) => db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", id).n;

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

test('C-1 깨진 요청 대상(`GET http://[`)은 400, 서버 프로세스는 산다', async () => {
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

test('C-2 재시도 예약된 앞 메시지는 뒤 메시지가 IGNORE로 끝나도 남는다 → 재시도 뒤 승인 대기에 오른다', async () => {
  process.env.LLM_RETRY_SCALE = '0.0001';
  let down = true;
  llm.use({ name: 'flaky-c2', json: async (r) => { if (down) throw new Error('503'); return mock.json(r); } });
  const t = thread();
  const r1 = await t.run('영수증 재발급 부탁드립니다. 지난달 것입니다.');
  assert.equal(db.get('SELECT retry_message_id FROM loops WHERE case_id=?', r1.caseId).retry_message_id, r1.messageId);
  const r2 = await t.run('[자동 회신] 휴가 중입니다.');
  assert.equal(lastExec(r1.caseId).action, 'IGNORE');
  assert.equal(db.get('SELECT retry_message_id FROM loops WHERE case_id=?', r1.caseId).retry_message_id, r1.messageId, '자동 회신이 앞 메시지 예약을 지우지 않는다');
  down = false;
  await sleep(5);
  await sweeper.tick(Date.now() + 3_600_000);
  const p = pending(r1.caseId);
  assert.equal(p.length, 1); assert.equal(p[0].trigger_message_id, r2.messageId, '뒤 메시지가 이미 IGNORE로 끝났으니 마지막 메시지 기준으로 올린다');
  assert.equal(p[0].intent, 'receipt');
  assert.equal(st(r1.caseId).state, 'AWAITING_APPROVAL');
  sweeper.autoClose(Date.now() + 31 * 86_400_000);
  assert.equal(st(r1.caseId).state, 'AWAITING_APPROVAL', '승인 대기라 30일 자동 종결 대상 아님');
  assert.equal(db.get('SELECT retry_message_id FROM loops WHERE case_id=?', r1.caseId).retry_message_id, null, '자기 회차가 끝나면 예약을 지운다');
});

test('C-2 앞 메시지를 맥락에 본 뒤 메시지가 답장으로 끝나면 예약은 지운다', async () => {
  process.env.LLM_RETRY_SCALE = '0.0001';
  let down = true;
  llm.use({ name: 'flaky-c2b', json: async (r) => { if (down) throw new Error('503'); return mock.json(r); } });
  const t = thread();
  const r1 = await t.run('영수증 재발급 부탁드립니다.');
  down = false;
  await t.run('로그인도 안 됩니다');
  assert.equal(lastExec(r1.caseId).action, 'DRAFT');
  assert.equal(db.get('SELECT retry_message_id FROM loops WHERE case_id=?', r1.caseId).retry_message_id, null);
});

test('C-3 반환 두 번(동시) → 두 번째는 409 busy, 같은 메시지 초안은 1개. 순차로 한 번 더 반환하면 409 not_handed_off, PENDING 1개', async () => {
  const t = thread();
  const r1 = await t.run('환불해 주세요');
  const r2 = await t.run('그럼 영수증이라도 발급해 주세요');
  process.env.LLM_MOCK_DELAY_MS = '20';
  const res = await Promise.allSettled([loop.returnToAgent(r1.caseId, { by: 'h' }), loop.returnToAgent(r1.caseId, { by: 'h' })]);
  delete process.env.LLM_MOCK_DELAY_MS;
  assert.equal(res[0].status, 'fulfilled'); assert.equal(res[0].value.cycled, true);
  assert.equal(res[1].status, 'rejected'); assert.equal(res[1].reason.status, 409); assert.equal(res[1].reason.message, 'busy');
  assert.equal(db.get('SELECT COUNT(*) n FROM drafts WHERE trigger_message_id=?', r2.messageId).n, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM activities WHERE case_id=? AND type='return'", r1.caseId).n, 1, 'busy는 아무것도 바꾸지 않는다');
  await rejects(loop.returnToAgent(r1.caseId, { by: 'h' }), 409, 'not_handed_off'); // 이미 에이전트가 맡았다(fix3 QA D1)
  assert.equal(pending(r1.caseId).length, 1);
});

test('C-3 sweeper 재시도가 도는 중에 recover가 같은 메시지를 다시 돌리지 않는다(반대도)', async () => {
  llm.use({ name: 'slow-c3', json: async (r) => { await sleep(40); return mock.json(r); } });
  for (const order of ['sweeper-first', 'recover-first']) {
    const t = thread();
    const r = t.add('영수증 발급 방법 알려주세요');
    cases.claim(`loop:${r.caseId}:${r.messageId}`); // LLM 장애로 재시도 예약된 상태
    db.run('UPDATE loops SET next_retry_at=?, retry_count=1, retry_message_id=? WHERE case_id=?', new Date(Date.now() - 1000).toISOString(), r.messageId, r.caseId);
    let a; let b;
    if (order === 'sweeper-first') { a = sweeper.tick(); await sleep(5); b = loop.recover(); } else {
      // recover가 먼저 그 메시지를 돌리게 예약 표시를 잠깐 비운다(sweeper가 예약을 막 꺼낸 순간과 같다)
      db.run('UPDATE loops SET next_retry_at=NULL WHERE case_id=?', r.caseId);
      a = loop.recover(); await sleep(5);
      db.run('UPDATE loops SET next_retry_at=? WHERE case_id=?', new Date(Date.now() - 1000).toISOString(), r.caseId);
      b = sweeper.tick();
    }
    await Promise.all([a, b]);
    await sleep(50);
    assert.equal(db.get("SELECT COUNT(*) n FROM decisions WHERE message_id=? AND step='triage'", r.messageId).n, 1, `${order}: 분류 1회`);
    assert.equal(db.get('SELECT COUNT(*) n FROM drafts WHERE trigger_message_id=?', r.messageId).n, 1, `${order}: 초안 1개`);
  }
});

test('C-3 같은 메시지에 이미 답장이 나갔으면 already_answered 뒤 다시 쓰지 않는다', async () => {
  const r = await thread().run('구독 해지 방법 알려주세요');
  const d = pending(r.caseId)[0];
  const dupId = db.uuid(); // 경쟁으로 생긴 같은 메시지의 두 번째 초안
  db.insert('drafts', { ...d, id: dupId, idempotency_key: `draft:${dupId}` });
  await loop.approveDraft(d.id, { by: 'a' });
  await rejects(loop.approveDraft(dupId, { by: 'a' }), 409, 'already_answered');
  await sleep(30);
  assert.equal(pending(r.caseId).length, 0, '재작성 초안 없음');
  assert.equal(outs(r.caseId), 1);
});

test('C-4 AUTH_USER_HEADER: GET·SSE도 헤더 필수, 웹훅·헬스체크만 예외. PROXY_SHARED_SECRET 없는 직결 요청은 401', async () => {
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

test('C-5 발송 중(SEND_CHECK_MS 전) 초안은 resolve-sending 409 sending_in_progress — 오래된 SENDING만 처리', async () => {
  const r = await thread().run('영수증 발급 방법 알려주세요');
  const d = pending(r.caseId)[0];
  process.env.MAIL_MOCK_DELAY_MS = '40';
  const ap = loop.approveDraft(d.id, { by: 'a' });
  await sleep(5);
  assert.throws(() => loop.resolveSending(d.id, { by: 'h', outcome: 'pending' }), (e) => e.status === 409 && e.message === 'sending_in_progress');
  assert.throws(() => loop.resolveSending(d.id, { by: 'h', outcome: 'sent' }), (e) => e.status === 409 && e.message === 'sending_in_progress');
  await ap;
  assert.equal(outs(r.caseId), 1);
  // 재시작 직후처럼 이 프로세스가 보내는 중은 아니지만 선점한 지 얼마 안 됐다 → 기다린다
  const r2 = await thread().run('구독 해지 방법 알려주세요');
  const d2 = pending(r2.caseId)[0];
  db.run("UPDATE drafts SET status='SENDING', approved_by='a', approved_at=? WHERE id=?", new Date().toISOString(), d2.id);
  assert.throws(() => loop.resolveSending(d2.id, { by: 'h', outcome: 'pending' }), (e) => e.message === 'sending_in_progress');
  db.run('UPDATE drafts SET approved_at=? WHERE id=?', new Date(Date.now() - cases.SEND_CHECK_MS - 1000).toISOString(), d2.id);
  assert.equal(loop.resolveSending(d2.id, { by: 'h', outcome: 'pending' }).status, 'PENDING');
});

test('C-6 .env.example와 deployment.md 표가 코드가 읽는 환경 변수를 전부 담는다', () => {
  const names = new Set();
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|\be\.(SMTP_[A-Z0-9_]+)/g)) names.add(m[1] || m[2]); } };
  walk(path.join(ROOT, 'server')); walk(path.join(ROOT, 'scripts'));
  assert.ok(names.size > 20);
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const deploy = fs.readFileSync(path.join(ROOT, 'docs/deployment.md'), 'utf8');
  for (const k of names) {
    assert.match(example, new RegExp(`^${k}=`, 'm'), `.env.example에 ${k}`);
    assert.match(deploy, new RegExp(`\`${k}\``), `deployment.md에 ${k}`);
  }
  assert.doesNotMatch(example, /어댑터 추가 필요/);
});

test('A-M2 발송 중 시작한 회차가 발송이 끝난 뒤 쓴 초안 → 승인 409 already_answered(회차가 본 답장 기준)', async () => {
  const t = thread();
  const r1 = await t.run('영수증 발급 방법 알려주세요');
  const d1 = pending(r1.caseId)[0];
  process.env.MAIL_MOCK_DELAY_MS = '40';
  process.env.LLM_MOCK_DELAY_MS = '30';
  const ap = loop.approveDraft(d1.id, { by: 'a' });
  await sleep(5);
  const r2 = t.add('로그인도 안 됩니다');
  const cyc = loop.runCycle(r2.caseId, r2.messageId); // 맥락을 읽는 시점엔 D1 답장이 아직 없다
  await ap; await cyc;
  delete process.env.MAIL_MOCK_DELAY_MS; delete process.env.LLM_MOCK_DELAY_MS;
  const d2 = pending(r1.caseId)[0];
  assert.ok(d2);
  const out = db.get("SELECT occurred_at FROM messages WHERE case_id=? AND direction='out'", r1.caseId);
  assert.ok(out.occurred_at < d2.created_at, '초안이 발송 뒤에 생겼다(예전 created_at 기준 검사가 놓친 경우)');
  await rejects(loop.approveDraft(d2.id, { by: 'a' }), 409, 'already_answered');
  const d3 = await until(() => pending(r1.caseId)[0]);
  assert.equal(d3.seen_out_rowid > 0, true, '다시 쓴 초안은 그 답장을 봤다');
  await loop.approveDraft(d3.id, { by: 'a' });
  assert.equal(outs(r1.caseId), 2);
});

test('A-M4 수신 트랜잭션이 실패하면 mailbox claim도 롤백 — 같은 providerMessageId 재전송이 처리된다', () => {
  assert.throws(() => cases.addInbound({ channel: 'support', from: 'm4@example.com', subject: { bad: 1 }, body: '영수증 주세요', providerMessageId: 'pm-f2-m4' }));
  const again = cases.addInbound({ channel: 'support', from: 'm4@example.com', subject: '영수증', body: '영수증 주세요', providerMessageId: 'pm-f2-m4' });
  assert.ok(again.caseId); assert.notEqual(again.duplicate, true);
  assert.equal(cases.addInbound({ channel: 'support', from: 'm4@example.com', body: '영수증 주세요', providerMessageId: 'pm-f2-m4' }).duplicate, true);
});

test('B-M8 정책 팩 원문을 versions에 저장, responder_human·failSafe 판단 행도 버전을 남긴다', async () => {
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

test('A-M15 HTTP 동시 승인(발송 지연) → 발송 1건·200 하나·409 하나', async () => {
  const r = await thread().run('구독 해지 방법 알려주세요');
  const d = pending(r.caseId)[0];
  process.env.MAIL_MOCK_DELAY_MS = '30';
  await withServer(async (api) => {
    const [a, b] = await Promise.all([api('POST', `/api/drafts/${d.id}/approve`, { by: 'a' }), api('POST', `/api/drafts/${d.id}/approve`, { by: 'b' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal([a, b].find((x) => x.status === 409).data.error, 'not_pending');
  });
  assert.equal(db.get('SELECT COUNT(*) n FROM dispatches WHERE draft_id=?', d.id).n, 1);
  assert.equal(outs(r.caseId), 1);
});

test('A-M15 재작성: 첫 작성 guard 실패 → 1회 재작성 통과 → DRAFT / 재작성도 실패 → HANDOFF guard_failed', async () => {
  llm.use({ name: 'rw1', json: async (r) => (r.agent === 'responder' && !r.ctx.violations
    ? { body: '영수증은 설정에서 받으세요. 환불도 됩니다.', usedFacts: ['receipt'], humanCommitments: [], needsHandoff: false, handoffReason: null } : mock.json(r)) });
  const a = await thread().run('영수증 발급 방법 알려주세요');
  const sa = db.all("SELECT step, action FROM decisions WHERE case_id=? AND step IN ('respond','guard','execute') ORDER BY rowid", a.caseId).map((x) => `${x.step}:${x.action}`);
  assert.deepEqual(sa, ['respond:COMPOSE', 'guard:FAIL', 'respond:REWRITE', 'guard:PASS', 'execute:DRAFT']);
  assert.doesNotMatch(pending(a.caseId)[0].original_body, /환불/);
  llm.use({ name: 'rw2', json: async (r) => (r.agent === 'responder'
    ? { body: '환불 가능합니다. 10,000원입니다.', usedFacts: ['receipt'], humanCommitments: [], needsHandoff: false, handoffReason: null } : mock.json(r)) });
  const b = await thread().run('영수증 발급 방법 알려주세요');
  const sb = db.all("SELECT step, action FROM decisions WHERE case_id=? AND step IN ('respond','execute') ORDER BY rowid", b.caseId).map((x) => `${x.step}:${x.action}`);
  assert.deepEqual(sb, ['respond:COMPOSE', 'respond:REWRITE', 'execute:HANDOFF']);
  assert.deepEqual(lastExec(b.caseId), { action: 'HANDOFF', reason: 'guard_failed' });
});

test('A-m19 production + mock 메일은 ALLOW_MOCK_MAIL=1 없으면 시작 거부, Dockerfile 기본은 mock 아님', async () => {
  const no = await startProcess({ NODE_ENV: 'production', MAIL_PROVIDER: 'mock' });
  assert.equal(no.code, 1, no.out); assert.match(no.out, /ALLOW_MOCK_MAIL/);
  const yes = await startProcess({ NODE_ENV: 'production', MAIL_PROVIDER: 'mock', ALLOW_MOCK_MAIL: '1' });
  assert.equal(yes.started, true, yes.out);
  // 비교 실험 스위치(CS_ABLATE)가 남은 환경에선 장치가 꺼진 채 돌 수 있다 — 서버는 아예 시작하지 않는다
  const abl = await startProcess({ MAIL_PROVIDER: 'mock', CS_ABLATE: 'guard' });
  assert.equal(abl.code, 1, abl.out); assert.match(abl.out, /CS_ABLATE/);
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(docker, /^\s*MAIL_PROVIDER=mock/m); assert.match(docker, /^\s*MAIL_PROVIDER=smtp/m);
});

test('A-m8 근거 KB 절이 기한 지남 — 고친 본문은 승인(경고 기록), 고치지 않은 본문은 422 unknown_fact', async () => {
  const r1 = await thread().run('영수증 발급 방법 알려주세요');
  const r2 = await thread().run('영수증 발급 방법 알려주세요');
  const orig = kbLoader.load;
  kbLoader.load = (ch, lang) => { const k = orig(ch, lang); const s = { ...k.sections }; delete s.receipt; return { ...k, sections: s }; };
  try {
    const e = await rejects(loop.approveDraft(pending(r1.caseId)[0].id, { by: 'h' }), 422, 'guard');
    assert.ok(e.extra.violations.some((v) => v.code === 'unknown_fact'));
    const out = await loop.approveDraft(pending(r2.caseId)[0].id, { by: 'h', finalBody: '확인 후 담당자가 이어서 안내드리겠습니다.' });
    assert.ok(out.dispatchId);
  } finally { kbLoader.load = orig; }
  const act = db.get("SELECT payload FROM activities WHERE case_id=? AND type='edit_approve'", r2.caseId);
  assert.deepEqual(JSON.parse(act.payload).expiredFacts, ['receipt']);
});

test('A-m17 거절(declined) 뒤 감사 인사 → IGNORE + 종결, 거절 뒤 새 질문 → 보통 회차', async () => {
  const s = thread('sales');
  const r1 = await s.run('검토해 봤는데 이번에는 진행이 어렵겠습니다.');
  assert.equal(db.get("SELECT reason FROM decisions WHERE message_id=? AND step='triage'", r1.messageId).reason, 'declined');
  await loop.approveDraft(pending(r1.caseId)[0].id, { by: 'a' });
  await s.run('네 감사합니다.');
  assert.equal(lastExec(r1.caseId).action, 'IGNORE');
  assert.equal(st(r1.caseId).state, 'CLOSED');
  assert.equal(JSON.parse(db.get("SELECT payload FROM activities WHERE case_id=? AND type='auto_close'", r1.caseId).payload).reason, 'declined_ack');
  const s2 = thread('sales');
  const q1 = await s2.run('검토해 봤는데 이번에는 진행이 어렵겠습니다.');
  await loop.approveDraft(pending(q1.caseId)[0].id, { by: 'a' });
  await s2.run('혹시 서비스 진행 절차는 어떻게 되나요?');
  assert.equal(lastExec(q1.caseId).action, 'DRAFT', '고객이 다시 물으면 답한다');
});

test('A-m18 /return은 자기 회차만 기다리고 응답한다 — 줄 선 메시지는 뒤에서 처리 {cycled, queued}', async () => {
  const t = thread();
  const a1 = await t.run('환불해 주세요');
  await t.run('영수증도 주세요');
  process.env.LLM_MOCK_DELAY_MS = '30';
  const p = loop.returnToAgent(a1.caseId, { by: 'h' });
  await sleep(5);
  const later = [t.add('로그인도 안 돼요'), t.add('비밀번호도요'), t.add('탈퇴는요')];
  for (const m of later) loop.runCycle(m.caseId, m.messageId); // 리스 중이라 큐로
  const out = await p;
  const doneNow = later.filter((m) => db.get("SELECT 1 FROM decisions WHERE message_id=? AND step='execute'", m.messageId)).length;
  assert.equal(out.cycled, true); assert.equal(out.queued, 3); assert.equal(doneNow, 0);
  await until(() => later.every((m) => db.get("SELECT 1 FROM decisions WHERE message_id=? AND step='execute'", m.messageId)), 5000);
  delete process.env.LLM_MOCK_DELAY_MS;
});

test('B-S4 provider가 답장을 다른 스레드 id로 보내면 그 id도 케이스에 묶는다 — 고객 회신이 같은 케이스로', async () => {
  const t = thread();
  const r = await t.run('영수증 발급 방법 알려주세요');
  const orig = mail.send;
  mail.send = async () => ({ id: `stub:${db.uuid()}`, provider: 'stub', threadId: 'prov-thread-b-s4' });
  try { await loop.approveDraft(pending(r.caseId)[0].id, { by: 'a' }); } finally { mail.send = orig; }
  assert.equal(db.get('SELECT case_id FROM case_threads WHERE thread_id=?', 'prov-thread-b-s4').case_id, r.caseId);
  const re = cases.addInbound({ channel: 'support', from: t.from, body: '감사합니다', threadId: 'prov-thread-b-s4' });
  assert.equal(re.caseId, r.caseId); assert.equal(re.created, false);
});

test('D1 1차 거르기를 통과해도 prefilter 판단 행(PASS)이 트레이스 맨 앞에 남는다', async () => {
  const r = await thread().run('영수증 발급 방법 알려주세요');
  const first = db.get('SELECT step, action FROM decisions WHERE case_id=? ORDER BY rowid LIMIT 1', r.caseId);
  assert.deepEqual({ ...first }, { step: 'prefilter', action: 'PASS' });
});

test('reopen: 마지막이 답 못 한 고객 메시지면 바로 회차, 답장이 마지막이면 WAITING_CUSTOMER. 첫 메시지 IGNORE 케이스도 다시 닫히지 않는다', async () => {
  const t = thread();
  const r = await t.run('영수증 발급 방법 알려주세요');
  loop.closeCase(r.caseId, { by: 'h' });
  const o = await loop.reopenCase(r.caseId, { by: 'h' });
  assert.equal(o.cycled, true); assert.equal(st(r.caseId).state, 'AWAITING_APPROVAL'); assert.equal(pending(r.caseId).length, 1);
  await loop.approveDraft(pending(r.caseId)[0].id, { by: 'a' });
  loop.closeCase(r.caseId, { by: 'h' });
  const o2 = await loop.reopenCase(r.caseId, { by: 'h' });
  assert.equal(o2.cycled, false); assert.equal(st(r.caseId).state, 'WAITING_CUSTOMER');
  await rejects(loop.reopenCase(r.caseId, { by: 'h' }), 409, 'not_closed');
  const a = await thread().run('감사합니다');
  assert.equal(st(a.caseId).state, 'CLOSED');
  await loop.reopenCase(a.caseId, { by: 'h' });
  assert.notEqual(st(a.caseId).state, 'CLOSED', '사람이 다시 연 케이스는 자동으로 닫지 않는다');
});

test('stripQuotes: Gmail 한국어 인용 머리("…님이 작성:")부터 자른다', () => {
  const body = '영수증 다시 부탁드립니다.\n\n2026년 10월 25일 (토) 오후 3:14, 김고객 <kim@example.com>님이 작성:\n이전 안내 본문';
  assert.equal(cases.stripQuotes(body), '영수증 다시 부탁드립니다.');
  assert.equal(cases.stripQuotes('질문입니다.\n2026년 10월 25일 (토) 오후 3:14, Kim <k@example.com> 작성\n인용'), '질문입니다.');
  assert.equal(cases.stripQuotes('On the form I wrote\n내용'), 'On the form I wrote\n내용', '영어 머리는 콜론이 있어야 자른다');
});

test('smoke:llm — npm 스크립트가 있고, ANTHROPIC_API_KEY 없으면 실행 방법을 알리고 거부한다', async () => {
  assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['smoke:llm'], /demo\.js --provider=anthropic --record/);
  const env = { PATH: process.env.PATH };
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server/mock/demo.js'), '--provider=anthropic', '--record'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 2, r.out); assert.match(r.out, /ANTHROPIC_API_KEY=.*npm run smoke:llm/);
});

/* ---------------- 수정 패스 3 ---------------- */

/** 가짜 SMTP 서버(평문, 인증 없음) — 받은 DATA 원문을 모은다. */
async function fakeSmtp() {
  const data = [];
  const server = net.createServer((sock) => {
    let buf = ''; let inData = false;
    const w = (x) => sock.write(`${x}\r\n`);
    w('220 fake');
    sock.on('data', (d) => {
      buf += d;
      for (;;) {
        if (inData) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; data.push(buf.slice(0, i)); buf = buf.slice(i + 5); inData = false; w('250 queued'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i).toUpperCase(); buf = buf.slice(i + 2);
        if (line.startsWith('EHLO')) w('250 fake'); else if (line === 'DATA') { inData = true; w('354 go'); } else if (line === 'QUIT') { w('221 bye'); sock.end(); } else w('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { data, port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } };
}
const header = (raw, name) => raw.replace(/\r\n[ \t]+/g, ' ').split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();

test('B-S4 smtp: 답장에 In-Reply-To/References를 달고 Message-ID를 스레드로 묶는다 — 고객 회신은 In-Reply-To만으로 같은 케이스', async () => {
  const srv = await fakeSmtp();
  const keys = ['MAIL_PROVIDER', 'MAIL_ALLOWED_DOMAINS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_ALLOW_PLAIN'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { MAIL_PROVIDER: 'smtp', MAIL_ALLOWED_DOMAINS: 'example.com', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(srv.port), SMTP_FROM: 'ACME <support@acme.example>', SMTP_ALLOW_PLAIN: '1' });
  try {
    const t = thread();
    const r = await t.run('영수증 발급 방법 알려주세요', { providerMessageId: '<cust-1@mail.example.com>' });
    const sent = await loop.approveDraft(pending(r.caseId)[0].id, { by: 'a' });
    const raw = srv.data[0];
    assert.equal(header(raw, 'In-Reply-To'), '<cust-1@mail.example.com>');
    assert.match(header(raw, 'References'), /<cust-1@mail\.example\.com>/);
    const outId = db.get('SELECT provider_message_id p FROM messages WHERE id=?', sent.messageId).p;
    assert.equal(header(raw, 'Message-ID'), outId);
    assert.ok(db.get('SELECT 1 FROM case_threads WHERE thread_id=? AND case_id=?', outId, r.caseId), '발송 Message-ID가 케이스 스레드로 등록');
    // 고객 회신: 수신 어댑터가 모르는 스레드 id + In-Reply-To(꺾쇠 없이 와도) → 같은 케이스, 그 스레드 id도 묶인다
    const reply = cases.addInbound({ channel: 'support', from: t.from, body: '감사합니다', threadId: 'gmail-new-1', inReplyTo: outId.slice(1, -1), references: `<cust-1@mail.example.com> ${outId}` });
    assert.equal(reply.caseId, r.caseId); assert.equal(reply.created, false);
    assert.ok(db.get("SELECT 1 FROM case_threads WHERE thread_id='gmail-new-1' AND case_id=?", r.caseId));
    // 스레드 id 없이 References만 와도 같은 케이스(원 고객 메일 id)
    const r2 = cases.addInbound({ channel: 'support', from: t.from, body: '하나 더 물어볼게요', references: ['<cust-1@mail.example.com>'] });
    assert.equal(r2.caseId, r.caseId);
    // 모르는 id면 새 케이스
    assert.equal(cases.addInbound({ channel: 'support', from: 'other@example.com', body: '새 문의', inReplyTo: '<nobody@x.example>' }).created, true);
    // 헤더 주입은 토큰만 남는다
    const built = require('../server/mail/smtp').buildMessage({ from: 'a@acme.example', to: 'b@example.com', subject: 's', body: 'b', inReplyTo: '<p@x.example>\r\nBcc: evil@x.example', references: ['<q@x.example>', 'junk'] });
    assert.doesNotMatch(built, /Bcc:/); assert.equal(header(built, 'References'), '<q@x.example>');
  } finally {
    srv.close();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('C-7 거절 뒤 감사 인사로 자동 종결된 케이스를 사람이 재오픈하면 같은 인사로 다시 닫지 않는다', async () => {
  const s = thread('sales');
  const r1 = await s.run('검토해 봤는데 이번에는 진행이 어렵겠습니다.');
  await loop.approveDraft(pending(r1.caseId)[0].id, { by: 'a' });
  await s.run('네 감사합니다.');
  assert.equal(st(r1.caseId).state, 'CLOSED');
  const out = await loop.reopenCase(r1.caseId, { by: 'h' });
  assert.equal(out.cycled, true);
  assert.notEqual(st(r1.caseId).state, 'CLOSED');
  assert.equal(db.get("SELECT COUNT(*) n FROM activities WHERE case_id=? AND type='auto_close'", r1.caseId).n, 1);
});

test('C-9 승인 때 고치지 않은 원문은 intent 근거 범위도 다시 본다(fact_off_intent), 고친 본문은 intent 없이 본다', async () => {
  const t = thread();
  const r = await t.run('영수증 발급 방법 알려주세요');
  const d = pending(r.caseId)[0];
  assert.equal(d.intent, 'receipt');
  db.run('UPDATE drafts SET used_facts=? WHERE id=?', JSON.stringify(['receipt', 'login']), d.id); // login 절은 receipt intent 밖
  const e = await rejects(loop.approveDraft(d.id, { by: 'a' }), 422, 'guard');
  assert.ok(e.extra.violations.some((v) => v.code === 'fact_off_intent'), JSON.stringify(e.extra.violations));
  assert.equal(pending(r.caseId).length, 1, '422면 PENDING 복귀');
  const ok = await loop.approveDraft(d.id, { by: 'a', finalBody: `${d.original_body}\n추가로 궁금하신 점은 회신해 주세요.` });
  assert.ok(ok.dispatchId);
});

test('QA D1 에이전트가 맡은 케이스 반환 → 409 not_handed_off, 아무것도 바꾸지 않는다(대시보드 문구 포함)', async () => {
  const t = thread();
  const r = await t.run('영수증 발급 방법 알려주세요');
  const before = pending(r.caseId).map((x) => x.id);
  await rejects(loop.returnToAgent(r.caseId, { by: 'h' }), 409, 'not_handed_off');
  assert.deepEqual(pending(r.caseId).map((x) => x.id), before);
  assert.equal(db.get("SELECT COUNT(*) n FROM drafts WHERE case_id=? AND status='STALE'", r.caseId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM activities WHERE case_id=? AND type='return'", r.caseId).n, 0);
  assert.match(fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8'), /not_handed_off: '이미 에이전트가 맡고 있습니다/);
});

test('QA 깨진 %-인코딩 경로(/api/cases/%E0%A4%A)는 400', async () => {
  await withServer(async (api) => {
    assert.equal((await api('GET', '/api/cases/%E0%A4%A')).status, 400);
    assert.equal((await api('GET', '/api/cases/nope')).status, 404);
  });
});

test('QA D2 문의 유형·넘김 사유는 사람 말로 — 정책 팩의 intent 전부에 한국어 이름(서버·대시보드), 브리핑 요약에 코드 없음', () => {
  const labels = require('../server/labels');
  const web = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  const webIntent = web.match(/\n {2}intent: \{([\s\S]*?)\n {2}\},/)[1];
  for (const ch of ['support', 'onboarding', 'sales']) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, `policy/${ch}.json`), 'utf8'));
    for (const k of Object.keys(pack.intents)) {
      assert.ok(labels.INTENT[k], `server/labels.js intent ${k}`);
      assert.match(webIntent, new RegExp(`\\b${k}: '`), `web/app.js intent ${k}`);
    }
    for (const k of pack.handoffReasons) assert.ok(labels.REASON[k], `server/labels.js reason ${k}`);
  }
  const fb = require('../server/agents/briefer').fallback({ reason: 'refund_request', message: { body_clean: '환불' } });
  assert.match(fb.summary, /넘김\(환불 요청\)/);
  const { summary } = mock.brief({ pack: { label: '고객문의' }, triage: { intent: 'refund' }, reason: 'refund_request', message: { body_clean: '환불해 주세요' }, kb: kbLoader.load('support', 'ko') });
  assert.match(summary, /분류 「환불」으로 넘김\(환불 요청\)/); assert.doesNotMatch(summary, /refund/);
});
