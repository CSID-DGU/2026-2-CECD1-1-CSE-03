'use strict';
// 임베딩 공급자 bedrock-cohere — 네트워크 없음. 전역 fetch를 바꿔 끼워 요청·서명·응답·오류를 본다(실제 Bedrock 호출 금지).
process.env.MAIL_MOCK_LOG = '0';
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// 모든 fetch는 이 손잡이로 간다 — 평가 실행기는 불러올 때 전역 fetch를 잡아 두므로 require보다 먼저 바꾼다
let handler = null;
const calls = [];
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = req.method === 'GET' ? '' : await req.text();
  calls.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body });
  if (!handler) throw new Error('네트워크 없음(시험)');
  return handler({ url: req.url, body, signal: req.signal });
};

const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const kbLoader = require('../server/kb');
const embed = require('../server/embed');
const vstore = require('../server/vector-store');
const bedrock = require('../server/embed-bedrock');
const { preflight } = require('../server/index');
const R = require('../scripts/sim/run');

const KEYS = { AWS_ACCESS_KEY_ID: 'AKIATESTKEYID0000001', AWS_SECRET_ACCESS_KEY: 'test/secret+KEY/value0000000000000000000', AWS_SESSION_TOKEN: 'TESTSESSIONTOKENvalue000000' };
const ENV = ['KB_MODE', 'EMBED_PROVIDER', 'BEDROCK_EMBED_MODEL', 'BEDROCK_EMBED_DIM', 'BEDROCK_REGION', 'EMBED_TIMEOUT_MS', 'AWS_REGION', ...Object.keys(KEYS)];
const SAVED = { ...process.env };
const setEnv = (o) => { for (const k of ENV) delete process.env[k]; Object.assign(process.env, o); };
const BASE = { ...KEYS, EMBED_PROVIDER: 'bedrock-cohere', BEDROCK_REGION: 'ap-southeast-2', AWS_REGION: 'us-east-1' };
const noSleep = { sleep: async () => {} };

before(() => { db.init(':memory:'); llm.use('mock'); });
afterEach(() => { handler = null; calls.length = 0; setEnv({}); embed.use(null); vstore.use(null); kbLoader.setReader(null); });

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
// 입력 순서대로 서로 다른 벡터(차원 dim)
const vec = (i, dim) => Array.from({ length: dim }, (_, j) => (j === i % dim ? 3 : 0) + 1);
const ok = (dim = 1536) => ({ body }) => { const { texts } = JSON.parse(body); return json(200, { id: 'x', response_type: 'embeddings_by_type', embeddings: { float: texts.map((_, i) => vec(i, dim)) } }); };
const leaks = (s) => [KEYS.AWS_ACCESS_KEY_ID, KEYS.AWS_SECRET_ACCESS_KEY, KEYS.AWS_SESSION_TOKEN, 'AWS4-HMAC', 'Signature=', 'x-amz-security-token'].filter((v) => String(s).includes(v));

/* ---------------- 요청 모양 ---------------- */

test('요청: bedrock-runtime 리전 URL(모델 ID 인코딩)·서명 서비스 bedrock·본문 필드·input_type 변환·output_dimension', async () => {
  setEnv({ ...BASE, BEDROCK_EMBED_DIM: '512' });
  handler = ok(512);
  assert.deepEqual(embed.info(), { provider: 'bedrock-cohere', model: 'global.cohere.embed-v4:0@512', dim: 512, region: 'ap-southeast-2', inference: 'global' });
  const d = await embed.embed(['계정 탈퇴', '영수증'], { inputType: 'document' });
  const q = await embed.embed(['영수증 어디서 받나요'], { inputType: 'query' });
  assert.equal(calls.length, 2);
  const [c1, c2] = calls;
  assert.equal(c1.method, 'POST');
  assert.equal(c1.url, 'https://bedrock-runtime.ap-southeast-2.amazonaws.com/model/global.cohere.embed-v4%3A0/invoke', 'BEDROCK_REGION이 AWS_REGION보다 앞, ":"는 %3A');
  assert.match(c1.headers.authorization, /Credential=[^/]+\/\d{8}\/ap-southeast-2\/bedrock\/aws4_request/, '서명 리전·서비스');
  assert.equal(c1.headers['x-amz-security-token'], KEYS.AWS_SESSION_TOKEN);
  assert.deepEqual(JSON.parse(c1.body), { texts: ['계정 탈퇴', '영수증'], input_type: 'search_document', embedding_types: ['float'], output_dimension: 512 });
  assert.equal(JSON.parse(c2.body).input_type, 'search_query');
  assert.deepEqual([d.provider, d.model, d.dim, d.vectors.length], ['bedrock-cohere', 'global.cohere.embed-v4:0@512', 512, 2]);
  for (const v of [...d.vectors, ...q.vectors]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9, '길이 1로 정규화');
  assert.ok(Number.isFinite(d.ms) && d.ms >= 0, '호출 시간 ms');
});

