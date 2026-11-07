'use strict';
// 채널 정책 팩 로더 + 판단 함수. 허용 범위는 팩이 정하고, 설정(env)은 그 안에서 좁히기만 한다. 하한은 코드가 지킨다(problems).
// 고객이 게시한 팩은 주입된 reader로 읽는다(setReader). reader가 없거나 null을 주면 이미지 파일(policy/<ch>.json)을 쓴다.
const fs = require('node:fs');
const path = require('node:path');
const { sha, CHANNEL_RE, KEY_RE } = require('./kb');
const { CASE_TYPES, CASE_REASONS } = require('./crm');
const { check: guardCheck } = require('./guard');

const DIR = path.join(__dirname, '..', 'policy');
const LEVELS = ['L0', 'L1', 'L2', 'H'];
// L2 = 승인 없이 자동 발송. 팩 maxLevel과 intent level이 둘 다 L2일 때만(env는 좁히기만 한다).
// AUTO_SEND는 켜는 값(1·true·on·yes, 없거나 빈 값이면 켬 — 2026-10-27 결정, .env.example의 "빈 값 = 기본값")일 때만 켠다. 0·false·off·오타는 끈다(fail-closed).
// 실발송(smtp)인데 수신 시크릿이 없으면 끈다 — 누구나 /api/inbound로 우리 도메인 자동 메일을 아무 주소에나 보내게 된다.
const autoSendOn = (env = process.env) => ['1', 'true', 'on', 'yes'].includes(String(env.AUTO_SEND || '1').trim().toLowerCase())
  && !(env.MAIL_PROVIDER === 'smtp' && !env.INBOUND_SECRET);
/** 이 채널에서 지금 사람 승인 없이 보내도 되나(섀도 채널 제외). 판단(decide)·승인(approveDraft)·접수 안내(sendAck)가 같이 쓴다. */
const autoAllowed = (pack) => autoSendOn() && pack.maxLevel === 'L2' && !pack.shadow;
// 발신자 인증 결과가 없는 메일(sender_auth NULL)에도 자동 메일을 보내나. 빈 값 = production에서만 요구, 0·false·off·no = 요구 안 함, 그 밖의 값(오타 포함) = 요구(fail-closed).
const requireSenderAuth = (env = process.env) => {
  const v = String(env.REQUIRE_SENDER_AUTH || '').trim().toLowerCase();
  return v ? !['0', 'false', 'off', 'no'].includes(v) : env.NODE_ENV === 'production';
};
/** 문의 폼 발신 주소인가(FORM_SENDER_DOMAINS, 하위 도메인 포함). */
const isFormAddress = (email) => {
  const d = (String(email || '').toLowerCase().match(/@([^@\s>]+)$/) || [])[1];
  return !!d && (process.env.FORM_SENDER_DOMAINS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).some((f) => d === f || d.endsWith(`.${f}`));
};
/**
 * 이 발신자에게 회사 명의 자동 메일(L2 자동 발송·접수 안내)을 보내도 되나. 사람 승인 초안은 이것과 무관하게 만든다.
 * 인증 실패(fail)는 늘 아니다. 폼에서 뽑은 주소(form)·폼 주소도 늘 아니다 — 폼 입력은 누구 주소든 넣을 수 있다(REQUIRE_SENDER_AUTH와 무관).
 */
const senderTrusted = (senderAuth, email) => senderAuth !== 'form' && !isFormAddress(email)
  && (senderAuth === 'pass' || (senderAuth !== 'fail' && !requireSenderAuth()));
