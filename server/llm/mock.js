'use strict';
// 규칙 기반 결정적 provider. 테스트·데모용 — 품질이 아니라 "루프가 정책대로 도는가"를 본다.
// 실제 LLM이 하는 네 역할(triage·responder·reviewer·briefer)을 키워드 규칙으로 흉내 낸다. ctx는 agents/*.js가 넘기는 구조화 입력.

const labels = require('../labels');

const ACK_RE = /감사|확인했|고맙|잘 받았|thanks|thank you|got it/i;
const QUESTION_RE = /\?|문의|요청|부탁|어떻게|해\s*주|주세요|궁금|가능|되나|될까|how|can|could|please/i;
const CONTACT_RE = /\d{2,3}-\d{3,4}-\d{4}|[\w.+-]+@[\w-]+\.[\w.]+/g;

// [intent, 패턴, {reason?, kb?, risk?}] — 채널마다 사람 전용(H) 신호를 먼저 본다.
const RULES = {
  support: [
    ['refund', /환불|돌려\s*(주|받)|refund|money back/i, { reason: 'refund_request', risk: ['refund'] }],
    ['billing_dispute', /중복\s*결제|이중\s*결제|두\s*번\s*결제|카드사|분쟁|chargeback|charged twice/i, { reason: 'billing_dispute', risk: ['billing', 'complaint'] }],
    ['data_export', /(데이터|자료|기록)[^.\n]{0,12}(전부|모두|파일|반출|내보내|다운로드|export)|export (all )?my data/i, { reason: 'data_export', risk: ['pii'] }],
    ['complaint', /사기|기만|항의|화가|최악|불만|scam|fraud/i, { reason: 'complaint', risk: ['complaint'] }],
    ['account_deletion', /탈퇴|계정\s*(삭제|지워)|delete my account/i, { kb: ['account_deletion'] }],
    ['receipt', /영수증|세금\s*계산서|증빙|invoice|receipt/i, { kb: ['receipt'] }],
    ['cancel_subscription', /해지|구독\s*(취소|중단|해제)|cancel.*subscription|unsubscribe/i, { kb: ['cancel_subscription'] }],
    ['login_issue', /로그인|비밀번호|password|log ?in|sign ?in|인증\s*메일/i, { kb: ['login'] }],
    ['feature_howto', /사용법|어떻게\s*(쓰|사용|하)|기능|how (do|can) i|설정\s*방법/i, { kb: ['features'] }],
  ],
  onboarding: [
    ['pricing_question', /할인|요금제|가격|비용|무료|얼마|pricing|discount|price/i, { reason: (b) => (/할인|교육|예외|비영리|학생|discount/i.test(b) ? 'policy_exception' : 'pricing') }],
    ['meeting_request', /미팅|회의|통화|시간\s*(괜찮|가능)|일정|schedule|meeting|call/i, { kb: ['meeting'] }],
    ['onboarding_request', /온보딩|도입|시작|신청|팀|써\s*보|사용해\s*보|onboard|get started|trial/i, { kb: ['onboarding_steps', 'meeting'] }],
  ],
  sales: [
    ['price_negotiation', /할인|수수료|정산|협상|깎|네고|discount/i, { reason: 'price_contract' }],
    ['purchase_intent', /진행\s*(하겠|할게|하고\s*싶|원합|하려)|계약\s*진행|시작하고\s*싶|신청서/i, { reason: 'purchase_intent' }],
    ['material_request', /소개서|자료|브로슈어|제안서|brochure|deck/i, { kb: ['materials'] }],
    ['quote_request', /예산|견적|비용|단가|가격|얼마|quote|budget|pricing/i, { kb: ['cost_structure', 'products'] }],
    ['declined', /진행(이|은)?\s*(어렵|안\s*할|하지\s*않|보류)|이번에는\s*(어렵|보류|패스)|not interested/i, { kb: [] }],
    ['reviewing', /검토|공유\s*(하|할)|회의\s*후|나중에\s*연락|내부/i, { kb: [] }],
    ['service_question', /서비스|어떤|방식|순서|절차|가능한지|가능할까|궁금|what|how/i, { kb: ['about', 'process', 'products'] }],
  ],
};

