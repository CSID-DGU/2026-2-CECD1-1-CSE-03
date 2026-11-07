'use strict';
// AWS 요청 서명(SigV4)과 자격 증명. 의존성 0(node:crypto + fetch).
// 자격 증명: AWS_ACCESS_KEY_ID·AWS_SECRET_ACCESS_KEY(로컬 시험용)가 있으면 그것, 없으면 EC2 IMDSv2(토큰 PUT → 역할 이름 → 임시 자격 증명).
// 오류 메시지에 Authorization·비밀 키·세션 토큰을 넣지 않는다.
const crypto = require('node:crypto');

const IMDS = 'http://169.254.169.254';
const IMDS_TIMEOUT_MS = 2000;
const REFRESH_MS = 5 * 60 * 1000; // 만료 5분 전이면 새로 받는다

const region = (env = process.env) => env.AWS_REGION || 'ap-northeast-2';
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();
// SigV4 UriEncode — 남기는 글자는 A-Z a-z 0-9 - _ . ~ 뿐(encodeURIComponent 는 ! ' ( ) * 도 남긴다)
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * SigV4 서명. 서명하는 헤더 = host + x-amz-date + 넘긴 헤더 전부 + 세션 토큰(있을 때). s3 는 x-amz-content-sha256 을 붙인다.
 * 경로: 실제 요청은 조각마다 한 번 인코딩, 정규 요청은 S3 밖 서비스만 한 번 더. 쿼리 문자열은 쓰지 않는다(오면 던진다).
 * 반환 { url, headers }(host 는 fetch 가 넣는다). canonical 은 시험용.
 */
function sign({ method = 'GET', url, headers = {}, body = '', service, region: r = region(), creds, now = new Date() }) {
  const u = new URL(url);
  if (u.search) throw new Error('aws sign: 쿼리 문자열은 지원하지 않는다');
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const h = { host: u.host, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  if (service === 's3' && !h['x-amz-content-sha256']) h['x-amz-content-sha256'] = sha(body);
  if (creds.sessionToken) h['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(h).sort();
  const once = u.pathname.split('/').map((s) => enc(decodeURIComponent(s)));
  const canonical = [
    method,
    (service === 's3' ? once : once.map(enc)).join('/') || '/',
    '',
    names.map((k) => `${k}:${h[k]}\n`).join(''),
    names.join(';'),
    h['x-amz-content-sha256'] || sha(body),
  ].join('\n');
  const scope = `${day}/${r}/${service}/aws4_request`;
  const key = [r, service, 'aws4_request'].reduce(hmac, hmac(`AWS4${creds.secretAccessKey}`, day));
  const signature = hmac(key, ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n')).toString('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}`;
  delete h.host;
  return { url: `${u.origin}${once.join('/') || '/'}`, headers: h, canonical };
}

// ---------- 자격 증명 ----------
let cache = null; // { creds, expires }
let inflight = null; // 동시 호출은 진행 중인 IMDS 조회 하나를 같이 기다린다

const forget = () => { cache = null; };

async function imds() {
  const get = async (p, init = {}) => {
    const res = await fetch(`${IMDS}${p}`, { ...init, signal: AbortSignal.timeout(IMDS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`imds ${res.status}`);
    return res.text();
  };
  try {
    const token = await get('/latest/api/token', { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } });
    const headers = { 'x-aws-ec2-metadata-token': token };
    const role = (await get('/latest/meta-data/iam/security-credentials/', { headers })).split('\n')[0].trim();
    if (!role) throw new Error('imds 역할 없음');
    const c = JSON.parse(await get(`/latest/meta-data/iam/security-credentials/${enc(role)}`, { headers }));
    if (!c.AccessKeyId || !c.SecretAccessKey) throw new Error('imds 자격 증명 형식');
    return { creds: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token }, expires: Date.parse(c.Expiration) || 0 };
  } catch (e) {
    throw Object.assign(new Error(`aws 자격 증명 없음(${e.name === 'TimeoutError' ? 'imds 응답 없음' : e.message})`), { noRetry: true });
  }
}

/** 환경 변수 자격 증명이 있으면 그것(IMDS 안 부름), 없으면 IMDSv2. 만료 5분 전까지 캐시. */
function credentials(env = process.env) {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return Promise.resolve({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined });
  }
  if (cache && cache.expires - Date.now() > REFRESH_MS) return Promise.resolve(cache.creds);
  inflight ||= imds().then((c) => { cache = c; return c.creds; }).finally(() => { inflight = null; });
  return inflight;
}

/**
 * 서명하고 fetch. 2xx 면 Response. 아니면 오류 { status, code, retryAfter }.
 * 만료는 상태 코드가 아니라 오류 코드로 본다(헤더 x-amzn-ErrorType, S3 XML <Code>, JSON __type) — 만료면 자격 증명을 다시 받아 한 번만 다시 보낸다.
 */
async function request({ service, url, method = 'GET', headers = {}, body = '', timeoutMs = 30000, region: r }) {
  for (let attempt = 0; ; attempt += 1) {
    const creds = await credentials();
    const s = sign({ method, url, headers, body, service, region: r, creds });
    const res = await fetch(s.url, { method, headers: s.headers, body: body || undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return res;
    let text = await res.text().catch(() => '');
    for (const v of [creds.secretAccessKey, creds.sessionToken]) if (v) text = text.split(v).join('***');
    const code = (res.headers.get('x-amzn-errortype') || '').split(':')[0]
      || /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || /"__type"\s*:\s*"(?:[^"#]*#)?([^"]+)"/.exec(text)?.[1] || '';
    if (attempt === 0 && /^ExpiredToken/.test(code)) { forget(); continue; }
    throw Object.assign(new Error(`${service} ${res.status} ${code}: ${text.slice(0, 300)}`), { status: res.status, code, retryAfter: res.headers.get('retry-after') });
  }
}

module.exports = { sign, credentials, request, region, forget };
