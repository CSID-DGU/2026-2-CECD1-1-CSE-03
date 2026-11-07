'use strict';
// SMTP provider — 네트워크 없이 프로세스 내 가짜 SMTP 서버(net/tls, 포트 0)로 검증.
// STARTTLS/암묵적 TLS 케이스는 openssl로 메모리상 자체서명 인증서를 만들 수 있을 때만 돈다(디스크에 아무것도 안 씀).
process.env.MAIL_MOCK_LOG = '0';
const { test, beforeEach, afterEach, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const smtp = require('../server/mail/smtp');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const mail = require('../server/mail');
const { createServer } = require('../server/index');

const FROM = 'ACME 상담 <support@acme.example>';

// --- env 격리: 매 테스트 전 SMTP_* 비우고, 후에 원래 값 복원 ---
const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SMTP_')));
const clearEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('SMTP_')) delete process.env[k]; };
beforeEach(clearEnv);
afterEach(() => { clearEnv(); Object.assign(process.env, saved); });
const setEnv = (srv, extra = {}) => Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(srv.port), SMTP_FROM: FROM }, extra);

// --- 자체서명 인증서(메모리) ---
function genCert() {
  try {
    const out = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/dev/stdout', '-out', '/dev/stdout', '-subj', '/CN=localhost', '-days', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const key = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/.exec(out)?.[0];
    const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(out)?.[0];
    return key && cert ? { key, cert } : null;
  } catch { return null; }
}
const pems = genCert();
const needTls = { skip: !pems && 'openssl 없음 — TLS 케이스 건너뜀' };

