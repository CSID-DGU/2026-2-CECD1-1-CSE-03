'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const INQUIRIES = require('../server/mock/inquiries');

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
