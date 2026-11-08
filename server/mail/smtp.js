'use strict';
// 의존성 0 SMTP provider (MAIL_PROVIDER=smtp). node:net/tls만 사용. 설정은 SMTP_* 환경변수를 호출 시점에 읽는다.
// STARTTLS 필수(SMTP_ALLOW_PLAIN=1이면 평문 허용). 오류 메시지는 단계+서버 응답 코드만 담고 자격증명·본문은 넣지 않는다.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

const ADDR = /^[^\s<>()[\],;:"\\@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/; // 단일 ASCII 주소(IDN·쉼표 목록 거부)
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const b64 = (s) => Buffer.from(s).toString('base64');

function config() {
  const e = process.env;
  if (!e.SMTP_HOST) throw new Error('smtp config: SMTP_HOST 필요');
  if (!e.SMTP_FROM) throw new Error('smtp config: SMTP_FROM 필요');
  const port = Number(e.SMTP_PORT) || 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('smtp config: SMTP_PORT 오류');
  return {
    host: e.SMTP_HOST, port, from: e.SMTP_FROM,
    secure: e.SMTP_SECURE === '1', allowPlain: e.SMTP_ALLOW_PLAIN === '1',
    user: e.SMTP_USER || '', pass: e.SMTP_PASS || '',
    timeout: Number(e.SMTP_TIMEOUT_MS) || 15000,
    reject: e.SMTP_TLS_REJECT_UNAUTHORIZED !== '0',
  };
}

// "이름 <addr>" 또는 "addr" → { name, addr }. CR/LF·잘못된 주소는 거부.
function parseFrom(from) {
  const s = String(from ?? '').trim();
  const m = /^(.*?)\s*<([^<>]*)>$/.exec(s);
  const addr = m ? m[2] : s;
  if (/[\r\n]/.test(s) || !ADDR.test(addr)) throw new Error('smtp invalid from');
  return { name: m ? m[1].replace(/^"(.*)"$/, '$1') : '', addr };
}

// RFC 2047 encoded-word. 한 단어 ≤ 68자(첫 줄이 78자 안에 들어오도록 원본 42바이트씩), 코드포인트 단위로 잘라 멀티바이트를 깨지 않는다.
function encodeWords(s) {
  if (isAscii(s)) return s;
  const words = [];
  let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 42) { words.push(cur); cur = ''; }
    cur += ch;
  }
  words.push(cur);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join(' ');
}

// 공백 기준 폴딩(CRLF+SP). 78자 초과 방지. 공백 없는 단어는 쪼개지 않는다.
function fold(name, value) {
  const [first, ...rest] = value.split(' ');
  const out = [];
  let line = `${name}: ${first}`;
  for (const w of rest) {
    if (line.length + 1 + w.length > 78) { out.push(line); line = ` ${w}`; } else line += ` ${w}`;
  }
  out.push(line);
  return out.join('\r\n');
}

function formatFrom({ name, addr }) {
  if (!name) return addr;
  const shown = !isAscii(name) ? encodeWords(name)
    : /^[\w .'-]+$/.test(name) ? name : `"${name.replace(/["\\]/g, '\\$&')}"`;
  return `${shown} <${addr}>`;
}

// 같은 idempotencyKey → 같은 Message-ID. 재시도해도 수신 측에서 중복으로 식별 가능.
const msgId = (key, addr) => `<${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 24)}@${addr.split('@')[1]}>`;

// In-Reply-To/References 값에서 `<id>` 토큰만 뽑는다(공백·CR/LF가 들어갈 수 없어 헤더 주입이 안 된다).
const msgIds = (v) => [].concat(v ?? []).flatMap((x) => String(x).match(/<[^<>\s]+>/g) || []);

function buildMessage({ from, to, subject, body, messageId, date, inReplyTo, references }) {
  const f = parseFrom(from);
  to = String(to ?? '');
  if (!ADDR.test(to)) throw new Error('smtp invalid to');
  subject = String(subject ?? '');
  if (/[\r\n]/.test(subject)) throw new Error('smtp invalid subject');
  const id = messageId ?? msgId(crypto.randomUUID(), f.addr);
  if (!/^<[^\s<>]+>$/.test(id)) throw new Error('smtp invalid message-id');
  const lines = b64(String(body ?? '').replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g) || [];
  const irt = msgIds(inReplyTo)[0];
  const refs = [...new Set(msgIds(references))].slice(-20); // 긴 대화는 최근 20개만
  return [
    `Date: ${new Date(date ?? Date.now()).toUTCString().replace('GMT', '+0000')}`,
    fold('From', formatFrom(f)),
    `To: ${to}`,
    fold('Subject', encodeWords(subject)),
    `Message-ID: ${id}`,
    ...(irt ? [`In-Reply-To: ${irt}`] : []),
    ...(refs.length ? [fold('References', refs.join(' '))] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...lines,
  ].join('\r\n') + '\r\n';
}

// 소켓 → 완성된 응답 큐. 다중행(`250-...` 이어짐, 마지막 `250 ...`)을 합쳐 { code, text }로 낸다.
function reader(sock) {
  let buf = '';
  let lines = [];
  let pending = null;
  let failure = null;
  const replies = [];
  const pump = () => {
    if (!pending) return;
    const p = pending;
    if (replies.length) { pending = null; p.resolve(replies.shift()); } else if (failure) { pending = null; p.reject(failure); }
  };
  const fail = (msg) => { failure = failure || new Error(msg); pump(); };
  const onData = (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const m = /^(\d{3})([ -]|$)(.*)$/.exec(line);
      if (!m) return fail('smtp protocol: bad reply');
      lines.push(m[3]);
      if (m[2] !== '-') { replies.push({ code: Number(m[1]), text: lines.join('\n') }); lines = []; }
    }
    if (buf.length > 65536) return fail('smtp protocol: reply too long');
    pump();
  };
  sock.setEncoding('utf8');
  sock.on('data', onData);
  sock.on('error', (e) => fail(`smtp socket ${e.code || 'error'}`));
  sock.on('close', () => fail('smtp connection closed'));
  return {
    read: () => new Promise((resolve, reject) => { pending = { resolve, reject }; pump(); }),
    // STARTTLS 직전 호출: 리스너를 떼고, 남은 데이터가 있으면(평문 주입 의심) true.
    stop: () => { sock.removeListener('data', onData); return buf.length > 0 || replies.length > 0; },
  };
}

// 접속 또는 STARTTLS 승격(plain 지정). 만든 소켓은 즉시 track해서 타임아웃 때도 정리되게 한다.
function open(cfg, track, plain) {
  return new Promise((resolve, reject) => {
    const t = { servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.reject };
    const done = () => resolve(s);
    const s = track(plain ? tls.connect({ socket: plain, ...t }, done)
      : cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, ...t }, done)
        : net.connect({ host: cfg.host, port: cfg.port }, done));
    s.once('error', (e) => reject(new Error(`smtp ${plain ? 'tls' : 'connect'} ${e.code || 'error'}`)));
  });
}

