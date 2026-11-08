'use strict';
// 시나리오 세트 도구(scripts/sim/scenarios.js) — 검증·중복 제거·동결·해시 대조. 작은 픽스처만 쓴다.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('../scripts/sim/scenarios');
const policy = require('../server/policy');

const ROOT = path.join(__dirname, '..');
const PERSONAS_FILE = path.join(ROOT, 'eval', 'personas.v1.json');
const personas = JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8'));
const packs = { support: policy.load('support'), onboarding: policy.load('onboarding'), sales: policy.load('sales') };
const ctx = { packs, personas };
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-scenarios-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const BODY = '안녕하세요. 지난달 결제한 영수증이 필요합니다. 회사 경비 처리용이라 발급 방법을 알려주세요.';
function rec(n = 1, over = {}) {
  const family = over.family || `sup-receipt-${String.fromCharCode(96 + n)}`;
  return {
    id: `${family}-01`, family, bundle: 'A', split: 'test', channel: 'support', difficulty: 1, tags: [], persona: 'p01-formal-calm',
    customer: { name: '가상고객' },
    opening: { subject: '영수증 발급 문의', body: BODY, stepIds: ['s1'] },
    formFacts: null, hiddenGoal: '지난달 영수증을 받고 싶다.', facts: [{ key: '결제월', value: '지난달' }], unknown: [],
    steps: [{ id: 's1', ask: '영수증 발급 방법', expect: { intent: 'receipt', outcome: 'auto', reasons: null }, doneWhen: { mentions: ['결제 내역'] } }],
    end: { kind: 'resolved' }, grade: 'turns', maxTurns: 2, mock: {}, adversarial: null,
    source: { origin: 'handwritten', dataset: 'own', license: 'own', use: 'handwritten', ref: 'card' },
    ...over,
  };
}
const writeJsonl = (file, recs) => fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('validate: 정상 레코드는 빈 배열이고 필수 칸·팩 밖 값·형식 위반은 오류로 낸다', () => {
  assert.deepEqual(S.validate(rec(), ctx), []);
  const noGoal = rec(); delete noGoal.hiddenGoal;
  assert.ok(S.validate(noGoal, ctx).some((e) => e.includes('hiddenGoal')));
  const badIntent = rec(); badIntent.steps[0].expect.intent = 'no_such_intent';
  assert.ok(S.validate(badIntent, ctx).some((e) => e.includes('no_such_intent')));
  const badReason = rec(1, { steps: [{ id: 's1', ask: 'x', expect: { intent: 'refund', outcome: 'handoff', reasons: ['no_such_reason'] }, doneWhen: { handoff: true } }] });
  assert.ok(S.validate(badReason, ctx).some((e) => e.includes('no_such_reason')));
  const noReason = rec(1, { steps: [{ id: 's1', ask: 'x', expect: { intent: 'refund', outcome: 'handoff', reasons: null }, doneWhen: { handoff: true } }] });
  assert.ok(S.validate(noReason, ctx).length > 0);
  assert.ok(S.validate(rec(1, { id: 'sup-receipt-a-1' }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { family: 'support-receipt-a', id: 'support-receipt-a-01' }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { id: 'sup-refund-a-01' }), ctx).length > 0, 'id는 family로 시작해야 한다');
  assert.ok(S.validate(rec(1, { tags: ['unknown_tag'] }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { persona: 'p99-none' }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { inspiration: 'x' }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { bundle: 'E', maxTurns: 2 }), ctx).some((e) => e.includes('E 묶음')));
});

test('라이선스: NC 문자열·목록 밖 라이선스·허용 밖 use·AI Hub 계열 데이터셋을 거부한다', () => {
  const src = (o) => ({ origin: 'adapted', dataset: 'banking77', license: 'CC-BY-4.0', use: 'taxonomy-only', ref: 'label:x', ...o });
  assert.deepEqual(S.validate(rec(1, { source: src() }), ctx), []);
  assert.ok(S.validate(rec(1, { source: src({ license: 'CC-BY-NC-4.0' }) }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { source: src({ license: 'GPL-3.0' }) }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { source: src({ license: 'CDLA-Sharing-1.0', use: 'text-adapted' }) }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { source: src({ license: 'US-gov-public', use: 'text-adapted' }) }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { source: src({ dataset: 'AI Hub 상담' }) }), ctx).length > 0);
  assert.ok(S.validate(rec(1, { source: src({ dataset: 'aihub' }) }), ctx).length > 0);
  assert.ok(!Object.keys(S.LICENSES).some((k) => /NC/i.test(k)));
});

