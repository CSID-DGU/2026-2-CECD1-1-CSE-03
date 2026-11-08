'use strict';
// AI 표시 문구 — 시스템이 내보내는 모든 메일 본문(자동 발송·접수 안내·승인 발송)에 들어간다. 발송 방식이 아니라 문구를 본다.
process.env.MAIL_MOCK_LOG = '0';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const mail = require('../server/mail');
const INQ = require('../server/mock/inquiries');

beforeEach(() => {
  db.init(':memory:'); llm.use('mock'); process.env.AUTO_SEND = '1';
  for (const k of ['MAIL_MOCK_FAIL', 'MAIL_MOCK_DELAY_MS', 'SHADOW_CHANNELS', 'MAIL_PROVIDER', 'INBOUND_SECRET']) delete process.env[k];
});

const KO_GREETING = /AI 상담 에이전트/;
const EN_GREETING = /the AI support agent/;
const KO_AUTO = /AI 상담 에이전트가 자동으로 보냈습니다/;
const KO_REVIEWED = /담당자 검토 후 발송/;
const EN_AUTO = /sent automatically by our AI support agent/;
const EN_REVIEWED = /sent after review by our staff/;

let n = 0;
async function run(id, extra = {}) {
  const q = INQ.find((x) => x.id === id);
  const r = cases.addInbound({ ...q, threadId: `dis-${id}-${++n}`, providerMessageId: `dism-${id}-${n}`, ...extra });
  await loop.runCycle(r.caseId, r.messageId);
  return r;
}
const outBodies = (caseId) => db.all("SELECT body FROM messages WHERE case_id=? AND direction='out' ORDER BY rowid", caseId).map((m) => m.body);

test('자동 발송 L2 답장: 인사 줄에 AI 표시, 맺음은 자동 발송 문구', async () => {
  const r = await run(1);
  const [body] = outBodies(r.caseId);
  assert.match(body, KO_GREETING);
  assert.match(body, KO_AUTO);
  assert.doesNotMatch(body, KO_REVIEWED);
});

test('접수 안내(ko·en): 나간 메일마다 AI 표시와 자동 발송 문구', async () => {
  const ko = await run(4);
  const [kb] = outBodies(ko.caseId);
  assert.match(kb, KO_GREETING); assert.match(kb, KO_AUTO);
  const en = await run(4, { body: 'I was charged yesterday without using the service. Please refund me.', subject: 'Refund request' });
  const [eb] = outBodies(en.caseId);
  assert.ok(eb, '영어 접수 안내가 나갔다');
  assert.match(eb, EN_GREETING); assert.match(eb, EN_AUTO);
});

test('팩 3종의 ackReply ko·en: 렌더하면 AI 표시와 자동 발송 문구가 붙는다', () => {
  for (const ch of ['support', 'sales', 'onboarding']) {
    const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'policy', `${ch}.json`), 'utf8'));
    assert.ok(pack.ackReply?.ko && pack.ackReply?.en, `${ch}: ackReply ko·en`);
    const ko = mail.renderAgent({ name: '고객', body: pack.ackReply.ko, auto: true });
    const en = mail.renderAgent({ name: 'Customer', body: pack.ackReply.en, auto: true });
    assert.match(ko, KO_GREETING); assert.match(ko, KO_AUTO);
    assert.match(en, EN_GREETING); assert.match(en, EN_AUTO);
  }
});

test('승인 발송 초안: AI 표시와 담당자 검토 문구', async () => {
  const r = await run(8);
  const d = db.get("SELECT id FROM drafts WHERE case_id=? AND status='PENDING'", r.caseId);
  assert.ok(d);
  await loop.approveDraft(d.id, { by: 'kim' });
  const [body] = outBodies(r.caseId);
  assert.match(body, KO_GREETING);
  assert.match(body, KO_REVIEWED);
  assert.doesNotMatch(body, KO_AUTO);
});

test('renderAgent ko·en × 자동·검토 4종 모두 인사 줄에 AI 표시', () => {
  for (const auto of [true, false]) {
    assert.match(mail.renderAgent({ name: 'a', body: '안내', auto }).split('\n')[1], KO_GREETING);
    assert.match(mail.renderAgent({ name: 'a', body: 'hello', auto }).split('\n')[1], EN_GREETING);
  }
  assert.match(mail.renderAgent({ name: 'a', body: '안내', auto: true }), KO_AUTO);
  assert.match(mail.renderAgent({ name: 'a', body: '안내' }), KO_REVIEWED);
  assert.match(mail.renderAgent({ name: 'a', body: 'hello', auto: true }), EN_AUTO);
  assert.match(mail.renderAgent({ name: 'a', body: 'hello' }), EN_REVIEWED);
});
