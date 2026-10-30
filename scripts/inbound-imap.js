'use strict';
// node scripts/inbound-imap.js — 메일함(IMAP)을 5초마다 읽어 새 메일을 POST /api/inbound 웹훅으로 넘긴다. 로컬 E2E 시연용 메일 어댑터(docs/deployment.md §4).
// 안전장치: ① 시작 뒤 새로 온 메일만 ② 받는 주소가 IMAP_TO 이고 보낸 주소가 IMAP_ALLOWED_FROM 인 메일만 ③ 메일함은 EXAMINE(읽기 전용)으로 열어 읽음 표시도 안 바꾼다.
// 의존성 0(node:tls). 로그인은 SMTP_USER·SMTP_PASS(Gmail 앱 비밀번호)를 같이 쓴다. 로그에 주소·제목·본문을 남기지 않는다.
const tls = require('node:tls');

const BASE = process.env.SIM_URL || `http://localhost:${process.env.PORT || 3000}`;
const POLL_MS = 5000;

// ---------- MIME ----------
function headers(text) {
  const h = {};
  for (const line of String(text).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = line.slice(i + 1).trim(); }
  }
  return h;
}

function decodeText(buf, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

// quoted-printable → 바이트. 헤더(encoded-word Q)는 _ 가 공백.
function qp(s, header = false) {
  s = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

// RFC 2047 encoded-word. 붙어 있는 encoded-word 사이 공백은 버린다.
const words = (s) => String(s || '')
  .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
  .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, t) => decodeText(/b/i.test(enc) ? Buffer.from(t, 'base64') : qp(t, true), cs));

const oneLine = (s) => s.replace(/[\r\n\t]+/g, ' ').trim(); // 제목·이름의 줄바꿈은 발송 헤더에서 거부된다(smtp.js)
const addrs = (s) => (String(s || '').match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/g) || []).map((a) => a.toLowerCase());

// 주소는 디코드 전 원문에서 뽑는다 — encoded-word 안에 <주소>를 숨겨 허용 발신자로 보이게 하는 위조를 막는다. 이름만 디코드.
function sender(v) {
  const s = String(v || '').trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(s);
  return m ? { email: m[2].trim(), name: oneLine(words(m[1].replace(/^"(.*)"$/, '$1'))) } : { email: s, name: '' };
}

const htmlText = (s) => s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// 파트 하나(latin1 문자열 = 바이트 보존) → { type, text }. multipart면 text/plain 우선, 없으면 text/html.
function bodyOf(raw) {
  let headText = raw; let body = '';
  const sep = /\r?\n\r?\n/.exec(raw);
  if (/^\r?\n/.test(raw)) { headText = ''; body = raw.replace(/^\r?\n/, ''); } else if (sep) { headText = raw.slice(0, sep.index); body = raw.slice(sep.index + sep[0].length); }
  const ct = headers(headText)['content-type'] || 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const b = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
    if (!b) return null;
    const parts = [];
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 경계는 줄 머리의 `--경계` 만 — 바깥 경계로 시작하는 안쪽 경계(B 와 B_alt)를 잘못 자르지 않게
    for (const seg of body.split(new RegExp(`(?:^|\\r?\\n)--${esc}(?=--|[ \\t]*(?:\\r?\\n|$))`)).slice(1)) { // 첫 조각은 preamble
      if (seg.startsWith('--')) break; // 닫는 경계
      const p = bodyOf(seg.replace(/^[ \t]*\r?\n/, ''));
      if (p) parts.push(p);
    }
    return parts.find((p) => p.type === 'text/plain') || parts.find((p) => p.type === 'text/html') || null;
  }
  if (!type.startsWith('text/')) return null;
  const enc = (headers(headText)['content-transfer-encoding'] || '').toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body, 'base64') : enc === 'quoted-printable' ? qp(body) : Buffer.from(body, 'latin1');
  return { type, text: decodeText(bytes, /charset="?([^";\s]+)"?/i.exec(ct)?.[1]) };
}

