'use strict';
// 감사 내보내기 — 서버와 같은 DB 파일(DB_PATH)을 읽어 기간 안의 처리 기록을 NDJSON 파일로 낸다. 서버가 돌고 있어도 된다.
//   node --no-warnings=ExperimentalWarning scripts/audit-export.js --from 2026-11-01 --to 2026-11-30 --by <이름> --out <파일> [--channel <ch>] [--bodies] [--include-versions]
// 허용 목록만 낸다: 줄마다 정해진 열만, LLM이 만든 문자열은 알려진 코드값만 남기고 나머지는 "(other)". 본문은 --bodies일 때만(PII 마스킹).
// 오류 코드: 인자·환경·파일 문제 2, 실행 중 오류 1. <out>.manifest.json에 건수·파일 sha256·표시 문구 해시를 남긴다.
// 단순화: 표 하나씩 db.all로 읽고 줄 단위로 쓴다 — 기간이 매우 길면 표 하나만큼 메모리를 쓴다. 필요하면 LIMIT/OFFSET 분할로 바꾼다.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
const accesslog = require('../server/accesslog');
const kb = require('../server/kb');
const policy = require('../server/policy');
const guard = require('../server/guard');
const mail = require('../server/mail');
const retention = require('../server/retention');
const { read } = require('../server/config-read');

const USAGE = '사용법: audit-export.js --from YYYY-MM-DD --to YYYY-MM-DD --by <이름> --out <파일> [--channel <ch>] [--bodies] [--include-versions]';
const OTHER = '(other)';
const EDIT_TAGS = ['fact', 'tone', 'missing', 'excess', 'policy', 'critical'];
const ACTIONS = ['IGNORE', 'HANDOFF', 'COMPOSE', 'DRAFT', 'ANSWER_AND_HANDOFF', 'SHADOW', 'REWRITE', 'PASS', 'FAIL', 'CLASSIFIED', 'RETRY', 'CARRY_OVER', 'ABORTED', 'ACK'];
const AGENTS = ['triage', 'responder', 'reviewer', 'briefer', 'code'];
const GUARD_CODES = ['amount', 'contact', 'date_promise', 'date', 'emoji', 'empty', 'fact_off_intent', 'forbidden_word', 'link_not_in_kb', 'no_fact', 'too_long', 'unknown_fact', 'unresolved_slot'];
const REVIEW_CODES = ['unsupported_claim', 'forbidden_content', 'not_answered', 'commitment_touched', 'tone', 'no_bridge', 'reasked_known'];
const RISKS = ['refund', 'legal', 'complaint', 'injection', 'pii', 'billing'];
// 정책 팩 밖에서 코드가 정하는 사유(사전 필터·회차 중단)
const FIXED_REASONS = ['auto_reply_or_empty', 'internal_sender', 'sender_unverified', 'sender_changed', 'responder_human', 'case_changed'];

const fail = (code, msg) => { const e = new Error(msg); e.exitCode = code; return e; };

function parseArgs(argv) {
  const o = {}; const bool = new Set(['--bodies', '--include-versions']); const val = new Set(['--from', '--to', '--by', '--out', '--channel']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bool.has(a)) o[a.slice(2)] = true;
    else if (val.has(a) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i];
    else throw fail(2, `${USAGE}\n알 수 없거나 값이 없는 인자: ${a}`);
  }
  for (const k of ['by', 'from', 'to', 'out']) if (!o[k]) throw fail(2, `--${k} 필요\n${USAGE}`);
  for (const k of ['from', 'to']) if (!/^\d{4}-\d{2}-\d{2}$/.test(o[k]) || Number.isNaN(Date.parse(`${o[k]}T00:00:00+09:00`))) throw fail(2, `--${k}는 YYYY-MM-DD(KST)`);
  if (o.from > o.to) throw fail(2, '--from이 --to보다 늦다');
  if (o.channel !== undefined && !kb.CHANNEL_RE.test(o.channel)) throw fail(2, '--channel 형식이 맞지 않는다');
  return o;
}

// 기간은 KST 날짜 [from 00:00, to+1일 00:00)
const dayStart = (d) => new Date(`${d}T00:00:00+09:00`).toISOString();
const dayAfter = (d) => new Date(Date.parse(`${d}T00:00:00+09:00`) + 86_400_000).toISOString();

