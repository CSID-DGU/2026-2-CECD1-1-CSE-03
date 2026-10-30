'use strict';
// 배포 안전장치 — 웹훅 시크릿(INBOUND_SECRET), 실발송 수신자 도메인 허용 목록(MAIL_ALLOWED_DOMAINS).
process.env.MAIL_MOCK_LOG = '0';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const mail = require('../server/mail');
const { createServer } = require('../server/index');

let server; let base;
before(async () => {
  db.init(':memory:'); llm.use('mock');
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); delete process.env.INBOUND_SECRET; delete process.env.MAIL_PROVIDER; delete process.env.MAIL_ALLOWED_DOMAINS; });

const inbound = (headers = {}) => fetch(`${base}/api/inbound`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ channel: 'support', from: 'sec@example.com', subject: '테스트', body: '감사합니다. 확인했습니다.' }),
});

test('INBOUND_SECRET 설정 시 헤더 없으면 401, 맞으면 200, 비어 있으면 검사 안 함', async () => {
  process.env.INBOUND_SECRET = 's3cret';
  assert.equal((await inbound()).status, 401);
  assert.equal((await inbound({ 'x-inbound-secret': 'wrong' })).status, 401);
  assert.equal((await inbound({ 'x-inbound-secret': 's3cret' })).status, 200);
  process.env.INBOUND_SECRET = '';
  assert.equal((await inbound()).status, 200);
});

test('실발송 provider는 허용 목록 비어 있으면 전체 차단, 목록 밖 도메인 차단', async () => {
  process.env.MAIL_PROVIDER = 'smtp';
  process.env.MAIL_ALLOWED_DOMAINS = '';
  await assert.rejects(mail.send({ to: 'a@example.com', subject: 's', body: 'b', idempotencyKey: 'k' }), /recipient_not_allowed/);
  process.env.MAIL_ALLOWED_DOMAINS = 'example.com, partner.co.kr';
  await assert.rejects(mail.send({ to: 'a@evil.com', subject: 's', body: 'b', idempotencyKey: 'k' }), /recipient_not_allowed/);
  // 허용 도메인(대소문자 무관)은 허용 목록을 통과한다 — 실제 발송은 smtp 어댑터 몫
  assert.doesNotThrow(() => mail.assertRecipientAllowed('a@Example.com'));
  process.env.MAIL_PROVIDER = 'mock';
  const r = await mail.send({ to: 'a@evil.com', subject: 's', body: 'b', idempotencyKey: 'k' });
  assert.equal(r.provider, 'mock'); // mock은 허용 목록 무관
});
