'use strict';
// 업무 대체율(report.workload) — 메시지 1통 = 1단위, 수신·발신 각각 에이전트 처리·에이전트 보조·사람 처리.
// 고정 행: 수신은 cases.addInbound, 판단·초안·발신 행은 직접 넣는다(2026-10-01). 마지막 테스트만 실제 회차(mock LLM)를 돌려 지금 시각 이후로 따로 본다.
process.env.MAIL_MOCK_LOG = '0';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const report = require('../server/report');
const INQ = require('../server/mock/inquiries');

const AUTO = 'agent:auto';
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (min) => new Date(T0 + min * 60e3).toISOString();
let seq = 0;
const inbound = (channel, min, extra = {}) => cases.addInbound({ channel, from: `w${++seq}@example.com`, subject: '문의', body: '문의드립니다', occurredAt: at(min), ...extra });
const decide = (r, step, action, reason = null) => db.insert('decisions', {
  id: db.uuid(), case_id: r.caseId, message_id: r.messageId, step, agent: { triage: 'triage', brief: 'briefer' }[step] || 'code', output: '{}', action, reason, created_at: db.now(),
});
function draft(r, action, status, approvedBy = null, sentMin = null, finalBody = null) {
  const id = db.uuid();
  db.insert('drafts', { id, case_id: r.caseId, trigger_message_id: r.messageId, status, action, original_body: '답장', final_body: finalBody,
    idempotency_key: `draft:${id}`, approved_by: approvedBy, sent_at: sentMin == null ? null : at(sentMin), created_at: db.now() });
}
function out(r, sentBy, min, edited) {
  const { thread_id: tid } = db.get('SELECT thread_id FROM messages WHERE id=?', r.messageId);
  db.insert('messages', { id: db.uuid(), case_id: r.caseId, thread_id: tid, direction: 'out', sent_by: sentBy, sender: 'x', subject: 'Re: 문의', body: '답장', body_clean: '답장', occurred_at: at(min), edited });
}
/** 나간 답장 = SENT 초안 + 같은 시각의 발신 메시지(실제 발송 기록과 같은 모양). */
const sent = (r, action, by, min, sentBy = 'agent', finalBody = null) => { draft(r, action, 'SENT', by, min, finalBody); out(r, sentBy, min, finalBody ? 1 : 0); };

