'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const INQUIRIES = require('../server/mock/inquiries');
const mock = require('../server/llm/mock');
const kbLoader = require('../server/kb');
const sweeper = require('../server/sweeper');
const prefilter = require('../server/prefilter');

before(() => { db.init(':memory:'); llm.use('mock'); });

const lastExec = (caseId) => db.get("SELECT action, reason FROM decisions WHERE case_id=? AND step='execute' ORDER BY created_at DESC, rowid DESC LIMIT 1", caseId);
const triageOf = (caseId) => { const r = db.get("SELECT output FROM decisions WHERE case_id=? AND step='triage' ORDER BY created_at DESC LIMIT 1", caseId); return r ? JSON.parse(r.output) : null; };

test('합성 문의 20건이 기대 행동으로 끝난다', async () => {
  for (const q of INQUIRIES) {
    const r = cases.addInbound({ ...q, threadId: `t-${q.id}`, providerMessageId: `m-${q.id}` });
    await loop.runCycle(r.caseId, r.messageId);
    const ex = lastExec(r.caseId); const t = triageOf(r.caseId);
    assert.equal(ex.action, q.expect.action, `#${q.id} action (reason=${ex.reason})`);
    if (q.expect.intent) assert.equal(t.intent, q.expect.intent, `#${q.id} intent`);
    if (q.expect.reasons) assert.ok([].concat(q.expect.reasons).includes(ex.reason), `#${q.id} reason=${ex.reason}`);
    if (q.expect.language) assert.equal(t.language, q.expect.language);
    const c = db.get('SELECT state, responder FROM cases WHERE id=?', r.caseId);
    if (q.expect.action === 'DRAFT' || q.expect.action === 'ANSWER_AND_HANDOFF') {
      assert.equal(c.state, 'AWAITING_APPROVAL', `#${q.id} state`);
      const d = db.get("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", r.caseId);
      assert.ok(d && d.original_body.length > 20, `#${q.id} 초안`);
      assert.ok(JSON.parse(d.used_facts).length > 0 || ['reviewing', 'declined'].includes(t.intent), `#${q.id} usedFacts`);
    }
    if (q.expect.action === 'HANDOFF') {
      assert.equal(c.state, 'HANDED_OFF'); assert.equal(c.responder, 'human');
      const h = db.get('SELECT * FROM handoffs WHERE case_id=?', r.caseId);
      assert.ok(h && JSON.parse(h.briefing).nextAction, `#${q.id} 브리핑`);
    }
    if (q.expect.action === 'ANSWER_AND_HANDOFF') assert.ok(db.get('SELECT 1 FROM handoffs WHERE case_id=?', r.caseId), '답장+넘김은 브리핑도 있다');
  }
});

test('같은 메시지 두 번 runCycle → 두 번째는 건너뛴다(claim)', async () => {
  const r = cases.addInbound({ channel: 'support', from: 'a@example.com', body: '영수증 발급 부탁드립니다.', threadId: 'claim-1' });
  const a = await loop.runCycle(r.caseId, r.messageId);
  const b = await loop.runCycle(r.caseId, r.messageId);
  assert.equal(a.action, 'DRAFT'); assert.deepEqual(b, { skipped: 'already_processed' });
  assert.equal(db.get('SELECT COUNT(*) n FROM drafts WHERE case_id=?', r.caseId).n, 1);
});

test('중복 provider_message_id는 수신 단계에서 걸러진다', () => {
  const a = cases.addInbound({ channel: 'support', from: 'b@example.com', body: '탈퇴하고 싶어요', threadId: 'dup-1', providerMessageId: 'pm-1' });
  const b = cases.addInbound({ channel: 'support', from: 'b@example.com', body: '탈퇴하고 싶어요', threadId: 'dup-1', providerMessageId: 'pm-1' });
  assert.ok(a.caseId); assert.equal(b.duplicate, true);
});