function knownCodes() {
  const s = new Set([...policy.SYSTEM_REASONS, ...policy.REQUIRED_REASONS, ...FIXED_REASONS]);
  const add = (raw) => {
    let p; try { p = JSON.parse(raw); } catch { return; }
    for (const k of Object.keys(p?.intents || {})) s.add(k);
    for (const r of Array.isArray(p?.handoffReasons) ? p.handoffReasons : []) if (typeof r === 'string') s.add(r);
  };
  for (const v of db.all("SELECT content FROM versions WHERE kind LIKE 'policy:%'")) add(v.content);
  const dir = path.join(__dirname, '..', 'policy');
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) add(fs.readFileSync(path.join(dir, f), 'utf8'));
  return s;
}

function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const salt = process.env.AUDIT_SALT || '';
  if (salt.length < 32) throw fail(2, 'AUDIT_SALT 32자 이상 필요');
  const file = db.file();
  if (!file || !fs.existsSync(file)) throw fail(2, `DB 파일이 없다: ${file || ':memory:'} — 서버와 같은 DB_PATH로 실행한다`);
  const out = path.resolve(o.out); const mf = `${out}.manifest.json`;
  if (fs.existsSync(out) || fs.existsSync(mf)) throw fail(2, `이미 있어 덮지 않는다: ${fs.existsSync(out) ? out : mf}`);

  db.init(file);
  const onInvalid = ({ kind, channel, lang, error }) => console.error(`[경고] ${kind} ${channel}${lang ? `:${lang}` : ''} 원문을 쓸 수 없다(${error})`);
  kb.setReader(read, { onInvalid }); policy.setReader(read, { onInvalid });
  accesslog.start(path.join(path.dirname(file), 'access.jsonl'), { subscribe: false });

  let fd; let fdm;
  try { fd = fs.openSync(out, 'wx', 0o600); fdm = fs.openSync(mf, 'wx', 0o600); } catch (e) {
    if (fd !== undefined) { fs.closeSync(fd); fs.rmSync(out, { force: true }); }
    throw fail(2, `출력 파일을 열 수 없다: ${e.code || e.message}`);
  }

  const codes = knownCodes();
  const code = (v) => (v == null ? null : codes.has(v) ? v : OTHER);
  const codeList = (v) => (v == null ? null : String(v).split(',').map((x) => code(x.trim())).join(','));
  const oneOf = (set) => (v) => (v == null ? null : set.includes(v) ? v : OTHER);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const list = (f) => (v) => (Array.isArray(v) ? v.map(f) : []);
  const key = (v) => (typeof v === 'string' && kb.KEY_RE.test(v) ? v : OTHER);
  const idish = (v) => (typeof v === 'string' && /^[\w.:-]{1,80}$/.test(v) ? v : null);
  const hash = (v) => (typeof v === 'string' && /^[0-9a-f]{6,64}$/i.test(v) ? v : null);
  const tags = (v) => (Array.isArray(v) ? v.filter((t) => EDIT_TAGS.includes(t)) : []);
  const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const pick = (obj, spec) => {
    const r = {}; if (!obj || typeof obj !== 'object') return r;
    for (const [k, f] of Object.entries(spec)) if (k in obj) r[k] = f(obj[k]);
    return r;
  };
  const kbHit = (v) => (v === true || v === false || v === 'partial' ? v : v == null ? null : OTHER);
  const lang = oneOf(['ko', 'en']);
  const INPUTS = {
    intent: code, handoffReason: code, level: oneOf(['L0', 'L1', 'L2']), kbHit, confidence: num, confidenceMin: num, rounds: num, maxRounds: num,
    repeatStreak: num, repeatLimit: num, riskSignals: list(oneOf(RISKS)), language: lang, shadow: bool, guardPass: bool, senderTrusted: bool, autoSend: bool,
  };
  const GATE = { action: oneOf(ACTIONS), reason: code, rule: num, inputs: (v) => pick(v, INPUTS), autoSend: bool };
  const STEP_OUT = {
    prefilter: { pass: bool, action: oneOf(ACTIONS), reason: code },
    triage: { intent: code, confidence: num, language: lang, kbHit, riskSignals: list(oneOf(RISKS)), handoffReason: code, repeatsPrevious: bool },
    gate1: GATE, gate2: GATE, execute: GATE,
    respond: { usedFacts: list(key), needsHandoff: bool, handoffReason: code },
    guard: { violations: list((v) => ({ code: oneOf(GUARD_CODES)(v?.code) })) },
    review: { pass: bool, reasons: list((v) => ({ code: oneOf(REVIEW_CODES)(v?.code) })) },
    error: { attempt: num, budget: bool },
  };
  const stepOut = (step, raw) => (STEP_OUT[step] ? pick(json(raw), STEP_OUT[step]) : {});

  const from = dayStart(o.from); const to = dayAfter(o.to);
  const chOk = (ch) => !o.channel || ch === o.channel;
  const inRange = (col) => `${col} >= ? AND ${col} < ?`;
  const caseCh = new Map(db.all('SELECT id, channel FROM cases').map((c) => [c.id, c.channel]));

  const sha = crypto.createHash('sha256'); const counts = {};
  const emit = (t, row) => { const line = `${JSON.stringify({ t, ...row })}\n`; fs.writeSync(fd, line); sha.update(line); counts[t] = (counts[t] || 0) + 1; };
  const ofCase = (r) => caseCh.has(r.case_id) && chOk(caseCh.get(r.case_id));
  const W = [from, to];

  const messages = db.all(`SELECT * FROM messages WHERE ${inRange('occurred_at')} ORDER BY occurred_at, rowid`, ...W).filter(ofCase);
  const decisions = db.all(`SELECT * FROM decisions WHERE ${inRange('created_at')} ORDER BY created_at, rowid`, ...W).filter(ofCase);
  const drafts = db.all(`SELECT * FROM drafts WHERE ${inRange('created_at')} ORDER BY created_at, rowid`, ...W).filter(ofCase);
  const handoffs = db.all(`SELECT * FROM handoffs WHERE ${inRange('created_at')} ORDER BY created_at, rowid`, ...W).filter(ofCase);
  const activities = db.all(`SELECT * FROM activities WHERE ${inRange('created_at')} ORDER BY created_at, rowid`, ...W).filter(ofCase);
  const newCases = db.all(`SELECT id FROM cases WHERE ${inRange('created_at')}`, ...W).map((c) => c.id).filter((id) => chOk(caseCh.get(id)));
  const caseIds = new Set([...newCases, ...[messages, decisions, drafts, handoffs, activities].flatMap((rows) => rows.map((r) => r.case_id))]);
  const changes = db.all(`SELECT * FROM config_changes WHERE ${inRange('created_at')} ORDER BY seq`, ...W).filter((c) => chOk(c.channel));
  const llm = db.all(`SELECT * FROM llm_calls WHERE ${inRange('created_at')} ORDER BY created_at, rowid`, ...W).filter((r) => (r.case_id && caseCh.has(r.case_id) ? chOk(caseCh.get(r.case_id)) : !o.channel));

  const hmac = (email) => crypto.createHmac('sha256', salt).update(String(email).trim().toLowerCase()).digest('hex');
  for (const c of db.all('SELECT * FROM cases ORDER BY created_at, rowid').filter((r) => caseIds.has(r.id))) {
    emit('case', {
      id: c.id, channel: c.channel, state: c.state, responder: c.responder, created_at: c.created_at, updated_at: c.updated_at, closed_at: c.closed_at,
      close_reason: oneOf(['resolved', 'no_response', 'duplicate', 'spam', 'not_applicable', 'other'])(c.close_reason), held_at: c.held_at, purged_at: c.purged_at,
      customer_hash: c.purged_at ? null : hmac(c.customer_email),
    });
  }
  for (const m of messages) {
    emit('message', {
      id: m.id, case_id: m.case_id, direction: m.direction, sent_by: m.sent_by, occurred_at: m.occurred_at, auto_submitted: m.auto_submitted, edited: m.edited,
      sender_auth: oneOf(['pass', 'fail', 'form'])(m.sender_auth), ...(o.bodies ? { body: guard.maskPii(m.body_clean || '') } : {}),
    });
  }
  const refs = new Set();
  for (const d of decisions) {
    for (const h of [d.prompt_version, d.kb_version, d.policy_version]) if (h) refs.add(h);
    emit('decision', {
      id: d.id, case_id: d.case_id, message_id: d.message_id, step: d.step, agent: oneOf(AGENTS)(d.agent), action: oneOf(ACTIONS)(d.action), reason: codeList(d.reason),
      prompt_version: hash(d.prompt_version), kb_version: hash(d.kb_version), policy_version: hash(d.policy_version), latency_ms: d.latency_ms, created_at: d.created_at,
      output: stepOut(d.step, d.output),
    });
  }
  for (const d of drafts) {
    emit('draft', {
      id: d.id, case_id: d.case_id, trigger_message_id: d.trigger_message_id, status: oneOf(['PENDING', 'SENT', 'STALE', 'DISCARDED', 'NOT_SELECTED', 'SUPERSEDED', 'SHADOW'])(d.status),
      intent: code(d.intent), action: oneOf(ACTIONS.concat('HUMAN_REPLY'))(d.action), approved_by: d.approved_by, approved_at: d.approved_at, sent_at: d.sent_at,
      edited_by: d.edited_by, edit_tags: tags(json(d.edit_tags)), used_facts: list(key)(json(d.used_facts)), created_at: d.created_at,
    });
  }
  for (const h of handoffs) emit('handoff', { id: h.id, case_id: h.case_id, reason: code(h.reason), assignee: h.assignee, created_at: h.created_at, returned_at: h.returned_at });
  for (const a of activities) {
    const p = json(retention.scrubPayload(a.type, a.payload));
    if (p && 'editTags' in p) p.editTags = tags(p.editTags);
    emit('activity', { id: a.id, case_id: a.case_id, type: a.type, actor: a.actor, created_at: a.created_at, payload: p });
  }
  for (const c of changes) {
    refs.add(c.from_hash); refs.add(c.to_hash);
    const s = json(c.summary) || {};
    // 요약은 목록에 있는 키만 — KB 절 본문·경고 문구·링크 호스트는 내지 않는다
    const summary = {
      diff: list((x) => ({ key: typeof x?.key === 'string' && /^[\w.@:-]{1,80}$/.test(x.key) ? x.key : OTHER, op: typeof x?.op === 'string' && /^[a-z_]{1,20}$/.test(x.op) ? x.op : OTHER, fromHash: hash(x?.fromHash), toHash: hash(x?.toHash) }))(s.diff),
      rollbackOf: idish(s.rollbackOf), draftId: idish(s.draftId), source: idish(s.source), kbVersion: hash(s.kbVersion),
    };
    emit('config_change', {
      seq: c.seq, id: c.id, kind: c.kind, channel: c.channel, language: c.language, action: c.action, from_hash: c.from_hash, to_hash: c.to_hash, to_sha256: c.to_sha256,
      actor: c.actor, summary, created_at: c.created_at, ...(o.bodies ? { note: c.note } : {}),
    });
  }
  for (const l of llm) emit('llm_call', { agent: l.agent, provider: l.provider, model: l.model, input_tokens: l.input_tokens, output_tokens: l.output_tokens, latency_ms: l.latency_ms, ok: l.ok, error: l.error, created_at: l.created_at });
  for (const h of refs) {
    const v = h && db.get('SELECT hash, kind, created_at, content FROM versions WHERE hash=?', h);
    if (v) emit('version', { hash: v.hash, kind: v.kind, created_at: v.created_at, ...(o['include-versions'] ? { content: v.content } : {}) });
  }
  fs.closeSync(fd);

  const filters = { from: o.from, to: o.to, channel: o.channel ?? null, bodies: !!o.bodies, includeVersions: !!o['include-versions'] };
  const digest = sha.digest('hex');
  const renders = ['안내', 'hello'].flatMap((body) => [true, false].map((auto) => mail.renderAgent({ name: 'x', body, auto })));
  const e = process.env;
  const manifest = {
    schema: 'audit-export/1', generatedAt: db.now(), by: o.by, filters, counts, sha256: digest,
    templates: { email: crypto.createHash('sha256').update(renders.join('\n')).digest('hex') },
    env: { COMPANY_NAME: e.COMPANY_NAME ?? null, AGENT_NAME: e.AGENT_NAME ?? null, MAIL_PROVIDER: mail.name(), LLM_PROVIDER: e.LLM_PROVIDER ?? null, autoSend: policy.autoSendOn(), SHADOW_CHANNELS: e.SHADOW_CHANNELS ?? null },
    app: { version: require('../package.json').version },
  };
  fs.writeSync(fdm, `${JSON.stringify(manifest, null, 2)}\n`); fs.closeSync(fdm);
  accesslog.write({ action: 'audit.export', user: o.by, by: o.by, filters, counts, sha256: digest });
  console.error(`내보냄: ${Object.values(counts).reduce((a, b) => a + b, 0)}줄 → ${out}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) {
    console.error(e.exitCode ? e.message : `오류: ${e.message}`);
    process.exitCode = e.exitCode || 1;
  }
}
module.exports = { main };
