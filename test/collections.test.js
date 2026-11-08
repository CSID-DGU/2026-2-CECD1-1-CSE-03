'use strict';
// CRM 컬렉션 — 수신 이벤트·지연 동기화(발송 경로 무간섭)·종결 뒤 회신 재오픈·보류/종결·활동·문의자/고객사·파기·재동기화·CRM API.
process.env.MAIL_MOCK_LOG = '0';
process.env.AUTO_SEND = '0';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const db = require('../server/db');
const llm = require('../server/llm');
const events = require('../server/events');
const cases = require('../server/cases');
const loop = require('../server/loop');
const store = require('../server/store');
const collections = require('../server/collections');
const sweeper = require('../server/sweeper');
const retention = require('../server/retention');
const accesslog = require('../server/accesslog');
const notify = require('../server/notify');
const { createServer, recover } = require('../server/index');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collections-'));
const ENV = ['AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'SHADOW_CHANNELS', 'NODE_ENV', 'FORM_SENDER_DOMAINS', 'INTERNAL_DOMAINS', 'LLM_MOCK_DELAY_MS', 'RETENTION_DAYS'];
before(() => { db.init(':memory:'); });
beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; });
after(() => { db.init(':memory:'); fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
/** 수신 한 건. 결과에 from을 붙여 같은 고객의 회신을 만들기 쉽게 한다. */
function add(o = {}) {
  n += 1;
  const from = o.from || `c${n}@example.com`;
  return { from, ...cases.addInbound({ channel: 'support', from, name: `고객${n}`, subject: `문의 ${n}`, body: '영수증 발급 부탁드립니다.', threadId: `co-${n}`, ...o }) };
}
const reply = (r, o = {}) => add({ from: r.from, threadId: r.threadId, ...o });
const run = async (o) => { const r = add(o); await loop.runCycle(r.caseId, r.messageId); return r; };
const pending = (caseId) => db.get("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", caseId);
const row = (caseId) => db.get('SELECT * FROM cases WHERE id=?', caseId);
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { if (fn()) return; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(5); } };
const doc = (c, id) => store.get(c, id)?.doc;
const rev = (id) => store.get('cases', id)?.revision;
const evOf = (messageId) => doc('inbound_events', db.get('SELECT event_id FROM messages WHERE id=?', messageId).event_id);
const snap = () => ({ ...db.get('SELECT COUNT(*) n, SUM(revision) r FROM documents') });
/** 지금 문서 = 처리 테이블에서 다시 계산한 값 — 강제 재계산이 아무것도 쓰지 않는다. */
const upToDate = (id) => { const s = snap(); db.tx(() => collections.syncCase(id)); return JSON.stringify(snap()) === JSON.stringify(s); };
/** console.error를 잠시 모은다(동기화 실패 로그). */
async function quiet(fn) {
  const orig = console.error; const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
}
const call = async (base, method, p, body) => {
  const res = await fetch(`${base}${p}`, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const post = (base, p, body) => call(base, 'POST', p, body);
const get = (base, p) => call(base, 'GET', p);

test('I1 수신 1건 = 이벤트 1건 — 같은 Message-ID 10번이면 1건, messages.event_id 연결, message.created 때 이벤트가 이미 있다', () => {
  const seen = [];
  const unsub = events.subscribe(({ name, data }) => {
    if (name === 'message.created' && data.direction === 'in') seen.push(!!evOf(data.messageId));
  });
  const before = store.all('inbound_events').length;
  let r;
  try {
    for (let i = 0; i < 10; i += 1) { const x = add({ from: 'i1@example.com', threadId: 'i1', providerMessageId: '<i1@example.com>' }); if (!x.duplicate) r = x; }
  } finally { unsub(); }
  assert.equal(store.all('inbound_events').length - before, 1);
  assert.deepEqual(seen, [true]);
  const e = evOf(r.messageId);
  assert.equal(e.id, db.get('SELECT event_id FROM messages WHERE id=?', r.messageId).event_id);
  assert.equal(e.dedupeKey, 'email:support:<i1@example.com>');
  assert.equal(store.find('inbound_events', { dedupeKey: e.dedupeKey }).length, 1);
  assert.equal(e.resolvedCaseId, r.caseId); assert.equal(e.sourceType, 'email_inbound'); assert.equal(e.matching.method, 'new_case');
  assert.equal(e.rawPayload.from, 'i1@example.com'); assert.equal(e.source.threadId, 'i1');
});

test('I2 이벤트 원문(rawPayload·occurredAt·dedupeKey·source)은 회차·발송·보류·종결 뒤에도 그대로', async () => {
  await withServer(async (base) => {
    const r = await run({ knownFacts: { 주문번호: 'A-100' } });
    const pick = (e) => JSON.stringify({ rawPayload: e.rawPayload, occurredAt: e.occurredAt, dedupeKey: e.dedupeKey, source: e.source });
    const before = pick(evOf(r.messageId));
    assert.match(evOf(r.messageId).rawPayload.body, /영수증/);
    assert.equal((await post(base, `/api/drafts/${pending(r.caseId).id}/approve`, { by: 'kim' })).status, 200);
    assert.equal((await post(base, `/api/cases/${r.caseId}/takeover`, { by: 'kim' })).status, 200);
    assert.equal((await post(base, `/api/cases/${r.caseId}/hold`, { by: 'kim', note: '확인 중' })).status, 200);
    assert.equal((await post(base, `/api/cases/${r.caseId}/close`, { by: 'kim', reason: 'resolved' })).status, 200);
    collections.flush();
    const e = evOf(r.messageId);
    assert.equal(pick(e), before);
    assert.equal(e.processing.status, 'succeeded'); assert.equal(e.parsed.intent, 'receipt');
    assert.ok(e.privacy.retentionUntil === null, 'RETENTION_DAYS 없음 → 보존 기한 없음');
  });
});

test('I3 발송 경로 무간섭 — 승인·L2 자동 발송·접수 안내·직접 답장의 finalizeSent 트랜잭션 안에서 documents SQL 0건, flush 뒤 반영 / 동기화가 던져도 승인은 성공, failures, 다음 flush가 맞춘다', async () => {
  // db.tx를 감싸 finalizeSent가 연 트랜잭션 동안 documents에 닿는 쓰기를 모은다
  const origTx = db.tx; const origRun = db.run; const origInsert = db.insert;
  let depth = 0; let entered = 0; const hits = [];
  db.tx = (fn) => { const f = /finalizeSent/.test(new Error().stack); if (f) { depth += 1; entered += 1; } try { return origTx(fn); } finally { if (f) depth -= 1; } };
  db.run = (sql, ...p) => { if (depth && /documents/i.test(sql)) hits.push(sql.slice(0, 60)); return origRun(sql, ...p); };
  db.insert = (t, ...p) => { if (depth && t === 'documents') hits.push(`insert ${t}`); return origInsert(t, ...p); };
  let a; let l2; let ack;
  try {
    a = await run();
    await loop.approveDraft(pending(a.caseId).id, { by: 'kim' }); // L1 승인
    process.env.AUTO_SEND = '1';
    l2 = await run({ body: '더 이상 서비스를 쓰지 않아서 계정을 탈퇴하고 싶습니다. 어떻게 하면 되나요?' }); // L2 자동 발송
    ack = await run({ body: '환불해 주세요' }); // 넘김 + 접수 안내
    await until(() => db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND sent_by='ack'", ack.caseId).n === 1);
    process.env.AUTO_SEND = '0';
    loop.takeover(a.caseId, { by: 'kim' });
    await loop.humanReply(a.caseId, { by: 'kim', body: '직접 답장 드립니다.' }); // 직접 답장
  } finally { db.tx = origTx; db.run = origRun; db.insert = origInsert; process.env.AUTO_SEND = '0'; }
  assert.deepEqual(hits, [], '발송 트랜잭션 안에서 documents 쓰기 없음');
  assert.ok(entered >= 4, `finalizeSent 트랜잭션 ${entered}번`);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out' AND sent_by='agent'", l2.caseId).n, 1);
  await tick(); collections.flush();
  assert.equal(doc('cases', l2.caseId).subStatus, 'Waiting on Customer');
  assert.equal(doc('cases', a.caseId).status, 'Escalated'); assert.equal(doc('cases', a.caseId).subStatus, 'Waiting on Customer');
  for (const r of [a, l2, ack]) assert.ok(upToDate(r.caseId));

  // 동기화가 던져도 승인·발송은 그대로 — 실패는 failures에 세고 그 케이스는 dirty에 남는다
  const b = await run();
  collections.flush();
  const f0 = collections.status().failures;
  const orig = store.put;
  store.put = () => { throw new Error('boom'); };
  let out;
  const logs = await quiet(async () => {
    try {
      out = await loop.approveDraft(pending(b.caseId).id, { by: 'kim' });
      await tick(); collections.flush();
    } finally { store.put = orig; }
  });
  assert.equal(db.get('SELECT status FROM dispatches WHERE id=?', out.dispatchId).status, 'SENT');
  assert.equal(row(b.caseId).state, 'WAITING_CUSTOMER');
  assert.ok(collections.status().failures > f0);
  assert.ok(collections.status().pending >= 1);
  assert.ok(logs.some((l) => l.startsWith('[collections] sync 실패') && !l.includes('@')), logs.join('\n'));
  assert.equal(doc('cases', b.caseId).subStatus, 'Awaiting Approval', '실패하는 동안 문서는 이전 값');
  collections.flush();
  assert.equal(doc('cases', b.caseId).subStatus, 'Waiting on Customer');
  assert.equal(collections.status().pending, 0);
  assert.ok(upToDate(b.caseId));
});

test('I4 dirty 표시 경로 — 인수·종결·반환·자동 종결(no_response)·재시작 복구(send_unconfirmed) 뒤 문서 = 다시 계산한 값', async () => {
  await withServer(async (base) => {
    const a = await run();
    assert.equal((await post(base, `/api/cases/${a.caseId}/takeover`, { by: 'kim' })).status, 200);
    await tick();
    assert.equal(doc('cases', a.caseId).status, 'Escalated'); assert.deepEqual(doc('cases', a.caseId).owner, { type: 'user', id: 'kim' });
    assert.ok(upToDate(a.caseId));
    assert.equal((await post(base, `/api/cases/${a.caseId}/close`, { by: 'kim', reason: 'duplicate' })).status, 200);
    await tick();
    assert.equal(doc('cases', a.caseId).status, 'Closed'); assert.equal(doc('cases', a.caseId).closeReason, 'duplicate');
    assert.ok(upToDate(a.caseId));

    // 반환 — 넘긴 케이스에 고객이 다른 질문을 더함 → 반환하면 그 메시지로 회차가 돈다
    const b = await run({ body: '환불해 주세요' });
    const b2 = reply(b, { body: '그럼 영수증이라도 발급해 주세요' });
    await loop.runCycle(b2.caseId, b2.messageId);
    assert.equal((await post(base, `/api/cases/${b.caseId}/return`, { by: 'kim' })).status, 200);
    await until(() => !loop.status().activeCases.includes(b.caseId));
    await tick();
    assert.equal(doc('cases', b.caseId).status, 'Working'); assert.equal(doc('cases', b.caseId).subStatus, 'Awaiting Approval');
    assert.ok(upToDate(b.caseId));
  });

  // 자동 종결 — 활동 기록이 상태 변경(emit) 뒤에 온다
  const c = await run();
  await loop.approveDraft(pending(c.caseId).id, { by: 'kim' });
  await tick();
  assert.ok(sweeper.autoClose(Date.now() + 31 * 86_400_000) >= 1);
  await tick();
  assert.equal(doc('cases', c.caseId).status, 'Closed'); assert.equal(doc('cases', c.caseId).closeReason, 'no_response');
  assert.ok(upToDate(c.caseId));

  // 재시작 복구 — 발송 확인 필요 표시는 emit이 없다
  const d = await run();
  const dr = pending(d.caseId);
  db.run("UPDATE drafts SET status='SENDING', approved_at=?, approved_by='kim' WHERE id=?", new Date(Date.now() - 600_000).toISOString(), dr.id);
  collections.flush();
  await recover();
  await tick();
  assert.ok(store.find('activities', { caseId: d.caseId }).some((x) => x.subtype === 'send_unconfirmed'));
  assert.ok(upToDate(d.caseId));
  db.run("UPDATE drafts SET status='NOT_SELECTED' WHERE id=?", dr.id);
  collections.markDirty(d.caseId);
});

test('I5 재오픈 — 종결 뒤 회신은 같은 케이스를 다시 연다: 에이전트 답변 케이스는 다시 답(Working), 사람 전담은 사람 담당 그대로(Escalated·발신 0), 반환 안 된 넘김이 있으면 답장+넘김 초안(L2여도 자동 발송 없음)', async () => {
  const outs = (id) => db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", id).n;
  const casesOf = (from) => db.get('SELECT COUNT(*) n FROM cases WHERE customer_email=?', from).n;

  // 에이전트가 답하고 종결 → 새 질문은 같은 케이스에서 다시 답한다
  const a = await run({ subject: '영수증 문의', name: '홍길동' });
  await loop.approveDraft(pending(a.caseId).id, { by: 'kim' });
  loop.closeCase(a.caseId, { by: 'kim' });
  collections.flush();
  const b = reply(a, { subject: 'Re: 영수증 문의', name: undefined, body: '구독 해지는 어떻게 하나요?' });
  assert.equal(b.caseId, a.caseId); assert.equal(b.created, false); assert.equal(b.reopened, true);
  assert.equal(casesOf(a.from), 1);
  let c = row(a.caseId);
  assert.equal(c.state, 'OPEN'); assert.equal(c.closed_at, null); assert.equal(c.close_reason, null); assert.equal(c.responder, 'agent'); assert.equal(c.related_case_id, null);
  await loop.runCycle(b.caseId, b.messageId);
  assert.equal(pending(a.caseId).action, 'DRAFT');
  collections.flush();
  let d = doc('cases', a.caseId);
  assert.deepEqual([d.status, d.subStatus, d.closeReason, d.relatedCaseId], ['Working', 'Awaiting Approval', null, null]);
  assert.ok(d.statusHistory.some((h) => h.toStatus === 'Closed'), '종결 이력은 남는다');
  await loop.approveDraft(pending(a.caseId).id, { by: 'kim' });
  assert.equal(outs(a.caseId), 2);
  assert.equal(db.get("SELECT subject FROM messages WHERE case_id=? AND direction='out' ORDER BY rowid DESC LIMIT 1", a.caseId).subject, 'Re: 영수증 문의');
  collections.flush();
  d = doc('cases', a.caseId);
  assert.deepEqual([d.status, d.subStatus], ['Working', 'Waiting on Customer']);
  const e = evOf(b.messageId);
  assert.deepEqual([e.matching.method, e.matching.status, e.matching.reasonCode], ['thread', 'resolved', 'reopened_by_reply']);
  assert.equal(evOf(a.messageId).matching.reasonCode, null);
  assert.ok(upToDate(a.caseId));

  // 사람 전담으로 종결 → 회신은 사람 담당 그대로(초안·발신 없음), L2 질문이어도 자동 발송 없음
  const h = await run();
  loop.takeover(h.caseId, { by: 'kim' });
  loop.closeCase(h.caseId, { by: 'kim' });
  const drafts0 = db.get('SELECT COUNT(*) n FROM drafts WHERE case_id=?', h.caseId).n;
  process.env.AUTO_SEND = '1';
  try {
    const h2 = reply(h, { body: '영수증 하나 더 부탁드립니다.' });
    assert.equal(h2.caseId, h.caseId); assert.equal(h2.reopened, true);
    assert.deepEqual(await loop.runCycle(h2.caseId, h2.messageId), { action: 'IGNORE', reason: 'responder_human' });
  } finally { process.env.AUTO_SEND = '0'; }
  c = row(h.caseId);
  assert.deepEqual([c.state, c.responder, c.assignee], ['HANDED_OFF', 'human', 'kim']);
  assert.equal(db.get('SELECT COUNT(*) n FROM drafts WHERE case_id=?', h.caseId).n, drafts0);
  assert.equal(outs(h.caseId), 0);
  assert.equal(casesOf(h.from), 1);
  collections.flush();
  assert.equal(doc('cases', h.caseId).status, 'Escalated');

  // 답장+넘김 초안에서 종결 — 넘김 행은 열린 채(응대 주체는 에이전트) → 회신의 L2 답도 답장+넘김(승인 대기), 자동 발송 없음
  const s = await run({ channel: 'sales', body: '예산 500만 원이면 어디까지 가능한가요? 견적 부탁드립니다.' });
  assert.equal(pending(s.caseId).action, 'ANSWER_AND_HANDOFF');
  assert.equal(row(s.caseId).responder, 'agent');
  loop.closeCase(s.caseId, { by: 'kim' });
  assert.ok(db.get('SELECT 1 FROM handoffs WHERE case_id=? AND returned_at IS NULL', s.caseId));
  process.env.AUTO_SEND = '1';
  let out;
  try {
    const s2 = reply(s, { channel: 'sales', body: '서비스 진행 방식이 궁금합니다.' });
    assert.equal(s2.caseId, s.caseId); assert.equal(s2.reopened, true);
    out = await loop.runCycle(s2.caseId, s2.messageId);
  } finally { process.env.AUTO_SEND = '0'; }
  assert.equal(db.get("SELECT intent FROM drafts WHERE case_id=? AND status='PENDING'", s.caseId).intent, 'service_question', 'L2 intent');
  assert.equal(out.action, 'ANSWER_AND_HANDOFF'); assert.equal(out.autoSend, undefined);
  assert.equal(pending(s.caseId).action, 'ANSWER_AND_HANDOFF');
  assert.equal(outs(s.caseId), 0);
  assert.equal(row(s.caseId).state, 'AWAITING_APPROVAL');
  assert.equal(db.get('SELECT COUNT(*) n FROM cases WHERE related_case_id IS NOT NULL').n, 0, '연결 케이스를 만들지 않는다');
});

test('I6 IMAP식 재오픈 — 스레드 id 없이 References만 온 회신도 같은 케이스(in_reply_to), 두 번째도 같은 케이스 / 파기된 케이스 회신은 무관한 새 케이스', async () => {
  const a = await run({ providerMessageId: '<i6-a@example.com>' });
  loop.closeCase(a.caseId, { by: 'kim' });
  const r1 = add({ from: a.from, threadId: undefined, references: '<i6-a@example.com>', providerMessageId: '<i6-r1@example.com>', body: '다시 문의드립니다' });
  assert.equal(r1.caseId, a.caseId); assert.equal(r1.created, false); assert.equal(r1.reopened, true);
  assert.equal(r1.threadId, a.threadId);
  assert.equal(row(a.caseId).state, 'OPEN');
  loop.closeCase(a.caseId, { by: 'kim' });
  const r2 = add({ from: a.from, threadId: undefined, references: '<i6-r1@example.com>', providerMessageId: '<i6-r2@example.com>', body: '한 번 더요' });
  assert.equal(r2.caseId, a.caseId); assert.equal(r2.reopened, true);
  assert.equal(db.get('SELECT COUNT(*) n FROM cases WHERE customer_email=?', a.from).n, 1);
  collections.flush();
  assert.deepEqual([evOf(r1.messageId).matching.method, evOf(r1.messageId).matching.reasonCode], ['in_reply_to', 'reopened_by_reply']);
  assert.deepEqual([evOf(r2.messageId).matching.method, evOf(r2.messageId).matching.reasonCode], ['in_reply_to', 'reopened_by_reply']);

  // 파기된 케이스에 온 회신 — 스레드 매핑이 지워져 무관한 새 케이스
  const p = await run();
  loop.closeCase(p.caseId, { by: 'kim' });
  assert.equal(retention.purge(p.caseId, { reason: 'test', actor: 'kim' }), true);
  const q = reply(p, { body: '다시 문의합니다' });
  assert.equal(q.created, true); assert.notEqual(q.caseId, p.caseId); assert.equal(q.reopened, undefined);
  assert.equal(row(q.caseId).related_case_id, null);
  assert.equal(row(p.caseId).state, 'CLOSED');
  collections.flush();
  assert.deepEqual([evOf(q.messageId).matching.method, evOf(q.messageId).matching.reasonCode], ['new_case', null]);
});

test('I7 감사 인사 회신 — 종결 케이스에 붙고(같은 케이스·새 케이스 없음), 답하지 않고, 다시 Closed(closeReason resolved)', async () => {
  const a = await run({ subject: '영수증 문의' });
  await loop.approveDraft(pending(a.caseId).id, { by: 'kim' });
  loop.closeCase(a.caseId, { by: 'kim' });
  collections.flush();
  const closedRev = rev(a.caseId);
  await withServer(async (base) => {
    const r = await post(base, '/api/test/inbound', { channel: 'support', from: a.from, threadId: a.threadId, subject: 'Re: 영수증 문의', body: '감사합니다. 잘 받았습니다.' });
    assert.equal(r.status, 200);
    assert.equal(r.body.caseId, a.caseId); assert.equal(r.body.created, false);
    await until(() => db.get("SELECT 1 FROM activities WHERE case_id=? AND type='auto_close'", a.caseId));
  });
  const c = row(a.caseId);
  assert.equal(c.state, 'CLOSED'); assert.ok(c.closed_at);
  assert.deepEqual(JSON.parse(db.get("SELECT payload FROM activities WHERE case_id=? AND type='auto_close'", a.caseId).payload), { reason: 'courtesy_reply' });
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='in'", a.caseId).n, 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", a.caseId).n, 1, '답하지 않는다');
  assert.equal(db.get("SELECT COUNT(*) n FROM drafts WHERE case_id=? AND status IN ('PENDING','SENDING')", a.caseId).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM cases WHERE customer_email=?', a.from).n, 1);
  collections.flush();
  const d = doc('cases', a.caseId);
  assert.deepEqual([d.status, d.closeReason], ['Closed', 'resolved']);
  assert.ok(rev(a.caseId) > closedRev);
  const closedAt = d.statusHistory.findIndex((h) => h.toStatus === 'Closed');
  assert.ok(closedAt >= 0 && d.statusHistory.slice(closedAt + 1, -1).some((h) => h.toStatus !== 'Closed'), '다시 열렸다가');
  assert.equal(d.statusHistory.at(-1).toStatus, 'Closed', '다시 닫힌다');
  const e = evOf(db.get("SELECT id FROM messages WHERE case_id=? AND direction='in' ORDER BY rowid DESC LIMIT 1", a.caseId).id);
  assert.deepEqual([e.matching.method, e.matching.reasonCode], ['thread', 'reopened_by_reply']);
  assert.ok(upToDate(a.caseId));
});

test('I8 보류 — 사람 전담만(에이전트는 409 not_escalated), On Hold는 고객 회신·직접 답장 뒤에도 유지, unhold로 해제, 중복 409, 메모 가림', async () => {
  await withServer(async (base) => {
    const a = await run();
    let r = await post(base, `/api/cases/${a.caseId}/hold`, { by: 'kim', note: '확인 중' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'not_escalated');
    await post(base, `/api/cases/${a.caseId}/takeover`, { by: 'kim' });
    r = await post(base, `/api/cases/${a.caseId}/hold`, { by: 'kim', note: '  ' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'note 필요');
    r = await post(base, `/api/cases/${a.caseId}/hold`, { by: 'kim', note: '고객 회신 대기 — hold-pii@example.com, 010-1234-5678' });
    assert.equal(r.status, 200); assert.deepEqual(r.body, { caseId: a.caseId, held: true });
    r = await post(base, `/api/cases/${a.caseId}/hold`, { by: 'kim', note: '또' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'already_held');
    collections.flush();
    let d = doc('cases', a.caseId);
    assert.equal(d.status, 'On Hold'); assert.equal(d.subStatus, null);
    assert.ok(!d.hold.note.includes('hold-pii@example.com') && !d.hold.note.includes('010-1234-5678'), d.hold.note);
    assert.ok(!row(a.caseId).hold_note.includes('hold-pii'));
    assert.ok(store.find('activities', { caseId: a.caseId }).some((x) => x.subtype === 'hold' && !x.body.includes('hold-pii')));

    const b = reply(a, { body: '아직인가요?' });
    assert.equal(b.caseId, a.caseId);
    await loop.runCycle(b.caseId, b.messageId);
    assert.equal((await post(base, `/api/cases/${a.caseId}/human-reply`, { by: 'kim', body: '확인 중입니다. 조금만 기다려 주세요.' })).status, 200);
    collections.flush();
    assert.equal(doc('cases', a.caseId).status, 'On Hold');
    assert.ok(row(a.caseId).held_at);

    r = await post(base, `/api/cases/${a.caseId}/unhold`, { by: 'kim' });
    assert.equal(r.status, 200); assert.deepEqual(r.body, { caseId: a.caseId, held: false });
    r = await post(base, `/api/cases/${a.caseId}/unhold`, { by: 'kim' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'not_held');
    collections.flush();
    d = doc('cases', a.caseId);
    assert.equal(d.status, 'Escalated'); assert.equal(d.subStatus, 'Waiting on Customer'); assert.equal(d.hold, null);
  });
});

test('I9 보류 해제 경로 — 반환 성공이면 해제(재넘김이면 Escalated), 반환 409면 복원, 종결이 해제, 자동 종결은 보류 중 제외', async () => {
  await withServer(async (base) => {
    const a = await run({ body: '환불해 주세요' });
    assert.equal(row(a.caseId).responder, 'human');
    assert.equal((await post(base, `/api/cases/${a.caseId}/hold`, { by: 'kim', note: '환불 검토' })).status, 200);
    assert.equal((await post(base, `/api/cases/${a.caseId}/return`, { by: 'kim' })).status, 200);
    assert.equal(row(a.caseId).held_at, null); assert.equal(row(a.caseId).hold_note, null);
    collections.flush();
    assert.equal(doc('cases', a.caseId).status, 'Escalated', '같은 메시지가 다시 넘김');
    assert.equal(doc('cases', a.caseId).hold, null);

    // 반환이 거절되면(회차가 그 메시지를 도는 중 → 409 busy) 보류를 되돌린다
    process.env.LLM_MOCK_DELAY_MS = '300';
    const b = add();
    const cyc = loop.runCycle(b.caseId, b.messageId);
    await until(() => loop.status().activeCases.includes(b.caseId));
    assert.equal((await post(base, `/api/cases/${b.caseId}/takeover`, { by: 'kim' })).status, 200);
    assert.equal((await post(base, `/api/cases/${b.caseId}/hold`, { by: 'kim', note: '보류' })).status, 200);
    const held = row(b.caseId);
    const r = await post(base, `/api/cases/${b.caseId}/return`, { by: 'kim' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'busy');
    assert.equal(row(b.caseId).held_at, held.held_at); assert.equal(row(b.caseId).hold_note, held.hold_note);
    delete process.env.LLM_MOCK_DELAY_MS;
    await cyc;
    collections.flush();
    assert.equal(doc('cases', b.caseId).status, 'On Hold');

    // 종결이 보류를 푼다
    assert.equal((await post(base, `/api/cases/${b.caseId}/close`, { by: 'kim', reason: 'resolved' })).status, 200);
    assert.equal(row(b.caseId).held_at, null); assert.equal(row(b.caseId).hold_note, null);

    // 자동 종결은 보류 중인 케이스를 닫지 않는다
    const c = await run();
    await post(base, `/api/cases/${c.caseId}/takeover`, { by: 'kim' });
    await post(base, `/api/cases/${c.caseId}/hold`, { by: 'kim', note: '고객 일정 대기' });
    sweeper.autoClose(Date.now() + 40 * 86_400_000);
    assert.notEqual(row(c.caseId).state, 'CLOSED');
    await post(base, `/api/cases/${c.caseId}/unhold`, { by: 'kim' });
    sweeper.autoClose(Date.now() + 40 * 86_400_000);
    assert.equal(row(c.caseId).state, 'CLOSED');
  });
});

test('I10 종결 — 사유 검사(400), closeReason·closeDetail 기록, 종결 케이스 409, 발송 중 409(사유 미기록·보류 유지), /reopen 404, 재시도 예약을 지워 스위퍼가 되살리지 않는다', async () => {
  await withServer(async (base) => {
    const a = await run();
    const close = (id, b) => post(base, `/api/cases/${id}/close`, { by: 'kim', ...b });
    let r = await close(a.caseId, {});
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_reason');
    r = await close(a.caseId, { reason: 'later' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_reason');
    r = await close(a.caseId, { reason: 'other', detail: ' ' });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'detail 필요');
    r = await close(a.caseId, { reason: 'other', detail: '다른 채널에서 처리 — close-pii@example.com' });
    assert.equal(r.status, 200); assert.deepEqual(r.body, { caseId: a.caseId, state: 'CLOSED', closeReason: 'other' });
    assert.equal(row(a.caseId).close_reason, 'other'); assert.ok(!row(a.caseId).close_detail.includes('close-pii'));
    collections.flush();
    assert.equal(doc('cases', a.caseId).closeReason, 'other'); assert.match(doc('cases', a.caseId).closeDetail, /다른 채널/);
    r = await close(a.caseId, { reason: 'resolved' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'already_closed');
    assert.equal(row(a.caseId).close_reason, 'other');
    r = await post(base, `/api/cases/${a.caseId}/reopen`, { by: 'kim' });
    assert.equal(r.status, 404);

    // 발송 중이면 409 — 사유는 남지 않고 보류도 그대로(한 트랜잭션)
    const b = await run();
    await post(base, `/api/cases/${b.caseId}/takeover`, { by: 'kim' });
    await post(base, `/api/cases/${b.caseId}/hold`, { by: 'kim', note: '보류' });
    const dr = db.get('SELECT id FROM drafts WHERE case_id=?', b.caseId);
    db.run("UPDATE drafts SET status='SENDING' WHERE id=?", dr.id);
    r = await close(b.caseId, { reason: 'resolved' });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'sending');
    assert.equal(row(b.caseId).close_reason, null); assert.ok(row(b.caseId).held_at); assert.notEqual(row(b.caseId).state, 'CLOSED');
    db.run("UPDATE drafts SET status='NOT_SELECTED' WHERE id=?", dr.id);

    // LLM 장애 재시도 예약 뒤 종결 → 스위퍼가 회차를 다시 돌려 케이스를 열지 않는다
    llm.use({ name: 'flaky', json: async () => { throw new Error('upstream 503'); } });
    const c = add();
    assert.equal((await loop.runCycle(c.caseId, c.messageId)).action, 'RETRY');
    llm.use('mock');
    assert.ok(db.get('SELECT next_retry_at FROM loops WHERE case_id=?', c.caseId).next_retry_at);
    assert.equal((await close(c.caseId, { reason: 'spam' })).status, 200);
    const lp = db.get('SELECT * FROM loops WHERE case_id=?', c.caseId);
    assert.equal(lp.next_retry_at, null); assert.equal(lp.retry_message_id, null); assert.equal(lp.queue, '[]');
    assert.equal(db.get('SELECT COUNT(*) n FROM claims WHERE key LIKE ?', `loop:${c.caseId}:%`).n, 0);
    const decided = db.get('SELECT COUNT(*) n FROM decisions WHERE case_id=?', c.caseId).n;
    await sweeper.tick(Date.now() + 3_600_000);
    assert.equal(row(c.caseId).state, 'CLOSED');
    assert.equal(db.get('SELECT COUNT(*) n FROM decisions WHERE case_id=?', c.caseId).n, decided);
    collections.flush();
    assert.equal(doc('cases', c.caseId).closeReason, 'spam');
  });
});

test('I11 expectedRevision이 지금 문서와 다르면 409 stale(hold·unhold·close) — 응답에 지금 revision', async () => {
  await withServer(async (base) => {
    const a = await run();
    await post(base, `/api/cases/${a.caseId}/takeover`, { by: 'kim' });
    collections.flush();
    let cur = rev(a.caseId);
    let r = await post(base, `/api/cases/${a.caseId}/hold`, { by: 'kim', note: '보류', expectedRevision: cur - 1 });
    assert.equal(r.status, 409); assert.deepEqual(r.body, { error: 'stale', revision: cur });
    assert.equal(row(a.caseId).held_at, null);
    r = await post(base, `/api/cases/${a.caseId}/hold`, { by: 'kim', note: '보류', expectedRevision: cur });
    assert.equal(r.status, 200);
    collections.flush();
    r = await post(base, `/api/cases/${a.caseId}/unhold`, { by: 'kim', expectedRevision: cur });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'stale'); assert.equal(r.body.revision, rev(a.caseId));
    assert.ok(row(a.caseId).held_at);
    cur = rev(a.caseId);
    assert.equal((await post(base, `/api/cases/${a.caseId}/unhold`, { by: 'kim', expectedRevision: cur })).status, 200);
    r = await post(base, `/api/cases/${a.caseId}/close`, { by: 'kim', reason: 'resolved', expectedRevision: cur });
    assert.equal(r.status, 409); assert.equal(r.body.error, 'stale');
    assert.notEqual(row(a.caseId).state, 'CLOSED'); assert.equal(row(a.caseId).close_reason, null);
    r = await post(base, `/api/cases/${a.caseId}/close`, { by: 'kim', reason: 'resolved', expectedRevision: r.body.revision });
    assert.equal(r.status, 200);
  });
});

test('I12 활동 — 수신은 body null + inboundEventId, 발신은 본문, id = dedupeKey, 판단 트레이스 없음, 요약에 본문·메모 없음, resyncAll 반복은 아무것도 안 바꾼다', async () => {
  const NOTE = '내부 메모 — 다음 주 재확인';
  const a = await run();
  await loop.approveDraft(pending(a.caseId).id, { by: 'kim' });
  loop.addNote(a.caseId, { by: 'kim', text: NOTE });
  collections.markDirty(a.caseId); collections.flush();
  const acts = store.find('activities', { caseId: a.caseId });
  const inb = acts.filter((x) => x.direction === 'inbound');
  assert.equal(inb.length, 1);
  assert.equal(inb[0].body, null); assert.equal(inb[0].inboundEventId, evOf(a.messageId).id); assert.equal(inb[0].id, `msg:${a.messageId}`);
  const outb = acts.find((x) => x.direction === 'outbound');
  assert.equal(outb.subtype, 'agent_reply'); assert.match(outb.body, /영수증/);
  assert.equal(acts.find((x) => x.type === 'note').body, NOTE);
  assert.ok(acts.every((x) => x.id === x.dedupeKey));
  assert.ok(acts.every((x) => /^(msg|act|handoff):/.test(x.id)), '판단(decisions)은 활동이 아니다');
  assert.ok(acts.every((x) => !x.summary.includes(NOTE) && !/영수증/.test(x.summary)));
  collections.resyncAll();
  const s0 = snap();
  collections.resyncAll(); collections.resyncAll();
  assert.deepEqual(snap(), s0);
  assert.equal(store.find('activities', { caseId: a.caseId }).length, acts.length);
});

test('I13 문의자·고객사 — 같은 주소 = 같은 문의자, 공용 도메인은 고객사 없음, 업무 도메인 고객사 1개, 폼·사내 도메인·못 뽑은 폼 주소·빈 주소는 만들지 않는다', () => {
  process.env.FORM_SENDER_DOMAINS = 'forms.example.net';
  process.env.INTERNAL_DOMAINS = 'staff.example.org';
  const a1 = add({ from: 'Kim <kim@biz-one.example.com>' });
  const a2 = add({ from: 'KIM@biz-one.example.com' });
  const g = add({ from: 'lee@gmail.com' });
  const f = add({ from: 'noreply@forms.example.net', subject: '문의 접수', body: '이름: 박고객\n이메일: park@biz-two.example.com\n내용: 견적 문의', knownFacts: { 회사: '둘째 상사' } });
  const fu = add({ from: 'noreply@forms.example.net', subject: '문의 접수', body: '이름: 무명\n내용: 주소를 안 적었습니다' });
  const s = add({ from: 'ops@staff.example.org' });
  const z = add({ from: ' ' });
  collections.flush();
  const D = (r) => doc('cases', r.caseId);
  assert.ok(D(a1).contactId); assert.equal(D(a2).contactId, D(a1).contactId);
  assert.equal(store.find('contacts', { primaryEmail: 'kim@biz-one.example.com' }).length, 1);
  assert.ok(D(a1).companyId); assert.equal(D(a2).companyId, D(a1).companyId);
  assert.equal(store.find('companies', { primaryDomain: 'biz-one.example.com' }).length, 1);
  assert.equal(doc('contacts', D(a1).contactId).companyId, D(a1).companyId);
  assert.ok(D(g).contactId); assert.equal(D(g).companyId, null);
  assert.equal(store.find('companies', { primaryDomain: 'gmail.com' }).length, 0);
  // 폼 메일 — 뽑은 고객 주소로 문의자·고객사(폼 도메인 고객사는 없다), origin Web
  assert.equal(doc('contacts', D(f).contactId).primaryEmail, 'park@biz-two.example.com');
  assert.equal(doc('companies', D(f).companyId).primaryDomain, 'biz-two.example.com');
  assert.equal(doc('companies', D(f).companyId).canonicalName, '둘째 상사');
  assert.equal(D(f).origin, 'Web'); assert.equal(evOf(f.messageId).sourceType, 'customer_support_form');
  assert.equal(store.find('companies', { primaryDomain: 'forms.example.net' }).length, 0);
  // 고객 주소를 못 뽑은 폼 메일 — 케이스 주소가 폼 주소 그대로라 문의자를 만들지도 잇지도 않는다
  assert.equal(row(fu.caseId).customer_email, 'noreply@forms.example.net');
  assert.equal(D(fu).contactId, null); assert.equal(D(fu).companyId, null);
  assert.equal(store.find('contacts', { primaryEmail: 'noreply@forms.example.net' }).length, 0);
  assert.equal(evOf(fu.messageId).resolvedContactId, null);
  // 사내 도메인 — 문의자는 있고 고객사는 없다
  assert.ok(D(s).contactId); assert.equal(D(s).companyId, null);
  assert.equal(store.find('companies', { primaryDomain: 'staff.example.org' }).length, 0);
  // 빈 주소
  assert.equal(row(z.caseId).customer_email, '');
  assert.equal(D(z).contactId, null);
  assert.equal(store.find('contacts', { primaryEmail: '' }).length, 0);
});

test('I14 파기 — 문서 JSON 전체에 원문·주소·이름·Message-ID 없음, anonymized, 문의자 primaryEmail null(둘이어도 충돌 없음), 파기 뒤 flush는 쓰지 않음, 동기화가 던져도 파기는 끝난다', async () => {
  const MARK = 'QZVMARK';
  const docsText = () => JSON.stringify(store.COLLECTIONS.map((c) => store.all(c))).toLowerCase();
  const ids = []; const dedupe = {};
  await withServer(async (base) => {
    for (const [i, email] of ['qzvmark@biz-three.example.com', 'qzvmark2@example.com'].entries()) {
      const r = await run({ from: `"${MARK}" <${email}>`, name: MARK, subject: `${MARK} 문의`, body: `영수증 발급 부탁드립니다. ${MARK}`, knownFacts: { 회사: `${MARK} 상사`, 주문번호: `${MARK}-${i}` }, providerMessageId: `<i14-mid-${i}@mail-host.example.com>` });
      await post(base, `/api/drafts/${pending(r.caseId).id}/approve`, { by: 'kim' });
      await post(base, `/api/cases/${r.caseId}/note`, { by: 'kim', text: `${MARK} 메모` });
      await post(base, `/api/cases/${r.caseId}/takeover`, { by: 'kim' });
      await post(base, `/api/cases/${r.caseId}/hold`, { by: 'kim', note: `${MARK} 보류` });
      assert.equal((await post(base, `/api/cases/${r.caseId}/close`, { by: 'kim', reason: 'other', detail: `${MARK} 상세` })).status, 200);
      ids.push(r.caseId); dedupe[r.caseId] = evOf(r.messageId).dedupeKey;
    }
  });
  collections.flush();
  assert.ok(docsText().includes(MARK.toLowerCase())); assert.ok(docsText().includes('i14-mid-'));
  assert.ok(doc('companies', doc('cases', ids[0]).companyId).canonicalName.includes(MARK));
  const contactIds = ids.map((id) => doc('cases', id).contactId);
  for (const id of ids) assert.equal(retention.purge(id, { reason: 'test', actor: 'kim' }), true);

  assert.ok(!docsText().includes(MARK.toLowerCase()), '원문·이름·주소·메모·상세가 문서에 남지 않는다');
  assert.ok(!docsText().includes('i14-mid-') && !docsText().includes('mail-host.example.com'), 'Message-ID가 문서에 남지 않는다');
  for (const id of ids) {
    const d = doc('cases', id);
    assert.equal(d.lifecycleStatus, 'anonymized'); assert.equal(d.subject, null); assert.equal(d.suppliedEmail, null); assert.equal(d.closeDetail, null);
    const c = row(id); assert.equal(c.close_detail, null); assert.equal(c.hold_note, null);
    const evs = store.find('inbound_events', { resolvedCaseId: id });
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.lifecycleStatus, 'anonymized'); assert.match(e.dedupeKey, /^email:support:[0-9a-f]{32}$/); assert.notEqual(e.dedupeKey, dedupe[id]);
    assert.ok(Object.keys(e.rawPayload).length > 5 && Object.values(e.rawPayload).every((v) => v === null), JSON.stringify(e.rawPayload));
    assert.equal(e.parsed.email, null); assert.equal(e.parsed.name, null); assert.equal(e.source.threadId, null); assert.equal(e.source.providerObjectId, null);
    assert.ok(store.find('activities', { caseId: id }).every((x) => x.lifecycleStatus === 'anonymized'));
  }
  for (const cid of contactIds) { const p = doc('contacts', cid); assert.equal(p.primaryEmail, null); assert.equal(p.lifecycleStatus, 'anonymized'); }
  assert.equal(doc('companies', doc('cases', ids[0]).companyId).canonicalName, null, '폼 값에서 온 고객사 이름은 비운다');
  // 파기 뒤 flush는 같은 결과 — 아무것도 쓰지 않는다
  const s0 = snap();
  for (const id of ids) collections.markDirty(id);
  collections.flush();
  assert.deepEqual(snap(), s0);

  // 파기 트랜잭션 안 동기화가 던져도 파기는 끝난다 — 케이스·활동 문서는 지우고 이벤트 원문은 비운다, 다음 flush가 다시 계산
  const p = await run({ subject: `${MARK} 셋째`, body: `로그인이 안 돼요 ${MARK}` });
  loop.closeCase(p.caseId, { by: 'kim' });
  collections.markDirty(p.caseId); collections.flush();
  const f0 = collections.status().failures;
  const orig = store.put;
  store.put = (c, d) => { if (c === 'cases') throw new Error('boom'); return orig(c, d); };
  let ok;
  const logs = await quiet(() => { try { ok = retention.purge(p.caseId, { reason: 'test', actor: 'kim' }); } finally { store.put = orig; } });
  assert.equal(ok, true);
  assert.ok(row(p.caseId).purged_at);
  assert.equal(collections.status().failures, f0 + 1);
  assert.ok(logs.some((l) => l.startsWith('[collections] 파기 동기화 실패')), logs.join('\n'));
  assert.equal(store.get('cases', p.caseId), null);
  assert.equal(store.find('activities', { caseId: p.caseId }).length, 0);
  const pe = evOf(p.messageId);
  assert.equal(pe.lifecycleStatus, 'anonymized'); assert.ok(Object.values(pe.rawPayload).every((v) => v === null));
  assert.ok(!docsText().includes(MARK.toLowerCase()));
  await tick();
  assert.equal(doc('cases', p.caseId).lifecycleStatus, 'anonymized');
  assert.ok(store.find('activities', { caseId: p.caseId }).length > 0);
});

test('I15 resyncAll — 문서 없는 처리 데이터에서 문서를 만든다(파기된 케이스 이벤트는 비운 채, provider id 없으면 msg:<id>), 두 번째는 revision·caseNumber 그대로, 케이스 하나가 던져도 기동을 막지 않는다', async () => {
  const a = await run();
  const a2 = reply(a, { body: '추가 질문입니다' });
  await loop.runCycle(a2.caseId, a2.messageId);
  const p = await run();
  const p2 = reply(p, { body: '하나 더요' });
  loop.closeCase(p.caseId, { by: 'kim' });
  assert.equal(retention.purge(p.caseId, { reason: 'test', actor: 'kim' }), true);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='in' AND provider_message_id IS NULL", p.caseId).n, 2);
  collections.flush();
  const num = { [a.caseId]: doc('cases', a.caseId).caseNumber, [p.caseId]: doc('cases', p.caseId).caseNumber };
  // 예전 DB 흉내 — 이 두 케이스의 문서를 지우고 메시지의 이벤트 연결을 끊는다
  for (const id of [a.caseId, p.caseId]) {
    for (const e of store.find('inbound_events', { resolvedCaseId: id })) store.remove('inbound_events', e.id);
    for (const x of store.find('activities', { caseId: id })) store.remove('activities', x.id);
    store.remove('cases', id);
    db.run('UPDATE messages SET event_id=NULL WHERE case_id=?', id);
  }
  const f0 = collections.status().failures;
  const out = collections.resyncAll();
  assert.equal(out.events, 4);
  assert.equal(collections.status().failures, f0);
  for (const id of [a.caseId, p.caseId]) {
    assert.equal(doc('cases', id).caseNumber, num[id]);
    assert.equal(store.find('inbound_events', { resolvedCaseId: id }).length, 2);
    assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='in' AND event_id IS NULL", id).n, 0);
  }
  assert.equal(doc('cases', a.caseId).attribution.caseCreationEventId, evOf(a.messageId).id);
  assert.equal(evOf(a2.messageId).matching.method, 'thread');
  for (const m of [p, p2]) {
    const e = evOf(m.messageId);
    assert.equal(e.dedupeKey, `email:support:msg:${m.messageId}`);
    assert.equal(e.lifecycleStatus, 'anonymized'); assert.ok(Object.values(e.rawPayload).every((v) => v === null));
  }
  assert.equal(doc('cases', p.caseId).lifecycleStatus, 'anonymized');
  const s0 = snap();
  assert.equal(collections.resyncAll().events, 0);
  assert.deepEqual(snap(), s0);
  assert.equal(doc('cases', a.caseId).caseNumber, num[a.caseId]);

  // 케이스 하나의 동기화가 던져도 나머지는 끝나고 failures에 센다 — 그 케이스는 dirty에 남아 다음 flush가 맞춘다
  const o = add();
  collections.flush();
  db.run('UPDATE cases SET subject=? WHERE id IN (?,?)', '재동기화 확인', a.caseId, o.caseId);
  const orig = store.put;
  store.put = (c, d) => { if (c === 'cases' && d.id === a.caseId) throw new Error('boom'); return orig(c, d); };
  const logs = await quiet(() => { try { collections.resyncAll(); } finally { store.put = orig; } });
  assert.equal(collections.status().failures, f0 + 1);
  assert.ok(logs.length === 1 && logs[0].startsWith('[collections] sync 실패'), logs.join('\n'));
  assert.notEqual(doc('cases', a.caseId).subject, '재동기화 확인');
  assert.equal(doc('cases', o.caseId).subject, '재동기화 확인', '나머지 케이스는 끝까지 간다');
  collections.flush();
  assert.equal(doc('cases', a.caseId).subject, '재동기화 확인');
  assert.ok(upToDate(a.caseId));
});

test('I16 CRM API — 목록 필터·counts·subCounts·400, 상세 actions·트레이스 필드 없음·읽기 직전 flush, 접속기록에 검색어 원값 없음, 정보주체 열람에 컬렉션 문서', async () => {
  const log = path.join(tmp, 'access.jsonl');
  const QUERY = 'secret-search@example.com';
  const stop = accesslog.start(log);
  let a; let h;
  try {
    await withServer(async (base) => {
      a = await run({ subject: 'API 검색 대상' });
      h = await run({ body: '환불해 주세요' });
      let r = await get(base, '/api/crm/cases?status=Escalated');
      assert.equal(r.status, 200);
      assert.ok(r.body.items.length && r.body.items.every((x) => x.status === 'Escalated'));
      assert.ok(r.body.items.some((x) => x.id === h.caseId));
      assert.equal(r.body.counts.Escalated, r.body.items.length);
      assert.equal(r.body.counts.all, ['New', 'Working', 'On Hold', 'Escalated', 'Closed'].reduce((s, k) => s + r.body.counts[k], 0));
      r = await get(base, '/api/crm/cases?subStatus=Awaiting%20Approval');
      assert.ok(r.body.items.some((x) => x.id === a.caseId) && r.body.items.every((x) => x.subStatus === 'Awaiting Approval'));
      assert.equal(r.body.subCounts['Awaiting Approval'], r.body.items.length);
      const sorted = r.body.items.map((x) => x.audit.updatedAt);
      assert.deepEqual(sorted, [...sorted].sort().reverse());
      r = await get(base, '/api/crm/cases?status=Bogus');
      assert.equal(r.status, 400); assert.deepEqual(r.body, { error: 'bad_filter', field: 'status' });
      r = await get(base, `/api/crm/cases?q=${'x'.repeat(101)}`);
      assert.equal(r.status, 400); assert.equal(r.body.field, 'q');
      r = await get(base, '/api/crm/cases?limit=1');
      assert.equal(r.body.items.length, 1);
      r = await get(base, `/api/crm/cases?q=${doc('cases', a.caseId).caseNumber}`);
      assert.deepEqual(r.body.items.map((x) => x.id), [a.caseId]);
      r = await get(base, `/api/crm/cases?q=${encodeURIComponent(QUERY)}`);
      assert.equal(r.status, 200); assert.equal(r.body.items.length, 0);

      // 상세 — 승인 대기 초안, 계약 키만(판단·회차·버전 트레이스 없음)
      r = await get(base, `/api/crm/cases/${a.caseId}`);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body).sort(), ['actions', 'case', 'company', 'contact', 'pendingDraft', 'relatedCases', 'revision', 'sendingDraft', 'shadowDraft', 'timeline']);
      assert.deepEqual(r.body.actions, ['approve', 'edit_approve', 'discard', 'takeover', 'note', 'close']);
      assert.equal(r.body.pendingDraft.id, pending(a.caseId).id); assert.match(r.body.pendingDraft.preview, /영수증/);
      assert.ok(!/prompt_hash|promptHash|"decisions"|"loop"|lease_token/.test(JSON.stringify(r.body)));
      assert.equal(r.body.timeline[0].kind, 'inbound'); assert.equal(r.body.timeline[0].sender, a.from);
      r = await get(base, `/api/crm/cases/${h.caseId}`);
      assert.deepEqual(r.body.actions, ['human_reply', 'note', 'hold', 'return', 'close']);
      // 읽기 직전 flush — emit 없는 쓰기도 상세에는 바로 보인다
      db.run('UPDATE cases SET subject=? WHERE id=?', 'API 바뀐 제목', a.caseId);
      r = await get(base, `/api/crm/cases/${a.caseId}`);
      assert.equal(r.body.case.subject, 'API 바뀐 제목');
      await post(base, `/api/cases/${h.caseId}/close`, { by: 'kim', reason: 'resolved' });
      r = await get(base, `/api/crm/cases/${h.caseId}`);
      assert.equal(r.body.case.status, 'Closed'); assert.deepEqual(r.body.actions, []);
      assert.equal((await get(base, '/api/crm/cases/nope')).status, 404);
      const st = await get(base, '/api/status');
      assert.deepEqual(Object.keys(st.body.crm).sort(), ['failures', 'lastFlushAt', 'pending']);
    });
  } finally { stop(); }
  const text = fs.readFileSync(log, 'utf8');
  assert.ok(!text.includes('secret-search'), '검색어 원값은 접속기록에 남지 않는다');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.action === 'crm.case.list' && l.filters.hasQuery && l.filters.qLen === QUERY.length && l.count === 0));
  assert.ok(lines.some((l) => l.action === 'crm.case.list' && l.filters.status === 'Escalated'));
  assert.ok(lines.some((l) => l.action === 'crm.case.view' && l.caseId === a.caseId));

  // 정보주체 열람 — 처리 기록 + CRM 문서(케이스·이벤트·활동·문의자). 서버와 같은 파일 DB에 붙는다.
  const file = path.join(tmp, 'cs.db');
  db.init(file);
  const x = add({ from: 'subject-x@example.com', subject: '열람 대상' });
  db.init(':memory:');
  const res = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'subject-request.js'), 'export', 'subject-x@example.com', '--by', 'dpo'],
    { env: { ...process.env, DB_PATH: file }, cwd: tmp, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const [e] = JSON.parse(res.stdout);
  assert.equal(e.case.id, x.caseId);
  assert.equal(e.crm.case.id, x.caseId); assert.equal(e.crm.case.subject, '열람 대상');
  assert.equal(e.crm.events.length, 1); assert.equal(e.crm.events[0].rawPayload.from, 'subject-x@example.com');
  assert.ok(e.crm.activities.some((y) => y.direction === 'inbound'));
  assert.equal(e.crm.contact.primaryEmail, 'subject-x@example.com');
});

test('I17 같은 답 반복 금지 — 인수·반환 뒤 이미 보낸 답과 같은 답은 다시 나가지 않는다(no_progress 넘김), 다른 질문의 답은 그대로 자동 발송', async () => {
  const agentOuts = (id) => db.all("SELECT body_clean FROM messages WHERE case_id=? AND direction='out' AND sent_by='agent'", id).map((m) => m.body_clean);
  process.env.AUTO_SEND = '1';
  try {
    const a = await run({ body: '영수증 발급 부탁드립니다.' });
    assert.equal(agentOuts(a.caseId).length, 1, 'L2 자동 발송');
    loop.takeover(a.caseId, { by: 'kim' });
    await loop.returnToAgent(a.caseId, { by: 'kim' });
    const b = reply(a, { body: '구독 해지는 어떻게 하나요?' });
    assert.equal((await loop.runCycle(b.caseId, b.messageId)).autoSend, true, '다른 질문은 답한다');
    assert.equal(agentOuts(a.caseId).length, 2);
    const r = reply(a, { body: '영수증 발급 부탁드립니다.' });
    assert.deepEqual(await loop.runCycle(r.caseId, r.messageId), { action: 'HANDOFF', reason: 'no_progress' });
    const outs = agentOuts(a.caseId);
    assert.equal(outs.length, 2, '같은 답이 두 번 나가지 않는다'); assert.equal(new Set(outs).size, 2);
    assert.equal(db.get("SELECT COUNT(*) n FROM drafts WHERE case_id=? AND status IN ('PENDING','SENDING')", a.caseId).n, 0);
    assert.equal(row(a.caseId).responder, 'human');
    assert.equal(db.get('SELECT reason FROM handoffs WHERE case_id=? AND returned_at IS NULL', a.caseId).reason, 'no_progress');
    assert.equal(JSON.parse(db.get("SELECT output FROM decisions WHERE message_id=? AND step='respond'", r.messageId).output).repeatsSent, true);
  } finally { process.env.AUTO_SEND = '0'; }
});

test('I18 재오픈 알림 — 사람 전담 종결 케이스에 회신이 오면(감사 인사여도) 다시 열고 담당자 그대로, 웹훅 1건(채널·케이스 번호·사유만, 연락처·이름·본문 없음), 에이전트 케이스 재오픈은 알림 없음, URL이 없으면 아무것도 안 한다', async () => {
  const human = async () => { const h = await run({ name: '김알림' }); loop.takeover(h.caseId, { by: 'kim' }); loop.closeCase(h.caseId, { by: 'kim' }); return h; };
  const h0 = await human(); const h = await human();
  const ag = await run({ name: '이에이' });
  await loop.approveDraft(pending(ag.caseId).id, { by: 'kim' });
  loop.closeCase(ag.caseId, { by: 'kim' });
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push(JSON.parse(b).text); res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  delete process.env.NOTIFY_WEBHOOK_URL;
  const off = notify.start();
  reply(h0, { body: '추가 문의 010-2222-3333 입니다' });
  await sleep(30); off();
  assert.equal(got.length, 0, 'URL 없음');
  const stop = notify.start(`http://127.0.0.1:${srv.address().port}/hook`);
  let t;
  try {
    t = reply(h, { name: '김알림', body: '감사합니다. 잘 받았습니다. 010-2222-3333' }); // 감사 인사여도 사람 전담은 다시 열고 알린다
    assert.equal(t.reopened, true);
    await until(() => got.length >= 1);
    assert.equal(reply(ag, { name: '이에이', body: '하나 더 여쭙니다 010-4444-5555' }).reopened, true);
    await sleep(50);
  } finally { stop(); srv.closeAllConnections(); srv.close(); }
  assert.equal(got.length, 1, '에이전트 케이스 재오픈은 알림 없음');
  assert.match(got[0], /종결 케이스에 고객 회신 — 담당자 확인 필요/);
  assert.ok(got[0].includes(h.caseId.slice(0, 8))); assert.match(got[0], /#cs-support/);
  assert.doesNotMatch(got[0], /@|010|2222|김알림|감사|잘 받았|영수증/);
  assert.deepEqual(await loop.runCycle(t.caseId, t.messageId), { action: 'IGNORE', reason: 'responder_human' });
  await tick(); await tick();
  assert.deepEqual([row(h.caseId).state, row(h.caseId).responder, row(h.caseId).assignee], ['HANDED_OFF', 'human', 'kim'], '사람 전담 감사 인사는 다시 닫지 않는다');
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", h.caseId).n, 0);
});

test('I19 자동 회신·빈 본문은 종결 케이스를 다시 열지 않는다 — 같은 케이스에 붙기만(reopened false), 상태·종결 사유 그대로, case.reopened 없음, 회차는 에이전트·사람 케이스 모두 초안·발신·상태 변화 없음', async () => {
  const seen = []; const unsub = events.subscribe(({ name, data }) => { if (name === 'case.reopened') seen.push(data.caseId); });
  const counts = (id) => db.get(`SELECT (SELECT COUNT(*) FROM drafts WHERE case_id=?) d, (SELECT COUNT(*) FROM messages WHERE case_id=? AND direction='out') o,
    (SELECT COUNT(*) FROM activities WHERE case_id=?) a, (SELECT COUNT(*) FROM handoffs WHERE case_id=?) h`, id, id, id, id);
  const KINDS = [
    { autoSubmitted: true, subject: 'Re: 문의', body: '휴가 중입니다. 다음 주에 확인하겠습니다.' },
    { subject: '[자동 회신] Re: 문의', body: '휴가 중입니다.' },
    { subject: 'Re: 문의', body: '부재중: 11월 10일에 복귀합니다.' },
    { subject: 'Re: 문의', body: '  \n ' },
  ];
  try {
    for (const owner of ['agent', 'human']) {
      for (const k of KINDS) {
        const a = await run();
        if (owner === 'human') loop.takeover(a.caseId, { by: 'kim' });
        loop.closeCase(a.caseId, { by: 'kim' });
        db.run("UPDATE cases SET close_reason='duplicate', close_detail='같은 건' WHERE id=?", a.caseId);
        const before = { ...row(a.caseId) }; const c0 = { ...counts(a.caseId) };
        const r = reply(a, k);
        assert.deepEqual([r.caseId, r.created, r.reopened], [a.caseId, false, false], `${owner} ${k.subject}`);
        await loop.runCycle(r.caseId, r.messageId);
        await tick(); await tick();
        const after = row(a.caseId);
        for (const f of ['state', 'closed_at', 'close_reason', 'close_detail', 'responder', 'assignee']) assert.equal(after[f], before[f], `${owner} ${f}`);
        assert.deepEqual({ ...counts(a.caseId) }, c0, `${owner} 초안·발신·활동·넘김 그대로`);
        collections.flush();
        const d = doc('cases', a.caseId);
        assert.deepEqual([d.status, d.closeReason, d.closeDetail], ['Closed', 'duplicate', '같은 건']);
        assert.deepEqual([evOf(r.messageId).matching.method, evOf(r.messageId).matching.reasonCode], ['thread', null]);
      }
    }
    assert.deepEqual(seen, []);
  } finally { unsub(); }
});

test('I20 감사 인사 재종결 — 회차가 어디서 돌든(직접 호출·감사 인사 둘 겹침·스위퍼 재시도) 다시 닫고 원래 종결 사유·상세를 되돌린다 / 진짜 문의면 사유를 비우고 열린 채, 그 뒤 감사 인사로도 닫지 않는다', async () => {
  const THANKS = '감사합니다. 잘 받았습니다.';
  const closedAs = async (reason, detail = null) => {
    const a = await run();
    await loop.approveDraft(pending(a.caseId).id, { by: 'kim' });
    loop.closeCase(a.caseId, { by: 'kim' });
    db.run('UPDATE cases SET close_reason=?, close_detail=? WHERE id=?', reason, detail, a.caseId);
    return a;
  };
  const closedAgain = (id) => until(() => row(id).state === 'CLOSED');
  const outs = (id) => db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", id).n;

  // 직접 호출(스크립트 경로) — 재오픈 활동에 사유를 남기고, 다시 닫을 때 되돌린다
  const a = await closedAs('other', '고객이 전화로 해결');
  const t = reply(a, { body: THANKS });
  assert.equal(t.reopened, true);
  assert.deepEqual([row(a.caseId).close_reason, row(a.caseId).close_detail], [null, null]);
  assert.deepEqual(JSON.parse(db.get("SELECT payload FROM activities WHERE case_id=? AND type='reopen'", a.caseId).payload),
    { messageId: t.messageId, closeReason: 'other', closeDetail: '고객이 전화로 해결' });
  await loop.runCycle(t.caseId, t.messageId);
  await closedAgain(a.caseId);
  assert.deepEqual([row(a.caseId).close_reason, row(a.caseId).close_detail, outs(a.caseId)], ['other', '고객이 전화로 해결', 1]);
  collections.flush();
  assert.deepEqual([doc('cases', a.caseId).status, doc('cases', a.caseId).closeReason, doc('cases', a.caseId).closeDetail], ['Closed', 'other', '고객이 전화로 해결']);

  // 감사 인사 둘이 겹쳐도 — 두 번째 회차까지 끝난 뒤 닫힌다
  const b = await closedAs('resolved');
  const t1 = reply(b, { body: THANKS }); const t2 = reply(b, { body: '정말 감사합니다!' });
  assert.deepEqual([t1.reopened, t2.reopened], [true, false]);
  await Promise.all([loop.runCycle(b.caseId, t1.messageId), loop.runCycle(b.caseId, t2.messageId)]);
  await closedAgain(b.caseId);
  assert.deepEqual([row(b.caseId).close_reason, outs(b.caseId)], ['resolved', 1]);

  // LLM 장애로 재시도 예약 → 스위퍼 재시도 회차가 ack로 끝나면 닫힌다
  const c = await closedAs('duplicate', '같은 건');
  const t3 = reply(c, { body: THANKS });
  llm.use({ name: 'flaky', json: async () => { throw new Error('upstream 503'); } });
  try { assert.equal((await loop.runCycle(c.caseId, t3.messageId)).action, 'RETRY'); } finally { llm.use('mock'); }
  await tick(); await tick();
  assert.notEqual(row(c.caseId).state, 'CLOSED');
  await sweeper.tick(Date.now() + 3_600_000);
  await closedAgain(c.caseId);
  assert.deepEqual([row(c.caseId).close_reason, row(c.caseId).close_detail], ['duplicate', '같은 건']);

  // 진짜 문의 — 사유를 비우고 열린 채, 답이 나간 뒤 감사 인사로는 다시 닫지 않는다(고객 회신 대기)
  const e = await closedAs('other', '메모');
  const q = reply(e, { body: '구독 해지는 어떻게 하나요?' });
  await loop.runCycle(q.caseId, q.messageId);
  await loop.approveDraft(pending(e.caseId).id, { by: 'kim' });
  const t4 = reply(e, { body: THANKS });
  await loop.runCycle(t4.caseId, t4.messageId);
  await tick(); await tick();
  assert.deepEqual([row(e.caseId).state, row(e.caseId).close_reason, row(e.caseId).close_detail], ['WAITING_CUSTOMER', null, null]);
  collections.flush();
  assert.deepEqual([doc('cases', e.caseId).status, doc('cases', e.caseId).closeReason], ['Working', null]);
});

test('I21 같은 답 반복 금지는 같은 문의 유형끼리만 — 다른 유형으로 나간 답과 문장이 거의 같아도 막지 않는다', async () => {
  process.env.AUTO_SEND = '1';
  try {
    const a = await run({ body: '영수증 발급 부탁드립니다.' });
    const sent = db.get("SELECT original_body, intent FROM drafts WHERE case_id=? AND status='SENT'", a.caseId);
    assert.equal(sent.intent, 'receipt');
    // 다른 케이스에 같은 문장이 해지 안내(다른 유형)로 이미 나갔다고 둔다
    const b = add({ body: '영수증 발급 부탁드립니다.' });
    db.insert('drafts', { id: db.uuid(), case_id: b.caseId, trigger_message_id: b.messageId, status: 'SENT', intent: 'cancel_subscription', action: 'DRAFT',
      original_body: sent.original_body, idempotency_key: `draft:${db.uuid()}`, created_at: db.now() });
    const out = await loop.runCycle(b.caseId, b.messageId);
    assert.deepEqual([out.action, out.autoSend], ['DRAFT', true], '다른 유형의 답과 같아도 나간다');
    assert.equal(row(b.caseId).responder, 'agent');
  } finally { process.env.AUTO_SEND = '0'; }
});

test('I22 종결 케이스는 명시적 재오픈으로만 열린다 — LLM을 기다리던 회차 도중 종결되고 그 호출이 실패해도(재시도 예약) Closed·종결 사유 그대로, 스위퍼 재시도가 또 실패해도·성공해도 그대로', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  llm.use({ name: 'down-later', json: async () => { await gate; throw new Error('upstream 503'); } });
  const a = add();
  const keep = ['state', 'closed_at', 'close_reason', 'close_detail', 'responder'];
  let before;
  const same = (why) => { const c = row(a.caseId); for (const k of keep) assert.equal(c[k], before[k], `${why}: ${k}`); };
  try {
    const cyc = loop.runCycle(a.caseId, a.messageId);
    assert.ok(loop.status().activeCases.includes(a.caseId));
    await withServer(async (base) => assert.equal((await post(base, `/api/cases/${a.caseId}/close`, { by: 'kim', reason: 'duplicate', detail: '같은 건' })).status, 200));
    before = { ...row(a.caseId) };
    assert.equal(before.state, 'CLOSED');
    release();
    assert.equal((await cyc).action, 'RETRY');
    assert.ok(db.get('SELECT next_retry_at FROM loops WHERE case_id=?', a.caseId).next_retry_at, '재시도 예약은 남는다');
    same('회차 실패');
    await sweeper.tick(Date.now() + 3_600_000);
    same('재시도도 실패');
  } finally { llm.use('mock'); }
  await sweeper.tick(Date.now() + 30 * 86_400_000);
  same('재시도 성공');
  assert.equal(db.get("SELECT COUNT(*) n FROM drafts WHERE case_id=? AND status IN ('PENDING','SENDING','SENT')", a.caseId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", a.caseId).n, 0);
  collections.flush();
  assert.deepEqual([doc('cases', a.caseId).status, doc('cases', a.caseId).closeReason, doc('cases', a.caseId).closeDetail], ['Closed', 'duplicate', '같은 건']);
});
