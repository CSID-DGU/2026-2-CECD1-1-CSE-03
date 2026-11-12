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
const accesslog = require('./accesslog');
const report = require('./report');
const retention = require('./retention');
const collections = require('./collections');
const store = require('./store');
const crm = require('./crm');
const guard = require('./guard');
const configConsole = require('./console');
const kbIndex = require('./kb-index');
const embed = require('./embed');
const vectorStore = require('./vector-store');
const pkg = require('../package.json');

const { HttpError } = cases;
const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
// 모든 응답(JSON·정적·SSE·401)에 붙인다. 대시보드는 같은 출처 파일만 쓴다(인라인 스크립트·외부 자원 없음). HSTS는 TLS를 끝내는 프록시 몫.
const SECURITY_HEADERS = [
  ['content-security-policy', "default-src 'self'; frame-ancestors 'none'"], ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'],
];
const STATS_TRIGGERS = new Set(['case.updated', 'draft.created', 'draft.updated', 'handoff.created', 'message.created']);
// 웹훅 수신 경로 — 사람 인증(AUTH_USER_HEADER) 대신 INBOUND_SECRET으로 지킨다.
const INBOUND = '/api/inbound';
// 사람 인증·프록시 시크릿을 묻지 않는 /api 경로: 웹훅(INBOUND_SECRET)과 헬스체크(컨테이너 안에서 직접 부른다 — 본문은 {ok, config}뿐, 상세는 /api/status)
const OPEN_API = new Set([INBOUND, '/api/health']);

const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };
// agent:auto는 L2 자동 발송의 승인자 이름 — 사람이 쓰면 그 승인이 "완전 자동응대"로 잡히고 승격 지표에서 빠진다
const by = (b) => { if (!b || typeof b.by !== 'string' || !b.by.trim()) fail(400, 'by(표시 이름) 필요'); if (b.by.trim() === 'agent:auto') fail(400, 'by: 예약된 이름'); return b; };
const authHeader = () => (process.env.AUTH_USER_HEADER || '').toLowerCase();
// 테스트 주입: 명시적으로 켜거나, 개발 + mock 메일(로컬 시연)일 때만. NODE_ENV가 빠진 실발송 서버는 닫힌다.
const testInjectOn = () => process.env.ENABLE_TEST_INJECT === '1' || (process.env.NODE_ENV !== 'production' && mail.name() === 'mock');
const mailWarning = () => (process.env.NODE_ENV === 'production' && mail.name() === 'mock' ? 'mock — 실제 발송 안 됨' : undefined);
const senderAuthMode = () => (policy.requireSenderAuth() ? 'required' : 'optional');
const tokenBudget = () => Number(process.env.LLM_DAILY_TOKEN_BUDGET) || null; // 형식은 시작 검사가 본다
/** 접수 Agent KB 설정 + rag면 채널마다 미리 색인(이미 맞으면 다시 임베딩하지 않는다). full이면 색인하지 않는다. */
async function kbIndexStatus() {
  const cfg = kbIndex.config();
  if (cfg.mode !== 'rag') return { ...cfg, embed: null, store: null, channels: [] };
  const channels = await kbIndex.warm(policy.all().map((p) => p.channel));
  let info = null; try { info = embed.info(); } catch { /* 설정 오류는 채널별 error에 있다 */ }
  return { ...cfg, embed: info, store: process.env.VECTOR_STORE || 'memory', channels };
}

