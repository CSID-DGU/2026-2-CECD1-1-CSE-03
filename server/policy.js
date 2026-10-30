'use strict';
// 채널 정책 팩 로더 + 판단 함수. 허용 범위는 팩(코드 리뷰 대상)이 정하고, 설정(env)은 그 안에서 좁히기만 한다.
const fs = require('node:fs');
const path = require('node:path');
const { sha } = require('./kb');

const DIR = path.join(__dirname, '..', 'policy');
const LEVELS = ['L0', 'L1', 'L2', 'H'];
// L2 = 승인 없이 자동 발송. 팩 maxLevel과 intent level이 둘 다 L2일 때만(env는 좁히기만 한다).
// AUTO_SEND는 켜는 값(1·true·on·yes, 없거나 빈 값이면 켬 — 2026-10-27 결정, .env.example의 "빈 값 = 기본값")일 때만 켠다. 0·false·off·오타는 끈다(fail-closed).
// 실발송(smtp)인데 수신 시크릿이 없으면 끈다 — 누구나 /api/inbound로 우리 도메인 자동 메일을 아무 주소에나 보내게 된다.
const autoSendOn = () => ['1', 'true', 'on', 'yes'].includes(String(process.env.AUTO_SEND || '1').trim().toLowerCase())
  && !(process.env.MAIL_PROVIDER === 'smtp' && !process.env.INBOUND_SECRET);
/** 이 채널에서 지금 사람 승인 없이 보내도 되나(섀도 채널 제외). 판단(decide)·승인(approveDraft)·접수 안내(sendAck)가 같이 쓴다. */
const autoAllowed = (pack) => autoSendOn() && pack.maxLevel === 'L2' && !pack.shadow;
// 사람 신호지만 "다른 질문엔 답하고 그 신호만 넘겨도 되는" 사유. 이 밖의 사유(환불·분쟁·법적·주입 등)는 섞여도 통째로 넘긴다.
const DEFAULT_ANSWERABLE = ['human_request', 'call_meeting', 'contract_documents', 'purchase_intent', 'out_of_knowledge', 'price_contract'];
// 위험 신호 → 넘김 사유. triage가 riskSignals에 하나라도 적으면 kbHit와 무관하게 통째로 넘긴다.
const RISK_REASON = { refund: 'refund_request', legal: 'legal_threat', complaint: 'complaint', injection: 'injection' };
// L0 → L1 승격 기준(채널 단위). 코드 상수 — 바꾸려면 코드 리뷰.
const PROMOTION = { minReviewed: 50, minNoEditRate: 0.9, maxCritical: 0 };
const REQUIRED_REASONS = ['injection', 'legal_threat', 'human_request'];

/** 팩이 잘못되면 시작할 때 바로 죽는다 — 잘못된 팩으로 루프가 도는 것보다 낫다. */
function validate(pack, name = pack?.channel) {
  const errs = [];
  if (!pack || typeof pack !== 'object') throw new Error(`정책 팩 ${name}: 객체가 아님`);
  if (!LEVELS.includes(pack.maxLevel)) errs.push(`maxLevel=${pack.maxLevel} (L0|L1|L2|H)`);
  if (!Array.isArray(pack.handoffReasons) || !pack.handoffReasons.length) errs.push('handoffReasons 비어 있음');
  // 코드 1차 거르기의 안전 규칙 — 팩에서 빠지면 그 채널에서 조용히 꺼진다(prefilter는 팩 사유로 규칙을 고른다).
  for (const r of REQUIRED_REASONS) if (!(pack.handoffReasons || []).includes(r)) errs.push(`handoffReasons에 ${r} 없음`);
  for (const k of ['confidenceMin', 'maxRounds', 'repeatLimit', 'maxLength']) {
    if (typeof pack.thresholds?.[k] !== 'number' || Number.isNaN(pack.thresholds[k])) errs.push(`thresholds.${k} 숫자 아님`);
  }
  for (const [intent, def] of Object.entries(pack.intents || {})) {
    if (def.level !== undefined && !LEVELS.includes(def.level)) errs.push(`intents.${intent}.level=${def.level}`);
    if (def.reason !== undefined && !(pack.handoffReasons || []).includes(def.reason)) errs.push(`intents.${intent}.reason=${def.reason}가 handoffReasons에 없음`);
  }
  for (const r of pack.answerableHandoffReasons || []) if (!(pack.handoffReasons || []).includes(r)) errs.push(`answerableHandoffReasons.${r}가 handoffReasons에 없음`);
  const text = (v) => typeof v === 'string' && v.trim();
  if (pack.ackReply !== undefined && !(text(pack.ackReply?.ko) && (pack.ackReply.en === undefined || text(pack.ackReply.en)))) errs.push('ackReply.ko(필수)·en은 빈 문자열이 아닌 문자열');
  if (errs.length) throw new Error(`정책 팩 ${name} 오류: ${errs.join('; ')}`);
  return pack;
}

