'use strict';
// 코드 1차 거르기(LLM 전). 요청 "문장"만 잡는다 — 단어 하나("담당자","미팅")로 넘기면 인사·인용까지 걸린다.
// 규칙의 사유가 채널 팩 handoffReasons에 없으면 그 규칙은 그 채널에서 안 돈다(예: 온보딩은 미팅 요청이 정상 문의).
// 규칙 세 번째 칸(채널 목록)이 있으면 그 채널에서만 돈다.

// 자동 회신은 (a) 수신 어댑터가 헤더로 표시(autoSubmitted) (b) 제목이 표지로 시작 (c) 짧은 본문이 표지로 시작 — 셋뿐이다.
// 표지 = 괄호로 감싸거나("[부재중]") 콜론이 붙은("Automatic reply:") 머리말. 본문에 "부재중"·"자동 응답"이 들어 있다는
// 이유로 버리지 않는다("부재중 전화가 와서…", "자동 응답 기능 설정 방법").
const MARK = String.raw`(?:부재중|자동\s*(?:회신|응답|답장)|out of office|automatic reply|auto-?reply)`;
const AUTO_MARK_RE = new RegExp(String.raw`^\s*(?:[[(]\s*${MARK}\s*[\])]|${MARK}\s*[:：])`, 'i');
const AUTO_BODY_MAX = 200;
const RULES = [
  // "안내"는 뺐다 — "이전 안내는 무시해 주세요"는 고객이 자기 앞 메일을 거두는 말이다. 지시·프롬프트·명령·규칙은 모델에게 하는 말.
  ['injection', /(이전|위의?|앞의?|앞에서|기존|모든)\s*(말한\s*)?(지시|프롬프트|명령|규칙)[^.\n]{0,12}(무시|잊|신경\s*쓰지)|(ignore|disregard)\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions|prompts?|rules)|시스템\s*프롬프트|너는\s*이제|you are now/i],
  ['human_request', /(담당자|매니저|사람|직원|상담사|상담원)\s*(분|님)?\s*(과|와|이랑|하고|께|에게|한테)?\s*(직접\s*)?(통화|연락|이야기|얘기|상담|연결|미팅|대화)|연결\s*(해\s*주|부탁)|상담원\s*(으로\s*)?(바꿔|연결)|(실제|진짜)\s*사람이\s*(답|응대)|speak (to|with) (a |an )?(human|person|agent)/i],
  ['call_meeting', /(통화|전화(?!\s*번호)|유선|미팅|화상\s*회의|줌|zoom)[^.\n?]{0,10}?(가능|하고\s*싶|했으면|원해|원합|요청|부탁|잡|주세요|주시면|주실|드려도|나누)/i],
  ['contract_documents', /(계약서|사업자\s*등록증|통장\s*사본|견적서)[^.\n?]{0,12}?(보내|주|받|요청|부탁|전달|공유|발행)/],
  ['legal_threat', /소비자원|공정위|공정거래위원회|고소|소송|법적\s*(대응|조치|책임)|변호사|경찰에/],
  // 실데이터(docs/feasibility.md P1·P2 외) — 법적 위협·주입 뒤. 사유가 팩에 있는 채널에서만 돈다(환불·분쟁은 support뿐).
  // 결제 취소·환급 = 환불, 해지 뒤 결제·계속 빠져나가는 결제 = 분쟁. 연간 구독 중도 해지는 남은 기간 환불 문제다.
  ['refund_request', /(결제|자동\s*결제|정기\s*결제|결제\s*건)[^.\n?]{0,15}(취소|환급)|구독[^.\n?]{0,15}취소/],
  ['refund_request', /중도\s*(해지|취소|해약)|연간\s*(구독|결제|플랜|요금제|이용권)[^.\n?]{0,20}(해지|취소)/],
  ['billing_dispute', /해지[^.\n?]{0,30}결제|결제[^.\n?]{0,30}해지/],
  ['billing_dispute', /(결제|청구|출금)[가이]?\s*(계속|또|다시|여전히)?\s*(되고\s*있|나가고\s*있|빠져\s*나가|발생하고\s*있)|(계속|또|다시|여전히)\s*(결제|청구|출금)[가이]?\s*(되|됐|발생|나가)/],
  // 분석 결과로 피해를 봤다·내려 달라 = 항의
  ['complaint', /(채널|분석|AI)[^.\n?]{0,12}(내려|비공개|노출\s*(중단|제외))[^.\n?]{0,12}(주시|해\s*주|요청|촉구|바랍|원합)|피해[^.\n?]{0,10}(끼치|입었|입고|보고\s*있|주고)/],
  // 요금 — 엔터프라이즈 요금·가격 표기 불일치("요금제마다 기능이 다르나요"는 요금제 비교 질문이라 분류 몫). 할인 요청은 support만(온보딩·영업은 분류가 pricing_question·price_negotiation으로 넘긴다).
  ['pricing', /엔터프라이즈\s*(솔루션|플랜|요금제?|버전|계약|라이선스|상품)|enterprise\s*(plan|pricing|license|contract)|(가격|금액|비용|요금(?!제))[^.\n?]{0,40}(상이|불일치)|(가격|금액|비용|요금)[이가은는]?\s*(서로\s*)?(달라|다르|다릅)/i],
  ['pricing', /할인[^.\n?]{0,15}(가능|되나|될까|되는지|받을|받고|요청|부탁|문의|해\s*주|여쭤)|(맞춤|별도|특별|개별)\s*(요금제?|가격|단가)/, ['support']],
  // 예외 부여 — 크레딧·쿼터·무료 기간, 라이선스·권한, 체험 계정
  ['policy_exception', /(크레딧|쿼터|이용\s*횟수|무료\s*(기간|이용|추가|연장)|사용\s*한도)[^.\n?]{0,20}(지급|추가|연장|부여|늘려|늘리|풀어|올려|받을\s*수|받는)|(라이선스|라이센스|license|이용권)[^.\n?]{0,15}(확인|부여|발급|등록|적용|활성|추가)[^.\n?]{0,10}(부탁|요청|해\s*주|주세요|주시|주실|가능)|권한[^.\n?]{0,10}(부여|열어|풀어)[^.\n?]{0,10}(부탁|요청|해\s*주|주세요|주시|주실|가능)|(체험|트라이얼|데모\s*계정|테스트\s*계정|시범\s*(계정|사용|이용))[^.\n?]{0,20}(해\s*보고\s*싶|하고\s*싶|요청|부탁|받고\s*싶|받을\s*수|신청|원합|드려도)|계정[^.\n?]{0,10}(받아|발급|생성|열어)[^.\n?]{0,25}체험/i],
  // 크리에이터 리스트업 요청 — KB로 만들 수 없는 맞춤 작업(영업만)
  ['list_request', /리스트\s*업[^.\n?]{0,8}(요청|부탁)/],
];

