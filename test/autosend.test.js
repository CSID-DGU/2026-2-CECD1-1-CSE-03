'use strict';
// L2 자동 발송 + 넘김 1차 응대(접수 안내). npm test는 AUTO_SEND=0(기존 L1 테스트)이라 이 파일은 각 테스트에서 직접 켠다.
process.env.MAIL_MOCK_LOG = '0';
const { test, beforeEach, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const INQ = require('../server/mock/inquiries');

const policy = require('../server/policy');
const http = require('node:http');
const notify = require('../server/notify');
const { createServer } = require('../server/index');

beforeEach(() => {
  db.init(':memory:'); llm.use('mock'); process.env.AUTO_SEND = '1';
  for (const k of ['MAIL_MOCK_FAIL', 'MAIL_MOCK_DELAY_MS', 'SHADOW_CHANNELS', 'MAIL_PROVIDER', 'INBOUND_SECRET']) delete process.env[k];
});

let n = 0;
async function run(id, extra = {}) {
  const q = INQ.find((x) => x.id === id);
  const r = cases.addInbound({ ...q, threadId: `l2-${id}-${++n}`, providerMessageId: `l2m-${id}-${n}`, ...extra });
  const out = await loop.runCycle(r.caseId, r.messageId);
  return { ...r, out, c: db.get('SELECT * FROM cases WHERE id=?', r.caseId), drafts: db.all('SELECT * FROM drafts WHERE case_id=? ORDER BY rowid', r.caseId) };
}
const acts = (caseId) => db.all('SELECT type, actor FROM activities WHERE case_id=? ORDER BY rowid', caseId).map((a) => a.type);
const outs = (caseId) => db.get("SELECT COUNT(*) n FROM messages WHERE case_id=? AND direction='out'", caseId).n;

test('L2 intent(탈퇴) → 승인 없이 같은 발송 경로로 SENT, 케이스는 고객 회신 대기', async () => {
  const r = await run(1);
  assert.equal(r.drafts.length, 1);
  assert.equal(r.drafts[0].status, 'SENT');
  assert.equal(r.drafts[0].approved_by, 'agent:auto');
  assert.equal(r.c.state, 'WAITING_CUSTOMER');
  assert.equal(r.c.responder, 'agent');
  assert.ok(acts(r.caseId).includes('auto_send'));
  assert.equal(outs(r.caseId), 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM dispatches WHERE draft_id=?', r.drafts[0].id).n, 1);
  const ex = JSON.parse(db.get("SELECT output FROM decisions WHERE case_id=? AND step='execute'", r.caseId).output);
  assert.equal(ex.autoSend, true);
});

test('L1 intent(로그인) → 자동 발송 없이 승인 대기', async () => {
  const r = await run(8);
  assert.equal(r.c.state, 'AWAITING_APPROVAL');
  assert.equal(r.drafts[0].status, 'PENDING');
  assert.equal(outs(r.caseId), 0);
});

test('넘김(환불) → 접수 안내를 자동 발송, 케이스는 사람 전담 그대로, 브리핑도 있다', async () => {
  const r = await run(4);
  assert.equal(r.c.state, 'HANDED_OFF');
  assert.equal(r.c.responder, 'human');
  const ack = r.drafts.find((d) => d.action === 'ACK');
  assert.ok(ack, '접수 안내 초안');
  assert.equal(ack.status, 'SENT');
  assert.equal(ack.approved_by, 'agent:auto');
  assert.doesNotMatch(ack.original_body, /환불|\d/);
  assert.ok(acts(r.caseId).includes('auto_ack'));
  assert.equal(outs(r.caseId), 1);
  assert.ok(JSON.parse(db.get('SELECT briefing FROM handoffs WHERE case_id=?', r.caseId).briefing).summary);
});

test('지시 변경 시도(injection) 넘김엔 접수 안내를 보내지 않는다', async () => {
  const r = await run(9);
  assert.equal(r.c.state, 'HANDED_OFF');
  assert.equal(r.drafts.filter((d) => d.action === 'ACK').length, 0);
  assert.equal(outs(r.caseId), 0);
});

test('접수 안내는 케이스당 한 번 — 반환 뒤 다시 넘겨도 두 번째는 없다', async () => {
  const r = await run(4);
  await loop.returnToAgent(r.caseId, { by: 'kim' });
  assert.equal(db.get('SELECT responder FROM cases WHERE id=?', r.caseId).responder, 'human', '같은 환불 메시지를 다시 판단해 또 넘긴다');
  assert.equal(db.all("SELECT 1 FROM drafts WHERE case_id=? AND action='ACK'", r.caseId).length, 1);
});

test('AUTO_SEND=0 → L2 intent도 승인 대기, 넘김에 접수 안내 없음', async () => {
  process.env.AUTO_SEND = '0';
  const a = await run(1);
  assert.equal(a.drafts[0].status, 'PENDING');
  assert.equal(a.c.state, 'AWAITING_APPROVAL');
  const b = await run(4);
  assert.equal(b.drafts.filter((d) => d.action === 'ACK').length, 0);
});

test('자동 발송 실패 → 초안은 PENDING으로 남아 사람이 승인, 접수 안내 실패는 DISCARDED', async () => {
  process.env.MAIL_MOCK_FAIL = '1';
  const a = await run(1);
  assert.equal(a.drafts[0].status, 'PENDING');
  assert.ok(acts(a.caseId).includes('auto_send_failed'));
  const b = await run(4);
  assert.equal(b.drafts.find((d) => d.action === 'ACK').status, 'DISCARDED');
  assert.equal(b.c.state, 'HANDED_OFF');
});

test('통계: 자동 발송·접수 안내는 무수정 승인률·승격 지표에 안 들어가고, 1차 응대 3분류로 센다', async () => {
  await run(1); // 완전 자동응대
  await run(4); // 접수 안내 + 넘김
  await run(8); // 승인 대기 초안
  await run(9); // 지시 변경 시도 — 응대 못함
  await run(11); // 감사 인사 — 처음부터 무시로 닫힘(분모 밖)
  const s = cases.stats();
  assert.equal(s.approvedNoEdit, 0);
  assert.equal(s.promotion.support.reviewed, 0);
  assert.deepEqual({ ...s.firstResponse, rate: undefined }, { base: 4, auto: 1, handedOff: 2, none: 1, human: 2, rate: undefined });
  assert.equal(s.firstResponse.rate, 0.75);
});

test('알림: 자동 발송될 초안은 승인 대기로 알리지 않고, 자동 발송이 막혀 PENDING으로 남으면 알린다', async () => {
  const notify = require('../server/notify');
  const got = []; const realFetch = global.fetch;
  global.fetch = async (_u, o) => { got.push(JSON.parse(o.body).text); return { ok: true }; };
  const stop = notify.start('http://hook.invalid');
  try {
    await run(1);
    assert.ok(!got.some((t) => /승인 대기/.test(t)), got.join('\n'));
    process.env.MAIL_MOCK_FAIL = '1';
    await run(1);
    assert.ok(got.some((t) => /자동 발송 막힘 — 승인 대기 초안/.test(t)), got.join('\n'));
  } finally { stop(); global.fetch = realFetch; }
});

test('발송 확인 필요(SENDING 고착) 접수 안내를 "발송됨"으로 처리해도 답으로 치지 않는다', async () => {
  const r = await run(4);
  const ack = r.drafts.find((d) => d.action === 'ACK');
  db.run("DELETE FROM messages WHERE case_id=? AND direction='out'", r.caseId);
  db.run("UPDATE drafts SET status='SENDING', approved_at=? WHERE id=?", new Date(Date.now() - 10 * 60_000).toISOString(), ack.id);
  loop.resolveSending(ack.id, { by: 'kim', outcome: 'sent' });
  const m = db.get("SELECT sent_by, body FROM messages WHERE case_id=? AND direction='out'", r.caseId);
  assert.equal(m.sent_by, 'ack');
  assert.match(m.body, /자동으로 보냈습니다/);
});

test('통계: 사람 직접 답장만 나간 케이스는 에이전트 1차 응대가 아니다(응대 못함)', async () => {
  const r = await run(9); // 지시 변경 시도 — 접수 안내 없음
  await loop.humanReply(r.caseId, { by: 'kim', body: '확인 후 다시 안내드리겠습니다.' });
  const fr = cases.stats().firstResponse;
  assert.equal(fr.base, 1);
  assert.equal(fr.handedOff, 0);
  assert.equal(fr.none, 1);
});

test('kill switch는 켜는 값일 때만 켠다(fail-closed), smtp인데 수신 시크릿이 없으면 끈다', () => {
  for (const v of ['0', 'false', 'off', ' 0', 'no', 'flase']) { process.env.AUTO_SEND = v; assert.equal(policy.autoSendOn(), false, JSON.stringify(v)); }
  for (const v of ['1', 'true', 'ON', ' yes ']) { process.env.AUTO_SEND = v; assert.equal(policy.autoSendOn(), true, JSON.stringify(v)); }
  process.env.AUTO_SEND = ''; assert.equal(policy.autoSendOn(), true, '빈 값 = 기본값(켬) — .env.example 템플릿 그대로');
  delete process.env.AUTO_SEND; assert.equal(policy.autoSendOn(), true, '없으면 켬(기본값)');
  process.env.MAIL_PROVIDER = 'smtp'; assert.equal(policy.autoSendOn(), false);
  process.env.INBOUND_SECRET = 's'; assert.equal(policy.autoSendOn(), true);
});

test('섀도 채널: 자동 발송도 접수 안내도 없다', async () => {
  process.env.SHADOW_CHANNELS = 'support';
  const a = await run(1);
  assert.equal(a.drafts[0].status, 'SHADOW');
  const b = await run(4);
  assert.equal(b.drafts.filter((d) => d.action === 'ACK').length, 0);
  assert.equal(outs(a.caseId) + outs(b.caseId), 0);
});

test('같은 케이스 답장이 발송 중이면 자동 발송은 그 답장을 못 본 채 나가지 않는다(409 sending → PENDING)', async () => {
  const q8 = INQ.find((x) => x.id === 8); const q1 = INQ.find((x) => x.id === 1);
  const r = cases.addInbound({ ...q8, threadId: 'race', providerMessageId: 'race-1' });
  await loop.runCycle(r.caseId, r.messageId);
  const d1 = db.get("SELECT id FROM drafts WHERE case_id=? AND status='PENDING'", r.caseId).id;
  process.env.MAIL_MOCK_DELAY_MS = '60';
  const sending = loop.approveDraft(d1, { by: 'kim' });
  delete process.env.MAIL_MOCK_DELAY_MS;
  const r2 = cases.addInbound({ ...q1, from: q8.from, threadId: 'race', providerMessageId: 'race-2' });
  await loop.runCycle(r.caseId, r2.messageId);
  await sending;
  const d2 = db.get('SELECT * FROM drafts WHERE case_id=? AND trigger_message_id=?', r.caseId, r2.messageId);
  assert.equal(d2.status, 'PENDING');
  assert.equal(outs(r.caseId), 1, '발송 중이던 답장 하나만');
  assert.ok(db.get("SELECT 1 FROM activities WHERE case_id=? AND type='auto_send_failed' AND payload LIKE '%sending%'", r.caseId));
});

test('자동 메일은 고객이 넣은 제목·이름도 검사한다 — 링크·연락처가 있으면 안 보낸다', async () => {
  const a = await run(1, { subject: '확인 http://evil.example/login 010-1234-5678' });
  assert.equal(a.drafts[0].status, 'PENDING');
  assert.equal(outs(a.caseId), 0);
  const p = await run(1, { subject: '탈퇴 문의 — 상담 010-1234-5678' });
  assert.equal(p.drafts[0].status, 'PENDING', '전화번호만 있어도');
  const e = await run(1, { subject: '문의 폼 접수: someone@example.com' });
  assert.equal(e.drafts[0].status, 'SENT', '폼 제목의 메일 주소는 막지 않는다');
  for (const subject of ['확인 https://evil.example/login?u=a@b.co', '확인 https://x@evil.example/login']) {
    const u = await run(1, { subject });
    assert.equal(u.drafts[0].status, 'PENDING', `@ 들어간 링크도 막는다: ${subject}`);
  }
  const b = await run(4, { name: 'www.evil.com' });
  assert.equal(b.drafts.filter((d) => d.action === 'ACK').length, 0);
  assert.equal(outs(b.caseId), 0);
  assert.equal(b.c.state, 'HANDED_OFF');
});

test('통계: 응대 못한 케이스는 닫아도 분모에서 안 빠진다, 접수 안내는 직전 답 요약을 덮지 않는다', async () => {
  const r = await run(9);
  loop.closeCase(r.caseId, { by: 'kim' });
  const fr = cases.stats().firstResponse;
  assert.equal(fr.base, 1);
  assert.equal(fr.none, 1);
  const b = await run(4);
  assert.equal(db.get('SELECT last_outbound_gist g FROM loops WHERE case_id=?', b.caseId).g, null);
});

test('팩 ackReply 검증 — ko 필수, 빈 문자열 금지', () => {
  const ok = policy.load('support');
  const bad = (ackReply) => () => policy.validate({ ...JSON.parse(JSON.stringify(ok)), ackReply }, 'x');
  assert.throws(bad({ en: 'hi' }), /ackReply/);
  assert.throws(bad({ ko: ' ' }), /ackReply/);
  assert.throws(bad({ ko: '접수', en: '' }), /ackReply/);
  assert.doesNotThrow(bad({ ko: '접수했습니다.' }));
});

test('통계는 케이스 수에 선형 — 상태 조건이 케이스당 초안 인덱스를 버리지 않는다', () => {
  const now = db.now();
  db.tx(() => {
    for (let i = 0; i < 5000; i += 1) {
      const id = `perf-${i}`;
      db.insert('cases', { id, channel: 'support', customer_email: `p${i}@example.com`, customer_name: 'p', subject: 's', state: 'WAITING_CUSTOMER', responder: 'agent', created_at: now, updated_at: now });
      const msg = (dir) => ({ id: `pm-${dir}-${i}`, case_id: id, thread_id: `pt-${i}`, direction: dir, sent_by: dir === 'out' ? 'agent' : null, sender: 'x', body: 'b', body_clean: 'b', occurred_at: now });
      db.insert('messages', msg('in')); db.insert('messages', msg('out'));
      db.insert('drafts', { id: `pd-${i}`, case_id: id, trigger_message_id: `pm-in-${i}`, status: 'SENT', action: 'DRAFT', original_body: 'b', used_facts: '[]', idempotency_key: `pk-${i}`, approved_by: 'agent:auto', created_at: now });
    }
  });
  const t0 = Date.now(); const fr = cases.stats().firstResponse; const ms = Date.now() - t0;
  assert.equal(fr.base, 5000); assert.equal(fr.auto, 5000);
  assert.ok(ms < 300, `stats ${ms}ms`);
});

describe('알림 웹훅', () => {
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); process.env.AUTO_SEND = '0'; for (const k of ['SHADOW_CHANNELS', 'AUTH_USER_HEADER', 'NODE_ENV', 'AUTO_CLOSE_DAYS', 'ENABLE_TEST_INJECT', 'INBOUND_SECRET']) delete process.env[k]; });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `cf-${n}`; const from = `cf${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }

  test('알림 웹훅: 넘김·승인 대기 초안만, 고객 연락처·본문 없이', async () => {
    const got = [];
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const stop = notify.start(`http://127.0.0.1:${srv.address().port}/hook`);
    try {
      await thread().run('환불해 주세요. 제 번호는 010-9999-8888 입니다');
      await thread().run('구독 해지 방법 알려주세요');
      for (let i = 0; i < 50 && got.length < 2; i += 1) await sleep(10);
    } finally { stop(); srv.close(); }
    const texts = got.map((g) => g.text);
    assert.ok(texts.some((t) => /사람에게 넘김: refund_request/.test(t) && /#cs-support/.test(t)));
    assert.ok(texts.some((t) => /승인 대기 초안/.test(t)));
    for (const t of texts) { assert.doesNotMatch(t, /@|9999|환불해/); }
  });
});