// 사람 신호지만 "다른 질문엔 답하고 그 신호만 넘겨도 되는" 사유. 이 밖의 사유(환불·분쟁·법적·주입 등)는 섞여도 통째로 넘긴다.
const DEFAULT_ANSWERABLE = ['human_request', 'call_meeting', 'contract_documents', 'purchase_intent', 'out_of_knowledge', 'price_contract'];
// 위험 신호 → 넘김 사유. triage가 riskSignals에 하나라도 적으면 kbHit와 무관하게 통째로 넘긴다.
const RISK_REASON = { refund: 'refund_request', legal: 'legal_threat', complaint: 'complaint', injection: 'injection' };
// L0 → L1 승격 기준(채널 단위). 코드 상수 — 바꾸려면 코드 리뷰.
const PROMOTION = { minReviewed: 50, minNoEditRate: 0.9, maxCritical: 0 };
const REQUIRED_REASONS = ['injection', 'legal_threat', 'human_request', 'sender_unverified'];
// 코드가 내는 넘김 사유 — 팩에서 빠지면 normalizeReason이 unclear로 뭉개 정보를 잃는다.
const SYSTEM_REASONS = ['unclear', 'out_of_knowledge', 'low_confidence', 'no_progress', 'round_limit', 'guard_failed', 'llm_error', 'internal_error', 'language_unsupported', 'discarded'];
// 코드 하한 — 팩은 이보다 엄격하게만 바꿀 수 있다.
const FLOOR = { confidenceMin: 0.8, maxRounds: 10, repeatLimit: 2, allowAmounts: false };
const LANGS = ['ko', 'en'];
/**
 * 팩 필드 규칙(정본). edit: free(고객 편집) | tighten(조이기만) | fixed(코드 고정). widen: 넓히는 변경이 걸리는 범위(channel | intent).
 * problems·widenings와 콘솔 화면이 같은 값을 쓴다.
 */
const FIELD_RULES = {
  channel: { edit: 'fixed' },
  label: { edit: 'free', required: true, maxLen: 40, widen: 'channel' },
  maxLevel: { edit: 'free', values: LEVELS, widen: 'channel' },
  shadow: { edit: 'free', widen: 'channel' },
  languages: { edit: 'free', values: LANGS, widen: 'channel' },
  persona: { edit: 'free', required: true, maxLen: 300 },
  intents: { edit: 'free', max: 60, widen: 'channel' },
  'intents.*.level': { edit: 'free', values: LEVELS, widen: 'intent' },
  // L2 intent의 변경은 그 intent의 확대, L2 intent가 있는 팩에서 L1·H intent의 변경(새 intent의 설명 포함)과 label 변경은 채널 확대
  'intents.*.description': { edit: 'free', maxLen: 200, widen: 'channel' },
  'intents.*.kb': { edit: 'free', widen: 'intent' },
  'intents.*.reason': { edit: 'free' },
  'intents.*.caseType': { edit: 'free', values: CASE_TYPES },
  'intents.*.caseReason': { edit: 'free', values: CASE_REASONS },
  'intents.*.actions': { edit: 'fixed' },
  handoffReasons: { edit: 'free', required: [...REQUIRED_REASONS, ...SYSTEM_REASONS], widen: 'channel' },
  answerableHandoffReasons: { edit: 'tighten', values: DEFAULT_ANSWERABLE, widen: 'channel' },
  'thresholds.confidenceMin': { edit: 'tighten', min: FLOOR.confidenceMin, max: 1, widen: 'channel' },
  'thresholds.maxRounds': { edit: 'tighten', min: 1, max: FLOOR.maxRounds, integer: true, widen: 'channel' },
  'thresholds.repeatLimit': { edit: 'tighten', min: 1, max: FLOOR.repeatLimit, integer: true, widen: 'channel' },
  'thresholds.maxLength': { edit: 'free', min: 200, max: 1000, integer: true, widen: 'channel' },
  'guard.forbiddenWords': { edit: 'free', required: true, maxLen: 20, max: 50, widen: 'channel' },
  'guard.forbiddenWordsEn': { edit: 'free', required: true, maxLen: 20, max: 50, widen: 'channel' },
  'guard.allowDates': { edit: 'free', widen: 'channel' },
  'guard.allowAmounts': { edit: 'fixed', value: FLOOR.allowAmounts },
  'guard.allowQuantities': { edit: 'free', widen: 'channel' },
  'ackReply.ko': { edit: 'free', maxLen: 500 },
  'ackReply.en': { edit: 'free', maxLen: 500 },
  'notify.channel': { edit: 'free', maxLen: 80 },
};

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
    // CRM 케이스 유형·사유 — 있으면 값 집합 안. 없어도 통과(테스트용 팩). 출하 팩에 빠짐없이 있는지는 test/policy.test.js가 본다.
    if (def.caseType !== undefined && !CASE_TYPES.includes(def.caseType)) errs.push(`intents.${intent}.caseType=${def.caseType}`);
    if (def.caseReason !== undefined && !CASE_REASONS.includes(def.caseReason)) errs.push(`intents.${intent}.caseReason=${def.caseReason}`);
  }
  for (const r of pack.answerableHandoffReasons || []) if (!(pack.handoffReasons || []).includes(r)) errs.push(`answerableHandoffReasons.${r}가 handoffReasons에 없음`);
  const text = (v) => typeof v === 'string' && v.trim();
  if (pack.ackReply !== undefined && !(text(pack.ackReply?.ko) && (pack.ackReply.en === undefined || text(pack.ackReply.en)))) errs.push('ackReply.ko(필수)·en은 빈 문자열이 아닌 문자열');
  if (errs.length) throw new Error(`정책 팩 ${name} 오류: ${errs.join('; ')}`);
  return pack;
}

