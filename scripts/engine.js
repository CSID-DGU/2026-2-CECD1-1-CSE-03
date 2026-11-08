'use strict';
// node scripts/engine.js <하위 명령> — 결정적 검사 CLI. 서버와 같은 함수로 KB·정책·초안을 검사하고 서버 에이전트의 실제 요청을 만든다.
// 출력은 stdout JSON 한 개. 종료 코드 0 = 통과, 1 = 검사 결과에 오류, 2 = 사용법·입력 오류.
// LLM을 부르지 않는다: 시작할 때 부르면 던지는 provider를 끼우고, render만 요청을 가로채 돌려준다. 네트워크는 dashboard-data의 루프백 GET뿐.
// 파일 DB를 열지 않는다(render만 메모리 DB). 입력 파일은 한 번에 하나, 저장소 옆 막힌 폴더·링크는 거부한다.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const pkg = require('../package.json');
const db = require('../server/db');
const llm = require('../server/llm');
const kb = require('../server/kb');
const policy = require('../server/policy');
const guard = require('../server/guard');
const prefilter = require('../server/prefilter');
const convert = require('../server/convert');
const crm = require('../server/crm');
const triageAgent = require('../server/agents/triage');
const responder = require('../server/agents/responder');
const reviewer = require('../server/agents/reviewer');
const { realKey, isUnder } = require('./sim/scenarios');

const CONTRACT = 1;
const ROOT = path.resolve(__dirname, '..');
// 저장소 옆 실데이터·참고 자료·평가 출력·특허 폴더
const BLOCKED = ['data', 'reference', 'eval-out', 'patent'].map((d) => path.join(ROOT, '..', d));
const MAX_FILE = 10 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const MAX_INPUT_CHARS = 4000; // server/loop.js와 같은 값
const MESSAGE_ID = 'engine-message';
// 칸 → 출처 라우트
const ROUTES = { status: '/api/status', workload: '/api/report/workload', promotion: '/api/stats', cases: '/api/crm/cases?limit=500' };
const REWRITE = '서버는 이 지적으로 답장을 한 번 다시 쓰고 다시 검사한다. render responder --violations --previous로 다시 쓴 초안을 넣어 한 번 더 돌린다. 두 번째도 떨어지면 이 판단이 최종이다';
const MIRROR = 'AWS 미러 단계 서버는 모든 채널이 섀도라 같은 문의도 SHADOW로 끝난다. 그 결과는 --shadow on으로 본다';
const AGENTS = { triage: triageAgent, responder, reviewer };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (error, extra = {}) => Object.assign(new Error(error), { usage: true, out: { error, ...extra } });

