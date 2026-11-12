'use strict';
// 접수 Agent RAG(KB_MODE=rag) — mock 임베더·메모리 저장소만 쓴다(네트워크 없음).
process.env.MAIL_MOCK_LOG = '0';
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const mock = require('../server/llm/mock');
const cases = require('../server/cases');
const loop = require('../server/loop');
const guard = require('../server/guard');
const kbLoader = require('../server/kb');
const embed = require('../server/embed');
const vstore = require('../server/vector-store');
const kbIndex = require('../server/kb-index');
const triage = require('../server/agents/triage');
const { sha } = require('../server/agents/common');
const { preflight } = require('../server/index');

const ENV = ['KB_MODE', 'KB_TOPK', 'KB_TRIAGE_TOC', 'EMBED_PROVIDER', 'VECTOR_STORE', 'RESPONDER_MODE'];
const origCheck = guard.check;
before(() => { db.init(':memory:'); llm.use('mock'); });
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  embed.use(null); vstore.use(null); kbLoader.setReader(null); llm.use('mock'); guard.check = origCheck;
});

// 콘솔에 게시된 support KB(절 7개) — 본문마다 표지 BODY-<key>
const SECTIONS = [
  ['account_deletion', '계정 탈퇴 절차', '설정 > 계정 > 탈퇴에서 진행합니다.'],
  ['receipt', '영수증·세금계산서 발급', '영수증은 설정 > 결제 내역에서 내려받습니다. 영수증 발급은 바로 됩니다.'],
  ['cancel_subscription', '구독 해지 경로', '설정 > 구독 관리에서 해지합니다.'],
  ['login', '로그인 문제 해결', '비밀번호 재설정 메일을 확인합니다.'],
  ['features', '기능 사용 안내', '대시보드에서 기능을 켭니다.'],
  ['office_hours', '상담 시간', '평일 상담 시간 안내입니다.'],
  ['mobile_app', '모바일 앱', '앱 스토어에서 설치합니다.'],
];
const kbRaw = (secs = SECTIONS) => secs.map(([k, t, b]) => `## kb:${k}\n제목: ${t}\n\n${b} BODY-${k}`).join('\n\n');
const publish = (raw) => kbLoader.setReader((kind, channel, lang) => (kind === 'kb' && channel === 'support' && lang === 'ko' ? { raw, hash: 'h', changeId: 'c1' } : null));
const spy = () => {
  const calls = [];
  llm.use({ name: 'spy', json: async (r) => { calls.push(r); return mock.json(r); }, chat: async (r) => { calls.push(r); return mock.chat(r); } });
  return calls;
};
let n = 0;
async function ask(body, { subject = '문의', from = 'rag@example.com' } = {}) {
  n += 1;
  const r = cases.addInbound({ channel: 'support', from, subject, body, threadId: `rag-${n}`, providerMessageId: `rag-pm-${n}` });
  await loop.runCycle(r.caseId, r.messageId);
  const rows = db.all('SELECT step, action, reason, output, kb_version, prompt_version FROM decisions WHERE case_id=? ORDER BY rowid', r.caseId);
  return { ...r, rows, step: (s) => rows.filter((x) => x.step === s).map((x) => ({ ...x, out: JSON.parse(x.output) })) };
}
const markers = (s) => [...String(s).matchAll(/BODY-([a-z_]+)/g)].map((m) => m[1]).sort();
// 질문 임베딩을 세는 mock 공급자(같은 벡터)
const counting = () => {
  const seen = [];
  embed.use({ ...embed.PROVIDERS.mock, raw: (texts, type) => { seen.push({ type, texts }); return embed.PROVIDERS.mock.raw(texts); } });
  return seen;
};

/* ---------------- full 유지 ---------------- */