test('dedup: 0.8 이상은 뒤 것을 빼고 0.5~0.8 쌍은 검토로 올리며 intent가 다르면 남기고 시드와 겹친 test는 뺀다', () => {
  const mid = '안녕하세요. 지난달 결제한 영수증이 필요합니다. 회사 경비 처리용이라 세금 서류도 받고 싶습니다.';
  const a = rec(1);
  const b = rec(2, { opening: { subject: '영수증 발급 문의', body: BODY + ' 감사합니다.', stepIds: ['s1'] } });
  const c = rec(3, { opening: { subject: '영수증 발급 문의', body: mid, stepIds: ['s1'] } });
  const d = rec(4, { opening: { subject: '영수증 발급 문의', body: BODY + ' 감사합니다.', stepIds: ['s1'] }, steps: [{ ...a.steps[0], expect: { intent: 'cancel_subscription', outcome: 'auto', reasons: null } }] });
  assert.ok(S.similar(textOf(a), textOf(b)) >= 0.8);
  const mScore = S.similar(textOf(a), textOf(c));
  assert.ok(mScore >= 0.5 && mScore < 0.8, `중간 점수 픽스처: ${mScore}`);
  const out = S.dedup([a, b, c, d]);
  assert.deepEqual(out.kept.map((r) => r.id), [a.id, c.id, d.id]);
  assert.deepEqual(out.dropped.map((r) => r.id), [b.id]);
  assert.ok(out.review.some((p) => [p.a, p.b].includes(a.id) && [p.a, p.b].includes(c.id) && p.score >= 0.5 && p.score < 0.8));
  assert.ok(!out.review.some((p) => [p.a, p.b].includes(d.id)), 'intent가 다르면 비교하지 않는다');
  // 시드와 0.8 이상인 test는 뺀다. dev는 남는다.
  const seed = rec(5, { split: 'dev', source: { origin: 'seed', dataset: 'own', license: 'own', use: 'seed', ref: 'seed:2' } });
  const t = rec(6);
  const dv = rec(7, { split: 'dev' });
  const out2 = S.dedup([t, dv], { seeds: [seed] });
  assert.deepEqual(out2.dropped.map((r) => r.id), [t.id]);
  assert.deepEqual(out2.kept.map((r) => r.id), [dv.id]);
});
function textOf(r) { return `${r.opening.subject} ${r.opening.body}`; }

test('freeze와 load 왕복: 시나리오 파일을 한 글자 바꾸면 set_hash_mismatch이고 같은 버전을 다시 동결하면 version_exists다', () => {
  const dir = tmp();
  fs.copyFileSync(PERSONAS_FILE, path.join(dir, 'personas.v1.json'));
  const cand = path.join(dir, 'cand.jsonl');
  writeJsonl(cand, [rec(2), rec(1)]);
  const entry = S.freeze(cand, { version: 'v1', outDir: dir });
  assert.equal(entry.count, 2);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.match(entry.personasSha256, /^[0-9a-f]{64}$/);
  for (const c of ['support', 'onboarding', 'sales']) { assert.ok(entry.policySha256[c]); assert.ok(entry.kbSha256[c]); }
  const file = path.join(dir, 'scenarios.v1.jsonl');
  const manifest = path.join(dir, 'MANIFEST.json');
  const ok = S.load(file, { manifest, version: 'v1' });
  assert.deepEqual(ok.records.map((r) => r.id), ['sup-receipt-a-01', 'sup-receipt-b-01'], 'id 순');
  assert.equal(ok.sha256, entry.sha256);
  assert.throws(() => S.freeze(cand, { version: 'v1', outDir: dir }), /version_exists/);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('영수증', '영수정'));
  assert.throws(() => S.load(file, { manifest, version: 'v1' }), /set_hash_mismatch/);
});