test('기본값: 모델 global.cohere.embed-v4:0, 1536차원, 리전은 AWS_REGION, 모델 ID가 다르면 다른 모델 식별자', () => {
  setEnv({ ...KEYS, EMBED_PROVIDER: 'bedrock-cohere', AWS_REGION: 'ap-southeast-2' });
  assert.deepEqual(embed.info(), { provider: 'bedrock-cohere', model: 'global.cohere.embed-v4:0@1536', dim: 1536, region: 'ap-southeast-2', inference: 'global' });
  setEnv({ ...BASE, BEDROCK_EMBED_MODEL: 'cohere.embed-v4:0' });
  assert.deepEqual([embed.info().model, embed.info().inference], ['cohere.embed-v4:0@1536', 'in-region']);
  setEnv({ ...BASE, BEDROCK_EMBED_DIM: '768' });
  assert.throws(() => embed.info(), { code: 'embed_config' });
});

test('응답: 개수·차원이 틀리거나 embeddings.float가 없으면 embed_invalid', async () => {
  setEnv(BASE);
  handler = () => json(200, { embeddings: { float: [vec(0, 1536)] } });
  await assert.rejects(embed.embed(['a', 'b'], { inputType: 'document' }), { code: 'embed_invalid' }, '개수');
  handler = ({ body }) => json(200, { embeddings: { float: JSON.parse(body).texts.map(() => vec(0, 1024)) } });
  await assert.rejects(embed.embed(['a'], { inputType: 'query' }), { code: 'embed_invalid' }, '차원');
  handler = () => json(200, { embeddings: [[1, 2]] });
  await assert.rejects(embed.embed(['a'], { inputType: 'query' }), { code: 'embed_invalid' }, 'float 없음');
  handler = () => new Response('not json', { status: 200 });
  await assert.rejects(embed.embed(['a'], { inputType: 'query' }), { code: 'embed_invalid' }, 'JSON 아님');
});

test('나눠 보내기: 한 요청에 문장 96개까지, 순서를 지켜 이어 붙인다', async () => {
  setEnv(BASE);
  const sizes = [];
  handler = ({ body }) => { const { texts } = JSON.parse(body); sizes.push(texts.length); return json(200, { embeddings: { float: texts.map((t) => vec(Number(t), 1536)) } }); };
  const texts = Array.from({ length: 200 }, (_, i) => String(i));
  const r = await embed.embed(texts, { inputType: 'document' });
  assert.equal(bedrock.MAX_TEXTS, 96);
  assert.deepEqual(sizes, [96, 96, 8]);
  assert.equal(r.vectors.length, 200);
  const top = (v) => v.indexOf(Math.max(...v));
  assert.deepEqual([top(r.vectors[0]), top(r.vectors[150]), top(r.vectors[199])], [0, 150, 199]);
});

/* ---------------- 오류 ---------------- */

test('오류 코드: 403 → embed_auth, 429 두 번 다시 보내도 → embed_throttled, 429 뒤 성공은 통과, 시간 초과 → embed_timeout, 500 → embed_error', async () => {
  setEnv(BASE);
  const make = () => bedrock.create(process.env, noSleep);
  handler = () => json(403, { message: `User: arn:aws:iam::123:user/dev is not authorized ${KEYS.AWS_SECRET_ACCESS_KEY}` }, { 'x-amzn-errortype': 'AccessDeniedException:http://internal' });
  await assert.rejects(make().raw(['a'], 'query'), (e) => e.code === 'embed_auth' && !leaks(e.message).length);
  calls.length = 0;
  handler = () => json(429, { message: 'Too many requests' }, { 'x-amzn-errortype': 'ThrottlingException' });
  await assert.rejects(make().raw(['a'], 'query'), { code: 'embed_throttled' });
  assert.equal(calls.length, 3, '처음 + 재시도 2회');
  calls.length = 0;
  let n = 0;
  handler = (r) => (n++ < 2 ? json(429, {}, { 'x-amzn-errortype': 'ThrottlingException' }) : ok()(r));
  assert.equal((await make().raw(['a'], 'query')).length, 1);
  assert.equal(calls.length, 3);
  calls.length = 0;
  process.env.EMBED_TIMEOUT_MS = '30';
  handler = ({ signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason)));
  await assert.rejects(make().raw(['a'], 'query'), { code: 'embed_timeout' });
  assert.equal(calls.length, 1, '시간 초과는 다시 보내지 않는다');
  handler = () => json(500, { message: 'internal' }, { 'x-amzn-errortype': 'InternalServerException' });
  await assert.rejects(make().raw(['a'], 'query'), { code: 'embed_error' });
  handler = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(make().raw(['a'], 'query'), { code: 'embed_error' });
});

