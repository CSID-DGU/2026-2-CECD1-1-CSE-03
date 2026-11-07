'use strict';
// 콘솔 쓰기 경로·관리자 확인과 정책 L2 게이트(게시·되돌리기·복원, actions 읽기 전용). 실제 HTTP 서버(createServer), :memory: DB, mock LLM.
process.env.MAIL_MOCK_LOG = '0';
process.env.AUTO_SEND = '0';
process.env.ADMIN_USERS = ' Admin , ,other';
for (const k of ['AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'SHADOW_CHANNELS']) delete process.env[k];
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../server/db');
const llm = require('../server/llm');
const kb = require('../server/kb');
const policy = require('../server/policy');
const cfg = require('../server/console');
const { sha256 } = require('../server/config-read');
const { createServer } = require('../server/index');

let server; let base; let port;
before(async () => {
  db.init(':memory:'); llm.use('mock');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port; base = `http://127.0.0.1:${port}`;
});
after(() => { server.closeAllConnections(); server.close(); kb.setReader(null); policy.setReader(null); });
beforeEach(() => db.init(':memory:'));

const api = async (method, p, body, headers = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};
const pol = async (ch, headers) => (await api('GET', `/api/console/policy/${ch}`, undefined, headers)).data;
/** 라이브 팩을 받아 고쳐 게시한다. */
async function publish(ch, mutate, extra = {}) {
  const g = await pol(ch);
  const pack = structuredClone(g.pack ?? JSON.parse(g.shipped));
  mutate(pack);
  return api('POST', `/api/console/policy/${ch}/publish`, { by: 'admin', pack, baseVersion: g.version, note: '테스트', ...extra });
}
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const changes = () => db.get('SELECT COUNT(*) n FROM config_changes').n;
const versionsOfKind = () => db.get("SELECT COUNT(*) n FROM versions WHERE kind LIKE 'policy:%' OR kind LIKE 'kbsrc:%'").n;
/** (channel, intent)에 무수정 승인 SENT 초안 n건. critical건은 치명 태그로 고쳐 승인한 초안. */
function seed(channel, intent, n, critical = 0) {
  const now = db.now(); const caseId = db.uuid();
  db.insert('cases', { id: caseId, channel, customer_email: 'seed@seed.example.com', state: 'CLOSED', created_at: now, updated_at: now });
  for (let i = 0; i < n + critical; i += 1) {
    db.insert('drafts', {
      id: db.uuid(), case_id: caseId, trigger_message_id: 'm', status: 'SENT', intent, action: 'DRAFT', original_body: 'b', idempotency_key: `draft:${db.uuid()}`,
      approved_by: 'h', created_at: now, ...(i >= n ? { final_body: 'x', edit_tags: '["critical"]' } : {}),
    });
  }
}
/** 테스트 도우미 — 검사 없이 라이브 정책 원문을 DB에 넣는다(게시 트랜잭션과 같은 두 행). */
function putLive(ch, pack) {
  const raw = `${JSON.stringify(pack, null, 2)}\n`;
  db.saveVersion(kb.sha(raw), `policy:${ch}`, raw);
  const id = db.uuid();
  db.insert('config_changes', { id, kind: 'policy', channel: ch, language: null, action: 'publish', to_hash: kb.sha(raw), to_sha256: sha256(raw), actor: 'seed', created_at: db.now() });
  return id;
}

test('writeGuard: 가짜 req — LAN 주소·중계 헤더·루프백이 아닌 Host·Origin은 거부, 두 설정이 다 있으면 시크릿이 맞는 요청만', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:3000', ...headers } });
  try {
    process.env.AUTH_USER_HEADER = 'x-user';
    assert.equal(cfg.writeGuard(req('192.168.0.10', { 'x-user': 'admin' })), false);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { 'x-user': 'admin' })), true);
    assert.equal(cfg.writeGuard(req('::ffff:127.0.0.1', { 'x-user': 'admin', 'x-forwarded-for': '10.0.0.1' })), false);
    assert.equal(cfg.writeGuard(req('::1', { forwarded: 'for=10.0.0.1' })), false);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { 'x-real-ip': '10.0.0.1' })), false);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { via: '1.1 edge' })), false);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { host: 'cs.example.org' })), false, 'DNS 재바인딩 — 루프백 소켓이어도 Host가 다르면');
    assert.equal(cfg.writeGuard(req('127.0.0.1', { host: undefined })), false);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { origin: 'http://evil.example' })), false);
    assert.equal(cfg.writeGuard(req('::1', { host: '[::1]:3000', origin: 'http://localhost:3000' })), true);
    process.env.PROXY_SHARED_SECRET = 's3cret';
    assert.equal(cfg.writeGuard(req('192.168.0.10', { 'x-user': 'admin', 'x-proxy-secret': 's3cret' })), true);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { 'x-user': 'admin', 'x-proxy-secret': 'nope' })), false);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { 'x-user': ' ', 'x-proxy-secret': 's3cret' })), false);
    assert.equal(cfg.writeGuard(req('127.0.0.1', { 'x-user': 'admin' })), false, '두 설정이 있으면 루프백도 시크릿이 필요');
  } finally { delete process.env.AUTH_USER_HEADER; delete process.env.PROXY_SHARED_SECRET; }
});

