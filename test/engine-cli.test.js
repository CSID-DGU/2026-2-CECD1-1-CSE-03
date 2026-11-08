'use strict';
// scripts/engine.js 결정적 검사 CLI. run(argv, io)를 같은 프로세스에서 부른다. 실제 LLM·외부 네트워크 없음(루프백 서버만).
process.env.MAIL_MOCK_LOG = '0';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const llm = require('../server/llm');
const db = require('../server/db');
const policy = require('../server/policy');
const triageAgent = require('../server/agents/triage');
const { checkKb } = require('../server/console');
const engine = require('../scripts/engine');

const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, 'kb', 'support.md');
let work;
before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cli-'));
  process.env.DB_PATH = path.join(work, 'engine.db'); // 파일 DB가 생기면 여기 생긴다(AC-D13)
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

const put = (name, data) => { const p = path.join(work, name); fs.writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return p; };
async function cli(argv, stdin = '') {
  let s = '';
  const code = await engine.run(argv, { write: (x) => { s += x; }, stdin });
  return { code, out: JSON.parse(s) };
}
const msg = (m) => JSON.stringify(m);

// 출력 최상위 키. 키를 바꾸면 contract를 올리고 새 줄을 더한다
const KEYS = {
  1: {
    version: ['name', 'version', 'contract', 'commands'],
    extract: ['kind', 'chunks', 'rules', 'schema'],
    'extract-pdf': ['kind', 'rules', 'schema'],
    'kb-normalize': ['markdown', 'sections', 'omitted'],
    'kb-check': ['errors', 'warnings'],
    'policy-check': ['problems', 'widenings'],
    render: ['agent', 'system', 'user', 'schema'],
    mask: ['text'],
    'check-reply': ['stage', 'prefilter', 'triage', 'gate1', 'guard', 'review', 'decision', 'level', 'env'],
    'dashboard-data': ['generatedAt', 'source', 'workload', 'promotion', 'cases', 'truncated'],
  },
};

// 테스트용 최소 DOCX(ZIP)
function zip(files) {
  const locals = []; const cds = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const data = zlib.deflateRawSync(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, data]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(f.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    locals.push(local); cds.push(Buffer.concat([cd, name])); off += local.length;
  }
  const cd = Buffer.concat(cds); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const docx = () => zip([{ name: 'word/document.xml', data: Buffer.from('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>환불 규정</w:t></w:r></w:p><w:p><w:r><w:t>구독 해지는 설정에서 합니다.</w:t></w:r></w:p></w:body></w:document>') },
  { name: 'word/styles.xml', data: Buffer.from('<w:styles><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>') }]);

const RECEIPT = {
  intent: 'receipt', handoffReason: null, confidence: 0.95, kbHit: 'true', kbSections: ['receipt'], riskSignals: [],
  questionSummary: '영수증 발급 위치', handoffTopic: null, repeatsPrevious: false, language: 'ko', evidence: [],
};
const RECEIPT_DRAFT = { body: '영수증은 [설정 > 결제 > 결제 내역]에서 결제 건별로 PDF로 내려받으실 수 있습니다.', usedFacts: ['receipt'], humanCommitments: [], needsHandoff: false, handoffReason: null };
const RECEIPT_MSG = msg({ body: '영수증은 어디서 받을 수 있나요?', from: 'cust@example.com', senderAuth: 'pass' });
const shippedPack = (ch) => policy.fill(policy.validate(JSON.parse(policy.shipped(ch)), ch));

test('AC-D12 하위 명령 출력 키가 스냅샷과 같고 contract는 1', async () => {
  const v = await cli(['--version']);
  assert.equal(v.code, 0);
  assert.equal(v.out.contract, 1);
  const snap = KEYS[v.out.contract];
  assert.ok(snap, 'contract에 맞는 스냅샷이 있어야 한다');
  assert.deepEqual(Object.keys(v.out), snap.version);
  assert.deepEqual(v.out.commands, ['extract', 'kb-normalize', 'kb-check', 'policy-check', 'render', 'mask', 'check-reply', 'dashboard-data']);
  const keys = async (name, argv, stdin) => { const r = await cli(argv, stdin); assert.ok(r.code <= 1, `${name}: ${JSON.stringify(r.out)}`); assert.deepEqual(Object.keys(r.out), snap[name], name); };
  await keys('extract', ['extract', put('a.md', '# 제목\n본문')]);
  await keys('extract-pdf', ['extract', put('a.pdf', '%PDF-1.4\n%%EOF')]);
  await keys('kb-normalize', ['kb-normalize', put('s.json', { sections: [{ key: 'a_b', title: 't', sourceRef: 'r', body: '본문', validUntil: null }], omitted: [] }), '--source', 'm.md']);
  await keys('kb-check', ['kb-check', KB]);
  await keys('policy-check', ['policy-check', path.join(ROOT, 'policy', 'support.json')]);
  await keys('render', ['render', 'triage', '--channel', 'support', '--kb', KB], RECEIPT_MSG);
  await keys('mask', ['mask', put('m.txt', '안녕')]);
  await keys('check-reply', ['check-reply', '--channel', 'support', '--kb', KB], RECEIPT_MSG);
  // check-reply의 env 키 안쪽도 고정한다
  const cr = await cli(['check-reply', '--channel', 'support', '--kb', KB], RECEIPT_MSG);
  assert.deepEqual(Object.keys(cr.out.env), ['autoSend', 'shadow', 'packShadow', 'requireSenderAuth', 'formSenderDomains', 'mirror']);
});

test('AC-D1 kb-check = console.checkKb, 오류면 종료 코드 1', async () => {
  const raw = fs.readFileSync(KB, 'utf8');
  const ok = await cli(['kb-check', KB, '--channel', 'support']);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.out, checkKb(raw, { channel: 'support' }));
  const badRaw = '## kb:Bad Key\n제목: x\n\n본문\n\n## kb:no_src\n제목: y\n\n본문';
  const bad = await cli(['kb-check', put('bad.md', badRaw)]);
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.out, checkKb(badRaw, {}));
  assert.ok(bad.out.errors.some((e) => e.code === 'bad_key') && bad.out.errors.some((e) => e.code === 'no_source'));
  const packed = await cli(['kb-check', KB, '--pack', path.join(ROOT, 'policy', 'support.json')]);
  assert.deepEqual(packed.out, checkKb(raw, { pack: shippedPack('support') }));
  assert.equal((await cli(['kb-check', KB, '--channel', 'support', '--pack', path.join(ROOT, 'policy', 'support.json')])).code, 2);
});

