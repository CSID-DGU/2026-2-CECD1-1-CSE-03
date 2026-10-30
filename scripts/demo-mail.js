'use strict';
// npm run demo:mail [-- --check] — 실제 메일 계정 없이 메일 왕복 전체를 로컬에서 돌리는 시연 환경.
// 가짜 메일 서버(IMAP TLS·SMTP, 루프백 임의 포트) + 고객 메일함 화면(:2600) + 서버(:3000, MAIL_PROVIDER=smtp) + 수신 어댑터(scripts/inbound-imap.js).
// 서버와 어댑터는 운영과 같은 코드로 실제 IMAP·SMTP에 붙는다. 바뀌는 건 메일 서버뿐이다. 실행마다 새 DB·인증서·비밀번호(임시 폴더, 끝나면 지움).
// --check: 준비 뒤 세 시나리오(영수증·환불·로그인)를 보내고 결과를 확인한 뒤 종료(0 = 통과).
const tls = require('node:tls');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { parseMessage } = require('./inbound-imap');

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const PORT = Number(arg('port', 3000));
const BOX_PORT = Number(arg('mail-port', 2600));
const CHECK = process.argv.includes('--check');
const APP = `http://127.0.0.1:${PORT}`;
const SUPPORT = 'support@acme.example';
const CUSTOMER = { name: '김민지', email: 'minji@example.com' };
const PRESETS = [
  { label: '영수증', subject: '영수증 발급 문의', body: '지난달 결제한 건의 영수증을 받고 싶습니다. 어디서 받을 수 있나요?' },
  { label: '환불', subject: '환불 요청드립니다', body: '이번 달 결제 건 환불 부탁드립니다. 거의 사용하지 못했습니다.' },
  { label: '로그인', subject: '로그인이 안 됩니다', body: '비밀번호를 잊어버려서 로그인이 안 됩니다. 어떻게 해야 하나요?' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-demo-'));
const PASS = crypto.randomBytes(12).toString('hex');
const SECRET = crypto.randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let examined; const firstExamine = new Promise((r) => { examined = r; }); // 어댑터가 기준점(UIDNEXT)을 잡은 뒤에야 메일을 보낸다

// ---------- 메일 저장소 ----------
const box = []; // { uid, raw: Buffer, sender, rcpts[], at }
let nextUid = 1;
const deliver = (raw, sender, rcpts) => box.push({ uid: nextUid++, raw: Buffer.from(raw), sender: sender.toLowerCase(), rcpts: rcpts.map((r) => r.toLowerCase()), at: Date.now() });
const inbox = () => box.filter((m) => m.rcpts.includes(SUPPORT)); // 어댑터가 IMAP으로 읽는 support 메일함
const b64 = (s) => Buffer.from(s).toString('base64');

function compose(subject, body) {
  const id = `<demo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.com>`;
  const raw = [
    `From: =?UTF-8?B?${b64(CUSTOMER.name)}?= <${CUSTOMER.email}>`, `To: ${SUPPORT}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: ${id}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(`${body}\r\n`), '',
  ].join('\r\n');
  deliver(raw, CUSTOMER.email, [SUPPORT]);
  return id;
}

// ---------- IMAP(TLS, 읽기 전용 명령만) ----------
function imapServer(key, cert) {
  return tls.createServer({ key, cert }, (s) => {
    s.write('* OK demo imap ready\r\n');
    let buf = ''; let authed = false;
    s.on('error', () => {});
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, verb = '', ...rest] = line.split(' ');
        const V = verb.toUpperCase(); const a = rest.join(' ');
        if (V === 'LOGIN') {
          authed = a === `"${SUPPORT}" "${PASS}"`;
          s.write(authed ? `${tag} OK LOGIN done\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (V === 'LOGOUT') s.end(`* BYE\r\n${tag} OK\r\n`);
        else if (!authed) s.write(`${tag} BAD not authenticated\r\n`);
        else if (V === 'EXAMINE') {
          s.write(`* ${inbox().length} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT ${nextUid}] next\r\n${tag} OK [READ-ONLY] done\r\n`);
          setImmediate(examined);
        }
        else if (V === 'UID' && /^FETCH /i.test(a)) {
          const m = /^FETCH (\d+)(:\*)? (.*)$/i.exec(a);
          const list = inbox(); const from = Number(m?.[1]);
          let hits = m?.[2] ? list.filter((x) => x.uid >= from) : list.filter((x) => x.uid === from);
          if (m?.[2] && !hits.length && list.length) hits = [list.at(-1)]; // n:* 에서 n이 최대 UID보다 크면 마지막 메일(IMAP 규칙, Gmail도 이렇게 준다)
          const hf = m && /HEADER\.FIELDS \(([^)]*)\)/i.exec(m[3]);
          for (const x of hits) {
            const lit = hf ? headerFields(x.raw, hf[1].toUpperCase().split(/\s+/)) : x.raw;
            s.write(Buffer.concat([Buffer.from(`* ${list.indexOf(x) + 1} FETCH (UID ${x.uid} BODY[${hf ? `HEADER.FIELDS (${hf[1]})` : ''}] {${lit.length}}\r\n`), lit, Buffer.from(')\r\n')]));
          }
          s.write(`${tag} OK fetch done\r\n`);
        } else s.write(`${tag} OK ${V} done\r\n`);
      }
    });
  });
}