test('HTTP: 믿을 수 없는 경로는 본문을 기다리지 않고 403, 상한을 넘는 content-length는 바로 413, DB 그대로', async () => {
  const raw = (headers) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/console/policy/support/publish', headers: { 'content-type': 'application/json', connection: 'close', ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { resolve({ status: res.statusCode, data: JSON.parse(b) }); r.destroy(); });
    });
    r.on('error', reject);
    r.flushHeaders(); // 본문은 보내지 않는다
  });
  const before0 = changes();
  const t0 = Date.now();
  const denied = await raw({ 'content-length': '15000000', 'x-forwarded-for': '192.168.0.10' });
  assert.deepEqual([denied.status, denied.data.error], [403, 'console_write_untrusted']);
  const big = await raw({ 'content-length': '15000000' });
  assert.deepEqual([big.status, big.data.error], [413, 'body too large']);
  assert.ok(Date.now() - t0 < 2000, '본문을 기다리지 않는다');
  const fwd = await api('POST', '/api/console/policy/support/publish', { by: 'admin' }, { 'x-forwarded-for': '127.0.0.1' });
  assert.deepEqual([fwd.status, fwd.data.error], [403, 'console_write_untrusted']);
  // 루프백 소켓이어도 중계 헤더(x-real-ip·via)나 루프백이 아닌 Host가 있으면 403
  for (const h of [{ 'x-real-ip': '10.0.0.9', via: '1.1 edge' }, { host: 'cs.example.org' }]) {
    const r = await raw(h);
    assert.deepEqual([r.status, r.data.error], [403, 'console_write_untrusted'], JSON.stringify(h));
  }
  // 두 설정을 켜면 시크릿이 맞는 요청만 쓰기 경로를 지난다(시크릿이 틀리면 /api 인증에서 401)
  process.env.AUTH_USER_HEADER = 'x-user'; process.env.PROXY_SHARED_SECRET = 's3cret';
  try {
    const g = await pol('support', { 'x-user': 'admin', 'x-proxy-secret': 's3cret' });
    const bad = await api('POST', '/api/console/policy/support/publish', { pack: g.pack, baseVersion: g.version }, { 'x-user': 'admin', 'x-proxy-secret': 'nope' });
    assert.equal(bad.status, 401);
    const good = await api('POST', '/api/console/policy/support/publish', { pack: { ...g.pack, persona: '새 담당자' }, baseVersion: g.version }, { 'x-user': 'admin', 'x-proxy-secret': 's3cret' });
    assert.equal(good.status, 200, JSON.stringify(good.data));
  } finally { delete process.env.AUTH_USER_HEADER; delete process.env.PROXY_SHARED_SECRET; }
  assert.equal(changes(), before0 + 1);
});