const shadowEnv = () => (process.env.SHADOW_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);

function load(channel) {
  const file = path.join(DIR, `${channel}.json`);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const pack = validate(JSON.parse(text), channel);
  pack.version = sha(text);
  pack.languages ??= ['ko'];
  pack.answerableHandoffReasons ??= DEFAULT_ANSWERABLE.filter((r) => pack.handoffReasons.includes(r));
  pack.shadow = !!pack.shadow || shadowEnv().includes(channel); // env는 좁히기만(섀도로 내리기만) 한다
  return pack;
}

const all = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => load(f.slice(0, -5)));

// 팩 목록에 없는 사유(모델이 intent 이름을 사유 칸에 적는 등)는 unclear로 뭉갠다.
const normalizeReason = (pack, reason) => (pack.handoffReasons.includes(reason) ? reason : 'unclear');

/**
 * 한 회차에 무엇을 할지(spec §4, 12규칙 첫 매치). 두 번 부른다 — 분류 뒤(guard 없음 → COMPOSE), 검사 뒤(guard 있음 → 최종).
 * @returns {{action, reason?, rule: number, inputs: object}} rule·inputs는 대시보드 트레이스에 그대로 보인다.
 */
function decide({ pack, triage, rounds = 0, repeatStreak = 0, guard }) {
  const t = pack.thresholds;
  const intent = triage.intent;
  const def = pack.intents[intent];
  const inputs = {
    intent, level: def?.level ?? null, handoffReason: triage.handoffReason ?? null, kbHit: triage.kbHit, confidence: triage.confidence,
    confidenceMin: t.confidenceMin, rounds, maxRounds: t.maxRounds, repeatStreak, repeatLimit: t.repeatLimit,
    riskSignals: triage.riskSignals || [], language: triage.language || 'ko', shadow: !!pack.shadow, guardPass: guard ? !!guard.pass : null,
    autoSend: autoAllowed(pack) && def?.level === 'L2',
  };
  const out = (rule, action, reason) => ({ action, ...(reason !== undefined ? { reason } : {}), rule, inputs });
  const H = (rule, reason) => out(rule, 'HANDOFF', normalizeReason(pack, reason));
  const answerable = pack.answerableHandoffReasons || DEFAULT_ANSWERABLE;
  const risk = (triage.riskSignals || []).find((r) => RISK_REASON[r]);

  if (intent === 'ignore' || intent === 'ack') return out(1, 'IGNORE', intent);
  // 2 사람 전용 — H 등급, 미지원 언어, 위험 신호, 답할 몫이 없는 사유, 답해도 되는 목록 밖의 사유
  if (!(pack.languages || ['ko']).includes(inputs.language)) return H(2, 'language_unsupported');
  if (def?.level === 'H' || pack.maxLevel === 'H' || risk
    || (triage.handoffReason && (triage.kbHit === false || !answerable.includes(triage.handoffReason)))) {
    const modelReason = pack.handoffReasons.includes(triage.handoffReason) ? triage.handoffReason : null;
    return H(2, modelReason || (def?.level === 'H' && def.reason) || (risk && RISK_REASON[risk]) || def?.reason || intent);
  }
  if (repeatStreak >= t.repeatLimit) return H(3, 'no_progress');
  if (!(Number(triage.confidence) >= t.confidenceMin)) return H(4, 'low_confidence');
  if (rounds >= t.maxRounds) return H(5, 'round_limit');
  if (!def) return H(6, 'unclear');
  if (triage.kbHit === false) return H(7, 'out_of_knowledge');
  if (guard === undefined) return out(8, 'COMPOSE');
  if (!guard.pass) return H(9, 'guard_failed');
  if (pack.shadow || pack.maxLevel === 'L0' || def.level === 'L0') return out(10, 'SHADOW', 'shadow');
  if (intent === 'quote_request') return out(11, 'ANSWER_AND_HANDOFF', normalizeReason(pack, 'price_contract'));
  if (triage.kbHit === 'partial') return out(11, 'ANSWER_AND_HANDOFF', normalizeReason(pack, 'out_of_knowledge'));
  if (triage.handoffReason) return out(11, 'ANSWER_AND_HANDOFF', normalizeReason(pack, triage.handoffReason));
  return out(12, 'DRAFT');
}

module.exports = { load, all, validate, decide, normalizeReason, autoSendOn, autoAllowed, PROMOTION, DEFAULT_ANSWERABLE, RISK_REASON, REQUIRED_REASONS };
