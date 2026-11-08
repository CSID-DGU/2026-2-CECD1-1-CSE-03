'use strict';
// 감사 내보내기 CLI(scripts/audit-export.js) — 임시 파일 DB에 정상 경로로 시드하고 자식 프로세스로 돌린다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-export-'));
const DB = path.join(tmp, 'cs.db');
process.env.DB_PATH = DB; process.env.MAIL_MOCK_LOG = '0'; process.env.AUTO_SEND = '1';
for (const k of ['MAIL_PROVIDER', 'SHADOW_CHANNELS', 'MAIL_MOCK_FAIL', 'INBOUND_SECRET', 'RETENTION_DAYS']) delete process.env[k];
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const retention = require('../server/retention');
const INQ = require('../server/mock/inquiries');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'audit-export.js');
const SALT = 'test-salt-0123456789-0123456789-abcdef';
const day = (off) => new Date(Date.now() + off * 86_400_000).toISOString().slice(0, 10);
const RANGE = ['--from', day(-1), '--to', day(1), '--by', 'auditor'];
let seq = 0;
const outPath = () => path.join(tmp, `out-${++seq}.jsonl`);
function cli(args, env = {}) {
  const e = { PATH: process.env.PATH, DB_PATH: DB, AUDIT_SALT: SALT, COMPANY_NAME: 'TestCo', AGENT_NAME: 'Aria', MAIL_PROVIDER: 'mock', LLM_PROVIDER: 'mock', AUTO_SEND: '1', ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', SCRIPT, ...args], { env: e, encoding: 'utf8' });
}
function exportTo(extra = [], env) {
  const out = outPath(); const r = cli([...RANGE, '--out', out, ...extra], env);
  return { r, out, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, lines: fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] };
}