/** 원문 메일(Buffer) → /api/inbound 페이로드(channel 제외). */
function parseMessage(buf) {
  const raw = buf.toString('latin1');
  const end = /\r?\n\r?\n/.exec(raw);
  const h = headers(Buffer.from(end ? raw.slice(0, end.index) : raw, 'latin1').toString('utf8'));
  const part = bodyOf(raw);
  const from = sender(h.from);
  const date = new Date(h.date || '');
  return {
    from: from.email, name: from.name || undefined, subject: oneLine(words(h.subject)),
    body: part ? (part.type === 'text/html' ? htmlText(part.text) : part.text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '',
    providerMessageId: h['message-id'] || undefined, inReplyTo: h['in-reply-to'] || undefined, references: h.references || undefined,
    autoSubmitted: !!((h['auto-submitted'] && !/^no\b/i.test(h['auto-submitted'])) || h['x-autoreply'] || /^(bulk|junk|list|auto_reply)$/i.test(h.precedence || '')),
    occurredAt: Number.isNaN(date.getTime()) ? undefined : date.toISOString(),
  };
}

/** 헤더만 보고 넘길 메일인지 — 받는 주소가 IMAP_TO, 보낸 주소가 허용 목록. */
const accept = (h, cfg) => [...addrs(h.to), ...addrs(h.cc), ...addrs(h['delivered-to'])].includes(cfg.to)
  && cfg.allowed.includes(sender(h.from).email.toLowerCase());

// ---------- IMAP ----------
// 응답 조립기: 바이트 청크 → { text, lits[] }. 줄 끝 {n} 이면 n바이트 literal을 받고 같은 응답을 이어 읽는다.
function createParser(onResponse) {
  let buf = Buffer.alloc(0); let cur = { text: '', lits: [] }; let need = -1;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (need >= 0) {
        if (buf.length < need) return;
        cur.lits.push(buf.subarray(0, need)); buf = buf.subarray(need); need = -1;
        continue;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 2);
      cur.text += line;
      const m = /\{(\d+)\}$/.exec(line);
      if (m) { need = Number(m[1]); continue; }
      const r = cur; cur = { text: '', lits: [] };
      onResponse(r);
    }
  };
}

const quote = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`imap ${what} timeout`)), ms).unref())]);

// 명령은 한 번에 하나(순차). 오류 메시지엔 명령 이름과 서버 응답만 — 자격증명은 안 넣는다.
function client(host, port) {
  const sock = tls.connect({ host, port, servername: host });
  let pending = null; let seq = 0; let greet;
  const untagged = [];
  const greeting = new Promise((resolve, reject) => { greet = { resolve, reject }; });
  const fail = (e) => { if (greet) { greet.reject(e); greet = null; } if (pending) { const p = pending; pending = null; p.reject(e); } };
  sock.on('error', (e) => fail(new Error(`imap socket ${e.code || 'error'}`)));
  sock.on('close', () => fail(new Error('imap closed')));
  sock.on('data', createParser((r) => {
    if (greet) { const g = greet; greet = null; return /^\* (OK|PREAUTH)/.test(r.text) ? g.resolve() : g.reject(new Error('imap greeting')); }
    if (pending && r.text.startsWith(`${pending.tag} `)) {
      const p = pending; pending = null;
      const status = r.text.slice(p.tag.length + 1);
      return status.startsWith('OK') ? p.resolve(untagged.splice(0)) : p.reject(new Error(`imap ${p.verb} ${status.slice(0, 200)}`));
    }
    untagged.push(r);
  }));
  const cmd = (line) => timeout(new Promise((resolve, reject) => {
    if (sock.destroyed) return reject(new Error('imap closed'));
    const tag = `A${++seq}`;
    pending = { tag, verb: line.split(' ')[0], resolve, reject };
    sock.write(`${tag} ${line}\r\n`);
  }), 30000, line.split(' ')[0]);
  return { greeting: timeout(greeting, 15000, 'greeting'), cmd, close: () => sock.destroy() };
}

async function open(cfg) {
  const c = client(cfg.host, cfg.port);
  try {
    await c.greeting;
    await c.cmd(`LOGIN ${quote(cfg.user)} ${quote(cfg.pass)}`).catch((e) => { e.fatal = true; throw e; }); // 틀린 비밀번호로 계속 두드리면 계정이 잠긴다
    return c;
  } catch (e) { c.close(); throw e; }
}

