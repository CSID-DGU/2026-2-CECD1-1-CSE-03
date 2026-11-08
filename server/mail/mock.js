'use strict';
// 발송 흉내. 실제로 아무 데도 안 보낸다. 같은 멱등키면 같은 id를 돌려준다(실 provider의 멱등 동작 흉내).
// MAIL_MOCK_FAIL=1이면 실패, MAIL_MOCK_DELAY_MS면 그만큼 늦게 끝난다(발송 중 경쟁 테스트용).
const crypto = require('node:crypto');

// 단순화: 프로세스 메모리 — 재시작하면 잊는다. 실 provider는 서버 쪽 멱등키를 쓴다.
const sent = new Map();

async function send({ to, subject, body, idempotencyKey }) {
  if (process.env.MAIL_MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.MAIL_MOCK_DELAY_MS)));
  if (process.env.MAIL_MOCK_FAIL === '1') throw new Error('mock send failure');
  if (idempotencyKey && sent.has(idempotencyKey)) return { id: sent.get(idempotencyKey), provider: 'mock', duplicate: true };
  const id = `mock:${crypto.randomUUID()}`;
  if (idempotencyKey) sent.set(idempotencyKey, id);
  // 수신 주소는 도메인만 남긴다 — 로그는 오래 남고 여러 사람이 본다.
  if (process.env.MAIL_MOCK_LOG !== '0') console.log(`[mail:mock] → *@${String(to).split('@').pop()} | ${String(subject).slice(0, 40)} | ${String(body).length}자 | key=${idempotencyKey}`);
  return { id, provider: 'mock' };
}

module.exports = { send };
