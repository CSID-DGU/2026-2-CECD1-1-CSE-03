'use strict';
// 벡터 저장소 계약(memory · pgvector 같은 검사) + 색인 맞춤 생략 + pgvector 접속 오류 폴백.
// pgvector 몫은 PGVECTOR_URL이 있을 때만 돈다 — 임시 스키마를 만들고 끝나면 지운다. 없으면 건너뛴다(Postgres 없이 전부 통과).
process.env.MAIL_MOCK_LOG = '0';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const kbLoader = require('../server/kb');
const embed = require('../server/embed');
const vstore = require('../server/vector-store');
const kbIndex = require('../server/kb-index');
const { preflight } = require('../server/index');

const PG_URL = process.env.PGVECTOR_URL || '';
const ENV = ['KB_MODE', 'VECTOR_STORE', 'PGVECTOR_URL'];
const UNREACHABLE = 'postgresql://test@127.0.0.1:1/none';
before(() => { db.init(':memory:'); llm.use('mock'); });
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  embed.use(null); vstore.use(null); kbLoader.setReader(null);
});
after(() => { if (PG_URL) process.env.PGVECTOR_URL = PG_URL; });

const SECTIONS = [
  ['receipt', '영수증·세금계산서 발급', '영수증은 설정 > 결제 내역에서 내려받습니다.'],
  ['login', '로그인 문제 해결', '비밀번호 재설정 메일을 확인합니다.'],
  ['office_hours', '상담 시간', '평일 상담 시간 안내입니다.'],
];
const kbRaw = (secs = SECTIONS) => secs.map(([k, t, b]) => `## kb:${k}\n제목: ${t}\n\n${b}`).join('\n\n');
const publish = (raw) => kbLoader.setReader((kind, channel, lang) => (kind === 'kb' && channel === 'support' && lang === 'ko' ? { raw, hash: crypto.createHash('sha256').update(raw).digest('hex'), changeId: 'c1' } : null));
let n = 0;
async function ask(body) {
  n += 1;
  const r = cases.addInbound({ channel: 'support', from: 'vs@example.com', subject: '문의', body, threadId: `vs-${n}`, providerMessageId: `vs-pm-${n}` });
  await loop.runCycle(r.caseId, r.messageId);
  const rows = db.all('SELECT step, action, reason, output FROM decisions WHERE case_id=? ORDER BY rowid', r.caseId);
  return { step: (s) => rows.filter((x) => x.step === s).map((x) => ({ ...x, out: JSON.parse(x.output) })) };
}

/* ---------------- 저장소 계약 (memory · pgvector 같은 검사) ---------------- */