test('freeze는 검사에 실패한 후보를 쓰지 않고 거부한다', () => {
  const dir = tmp();
  fs.copyFileSync(PERSONAS_FILE, path.join(dir, 'personas.v1.json'));
  const cand = path.join(dir, 'cand.jsonl');
  writeJsonl(cand, [rec(1, { persona: 'p99-none' })]);
  assert.throws(() => S.freeze(cand, { version: 'v1', outDir: dir }), /validation_failed/);
  assert.ok(!fs.existsSync(path.join(dir, 'scenarios.v1.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'MANIFEST.json')));
});

test('저장소 밖 실고객 데이터 폴더 아래 경로는 읽지 않고 거부한다', () => {
  const bad = path.join(__dirname, '..', '..', 'da' + 'ta', 'x.jsonl');
  assert.throws(() => S.load(bad, { manifest: { sets: {} }, version: 'v1' }), /path_refused/);
  assert.throws(() => S.freeze(bad, { version: 'v1', outDir: tmp() }), /path_refused/);
});

test('페르소나 파일: 12개, 필수 칸과 허용값, p09의 rules, p12의 scripted', () => {
  assert.equal(personas.length, 12);
  assert.equal(new Set(personas.map((p) => p.id)).size, 12);
  for (const p of personas) {
    for (const k of ['id', 'label', 'register', 'temperament', 'length', 'onUnanswered', 'patience', 'description']) assert.ok(p[k] !== undefined && p[k] !== '', `${p.id}.${k}`);
    assert.ok(['short', 'medium', 'long'].includes(p.length), p.id);
    assert.ok(['follow_up', 'escalate', 'silence'].includes(p.onUnanswered), p.id);
    assert.ok(Number.isInteger(p.patience) && p.patience >= 0 && p.patience <= 3, p.id);
    if (p.rules) assert.ok(Array.isArray(p.rules) && p.rules.every((r) => typeof r === 'string'));
  }
  const p09 = personas.find((p) => p.id === 'p09-stubborn-repeat');
  assert.ok(p09.rules.length >= 1);
  const p12 = personas.find((p) => p.id === 'p12-autoresponder');
  assert.ok(typeof p12.scripted.body === 'string' && typeof p12.scripted.autoSubmitted === 'boolean');
  assert.deepEqual(personas.map((p) => p.id).slice(0, 2), ['p01-formal-calm', 'p02-polite-busy']);
});

test('SOURCES.md: 저작자 표시와 공개 주소, LLMail-Inject 확인일, CFPB 필드 정의 주소, 범주만 원칙과 AI Hub 미사용, 로컬 경로 없음', () => {
  const md = fs.readFileSync(path.join(ROOT, 'eval', 'SOURCES.md'), 'utf8');
  assert.match(md, /MIT/);
  assert.match(md, /CC BY 4\.0/);
  assert.match(md, /CC BY 3\.0/);
  assert.match(md, /https:\/\/github\.com\/sierra-research\/tau-bench/);
  assert.match(md, /Casanueva/);
  assert.match(md, /Larson/);
  assert.ok(md.split('\n').some((l) => /LLMail-Inject/.test(l) && /\d{4}-\d{2}-\d{2}/.test(l)), 'LLMail-Inject 줄에 확인일');
  assert.match(md, /https:\/\/cfpb\.github\.io\/api\/ccdb\/fields\.html/);
  assert.doesNotMatch(md, /complaints\.csv/);
  assert.match(md, /범주만/);
  assert.match(md, /AI Hub 데이터는 쓰지 않는다/);
  assert.doesNotMatch(md, /\/Users\/|\/home\/|[A-Z]:\\/);
});

test('개인정보: example.com 주소는 허용하고 전화번호 같은 개인정보는 거부한다', () => {
  const withMail = rec(1); withMail.opening.body = BODY + ' 답장은 haneul.kim@example.com 으로 주세요.';
  assert.deepEqual(S.validate(withMail, ctx), []);
  const withPhone = rec(1); withPhone.opening.body = BODY + ' 연락처는 010-1234-5678 입니다.';
  assert.ok(S.validate(withPhone, ctx).some((e) => e.includes('개인정보')));
  const inFact = rec(1); inFact.facts[0].value = '900101-1234567';
  assert.ok(S.validate(inFact, ctx).some((e) => e.includes('개인정보')));
  // 모든 문자열 칸(고객 이름·모르는 것·단계 질문)과 폼 칸 이름도 본다
  const phone = '010-2345-6789';
  const inAsk = rec(1); inAsk.steps[0].ask = `연락처 ${phone}로 연락 주세요`;
  for (const [where, r] of [['customer.name', rec(1, { customer: { name: 'haneul.kim@corp.co.kr' } })], ['unknown', rec(1, { unknown: [phone] })],
    ['steps[].ask', inAsk], ['formFacts 칸 이름', rec(1, { formFacts: { [phone]: '연락처' } })],
    // 중첩 객체의 칸 이름과 숫자 값도 본다
    ['customer 칸 이름', rec(1, { customer: { name: '가상고객', [phone]: 'x' } })], ['customer 숫자 값', rec(1, { customer: { name: '가상고객', phone: 1012345678 } })]]) {
    assert.ok(S.validate(r, ctx).some((e) => e.includes('개인정보')), where);
  }
});

test('BANNED: 정규식 두 개마다 실행 때 만든 단어를 본문·facts·mock에서 거부하고 화면 코드 금지 테스트의 정규식과 같다', () => {
  assert.equal(S.BANNED.length, 2);
  const dash = fs.readFileSync(path.join(__dirname, 'dashboard-static.test.js'), 'utf8');
  for (const re of S.BANNED) {
    assert.ok(dash.includes(re.source), `dashboard-static 테스트에 같은 정규식: ${re.source.slice(0, 20)}`);
    const word = re.source.split('|')[0].replace(/\\/g, '').split('').map((ch, i) => (i % 2 ? ch.toLowerCase() : ch.toUpperCase())).join('');
    assert.ok(re.test(word), `픽스처 단어가 정규식에 맞는다: ${word}`);
    const inBody = rec(1); inBody.opening.body = `${BODY} ${word}`;
    const inFact = rec(1); inFact.facts[0].value = word;
    const inMock = rec(1, { mock: { s1: [`${word} 문의입니다.`] } });
    for (const r of [inBody, inFact, inMock]) assert.ok(S.validate(r, ctx).some((e) => e.includes('금지')), word);
  }
});

test('MANIFEST의 personasSha256: 페르소나 파일을 한 글자 바꾸면 load가 personas_hash_mismatch를 낸다', () => {
  const dir = tmp();
  const pf = path.join(dir, 'personas.v1.json');
  fs.copyFileSync(PERSONAS_FILE, pf);
  const cand = path.join(dir, 'cand.jsonl');
  writeJsonl(cand, [rec(1)]);
  S.freeze(cand, { version: 'v1', outDir: dir, personasFile: pf });
  const file = path.join(dir, 'scenarios.v1.jsonl');
  const manifest = path.join(dir, 'MANIFEST.json');
  assert.equal(S.load(file, { manifest, version: 'v1', personasFile: pf }).personas.length, 12);
  fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace('차분', '찬분'));
  assert.throws(() => S.load(file, { manifest, version: 'v1', personasFile: pf }), /personas_hash_mismatch/);
});

test('CLI: 버전 없이 부르면 사용법을 내고 종료 코드 2다', () => {
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'sim', 'scenarios.js'), 'check'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /사용법/);
});

