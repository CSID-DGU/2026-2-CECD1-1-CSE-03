'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');

before(() => { db.init(':memory:'); llm.use('mock'); });

let n = 0;
async function draftFor(body = '영수증 발급 부탁드립니다.', channel = 'support') {
  n += 1;
  const tid = `ap-${n}`;
  const r = cases.addInbound({ channel, from: `u${n}@example.com`, name: `고객${n}`, subject: '문의', body, threadId: tid });
  await loop.runCycle(r.caseId, r.messageId);
  const d = db.get("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", r.caseId);
  return { ...r, draft: d };
}
const rejects = (p, status, code) => p.then(() => assert.fail('throw 기대'), (e) => { assert.equal(e.status, status); if (code) assert.equal(e.message, code); return e; });

test('승인 → SENT → WAITING_CUSTOMER, out 메시지·dispatch·rounds', async () => {
  const { caseId, draft } = await draftFor();
  const out = await loop.approveDraft(draft.id, { by: 'tester' });
  assert.ok(out.dispatchId);
  const d = db.get('SELECT * FROM drafts WHERE id=?', draft.id);
  assert.equal(d.status, 'SENT'); assert.equal(d.approved_by, 'tester'); assert.equal(d.final_body, null);
  assert.equal(db.get('SELECT state FROM cases WHERE id=?', caseId).state, 'WAITING_CUSTOMER');
  const m = db.get("SELECT * FROM messages WHERE case_id=? AND direction='out'", caseId);
  assert.equal(m.sent_by, 'agent'); assert.match(m.body, /AI 상담 에이전트/); assert.match(m.body, /고객1 님/);
  assert.equal(db.get('SELECT rounds FROM loops WHERE case_id=?', caseId).rounds, 1);
  assert.equal(db.get('SELECT status FROM dispatches WHERE draft_id=?', draft.id).status, 'SENT');
});

test('두 번 승인 → 두 번째는 409 not_pending, 발송 1건', async () => {
  const { draft } = await draftFor();
  await loop.approveDraft(draft.id, { by: 'a' });
  await rejects(loop.approveDraft(draft.id, { by: 'b' }), 409, 'not_pending');
  assert.equal(db.get('SELECT COUNT(*) n FROM dispatches WHERE draft_id=?', draft.id).n, 1);
});

test('승인 전에 새 고객 메시지 → 409 stale, 초안 STALE', async () => {
  const { caseId, draft, threadId } = await draftFor();
  // 루프를 돌리지 않고 메시지만 추가(승인 버튼 누르는 순간 도착한 상황)
  cases.addInbound({ channel: 'support', from: 'x@example.com', body: '추가 질문이요', threadId });
  await rejects(loop.approveDraft(draft.id, { by: 'a' }), 409, 'stale');
  assert.equal(db.get('SELECT status FROM drafts WHERE id=?', draft.id).status, 'STALE');
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", caseId).n, 0);
});

test('인수(takeover) 뒤 승인 → 409 (PENDING은 NOT_SELECTED)', async () => {
  const { caseId, draft } = await draftFor();
  loop.takeover(caseId, { by: 'human1' });
  const c = db.get('SELECT * FROM cases WHERE id=?', caseId);
  assert.equal(c.responder, 'human'); assert.equal(c.state, 'HANDED_OFF'); assert.equal(c.assignee, 'human1');
  assert.equal(db.get('SELECT status FROM drafts WHERE id=?', draft.id).status, 'NOT_SELECTED');
  await rejects(loop.approveDraft(draft.id, { by: 'a' }), 409, 'not_pending');
});

test('수정 후 승인 → final_body·edited_by·edit_tags 기록, 멱등키 그대로', async () => {
  const { draft } = await draftFor();
  await loop.approveDraft(draft.id, { by: 'editor', finalBody: '영수증은 설정 > 결제 > 결제 내역에서 받으실 수 있습니다.', editTags: ['excess'] });
  const d = db.get('SELECT * FROM drafts WHERE id=?', draft.id);
  assert.equal(d.status, 'SENT'); assert.match(d.final_body, /결제 내역/); assert.equal(d.edited_by, 'editor'); assert.deepEqual(JSON.parse(d.edit_tags), ['excess']);
  assert.equal(d.idempotency_key, `draft:${draft.id}`);
  assert.equal(db.get('SELECT type FROM activities WHERE case_id=? ORDER BY created_at DESC LIMIT 1', draft.case_id).type, 'edit_approve');
});

test('사람이 고친 본문에 금액·미치환 슬롯 → 422 guard, PENDING 복귀', async () => {
  const { draft } = await draftFor();
  const e = await rejects(loop.approveDraft(draft.id, { by: 'a', finalBody: '{회사명} 님, 비용은 10,000원입니다.' }), 422, 'guard');
  assert.ok(e.extra.violations.some((v) => v.code === 'amount'));
  assert.ok(e.extra.violations.some((v) => v.code === 'unresolved_slot'));
  assert.equal(db.get('SELECT status FROM drafts WHERE id=?', draft.id).status, 'PENDING');
});