test('리스 중 도착한 회신은 큐에 들어가고, 리스가 풀리면 처리된다', async () => {
  const r1 = cases.addInbound({ channel: 'support', from: 'c@example.com', body: '구독 해지 방법 알려주세요', threadId: 'lease-1' });
  db.run('UPDATE loops SET lease_until=? WHERE case_id=?', new Date(Date.now() + 60000).toISOString(), r1.caseId);
  const q = await loop.runCycle(r1.caseId, r1.messageId);
  assert.deepEqual(q, { queued: true });
  assert.deepEqual(JSON.parse(db.get('SELECT queue FROM loops WHERE case_id=?', r1.caseId).queue), [r1.messageId]);
  db.run('UPDATE loops SET lease_until=NULL WHERE case_id=?', r1.caseId);
  // 다른 메시지로 회차를 돌리면 끝난 뒤 큐를 비운다
  const r2 = cases.addInbound({ channel: 'support', from: 'c@example.com', body: '영수증도 필요합니다', threadId: 'lease-1' });
  await loop.runCycle(r2.caseId, r2.messageId);
  assert.deepEqual(JSON.parse(db.get('SELECT queue FROM loops WHERE case_id=?', r1.caseId).queue), []);
  assert.equal(db.get('SELECT COUNT(*) n FROM decisions WHERE case_id=? AND step=\'execute\'', r1.caseId).n, 2);
});

test('고객 재회신 → PENDING 초안은 STALE', async () => {
  const r1 = cases.addInbound({ channel: 'support', from: 'd@example.com', body: '로그인이 안 됩니다', threadId: 'stale-1' });
  await loop.runCycle(r1.caseId, r1.messageId);
  const d1 = db.get("SELECT id FROM drafts WHERE case_id=? AND status='PENDING'", r1.caseId);
  assert.ok(d1);
  const r2 = cases.addInbound({ channel: 'support', from: 'd@example.com', body: '아 그리고 비밀번호 재설정 메일도 안 와요', threadId: 'stale-1' });
  await loop.runCycle(r2.caseId, r2.messageId);
  assert.equal(db.get('SELECT status FROM drafts WHERE id=?', d1.id).status, 'STALE');
  assert.equal(db.get("SELECT COUNT(*) n FROM drafts WHERE case_id=? AND status='PENDING'", r1.caseId).n, 1);
});

test('같은 질문 반복 → 3번째에 no_progress 넘김', async () => {
  const body = '영수증은 어디서 받나요?';
  const r1 = cases.addInbound({ channel: 'support', from: 'e@example.com', body, threadId: 'rep-1' });
  await loop.runCycle(r1.caseId, r1.messageId);
  const r2 = cases.addInbound({ channel: 'support', from: 'e@example.com', body, threadId: 'rep-1' });
  await loop.runCycle(r2.caseId, r2.messageId);
  const r3 = cases.addInbound({ channel: 'support', from: 'e@example.com', body, threadId: 'rep-1' });
  const d = await loop.runCycle(r3.caseId, r3.messageId);
  assert.deepEqual(d, { action: 'HANDOFF', reason: 'no_progress' });
});

test('사람이 맡은 케이스의 회신은 판단하지 않는다(responder_human)', async () => {
  const r1 = cases.addInbound({ channel: 'support', from: 'f@example.com', body: '환불해 주세요', threadId: 'human-1' });
  await loop.runCycle(r1.caseId, r1.messageId);
  assert.equal(db.get('SELECT responder FROM cases WHERE id=?', r1.caseId).responder, 'human');
  const r2 = cases.addInbound({ channel: 'support', from: 'f@example.com', body: '답이 없네요. 영수증이라도 주세요', threadId: 'human-1' });
  const d = await loop.runCycle(r2.caseId, r2.messageId);
  assert.deepEqual(d, { action: 'IGNORE', reason: 'responder_human' });
  assert.equal(db.get("SELECT COUNT(*) n FROM drafts WHERE case_id=?", r1.caseId).n, 0);
});

