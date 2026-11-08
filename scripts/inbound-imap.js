'use strict';
// node scripts/inbound-imap.js — 메일함(IMAP)을 5초마다 읽어 새 메일을 POST /api/inbound 웹훅으로 넘긴다. 로컬 E2E 시연용 메일 어댑터(docs/deployment.md §4).
// 안전장치: ① 시작 뒤 새로 온 메일만 ② 받는 주소가 IMAP_TO 이고 보낸 주소가 IMAP_ALLOWED_FROM 인 메일만 ③ 메일함은 EXAMINE(읽기 전용)으로 열어 읽음 표시도 안 바꾼다.
// IMAP_MODE=mirror: 공유 메일함 미러 — 아무 발신자나 받되 우리 주소(IMAP_TO·SMTP_FROM) 발신은 빼고, 어디까지 읽었는지를 DB 폴더 imap-state.json 에 남겨 재시작 뒤 이어 읽는다.
// 실고객 메일을 읽으므로 발송이 없는 설정(mock 메일·자동 발송 끔·섀도 채널)이 아니면 시작하지 않고, 페이로드에 mirror:true 를 실어 서버도 같은 검사를 하게 한다.
// 의존성 0(node:tls). 로그인은 SMTP_USER·SMTP_PASS(Gmail 앱 비밀번호)를 같이 쓴다. 로그에 주소·제목·본문을 남기지 않는다.
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../server/policy');

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
    // 글자가 남는 첫 부분 — 평문 우선, 평문이 비었으면(HTML 에만 내용을 담는 메일) HTML. 빈 평문을 고르면 본문 없는 메일로 건너뛴다
    const filled = (t) => parts.find((p) => p.type === t && (t === 'text/html' ? htmlText(p.text) : p.text).trim());
    return filled('text/plain') || filled('text/html') || null;
  }
  if (!type.startsWith('text/')) return null;
  const enc = (headers(headText)['content-transfer-encoding'] || '').toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body, 'base64') : enc === 'quoted-printable' ? qp(body) : Buffer.from(body, 'latin1');
  return { type, text: decodeText(bytes, /charset="?([^";\s]+)"?/i.exec(ct)?.[1]) };
}

// 괄호 주석·따옴표 값을 공백으로 — 따옴표 안의 괄호·세미콜론은 글자다(주석 안에 든 따옴표도). 봉투 주소 `"x);dmarc=pass ("@…` 가 주석을 닫고 결과를 끼워 넣지 못하게.
// 백슬래시는 따옴표·주석 안에서 다음 글자를 escape. 닫히지 않은 따옴표·주석은 끝까지 걷어 내고 open 으로 알린다.
function visible(v) {
  let out = ''; let depth = 0; let q = false;
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i];
    if ((q || depth) && ch === '\\') { out += '  '; i += 1; continue; }
    if (ch === '"') q = !q;
    else if (!q && ch === '(') depth += 1;
    else if (!q && ch === ')' && depth) { depth -= 1; out += ' '; continue; }
    out += q || depth || ch === '"' ? ' ' : ch;
  }
  return { text: out, open: q || depth > 0 };
}

// Authentication-Results(RFC 8601) → 'pass'|'fail'|undefined. 우리 수신 서버(authserv-id)가 붙인 헤더 중 맨 위 것의 DMARC 결과만 본다 —
// 그 아래 것은 보낸 쪽이 미리 넣어 둘 수 있다. 괄호 주석·따옴표 값(봉투 주소 등 보낸 쪽이 정하는 글자)은 걷어 내고 읽는다.
// 걷어 낸 뒤 dmarc 결과가 둘 이상이면 끼워 넣은 것으로 보고 결과 없음. 단 원문에 `; dmarc=fail` 이 있으면 fail —
// 수신 서버가 쓴 fail 은 원문에 늘 그대로 있다. 따옴표·괄호 짝을 어긋나게 해 그것을 가리는 위조(fail → 결과 없음)를 막는다. 끼워 넣은 fail 은 보낸 쪽만 손해다.
// 단순화: DKIM 정렬은 따로 안 본다(DMARC가 그 판정이다).
function authResult(headText, id) {
  if (!id) return undefined;
  for (const line of String(headText).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const raw = /^authentication-results\s*:(.*)$/i.exec(line)?.[1];
    if (raw == null) continue;
    const { text, open } = visible(raw);
    const [serv, ...res] = text.split(';');
    if (serv.trim().split(/\s+/)[0].toLowerCase() !== id.toLowerCase()) continue; // `mx.example.com 1` 의 버전 토큰은 버린다
    if (/;\s*dmarc\s*=\s*fail\b/i.test(raw)) return 'fail';
    if (open) return undefined; // 따옴표·괄호가 끝까지 안 닫혔다 — 그 앞에 끼워 넣은 dmarc=pass 가 진짜 결과를 가렸을 수 있다
    const r = res.map((x) => /^\s*dmarc\s*=\s*([a-z]+)/i.exec(x)?.[1].toLowerCase()).filter(Boolean);
    return r.length === 1 && (r[0] === 'pass' || r[0] === 'fail') ? r[0] : undefined;
  }
  return undefined;
}