const NEXT_ACTION = {
  refund_request: '결제 이력 확인 후 약관 기준으로 환불 가능 여부 판단', billing_dispute: '중복 결제 건 확인 후 취소 처리 안내',
  data_export: '본인 확인 후 데이터 반출 범위·형식 확인', complaint: '사과 + 사실관계 확인 후 직접 회신', legal_threat: '법무 공유 후 직접 회신',
  human_request: '담당자가 직접 연락', call_meeting: '통화 가능 시간 제안', contract_documents: '계약 서류 발송', purchase_intent: '신청서 안내 및 계약 진행',
  price_contract: '견적서 작성 후 발송', policy_exception: '요금 정책 예외 가능 여부 확인', pricing: '요금 안내', injection: '무시 또는 정중히 범위 안내',
  unclear: '고객에게 요청 사항 다시 확인', out_of_knowledge: '지식베이스 보강 검토 후 직접 회신', llm_error: '수동 응대', guard_failed: '초안 수정 후 직접 회신',
  low_confidence: '문의 의도 확인', no_progress: '같은 질문 반복 — 직접 설명', round_limit: '왕복 한도 — 직접 마무리',
};

const firstSentence = (s) => String(s || '').trim().split(/(?<=[.!?])\s+|\n/)[0].slice(0, 80);
const mask = (s) => String(s || '').replace(CONTACT_RE, '[연락처]');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// 감정 신호 — 키워드 등급(표시 전용, 판정에는 쓰지 않는다)
function triage(ctx) {
  const body = ctx.message?.body_clean || '';
  const hits = (re) => (body.match(re) || []).length;
  const threat = /죽|가만 안|찾아가|가만두지/.test(body);
  const sentiment = Math.min(5, 1 + Math.min(hits(/사기|화나|짜증|최악|신고|고소|황당|어이없/g), 3) + (threat ? 1 : 0) + (/!{2,}/.test(body) ? 1 : 0));
  const urgency = /급해|빨리|오늘|당장|즉시/.test(body) ? 'high' : 'normal';
  const customerWants = mask(firstSentence(body)).slice(0, 80);
  return { ...triageIntent(ctx), sentiment, urgency, threat, customerWants };
}

function triageIntent(ctx) {
  const body = ctx.message?.body_clean || '';
  const pack = ctx.pack;
  const language = /[가-힣]/.test(body) ? 'ko' : 'en';
  const questionSummary = firstSentence(body);
  const evidence = [mask(questionSummary)];
  const base = { handoffReason: null, kbSections: [], riskSignals: [], questionSummary, handoffTopic: null, repeatsPrevious: false, language, evidence };
  if (!body.trim()) return { ...base, intent: 'ignore', confidence: 1, kbHit: false };
  if (body.length <= 60 && ACK_RE.test(body) && !QUESTION_RE.test(body)) return { ...base, intent: 'ack', confidence: 0.95, kbHit: false };
  const prior = (ctx.history || []).filter((m) => m.id !== ctx.message?.id && m.direction === 'in');
  const repeatsPrevious = prior.some((m) => norm(m.body_clean) === norm(body));
  for (const [intent, re, opt] of RULES[pack.channel] || []) {
    if (!re.test(body)) continue;
    const def = pack.intents[intent] || {};
    const reason = typeof opt.reason === 'function' ? opt.reason(body) : (opt.reason || null);
    const keys = opt.kb || def.kb || [];
    const present = keys.filter((k) => ctx.kb.sections[k]);
    const kbHit = def.level === 'H' ? false : keys.length === 0 ? true : present.length === keys.length ? true : present.length ? 'partial' : false;
    return { ...base, intent, handoffReason: reason, confidence: 0.92, kbHit, kbSections: present, riskSignals: opt.risk || [], repeatsPrevious };
  }
  return { ...base, intent: 'unclear', handoffReason: 'unclear', confidence: 0.4, kbHit: false };
}