const shadowEnv = (env = process.env) => (env.SHADOW_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);

const NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;
// 프롬프트에 들어가는 문자열 — 줄바꿈·제어 문자, 보이지 않는 문자(폭 0·방향 제어·BOM)와 프롬프트 울타리(<<<·>>>)는 지시를 끼워 넣는 통로가 된다.
const PROMPT_BAD_RE = /[\u0000-\u001f\u007f\u0085\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]|<<<|>>>/;
const KEYS = {
  '': ['channel', 'label', 'maxLevel', 'shadow', 'languages', 'persona', 'intents', 'handoffReasons', 'answerableHandoffReasons', 'thresholds', 'guard', 'ackReply', 'notify'],
  intent: ['level', 'description', 'kb', 'reason', 'caseType', 'caseReason', 'actions'],
  thresholds: ['confidenceMin', 'maxRounds', 'repeatLimit', 'maxLength'],
  guard: ['forbiddenWords', 'forbiddenWordsEn', 'allowDates', 'allowAmounts', 'allowQuantities'],
  ackReply: ['ko', 'en'],
  notify: ['channel'],
};
// 회사 명의로 자동 발송되는 접수 안내에서 막는 guard 코드
const ACK_GUARD = ['amount', 'date_promise', 'contact', 'emoji', 'forbidden_word'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * 하한·구조 검사(FIELD_RULES). validate가 보는 기존 규칙에 더해 키 허용 목록, 필수 구조, 프롬프트 문자열, 코드 고정 값, 조이기만 하는 범위를 본다.
 * @returns {{path: string, rule: 'structure'|'fixed'|'stricter', msg: string}[]} 빈 배열이면 통과. actions는 내용을 보지 않는다.
 */
function problems(pack, channel = pack?.channel) {
  const out = [];
  const add = (p, rule, msg) => out.push({ path: p, rule, msg });
  if (!isObj(pack)) { add('', 'structure', '팩은 객체여야 한다'); return out; }
  const keys = (obj, kind, at) => { for (const k of Object.keys(obj)) if (!KEYS[kind].includes(k)) add(`${at}${k}`, 'structure', '허용되지 않는 키'); };
  // 프롬프트에 들어가는 문자열
  const text = (p, v, rule) => {
    if (v === undefined) { if (rule.required) add(p, 'structure', '필수'); return; }
    if (typeof v !== 'string' || !v.trim() || v.length > rule.maxLen) add(p, 'structure', `1–${rule.maxLen}자 문자열`);
    else if (PROMPT_BAD_RE.test(v)) add(p, 'structure', '줄바꿈·제어 문자·<<<·>>> 금지');
  };
  keys(pack, '', '');
  if (pack.channel !== channel || !CHANNEL_RE.test(String(pack.channel))) add('channel', 'fixed', '파일 이름과 같아야 한다');
  text('label', pack.label, FIELD_RULES.label);
  text('persona', pack.persona, FIELD_RULES.persona);
  if (pack.shadow !== undefined && typeof pack.shadow !== 'boolean') add('shadow', 'structure', 'true|false');
  if (pack.languages !== undefined && !(Array.isArray(pack.languages) && pack.languages.length && pack.languages.every((l) => LANGS.includes(l)))) add('languages', 'structure', `${LANGS.join('·')}의 비지 않은 부분집합`);

  if (!isObj(pack.intents)) add('intents', 'structure', '객체여야 한다');
  else {
    const intents = pack.intents;
    if (Object.keys(intents).length > FIELD_RULES.intents.max) add('intents', 'structure', `최대 ${FIELD_RULES.intents.max}개`);
    for (const k of ['ack', 'ignore']) if (!isObj(intents[k]) || Object.keys(intents[k]).length) add(`intents.${k}`, 'fixed', '있어야 하고 값은 {}');
    for (const k of ['injection', 'human_request']) if (intents[k]?.reason !== k) add(`intents.${k}.reason`, 'fixed', `있어야 하고 사유는 ${k}`);
    for (const [k, d] of Object.entries(intents)) {
      const at = `intents.${k}`;
      if (!NAME_RE.test(k)) add(at, 'structure', '이름은 영소문자로 시작하는 2–40자(a-z0-9_)');
      if (!isObj(d)) { add(at, 'structure', '객체여야 한다'); continue; }
      keys(d, 'intent', `${at}.`);
      if (REQUIRED_REASONS.includes(d.reason) && d.level !== 'H') add(`${at}.level`, 'fixed', `사유 ${d.reason}는 H 고정`);
      text(`${at}.description`, d.description, FIELD_RULES['intents.*.description']);
      // L2 intent의 kb가 배열이 아니면 guard의 근거 범위 검사(fact_off_intent)가 꺼진다
      if ((d.level === 'L2' || d.kb !== undefined) && !Array.isArray(d.kb)) add(`${at}.kb`, 'structure', d.level === 'L2' ? 'L2 intent는 배열이어야 한다' : '배열이어야 한다');
      for (const key of arr(d.kb)) if (typeof key !== 'string' || !KEY_RE.test(key)) add(`${at}.kb`, 'structure', `key 형식: ${key}`);
    }
  }

  if (!Array.isArray(pack.handoffReasons)) add('handoffReasons', 'structure', '배열이어야 한다');
  for (const r of FIELD_RULES.handoffReasons.required) if (!arr(pack.handoffReasons).includes(r)) add('handoffReasons', 'fixed', `${r} 필요`);
  for (const r of arr(pack.handoffReasons)) if (typeof r !== 'string' || !NAME_RE.test(r)) add('handoffReasons', 'structure', `이름 형식: ${r}`);
  if (pack.answerableHandoffReasons !== undefined && !Array.isArray(pack.answerableHandoffReasons)) add('answerableHandoffReasons', 'structure', '배열이어야 한다');
  for (const r of arr(pack.answerableHandoffReasons)) if (!DEFAULT_ANSWERABLE.includes(r)) add('answerableHandoffReasons', 'stricter', `${r}는 상한(${DEFAULT_ANSWERABLE.join(', ')}) 밖`);

  if (!isObj(pack.thresholds)) add('thresholds', 'structure', '객체여야 한다');
  else {
    keys(pack.thresholds, 'thresholds', 'thresholds.');
    for (const k of KEYS.thresholds) {
      const r = FIELD_RULES[`thresholds.${k}`]; const v = pack.thresholds[k];
      if (!(typeof v === 'number' && v >= r.min && v <= r.max && (!r.integer || Number.isInteger(v)))) add(`thresholds.${k}`, r.edit === 'tighten' ? 'stricter' : 'structure', `${r.integer ? '정수 ' : ''}${r.min}–${r.max}`);
    }
  }

  if (!isObj(pack.guard)) add('guard', 'structure', '필수');
  else {
    const g = pack.guard;
    keys(g, 'guard', 'guard.');
    for (const k of ['forbiddenWords', 'forbiddenWordsEn']) {
      const rule = FIELD_RULES[`guard.${k}`];
      if (!Array.isArray(g[k]) || g[k].length > rule.max) add(`guard.${k}`, 'structure', `필수, 최대 ${rule.max}개`);
      else g[k].forEach((w, i) => text(`guard.${k}.${i}`, w, rule));
    }
    for (const k of ['allowDates', 'allowQuantities']) if (g[k] !== undefined && typeof g[k] !== 'boolean') add(`guard.${k}`, 'structure', 'true|false');
    if (g.allowAmounts !== undefined && g.allowAmounts !== FLOOR.allowAmounts) add('guard.allowAmounts', 'fixed', 'false 고정(금액 약속 금지)');
  }

  if (pack.ackReply !== undefined) {
    if (!isObj(pack.ackReply)) add('ackReply', 'structure', '객체여야 한다');
    else {
      keys(pack.ackReply, 'ackReply', 'ackReply.');
      for (const l of KEYS.ackReply) {
        const v = pack.ackReply[l];
        if (v === undefined) continue; // ko 필수는 validate가 본다
        if (typeof v !== 'string' || v.length > FIELD_RULES[`ackReply.${l}`].maxLen) { add(`ackReply.${l}`, 'structure', `${FIELD_RULES[`ackReply.${l}`].maxLen}자 이하 문자열`); continue; }
        let hits = [];
        try { hits = guardCheck({ body: v, pack, kb: { sections: {} }, only: ACK_GUARD }); } catch { /* guard 칸이 잘못된 팩 — 위에서 구조 오류로 이미 걸렸다 */ }
        if (hits.length) add(`ackReply.${l}`, 'fixed', `자동 발송 문장 검사에 걸림: ${hits.map((h) => h.code).join(', ')}`);
      }
    }
  }
  if (pack.notify !== undefined) {
    if (!isObj(pack.notify)) add('notify', 'structure', '객체여야 한다');
    else {
      keys(pack.notify, 'notify', 'notify.');
      const v = pack.notify.channel;
      if (v !== undefined && (typeof v !== 'string' || v.length > FIELD_RULES['notify.channel'].maxLen)) add('notify.channel', 'structure', `${FIELD_RULES['notify.channel'].maxLen}자 이하 문자열`);
    }
  }
  return out;
}

/** load와 같은 기본값 채우기(env는 넣지 않는다). 받은 객체를 고쳐서 돌려준다. */
function fill(pack) {
  pack.languages ??= ['ko'];
  pack.answerableHandoffReasons ??= DEFAULT_ANSWERABLE.filter((r) => arr(pack.handoffReasons).includes(r));
  pack.shadow = !!pack.shadow;
  return pack;
}

/** 원문 → 검사를 마친 팩. 잘못되면 던진다(validate의 기존 메시지, 그다음 problems). */
function parsePack(raw, channel) {
  const pack = validate(JSON.parse(raw), channel);
  const bad = problems(pack, channel);
  if (bad.length) throw new Error(`정책 팩 ${channel} 하한·구조 위반: ${bad.map((b) => `${b.path || '(팩)'} ${b.msg}`).join('; ')}`);
  return pack;
}
const finish = (pack, raw, channel) => {
  fill(pack);
  pack.version = sha(raw);
  pack.shadow = pack.shadow || shadowEnv().includes(channel); // env는 좁히기만(섀도로 내리기만) 한다
  return pack;
};

let reader = null;
let onInvalid = null;
let warned = new Set();
/** fn('policy', channel, null) → null | {raw, hash, changeId} | {error, changeId}. onInvalid({kind, channel, lang, changeId, error})는 대상을 닫을 때 (대상, changeId)당 한 번. */
function setReader(fn, { onInvalid: cb = null } = {}) { reader = fn || null; onInvalid = cb; warned = new Set(); }

/** 이미지 원문(policy/<ch>.json). 없거나 채널 이름이 잘못되면 null. */
function shipped(channel) {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) return null;
  const file = path.join(DIR, `${channel}.json`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * 이 채널의 라이브 원문. 이미지에 팩이 없는 채널은 null(reader를 보지 않는다).
 * @returns {{raw, version, live, invalid, changeId, error?} | null} invalid = reader 오류, sha256 불일치, 파싱·validate·problems 실패.
 */
function source(channel) {
  const img = shipped(channel);
  if (img === null) return null;
  let r = null;
  if (reader) { try { r = reader('policy', channel, null) || null; } catch { r = { error: 'reader' }; } }
  if (!r) return { raw: img, version: sha(img), live: false, invalid: false, changeId: null };
  const changeId = r.changeId ?? null;
  if (r.error) return { raw: null, version: null, live: true, invalid: true, changeId, error: String(r.error) };
  try {
    parsePack(r.raw, channel);
    return { raw: r.raw, version: sha(r.raw), live: true, invalid: false, changeId };
  } catch (e) {
    return { raw: typeof r.raw === 'string' ? r.raw : null, version: typeof r.raw === 'string' ? sha(r.raw) : null, live: true, invalid: true, changeId, error: e.message };
  }
}

/**
 * 채널 팩. 이미지 팩이 잘못되면 던진다(assertShipped가 기동 때 막는다). 고객 원문이 닫히면 던지지 않고
 * 이미지 팩을 maxLevel H로 돌린다 — L0–L2 intent는 H·internal_error, 이미 H인 intent와 caseType·caseReason은 그대로.
 */
function load(channel) {
  const src = source(channel);
  if (!src) return null;
  if (!src.invalid) return finish(parsePack(src.raw, channel), src.raw, channel);
  const key = `policy:${channel}\u0000${src.changeId}`;
  if (!warned.has(key)) {
    warned.add(key);
    const info = { kind: 'policy', channel, lang: null, changeId: src.changeId, error: src.error };
    try { if (onInvalid) onInvalid(info); else console.warn(`[policy] ${channel} 팩을 쓸 수 없어 모든 문의를 사람에게 넘김(${src.error})`); } catch { /* 콜백 오류로 load가 던지지 않게 */ }
  }
  const img = shipped(channel);
  const pack = finish(parsePack(img, channel), img, channel);
  pack.maxLevel = 'H';
  pack.invalid = true;
  pack.error = src.error;
  for (const def of Object.values(pack.intents)) if (['L0', 'L1', 'L2'].includes(def.level)) Object.assign(def, { level: 'H', reason: 'internal_error' });
  return pack;
}

const all = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => load(f.slice(0, -5)));

/** 기동 검사 — reader를 보지 않고 이미지 팩 전부를 엄격히 읽는다. 잘못된 출하 팩이면 던진다. */
function assertShipped() {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
    const ch = f.slice(0, -5); const raw = shipped(ch);
    if (raw === null) throw new Error(`정책 팩 파일 이름이 채널 규칙에 맞지 않음: ${f}`);
    parsePack(raw, ch);
  }
}

