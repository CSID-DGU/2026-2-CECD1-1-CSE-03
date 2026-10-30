'use strict';
// node:http 단일 프로세스 — REST(spec §5) + SSE(/api/events) + web/ 정적 서빙.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const events = require('./events');
const cases = require('./cases');
const loop = require('./loop');
const policy = require('./policy');
const llm = require('./llm');
const mail = require('./mail');
const pkg = require('../package.json');

const { HttpError } = cases;
const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
const STATS_TRIGGERS = new Set(['case.updated', 'draft.created', 'draft.updated', 'handoff.created', 'message.created']);
// 웹훅 수신 경로 — 사람 인증(AUTH_USER_HEADER) 대신 INBOUND_SECRET으로 지킨다.
const INBOUND = '/api/inbound';
// 사람 인증·프록시 시크릿을 묻지 않는 /api 경로: 웹훅(INBOUND_SECRET)과 헬스체크(컨테이너 안에서 직접 부른다)
const OPEN_API = new Set([INBOUND, '/api/health']);

const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };
// agent:auto는 L2 자동 발송의 승인자 이름 — 사람이 쓰면 그 승인이 "완전 자동응대"로 잡히고 승격 지표에서 빠진다
const by = (b) => { if (!b || typeof b.by !== 'string' || !b.by.trim()) fail(400, 'by(표시 이름) 필요'); if (b.by.trim() === 'agent:auto') fail(400, 'by: 예약된 이름'); return b; };
const authHeader = () => (process.env.AUTH_USER_HEADER || '').toLowerCase();
const testInjectOn = () => process.env.NODE_ENV !== 'production' || process.env.ENABLE_TEST_INJECT === '1';
const mailWarning = () => (process.env.NODE_ENV === 'production' && mail.name() === 'mock' ? 'mock — 실제 발송 안 됨' : undefined);