// --- 가짜 SMTP 서버 ---
// opt: starttls(STARTTLS 광고·수락), implicitTls, mechs(AUTH 광고), auth(AUTH PLAIN 응답 덮어쓰기), rcpt(RCPT 응답 덮어쓰기), silent(인사 안 함)
async function fakeServer(opt = {}) {
  const rec = { conns: 0, cmds: [], data: [], closed: 0 };
  const handle = (sock, secured, greet) => {
    let buf = '';
    let inData = false;
    let data = '';
    let login = 0;
    const w = (s) => sock.write(`${s}\r\n`);
    if (greet && !opt.silent) w('220 fake ESMTP ready');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          rec.data.push(`${buf.slice(0, i + 2)}`.replace(/\r\n\.\./g, '\r\n.')); // dot-unstuff
          buf = buf.slice(i + 5);
          inData = false;
          w('250 queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const up = line.toUpperCase();
        if (login === 1) { login = 2; rec.cmds.push('LOGIN-USER ' + line); w('334 UGFzc3dvcmQ6'); continue; }
        if (login === 2) { login = 0; rec.cmds.push('LOGIN-PASS ' + line); w('235 ok'); continue; }
        rec.cmds.push(line);
        if (up.startsWith('EHLO')) {
          w('250-fake');
          if (opt.starttls && !secured) w('250-STARTTLS');
          w(`250-AUTH ${opt.mechs || 'PLAIN LOGIN'}`);
          w('250 8BITMIME');
        } else if (up === 'STARTTLS') {
          w('220 go ahead');
          sock.removeAllListeners('data');
          sock.pause();
          const t = new tls.TLSSocket(sock, { isServer: true, secureContext: tls.createSecureContext(pems) });
          t.on('error', () => {});
          handle(t, true, false);
          return;
        } else if (up.startsWith('AUTH PLAIN')) w(opt.auth || '235 ok');
        else if (up === 'AUTH LOGIN') { login = 1; w('334 VXNlcm5hbWU6'); } else if (up.startsWith('MAIL FROM:')) w('250 ok');
        else if (up.startsWith('RCPT TO:')) w(opt.rcpt || '250 ok');
        else if (up === 'DATA') { inData = true; w('354 go'); } else if (up === 'QUIT') { w('221 bye'); sock.end(); } else w('500 what');
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { rec.closed++; });
  };
  const onConn = (sock) => { rec.conns++; handle(sock, !!opt.implicitTls, true); };
  const server = opt.implicitTls ? tls.createServer(pems, onConn) : net.createServer(onConn);
  server.on('tlsClientError', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { rec, port: server.address().port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

// 수신 메시지 파싱: 헤더 펼치기 + RFC 2047 디코드
const unfold = (s) => s.replace(/\r\n[ \t]+/g, ' ');
function parseMsg(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = {};
  for (const l of unfold(head).split('\r\n')) { const i = l.indexOf(':'); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  return { headers, rawHead: head, bodyB64: rest.join('\r\n\r\n') };
}
const decodeWords = (s) => s.replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8')); // 인접 encoded-word 사이 공백만 무시(RFC 2047)
const msg = (over = {}) => ({ to: 'user@example.com', subject: '환불 문의에 대한 답변드립니다. 주문번호 확인 후 안내해 드립니다', body: '안녕하세요.\n.점으로 시작하는 줄\n' + '긴 본문입니다. '.repeat(30), idempotencyKey: 'case-1:attempt-1', ...over });

test('평문 모드(SMTP_ALLOW_PLAIN=1): 봉투·AUTH PLAIN·본문 왕복·Message-ID 결정적', async () => {
  const srv = await fakeServer();
  setEnv(srv, { SMTP_ALLOW_PLAIN: '1', SMTP_USER: 'bot@acme.example', SMTP_PASS: 'p@ss/word' });
  try {
    const m = msg();
    const r1 = await smtp.send(m);
    const r2 = await smtp.send(m);
    const r3 = await smtp.send(msg({ idempotencyKey: 'other' }));
    assert.equal(r1.provider, 'smtp');
    assert.match(r1.id, /^<[0-9a-f]{24}@acme\.example>$/);
    assert.equal(r1.id, r2.id); // 같은 키 → 같은 Message-ID
    assert.notEqual(r1.id, r3.id);

    const c = srv.rec.cmds;
    assert.match(c[0], /^EHLO [A-Za-z0-9.-]+$/);
    const auth = c.find((x) => x.startsWith('AUTH PLAIN '));
    assert.equal(Buffer.from(auth.split(' ')[2], 'base64').toString(), '\0bot@acme.example\0p@ss/word');
    assert.ok(c.includes('MAIL FROM:<support@acme.example>'));
    assert.ok(c.includes('RCPT TO:<user@example.com>'));
    assert.equal(c.at(-1), 'QUIT');
    assert.ok(!JSON.stringify(c.filter((x) => !x.startsWith('AUTH'))).includes('p@ss')); // 비밀번호는 AUTH 줄에만

    const p = parseMsg(srv.rec.data[0]);
    assert.equal(p.headers['message-id'], r1.id);
    assert.equal(parseMsg(srv.rec.data[1]).headers['message-id'], r1.id);
    assert.equal(decodeWords(p.headers.subject), m.subject);
    assert.equal(decodeWords(p.headers.from), 'ACME 상담 <support@acme.example>');
    assert.equal(p.headers.to, 'user@example.com');
    assert.match(p.headers.date, /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d \+0000$/);
    assert.equal(p.headers['mime-version'], '1.0');
    assert.equal(p.headers['content-type'], 'text/plain; charset=UTF-8');
    assert.equal(p.headers['content-transfer-encoding'], 'base64');
    assert.equal(p.headers['auto-submitted'], undefined);
    assert.equal(p.headers.bcc, undefined);
    for (const l of srv.rec.data[0].split('\r\n')) assert.ok(l.length <= 78, `줄이 너무 김: ${l.length}`);
    assert.ok(p.rawHead.includes('\r\n =?UTF-8?B?')); // 긴 비ASCII 제목은 폴딩됨
    const b64 = p.bodyB64.replace(/\r\n$/, '');
    assert.ok(b64.split('\r\n').every((l) => l.length <= 76));
    assert.equal(Buffer.from(b64, 'base64').toString('utf8'), m.body.replace(/\n/g, '\r\n'));
  } finally { await srv.close(); }
});

test('RCPT 550 → rcpt 550 으로 거부, 자격증명 없으면 AUTH 안 보냄, QUIT 정리', async () => {
  const srv = await fakeServer({ rcpt: '550 no such user' });
  setEnv(srv, { SMTP_ALLOW_PLAIN: '1' });
  try {
    await assert.rejects(smtp.send(msg()), /rcpt 550/);
    assert.ok(!srv.rec.cmds.some((x) => x.startsWith('AUTH')));
    assert.ok(!srv.rec.cmds.includes('DATA'));
    assert.equal(srv.rec.cmds.at(-1), 'QUIT');
  } finally { await srv.close(); }
});

test('STARTTLS 미광고 + SMTP_ALLOW_PLAIN 없음 → starttls required, 메일·인증 명령 전에 중단', async () => {
  const srv = await fakeServer();
  setEnv(srv, { SMTP_USER: 'u', SMTP_PASS: 'p' });
  try {
    await assert.rejects(smtp.send(msg()), /starttls required/);
    assert.ok(!srv.rec.cmds.some((x) => /^(AUTH|MAIL|RCPT|DATA)/.test(x)));
  } finally { await srv.close(); }
});

test('헤더 주입: subject/to의 CR·LF, 다중 수신자는 접속 전에 거부', async () => {
  const srv = await fakeServer();
  setEnv(srv, { SMTP_ALLOW_PLAIN: '1' });
  try {
    await assert.rejects(smtp.send(msg({ subject: '안녕\r\nBcc: x@y' })), /invalid subject/);
    await assert.rejects(smtp.send(msg({ subject: 'hi\nBcc: x@y' })), /invalid subject/);
    await assert.rejects(smtp.send(msg({ to: 'a@example.com\r\nBcc: x@y.com' })), /invalid to/);
    await assert.rejects(smtp.send(msg({ to: 'a@example.com,b@example.com' })), /invalid to/);
    await assert.rejects(smtp.send(msg({ to: 'Name <a@example.com>' })), /invalid to/);
    process.env.SMTP_FROM = 'ACME <a@example.com>\r\nBcc: x@y.com';
    await assert.rejects(smtp.send(msg()), /invalid from/);
    assert.equal(srv.rec.conns, 0);
  } finally { await srv.close(); }
});

test('타임아웃: 인사 없이 붙잡고 있는 서버 → timeout, 소켓 정리', async () => {
  const srv = await fakeServer({ silent: true });
  setEnv(srv, { SMTP_ALLOW_PLAIN: '1', SMTP_TIMEOUT_MS: '200' });
  try {
    const t0 = Date.now();
    await assert.rejects(smtp.send(msg()), /timeout/);
    assert.ok(Date.now() - t0 < 2000);
    for (let i = 0; i < 50 && srv.rec.closed < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(srv.rec.closed, 1); // 클라이언트가 소켓을 닫음
  } finally { await srv.close(); }
});

test('AUTH PLAIN 미광고(LOGIN만) → AUTH LOGIN 폴백', async () => {
  const srv = await fakeServer({ mechs: 'LOGIN' });
  setEnv(srv, { SMTP_ALLOW_PLAIN: '1', SMTP_USER: 'bot', SMTP_PASS: 'pw' });
  try {
    await smtp.send(msg());
    const c = srv.rec.cmds;
    assert.ok(c.includes('AUTH LOGIN'));
    assert.equal(Buffer.from(c.find((x) => x.startsWith('LOGIN-USER ')).split(' ')[1], 'base64').toString(), 'bot');
    assert.equal(Buffer.from(c.find((x) => x.startsWith('LOGIN-PASS ')).split(' ')[1], 'base64').toString(), 'pw');
    assert.equal(srv.rec.data.length, 1);
  } finally { await srv.close(); }
});

test('AUTH 거부(535) → auth 535, 오류 메시지에 비밀번호 없음', async () => {
  const srv = await fakeServer({ auth: '535 5.7.8 bad credentials' });
  setEnv(srv, { SMTP_ALLOW_PLAIN: '1', SMTP_USER: 'bot', SMTP_PASS: 'sup3rs3cret' });
  try {
    await assert.rejects(smtp.send(msg()), (e) => /smtp auth 535/.test(e.message) && !e.message.includes('sup3rs3cret'));
    assert.ok(!srv.rec.cmds.includes('MAIL FROM:<support@acme.example>'));
  } finally { await srv.close(); }
});

test('STARTTLS: 승격 후 EHLO 재전송, AUTH는 TLS 이후에만', needTls, async () => {
  const srv = await fakeServer({ starttls: true });
  setEnv(srv, { SMTP_USER: 'bot', SMTP_PASS: 'pw', SMTP_TLS_REJECT_UNAUTHORIZED: '0' });
  try {
    const m = msg();
    const r = await smtp.send(m);
    const c = srv.rec.cmds;
    const names = c.map((x) => x.split(' ')[0]);
    assert.deepEqual(names, ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    const p = parseMsg(srv.rec.data[0]);
    assert.equal(p.headers['message-id'], r.id);
    assert.equal(Buffer.from(p.bodyB64.replace(/\r\n$/, ''), 'base64').toString('utf8'), m.body.replace(/\n/g, '\r\n'));
  } finally { await srv.close(); }
});

test('STARTTLS: 인증서 검증 실패(기본값) → tls 오류, 자격증명 미전송', needTls, async () => {
  const srv = await fakeServer({ starttls: true });
  setEnv(srv, { SMTP_USER: 'bot', SMTP_PASS: 'pw' });
  try {
    await assert.rejects(smtp.send(msg()), /smtp tls /);
    assert.ok(!srv.rec.cmds.some((x) => /^(AUTH|MAIL|RCPT|DATA)/.test(x)));
  } finally { await srv.close(); }
});

test('SMTP_SECURE=1: 접속 즉시 TLS(암묵적 TLS)', needTls, async () => {
  const srv = await fakeServer({ implicitTls: true });
  setEnv(srv, { SMTP_SECURE: '1', SMTP_USER: 'bot', SMTP_PASS: 'pw', SMTP_TLS_REJECT_UNAUTHORIZED: '0' });
  try {
    const r = await smtp.send(msg());
    assert.equal(r.provider, 'smtp');
    assert.deepEqual(srv.rec.cmds.map((x) => x.split(' ')[0]), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  } finally { await srv.close(); }
});

test('buildMessage: ASCII 긴 제목 폴딩·기본 제목 그대로·주소 검증', () => {
  const subject = 'Re: ' + 'word '.repeat(30).trim();
  const raw = smtp.buildMessage({ from: 'noreply@acme.example', to: 'a@example.com', subject, body: '', messageId: '<id1@acme.example>', date: 0 });
  assert.ok(raw.startsWith('Date: Thu, 01 Jan 1970 00:00:00 +0000\r\n'));
  assert.ok(raw.includes('\r\nFrom: noreply@acme.example\r\n'));
  assert.equal(unfold(raw.split('\r\n\r\n')[0]).match(/Subject: (.*)/)[1], subject);
  for (const l of raw.split('\r\n')) assert.ok(l.length <= 78);
  assert.ok(raw.endsWith('\r\n'));
  assert.throws(() => smtp.buildMessage({ from: 'noreply@acme.example', to: 'a@example.com', subject: 's', body: 'b', messageId: '<x>\r\nBcc: y@z>' }), /message-id/);
  assert.throws(() => smtp.buildMessage({ from: 'not-an-address', to: 'a@example.com', subject: 's', body: 'b' }), /invalid from/);
});

test('설정 누락: SMTP_HOST/SMTP_FROM 없으면 접속 없이 거부', async () => {
  await assert.rejects(smtp.send(msg()), /SMTP_HOST/);
  process.env.SMTP_HOST = '127.0.0.1';
  await assert.rejects(smtp.send(msg()), /SMTP_FROM/);
});

describe('운영 mock 메일 경고와 mock 발송 중복 방지', () => {
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); process.env.AUTO_SEND = '0'; for (const k of ['SHADOW_CHANNELS', 'AUTH_USER_HEADER', 'NODE_ENV', 'AUTO_CLOSE_DAYS', 'ENABLE_TEST_INJECT', 'INBOUND_SECRET']) delete process.env[k]; });

  async function withServer(fn) {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, p, body, headers = {}) => {
      const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    try { return await fn(api); } finally { server.close(); }
  }

  test('운영에서 mock 메일이면 경고, mock 발송은 같은 멱등키에 같은 id', async () => {
    await withServer(async (api) => {
      assert.equal((await api('GET', '/api/status')).data.mailWarning, undefined);
      process.env.NODE_ENV = 'production';
      assert.match((await api('GET', '/api/status')).data.mailWarning, /mock/);
    });
    const a = await mail.send({ to: 'x@example.com', subject: 's', body: 'b', idempotencyKey: 'same' });
    const b = await mail.send({ to: 'x@example.com', subject: 's', body: 'b', idempotencyKey: 'same' });
    assert.equal(a.id, b.id); assert.equal(b.duplicate, true);
  });
});

describe('답장 스레드 묶기', () => {
  const ENV = ['LLM_MOCK_DELAY_MS', 'MAIL_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL', 'AUTH_USER_HEADER', 'PROXY_SHARED_SECRET', 'INBOUND_SECRET', 'LLM_RETRY_SCALE'];
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ENV) delete process.env[k]; });

  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `f2-${n}`; const from = `f2-${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }
  const pending = (id) => db.all("SELECT * FROM drafts WHERE case_id=? AND status='PENDING'", id);
  /** 가짜 SMTP 서버(평문, 인증 없음) — 받은 DATA 원문을 모은다. */
  async function fakeSmtp() {
    const data = [];
    const server = net.createServer((sock) => {
      let buf = ''; let inData = false;
      const w = (x) => sock.write(`${x}\r\n`);
      w('220 fake');
      sock.on('data', (d) => {
        buf += d;
        for (;;) {
          if (inData) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; data.push(buf.slice(0, i)); buf = buf.slice(i + 5); inData = false; w('250 queued'); continue; }
          const i = buf.indexOf('\r\n'); if (i < 0) return;
          const line = buf.slice(0, i).toUpperCase(); buf = buf.slice(i + 2);
          if (line.startsWith('EHLO')) w('250 fake'); else if (line === 'DATA') { inData = true; w('354 go'); } else if (line === 'QUIT') { w('221 bye'); sock.end(); } else w('250 ok');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { data, port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } };
  }
  const header = (raw, name) => raw.replace(/\r\n[ \t]+/g, ' ').split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();

  test('provider가 답장을 다른 스레드 id로 보내면 그 id도 케이스에 묶는다 — 고객 회신이 같은 케이스로', async () => {
    const t = thread();
    const r = await t.run('영수증 발급 방법 알려주세요');
    const orig = mail.send;
    mail.send = async () => ({ id: `stub:${db.uuid()}`, provider: 'stub', threadId: 'prov-thread-b-s4' });
    try { await loop.approveDraft(pending(r.caseId)[0].id, { by: 'a' }); } finally { mail.send = orig; }
    assert.equal(db.get('SELECT case_id FROM case_threads WHERE thread_id=?', 'prov-thread-b-s4').case_id, r.caseId);
    const re = cases.addInbound({ channel: 'support', from: t.from, body: '감사합니다', threadId: 'prov-thread-b-s4' });
    assert.equal(re.caseId, r.caseId); assert.equal(re.created, false);
  });

  test('smtp: 답장에 In-Reply-To/References를 달고 Message-ID를 스레드로 묶는다 — 고객 회신은 In-Reply-To만으로 같은 케이스', async () => {
    const srv = await fakeSmtp();
    const keys = ['MAIL_PROVIDER', 'MAIL_ALLOWED_DOMAINS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_ALLOW_PLAIN'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { MAIL_PROVIDER: 'smtp', MAIL_ALLOWED_DOMAINS: 'example.com', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(srv.port), SMTP_FROM: 'ACME <support@acme.example>', SMTP_ALLOW_PLAIN: '1' });
    try {
      const t = thread();
      const r = await t.run('영수증 발급 방법 알려주세요', { providerMessageId: '<cust-1@mail.example.com>' });
      const sent = await loop.approveDraft(pending(r.caseId)[0].id, { by: 'a' });
      const raw = srv.data[0];
      assert.equal(header(raw, 'In-Reply-To'), '<cust-1@mail.example.com>');
      assert.match(header(raw, 'References'), /<cust-1@mail\.example\.com>/);
      const outId = db.get('SELECT provider_message_id p FROM messages WHERE id=?', sent.messageId).p;
      assert.equal(header(raw, 'Message-ID'), outId);
      assert.ok(db.get('SELECT 1 FROM case_threads WHERE thread_id=? AND case_id=?', outId, r.caseId), '발송 Message-ID가 케이스 스레드로 등록');
      // 고객 회신: 수신 어댑터가 모르는 스레드 id + In-Reply-To(꺾쇠 없이 와도) → 같은 케이스, 그 스레드 id도 묶인다
      const reply = cases.addInbound({ channel: 'support', from: t.from, body: '감사합니다', threadId: 'gmail-new-1', inReplyTo: outId.slice(1, -1), references: `<cust-1@mail.example.com> ${outId}` });
      assert.equal(reply.caseId, r.caseId); assert.equal(reply.created, false);
      assert.ok(db.get("SELECT 1 FROM case_threads WHERE thread_id='gmail-new-1' AND case_id=?", r.caseId));
      // 스레드 id 없이 References만 와도 같은 케이스(원 고객 메일 id)
      const r2 = cases.addInbound({ channel: 'support', from: t.from, body: '하나 더 물어볼게요', references: ['<cust-1@mail.example.com>'] });
      assert.equal(r2.caseId, r.caseId);
      // 모르는 id면 새 케이스
      assert.equal(cases.addInbound({ channel: 'support', from: 'other@example.com', body: '새 문의', inReplyTo: '<nobody@x.example>' }).created, true);
      // 헤더 주입은 토큰만 남는다
      const built = require('../server/mail/smtp').buildMessage({ from: 'a@acme.example', to: 'b@example.com', subject: 's', body: 'b', inReplyTo: '<p@x.example>\r\nBcc: evil@x.example', references: ['<q@x.example>', 'junk'] });
      assert.doesNotMatch(built, /Bcc:/); assert.equal(header(built, 'References'), '<q@x.example>');
    } finally {
      srv.close();
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});