const expect = (step, r, ok) => {
  if (!ok.includes(r.code)) throw new Error(`smtp ${step} ${r.code} ${r.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  return r;
};

const ehloName = () => os.hostname().replace(/[^A-Za-z0-9.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'localhost';

async function send({ to, subject, body, idempotencyKey, inReplyTo, references }) {
  const cfg = config();
  const from = parseFrom(cfg.from);
  const messageId = msgId(idempotencyKey ?? crypto.randomUUID(), from.addr);
  const raw = buildMessage({ from: cfg.from, to, subject, body, messageId, inReplyTo, references }); // 접속 전에 검증(헤더 주입 차단)

  const socks = [];
  const track = (s) => (socks.push(s), s);
  let sock; let rd; let timer;
  const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('smtp timeout')), cfg.timeout); });
  const cmd = async (step, line, ...ok) => { sock.write(`${line}\r\n`); return expect(step, await rd.read(), ok); };

  // 정중한 종료. 이미 수락된 메일이 QUIT 지연 때문에 실패로 보이면 안 되므로 전체 타임아웃은 여기서 끄고 1초만 기다린다.
  const quit = async () => {
    clearTimeout(timer);
    if (!sock || !sock.writable) return;
    sock.write('QUIT\r\n');
    await Promise.race([rd.read().catch(() => {}), new Promise((r) => setTimeout(r, 1000).unref())]);
  };

  const session = async () => {
    try {
      sock = await open(cfg, track);
      rd = reader(sock);
      expect('greeting', await rd.read(), [220]);
      let caps = (await cmd('ehlo', `EHLO ${ehloName()}`, 250)).text;
      if (!cfg.secure) {
        if (/^STARTTLS$/im.test(caps)) {
          await cmd('starttls', 'STARTTLS', 220);
          if (rd.stop()) throw new Error('smtp starttls buffered data');
          sock = await open(cfg, track, sock);
          rd = reader(sock);
          caps = (await cmd('ehlo', `EHLO ${ehloName()}`, 250)).text; // 승격 후 능력 재조회
        } else if (!cfg.allowPlain) throw new Error('smtp starttls required');
      }
      if (cfg.user) {
        const mech = (/^AUTH[ =](.*)$/im.exec(caps)?.[1] || '').toUpperCase().split(/\s+/);
        if (mech.includes('PLAIN')) await cmd('auth', `AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, 235);
        else if (mech.includes('LOGIN')) {
          await cmd('auth', 'AUTH LOGIN', 334);
          await cmd('auth', b64(cfg.user), 334);
          await cmd('auth', b64(cfg.pass), 235);
        } else throw new Error('smtp auth unsupported');
      }
      await cmd('mail', `MAIL FROM:<${from.addr}>`, 250);
      await cmd('rcpt', `RCPT TO:<${to}>`, 250);
      await cmd('data', 'DATA', 354);
      sock.write(`${raw.replace(/(^|\r\n)\./g, '$1..')}.\r\n`); // dot-stuffing(base64라 실제론 불필요, 안전용)
      expect('dataend', await rd.read(), [250]);
    } finally {
      await quit();
    }
  };

  try {
    await Promise.race([session(), deadline]);
    // SMTP엔 provider 스레드 id가 없다 — 이 메일의 Message-ID를 스레드 id로 돌려준다(loop.finalizeSent가 케이스에 묶는다).
    return { id: messageId, provider: 'smtp', threadId: messageId };
  } finally {
    clearTimeout(timer);
    for (const s of socks) s.destroy();
  }
}

module.exports = { send, buildMessage };