/** 시크릿 비교는 상수 시간. */
function same(got, want) {
  const a = Buffer.from(String(got || '')); const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const secretOk = (req) => !process.env.INBOUND_SECRET || same(req.headers['x-inbound-secret'], process.env.INBOUND_SECRET);
// 앱 포트에 직접 붙은 요청(프록시 우회)에는 프록시가 넣는 공유 시크릿이 없다 — 사용자 헤더 위조를 막는다
const proxyOk = (req) => !process.env.PROXY_SHARED_SECRET || same(req.headers['x-proxy-secret'], process.env.PROXY_SHARED_SECRET);

/** 수신 — 루프는 응답 뒤에 돈다. occurredAt은 시크릿으로 검증된 어댑터만 넘길 수 있다. */
function inbound(body, trusted) {
  const b = { ...(body || {}) };
  if (!trusted) delete b.occurredAt;
  const r = cases.addInbound(b);
  if (!r.duplicate) setImmediate(() => loop.runCycle(r.caseId, r.messageId).catch((e) => console.error('[loop]', e)));
  return r;
}

const routes = [
  ['GET', /^\/api\/health$/, () => ({
    ok: true, company: process.env.COMPANY_NAME || 'ACME', auth: authHeader() ? 'header' : 'none', provider: { llm: llm.name(), mail: mail.name() },
    version: pkg.version, mailWarning: mailWarning(), testInject: testInjectOn(),
  })],
  ['GET', /^\/api\/me$/, (_m, _q, _b, ctx) => ({ user: ctx.user, auth: authHeader() ? 'header' : 'none' })],
  ['GET', /^\/api\/stats$/, () => cases.stats()],
  ['GET', /^\/api\/policy$/, () => policy.all()],
  ['GET', /^\/api\/agent\/status$/, () => loop.status()],
  ['GET', /^\/api\/versions\/([0-9a-f]{6,40})$/, (m) => db.get('SELECT * FROM versions WHERE hash=?', m[1]) || fail(404, 'version 없음')],
  ['GET', /^\/api\/cases$/, (_m, q) => cases.listCases(q)],
  ['GET', /^\/api\/cases\/([^/]+)$/, (m) => cases.getCase(m[1]) || fail(404, 'case 없음')],
  ['POST', /^\/api\/inbound$/, (_m, _q, b) => inbound(b, !!process.env.INBOUND_SECRET)],
  ['POST', /^\/api\/test\/inbound$/, (_m, _q, b) => (testInjectOn() ? inbound(b, false) : fail(404, 'not found'))],
  ['POST', /^\/api\/drafts\/([^/]+)\/approve$/, (m, _q, b) => loop.approveDraft(m[1], by(b))],
  ['POST', /^\/api\/drafts\/([^/]+)\/discard$/, (m, _q, b) => loop.discardDraft(m[1], by(b))],
  ['POST', /^\/api\/drafts\/([^/]+)\/rate$/, (m, _q, b) => loop.rateShadow(m[1], by(b))],
  ['POST', /^\/api\/drafts\/([^/]+)\/resolve-sending$/, (m, _q, b) => loop.resolveSending(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/takeover$/, (m, _q, b) => loop.takeover(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/return$/, (m, _q, b) => loop.returnToAgent(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/close$/, (m, _q, b) => loop.closeCase(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/reopen$/, (m, _q, b) => loop.reopenCase(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/note$/, (m, _q, b) => loop.addNote(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/human-reply$/, (m, _q, b) => loop.humanReply(m[1], by(b))],
];

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) fail(413, 'body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'invalid JSON'); }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sse(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  send('hello', { at: db.now(), status: loop.status(), stats: cases.stats() });
  // 단순화: 상태 이벤트마다 stats를 다시 센다. 클라이언트 수십 명·케이스 수만 건이면 debounce.
  const unsub = events.subscribe(({ name, data }) => { send(name, data); if (STATS_TRIGGERS.has(name)) send('stats.updated', cases.stats()); });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); unsub(); });
}

function serveStatic(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'bad uri' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB + path.sep)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (rel === '/index.html') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('web/ 대시보드가 아직 없습니다. API: /api/health'); }
    return json(res, 404, { error: 'not found' });
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

async function handle(req, res) {
  let url;
  // 요청 대상이 URL로 안 읽히면(`GET http://[`, 범위 밖 포트) 400 — 예전엔 여기서 프로세스가 죽었다. 깨진 %-인코딩(`/api/cases/%E0%A4%A`)도 400.
  try { url = new URL(req.url, 'http://localhost'); decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'bad request target' }); }
  try {
    const ah = authHeader();
    const user = ah ? (req.headers[ah] ? String(req.headers[ah]) : null) : null;
    // 사람 인증(리버스 프록시가 넣는 헤더) — 켜져 있으면 /api 전부(GET·SSE 포함)에 요구한다. 웹훅 수신·헬스체크만 예외.
    if (url.pathname.startsWith('/api/') && !OPEN_API.has(url.pathname) && (!proxyOk(req) || (ah && !user))) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/api/events') return sse(req, res);
    if (req.method === 'POST') {
      // JSON만 받는다 — 폼·text/plain 교차 출처 요청(CSRF)을 막는다.
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'content-type은 application/json' });
      if (url.pathname === INBOUND && !secretOk(req)) return json(res, 401, { error: 'unauthorized' });
    }
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = url.pathname.match(re);
      if (!m) continue;
      const body = method === 'POST' ? await readJson(req) : null;
      // 켜져 있으면 by는 인증 헤더 값으로 덮는다
      if (body && typeof body === 'object' && ah && url.pathname !== INBOUND) body.by = user;
      const out = await handler(m, Object.fromEntries(url.searchParams), body, { user });
      return json(res, 200, out ?? {});
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error('[http]', e);
    return json(res, 500, { error: 'internal' });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    // 마지막 그물 — 핸들러의 어떤 예외(응답을 이미 쓰기 시작한 뒤 포함)도 프로세스를 죽이지 않는다
    handle(req, res).catch((e) => {
      console.error('[http]', e);
      try { if (res.headersSent) res.destroy(); else json(res, 500, { error: 'internal' }); } catch { /* 소켓이 이미 닫혔다 */ }
    });
  });
}

if (require.main === module) {
  // 운영 + mock 메일이면 승인해도 고객에게 아무것도 안 나간다(SENT는 허구) — 명시적으로 허용하지 않으면 시작하지 않는다
  if (mailWarning() && process.env.ALLOW_MOCK_MAIL !== '1') {
    console.error('시작 거부: NODE_ENV=production인데 MAIL_PROVIDER=mock. 실발송은 MAIL_PROVIDER=smtp(+SMTP_*·MAIL_ALLOWED_DOMAINS), 발송 없는 시연이면 ALLOW_MOCK_MAIL=1.');
    process.exit(1);
  }
  // 비교 실험 스위치(발송 시점 장치 끄기)는 실험 전용 — 서버는 장치를 끈 채 뜨지 않는다
  if (process.env.CS_ABLATE) {
    console.error('시작 거부: CS_ABLATE가 설정돼 있다(비교 실험 전용). 비우고 다시 시작한다.');
    process.exit(1);
  }
  policy.all(); // 팩 검증 — 잘못된 팩이면 여기서 죽는다
  db.init();
  if (mailWarning()) console.warn('\n!!! NODE_ENV=production인데 MAIL_PROVIDER=mock(ALLOW_MOCK_MAIL=1) — 승인해도 고객에게 메일이 나가지 않는다 !!!\n');
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, process.env.HOST || undefined, () => {
    console.log(`cs-agent http://localhost:${port}  llm=${llm.name()} mail=${mail.name()} auto_send=${policy.autoSendOn() ? 'on' : 'off'} db=${process.env.DB_PATH || 'data/cs-agent.db'}`);
    loop.recover().catch((e) => console.error('[recover]', e));
    require('./sweeper').start();
    require('./notify').start();
  });
}

module.exports = { createServer };
