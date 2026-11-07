'use strict';
// server/aws.js — SigV4 서명(AWS 문서의 예제 값), IMDSv2 자격 증명(토큰 PUT → 역할 → 자격 증명, 캐시, 만료 전 갱신), 만료 오류 한 번 재시도.
// 네트워크는 globalThis.fetch 대체. AWS 를 부르지 않는다.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const aws = require('../server/aws');

const DOC = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION'];
const realFetch = globalThis.fetch;
let saved;
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); for (const k of ENV) delete process.env[k]; aws.forget(); });
afterEach(() => { globalThis.fetch = realFetch; for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

// 기대 값 출처: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html ("Example: GET Object")
test('S3 GET Object 문서 예제 — range 머리글, 빈 본문 해시, Authorization 이 문서 값과 같다', () => {
  const s = aws.sign({ url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' }, service: 's3', region: 'us-east-1', creds: DOC, now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(s.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(s.headers['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(s.headers['x-amz-date'], '20130524T000000Z');
  assert.equal(s.headers.host, undefined, 'host 는 fetch 가 넣는다');
});

// 기대 값 출처: 같은 페이지 "Example: PUT Object" — S3 경로는 한 번만 인코딩($ → %24)
test('S3 PUT Object 문서 예제 — 본문 해시, date·storage-class 서명, 경로 한 번 인코딩', () => {
  const body = 'Welcome to Amazon S3.';
  const s = aws.sign({
    method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', body, service: 's3', region: 'us-east-1', creds: DOC, now: new Date('2013-05-24T00:00:00Z'),
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': crypto.createHash('sha256').update(body).digest('hex') },
  });
  assert.match(s.headers.authorization, /,Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
  assert.match(s.headers.authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);
  assert.equal(s.url, 'https://examplebucket.s3.amazonaws.com/test%24file.text');
  assert.match(s.canonical, /^PUT\n\/test%24file\.text\n\n/);
});

// 기대 값 출처: https://docs.aws.amazon.com/amazonglacier/latest/dev/amazon-glacier-signing-requests.html ("Example Signature Calculation") — S3 밖 서비스
test('S3 밖 서비스 문서 예제(Glacier Create Vault) — x-amz-content-sha256 없이 서명, 문서 서명 값', () => {
  const s = aws.sign({ method: 'PUT', url: 'https://glacier.us-east-1.amazonaws.com/-/vaults/examplevault', headers: { 'x-amz-glacier-version': '2012-06-01' }, service: 'glacier', region: 'us-east-1', creds: DOC, now: new Date('2012-05-25T00:24:53Z') });
  assert.equal(s.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20120525/us-east-1/glacier/aws4_request,SignedHeaders=host;x-amz-date;x-amz-glacier-version,Signature=3ce5b2f2fffac9262b4da9256f8d086b4aaf42eba5f111c21681a65a127b7c2a');
  assert.equal(s.headers['x-amz-content-sha256'], undefined);
});

test('S3 밖 경로는 정규 요청에서 두 번(%253A), 실제 요청에서 한 번(%3A) 인코딩. 쿼리 문자열은 거부. 세션 토큰은 서명 헤더', () => {
  const s = aws.sign({ method: 'POST', url: 'https://x.ap-northeast-2.amazonaws.com/p/a:b/q', service: 'x', creds: { ...DOC, sessionToken: 'TOK' }, now: new Date('2026-11-08T00:00:00Z') });
  assert.equal(s.canonical.split('\n')[1], '/p/a%253Ab/q');
  assert.equal(s.url, 'https://x.ap-northeast-2.amazonaws.com/p/a%3Ab/q');
  assert.equal(s.headers['x-amz-security-token'], 'TOK');
  assert.match(s.headers.authorization, /\/20261108\/ap-northeast-2\/x\/aws4_request,SignedHeaders=host;x-amz-date;x-amz-security-token,/, '리전 기본값 ap-northeast-2');
  assert.throws(() => aws.sign({ url: 'https://x.amazonaws.com/?a=1', service: 'x', creds: DOC }), /쿼리/);
});

// ---------- 자격 증명 ----------
const iso = (ms) => new Date(Date.now() + ms).toISOString();
function imdsStub({ expiresIn = 3600e3, hang = false } = {}) {
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: { ...(init.headers || {}) } });
    if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    const p = new URL(url).pathname;
    if (p === '/latest/api/token') return new Response('TOKEN-1');
    if (init.headers?.['x-aws-ec2-metadata-token'] !== 'TOKEN-1') return new Response('', { status: 401 });
    if (p === '/latest/meta-data/iam/security-credentials/') return new Response('cs-role\n');
    if (p === '/latest/meta-data/iam/security-credentials/cs-role') {
      n += 1;
      return new Response(JSON.stringify({ Code: 'Success', AccessKeyId: `ASIA${n}`, SecretAccessKey: `sec${n}`, Token: `tok${n}`, Expiration: iso(expiresIn) }));
    }
    return new Response('', { status: 404 });
  };
  return calls;
}

test('환경 변수 자격 증명이 있으면 IMDS 를 부르지 않는다', async () => {
  const calls = imdsStub();
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK', AWS_SESSION_TOKEN: 'ST' });
  assert.deepEqual(await aws.credentials(), { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' });
  assert.equal(calls.length, 0);
});

test('IMDSv2 — 토큰 PUT(TTL 21600) 뒤 토큰 머리글로 역할 → 자격 증명. 캐시, 동시 두 호출에 한 벌', async () => {
  const calls = imdsStub();
  const [a, b] = await Promise.all([aws.credentials(), aws.credentials()]);
  assert.deepEqual(a, { accessKeyId: 'ASIA1', secretAccessKey: 'sec1', sessionToken: 'tok1' });
  assert.deepEqual(b, a);
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['PUT /latest/api/token', 'GET /latest/meta-data/iam/security-credentials/', 'GET /latest/meta-data/iam/security-credentials/cs-role']);
  assert.ok(calls.every((c) => c.url.startsWith('http://169.254.169.254/')));
  assert.equal(calls[0].headers['x-aws-ec2-metadata-token-ttl-seconds'], '21600');
  assert.equal(calls[1].headers['x-aws-ec2-metadata-token'], 'TOKEN-1');
  await aws.credentials();
  assert.equal(calls.length, 3, '만료가 멀면 캐시');
});

test('만료 5분 안이면 다시 받는다', async () => {
  const calls = imdsStub({ expiresIn: 4 * 60e3 });
  assert.equal((await aws.credentials()).accessKeyId, 'ASIA1');
  assert.equal((await aws.credentials()).accessKeyId, 'ASIA2');
  assert.equal(calls.length, 6);
});

test('IMDS 가 2초 안에 답하지 않으면 noRetry 오류', async () => {
  imdsStub({ hang: true });
  const keep = setTimeout(() => {}, 10000); // AbortSignal.timeout 타이머는 이벤트 루프를 붙잡지 않는다 — 대체 fetch 에는 소켓이 없으니 시험 동안 붙잡아 둔다
  const t0 = Date.now();
  await assert.rejects(aws.credentials(), (e) => e.noRetry === true && /자격 증명 없음\(imds 응답 없음\)/.test(e.message));
  clearTimeout(keep);
  assert.ok(Date.now() - t0 < 4000);
});

// ---------- request: 만료 오류 ----------
function awsStub(fail, always = false) {
  imdsStub();
  const sent = [];
  const imds = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('http://169.254.169.254/')) return imds(url, init);
    sent.push({ url: String(url), headers: init.headers });
    return sent.length === 1 || always ? fail() : new Response('{}');
  };
  return { sent };
}

test('만료 — S3 형태(400 <Code>ExpiredToken</Code>)와 SQS 형태(x-amzn-ErrorType) 모두 자격 증명을 다시 받고 한 번만 다시 보낸다', async () => {
  for (const fail of [
    () => new Response('<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>', { status: 400 }),
    () => new Response('{}', { status: 403, headers: { 'x-amzn-ErrorType': 'ExpiredTokenException:http://internal/' } }),
  ]) {
    aws.forget();
    const { sent } = awsStub(fail);
    const res = await aws.request({ service: 's3', url: 'https://b.s3.ap-northeast-2.amazonaws.com/inbound/k' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].headers['x-amz-security-token'], 'tok1');
    assert.equal(sent[1].headers['x-amz-security-token'], 'tok2', '새 자격 증명으로 다시 보냄');
  }
});

test('계속 만료면 한 번만 다시 보내고 던진다. 오류 메시지에 비밀 키·세션 토큰·Authorization 이 없다(오류 본문이 그 요청의 값을 되돌려 줘도)', async () => {
  const { sent } = awsStub(() => new Response('<Error><Code>ExpiredToken</Code><Echo>x-amz-security-token:tok2 sec2</Echo></Error>', { status: 400 }), true);
  await assert.rejects(aws.request({ service: 's3', url: 'https://b.s3.ap-northeast-2.amazonaws.com/inbound/k' }), (e) => {
    assert.equal(e.status, 400); assert.equal(e.code, 'ExpiredToken');
    assert.doesNotMatch(e.message, /tok2|sec2|AWS4-HMAC|Signature=/);
    return true;
  });
  assert.equal(sent.length, 2);
});

test('SQS JSON 오류 본문 __type 에서 오류 코드를 읽는다. 만료가 아니면 다시 보내지 않는다', async () => {
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK' });
  let n = 0;
  globalThis.fetch = async () => { n += 1; return new Response('{"__type":"com.amazonaws.sqs#QueueDoesNotExist","message":"x"}', { status: 400 }); };
  await assert.rejects(aws.request({ service: 'sqs', url: 'https://sqs.ap-northeast-2.amazonaws.com/', method: 'POST', body: '{}' }), (e) => e.code === 'QueueDoesNotExist' && /^sqs 400 QueueDoesNotExist/.test(e.message));
  assert.equal(n, 1);
});