const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const item = (over) => ({ channel: 'support', language: 'ko', model: 'm1', key: 'k', hash: 'h', dim: 3, vector: norm([1, 0, 0]), ...over });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≈ ${b}`);
const scope = { channel: 'support', language: 'ko', model: 'm1' };

function contract(name, make) {
  test(`저장소 계약(${name}): upsert·get·hashes·prune·search 순서와 점수·채널·언어·모델·차원 분리`, async () => {
    const st = await make();
    try {
      assert.equal(await st.get({ ...scope, key: 'a' }), null);
      assert.deepEqual(await st.hashes(scope), {});
      await st.upsert([]); // 빈 묶음은 아무것도 하지 않는다

      // 한 번에 여러 개
      await st.upsert([
        item({ key: 'a', hash: 'ha', vector: norm([1, 0, 0]) }),
        item({ key: 'c', hash: 'hc', vector: norm([0.6, 0.8, 0]) }),
        item({ key: 'b', hash: 'hb', vector: norm([0.6, 0.8, 0]) }), // c와 같은 점수 — 키 순
        item({ key: 'd', hash: 'hd', vector: norm([0, 1, 0]) }),
        item({ key: 'a', channel: 'sales', hash: 'sa' }),
        item({ key: 'a', language: 'en', hash: 'ea' }),
        item({ key: 'a', model: 'm2', hash: 'ma' }),
        item({ key: 'z', dim: 2, hash: 'hz', vector: norm([1, 0]) }), // 같은 모델 이름, 다른 차원
      ]);
      const a = await st.get({ ...scope, key: 'a' });
      assert.deepEqual({ ...a, vector: undefined }, { channel: 'support', language: 'ko', model: 'm1', key: 'a', hash: 'ha', dim: 3, vector: undefined });
      assert.equal(a.vector.length, 3);
      near(a.vector[0], 1, 'get 벡터');
      assert.equal((await st.get({ ...scope, channel: 'sales', key: 'a' })).hash, 'sa');

      assert.deepEqual(await st.hashes(scope), { a: { hash: 'ha', dim: 3 }, b: { hash: 'hb', dim: 3 }, c: { hash: 'hc', dim: 3 }, d: { hash: 'hd', dim: 3 }, z: { hash: 'hz', dim: 2 } });
      assert.deepEqual(await st.hashes({ ...scope, model: 'm2' }), { a: { hash: 'ma', dim: 3 } });
      assert.deepEqual(await st.hashes({ ...scope, language: 'en' }), { a: { hash: 'ea', dim: 3 } });
      assert.deepEqual(await st.hashes({ ...scope, channel: 'onboarding' }), {});

      // 점수 = 내적(정규화 벡터라 코사인), 내림차순, 같으면 키 순, topK, 같은 차원만
      const hits = await st.search({ ...scope, dim: 3, vector: norm([1, 0, 0]), topK: 10 });
      assert.deepEqual(hits.map((h) => h.key), ['a', 'b', 'c', 'd']);
      assert.deepEqual(hits.map((h) => h.hash), ['ha', 'hb', 'hc', 'hd']);
      [1, 0.6, 0.6, 0].forEach((s, i) => near(hits[i].score, s, `점수 ${hits[i].key}`));
      assert.deepEqual((await st.search({ ...scope, dim: 3, vector: norm([1, 0, 0]), topK: 2 })).map((h) => h.key), ['a', 'b']);
      assert.deepEqual((await st.search({ ...scope, dim: 2, vector: norm([1, 0]), topK: 10 })).map((h) => h.key), ['z'], '다른 차원은 섞이지 않는다');
      assert.deepEqual((await st.search({ ...scope, model: 'm2', dim: 3, vector: norm([1, 0, 0]), topK: 10 })).map((h) => h.key), ['a']);
      assert.deepEqual(await st.search({ ...scope, channel: 'onboarding', dim: 3, vector: norm([1, 0, 0]), topK: 10 }), []);

      // 같은 자리면 바꾼다
      await st.upsert([item({ key: 'a', hash: 'ha2', vector: norm([0, 0, 1]) })]);
      assert.equal((await st.get({ ...scope, key: 'a' })).hash, 'ha2');
      assert.equal((await st.search({ ...scope, dim: 3, vector: norm([0, 0, 1]), topK: 1 }))[0].key, 'a');

      // prune은 그 채널·언어·모델 안에서만, keepKeys 밖을 지운다
      assert.equal(await st.prune({ ...scope, keepKeys: ['a', 'b'] }), 3);
      assert.deepEqual(Object.keys(await st.hashes(scope)).sort(), ['a', 'b']);
      assert.equal((await st.get({ ...scope, channel: 'sales', key: 'a' })).hash, 'sa', '다른 채널은 그대로');
      assert.equal((await st.get({ ...scope, model: 'm2', key: 'a' })).hash, 'ma', '다른 모델은 그대로');
      assert.equal(await st.prune({ ...scope, keepKeys: [] }), 2);
      assert.equal(await st.size(), 3);
    } finally {
      await st.drop?.();
      await st.close();
    }
  });
}

contract('memory', () => vstore.createMemoryStore());
const pgOpts = { skip: PG_URL ? false : 'PGVECTOR_URL 없음 — pgvector 계약은 건너뛴다' };
if (PG_URL) {
  contract('pgvector', () => require('../server/vector-store-pg').createPgStore({ url: PG_URL, schema: `test_kbv_${process.pid}_${crypto.randomBytes(3).toString('hex')}` }));
} else {
  test('저장소 계약(pgvector)', pgOpts, () => {});
}

test('pgvector 표·스키마 이름은 식별자 형식만', () => {
  const { createPgStore } = require('../server/vector-store-pg');
  for (const bad of [{ table: 'kb; DROP TABLE x' }, { schema: 'A"b' }, { table: '' }]) {
    assert.throws(() => createPgStore({ url: UNREACHABLE, ...bad }), (e) => e.code === 'store_config');
  }
});

/* ---------------- 색인 맞춤 생략 ---------------- */

// 저장소·임베더 호출을 센다
function counted() {
  const mem = vstore.createMemoryStore();
  const calls = { hashes: 0, upsert: 0, prune: 0, search: 0, get: 0 };
  const wrap = Object.fromEntries(Object.keys(calls).map((k) => [k, async (...a) => { calls[k] += 1; return mem[k](...a); }]));
  vstore.use({ ...mem, ...wrap, name: 'counted' });
  const seen = [];
  embed.use({ ...embed.PROVIDERS.mock, raw: (texts, type) => { seen.push({ type, n: texts.length }); return embed.PROVIDERS.mock.raw(texts); } });
  return { calls, docs: () => seen.filter((s) => s.type === 'document').length, queries: () => seen.filter((s) => s.type === 'query').length };
}

test('맞춤 생략: 같은 kbVersion이면 두 번째 retrieve는 일괄 조회·문서 임베딩을 부르지 않고(index 0ms·skipped), 콘솔 게시로 KB가 바뀌면 다시 맞춘다', async () => {
  const c = counted();
  publish(kbRaw());
  const kb1 = kbLoader.load('support', 'ko');
  const r1 = await kbIndex.retrieve({ channel: 'support', kb: kb1, query: '영수증 발급', topK: 5 });
  assert.deepEqual([c.calls.hashes, c.calls.get, c.docs(), c.queries()], [1, 0, 1, 1], '첫 회: 일괄 조회 한 번(절마다 get 없음)·문서 임베딩 한 번');
  assert.deepEqual([r1.index.skipped, r1.index.embedded], [false, 3]);

  const r2 = await kbIndex.retrieve({ channel: 'support', kb: kbLoader.load('support', 'ko'), query: '로그인', topK: 5 });
  assert.deepEqual([c.calls.hashes, c.calls.upsert, c.calls.prune, c.docs(), c.queries(), c.calls.search], [1, 1, 1, 1, 2, 2], '두 번째: 질문 임베딩·검색만');
  assert.deepEqual([r2.index.skipped, r2.ms.index, r2.index.embedded], [true, 0, 0]);
  assert.equal(r2.kbVersion, r1.kbVersion);
  assert.equal(typeof r2.ms.embed, 'number');
  assert.equal(typeof r2.ms.search, 'number');

  // 콘솔에 새 판 게시(절 하나 본문 바뀜) → kbVersion이 달라지고 다시 맞춘다(바뀐 절만 임베딩)
  publish(kbRaw([SECTIONS[0], SECTIONS[1], ['office_hours', '상담 시간', '평일 09~18시 상담합니다.']]));
  const kb3 = kbLoader.load('support', 'ko');
  assert.notEqual(kb3.version, kb1.version, '콘솔 게시가 kbVersion에 잡힌다');
  const r3 = await kbIndex.retrieve({ channel: 'support', kb: kb3, query: '상담 시간', topK: 5 });
  assert.deepEqual([c.calls.hashes, c.docs(), r3.index.skipped, r3.index.embedded, r3.index.kept], [2, 2, false, 1, 2]);

  // 절 삭제도 판이 바뀐다 → 맞춤이 지운다
  publish(kbRaw(SECTIONS.slice(0, 2)));
  const r4 = await kbIndex.retrieve({ channel: 'support', kb: kbLoader.load('support', 'ko'), query: '상담 시간', topK: 5 });
  assert.deepEqual([c.calls.hashes, r4.index.skipped, r4.index.removed, r4.index.embedded], [3, false, 1, 0]);
  assert.ok(r4.hits.every((h) => h.key !== 'office_hours'));

  // 저장소를 바꿔 끼우면(새 저장소) 다시 맞춘다
  const before_ = c.calls.hashes;
  const c2 = counted();
  await kbIndex.retrieve({ channel: 'support', kb: kbLoader.load('support', 'ko'), query: '영수증', topK: 5 });
  assert.deepEqual([c2.calls.hashes, c.calls.hashes], [1, before_]);
});

test('맞춤 생략: 미리 색인(warm) 뒤 회차는 맞추지 않는다 — 회차 retrieve 기록에 skipped·index 0', async () => {
  const c = counted();
  publish(kbRaw());
  process.env.KB_MODE = 'rag';
  const w = await kbIndex.warm(['support']);
  assert.ok(!w[0].error && w[0].embedded === 3);
  const a = await ask('영수증 발급 방법 알려주세요');
  const [ret] = a.step('retrieve');
  assert.equal(ret.action, 'RAG');
  assert.equal(ret.out.store, 'counted', '저장소 이름이 판단 기록에 남는다');
  assert.deepEqual([ret.out.index.skipped, ret.out.ms.index, c.calls.hashes, c.docs()], [true, 0, 1, 1]);
});

test('맞춤 생략: 검색이 비거나 실패하면 다음 회차는 다시 맞춘다(저장소가 밖에서 비워진 경우)', async () => {
  const c = counted();
  publish(kbRaw());
  const kb = kbLoader.load('support', 'ko');
  await kbIndex.retrieve({ channel: 'support', kb, query: '영수증', topK: 5 });
  await vstore.store().prune({ channel: 'support', language: 'ko', model: embed.info().model, keepKeys: [] }); // 밖에서 비움
  await assert.rejects(kbIndex.retrieve({ channel: 'support', kb, query: '영수증', topK: 5 }), (e) => e.code === 'no_hits');
  const r = await kbIndex.retrieve({ channel: 'support', kb, query: '영수증', topK: 5 });
  assert.deepEqual([r.index.skipped, r.index.embedded, c.calls.hashes], [false, 3, 2]);
});

/* ---------------- pgvector 설정·폴백 (Postgres 없이) ---------------- */

test('full(KB_MODE 없음)이면 VECTOR_STORE=pgvector여도 접속하지 않는다', async () => {
  process.env.VECTOR_STORE = 'pgvector';
  process.env.PGVECTOR_URL = UNREACHABLE;
  publish(kbRaw());
  const pgMod = require.resolve('../server/vector-store-pg');
  const loaded = !!require.cache[pgMod];
  const a = await ask('영수증 발급 방법 알려주세요');
  assert.equal(a.step('retrieve').length, 0);
  assert.equal(a.step('execute').length, 1);
  if (!loaded) assert.equal(require.cache[pgMod], undefined, 'pg 저장소 모듈을 읽지도 않는다');
});

test('pgvector 접속 실패 → 그 회차는 store_error로 full 폴백, 오류 메시지에 접속 주소가 없다', async () => {
  process.env.KB_MODE = 'rag';
  process.env.VECTOR_STORE = 'pgvector';
  process.env.PGVECTOR_URL = UNREACHABLE;
  publish(kbRaw());
  await assert.rejects(kbIndex.retrieve({ channel: 'support', kb: kbLoader.load('support', 'ko'), query: '영수증', topK: 5 }),
    (e) => e.code === 'store_error' && !e.message.includes('127.0.0.1') && !e.message.includes('postgres'));
  const a = await ask('영수증 발급 방법 알려주세요');
  const [ret] = a.step('retrieve');
  assert.deepEqual([ret.action, ret.reason, ret.out.requestedMode, ret.out.mode], ['FALLBACK', 'store_error', 'rag', 'full']);
  assert.equal(a.step('execute').length, 1, '회차는 끝난다');
  assert.doesNotMatch(JSON.stringify(ret.out), /127\.0\.0\.1|postgres/);
  const w = await kbIndex.warm(['support']);
  assert.deepEqual(w, [{ channel: 'support', error: 'store_error' }], '미리 색인도 사유만 남긴다');
});

test('기동 검사: rag+pgvector인데 PGVECTOR_URL 없음·형식 오류는 거부(값은 메시지에 없음), full+pgvector는 경고만', () => {
  assert.deepEqual(preflight({ KB_MODE: 'rag', VECTOR_STORE: 'pgvector', PGVECTOR_URL: 'postgresql://<사용자>:<비밀번호>@<호스트>:5432/<DB>' }).errors, []);
  assert.ok(preflight({ KB_MODE: 'rag', VECTOR_STORE: 'pgvector' }).errors.some((e) => e.includes('PGVECTOR_URL이 비어')));
  const bad = preflight({ KB_MODE: 'rag', VECTOR_STORE: 'pgvector', PGVECTOR_URL: 'mysql://secret-host/x' });
  assert.ok(bad.errors.some((e) => e.startsWith('PGVECTOR_URL 형식')));
  assert.ok(bad.errors.every((e) => !e.includes('secret-host')), '접속 주소를 메시지에 넣지 않는다');
  const full = preflight({ VECTOR_STORE: 'pgvector' });
  assert.deepEqual(full.errors, []);
  assert.ok(full.warnings.some((w) => w.includes('접속하지 않습니다')));
  assert.deepEqual(preflight({ KB_MODE: 'rag', VECTOR_STORE: 'memory' }).errors, []);
});
