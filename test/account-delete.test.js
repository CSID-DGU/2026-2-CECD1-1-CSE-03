'use strict';
// 계정 탈퇴: 본인 확인 코드(등록 주소로 발송 → 코드 회신) → soft delete → 유예 뒤 관리자 승인 완전 삭제. 결정 모델 툴 라우터.
process.env.MAIL_MOCK_LOG = '0';
process.env.ADMIN_USERS = 'admin';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const db = require('../server/db');
const llm = require('../server/llm');
const mail = require('../server/mail');
const cases = require('../server/cases');
const loop = require('../server/loop');
const members = require('../server/members');
const tools = require('../server/agents/tools');
const decision = require('../server/llm/decision');
const { preflight, createServer } = require('../server/index');

const BIZ = path.join(__dirname, '..', 'server', 'mock', 'business-data.json');
const ENV = ['ACCOUNT_DELETE_TOOL', 'TOOL_ROUTER', 'BUSINESS_DATA_FILE'];
// 확인 코드 메일만 가로채 본다(나머지 발송은 그대로)
const realSend = mail.send;
let codeMails = [];
const lastCode = () => codeMails.at(-1)?.body.match(/확인 코드는 (\d{6})/)[1];
before(() => {
  llm.use('mock'); process.env.RESPONDER_MODE = 'react';
  mail.send = async (m) => { if (/탈퇴 확인/.test(m.subject)) codeMails.push(m); return realSend(m); };
});
beforeEach(() => { db.init(':memory:'); for (const k of ENV) delete process.env[k]; decision.use(null); codeMails = []; });
after(() => { for (const k of ENV) delete process.env[k]; delete process.env.RESPONDER_MODE; decision.use(null); mail.send = realSend; });

const pack = () => require('../server/policy').load('support');
const kb = () => require('../server/kb').load('support');
const ctx = (email, { auth = 'pass', intent = 'account_deletion', body = '계정 탈퇴 처리해 주세요.' } = {}) => ({
  caseId: 'c-1', case: { customer_email: email, known_facts: '{}' }, rawMessage: { sender: email, sender_auth: auth, body_clean: body },
  message: { body_clean: body }, pack: pack(), kb: kb(), triage: { intent },
});
const names = (c) => tools.defs(c).map((d) => d.name);
const outs = (caseId, step = 'respond') => db.all('SELECT output FROM decisions WHERE case_id=? AND step=? ORDER BY created_at, rowid', caseId, step).map((r) => JSON.parse(r.output));
let seq = 0;
const inbound = async (from, body, { auth = 'pass' } = {}) => {
  seq += 1;
  const r = cases.addInbound({ channel: 'support', name: '가상고객', from, subject: '탈퇴', body, threadId: `t-${seq}`, providerMessageId: `p-${seq}`, senderAuth: auth });
  await loop.runCycle(r.caseId, r.messageId);
  return r;
};
const deletion = require('../server/deletion');
const on = () => { process.env.BUSINESS_DATA_FILE = BIZ; process.env.ACCOUNT_DELETE_TOOL = '1'; };
const other = (code) => (code === '000000' ? '111111' : '000000');