// ---- 입력 ----
/** 파일 하나를 읽는다. 글롭·막힌 폴더·링크·폴더면 거부(종료 2). */
function readInput(p, max = MAX_FILE) {
  if (typeof p !== 'string' || !p) throw bad('no_file');
  if (/[*?[\]{}]/.test(p)) throw bad('glob_not_allowed');
  let blocked;
  try { blocked = BLOCKED.some((d) => isUnder(p, d)); } catch { throw bad('path_refused'); }
  if (blocked) throw bad('path_refused');
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
    throw bad(e.code === 'ELOOP' ? 'symlink_refused' : e.code === 'ENOENT' ? 'not_found' : 'unreadable');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw bad('not_a_file');
    // 하드 링크는 막힌 폴더 파일을 다른 이름으로 열 수 있다 — scenarios.js readChecked와 같이 거부
    if (st.nlink !== 1) throw bad('hardlink_refused');
    // 연 뒤 실경로를 다시 구해 막힌 폴더가 아니고 연 파일과 같은지 본다(중간 폴더 링크를 바꿔치는 경쟁)
    let real; let now;
    try { real = fs.realpathSync.native(p); now = fs.statSync(real); } catch { throw bad('path_refused'); }
    if (BLOCKED.some((d) => isUnder(real, d)) || now.dev !== st.dev || now.ino !== st.ino) throw bad('path_refused');
    if (st.size > max) throw bad('too_large', { max });
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
const readText = (p, max) => readInput(p, max).toString('utf8');
function readJson(p, name) {
  try { return JSON.parse(readText(p, MAX_JSON)); } catch (e) { if (e.usage) throw e; throw bad('bad_json', { input: name }); }
}

async function readStdin(io) {
  const s = io.stdin;
  if (typeof s === 'string' || Buffer.isBuffer(s)) return String(s);
  if (!s || s.isTTY) throw bad('no_message');
  const chunks = []; let n = 0;
  for await (const c of s) { n += c.length; if (n > MAX_JSON) throw bad('too_large', { max: MAX_JSON }); chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks).toString('utf8');
}

/** 표준 입력의 문의 JSON {body, subject?, from?, autoSubmitted?, senderAuth?}. 원문은 메모리에만 둔다. */
async function messageFrom(io) {
  let m;
  try { m = JSON.parse(await readStdin(io)); } catch (e) { if (e.usage) throw e; throw bad('bad_message'); }
  if (!isObj(m) || typeof m.body !== 'string') throw bad('bad_message', { need: 'body 문자열' });
  const extra = Object.keys(m).filter((k) => !['body', 'subject', 'from', 'autoSubmitted', 'senderAuth'].includes(k));
  if (extra.length) throw bad('bad_message', { unknownKeys: extra });
  for (const k of ['subject', 'from']) if (m[k] != null && typeof m[k] !== 'string') throw bad('bad_message', { field: k });
  if (m.autoSubmitted != null && typeof m.autoSubmitted !== 'boolean') throw bad('bad_message', { field: 'autoSubmitted' });
  if (m.senderAuth != null && !['pass', 'fail', 'form'].includes(m.senderAuth)) throw bad('bad_message', { field: 'senderAuth' });
  return { body: m.body, subject: m.subject ?? null, from: m.from ?? null, autoSubmitted: !!m.autoSubmitted, senderAuth: m.senderAuth ?? null };
}

/** 출하 팩(--channel) 또는 팩 파일(--pack). 서버 로더와 같은 검사(validate·problems)와 기본값 채우기. env는 보지 않는다. */
function packFrom(opts, { optional = false } = {}) {
  if (opts.channel != null && opts.pack != null) throw bad('channel_or_pack');
  let raw; let channel = opts.channel;
  if (channel != null) { raw = policy.shipped(channel); if (raw === null) throw bad('unknown_channel'); } else if (opts.pack != null) raw = readText(opts.pack, MAX_JSON);
  else if (optional) return null;
  else throw bad('channel_or_pack');
  let pack;
  try { pack = JSON.parse(raw); } catch { throw bad('bad_json', { input: 'pack' }); }
  channel ??= pack?.channel;
  try { policy.validate(pack, channel); } catch (e) { throw bad('pack_invalid', { problems: [e.message] }); }
  const problems = policy.problems(pack, channel);
  if (problems.length) throw bad('pack_invalid', { problems });
  policy.fill(pack);
  pack.version = kb.sha(raw);
  return pack;
}

/** KB 파일 → kb.load와 같은 모양 {channel, language, sections, version, text}. */
function kbFrom(p, channel) {
  if (p == null) throw bad('kb_required');
  const raw = readText(p);
  // 서버는 크기를 넘거나 프롬프트 울타리가 든 원문을 빈 KB로 닫는다 — 여기서는 입력 오류로 돌려준다
  if (Buffer.byteLength(raw, 'utf8') > kb.KB_MAX_BYTES || /<<<|>>>/.test(raw)) throw bad('kb_invalid', { hint: 'kb-check로 먼저 검사한다' });
  const sections = kb.parse(raw);
  const text = Object.values(sections).map((s) => s.raw).join('\n\n');
  // kb.load와 같은 파일 이름 규칙: <채널>.en.md = 영어 KB
  return { channel, language: /\.en\.md$/i.test(p) ? 'en' : 'ko', sections, version: kb.sha(text), text };
}

function triageFrom(p) {
  const t = readJson(p, 'triage');
  if (!isObj(t)) throw bad('bad_json', { input: 'triage' });
  return triageAgent.normalize(t);
}
// responder.normalize와 같은 식(그 함수는 내보내지 않는다)
function draftFrom(p, name = 'draft') {
  const r = readJson(p, name);
  if (!isObj(r)) throw bad('bad_json', { input: name });
  return {
    body: r.body ? String(r.body).trim() : null,
    usedFacts: (Array.isArray(r.usedFacts) ? r.usedFacts : []).map((k) => String(k).replace(/^\s*(#+\s*)?kb:\s*/i, '').trim()).filter(Boolean),
    humanCommitments: Array.isArray(r.humanCommitments) ? r.humanCommitments : [],
    needsHandoff: !!r.needsHandoff,
    handoffReason: r.handoffReason || null,
  };
}
// reviewer.run과 같은 정규화. 코드 값은 그대로 옮긴다
function reviewFrom(p) {
  const r = readJson(p, 'review');
  if (!isObj(r)) throw bad('bad_json', { input: 'review' });
  return { pass: !!r.pass, reasons: Array.isArray(r.reasons) ? r.reasons : [] };
}

const count = (v, name) => {
  if (v == null) return 0;
  if (!/^\d{1,4}$/.test(v)) throw bad('bad_option', { option: name });
  return Number(v);
};

/** server/loop.js cycle의 ctx와 같은 키. 프롬프트에는 가린 본문만 들어간다. */
function ctxFrom(pack, kbo, msg, rounds) {
  const mask = (s) => guard.maskPii(s, { kbText: kbo.text, company: process.env.COMPANY_NAME || 'ACME' });
  const body = mask(msg.body);
  // 서버 history는 이 메시지까지 — 접수 Agent는 이 메시지를 빼고, 답장 Agent는 넣어서 본다
  const history = [{ id: MESSAGE_ID, direction: 'in', sent_by: null, edited: 0, body_clean: body }];
  return {
    caseId: null, messageId: MESSAGE_ID, channel: pack.channel, pack, kb: kbo, history,
    message: { body_clean: body.length > MAX_INPUT_CHARS ? `${body.slice(0, MAX_INPUT_CHARS)} [TRUNCATED]` : body },
    knownFacts: {}, lastOutboundGist: null, rounds,
    humanMessages: history.filter((m) => m.direction === 'out' && (m.sent_by === 'human' || m.edited)), recentDecisions: [],
  };
}

// ---- 판단 환경: 셸 env를 무시하고 옵션 값만 쓴다 ----
function envFrom(opts) {
  const flag = (v, def, name) => { const x = v ?? def; if (!['0', '1'].includes(x)) throw bad('bad_option', { option: name }); return x === '1'; };
  const shadow = opts.shadow ?? 'off';
  if (!['on', 'off'].includes(shadow)) throw bad('bad_option', { option: 'shadow' });
  return {
    autoSend: flag(opts['auto-send'], '0', 'auto-send'), shadow: shadow === 'on', requireSenderAuth: flag(opts['require-sender-auth'], '1', 'require-sender-auth'),
    formSenderDomains: String(opts['form-domains'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}
/** policy·prefilter가 process.env에서 읽는 값을 옵션 값으로 바꿔 fn을 돌리고 되돌린다(동기 함수만). */
function withEnv(env, fn) {
  const vals = {
    AUTO_SEND: env.autoSend ? '1' : '0', SHADOW_CHANNELS: '', REQUIRE_SENDER_AUTH: env.requireSenderAuth ? '1' : '0', FORM_SENDER_DOMAINS: env.formSenderDomains.join(','),
    NODE_ENV: undefined, MAIL_PROVIDER: undefined, INBOUND_SECRET: undefined, INTERNAL_DOMAINS: undefined,
  };
  const saved = Object.fromEntries(Object.keys(vals).map((k) => [k, process.env[k]]));
  const put = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  put(vals);
  try { return fn(); } finally { put(saved); }
}

// 처리 등급: 넘김 H, 섀도 L0, 초안은 자동 발송이면 L2 아니면 L1(승인 대기). 무시·작성 전은 null.
const levelOf = (d) => {
  if (!d) return null;
  if (d.action === 'HANDOFF') return 'H';
  if (d.action === 'SHADOW') return 'L0';
  if (d.action === 'DRAFT') return d.inputs?.autoSend ? 'L2' : 'L1';
  return d.action === 'ANSWER_AND_HANDOFF' ? 'L1' : null;
};

// ---- 하위 명령 ----
function extract([file]) {
  let r;
  try { r = convert.extract({ filename: path.basename(file), buffer: readInput(file) }); } catch (e) {
    if (e.usage) throw e;
    throw bad(e.code || 'bad_file', e.hint ? { hint: e.hint } : {});
  }
  // PDF는 세션 모델이 직접 읽는다
  if (r.kind === 'pdf') return { code: 0, out: { kind: 'pdf', rules: convert.SYSTEM, schema: convert.SCHEMA } };
  let chunks;
  try { chunks = convert.chunks(r.text); } catch (e) { throw bad(e.code || 'bad_file'); }
  return { code: 0, out: { kind: r.kind, chunks, rules: convert.SYSTEM, schema: convert.SCHEMA } };
}

function kbNormalize([file], opts) {
  if (!opts.source) throw bad('source_required');
  const r = readJson(file, 'sections');
  if (!isObj(r)) throw bad('bad_json', { input: 'sections' });
  const { sections, omitted } = convert.normalize(r);
  const markdown = convert.toMarkdown(sections, opts.source);
  return { code: sections.some((s) => s.errors.length) ? 1 : 0, out: { markdown, sections, omitted } };
}

function kbCheck([file], opts) {
  const pack = packFrom(opts, { optional: true });
  const raw = readText(file);
  const { checkKb } = require('../server/console');
  const r = checkKb(raw, { pack });
  return { code: r.errors.length ? 1 : 0, out: { errors: r.errors, warnings: r.warnings } };
}

function policyCheck([file], opts) {
  const raw = readText(file, MAX_JSON);
  let pack;
  try { pack = JSON.parse(raw); } catch { throw bad('bad_json', { input: 'pack' }); }
  const live = opts.channel != null ? policy.shipped(opts.channel) : null;
  if (opts.channel != null && live === null) throw bad('unknown_channel');
  const channel = opts.channel ?? pack?.channel;
  const problems = [];
  try { policy.validate(pack, channel); } catch (e) { problems.push({ path: '', rule: 'structure', msg: e.message }); }
  problems.push(...policy.problems(pack, channel));
  const widenings = live === null ? [] : policy.widenings(live, raw);
  return { code: problems.length ? 1 : 0, out: { problems, widenings } };
}

// 파일 하나 또는 표준 입력의 문의 JSON(body만 가린다)
async function mask([file], _opts, io) {
  return { code: 0, out: { text: guard.maskPii(file != null ? readText(file) : (await messageFrom(io)).body) } };
}

async function render([agentName], opts, io) {
  const agent = Object.hasOwn(AGENTS, agentName) ? AGENTS[agentName] : null;
  if (!agent) throw bad('unknown_agent', { agents: Object.keys(AGENTS) });
  const pack = packFrom(opts);
  const kbo = kbFrom(opts.kb, pack.channel);
  const ctx = ctxFrom(pack, kbo, await messageFrom(io), count(opts.rounds, 'rounds'));
  if (agentName !== 'triage') {
    if (opts.triage == null) throw bad('triage_required');
    ctx.triage = triageFrom(opts.triage);
  }
  if (agentName === 'responder' && (opts.violations != null || opts.previous != null)) {
    if (opts.violations == null || opts.previous == null) throw bad('violations_and_previous');
    const v = readJson(opts.violations, 'violations');
    if (!Array.isArray(v)) throw bad('bad_json', { input: 'violations' });
    const prev = draftFrom(opts.previous, 'previous');
    Object.assign(ctx, { violations: v, previousBody: prev.body, previousUsedFacts: prev.usedFacts });
  }
  if (agentName === 'reviewer') {
    if (opts.draft == null) throw bad('draft_required');
    const d = draftFrom(opts.draft);
    Object.assign(ctx, { body: d.body, usedFacts: d.usedFacts, humanCommitments: d.humanCommitments });
  }
  db.init(':memory:');
  let req = null;
  // 캡처 provider: 요청을 받아 두고 던진다. noRetry라 한 번만 불린다. use가 차단기를 초기화한다
  llm.use({ name: 'engine-capture', json: async (r) => { req = r; throw Object.assign(new Error('captured'), { code: 'captured', noRetry: true }); } });
  try { await agent.run(ctx); } catch (e) { if (!req) throw bad('render_failed', { code: String(e.code || e.message) }); }
  return { code: 0, out: { agent: req.agent, system: req.system, user: req.user, schema: req.schema } };
}

/** 서버 순서: 1차 거르기 → 판단 1차 → (COMPOSE) 초안 넘김·빈 본문 → guard → 검수 → 판단 2차. 멈춘 단계를 stage로 낸다. */
async function checkReply(_args, opts, io) {
  const env = envFrom(opts);
  const pack = packFrom(opts);
  const packShadow = pack.shadow;
  if (env.shadow) pack.shadow = true;
  const kbo = kbFrom(opts.kb, pack.channel);
  const msg = await messageFrom(io);
  const tri = opts.triage != null ? triageFrom(opts.triage) : null;
  const draft = opts.draft != null ? draftFrom(opts.draft) : null;
  const review = opts.review != null ? reviewFrom(opts.review) : null;
  const rounds = count(opts.rounds, 'rounds'); const repeat = count(opts.repeat, 'repeat');
  const out = {
    stage: 'prefilter', prefilter: null, triage: null, gate1: null, guard: null, review: null, decision: null, level: null,
    // shadow = 판단에 쓴 값(팩 또는 옵션), packShadow = 팩 자체 값
    env: { autoSend: env.autoSend, shadow: pack.shadow, packShadow, requireSenderAuth: env.requireSenderAuth, formSenderDomains: env.formSenderDomains, mirror: MIRROR } };
  const stop = (stage, decision, code = 0) => { Object.assign(out, { stage, decision, level: levelOf(decision) }); return { code, out }; };
  return withEnv(env, () => {
    const pf = prefilter.check({
      body: msg.body, subject: msg.subject, sender: msg.from, pack, autoSubmitted: msg.autoSubmitted, senderAuth: msg.senderAuth, formUnresolved: policy.isFormAddress(msg.from),
    });
    if (pf) { out.prefilter = pf; return stop('prefilter', pf.action === 'IGNORE' ? pf : { action: 'HANDOFF', reason: policy.normalizeReason(pack, pf.reason) }); }
    out.prefilter = { pass: true };
    if (!tri) return stop('prefilter', null); // 다음: render triage
    out.triage = tri;
    const base = { pack, triage: tri, rounds, repeatStreak: tri.repeatsPrevious ? repeat + 1 : 0, senderTrusted: policy.senderTrusted(msg.senderAuth, msg.from) };
    out.gate1 = policy.decide(base);
    if (out.gate1.action !== 'COMPOSE') return stop('gate1', out.gate1);
    if (!draft) return stop('gate1', null); // 다음: render responder
    if (draft.needsHandoff || !draft.body) {
      return stop('compose', { action: 'HANDOFF', reason: policy.normalizeReason(pack, draft.handoffReason || 'out_of_knowledge'), rule: null, inputs: { from: 'responder' } });
    }
    const hits = guard.check({ body: draft.body, usedFacts: draft.usedFacts, pack, kb: kbo, intent: tri.intent });
    out.guard = { pass: !hits.length, hits };
    if (hits.length) { out.guard.rewrite = REWRITE; return stop('guard', policy.decide({ ...base, guard: { pass: false, reasons: hits } }), 1); }
    if (!review) return stop('guard', null); // 다음: render reviewer
    out.review = review;
    // 서버처럼 사유가 빈 실패는 통과로 본다(loop.js: 사유 목록이 비면 통과)
    if (!review.pass && review.reasons.length) { out.review = { ...review, rewrite: REWRITE }; return stop('review', policy.decide({ ...base, guard: { pass: false, reasons: review.reasons } }), 1); }
    return stop('done', policy.decide({ ...base, guard: { pass: true } }));
  });
}

/** 로컬 mock 서버의 집계만 허용 목록으로 옮긴다. 케이스 id·주소·이름·제목·본문은 내보내지 않는다. */
async function dashboardData(_args, opts) {
  let u;
  try { u = new URL(String(opts.url)); } catch { throw bad('bad_url'); }
  // 루프백 IP 글자만 받는다. localhost는 이름 풀이(hosts 파일)에 따라 다른 곳을 가리킬 수 있어 받지 않는다
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password) throw bad('not_loopback');
  const get = async (route) => {
    let res;
    try { res = await fetch(new URL(route, u.origin), { redirect: 'error', signal: AbortSignal.timeout(5000) }); } catch { throw bad('unreachable', { route }); }
    if (res.status === 401) throw bad('refused', { reason: 'auth_header' });
    if (!res.ok) throw bad('http_error', { route, status: res.status });
    try { return await res.json(); } catch { throw bad('bad_response', { route }); }
  };
  const status = await get(ROUTES.status);
  // 프록시 뒤 서버(사람 인증 머리글), 실발송 메일, production 표시는 거부한다
  if (status?.auth === 'header') throw bad('refused', { reason: 'auth_header' });
  if (status?.provider?.mail !== 'mock') throw bad('refused', { reason: 'mail_not_mock' });
  if (status?.mailWarning) throw bad('refused', { reason: 'production' });
  const [wl, stats, view] = [await get(ROUTES.workload), await get(ROUTES.promotion), await get(ROUTES.cases)];
  // 채널 이름은 채널 규칙에 맞고 이 저장소에 팩이 있는 것만(서버도 팩 파일이 있는 채널만 받는다). 그 밖(이름·주소·번호·케이스 id)은 other
  const chan = (v) => (typeof v === 'string' && /^[a-z0-9_-]{1,40}$/.test(v) && policy.shipped(v) !== null ? v : 'other');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const W = ['total', 'agent', 'assisted', 'human', 'agentRate', 'assistedRate', 'humanRate', 'ackCount', 'pendingCount'];
  const pick = (o) => Object.fromEntries(W.filter((k) => isObj(o) && k in o).map((k) => [k, num(o[k])]));
  const workload = {
    ...pick(wl), byDirection: { in: pick(wl?.byDirection?.in), out: pick(wl?.byDirection?.out) },
    byChannel: (Array.isArray(wl?.byChannel) ? wl.byChannel : []).map((c) => ({ channel: chan(c?.channel), ...pick(c) })),
  };
  const promotion = Object.entries(isObj(stats?.promotion) ? stats.promotion : {}).map(([channel, p]) => ({
    channel: chan(channel), reviewed: num(p?.reviewed), approvedNoEditRate: num(p?.approvedNoEditRate), criticalCount: num(p?.criticalCount), eligible: !!p?.eligible,
  }));
  const items = Array.isArray(view?.items) ? view.items : [];
  // 값은 서버 열거 값만 센다. 그 밖은 other, 비면 none
  const FIELDS = { status: crm.STATUSES, subStatus: crm.SUB_STATUSES, priority: crm.PRIORITIES, caseReason: crm.CASE_REASONS, origin: crm.ORIGINS };
  const AGE = [['lt1d', 1], ['d1to3', 3], ['d3to7', 7], ['gte7d', Infinity]];
  // 프로토타입 없는 객체 — 채널 이름이 __proto__여도 칸으로만 센다
  const bag = () => Object.create(null);
  const cases = bag(); const now = Date.now();
  for (const d of items) {
    const ch = chan(d?.recordType);
    if (!cases[ch]) { cases[ch] = Object.assign(bag(), { total: 0, openAge: Object.assign(bag(), Object.fromEntries(AGE.map(([k]) => [k, 0]))) }); for (const k of Object.keys(FIELDS)) cases[ch][k] = bag(); }
    const c = cases[ch];
    c.total += 1;
    for (const [k, allowed] of Object.entries(FIELDS)) { const v = d?.[k] == null ? 'none' : allowed.includes(d[k]) ? d[k] : 'other'; c[k][v] = (c[k][v] || 0) + 1; }
    const days = (now - Date.parse(d?.audit?.createdAt)) / 86_400_000;
    if (!d?.isClosed && Number.isFinite(days)) c.openAge[AGE.find(([, max]) => days < max)[0]] += 1;
  }
  return { code: 0, out: { generatedAt: new Date().toISOString(), source: ROUTES, workload, promotion, cases, truncated: items.length >= 500 } };
}

// 하위 명령: [처리, 위치 인자 수, 옵션]
const S = { type: 'string' };
const COMMANDS = {
  extract: [extract, 1, {}],
  'kb-normalize': [kbNormalize, 1, { source: S }],
  'kb-check': [kbCheck, 1, { channel: S, pack: S }],
  'policy-check': [policyCheck, 1, { channel: S }],
  render: [render, 1, { channel: S, pack: S, kb: S, triage: S, draft: S, violations: S, previous: S, rounds: S }],
  mask: [mask, [0, 1], {}],
  'check-reply': [checkReply, 0, {
    channel: S, pack: S, kb: S, triage: S, draft: S, review: S, rounds: S, repeat: S, 'auto-send': S, shadow: S, 'require-sender-auth': S, 'form-domains': S,
  }],
  'dashboard-data': [dashboardData, 0, { url: S }],
};

async function dispatch(argv, io) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' && !rest.length) return { code: 0, out: { name: pkg.name, version: pkg.version, contract: CONTRACT, commands: Object.keys(COMMANDS) } };
  if (!Object.hasOwn(COMMANDS, cmd)) throw bad('usage', { commands: ['--version', ...Object.keys(COMMANDS)] });
  const [fn, nargs, options] = COMMANDS[cmd];
  let parsed;
  try { parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true, tokens: true }); } catch (e) { throw bad('usage', { detail: e.code || 'bad_args' }); }
  const names = parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name);
  if (new Set(names).size !== names.length) throw bad('usage', { detail: 'repeated_option' });
  // 한 번에 하나: 위치 인자 수가 정확히 맞아야 한다
  const ok = Array.isArray(nargs) ? nargs.includes(parsed.positionals.length) : parsed.positionals.length === nargs;
  if (!ok) throw bad('usage', { detail: nargs ? 'one_input_only' : 'no_positional' });
  return fn(parsed.positionals, parsed.values, io);
}

/** argv(명령 뒤 인자) → 종료 코드. io = {write(s), stdin(문자열·스트림)}. */
async function run(argv, io = { write: (s) => process.stdout.write(s), stdin: process.stdin }) {
  // 하위 명령은 LLM을 부르지 않는다 — 부르면 던지는 provider(render는 안에서 캡처로 바꾼다)
  llm.use({ name: 'engine-blocked', json: async () => { throw Object.assign(new Error('llm_not_allowed'), { code: 'llm_not_allowed', noRetry: true }); } });
  let r;
  try { r = await dispatch(argv, io); } catch (e) { r = { code: 2, out: e.usage ? e.out : { error: 'internal', detail: String(e.message).slice(0, 200) } }; }
  io.write(`${JSON.stringify(r.out, null, 2)}\n`);
  return r.code;
}

module.exports = { run, CONTRACT };

if (require.main === module) run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