function respond(ctx) {
  const t = ctx.triage; const kb = ctx.kb;
  if (ctx.violations?.length && ctx.previousBody) {
    // 재작성 흉내 — 걸린 구절을 걷어낸다
    let b = ctx.previousBody;
    for (const v of ctx.violations) if (v.quote) b = b.split(v.quote).join('');
    b = b.replace(/\{[^{}\n]{1,40}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim();
    return { body: b || null, usedFacts: ctx.previousUsedFacts || [], humanCommitments: [], needsHandoff: !b, handoffReason: b ? null : 'guard_failed' };
  }
  const secs = (t.kbSections || []).map((k) => kb.sections[k]).filter(Boolean);
  // 영어 문의: 영어 KB에 같은 키가 다 있어야 답한다(mock은 번역하지 않는다). 없으면 사람에게.
  if (t.language === 'en' && (kb.language !== 'en' || secs.length < (t.kbSections || []).length)) {
    return { body: null, usedFacts: [], humanCommitments: [], needsHandoff: true, handoffReason: 'language_unsupported' };
  }
  let body;
  if (t.intent === 'reviewing') body = '검토해 주신다니 감사합니다. 좋은 방향으로 검토되시길 바랍니다. 궁금한 점이 생기면 언제든 이 메일로 알려주세요.';
  else if (t.intent === 'declined') body = '알려주셔서 감사합니다. 다음에 필요하실 때 언제든 다시 문의해 주세요.';
  else if (!secs.length) return { body: null, usedFacts: [], humanCommitments: [], needsHandoff: true, handoffReason: 'out_of_knowledge' };
  else if (t.language === 'en') body = secs.length === 1 ? `Thank you for your message. Here is how it works.\n\n${secs[0].text}` : `Thank you for your message.\n\n${secs.map((s, i) => `${i + 1}) ${s.title}\n${s.text}`).join('\n\n')}`;
  else if (secs.length === 1) body = `문의 주신 ${secs[0].title} 관련해 안내드립니다.\n\n${secs[0].text}`;
  else body = `문의 주신 내용 아래와 같이 안내드립니다.\n\n${secs.map((s, i) => `${i + 1}) ${s.title}\n${s.text}`).join('\n\n')}`;
  if (t.intent === 'quote_request') body += '\n\n정확한 견적은 담당자가 이어서 안내드리겠습니다.';
  if (t.kbHit === 'partial' && t.handoffTopic) body += `\n\n${t.handoffTopic}은(는) 담당자가 이어서 안내드리겠습니다.`;
  const humanCommitments = (ctx.humanMessages || []).map((m) => firstSentence(m.body_clean)).filter(Boolean);
  return { body, usedFacts: secs.map((s) => s.key), humanCommitments, needsHandoff: false, handoffReason: null };
}

function review(ctx) {
  const ok = !!ctx.body && String(ctx.body).trim().length > 10;
  return { pass: ok, reasons: ok ? [] : [{ code: 'not_answered', quote: String(ctx.body || '').slice(0, 60) }] };
}

function brief(ctx) {
  const t = ctx.triage; const reason = ctx.reason;
  const facts = Object.entries(ctx.knownFacts || {}).map(([k, v]) => `${k}: ${v}`);
  const request = t?.questionSummary || firstSentence(ctx.message?.body_clean);
  const kbHint = (t?.kbSections || []).map((k) => ctx.kb.sections[k]?.text).filter(Boolean)[0];
  return {
    summary: `${ctx.pack.label} 문의. ${t ? `분류 「${labels.intent(t.intent)}」` : '코드 규칙'}으로 넘김(${labels.reason(reason)}). 고객 요청: ${request}`,
    request,
    knownFacts: facts,
    recommendedReply: ctx.draftBody ? '에이전트 답장이 함께 나간다 — 넘긴 부분만 이어서 답하면 된다.' : (kbHint || '[담당자 판단] 고객 요청을 확인한 뒤 답한다.'),
    nextAction: NEXT_ACTION[reason] || '담당자 확인',
  };
}

// 매뉴얼 변환: 머리말(#)마다 절 하나. PDF는 자리표시 절 하나. 결정적이다.
function convert(ctx) {
  const c = ctx.convert || {};
  if (c.pdf) return { sections: [{ key: 'mock_pdf', title: '목업 변환 — PDF는 실제 LLM에서만 읽는다', sourceRef: 'p.1', body: '목업 변환 — PDF는 실제 LLM에서만 읽는다.', validUntil: null }], omitted: [] };
  const parts = [];
  for (const line of String(c.text || '').split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) parts.push({ title: h[1].trim(), lines: [] });
    else { if (!parts.length) parts.push({ title: c.ref || '본문', lines: [] }); parts[parts.length - 1].lines.push(line); }
  }
  const sections = parts.map((p) => ({ title: p.title, body: p.lines.join('\n').trim() })).filter((p) => p.body)
    .map((p, i) => ({ key: `s${c.index || 1}_${i + 1}`, title: p.title, sourceRef: p.title, body: p.body.slice(0, 1200), validUntil: null }));
  return { sections, omitted: [] };
}