// 경로 검사는 저장소 위치로 형제 폴더를 정한다 — 임시 폴더에 가짜 저장소·형제 폴더를 만들고 모듈 사본으로 본다(실제 형제 폴더는 건드리지 않는다)
// 임시 폴더가 저장소 상위를 품으면 임시 폴더 허용이 꺼지므로, 사본은 트리 안 tmp를 임시 폴더로 삼아 읽는다(모듈을 읽을 때 한 번 정한다)
function fakeTree() {
  const base = tmp();
  const repo = path.join(base, 'repo');
  const dataName = 'da' + 'ta';
  fs.mkdirSync(path.join(repo, 'scripts', 'sim'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'eval'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'sim', 'scenarios.js'), path.join(repo, 'scripts', 'sim', 'scenarios.js'));
  for (const d of [dataName, 'reference', 'patent', 'tmp', path.join('eval-out', 'sim'), path.join('eval-out', 'other')]) fs.mkdirSync(path.join(base, d), { recursive: true });
  fs.writeFileSync(path.join(base, dataName, 'x.jsonl'), '{}\n');
  // 임시 폴더는 별칭 경로와 실경로가 다를 수 있다(macOS /var ↔ /private/var). 둘 다 시험한다
  const forms = [...new Set([base, fs.realpathSync(base)])];
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = path.join(base, 'tmp');
  try {
    return { base, repo, dataName, forms, G: require(path.join(repo, 'scripts', 'sim', 'scenarios.js')) };
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
  }
}
const refusedPath = (e) => e.code === 'path_refused' && e.message === 'path_refused';