let ids;
before(async () => {
  db.init(DB); llm.use('mock');
  let n = 0;
  const inbound = async (id, extra = {}) => {
    const q = INQ.find((x) => x.id === id);
    const r = cases.addInbound({ ...q, threadId: `ae-${id}-${++n}`, providerMessageId: `aem-${id}-${n}`, ...extra });
    await loop.runCycle(r.caseId, r.messageId);
    return r;
  };
  const a = await inbound(1, { from: 'a1@example.com' });
  const b = await inbound(8, { from: 'a2@example.com' });
  const old = await inbound(2, { from: 'a3@example.com' });
  const gone = await inbound(3, { from: 'a4@example.com' });
  const now = db.now();
  // 같은 주소, 대소문자·공백만 다름
  db.run('UPDATE cases SET customer_email=? WHERE id=?', '  Same.Person@Example.com ', a.caseId);
  db.run('UPDATE cases SET customer_email=? WHERE id=?', 'same.person@example.com', b.caseId);
  // 기간 전에 생긴 케이스
  db.run("UPDATE cases SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?", old.caseId);
  // 파기한 케이스
  db.run("UPDATE cases SET state='CLOSED', closed_at=? WHERE id=?", now, gone.caseId);
  assert.ok(retention.purge(gone.caseId, { reason: 'test', actor: 'tester' }));
  // 카나리아 — 허용 목록 밖 열
  db.run("UPDATE cases SET subject='CANARY_SUBJECT', customer_name='CANARY_NAME', known_facts='{\"k\":\"CANARY_FACT\"}', close_detail='CANARY_CLOSE', hold_note='CANARY_HOLD' WHERE id=?", a.caseId);
  db.insert('handoffs', { id: db.uuid(), case_id: a.caseId, reason: 'CANARY_HANDOFF_REASON', briefing: '{"summary":"CANARY_BRIEFING"}', created_at: now });
  db.insert('activities', { id: db.uuid(), case_id: a.caseId, type: 'note', actor: 'kim', payload: JSON.stringify({ memo: 'CANARY_MEMO', draftId: 'd1' }), created_at: now });
  db.run("UPDATE messages SET sender='CANARY_SENDER', subject='CANARY_MSG_SUBJECT', body='CANARY_BODY_RAW', body_clean='BODY_CANARY_MSG' WHERE case_id=? AND direction='in'", a.caseId);
  db.run("UPDATE drafts SET original_body='CANARY_ORIG', final_body='CANARY_FINAL', error='CANARY_DRAFT_ERR', intent='CANARY_DRAFT_INTENT', used_facts=?, edit_tags=? WHERE case_id=?",
    JSON.stringify(['CANARY_USED']), JSON.stringify(['fact', 'CANARY_TAG']), a.caseId);
  db.run("UPDATE decisions SET input_summary='CANARY_SUMMARY' WHERE case_id=?", a.caseId);
  const dec = (step, output, extra = {}) => db.insert('decisions', { id: db.uuid(), case_id: old.caseId, message_id: null, step, agent: 'code', output: JSON.stringify(output), created_at: now, input_summary: 'CANARY_IN', ...extra });
  dec('triage', { intent: 'CANARY_INTENT', handoffReason: 'CANARY_HR', questionSummary: 'CANARY_QS', evidence: 'CANARY_EV', confidence: 0.9, kbHit: true, riskSignals: ['refund', 'CANARY_RISK'], language: 'ko', repeatsPrevious: false }, { reason: 'CANARY_INTENT' });
  dec('gate1', { action: 'DRAFT', rule: 5, inputs: { intent: 'CANARY_GATE_INTENT', level: 'L2', confidence: 0.9, autoSend: true, extra: 'CANARY_X' } }, { action: 'DRAFT', reason: 'account_deletion,CANARY_R2' });
  dec('respond', { body: 'CANARY_RESP_BODY', usedFacts: ['CANARY_USED_FACT', 'refund_policy'], needsHandoff: false, handoffReason: 'CANARY_HR2', humanCommitments: ['CANARY_COMMIT'] });
  dec('review', { pass: false, reasons: [{ code: 'tone', quote: 'CANARY_QUOTE' }, { code: 'CANARY_REVIEW_CODE', quote: 'q' }] });
  dec('brief', { summary: 'CANARY_BRIEF' });
  dec('error', { error: 'CANARY_ERR', attempt: 2, budget: true });
  dec('zz_unknown', { intent: 'account_deletion', secret: 'CANARY_UNKNOWN' });
  db.insert('config_changes', {
    id: db.uuid(), kind: 'kb', channel: 'support', language: 'ko', action: 'publish', from_hash: null, to_hash: 'abcdef123456', to_sha256: 'f'.repeat(64), actor: 'kim',
    note: 'BODY_CANARY_NOTE', summary: JSON.stringify({ diff: [{ key: 'refund_policy', op: 'change', fromHash: 'aaaaaa11', toHash: 'bbbbbb22', text: 'CANARY_SECTION' }], warnings: ['CANARY_WARN'] }), created_at: now,
  });
  ids = { a: a.caseId, b: b.caseId, old: old.caseId, gone: gone.caseId };
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('줄 형식·해시·카나리아: 본문 없이 낸 결과와 manifest 어디에도 카나리아가 없다', () => {
  const { r, out, text, lines } = exportTo();
  assert.equal(r.status, 0, r.stderr);
  const manifest = fs.readFileSync(`${out}.manifest.json`, 'utf8');
  assert.doesNotMatch(text + manifest, /canary/i);
  const m = JSON.parse(manifest);
  assert.equal(m.schema, 'audit-export/1');
  assert.equal(m.sha256, crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
  for (const f of [out, `${out}.manifest.json`]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${f} 권한은 소유자만`);
  assert.equal(m.by, 'auditor');
  assert.equal(m.env.COMPANY_NAME, 'TestCo'); assert.equal(m.env.AGENT_NAME, 'Aria'); assert.equal(m.env.autoSend, true);
  assert.match(m.templates.email, /^[0-9a-f]{64}$/);
  for (const l of lines) assert.equal(typeof l.t, 'string');
  // 코드값 자리의 카나리아는 (other), 알려진 값은 그대로, 정의 밖 edit_tags는 빠진다
  const dec = (step) => lines.findLast((l) => l.t === 'decision' && l.case_id === ids.old && l.step === step);
  assert.deepEqual(dec('triage').output, { intent: '(other)', handoffReason: '(other)', confidence: 0.9, kbHit: true, riskSignals: ['refund', '(other)'], language: 'ko', repeatsPrevious: false });
  assert.equal(dec('triage').reason, '(other)');
  assert.equal(dec('gate1').output.inputs.intent, '(other)');
  assert.equal(dec('gate1').output.inputs.autoSend, true);
  assert.equal('extra' in dec('gate1').output.inputs, false);
  assert.equal(dec('gate1').reason, 'account_deletion,(other)');
  assert.deepEqual(dec('respond').output, { usedFacts: ['(other)', 'refund_policy'], needsHandoff: false, handoffReason: '(other)' });
  assert.deepEqual(dec('review').output, { pass: false, reasons: [{ code: 'tone' }, { code: '(other)' }] });
  assert.deepEqual(dec('brief').output, {});
  assert.deepEqual(dec('error').output, { attempt: 2, budget: true });
  assert.deepEqual(dec('zz_unknown').output, {});
  const draft = lines.find((l) => l.t === 'draft' && l.id);
  const withTags = lines.filter((l) => l.t === 'draft').find((l) => l.intent === '(other)');
  assert.ok(draft && withTags);
  assert.deepEqual(withTags.edit_tags, ['fact']); assert.deepEqual(withTags.used_facts, ['(other)']);
  assert.equal(lines.find((l) => l.t === 'handoff' && l.case_id === ids.a).reason, '(other)');
  assert.deepEqual(lines.find((l) => l.t === 'activity' && l.type === 'note').payload, { draftId: 'd1' });
  // 포함: config_change(note 없음, diff는 key·해시만), 기간 전 케이스와 그 결정
  const cc = lines.find((l) => l.t === 'config_change');
  assert.equal('note' in cc, false);
  assert.deepEqual(cc.summary.diff, [{ key: 'refund_policy', op: 'change', fromHash: 'aaaaaa11', toHash: 'bbbbbb22' }]);
  assert.ok(lines.some((l) => l.t === 'case' && l.id === ids.old), '부모 case 줄');
  assert.ok(lines.some((l) => l.t === 'decision' && l.case_id === ids.old));
  assert.equal(lines.filter((l) => l.t === 'message').every((l) => !('body' in l)), true);
  // 접속기록
  const log = fs.readFileSync(path.join(tmp, 'access.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  assert.equal(log.filter((x) => x.action === 'audit.export').length, 1);
});

test('고객 해시: 같은 주소는 같고(대소문자·공백 무시), 파기한 케이스는 null, salt가 다르면 다르다', () => {
  const one = exportTo(); const two = exportTo(); const other = exportTo([], { AUDIT_SALT: `${SALT}-other` });
  const h = (x, id) => x.lines.find((l) => l.t === 'case' && l.id === id).customer_hash;
  assert.match(h(one, ids.a), /^[0-9a-f]{64}$/);
  assert.equal(h(one, ids.a), h(one, ids.b));
  assert.equal(h(one, ids.a), h(two, ids.a));
  assert.equal(h(one, ids.a), crypto.createHmac('sha256', SALT).update('same.person@example.com').digest('hex'));
  assert.notEqual(h(one, ids.a), h(other, ids.a));
  assert.equal(h(one, ids.gone), null);
  assert.notEqual(h(one, ids.a), h(one, ids.old));
});

test('--bodies: 본문(마스킹)과 note가 더해지지만 다른 카나리아와 금지 열은 여전히 없다', () => {
  const { r, text, lines } = exportTo(['--bodies']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(text, /BODY_CANARY_MSG/); assert.match(text, /BODY_CANARY_NOTE/);
  assert.doesNotMatch(text, /CANARY_(?!MSG|NOTE)/);
  const FORBIDDEN = ['input_summary', 'briefing', 'original_body', 'final_body', 'customer_email', 'customer_name', 'subject', 'known_facts', 'close_detail', 'hold_note', 'sender', 'provider_message_id', 'questionSummary', 'evidence', 'humanCommitments', 'quote'];
  const keys = new Set(); const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  lines.forEach(walk);
  assert.deepEqual(FORBIDDEN.filter((k) => keys.has(k)), []);
});

test('--channel: 다른 채널의 케이스는 빠진다', () => {
  const { lines } = exportTo(['--channel', 'sales']);
  assert.equal(lines.some((l) => l.t === 'case' && l.id === ids.a), false);
  assert.equal(lines.some((l) => l.t === 'config_change'), false);
});

test('거부: AUDIT_SALT 없음·31자, --by 없음, DB 파일 없음, 출력 파일 이미 있음 → exit 2, 덮지 않는다', () => {
  for (const salt of [undefined, '', 'x'.repeat(31)]) {
    const out = outPath(); const r = cli([...RANGE, '--out', out], { AUDIT_SALT: salt });
    assert.equal(r.status, 2); assert.equal(fs.existsSync(out), false); assert.equal(fs.existsSync(`${out}.manifest.json`), false);
  }
  assert.equal(cli(['--from', day(-1), '--to', day(1), '--out', outPath()]).status, 2);
  assert.equal(cli([...RANGE, '--out', outPath()], { DB_PATH: path.join(tmp, 'none.db') }).status, 2);
  const out = outPath(); fs.writeFileSync(out, 'keep');
  assert.equal(cli([...RANGE, '--out', out]).status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'keep');
  const out2 = outPath(); fs.writeFileSync(`${out2}.manifest.json`, 'keep');
  assert.equal(cli([...RANGE, '--out', out2]).status, 2);
  assert.equal(fs.existsSync(out2), false);
});