// ReAct 흉내(답장 Agent만): 지금까지 부른 툴과 결과를 대화에서 읽어 다음 툴 하나를 고른다.
// (이전 문의를 가리키면 search_past_cases, 소속 회사를 말하면 get_customer_record, 주문·배송을 물으면 lookup_order, 결제·환불·구독을 물으면 lookup_billing, 계정·로그인·탈퇴를 물으면 lookup_account, 미팅·일정을 물으면 find_meeting_slots — 노출됐을 때만) →
// read_knowledge_base(필요한 절) → check_draft → 위반이면 걸린 구절을 걷어내 다시 check_draft → 통과하면 submit_draft.
// 지식베이스에 없어 넘길 때는 search_knowledge_base → report_knowledge_gap → request_handoff.
const PAST_RE = /지난번|저번|이전에\s*문의|전에\s*(문의|말씀|여쭤)|last time|previously/i;
const COMPANY_RE = /저희\s*회사|우리\s*회사|저희\s*팀|회사\s*계정|our company|our team/i;
const ORDER_RE = /주문|배송|택배|order|shipping/i;
const BILLING_RE = /결제|환불|구독|요금|청구|자동결제|billing|refund|charge|subscription/i;
const ACCOUNT_RE = /계정|로그인|잠겼|잠김|잠금|탈퇴|권한|account|log ?in|locked/i;
const MEETING_RE = /미팅|일정|가능한\s*시간|빈\s*시간|meeting|schedule/i;
function chat({ agent, ctx, messages = [], tools = [] }) {
  if (agent !== 'responder') throw new Error(`mock chat: 알 수 없는 agent ${agent}`);
  const calls = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, input: b.input });
      if (b.type === 'tool_result') { const c = calls.find((x) => x.id === b.tool_use_id); if (c) c.result = JSON.parse(b.content); }
    }
  }
  const use = (name, input) => ({ content: [{ type: 'tool_use', id: `toolu_mock_${calls.length + 1}`, name, input }], stopReason: 'tool_use' });
  const has = (name) => tools.some((t) => t.name === name);
  const called = (name) => calls.some((c) => c.name === name);
  const body = ctx.message?.body_clean || '';
  if (has('search_past_cases') && !called('search_past_cases') && PAST_RE.test(body)) return use('search_past_cases', {});
  if (has('get_customer_record') && !called('get_customer_record') && COMPANY_RE.test(body)) return use('get_customer_record', {});
  if (has('lookup_order') && !called('lookup_order') && ORDER_RE.test(body)) return use('lookup_order', {});
  if (has('lookup_billing') && !called('lookup_billing') && BILLING_RE.test(body)) return use('lookup_billing', {});
  if (has('lookup_account') && !called('lookup_account') && ACCOUNT_RE.test(body)) return use('lookup_account', {});
  if (has('find_meeting_slots') && !called('find_meeting_slots') && MEETING_RE.test(body)) return use('find_meeting_slots', {});
  const d = respond(ctx);
  if (d.needsHandoff && d.handoffReason === 'out_of_knowledge') {
    const q = ctx.triage?.questionSummary || firstSentence(body);
    if (has('search_knowledge_base') && !called('search_knowledge_base')) return use('search_knowledge_base', { query: q });
    if (has('report_knowledge_gap') && !called('report_knowledge_gap')) return use('report_knowledge_gap', { question: q, nearestKeys: [] });
  }
  if (d.needsHandoff) return use('request_handoff', { reason: d.handoffReason });
  if (d.usedFacts.length && !called('read_knowledge_base')) return use('read_knowledge_base', { keys: d.usedFacts });
  const last = [...calls].reverse().find((c) => c.name === 'check_draft' || c.name === 'submit_draft');
  if (!last) return use('check_draft', { body: d.body, usedFacts: d.usedFacts });
  if (last.result?.ok) return use('submit_draft', { body: last.input.body, usedFacts: last.input.usedFacts, humanCommitments: d.humanCommitments });
  let fixed = last.input.body;
  for (const v of last.result?.violations || []) if (v.quote) fixed = fixed.split(v.quote).join('');
  fixed = fixed.replace(/[ \t]{2,}/g, ' ').trim();
  if (!fixed || fixed === last.input.body) return use('request_handoff', { reason: 'guard_failed' });
  return use('check_draft', { body: fixed, usedFacts: last.input.usedFacts });
}

async function json({ agent, ctx }) {
  if (process.env.LLM_MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.LLM_MOCK_DELAY_MS)));
  switch (agent) {
    case 'triage': return triage(ctx);
    case 'responder': return respond(ctx);
    case 'reviewer': return review(ctx);
    case 'briefer': return brief(ctx);
    case 'kb_convert': return convert(ctx);
    default: throw new Error(`mock: 알 수 없는 agent ${agent}`);
  }
}

async function chatDelayed(req) {
  if (process.env.LLM_MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.LLM_MOCK_DELAY_MS)));
  return chat(req);
}

module.exports = { json, chat: chatDelayed, RULES, triage, respond, review, brief };