test('자격 증명 없음(환경 변수 키 없고 IMDS 응답 없음) → embed_auth', async () => {
  setEnv({ EMBED_PROVIDER: 'bedrock-cohere', BEDROCK_REGION: 'ap-southeast-2' });
  require('../server/aws').forget();
  await assert.rejects(embed.embed(['a'], { inputType: 'query' }), { code: 'embed_auth' });
  assert.ok(calls.every((c) => c.url.startsWith('http://169.254.169.254/')), 'Bedrock은 부르지 않는다');
});

/* ---------------- rag 폴백 ---------------- */

let n = 0;
async function ask(body) {
  n += 1;
  const r = cases.addInbound({ channel: 'support', from: 'bedrock@example.com', subject: '문의', body, threadId: `br-${n}`, providerMessageId: `br-pm-${n}` });
  await loop.runCycle(r.caseId, r.messageId);
  return db.all("SELECT action, reason, output FROM decisions WHERE case_id=? AND step='retrieve'", r.caseId).map((x) => ({ ...x, out: JSON.parse(x.output) }));
}

test('rag 회차: Bedrock 403·시간 초과면 full로 폴백하고 retrieve 사유가 남으며, 성공이면 rag로 돌고 Bedrock 시간이 embed에 들어간다', async () => {
  const raw = '## kb:receipt\n제목: 영수증 발급\n\n영수증은 결제 내역에서 받습니다.\n\n## kb:login\n제목: 로그인\n\n비밀번호 재설정 메일을 확인합니다.';
  kbLoader.setReader((kind, channel, lang) => (kind === 'kb' && channel === 'support' && lang === 'ko' ? { raw, hash: 'h', changeId: 'c1' } : null));
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(' '));
  try {
    for (const [reason, h, extra] of [
      ['embed_auth', () => json(403, { message: 'denied' }, { 'x-amzn-errortype': 'AccessDeniedException' }), {}],
      ['embed_timeout', ({ signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason))), { EMBED_TIMEOUT_MS: '20' }],
    ]) {
      setEnv({ ...BASE, KB_MODE: 'rag', ...extra });
      vstore.use(null);
      handler = h;
      const [ret] = await ask('영수증 발급 방법 알려주세요');
      assert.equal(ret.action, 'FALLBACK', reason);
      assert.equal(ret.reason, reason);
      assert.deepEqual([ret.out.requestedMode, ret.out.mode, ret.out.fallbackReason], ['rag', 'full', reason]);
    }
    setEnv({ ...BASE, KB_MODE: 'rag' });
    vstore.use(null);
    handler = ok();
    const [ret] = await ask('영수증 발급 방법 알려주세요');
    assert.equal(ret.action, 'RAG');
    assert.deepEqual(ret.out.embed, { provider: 'bedrock-cohere', model: 'global.cohere.embed-v4:0@1536', dim: 1536, region: 'ap-southeast-2', inference: 'global' });
    assert.ok(Number.isFinite(ret.out.ms.embed));
  } finally { Object.assign(console, orig); }
  const stored = db.all('SELECT output, reason FROM decisions').map((r) => `${r.output} ${r.reason}`).join('\n');
  assert.deepEqual(leaks(stored), [], '판단 기록에 키·서명 없음');
  assert.deepEqual(leaks(logs.join('\n')), [], '로그에 키·서명 없음');
});

/* ---------------- 기동 검사 ---------------- */