const domainOf = (s) => (String(s || '').match(/[\w.+-]+@([\w-]+\.[\w.-]+)/) || [])[1]?.toLowerCase();

/**
 * @param {{body, subject?, sender?, pack, autoSubmitted?: boolean, senderChanged?: boolean}} p
 * @returns {{action:'IGNORE'|'HANDOFF', reason:string} | null} null = 규칙 통과 → LLM 분류로
 */
function check({ body, subject, sender, pack, autoSubmitted = false, senderChanged = false, internalDomains = (process.env.INTERNAL_DOMAINS || '').split(',').filter(Boolean) }) {
  const text = String(body || '');
  if (!text.trim()) return { action: 'IGNORE', reason: 'auto_reply_or_empty' };
  if (autoSubmitted || AUTO_MARK_RE.test(subject || '') || (text.trim().length <= AUTO_BODY_MAX && AUTO_MARK_RE.test(text))) return { action: 'IGNORE', reason: 'auto_reply_or_empty' };
  const dom = domainOf(sender);
  if (dom && internalDomains.map((d) => d.trim().toLowerCase()).includes(dom)) return { action: 'IGNORE', reason: 'internal_sender' };
  const allowed = new Set(pack?.handoffReasons || [...RULES.map(([r]) => r), 'sender_changed']);
  // 같은 스레드에 다른 주소가 끼어들면 그 사람이 누구인지 사람이 확인한다.
  if (senderChanged && allowed.has('sender_changed')) return { action: 'HANDOFF', reason: 'sender_changed' };
  for (const [reason, re, channels] of RULES) if (allowed.has(reason) && (!channels || channels.includes(pack?.channel)) && re.test(text)) return { action: 'HANDOFF', reason };
  return null;
}

module.exports = { check, RULES, AUTO_MARK_RE };
