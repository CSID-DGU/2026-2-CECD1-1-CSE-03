'use strict';
// 운영 CLI도 고객이 게시한 KB·정책을 읽는다 — subject-request.js 실행과 scripts/*.js 정적 검사.
process.env.MAIL_MOCK_LOG = '0';
process.env.AUTO_SEND = '0';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const db = require('../server/db');
const llm = require('../server/llm');
const kb = require('../server/kb');
const policy = require('../server/policy');
const cases = require('../server/cases');
const loop = require('../server/loop');
const store = require('../server/store');
const { read, sha256 } = require('../server/config-read');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-reader-'));
after(() => { db.init(':memory:'); kb.setReader(null); policy.setReader(null); fs.rmSync(tmp, { recursive: true, force: true }); });

test('subject-request.js: export·delete의 CRM 문서가 고객 팩 caseType, 깨진 팩이면 stderr 경고 한 줄과 그대로 파싱되는 stdout', async () => {
  const file = path.join(tmp, 'cs.db');
  db.init(file); llm.use('mock');
  kb.setReader(read); policy.setReader(read);
  const pack = JSON.parse(policy.shipped('support'));
  assert.equal(pack.intents.refund.caseType, 'Problem');
  pack.intents.refund.caseType = 'Question';
  const raw = `${JSON.stringify(pack, null, 2)}\n`;
  db.saveVersion(kb.sha(raw), 'policy:support', raw);
  db.insert('config_changes', { id: db.uuid(), kind: 'policy', channel: 'support', language: null, action: 'publish', to_hash: kb.sha(raw), to_sha256: sha256(raw), actor: 'seed', created_at: db.now() });
  const run = async (from) => {
    const r = cases.addInbound({ channel: 'support', from, subject: '환불', body: '어제 자동결제가 됐는데 환불해 주세요.' });
    await loop.runCycle(r.caseId, r.messageId);
    return r.caseId;
  };
  const a = await run('cli-a@seed.example.com');
  const b = await run('cli-b@seed.example.com');
  const cli = (...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'subject-request.js'), ...args],
    { env: { PATH: process.env.PATH, DB_PATH: file, LLM_PROVIDER: 'mock', MAIL_MOCK_LOG: '0' }, cwd: tmp, encoding: 'utf8' });
  const ex = cli('export', 'cli-a@seed.example.com', '--by', 'dpo');
  assert.equal(ex.status, 0, ex.stderr);
  assert.equal(ex.stderr, '');
  const out = JSON.parse(ex.stdout);
  assert.equal(out[0].crm.case.caseType, 'Question');
  loop.closeCase(a, { by: 'h' });
  const del = cli('delete', 'cli-a@seed.example.com', '--by', 'dpo');
  assert.equal(del.status, 0, del.stderr);
  const doc = store.get('cases', a).doc;
  assert.ok(db.get('SELECT purged_at FROM cases WHERE id=?', a).purged_at);
  assert.equal(doc.caseType, 'Question', '파기 뒤 다시 계산한 문서도 고객 값');
  // 라이브 팩을 깨뜨린다 — 경고는 stderr 한 줄, stdout은 그대로 JSON
  db.run('UPDATE versions SET content=content||? WHERE hash=?', ' ', kb.sha(raw));
  const broken = cli('export', 'cli-b@seed.example.com', '--by', 'dpo');
  assert.equal(broken.status, 0, broken.stderr);
  const warns = broken.stderr.split('\n').filter(Boolean);
  assert.equal(warns.length, 1, broken.stderr);
  assert.match(warns[0], /^경고: policy:support 저장된 원문을 쓸 수 없어\(mismatch\)/);
  assert.equal(JSON.parse(broken.stdout)[0].case.id, b);
});

test('파일 DB를 여는 scripts/*.js는 kb·policy setReader를 부른다 — 대상은 정확히 subject-request.js, audit-export.js', () => {
  const dir = path.join(ROOT, 'scripts');
  // 순서: 목록 → 이름으로 ablation.js 제외 → 그 뒤에만 읽는다
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'ablation.js');
  const targets = [];
  for (const n of names) {
    const src = fs.readFileSync(path.join(dir, n), 'utf8');
    // 인자 없는 db.init()도 파일 DB(기본 DB_PATH)다. ':memory:' 리터럴만 뺀다
    const args = [...src.matchAll(/\bdb\.init\(\s*([^)]*?)\s*\)/g)].map((m) => m[1]);
    if (args.some((x) => !/^(['"]):memory:\1$/.test(x))) targets.push({ n, src });
  }
  assert.deepEqual(targets.map((x) => `scripts/${x.n}`).sort(), ['scripts/audit-export.js', 'scripts/subject-request.js']);
  for (const { n, src } of targets) {
    assert.match(src, /\bkb\.setReader\(/, n);
    assert.match(src, /\bpolicy\.setReader\(/, n);
  }
});