test('기동 검사: bedrock-cohere 허용, BEDROCK_EMBED_DIM·BEDROCK_REGION·EMBED_TIMEOUT_MS 형식, 환경 변수 키 없으면 경고(거부 아님, 값 출력 없음)', () => {
  const base = { KB_MODE: 'rag', EMBED_PROVIDER: 'bedrock-cohere' };
  const a = preflight({ ...base, ...KEYS });
  assert.deepEqual(a.errors, []);
  assert.ok(!a.warnings.some((w) => /AWS_ACCESS_KEY_ID/.test(w)));
  const b = preflight(base);
  assert.deepEqual(b.errors, []);
  assert.ok(b.warnings.some((w) => /AWS_ACCESS_KEY_ID/.test(w) && /인스턴스 역할/.test(w)));
  for (const [k, v] of [['BEDROCK_EMBED_DIM', '768'], ['BEDROCK_EMBED_DIM', 'x'], ['BEDROCK_REGION', 'Sydney'], ['EMBED_TIMEOUT_MS', '0']]) {
    assert.ok(preflight({ ...base, ...KEYS, [k]: v }).errors.some((e) => e.startsWith(k)), `${k}=${v}`);
  }
  for (const d of ['256', '512', '1024', '1536']) assert.deepEqual(preflight({ ...base, ...KEYS, BEDROCK_EMBED_DIM: d }).errors, []);
  assert.deepEqual(leaks(JSON.stringify([a, b])), []);
  assert.ok(preflight({ EMBED_PROVIDER: 'bedrock' }).errors.some((e) => /EMBED_PROVIDER/.test(e)), '모르는 이름은 그대로 거부');
});

test('기본(mock): EMBED_PROVIDER 비우면 네트워크 없이 mock', async () => {
  setEnv({});
  const r = await embed.embed(['영수증'], { inputType: 'query' });
  assert.deepEqual([r.provider, r.model, r.dim], ['mock', 'mock-hash-2gram-v1', 256]);
  assert.equal(calls.length, 0);
});

/* ---------------- 평가 실행기 네트워크 ---------------- */

test('평가 실행기: rag + bedrock-cohere일 때만 설정 리전 bedrock-runtime 오리진을 허용하고, 그 밖은 거부한다', async () => {
  const origin = 'https://bedrock-runtime.ap-southeast-2.amazonaws.com';
  assert.deepEqual(R.embedOrigins({ KB_MODE: 'rag', EMBED_PROVIDER: 'bedrock-cohere', BEDROCK_REGION: 'ap-southeast-2' }), [origin]);
  assert.deepEqual(R.embedOrigins({ KB_MODE: 'rag', EMBED_PROVIDER: 'bedrock-cohere', AWS_REGION: 'ap-southeast-2' }), [origin], 'BEDROCK_REGION 비면 AWS_REGION');
  assert.deepEqual(R.embedOrigins({ KB_MODE: 'full', EMBED_PROVIDER: 'bedrock-cohere', BEDROCK_REGION: 'ap-southeast-2' }), []);
  assert.deepEqual(R.embedOrigins({ EMBED_PROVIDER: 'bedrock-cohere', BEDROCK_REGION: 'ap-southeast-2' }), []);
  assert.deepEqual(R.embedOrigins({ KB_MODE: 'rag', BEDROCK_REGION: 'ap-southeast-2' }), [], 'mock 임베딩');
  assert.deepEqual(R.embedOrigins({ KB_MODE: 'rag', EMBED_PROVIDER: 'bedrock-cohere', BEDROCK_EMBED_DIM: '7' }), [], '설정 오류');

  const dir = path.join(os.tmpdir(), `embed-bedrock-${process.pid}`);
  const wrapped = globalThis.fetch;
  try {
    // rag + bedrock + mock LLM: Bedrock 오리진만 더해진다
    setEnv({ ...BASE, KB_MODE: 'rag' });
    R.lockDown({ provider: 'mock', autoSend: false, runDir: dir });
    handler = ok();
    const r = await embed.embed(['a'], { inputType: 'query' });
    assert.equal(r.vectors.length, 1, 'bedrock-runtime 통과');
    await assert.rejects(fetch('https://bedrock-runtime.us-east-1.amazonaws.com/x'), /허용 안 된 네트워크/, '다른 리전');
    await assert.rejects(fetch('https://api.anthropic.com/v1/messages'), /허용 안 된 네트워크/, 'mock LLM이면 Anthropic은 닫힘');
    await assert.rejects(fetch('http://169.254.169.254/latest/api/token'), /허용 안 된 네트워크/, 'IMDS 닫힘');
    // full이면 Bedrock도 닫힌다
    setEnv({ ...BASE, KB_MODE: 'full' });
    R.lockDown({ provider: 'mock', autoSend: false, runDir: dir });
    await assert.rejects(fetch(`${origin}/model/x/invoke`, { method: 'POST' }), /허용 안 된 네트워크/);
  } finally {
    globalThis.fetch = wrapped;
    for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
    Object.assign(process.env, SAVED);
  }
});
