'use strict';
// scripts/inbound-imap.js — MIME 해석, 수신 필터, IMAP literal 조립(청크 경계), 설정 거부.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, accept, headers, createParser, config, poll } = require('../scripts/inbound-imap');

const b64 = (s) => Buffer.from(s).toString('base64');
const qpAll = (s) => [...Buffer.from(s)].map((x) => `=${x.toString(16).toUpperCase().padStart(2, '0')}`).join('');
const crlf = (lines) => Buffer.from(lines.join('\r\n'), 'latin1');

test('multipart/alternative — text/plain(QP, 소프트 줄바꿈) 우선, B·Q encoded-word 제목, 이름 디코드', () => {
  const body = qpAll('영수증 발급 부탁드립니다');
  const raw = crlf([
    `From: =?UTF-8?B?${b64('홍길동')}?= <me@gmail.com>`,
    'To: me+cs@gmail.com',
    `Subject: =?UTF-8?B?${b64('영수증')}?= =?UTF-8?Q?${qpAll(' 요청')}?=`,
    'Date: Fri, 30 Oct 2026 10:00:00 +0900',
    'Message-ID: <abc@mail.gmail.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="BB"',
    '',
    'preamble text',
    '--BB',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    `${body.slice(0, 30)}=`, // =XX 단위(3자) 경계에서 소프트 줄바꿈
    body.slice(30),
    '--BB',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64('<div>HTML 본문</div>'),
    '--BB--',
    '',
  ]);
  const m = parseMessage(raw);
  assert.equal(m.from, 'me@gmail.com');
  assert.equal(m.name, '홍길동');
  assert.equal(m.subject, '영수증 요청');
  assert.equal(m.body, '영수증 발급 부탁드립니다');
  assert.equal(m.providerMessageId, '<abc@mail.gmail.com>');
  assert.equal(m.occurredAt, '2026-10-30T01:00:00.000Z');
  assert.equal(m.autoSubmitted, false);
});

test('html 단독(base64) — 태그 제거, 자동 회신 헤더 표시', () => {
  const m = parseMessage(crlf([
    'From: me@gmail.com', 'To: me+cs@gmail.com', 'Subject: hi', 'Auto-Submitted: auto-replied',
    'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64('<p>환불&nbsp;요청</p><br>감사합니다'), '',
  ]));
  assert.equal(m.body, '환불 요청\n\n감사합니다');
  assert.equal(m.autoSubmitted, true);
});

test('accept — 받는 주소와 보낸 주소가 둘 다 맞아야 넘긴다', () => {
  const cfg = { to: 'me+cs@gmail.com', allowed: ['me@gmail.com'] };
  assert.equal(accept(headers('From: "Me" <Me@Gmail.com>\r\nTo: me+cs@gmail.com'), cfg), true);
  assert.equal(accept(headers('From: other@gmail.com\r\nTo: me+cs@gmail.com'), cfg), false, '허용 안 된 발신자');
  assert.equal(accept(headers('From: me@gmail.com\r\nTo: me@gmail.com'), cfg), false, '에이전트 답장(고객 주소로 감)은 다시 받지 않는다');
  assert.equal(accept(headers('From: me@gmail.com\r\nTo: x@a.com\r\nCc: ME+cs@gmail.com'), cfg), true, 'Cc 도 본다');
  assert.equal(accept(headers(`From: attacker@evil.com =?UTF-8?B?${b64('<me@gmail.com>')}?=\r\nTo: me+cs@gmail.com`), cfg), false, 'encoded-word 안에 숨긴 주소로 위조');
});

test('중첩 multipart — 바깥 경계로 시작하는 안쪽 경계(B / B_alt)를 섞지 않는다, 제목 줄바꿈은 한 줄로', () => {
  const m = parseMessage(crlf([
    'From: me@gmail.com', 'To: me+cs@gmail.com', `Subject: =?UTF-8?B?${b64('첫줄\r\n둘째줄')}?=`, 'Content-Type: multipart/mixed; boundary="B"', '',
    '--B', 'Content-Type: multipart/alternative; boundary="B_alt"', '',
    '--B_alt', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64('본문입니다'),
    '--B_alt--', '', '--B', 'Content-Type: application/pdf', '', 'xxx', '--B--', '',
  ]));
  assert.equal(m.body, '본문입니다');
  assert.equal(m.subject, '첫줄 둘째줄');
});