test('회원 저장소: 코드는 해시로만, 틀리면 남은 횟수·5번이면 잠금, 맞으면 disabled + 30일 유예, 유예 전에는 완전 삭제 안 됨', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T00:00:00.000Z') });
  const e = 'nari.cho@example.com';
  const { code } = members.requestCode(e, { caseId: 'c-1' });
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM members')).includes(code), '코드 원문은 저장하지 않는다');
  assert.deepEqual(members.confirm(e, other(code)), { ok: false, error: 'mismatch', left: 4 });
  assert.deepEqual(members.confirm(e, code), { ok: true, caseId: 'c-1' });
  const m = members.get(e);
  assert.equal(m.status, 'disabled'); assert.equal(m.deleted_by, 'customer:confirm_code'); assert.equal(m.purge_after, '2026-12-16T00:00:00.000Z');
  assert.deepEqual(members.listDisabled().map((x) => [x.email, x.due]), [[e, false]]);
  assert.deepEqual(members.purge(e, { by: 'admin' }), { ok: false, error: 'not_due' });
  assert.deepEqual(members.restore(e, { by: 'admin' }), { ok: true });
  assert.equal(members.get(e).purge_after, null);
  // 다시 탈퇴 → 30일 뒤 완전 삭제: 주소는 해시만 남는다
  members.confirm(e, members.requestCode(e, { caseId: 'c-2' }).code);
  t.mock.timers.setTime(Date.parse('2026-12-17T00:00:00.000Z'));
  assert.equal(members.listDisabled()[0].due, true);
  assert.deepEqual(members.purge(e, { by: 'admin' }), { ok: true });
  assert.equal(db.get('SELECT COUNT(*) n FROM members WHERE email LIKE ?', '%nari%').n, 0, '주소가 남지 않는다');
  assert.match(db.get("SELECT email FROM members WHERE status='purged'").email, /^purged:[0-9a-f-]{36}$/, '해시가 아닌 임의 키');
  assert.equal(members.get(e), null);
  assert.match(members.requestCode(e, { caseId: 'c-3' }).code, /^\d{6}$/, '다시 가입한 주소는 새로 받는다');
  // 유예 기간이 없는 행은 바로 지우지 않는다
  db.run("INSERT INTO members (email, status, updated_at) VALUES ('x@example.com', 'disabled', ?)", db.now());
  assert.deepEqual(members.purge('x@example.com', { by: 'admin' }), { ok: false, error: 'not_due' });
  // 만료·잠금
  const s = 'sumin.lee@example.com';
  members.requestCode(s, { caseId: 'c-4' });
  t.mock.timers.setTime(Date.parse('2026-12-18T01:00:00.000Z'));
  assert.equal(members.pending(s), null, '만료된 코드는 걸려 있지 않은 것으로 본다');
  assert.deepEqual(members.confirm(s, '123456'), { ok: false, error: 'expired' });
  const c2 = members.requestCode(s, { caseId: 'c-5' }).code;
  for (let i = 0; i < 4; i += 1) members.confirm(s, other(c2));
  assert.deepEqual(members.confirm(s, other(c2)), { ok: false, error: 'locked' });
  assert.deepEqual(members.confirm(s, c2), { ok: false, error: 'none' }, '잠긴 뒤에는 맞는 코드도 안 된다');
  assert.equal(members.get(s).status, 'active');
});

test('탈퇴 요청 툴은 켜는 값·회원 원본·고객 본인 인증·탈퇴 분류가 모두 맞을 때만 보인다', () => {
  const e = 'nari.cho@example.com';
  process.env.BUSINESS_DATA_FILE = BIZ;
  assert.ok(!names(ctx(e)).includes('request_account_deletion'), 'ACCOUNT_DELETE_TOOL 없으면 숨김');
  process.env.ACCOUNT_DELETE_TOOL = '1';
  assert.ok(names(ctx(e)).includes('request_account_deletion'));
  assert.ok(!names(ctx(e, { auth: null })).includes('request_account_deletion'), '발신 인증 없음');
  assert.ok(!names(ctx(e, { auth: 'fail' })).includes('request_account_deletion'), '발신 인증 실패');
  assert.ok(!names(ctx(e, { intent: 'login_issue' })).includes('request_account_deletion'), '탈퇴 분류가 아님');
  assert.ok(!names({ ...ctx(e), pack: { ...pack(), shadow: true } }).includes('request_account_deletion'), '섀도 채널');
  delete process.env.BUSINESS_DATA_FILE;
  assert.ok(!names(ctx(e)).includes('request_account_deletion'), '회원 원본 없음');
});

