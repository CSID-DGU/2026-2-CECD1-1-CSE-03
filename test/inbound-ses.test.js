'use strict';
// scripts/inbound-ses.js — SQS(SES 알림) → S3 원문 → /api/inbound. SQS·S3 는 fetch 대체(AWS 를 부르지 않는다),
// 서버는 createServer 를 127.0.0.1:0 에(in-memory DB, mock LLM·메일), 시계는 주입한다.
process.env.MAIL_MOCK_LOG = '0';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const db = require('../server/db');
const llm = require('../server/llm');
const { createServer } = require('../server/index');

const QUEUE = 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/cs-inbound';
const BUCKET = 'cs-raw-mail';
const ENV = {
  SES_QUEUE_URL: QUEUE, SES_BUCKET: BUCKET, INBOUND_SECRET: 'sec-inbound', SMTP_FROM: 'ACME <help@acme.example>',
  SES_CHANNELS: 'support@mirror.acme.example=support, Sales@mirror.acme.example=sales',
};
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MIN = 60 * 1000;

const realFetch = globalThis.fetch;
const realConsole = { log: console.log, error: console.error };
const logs = [];
const fake = {};
let server; let base; let ses; let imap; let cfg;
let t = 1e12;
const clock = () => t;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

async function stub(url, init = {}) {
  const u = new URL(String(url));
  if (u.origin === base) {
    if (u.pathname === '/api/health' && fake.health) return fake.health();
    if (u.pathname === '/api/inbound') {
      fake.posts.push({ body: JSON.parse(init.body), headers: init.headers });
      if (fake.inbound) return fake.inbound();
    }
    return realFetch(url, init);
  }
  const call = { url: String(url), method: init.method || 'GET', headers: init.headers };
  fake.calls.push(call);
  if (u.host === 'sqs.ap-northeast-2.amazonaws.com') {
    call.action = init.headers['x-amz-target'].replace('AmazonSQS.', '');
    call.params = JSON.parse(init.body);
    if (call.action === 'ReceiveMessage') { const m = fake.queue.shift(); return json(m ? { Messages: [m] } : {}); }
    return json({});
  }
  if (u.host === `${BUCKET}.s3.ap-northeast-2.amazonaws.com`) {
    call.action = 'GetObject';
    const o = fake.s3[u.pathname.slice(1)];
    if (o === undefined) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return typeof o === 'function' ? o() : new Response(o);
  }
  throw new Error(`예상 밖 요청 ${u.host}`);
}

let seq = 0;
/** 시험 메일 하나를 S3·큐에 넣는다. 제목·본문·주소에는 로그 검사용 표지가 있다. */
function queueMail({ key, from = 'cust7731@example.com', to = 'support@mirror.acme.example', messageId, dmarc = 'PASS', spam = 'PASS', virus = 'PASS', bucket = BUCKET, type = 'Received', action = 'S3', rawBody, count = '1' } = {}) {
  seq += 1;
  key ??= `inbound/m${seq}xxxxxxxxxxxx`;
  fake.s3[key] = [`From: Kim Mark <${from}>`, `To: ${to}`, `Subject: SUBJMARK 영수증 ${seq}`, ...(messageId ? [`Message-ID: ${messageId}`] : []),
    'Content-Type: text/plain; charset=utf-8', '', `BODYMARK 영수증 발급 부탁드립니다 ${seq}`, ''].join('\r\n');
  const note = {
    notificationType: type, mail: { messageId: `sesid${seq}`, timestamp: '2026-11-08T00:00:00.000Z' },
    receipt: { recipients: [to], dmarcVerdict: { status: dmarc }, spamVerdict: { status: spam }, virusVerdict: { status: virus }, action: { type: action, bucketName: bucket, objectKey: key } },
  };
  const m = { MessageId: `q${seq}`, ReceiptHandle: `rh${seq}`, Body: rawBody ?? JSON.stringify(note), Attributes: { ApproximateReceiveCount: count } };
  fake.queue.push(m);
  return { key, rh: m.ReceiptHandle, sesId: `sesid${seq}`, m };
}
const of = (action) => fake.calls.filter((c) => c.action === action);
const deleted = (rh) => of('DeleteMessage').some((c) => c.params.ReceiptHandle === rh);
const vis = (rh) => of('ChangeMessageVisibility').filter((c) => c.params.ReceiptHandle === rh).map((c) => c.params.VisibilityTimeout);