// 원문 JSON은 문자열이나 객체로 받는다. 파싱되지 않는 원문은 null(로더가 닫는 원문 — 자동 발송이 없다).
const parsed = (raw) => { if (typeof raw !== 'string') return raw; try { return JSON.parse(raw); } catch { return null; } };

/** 원문의 자동 발송 집합 — L2 intent 이름과 접수 안내('@ack'). env(SHADOW_CHANNELS·AUTO_SEND)는 보지 않는다. */
function autoSet(raw) {
  const p = parsed(raw);
  if (!isObj(p) || p.maxLevel !== 'L2' || p.shadow) return [];
  const names = Object.entries(isObj(p.intents) ? p.intents : {}).filter(([, d]) => d?.level === 'L2').map(([k]) => k);
  return p.ackReply ? [...names, '@ack'] : names;
}

/**
 * 자동 발송을 넓히는 변경 목록(FIELD_RULES의 widen). 두 원문은 fill을 거친 뒤 비교하고, 배열은 집합으로 본다.
 * liveRaw가 null이거나 파싱되지 않으면(라이브가 깨짐) 채널 범위 확대 전부. prefilter 연동 사유 삭제도 handoffReasons 삭제로 여기 잡힌다.
 * @returns {{scope: 'channel'|'intent', intent?: string, path: string}[]}
 */