test('탈퇴 요청 툴: 계정을 끄지 않고 등록 주소로 코드만 보낸다. 메일에 없는 문장·소유자 계정·없는 주소는 보내지 않는다', async () => {
  on();
  const caseOf = (from) => cases.addInbound({ channel: 'support', name: '가상고객', from, subject: '탈퇴', body: '-', threadId: `tc-${from}`, providerMessageId: `pc-${from}`, senderAuth: 'pass' }).caseId;
  const c = { ...ctx('nari.cho@example.com', { body: '안녕하세요.\n제 계정 탈퇴 처리해 주세요. 감사합니다.' }), caseId: caseOf('nari.cho@example.com') };
  const run = tools.runner(c);
  for (const q of ['탈퇴해 주세요', '계정 삭제를 원합니다', '안녕하세요. 감사합니다.', '']) assert.ok((await run.run('request_account_deletion', { customerQuote: q })).isError, q);
  assert.equal(codeMails.length, 0);
  const ok = await run.run('request_account_deletion', { customerQuote: '제 계정 탈퇴 처리해 주세요.' });
  assert.ok(!ok.isError, ok.content);
  assert.equal(JSON.parse(ok.content).codeSent, true);
  assert.equal(codeMails.length, 1); assert.equal(codeMails[0].to, 'nari.cho@example.com');
  assert.ok(!ok.content.includes(lastCode()), '모델은 코드를 모른다');
  assert.deepEqual(run.state.actions, [{ type: 'deletion_code_sent', by: 'agent:responder' }]);
  assert.equal(JSON.parse(run.run('lookup_account', {}).content).status, 'active', '아직 꺼지지 않았다');
  // 팀 소유자 → 코드 없이 사람에게
  const own = await tools.runner(ctx('hayul.kwon@example.com')).run('request_account_deletion', { customerQuote: '계정 탈퇴 처리해 주세요.' });
  assert.deepEqual([own.done?.needsHandoff, own.done?.handoffReason], [true, 'human_request']);
  assert.ok((await tools.runner(ctx('nobody@example.com')).run('request_account_deletion', { customerQuote: '계정 탈퇴 처리해 주세요.' })).isError);
  assert.equal(codeMails.length, 1);
});