before(async () => {
  Object.assign(process.env, { AUTO_SEND: '0', INBOUND_SECRET: 'sec-inbound', AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'secret-test', AWS_REGION: 'ap-northeast-2' });
  delete process.env.AWS_SESSION_TOKEN;
  db.init(':memory:'); llm.use('mock');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.SIM_URL = base; // 두 어댑터 모두 불러올 때 POST 대상을 정한다 — 그 전에 불러오지 않는다
  ses = require('../scripts/inbound-ses');
  imap = require('../scripts/inbound-imap');
  cfg = ses.config({ ...ENV });
  globalThis.fetch = stub;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
});
after(() => { globalThis.fetch = realFetch; Object.assign(console, realConsole); server.close(); });
beforeEach(() => Object.assign(fake, { queue: [], s3: {}, calls: [], posts: [], inbound: null, health: null }));

test('AC-B12·B1·B3 — ReceiveMessage(JSON 프로토콜, 한 통, 수신 횟수), S3 GET 서명, 페이로드, 2xx 면 지움', async () => {
  const { key, rh, sesId } = queueMail();
  assert.equal(await ses.tick(cfg, {}, clock), 0);
  const [rcv] = fake.calls;
  assert.equal(rcv.action, 'ReceiveMessage');
  assert.equal(rcv.url, 'https://sqs.ap-northeast-2.amazonaws.com/');
  assert.equal(rcv.method, 'POST');
  assert.equal(rcv.headers['content-type'], 'application/x-amz-json-1.0');
  assert.equal(rcv.headers['x-amz-target'], 'AmazonSQS.ReceiveMessage');
  assert.match(rcv.headers.authorization, /\/ap-northeast-2\/sqs\/aws4_request,SignedHeaders=content-type;host;x-amz-date;x-amz-target,/);
  assert.equal(rcv.params.QueueUrl, QUEUE);
  assert.equal(rcv.params.MaxNumberOfMessages, 1);
  assert.deepEqual(rcv.params.MessageSystemAttributeNames, ['ApproximateReceiveCount']);
  assert.equal(rcv.params.WaitTimeSeconds, 20);
  assert.equal(rcv.params.VisibilityTimeout, 120);

  const [get] = of('GetObject');
  assert.equal(get.url, `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com/${key}`);
  assert.equal(get.method, 'GET');
  assert.equal(get.headers['x-amz-content-sha256'], EMPTY_SHA);
  assert.match(get.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/ap-northeast-2\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);

  const [p] = fake.posts;
  assert.equal(p.headers['x-inbound-secret'], 'sec-inbound');
  assert.equal(p.body.channel, 'support');
  assert.equal(p.body.from, 'cust7731@example.com');
  assert.equal(p.body.senderAuth, 'pass');
  assert.equal(p.body.providerMessageId, `ses:${sesId}`, 'Message-ID 가 없으면 SES 메시지 id');
  assert.equal(p.body.mirror, undefined);
  assert.ok(deleted(rh));
  assert.deepEqual(of('DeleteMessage')[0].params, { QueueUrl: QUEUE, ReceiptHandle: rh });
  assert.match(logs.at(-1), /새 케이스/);
});

test('AC-B3 — senderAuth 변환(FAIL → fail, GRAY → 없음), 채널 매핑(대소문자 무시), Message-ID 그대로, 같은 알림 두 번 → 둘째는 중복 → 지움', async () => {
  queueMail({ dmarc: 'FAIL', to: 'sales@mirror.acme.example' });
  queueMail({ dmarc: 'GRAY', messageId: '<abc-1@mail.example.com>' });
  await ses.tick(cfg, {}, clock); await ses.tick(cfg, {}, clock);
  assert.equal(fake.posts[0].body.senderAuth, 'fail');
  assert.equal(fake.posts[0].body.channel, 'sales');
  assert.equal('senderAuth' in fake.posts[1].body, false);
  assert.equal(fake.posts[1].body.providerMessageId, '<abc-1@mail.example.com>');

  const { m, rh } = queueMail();
  fake.queue.push({ ...m, ReceiptHandle: `${rh}-again` });
  await ses.tick(cfg, {}, clock); await ses.tick(cfg, {}, clock);
  assert.equal(fake.posts.length, 4);
  assert.ok(deleted(rh) && deleted(`${rh}-again`));
  assert.match(logs.at(-1), /\(중복\)/);
});

