'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const { normalize } = require('../server/agents/triage');
const INQUIRIES = require('../server/mock/inquiries');

before(() => { db.init(':memory:'); llm.use('mock'); });

const lastExec = (id) => db.get("SELECT action FROM decisions WHERE case_id=? AND step='execute' ORDER BY created_at DESC, rowid DESC LIMIT 1", id);
const triageOut = (id) => JSON.parse(db.get("SELECT output FROM decisions WHERE case_id=? AND step='triage' ORDER BY rowid DESC LIMIT 1", id).output);
const ask = async (body, n) => {
  const r = cases.addInbound({ channel: 'support', from: `sig${n}@example.com`, subject: '문의', body, threadId: `sig-${n}`, providerMessageId: `sig-m${n}` });
  await loop.runCycle(r.caseId, r.messageId);
  return r.caseId;
};

test('normalize: 범위를 맞추고 빠진 값은 기본값, customerWants는 마스킹 후 80자', () => {
  const base = { questionSummary: 'q' };
  const d = normalize(base);
  assert.deepEqual([d.sentiment, d.urgency, d.threat, d.customerWants], [1, 'normal', false, '']);
  assert.equal(normalize({ ...base, sentiment: 9 }).sentiment, 5);
  assert.equal(normalize({ ...base, sentiment: -2 }).sentiment, 1);
  assert.equal(normalize({ ...base, sentiment: 'x', urgency: 'now', threat: 'yes' }).urgency, 'normal');
  const w = normalize({ ...base, customerWants: `연락처 010-1234-5678 ${'가'.repeat(100)}` }).customerWants;
  assert.ok(w.length <= 80 && !w.includes('010-1234-5678'));
});

test('mock 등급: 화난 문의는 높고 차분한 문의는 1', async () => {
  const angry = await ask('영수증이 안 와요 사기 아니에요? 정말 화나고 최악입니다!! 오늘 당장 처리해 주세요', 1);
  const calm = await ask('영수증은 어디서 받을 수 있나요?', 2);
  const a = triageOut(angry); const c = triageOut(calm);
  assert.ok(a.sentiment >= 4 && a.urgency === 'high', JSON.stringify(a));
  assert.deepEqual([c.sentiment, c.urgency, c.threat], [1, 'normal', false]);
  assert.equal(triageOut(await ask('가만 안 둔다 찾아가겠다 환불해', 3)).threat, true);
});

test('목록 API: 접수한 케이스는 signals, 안 한 케이스는 null', async () => {
  const id = await ask('영수증은 어디서 받을 수 있나요?', 4);
  const bare = cases.addInbound({ channel: 'support', from: 'bare@example.com', subject: 's', body: '아직 처리 안 한 문의', threadId: 'sig-bare', providerMessageId: 'sig-mb' });
  const list = cases.listCases({ limit: 500 });
  assert.deepEqual(list.find((c) => c.id === id).signals, { sentiment: 1, urgency: 'normal', threat: false });
  assert.equal(list.find((c) => c.id === bare.caseId).signals, null);
});

test('합성 문의 20건: 감정 신호를 붙여도 행동은 그대로', async () => {
  for (const q of INQUIRIES) {
    const r = cases.addInbound({ ...q, threadId: `sd-${q.id}`, providerMessageId: `sdm-${q.id}` });
    await loop.runCycle(r.caseId, r.messageId);
    assert.equal(lastExec(r.caseId).action, q.expect.action, `#${q.id}`);
  }
});
