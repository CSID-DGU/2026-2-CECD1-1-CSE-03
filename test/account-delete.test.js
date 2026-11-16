'use strict';
// 계정 탈퇴(soft delete) 툴·회원 저장소·결정 모델 툴 라우터.
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const members = require('../server/members');
const tools = require('../server/agents/tools');
const decision = require('../server/llm/decision');
const { preflight } = require('../server/index');

const BIZ = path.join(__dirname, '..', 'server', 'mock', 'business-data.json');
const ENV = ['ACCOUNT_DELETE_TOOL', 'TOOL_ROUTER', 'BUSINESS_DATA_FILE'];
before(() => { llm.use('mock'); process.env.RESPONDER_MODE = 'react'; });
beforeEach(() => { db.init(':memory:'); for (const k of ENV) delete process.env[k]; decision.use(null); });
after(() => { for (const k of ENV) delete process.env[k]; delete process.env.RESPONDER_MODE; decision.use(null); });

const pack = () => require('../server/policy').load('support');
const kb = () => require('../server/kb').load('support');
const ctx = (email, { auth = 'pass', intent = 'account_deletion', body = '계정 탈퇴 처리해 주세요.' } = {}) => ({
  caseId: 'c-1', case: { customer_email: email, known_facts: '{}' }, rawMessage: { sender: email, sender_auth: auth, body_clean: body },
  message: { body_clean: body }, pack: pack(), kb: kb(), triage: { intent },
});
const names = (c) => tools.defs(c).map((d) => d.name);
const outs = (caseId) => db.all("SELECT output FROM decisions WHERE case_id=? AND step='respond' ORDER BY created_at, rowid", caseId).map((r) => JSON.parse(r.output));

test('회원 저장소: soft delete는 행을 남기고 disabled로, 두 번째는 already, 복구하면 active', () => {
  assert.deepEqual(members.softDelete('Hayul.Kwon@example.com', { by: 'agent:responder', caseId: 'c-1' }), { ok: true, already: false });
  const m = members.get('hayul.kwon@example.com');
  assert.equal(m.status, 'disabled'); assert.ok(m.disabled_at && m.deleted_at); assert.equal(m.deleted_by, 'agent:responder'); assert.equal(m.delete_case_id, 'c-1');
  assert.deepEqual(members.softDelete('hayul.kwon@example.com', { by: 'x' }), { ok: true, already: true });
  assert.equal(members.get('hayul.kwon@example.com').deleted_by, 'agent:responder', '이미 끈 계정은 다시 쓰지 않는다');
  assert.deepEqual(members.restore('hayul.kwon@example.com', { by: 'admin@acme.test' }), { ok: true });
  const r = members.get('hayul.kwon@example.com');
  assert.equal(r.status, 'active'); assert.equal(r.deleted_at, null); assert.equal(r.restored_by, 'admin@acme.test');
  assert.deepEqual(members.restore('hayul.kwon@example.com', { by: 'a' }), { ok: false, error: 'not_disabled' });
});

test('탈퇴 툴은 켜는 값·회원 원본·고객 본인 인증·탈퇴 분류가 모두 맞을 때만 보인다', () => {
  const e = 'hayul.kwon@example.com';
  process.env.BUSINESS_DATA_FILE = BIZ;
  assert.ok(!names(ctx(e)).includes('delete_account'), 'ACCOUNT_DELETE_TOOL 없으면 숨김');
  process.env.ACCOUNT_DELETE_TOOL = '1';
  assert.ok(names(ctx(e)).includes('delete_account'));
  assert.ok(!names(ctx(e, { auth: null })).includes('delete_account'), '발신 인증 없음');
  assert.ok(!names(ctx(e, { auth: 'fail' })).includes('delete_account'), '발신 인증 실패');
  assert.ok(!names(ctx(e, { intent: 'login_issue' })).includes('delete_account'), '탈퇴 분류가 아님');
  delete process.env.BUSINESS_DATA_FILE;
  assert.ok(!names(ctx(e)).includes('delete_account'), '회원 원본 없음');
});

test('탈퇴 툴: 메일에 없는 요청 문장이면 실행하지 않고, 맞으면 끈 뒤 계정 조회가 disabled를 돌려준다', () => {
  process.env.BUSINESS_DATA_FILE = BIZ; process.env.ACCOUNT_DELETE_TOOL = '1';
  const c = ctx('hayul.kwon@example.com', { body: '안녕하세요.\n제 계정 탈퇴 처리해 주세요. 감사합니다.' });
  const run = tools.runner(c);
  for (const q of ['탈퇴해 주세요', '계정 삭제를 원합니다', '안녕하세요. 감사합니다.', '']) {
    const r = run.run('delete_account', { customerQuote: q });
    assert.ok(r.isError, q);
  }
  assert.equal(members.get('hayul.kwon@example.com'), null, '아무것도 바뀌지 않음');
  const ok = run.run('delete_account', { customerQuote: '제 계정 탈퇴 처리해 주세요.' });
  assert.ok(!ok.isError, ok.content);
  assert.deepEqual(JSON.parse(ok.content).disabled, true);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(ok.content), '날짜 없음');
  assert.deepEqual(run.state.actions, [{ type: 'account_disabled', by: 'agent:responder' }]);
  assert.equal(JSON.parse(run.run('lookup_account', {}).content).status, 'disabled');
  assert.equal(JSON.parse(run.run('delete_account', { customerQuote: '제 계정 탈퇴 처리해 주세요.' }).content).already, true);
  assert.equal(run.state.actions.length, 1, '이미 끈 계정은 다시 남기지 않는다');
  assert.ok(tools.runner(ctx('nobody@example.com')).run('delete_account', { customerQuote: '계정 탈퇴 처리해 주세요.' }).isError, '회원 원본에 없는 주소');
});

