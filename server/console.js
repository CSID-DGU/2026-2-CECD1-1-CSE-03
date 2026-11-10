'use strict';
// 고객 관리 지식베이스·정책 콘솔 — 검사, L2 게이트, 게시 트랜잭션(게시·되돌리기·복원), 초안과 매뉴얼 변환 작업, 기동 점검, 라우트.
// 라이브 = 대상(policy:<ch>, kb:<ch>:<lang>)별 seq가 가장 큰 config_changes 행이 가리키는 versions 원문. 행이 없거나 reset이면 이미지 파일.
// 하한은 policy.load 경로(problems)가 모든 팩에 지킨다. 여기서는 같은 함수를 게시 전에 먼저 부른다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const events = require('./events');
const kb = require('./kb');
const policy = require('./policy');
const guard = require('./guard');
const prefilter = require('./prefilter');
const report = require('./report');
const cases = require('./cases');
const accesslog = require('./accesslog');
const llm = require('./llm');
const { read, sha256 } = require('./config-read');

const { HttpError } = cases;
const fail = (status, code, extra) => { throw new HttpError(status, code, extra); };

const KB_DIR = path.join(__dirname, '..', 'kb');
const LANGS = ['ko', 'en'];
const LIMITS = { kbMaxBytes: kb.KB_MAX_BYTES, sectionChars: 1500, sections: 100, totalChars: 50_000, warnChars: 20_000, uploadBytes: 10 * 1024 * 1024, uploadBody: 15 * 1024 * 1024 };
const TITLE_MAX = 80;
const SOURCE_MAX = 200;
const NOTE_MAX = 500;
// 변환 작업당 토큰 상한 — 일일 예산이 없어도 늘 걸린다(convert.js의 코드 상수)
const { JOB_TOKEN_CAP } = require('./convert');
const FAILS_TO_STOP = 3;
const DRAFT_KEEP_MS = 7 * 86_400_000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const parsed = (raw) => { if (typeof raw !== 'string') return null; try { return JSON.parse(raw); } catch { return null; } };
// 키 순서를 무시한 JSON 비교값
const canon = (v) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const kstDay = (now = Date.now()) => new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
const shippedKb = (ch, lang) => { const f = path.join(KB_DIR, lang === 'en' ? `${ch}.en.md` : `${ch}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };

/* ---------------- 권한 ---------------- */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// 프록시·중계가 붙이는 헤더 — 하나라도 있으면 소켓 주소가 루프백이어도 앞에 다른 사람이 있다
const RELAY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'via', 'x-forwarded-host', 'x-forwarded-proto', 'x-client-ip', 'true-client-ip', 'cf-connecting-ip'];
const authHeader = () => (process.env.AUTH_USER_HEADER || '').toLowerCase();
const same = (got, want) => { const a = Buffer.from(String(got || '')); const b = Buffer.from(String(want)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

/**
 * 콘솔 쓰기를 받을 수 있는 경로인가 — (a) 사용자 헤더·프록시 시크릿이 둘 다 설정됐고 시크릿이 맞고 헤더 사용자가 있다,
 * (b) 둘 중 하나라도 없으면 소켓 주소가 루프백이고, Host가 루프백 이름이고, Origin이 없거나 루프백이고, 중계 헤더(RELAY_HEADERS)가 하나도 없다.
 * 전달 헤더는 믿지 않고 소켓 주소만 본다. Host·Origin은 같은 머신의 다른 출처(DNS 재바인딩 페이지)를 막는다.
 */
function writeGuard(req) {
  const ah = authHeader(); const secret = process.env.PROXY_SHARED_SECRET;
  if (ah && secret) return same(req.headers['x-proxy-secret'], secret) && !!String(req.headers[ah] || '').trim();
  const h = req.headers || {};
  return LOOPBACK.has(req.socket?.remoteAddress) && LOOPBACK_HOST_RE.test(String(h.host ?? ''))
    && (h.origin === undefined || LOOPBACK_ORIGIN_RE.test(String(h.origin))) && RELAY_HEADERS.every((k) => h[k] === undefined);
}

let admins = new Set();
const norm = (s) => String(s ?? '').trim().toLowerCase();
/** ADMIN_USERS(쉼표 목록, trim·소문자)에 있는 actor인가. 목록이 비면 아무도 아니다. */
const isAdmin = (actor) => !!norm(actor) && admins.has(norm(actor));

/** GET의 보는 사람 — 사용자 헤더가 켜져 있으면 그 값, 아니면 ?by=. writable = 쓰기 경로 조건, admin = writable && 관리자. */
function viewer(req, q) {
  const ah = authHeader();
  const actor = (ah ? String(req.headers[ah] || '').trim() : (typeof q.by === 'string' ? q.by.trim() : '')) || null;
  const writable = writeGuard(req);
  return { actor, writable, admin: writable && isAdmin(actor) };
}
// 쓰기 라우트는 라우터가 writeGuard를 이미 확인했고, 사용자 헤더가 켜져 있으면 body.by를 그 값으로 덮었다.
const adminOf = (b) => { const a = typeof b?.by === 'string' ? b.by.trim() : ''; if (!isAdmin(a)) fail(403, 'not_admin'); return a; };

/* ---------------- 깨진 라이브 대상 표시(health가 읽는다) ---------------- */

const configInvalid = new Set();
const targetOf = (kind, channel, lang) => (kind === 'policy' ? `policy:${channel}` : `kb:${channel}:${lang}`);
/** 로더가 대상을 닫을 때 부른다 — 트랜잭션 안에서 불릴 수 있어 메모리 플래그와 경고만 다룬다. */
function markInvalid({ kind, channel, lang, changeId, error }) {
  configInvalid.add(targetOf(kind, channel, lang));
  console.warn(`[console] ${targetOf(kind, channel, lang)} 저장된 원문을 쓸 수 없어 사람에게 넘기는 쪽으로 닫음(${error}, 변경 ${changeId ?? '-'})`);
}
const configState = () => (configInvalid.size ? 'invalid' : 'ok');

/** reader 주입과 관리자 목록 읽기. 기동 때(main·createServer) 부른다 — ADMIN_USERS를 바꾸면 재시작한다. */
function setup() {
  admins = new Set(String(process.env.ADMIN_USERS || '').split(',').map(norm).filter(Boolean));
  const opts = { onInvalid: markInvalid };
  kb.setReader(read, opts);
  policy.setReader(read, opts);
}

/* ---------------- 공통 ---------------- */

function channelOf(ch) {
  if (typeof ch !== 'string' || !kb.CHANNEL_RE.test(ch)) fail(400, 'bad_channel');
  if (policy.shipped(ch) === null) fail(404, 'no_channel');
  return ch;
}
const langOf = (l) => (LANGS.includes(l) ? l : fail(400, 'bad_lang'));

/** 승격 지표로 본 자동 발송 구성원의 증거. '@ack'(접수 안내)는 채널 지표를 쓴다. */
function evidence(channel, members) {
  const rows = report.promotionByIntent().rows.filter((r) => r.channel === channel);
  const chan = cases.promotion(channel);
  const blocked = [];
  for (const m of members) {
    const r = m === '@ack' ? chan : rows.find((x) => x.intent === m);
    if (!r?.eligible) blocked.push({ member: m, reviewed: r?.reviewed ?? 0, approvedNoEditRate: r?.approvedNoEditRate ?? 0, criticalCount: r?.criticalCount ?? 0 });
  }
  return { blocked, channelCritical: chan.criticalCount };
}

/**
 * L2 게이트(정책 게시·되돌리기·복원). live = policy.source(ch). 결과 자동 발송 집합이 비면 통과,
 * 라이브의 부분집합이고 적용되는 확대가 없으면 증거 없이 통과, 그 밖에는 결과 집합 전부 eligible + 채널 치명 0.
 * 라이브가 깨졌으면(invalid) 라이브 집합은 비고 확대는 채널 범위 전부다.
 */
function gate({ channel, live, nextRaw }) {
  const broken = !live || live.invalid;
  const liveSet = broken ? [] : policy.autoSet(live.raw);
  const next = policy.autoSet(nextRaw);
  const widenings = policy.widenings(broken ? null : live.raw, nextRaw);
  const out = { live: liveSet, next, widenings, pass: true, blocked: [], channelCritical: null };
  if (!next.length) return out;
  const applies = widenings.some((w) => w.scope === 'channel' || next.includes(w.intent));
  if (!applies && next.every((m) => liveSet.includes(m))) return out;
  const ev = evidence(channel, next);
  return { ...out, ...ev, pass: !ev.blocked.length && ev.channelCritical === 0 };
}

/**
 * 검사를 마친 대상들을 한 트랜잭션으로 쓴다 — versions(다시 읽어 sha256 대조), config_changes, 초안 published.
 * 같은 8자리 키에 다른 내용이 있으면 409 hash_collision으로 되돌린다. 접속기록·이벤트·플래그 정리는 커밋 뒤.
 * @param rows [{kind, channel, language, action, raw|null, vkind, toHash, toSha256, fromHash, summary}] raw가 null이면(reset) versions를 쓰지 않는다.
 */
function commit(rows, { actor, note, ctx, draftId = null }) {
  const now = db.now();
  // 자른 뒤 가린다 — 긴 메모 전체에 마스킹 정규식을 돌리지 않는다
  const memo = note == null || String(note).trim() === '' ? null : guard.maskPii(String(note).slice(0, NOTE_MAX));
  const ids = db.tx(() => {
    const out = rows.map((r) => {
      if (r.raw != null) {
        db.saveVersion(r.toHash, r.vkind, r.raw);
        const got = db.get('SELECT content FROM versions WHERE hash=?', r.toHash);
        if (!got || sha256(got.content) !== r.toSha256) fail(409, 'hash_collision');
      }
      const id = db.uuid();
      db.insert('config_changes', {
        id, kind: r.kind, channel: r.channel, language: r.language, action: r.action, from_hash: r.fromHash ?? null, to_hash: r.toHash ?? null,
        to_sha256: r.toSha256 ?? null, actor, note: memo, summary: JSON.stringify(r.summary), created_at: now,
      });
      return id;
    });
    if (draftId) db.run("UPDATE kb_drafts SET status='published', source_text=NULL, updated_at=? WHERE id=?", now, draftId);
    return out;
  });
  rows.forEach((r, i) => {
    configInvalid.delete(targetOf(r.kind, r.channel, r.language));
    // 메모 원문은 넣지 않는다 — 해시와 대상만
    accesslog.write({
      action: r.summary.rollbackOf ? 'config.rollback' : `config.${r.action}`, user: actor, ip: ctx?.ip ?? null, kind: r.kind, channel: r.channel, lang: r.language,
      changeId: ids[i], toHash: r.toHash ?? null, noteHash: memo ? sha256(memo).slice(0, 16) : null,
    });
    try { events.emit('config.changed', { kind: r.kind, channel: r.channel, language: r.language, action: r.action, changeId: ids[i] }); } catch (e) { console.error('[console] event', e.message); }
  });
  return ids;
}

function changeRow(id, kind, ch) {
  const row = typeof id === 'string' ? db.get('SELECT * FROM config_changes WHERE id=?', id) : null;
  if (!row || row.kind !== kind || row.channel !== ch) fail(404, 'no_change');
  return row;
}
/** 변경 행이 가리키는 원문 — hash로 찾고 to_sha256으로 대조한다. */
function contentOf(row) {
  const v = row.to_hash ? db.get('SELECT content FROM versions WHERE hash=?', row.to_hash) : null;
  if (!v || sha256(v.content) !== row.to_sha256) fail(409, 'history_mismatch');
  return v.content;
}

/* ---------------- 정책 ---------------- */

const PREFILTER_REASONS = new Set([...prefilter.RULES.map(([r]) => r), 'sender_changed']);
const serialize = (pack) => `${JSON.stringify(pack, null, 2)}\n`;
const actionsOf = (p) => Object.fromEntries(Object.entries(isObj(p?.intents) ? p.intents : {}).filter(([, d]) => isObj(d) && d.actions !== undefined).map(([k, d]) => [k, d.actions]));

/** validate(기존 메시지)와 problems(하한·구조)를 함께. */
function packProblems(pack, ch) {
  const out = [];
  try { policy.validate(pack, ch); } catch (e) { out.push({ path: '', rule: 'structure', msg: e.message }); }
  return [...out, ...policy.problems(pack, ch)];
}

/** 후보 팩 — version 키를 버리고 actions는 라이브 원문 값을 복사한다. 보낸 actions가 라이브와 다른 intent를 돌려준다. */
function candidate(pack, live) {
  const cand = structuredClone(pack);
  delete cand.version;
  const liveActions = actionsOf(parsed(live.raw));
  const bad = [];
  for (const [k, d] of Object.entries(isObj(cand.intents) ? cand.intents : {})) {
    if (!isObj(d)) continue;
    if (d.actions !== undefined && canon(d.actions) !== canon(liveActions[k])) bad.push(k);
    if (liveActions[k] === undefined) delete d.actions; else d.actions = liveActions[k];
  }
  return { cand, actionsBad: bad };
}
// 되돌리기·복원은 원문을 바이트 그대로 쓴다 — actions가 라이브와 다르면 거절(P0은 읽기 전용)
const actionsDiffer = (pack, live) => {
  const la = actionsOf(parsed(live.raw)); const na = actionsOf(pack);
  return Object.keys(isObj(pack?.intents) ? pack.intents : {}).filter((k) => canon(na[k]) !== canon(la[k]));
};

function policyWarnings(ch, liveRaw, pack) {
  const out = [];
  for (const r of arr(parsed(liveRaw)?.handoffReasons)) {
    if (PREFILTER_REASONS.has(r) && !arr(pack.handoffReasons).includes(r)) out.push({ path: 'handoffReasons', code: 'prefilter_off', reason: r, msg: `${r} 사유를 빼면 이 채널에서 코드 규칙 ${r}가 꺼지고 자동 발송 확대로 검사된다` });
  }
  const keys = new Set(LANGS.flatMap((l) => Object.keys(kb.load(ch, l).sections)));
  for (const [k, d] of Object.entries(isObj(pack.intents) ? pack.intents : {})) {
    for (const key of arr(d?.kb)) if (!keys.has(key)) out.push({ path: `intents.${k}.kb`, code: 'kb_key_missing', key, msg: `라이브 지식베이스에 ${key} 절이 없다` });
  }
  return out;
}

/** 필드 단위 변경(배열은 값 하나로 본다). */
function packDiff(a, b, at = '', out = []) {
  if (isObj(a) && isObj(b)) for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) packDiff(a[k], b[k], at ? `${at}.${k}` : k, out);
  else if (canon(a) !== canon(b)) out.push({ path: at, from: a ?? null, to: b ?? null });
  return out;
}
const ruleOf = (p) => (policy.FIELD_RULES[p.replace(/^intents\.[^.]+\./, 'intents.*.')] || policy.FIELD_RULES[p.split('.')[0]])?.edit ?? null;

function policyGet(ch) {
  channelOf(ch);
  const s = policy.source(ch);
  const pack = parsed(s.raw);
  const shipped = policy.shipped(ch);
  const c = cases.promotion(ch);
  return {
    pack, raw: s.raw, version: s.version, live: s.live, invalid: s.invalid, ...(s.error ? { error: s.error } : {}), shipped, shippedVersion: kb.sha(shipped),
    rules: policy.FIELD_RULES, problems: isObj(pack) ? packProblems(pack, ch) : [{ path: '', rule: 'structure', msg: '원문을 읽을 수 없다' }],
    promotion: { intents: report.promotionByIntent().rows.filter((r) => r.channel === ch), channel: { reviewed: c.reviewed, approvedNoEditRate: c.approvedNoEditRate, criticalCount: c.criticalCount, eligible: c.eligible } },
    kbKeys: [...new Set(LANGS.flatMap((l) => Object.keys(kb.load(ch, l).sections)))],
  };
}

function policyCheck(ch, b) {
  channelOf(ch);
  if (!isObj(b?.pack)) return { problems: [{ path: '', rule: 'structure', msg: '팩은 객체여야 한다' }], warnings: [], diff: [], gate: null };
  const live = policy.source(ch);
  const { cand, actionsBad } = candidate(b.pack, live);
  const problems = [...packProblems(cand, ch), ...actionsBad.map((k) => ({ path: `intents.${k}.actions`, rule: 'fixed', msg: '읽기 전용 — 라이브 값과 달라질 수 없다' }))];
  return {
    problems, warnings: policyWarnings(ch, live.raw, cand),
    diff: packDiff(parsed(live.raw) ?? {}, cand).map((d) => ({ ...d, rule: ruleOf(d.path) })),
    gate: gate({ channel: ch, live, nextRaw: serialize(cand) }),
  };
}

/** 정책 게시·되돌리기·복원 — 같은 검사(stale, actions, problems, 게이트)와 같은 트랜잭션. */
function policyWrite(ch, mode, b, actor, ctx) {
  channelOf(ch);
  const live = policy.source(ch);
  if ((b.baseVersion ?? null) !== live.version) fail(409, 'stale', { current: live.version });
  let raw; let action = mode; let rollbackOf = null;
  if (mode === 'publish') {
    if (!isObj(b.pack)) fail(422, 'invalid', { errors: [{ path: '', rule: 'structure', msg: '팩은 객체여야 한다' }], warnings: [] });
    const { cand, actionsBad } = candidate(b.pack, live);
    if (actionsBad.length) fail(422, 'actions_readonly', { intents: actionsBad });
    raw = serialize(cand);
  } else {
    if (mode === 'rollback') {
      const row = changeRow(b.changeId, 'policy', ch);
      rollbackOf = row.id;
      if (row.action === 'reset') action = 'reset'; else raw = contentOf(row);
    } else if (!live.live) fail(409, 'already_default');
    raw ??= policy.shipped(ch);
    const bad = actionsDiffer(parsed(raw), live);
    if (bad.length) fail(422, 'actions_readonly', { intents: bad });
  }
  const pack = parsed(raw);
  const errors = packProblems(pack, ch);
  const warnings = isObj(pack) ? policyWarnings(ch, live.raw, pack) : [];
  if (errors.length) fail(422, 'invalid', { errors, warnings });
  const g = gate({ channel: ch, live, nextRaw: raw });
  if (!g.pass) fail(409, 'l2_not_eligible', { blocked: g.blocked, channelCritical: g.channelCritical, widenings: g.widenings });
  const summary = { diff: packDiff(parsed(live.raw) ?? {}, pack), warnings, gate: g, ...(rollbackOf ? { rollbackOf } : {}) };
  const [changeId] = commit([{
    kind: 'policy', channel: ch, language: null, action, raw: action === 'reset' ? null : raw, vkind: `policy:${ch}`,
    toHash: kb.sha(raw), toSha256: sha256(raw), fromHash: live.version, summary,
  }], { actor, note: b.note, ctx });
  return { version: kb.sha(raw), changeId, warnings };
}

/* ---------------- KB ---------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const okDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const FENCE_RE = /<<<|>>>/;
const INJECTION = prefilter.RULES.filter(([r]) => r === 'injection').map(([, re]) => re);
const INVISIBLE_RE = /[\u0085\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
const GUARD_WARN = ['forbidden_word', 'amount', 'date_promise', 'date', 'contact'];
const reviewedOf = (s) => s.meta['검토일'] ?? s.meta.reviewed;
// guard.js의 LINK_RE와 같은 식 — guard는 KB에 있는 링크를 초안에 허용하므로 같은 기준으로 링크를 찾는다(guard가 이 식을 내보내지 않는다)
const FILE_EXT = 'js|jsx|ts|tsx|py|rb|go|rs|java|kt|php|sh|md|txt|csv|tsv|xlsx?|docx?|pptx?|pdf|hwpx?|json|xml|ya?ml|html?|css|png|jpe?g|gif|svg|webp|zip|gz|mp[34]|mov|wav|log|sql';
const LINK_RE = new RegExp(String.raw`https?:\/\/[\x21-\x7e]+|(?<![\w@./-])(?:www\.[\w-]+(?:\.[\w-]+)+|(?:[\w-]+\.)+(?!(?:${FILE_EXT})\/)[a-z]{2,}(?=\/))(?:\/[\x21-\x7e]*)?`, 'gi');
const hostsOf = (raw, now) => new Set((Object.values(kb.parse(raw || '', now)).map((s) => s.text).join('\n').match(LINK_RE) || [])
  .map((u) => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].replace(/[.,<>"')\]]+$/, '').toLowerCase()));
const newHosts = (baseRaw, nextRaw, now) => { const old = hostsOf(baseRaw, now); return [...hostsOf(nextRaw, now)].filter((h) => !old.has(h)).sort(); };

/**
 * KB 원문 검사. 중복·만료 절까지 보려고 parse(raw, new Date(0))와 `## kb:` 줄 스캔을 함께 쓰고, 합계는 지금 유효한 절로 센다.
 * @returns {{errors: {key, code, msg}[], warnings: {key, code, msg}[]}} key가 null이면 파일 단위
 */
function checkKb(raw, { channel = null, pack = channel ? policy.load(channel) : null, now = new Date() } = {}) {
  const errors = []; const warnings = [];
  const e = (key, code, msg) => errors.push({ key, code, msg });
  const w = (key, code, msg) => warnings.push({ key, code, msg });
  const text = String(raw ?? '');
  // 상한을 넘는 원문은 더 보지 않는다 — 절마다 도는 정규식 검사가 큰 입력에서 오래 걸린다
  if (Buffer.byteLength(text, 'utf8') > LIMITS.kbMaxBytes) return { errors: [{ key: null, code: 'too_large', msg: `파일 ${LIMITS.kbMaxBytes / 1024} KB 이하` }], warnings };
  if (FENCE_RE.test(text.split(/^## kb:/m)[0])) e(null, 'fence', '<<<·>>> 금지(프롬프트 울타리)');
  const seen = new Set();
  for (const [, k] of text.matchAll(/^## kb:(.*)$/gm)) { const key = k.trim(); if (seen.has(key)) e(key, 'dup_key', '같은 key가 두 번 나온다'); seen.add(key); }
  const all = kb.parse(text, new Date(0));
  const valid = kb.parse(text, now);
  if (Object.keys(all).length > LIMITS.sections) e(null, 'too_many_sections', `절 ${LIMITS.sections}개 이하`);
  for (const s of Object.values(all)) {
    const k = s.key;
    if (!kb.KEY_RE.test(k)) e(k, 'bad_key', 'key는 영소문자·숫자·밑줄 2–40자');
    const title = s.meta['제목'] ?? s.meta.title; const source = s.meta['출처'] ?? s.meta.source;
    if (!title || title.length > TITLE_MAX) e(k, 'no_title', `제목 1–${TITLE_MAX}자`);
    if (!source || source.length > SOURCE_MAX) e(k, 'no_source', `출처 1–${SOURCE_MAX}자`);
    const reviewed = reviewedOf(s);
    if (reviewed !== undefined && !okDate(reviewed)) e(k, 'bad_reviewed', '검토일은 YYYY-MM-DD');
    const vu = s.meta.validUntil;
    if (vu === undefined) w(k, 'no_valid_until', 'validUntil 없음');
    else if (!okDate(vu) || (reviewed && okDate(reviewed) && vu < reviewed)) e(k, 'bad_valid_until', 'validUntil은 YYYY-MM-DD, 검토일 이후');
    if (!s.text) e(k, 'empty_body', '본문이 비어 있다');
    if (s.text.length > LIMITS.sectionChars) { e(k, 'body_too_long', `본문 ${LIMITS.sectionChars}자 이하(${s.text.length}자)`); continue; }
    if (FENCE_RE.test(s.raw)) e(k, 'fence', '<<<·>>> 금지(프롬프트 울타리)');
    // KB 전체가 매 회차 접수·답장 Agent 프롬프트에 그대로 들어간다
    // 호환 문자는 펼치고 보이지 않는 문자(폭 0·방향 제어·BOM)는 지운 뒤 본다 — 사이에 끼워 패턴을 피하지 못하게
    const plain = s.raw.normalize('NFKC').replace(INVISIBLE_RE, '');
    if (INJECTION.some((re) => re.test(plain))) e(k, 'kb_injection', '지시를 바꾸려는 문장(주입 패턴)');
    if (s.text.split('\n').some((l) => kb.META_RE.test(l) || /^#/.test(l))) w(k, 'meta_in_body', '본문 안에 메타처럼 생긴 줄이나 # 머리줄이 있다');
    if (pack) {
      let hits = [];
      try { hits = guard.check({ body: s.text, pack, kb: { sections: {} }, only: GUARD_WARN }); } catch { /* guard 칸이 잘못된 팩 */ }
      if (hits.length) w(k, 'guard', `이 절을 근거로 쓴 초안은 검사에 걸려 넘김이 된다(${hits.map((h) => h.code).join(', ')})`);
    }
  }
  const total = Object.values(valid).reduce((n, s) => n + s.text.length, 0);
  if (total > LIMITS.totalChars) e(null, 'total_too_long', `유효 본문 합계 ${LIMITS.totalChars}자 이하(${total}자)`);
  else if (total > LIMITS.warnChars) w(null, 'large_kb', `유효 본문 ${total}자 — 회차마다 약 ${total} 토큰이 프롬프트에 더 든다`);
  for (const [name, d] of Object.entries(isObj(pack?.intents) ? pack.intents : {})) {
    for (const key of arr(d?.kb)) if (!valid[key]) w(key, 'missing_key', `intent ${name}가 가리키는 절이 없다`);
  }
  return { errors, warnings };
}

/** 절 단위 비교(지금 유효한 절 기준). */
function kbDiff(beforeRaw, afterRaw, now = new Date()) {
  const a = kb.parse(beforeRaw || '', now); const b = kb.parse(afterRaw || '', now);
  const out = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [k, s] of Object.entries(b)) {
    const p = a[k];
    if (!p) out.added.push({ key: k, after: s.raw });
    else if (p.raw === s.raw) out.unchanged.push(k);
    else out.changed.push({ key: k, meta: canon(p.meta) !== canon(s.meta), body: p.text !== s.text, before: p.raw, after: s.raw });
  }
  for (const [k, s] of Object.entries(a)) if (!b[k]) out.removed.push({ key: k, before: s.raw });
  return out;
}
const diffKeys = (d) => [...d.added, ...d.removed, ...d.changed].map((x) => x.key);
// 감사 summary에는 절 본문을 넣지 않는다 — key와 해시만
const diffSummary = (d) => [
  ...d.added.map((x) => ({ key: x.key, op: 'added', fromHash: null, toHash: kb.sha(x.after) })),
  ...d.changed.map((x) => ({ key: x.key, op: 'changed', fromHash: kb.sha(x.before), toHash: kb.sha(x.after) })),
  ...d.removed.map((x) => ({ key: x.key, op: 'removed', fromHash: kb.sha(x.before), toHash: null })),
];
const kbVersionOf = (raw, now) => kb.sha(Object.values(kb.parse(raw, now)).map((s) => s.raw).join('\n\n'));

/**
 * 새로 생기거나 바뀐 절에만 검토일을 오늘(UTC+9)로 찍는다. 바뀌지 않은 절은 기준 원문의 값을 둔다(보낸 값은 믿지 않는다).
 * 바뀜 = 검토일을 뺀 메타와 본문이 기준 원문의 같은 key 절과 다르다.
 */
function stamp(raw, baseRaw, lang, today) {
  const old = kb.parse(baseRaw || '', new Date(0));
  const sig = (s) => canon([Object.fromEntries(Object.entries(s.meta).filter(([k]) => k !== '검토일' && k !== 'reviewed')), s.text]);
  return String(raw).split(/^(?=## kb:)/m).map((part) => {
    if (!part.startsWith('## kb:')) return part;
    const sec = Object.values(kb.parse(part, new Date(0)))[0];
    const prev = sec && old[sec.key];
    const value = prev && sig(prev) === sig(sec) ? reviewedOf(prev) : today;
    const lines = part.split('\n');
    const keep = [lines[0]];
    // 검토일 줄이 있으면 그 자리에서 값만 바꾼다(줄 순서가 바뀌면 안 바뀐 절도 바뀐 절로 보인다). 없으면 마지막 메타 줄 뒤에 넣는다.
    let at = 0; let slot = -1; let started = false; let alias = lang === 'en' ? 'reviewed' : '검토일';
    for (const line of lines.slice(1)) {
      const m = !started && line.match(kb.META_RE);
      if (m && (m[1] === '검토일' || m[1] === 'reviewed')) { if (slot < 0) { alias = m[1]; slot = keep.length; keep.push(null); } continue; }
      keep.push(line);
      if (m) at = keep.length - 1; else if (line.trim()) started = true;
    }
    const stamped = value ? `${alias}: ${value}` : null;
    if (slot >= 0) { if (stamped) keep[slot] = stamped; else keep.splice(slot, 1); } else if (stamped) keep.splice(at + 1, 0, stamped);
    return keep.join('\n');
  }).join('');
}

/**
 * KB 게시가 자동 발송 intent에 닿는가. KB 전체가 매 회차 접수·답장 Agent 프롬프트에 들어가므로, 라이브 정책에 L2 intent가 있으면
 * 바뀐 절이 하나라도 있을 때 L2 intent 전부가 영향이다. keys는 그중 intent의 kb가 가리키는 절(화면 표시용).
 */
function kbImpact(channel, keys) {
  const live = policy.source(channel);
  const pack = live && !live.invalid ? parsed(live.raw) : null;
  const intents = pack && keys.length ? policy.autoSet(live.raw).filter((m) => m !== '@ack') : [];
  const hit = [...new Set(intents.flatMap((m) => arr(pack.intents[m].kb).filter((k) => keys.includes(k))))];
  const ev = intents.length ? evidence(channel, intents) : { blocked: [], channelCritical: null };
  return { intents, keys: hit, blocked: ev.blocked, channelCritical: ev.channelCritical };
}
function requireAck(impact, hosts, ack) {
  if (impact.intents.length) {
    if (impact.blocked.length || impact.channelCritical !== 0) fail(409, 'l2_impact_ineligible', { intents: impact.intents, blocked: impact.blocked, channelCritical: impact.channelCritical });
    if (ack?.l2Impact !== true) fail(409, 'l2_impact', { intents: impact.intents, keys: impact.keys });
  }
  if (hosts.length && ack?.linkHosts !== true) fail(409, 'new_link_hosts', { hosts });
}

/** KB 한 언어 게시·되돌리기. 기준선은 그 언어의 실효 라이브 원문 kb.source(ch, lang).raw. */
function kbWrite(ch, { lang, raw, b, actor, ctx, action = 'publish', rollbackOf = null, draft = null }) {
  const now = new Date();
  const src = kb.source(ch, lang);
  if ((b.baseHash ?? null) !== src.srcHash) fail(409, 'stale', { current: src.srcHash });
  if (lang === 'en' && read('kb', ch, 'ko') === null) fail(409, 'ko_first');
  if (typeof raw !== 'string') fail(400, 'bad_raw');
  const next = action === 'publish' ? stamp(raw, src.raw, lang, kstDay(now.getTime())) : raw;
  const { errors, warnings } = checkKb(next, { channel: ch, now });
  if (errors.length) fail(422, 'invalid', { errors, warnings });
  const diff = kbDiff(src.raw, next, now);
  const impact = kbImpact(ch, diffKeys(diff));
  const hosts = newHosts(src.raw, next, now);
  requireAck(impact, hosts, b.ack);
  const summary = {
    diff: diffSummary(diff), warnings, ...(impact.intents.length ? { ackL2Impact: true, l2Impact: { intents: impact.intents, keys: impact.keys } } : {}),
    ...(hosts.length ? { ackLinkHosts: true, hosts } : {}), ...(rollbackOf ? { rollbackOf } : {}), ...(draft ? { draftId: draft.id } : {}),
    source: draft ? draft.origin : action === 'rollback' ? 'history' : 'edit', kbVersion: kbVersionOf(next, now),
  };
  const [changeId] = commit([{
    kind: 'kb', channel: ch, language: lang, action, raw: next, vkind: `kbsrc:${ch}:${lang}`, toHash: kb.sha(next), toSha256: sha256(next), fromHash: src.srcHash, summary,
  }], { actor, note: b.note, ctx, draftId: draft?.id });
  return { srcHash: kb.sha(next), version: kb.load(ch, lang).version, changeId, warnings };
}

/** KB 기본값 복원 — 고객 원문이 라이브인 언어마다 reset 행 하나, 한 트랜잭션. baseLang의 실효 원문 해시로 stale을 본다. */
function kbReset(ch, b, actor, ctx, { baseLang = 'ko', rollbackOf = null } = {}) {
  const base = kb.source(ch, baseLang);
  if ((b.baseHash ?? null) !== base.srcHash) fail(409, 'stale', { current: base.srcHash });
  const langs = LANGS.filter((l) => read('kb', ch, l) !== null);
  if (!langs.length) fail(409, 'already_default');
  const now = new Date();
  const plans = langs.map((l) => {
    const before = kb.source(ch, l);
    const img = shippedKb(ch, l);
    const after = img ?? (l === 'en' ? shippedKb(ch, 'ko') : null); // 복원 뒤 이 언어 요청에 쓰일 이미지 원문
    return { l, before, img, after, diff: kbDiff(before.raw, after, now) };
  });
  const impact = kbImpact(ch, [...new Set(plans.flatMap((p) => diffKeys(p.diff)))]);
  const hosts = [...new Set(plans.flatMap((p) => newHosts(p.before.raw, p.after, now)))].sort();
  requireAck(impact, hosts, b.ack);
  const ids = commit(plans.map((p) => ({
    kind: 'kb', channel: ch, language: p.l, action: 'reset', raw: null, toHash: p.img === null ? null : kb.sha(p.img), toSha256: p.img === null ? null : sha256(p.img), fromHash: p.before.srcHash,
    summary: {
      diff: diffSummary(p.diff), warnings: [], ...(impact.intents.length ? { ackL2Impact: true, l2Impact: { intents: impact.intents, keys: impact.keys } } : {}),
      ...(hosts.length ? { ackLinkHosts: true, hosts } : {}), ...(rollbackOf ? { rollbackOf } : {}), source: 'shipped', kbVersion: p.after === null ? 'none' : kbVersionOf(p.after, now),
    },
  })), { actor, note: b.note, ctx });
  const s = kb.source(ch, 'ko');
  return { srcHash: s.srcHash, version: kb.load(ch, 'ko').version, changeId: ids[0], changeIds: ids, warnings: [] };
}

function kbRollback(ch, b, actor, ctx) {
  channelOf(ch);
  const row = changeRow(b.changeId, 'kb', ch);
  // reset 행으로 되돌리기는 언어와 상관없이 그 채널 KB 전체 복원이다(en만 남는 상태를 만들지 않는다)
  if (row.action === 'reset') return kbReset(ch, b, actor, ctx, { baseLang: row.language, rollbackOf: row.id });
  return kbWrite(ch, { lang: row.language, raw: contentOf(row), b, actor, ctx, action: 'rollback', rollbackOf: row.id });
}

function kbGet(ch, q) {
  channelOf(ch);
  const lang = langOf(q.lang || 'ko');
  const s = kb.source(ch, lang);
  const shipped = shippedKb(ch, lang) ?? (lang === 'en' ? shippedKb(ch, 'ko') : null);
  const valid = kb.parse(s.raw || '');
  return {
    raw: s.raw, language: s.language, srcHash: s.srcHash, version: kb.load(ch, lang).version, live: s.live, invalid: s.invalid, shippedHash: shipped === null ? null : kb.sha(shipped),
    sections: Object.values(kb.parse(s.raw || '', new Date(0))).map((x) => ({
      key: x.key, title: x.title, source: x.meta['출처'] ?? x.meta.source ?? null, reviewed: reviewedOf(x) ?? null, validUntil: x.meta.validUntil ?? null, chars: x.text.length, expired: !valid[x.key],
    })),
    check: checkKb(s.raw || '', { channel: ch }),
  };
}

function kbCheck(ch, b) {
  channelOf(ch);
  const lang = langOf(b.lang);
  if (typeof b.raw !== 'string') fail(400, 'bad_raw');
  const now = new Date();
  const src = kb.source(ch, lang);
  const next = stamp(b.raw, src.raw, lang, kstDay(now.getTime()));
  const diff = kbDiff(src.raw, next, now);
  const im = kbImpact(ch, diffKeys(diff));
  return { ...checkKb(next, { channel: ch, now }), diff, l2Impact: im, newLinkHosts: newHosts(src.raw, next, now) };
}

function overview(v) {
  const conv = require('./convert');
  const kbView = (ch, l, s) => {
    const k = kb.load(ch, l);
    return { srcHash: s.srcHash, version: k.version, sections: Object.keys(k.sections).length, chars: Object.values(k.sections).reduce((n, x) => n + x.text.length, 0), live: s.live, invalid: s.invalid };
  };
  return {
    admin: v.admin, actor: v.actor, writable: v.writable, provider: llm.name(),
    limits: { ...LIMITS, manualChars: conv.MAX_SOURCE_CHARS, pdfTokens: conv.PDF_TOKEN_CAP, jobCap: JOB_TOKEN_CAP },
    channels: policy.all().map((p) => {
      const s = policy.source(p.channel);
      const kbs = {};
      for (const l of LANGS) { const ks = kb.source(p.channel, l); if (l === 'ko' || ks.language === 'en') kbs[l] = kbView(p.channel, l, ks); }
      return { channel: p.channel, label: p.label, policy: { version: s.version, live: s.live, invalid: s.invalid, ...(s.error ? { error: s.error } : {}) }, kb: kbs };
    }),
  };
}

/* ---------------- 이력 ---------------- */

const rowOut = (r) => ({ ...r, summary: parsed(r.summary) });
function history(q) {
  const where = []; const p = [];
  for (const [col, v] of [['kind', q.kind], ['channel', q.channel], ['language', q.lang]]) if (v) { where.push(`${col}=?`); p.push(v); }
  const lim = Math.min(Math.max(Math.trunc(Number(q.limit)) || 50, 1), 500);
  return { items: db.all(`SELECT * FROM config_changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`, ...p, lim).map(rowOut) };
}
function historyItem(id) {
  const row = db.get('SELECT * FROM config_changes WHERE id=?', id) || fail(404, 'no_change');
  if (row.action === 'reset') return { change: rowOut(row), content: null, shipped: true };
  return { change: rowOut(row), content: contentOf(row) };
}

/* ---------------- 초안 ---------------- */

const draftRow = (id) => db.get('SELECT * FROM kb_drafts WHERE id=?', id) || fail(404, 'no_draft');
const draftMeta = (d) => ({
  id: d.id, channel: d.channel, language: d.language, status: d.status, origin: d.origin, sourceName: d.source_name, sourceKind: d.source_kind,
  baseHash: d.base_hash, error: d.error, createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at,
});
// 저장·게시는 ready·failed(끝난 청크가 남은 변환) 초안만. 변환 중이면 409 draft_busy
const editable = (d) => { if (d.status === 'converting') fail(409, 'draft_busy'); if (!['ready', 'failed'].includes(d.status)) fail(409, 'draft_closed'); return d; };

function draftCreate(ch, b, actor) {
  channelOf(ch);
  const lang = langOf(b.lang);
  if (!['live', 'blank'].includes(b.from)) fail(400, 'bad_from');
  const s = kb.source(ch, lang); const now = db.now(); const id = db.uuid();
  db.insert('kb_drafts', { id, channel: ch, language: lang, status: 'ready', origin: 'edit', base_hash: s.srcHash, raw: b.from === 'live' ? s.raw ?? '' : '', created_by: actor, created_at: now, updated_at: now });
  return { draftId: id };
}
function draftList(q) {
  const rows = q.channel ? db.all('SELECT * FROM kb_drafts WHERE channel=? ORDER BY updated_at DESC LIMIT 100', q.channel) : db.all('SELECT * FROM kb_drafts ORDER BY updated_at DESC LIMIT 100');
  return { items: rows.map(draftMeta) };
}
function draftGet(id, v) {
  const d = draftRow(id); const now = new Date();
  return {
    draft: draftMeta(d), raw: d.raw, revision: d.revision, status: d.status, report: parsed(d.report),
    check: checkKb(d.raw, { channel: d.channel, now }), diff: kbDiff(kb.source(d.channel, d.language)?.raw, d.raw, now),
    ...(v.admin && d.source_text != null ? { sourceText: d.source_text } : {}),
  };
}
function draftSave(id, b) {
  const d = editable(draftRow(id));
  if (typeof b.raw !== 'string') fail(400, 'bad_raw');
  if (Number(b.revision) !== d.revision) fail(409, 'stale', { current: d.revision });
  db.run('UPDATE kb_drafts SET raw=?, revision=revision+1, updated_at=? WHERE id=?', b.raw, db.now(), id);
  const now = new Date();
  return { revision: d.revision + 1, check: checkKb(b.raw, { channel: d.channel, now }), diff: kbDiff(kb.source(d.channel, d.language).raw, b.raw, now) };
}
function draftPublish(id, b, actor, ctx) {
  const d = editable(draftRow(id));
  // 검토한 revision만 게시한다 — 그 사이 다른 저장이 있었으면 stale
  if (Number(b.revision) !== d.revision) fail(409, 'stale', { current: d.revision });
  return kbWrite(d.channel, { lang: d.language, raw: d.raw, b, actor, ctx, draft: d });
}
/** 폐기 — 변환 중이면 작업이 다음 청크 전에 멈춘다. */
function draftDiscard(id) {
  const d = draftRow(id);
  if (d.status === 'published') fail(409, 'draft_closed');
  db.run("UPDATE kb_drafts SET status='discarded', source_text=NULL, updated_at=? WHERE id=?", db.now(), id);
  return { status: 'discarded' };
}

/** 7일 지난 초안의 추출 원문을 지우고, 7일 지난 폐기·실패 초안을 지운다(기동 점검과 sweeper 주기). */
function purgeDrafts(now = Date.now()) {
  const cutoff = new Date(now - DRAFT_KEEP_MS).toISOString();
  return {
    cleared: Number(db.run('UPDATE kb_drafts SET source_text=NULL WHERE source_text IS NOT NULL AND updated_at < ?', cutoff).changes),
    deleted: Number(db.run("DELETE FROM kb_drafts WHERE status IN ('discarded','failed') AND updated_at < ?", cutoff).changes),
  };
}

/* ---------------- 매뉴얼 변환 작업 ---------------- */

// 한계: 서버 전체에서 변환 하나(전역 플래그). 처리량 문제가 생기면 큐로 바꾼다.
let converting = false;
// convert.js 오류(Error(code) + {code, status, ...추가 필드})를 HTTP 오류로
const asHttp = (e) => { if (!e || e instanceof HttpError || !e.status || !e.code) return e; const { code, status, ...extra } = e; return new HttpError(status, code, Object.keys(extra).length ? extra : undefined); };
// 일일 예산이 있으면 다음 호출 추정치가 남은 예산의 50% 이하일 때만 부른다(라이브 응대 몫을 남긴다)
const headroom = (tokens) => { const b = report.budget(); return b.limit == null || tokens <= (b.limit - b.used) * 0.5; };
const fileName = (s) => String(s).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, 80);

/** 변환 결과 절을 초안 원문에 병합 — 같은 key는 교체, 새 key는 뒤에 붙인다. */
function mergeKb(baseRaw, addRaw) {
  const keyOf = (p) => p.slice(6).split('\n')[0].trim();
  const parts = String(baseRaw || '').split(/^(?=## kb:)/m).map((p) => (p.trim() ? `${p.trimEnd()}\n\n` : p));
  for (const sec of String(addRaw).split(/^(?=## kb:)/m).filter((p) => p.startsWith('## kb:'))) {
    const i = parts.findIndex((p) => p.startsWith('## kb:') && keyOf(p) === keyOf(sec));
    if (i >= 0) parts[i] = `${sec.trimEnd()}\n\n`; else parts.push(`${sec.trimEnd()}\n\n`);
  }
  const out = parts.join('').trimEnd();
  return out ? `${out}\n` : '';
}

/**
 * 변환 시작 — 형식 추출, 추정(PDF는 실측 입력 + 출력 상한), 작업 상한·예산 여유 확인, 초안(converting) 생성, 백그라운드 작업.
 * conv는 server/convert.js 계약(extract·chunks·estimate·measurePdf·run·normalize·toMarkdown)을 따르는 모듈이다.
 */
async function convertStart(ch, b, actor, ctx, conv = require('./convert')) {
  channelOf(ch);
  const lang = langOf(b.lang);
  const mode = b.mode ?? 'merge';
  if (!['merge', 'replace'].includes(mode)) fail(400, 'bad_mode');
  if (typeof b.filename !== 'string' || !fileName(b.filename) || typeof b.contentBase64 !== 'string') fail(400, 'bad_file');
  if (converting) fail(409, 'convert_busy');
  converting = true;
  let started = false;
  try {
    const buffer = Buffer.from(b.contentBase64, 'base64');
    const src = conv.extract({ filename: b.filename, buffer });
    const name = fileName(b.filename);
    const live = kb.source(ch, lang);
    const existing = Object.values(kb.parse(live.raw || '')).map((s) => ({ key: s.key, title: s.title }));
    let est;
    if (src.kind === 'pdf') {
      const inputTokens = await conv.measurePdf({ buffer: src.pdf, existing, ctx: {} });
      est = { chunks: 1, perChunk: [inputTokens + conv.MAX_OUTPUT_TOKENS], total: inputTokens + conv.MAX_OUTPUT_TOKENS };
    } else est = conv.estimate({ kind: 'text', text: src.text, existing });
    if (est.total > JOB_TOKEN_CAP) fail(409, 'job_too_large', { totalTokens: est.total, jobCap: JOB_TOKEN_CAP });
    if (!headroom(est.perChunk[0])) fail(409, 'budget_headroom');
    const parts = src.kind === 'pdf' ? [null] : conv.chunks(src.text);
    const kind = src.kind === 'pdf' ? 'pdf' : (path.extname(name).slice(1).toLowerCase().replace(/^htm$/, 'html') || 'txt');
    const id = db.uuid(); const now = db.now();
    // 202 응답과 초안 report가 같은 모양. report에는 청크별 추정(perChunk)을 더 둔다
    const estimate = { chunks: est.chunks, inputTokens: est.total - est.chunks * conv.MAX_OUTPUT_TOKENS, totalTokens: est.total, jobCap: JOB_TOKEN_CAP };
    const rep = { chunks: { done: 0, total: parts.length, failed: [] }, omitted: [], usage: { input: 0, output: 0, perChunk: [] }, estimate: { ...estimate, perChunk: est.perChunk } };
    db.insert('kb_drafts', {
      id, channel: ch, language: lang, status: 'converting', origin: 'convert', source_name: name, source_kind: kind, source_text: src.kind === 'pdf' ? null : src.text,
      base_hash: live.srcHash, raw: mode === 'merge' ? live.raw ?? '' : '', report: JSON.stringify(rep), created_by: actor, created_at: now, updated_at: now,
    });
    // 매뉴얼 본문이 외부 API로 나간다는 사실을 남긴다
    accesslog.write({ action: 'kb.convert', user: actor, ip: ctx?.ip ?? null, channel: ch, lang, file: name, kind, bytes: buffer.length, provider: llm.name(), estimate: est.total });
    started = true;
    setImmediate(() => runJob({ id, parts, pdf: src.pdf, est, existing, source: name, rep, conv })
      .catch((e) => { console.error('[console] convert', e); finish(id, rep, 'failed', 'internal'); })
      .finally(() => { converting = false; }));
    return { draftId: id, status: 'converting', estimate };
  } catch (e) { throw asHttp(e); } finally { if (!started) converting = false; }
}

const finish = (id, rep, status, error) => db.run("UPDATE kb_drafts SET status=?, error=?, report=?, updated_at=? WHERE id=? AND status='converting'", status, error, JSON.stringify(rep), db.now(), id);

/**
 * 청크를 차례로 부른다. 부르기 전마다 실제 사용량 + 다음 추정치 ≤ 작업 상한, 일일 예산 여유를 다시 잰다(넘으면 failed job_cap|budget_headroom).
 * 청크 실패는 기록하고 다음으로 간다. 연속 3번 실패하면 멈춘다(failed llm_unavailable). 끝난 청크는 초안에 남는다. 폐기되면 조용히 멈춘다.
 */
async function runJob({ id, parts, pdf, est, existing, source, rep, conv }) {
  const used = new Set();
  let spent = 0; let streak = 0; let last = null;
  for (let i = 0; i < parts.length; i += 1) {
    if (db.get('SELECT status FROM kb_drafts WHERE id=?', id)?.status !== 'converting') return;
    const need = est.perChunk[i] ?? est.perChunk.at(-1);
    if (spent + need > JOB_TOKEN_CAP) { finish(id, rep, 'failed', 'job_cap'); return; }
    if (!headroom(need)) { finish(id, rep, 'failed', 'budget_headroom'); return; }
    const chunk = parts[i] && { ...parts[i], i: i + 1, n: parts.length };
    try {
      const r = await conv.run({ source, ...(pdf ? { pdf } : { chunk }), existing, ctx: {} });
      const u = { input: r.usage?.input_tokens || 0, output: r.usage?.output_tokens || 0 };
      spent += u.input + u.output;
      rep.usage.input += u.input; rep.usage.output += u.output; rep.usage.perChunk.push(u);
      const n = conv.normalize(r, used);
      rep.omitted.push(...n.omitted);
      rep.chunks.done += 1;
      streak = 0;
      const d = db.get('SELECT status, raw FROM kb_drafts WHERE id=?', id);
      if (d?.status !== 'converting') return;
      const raw = n.sections.length ? mergeKb(d.raw, conv.toMarkdown(n.sections, source)) : d.raw;
      db.run("UPDATE kb_drafts SET raw=?, report=?, updated_at=? WHERE id=? AND status='converting'", raw, JSON.stringify(rep), db.now(), id);
    } catch (e) {
      streak += 1; last = String(e?.code || e?.status || 'error');
      rep.chunks.failed.push({ ref: chunk?.ref ?? 'pdf', error: last });
      db.run("UPDATE kb_drafts SET report=?, updated_at=? WHERE id=? AND status='converting'", JSON.stringify(rep), db.now(), id);
      if (streak >= FAILS_TO_STOP) { finish(id, rep, 'failed', 'llm_unavailable'); return; }
    }
  }
  finish(id, rep, rep.chunks.done ? 'ready' : 'failed', rep.chunks.done ? null : last);
}

/* ---------------- 기동 점검 ---------------- */

/** 깨진 라이브 대상 기록(config.invalid), 끊긴 변환 정리, 초안 정리, 고객 원문 라이브 대상 한 줄. main 기동 순서의 마지막. */
function startup(now = Date.now()) {
  const invalid = []; const live = [];
  for (const p of policy.all()) {
    const ch = p.channel;
    if (p.invalid) invalid.push({ kind: 'policy', channel: ch, lang: null, changeId: policy.source(ch).changeId, error: p.error });
    const seen = new Set();
    for (const l of LANGS) {
      const k = kb.load(ch, l);
      if (k.version !== 'invalid' || seen.has(k.language)) continue;
      seen.add(k.language);
      const s = kb.source(ch, l);
      invalid.push({ kind: 'kb', channel: ch, lang: k.language, changeId: s.changeId, error: s.error });
    }
    if (read('policy', ch, null)) live.push(`policy:${ch}`);
    for (const l of LANGS) if (read('kb', ch, l)) live.push(`kb:${ch}:${l}`);
  }
  for (const x of invalid) {
    configInvalid.add(targetOf(x.kind, x.channel, x.lang));
    console.error(`[console] config.invalid ${targetOf(x.kind, x.channel, x.lang)} — 그 대상은 사람에게 넘기는 쪽으로 돈다(${x.error})`);
    accesslog.write({ action: 'config.invalid', ...x });
  }
  const interrupted = Number(db.run("UPDATE kb_drafts SET status='failed', error='interrupted', updated_at=? WHERE status='converting'", db.now()).changes);
  const purged = purgeDrafts(now);
  console.log(`[console] 고객 원문 라이브: ${live.length ? live.join(', ') : '없음'}`);
  return { invalid, live, interrupted, purged };
}

/* ---------------- 라우트 ([메서드, 경로, 처리, {write, maxBody, status}]) ---------------- */

const W = { write: true };
// 원문(raw)·팩을 싣는 본문 상한 — KB 원문 상한에 메모·JSON 여유를 더한다
const RAW_BODY = LIMITS.kbMaxBytes + 64 * 1024;
const WR = { write: true, maxBody: RAW_BODY };
const routes = [
  ['GET', /^\/api\/console$/, (_m, q, _b, _c, req) => overview(viewer(req, q))],
  ['GET', /^\/api\/console\/kb\/([^/]+)$/, (m, q) => kbGet(m[1], q)],
  ['POST', /^\/api\/console\/kb\/([^/]+)\/check$/, (m, _q, b) => kbCheck(m[1], b), { maxBody: RAW_BODY }],
  ['POST', /^\/api\/console\/kb\/([^/]+)\/publish$/, (m, _q, b, ctx) => { const a = adminOf(b); channelOf(m[1]); return kbWrite(m[1], { lang: langOf(b.lang), raw: b.raw, b, actor: a, ctx }); }, WR],
  ['POST', /^\/api\/console\/kb\/([^/]+)\/rollback$/, (m, _q, b, ctx) => kbRollback(m[1], b, adminOf(b), ctx), W],
  ['POST', /^\/api\/console\/kb\/([^/]+)\/reset$/, (m, _q, b, ctx) => { const a = adminOf(b); channelOf(m[1]); return kbReset(m[1], b, a, ctx); }, W],
  ['POST', /^\/api\/console\/kb\/([^/]+)\/drafts$/, (m, _q, b) => draftCreate(m[1], b, adminOf(b)), W],
  ['POST', /^\/api\/console\/kb\/([^/]+)\/convert$/, (m, _q, b, ctx) => convertStart(m[1], b, adminOf(b), ctx), { write: true, maxBody: LIMITS.uploadBody, status: 202 }],
  ['GET', /^\/api\/console\/drafts$/, (_m, q) => draftList(q)],
  ['GET', /^\/api\/console\/drafts\/([^/]+)$/, (m, q, _b, _c, req) => draftGet(m[1], viewer(req, q))],
  ['POST', /^\/api\/console\/drafts\/([^/]+)\/save$/, (m, _q, b) => { adminOf(b); return draftSave(m[1], b); }, WR],
  ['POST', /^\/api\/console\/drafts\/([^/]+)\/publish$/, (m, _q, b, ctx) => draftPublish(m[1], b, adminOf(b), ctx), W],
  ['POST', /^\/api\/console\/drafts\/([^/]+)\/discard$/, (m, _q, b) => { adminOf(b); return draftDiscard(m[1]); }, W],
  ['GET', /^\/api\/console\/policy\/([^/]+)$/, (m) => policyGet(m[1])],
  ['POST', /^\/api\/console\/policy\/([^/]+)\/check$/, (m, _q, b) => policyCheck(m[1], b), { maxBody: RAW_BODY }],
  ['POST', /^\/api\/console\/policy\/([^/]+)\/publish$/, (m, _q, b, ctx) => policyWrite(m[1], 'publish', b, adminOf(b), ctx), WR],
  ['POST', /^\/api\/console\/policy\/([^/]+)\/rollback$/, (m, _q, b, ctx) => policyWrite(m[1], 'rollback', b, adminOf(b), ctx), W],
  ['POST', /^\/api\/console\/policy\/([^/]+)\/reset$/, (m, _q, b, ctx) => policyWrite(m[1], 'reset', b, adminOf(b), ctx), W],
  ['GET', /^\/api\/console\/history$/, (_m, q) => history(q)],
  ['GET', /^\/api\/console\/history\/([^/]+)$/, (m) => historyItem(m[1])],
];

module.exports = {
  read, setup, writeGuard, isAdmin, markInvalid, configState, gate, checkKb, kbDiff, stamp, purgeDrafts, startup, convertStart, routes, JOB_TOKEN_CAP,
};