test('AC-D2 policy-check: 출하 팩 문제 0, 하한을 낮춘 팩은 문제 +1, --channel이면 넓힘 목록', async () => {
  const shipped = await cli(['policy-check', path.join(ROOT, 'policy', 'support.json')]);
  assert.equal(shipped.code, 0);
  assert.deepEqual(shipped.out, { problems: [], widenings: [] });
  const low = JSON.parse(policy.shipped('support')); low.thresholds.confidenceMin = 0.5;
  const p = put('low.json', JSON.stringify(low));
  const r = await cli(['policy-check', p, '--channel', 'support']);
  assert.equal(r.code, 1);
  assert.equal(r.out.problems.length, shipped.out.problems.length + 1);
  assert.equal(r.out.problems[0].path, 'thresholds.confidenceMin');
  assert.ok(r.out.widenings.some((w) => w.path === 'thresholds.confidenceMin'));
  assert.equal((await cli(['policy-check', put('nojson.json', '{')])).code, 2);
  assert.equal((await cli(['policy-check', p, '--channel', 'nope'])).code, 2);
});

test('AC-D3 check-reply decision = policy.decide 직접 호출, 셸 env 무시, 금액 초안은 사람 쪽', async () => {
  const t = put('t.json', RECEIPT); const d = put('d.json', RECEIPT_DRAFT); const rv = put('r.json', { pass: true, reasons: [] });
  const saved = { AUTO_SEND: process.env.AUTO_SEND, SHADOW_CHANNELS: process.env.SHADOW_CHANNELS };
  process.env.AUTO_SEND = '1'; process.env.SHADOW_CHANNELS = 'support'; // 셸 값 — CLI는 무시해야 한다
  try {
    const argv = ['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', d, '--review', rv];
    const r = await cli(argv, RECEIPT_MSG);
    assert.equal(r.code, 0);
    assert.equal(r.out.stage, 'done');
    assert.equal(r.out.guard.pass, true);
    // 같은 입력으로 decide 직접 호출(옵션 기본값 = 자동 발송 끔, 섀도 끔)
    process.env.AUTO_SEND = '0'; delete process.env.SHADOW_CHANNELS;
    const tri = triageAgent.normalize(RECEIPT);
    const expected = policy.decide({ pack: shippedPack('support'), triage: tri, rounds: 0, repeatStreak: 0, guard: { pass: true }, senderTrusted: policy.senderTrusted('pass', 'cust@example.com') });
    assert.deepEqual(r.out.decision, expected);
    assert.equal(r.out.decision.action, 'DRAFT');
    assert.equal(r.out.decision.inputs.autoSend, false);
    assert.equal(r.out.level, 'L1');
    assert.deepEqual(r.out.env.autoSend, false);
    process.env.AUTO_SEND = '1'; process.env.SHADOW_CHANNELS = 'support';
    const on = await cli([...argv, '--auto-send', '1'], RECEIPT_MSG);
    assert.equal(on.out.decision.inputs.autoSend, true);
    assert.equal(on.out.level, 'L2');
    const sh = await cli([...argv, '--shadow', 'on'], RECEIPT_MSG);
    assert.equal(sh.out.decision.action, 'SHADOW');
    assert.equal(sh.out.env.shadow, true);
    assert.equal(sh.out.env.packShadow, false);
    // 팩이 섀도면 --shadow off여도 판단은 SHADOW — env.shadow는 실제로 쓴 값
    const sp = JSON.parse(policy.shipped('support')); sp.shadow = true;
    const ps = await cli(['check-reply', '--pack', put('shadow.json', JSON.stringify(sp)), '--kb', KB, '--triage', t, '--draft', d, '--review', rv, '--shadow', 'off'], RECEIPT_MSG);
    assert.equal(ps.out.decision.action, 'SHADOW');
    assert.equal(ps.out.env.shadow, true);
    assert.equal(ps.out.env.packShadow, true);
    assert.equal(process.env.AUTO_SEND, '1', 'env를 되돌린다');
    // 금액이 든 초안
    const money = put('money.json', { ...RECEIPT_DRAFT, body: '영수증 발급 수수료는 5,000원입니다.' });
    const m = await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', money], RECEIPT_MSG);
    assert.equal(m.code, 1);
    assert.equal(m.out.stage, 'guard');
    assert.ok(m.out.guard.hits.some((h) => h.code === 'amount'));
    assert.equal(m.out.decision.action, 'HANDOFF');
    assert.equal(m.out.level, 'H');
    assert.equal(typeof m.out.guard.rewrite, 'string');
    assert.equal((await cli([...argv, '--auto-send', 'yes'], RECEIPT_MSG)).code, 2);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('AC-D4 extract: md·html·docx → 청크·rules·schema, pdf → kind pdf, 지원 밖 → 2', async () => {
  const md = await cli(['extract', put('x.md', '# 가입\n가입은 설정에서 합니다.\n\n# 탈퇴\n탈퇴도 설정에서 합니다.')]);
  assert.equal(md.code, 0);
  assert.equal(md.out.kind, 'text');
  assert.deepEqual(md.out.chunks.map((c) => c.ref), ['가입']);
  assert.match(md.out.chunks[0].text, /탈퇴도 설정에서/);
  assert.equal(typeof md.out.rules, 'string');
  assert.deepEqual(md.out.schema.required, ['sections', 'omitted']);
  const html = await cli(['extract', put('x.html', '<h1>로그인</h1><p>비밀번호 재설정</p><script>x()</script>')]);
  assert.equal(html.code, 0);
  assert.match(html.out.chunks[0].text, /# 로그인\n비밀번호 재설정/);
  assert.doesNotMatch(html.out.chunks[0].text, /x\(\)/);
  const dx = await cli(['extract', put('x.docx', docx())]);
  assert.equal(dx.code, 0);
  assert.match(dx.out.chunks[0].text, /^# 환불 규정/);
  const pdf = await cli(['extract', put('x.pdf', '%PDF-1.4\n%%EOF')]);
  assert.equal(pdf.code, 0);
  assert.equal(pdf.out.kind, 'pdf');
  assert.equal('chunks' in pdf.out, false);
  const hwp = await cli(['extract', put('x.hwp', 'x')]);
  assert.equal(hwp.code, 2);
  assert.equal(hwp.out.error, 'unsupported_format');
  assert.equal((await cli(['extract', put('x.zzz', 'x')])).code, 2);
});

test('AC-D5 kb-normalize 출력은 kb-check 오류 0', async () => {
  const sections = { sections: [
    { key: 'Sign Up', title: '가입 방법', sourceRef: '1장', body: '가입은 [설정 > 계정]에서 합니다.', validUntil: '2027-12-31' },
    { key: 'logout', title: '로그아웃', sourceRef: '2장', body: '## 머리\n로그아웃은 오른쪽 위 메뉴에서 합니다.', validUntil: null },
  ], omitted: [{ sourceRef: '3장', reason: 'pricing' }] };
  const r = await cli(['kb-normalize', put('sec.json', sections), '--source', 'manual.docx']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.sections.map((s) => s.key), ['sign_up', 'logout']);
  assert.deepEqual(r.out.omitted, [{ sourceRef: '3장', reason: 'pricing' }]);
  const check = await cli(['kb-check', put('norm.md', r.out.markdown), '--channel', 'support']);
  assert.equal(check.code, 0);
  assert.deepEqual(check.out.errors, []);
  assert.equal((await cli(['kb-normalize', put('sec2.json', sections)])).code, 2, '--source 필수');
  const empty = await cli(['kb-normalize', put('sec3.json', { sections: [{ key: 'a_b', title: 't', sourceRef: 'r', body: '', validUntil: null }], omitted: [] }), '--source', 'm']);
  assert.equal(empty.code, 1);
});

test('AC-D7 render 밖 하위 명령은 LLM을 부르지 않고, render는 캡처만, mask는 전화·이메일을 가린다', async () => {
  const json0 = llm.json; let calls = 0; let realCalls = 0;
  llm.json = async (...a) => { calls += 1; return json0(...a); };
  try {
    llm.use({ name: 'mock', json: async () => { realCalls += 1; return {}; } });
    const t = put('t7.json', RECEIPT); const d = put('d7.json', RECEIPT_DRAFT);
    await cli(['extract', put('y.md', '# a\nb')]);
    await cli(['kb-normalize', put('y.json', { sections: [], omitted: [] }), '--source', 'y']);
    await cli(['kb-check', KB, '--channel', 'support']);
    await cli(['policy-check', path.join(ROOT, 'policy', 'support.json'), '--channel', 'support']);
    await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', d], RECEIPT_MSG);
    const m = await cli(['mask', put('pii.txt', '연락은 010-1234-5678 또는 hong.gil@example.com 으로 주세요.')]);
    assert.equal(calls, 0);
    assert.equal(m.code, 0);
    assert.doesNotMatch(m.out.text, /010-1234-5678|hong\.gil@example\.com/);
    assert.match(m.out.text, /\[CONTACT\].*\[CONTACT\]/);
    const ms = await cli(['mask'], msg({ body: '제 번호는 010-1234-5678입니다.' }));
    assert.equal(ms.code, 0);
    assert.equal(ms.out.text, '제 번호는 [CONTACT]입니다.');
    const r = await cli(['render', 'responder', '--channel', 'support', '--kb', KB, '--triage', t], RECEIPT_MSG);
    assert.equal(r.code, 0);
    assert.equal(calls, 1);
    assert.equal(realCalls, 0);
    assert.equal(llm.name(), 'engine-capture');
  } finally { llm.json = json0; llm.use('mock'); }
});

test('AC-D8 막힌 폴더·그 폴더를 가리키는 링크·폴더·여러 경로·글롭 → 2', async () => {
  for (const d of ['data', 'reference', 'eval-out', 'patent']) {
    const r = await cli(['mask', path.join(ROOT, '..', d, 'x.txt')]);
    assert.equal(r.code, 2, d);
    assert.equal(r.out.error, 'path_refused', d);
  }
  const link = path.join(work, 'to-blocked.txt');
  fs.symlinkSync(path.join(ROOT, '..', 'reference', 'x.txt'), link);
  assert.equal((await cli(['mask', link])).code, 2);
  const plain = put('plain.txt', '안녕');
  const link2 = path.join(work, 'plain-link.txt'); fs.symlinkSync(plain, link2);
  const l2 = await cli(['mask', link2]);
  assert.equal(l2.code, 2);
  assert.equal(l2.out.error, 'symlink_refused');
  assert.equal((await cli(['mask', work])).out.error, 'not_a_file');
  // 하드 링크(막힌 폴더 파일을 다른 이름으로 여는 길)는 거부한다 — 링크 수가 1이 아니면 거부
  const orig = put('hard-orig.txt', '비밀');
  const hard = path.join(work, 'hard-link.txt'); fs.linkSync(orig, hard);
  assert.deepEqual((await cli(['mask', hard])).out, { error: 'hardlink_refused' });
  assert.deepEqual((await cli(['mask', orig])).out, { error: 'hardlink_refused' }, '원본도 링크 수가 2');
  assert.equal((await cli(['mask', plain, plain])).code, 2);
  assert.equal((await cli(['mask', path.join(work, '*.txt')])).out.error, 'glob_not_allowed');
  assert.equal((await cli(['mask'])).code, 2, '파일도 문의 JSON도 없음');
  assert.equal((await cli(['kb-check', KB, '--pack', path.join(ROOT, '..', 'patent', 'p.json')])).code, 2, '옵션 경로도 같은 검사');
  assert.equal((await cli(['nope'])).code, 2);
});

test('AC-D9 render triage: system에 support intent 전부, schema = triage.SCHEMA, user에 KB 절 머리와 문의 본문', async () => {
  const r = await cli(['render', 'triage', '--channel', 'support', '--kb', KB], msg({ body: '영수증 PDF는 어디서 받나요? 제 번호는 010-9876-5432입니다.' }));
  assert.equal(r.code, 0);
  assert.equal(r.out.agent, 'triage');
  for (const k of Object.keys(shippedPack('support').intents)) assert.ok(r.out.system.includes(`- ${k}(`), k);
  assert.deepEqual(r.out.schema, triageAgent.SCHEMA);
  for (const k of ['account_deletion', 'receipt', 'cancel_subscription', 'login', 'features']) assert.ok(r.out.user.includes(`## kb:${k}`), k);
  assert.match(r.out.user, /<<<MESSAGE\n영수증 PDF는 어디서 받나요\?/);
  assert.doesNotMatch(r.out.user, /010-9876-5432/, '프롬프트에는 가린 본문만');
  assert.match(r.out.user, /THREAD\n\(첫 메시지\)/, '서버처럼 이 메시지는 스레드에서 뺀다');
  // 답장 Agent는 스레드에 이 메시지를 넣어 본다
  const resp = await cli(['render', 'responder', '--channel', 'support', '--kb', KB, '--triage', put('t9.json', RECEIPT)], RECEIPT_MSG);
  assert.match(resp.out.user, /\[고객\] 영수증은 어디서 받을 수 있나요\?/);
  assert.equal((await cli(['render', 'responder', '--channel', 'support', '--kb', KB], RECEIPT_MSG)).code, 2, '분류 JSON 필수');
  // 영어 문의: KB 파일 이름(.en.md)으로 KB 언어를 정한다 — 서버의 kb.load(channel, 'en')와 같은 안내
  const tEn = put('t9en.json', { ...RECEIPT, language: 'en' });
  const en = await cli(['render', 'responder', '--channel', 'support', '--kb', path.join(ROOT, 'kb', 'support.en.md'), '--triage', tEn], msg({ body: 'Where can I get my receipt?' }));
  assert.equal(en.code, 0);
  assert.match(en.out.user, /고객이 영어로 썼다 — 본문은 영어로 쓴다\. 사실은 지식 베이스에 있는 것만\(영어 KB\)/);
  const enKo = await cli(['render', 'responder', '--channel', 'support', '--kb', KB, '--triage', tEn], msg({ body: 'Where can I get my receipt?' }));
  assert.match(enKo.out.user, /한국어 KB를 뜻 그대로 옮긴다/);
  assert.equal((await cli(['render', 'triage', '--channel', 'support', '--kb', KB], msg({ text: 'x' }))).code, 2, '문의 JSON 모양');
});

test('AC-D10 1차 거르기에 걸리는 문의 → stage prefilter, 분류 입력 없이 끝', async () => {
  const auto = await cli(['check-reply', '--channel', 'support', '--kb', KB], msg({ body: '휴가 중입니다.', autoSubmitted: true }));
  assert.equal(auto.code, 0);
  assert.equal(auto.out.stage, 'prefilter');
  assert.deepEqual(auto.out.decision, { action: 'IGNORE', reason: 'auto_reply_or_empty' });
  assert.equal(auto.out.triage, null);
  const subj = await cli(['check-reply', '--channel', 'support', '--kb', KB], msg({ body: '다음 주에 돌아옵니다.', subject: '[부재중] 안내' }));
  assert.equal(subj.out.stage, 'prefilter');
  assert.equal(subj.out.decision.action, 'IGNORE');
  const spoof = await cli(['check-reply', '--channel', 'support', '--kb', KB], msg({ body: '영수증 부탁드립니다.', senderAuth: 'fail' }));
  assert.deepEqual(spoof.out.decision, { action: 'HANDOFF', reason: policy.normalizeReason(shippedPack('support'), 'sender_unverified') });
  assert.equal(spoof.out.level, 'H');
  // 통과하고 분류 JSON이 없으면 판단 없이 멈춘다(다음은 render triage)
  const pass = await cli(['check-reply', '--channel', 'support', '--kb', KB], RECEIPT_MSG);
  assert.deepEqual([pass.out.stage, pass.out.prefilter, pass.out.decision], ['prefilter', { pass: true }, null]);
});

test('AC-D11 KB 링크·KB 절 key 초안은 guard 통과, KB 밖 링크는 link_not_in_kb', async () => {
  const t = put('t11.json', { ...RECEIPT, intent: 'feature_howto', kbSections: ['features'] });
  const good = put('g11.json', { body: '화면별 사용법은 도움말 센터(https://help.example.com/guide)에 정리돼 있습니다.', usedFacts: ['kb:features'] });
  const r = await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', good], RECEIPT_MSG);
  assert.deepEqual(r.out.guard, { pass: true, hits: [] });
  assert.equal(r.out.stage, 'guard', '검수 JSON이 없으면 guard 뒤에서 멈춘다');
  assert.equal(r.out.decision, null);
  const badLink = put('b11.json', { body: '사용법은 https://evil.example.net/guide 에 있습니다.', usedFacts: ['features'] });
  const b = await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', badLink], RECEIPT_MSG);
  assert.equal(b.code, 1);
  assert.ok(b.out.guard.hits.some((h) => h.code === 'link_not_in_kb'));
  // 검수 실패도 판단 2차로 사람 쪽
  const rv = put('rv11.json', { pass: false, reasons: [{ code: 'tone', quote: 'x' }] });
  const f = await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', good, '--review', rv], RECEIPT_MSG);
  assert.equal(f.out.stage, 'review');
  assert.equal(f.out.decision.action, 'HANDOFF');
  // 사유가 빈 검수 실패는 서버처럼 통과
  const empty = put('rv11e.json', { pass: false, reasons: [] });
  const e = await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', good, '--review', empty], RECEIPT_MSG);
  assert.equal(e.code, 0);
  assert.equal(e.out.stage, 'done');
  assert.equal(e.out.decision.action, 'DRAFT');
  // 초안이 넘김을 원하면 compose에서 멈춘다
  const ho = put('ho11.json', { body: null, needsHandoff: true, handoffReason: 'human_request' });
  const h = await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', ho], RECEIPT_MSG);
  assert.deepEqual([h.out.stage, h.out.decision.action, h.out.decision.reason], ['compose', 'HANDOFF', 'human_request']);
});

test('AC-D13 render·check-reply는 파일 DB를 만들지 않는다', async () => {
  const dflt = path.join(ROOT, 'data', 'cs-agent.db');
  const before0 = fs.existsSync(dflt);
  const t = put('t13.json', RECEIPT); const d = put('d13.json', RECEIPT_DRAFT);
  await cli(['render', 'reviewer', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', d], RECEIPT_MSG);
  await cli(['check-reply', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', d], RECEIPT_MSG);
  assert.equal(fs.existsSync(process.env.DB_PATH), false);
  assert.deepEqual(fs.readdirSync(work).filter((f) => /\.db/.test(f)), []);
  assert.equal(fs.existsSync(dflt), before0);
});

test('AC-D14 같은 프로세스에서 render 여섯 번이 모두 성공한다', async () => {
  const t = put('t14.json', RECEIPT); const d = put('d14.json', RECEIPT_DRAFT);
  const v = put('v14.json', [{ code: 'amount', quote: '5,000원' }]);
  const runs = [
    ['render', 'triage', '--channel', 'support', '--kb', KB],
    ['render', 'responder', '--channel', 'support', '--kb', KB, '--triage', t],
    ['render', 'reviewer', '--channel', 'support', '--kb', KB, '--triage', t, '--draft', d],
    ['render', 'triage', '--channel', 'onboarding', '--kb', KB],
    ['render', 'responder', '--channel', 'support', '--kb', KB, '--triage', t, '--violations', v, '--previous', d],
    ['render', 'triage', '--channel', 'sales', '--kb', KB],
  ];
  for (const argv of runs) {
    const r = await cli(argv, RECEIPT_MSG);
    assert.equal(r.code, 0, `${argv[1]}: ${JSON.stringify(r.out)}`);
    assert.equal(r.out.agent, argv[1]);
  }
  const rew = await cli(runs[4], RECEIPT_MSG);
  assert.match(rew.out.user, /- amount: "5,000원"[\s\S]*<<<PREV\n영수증은/);
  const rev = await cli(runs[2], RECEIPT_MSG);
  assert.match(rev.out.user, /<<<BODY\n영수증은/);
  assert.match(rev.out.user, /## kb:receipt/);
});

// ---- dashboard-data: 루프백 서버(실제 서버 + 가짜 서버). 메모리 DB를 쓰므로 마지막에 둔다 ----
const until = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };

test('AC-D6 dashboard-data: 루프백 밖 → 2, mock 서버 → 집계(주소·이름·제목 없음), 실발송·production·머리글 인증 → 거부', async () => {
  assert.equal((await cli(['dashboard-data', '--url', 'http://10.0.0.5:3000'])).code, 2);
  assert.equal((await cli(['dashboard-data', '--url', 'https://127.0.0.1:3000'])).code, 2);
  assert.equal((await cli(['dashboard-data', '--url', 'http://example.com'])).out.error, 'not_loopback');
  // localhost는 이름 풀이에 따라 다른 곳일 수 있어 받지 않는다(루프백 IP 글자만)
  assert.equal((await cli(['dashboard-data', '--url', 'http://localhost:3000'])).out.error, 'not_loopback');
  db.init(':memory:'); llm.use('mock');
  const { createServer } = require('../server/index');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env0 = { MAIL_PROVIDER: process.env.MAIL_PROVIDER, NODE_ENV: process.env.NODE_ENV, AUTH_USER_HEADER: process.env.AUTH_USER_HEADER };
  try {
    const fake = { from: 'kim.fakeperson@example.com', name: '김가짜사람', subject: '가짜제목테스트' };
    const res = await fetch(`${base}/api/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'support', ...fake, body: '계정을 탈퇴하고 싶습니다.' }) });
    assert.equal(res.status, 200);
    await until(async () => (await (await fetch(`${base}/api/crm/cases`)).json()).items?.length);
    const r = await cli(['dashboard-data', '--url', base]);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.deepEqual(Object.keys(r.out), KEYS[1]['dashboard-data']);
    const s = JSON.stringify(r.out);
    for (const v of Object.values(fake)) assert.equal(s.includes(v), false, v);
    assert.doesNotMatch(s, /@/);
    assert.equal(r.out.cases.support.total, 1);
    assert.equal(r.out.truncated, false);
    assert.deepEqual(r.out.source, { status: '/api/status', workload: '/api/report/workload', promotion: '/api/stats', cases: '/api/crm/cases?limit=500' });
    assert.ok(r.out.promotion.some((p) => p.channel === 'support'));
    assert.equal(typeof r.out.workload.total, 'number');
    process.env.MAIL_PROVIDER = 'smtp';
    assert.deepEqual((await cli(['dashboard-data', '--url', base])).out, { error: 'refused', reason: 'mail_not_mock' });
    process.env.MAIL_PROVIDER = 'mock'; process.env.NODE_ENV = 'production';
    assert.deepEqual((await cli(['dashboard-data', '--url', base])).out, { error: 'refused', reason: 'production' });
    delete process.env.NODE_ENV; process.env.AUTH_USER_HEADER = 'x-user';
    const ah = await cli(['dashboard-data', '--url', base]);
    assert.equal(ah.code, 2);
    assert.equal(ah.out.reason, 'auth_header');
  } finally {
    for (const [k, v] of Object.entries(env0)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise((r) => server.close(r));
  }
});

test('AC-D6 dashboard-data: items 500이면 truncated, 값은 열거 값만 센다', async () => {
  const item = (i) => ({ id: `c${i}`, recordType: 'support', status: i % 2 ? 'Closed' : 'Working', subStatus: null, priority: 'Low', caseReason: '비밀 사유', origin: 'Email', isClosed: !!(i % 2), subject: '제목', suppliedEmail: 'a@example.com', audit: { createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() } });
  const body = {
    '/api/status': { ok: true, auth: 'none', provider: { llm: 'mock', mail: 'mock' } },
    '/api/report/workload': { total: 3, agent: 1, assisted: 1, human: 1, agentRate: 0.333, byDirection: { in: { total: 2 } }, byChannel: [{ channel: 'support', total: 3, secret: 'x' }] },
    '/api/stats': { promotion: { support: { reviewed: 5, approvedNoEditRate: 0.8, criticalCount: 0, eligible: false } } },
    '/api/crm/cases': { items: Array.from({ length: 500 }, (_, i) => item(i)) },
  };
  const srv = http.createServer((req, res) => { const b = body[req.url.split('?')[0]]; res.writeHead(b ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(b || {})); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await cli(['dashboard-data', '--url', `http://127.0.0.1:${srv.address().port}`]);
    assert.deepEqual(Object.keys(r.out), KEYS[1]['dashboard-data']);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.truncated, true);
    const c = r.out.cases.support;
    assert.equal(c.total, 500);
    assert.deepEqual(c.status, { Working: 250, Closed: 250 });
    assert.deepEqual(c.caseReason, { other: 500 });
    assert.deepEqual(c.subStatus, { none: 500 });
    assert.equal(c.openAge.d1to3, 250);
    assert.deepEqual(r.out.workload.byChannel, [{ channel: 'support', total: 3 }]);
    const s = JSON.stringify(r.out);
    assert.doesNotMatch(s, /비밀 사유|제목|@|"c1"/);
  } finally { await new Promise((r) => srv.close(r)); }
});

// 자유 문자열 칸을 채널 자리에 넣는 가짜 서버(이름·케이스 id·전화·도메인, __proto__)
async function fakeServer(body) {
  const srv = http.createServer((req, res) => { const b = body[req.url.split('?')[0]]; res.writeHead(b ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(b || {})); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}
const LEAKS = ['김가짜', 'case-7f3a9c', '010-5555-1234', 'leak.example.org'];

test('AC-D6 dashboard-data: 채널·promotion 키·recordType의 자유 문자열(채널 규칙 모양의 케이스 id 포함)은 other로 바꾼다', async () => {
  const srv = await fakeServer({
    '/api/status': { auth: 'none', provider: { mail: 'mock' } },
    '/api/report/workload': { total: 1, byChannel: LEAKS.map((channel) => ({ channel, total: 1 })) },
    '/api/stats': { promotion: Object.fromEntries([...LEAKS, 'support'].map((k) => [k, { reviewed: 1, approvedNoEditRate: 1, criticalCount: 0, eligible: false }])) },
    '/api/crm/cases': { items: [...LEAKS, 'support'].map((recordType) => ({ recordType, status: 'New', priority: 'Low', origin: 'Email', isClosed: true })) },
  });
  try {
    const r = await cli(['dashboard-data', '--url', `http://127.0.0.1:${srv.address().port}`]);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    const s = JSON.stringify(r.out);
    for (const v of LEAKS) assert.equal(s.includes(v), false, v);
    assert.deepEqual(r.out.workload.byChannel.map((c) => c.channel), ['other', 'other', 'other', 'other']);
    assert.deepEqual(r.out.promotion.map((p) => p.channel), ['other', 'other', 'other', 'other', 'support']);
    assert.deepEqual(Object.keys(r.out.cases), ['other', 'support']);
    assert.equal(r.out.cases.other.total, 4);
  } finally { await new Promise((r) => srv.close(r)); }
});

test('AC-D6 dashboard-data: recordType __proto__도 엔진을 죽이지 않고 칸으로만 센다', async () => {
  const srv = await fakeServer({
    '/api/status': { auth: 'none', provider: { mail: 'mock' } },
    '/api/report/workload': {},
    '/api/stats': {},
    '/api/crm/cases': { items: [{ recordType: '__proto__', status: 'New' }, { recordType: 'constructor', status: 'New' }, { recordType: 'support', status: '__proto__' }] },
  });
  try {
    const r = await cli(['dashboard-data', '--url', `http://127.0.0.1:${srv.address().port}`]);
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.deepEqual(Object.keys(r.out.cases), ['other', 'support']);
    assert.equal(r.out.cases.other.total, 2);
    assert.deepEqual(r.out.cases.support.status, { other: 1 });
    assert.equal(({}).total, undefined, '전역 프로토타입을 건드리지 않는다');
  } finally { await new Promise((r) => srv.close(r)); }
});