test('KB_MODE 없음(full): 검색하지 않고(retrieve 행 없음·임베더를 부르지 않음) 접수 Agent가 KB 전체와 기존 프롬프트 버전을 받는다', async () => {
  publish(kbRaw());
  embed.use({ name: 'boom', model: 'x', dim: 4, raw: () => { throw new Error('부르면 안 된다'); } });
  const calls = spy();
  const a = await ask('영수증 발급 방법 알려주세요');
  assert.equal(a.step('retrieve').length, 0);
  const t = calls.find((c) => c.agent === 'triage');
  assert.deepEqual(markers(t.user), SECTIONS.map((s) => s[0]).sort(), '절 7개 본문 전부');
  assert.doesNotMatch(t.user, /\[목차/);
  assert.doesNotMatch(t.system, /본문이 실려 있다/, '시스템 프롬프트는 full 그대로');
  assert.equal(a.step('triage')[0].prompt_version, sha(triage.SOURCE), 'full 프롬프트 버전은 기존과 같다');
});

/* ---------------- 검색 ---------------- */

test('검색: 절이 topK 이하면 전부, 넘으면 점수 순 상위 topK만 — 점수는 내림차순', async () => {
  const kb3 = { channel: 'support', language: 'ko', version: 'v3', sections: kbLoader.parse(kbRaw(SECTIONS.slice(0, 3))) };
  const r3 = await kbIndex.retrieve({ channel: 'support', kb: kb3, query: '영수증 발급', topK: 5 });
  assert.equal(r3.hits.length, 3);
  assert.deepEqual(r3.kbKeys, SECTIONS.slice(0, 3).map((s) => s[0]));
  const kb7 = { channel: 'support', language: 'ko', version: 'v7', sections: kbLoader.parse(kbRaw()) };
  const r7 = await kbIndex.retrieve({ channel: 'support', kb: kb7, query: '영수증 발급 방법', topK: 5 });
  assert.equal(r7.hits.length, 5);
  assert.equal(r7.hits[0].key, 'receipt', '글이 가장 가까운 절이 맨 앞');
  for (let i = 1; i < r7.hits.length; i += 1) assert.ok(r7.hits[i - 1].score >= r7.hits[i].score);
  assert.equal((await kbIndex.retrieve({ channel: 'support', kb: kb7, query: '영수증', topK: 2 })).hits.length, 2);
  assert.deepEqual(Object.keys(r7.ms).sort(), ['embed', 'index', 'search']);
});

test('rag: 접수 Agent 프롬프트에는 검색된 절 본문만 + 목차(모든 절 키·제목), KB_TRIAGE_TOC=0이면 본문만, 프롬프트 버전은 rag 템플릿', async () => {
  publish(kbRaw());
  process.env.KB_MODE = 'rag';
  let calls = spy();
  const a = await ask('영수증 발급 방법 알려주세요');
  const [ret] = a.step('retrieve');
  assert.equal(ret.action, 'RAG');
  assert.equal(ret.out.requestedMode, 'rag');
  assert.equal(ret.out.mode, 'rag');
  assert.equal(ret.out.topK, 5);
  const picked = ret.out.hits.map((h) => h.key);
  assert.equal(picked.length, 5);
  let t = calls.find((c) => c.agent === 'triage');
  assert.deepEqual(markers(t.user), [...picked].sort(), '고른 5개 본문만 — 나머지 2개 본문은 없다');
  for (const [k, title] of SECTIONS) assert.ok(t.user.includes(`- ${k}: ${title}`), `목차에 ${k}`);
  assert.match(t.system, /본문이 실려 있다/);
  assert.match(t.system, /사실인지·답할 수 있는지와 무관/, '검색 순위를 사실·답변 가능성으로 설명하지 않는다');
  assert.equal(a.step('triage')[0].prompt_version, sha(triage.SOURCE_RAG));
  assert.notEqual(sha(triage.SOURCE_RAG), sha(triage.SOURCE));

  process.env.KB_TRIAGE_TOC = '0';
  calls = spy();
  const b = await ask('영수증 발급 방법 알려주세요');
  t = calls.find((c) => c.agent === 'triage');
  assert.doesNotMatch(t.user, /\[목차/);
  assert.equal(b.step('retrieve')[0].out.toc, false);
  for (const [k, title] of SECTIONS.filter(([k]) => !b.step('retrieve')[0].out.hits.some((h) => h.key === k))) {
    assert.ok(!t.user.includes(title) && !t.user.includes(`BODY-${k}`), `고르지 않은 ${k}는 제목도 본문도 없다`);
  }
});

test('rag: 답장 Agent·툴·guard·판단 기록에는 전체 KB가 그대로 간다', async () => {
  publish(kbRaw());
  process.env.KB_MODE = 'rag';
  const calls = spy();
  const guardKbs = [];
  guard.check = (args) => { guardKbs.push(args.kb); return origCheck(args); };
  const a = await ask('영수증 발급 방법 알려주세요');
  const full = kbLoader.load('support', 'ko');
  const resp = calls.filter((c) => c.agent === 'responder');
  assert.ok(resp.length >= 1, '답장 Agent까지 갔다');
  for (const c of resp) {
    assert.equal(Object.keys(c.ctx.kb.sections).length, 7, '답장 Agent(툴은 이 ctx.kb를 읽는다)는 절 7개');
    assert.equal(c.ctx.kb.mode, undefined, '검색 보기가 아니다');
  }
  assert.ok(guardKbs.length >= 1);
  for (const kb of guardKbs) assert.equal(Object.keys(kb.sections).length, 7);
  const tri = calls.find((c) => c.agent === 'triage');
  assert.equal(Object.keys(tri.ctx.kb.sections).length, 5, '접수 Agent만 고른 절');
  for (const r of a.rows.filter((x) => x.kb_version)) assert.equal(r.kb_version, full.version, `${r.step} kb_version은 전체 KB`);
  assert.equal(a.step('retrieve')[0].out.kbVersion, full.version);
});

test('rag: 임베더 입력은 가린 제목·본문이고, 질문 임베딩은 회차당 한 번(재작성이 있어도)', async () => {
  publish(kbRaw());
  process.env.KB_MODE = 'rag';
  const seen = counting();
  await ask('영수증 발급 부탁드려요. 연락은 kim.minsu@example.com 이나 010-1234-5678 로 주세요.', { subject: '영수증 요청 010-9876-5432' });
  const q = seen.filter((x) => x.type === 'query');
  assert.equal(q.length, 1);
  assert.equal(q[0].texts.length, 1);
  const text = q[0].texts[0];
  assert.match(text, /영수증/);
  for (const raw of ['kim.minsu@example.com', '010-1234-5678', '010-9876-5432']) assert.ok(!text.includes(raw), `${raw}는 가려져야 한다`);

  // 검사에 걸려 다시 쓰는 회차도 질문 임베딩은 한 번
  process.env.RESPONDER_MODE = 'single';
  llm.use({ name: 'rw', json: async (r) => (r.agent === 'responder' && !r.ctx.violations
    ? { body: '영수증은 설정에서 받으세요. 환불도 됩니다.', usedFacts: ['receipt'], humanCommitments: [], needsHandoff: false, handoffReason: null } : mock.json(r)) });
  const before = seen.filter((x) => x.type === 'query').length;
  const b = await ask('영수증 발급 방법 알려주세요');
  assert.ok(b.rows.some((x) => x.step === 'respond' && x.action === 'REWRITE'), '재작성이 있었다');
  assert.equal(seen.filter((x) => x.type === 'query').length - before, 1);
});

/* ---------------- 색인 ---------------- */

test('색인: 바뀐 절만 다시 임베딩, 지운·만료 절은 지우고 검색에서 빠지며, 모델이 다르면 색인이 따로다', async () => {
  const seen = counting();
  const kbOf = (raw) => ({ channel: 'support', language: 'ko', version: 'x', sections: kbLoader.parse(raw) });
  const docs = () => seen.filter((x) => x.type === 'document').flatMap((x) => x.texts);
  let s = await kbIndex.sync({ channel: 'support', kb: kbOf(kbRaw()) });
  assert.deepEqual([s.embedded, s.kept, s.removed], [7, 0, 0]);
  assert.ok(docs()[1].startsWith('영수증·세금계산서 발급\n'), '임베딩 입력 = 제목 + 본문');
  s = await kbIndex.sync({ channel: 'support', kb: kbOf(kbRaw()) });
  assert.deepEqual([s.embedded, s.kept, s.removed], [0, 7, 0], '그대로면 다시 임베딩하지 않는다');

  const changed = SECTIONS.map((x) => (x[0] === 'login' ? [x[0], x[1], '본문을 고쳤다.'] : x));
  seen.length = 0;
  s = await kbIndex.sync({ channel: 'support', kb: kbOf(kbRaw(changed)) });
  assert.deepEqual([s.embedded, s.kept], [1, 6]);
  assert.match(docs()[0], /본문을 고쳤다/);
  const retitled = changed.map((x) => (x[0] === 'features' ? [x[0], '새 제목', x[2]] : x));
  assert.equal((await kbIndex.sync({ channel: 'support', kb: kbOf(kbRaw(retitled)) })).embedded, 1, '제목만 바뀌어도 다시');

  // mobile_app 삭제, office_hours 만료
  const raw = kbRaw(retitled.filter((x) => x[0] !== 'mobile_app')).replace('제목: 상담 시간', '제목: 상담 시간\nvalidUntil: 2000-01-01');
  const kb = kbOf(raw);
  assert.ok(!kb.sections.office_hours, '만료 절은 load에서 빠진다');
  s = await kbIndex.sync({ channel: 'support', kb });
  assert.deepEqual([s.embedded, s.removed], [0, 2]);
  const r = await kbIndex.retrieve({ channel: 'support', kb, query: '모바일 앱 설치 상담 시간', topK: 10 });
  assert.deepEqual(r.hits.map((h) => h.key).sort(), Object.keys(kb.sections).sort());
  assert.ok(!r.hits.some((h) => ['mobile_app', 'office_hours'].includes(h.key)));

  // 다른 모델: 같은 절도 그 모델로 따로 색인한다. 앞 모델 항목은 남지만 검색에 섞이지 않는다
  const before = await vstore.store().size();
  embed.use({ name: 'other', model: 'other-v1', dim: 8, raw: (texts) => texts.map((t) => Array.from({ length: 8 }, (_, i) => (t.charCodeAt(i % t.length) % 7) + 1)) });
  s = await kbIndex.sync({ channel: 'support', kb });
  assert.deepEqual([s.model, s.dim, s.embedded], ['other-v1', 8, Object.keys(kb.sections).length]);
  assert.equal(await vstore.store().size(), before + Object.keys(kb.sections).length);
  const r2 = await kbIndex.retrieve({ channel: 'support', kb, query: '영수증', topK: 10 });
  assert.equal(r2.embed.model, 'other-v1');
  assert.equal(r2.hits.length, Object.keys(kb.sections).length, '한 모델의 절만');
});

test('검색 결과는 지금 KB 절과 해시로 다시 대조한다 — 지우지 못한 옛 항목·해시가 다른 항목은 버린다', async () => {
  const mem = vstore.createMemoryStore();
  // 지우지 않고, 검색 결과의 receipt 해시가 원문과 어긋나는 저장소(동기화가 끝난 뒤 색인이 틀어진 경우)
  vstore.use({ ...mem, name: 'leaky', prune: async () => 0,
    search: async (q) => (await mem.search(q)).map((h) => (h.key === 'receipt' ? { ...h, hash: 'stale' } : h)) });
  const kbOf = (raw) => ({ channel: 'support', language: 'ko', version: 'x', sections: kbLoader.parse(raw) });
  await kbIndex.sync({ channel: 'support', kb: kbOf(kbRaw()) });
  const kb = kbOf(kbRaw(SECTIONS.slice(0, 4)));
  const r = await kbIndex.retrieve({ channel: 'support', kb, query: '모바일 앱 상담 시간 영수증', topK: 10 });
  assert.equal(await mem.size(), 7, '지운 절 3개가 저장소에 남아 있다');
  assert.deepEqual(r.hits.map((h) => h.key).sort(), ['account_deletion', 'cancel_subscription', 'login'], '지금 KB에 있고 해시가 맞는 절만');
});

/* ---------------- 폴백 ---------------- */

test('폴백: 임베딩 오류·잘못된 벡터·빈 KB·설정 오류면 그 회차는 full로 돌고 요청·실제 모드와 사유가 남는다', async () => {
  process.env.KB_MODE = 'rag';
  const cases_ = [
    ['embed_error', () => embed.use({ name: 'down', model: 'd', dim: 4, raw: () => { throw new Error('503'); } })],
    ['embed_invalid', () => embed.use({ name: 'nan', model: 'n', dim: 2, raw: (t) => t.map(() => [NaN, 1]) })],
    ['embed_invalid', () => embed.use({ name: 'zero', model: 'z', dim: 2, raw: (t) => t.map(() => [0, 0]) })],
    ['embed_invalid', () => embed.use({ name: 'dim', model: 'w', dim: 3, raw: (t) => t.map(() => [1, 0]) })],
    ['embed_config', () => { process.env.EMBED_PROVIDER = 'bedrock'; }],
    ['store_config', () => { process.env.VECTOR_STORE = 'pgvector'; }],
    ['store_error', () => vstore.use({ name: 'down', get: async () => { throw new Error('db down'); } })],
  ];
  publish(kbRaw());
  for (const [reason, setup] of cases_) {
    embed.use(null); vstore.use(null); delete process.env.EMBED_PROVIDER; delete process.env.VECTOR_STORE;
    setup();
    const calls = spy();
    const a = await ask('영수증 발급 방법 알려주세요');
    const [ret] = a.step('retrieve');
    assert.equal(ret.action, 'FALLBACK', reason);
    assert.equal(ret.reason, reason);
    assert.deepEqual([ret.out.requestedMode, ret.out.mode, ret.out.fallbackReason], ['rag', 'full', reason]);
    assert.deepEqual(markers(calls.find((c) => c.agent === 'triage').user), SECTIONS.map((s) => s[0]).sort(), `${reason}: 접수 Agent가 KB 전체`);
    assert.ok(a.step('execute').length === 1, `${reason}: 회차는 끝난다`);
  }
  embed.use(null); vstore.use(null); delete process.env.EMBED_PROVIDER; delete process.env.VECTOR_STORE;
  publish('# 절 없는 KB\n');
  const e = await ask('영수증 발급 방법 알려주세요');
  assert.equal(e.step('retrieve')[0].reason, 'index_empty');
});

/* ---------------- 임베더·설정 ---------------- */

test('임베더: 같은 입력 → 같은 벡터, 길이 1, inputType 검사, 공급자 벡터 검사', async () => {
  const a = await embed.embed(['영수증 발급', '로그인'], { inputType: 'document' });
  const b = await embed.embed(['영수증 발급'], { inputType: 'query' });
  assert.deepEqual([a.model, a.dim, a.provider], ['mock-hash-2gram-v1', 256, 'mock']);
  assert.deepEqual(a.vectors[0], b.vectors[0]);
  for (const v of a.vectors) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  await assert.rejects(embed.embed(['x'], { inputType: 'search' }), { code: 'embed_input' });
  await assert.rejects(embed.embed([''], { inputType: 'query' }), { code: 'embed_invalid' }, '빈 입력은 영벡터');
  assert.throws(() => embed.normalize([[1, 2]], 2, 2), { code: 'embed_invalid' }, '개수');
  assert.throws(() => embed.normalize([[1, Infinity]], 1, 2), { code: 'embed_invalid' });
  assert.deepEqual(embed.normalize([[3, 4]], 1, 2), [[0.6, 0.8]]);
});

test('설정: 기본 full·topK 5·목차 포함, 잘못된 KB_MODE·KB_TOPK·KB_TRIAGE_TOC·EMBED_PROVIDER·VECTOR_STORE는 시작 거부', () => {
  assert.deepEqual(kbIndex.config({}), { mode: 'full', topK: 5, toc: true });
  assert.deepEqual(kbIndex.config({ KB_MODE: 'rag', KB_TOPK: '3', KB_TRIAGE_TOC: '0' }), { mode: 'rag', topK: 3, toc: false });
  assert.deepEqual(preflight({}).errors, []);
  assert.deepEqual(preflight({ KB_MODE: 'rag', KB_TOPK: '5', KB_TRIAGE_TOC: '1', EMBED_PROVIDER: 'mock', VECTOR_STORE: 'memory' }).errors, []);
  for (const [k, v] of [['KB_MODE', 'hybrid'], ['KB_TOPK', '0'], ['KB_TOPK', '51'], ['KB_TRIAGE_TOC', 'yes'], ['EMBED_PROVIDER', 'bedrock'], ['VECTOR_STORE', 'pgvector']]) {
    assert.ok(preflight({ [k]: v }).errors.some((e) => e.startsWith(`${k}=`)), `${k}=${v}`);
  }
});