test('AC-B2 — 버킷 불일치·접두어 밖·이상한 글자·Received 아님·S3 액션 아님 → S3 를 부르지 않고 지움', async () => {
  const rhs = [
    queueMail({ bucket: 'other-bucket' }), queueMail({ key: 'other/abc' }), queueMail({ key: 'inbound/a b' }), queueMail({ key: 'inbound/../x' }),
    queueMail({ key: 'inbound/a%2Fb' }), queueMail({ type: 'Bounce' }), queueMail({ action: 'Lambda' }),
  ].map((x) => x.rh);
  for (const _ of rhs) await ses.tick(cfg, {}, clock);
  assert.equal(of('GetObject').length, 0);
  assert.equal(fake.posts.length, 0);
  for (const rh of rhs) assert.ok(deleted(rh), rh);
});

test('AC-B4 — 우리 주소(SMTP_FROM·SES_CHANNELS) 발신과 바이러스 FAIL 은 넘기지 않고 지움, 스팸 FAIL 은 넘긴다', async () => {
  const ours = queueMail({ from: 'help@acme.example' });
  const loop = queueMail({ from: 'support@mirror.acme.example' });
  const virus = queueMail({ virus: 'FAIL' });
  const spam = queueMail({ spam: 'FAIL' });
  for (let i = 0; i < 4; i += 1) await ses.tick(cfg, {}, clock);
  assert.ok(deleted(ours.rh) && deleted(loop.rh) && deleted(virus.rh) && deleted(spam.rh));
  assert.equal(of('GetObject').filter((c) => c.url.endsWith(virus.key)).length, 0, '바이러스 판정이면 원문을 받지 않는다');
  assert.equal(fake.posts.length, 1);
  assert.equal(fake.posts[0].body.providerMessageId, `ses:${spam.sesId}`);
});

test('AC-B5 — 503(일반)·네트워크 오류·S3 5xx → 안 지움 + visibility 30, 미러 아님 + 400·413 → 지움', async () => {
  fake.inbound = () => json({ error: 'busy' }, 503);
  const a = queueMail(); await ses.tick(cfg, {}, clock);
  fake.inbound = () => { throw new TypeError('fetch failed'); };
  const b = queueMail(); await ses.tick(cfg, {}, clock);
  fake.inbound = null;
  const c = queueMail(); fake.s3[c.key] = () => new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
  await ses.tick(cfg, {}, clock);
  for (const x of [a, b, c]) { assert.equal(deleted(x.rh), false); assert.deepEqual(vis(x.rh), [30]); }
  fake.inbound = () => json({ error: 'bad' }, 400);
  const d = queueMail(); await ses.tick(cfg, {}, clock);
  fake.inbound = () => json({ error: 'body too large' }, 413);
  const e = queueMail(); await ses.tick(cfg, {}, clock);
  assert.ok(deleted(d.rh) && deleted(e.rh));
  assert.deepEqual([...vis(d.rh), ...vis(e.rh)], []);
});

test('30MB 넘는 원문은 넘기지 않고 지움', async () => {
  const x = queueMail();
  fake.s3[x.key] = () => new Response('x', { headers: { 'content-length': String(30 * 1024 * 1024 + 1) } });
  await ses.tick(cfg, {}, clock);
  assert.ok(deleted(x.rh));
  assert.equal(fake.posts.length, 0);
});

test('AC-B8 — 매핑된 받는 주소가 없으면 S3 를 부르지 않고 지움', async () => {
  const x = queueMail({ to: 'someone@else.example' });
  await ses.tick(cfg, {}, clock);
  assert.ok(deleted(x.rh));
  assert.equal(of('GetObject').length, 0);
});