test('회차 전체: 탈퇴 요청 → 코드 메일 → 등록 주소에서 코드 회신하면 코드가 맞춰 끄고 안내 후 종결. 판정 기록에 코드가 없다', async () => {
  on();
  const e = 'nari.cho@example.com';
  const r = await inbound(e, '더 이상 쓰지 않아서요. 제 계정 탈퇴 처리해 주세요.');
  assert.deepEqual(outs(r.caseId)[0].actions, [{ type: 'deletion_code_sent', by: 'agent:responder' }]);
  assert.equal(members.get(e).status, 'active');
  const code = lastCode();
  // 인증 실패 주소의 회신은 코드로 보지 않는다
  await inbound(e, `확인 코드 ${code}`, { auth: 'fail' });
  assert.equal(members.get(e).status, 'active');
  // 틀린 코드 → 남은 횟수 안내, 계정 그대로
  const bad = await inbound(e, `코드: ${other(code)}`);
  assert.equal(outs(bad.caseId, 'execute')[0].reason, 'deletion_mismatch');
  assert.ok(db.get("SELECT body_clean FROM messages WHERE case_id=? AND direction='out'", bad.caseId).body_clean.includes('남은 횟수 4번'));
  // 코드를 적지 않은 빈 회신(인용만) → 코드로 보지 않는다
  await inbound(e, `\n\n2026년 11월 16일 (월) 오후 3:00, ACME <cs@acme.test>님이 작성:\n> 요청하신 계정 탈퇴의 확인 코드는 ${code} 입니다.`);
  assert.equal(members.get(e).status, 'active', '인용된 코드로는 끄지 않는다');
  // 진행 중인 다른 케이스의 주문번호는 코드로 보지 않는다(코드를 요청한 케이스도, 새 케이스 첫 메일도 아니다)
  assert.equal(deletion.matchReply({ sender: e, senderAuth: 'pass', body: `주문번호 ${code} 확인해 주세요`, caseId: bad.caseId, firstInCase: false }), null);
  assert.ok(deletion.matchReply({ sender: e, senderAuth: 'pass', body: code, caseId: 'new', firstInCase: true }));
  assert.equal(deletion.matchReply({ sender: e, senderAuth: 'pass', body: code, subject: '자동 회신: 부재 중', caseId: 'new', firstInCase: true, autoSubmitted: true }), null, '자동 회신');
  // 맞는 코드(공백 섞여도) → 끄고 안내·종결
  const good = await inbound(e, `확인 코드 ${code.slice(0, 3)} ${code.slice(3)} 입니다.`);
  const m = members.get(e);
  assert.equal(m.status, 'disabled'); assert.equal(m.delete_case_id, r.caseId);
  assert.equal(db.get('SELECT state FROM cases WHERE id=?', good.caseId).state, 'CLOSED');
  assert.equal(db.get('SELECT state FROM cases WHERE id=?', r.caseId).state, 'CLOSED', '탈퇴를 요청한 케이스도 닫는다');
  assert.ok(db.get("SELECT 1 FROM activities WHERE case_id=? AND type='deletion_confirmed'", r.caseId));
  assert.ok(db.get("SELECT body_clean FROM messages WHERE case_id=? AND direction='out'", good.caseId).body_clean.includes('탈퇴를 처리했습니다'));
  assert.equal(outs(good.caseId, 'triage').length, 0, '모델을 부르지 않는다');
  assert.ok(!JSON.stringify(db.all('SELECT output, input_summary FROM decisions WHERE case_id=?', good.caseId)).includes(code), '판정 기록에 코드 없음');
  // 방법만 묻는 메일은 코드를 보내지 않는다
  await inbound('taeho.yoon@example.com', '계정 탈퇴는 어떻게 하나요?');
  assert.equal(codeMails.length, 1);
});