function widenings(liveRaw, nextRaw) {
  const lp = parsed(liveRaw);
  if (!isObj(lp)) return Object.keys(FIELD_RULES).filter((k) => FIELD_RULES[k].widen === 'channel').map((p) => ({ scope: 'channel', path: p }));
  const live = fill(structuredClone(lp));
  const next = fill(structuredClone(parsed(nextRaw)));
  const out = [];
  const ch = (p) => out.push({ scope: 'channel', path: p });
  const it = (intent, p) => out.push({ scope: 'intent', intent, path: `intents.${intent}.${p}` });
  const gained = (a, b) => arr(a).some((x) => !arr(b).includes(x)); // a에 있고 b에 없는 값
  const li = isObj(live.intents) ? live.intents : {};
  const ni = isObj(next.intents) ? next.intents : {};
  const lt = live.thresholds || {}; const nt = next.thresholds || {};
  const lg = live.guard || {}; const ng = next.guard || {};
  if (live.maxLevel !== 'L2' && next.maxLevel === 'L2') ch('maxLevel');
  if (live.shadow && !next.shadow) ch('shadow');
  if (gained(next.languages, live.languages)) ch('languages');
  for (const k of Object.keys(li)) if (!Object.hasOwn(ni, k)) ch(`intents.${k}`);
  if (gained(live.handoffReasons, next.handoffReasons)) ch('handoffReasons');
  if (gained(next.answerableHandoffReasons, live.answerableHandoffReasons)) ch('answerableHandoffReasons');
  if (nt.confidenceMin < lt.confidenceMin) ch('thresholds.confidenceMin');
  for (const k of ['maxRounds', 'repeatLimit', 'maxLength']) if (nt[k] > lt[k]) ch(`thresholds.${k}`);
  for (const k of ['forbiddenWords', 'forbiddenWordsEn']) if (gained(lg[k], ng[k])) ch(`guard.${k}`);
  if (!lg.allowDates && ng.allowDates) ch('guard.allowDates');
  if (lg.allowQuantities === false && ng.allowQuantities !== false) ch('guard.allowQuantities'); // guard는 === false일 때만 막는다
  const hasL2 = Object.values(ni).some((d) => d?.level === 'L2');
  // label은 접수 Agent 프롬프트에 들어간다 — intent 설명과 같이 본다
  if (hasL2 && live.label !== next.label) ch('label');
  for (const [k, d] of Object.entries(ni)) {
    const was = Object.hasOwn(li, k) ? li[k] : undefined;
    if (d?.level === 'L2') {
      if (was?.level !== 'L2') it(k, 'level');
      if (was?.description !== d.description) it(k, 'description');
      if (gained(d.kb, was?.kb)) it(k, 'kb');
    } else if (hasL2 && (was ? was.description !== d?.description : !!d?.description)) ch(`intents.${k}.description`); // 새 intent의 설명도 프롬프트에 들어간다
  }
  return out;
}