test('AC-B9 — /api/health 실패(5xx·연결 실패) → ReceiveMessage 를 부르지 않고 30초 뒤', async () => {
  queueMail();
  fake.health = () => new Response('', { status: 500 });
  assert.equal(await ses.tick(cfg, {}, clock), 30000);
  fake.health = () => { throw new TypeError('fetch failed'); };
  assert.equal(await ses.tick(cfg, {}, clock), 30000);
  assert.equal(fake.calls.length, 0);
  assert.match(logs.at(-1), /health/);
});

test('AC-B10 — 설정 오류(미러 400, 401, 503 mirror_unsafe, 403) → 안 지움 + visibility 0 + 정지(5→10→20→40→60분 상한), 정지 중 SQS 호출 없음, 정상 응답 한 번이면 5분으로', async () => {
  const mirror = { ...cfg, mirror: true };
  const state = {};
  const kinds = [
    [mirror, () => json({ error: 'bad' }, 400)], [cfg, () => json({ error: 'unauthorized' }, 401)], [cfg, () => json({ error: 'mirror_unsafe' }, 503)],
    [cfg, () => json({ error: 'forbidden' }, 403)], [mirror, () => json({ error: 'no channel' }, 404)], [cfg, () => json({ error: 'unauthorized' }, 401)],
  ];
  const minutes = [5, 10, 20, 40, 60, 60];
  for (const [i, [c, res]] of kinds.entries()) {
    fake.inbound = res;
    const x = queueMail();
    assert.equal(await ses.tick(c, state, clock), 0);
    assert.equal(deleted(x.rh), false);
    assert.deepEqual(vis(x.rh), [0]);
    assert.ok(logs.some((l) => l.startsWith(`[ses] 정지 ${minutes[i]}분`)), `정지 ${minutes[i]}분`);
    assert.equal(fake.posts.at(-1).body.mirror, c.mirror || undefined);
    // 정지 시간 동안은 아무것도 부르지 않는다(health 도)
    const n = fake.calls.length; const p = fake.posts.length;
    t += minutes[i] * MIN - 1;
    assert.equal(await ses.tick(c, state, clock), 1);
    assert.equal(fake.calls.length, n);
    assert.equal(fake.posts.length, p);
    t += 1;
  }
  fake.inbound = () => json({ caseId: 'c1', created: true });
  const ok = queueMail(); await ses.tick(cfg, state, clock);
  assert.ok(deleted(ok.rh));
  fake.inbound = () => json({ error: 'unauthorized' }, 401);
  queueMail(); await ses.tick(cfg, state, clock);
  assert.equal(state.pausedUntil - t, 5 * MIN, '정상 응답 뒤 다시 5분부터');
  t = state.pausedUntil;
  assert.equal(await ses.tick(cfg, state, clock), 0);
  assert.equal(fake.calls.at(-1).action, 'ReceiveMessage', '정지가 끝나면 다시 받는다');

  fake.inbound = () => json({ error: 'busy' }, 503);
  const busy = queueMail(); await ses.tick(mirror, state, clock);
  assert.deepEqual(vis(busy.rh), [30], '미러라도 일반 503 은 정지가 아니다');
  assert.ok(!(state.pausedUntil > t));
});

test('AC-B11 — S3 404 → 지움 + 사유 로그, S3 403 → 안 지움 + visibility 0 + 정지', async () => {
  const gone = queueMail(); delete fake.s3[gone.key];
  await ses.tick(cfg, {}, clock);
  assert.ok(deleted(gone.rh));
  assert.match(logs.at(-1), /원문 없음/);
  const denied = queueMail(); fake.s3[denied.key] = () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
  const state = {};
  await ses.tick(cfg, state, clock);
  assert.equal(deleted(denied.rh), false);
  assert.deepEqual(vis(denied.rh), [0]);
  assert.equal(state.pausedUntil - t, 5 * MIN);
  assert.match(logs.at(-1), /^\[ses\] 정지 5분 .*S3 403 AccessDenied/);
  assert.equal(fake.posts.length, 0);
});