test('입력 경로 검사: 대소문자 변형·파일 링크·폴더 링크·임시 폴더 별칭·참고 자료·특허·평가 출력 형제 폴더는 거부하고 eval·임시 폴더·eval-out/sim은 허용한다', () => {
  const { base, repo, dataName, forms, G } = fakeTree();
  // 링크는 임시 폴더(트리 안 tmp) 안에 두어 링크 풀기만으로 거부되는지 본다. 대상도 임시 트리 안이다
  fs.symlinkSync(path.join(base, dataName, 'x.jsonl'), path.join(base, 'tmp', 'file-link.jsonl'));
  fs.symlinkSync(path.join(base, dataName), path.join(base, 'tmp', 'dir-link'), 'dir');
  fs.symlinkSync(path.join(base, 'tmp', 'nowhere'), path.join(base, 'tmp', 'dangling'));
  for (const b of forms) {
    for (const p of [path.join(b, dataName, 'x.jsonl'), path.join(b, dataName.toUpperCase(), 'x.jsonl'), path.join(b, dataName.toUpperCase(), 'new', 'y.jsonl'),
      path.join(b, 'tmp', 'file-link.jsonl'), path.join(b, 'tmp', 'dir-link', 'x.jsonl'), path.join(b, 'tmp', 'dir-link', 'missing', 'y.jsonl'), path.join(b, 'tmp', 'dangling'),
      path.join(b, 'reference', 'r.md'), path.join(b, 'patent', 'p.md'), path.join(b, 'eval-out', 'other', 'm.json'), path.join(b, 'eval-out', 'x.json')]) {
      assert.throws(() => G.checkInput(p), refusedPath, p);
      assert.throws(() => G.checkInput(p, { out: path.join(b, 'eval-out', 'other') }), refusedPath, `출력 폴더가 막힌 곳이어도 거부: ${p}`);
    }
    for (const p of [path.join(b, 'tmp', 'ok.jsonl'), path.join(b, 'eval-out', 'sim', 'run', 'meta.json'), path.join(repo, 'eval', 'scenarios.v1.jsonl')]) {
      assert.equal(G.realKey(G.checkInput(p)), G.realKey(p), p);
    }
  }
  // 허용 폴더 밖(임시 폴더도 아님)
  assert.throws(() => G.checkInput(path.join(path.parse(base).root, 'no-such-sim-root', 'x.jsonl')), refusedPath);
  // 별칭 두 경로는 같은 키다
  assert.equal(G.realKey(path.join(forms[0], 'A.jsonl')), G.realKey(path.join(forms.at(-1), 'a.jsonl')));
  assert.ok(G.isUnder(path.join(forms[0], dataName.toUpperCase(), 'z'), path.join(forms.at(-1), dataName)));
  // 읽기 함수도 같은 검사를 거친다
  assert.throws(() => G.load(path.join(base, 'tmp', 'dir-link', 'x.jsonl'), { manifest: { sets: {} }, version: 'v1' }), refusedPath);
});