async function post(cfg, msg) {
  const res = await fetch(`${BASE}/api/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': cfg.secret }, body: JSON.stringify({ channel: cfg.channel, ...msg }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`inbound ${res.status} ${out.error || ''}`), { status: res.status });
  return out;
}

// 한 바퀴: 메일함을 다시 열어 UIDNEXT를 보고, 새 UID의 헤더만 받아 거른 뒤 맞는 메일만 본문을 받아 넘긴다.
async function poll(c, cfg, state) {
  const sel = (await c.cmd(`EXAMINE ${quote(cfg.mailbox)}`)).map((r) => r.text).join('\n');
  const next = Number(/\[UIDNEXT (\d+)\]/.exec(sel)?.[1]);
  const validity = /\[UIDVALIDITY (\d+)\]/.exec(sel)?.[1];
  if (!next) throw new Error('imap UIDNEXT 없음');
  // 첫 바퀴는 기준점만 — 시작 전 메일은 안 본다. UIDVALIDITY 가 바뀌면 UID 가 다시 매겨진 것이라 기준점을 새로 잡는다
  if (state.last == null || state.validity !== validity) { state.last = next - 1; state.validity = validity; return; }
  if (next - 1 <= state.last) return;
  const heads = await c.cmd(`UID FETCH ${state.last + 1}:* (UID BODY.PEEK[HEADER.FIELDS (FROM TO CC DELIVERED-TO)])`);
  const list = heads.map((r) => ({ uid: Number(/\bUID (\d+)/.exec(r.text)?.[1]), lit: r.lits[0] }))
    .filter((x) => x.uid > state.last && x.lit).sort((a, b) => a.uid - b.uid);
  for (const { uid, lit } of list) {
    if (accept(headers(lit.toString('utf8')), cfg)) {
      const full = (await c.cmd(`UID FETCH ${uid} BODY.PEEK[]`)).find((r) => r.lits.length)?.lits[0];
      const head = full && /\r?\n\r?\n/.exec(full.toString('latin1'));
      const msg = full && parseMessage(full);
      // 헤더만 받은 것과 본문까지 받은 것이 다르면(그 사이 바뀐 메일) 본문 쪽 헤더로 다시 거른다
      if (!msg || !accept(headers(full.subarray(0, head ? head.index : full.length).toString('utf8')), cfg)) console.log(`[imap] uid ${uid} 건너뜀(대상 아님)`);
      else if (!msg.body) console.log(`[imap] uid ${uid} 건너뜀(본문 없음)`);
      else {
        try {
          const r = await post(cfg, msg);
          console.log(`[imap] uid ${uid} → case ${String(r.caseId || '').slice(0, 8)}${r.duplicate ? ' (중복)' : r.created ? ' (새 케이스)' : ' (기존 케이스)'}`);
        } catch (e) {
          // 4xx 는 다시 보내도 같다 — 건너뛴다. 서버가 꺼졌거나 5xx 면 IMAP 연결은 두고 다음 바퀴에 같은 메일부터 다시(서버가 Message-ID로 중복을 거른다)
          if (!(e.status >= 400 && e.status < 500)) { console.error(`[imap] uid ${uid} 보류 — ${e.message}`); return; }
          console.error(`[imap] uid ${uid} 건너뜀 — ${e.message}`);
        }
      }
    } else console.log(`[imap] uid ${uid} 건너뜀(대상 아님)`);
    state.last = uid;
  }
  state.last = Math.max(state.last, next - 1); // 그 사이 지워진 메일 때문에 같은 UID 범위를 계속 다시 받지 않게
}

function config() {
  const cfg = {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    to: String(process.env.IMAP_TO || '').trim().toLowerCase(),
    allowed: String(process.env.IMAP_ALLOWED_FROM || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    channel: process.env.IMAP_CHANNEL || 'support',
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, secret: process.env.INBOUND_SECRET,
  };
  const missing = Object.entries({ SMTP_USER: cfg.user, SMTP_PASS: cfg.pass, INBOUND_SECRET: cfg.secret, IMAP_TO: cfg.to, IMAP_ALLOWED_FROM: cfg.allowed.length })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`설정 필요: ${missing.join(', ')}`);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('IMAP_PORT 오류');
  // 에이전트 답장은 고객 주소로 간다 — 받는 주소가 허용 발신자에 들어 있으면 자기 답장을 다시 문의로 받아 메일 루프가 된다
  if (cfg.allowed.includes(cfg.to)) throw new Error('IMAP_TO 가 IMAP_ALLOWED_FROM 에 있으면 안 된다(메일 루프)');
  return cfg;
}

async function main() {
  let cfg;
  try { cfg = config(); } catch (e) { console.error(`[imap] ${e.message}`); process.exit(2); }
  const state = { last: null };
  let c = null;
  for (;;) {
    try {
      if (!c) { c = await open(cfg); console.log(`[imap] ${cfg.host} ${cfg.mailbox} 연결 → ${BASE}/api/inbound (${cfg.channel}). 지금부터 도착하는 메일만 넘긴다`); }
      await poll(c, cfg, state);
    } catch (e) {
      console.error(`[imap] ${e.message}`);
      c?.close(); c = null;
      if (e.fatal) process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();

module.exports = { parseMessage, accept, headers, createParser, config, poll };