/** 원문 메일(Buffer) → /api/inbound 페이로드(channel 제외). authservId 가 없으면 발신자 인증 결과를 안 넘긴다(정보 없음). */
function parseMessage(buf, authservId) {
  const raw = buf.toString('latin1');
  const end = /\r?\n\r?\n/.exec(raw);
  const headText = Buffer.from(end ? raw.slice(0, end.index) : raw, 'latin1').toString('utf8');
  const h = headers(headText);
  const part = bodyOf(raw);
  const from = sender(h.from);
  const date = new Date(h.date || '');
  return {
    from: from.email, name: from.name || undefined, subject: oneLine(words(h.subject)),
    replyTo: addrs(sender(h['reply-to']).email)[0], senderAuth: authResult(headText, authservId), // Reply-To 도 디코드 전 원문에서(위조 방지)
    body: part ? (part.type === 'text/html' ? htmlText(part.text) : part.text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '',
    providerMessageId: h['message-id'] || undefined, inReplyTo: h['in-reply-to'] || undefined, references: h.references || undefined,
    autoSubmitted: !!((h['auto-submitted'] && !/^no\b/i.test(h['auto-submitted'])) || h['x-autoreply'] || /^(bulk|junk|list|auto_reply)$/i.test(h.precedence || '')),
    occurredAt: Number.isNaN(date.getTime()) ? undefined : date.toISOString(),
  };
}

/** 헤더만 보고 넘길 메일인지 — 받는 주소가 IMAP_TO, 보낸 주소가 허용 목록(미러: 우리 주소가 아니면 누구나). */
const accept = (h, cfg) => {
  const from = sender(h.from).email.toLowerCase();
  return [...addrs(h.to), ...addrs(h.cc), ...addrs(h['delivered-to'])].includes(cfg.to) && (cfg.mirror ? !cfg.ours.includes(from) : cfg.allowed.includes(from));
};

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
    method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': cfg.secret }, body: JSON.stringify({ channel: cfg.channel, ...msg, ...(cfg.mirror && { mirror: true }) }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`inbound ${res.status} ${out.error || ''}`), { status: res.status });
  return out;
}

// 미러 모드의 읽은 위치. 임시 파일 + rename 이라 쓰다 죽어도 반쪽 파일이 안 남는다. 시연 모드(stateFile 없음)는 안 쓴다.
function save(cfg, state) {
  if (!cfg.stateFile) return;
  fs.writeFileSync(`${cfg.stateFile}.tmp`, JSON.stringify({ validity: state.validity, last: state.last }));
  fs.renameSync(`${cfg.stateFile}.tmp`, cfg.stateFile);
}

/** 상태 파일 → poll 의 state. 없거나 못 읽으면 기준점부터(첫 바퀴가 기준점만 잡는다). */
function loadState(file) {
  if (!fs.existsSync(file)) return { last: null };
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (Number.isInteger(s.last)) return { validity: s.validity, last: s.last }; } catch {}
  console.error('[imap] 상태 파일을 읽지 못함 — 기준점부터 다시(그 사이 메일은 안 넘긴다)');
  return { last: null };
}