before(() => {
  db.init(':memory:');
  // 수신 → 기대 분류. 발신은 sent(...) 줄마다 하나
  const A = inbound('support', 0, { autoSubmitted: true }); // 자동 회신 무시 → 에이전트
  decide(A, 'prefilter', 'IGNORE', 'auto_reply_or_empty'); decide(A, 'execute', 'IGNORE', 'auto_reply_or_empty');
  const B = inbound('support', 10); // L2 자동 답변 → 수신·발신 에이전트
  decide(B, 'triage', 'CLASSIFIED', 'receipt'); decide(B, 'execute', 'DRAFT'); sent(B, 'DRAFT', AUTO, 25);
  const C = inbound('support', 20); // 사람 승인 → 수신·발신 보조. B의 자동 발송과 같은 시각 — 다른 케이스 초안과 잇지 않는다
  decide(C, 'triage', 'CLASSIFIED', 'feature_howto'); decide(C, 'execute', 'DRAFT'); sent(C, 'DRAFT', '검토자', 25);
  const D = inbound('support', 30); // 수정 후 승인 → 수신·발신 보조
  decide(D, 'triage', 'CLASSIFIED', 'login_issue'); decide(D, 'execute', 'DRAFT'); sent(D, 'DRAFT', '검토자', 31, 'agent', '고친 답장');
  const E = inbound('support', 40); // 분류 뒤 넘김 → 수신 보조, 접수 안내 발신 → 단위 아님(ackCount)
  decide(E, 'triage', 'CLASSIFIED', 'refund'); decide(E, 'execute', 'HANDOFF', 'refund_request'); decide(E, 'brief', 'HANDOFF', 'refund_request'); sent(E, 'ACK', AUTO, 41, 'ack');
  const F = inbound('support', 50); // 1차 거르기에서 바로 넘김(브리핑만 있음) → 사람
  decide(F, 'prefilter', 'HANDOFF', 'sender_unverified'); decide(F, 'execute', 'HANDOFF', 'sender_unverified'); decide(F, 'brief', 'HANDOFF', 'sender_unverified');
  const G = inbound('support', 60); // 분류 전에 사람이 맡은 케이스 → 수신 사람, 직접 답장 → 사람
  decide(G, 'gate1', 'IGNORE', 'responder_human'); decide(G, 'execute', 'IGNORE', 'responder_human'); sent(G, 'HUMAN_REPLY', '담당자', 61, 'human');
  const H = inbound('support', 70); // 승인 대기 초안 → 보조
  decide(H, 'triage', 'CLASSIFIED', 'feature_howto'); decide(H, 'execute', 'DRAFT'); draft(H, 'DRAFT', 'PENDING');
  const I = inbound('support', 80); // 감사 인사 무시 → 에이전트
  decide(I, 'triage', 'CLASSIFIED', 'ack'); decide(I, 'execute', 'IGNORE', 'ack');
  const L = inbound('support', 85); // 무시했다가 다시 판단해 넘김 — 마지막 execute 판단이 이긴다 → 보조
  decide(L, 'triage', 'CLASSIFIED', 'ack'); decide(L, 'execute', 'IGNORE', 'ack'); decide(L, 'triage', 'CLASSIFIED', 'complaint'); decide(L, 'execute', 'HANDOFF', 'complaint');
  const J = inbound('sales', 90); // 답장+넘김 승인 대기 → 보조
  decide(J, 'triage', 'CLASSIFIED', 'quote_request'); decide(J, 'execute', 'ANSWER_AND_HANDOFF', 'price_contract'); draft(J, 'ANSWER_AND_HANDOFF', 'PENDING');
  const K = inbound('sales', 100); // L2 자동 답변 → 수신·발신 에이전트
  decide(K, 'triage', 'CLASSIFIED', 'service_question'); decide(K, 'execute', 'DRAFT'); sent(K, 'DRAFT', AUTO, 101);
  const M = inbound('sales', 110); // 분류 뒤 넘김 + 접수 안내 → 수신 보조, 접수 안내는 sales ackCount
  decide(M, 'triage', 'CLASSIFIED', 'purchase_intent'); decide(M, 'execute', 'HANDOFF', 'purchase_intent'); sent(M, 'ACK', AUTO, 111, 'ack');
});

const counts = (o) => [o.total, o.agent, o.assisted, o.human];

test('세 갈래 × 수신·발신: 자동 답변·무시는 에이전트, 분류·초안 뒤 사람 결정은 보조, 1차 거르기 넘김·사람 전담·직접 답장은 사람, 접수 안내는 단위 밖', () => {
  const w = report.workload();
  assert.deepEqual(counts(w.byDirection.in), [13, 4, 7, 2]); // 에이전트 A B I K · 보조 C D E H L J M · 사람 F G
  assert.deepEqual(counts(w.byDirection.out), [5, 2, 2, 1]); // 에이전트 B K · 보조 C D · 사람 G — 접수 안내 E·M은 빠진다
  assert.deepEqual(counts(w), [18, 6, 9, 3]);
  assert.equal(w.ackCount, 2); assert.equal(w.pendingCount, 0);
  assert.equal(w.agentRate, 0.333); assert.equal(w.assistedRate, 0.5); assert.equal(w.humanRate, 0.167);
  assert.deepEqual([w.from, w.to, w.channel], [null, null, null]);
});

test('채널별 표 — 채널 이름순, 합이 전체와 같다', () => {
  const w = report.workload();
  assert.deepEqual(w.byChannel.map((r) => [r.channel, ...counts(r), r.ackCount, r.agentRate]), [['sales', 4, 2, 2, 0, 1, 0.5], ['support', 14, 4, 7, 3, 1, 0.286]]);
});

test('필터: channel, from 이상 · to 미만(발생 시각)', () => {
  assert.deepEqual(counts(report.workload({ channel: 'sales' })), [4, 2, 2, 0]);
  const w = report.workload({ from: at(60), to: at(80) }); // G 수신·직접 답장, H 수신 — I(80분)는 빠진다
  assert.deepEqual(counts(w), [3, 0, 1, 2]); assert.equal(w.ackCount, 0);
  assert.deepEqual(w.byChannel.map((r) => r.channel), ['support']);
  const none = report.workload({ channel: 'nope' });
  assert.deepEqual(counts(none), [0, 0, 0, 0]);
  assert.equal(none.agentRate, null); assert.deepEqual(none.byChannel, []);
});