/** 시크릿 비교는 상수 시간. */
function same(got, want) {
  const a = Buffer.from(String(got || '')); const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const secretOk = (req) => !process.env.INBOUND_SECRET || same(req.headers['x-inbound-secret'], process.env.INBOUND_SECRET);
// 앱 포트에 직접 붙은 요청(프록시 우회)에는 프록시가 넣는 공유 시크릿이 없다 — 사용자 헤더 위조를 막는다
const proxyOk = (req) => !process.env.PROXY_SHARED_SECRET || same(req.headers['x-proxy-secret'], process.env.PROXY_SHARED_SECRET);
// 접속기록의 ip — 소켓 주소. x-forwarded-for는 프록시 시크릿이 확인된 요청에서만 믿고, 그 프록시가 붙인 마지막 값을 쓴다(앞쪽은 클라이언트가 넣을 수 있다).
const ipOf = (req) => (process.env.PROXY_SHARED_SECRET && proxyOk(req) && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || null;

/**
 * 시작 검사 — 오류가 하나라도 있으면 main이 전부 출력하고 시작하지 않는다. env를 인자로 받는 순수 함수(테스트용).
 * 경고(warnings)는 시작은 하되 기동 로그에 남길 설정.
 */
function preflight(env = process.env) {
  const errors = []; const warnings = [];
  const prod = env.NODE_ENV === 'production';
  const mockMail = (env.MAIL_PROVIDER || 'mock') === 'mock';
  // 운영 + mock 메일이면 승인해도 고객에게 아무것도 안 나간다(SENT는 허구) — 명시적으로 허용하지 않으면 시작하지 않는다
  if (prod && mockMail && env.ALLOW_MOCK_MAIL !== '1') errors.push('NODE_ENV=production인데 MAIL_PROVIDER=mock. 실발송은 MAIL_PROVIDER=smtp(+SMTP_*·MAIL_ALLOWED_DOMAINS), 발송 없는 시연이면 ALLOW_MOCK_MAIL=1.');
  // 비교 실험 스위치(발송 시점 장치 끄기)는 실험 전용 — 서버는 장치를 끈 채 뜨지 않는다
  if (env.CS_ABLATE) errors.push('CS_ABLATE가 설정돼 있다(비교 실험 전용). 비우고 다시 시작한다.');
  // 운영은 웹훅·사람 인증·프록시 우회 차단이 모두 있어야 한다 — 하나라도 없으면 고객 원문이 무인증으로 열리거나 아무나 메일을 넣는다.
  // NODE_ENV와 무관하게 실발송(smtp)을 루프백 밖에 열어도 같다(Docker -e NODE_ENV= 는 이미지의 HOST=0.0.0.0·smtp를 그대로 둔다).
  // 루프백의 smtp(로컬 메일 E2E)와 mock 메일의 LAN 시연은 그대로 뜬다.
  const exposedSmtp = env.MAIL_PROVIDER === 'smtp' && !['127.0.0.1', '::1', 'localhost'].includes(env.HOST || '127.0.0.1');
  if (prod || exposedSmtp) {
    const why = prod ? 'NODE_ENV=production' : `MAIL_PROVIDER=smtp + HOST=${env.HOST}(루프백 아님)`;
    const fix = prod ? '발송 없는 로컬 시연은 NODE_ENV를 비운다(Docker는 -e NODE_ENV= -e MAIL_PROVIDER=mock).' : '실메일 로컬 시연은 HOST=127.0.0.1, 발송 없는 시연은 MAIL_PROVIDER=mock.';
    for (const k of ['INBOUND_SECRET', 'AUTH_USER_HEADER', 'PROXY_SHARED_SECRET']) {
      if (!env[k]) errors.push(`${why}인데 ${k}가 비어 있다. ${fix}`);
    }
  }
  // 미러(실고객 공유 메일함 읽기)는 어떤 경로로도 메일이 나가면 안 된다 — 환경과 무관하게 무발송·섀도를 요구한다(어댑터도 같은 검사)
  if (env.IMAP_MODE === 'mirror') {
    const ch = env.IMAP_CHANNEL || 'support';
    if (!mockMail) errors.push('IMAP_MODE=mirror인데 MAIL_PROVIDER가 mock이 아니다. 미러는 MAIL_PROVIDER=mock(production이면 ALLOW_MOCK_MAIL=1도).');
    if (policy.autoSendOn(env)) errors.push('IMAP_MODE=mirror인데 AUTO_SEND가 켜져 있다. AUTO_SEND=0.');
    if (!policy.shadowEnv(env).includes(ch)) errors.push(`IMAP_MODE=mirror인데 SHADOW_CHANNELS에 ${ch}(IMAP_CHANNEL)가 없다.`);
  }
  for (const k of ['RETENTION_DAYS', 'LLM_DAILY_TOKEN_BUDGET']) {
    if (env[k] && !/^[1-9]\d*$/.test(env[k])) errors.push(`${k}=${env[k]} — 비우거나 1 이상의 정수.`);
  }
  // 접수 Agent RAG(KB_MODE=rag). 이번 단계의 임베딩·저장소는 mock·memory뿐이다
  if (env.KB_MODE && !['full', 'rag'].includes(env.KB_MODE)) errors.push(`KB_MODE=${env.KB_MODE} — 비우거나 full | rag.`);
  if (env.KB_TOPK && !(/^[1-9]\d*$/.test(env.KB_TOPK) && Number(env.KB_TOPK) <= kbIndex.TOPK_MAX)) errors.push(`KB_TOPK=${env.KB_TOPK} — 비우거나 1~${kbIndex.TOPK_MAX} 정수.`);
  if (env.KB_TRIAGE_TOC && !['0', '1'].includes(env.KB_TRIAGE_TOC)) errors.push(`KB_TRIAGE_TOC=${env.KB_TRIAGE_TOC} — 비우거나 0 | 1.`);
  if (env.EMBED_PROVIDER && !embed.PROVIDERS[env.EMBED_PROVIDER]) errors.push(`EMBED_PROVIDER=${env.EMBED_PROVIDER} — 비우거나 ${Object.keys(embed.PROVIDERS).join(' | ')}.`);
  if (env.VECTOR_STORE && !vectorStore.STORES[env.VECTOR_STORE]) errors.push(`VECTOR_STORE=${env.VECTOR_STORE} — 비우거나 ${Object.keys(vectorStore.STORES).join(' | ')}.`);
  if (prod && env.KB_MODE === 'rag') warnings.push('KB_MODE=rag — 임베딩은 mock, 벡터 저장소는 memory(시험용)입니다.');
  // 자동 메일이 실제로 나가는 설정(smtp + 자동 발송 켬)에서만 — 꺼져 있으면 인증과 무관하게 자동 메일이 없다
  if (env.MAIL_PROVIDER === 'smtp' && policy.autoSendOn(env) && !policy.requireSenderAuth(env)) warnings.push('MAIL_PROVIDER=smtp인데 REQUIRE_SENDER_AUTH가 꺼져 있다 — 인증 결과 없는 메일에도 자동 메일이 나갑니다.');
  if (prod && (env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock')) === 'anthropic' && !env.LLM_DAILY_TOKEN_BUDGET) warnings.push('일일 토큰 예산이 없습니다(LLM_DAILY_TOKEN_BUDGET) — LLM 비용 상한 없음.');
  // 콘솔 편집 — 관리자 목록이 비면 아무도 못 고친다. 사용자 헤더 + 프록시 시크릿이 없으면 콘솔 쓰기는 루프백에서만 받는다.
  if (prod && !String(env.ADMIN_USERS || '').split(',').some((s) => s.trim())) warnings.push('ADMIN_USERS가 비어 있습니다 — 콘솔 편집 불가.');
  if (!['127.0.0.1', '::1', 'localhost'].includes(env.HOST || '127.0.0.1') && !(env.AUTH_USER_HEADER && env.PROXY_SHARED_SECRET)) warnings.push(`HOST=${env.HOST}(루프백 아님)인데 AUTH_USER_HEADER·PROXY_SHARED_SECRET이 다 있지 않습니다 — 콘솔 쓰기는 루프백에서만 됩니다.`);
  return { errors, warnings };
}

/** 수신 — 루프는 응답 뒤에 돈다. occurredAt·senderAuth는 시크릿으로 검증된 어댑터만 넘길 수 있다. */
function inbound(body, trusted, test = false) {
  const b = { ...(body || {}) };
  // 미러 페이로드(실고객 메일)는 이 서버가 무발송·섀도일 때만 받는다 — 어댑터와 서버 env가 달라도 메일이 나가지 않게. 저장 전에 거부하고, 어댑터는 5xx면 보류했다가 다시 보낸다.
  if (b.mirror && (mail.name() !== 'mock' || policy.autoSendOn() || !policy.load(b.channel)?.shadow)) fail(503, 'mirror_unsafe');
  if (!trusted) { delete b.occurredAt; delete b.senderAuth; }
  delete b.system; // 테스트 주입 표시는 서버만 붙인다
  const r = cases.addInbound({ ...b, ...(test ? { system: 'test' } : {}) });
  if (!r.duplicate) setImmediate(() => loop.runCycle(r.caseId, r.messageId).catch((e) => console.error('[loop]', e)));
  return r;
}

/* ---------------- CRM(컬렉션 문서만 읽는다 — 예외: 승인 화면의 대기 초안은 drafts에서) ---------------- */

const mustCase = (id) => db.get('SELECT * FROM cases WHERE id=?', id) || fail(404, 'case 없음');
const note500 = (t) => guard.maskPii(t).slice(0, 500); // 보류 메모·종결 상세에도 고객 식별자를 남기지 않는다

/** 화면이 본 케이스 문서 revision이 지금과 다르면 409 stale — 그 사이 회차·다른 담당자가 케이스를 바꿨다. 보내지 않았으면 검사하지 않는다. */
function fresh(caseId, expected) {
  if (expected === undefined || expected === null) return;
  collections.markDirty(caseId); collections.flush();
  const revision = store.get('cases', caseId)?.revision ?? null;
  if (revision !== Number(expected)) fail(409, 'stale', { revision });
}

function caseActivity(caseId, type, actor, payload, now) {
  db.insert('activities', { id: db.uuid(), case_id: caseId, type, actor, payload: payload ? JSON.stringify(payload) : null, created_at: now });
  events.emit('case.updated', { caseId, ...db.get('SELECT state, responder FROM cases WHERE id=?', caseId) });
}

/** 보류 — 사람 전담·종결 아닌 케이스만. 보류 중엔 자동 종결하지 않는다. */
function hold(caseId, { by: who, note, expectedRevision }) {
  const c = mustCase(caseId);
  const text = String(note ?? '').trim();
  if (!text) fail(400, 'note 필요');
  fresh(caseId, expectedRevision);
  if (c.responder !== 'human' || c.state === 'CLOSED') fail(409, 'not_escalated');
  if (c.held_at) fail(409, 'already_held');
  const now = db.now(); const masked = note500(text);
  db.tx(() => {
    db.run('UPDATE cases SET held_at=?, hold_note=?, updated_at=? WHERE id=?', now, masked, now, caseId);
    caseActivity(caseId, 'hold', who, { note: masked }, now);
  });
  return { caseId, held: true };
}

function unhold(caseId, { by: who, expectedRevision }) {
  const c = mustCase(caseId);
  fresh(caseId, expectedRevision);
  if (!c.held_at) fail(409, 'not_held');
  const now = db.now();
  db.tx(() => {
    db.run('UPDATE cases SET held_at=NULL, hold_note=NULL, updated_at=? WHERE id=?', now, caseId);
    caseActivity(caseId, 'unhold', who, null, now);
  });
  return { caseId, held: false };
}

/** 종결 — 사유 필수(기타면 상세도). 사유 기록·보류 해제·종결이 한 트랜잭션: 발송 중(409 sending)이면 사유도 남지 않는다. */
function close(caseId, { by: who, reason, detail, expectedRevision }) {
  mustCase(caseId);
  if (!crm.CLOSE_REASONS.includes(reason)) fail(400, 'bad_reason');
  const text = String(detail ?? '').trim();
  if (reason === 'other' && !text) fail(400, 'detail 필요');
  fresh(caseId, expectedRevision);
  return db.tx(() => {
    if (db.get('SELECT state FROM cases WHERE id=?', caseId).state === 'CLOSED') fail(409, 'already_closed');
    db.run('UPDATE cases SET close_reason=?, close_detail=?, held_at=NULL, hold_note=NULL WHERE id=?', reason, text ? note500(text) : null, caseId);
    // LLM 장애 재시도 예약·회차 claim을 지운다(retention.purge와 같다) — 남으면 스위퍼가 닫은 케이스에 회차를 돌려 다시 연다.
    // 남는 틈: 닫는 순간 LLM을 기다리던 회차가 실패하면 재시도 예약이 케이스를 OPEN으로 되돌린다. 문서는 Closed가 아니면 closeReason을 비운다.
    db.run("UPDATE loops SET next_retry_at=NULL, retry_count=0, retry_message_id=NULL, queue='[]' WHERE case_id=?", caseId);
    db.run('DELETE FROM claims WHERE key LIKE ?', `loop:${caseId}:%`);
    return { ...loop.closeCase(caseId, { by: who }), closeReason: reason };
  });
}

/** 반환 — 보류 중이면 먼저 풀고, 반환이 거절되면(409 등) 보류를 되돌린다. */
async function returnCase(caseId, b) {
  const c = mustCase(caseId);
  if (c.held_at) db.run('UPDATE cases SET held_at=NULL, hold_note=NULL WHERE id=?', caseId);
  try { return await loop.returnToAgent(caseId, b); } catch (e) {
    if (c.held_at) db.run('UPDATE cases SET held_at=?, hold_note=? WHERE id=?', c.held_at, c.hold_note, caseId);
    throw e;
  }
}

/** 상세 — 그 케이스를 지금 다시 동기화한 뒤 문서로 만든다(emit 없는 쓰기도 상세에서는 늘 맞다). */
function crmDetail(id) {
  collections.markDirty(id); collections.flush();
  const cur = store.get('cases', id) || fail(404, 'case 없음');
  const doc = cur.doc;
  const drafts = db.all("SELECT * FROM drafts WHERE case_id=? AND status IN ('PENDING','SHADOW','SENDING') ORDER BY created_at, rowid", id);
  const rated = new Set(db.all("SELECT json_extract(payload, '$.draftId') d FROM activities WHERE case_id=? AND type='shadow_rating'", id).map((r) => r.d));
  const pending = drafts.filter((d) => d.status === 'PENDING').at(-1);
  const sending = drafts.filter((d) => d.status === 'SENDING').at(-1);
  // 승인 화면: 실제로 나갈 메일 전체 + 근거 KB 문장 — /api/cases/:id와 같은 계산
  const full = pending || sending ? cases.getCase(id).drafts : [];
  return crm.detailView({
    doc, revision: cur.revision,
    contact: doc.contactId ? store.get('contacts', doc.contactId)?.doc ?? null : null,
    company: doc.companyId ? store.get('companies', doc.companyId)?.doc ?? null : null,
    related: [...(doc.relatedCaseId ? [store.get('cases', doc.relatedCaseId)?.doc] : []), ...store.find('cases', { relatedCaseId: id })].filter(Boolean),
    events: store.find('inbound_events', { resolvedCaseId: id }),
    activities: store.find('activities', { caseId: id }),
    pendingDraft: pending ? full.find((d) => d.id === pending.id) : null,
    shadowDraft: drafts.filter((d) => d.status === 'SHADOW' && !rated.has(d.id)).at(-1) ?? null,
    agentLog: crm.agentLog(db.all("SELECT id, step, created_at, output FROM decisions WHERE case_id=? AND step IN ('triage','respond') ORDER BY created_at, rowid", id)),
    sendingDraft: sending ? full.find((d) => d.id === sending.id) : null,
  });
}

const CORE = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, config: configConsole.configState() })],
  ['GET', /^\/api\/status$/, () => ({
    ok: true, company: process.env.COMPANY_NAME || 'ACME', auth: authHeader() ? 'header' : 'none', provider: { llm: llm.name(), mail: mail.name() },
    version: pkg.version, mailWarning: mailWarning(), testInject: testInjectOn(),
    autoSend: policy.autoSendOn(), senderAuth: senderAuthMode(), retentionDays: retention.days(), tokenBudget: tokenBudget(),
    crm: collections.status(),
  })],
  ['GET', /^\/api\/report$/, () => ({ llm: report.llmUsage(), promotion: report.promotionByIntent() })],
  ['GET', /^\/api\/report\/workload$/, (_m, q) => {
    // 기간은 UTC ISO로 맞춰 비교한다(occurred_at은 UTC ISO 문자열). 날짜만(YYYY-MM-DD)이면 UTC 자정 = 한국 시간 09:00.
    // 시각이 붙으면 Z·±hh:mm가 있어야 한다 — 없으면 Date.parse가 서버 현지 시각으로 읽는다. 그 밖·날짜로 안 읽히면 400
    const iso = (k) => {
      const v = q[k]; if (!v) return null;
      const t = /^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/i.test(v) ? Date.parse(v) : NaN;
      return Number.isNaN(t) ? fail(400, 'bad_date', { field: k }) : new Date(t).toISOString();
    };
    return report.workload({ from: iso('from'), to: iso('to'), channel: q.channel || null });
  }],
  // 매뉴얼 보강 목록 — 고객 질문에서 온 글(가린 뒤)이라 섀도 목록처럼 접속기록을 남긴다
  ['GET', /^\/api\/report\/knowledge-gaps$/, (_m, q, _b, ctx) => {
    const g = report.knowledgeGaps({ channel: q.channel, limit: q.limit });
    accesslog.write({ action: 'knowledge_gaps.list', ...ctx, channel: q.channel ?? null, count: g.items.length });
    return g;
  }],
  ['GET', /^\/api\/shadow$/, (_m, q, _b, ctx) => {
    const items = report.unratedShadow({ channel: q.channel, limit: q.limit });
    accesslog.write({ action: 'shadow.list', ...ctx, channel: q.channel ?? null, count: items.length });
    return { items };
  }],
  ['GET', /^\/api\/me$/, (_m, _q, _b, ctx) => ({ user: ctx.user, auth: authHeader() ? 'header' : 'none' })],
  ['GET', /^\/api\/stats$/, () => cases.stats()],
  ['GET', /^\/api\/policy$/, () => policy.all()],
  ['GET', /^\/api\/agent\/status$/, () => loop.status()],
  ['GET', /^\/api\/versions\/([0-9a-f]{6,40})$/, (m) => db.get('SELECT * FROM versions WHERE hash=?', m[1]) || fail(404, 'version 없음')],
  ['GET', /^\/api\/cases$/, (_m, q, _b, ctx) => {
    const rows = cases.listCases(q);
    // 검색어는 고객 주소·이름일 수 있다 — 원값 대신 유무·길이만
    accesslog.write({ action: 'case.list', ...ctx, filters: { state: q.state, channel: q.channel, limit: q.limit, hasQuery: !!q.q, qLen: (q.q || '').length }, count: rows.length });
    return rows;
  }],
  ['GET', /^\/api\/cases\/([^/]+)$/, (m, _q, _b, ctx) => {
    const c = cases.getCase(m[1]) || fail(404, 'case 없음');
    accesslog.write({ action: 'case.view', ...ctx, caseId: m[1] });
    return c;
  }],
  ['GET', /^\/api\/crm\/cases$/, (_m, q, _b, ctx) => {
    collections.flush();
    const field = crm.badFilter(q);
    if (field) fail(400, 'bad_filter', { field });
    const view = crm.listView(store.all('cases'), q);
    const sig = cases.signalsFor(view.items.map((d) => d.id));
    view.items = view.items.map((d) => ({ ...d, signals: sig.get(d.id) || null })); // 접수 Agent 감정 신호(목록 칩)
    // 검색어는 고객 주소·이름일 수 있다 — 원값 대신 유무·길이만
    const filters = Object.fromEntries(Object.keys(crm.FILTERS).filter((k) => q[k]).map((k) => [k, q[k]]));
    accesslog.write({ action: 'crm.case.list', ...ctx, filters: { ...filters, limit: q.limit, hasQuery: !!q.q, qLen: (q.q || '').length }, count: view.items.length });
    return view;
  }],
  ['GET', /^\/api\/crm\/cases\/([^/]+)$/, (m, _q, _b, ctx) => {
    const out = crmDetail(m[1]);
    accesslog.write({ action: 'crm.case.view', ...ctx, caseId: m[1] });
    return out;
  }],
  ['POST', /^\/api\/inbound$/, (_m, _q, b) => inbound(b, !!process.env.INBOUND_SECRET)],
  ['POST', /^\/api\/test\/inbound$/, (_m, _q, b) => (testInjectOn() ? inbound(b, false, true) : fail(404, 'not found'))],
  // 평가 실행기용: 접수 Agent KB 설정과(rag면) 미리 색인 결과 — 질문→답변 시간에 색인 시간이 섞이지 않게 실행 전에 부른다
  ['POST', /^\/api\/test\/kb-index$/, async () => (testInjectOn() ? kbIndexStatus() : fail(404, 'not found'))],
  ['POST', /^\/api\/drafts\/([^/]+)\/approve$/, (m, _q, b) => loop.approveDraft(m[1], by(b))],
  ['POST', /^\/api\/drafts\/([^/]+)\/discard$/, (m, _q, b) => loop.discardDraft(m[1], by(b))],
  ['POST', /^\/api\/drafts\/([^/]+)\/rate$/, (m, _q, b) => loop.rateShadow(m[1], by(b))],
  ['POST', /^\/api\/drafts\/([^/]+)\/resolve-sending$/, (m, _q, b) => loop.resolveSending(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/takeover$/, (m, _q, b) => loop.takeover(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/return$/, (m, _q, b) => returnCase(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/close$/, (m, _q, b) => close(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/hold$/, (m, _q, b) => hold(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/unhold$/, (m, _q, b) => unhold(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/note$/, (m, _q, b) => loop.addNote(m[1], by(b))],
  ['POST', /^\/api\/cases\/([^/]+)\/human-reply$/, (m, _q, b) => loop.humanReply(m[1], by(b))],
];
// 라우트 튜플: [메서드, 경로, 처리(m, q, body, ctx, req), 선택 {write, maxBody, status}]
const routes = [...CORE, ...configConsole.routes];

async function readJson(req, limit = 1e6) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) fail(413, 'body too large'); chunks.push(c); }
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
  let url; let touched = null;
  // 요청 대상이 URL로 안 읽히면(`GET http://[`, 범위 밖 포트) 400 — 예전엔 여기서 프로세스가 죽었다. 깨진 %-인코딩(`/api/cases/%E0%A4%A`)도 400.
  try { url = new URL(req.url, 'http://localhost'); decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'bad request target' }); }
  try {
    const ah = authHeader();
    const user = ah ? (req.headers[ah] ? String(req.headers[ah]) : null) : null;
    const ctx = { user, ip: ipOf(req) };
    const denied = (reason) => { accesslog.write({ action: 'auth.fail', ...ctx, reason, method: req.method, path: url.pathname }); return json(res, 401, { error: 'unauthorized' }); };
    // 사람 인증(리버스 프록시가 넣는 헤더) — 켜져 있으면 /api 전부(GET·SSE 포함)에 요구한다. 웹훅 수신·헬스체크만 예외.
    if (url.pathname.startsWith('/api/') && !OPEN_API.has(url.pathname)) {
      if (!proxyOk(req)) return denied('proxy');
      if (ah && !user) return denied('user');
    }
    if (req.method === 'GET' && url.pathname === '/api/events') { accesslog.write({ action: 'events.open', ...ctx }); return sse(req, res); }
    if (req.method === 'GET' && url.pathname === '/api/report/promotion.csv') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="promotion.csv"', 'cache-control': 'no-store' });
      return res.end(report.promotionCsv());
    }
    if (req.method === 'POST') {
      // JSON만 받는다 — 폼·text/plain 교차 출처 요청(CSRF)을 막는다.
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'content-type은 application/json' });
      if (url.pathname === INBOUND && !secretOk(req)) return denied('inbound');
      // 원문을 파기한 케이스에는 어떤 행동도 받지 않는다 — 케이스·초안 POST 전부를 여기 한 곳에서 409
      const pm = url.pathname.match(/^\/api\/(cases|drafts)\/([^/]+)\/[^/]+$/);
      const hit = pm && db.get(pm[1] === 'cases' ? 'SELECT id, purged_at p FROM cases WHERE id=?' : 'SELECT c.id, c.purged_at p FROM drafts d JOIN cases c ON c.id=d.case_id WHERE d.id=?', pm[2]);
      if (hit?.p) fail(409, 'purged');
      // 사람 명령 뒤(성공·실패 모두) 그 케이스 문서를 다시 계산한다 — 활동 기록이 상태 변경 뒤에 오거나 emit이 없는 경로까지 한 곳에서
      touched = hit?.id ?? null;
    }
    for (const [method, re, handler, opt = {}] of routes) {
      if (req.method !== method) continue;
      const m = url.pathname.match(re);
      if (!m) continue;
      // 콘솔 쓰기는 본문을 읽기 전에 쓰기 경로(사용자 헤더 + 프록시 시크릿, 또는 전달 헤더 없는 루프백)와 크기를 본다
      if (opt.write && !configConsole.writeGuard(req)) {
        accesslog.write({ action: 'console.denied', ...ctx, method, path: url.pathname });
        fail(403, 'console_write_untrusted');
      }
      const limit = opt.maxBody || 1e6;
      if (Number(req.headers['content-length']) > limit) fail(413, 'body too large');
      const body = method === 'POST' ? await readJson(req, limit) : null;
      // 켜져 있으면 by는 인증 헤더 값으로 덮는다
      if (body && typeof body === 'object' && ah && url.pathname !== INBOUND) body.by = user;
      const out = await handler(m, Object.fromEntries(url.searchParams), body, ctx, req);
      return json(res, opt.status || 200, out ?? {});
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error('[http]', e);
    return json(res, 500, { error: 'internal' });
  } finally { collections.markDirty(touched); }
}