test('관리자 API: 탈퇴 회원 목록·복구·완전 삭제(유예 전 409 not_due), 관리자가 아니면 403', async () => {
  members.confirm('nari.cho@example.com', members.requestCode('nari.cho@example.com', { caseId: 'c-1' }).code);
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => { const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  try {
    assert.deepEqual((await api('GET', '/api/console/members')).data.items.map((x) => [x.email, x.due]), [['nari.cho@example.com', false]]);
    assert.equal((await api('POST', '/api/console/members/purge', { email: 'nari.cho@example.com', by: 'someone' })).status, 403);
    const nd = await api('POST', '/api/console/members/purge', { email: 'nari.cho@example.com', by: 'admin' });
    assert.deepEqual([nd.status, nd.data.error], [409, 'not_due']);
    assert.deepEqual((await api('POST', '/api/console/members/restore', { email: 'nari.cho@example.com', by: 'admin' })).data, { ok: true });
    assert.equal(members.get('nari.cho@example.com').restored_by, 'admin');
  } finally { server.close(); }
});

test('결정 모델 라우터: 첫 걸음(탈퇴 요청·절 읽기·계정 조회)을 코드가 실행해 붙이고, 라우터 걸음은 걸음 수에 세지 않는다', async () => {
  on(); process.env.TOOL_ROUTER = 'decision';
  let asked = null;
  decision.use(async ({ input, questions }) => {
    asked = { input, keys: Object.keys(questions) };
    return { answers: { delete_now: { type: 'noul', noul: 0.97 }, section: { type: 'choice', choice: 'account_deletion', confidence: 0.92 }, lookup: { type: 'choice', choice: 'lookup_account', confidence: 0.95 } } };
  });
  const r = await inbound('nari.cho@example.com', '계정 탈퇴 부탁드립니다.');
  assert.deepEqual(asked.keys.sort(), ['delete_now', 'lookup', 'section']);
  assert.ok(asked.input.includes('계정 탈퇴 부탁드립니다'));
  const o = outs(r.caseId)[0];
  assert.equal(o.trace[0].router, true);
  assert.deepEqual(o.trace[0].calls.map((c) => c.tool), ['request_account_deletion', 'read_knowledge_base', 'lookup_account']);
  assert.equal(o.steps, o.trace.length - 1);
  assert.equal(codeMails.length, 1, 'LLM이 다시 보내지 않는다');
  assert.equal(members.get('nari.cho@example.com').status, 'active', '코드 회신 전에는 꺼지지 않는다');
});

test('결정 모델 라우터: 팀 소유자 계정이면 코드를 보내지 않고 모델을 부르지 않고 넘긴다', async () => {
  on(); process.env.TOOL_ROUTER = 'decision';
  decision.use(async () => ({ answers: { delete_now: { type: 'noul', noul: 0.98 }, section: { type: 'choice', choice: 'none', confidence: 0.9 }, lookup: { type: 'choice', choice: 'none', confidence: 0.9 } } }));
  const r = await inbound('hayul.kwon@example.com', '제 계정 탈퇴 처리해 주세요.');
  const o = outs(r.caseId)[0];
  assert.deepEqual([o.needsHandoff, o.handoffReason, o.trace.length], [true, 'human_request', 1]);
  assert.equal(codeMails.length, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM llm_calls WHERE case_id=? AND agent='responder'", r.caseId).n, 0);
});

test('결정 모델 라우터: 확신이 낮거나 실패하면 아무것도 실행하지 않고 원래 ReAct로 간다', async () => {
  on(); process.env.TOOL_ROUTER = 'decision';
  decision.use(async () => ({ answers: { delete_now: { type: 'noul', noul: 0.7 }, section: { type: 'choice', choice: 'account_deletion', confidence: 0.4 }, lookup: { type: 'choice', choice: 'none', confidence: 0.9 } } }));
  const a = await inbound('taeho.yoon@example.com', '계정 탈퇴는 어떻게 하나요?');
  assert.deepEqual(outs(a.caseId)[0].trace[0].calls, []);
  assert.equal(codeMails.length, 0, '0.9 미만이면 보내지 않는다');
  decision.use(async () => null);
  const b = await inbound('jisoo.kang@example.com', '영수증 발급 방법 알려주세요');
  const o = outs(b.caseId)[0];
  assert.deepEqual([o.trace[0].router, o.trace[0].ok], [true, false]);
  assert.ok(o.trace.slice(1).flatMap((s) => s.calls.map((c) => c.tool)).includes('submit_draft'));
});

test('시작 검사: 라우터 값·키·운영의 유료 등급 확인, 탈퇴 툴 값', () => {
  const errs = (env) => preflight(env).errors.join('\n');
  assert.match(errs({ TOOL_ROUTER: 'llm' }), /TOOL_ROUTER=llm/);
  assert.match(errs({ TOOL_ROUTER: 'decision' }), /GEMINI_API_KEY가 비어/);
  assert.doesNotMatch(errs({ TOOL_ROUTER: 'decision', GEMINI_API_KEY: 'k' }), /TOOL_ROUTER|GEMINI/);
  assert.match(errs({ NODE_ENV: 'production', TOOL_ROUTER: 'decision', GEMINI_API_KEY: 'k' }), /DECISION_PAID_TIER=1/);
  assert.doesNotMatch(errs({ NODE_ENV: 'production', TOOL_ROUTER: 'decision', GEMINI_API_KEY: 'k', DECISION_PAID_TIER: '1' }), /DECISION_PAID_TIER/);
  assert.match(errs({ ACCOUNT_DELETE_TOOL: 'yes' }), /ACCOUNT_DELETE_TOOL=yes/);
});