test('발송 실패 → PENDING 복귀 + error, 재시도 성공 시 dispatch 1행', async () => {
  const { draft } = await draftFor();
  process.env.MAIL_MOCK_FAIL = '1';
  await rejects(loop.approveDraft(draft.id, { by: 'a' }), 502, 'send_failed');
  delete process.env.MAIL_MOCK_FAIL;
  const d = db.get('SELECT * FROM drafts WHERE id=?', draft.id);
  assert.equal(d.status, 'PENDING'); assert.match(d.error, /mock send failure/);
  await loop.approveDraft(draft.id, { by: 'a' });
  const ds = db.all('SELECT * FROM dispatches WHERE draft_id=?', draft.id);
  assert.equal(ds.length, 1); assert.equal(ds[0].status, 'SENT');
});

test('폐기 → DISCARDED, 케이스는 사람에게', async () => {
  const { caseId, draft } = await draftFor();
  loop.discardDraft(draft.id, { by: 'h', reason: '어조' });
  assert.equal(db.get('SELECT status FROM drafts WHERE id=?', draft.id).status, 'DISCARDED');
  const c = db.get('SELECT * FROM cases WHERE id=?', caseId);
  assert.equal(c.responder, 'human'); assert.equal(c.state, 'HANDED_OFF');
});

test('반환(return) → 마지막 미답 고객 메시지를 즉시 다시 판단', async () => {
  // 환불 문의로 넘김 → 고객이 영수증 질문을 추가 → 담당자가 반환 → 영수증 초안이 생겨야 한다
  const r1 = cases.addInbound({ channel: 'support', from: 'ret@example.com', body: '환불해 주세요', threadId: 'ret-1' });
  await loop.runCycle(r1.caseId, r1.messageId);
  const r2 = cases.addInbound({ channel: 'support', from: 'ret@example.com', body: '그럼 영수증이라도 발급해 주세요', threadId: 'ret-1' });
  await loop.runCycle(r2.caseId, r2.messageId); // responder_human → 무시
  assert.equal(db.get('SELECT COUNT(*) n FROM drafts WHERE case_id=?', r1.caseId).n, 0);
  const out = await loop.returnToAgent(r1.caseId, { by: 'h' });
  assert.equal(out.cycled, true);
  const d = db.get("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", r1.caseId);
  assert.ok(d); assert.equal(d.intent, 'receipt'); assert.equal(d.trigger_message_id, r2.messageId);
  assert.equal(db.get('SELECT responder FROM cases WHERE id=?', r1.caseId).responder, 'agent');
});

test('ANSWER_AND_HANDOFF 승인 → 발송 후 HANDED_OFF + responder human', async () => {
  const { caseId, draft } = await draftFor('예산 500만 원이면 어디까지 가능한가요? 견적 부탁드립니다.', 'sales');
  assert.equal(draft.action, 'ANSWER_AND_HANDOFF');
  await loop.approveDraft(draft.id, { by: 'a' });
  const c = db.get('SELECT * FROM cases WHERE id=?', caseId);
  assert.equal(c.state, 'HANDED_OFF'); assert.equal(c.responder, 'human');
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", caseId).n, 1);
});

test('직접 답장(human-reply) → 실제 발송(dispatch), PENDING은 NOT_SELECTED, WAITING_CUSTOMER', async () => {
  const { caseId, draft } = await draftFor();
  const out = await loop.humanReply(caseId, { by: 'h', body: '제가 직접 안내드립니다.' });
  assert.equal(db.get('SELECT status FROM dispatches WHERE draft_id=?', out.draftId).status, 'SENT');
  assert.equal(db.get('SELECT status FROM drafts WHERE id=?', draft.id).status, 'NOT_SELECTED');
  const c = db.get('SELECT * FROM cases WHERE id=?', caseId);
  assert.equal(c.state, 'WAITING_CUSTOMER'); assert.equal(c.responder, 'human');
  assert.equal(db.get("SELECT sent_by FROM messages WHERE case_id=? AND direction='out'", caseId).sent_by, 'human');
});

test('종결 → CLOSED, 고객 회신 오면 재오픈', async () => {
  const { caseId, threadId } = await draftFor();
  loop.closeCase(caseId, { by: 'h' });
  assert.equal(db.get('SELECT state FROM cases WHERE id=?', caseId).state, 'CLOSED');
  const r = cases.addInbound({ channel: 'support', from: 'z@example.com', body: '다시 문의드립니다. 로그인이 안 돼요', threadId });
  assert.equal(r.caseId, caseId); assert.equal(r.created, false);
  assert.equal(db.get('SELECT state FROM cases WHERE id=?', caseId).state, 'OPEN');
});
