'use strict';
// 판단 코어의 실메일 전 안전장치 — 채널 이름 검사, 발신자 인증·문의 폼 게이트, LLM 입력 마스킹·상한, 예산 초과 처리, 메모 마스킹.
process.env.MAIL_MOCK_LOG = '0';
const { test, beforeEach, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const mock = require('../server/llm/mock');
const cases = require('../server/cases');
const loop = require('../server/loop');
const policy = require('../server/policy');
const guard = require('../server/guard');
const kbLoader = require('../server/kb');
const { createServer } = require('../server/index');
const INQ = require('../server/mock/inquiries');

const ENV = ['REQUIRE_SENDER_AUTH', 'NODE_ENV', 'FORM_SENDER_DOMAINS', 'COMPANY_NAME', 'SHADOW_CHANNELS', 'MAIL_PROVIDER', 'INBOUND_SECRET', 'MAIL_MOCK_FAIL'];
beforeEach(() => { db.init(':memory:'); llm.use('mock'); for (const k of ENV) delete process.env[k]; process.env.AUTO_SEND = '1'; });

let n = 0;
async function run(p) {
  n += 1;
  const r = cases.addInbound({ channel: 'support', threadId: `core-${n}`, providerMessageId: `core-m${n}`, ...p });
  const out = await loop.runCycle(r.caseId, r.messageId);
  return {
    ...r, out, c: db.get('SELECT * FROM cases WHERE id=?', r.caseId), m: db.get('SELECT * FROM messages WHERE id=?', r.messageId),
    drafts: db.all('SELECT * FROM drafts WHERE case_id=? ORDER BY rowid', r.caseId),
  };
}
const q = (id) => { const x = INQ.find((i) => i.id === id); return { from: x.from, name: x.name, subject: x.subject, body: x.body }; }; // 1 탈퇴(L2) · 4 환불(넘김) · 8 로그인
const acks = (r) => r.drafts.filter((d) => d.action === 'ACK').length;
const step = (caseId, s) => JSON.parse(db.get('SELECT output FROM decisions WHERE case_id=? AND step=? ORDER BY rowid DESC LIMIT 1', caseId, s).output);
/** 네 에이전트가 provider에 넘긴 실제 요청을 모은다(응답은 mock). */
function spy() {
  const calls = [];
  llm.use({ name: 'spy', json: async (req) => { calls.push(req); return mock.json(req); } });
  return calls;
}

test('채널 이름이 소문자·숫자·_- 밖이면 팩·KB 없음 — /api/inbound는 400(500 아님)', async () => {
  assert.equal(policy.load('../package'), null);
  assert.equal(policy.load('Support'), null);
  assert.ok(policy.load('support'));
  assert.equal(kbLoader.load('../README').text, '');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/inbound`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: '../package', from: 'a@example.com', body: '안녕하세요' }),
    });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('인증 실패(fail) → 1차 거르기에서 sender_unverified 넘김, LLM 호출 0(브리핑 포함), 접수 안내 없음', async () => {
  const calls = spy();
  for (const id of [1, 4]) {
    const r = await run({ ...q(id), senderAuth: 'fail' });
    assert.equal(r.m.sender_auth, 'fail');
    assert.equal(r.c.state, 'HANDED_OFF');
    assert.equal(r.out.reason, 'sender_unverified');
    assert.equal(r.drafts.length, 0, '자동 발송·접수 안내 초안 없음');
    assert.equal(db.get('SELECT reason FROM handoffs WHERE case_id=?', r.caseId).reason, 'sender_unverified');
  }
  assert.equal(calls.length, 0);
});

test('REQUIRE_SENDER_AUTH=1 + 인증 정보 없음 → L2도 승인 대기·넘김에 접수 안내 없음 / pass → 지금처럼 자동 메일', async () => {
  process.env.REQUIRE_SENDER_AUTH = '1';
  const a = await run({ ...q(1), senderAuth: 'maybe' }); // pass·fail 밖의 값은 정보 없음
  assert.equal(a.m.sender_auth, null);
  assert.equal(a.c.state, 'AWAITING_APPROVAL');
  assert.equal(a.drafts[0].status, 'PENDING');
  assert.equal(step(a.caseId, 'gate2').inputs.senderTrusted, false);
  const b = await run(q(4));
  assert.equal(b.c.state, 'HANDED_OFF');
  assert.equal(acks(b), 0);
  const c = await run({ ...q(1), senderAuth: 'pass' });
  assert.equal(c.drafts[0].status, 'SENT');
  assert.equal(c.drafts[0].approved_by, 'agent:auto');
  assert.equal(acks(await run({ ...q(4), senderAuth: 'pass' })), 1);
});

test('설정·NODE_ENV 비움 + 정보 없음 → 지금처럼 자동 발송·접수 안내 / production이면 승인 대기', async () => {
  assert.equal((await run(q(1))).drafts[0].status, 'SENT');
  assert.equal(acks(await run(q(4))), 1);
  process.env.NODE_ENV = 'production';
  assert.equal((await run(q(1))).drafts[0].status, 'PENDING');
  assert.equal(acks(await run(q(4))), 0);
});

test('REQUIRE_SENDER_AUTH 해석·senderTrusted 진리표(form은 설정과 무관하게 미신뢰)', () => {
  for (const v of ['0', 'false', 'OFF', ' no ']) assert.equal(policy.requireSenderAuth({ REQUIRE_SENDER_AUTH: v, NODE_ENV: 'production' }), false, v);
  for (const v of ['1', 'yes', 'ture', 'of']) assert.equal(policy.requireSenderAuth({ REQUIRE_SENDER_AUTH: v }), true, v);
  assert.equal(policy.requireSenderAuth({}), false);
  assert.equal(policy.requireSenderAuth({ REQUIRE_SENDER_AUTH: '', NODE_ENV: 'production' }), true);
  process.env.FORM_SENDER_DOMAINS = ' Forms.example ';
  process.env.REQUIRE_SENDER_AUTH = '0';
  assert.equal(policy.senderTrusted(null, 'a@x.example'), true);
  assert.equal(policy.senderTrusted('pass', 'a@x.example'), true);
  assert.equal(policy.senderTrusted('fail', 'a@x.example'), false);
  assert.equal(policy.senderTrusted('form', 'a@x.example'), false);
  assert.equal(policy.senderTrusted('pass', 'noreply@forms.example'), false);
  assert.equal(policy.senderTrusted('pass', 'noreply@mail.forms.example'), false);
  assert.equal(policy.isFormAddress('a@notforms.example'), false);
});

test('문의 폼 메일 — Reply-To·제목·본문 칸에서 고객 주소를 뽑아 케이스를 연다(sender_auth=form, sender_changed 없음, 자동 발송 없음)', async () => {
  process.env.FORM_SENDER_DOMAINS = 'forms.example';
  const base = { from: '문의폼 <noreply@forms.example>', subject: '[문의] 계정', body: q(1).body, senderAuth: 'pass' };
  for (const [extra, email] of [
    [{ replyTo: 'Kim <Kim@Customer.example>' }, 'kim@customer.example'],
    [{ replyTo: 'noreply@forms.example', subject: '[문의] lee@customer.example 님의 문의' }, 'lee@customer.example'],
    [{ body: `이름: 박고객\n이메일 : park@customer.example\n문의 내용: ${q(1).body}` }, 'park@customer.example'],
  ]) {
    const r = await run({ ...base, ...extra });
    assert.equal(r.c.customer_email, email);
    assert.equal(r.m.sender, email);
    assert.equal(r.m.sender_auth, 'form');
    assert.ok(!db.get("SELECT 1 FROM decisions WHERE case_id=? AND reason='sender_changed'", r.caseId));
    assert.equal(r.drafts[0].status, 'PENDING', '사람 승인 초안만');
    if (extra.body) assert.equal(r.c.customer_name, '박고객');
  }
});

test('문의 폼 메일은 REQUIRE_SENDER_AUTH=0이어도 자동 메일 없음, 주소를 못 뽑으면 unclear 넘김·접수 안내 없음', async () => {
  process.env.FORM_SENDER_DOMAINS = 'forms.example';
  process.env.REQUIRE_SENDER_AUTH = '0';
  const a = await run({ from: 'noreply@forms.example', replyTo: 'kim@customer.example', subject: '문의', body: q(1).body });
  assert.equal(a.drafts[0].status, 'PENDING');
  const b = await run({ from: 'noreply@forms.example', replyTo: 'kim@customer.example', subject: '문의', body: q(4).body });
  assert.equal(b.c.state, 'HANDED_OFF');
  assert.equal(acks(b), 0);
  const c = await run({ from: 'noreply@forms.example', subject: '문의', body: q(4).body });
  assert.equal(c.c.customer_email, 'noreply@forms.example');
  assert.equal(c.m.sender_auth, null);
  assert.equal(c.out.reason, 'unclear');
  assert.equal(acks(c), 0);
});

const PII = {
  rrn: ['900101-1234567', '900101 1234567', '9001011234567'], card: '4111 1111 1111 1111', account: '110-123-456789', passport: 'M12345678',
  order: 'ORD-20261031-0042', email: 'hong.gildong@private.example', phone: '010-2345-6789', intl: '+1 415 555 0100',
  url: 'https://youtube.com/@gildong', address: '서울시 강남구 테헤란로 123', name: '홍길동',
};
const PII_TEXT = `주민번호 ${PII.rrn.join(' / ')}
카드 ${PII.card}, 계좌 ${PII.account}, 여권번호 ${PII.passport}, 주문번호: ${PII.order}
메일 ${PII.email} 연락처 ${PII.phone} 해외 ${PII.intl}
채널 ${PII.url}
주소 ${PII.address}
안내 링크 https://help.example.com/guide 도 봤어요.

${PII.name} 드림`;

test('LLM 입력 마스킹 — 네 에이전트의 실제 요청에 원문 식별자가 없고 KB·KB 링크는 그대로, 긴 본문은 잘린다', async () => {
  const calls = spy();
  const kb = kbLoader.load('support', 'ko');
  const facts = { 주소: PII.address, 여권: PII.passport };
  const a = await run({ from: 'hong@example.com', name: PII.name, subject: '영수증', body: `영수증 발급 방법 알려주세요.\n${PII_TEXT}`, knownFacts: facts });
  await run({ from: 'hong@example.com', name: PII.name, subject: '환불', body: `환불해 주세요.\n${PII_TEXT}`, knownFacts: facts });
  assert.deepEqual([...new Set(calls.map((x) => x.agent))].sort(), ['briefer', 'responder', 'reviewer', 'triage']);
  const raw = [...PII.rrn, PII.card, PII.account, PII.passport, PII.order, PII.email, PII.phone, PII.intl, PII.url, PII.address, PII.name];
  for (const x of calls) for (const v of raw) assert.ok(!`${x.system}\n${x.user}`.includes(v), `${x.agent}: ${v}`);
  const tri = calls.find((x) => x.agent === 'triage').user;
  assert.ok(tri.includes(kb.text), 'KB 본문 그대로');
  assert.ok(tri.includes('https://help.example.com/guide 도 봤어요'), 'KB 링크 그대로');
  for (const t of ['[RRN]', '[CARD]', '[ACCOUNT]', '[PASSPORT]', '[ORDER]', '[CONTACT]', '[LINK]', '[ADDRESS]', '[NAME]']) assert.ok(tri.includes(t), t);
  // 판단 기록 요약은 로컬 기록이라 원문(연락처만 가림) 그대로
  assert.equal(db.get("SELECT input_summary FROM decisions WHERE case_id=? AND step='prefilter'", a.caseId).input_summary, guard.maskContacts(a.m.body_clean.slice(0, 80)));

  calls.length = 0;
  await run({ from: 'long@example.com', subject: '영수증', body: `영수증 발급 문의드립니다. ${'가나다라마'.repeat(900)} TAILEND` });
  const t2 = calls.find((x) => x.agent === 'triage').user;
  assert.ok(t2.includes('[TRUNCATED]'));
  for (const x of calls) assert.ok(!x.user.includes('TAILEND'), x.agent);
});

test('마스킹 오탐 방지 — 날짜·기간·금액·버전·KB 링크·"대로 2번"은 그대로, 전화는 연락처, 회사명 표시명은 이름 가림 안 함', async () => {
  const kbText = kbLoader.load('support', 'ko').text;
  for (const t of ['2026-10-31', '3~5영업일', '1,000원', 'v1.2.3', 'https://help.example.com/guide', '말씀하신대로 2번', '3단계로 1번']) {
    assert.equal(guard.maskPii(t, { name: '김하늘', kbText, company: 'ACME' }), t);
  }
  assert.equal(guard.maskPii('010-1234-5678'), '[CONTACT]');
  assert.equal(guard.maskPii('Kim 입니다. kimchi', { name: 'kim' }), '[NAME] 입니다. kimchi');
  process.env.COMPANY_NAME = 'ACME';
  const calls = spy();
  await run({ from: 'ACME <relay@partner.example>', subject: '전달', body: 'ACME 영수증 발급 방법 알려주세요.' });
  assert.ok(calls.find((x) => x.agent === 'triage').user.includes('ACME 영수증'));
});

test('영어 메일은 가린 뒤에도 en — 분류·접수 안내 모두 영어(토큰·잘림 표지가 ASCII)', async () => {
  const pack = policy.load('support');
  for (const body of [
    'I want a refund for my last payment. Contact me at john.smith@private.example or +1 415 555 0100.\n\nJohn Smith',
    `Please refund my subscription. ${'lorem ipsum dolor '.repeat(250)}`,
  ]) {
    const r = await run({ from: 'john@customer.example', name: 'John Smith', subject: 'Payment', body });
    assert.equal(step(r.caseId, 'triage').language, 'en');
    const ack = r.drafts.find((d) => d.action === 'ACK');
    assert.equal(ack.original_body, pack.ackReply.en);
  }
});

test('토큰이 섞인 초안 본문은 guard unresolved_slot', () => {
  const pack = policy.load('support'); const kb = kbLoader.load('support', 'ko');
  for (const t of ['[CONTACT]', '[NAME]', '[TRUNCATED]']) {
    assert.ok(guard.check({ body: `확인해 보겠습니다. ${t} 기준으로 안내드립니다.`, pack, kb }).some((v) => v.code === 'unresolved_slot'), t);
  }
});

test('일일 토큰 예산 초과(llm_budget)는 재시도 없이 바로 넘김 — next_retry_at NULL, 오류 기록에 budget', async () => {
  llm.use({ name: 'budget', json: async () => { throw Object.assign(new Error('llm_budget'), { code: 'llm_budget', noRetry: true }); } });
  const r = await run(q(8));
  assert.equal(r.c.state, 'HANDED_OFF');
  assert.equal(r.out.reason, 'llm_error');
  assert.equal(db.get('SELECT next_retry_at FROM loops WHERE case_id=?', r.caseId).next_retry_at, null);
  const err = db.get("SELECT action, output FROM decisions WHERE case_id=? AND step='error'", r.caseId);
  assert.equal(err.action, 'HANDOFF');
  assert.equal(JSON.parse(err.output).budget, true);
});

test('메모·섀도 평가 메모의 전화·주민번호는 저장할 때 가린다', async () => {
  process.env.SHADOW_CHANNELS = 'support';
  const r = await run(q(8));
  loop.addNote(r.caseId, { by: 'kim', text: '고객 전화 010-1234-5678, 주민 900101-1234567 확인함' });
  loop.rateShadow(r.drafts.find((d) => d.status === 'SHADOW').id, { by: 'kim', rating: 'good', note: '010-9876-5432로 확인' });
  const p = db.all("SELECT payload FROM activities WHERE case_id=? AND type IN ('note', 'shadow_rating')", r.caseId).map((x) => x.payload).join('\n');
  assert.doesNotMatch(p, /1234-5678|1234567|9876-5432/);
  assert.match(p, /\[CONTACT\]/);
  assert.match(p, /\[RRN\]/);
});

test('문의 폼 메일이어도 인증 실패(fail)는 form으로 덮지 않는다 — sender_unverified 넘김, LLM 호출 0', async () => {
  process.env.FORM_SENDER_DOMAINS = 'forms.example';
  const calls = spy();
  const r = await run({ from: 'noreply@forms.example', subject: '문의', body: '이메일: victim@corp.example\n영수증 발급 방법 알려주세요.', senderAuth: 'fail' });
  assert.equal(r.m.sender_auth, 'fail');
  assert.equal(r.c.customer_email, 'victim@corp.example', '고객 주소는 그대로 뽑는다');
  assert.equal(db.get("SELECT reason FROM decisions WHERE case_id=? AND step='prefilter'", r.caseId).reason, 'sender_unverified');
  assert.equal(r.c.state, 'HANDED_OFF');
  assert.deepEqual(calls, [], 'LLM 호출 없음(브리핑 포함)');
  assert.equal(acks(r), 0);
});

test('이름 가림은 낱말 단위 — KB의 announcement가 Ann을 살리지 않고, 이수증의 이수는 이름이 아니다(호칭·조사가 붙으면 이름)', () => {
  const kbText = 'announcement 이수증 발급 안내';
  const m = (t, name) => guard.maskPii(t, { name, kbText, company: 'ACME' });
  assert.equal(m('Hi, I am Ann. Thanks', 'Ann'), 'Hi, I am [NAME]. Thanks');
  assert.equal(m('Announcement from ann', 'Ann'), 'Announcement from [NAME]');
  assert.equal(m('이수증 발급 부탁드립니다', '이수'), '이수증 발급 부탁드립니다');
  assert.equal(m('이수님, 이수가 이수입니다. 이수씨 이수의 이수를', '이수'), '[NAME]님, [NAME]가 [NAME]입니다. [NAME]씨 [NAME]의 [NAME]를');
  assert.equal(m('이수라고 합니다. 이수랑 이수로 이수에요 이수드림', '이수'), '[NAME]라고 합니다. [NAME]랑 [NAME]로 [NAME]에요 [NAME]드림');
  assert.equal(m('Ann드림, Ann님', 'Ann'), '[NAME]드림, [NAME]님', '영문 이름에 한글이 바로 붙어도 이름');
  assert.equal(m('안내 메일 잘 받았습니다', '안내'), '안내 메일 잘 받았습니다', 'KB에 낱말로 있는 이름은 그대로');
});

test('KB 링크 예외는 링크 전체(경로·질의)로 대조 — KB 호스트라도 ?token=…이 붙으면 가린다', () => {
  const kbText = '자세한 내용은 https://help.acme.example/guide 참고';
  const m = (t) => guard.maskPii(t, { kbText });
  assert.equal(m('https://help.acme.example/guide 봤어요'), 'https://help.acme.example/guide 봤어요');
  assert.equal(m('www.help.acme.example/guide.'), 'www.help.acme.example/guide.');
  assert.equal(m('재설정 https://help.acme.example/reset?token=abc123&email=x 눌렀어요'), '재설정 [LINK] 눌렀어요');
  assert.equal(m('https://help.acme.example/guide?token=abc123'), '[LINK]');
});

test('3음절 이상 한글 이름은 뒤에 무엇이 붙어도 가린다(김철수라고·김철수드림), 앞에 한글이 붙으면 다른 낱말', () => {
  const m = (t) => guard.maskPii(t, { name: '김철수', kbText: kbLoader.load('support', 'ko').text, company: 'ACME' });
  for (const t of ['김철수라고 합니다', '김철수에요', '김철수로 예약했어요', '김철수랑 통화했어요', '김철수드림', '김철수님께', '김철수증']) {
    assert.ok(!m(t).includes('김철수') && m(t).includes('[NAME]'), t);
  }
  assert.equal(m('고객김철수'), '고객김철수');
});

test('표시명이 직함·부서(관리자·고객센터·결제팀·ACME Support)면 이름으로 가리지 않는다 — "관리자 권한"이 "[NAME] 권한"이 되지 않게', () => {
  const m = (name, t) => guard.maskPii(t, { name, kbText: '', company: 'ACME' });
  for (const name of ['관리자', '담당자', '고객센터', '결제팀', '운영팀', '매니저', '대표', '팀장', '환불담당', 'admin', 'Support', 'ACME Support', 'Billing Team', 'manager']) {
    const t = `${name} 권한이 필요하고 ${name}님께 문의했습니다`;
    assert.equal(m(name, t), t, name);
  }
  assert.equal(m('김관리', '김관리님께 문의'), '[NAME]님께 문의', '직함이 아닌 이름은 그대로 가린다');
});

describe('수신 경로별 발신자 인증', () => {
  const ENV = ['AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'MAIL_PROVIDER', 'SHADOW_CHANNELS', 'NODE_ENV', 'ENABLE_TEST_INJECT',
    'REQUIRE_SENDER_AUTH', 'RETENTION_DAYS', 'LLM_DAILY_TOKEN_BUDGET'];
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; process.env.AUTO_SEND = '0'; });
  after(() => { for (const k of ENV) delete process.env[k]; });

  const JSON_H = { 'content-type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } };
  // 수신 응답 뒤에 도는 회차가 끝날 때까지(판단 기록이 생기고 활성 목록에서 빠짐)
  const idle = (caseId) => until(() => db.get('SELECT COUNT(*) n FROM decisions WHERE case_id=?', caseId).n && !loop.status().activeCases.includes(caseId));
  const n = (sql, ...p) => db.get(sql, ...p).n;
  async function withServer(fn) {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
  }
  const post = (base, p, body, h = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { ...JSON_H, ...h }, body: JSON.stringify(body) });

  test('발신자 인증: 주입 경로의 senderAuth는 버리고, 시크릿 웹훅의 fail은 저장 → LLM 없이 넘김(llm_calls 0행)', async () => {
    process.env.INBOUND_SECRET = 's';
    await withServer(async (base) => {
      const a = await (await post(base, '/api/test/inbound', { channel: 'support', from: 'ia@example.com', subject: '영수증', body: '영수증 발급 방법 알려주세요', senderAuth: 'pass' })).json();
      const b = await (await post(base, '/api/inbound', { channel: 'support', from: 'ib@example.com', subject: '탈퇴', body: '탈퇴하고 싶어요', senderAuth: 'fail' }, { 'x-inbound-secret': 's' })).json();
      await idle(a.caseId); await idle(b.caseId);
      assert.equal(db.get('SELECT sender_auth FROM messages WHERE id=?', a.messageId).sender_auth, null);
      assert.ok(n('SELECT COUNT(*) n FROM llm_calls WHERE case_id=?', a.caseId) > 0, '보통 회차는 계량된다(대조군)');
      assert.equal(db.get('SELECT sender_auth FROM messages WHERE id=?', b.messageId).sender_auth, 'fail');
      assert.equal(db.get('SELECT state FROM cases WHERE id=?', b.caseId).state, 'HANDED_OFF');
      assert.equal(db.get('SELECT reason FROM handoffs WHERE case_id=?', b.caseId).reason, 'sender_unverified');
      assert.equal(n('SELECT COUNT(*) n FROM llm_calls WHERE case_id=?', b.caseId), 0);
      assert.equal(n("SELECT COUNT(*) n FROM drafts WHERE case_id=? AND action='ACK'", b.caseId), 0, '접수 안내 없음');
    });
  });
});
