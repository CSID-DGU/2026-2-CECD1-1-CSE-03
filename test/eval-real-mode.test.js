'use strict';
// 실평가 스크립트의 안전장치 — 실행 조건(가드), 실제 provider의 오리진 잠금, 조립된 프롬프트 자기 점검, 이름 칸·단어 가림, 계량 기록.
// 데이터 없이: 합성 CSV를 임시 폴더에 만들고 provider는 mock(spy)만 쓴다. 실제 키·네트워크 없음.
process.env.MAIL_MOCK_LOG = '0';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../server/guard');
const mock = require('../server/llm/mock');
const llm = require('../server/llm');
const { guardEnv, lockDown, selfCheck, main } = require('../scripts/eval-real');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-real-mode-'));
const DATA = path.join(TMP, 'data');
const OUT = path.join(TMP, 'out');
const API = 'https://api.anthropic.com/v1/messages';
const argv = (...a) => ['node', 'eval-real.js', DATA, OUT, ...a];
const REAL_ENV = { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key' };
const REAL = ['--provider=anthropic', '--approved-by=데이터 소유자 서면 승인 2026-10-31'];
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('가드 — mock 기본 경로는 그대로: LLM_PROVIDER=mock만, 출력 폴더는 레포 밖', () => {
  assert.match(guardEnv({}, argv()).error, /LLM_PROVIDER=\(없음\)/);
  assert.match(guardEnv({ ANTHROPIC_API_KEY: 'k' }, argv()).error, /LLM_PROVIDER/); // 비우면 키가 있을 때 anthropic이 기본이 되므로 거부
  assert.match(guardEnv(REAL_ENV, argv()).error, /LLM_PROVIDER=anthropic/); // --provider 없이 실제 provider 거부
  const o = guardEnv({ LLM_PROVIDER: 'mock' }, argv());
  assert.equal(o.error, undefined);
  assert.deepEqual([o.provider, o.dataDir, o.outDir, o.approvedBy, o.nameCol], ['mock', DATA, OUT, null, null]);
  assert.match(guardEnv({ LLM_PROVIDER: 'mock' }, ['node', 'x', DATA, path.join(ROOT, 'eval-out')]).error, /출력 폴더가 레포 안/);
  assert.match(guardEnv({ LLM_PROVIDER: 'mock' }, argv('--provider=openai')).error, /mock \| anthropic/);
});

test('가드 — 실제 provider는 env·플래그·승인·키·기본 오리진이 모두 있을 때만, 단어 목록은 레포 밖만', () => {
  const ok = guardEnv(REAL_ENV, argv(...REAL));
  assert.equal(ok.error, undefined);
  assert.deepEqual([ok.provider, ok.approvedBy], ['anthropic', '데이터 소유자 서면 승인 2026-10-31']);
  assert.equal(guardEnv({ ...REAL_ENV, ANTHROPIC_BASE_URL: API }, argv(...REAL)).error, undefined); // 기본값과 같으면 통과
  const rejects = [
    [REAL_ENV, argv('--provider=anthropic'), /--approved-by/],
    [REAL_ENV, argv('--provider=anthropic', '--approved-by='), /--approved-by/],
    [REAL_ENV, argv('--provider=anthropic', '--approved-by'), /--approved-by/],
    [{ LLM_PROVIDER: 'anthropic' }, argv(...REAL), /ANTHROPIC_API_KEY/],
    [{ ...REAL_ENV, LLM_PROVIDER: 'mock' }, argv(...REAL), /둘이 같아야/],
    [{ ...REAL_ENV, LLM_PROVIDER: undefined }, argv(...REAL), /둘이 같아야/],
    [{ ...REAL_ENV, ANTHROPIC_BASE_URL: 'https://evil.example' }, argv(...REAL), /ANTHROPIC_BASE_URL/],
    [{ ...REAL_ENV, ANTHROPIC_BASE_URL: 'https://api.anthropic.com.evil.example/v1/messages' }, argv(...REAL), /ANTHROPIC_BASE_URL/],
    [REAL_ENV, argv(...REAL, `--mask-terms=${path.join(ROOT, 'kb', 'terms.txt')}`), /--mask-terms/],
    [REAL_ENV, argv(...REAL, '--mask-terms'), /--mask-terms/],
    [REAL_ENV, argv(...REAL, '--name-col'), /--name-col/],
  ];
  for (const [env, a, re] of rejects) assert.match(guardEnv(env, a).error ?? '(통과)', re, a.slice(4).join(' '));
  assert.equal(guardEnv(REAL_ENV, argv(...REAL, `--mask-terms=${path.join(TMP, 'terms.txt')}`, '--name-col=보낸이름')).error, undefined);
});

test('잠금 — 실제 provider면 fetch가 기본 Anthropic 오리진만 넘기고, mock이면 전부 막는다', async () => {
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return 'stub'; }; // 래퍼 대상 함수(네트워크 없음)
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: API });
  lockDown({ provider: 'anthropic' });
  for (const u of ['https://evil.example/v1/messages', 'http://api.anthropic.com/v1/messages', 'https://api.anthropic.com.evil.example/v1/messages', 'https://api.anthropic.com:8443/v1/messages']) {
    assert.throws(() => fetch(u, {}), /허용 안 된 오리진/, u);
  }
  assert.equal(await fetch(API, {}), 'stub');
  assert.deepEqual(seen, [API]);
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, 'test-key');
  assert.deepEqual([process.env.LLM_PROVIDER, process.env.MAIL_PROVIDER], ['anthropic', 'mock']);

  lockDown({ provider: 'mock' });
  assert.throws(() => fetch(API, {}), /네트워크 차단/);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(seen, [API]);
});

