'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const mock = require('../server/llm/mock');
const events = require('../server/events');
const kbLoader = require('../server/kb');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server/index');

const ROOT = path.join(__dirname, '..');

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

describe('반환·폐기·승인 이벤트·고쳐서 승인', () => {
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

  test('반환은 회차·되묻기를 새로 센다, 폐기는 담당자 노트를 남긴다, 승인 이벤트에 실제 messageId', async () => {
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

  test('고쳐서 승인한 답장은 사람 약속으로 다음 회차에 넘어간다(edited)', async () => {
    const t = thread(); const r = await t.run('영수증 발급 방법 알려주세요');
    const out = await loop.approveDraft(pending(r.caseId)[0].id, { by: 'a', finalBody: '영수증은 설정 > 결제 > 결제 내역에서 받으실 수 있습니다.', editTags: ['missing'] });
    assert.equal(db.get('SELECT edited FROM messages WHERE id=?', out.messageId).edited, 1);
    await t.run('로그인도 안 됩니다');
    const resp = JSON.parse(db.get("SELECT output FROM decisions WHERE case_id=? AND step='respond' ORDER BY rowid DESC LIMIT 1", r.caseId).output);
    assert.ok(resp.humanCommitments.length > 0);
  });
});

describe('발송 확인·동시 승인·재작성·기한 지난 근거·원문 재검사', () => {
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

  test('발송 중(SEND_CHECK_MS 전) 초안은 resolve-sending 409 sending_in_progress — 오래된 SENDING만 처리', async () => {
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

  test('HTTP 동시 승인(발송 지연) → 발송 1건·200 하나·409 하나', async () => {
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

  test('재작성: 첫 작성 guard 실패 → 1회 재작성 통과 → DRAFT / 재작성도 실패 → HANDOFF guard_failed', async () => {
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

  test('근거 KB 절이 기한 지남 — 고친 본문은 승인(경고 기록), 고치지 않은 본문은 422 unknown_fact', async () => {
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

  test('승인 때 고치지 않은 원문은 intent 근거 범위도 다시 본다(fact_off_intent), 고친 본문은 intent 없이 본다', async () => {
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

  test('에이전트가 맡은 케이스 반환 → 409 not_handed_off, 아무것도 바꾸지 않는다(대시보드 문구 포함)', async () => {
    const t = thread();
    const r = await t.run('영수증 발급 방법 알려주세요');
    const before = pending(r.caseId).map((x) => x.id);
    await rejects(loop.returnToAgent(r.caseId, { by: 'h' }), 409, 'not_handed_off');
    assert.deepEqual(pending(r.caseId).map((x) => x.id), before);
    assert.equal(db.get("SELECT COUNT(*) n FROM drafts WHERE case_id=? AND status='STALE'", r.caseId).n, 0);
    assert.equal(db.get("SELECT COUNT(*) n FROM activities WHERE case_id=? AND type='return'", r.caseId).n, 0);
    assert.match(fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8'), /not_handed_off: '이미 에이전트가 맡고 있습니다/);
  });
});

describe('직접 답장', () => {
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ['LLM_MOCK_DELAY_MS', 'MAIL_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL']) delete process.env[k]; });

  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `rf-${n}`; const from = `rf${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }

  test('직접 답장은 실제로 발송된다 — 사람 템플릿, 환불 언급 허용, 자리표시는 막는다', async () => {
    const t = thread(); const r = await t.run('영수증 발급 방법 알려주세요');
    const out = await loop.humanReply(r.caseId, { by: '김담당', body: '환불은 확인 후 처리해 드리겠습니다.' });
    const m = db.get('SELECT * FROM messages WHERE id=?', out.messageId);
    assert.equal(m.sent_by, 'human'); assert.match(m.body, /ACME 김담당입니다/); assert.doesNotMatch(m.body, /AI 상담/);
    assert.equal(db.get('SELECT status FROM dispatches WHERE draft_id=?', out.draftId).status, 'SENT');
    await rejects(loop.humanReply(r.caseId, { by: '김담당', body: '[고객명] 님 확인 부탁드립니다' }), 422, 'guard');
  });
});
