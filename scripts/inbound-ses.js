'use strict';
// node scripts/inbound-ses.js — SES 수신 어댑터: SQS(SES 알림, SNS 원문 전달) → S3 원문 MIME → POST /api/inbound.
// 한 번에 한 통(MaxNumberOfMessages 1). 서버 /api/health 가 실패하면 큐를 건드리지 않는다.
// 설정 오류(401·403, 503 mirror_unsafe, 미러의 4xx, S3 403)는 메시지를 돌려놓고 정지 — 5→10→20→40→60분(상한), 정상 응답 한 번이면 5분으로 돌아간다.
// 독 메시지(알림 JSON·MIME 해석 실패)는 visibility 0 으로 돌려 곧 다시 받게 한다. 큐의 maxReceiveCount 뒤 DLQ 로 간다.
// 로그에는 객체 키 앞 8자·채널·결과·수신 횟수만. 주소·제목·본문은 남기지 않는다.
const aws = require('../server/aws');
const policy = require('../server/policy');
const imap = require('./inbound-imap'); // parseMessage·post — 호출할 때 모듈에서 꺼낸다

const BASE = process.env.SIM_URL || `http://localhost:${process.env.PORT || 3000}`;
const MAX_BYTES = 30 * 1024 * 1024; // SES S3 액션이 저장하는 메일 최대 크기
const PAUSE_MS = 5 * 60 * 1000;
const PAUSE_MAX_MS = 60 * 60 * 1000;
const HEALTH_RETRY_MS = 30 * 1000;
const KEY_RE = /^[A-Za-z0-9/_.-]+$/;

const addrs = (s) => (String(s || '').match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/g) || []).map((a) => a.toLowerCase());
const why = (e) => (e.status ? `${e.status} ${e.code || ''}`.trim() : e.message);

function config(env = process.env) {
  const mode = env.SES_MODE || '';
  if (mode && mode !== 'mirror') throw new Error('SES_MODE 오류(비우거나 mirror)');
  const missing = ['SES_QUEUE_URL', 'SES_BUCKET', 'SES_CHANNELS', 'INBOUND_SECRET'].filter((k) => !String(env[k] || '').trim());
  if (missing.length) throw new Error(`설정 필요: ${missing.join(', ')}`);
  let queue;
  try { queue = new URL(env.SES_QUEUE_URL); } catch { throw new Error('SES_QUEUE_URL 오류'); }
  if (queue.protocol !== 'https:') throw new Error('SES_QUEUE_URL 오류(https)');
  const channels = {};
  for (const item of env.SES_CHANNELS.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^\s=@]+@[^\s=@]+)=([A-Za-z0-9_-]+)$/.exec(item);
    if (!m) throw new Error('SES_CHANNELS 형식 오류(받는주소=채널 쉼표 목록)');
    channels[m[1].toLowerCase()] = m[2];
  }
  if (!Object.keys(channels).length) throw new Error('SES_CHANNELS 형식 오류(받는주소=채널 쉼표 목록)');
  const mirror = mode === 'mirror';
  if (mirror) {
    // 실고객 메일을 받는 동안 어떤 메일도 나가면 안 된다 — 서버 시작 검사와 같은 해석(policy)
    const shadow = policy.shadowEnv(env);
    const unsafe = Object.entries({
      'MAIL_PROVIDER=mock': env.MAIL_PROVIDER === 'mock',
      'AUTO_SEND=0': !policy.autoSendOn(env),
      ...Object.fromEntries([...new Set(Object.values(channels))].map((ch) => [`SHADOW_CHANNELS 에 ${ch}`, shadow.includes(ch)])),
    }).filter(([, ok]) => !ok).map(([k]) => k);
    if (unsafe.length) throw new Error(`미러 모드는 발송 없는 설정이어야 한다 — 필요: ${unsafe.join(', ')}`);
  }
  return {
    queueUrl: env.SES_QUEUE_URL, bucket: env.SES_BUCKET, prefix: env.SES_PREFIX || 'inbound/', region: aws.region(env),
    channels, ours: [...addrs(env.SMTP_FROM), ...Object.keys(channels)], secret: env.INBOUND_SECRET, mirror,
  };
}

