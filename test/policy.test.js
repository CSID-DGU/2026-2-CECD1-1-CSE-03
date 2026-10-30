'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../server/policy');

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