test('개인정보는 known_facts·evidence에 남지 않는다', async () => {
  const r = cases.addInbound({ channel: 'support', from: 'g@example.com', body: '탈퇴 원합니다. 제 번호는 010-1234-5678 입니다.', threadId: 'pii-1', knownFacts: { 이름: '홍길동', 전화: '010-1234-5678', 이메일: 'g@example.com' } });
  assert.deepEqual(JSON.parse(db.get('SELECT known_facts FROM cases WHERE id=?', r.caseId).known_facts), { 이름: '홍길동' });
  await loop.runCycle(r.caseId, r.messageId);
  const t = triageOf(r.caseId);
  assert.ok(!JSON.stringify(t.evidence).includes('1234-5678'));
});

describe('영어 응대·LLM 장애·판단 근거·생명주기', () => {
  before(() => { db.init(':memory:'); process.env.LLM_RETRY_SCALE = '0.0001'; }); // 2분 → 12ms
  after(() => { delete process.env.LLM_RETRY_SCALE; });
  beforeEach(() => { llm.use('mock'); process.env.AUTO_SEND = '0'; for (const k of ['SHADOW_CHANNELS', 'AUTH_USER_HEADER', 'NODE_ENV', 'AUTO_CLOSE_DAYS', 'ENABLE_TEST_INJECT', 'INBOUND_SECRET']) delete process.env[k]; });

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

  test('영어: support는 영어 KB로 답하고 영어 메일 템플릿으로 나간다. 영어를 안 받는 채널은 language_unsupported', async () => {
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

  test('LLM 장애: 바로 넘기지 않고 재시도 예약 → sweeper가 돌림 → 4번 재시도 뒤 llm_error 넘김, 차단기', async () => {
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

  test('판단 근거: 게이트는 규칙 번호·입력값, 분류는 CLASSIFIED, 승인 대기 초안엔 KB 원문', async () => {
    const r = await thread().run('영수증 발급 방법 알려주세요');
    const g1 = db.get("SELECT output FROM decisions WHERE case_id=? AND step='gate1'", r.caseId);
    const o = JSON.parse(g1.output);
    assert.equal(o.rule, 8); assert.equal(o.inputs.intent, 'receipt'); assert.equal(o.inputs.confidenceMin, 0.8);
    assert.equal(JSON.parse(db.get("SELECT output FROM decisions WHERE case_id=? AND step='gate2'", r.caseId).output).rule, 12);
    assert.equal(db.get("SELECT action FROM decisions WHERE case_id=? AND step='triage'", r.caseId).action, 'CLASSIFIED');
    const d = cases.getCase(r.caseId).drafts.find((x) => x.status === 'PENDING');
    assert.match(d.kbPassages.receipt, /결제 내역/);
  });

  test('생명주기: 첫 메시지가 무시 대상이면 바로 종결, 30일 조용하면 자동 종결(승인 대기는 제외), 회신 오면 재오픈', async () => {
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
});

describe('재시도 예약·반환·재오픈·발송 중 회차 경쟁', () => {
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

  test('재시도 예약된 앞 메시지는 뒤 메시지가 IGNORE로 끝나도 남는다 → 재시도 뒤 승인 대기에 오른다', async () => {
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

  test('앞 메시지를 맥락에 본 뒤 메시지가 답장으로 끝나면 예약은 지운다', async () => {
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

  test('반환 두 번(동시) → 두 번째는 409 busy, 같은 메시지 초안은 1개. 순차로 한 번 더 반환하면 409 not_handed_off, PENDING 1개', async () => {
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

  test('sweeper 재시도가 도는 중에 recover가 같은 메시지를 다시 돌리지 않는다(반대도)', async () => {
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

  test('같은 메시지에 이미 답장이 나갔으면 already_answered 뒤 다시 쓰지 않는다', async () => {
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

  test('발송 중 시작한 회차가 발송이 끝난 뒤 쓴 초안 → 승인 409 already_answered(회차가 본 답장 기준)', async () => {
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

  test('거절(declined) 뒤 감사 인사 → IGNORE + 종결, 거절 뒤 새 질문 → 보통 회차', async () => {
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

  test('/return은 자기 회차만 기다리고 응답한다 — 줄 선 메시지는 뒤에서 처리 {cycled, queued}', async () => {
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

  test('1차 거르기를 통과해도 prefilter 판단 행(PASS)이 트레이스 맨 앞에 남는다', async () => {
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

  test('거절 뒤 감사 인사로 자동 종결된 케이스를 사람이 재오픈하면 같은 인사로 다시 닫지 않는다', async () => {
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
});

describe('회차 시나리오: 대기 초안·부재중·종결·인수·복구·리스', () => {
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ['LLM_MOCK_DELAY_MS', 'MAIL_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL']) delete process.env[k]; });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } };
  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `rf-${n}`; const from = `rf${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }
  const st = (id) => ({ ...db.get('SELECT state, responder FROM cases WHERE id=?', id) });
  const pending = (id) => db.all("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", id);
  const draft = (id) => db.get('SELECT * FROM drafts WHERE id=?', id);
  const lastExec = (id) => ({ ...db.get("SELECT action, reason FROM decisions WHERE case_id=? AND step='execute' ORDER BY rowid DESC LIMIT 1", id) });
  const rejects = (p, status, code) => p.then(() => assert.fail('throw 기대'), (e) => { assert.equal(e.status, status); if (code) assert.equal(e.message, code); return e; });
  const throws409 = (fn, code) => assert.throws(fn, (e) => e.status === 409 && e.message === code);

  test('대기 초안이 있는데 고객이 "감사합니다"만 보내면 답이 새 메시지 기준으로 다시 승인 대기에 오른다', async () => {
    const t = thread();
    const r1 = await t.run('영수증 발급 방법 알려주세요');
    assert.equal(pending(r1.caseId).length, 1);
    const r2 = await t.run('감사합니다');
    const p = pending(r1.caseId);
    assert.equal(p.length, 1); assert.equal(p[0].trigger_message_id, r2.messageId); assert.equal(p[0].intent, 'receipt');
    assert.equal(lastExec(r1.caseId).action, 'CARRY_OVER');
    assert.equal(st(r1.caseId).state, 'AWAITING_APPROVAL');
    await loop.approveDraft(p[0].id, { by: 't' });
    assert.equal(st(r1.caseId).state, 'WAITING_CUSTOMER');
  });

  test('본문에 "부재중"이 들어간 환불 요청은 버리지 않고 사람에게 넘긴다', async () => {
    const r = await thread().run('출장으로 부재중이었는데 자동결제가 됐어요. 환불해 주세요');
    assert.deepEqual(lastExec(r.caseId), { action: 'HANDOFF', reason: 'refund_request' });
  });

  test('수신 어댑터가 autoSubmitted로 표시한 메일은 무시한다', async () => {
    const r = await thread().run('휴가 중입니다. 다음 주에 회신드립니다.', { autoSubmitted: true });
    assert.equal(lastExec(r.caseId).action, 'IGNORE');
  });

  test('회차 도중 종결 → 결과를 쓰지 않는다(승인 대기 없음, 초안은 NOT_SELECTED 기록)', async () => {
    process.env.LLM_MOCK_DELAY_MS = '30';
    const t = thread(); const r = t.add('영수증 발급 방법 알려주세요');
    const p = loop.runCycle(r.caseId, r.messageId);
    await sleep(10); loop.closeCase(r.caseId, { by: 'h' });
    assert.equal((await p).action, 'ABORTED');
    assert.equal(st(r.caseId).state, 'CLOSED'); assert.equal(pending(r.caseId).length, 0);
    assert.ok(db.get("SELECT 1 FROM drafts WHERE case_id=? AND status='NOT_SELECTED'", r.caseId));
  });

  test('회차 도중 인수 → HANDED_OFF 유지, 승인할 초안이 생기지 않는다', async () => {
    process.env.LLM_MOCK_DELAY_MS = '30';
    const t = thread(); const r = t.add('로그인이 안 됩니다');
    const p = loop.runCycle(r.caseId, r.messageId);
    await sleep(10); loop.takeover(r.caseId, { by: 'h' });
    await p;
    assert.deepEqual(st(r.caseId), { state: 'HANDED_OFF', responder: 'human' });
    assert.equal(pending(r.caseId).length, 0);
  });

  test('발송 중: 직접 답장·인수·종결은 409 sending, 발송 중 들어온 메시지의 초안은 그 답장을 보고 다시 쓴다', async () => {
    const t = thread();
    const r1 = await t.run('영수증 발급 방법 알려주세요');
    const d1 = pending(r1.caseId)[0];
    process.env.MAIL_MOCK_DELAY_MS = '80';
    const ap = loop.approveDraft(d1.id, { by: 'a' });
    await sleep(10);
    await rejects(loop.humanReply(r1.caseId, { by: 'h', body: '제가 답합니다' }), 409, 'sending');
    throws409(() => loop.takeover(r1.caseId, { by: 'h' }), 'sending');
    throws409(() => loop.closeCase(r1.caseId, { by: 'h' }), 'sending');
    // 발송 중에 고객이 또 씀 → 그 회차는 D1 답장을 못 본 채 D2를 쓴다
    const r2 = t.add('로그인도 안 됩니다');
    await loop.runCycle(r2.caseId, r2.messageId);
    const d2 = pending(r1.caseId)[0];
    assert.ok(d2);
    await ap;
    assert.equal(st(r1.caseId).state, 'AWAITING_APPROVAL', 'D2가 남아 있으면 상태를 덮지 않는다');
    delete process.env.MAIL_MOCK_DELAY_MS;
    await rejects(loop.approveDraft(d2.id, { by: 'a' }), 409, 'already_answered');
    assert.equal(draft(d2.id).status, 'STALE');
    const d3 = await until(() => pending(r1.caseId)[0]);
    assert.equal(d3.trigger_message_id, r2.messageId);
    await loop.approveDraft(d3.id, { by: 'a' });
    assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", r1.caseId).n, 2);
  });

  test('답장+넘김 초안이 낡아도 넘김은 남는다 — 다음 초안도 승인되면 사람에게', async () => {
    const t = thread('sales');
    const r1 = await t.run('예산이 정해져 있는데 대략적인 견적 부탁드립니다.');
    assert.equal(pending(r1.caseId)[0].action, 'ANSWER_AND_HANDOFF');
    await t.run('소개서도 보내주실 수 있나요?');
    const d = pending(r1.caseId)[0];
    assert.equal(d.intent, 'material_request'); assert.equal(d.action, 'ANSWER_AND_HANDOFF');
    assert.equal(db.get('SELECT COUNT(*) n FROM handoffs WHERE case_id=?', r1.caseId).n, 1, '같은 사유로 넘김을 또 만들지 않는다');
    await loop.approveDraft(d.id, { by: 'a' });
    assert.deepEqual(st(r1.caseId), { state: 'HANDED_OFF', responder: 'human' });
  });

  test('회차 밖 예외 → internal_error로 사람에게, 리스 해제, 줄 선 메시지도 처리', async () => {
    const t = thread();
    const r1 = t.add('영수증 주세요'); const r2 = t.add('로그인도 안 돼요');
    db.run('UPDATE loops SET queue=? WHERE case_id=?', JSON.stringify([r2.messageId]), r1.caseId);
    const orig = prefilter.check;
    prefilter.check = () => { prefilter.check = orig; throw new Error('boom'); };
    const out = await loop.runCycle(r1.caseId, r1.messageId);
    assert.deepEqual(out, { action: 'HANDOFF', reason: 'internal_error' });
    assert.deepEqual(st(r1.caseId), { state: 'HANDED_OFF', responder: 'human' });
    assert.ok(db.get("SELECT 1 FROM handoffs WHERE case_id=? AND reason='internal_error'", r1.caseId));
    const lp = db.get('SELECT lease_until, queue FROM loops WHERE case_id=?', r1.caseId);
    assert.equal(lp.lease_until, null); assert.equal(lp.queue, '[]');
    assert.ok(db.get("SELECT 1 FROM decisions WHERE message_id=? AND step='execute'", r2.messageId), '줄 선 메시지도 판단됨');
  });

  test('재시작 복구: 판단이 안 끝난 메시지 재실행, 큐 비우기, SENDING 초안 확인 표시·처리', async () => {
    const t = thread();
    const r1 = t.add('영수증 발급 부탁드립니다');
    cases.claim(`loop:${r1.caseId}:${r1.messageId}`); // 회차 도중 죽은 상태
    db.run('UPDATE loops SET lease_until=?, lease_token=? WHERE case_id=?', new Date(Date.now() + 60000).toISOString(), 'dead', r1.caseId);
    await loop.recover();
    const d = pending(r1.caseId)[0];
    assert.ok(d, '재실행으로 초안이 생긴다');
    // 발송 중에 죽은 초안
    db.run("UPDATE drafts SET status='SENDING', approved_by='a', approved_at=? WHERE id=?", new Date(Date.now() - 5 * 60000).toISOString(), d.id);
    await loop.recover();
    assert.ok(db.get("SELECT 1 FROM activities WHERE case_id=? AND type='send_unconfirmed'", r1.caseId));
    const det = cases.getCase(r1.caseId);
    assert.equal(det.needsSendCheck, true);
    assert.equal(det.drafts.find((x) => x.id === d.id).needs_send_check, true);
    loop.resolveSending(d.id, { by: 'h', outcome: 'pending' });
    assert.equal(draft(d.id).status, 'PENDING'); assert.equal(st(r1.caseId).state, 'AWAITING_APPROVAL');
    db.run("UPDATE drafts SET status='SENDING' WHERE id=?", d.id);
    loop.resolveSending(d.id, { by: 'h', outcome: 'sent' });
    assert.equal(draft(d.id).status, 'SENT');
    assert.equal(st(r1.caseId).state, 'WAITING_CUSTOMER');
    assert.equal(db.get("SELECT provider FROM dispatches WHERE draft_id=?", d.id).provider, 'manual');
  });

  test('같은 케이스에 회차 둘이 동시에 → 하나는 큐, 순서대로 처리, 리스는 비워진다', async () => {
    process.env.LLM_MOCK_DELAY_MS = '15';
    const t = thread();
    const r1 = t.add('영수증 발급 부탁드립니다'); const r2 = t.add('로그인도 안 됩니다');
    const [a, b] = await Promise.all([loop.runCycle(r1.caseId, r1.messageId), loop.runCycle(r2.caseId, r2.messageId)]);
    assert.deepEqual(b, { queued: true });
    assert.equal(a.action, 'ABORTED', '더 새 메시지가 있으니 r1 초안은 쓰지 않는다');
    const p = pending(r1.caseId);
    assert.equal(p.length, 1); assert.equal(p[0].trigger_message_id, r2.messageId);
    assert.equal(db.get('SELECT lease_until FROM loops WHERE case_id=?', r1.caseId).lease_until, null);
  });

  test('리스 해제는 자기 토큰일 때만', async () => {
    process.env.LLM_MOCK_DELAY_MS = '30';
    const t = thread(); const r = t.add('구독 해지 방법');
    const p = loop.runCycle(r.caseId, r.messageId);
    await sleep(10);
    const later = new Date(Date.now() + 60000).toISOString();
    db.run("UPDATE loops SET lease_until=?, lease_token='other' WHERE case_id=?", later, r.caseId); // 리스가 만료돼 다른 회차가 잡았다고 치자
    await p;
    assert.equal(db.get('SELECT lease_token FROM loops WHERE case_id=?', r.caseId).lease_token, 'other');
  });

  test('불변식: 승인 대기인데 PENDING 초안이 없는 케이스가 없다', () => {
    const bad = db.all("SELECT id FROM cases c WHERE state='AWAITING_APPROVAL' AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=c.id AND d.status='PENDING')");
    assert.deepEqual(bad, []);
  });
});