// 한 바퀴: 메일함을 다시 열어 UIDNEXT를 보고, 새 UID의 헤더만 받아 거른 뒤 맞는 메일만 본문을 받아 넘긴다.
async function poll(c, cfg, state) {
  const sel = (await c.cmd(`EXAMINE ${quote(cfg.mailbox)}`)).map((r) => r.text).join('\n');
  const next = Number(/\[UIDNEXT (\d+)\]/.exec(sel)?.[1]);
  const validity = /\[UIDVALIDITY (\d+)\]/.exec(sel)?.[1];
  if (!next) throw new Error('imap UIDNEXT 없음');
  // 첫 바퀴는 기준점만 — 시작 전 메일은 안 본다. UIDVALIDITY 가 바뀌면 UID 가 다시 매겨진 것이라 기준점을 새로 잡는다
  if (state.last == null || state.validity !== validity) {
    if (state.last != null) console.error('[imap] UIDVALIDITY 바뀜 — 기준점부터 다시(그 사이 메일은 안 넘긴다)');
    state.last = next - 1; state.validity = validity; save(cfg, state); return;
  }
  if (next - 1 <= state.last) return;
  const heads = await c.cmd(`UID FETCH ${state.last + 1}:* (UID BODY.PEEK[HEADER.FIELDS (FROM TO CC DELIVERED-TO)])`);
  const list = heads.map((r) => ({ uid: Number(/\bUID (\d+)/.exec(r.text)?.[1]), lit: r.lits[0] }))
    .filter((x) => x.uid > state.last && x.lit).sort((a, b) => a.uid - b.uid);
  for (const { uid, lit } of list) {
    if (accept(headers(lit.toString('utf8')), cfg)) {
      const full = (await c.cmd(`UID FETCH ${uid} BODY.PEEK[]`)).find((r) => r.lits.length)?.lits[0];
      const head = full && /\r?\n\r?\n/.exec(full.toString('latin1'));
      const msg = full && parseMessage(full, cfg.authservId);
      // 헤더만 받은 것과 본문까지 받은 것이 다르면(그 사이 바뀐 메일) 본문 쪽 헤더로 다시 거른다
      if (!msg || !accept(headers(full.subarray(0, head ? head.index : full.length).toString('utf8')), cfg)) console.log(`[imap] uid ${uid} 건너뜀(대상 아님)`);
      // 서버가 400 으로 거절할 메일(발신 주소 없음·본문 없음 — 첨부만 있는 메일 등)은 여기서 건너뛴다. 그래야 미러의 400 은 설정 오류만 뜻하고 보류가 맞다
      else if (!msg.from) console.log(`[imap] uid ${uid} 건너뜀(발신 주소 없음)`);
      else if (!msg.body) console.log(`[imap] uid ${uid} 건너뜀(본문 없음)`);
      else {
        try {
          const r = await post(cfg, msg);
          console.log(`[imap] uid ${uid} → case ${String(r.caseId || '').slice(0, 8)}${r.duplicate ? ' (중복)' : r.created ? ' (새 케이스)' : ' (기존 케이스)'}`);
        } catch (e) {
          // 4xx 는 다시 보내도 같다 — 건너뛴다. 서버가 꺼졌거나 5xx 면 IMAP 연결은 두고 다음 바퀴에 같은 메일부터 다시(서버가 Message-ID로 중복을 거른다)
          // 미러는 실고객 메일이다 — 그 메일만의 영구 오류(413 본문 과대)만 건너뛰고, 400·401·403·404 등(시크릿·채널·경로 설정 오류)은 5xx처럼 보류한다.
          // 건너뛰고 위치를 저장하면 설정을 고친 뒤에도 그 사이 메일은 다시 안 읽힌다.
          const skip = cfg.mirror ? e.status === 413 : e.status >= 400 && e.status < 500;
          if (!skip) {
            const loud = e.status >= 400 && e.status < 500; // 미러의 설정 오류 — 고칠 때까지 여기서 멈춰 있다
            console.error(loud ? `[imap] !!! uid ${uid} 보류 — ${e.message}. 서버 설정(INBOUND_SECRET·IMAP_CHANNEL)을 고칠 때까지 이 메일부터 다시 보낸다 !!!` : `[imap] uid ${uid} 보류 — ${e.message}`);
            return;
          }
          console.error(`[imap] uid ${uid} 건너뜀 — ${e.message}`);
        }
      }
    } else console.log(`[imap] uid ${uid} 건너뜀(대상 아님)`);
    state.last = uid; save(cfg, state);
  }
  state.last = Math.max(state.last, next - 1); // 그 사이 지워진 메일 때문에 같은 UID 범위를 계속 다시 받지 않게
  save(cfg, state);
}