test('회차 전체: 본인 고객이 탈퇴를 요청하면 답장 Agent가 끄고 확인한 뒤 초안을 내며, 판정 기록에 처리 사실이 남는다', async () => {
  process.env.BUSINESS_DATA_FILE = BIZ; process.env.ACCOUNT_DELETE_TOOL = '1';
  const r = cases.addInbound({ channel: 'support', name: '권하율', from: 'hayul.kwon@example.com', subject: '탈퇴', body: '더 이상 쓰지 않아서요. 제 계정 탈퇴 처리해 주세요.', threadId: 'del-1', providerMessageId: 'del-m1', senderAuth: 'pass' });
  await loop.runCycle(r.caseId, r.messageId);
  const o = outs(r.caseId)[0];
  const called = o.trace.flatMap((s) => s.calls.map((c) => c.tool));
  assert.deepEqual(called.slice(0, 2), ['delete_account', 'lookup_account']);
  assert.deepEqual(o.actions, [{ type: 'account_disabled', by: 'agent:responder' }]);
  assert.equal(members.get('hayul.kwon@example.com').status, 'disabled');
  assert.equal(members.get('hayul.kwon@example.com').delete_case_id, r.caseId);
  // 방법만 묻는 메일은 끄지 않는다
  const q = cases.addInbound({ channel: 'support', name: '박서연', from: 'seoyeon.park@example.com', subject: '탈퇴', body: '계정 탈퇴는 어떻게 하나요?', threadId: 'del-2', providerMessageId: 'del-m2', senderAuth: 'pass' });
  await loop.runCycle(q.caseId, q.messageId);
  assert.equal(members.get('seoyeon.park@example.com'), null);
});

test('결정 모델 라우터: 첫 걸음(탈퇴·절 읽기·계정 조회)을 코드가 실행해 붙이고, 라우터 걸음은 걸음 수에 세지 않는다', async () => {
  process.env.BUSINESS_DATA_FILE = BIZ; process.env.ACCOUNT_DELETE_TOOL = '1'; process.env.TOOL_ROUTER = 'decision';
  let asked = null;
  decision.use(async ({ input, questions }) => {
    asked = { input, keys: Object.keys(questions) };
    return { answers: { delete_now: { type: 'noul', noul: 0.97 }, section: { type: 'choice', choice: 'account_deletion', confidence: 0.92 }, lookup: { type: 'choice', choice: 'lookup_account', confidence: 0.95 } } };
  });
  const r = cases.addInbound({ channel: 'support', name: '권하율', from: 'hayul.kwon@example.com', subject: '탈퇴 요청', body: '계정 탈퇴 부탁드립니다.', threadId: 'rt-1', providerMessageId: 'rt-m1', senderAuth: 'pass' });
  await loop.runCycle(r.caseId, r.messageId);
  assert.deepEqual(asked.keys.sort(), ['delete_now', 'lookup', 'section']);
  assert.ok(asked.input.includes('계정 탈퇴 부탁드립니다'));
  const o = outs(r.caseId)[0];
  assert.equal(o.trace[0].router, true);
  assert.deepEqual(o.trace[0].calls.map((c) => c.tool), ['delete_account', 'read_knowledge_base', 'lookup_account']);
  assert.equal(o.steps, o.trace.length - 1);
  assert.equal(members.get('hayul.kwon@example.com').deleted_by, 'agent:router');
  assert.ok(!o.trace.slice(1).flatMap((s) => s.calls.map((c) => c.tool)).includes('delete_account'), 'LLM이 다시 끄지 않는다');
});

test('결정 모델 라우터: 확신이 낮거나 실패하면 아무것도 실행하지 않고 원래 ReAct로 간다', async () => {
  process.env.BUSINESS_DATA_FILE = BIZ; process.env.ACCOUNT_DELETE_TOOL = '1'; process.env.TOOL_ROUTER = 'decision';
  decision.use(async () => ({ answers: { delete_now: { type: 'noul', noul: 0.7 }, section: { type: 'choice', choice: 'account_deletion', confidence: 0.4 }, lookup: { type: 'choice', choice: 'none', confidence: 0.9 } } }));
  const a = cases.addInbound({ channel: 'support', name: '박서연', from: 'seoyeon.park@example.com', subject: '탈퇴', body: '계정 탈퇴는 어떻게 하나요?', threadId: 'rt-2', providerMessageId: 'rt-m2', senderAuth: 'pass' });
  await loop.runCycle(a.caseId, a.messageId);
  assert.deepEqual(outs(a.caseId)[0].trace[0].calls, []);
  assert.equal(members.get('seoyeon.park@example.com'), null, '0.9 미만이면 끄지 않는다');
  decision.use(async () => null);
  const b = cases.addInbound({ channel: 'support', name: '강지수', from: 'jisoo.kang@example.com', subject: '영수증', body: '영수증 발급 방법 알려주세요', threadId: 'rt-3', providerMessageId: 'rt-m3', senderAuth: 'pass' });
  await loop.runCycle(b.caseId, b.messageId);
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