test('createParser — literal이 청크 경계에 걸려도 한 응답으로 조립', () => {
  const lit = Buffer.from('Subject: 한글\r\n\r\n본문\r\n');
  const wire = Buffer.concat([Buffer.from(`* 3 FETCH (UID 42 BODY[] {${lit.length}}\r\n`), lit, Buffer.from(')\r\nA1 OK done\r\n')]);
  const got = [];
  const push = createParser((r) => got.push(r));
  for (let i = 0; i < wire.length; i += 5) push(wire.subarray(i, i + 5));
  assert.equal(got.length, 2);
  assert.match(got[0].text, /UID 42/);
  assert.ok(got[0].lits[0].equals(lit));
  assert.equal(got[1].text, 'A1 OK done');
});

test('config — 필수값 누락·메일 루프 설정·잘못된 포트는 거부', () => {
  const keys = ['SMTP_USER', 'SMTP_PASS', 'INBOUND_SECRET', 'IMAP_TO', 'IMAP_ALLOWED_FROM', 'IMAP_PORT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.throws(() => config(), /설정 필요: SMTP_USER, SMTP_PASS, INBOUND_SECRET, IMAP_TO, IMAP_ALLOWED_FROM/);
    Object.assign(process.env, { SMTP_USER: 'me@gmail.com', SMTP_PASS: 'x', INBOUND_SECRET: 's', IMAP_TO: 'me@gmail.com', IMAP_ALLOWED_FROM: 'me@gmail.com' });
    assert.throws(() => config(), /메일 루프/);
    process.env.IMAP_TO = 'me+cs@gmail.com';
    assert.equal(config().to, 'me+cs@gmail.com');
    assert.equal(config().port, 993, 'IMAP_PORT 기본값');
    process.env.IMAP_PORT = 'abc';
    assert.throws(() => config(), /IMAP_PORT 오류/);
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test('poll — 기준점, 필터, 5xx 는 보류(재시도)·4xx 는 건너뜀, UIDVALIDITY 가 바뀌면 기준점 다시', async () => {
  const mail = (from, to, subject) => crlf([`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${subject}@x>`, 'Content-Type: text/plain; charset=UTF-8', '', `${subject} 본문`, '']);
  const box = [{ uid: 1, raw: mail('me@gmail.com', 'me+cs@gmail.com', 'old') }];
  let validity = '7';
  const head = (raw) => Buffer.from(raw.toString('latin1').split('\r\n\r\n')[0] + '\r\n\r\n', 'latin1');
  const c = {
    cmd: async (line) => {
      if (line.startsWith('EXAMINE')) return [{ text: `* OK [UIDVALIDITY ${validity}] v`, lits: [] }, { text: `* OK [UIDNEXT ${box.at(-1).uid + 1}] n`, lits: [] }];
      const m = /^UID FETCH (\d+)(:\*)? /.exec(line);
      const hits = m[2] ? box.filter((x) => x.uid >= Number(m[1])) : box.filter((x) => x.uid === Number(m[1]));
      return hits.map((x) => ({ text: `* ${x.uid} FETCH (UID ${x.uid} BODY[] {0})`, lits: [m[2] ? head(x.raw) : x.raw] }));
    },
  };
  const cfg = { to: 'me+cs@gmail.com', allowed: ['me@gmail.com'], channel: 'support', secret: 's' };
  const posted = []; const statuses = [];
  const realFetch = global.fetch; const realLog = console.log; const realErr = console.error;
  global.fetch = async (_url, opt) => { const b = JSON.parse(opt.body); posted.push(b.subject); const st = statuses.shift() ?? 200; return { ok: st < 300, status: st, json: async () => ({ caseId: 'c', created: true, error: 'x' }) }; };
  console.log = () => {}; console.error = () => {};
  try {
    const state = {};
    await poll(c, cfg, state);
    assert.equal(state.last, 1, '첫 바퀴는 기준점만');
    assert.deepEqual(posted, []);
    box.push({ uid: 2, raw: mail('me@gmail.com', 'me+cs@gmail.com', 'a') }, { uid: 3, raw: mail('x@gmail.com', 'me+cs@gmail.com', 'spam') }, { uid: 4, raw: mail('me@gmail.com', 'me+cs@gmail.com', 'b') });
    statuses.push(503);
    await poll(c, cfg, state);
    assert.equal(state.last, 1, '5xx 면 그 메일부터 다음 바퀴에 다시');
    statuses.push(200, 400);
    await poll(c, cfg, state);
    assert.deepEqual(posted, ['a', 'a', 'b'], '허용 안 된 발신자(spam)는 안 보낸다');
    assert.equal(state.last, 4, '4xx 는 건너뛰고 넘어간다');
    validity = '8'; box.push({ uid: 5, raw: mail('me@gmail.com', 'me+cs@gmail.com', 'c') });
    await poll(c, cfg, state);
    assert.equal(state.last, 5); assert.equal(posted.length, 3, 'UIDVALIDITY 가 바뀐 바퀴는 기준점만');
  } finally { global.fetch = realFetch; console.log = realLog; console.error = realErr; }
});
