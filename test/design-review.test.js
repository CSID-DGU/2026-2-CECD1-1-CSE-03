'use strict';
// 설계 리뷰 반영 — 영어·인증·섀도 승격·LLM 장애·버전·판단 근거·생명주기·팩 검증·기타.
process.env.MAIL_MOCK_LOG = '0';
process.env.LLM_RETRY_SCALE = '0.0001'; // 2분 → 12ms
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../server/db');
const llm = require('../server/llm');
const mock = require('../server/llm/mock');
const cases = require('../server/cases');
const loop = require('../server/loop');
const events = require('../server/events');
const policy = require('../server/policy');
const kbLoader = require('../server/kb');
const mail = require('../server/mail');
const sweeper = require('../server/sweeper');
const notify = require('../server/notify');
const { createServer } = require('../server/index');

before(() => { db.init(':memory:'); });
beforeEach(() => { llm.use('mock'); for (const k of ['SHADOW_CHANNELS', 'AUTH_USER_HEADER', 'NODE_ENV', 'AUTO_CLOSE_DAYS', 'ENABLE_TEST_INJECT', 'INBOUND_SECRET']) delete process.env[k]; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
function thread(channel = 'support') {
  n += 1;
  const tid = `cf-${n}`; const from = `cf${n}@example.com`;
  const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
  return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
}
const st = (id) => ({ ...db.get('SELECT state, responder FROM cases WHERE id=?', id) });
const pending = (id) => db.all("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", id);
const lastExec = (id) => ({ ...db.get("SELECT action, reason FROM decisions WHERE case_id=? AND step='execute' ORDER BY rowid DESC LIMIT 1", id) });
async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try { return await fn(api); } finally { server.close(); }
}

test('1 영어: support는 영어 KB로 답하고 영어 메일 템플릿으로 나간다. 영어를 안 받는 채널은 language_unsupported', async () => {
  const r = await thread().run('Hi, how do I cancel my subscription? I could not find the option.');
  const d = pending(r.caseId)[0];
  assert.ok(d); assert.doesNotMatch(d.original_body, /[가-힣]/);
  const out = await loop.approveDraft(d.id, { by: 'a' });
  const m = db.get('SELECT body FROM messages WHERE id=?', out.messageId).body;
  assert.match(m, /^Hello /); assert.match(m, /AI support agent at ACME/);
  const s = await thread('sales').run('Could you send me your service brochure?');
  assert.deepEqual(lastExec(s.caseId), { action: 'HANDOFF', reason: 'language_unsupported' });
  // mock은 영어 KB에 키가 없으면 지어내지 않고 넘긴다
  const res = mock.respond({ triage: { intent: 'receipt', language: 'en', kbSections: ['receipt'] }, kb: kbLoader.load('sales', 'en') });
  assert.equal(res.needsHandoff, true); assert.equal(res.handoffReason, 'language_unsupported');
  assert.equal(kbLoader.load('support', 'en').language, 'en');
  assert.equal(kbLoader.load('sales', 'en').language, 'ko', '영어 KB가 없으면 한국어 KB(실제 LLM이 옮긴다)');
});

test('2 인증 헤더: 켜지면 POST는 헤더 필수, by는 헤더 값으로 덮인다. 웹훅 수신은 예외', async () => {
  process.env.AUTH_USER_HEADER = 'x-forwarded-user';
  const r = await thread().run('영수증 발급 방법 알려주세요');
  const d = pending(r.caseId)[0];
  await withServer(async (api) => {
    assert.equal((await api('GET', '/api/health')).data.auth, 'header');
    assert.equal((await api('POST', `/api/drafts/${d.id}/approve`, { by: 'fake' })).status, 401);
    assert.deepEqual((await api('GET', '/api/me', null, { 'x-forwarded-user': 'kim' })).data, { user: 'kim', auth: 'header' });
    const ok = await api('POST', `/api/drafts/${d.id}/approve`, { by: 'fake' }, { 'x-forwarded-user': 'kim' });
    assert.equal(ok.status, 200);
    assert.equal(db.get('SELECT approved_by FROM drafts WHERE id=?', d.id).approved_by, 'kim');
    assert.equal((await api('POST', '/api/inbound', { channel: 'support', from: 'w@example.com', body: '감사합니다' })).status, 200);
  });
});

test('3 섀도: SHADOW_CHANNELS는 좁히기만, 섀도 초안 평가 → 채널 승격 지표', async () => {
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

test('4 LLM 장애: 바로 넘기지 않고 재시도 예약 → sweeper가 돌림 → 4번 재시도 뒤 llm_error 넘김, 차단기', async () => {
  let fail = true;
  llm.use({ name: 'flaky', json: async (req) => { if (fail) throw new Error('upstream 503'); return mock.json(req); } });
  const t = thread(); const r = t.add('로그인이 안 됩니다');
  let out = await loop.runCycle(r.caseId, r.messageId);
  assert.equal(out.action, 'RETRY'); assert.deepEqual(st(r.caseId), { state: 'OPEN', responder: 'agent' });
  assert.ok(db.get('SELECT next_retry_at FROM loops WHERE case_id=?', r.caseId).next_retry_at);
  assert.equal(loop.status().retriesPending, 1);
  for (let i = 0; i < 4; i += 1) { await sleep(5); await sweeper.tick(Date.now() + 3_600_000); }
  assert.deepEqual(lastExec(r.caseId), { action: 'HANDOFF', reason: 'llm_error' });
  assert.deepEqual(st(r.caseId), { state: 'HANDED_OFF', responder: 'human' });
  assert.equal(db.get("SELECT COUNT(*) n FROM decisions WHERE case_id=? AND step='error'", r.caseId).n, 5);
  // 차단기: 연속 5번 실패하면 열린다 → 바로 실패(llm_unavailable)
  llm.use({ name: 'down', json: async () => { throw new Error('down'); } });
  for (let i = 0; i < 5; i += 1) await assert.rejects(llm.json({ agent: 'triage' }));
  assert.equal(llm.health(), 'open'); assert.equal(loop.status().llm, 'open');
  await assert.rejects(llm.json({ agent: 'triage' }), /llm_unavailable/);
  // 복구되면 재시도로 정상 처리
  fail = false; llm.use({ name: 'flaky', json: async (req) => mock.json(req) });
  const r2 = t.add('비밀번호 재설정 메일이 안 와요'); // 사람 전담이 된 케이스 — 판단만 기록
  out = await loop.runCycle(r2.caseId, r2.messageId);
  assert.equal(out.reason, 'responder_human');
});

test('5 버전: 프롬프트 원본·KB 본문이 해시로 저장되고 API로 되찾는다', async () => {
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

test('6 판단 근거: 게이트는 규칙 번호·입력값, 분류는 CLASSIFIED, 승인 대기 초안엔 KB 원문', async () => {
  const r = await thread().run('영수증 발급 방법 알려주세요');
  const g1 = db.get("SELECT output FROM decisions WHERE case_id=? AND step='gate1'", r.caseId);
  const o = JSON.parse(g1.output);
  assert.equal(o.rule, 8); assert.equal(o.inputs.intent, 'receipt'); assert.equal(o.inputs.confidenceMin, 0.8);
  assert.equal(JSON.parse(db.get("SELECT output FROM decisions WHERE case_id=? AND step='gate2'", r.caseId).output).rule, 12);
  assert.equal(db.get("SELECT action FROM decisions WHERE case_id=? AND step='triage'", r.caseId).action, 'CLASSIFIED');
  const d = cases.getCase(r.caseId).drafts.find((x) => x.status === 'PENDING');
  assert.match(d.kbPassages.receipt, /결제 내역/);
});

test('7 생명주기: 첫 메시지가 무시 대상이면 바로 종결, 30일 조용하면 자동 종결(승인 대기는 제외), 회신 오면 재오픈', async () => {
  const t = thread(); const r = await t.run('감사합니다. 잘 받았습니다.');
  assert.equal(st(r.caseId).state, 'CLOSED');
  assert.ok(db.get("SELECT 1 FROM activities WHERE case_id=? AND type='auto_close' AND payload LIKE '%ignored_first_message%'", r.caseId));
  const r2 = t.add('그런데 영수증은 어디서 받나요?');
  assert.equal(st(r.caseId).state, 'OPEN');
  await loop.runCycle(r2.caseId, r2.messageId);
  assert.equal(st(r.caseId).state, 'AWAITING_APPROVAL');
  const h = await thread().run('환불해 주세요'); // HANDED_OFF
  process.env.AUTO_CLOSE_DAYS = '30';
  const res = await sweeper.tick(Date.now() + 31 * 86_400_000);
  assert.ok(res.closed >= 1);
  assert.equal(st(h.caseId).state, 'CLOSED'); assert.equal(st(r.caseId).state, 'AWAITING_APPROVAL', '승인 대기는 닫지 않는다');
  assert.ok(db.get("SELECT 1 FROM activities WHERE case_id=? AND type='auto_close'", h.caseId));
});

test('7 알림 웹훅: 넘김·승인 대기 초안만, 고객 연락처·본문 없이', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, r));
  const stop = notify.start(`http://127.0.0.1:${srv.address().port}/hook`);
  try {
    await thread().run('환불해 주세요. 제 번호는 010-9999-8888 입니다');
    await thread().run('구독 해지 방법 알려주세요');
    for (let i = 0; i < 50 && got.length < 2; i += 1) await sleep(10);
  } finally { stop(); srv.close(); }
  const texts = got.map((g) => g.text);
  assert.ok(texts.some((t) => /사람에게 넘김: refund_request/.test(t) && /#cs-support/.test(t)));
  assert.ok(texts.some((t) => /승인 대기 초안/.test(t)));
  for (const t of texts) { assert.doesNotMatch(t, /@|9999|환불해/); }
});

test('8 잘못된 팩은 로드할 때 바로 실패한다', () => {
  const ok = policy.load('support');
  const bad = (patch) => () => policy.validate({ ...JSON.parse(JSON.stringify(ok)), ...patch }, 'x');
  assert.throws(bad({ maxLevel: 'L3' }), /maxLevel/);
  assert.throws(bad({ thresholds: { ...ok.thresholds, confidenceMin: '0.8' } }), /confidenceMin/);
  assert.throws(bad({ intents: { refund: { level: 'L9' } } }), /level/);
  assert.throws(bad({ intents: { refund: { level: 'H', reason: 'nope' } } }), /reason=nope/);
  assert.doesNotThrow(() => policy.all());
});

test('9 반환은 회차·되묻기를 새로 센다, 폐기는 담당자 노트를 남긴다, 승인 이벤트에 실제 messageId', async () => {
  const t = thread(); const r = await t.run('영수증 발급 방법 알려주세요');
  db.run('UPDATE loops SET rounds=7, repeat_streak=1 WHERE case_id=?', r.caseId);
  loop.takeover(r.caseId, { by: 'h' });
  await loop.returnToAgent(r.caseId, { by: 'h' });
  const lp = db.get('SELECT rounds, repeat_streak FROM loops WHERE case_id=?', r.caseId);
  assert.deepEqual({ ...lp }, { rounds: 0, repeat_streak: 0 });
  const d = pending(r.caseId)[0];
  loop.discardDraft(d.id, { by: 'h', reason: '어조' });
  const hf = db.get("SELECT briefing FROM handoffs WHERE case_id=? AND reason='discarded'", r.caseId);
  assert.match(JSON.parse(hf.briefing).summary, /폐기/);
  const r2 = await thread().run('구독 해지 방법');
  const seen = []; const unsub = events.subscribe((e) => { if (e.name === 'message.created') seen.push(e.data); });
  const out = await loop.approveDraft(pending(r2.caseId)[0].id, { by: 'a' });
  unsub();
  assert.equal(seen[0].messageId, out.messageId);
});

test('9 고쳐서 승인한 답장은 사람 약속으로 다음 회차에 넘어간다(edited)', async () => {
  const t = thread(); const r = await t.run('영수증 발급 방법 알려주세요');
  const out = await loop.approveDraft(pending(r.caseId)[0].id, { by: 'a', finalBody: '영수증은 설정 > 결제 > 결제 내역에서 받으실 수 있습니다.', editTags: ['missing'] });
  assert.equal(db.get('SELECT edited FROM messages WHERE id=?', out.messageId).edited, 1);
  await t.run('로그인도 안 됩니다');
  const resp = JSON.parse(db.get("SELECT output FROM decisions WHERE case_id=? AND step='respond' ORDER BY rowid DESC LIMIT 1", r.caseId).output);
  assert.ok(resp.humanCommitments.length > 0);
});

test('9 테스트 주입 엔드포인트: 개발에선 켜짐(시크릿 무시), 운영에선 ENABLE_TEST_INJECT=1일 때만', async () => {
  process.env.INBOUND_SECRET = 's';
  await withServer(async (api) => {
    const body = { channel: 'support', from: 'ti@example.com', body: '감사합니다' };
    assert.equal((await api('POST', '/api/inbound', body)).status, 401);
    assert.equal((await api('POST', '/api/test/inbound', body)).status, 200);
    process.env.NODE_ENV = 'production';
    assert.equal((await api('POST', '/api/test/inbound', body)).status, 404);
    process.env.ENABLE_TEST_INJECT = '1';
    assert.equal((await api('POST', '/api/test/inbound', body)).status, 200);
  });
});

test('11 운영에서 mock 메일이면 경고, mock 발송은 같은 멱등키에 같은 id', async () => {
  await withServer(async (api) => {
    assert.equal((await api('GET', '/api/health')).data.mailWarning, undefined);
    process.env.NODE_ENV = 'production';
    assert.match((await api('GET', '/api/health')).data.mailWarning, /mock/);
  });
  const a = await mail.send({ to: 'x@example.com', subject: 's', body: 'b', idempotencyKey: 'same' });
  const b = await mail.send({ to: 'x@example.com', subject: 's', body: 'b', idempotencyKey: 'same' });
  assert.equal(a.id, b.id); assert.equal(b.duplicate, true);
});