function headerFields(raw, fields) {
  const s = raw.toString('latin1');
  const lines = s.slice(0, s.search(/\r\n\r\n/)).split(/\r\n(?![ \t])/);
  return Buffer.from(`${lines.filter((l) => fields.includes(l.split(':')[0].trim().toUpperCase())).join('\r\n')}\r\n\r\n`, 'latin1');
}

// ---------- SMTP(평문, 루프백 전용) ----------
function smtpServer() {
  return net.createServer((s) => {
    s.write('220 demo smtp\r\n');
    let buf = ''; let data = false; let authed = false; let env = { rcpts: [] };
    s.on('error', () => {});
    s.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (data) {
          const e = buf.indexOf('\r\n.\r\n');
          if (e < 0) return;
          deliver(Buffer.from(buf.slice(0, e).replace(/(^|\r\n)\.\./g, '$1.'), 'latin1'), env.from, env.rcpts);
          buf = buf.slice(e + 5); data = false; env = { rcpts: [] };
          s.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const addr = () => (/<([^>]*)>/.exec(line)?.[1] || '');
        if (/^EHLO/i.test(line)) s.write('250-demo\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          authed = u === SUPPORT && p === PASS;
          s.write(authed ? '235 ok\r\n' : '535 bad credentials\r\n');
        } else if (/^QUIT/i.test(line)) s.end('221 bye\r\n');
        else if (!authed && /^(MAIL|RCPT|DATA)/i.test(line)) s.write('530 auth required\r\n');
        else if (/^MAIL FROM:/i.test(line)) { env.from = addr(); s.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { env.rcpts.push(addr()); s.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { data = true; s.write('354 go\r\n'); }
        else s.write('250 ok\r\n');
      }
    });
  });
}

// ---------- 고객 메일함 화면 ----------
function view() {
  return box.filter((m) => m.sender === CUSTOMER.email || m.rcpts.includes(CUSTOMER.email)).map((m) => {
    const p = parseMessage(m.raw);
    return { uid: m.uid, at: m.at, mine: m.sender === CUSTOMER.email, fromName: p.name || p.from, subject: p.subject, body: p.body, messageId: p.providerMessageId, inReplyTo: p.inReplyTo, references: p.references };
  });
}

function mailboxServer() {
  const page = path.join(__dirname, 'demo-mailbox.html');
  const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(v)); };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x').pathname; // ?zoom= 같은 쿼리는 화면이 읽는다
    if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(page)); }
    if (req.method === 'GET' && url === '/api/info') return json(res, 200, { customer: CUSTOMER, support: SUPPORT, supportName: 'ACME 고객지원', presets: PRESETS });
    if (req.method === 'GET' && url === '/api/mail') return json(res, 200, view());
    if (req.method === 'POST' && url === '/api/send') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'application/json 만 받습니다' }); // 다른 사이트의 폼 POST 차단
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 20000) return json(res, 413, { error: 'too large' }); }
      let b; try { b = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      if (!b || typeof b !== 'object') return json(res, 400, { error: 'invalid JSON' });
      const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      const body = String(b.body || '').trim().slice(0, 5000);
      if (!subject || !body) return json(res, 400, { error: '제목과 본문이 필요합니다' });
      return json(res, 200, { ok: true, messageId: compose(subject, body) });
    }
    json(res, 404, { error: 'not found' });
  });
}

// ---------- 서버·어댑터 ----------
const children = [];
function run(name, file, env) {
  if (stopping) throw new Error('종료 중');
  const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', file)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  for (const s of [p.stdout, p.stderr]) readline.createInterface({ input: s }).on('line', (l) => { lines.push(l); console.log(`[${name}] ${l}`); });
  p.on('exit', (code) => { if (!stopping) { console.error(`[demo] ${name} 종료(code ${code}) — 전체 종료`); stop(1); } });
  children.push(p);
  return { waitFor: async (re, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (lines.some((l) => re.test(l))) return; throw new Error(`${name} 준비 시간 초과`); } };
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const p of children) p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 300);
}

const listen = (srv, port, host) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, host, () => resolve(srv.address().port)); });