test('AC-B13 — 알림 JSON 이 깨졌거나 MIME 해석이 던지면 안 지움 + visibility 0, 수신 횟수 로그, 다음 바퀴는 막히지 않는다', async () => {
  const broken = queueMail({ rawBody: '{not json', count: '3' });
  const state = {};
  await ses.tick(cfg, state, clock);
  assert.equal(deleted(broken.rh), false);
  assert.deepEqual(vis(broken.rh), [0]);
  assert.match(logs.at(-1), /독 메시지.*수신 3회/);
  assert.equal(of('GetObject').length, 0);

  const orig = imap.parseMessage;
  imap.parseMessage = () => { throw new RangeError('boom'); };
  const bad = queueMail();
  try { await ses.tick(cfg, state, clock); } finally { imap.parseMessage = orig; }
  assert.equal(deleted(bad.rh), false);
  assert.deepEqual(vis(bad.rh), [0]);
  assert.ok(!(state.pausedUntil > t), '독 메시지는 정지가 아니다');

  const good = queueMail();
  await ses.tick(cfg, state, clock);
  assert.ok(deleted(good.rh));
  assert.equal(fake.posts.length, 1);
});

test('AC-B6 — config(): 필수 누락·잘못된 SES_MODE·SES_CHANNELS 형식·미러인데 발송 가능 → 오류, 실행하면 종료 코드 2', () => {
  for (const k of ['SES_QUEUE_URL', 'SES_BUCKET', 'SES_CHANNELS', 'INBOUND_SECRET']) assert.throws(() => ses.config({ ...ENV, [k]: '' }), new RegExp(`설정 필요: ${k}`));
  assert.throws(() => ses.config({ ...ENV, SES_MODE: 'mirorr' }), /SES_MODE 오류/);
  for (const SES_CHANNELS of ['support', 'support=support', 'a@b=sup port', ' , ']) assert.throws(() => ses.config({ ...ENV, SES_CHANNELS }), /SES_CHANNELS 형식 오류/, SES_CHANNELS);
  assert.throws(() => ses.config({ ...ENV, SES_QUEUE_URL: 'http://sqs.local/1/q' }), /SES_QUEUE_URL/);

  const safe = { ...ENV, SES_MODE: 'mirror', MAIL_PROVIDER: 'mock', AUTO_SEND: '0', SHADOW_CHANNELS: 'support,sales' };
  const m = ses.config(safe);
  assert.equal(m.mirror, true);
  assert.deepEqual(m.channels, { 'support@mirror.acme.example': 'support', 'sales@mirror.acme.example': 'sales' });
  assert.deepEqual(m.ours, ['help@acme.example', 'support@mirror.acme.example', 'sales@mirror.acme.example']);
  assert.equal(m.prefix, 'inbound/');
  assert.equal(m.region, 'ap-northeast-2');
  assert.throws(() => ses.config({ ...safe, MAIL_PROVIDER: 'smtp' }), (e) => /MAIL_PROVIDER=mock/.test(e.message) && !/AUTO_SEND|SHADOW/.test(e.message));
  assert.throws(() => ses.config({ ...safe, AUTO_SEND: '' }), /AUTO_SEND=0/);
  assert.throws(() => ses.config({ ...safe, SHADOW_CHANNELS: 'support' }), /SHADOW_CHANNELS 에 sales/, '매핑된 모든 채널');
  assert.equal(ses.config(ENV).mirror, false);

  const script = path.join(__dirname, '..', 'scripts', 'inbound-ses.js');
  for (const env of [{}, { ...safe, MAIL_PROVIDER: 'smtp' }]) {
    const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^\[ses\] /);
  }
});

test('AC-B7 — 콘솔 출력에 시험 메일의 주소·이름·제목·본문이 없다', () => {
  const out = logs.join('\n');
  assert.ok(logs.filter((l) => l.startsWith('[ses]')).length > 20, '어댑터 로그가 남았다');
  assert.doesNotMatch(out, /@|cust7731|Kim Mark|SUBJMARK|BODYMARK|영수증/);
});