/** 재시작 복구. 발송 확인 필요 표시(send_unconfirmed)는 emit이 없다 — 끝나면 그 케이스 문서를 다시 계산한다. */
async function recover() {
  const sending = db.all("SELECT DISTINCT case_id FROM drafts WHERE status='SENDING'").map((r) => r.case_id);
  await loop.recover();
  for (const id of sending) collections.markDirty(id);
}

function createServer() {
  configConsole.setup(); // reader 주입(고객이 게시한 KB·정책을 DB에서 읽는다)과 관리자 목록
  return http.createServer((req, res) => {
    for (const [k, v] of SECURITY_HEADERS) res.setHeader(k, v);
    // 마지막 그물 — 핸들러의 어떤 예외(응답을 이미 쓰기 시작한 뒤 포함)도 프로세스를 죽이지 않는다
    handle(req, res).catch((e) => {
      console.error('[http]', e);
      try { if (res.headersSent) res.destroy(); else json(res, 500, { error: 'internal' }); } catch { /* 소켓이 이미 닫혔다 */ }
    });
  });
}

if (require.main === module) {
  const { errors, warnings } = preflight();
  for (const e of errors) console.error(`시작 거부: ${e}`);
  if (errors.length) process.exit(1);
  for (const w of warnings) console.warn(`경고: ${w}`);
  policy.assertShipped(); // 출하 팩 검증 — 잘못된 이미지 팩이면 여기서 죽는다. 게시된 팩이 깨지면 그 채널만 사람에게 넘긴다
  db.init();
  configConsole.setup(); // 기동 재계산이 고객 팩 값(caseType 등)을 쓰게 resyncAll 전에
  // 접속기록은 파일 DB 옆에만(:memory:면 끔) — 레포·작업 폴더에 남지 않게. 기동 점검의 config.invalid가 남게 그 전에 연다
  const dbFile = db.file();
  if (dbFile) accesslog.start(path.join(path.dirname(dbFile), 'access.jsonl'));
  collections.resyncAll(); // 이벤트 백필 + 모든 케이스 문서 재계산(처리 테이블이 진실)
  configConsole.startup();
  if (mailWarning()) console.warn('\n!!! NODE_ENV=production인데 MAIL_PROVIDER=mock(ALLOW_MOCK_MAIL=1) — 승인해도 고객에게 메일이 나가지 않는다 !!!\n');
  const port = Number(process.env.PORT || 3000);
  // 기본은 이 컴퓨터에서만. 컨테이너는 이미지가 HOST=0.0.0.0을 준다.
  createServer().listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`cs-agent http://localhost:${port}  llm=${llm.name()} mail=${mail.name()} auto_send=${policy.autoSendOn() ? 'on' : 'off'} sender_auth=${senderAuthMode()} retention=${retention.days() ?? 'off'} budget=${tokenBudget() ?? 'none'} db=${process.env.DB_PATH || 'data/cs-agent.db'}`);
    if (kbIndex.config().mode === 'rag') kbIndexStatus().then((s) => console.log(`[kb-index] 미리 색인 ${s.channels.map((c) => `${c.channel}:${c.error || `${c.embedded}/${c.embedded + c.kept} ${c.ms}ms`}`).join(' ')}`), (e) => console.error('[kb-index]', e));
    recover().catch((e) => console.error('[recover]', e));
    require('./sweeper').start();
    require('./notify').start();
  });
}

module.exports = { createServer, preflight, recover };