async function check() {
  const api = async (p, body) => (await fetch(`${APP}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
  const until = async (what, fn, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { const v = await fn(); if (v) return v; } throw new Error(`시간 초과: ${what}`); };
  const replies = (subject) => { const root = view().find((m) => m.mine && m.subject === subject)?.messageId; return view().filter((m) => !m.mine && root && `${m.inReplyTo} ${m.references}`.includes(root)); };
  const caseOf = async (subject) => (await api(`/api/cases?q=${encodeURIComponent(subject)}`))[0];
  const [receipt, refund, login] = PRESETS;
  for (const p of PRESETS) compose(p.subject, p.body);
  const results = [];
  const r1 = await until('영수증 자동 답장', () => replies(receipt.subject)[0]);
  results.push(['영수증 → 자동 답장(L2)', /자동으로 보냈습니다/.test(r1.body) && (await caseOf(receipt.subject))?.responder === 'agent']); // 넘김 접수 안내도 같은 맺음말이라 responder로 가른다
  const r2 = await until('환불 접수 안내', () => replies(refund.subject)[0]);
  results.push(['환불 → 접수 안내 + 넘김(H)', (await caseOf(refund.subject))?.state === 'HANDED_OFF' && !!r2]);
  const c3 = await until('로그인 승인 대기', async () => { const c = await caseOf(login.subject); return c?.pendingDraftId && c; });
  results.push(['로그인 → 승인 대기, 답장 없음(L1)', replies(login.subject).length === 0]);
  await api(`/api/drafts/${c3.pendingDraftId}/approve`, { by: '데모 검토자' });
  const r3 = await until('로그인 승인 후 답장', () => replies(login.subject)[0]);
  results.push(['로그인 → 승인 후 답장', /담당자 검토 후 발송/.test(r3.body)]);
  for (const [k, ok] of results) console.log(`[check] ${ok ? '통과' : '실패'}  ${k}`);
  return results.every(([, ok]) => ok);
}

async function main() {
  try { execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7', '-subj', '/CN=localhost', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' }); } catch { throw new Error('openssl 이 필요합니다(가짜 IMAP 서버용 임시 인증서)'); }
  const cert = path.join(tmp, 'cert.pem');
  const imapPort = await listen(imapServer(fs.readFileSync(path.join(tmp, 'key.pem')), fs.readFileSync(cert)), 0, 'localhost');
  const smtpPort = await listen(smtpServer(), 0, '127.0.0.1');
  await listen(mailboxServer(), BOX_PORT, '127.0.0.1');

  const env = {
    AUTO_SEND: '1', LLM_MOCK_DELAY_MS: '700', ...process.env, // AUTO_SEND=0 을 주면 그대로 꺼진다(킬 스위치)
    // 셸에 남은 실계정·운영 설정이 데모를 망치지 않게 비운다(빈 값 = 끔)
    SMTP_SECURE: '', AUTH_USER_HEADER: '', PROXY_SHARED_SECRET: '', NOTIFY_WEBHOOK_URL: '',
    HOST: '127.0.0.1', PORT: String(PORT), SIM_URL: `${APP}`, DB_PATH: path.join(tmp, 'demo.db'), INBOUND_SECRET: SECRET,
    MAIL_PROVIDER: 'smtp', MAIL_ALLOWED_DOMAINS: CUSTOMER.email.split('@')[1], SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_ALLOW_PLAIN: '1',
    SMTP_USER: SUPPORT, SMTP_PASS: PASS, SMTP_FROM: `ACME 고객지원 <${SUPPORT}>`,
    IMAP_HOST: 'localhost', IMAP_PORT: String(imapPort), IMAP_MAILBOX: 'INBOX', IMAP_TO: SUPPORT, IMAP_ALLOWED_FROM: CUSTOMER.email, IMAP_CHANNEL: 'support',
  };
  const server = run('server', 'server/index.js', env);
  await server.waitFor(/^cs-agent http/);
  const imap = run('imap', 'scripts/inbound-imap.js', { ...env, NODE_EXTRA_CA_CERTS: cert });
  await imap.waitFor(/연결/);

  await firstExamine;
  const health = await (await fetch(`${APP}/api/health`)).json();
  console.log(`\n[demo] 준비 완료 — llm=${health.provider.llm} mail=smtp(가짜 메일 서버)\n  고객 메일함  http://127.0.0.1:${BOX_PORT}\n  백오피스     ${APP}\n  Ctrl+C 로 종료(임시 DB·인증서 삭제)\n`);
  if (CHECK) stop((await check()) ? 0 : 1);
}

// 어떻게 끝나든(처리 안 된 예외 포함) 자식 프로세스와 임시 폴더를 남기지 않는다
process.on('exit', () => { for (const p of children) p.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
main().catch((e) => { console.error(`[demo] ${e.message}`); stop(1); });
