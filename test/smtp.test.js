'use strict';
// SMTP provider — 네트워크 없이 프로세스 내 가짜 SMTP 서버(net/tls, 포트 0)로 검증.
// STARTTLS/암묵적 TLS 케이스는 openssl로 메모리상 자체서명 인증서를 만들 수 있을 때만 돈다(디스크에 아무것도 안 씀).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const smtp = require('../server/mail/smtp');

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