function config() {
  const mirror = process.env.IMAP_MODE === 'mirror';
  if (process.env.IMAP_MODE && !mirror) throw new Error('IMAP_MODE 오류(비우거나 mirror)');
  const cfg = {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    to: String(process.env.IMAP_TO || '').trim().toLowerCase(),
    allowed: String(process.env.IMAP_ALLOWED_FROM || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    channel: process.env.IMAP_CHANNEL || 'support',
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, secret: process.env.INBOUND_SECRET,
    authservId: String(process.env.IMAP_AUTHSERV_ID || '').trim(),
    mirror, stateFile: null,
  };
  cfg.ours = [cfg.to, ...addrs(process.env.SMTP_FROM)];
  const missing = Object.entries({ SMTP_USER: cfg.user, SMTP_PASS: cfg.pass, INBOUND_SECRET: cfg.secret, IMAP_TO: cfg.to, ...(!mirror && { IMAP_ALLOWED_FROM: cfg.allowed.length }) })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`설정 필요: ${missing.join(', ')}`);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('IMAP_PORT 오류');
  // 에이전트 답장은 고객 주소로 간다 — 받는 주소가 허용 발신자에 들어 있으면 자기 답장을 다시 문의로 받아 메일 루프가 된다
  if (cfg.allowed.includes(cfg.to)) throw new Error('IMAP_TO 가 IMAP_ALLOWED_FROM 에 있으면 안 된다(메일 루프)');
  if (mirror) {
    // 실고객 메일을 읽는 동안 우리 쪽에서는 어떤 메일도 나가면 안 된다 — 서버 시작 검사와 같은 해석(policy)으로 셋 다 요구한다
    const unsafe = Object.entries({ 'MAIL_PROVIDER=mock': process.env.MAIL_PROVIDER === 'mock', 'AUTO_SEND=0': !policy.autoSendOn(process.env), [`SHADOW_CHANNELS 에 ${cfg.channel}`]: policy.shadowEnv(process.env).includes(cfg.channel) })
      .filter(([, ok]) => !ok).map(([k]) => k);
    if (unsafe.length) throw new Error(`미러 모드는 발송 없는 설정이어야 한다 — 필요: ${unsafe.join(', ')}`);
    const dbFile = require('../server/db').file(); // 여기서만 불러온다(node:sqlite 경고를 시연 모드에 안 띄우게)
    if (!dbFile) throw new Error('미러 모드는 DB_PATH 가 파일이어야 한다(읽은 위치를 DB 폴더에 남겨 재시작 뒤 이어 읽는다)');
    cfg.stateFile = path.join(path.dirname(dbFile), 'imap-state.json');
  }
  return cfg;
}

async function main() {
  let cfg;
  try { cfg = config(); } catch (e) { console.error(`[imap] ${e.message}`); process.exit(2); }
  if (!cfg.authservId) console.error('[imap] IMAP_AUTHSERV_ID 없음 — 발신자 인증 결과(DMARC)를 넘기지 않는다');
  if (cfg.stateFile) fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  const state = cfg.stateFile ? loadState(cfg.stateFile) : { last: null };
  let c = null;
  for (;;) {
    try {
      if (!c) { c = await open(cfg); console.log(`[imap] ${cfg.host} ${cfg.mailbox} 연결 → ${BASE}/api/inbound (${cfg.channel}${cfg.mirror ? ', 미러' : ''}). ${state.last != null ? `UID ${state.last} 다음부터 이어 읽는다` : '지금부터 도착하는 메일만 넘긴다'}`); }
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

module.exports = { parseMessage, accept, headers, createParser, config, poll, loadState, post };