test('관리자가 아니면 모든 콘솔 쓰기 POST가 403 not_admin, ADMIN_USERS가 비면 모두 403, GET은 200', async () => {
  const g = await pol('support');
  const posts = [
    ['/api/console/kb/support/publish', { lang: 'ko', raw: 'x', baseHash: null }], ['/api/console/kb/support/rollback', { changeId: 'x' }], ['/api/console/kb/support/reset', {}],
    ['/api/console/kb/support/drafts', { lang: 'ko', from: 'live' }], ['/api/console/kb/support/convert', { lang: 'ko', filename: 'a.md', contentBase64: '' }],
    ['/api/console/drafts/x/save', { raw: '', revision: 1 }], ['/api/console/drafts/x/publish', {}], ['/api/console/drafts/x/discard', {}],
    ['/api/console/policy/support/publish', { pack: g.pack, baseVersion: g.version }], ['/api/console/policy/support/rollback', { changeId: 'x' }], ['/api/console/policy/support/reset', {}],
  ];
  for (const by of ['someone', undefined]) {
    for (const [p, body] of posts) {
      const r = await api('POST', p, { ...body, by });
      assert.deepEqual([r.status, r.data.error], [403, 'not_admin'], `${p} by=${by}`);
    }
  }
  try {
    process.env.ADMIN_USERS = '';
    cfg.setup();
    for (const [p, body] of posts) assert.equal((await api('POST', p, { ...body, by: 'admin' })).status, 403, p);
  } finally { process.env.ADMIN_USERS = ' Admin , ,other'; cfg.setup(); }
  assert.equal(changes(), 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM kb_drafts').n, 0);
  // GET은 누구나. 관리자 이름은 trim·소문자로 비교한다
  for (const p of ['/api/console', '/api/console/kb/support?lang=ko', '/api/console/policy/support', '/api/console/history', '/api/console/drafts']) assert.equal((await api('GET', p)).status, 200, p);
  const me = (await api('GET', '/api/console?by=ADMIN')).data;
  assert.deepEqual([me.actor, me.writable, me.admin], ['ADMIN', true, true]);
  const lan = (await api('GET', '/api/console?by=admin', undefined, { 'x-forwarded-for': '192.168.0.10' })).data;
  assert.deepEqual([lan.writable, lan.admin], [false, false]);
  // 초안의 추출 원문(sourceText)은 쓰기 경로 + 관리자에게만
  const now = db.now();
  db.insert('kb_drafts', { id: 'd1', channel: 'support', language: 'ko', status: 'ready', origin: 'convert', source_text: '원문', raw: '', created_by: 'admin', created_at: now, updated_at: now });
  assert.equal((await api('GET', '/api/console/drafts/d1?by=admin')).data.sourceText, '원문');
  assert.equal('sourceText' in (await api('GET', '/api/console/drafts/d1?by=someone')).data, false);
  assert.equal('sourceText' in (await api('GET', '/api/console/drafts/d1')).data, false);
  assert.equal('sourceText' in (await api('GET', '/api/console/drafts/d1?by=admin', undefined, { 'x-forwarded-for': '192.168.0.10' })).data, false);
});

test('사용자 헤더가 켜져 있으면 actor는 헤더 값이고 body.by는 무시한다', async () => {
  process.env.AUTH_USER_HEADER = 'x-user';
  try {
    const g = await pol('support', { 'x-user': 'someone' });
    const denied = await api('POST', '/api/console/policy/support/publish', { by: 'admin', pack: g.pack, baseVersion: g.version }, { 'x-user': 'someone' });
    assert.deepEqual([denied.status, denied.data.error], [403, 'not_admin']);
    ok(await api('POST', '/api/console/policy/support/publish', { by: 'someone', pack: { ...g.pack, persona: '헤더' }, baseVersion: g.version }, { 'x-user': 'other' }));
    assert.equal(db.get('SELECT actor FROM config_changes').actor, 'other');
    const me = (await api('GET', '/api/console?by=admin', undefined, { 'x-user': 'other' })).data;
    assert.deepEqual([me.actor, me.admin], ['other', true]);
  } finally { delete process.env.AUTH_USER_HEADER; }
});

test('출하 sales(표본 0건): L2 intent 설명 변경·kb key 추가·언어 추가·label 변경·설명 있는 새 L1 intent는 409 l2_not_eligible, widenings에 경로', async () => {
  const cases = [
    [(p) => { p.intents.service_question.description = '서비스를 묻는다'; }, 'intents.service_question.description'],
    [(p) => { p.intents.service_question.kb.push('materials'); }, 'intents.service_question.kb'],
    [(p) => { p.languages = ['ko', 'en']; }, 'languages'],
    [(p) => { p.label = '영업 문의'; }, 'label'],
    [(p) => { p.intents.new_q = { level: 'L1', description: '무엇이든 자동으로 답한다', kb: [], caseType: 'Question', caseReason: 'other' }; }, 'intents.new_q.description'],
  ];
  for (const [mutate, path] of cases) {
    const r = await publish('sales', mutate);
    assert.equal(r.status, 409, path); assert.equal(r.data.error, 'l2_not_eligible');
    assert.ok(r.data.widenings.some((w) => w.path === path), `${path} ${JSON.stringify(r.data.widenings)}`);
    assert.deepEqual(r.data.blocked.map((b) => b.member).sort(), ['@ack', 'service_question']);
    assert.equal(r.data.blocked[0].reviewed, 0);
  }
  assert.equal(changes(), 0);
});

test('같은 채널의 intent L1로 내리기·금지어 추가는 표본 없이 200', async () => {
  ok(await publish('sales', (p) => { p.guard.forbiddenWords.push('특가'); }));
  ok(await publish('sales', (p) => { p.intents.service_question.level = 'L1'; }));
  assert.equal(policy.load('sales').intents.service_question.level, 'L1');
  assert.equal(changes(), 2);
});

test('확대는 증거가 없으면 409, 하한·구조 위반은 게이트 전에 422', async () => {
  const widen = [
    ['sales', null, (p) => { p.guard.forbiddenWords.shift(); }],
    ['sales', null, (p) => { p.thresholds.maxLength = 700; }],
    ['sales', (p) => { p.thresholds.confidenceMin = 0.9; }, (p) => { p.thresholds.confidenceMin = 0.8; }],
    ['sales', null, (p) => { p.guard.allowDates = true; }],
    ['sales', null, (p) => { p.handoffReasons = p.handoffReasons.filter((r) => r !== 'call_meeting'); p.answerableHandoffReasons = p.answerableHandoffReasons.filter((r) => r !== 'call_meeting'); }], // prefilter 연동 사유
    ['sales', null, (p) => { delete p.intents.complaint; p.handoffReasons = p.handoffReasons.filter((r) => r !== 'complaint'); }],
    ['sales', (p) => { p.maxLevel = 'L1'; }, (p) => { p.maxLevel = 'L2'; }],
    ['sales', (p) => { p.shadow = true; }, (p) => { p.shadow = false; }],
    ['support', null, (p) => { p.intents.feature_howto.description = '기능을 묻는다'; }],
    ['support', null, (p) => { delete p.intents.feature_howto.description; }],
    ['support', null, (p) => { p.handoffReasons = p.handoffReasons.filter((r) => r !== 'account_identity'); }],
    ['support', (p) => { p.answerableHandoffReasons = ['human_request']; }, (p) => { delete p.answerableHandoffReasons; }],
    ['sales', (p) => { p.shadow = true; }, (p) => { delete p.shadow; }],
    ['sales', null, (p) => { delete p.guard.allowQuantities; }],
    ['support', null, (p) => { delete p.answerableHandoffReasons; p.handoffReasons.push('price_contract'); }],
    ['support', (p) => { p.intents.extra_q = { level: 'L1', kb: [], caseType: 'Question', caseReason: 'other' }; }, (p) => { p.intents.extra_q.description = '새 설명'; }],
  ];
  for (const [i, [ch, setup, mutate]] of widen.entries()) {
    db.init(':memory:');
    if (setup) ok(await publish(ch, setup));
    const n = changes();
    const r = await publish(ch, mutate);
    assert.deepEqual([r.status, r.data.error], [409, 'l2_not_eligible'], `#${i} ${JSON.stringify(r.data)}`);
    assert.equal(changes(), n);
  }
  // 확대가 아닌 것 — fill 결과가 라이브와 같은 집합, 설명 없는 새 L1 intent, prefilter 사유 삭제 경고
  db.init(':memory:');
  ok(await publish('support', (p) => { delete p.answerableHandoffReasons; }));
  ok(await publish('support', (p) => { p.intents.new_q = { level: 'L1', kb: [], caseType: 'Question', caseReason: 'other' }; }));
  const chk = (await api('POST', '/api/console/policy/onboarding/check', { pack: { ...(await pol('onboarding')).pack, maxLevel: 'L1', handoffReasons: (await pol('onboarding')).pack.handoffReasons.filter((r) => r !== 'human_request' && r !== 'legal_threat') } })).data;
  assert.ok(chk.problems.some((p) => p.path === 'handoffReasons' && p.rule === 'fixed'));
  // 422 — L2 intent의 kb 삭제(C-1), guard.forbiddenWords 키 삭제
  for (const mutate of [(p) => { delete p.intents.service_question.kb; }, (p) => { delete p.guard.forbiddenWords; }, (p) => { p.thresholds.confidenceMin = 0.7; }]) {
    const r = await publish('sales', mutate);
    assert.deepEqual([r.status, r.data.error], [422, 'invalid'], JSON.stringify(r.data));
    assert.ok(r.data.errors.length);
  }
});

test('경고: prefilter 연동 사유를 빼면 경고, L1 채널에서는 게이트를 통과한다', async () => {
  ok(await publish('sales', (p) => { p.maxLevel = 'L1'; }));
  const r = ok(await publish('sales', (p) => { p.handoffReasons = p.handoffReasons.filter((x) => x !== 'call_meeting'); p.answerableHandoffReasons = p.answerableHandoffReasons.filter((x) => x !== 'call_meeting'); }));
  assert.ok(r.warnings.some((w) => w.code === 'prefilter_off' && w.reason === 'call_meeting'));
});

test('409의 blocked intent를 L1로 바꿔 다시 보내면 200, 채널 확대는 maxLevel L1로 200, demote는 무시', async () => {
  const r1 = await publish('sales', (p) => { p.intents.service_question.description = '설명 변경'; }, { demote: true });
  assert.equal(r1.status, 409);
  const r2 = ok(await publish('sales', (p) => { p.intents.service_question.description = '설명 변경'; p.intents.service_question.level = 'L1'; }));
  const row = db.get('SELECT summary FROM config_changes WHERE id=?', r2.changeId);
  const diff = JSON.parse(row.summary).diff;
  assert.ok(diff.some((d) => d.path === 'intents.service_question.level' && d.from === 'L2' && d.to === 'L1'));
  db.init(':memory:');
  assert.equal((await publish('support', (p) => { p.guard.forbiddenWords.shift(); })).status, 409);
  ok(await publish('support', (p) => { p.guard.forbiddenWords.shift(); p.maxLevel = 'L1'; }));
});

test('persona만 바꾼 게시는 표본 없이 200, 등급 그대로, diff persona·widenings 없음', async () => {
  const r = ok(await publish('support', (p) => { p.persona = '차분한 고객지원 담당.'; }));
  const p = policy.load('support');
  assert.equal(p.maxLevel, 'L2'); assert.equal(p.intents.receipt.level, 'L2'); assert.equal(p.persona, '차분한 고객지원 담당.');
  const s = JSON.parse(db.get('SELECT summary FROM config_changes WHERE id=?', r.changeId).summary);
  assert.deepEqual(s.diff.map((d) => d.path), ['persona']);
  assert.deepEqual(s.gate.widenings, []);
  assert.equal(changes(), 1);
});

test('sales L2 intent 전부와 채널에 표본 50건이면 설명·kb key·언어 세 확대가 성공, 치명 1건이면 다시 409', async () => {
  seed('sales', 'service_question', 50);
  ok(await publish('sales', (p) => { p.intents.service_question.description = '서비스 구성과 진행 순서를 묻는다'; }));
  ok(await publish('sales', (p) => { p.intents.service_question.kb.push('materials'); }));
  ok(await publish('sales', (p) => { p.languages = ['ko', 'en']; }));
  seed('sales', 'service_question', 0, 1);
  const r = await publish('sales', (p) => { p.intents.service_question.description = '또 바꾼다'; });
  assert.deepEqual([r.status, r.data.error], [409, 'l2_not_eligible']);
  assert.equal(r.data.channelCritical, 1);
});

test('치명 오류가 있는 채널도 maxLevel L1로 게시한 뒤에는 금지어 삭제가 표본 없이 200', async () => {
  seed('support', 'receipt', 0, 1);
  ok(await publish('support', (p) => { p.maxLevel = 'L1'; }));
  ok(await publish('support', (p) => { p.guard.forbiddenWords.shift(); }));
});

test('깨진 라이브: L1 게시는 200이고 invalid가 풀린다, L2 유지는 채널 확대 전부로 409, gate 직접 호출', async () => {
  const first = ok(await publish('support', (p) => { p.persona = '깨질 팩'; }));
  db.run('UPDATE versions SET content=content||? WHERE hash=?', ' ', db.get('SELECT to_hash FROM config_changes WHERE id=?', first.changeId).to_hash);
  const g = await pol('support');
  assert.deepEqual([g.invalid, g.raw, g.version], [true, null, null]);
  assert.equal(policy.load('support').maxLevel, 'H', '닫힌 쪽 = 이미지 팩을 H로');
  assert.equal((await api('GET', '/api/health')).data.config, 'invalid');
  const keepL2 = await publish('support', () => {});
  assert.deepEqual([keepL2.status, keepL2.data.error], [409, 'l2_not_eligible']);
  const channelPaths = Object.keys(policy.FIELD_RULES).filter((k) => policy.FIELD_RULES[k].widen === 'channel');
  assert.deepEqual(keepL2.data.widenings.map((w) => w.path).sort(), channelPaths.sort());
  ok(await publish('support', (p) => { p.maxLevel = 'L1'; }));
  assert.equal((await pol('support')).invalid, false);
  assert.equal((await api('GET', '/api/health')).data.config, 'ok');
  const l1 = { ...JSON.parse(policy.shipped('support')), maxLevel: 'L1' };
  assert.equal(cfg.gate({ channel: 'support', live: { raw: '{ broken' }, nextRaw: JSON.stringify(l1) }).pass, true);
  assert.equal(cfg.gate({ channel: 'support', live: { raw: '{ broken', invalid: true }, nextRaw: policy.shipped('support') }).pass, false);
});

test('정책 되돌리기·복원: 같은 게이트, rollback·rollbackOf, reset 뒤 이미지 팩, 내용 변조는 history_mismatch', async () => {
  const c1 = ok(await publish('support', (p) => { p.persona = '첫째'; }));
  const c2 = ok(await publish('support', (p) => { p.persona = '둘째'; }));
  const c3 = ok(await publish('support', (p) => { p.maxLevel = 'L1'; }));
  // 표본 없는 L2가 돌아오는 되돌리기·복원은 409
  const back = await api('POST', '/api/console/policy/support/rollback', { by: 'admin', changeId: c1.changeId, baseVersion: c3.version });
  assert.deepEqual([back.status, back.data.error], [409, 'l2_not_eligible']);
  const reset = await api('POST', '/api/console/policy/support/reset', { by: 'admin', baseVersion: c3.version });
  assert.deepEqual([reset.status, reset.data.error], [409, 'l2_not_eligible']);
  // L1 팩(c3)으로 되돌리기는 좁히는 쪽이라 표본 없이 된다
  const c4 = ok(await publish('support', (p) => { p.persona = '넷째'; }));
  const r = ok(await api('POST', '/api/console/policy/support/rollback', { by: 'admin', changeId: c3.changeId, baseVersion: c4.version }));
  const row = db.get('SELECT action, summary FROM config_changes WHERE id=?', r.changeId);
  assert.equal(row.action, 'rollback'); assert.equal(JSON.parse(row.summary).rollbackOf, c3.changeId);
  assert.equal(r.version, c3.version);
  assert.equal(policy.load('support').persona, '둘째');
  // L2 표본을 채우면 이미지로 복원된다 — reset 행, 다음 load는 이미지 팩
  seed('support', 'account_deletion', 50); seed('support', 'receipt', 50); seed('support', 'cancel_subscription', 50);
  const rs = ok(await api('POST', '/api/console/policy/support/reset', { by: 'admin', baseVersion: r.version }));
  assert.equal(db.get('SELECT action FROM config_changes WHERE id=?', rs.changeId).action, 'reset');
  assert.equal(policy.load('support').version, kb.sha(policy.shipped('support')));
  assert.deepEqual((await api('GET', `/api/console/history/${rs.changeId}`)).data.shipped, true);
  const again = await api('POST', '/api/console/policy/support/reset', { by: 'admin', baseVersion: rs.version });
  assert.deepEqual([again.status, again.data.error], [409, 'already_default']);
  // 되돌리기 대상의 versions 내용이 to_sha256과 어긋나면 409 history_mismatch, 그 대상이 라이브면 invalid
  db.run('UPDATE versions SET content=content||? WHERE hash=?', ' ', c2.version);
  const mm = await api('POST', '/api/console/policy/support/rollback', { by: 'admin', changeId: c2.changeId, baseVersion: rs.version });
  assert.deepEqual([mm.status, mm.data.error], [409, 'history_mismatch']);
  assert.equal((await api('GET', `/api/console/history/${c2.changeId}`)).status, 409);
  assert.equal((await api('POST', '/api/console/policy/support/rollback', { by: 'admin', changeId: 'none', baseVersion: rs.version })).status, 404);
  // stale
  const st = await api('POST', '/api/console/policy/support/reset', { by: 'admin', baseVersion: 'deadbeef' });
  assert.deepEqual([st.status, st.data.error, st.data.current], [409, 'stale', rs.version]);
});

test('actions는 읽기 전용 — 같은 값·뺀 값은 200(라이브 값 그대로), 바꾸거나 다른 intent에 붙이면 422, 되돌리기 왕복', async () => {
  const pack = JSON.parse(policy.shipped('support'));
  pack.intents.receipt.actions = [{ type: 'lookup', target: 'billing' }];
  const seeded = putLive('support', pack);
  const live = () => JSON.stringify(JSON.parse(policy.source('support').raw).intents.receipt.actions);
  const want = JSON.stringify(pack.intents.receipt.actions);
  ok(await publish('support', (p) => { p.persona = 'a'; }));
  assert.equal(live(), want);
  ok(await publish('support', (p) => { delete p.intents.receipt.actions; p.persona = 'b'; }));
  assert.equal(live(), want);
  const n = changes();
  for (const mutate of [(p) => { p.intents.receipt.actions = [{ type: 'other' }]; }, (p) => { p.intents.login_issue.actions = []; }]) {
    const r = await publish('support', mutate);
    assert.deepEqual([r.status, r.data.error], [422, 'actions_readonly']);
  }
  const chk = (await api('POST', '/api/console/policy/support/check', { pack: { ...(await pol('support')).pack, intents: { ...(await pol('support')).pack.intents, login_issue: { ...(await pol('support')).pack.intents.login_issue, actions: [] } } } })).data;
  assert.ok(chk.problems.some((p) => p.path === 'intents.login_issue.actions'));
  assert.equal(changes(), n);
  const g = await pol('support');
  ok(await api('POST', '/api/console/policy/support/rollback', { by: 'admin', changeId: seeded, baseVersion: g.version }));
  assert.equal(live(), want);
});

test('정책 check: problems·diff(rule)·gate를 내고 아무것도 쓰지 않는다', async () => {
  const g = await pol('sales');
  assert.equal(g.shippedVersion, g.version);
  assert.ok(g.kbKeys.includes('about'));
  assert.equal(g.rules.label.maxLen, 40);
  const r = (await api('POST', '/api/console/policy/sales/check', { pack: { ...g.pack, label: '새 이름', intents: { ...g.pack.intents, service_question: { ...g.pack.intents.service_question, kb: [...g.pack.intents.service_question.kb, 'nope_key'] } } } })).data;
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.diff.map((d) => [d.path, d.rule]), [['label', 'free'], ['intents.service_question.kb', 'free']]);
  assert.equal(r.gate.pass, false);
  assert.ok(r.warnings.some((w) => w.code === 'kb_key_missing' && w.key === 'nope_key'));
  assert.equal(changes(), 0); assert.equal(versionsOfKind(), 0);
  assert.equal((await api('GET', '/api/console/policy/nope')).status, 404);
  assert.equal((await api('GET', '/api/console/policy/..%2Fx')).status, 400);
});