async function sqs(cfg, action, params, timeoutMs = 10000) {
  const res = await aws.request({
    service: 'sqs', url: `${new URL(cfg.queueUrl).origin}/`, method: 'POST', region: cfg.region, timeoutMs,
    headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${action}` },
    body: JSON.stringify({ QueueUrl: cfg.queueUrl, ...params }),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** 한 바퀴. 다음 바퀴까지 기다릴 ms 를 돌려준다. clock 은 시험에서 주입한다. */
async function tick(cfg, state, clock = Date.now) {
  if (state.pausedUntil > clock()) return state.pausedUntil - clock();
  const healthy = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (!healthy) { console.error('[ses] 서버 health 실패 — 큐를 읽지 않고 30초 뒤 다시'); return HEALTH_RETRY_MS; }
  const r = await sqs(cfg, 'ReceiveMessage', {
    MaxNumberOfMessages: 1, WaitTimeSeconds: 20, VisibilityTimeout: 120, MessageSystemAttributeNames: ['ApproximateReceiveCount'],
  }, 30000);
  for (const m of r.Messages || []) {
    try { await handle(cfg, state, clock, m); } catch (e) { console.error(`[ses] 처리 오류 — ${why(e)}`); }
  }
  return 0;
}

async function handle(cfg, state, clock, m) {
  const count = m.Attributes?.ApproximateReceiveCount || '?';
  let tag = '-';
  const log = (s) => console.log(`[ses] ${tag} ${s} (수신 ${count}회)`);
  const del = (s) => sqs(cfg, 'DeleteMessage', { ReceiptHandle: m.ReceiptHandle }).then(() => log(s));
  const back = (sec) => sqs(cfg, 'ChangeMessageVisibility', { ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: sec });
  const poison = async (s) => { await back(0); console.error(`[ses] ${tag} 독 메시지 — ${s}. 돌려놓음 (수신 ${count}회)`); };
  const pause = (s) => {
    const ms = state.nextPause || PAUSE_MS;
    state.pausedUntil = clock() + ms;
    state.nextPause = Math.min(ms * 2, PAUSE_MAX_MS);
    console.error(`[ses] 정지 ${ms / 60000}분 — ${tag} ${s}. 설정(INBOUND_SECRET·SES_CHANNELS·버킷 권한·미러 조건)을 확인 (수신 ${count}회)`);
    return back(0);
  };

  let n;
  try { n = JSON.parse(m.Body); } catch { return poison('알림 JSON 해석 실패'); }
  const act = n?.receipt?.action || {};
  const key = String(act.objectKey || '');
  tag = key.slice(cfg.prefix.length, cfg.prefix.length + 8) || '-';
  if (n?.notificationType !== 'Received' || act.type !== 'S3' || act.bucketName !== cfg.bucket || !key.startsWith(cfg.prefix)
    || !KEY_RE.test(key) || key.split('/').some((s) => s === '.' || s === '..')) return del('지움(알림 형식 밖)');
  if (n.receipt.virusVerdict?.status === 'FAIL') return del('지움(바이러스 판정)');
  const to = (Array.isArray(n.receipt.recipients) ? n.receipt.recipients : []).map((a) => String(a).toLowerCase()).find((a) => cfg.channels[a]);
  if (!to) return del('지움(매핑된 받는 주소 없음)');
  const channel = cfg.channels[to];
  tag = `${tag} ${channel}`;

  let buf;
  try {
    const res = await aws.request({ service: 's3', url: `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`, region: cfg.region, timeoutMs: 60000 });
    if (Number(res.headers.get('content-length')) > MAX_BYTES) { await res.body?.cancel(); return del('지움(30MB 초과)'); }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e.status === 404 || e.code === 'NoSuchKey') return del('지움(원문 없음 — 보존 기간이 지났을 수 있음)');
    if (e.status === 403) return pause(`S3 ${why(e)}`);
    await back(30);
    return log(`보류(S3 ${why(e)})`);
  }
  if (buf.length > MAX_BYTES) return del('지움(30MB 초과)');

  let msg;
  try { msg = imap.parseMessage(buf); } catch { return poison('MIME 해석 실패'); }
  const dmarc = n.receipt.dmarcVerdict?.status;
  msg.senderAuth = dmarc === 'PASS' ? 'pass' : dmarc === 'FAIL' ? 'fail' : undefined;
  if (!msg.providerMessageId && n.mail?.messageId) msg.providerMessageId = `ses:${n.mail.messageId}`;
  if (cfg.ours.includes(String(msg.from || '').toLowerCase())) return del('지움(우리 주소 발신)');
  if (!msg.from) return del('지움(발신 주소 없음)');
  if (!msg.body) return del('지움(본문 없음)');

  let out;
  try {
    out = await imap.post({ ...cfg, channel }, msg);
  } catch (e) {
    const setup = e.status === 401 || e.status === 403 || (e.status === 503 && /mirror_unsafe/.test(e.message))
      || (cfg.mirror && e.status >= 400 && e.status < 500 && e.status !== 413);
    if (setup) return pause(`inbound ${e.status}`);
    if (e.status >= 400 && e.status < 500) return del(`지움(inbound ${e.status})`);
    await back(30);
    return log(`보류(inbound ${e.status || e.message})`);
  }
  state.nextPause = PAUSE_MS; // 정상 응답 — 다음 정지는 다시 5분부터
  return del(`→ case ${String(out.caseId || '').slice(0, 8)}${out.duplicate ? ' (중복)' : out.created ? ' (새 케이스)' : ' (기존 케이스)'}`);
}

async function main() {
  let cfg;
  try { cfg = config(); } catch (e) { console.error(`[ses] ${e.message}`); process.exit(2); }
  console.log(`[ses] 큐 → ${BASE}/api/inbound (채널 ${[...new Set(Object.values(cfg.channels))].join(',')}${cfg.mirror ? ', 미러' : ''})`);
  const state = {};
  for (;;) {
    const wait = await tick(cfg, state).catch((e) => { console.error(`[ses] ${why(e)}`); return HEALTH_RETRY_MS; });
    if (wait) await new Promise((r) => setTimeout(r, wait));
  }
}

if (require.main === module) main();

module.exports = { config, tick };