// 팩 목록에 없는 사유(모델이 intent 이름을 사유 칸에 적는 등)는 unclear로 뭉갠다.
const normalizeReason = (pack, reason) => (pack.handoffReasons.includes(reason) ? reason : 'unclear');

/**
 * 한 회차에 무엇을 할지(spec §4, 12규칙 첫 매치). 두 번 부른다 — 분류 뒤(guard 없음 → COMPOSE), 검사 뒤(guard 있음 → 최종).
 * @returns {{action, reason?, rule: number, inputs: object}} rule·inputs는 대시보드 트레이스에 그대로 보인다.
 */
function decide({ pack, triage, rounds = 0, repeatStreak = 0, guard, senderTrusted: trusted = true }) {
  const t = pack.thresholds;
  const intent = triage.intent;
  const def = Object.hasOwn(pack.intents, intent) ? pack.intents[intent] : undefined;
  const inputs = {
    intent, level: def?.level ?? null, handoffReason: triage.handoffReason ?? null, kbHit: triage.kbHit, confidence: triage.confidence,
    confidenceMin: t.confidenceMin, rounds, maxRounds: t.maxRounds, repeatStreak, repeatLimit: t.repeatLimit,
    riskSignals: triage.riskSignals || [], language: triage.language || 'ko', shadow: !!pack.shadow, guardPass: guard ? !!guard.pass : null,
    senderTrusted: trusted, autoSend: autoAllowed(pack) && def?.level === 'L2' && trusted, // 미신뢰 발신자는 L2 intent도 승인 대기
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

module.exports = {
  load, all, validate, decide, normalizeReason, autoSendOn, autoAllowed, shadowEnv, requireSenderAuth, isFormAddress, senderTrusted, PROMOTION, DEFAULT_ANSWERABLE, RISK_REASON, REQUIRED_REASONS,
  problems, fill, autoSet, widenings, setReader, source, shipped, assertShipped, FIELD_RULES, FLOOR, SYSTEM_REASONS,
};