test('자기 점검 — 조립된 프롬프트를 본다: 마스킹을 끈 maskPii면 실패, 실제 구현이면 통과', async () => {
  assert.deepEqual(await selfCheck(), []);
  const real = guard.maskPii;
  guard.maskPii = (t) => t;
  try {
    const bad = await selfCheck();
    assert.ok(bad.length > 0);
    for (const a of ['triage', 'responder', 'reviewer', 'briefer']) assert.ok(bad.some((x) => x.startsWith(`${a}: `)), a);
    assert.ok(bad.includes('triage: 800101-1234567'));
    assert.ok(bad.includes('triage: 김가람'));
  } finally { guard.maskPii = real; }
  assert.deepEqual(await selfCheck(), []);
});

test('자기 점검 — 이름 뒤에 서명이 띄어쓰기 없이 붙은 경우(김가람드림)도 본다: 띄어 쓴 이름만 가리는 maskPii면 실패', async () => {
  const real = guard.maskPii;
  guard.maskPii = (t, o = {}) => { const s = real(t, { ...o, name: undefined }); return s != null && o.name ? s.replace(new RegExp(`${o.name}(?=\\s|$)`, 'g'), '[NAME]') : s; };
  try {
    assert.ok((await selfCheck()).includes('triage: 김가람'));
  } finally { guard.maskPii = real; }
});

const csv = (rows) => rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';

test('실행 — --name-col 이름과 --mask-terms 단어가 LLM 요청에 없고, 행별 계량·실행 머리가 남고, 본문은 출력에 없다', async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const q = ['일반', 'th-1', '2026-10-01T00:00:00Z', '2026-10-01T02:00:00Z'];
  fs.writeFileSync(path.join(DATA, 'reply_pairs.csv'), csv([
    ['쌍유형', 'threadId', '문의시각', '답장시각', '문의제목', '문의본문', '답장본문', '답장threadId', '테스트의심', '보낸이름'],
    [...q, '영수증 문의', '영수증 발급 방법 알려주세요.\n소속은 한빛상회입니다.\n\n박서연 드림', '안내드립니다.', 'th-1', 'N', '박서연'],
  ]));
  fs.writeFileSync(path.join(DATA, 'intent_labels.csv'), csv([
    ['행번호', '쌍유형', 'threadId', '문의시각', '답장시각', '문의유형', '우리대응', '자동화등급', '필요지식', 'CS범위여부'],
    [1, ...q, '플랫폼 이용 문의', '안내', 'draft_approve', '영수증', 'Y'],
  ]));
  fs.writeFileSync(path.join(DATA, 'eval_set.csv'), csv([['threadId', '문의시각'], ['th-1', q[2]]]));
  fs.writeFileSync(path.join(DATA, 'messages.csv'), csv([['방향', 'threadId', 'receivedAt'], ['수신', 'th-1', q[2]]]));
  const terms = path.join(TMP, 'terms.txt');
  fs.writeFileSync(terms, '한빛상회\n\n');

  // mock provider를 감싸 요청을 모으고 계량 값을 채운다(실제 provider가 meta에 채우는 자리)
  const calls = [];
  const orig = { json: mock.json, chat: mock.chat };
  const spy = (fn) => async (req) => { calls.push(req); Object.assign(req.meta || {}, { model: 'stub-model', inputTokens: 10, outputTokens: 5 }); return fn(req); };
  mock.json = spy(orig.json); mock.chat = spy(orig.chat); // 답장 Agent 툴 루프 걸음도 한 번씩 센다
  const log = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  process.env.LLM_PROVIDER = 'mock';
  try {
    await main(argv('--name-col=보낸이름', `--mask-terms=${terms}`));
  } finally { Object.assign(mock, orig); console.log = log; }

  const rowCalls = calls.filter((x) => x.ctx.case.customer_email === 'customer@example.invalid'); // 자기 점검 호출과 구분 — 평가 행만
  assert.ok(rowCalls.length >= 2, '평가 행이 LLM 입력까지 갔다');
  const tri = rowCalls.find((x) => x.agent === 'triage').user;
  assert.ok(tri.includes('[NAME] 드림') && tri.includes('소속은 [TERM]입니다'), tri);
  for (const x of calls) for (const v of ['박서연', '한빛상회']) assert.ok(!llm.promptText(x).includes(v), `${x.agent}: ${v}`);
  assert.match(lines[0], /이름 가림 칸 보낸이름 · 단어 가림 1개/);

  const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
  assert.deepEqual({ ...summary.run, startedAt: 0, finishedAt: 0 }, { provider: 'mock', models: ['stub-model'], approvedBy: null, nameMasking: 'column:보낸이름', maskTerms: 1, startedAt: 0, finishedAt: 0 });
  assert.ok(summary.run.startedAt <= summary.run.finishedAt);
  const [row] = fs.readFileSync(path.join(OUT, 'rows.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(row.llm.calls, rowCalls.length);
  assert.deepEqual([row.llm.inputTokens, row.llm.outputTokens], [10 * row.llm.calls, 5 * row.llm.calls]);
  assert.ok(Number.isInteger(row.llm.latencyMs));
  for (const f of fs.readdirSync(OUT)) {
    const t = fs.readFileSync(path.join(OUT, f), 'utf8');
    for (const v of ['박서연', '한빛상회', '영수증 발급 방법']) assert.ok(!t.includes(v), `${f}: ${v}`);
  }
});

test('실행 — 이름 칸 없이 돌면 시작 출력에 「본문 속 실명은 가리지 않는다」', async () => {
  const log = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  process.env.LLM_PROVIDER = 'mock';
  try { await main(argv()); } finally { console.log = log; }
  assert.match(lines[0], /이름 가림 꺼짐 — 본문 속 실명은 가리지 않는다/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8')).run.nameMasking, 'off');
});