test('출력 경로 검사: 저장소 안(링크·대소문자·별칭 포함)과 막힌 형제 폴더는 거부하고 eval-out/sim과 저장소 밖은 허용한다', () => {
  const { base, repo, dataName, forms, G } = fakeTree();
  fs.symlinkSync(repo, path.join(base, 'tmp', 'repo-link'), 'dir');
  for (const b of forms) {
    for (const p of [path.join(b, 'repo'), path.join(b, 'repo', 'out'), path.join(b, 'REPO', 'out'), path.join(b, 'tmp', 'repo-link', 'out'),
      path.join(b, dataName, 'out'), path.join(b, 'reference'), path.join(b, 'patent', 'o'), path.join(b, 'eval-out', 'other'), path.join(b, 'eval-out')]) {
      assert.throws(() => G.checkOut(p), refusedPath, p);
    }
    for (const p of [path.join(b, 'eval-out', 'sim'), path.join(b, 'eval-out', 'sim', 'new'), path.join(b, 'tmp', 'elsewhere')]) assert.equal(G.realKey(G.checkOut(p)), G.realKey(p), p);
  }
});

test('검사 출력: validate CLI와 freeze 오류는 레코드 id와 오류 코드만 내고 레코드 값·JSON 원문을 싣지 않는다', () => {
  const dir = tmp();
  const cand = path.join(dir, 'cand.jsonl');
  writeJsonl(cand, [rec(1, { channel: 'leak-channel-value', persona: 'p99-leak-persona' }), rec(2, { id: 'LEAK-ID 010-9999-8888', family: 'leak' })]);
  const cli = (...args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'sim', 'scenarios.js'), ...args],
    { encoding: 'utf8', env: { ...process.env, TMPDIR: os.tmpdir() } });
  const r = cli('validate', cand);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^sup-receipt-a-01: channel 값 오류$/m);
  assert.match(r.stderr, /^sup-receipt-a-01: 없는 페르소나$/m);
  assert.match(r.stderr, /^#2: id 형식 위반$/m);
  assert.doesNotMatch(r.stderr, /leak|LEAK|9999/);
  // 반환값(코드: 값)은 그대로다
  assert.ok(S.validate(rec(1, { channel: 'leak-channel-value' }), ctx).includes('channel 값 오류: leak-channel-value'));
  assert.equal(S.errorCode('channel 값 오류: leak-channel-value'), 'channel 값 오류');
  fs.copyFileSync(PERSONAS_FILE, path.join(dir, 'personas.v1.json'));
  assert.throws(() => S.freeze(cand, { version: 'v1', outDir: dir }), (e) => /^validation_failed/.test(e.message) && !/leak|LEAK|9999/.test(e.message));
  const junk = path.join(dir, 'junk.jsonl');
  fs.writeFileSync(junk, 'SECRETLINE 010-1234-5678 not json\n');
  const j = cli('validate', junk);
  assert.equal(j.status, 2);
  assert.match(j.stderr, /JSON 형식 오류/);
  assert.doesNotMatch(j.stderr, /SECRETLINE|5678/);
});

test('한글 검사: english 태그가 없는 시나리오는 첫 메일 본문에 한글이 있어야 하고(no_hangul), english 태그면 영어 본문을 받는다', () => {
  const op = { subject: 'Receipt', body: 'Please send me last month receipt.', stepIds: ['s1'] };
  assert.ok(S.validate(rec(1, { opening: op }), ctx).includes('no_hangul'));
  assert.ok(!S.validate(rec(1, { opening: op, tags: ['english'] }), ctx).includes('no_hangul'));
  assert.deepEqual(S.validate(rec(1), ctx), []);
});

test('출력 폴더는 허용 폴더를 넓히지 않는다: 형제가 아닌 곳의 데이터 폴더를 --out으로 주어도 출력·그 아래 입력 모두 거부한다', () => {
  // 사본의 임시 폴더는 트리 안 tmp다 — 저장소 형제도 임시 폴더도 아닌 데이터 폴더를 만든다
  const { base, G } = fakeTree();
  const secretDir = path.join(base, 'secret-store');
  fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(secretDir, 'secret.jsonl'), '{}\n');
  assert.throws(() => G.checkOut(secretDir), refusedPath);
  assert.throws(() => G.checkInput(path.join(secretDir, 'secret.jsonl'), { out: secretDir }), refusedPath);
  assert.equal(G.realKey(G.checkOut(path.join(base, 'tmp', 'run'))), G.realKey(path.join(base, 'tmp', 'run')));
  assert.equal(G.realKey(G.checkOut(path.join(base, 'eval-out', 'sim', 'run'))), G.realKey(path.join(base, 'eval-out', 'sim', 'run')));
});

