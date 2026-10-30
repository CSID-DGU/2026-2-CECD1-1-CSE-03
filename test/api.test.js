'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const { createServer } = require('../server/index');

let server; let base;
before(async () => {
  db.init(':memory:'); llm.use('mock');
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const api = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };

test('health · policy · stats · status', async () => {
  const h = await api('GET', '/api/health'); assert.equal(h.status, 200); assert.equal(h.data.ok, true); assert.equal(h.data.provider.llm, 'mock');
  const p = await api('GET', '/api/policy'); assert.equal(p.data.length, 3);
  const s = await api('GET', '/api/stats'); assert.equal(typeof s.data.awaitingApproval, 'number');
  const st = await api('GET', '/api/agent/status'); assert.equal(st.data.running, false);
});

test('inbound → SSE agent.step 수신 → 목록 → 승인 → 상세', async () => {
  // SSE 먼저 연다
  const ac = new AbortController();
  const sseRes = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = sseRes.body.getReader(); const dec = new TextDecoder(); let buf = '';
  const gotStep = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return false; buf += dec.decode(value, { stream: true }); if (/event: agent\.step/.test(buf)) return true; } })();

  const inb = await api('POST', '/api/inbound', { channel: 'support', from: 'api@example.com', name: '테스터', subject: '탈퇴', body: '계정을 탈퇴하고 싶습니다.' });
  assert.equal(inb.status, 200); assert.ok(inb.data.caseId); assert.equal(inb.data.created, true);
  const row = await until(async () => (await api('GET', '/api/cases?state=AWAITING_APPROVAL')).data.find((c) => c.id === inb.data.caseId && c.pendingDraftId));
  assert.equal(row.state, 'AWAITING_APPROVAL'); assert.equal(row.threadId, inb.data.threadId);
  assert.equal(await gotStep, true); ac.abort();

  const bad = await api('POST', `/api/drafts/${row.pendingDraftId}/approve`, {}); assert.equal(bad.status, 400);
  const ok = await api('POST', `/api/drafts/${row.pendingDraftId}/approve`, { by: 'tester' }); assert.equal(ok.status, 200); assert.ok(ok.data.dispatchId);
  const again = await api('POST', `/api/drafts/${row.pendingDraftId}/approve`, { by: 'tester' }); assert.equal(again.status, 409); assert.equal(again.data.error, 'not_pending');

  const det = await api('GET', `/api/cases/${inb.data.caseId}`);
  assert.equal(det.data.case.state, 'WAITING_CUSTOMER');
  assert.ok(det.data.messages.some((m) => m.direction === 'out'));
  assert.ok(det.data.decisions.length >= 6);
  assert.deepEqual(det.data.activities.map((a) => a.type), ['approve']);

  // 같은 스레드 재회신 → 새 회차, 상세에 메시지 3개
  const re = await api('POST', '/api/inbound', { channel: 'support', from: 'api@example.com', subject: 'Re: 탈퇴', body: '감사합니다. 확인했습니다.', threadId: inb.data.threadId });
  assert.equal(re.data.created, false);
  await until(async () => (await api('GET', `/api/cases/${inb.data.caseId}`)).data.decisions.some((d) => d.step === 'execute' && d.message_id === re.data.messageId));
  const det2 = await api('GET', `/api/cases/${inb.data.caseId}`);
  assert.equal(det2.data.messages.length, 3);
  assert.equal(det2.data.case.state, 'WAITING_CUSTOMER'); // ack는 무시, 상태 유지
});

test('잘못된 channel → 400, 없는 케이스 → 404, 정적 루트 응답', async () => {
  assert.equal((await api('POST', '/api/inbound', { channel: 'nope', from: 'a@b.c', body: 'x' })).status, 400);
  assert.equal((await api('GET', '/api/cases/none')).status, 404);
  const r = await fetch(`${base}/`); assert.equal(r.status, 200);
});