test('읽는 테이블은 messages·cases·decisions·drafts뿐 — 발송 경로 테이블은 보지 않는다', () => {
  assert.deepEqual([...new Set([...report.WORKLOAD_SQL.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/g)].map((m) => m[1]))].sort(), ['cases', 'decisions', 'drafts', 'messages']);
});

test('쿼리 계획: 초안 하위 질의는 drafts_case 인덱스 — drafts_status(메시지마다 SENT 초안 전부 훑기)를 고르지 않는다', () => {
  const plan = db.all(`EXPLAIN QUERY PLAN ${report.WORKLOAD_SQL}`, null, null, null).map((r) => r.detail);
  assert.ok(plan.some((d) => d.includes('drafts_case')), plan.join('\n'));
  assert.ok(!plan.some((d) => d.includes('drafts_status')), plan.join('\n'));
});

test('GET /api/report/workload — 같은 집계, 날짜만은 UTC 자정, 시각은 Z·±hh:mm 필수, 잘못된 날짜는 400', async () => {
  const server = require('../server/index').createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/report/workload`;
  try {
    const r = await (await fetch(`${base}?channel=sales&from=2026-10-01`)).json();
    assert.deepEqual([...counts(r), r.ackCount], [4, 2, 2, 0, 1]);
    assert.deepEqual([r.from, r.channel], ['2026-10-01T00:00:00.000Z', 'sales']);
    assert.equal((await (await fetch(`${base}?from=2026-10-01T09:00%2B09:00`)).json()).from, '2026-10-01T00:00:00.000Z');
    for (const v of ['nope', '2026-10-01T00:00', '2026-10-01 00:00']) {
      const bad = await fetch(`${base}?to=${encodeURIComponent(v)}`);
      assert.equal(bad.status, 400, v); assert.deepEqual(await bad.json(), { error: 'bad_date', field: 'to' });
    }
  } finally { server.close(); }
});

test('실제 회차(mock LLM): L2 자동 발송의 수신·발신은 에이전트, 종결 케이스에 온 자동 회신(ABORTED)도 에이전트, 판단 전 수신은 pendingCount', async () => {
  llm.use('mock'); process.env.AUTO_SEND = '1';
  for (const k of ['MAIL_MOCK_FAIL', 'MAIL_MOCK_DELAY_MS', 'SHADOW_CHANNELS', 'MAIL_PROVIDER', 'INBOUND_SECRET']) delete process.env[k];
  const from = new Date().toISOString(); // 위 고정 행(2026-10-01)과 섞이지 않게 지금 이후만 본다
  const q = INQ.find((x) => x.id === 1); // 탈퇴 문의 — support L2
  const r = cases.addInbound({ ...q, threadId: 'wl-real', providerMessageId: 'wl-real-1' });
  await loop.runCycle(r.caseId, r.messageId);
  assert.equal(db.get("SELECT approved_by FROM drafts WHERE case_id=? AND status='SENT'", r.caseId).approved_by, AUTO);
  loop.closeCase(r.caseId, { by: '검토자' });
  // 종결 케이스에 붙는 자동 회신 — 1차 거르기 IGNORE, 케이스가 닫혀 있어 실행은 ABORTED
  const a = cases.addInbound({ channel: q.channel, from: q.from, subject: '자동 회신: 부재중', body: '부재중입니다.', threadId: 'wl-real', providerMessageId: 'wl-real-2', autoSubmitted: true });
  await loop.runCycle(a.caseId, a.messageId);
  assert.equal(db.get("SELECT action FROM decisions WHERE message_id=? AND step='execute'", a.messageId).action, 'ABORTED');
  cases.addInbound({ channel: 'support', from: 'pending@example.com', subject: '문의', body: '로그인이 안 됩니다', providerMessageId: 'wl-real-3' }); // 회차 전
  const w = report.workload({ from });
  assert.deepEqual(counts(w.byDirection.in), [2, 2, 0, 0]);
  assert.deepEqual(counts(w.byDirection.out), [1, 1, 0, 0], '실제 발송 기록의 초안·메시지 시각이 이어진다');
  assert.deepEqual([w.ackCount, w.pendingCount], [0, 1]);
  assert.deepEqual(w.byChannel.map((x) => [x.channel, x.pendingCount]), [['support', 1]]);
});
