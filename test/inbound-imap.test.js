'use strict';
// scripts/inbound-imap.js — MIME 해석, 수신 필터, IMAP literal 조립(청크 경계), 설정 거부, 발신자 인증 결과, 미러 모드(이어 읽기·발송 없는 설정 강제).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMessage, accept, headers, createParser, config, poll, loadState } = require('../scripts/inbound-imap');

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

test('multipart/alternative — 평문이 비었으면 HTML 본문을 쓴다, 평문에 내용이 있으면 평문, 둘 다 비면 빈 본문', () => {
  const mail = (plain, html) => parseMessage(crlf([
    'From: me@gmail.com', 'To: me+cs@gmail.com', 'Subject: hi', 'Content-Type: multipart/alternative; boundary="AA"', '',
    '--AA', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(plain),
    '--AA', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html),
    '--AA--', '',
  ])).body;
  assert.equal(mail(' \r\n', '<p>환불 요청합니다</p>'), '환불 요청합니다');
  assert.equal(mail('평문 본문', '<p>HTML 본문</p>'), '평문 본문');
  assert.equal(mail('', '<div>&nbsp;</div>'), '');
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

// env를 잠깐 바꿔 fn을 돌리고 되돌린다(undefined = 지움)
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (o) => { for (const [k, v] of Object.entries(o)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  put(vars);
  try { return fn(); } finally { put(saved); }
}

test('Authentication-Results — 우리 authserv-id 의 맨 위 헤더 dmarc 만 믿는다', () => {
  const id = 'mx.google.com';
  const auth = (...ar) => parseMessage(crlf([...ar.map((v) => `Authentication-Results: ${v}`), 'From: a@x.com', 'To: cs@acme.com', 'Subject: s', '', '본문', '']), id).senderAuth;
  assert.equal(auth('mx.google.com; dkim=pass header.i=@x.com; spf=pass (google.com: domain of a@x.com designates 1.2.3.4) smtp.mailfrom=a@x.com; dmarc=pass (p=NONE) header.from=x.com'), 'pass');
  assert.equal(auth('mx.google.com; dmarc=fail (p=REJECT) header.from=x.com'), 'fail');
  assert.equal(auth('mx.google.com; dmarc=none header.from=x.com', 'mx.google.com; dmarc=pass'), undefined, '아래에 붙은 위조 pass 는 무시');
  assert.equal(auth('mx.google.com; dmarc=fail', 'mx.google.com; dmarc=pass'), 'fail');
  assert.equal(auth('evil.example; dmarc=pass'), undefined, 'authserv-id 불일치');
  assert.equal(auth('MX.Google.com 1; dmarc=pass'), 'pass', '버전 토큰·대소문자');
  assert.equal(auth('mx.google.com (주석; 세미콜론) ; dmarc=pass'), 'pass', '주석 붙은 id');
  assert.equal(auth('mx.google.com; spf=pass (domain of "x;dmarc=pass"@evil.com) smtp.mailfrom=dmarc=pass@evil.com; dmarc=fail'), 'fail', '보낸 쪽이 정하는 주석·주소 속 dmarc= 는 안 본다');
  assert.equal(auth('mx.google.com; dmarc=temperror'), undefined);
  assert.equal(auth('mx.google.com; spf=pass'), undefined, 'dmarc 결과 없음');
  // 접힌 헤더 + ARC 헤더(중계자가 붙인 것)는 Authentication-Results 가 아니다
  const raw = crlf(['ARC-Authentication-Results: i=1; mx.google.com; dmarc=pass', 'Authentication-Results: mx.google.com;', '\tdmarc=fail header.from=x.com', 'From: a@x.com', '', '본문', '']);
  assert.equal(parseMessage(raw, id).senderAuth, 'fail');
  assert.equal(parseMessage(raw).senderAuth, undefined, 'IMAP_AUTHSERV_ID 없으면 안 넘김');
  assert.equal(parseMessage(raw, '').senderAuth, undefined);
});

test('Reply-To — 디코드 전 원문에서 주소 하나', () => {
  const m = parseMessage(crlf(['From: form@forms.example', `Reply-To: =?UTF-8?B?${b64('<victim@x.com>')}?= <Real@Customer.com>`, 'Subject: s', '', '본문', '']));
  assert.equal(m.replyTo, 'real@customer.com');
  assert.equal(parseMessage(crlf(['From: a@x.com', '', '본문', ''])).replyTo, undefined);
  assert.ok(!('replyTo' in JSON.parse(JSON.stringify(parseMessage(crlf(['From: a@x.com', '', '본문', '']))))), '없으면 페이로드에 안 실린다');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'imap-test-'));
const MIRROR = {
  SMTP_USER: 'cs@acme.com', SMTP_PASS: 'x', INBOUND_SECRET: 's', IMAP_TO: 'cs@acme.com', IMAP_ALLOWED_FROM: undefined, IMAP_CHANNEL: undefined, IMAP_PORT: undefined,
  IMAP_MODE: 'mirror', MAIL_PROVIDER: 'mock', AUTO_SEND: '0', SHADOW_CHANNELS: 'billing, support', SMTP_FROM: 'ACME 고객지원 <Agent@acme.com>', IMAP_AUTHSERV_ID: 'mx.google.com',
};

test('mirror config — mock 메일·자동 발송 끔·섀도 채널·파일 DB 가 다 있어야 시작, IMAP_ALLOWED_FROM 은 없어도 된다', () => {
  const dir = tmp();
  try {
    const DB_PATH = path.join(dir, 'cs.db');
    const cfg = withEnv({ ...MIRROR, DB_PATH }, () => config());
    assert.equal(cfg.mirror, true);
    assert.equal(cfg.stateFile, path.join(dir, 'imap-state.json'), '상태 파일은 DB 폴더');
    assert.throws(() => withEnv({ ...MIRROR, DB_PATH, MAIL_PROVIDER: 'smtp' }, () => config()), (e) => /MAIL_PROVIDER=mock/.test(e.message) && !/AUTO_SEND|SHADOW/.test(e.message));
    for (const AUTO_SEND of [undefined, '', '1', 'yes']) assert.throws(() => withEnv({ ...MIRROR, DB_PATH, AUTO_SEND }, () => config()), (e) => /AUTO_SEND=0/.test(e.message) && !/MAIL_PROVIDER|SHADOW/.test(e.message), `AUTO_SEND=${AUTO_SEND}`);
    for (const SHADOW_CHANNELS of [undefined, 'billing']) assert.throws(() => withEnv({ ...MIRROR, DB_PATH, SHADOW_CHANNELS }, () => config()), (e) => /SHADOW_CHANNELS 에 support/.test(e.message) && !/MAIL_PROVIDER|AUTO_SEND/.test(e.message));
    assert.throws(() => withEnv({ ...MIRROR, DB_PATH, IMAP_CHANNEL: 'sales' }, () => config()), /SHADOW_CHANNELS 에 sales/, '넘길 채널 기준');
    assert.throws(() => withEnv({ ...MIRROR, DB_PATH: ':memory:' }, () => config()), /DB_PATH/, '이어 읽기 없는 미러는 막는다');
    assert.throws(() => withEnv({ ...MIRROR, DB_PATH, IMAP_MODE: 'mirorr' }, () => config()), /IMAP_MODE 오류/);
    assert.throws(() => withEnv({ ...MIRROR, DB_PATH, IMAP_MODE: undefined }, () => config()), /설정 필요: IMAP_ALLOWED_FROM/, '시연 모드는 지금처럼 허용 발신자 필수');
    // 미러 accept: 받는 주소만 맞으면 누구나, 우리 주소(IMAP_TO·SMTP_FROM) 발신은 뺀다
    assert.equal(accept(headers('From: "고객" <Anyone@Customer.com>\r\nTo: cs@acme.com'), cfg), true);
    assert.equal(accept(headers('From: cs@acme.com\r\nTo: cs@acme.com'), cfg), false, 'IMAP_TO 발신');
    assert.equal(accept(headers('From: "ACME" <agent@ACME.com>\r\nTo: x@customer.com\r\nCc: cs@acme.com'), cfg), false, 'SMTP_FROM 발신');
    assert.equal(accept(headers('From: anyone@customer.com\r\nTo: other@acme.com'), cfg), false, '받는 주소 불일치');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mirror poll — 상태 파일로 재시작 뒤 이어 읽기, 5xx 는 위치를 안 올림, UIDVALIDITY 변경은 기준점, 메일함을 바꾸는 명령 없음', async () => {
  const dir = tmp();
  const mail = (from, subject, extra = []) => crlf([...extra, `From: ${from}`, 'To: cs@acme.com', `Subject: ${subject}`, `Message-ID: <${subject}@x>`, 'Content-Type: text/plain; charset=UTF-8', '', `${subject} body`, '']);
  const box = [{ uid: 1, raw: mail('old@customer.com', 'old') }];
  let validity = '7';
  const sent = [];
  const head = (raw) => Buffer.from(raw.toString('latin1').split('\r\n\r\n')[0] + '\r\n\r\n', 'latin1');
  const c = {
    cmd: async (line) => {
      sent.push(line);
      if (line.startsWith('EXAMINE')) return [{ text: `* OK [UIDVALIDITY ${validity}] v`, lits: [] }, { text: `* OK [UIDNEXT ${box.at(-1).uid + 1}] n`, lits: [] }];
      const m = /^UID FETCH (\d+)(:\*)? /.exec(line);
      const hits = m[2] ? box.filter((x) => x.uid >= Number(m[1])) : box.filter((x) => x.uid === Number(m[1]));
      return hits.map((x) => ({ text: `* ${x.uid} FETCH (UID ${x.uid} BODY[] {0})`, lits: [m[2] ? head(x.raw) : x.raw] }));
    },
  };
  const posted = []; const statuses = [];
  const realFetch = global.fetch; const realLog = console.log; const realErr = console.error;
  global.fetch = async (_url, opt) => { posted.push(JSON.parse(opt.body)); const st = statuses.shift() ?? 200; return { ok: st < 300, status: st, json: async () => ({ caseId: 'c', created: true }) }; };
  console.log = () => {}; console.error = () => {};
  try {
    const cfg = withEnv({ ...MIRROR, DB_PATH: path.join(dir, 'cs.db') }, () => config());
    const file = () => JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    await poll(c, cfg, loadState(cfg.stateFile)); // 상태 파일 없음 → 기준점만, 그래도 파일에 남긴다
    assert.deepEqual(file(), { validity: '7', last: 1 });
    assert.deepEqual(posted, []);
    // 어댑터가 꺼진 사이 도착: 고객 메일 + 우리 주소 발신
    box.push({ uid: 2, raw: mail('new@customer.com', 'a', ['Authentication-Results: mx.google.com; dmarc=pass header.from=customer.com', 'Reply-To: real@customer.com']) }, { uid: 3, raw: mail('agent@acme.com', 'ours') });
    statuses.push(503);
    await poll(c, cfg, loadState(cfg.stateFile)); // 메모리 state 를 버리고 파일에서 복원
    assert.equal(file().last, 1, '5xx(서버의 미러 거부 포함)면 읽은 위치를 안 올린다 — 다음에 같은 메일부터');
    await poll(c, cfg, loadState(cfg.stateFile));
    assert.deepEqual(posted.map((b) => b.subject), ['a', 'a'], '우리 주소 발신(ours)은 안 넘긴다');
    assert.deepEqual(posted[1], { channel: 'support', from: 'new@customer.com', subject: 'a', replyTo: 'real@customer.com', senderAuth: 'pass', body: 'a body', providerMessageId: '<a@x>', autoSubmitted: false, mirror: true });
    assert.deepEqual(file(), { validity: '7', last: 3 });
    box.push({ uid: 4, raw: mail('b@customer.com', 'b') });
    await poll(c, cfg, loadState(cfg.stateFile));
    assert.deepEqual(posted.map((b) => b.subject), ['a', 'a', 'b']);
    assert.equal(posted[2].senderAuth, undefined, 'Authentication-Results 없으면 안 넘김');
    validity = '8'; box.push({ uid: 5, raw: mail('c@customer.com', 'c') });
    await poll(c, cfg, loadState(cfg.stateFile));
    assert.equal(posted.length, 3, 'UIDVALIDITY 가 바뀌면 기준점만');
    assert.deepEqual(file(), { validity: '8', last: 5 });
    assert.ok(sent.every((l) => /^(EXAMINE|UID FETCH) /.test(l) && !l.includes('BODY[')), `읽기 전용 명령만: ${sent.join(' | ')}`);
    assert.ok(sent.some((l) => l.includes('BODY.PEEK[]')));
  } finally {
    global.fetch = realFetch; console.log = realLog; console.error = realErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Authentication-Results — 따옴표 안의 괄호·세미콜론은 글자다, 결과가 둘이면 결과 없음, 원문의 dmarc=fail 은 가릴 수 없다', () => {
  const id = 'mx.google.com';
  const auth = (v) => parseMessage(crlf([`Authentication-Results: ${v}`, 'From: a@victim.example', 'To: cs@acme.com', 'Subject: s', '', '본문', '']), id).senderAuth;
  const q = '"x);dmarc=pass ("@evil.example'; // 보낸 쪽이 정하는 봉투 주소
  assert.equal(auth(`mx.google.com; spf=pass (google.com: domain of ${q} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${q}; dmarc=fail (p=REJECT) header.from=victim.example`), 'fail');
  assert.equal(auth('mx.google.com; spf=pass (domain of "x);dmarc=pass"@evil.example) smtp.mailfrom=a@evil.example; dmarc=none'), undefined, '주석 안 따옴표 속 dmarc=pass 는 안 본다');
  assert.equal(auth('mx.google.com; dmarc=pass; dmarc=pass'), undefined, '결과 둘');
  assert.equal(auth('mx.google.com; spf=pass (domain of x"@evil.example) smtp.mailfrom=x"@evil.example; dmarc=fail'), 'fail', '짝 안 맞는 따옴표로 진짜 fail 을 가리지 못한다');
  assert.equal(auth('mx.google.com; spf=pass (domain of x(@evil.example) smtp.mailfrom=a@evil.example; dmarc=fail'), 'fail', '짝 안 맞는 괄호도');
  assert.equal(auth('mx.google.com; dkim=pass; dmarc=pass (p=NONE) header.from=x.com'), 'pass');
});

test('mirror poll — 메일 하나만의 영구 오류(413)만 건너뛰고 400·401·403·404 는 5xx 처럼 보류(위치 그대로), 시연 모드는 4xx 를 지금처럼 건너뛴다', async () => {
  const dir = tmp();
  const mail = (subject) => crlf(['From: c@customer.com', 'To: cs@acme.com', `Subject: ${subject}`, `Message-ID: <${subject}@x>`, 'Content-Type: text/plain; charset=UTF-8', '', `${subject} body`, '']);
  const box = [{ uid: 1, raw: mail('old') }];
  const head = (raw) => Buffer.from(raw.toString('latin1').split('\r\n\r\n')[0] + '\r\n\r\n', 'latin1');
  const c = {
    cmd: async (line) => {
      if (line.startsWith('EXAMINE')) return [{ text: '* OK [UIDVALIDITY 7] v', lits: [] }, { text: `* OK [UIDNEXT ${box.at(-1).uid + 1}] n`, lits: [] }];
      const m = /^UID FETCH (\d+)(:\*)? /.exec(line);
      const hits = m[2] ? box.filter((x) => x.uid >= Number(m[1])) : box.filter((x) => x.uid === Number(m[1]));
      return hits.map((x) => ({ text: `* ${x.uid} FETCH (UID ${x.uid} BODY[] {0})`, lits: [m[2] ? head(x.raw) : x.raw] }));
    },
  };
  const posted = []; const statuses = []; const errs = [];
  const realFetch = global.fetch; const realLog = console.log; const realErr = console.error;
  global.fetch = async (_url, opt) => { posted.push(JSON.parse(opt.body).subject); const st = statuses.shift() ?? 200; return { ok: st < 300, status: st, json: async () => ({ caseId: 'c', error: 'x' }) }; };
  console.log = () => {}; console.error = (m) => errs.push(String(m));
  try {
    const cfg = withEnv({ ...MIRROR, DB_PATH: path.join(dir, 'cs.db') }, () => config());
    const last = () => JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')).last;
    await poll(c, cfg, loadState(cfg.stateFile));
    box.push({ uid: 2, raw: mail('a') }, { uid: 3, raw: mail('b') });
    for (const st of [400, 401, 403, 404]) {
      statuses.push(st);
      await poll(c, cfg, loadState(cfg.stateFile));
      assert.equal(last(), 1, `${st} 이면 위치를 안 올린다 — 설정을 고친 뒤 같은 메일부터`);
      assert.match(errs.at(-1), /!!!.*보류/, `${st} 는 크게 남긴다`);
    }
    statuses.push(413);
    await poll(c, cfg, loadState(cfg.stateFile));
    assert.equal(last(), 3, '413 은 그 메일만 건너뛰고 다음 메일(b)을 넘긴다');
    assert.deepEqual(posted, ['a', 'a', 'a', 'a', 'a', 'b']);
    // 시연 모드(미러 아님)는 그대로 — 4xx 는 건너뛴다
    const demo = { to: 'cs@acme.com', allowed: ['c@customer.com'], channel: 'support', secret: 's' };
    const state = {};
    await poll(c, demo, state);
    box.push({ uid: 4, raw: mail('d') });
    statuses.push(400);
    await poll(c, demo, state);
    assert.equal(state.last, 4);
  } finally {
    global.fetch = realFetch; console.log = realLog; console.error = realErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Authentication-Results — 따옴표·괄호가 끝까지 안 닫히면 결과 없음(그 앞에 끼워 넣은 dmarc=pass 가 이기지 못한다), 원문의 dmarc=fail 은 그대로 fail', () => {
  const auth = (v) => parseMessage(crlf([`Authentication-Results: ${v}`, 'From: a@victim.example', '', '본문', '']), 'mx.google.com').senderAuth;
  assert.equal(auth('mx.google.com; spf=pass (domain of a) ; dmarc=pass ; x"@evil.example designates) smtp.mailfrom=a@evil.example; dmarc=none'), undefined);
  assert.equal(auth('mx.google.com; spf=pass (domain of a) ; dmarc=pass ; x(@evil.example designates) smtp.mailfrom=a@evil.example; dmarc=none'), undefined);
  assert.equal(auth('mx.google.com; spf=pass (domain of a) ; dmarc=pass ; x"@evil.example designates) smtp.mailfrom=a@evil.example; dmarc=fail'), 'fail');
});

test('mirror poll — 서버가 400 으로 거절할 메일(발신 주소 없음·첨부만)은 어댑터가 건너뛰어 미러가 멈추지 않고, 멀쩡한 메일의 400 은 여전히 보류', async () => {
  const dir = tmp();
  const mail = (subject, from = 'c@customer.com') => crlf([...(from ? [`From: ${from}`] : []), 'To: cs@acme.com', `Subject: ${subject}`, `Message-ID: <${subject}@x>`, '', `${subject} body`, '']);
  const attachOnly = crlf(['From: c@customer.com', 'To: cs@acme.com', 'Subject: att', 'Message-ID: <att@x>', 'Content-Type: multipart/mixed; boundary="B"', '',
    '--B', 'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=', '--B--', '']);
  const box = [{ uid: 1, raw: mail('old') }];
  const head = (raw) => Buffer.from(raw.toString('latin1').split('\r\n\r\n')[0] + '\r\n\r\n', 'latin1');
  const c = {
    cmd: async (line) => {
      if (line.startsWith('EXAMINE')) return [{ text: '* OK [UIDVALIDITY 7] v', lits: [] }, { text: `* OK [UIDNEXT ${box.at(-1).uid + 1}] n`, lits: [] }];
      const m = /^UID FETCH (\d+)(:\*)? /.exec(line);
      const hits = m[2] ? box.filter((x) => x.uid >= Number(m[1])) : box.filter((x) => x.uid === Number(m[1]));
      return hits.map((x) => ({ text: `* ${x.uid} FETCH (UID ${x.uid} BODY[] {0})`, lits: [m[2] ? head(x.raw) : x.raw] }));
    },
  };
  const posted = []; const statuses = [];
  const realFetch = global.fetch; const realLog = console.log; const realErr = console.error;
  // 서버처럼: 발신 주소·본문이 없으면 400
  global.fetch = async (_url, opt) => { const b = JSON.parse(opt.body); posted.push(b.subject); const st = !b.from || !b.body ? 400 : statuses.shift() ?? 200; return { ok: st < 300, status: st, json: async () => ({ caseId: 'c', error: 'x' }) }; };
  console.log = () => {}; console.error = () => {};
  try {
    const cfg = withEnv({ ...MIRROR, DB_PATH: path.join(dir, 'cs.db') }, () => config());
    const last = () => JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')).last;
    await poll(c, cfg, loadState(cfg.stateFile));
    box.push({ uid: 2, raw: mail('nofrom', '') }, { uid: 3, raw: attachOnly }, { uid: 4, raw: mail('a') });
    await poll(c, cfg, loadState(cfg.stateFile));
    assert.equal(last(), 4, '발신 주소 없는 메일·첨부만 있는 메일은 건너뛰고 다음 메일까지 간다');
    assert.deepEqual(posted, ['a']);
    box.push({ uid: 5, raw: mail('b') });
    statuses.push(400);
    await poll(c, cfg, loadState(cfg.stateFile));
    assert.equal(last(), 4, '멀쩡한 메일의 400(설정 오류)은 보류');
  } finally {
    global.fetch = realFetch; console.log = realLog; console.error = realErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