test('허용 뿌리 링크: eval-out/sim이 링크면 임시 폴더·eval·sim 아래까지 입력과 출력을 모두 거부한다', () => {
  const { base, repo, G } = fakeTree();
  const sim = path.join(base, 'eval-out', 'sim');
  const elsewhere = path.join(base, 'tmp', 'elsewhere');
  assert.equal(G.realKey(G.checkOut(elsewhere)), G.realKey(elsewhere), '링크 전에는 허용');
  // 링크 대상도 임시 트리 안이다
  fs.rmSync(sim, { recursive: true });
  fs.mkdirSync(path.join(base, 'moved-sim'));
  fs.symlinkSync(path.join(base, 'moved-sim'), sim, 'dir');
  for (const p of [path.join(base, 'tmp', 'ok.jsonl'), path.join(repo, 'eval', 'scenarios.v1.jsonl'), path.join(sim, 'run', 'meta.json')]) assert.throws(() => G.checkInput(p), refusedPath, p);
  for (const p of [elsewhere, path.join(sim, 'new')]) assert.throws(() => G.checkOut(p), refusedPath, p);
});

test('임시 폴더 범위: TMPDIR이 루트·홈·저장소 상위 폴더면 임시 폴더 허용을 끄고, 보통 임시 폴더면 허용한다', () => {
  const probe = (tmpdir, p) => {
    const code = `const S = require(${JSON.stringify(path.join(ROOT, 'scripts', 'sim', 'scenarios.js'))});
try { S.checkOut(process.argv[1]); console.log('allowed'); } catch (e) { console.log(e.code); }`;
    const r = spawnSync(process.execPath, ['-e', code, p], { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: tmpdir } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const inTmp = path.join(tmp(), 'run');
  const parent = path.join(ROOT, '..');
  assert.equal(probe(os.tmpdir(), inTmp), 'allowed');
  assert.equal(probe(path.parse(ROOT).root, inTmp), 'path_refused');
  assert.equal(probe(os.homedir(), path.join(os.homedir(), 'no-such-sim-probe')), 'path_refused');
  assert.equal(probe(parent, path.join(parent, 'no-such-sim-probe')), 'path_refused');
});

test('입력 파일 읽기: 하드 링크(링크 수 2)는 검사를 통과한 경로여도 읽지 않고 거부하고, 보통 파일은 읽는다', () => {
  const d = tmp();
  const f = path.join(d, 'a.jsonl');
  fs.writeFileSync(f, '{}\n');
  assert.equal(S.readChecked(f).toString('utf8'), '{}\n');
  fs.linkSync(f, path.join(d, 'b.jsonl'));
  for (const p of [f, path.join(d, 'b.jsonl')]) assert.throws(() => S.readChecked(p), refusedPath, p);
  // 세트 읽기도 같은 함수를 거친다
  assert.throws(() => S.load(f, { manifest: { sets: { v1: {} } }, version: 'v1' }), refusedPath);
  // FIFO는 쓰는 쪽이 없어도 열 때 멈추지 않고 거부한다(멈추면 자식 프로세스가 시간 초과로 죽는다)
  const fifo = path.join(d, 'pipe.jsonl');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const code = `const S = require(${JSON.stringify(path.join(ROOT, 'scripts', 'sim', 'scenarios.js'))});
try { S.readChecked(process.argv[1]); console.log('read'); } catch (e) { console.log(e.code); }`;
  const r = spawnSync(process.execPath, ['-e', code, fifo], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: os.tmpdir() } });
  assert.equal(r.stdout.trim(), 'path_refused', r.stderr || `signal ${r.signal}`);
});
