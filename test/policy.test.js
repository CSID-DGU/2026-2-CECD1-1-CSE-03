'use strict';
process.env.MAIL_MOCK_LOG = '0';
const { test, before, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../server/policy');
const db = require('../server/db');
const llm = require('../server/llm');
const mock = require('../server/llm/mock');
const cases = require('../server/cases');
const loop = require('../server/loop');

const pack = policy.load('support');
const sales = policy.load('sales');
const tri = (o) => ({ intent: 'receipt', handoffReason: null, confidence: 0.92, kbHit: true, ...o });
// rule·inputs는 따로 본다 — 여기선 행동과 사유만
const decide = (o, p = pack) => { const d = policy.decide({ pack: p, ...o }); return d.reason === undefined ? { action: d.action } : { action: d.action, reason: d.reason }; };

test('1 ack/ignore → IGNORE', () => {
  assert.equal(decide({ triage: tri({ intent: 'ack' }) }).action, 'IGNORE');
  assert.equal(decide({ triage: tri({ intent: 'ignore' }) }).action, 'IGNORE');
});
test('2 H 등급 → HANDOFF(사유 = handoffReason ?? 팩 reason)', () => {
  assert.deepEqual(decide({ triage: tri({ intent: 'refund', handoffReason: 'refund_request', kbHit: false }) }), { action: 'HANDOFF', reason: 'refund_request' });
  assert.deepEqual(decide({ triage: tri({ intent: 'refund', kbHit: false }) }), { action: 'HANDOFF', reason: 'refund_request' });
  assert.deepEqual(decide({ triage: tri({ handoffReason: 'human_request', kbHit: false }) }), { action: 'HANDOFF', reason: 'human_request' });
});
test('2b 팩에 없는 사유는 unclear로', () => {
  assert.equal(decide({ triage: tri({ intent: 'legal', handoffReason: 'made_up' }) }).reason, 'legal_threat');
  assert.equal(decide({ triage: tri({ handoffReason: 'made_up', kbHit: false }) }).reason, 'unclear');
});
test('3 되묻기 연속 → no_progress', () => assert.equal(decide({ triage: tri(), repeatStreak: 2 }).reason, 'no_progress'));
test('4 confidence < 0.8 → low_confidence', () => assert.equal(decide({ triage: tri({ confidence: 0.7 }) }).reason, 'low_confidence'));
test('5 rounds ≥ 10 → round_limit', () => assert.equal(decide({ triage: tri(), rounds: 10 }).reason, 'round_limit'));
test('6 팩에 없는 intent → unclear', () => assert.equal(decide({ triage: tri({ intent: 'nope' }) }).reason, 'unclear'));
test('7 kbHit false → out_of_knowledge', () => assert.equal(decide({ triage: tri({ kbHit: false }) }).reason, 'out_of_knowledge'));
test('8 guard 전 → COMPOSE', () => assert.equal(decide({ triage: tri() }).action, 'COMPOSE'));
test('9 guard 실패 → guard_failed', () => assert.equal(decide({ triage: tri(), guard: { pass: false } }).reason, 'guard_failed'));
test('10 shadow → SHADOW', () => assert.equal(decide({ triage: tri(), guard: { pass: true } }, { ...pack, shadow: true }).action, 'SHADOW'));
test('11 quote_request / partial / 답 가능 handoff → ANSWER_AND_HANDOFF', () => {
  assert.deepEqual(decide({ triage: tri({ intent: 'quote_request' }), guard: { pass: true } }, sales), { action: 'ANSWER_AND_HANDOFF', reason: 'price_contract' });
  assert.deepEqual(decide({ triage: tri({ kbHit: 'partial' }), guard: { pass: true } }), { action: 'ANSWER_AND_HANDOFF', reason: 'out_of_knowledge' });
  assert.deepEqual(decide({ triage: tri({ handoffReason: 'call_meeting', kbHit: true }), guard: { pass: true } }), { action: 'ANSWER_AND_HANDOFF', reason: 'call_meeting' });
});
test('12 그 밖에 → DRAFT', () => assert.deepEqual(decide({ triage: tri(), guard: { pass: true } }), { action: 'DRAFT' }));
test('rule 번호·입력값이 결과에 들어간다', () => {
  const d = policy.decide({ pack, triage: tri({ confidence: 0.5 }) });
  assert.equal(d.rule, 4); assert.equal(d.inputs.confidence, 0.5); assert.equal(d.inputs.confidenceMin, 0.8);
  assert.equal(policy.decide({ pack, triage: tri(), guard: { pass: true } }).rule, 12);
});
test('팩 3개 로드, 버전 해시 있음', () => {
  const all = policy.all();
  assert.deepEqual(all.map((p) => p.channel), ['onboarding', 'sales', 'support']);
  all.forEach((p) => assert.match(p.version, /^[0-9a-f]{8}$/));
});
test('P1 출하 팩 intent(ack·ignore 제외) 전부 caseType·caseReason이 값 집합 안, 잘못된 값은 validate가 거부, reason 검사는 그대로', () => {
  const crm = require('../server/crm');
  for (const p of policy.all()) {
    for (const [k, def] of Object.entries(p.intents)) {
      if (k === 'ack' || k === 'ignore') { assert.equal(def.caseType, undefined, `${p.channel}.${k}`); continue; }
      assert.ok(crm.CASE_TYPES.includes(def.caseType), `${p.channel}.${k}.caseType=${def.caseType}`);
      assert.ok(crm.CASE_REASONS.includes(def.caseReason), `${p.channel}.${k}.caseReason=${def.caseReason}`);
    }
  }
  const base = { ...pack, intents: { receipt: { level: 'L2', caseType: 'Question', caseReason: 'billing' }, bare: { level: 'L1' } } };
  assert.equal(policy.validate(base), base, '없어도 통과(테스트용 팩)');
  assert.throws(() => policy.validate({ ...base, intents: { receipt: { level: 'L2', caseType: 'Bug' } } }), /caseType=Bug/);
  assert.throws(() => policy.validate({ ...base, intents: { receipt: { level: 'L2', caseReason: 'refund' } } }), /caseReason=refund/);
  assert.throws(() => policy.validate({ ...base, intents: { refund: { level: 'H', reason: 'nope', caseType: 'Problem', caseReason: 'billing' } } }), /reason=nope가 handoffReasons에 없음/);
});

test('잘못된 팩은 로드할 때 바로 실패한다', () => {
  const ok = policy.load('support');
  const bad = (patch) => () => policy.validate({ ...JSON.parse(JSON.stringify(ok)), ...patch }, 'x');
  assert.throws(bad({ maxLevel: 'L3' }), /maxLevel/);
  assert.throws(bad({ thresholds: { ...ok.thresholds, confidenceMin: '0.8' } }), /confidenceMin/);
  assert.throws(bad({ intents: { refund: { level: 'L9' } } }), /level/);
  assert.throws(bad({ intents: { refund: { level: 'H', reason: 'nope' } } }), /reason=nope/);
  assert.doesNotThrow(() => policy.all());
});

describe('팩 로드 검증과 H intent 사유 매핑', () => {
  const packs = { support: policy.load('support'), onboarding: policy.load('onboarding'), sales: policy.load('sales') };

  test('팩에 injection·legal_threat·human_request가 없으면 로드에서 실패', () => {
    const ok = JSON.parse(JSON.stringify(packs.support));
    for (const r of ['injection', 'legal_threat', 'human_request']) {
      assert.throws(() => policy.validate({ ...ok, handoffReasons: ok.handoffReasons.filter((x) => x !== r) }, 'x'), new RegExp(r));
    }
    assert.doesNotThrow(() => policy.all());
  });

  test('새 H intent는 팩 사유로 넘긴다', () => {
    const tri = (intent) => ({ intent, handoffReason: null, confidence: 0.95, kbHit: true });
    for (const [ch, intent, reason] of [['support', 'pricing_exception', 'pricing'], ['support', 'access_grant', 'policy_exception'], ['support', 'custom_data', 'custom_data'],
      ['onboarding', 'trial_access', 'policy_exception'], ['sales', 'custom_quote', 'price_contract'], ['sales', 'list_request', 'list_request']]) {
      const d = policy.decide({ pack: packs[ch], triage: tri(intent) });
      assert.deepEqual([d.action, d.reason], ['HANDOFF', reason], `${ch}/${intent}`);
    }
  });
});

describe('영수증 + 환불 분류', () => {
  before(() => { db.init(':memory:'); });
  beforeEach(() => { llm.use('mock'); for (const k of ['LLM_MOCK_DELAY_MS', 'MAIL_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL']) delete process.env[k]; });

  let n = 0;
  function thread(channel = 'support') {
    n += 1;
    const tid = `rf-${n}`; const from = `rf${n}@example.com`;
    const add = (body, o = {}) => cases.addInbound({ channel, from, name: `고객${n}`, subject: '문의', body, threadId: tid, ...o });
    return { tid, from, add, run: async (body, o) => { const r = add(body, o); await loop.runCycle(r.caseId, r.messageId); return r; } };
  }
  const lastExec = (id) => ({ ...db.get("SELECT action, reason FROM decisions WHERE case_id=? AND step='execute' ORDER BY rowid DESC LIMIT 1", id) });

  test('현실적인 분류(영수증 + 환불, kbHit partial) → 답장+넘김이 아니라 통째 넘김', async () => {
    const triage = { intent: 'receipt', handoffReason: 'refund_request', confidence: 0.9, kbHit: 'partial', kbSections: ['receipt'], riskSignals: [], questionSummary: '영수증과 환불', handoffTopic: '환불', repeatsPrevious: false, language: 'ko', evidence: [] };
    llm.use({ name: 'stub', json: async (req) => (req.agent === 'triage' ? triage : mock.json(req)) });
    const r = await thread().run('지난달 영수증 발급 부탁드리고, 이번 달 결제는 환불해 주세요.');
    assert.deepEqual(lastExec(r.caseId), { action: 'HANDOFF', reason: 'refund_request' });
    const pack = policy.load('support');
    const d = (o) => policy.decide({ pack, triage: { ...triage, handoffReason: null, kbHit: true, riskSignals: [], ...o }, guard: { pass: true } });
    assert.deepEqual([d({ handoffReason: 'injection' }).action, d({ handoffReason: 'injection' }).reason], ['HANDOFF', 'injection']);
    assert.deepEqual([d({ riskSignals: ['refund'] }).action, d({ riskSignals: ['refund'] }).reason], ['HANDOFF', 'refund_request']);
    assert.deepEqual([d({ riskSignals: ['legal'] }).reason, d({ riskSignals: ['complaint'] }).reason], ['legal_threat', 'complaint']);
    assert.equal(d({ handoffReason: 'call_meeting' }).action, 'ANSWER_AND_HANDOFF', '답해도 되는 사유는 섞여도 답한다');
  });
});
