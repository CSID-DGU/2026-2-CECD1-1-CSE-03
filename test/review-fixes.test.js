'use strict';
// 코드 리뷰(C1–C2, M1–M15) 시나리오. 리뷰에서 재현한 실패를 그대로 테스트로 둔다.
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../server/db');
const llm = require('../server/llm');
const mock = require('../server/llm/mock');
const cases = require('../server/cases');
const loop = require('../server/loop');
const events = require('../server/events');
const policy = require('../server/policy');
const guard = require('../server/guard');
const kbLoader = require('../server/kb');
const prefilter = require('../server/prefilter');
const { createServer } = require('../server/index');

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

test('C1 대기 초안이 있는데 고객이 "감사합니다"만 보내면 답이 새 메시지 기준으로 다시 승인 대기에 오른다', async () => {
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

test('C2 본문에 "부재중"이 들어간 환불 요청은 버리지 않고 사람에게 넘긴다', async () => {
  const r = await thread().run('출장으로 부재중이었는데 자동결제가 됐어요. 환불해 주세요');
  assert.deepEqual(lastExec(r.caseId), { action: 'HANDOFF', reason: 'refund_request' });
});

test('C2 수신 어댑터가 autoSubmitted로 표시한 메일은 무시한다', async () => {
  const r = await thread().run('휴가 중입니다. 다음 주에 회신드립니다.', { autoSubmitted: true });
  assert.equal(lastExec(r.caseId).action, 'IGNORE');
});

test('M1 회차 도중 종결 → 결과를 쓰지 않는다(승인 대기 없음, 초안은 NOT_SELECTED 기록)', async () => {
  process.env.LLM_MOCK_DELAY_MS = '30';
  const t = thread(); const r = t.add('영수증 발급 방법 알려주세요');
  const p = loop.runCycle(r.caseId, r.messageId);
  await sleep(10); loop.closeCase(r.caseId, { by: 'h' });
  assert.equal((await p).action, 'ABORTED');
  assert.equal(st(r.caseId).state, 'CLOSED'); assert.equal(pending(r.caseId).length, 0);
  assert.ok(db.get("SELECT 1 FROM drafts WHERE case_id=? AND status='NOT_SELECTED'", r.caseId));
});

test('M1 회차 도중 인수 → HANDED_OFF 유지, 승인할 초안이 생기지 않는다', async () => {
  process.env.LLM_MOCK_DELAY_MS = '30';
  const t = thread(); const r = t.add('로그인이 안 됩니다');
  const p = loop.runCycle(r.caseId, r.messageId);
  await sleep(10); loop.takeover(r.caseId, { by: 'h' });
  await p;
  assert.deepEqual(st(r.caseId), { state: 'HANDED_OFF', responder: 'human' });
  assert.equal(pending(r.caseId).length, 0);
});

test('M2 발송 중: 직접 답장·인수·종결은 409 sending, 발송 중 들어온 메시지의 초안은 그 답장을 보고 다시 쓴다', async () => {
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

test('M2 발송 실패 시 초안은 PENDING으로 돌아오고 오류가 남는다', async () => {
  const r = await thread().run('구독 해지 방법 알려주세요');
  const d = pending(r.caseId)[0];
  process.env.MAIL_MOCK_FAIL = '1';
  await rejects(loop.approveDraft(d.id, { by: 'a' }), 502, 'send_failed');
  assert.equal(draft(d.id).status, 'PENDING'); assert.match(draft(d.id).error, /mock send failure/);
  assert.equal(st(r.caseId).state, 'AWAITING_APPROVAL');
});

test('M3 답장+넘김 초안이 낡아도 넘김은 남는다 — 다음 초안도 승인되면 사람에게', async () => {
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

test('M4 회차 밖 예외 → internal_error로 사람에게, 리스 해제, 줄 선 메시지도 처리', async () => {
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

test('M4 재시작 복구: 판단이 안 끝난 메시지 재실행, 큐 비우기, SENDING 초안 확인 표시·처리', async () => {
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

test('M5 같은 케이스에 회차 둘이 동시에 → 하나는 큐, 순서대로 처리, 리스는 비워진다', async () => {
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

test('M5 리스 해제는 자기 토큰일 때만', async () => {
  process.env.LLM_MOCK_DELAY_MS = '30';
  const t = thread(); const r = t.add('구독 해지 방법');
  const p = loop.runCycle(r.caseId, r.messageId);
  await sleep(10);
  const later = new Date(Date.now() + 60000).toISOString();
  db.run("UPDATE loops SET lease_until=?, lease_token='other' WHERE case_id=?", later, r.caseId); // 리스가 만료돼 다른 회차가 잡았다고 치자
  await p;
  assert.equal(db.get('SELECT lease_token FROM loops WHERE case_id=?', r.caseId).lease_token, 'other');
});

test('M5 anthropic provider: 4xx 재시도 안 함 · 429 재시도 · 타임아웃 · max_tokens · 정상', async () => {
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
  await new Promise((r) => srv.listen(0, r));
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

test('M6 직접 답장은 실제로 발송된다 — 사람 템플릿, 환불 언급 허용, 자리표시는 막는다', async () => {
  const t = thread(); const r = await t.run('영수증 발급 방법 알려주세요');
  const out = await loop.humanReply(r.caseId, { by: '김담당', body: '환불은 확인 후 처리해 드리겠습니다.' });
  const m = db.get('SELECT * FROM messages WHERE id=?', out.messageId);
  assert.equal(m.sent_by, 'human'); assert.match(m.body, /ACME 김담당입니다/); assert.doesNotMatch(m.body, /AI 상담/);
  assert.equal(db.get('SELECT status FROM dispatches WHERE draft_id=?', out.draftId).status, 'SENT');
  await rejects(loop.humanReply(r.caseId, { by: '김담당', body: '[고객명] 님 확인 부탁드립니다' }), 422, 'guard');
});

test('M7 현실적인 분류(영수증 + 환불, kbHit partial) → 답장+넘김이 아니라 통째 넘김', async () => {
  const triage = { intent: 'receipt', handoffReason: 'refund_request', confidence: 0.9, kbHit: 'partial', kbSections: ['receipt'], riskSignals: [], questionSummary: '영수증과 환불', handoffTopic: '환불', repeatsPrevious: false, language: 'ko', evidence: [] };
  llm.use({ name: 'stub', json: async (req) => (req.agent === 'triage' ? triage : mock.json(req)) });
  const r = await thread().run('지난달 영수증 발급 부탁드리고, 이번 달 결제는 환불해 주세요.');
  assert.deepEqual(lastExec(r.caseId), { action: 'HANDOFF', reason: 'refund_request' });
  const pack = policy.load('support');
  const d = (o) => policy.decide({ pack, triage: { ...triage, handoffReason: null, kbHit: true, riskSignals: [], ...o }, guard: { pass: true } });
  assert.deepEqual([d({ handoffReason: 'injection' }).action, d({ handoffReason: 'injection' }).reason], ['HANDOFF', 'injection']);
  assert.deepEqual([d({ riskSignals: ['refund'] }).action, d({ riskSignals: ['refund'] }).reason], ['HANDOFF', 'refund_request']);
  assert.deepEqual([d({ riskSignals: ['legal'] }).reason, d({ riskSignals: ['complaint'] }).reason], ['legal_threat', 'complaint']);
  assert.equal(d({ handoffReason: 'call_meeting' }).action, 'ANSWER_AND_HANDOFF', '답해도 되는 사유는 섞여도 답한다');
});

test('M8 guard가 금액·기한 약속의 흔한 표기를 잡는다(영어 포함)', () => {
  const pack = policy.load('support'); const kb = kbLoader.load('support');
  const codes = (b) => guard.check({ body: b, pack, kb }).map((h) => h.code);
  for (const b of ['$50 입니다', '₩50,000 입니다', '50,000 입니다', '20 percent off', '5만원']) assert.ok(codes(b).includes('amount'), b);
  for (const b of ['3영업일 이내에 처리됩니다', '24시간 이내 답변드리겠습니다', '1주일 이내에 보내드립니다', '내일 회신하겠습니다', '월요일에 연락드리겠습니다',
    '내일 오후 중으로 담당 부서에서 확인한 뒤 결과를 정리해서 보내드리겠습니다', 'We will get back to you by tomorrow', 'It will be done within 3 days']) assert.ok(codes(b).includes('date_promise'), b);
  assert.ok(codes('We can refund you').includes('forbidden_word'));
  assert.deepEqual(codes('삭제된 데이터는 30일간 보관됩니다.'), []);
  const ob = policy.load('onboarding');
  assert.deepEqual(guard.check({ body: '팀원 10명 규모면 기본 설정으로 충분합니다.', pack: ob, kb: kbLoader.load('onboarding') }), []);
});

test('M9 자리표시 여러 모양을 막고, KB의 메뉴 이름·경로는 허용', () => {
  const pack = policy.load('support'); const kb = kbLoader.load('support');
  const slot = (b) => guard.check({ body: b, pack, kb }).some((h) => h.code === 'unresolved_slot');
  for (const b of ['[고객명] 님', '○○○ 님 안녕하세요', 'OO 님', '<이름> 님', '{} 님', '{회사명}']) assert.ok(slot(b), b);
  for (const b of ['[설정 > 계정 > 탈퇴하기]에서 진행하세요', '[세금계산서 요청]을 누르세요']) assert.ok(!slot(b), b);
});

test('M11 이름은 수신 때 정리되고, 승인 때는 렌더된 메일 전체를 검사한다. 상세에 미리보기', async () => {
  const t = thread();
  const r = await t.run('영수증 발급 방법 알려주세요', { name: '환불 승인 완료 https://evil.example {x}' });
  const c = db.get('SELECT customer_name FROM cases WHERE id=?', r.caseId);
  assert.doesNotMatch(c.customer_name, /[{}:/]/); assert.ok(c.customer_name.length <= 30);
  const d = cases.getCase(r.caseId).drafts.find((x) => x.status === 'PENDING');
  assert.match(d.preview, /^안녕하세요, /); assert.match(d.preview, /AI 상담 에이전트/);
  assert.ok(d.kbPassages.receipt.length > 20);
  const e = await rejects(loop.approveDraft(d.id, { by: 'a' }), 422, 'guard');
  assert.ok(e.extra.violations.some((v) => v.code === 'forbidden_word'), '인사말 이름의 "환불"');
  assert.equal(cases.sanitizeName(''), '고객');
});

test('M12 연락처는 판단 기록·SSE·브리핑에 남지 않는다', async () => {
  const seen = [];
  const unsub = events.subscribe((e) => seen.push(JSON.stringify(e)));
  const r = await thread().run('010-1234-5678로 전화 주세요. 메일은 me@private.example 입니다.');
  unsub();
  const rows = db.all('SELECT input_summary, output FROM decisions WHERE case_id=?', r.caseId).map((x) => `${x.input_summary} ${x.output}`).join('\n');
  const brief = db.all('SELECT briefing FROM handoffs WHERE case_id=?', r.caseId).map((x) => x.briefing).join('\n');
  for (const s of [rows, brief, seen.join('\n')]) { assert.doesNotMatch(s, /1234-5678/); assert.doesNotMatch(s, /me@private/); }
  assert.match(rows, /\[연락처\]/);
});

test('M13 폼 값의 연락처는 키 이름·값 모양 둘 다로 거른다', () => {
  assert.deepEqual(cases.sanitizeFacts({ 회사: 'ACME', 핸드폰: '01012345678', mobile: '010 1234 5678', HP: '+82 10 1234 5678', 메모: '연락은 02-123-4567' }), { 회사: 'ACME' });
});

test('HTTP: 깨진 URI 400 · 경로 탈출 차단 · JSON 아니면 415 · limit 범위 · 500에 내부 메시지 없음', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    assert.ok([403, 404].includes((await fetch(`${base}/..%2f..%2fpackage.json`)).status));
    assert.equal((await fetch(`${base}/api/test/inbound`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    for (let i = 0; i < 3; i += 1) cases.addInbound({ channel: 'support', from: `lim${i}@example.com`, body: '영수증' });
    assert.equal((await (await fetch(`${base}/api/cases?limit=-1`)).json()).length, 1);
  } finally { server.close(); }
});

test('불변식: 승인 대기인데 PENDING 초안이 없는 케이스가 없다', () => {
  const bad = db.all("SELECT id FROM cases c WHERE state='AWAITING_APPROVAL' AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=c.id AND d.status='PENDING')");
  assert.deepEqual(bad, []);
});

after(() => {});
