'use strict';
// 원문 파기 — 제자리 가명화가 표지·주소를 전 테이블에서 지우고, 지표·FK는 그대로, 열린 케이스는 건드리지 않는다. 보존 기간 스위퍼·정보주체 스크립트.
process.env.MAIL_MOCK_LOG = '0';
process.env.AUTO_SEND = '0';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const sweeper = require('../server/sweeper');
const retention = require('../server/retention');
const mockMail = require('../server/mail/mock');
const mockLlm = require('../server/llm/mock');
const { createServer } = require('../server/index');

const ROOT = path.join(__dirname, '..');

const MARK = 'ZQXMARK';
const EMAIL = 'zqxmark@example.com';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
before(() => { db.init(':memory:'); llm.use('mock'); });
after(() => { db.init(':memory:'); fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
const add = (body, o = {}) => { n += 1; return cases.addInbound({ channel: 'support', from: `"${MARK}" <${EMAIL}>`, subject: `${MARK} 문의`, body: `${body} ${MARK}`, threadId: `ret-${n}`, knownFacts: { 주문번호: `${MARK}-1` }, ...o }); };
const run = async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; };
const draftOf = (caseId, status) => db.get('SELECT * FROM drafts WHERE case_id=? AND status=?', caseId, status);
const tables = () => db.all("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
const dump = () => Object.fromEntries(tables().map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`).map((r) => ({ ...r }))]));
/** 모든 테이블·칼럼에서 표지·주소(대소문자 무시)가 든 값. */
function leaks() {
  const out = [];
  for (const t of tables()) {
    for (const { name } of db.all(`PRAGMA table_info(${t})`)) {
      const k = db.get(`SELECT COUNT(*) n FROM ${t} WHERE ${name} LIKE ?`, `%${MARK}%`).n;
      if (k) out.push(`${t}.${name}=${k}`);
    }
  }
  return out;
}

const ids = [];
test('보내고·고쳐 승인하고·섀도 평가·폐기·넘김·발송 실패한 케이스를 파기하면 표지·주소가 0건, 지표·FK는 그대로', async () => {
  // 고쳐서 승인(final_body 있음) + 메모
  const a = await run('영수증 발급 부탁드립니다.', { providerMessageId: '<ret-a1@example.com>' });
  const da = draftOf(a.caseId, 'PENDING'); assert.ok(da);
  await loop.approveDraft(da.id, { by: 'h', finalBody: `${da.original_body}\n추가로 확인해 드렸습니다.`, editTags: ['tone'] });
  loop.addNote(a.caseId, { by: 'h', text: `${MARK} 메모` });
  // 무수정 승인(final_body NULL)
  const b = await run('구독 해지 방법 알려주세요');
  await loop.approveDraft(draftOf(b.caseId, 'PENDING').id, { by: 'h' });
  // 섀도 초안 평가(메모 포함)
  process.env.SHADOW_CHANNELS = 'support';
  const c = await run('구독 해지 방법 알려주세요');
  delete process.env.SHADOW_CHANNELS;
  loop.rateShadow(draftOf(c.caseId, 'SHADOW').id, { by: 'h', rating: 'needs_edit', note: `${MARK} 섀도 메모` });
  // 폐기(사유는 자유 텍스트) → 넘김 브리핑
  const d = await run('영수증 발급 부탁드립니다.');
  loop.discardDraft(draftOf(d.caseId, 'PENDING').id, { by: 'h', reason: `${MARK} 폐기 사유` });
  // 넘김
  const e = await run('환불해 주세요');
  assert.ok(db.get('SELECT 1 FROM handoffs WHERE case_id=?', e.caseId));
  // 직접 답장 발송 실패 — SMTP 거부 문구에 수신 주소가 남는다
  const f = add('로그인이 안 됩니다');
  const orig = mockMail.send;
  mockMail.send = async ({ to }) => { throw new Error(`550 5.1.1 <${to}>: Recipient address rejected`); };
  try { await assert.rejects(loop.humanReply(f.caseId, { by: 'h', body: `${MARK} 직접 답장` }), (err) => err.status === 502); } finally { mockMail.send = orig; }
  assert.ok(db.get("SELECT 1 FROM dispatches WHERE status='FAILED' AND error LIKE ?", `%${EMAIL}%`));

  for (const r of [a, b, c, d, e, f]) { loop.closeCase(r.caseId, { by: 'h' }); ids.push(r.caseId); }
  assert.ok(leaks().length > 5);
  const stats = cases.stats(); const promo = cases.promotion('support');
  for (const id of ids) assert.equal(retention.purge(id, { reason: 'test', actor: 'h' }), true);

  assert.deepEqual(leaks(), []);
  assert.deepEqual(cases.stats(), stats);
  assert.deepEqual(cases.promotion('support'), promo);
  assert.equal(db.get("SELECT final_body FROM drafts WHERE case_id=? AND status='SENT'", a.caseId).final_body, '', '고친 승인은 고친 승인으로 남는다');
  assert.equal(db.get("SELECT final_body FROM drafts WHERE case_id=? AND status='SENT'", b.caseId).final_body, null);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  assert.equal(db.get('SELECT COUNT(*) n FROM case_threads WHERE case_id IN (?,?,?,?,?,?)', ...ids).n, 0);
  const c0 = db.get('SELECT * FROM cases WHERE id=?', a.caseId);
  assert.ok(c0.purged_at); assert.equal(c0.state, 'CLOSED'); assert.equal(c0.customer_email, '');
  // 활동은 허용 목록만: 폐기 사유는 빠지고 draftId는 남는다, 파기 행이 하나
  assert.deepEqual(Object.keys(JSON.parse(db.get("SELECT payload FROM activities WHERE case_id=? AND type='discard'", d.caseId).payload)), ['draftId']);
  assert.deepEqual(JSON.parse(db.get("SELECT payload FROM activities WHERE case_id=? AND type='purge'", a.caseId).payload), { reason: 'test' });
  assert.equal(db.get("SELECT payload FROM activities WHERE case_id=? AND type='note'", a.caseId).payload, '{}');
});

test('두 번 파기해도 행이 바뀌지 않는다', () => {
  const snap = dump();
  for (const id of ids) assert.equal(retention.purge(id, { reason: 'test', actor: 'h' }), false);
  assert.deepEqual(dump(), snap);
});

test('파기된 케이스의 옛 스레드·In-Reply-To로 온 회신은 새 케이스가 된다', () => {
  const r = cases.addInbound({ channel: 'support', from: 'other@example.com', body: '다시 문의드립니다', threadId: 'ret-1', inReplyTo: '<ret-a1@example.com>' });
  assert.equal(r.created, true); assert.notEqual(r.caseId, ids[0]);
});

test('파기된 케이스는 서비스 함수가 직접 거부한다 — 메모·섀도 평가·인수·반환·재오픈·종결·직접 답장 모두 409 purged, 행은 그대로', async () => {
  process.env.SHADOW_CHANNELS = 'support';
  const s = await run('구독 해지 방법 알려주세요');
  delete process.env.SHADOW_CHANNELS;
  const h = await run('환불해 주세요'); // 넘김 — 사람 전담
  for (const r of [s, h]) { loop.closeCase(r.caseId, { by: 'h' }); assert.equal(retention.purge(r.caseId, { reason: 'test', actor: 'h' }), true); }
  const snap = dump();
  const purged = (e) => e.status === 409 && e.message === 'purged';
  assert.throws(() => loop.addNote(s.caseId, { by: 'h', text: '메모' }), purged);
  assert.throws(() => loop.rateShadow(draftOf(s.caseId, 'SHADOW').id, { by: 'h', rating: 'good' }), purged);
  assert.throws(() => loop.takeover(s.caseId, { by: 'h' }), purged);
  assert.throws(() => loop.closeCase(s.caseId, { by: 'h' }), purged);
  await assert.rejects(loop.reopenCase(s.caseId, { by: 'h' }), purged);
  await assert.rejects(loop.returnToAgent(h.caseId, { by: 'h' }), purged);
  await assert.rejects(loop.humanReply(h.caseId, { by: 'h', body: '안녕하세요' }), purged);
  assert.deepEqual(dump(), snap);
});

test('파기는 LLM 재시도 예약·회차 claim을 지운다 — 스위퍼·재시작 복구가 파기된 케이스에 회차를 다시 돌리지 않는다', async () => {
  llm.use({ name: 'down', json: async () => { throw Object.assign(new Error('boom'), { noRetry: true }); } });
  let r;
  try { r = await run('영수증 발급 부탁드립니다.'); } finally { llm.use('mock'); }
  assert.ok(db.get('SELECT next_retry_at FROM loops WHERE case_id=?', r.caseId).next_retry_at, '재시도 예약됨');
  loop.closeCase(r.caseId, { by: 'h' });
  assert.equal(retention.purge(r.caseId, { reason: 'test', actor: 'h' }), true);
  assert.deepEqual({ ...db.get('SELECT next_retry_at, retry_count, retry_message_id FROM loops WHERE case_id=?', r.caseId) }, { next_retry_at: null, retry_count: 0, retry_message_id: null });
  assert.equal(db.get('SELECT COUNT(*) n FROM claims WHERE key LIKE ?', `loop:${r.caseId}:%`).n, 0);
  const snap = dump();
  await sweeper.tick(Date.now() + 3_600_000);
  await loop.recover();
  assert.deepEqual(dump(), snap, '판단·상태가 그대로(다시 열리지 않는다)');
});

test('회차가 도는 중(리스)인 케이스는 파기하지 않는다 — 회차가 끝난 뒤 파기', async () => {
  let release; const gate = new Promise((res) => { release = res; });
  llm.use({ name: 'slow', json: async (req) => { await gate; return mockLlm.json(req); } });
  try {
    const r = add('영수증 발급 부탁드립니다.');
    const running = loop.runCycle(r.caseId, r.messageId); // LLM 응답을 기다리는 중
    loop.closeCase(r.caseId, { by: 'h' }); // 회차 도중 종결
    const snap = dump();
    assert.equal(retention.purge(r.caseId, { reason: 'test', actor: 'h' }), false);
    assert.deepEqual(dump(), snap);
    release(); await running;
    assert.equal(retention.purge(r.caseId, { reason: 'test', actor: 'h' }), true);
  } finally { release(); llm.use('mock'); }
});

test('종결이 아니면(검사 뒤 회신으로 다시 열린 경우 포함) 파기하지 않고 행도 안 바뀐다', () => {
  const open = add('영수증 발급 부탁드립니다.');
  let snap = dump();
  assert.equal(retention.purge(open.caseId, { reason: 'test', actor: 'h' }), false);
  assert.deepEqual(dump(), snap);
  loop.closeCase(open.caseId, { by: 'h' });
  assert.equal(retention.findSubject(EMAIL).find((c) => c.id === open.caseId).state, 'CLOSED');
  const reply = cases.addInbound({ channel: 'support', from: EMAIL, body: '하나 더 여쭤봅니다', threadId: `ret-${n}` }); // 검사와 파기 사이 회신
  assert.equal(reply.caseId, open.caseId);
  snap = dump();
  assert.equal(retention.purge(open.caseId, { reason: 'test', actor: 'h' }), false);
  assert.deepEqual(dump(), snap);
  assert.equal(db.get('SELECT body FROM messages WHERE id=?', reply.messageId).body, '하나 더 여쭤봅니다');
});

test('RETENTION_DAYS: 비었거나 1 이상 정수가 아니면 끔', () => {
  for (const v of [undefined, '', ' ', '0', '-3', '1.5', 'abc', '30일']) assert.equal(retention.days({ RETENTION_DAYS: v }), null, `${v}`);
  assert.equal(retention.days({}), null);
  assert.equal(retention.days({ RETENTION_DAYS: '30' }), 30);
});

test('스위퍼: 보존 기간이 꺼져 있으면 안 지우고, =30이면 종결 31일 지난 것만 지운다', async () => {
  const ago = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  const old = add('영수증 발급 부탁드립니다.'); const recent = add('영수증 발급 부탁드립니다.');
  db.run("UPDATE cases SET state='CLOSED', closed_at=? WHERE id=?", ago(31), old.caseId);
  db.run("UPDATE cases SET state='CLOSED', closed_at=? WHERE id=?", ago(29), recent.caseId);
  const waiting = await run('영수증 발급 부탁드립니다.'); // 승인 대기
  const opened = add('로그인이 안 됩니다');
  const purged = (id) => !!db.get('SELECT purged_at FROM cases WHERE id=?', id).purged_at;
  delete process.env.RETENTION_DAYS;
  assert.equal((await sweeper.tick()).purged, 0);
  assert.equal(purged(old.caseId), false);
  process.env.RETENTION_DAYS = '30';
  try {
    assert.equal((await sweeper.tick()).purged, 1);
  } finally { delete process.env.RETENTION_DAYS; }
  assert.equal(purged(old.caseId), true);
  assert.equal(purged(recent.caseId), false);
  assert.equal(db.get('SELECT state FROM cases WHERE id=?', waiting.caseId).state, 'AWAITING_APPROVAL');
  for (const id of [waiting.caseId, opened.caseId]) assert.equal(purged(id), false);
});

test('정보주체 스크립트: 열린 케이스가 있으면 delete가 exit 1, 종결 뒤에는 파기한다', () => {
  const file = path.join(tmp, 'cs.db');
  db.init(file);
  const email = 'subject@example.com';
  const r = cases.addInbound({ channel: 'support', from: email, body: '탈퇴하고 싶어요', threadId: 'sr-1' });
  const cli = (...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'subject-request.js'), ...args],
    { env: { ...process.env, DB_PATH: file }, cwd: tmp, encoding: 'utf8' });
  assert.equal(cli('export', email).status, 2, 'export도 --by 필수');
  const ex = cli('export', email, '--by', 'dpo');
  assert.equal(ex.status, 0, ex.stderr);
  assert.equal(JSON.parse(ex.stdout)[0].messages[0].body, '탈퇴하고 싶어요');
  assert.equal(cli('delete', email).status, 2, '--by 필수');
  let del = cli('delete', email, '--by', 'dpo');
  assert.equal(del.status, 1); assert.equal(del.stdout.trim(), r.caseId);
  assert.equal(db.get('SELECT purged_at FROM cases WHERE id=?', r.caseId).purged_at, null);
  loop.closeCase(r.caseId, { by: 'h' });
  // 종결됐지만 회차가 리스를 쥐고 있으면 건너뛰고, 사유는 "다시 열림"이 아니라 "회차가 도는 중"
  db.run('UPDATE loops SET lease_until=? WHERE case_id=?', new Date(Date.now() + 60_000).toISOString(), r.caseId);
  del = cli('delete', email, '--by', 'dpo');
  assert.equal(del.status, 1); assert.equal(del.stdout.trim(), r.caseId);
  assert.match(del.stderr, /건너뜀 1건\(회차가 도는 중 1건/); assert.doesNotMatch(del.stderr, /다시 열/);
  db.run('UPDATE loops SET lease_until=NULL WHERE case_id=?', r.caseId);
  del = cli('delete', email, '--by', 'dpo');
  assert.equal(del.status, 0, del.stderr);
  const c = db.get('SELECT purged_at, customer_email FROM cases WHERE id=?', r.caseId);
  assert.ok(c.purged_at); assert.equal(c.customer_email, '');
  assert.equal(db.get("SELECT actor FROM activities WHERE case_id=? AND type='purge'", r.caseId).actor, 'dpo');
  // 파기 뒤 WAL을 비웠다 — 원문이 WAL·DB 파일 어디에도 없다
  for (const f of [file, `${file}-wal`]) assert.ok(!fs.existsSync(f) || !fs.readFileSync(f).includes(Buffer.from('탈퇴하고 싶어요')), f);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => !f.startsWith('cs.db') && f !== 'access.jsonl'), []);
});

test('파일 DB: secure_delete 켜짐, 보존 기간 파기 뒤 원문이 DB 파일·WAL 어디에도 없다', () => {
  const file = path.join(fs.mkdtempSync(path.join(tmp, 'wal-')), 'cs.db');
  db.init(file);
  try {
    assert.equal(db.get('PRAGMA secure_delete').secure_delete, 1);
    const SECRET = 'QQSECRETBODYQQ';
    const r = cases.addInbound({ channel: 'support', from: 'wal@example.com', subject: SECRET, body: `${SECRET} 영수증 발급 부탁드립니다`, threadId: 'wal-1' });
    db.run("UPDATE cases SET state='CLOSED', closed_at=? WHERE id=?", new Date(Date.now() - 40 * 86_400_000).toISOString(), r.caseId);
    assert.equal(retention.purgeExpired(Date.now(), 30), 1);
    for (const f of [file, `${file}-wal`]) assert.ok(!fs.existsSync(f) || !fs.readFileSync(f).includes(Buffer.from(SECRET)), f);
  } finally { db.init(':memory:'); }
});

describe('파기된 케이스 409와 정보주체 스크립트', () => {
  const ENV = ['AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'MAIL_PROVIDER', 'SHADOW_CHANNELS', 'NODE_ENV', 'ENABLE_TEST_INJECT',
    'REQUIRE_SENDER_AUTH', 'RETENTION_DAYS', 'LLM_DAILY_TOKEN_BUDGET'];
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; process.env.AUTO_SEND = '0'; });
  after(() => { for (const k of ENV) delete process.env[k]; });

  const JSON_H = { 'content-type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } };
  const n = (sql, ...p) => db.get(sql, ...p).n;
  async function withServer(fn) {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); server.close(); }
  }
  const post = (base, p, body, h = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { ...JSON_H, ...h }, body: JSON.stringify(body) });

  test('파기된 케이스: 케이스·초안 POST는 전부 409 purged, 조회는 그대로, 파기 안 된 케이스는 영향 없음', async () => {
    const mk = async (from) => {
      const r = cases.addInbound({ channel: 'support', from, subject: '영수증', body: '영수증 발급 방법 알려주세요' });
      await loop.runCycle(r.caseId, r.messageId);
      return { caseId: r.caseId, draftId: db.get('SELECT id FROM drafts WHERE case_id=? ORDER BY created_at DESC LIMIT 1', r.caseId).id };
    };
    const gone = await mk('pg@example.com');
    const live = await mk('pl@example.com');
    loop.closeCase(gone.caseId, { by: 'h' });
    assert.equal(retention.purge(gone.caseId, { reason: 'test', actor: 't' }), true);
    const acts = () => n('SELECT COUNT(*) n FROM activities WHERE case_id=?', gone.caseId);
    const before = acts();
    await withServer(async (base) => {
      const body = { by: 'h', text: '확인했습니다', rating: 'good' };
      for (const a of ['human-reply', 'note', 'takeover', 'hold', 'unhold', 'return', 'close']) {
        const r = await post(base, `/api/cases/${gone.caseId}/${a}`, body);
        assert.equal(r.status, 409, a); assert.deepEqual(await r.json(), { error: 'purged' });
      }
      for (const a of ['rate', 'approve', 'discard', 'resolve-sending']) {
        const r = await post(base, `/api/drafts/${gone.draftId}/${a}`, body);
        assert.equal(r.status, 409, a); assert.deepEqual(await r.json(), { error: 'purged' });
      }
      assert.equal((await fetch(`${base}/api/cases/${gone.caseId}`)).status, 200);
      assert.equal((await post(base, `/api/cases/${live.caseId}/note`, body)).status, 200);
    });
    assert.equal(acts(), before, '파기된 케이스에 활동 기록이 늘지 않음');
  });

  test('정보주체 스크립트: export·delete가 DB 폴더의 접속기록에 한 줄씩, 작업 폴더에는 없음', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'subj-'));
    const cwd = fs.mkdtempSync(path.join(tmp, 'subj-cwd-'));
    const file = path.join(dir, 'cs.db');
    const email = 'subj@example.com';
    db.init(file);
    try {
      const r = cases.addInbound({ channel: 'support', from: email, body: '탈퇴하고 싶어요' });
      loop.closeCase(r.caseId, { by: 'h' });
      const cli = (...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'subject-request.js'), ...args],
        { env: { ...process.env, DB_PATH: file }, cwd, encoding: 'utf8' });
      assert.equal(cli('export', email, '--by', 'dpo').status, 0);
      const del = cli('delete', email, '--by', 'dpo');
      assert.equal(del.status, 0, del.stderr);
    } finally { db.init(':memory:'); }
    const lines = fs.readFileSync(path.join(dir, 'access.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map(({ action, by, cases: c }) => ({ action, by, cases: c })), [
      { action: 'subject.export', by: 'dpo', cases: 1 }, { action: 'subject.delete', by: 'dpo', cases: 1 },
    ]);
    for (const l of lines) assert.ok(l.at && 'ip' in l && 'user' in l, JSON.stringify(l));
    assert.ok(!JSON.stringify(lines).includes(email), '고객 주소 없음');
    assert.equal(fs.existsSync(path.join(cwd, 'access.jsonl')), false);
  });
});
