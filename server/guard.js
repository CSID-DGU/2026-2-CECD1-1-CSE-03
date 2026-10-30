'use strict';
// 코드 guard(spec §3 ⑦) — 초안 본문 규칙 검사.
// 연락처 마스킹(maskContacts)도 여기 둔다 — 판단 기록·SSE·브리핑에 같은 패턴을 쓴다.
const URL_RE = /https?:\/\/[\x21-\x7e]+/g;
// 스킴 없는 링크 — www.로 시작하거나, 마지막 라벨이 영문 2자 이상인 도메인 뒤에 경로가 붙은 것.
// 경로 없는 파일명(intro.pdf)·버전(v1.2)·소수·이메일 도메인, 확장자 뒤 /목록(Node.js/Python, report.csv/xlsx)은 링크가 아니다.
const FILE_EXT = 'js|jsx|ts|tsx|py|rb|go|rs|java|kt|php|sh|md|txt|csv|tsv|xlsx?|docx?|pptx?|pdf|hwpx?|json|xml|ya?ml|html?|css|png|jpe?g|gif|svg|webp|zip|gz|mp[34]|mov|wav|log|sql';
const LINK_RE = new RegExp(String.raw`https?:\/\/[\x21-\x7e]+|(?<![\w@./-])(?:www\.[\w-]+(?:\.[\w-]+)+|(?:[\w-]+\.)+(?!(?:${FILE_EXT})\/)[a-z]{2,}(?=\/))(?:\/[\x21-\x7e]*)?`, 'gi');
// ™ ® ©는 상표·저작권 표기 — 이모지가 아니다(회사명에 들어가면 모든 승인이 막힌다).
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}/u;

// 연락처 — 이메일, 휴대폰(+82·공백·하이픈·붙여 쓰기), 지역번호, 대표번호(1588-xxxx 등)
const CONTACT_SRC = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\w-])(?:\+?82[-\s.]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\w)|(?<![\w-])0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}(?!\w)|(?<![\w-])1[5-9]\d{2}[-\s.]?\d{4}(?!\w)`;
const CONTACT_RE = new RegExp(CONTACT_SRC);
const maskContacts = (s) => (s == null ? s : String(s).replace(new RegExp(CONTACT_SRC, 'g'), '[연락처]'));

// 미치환 자리표시 — {슬롯}·{}·[고객명]·○○ 님·XXX 님·△△님·<이름> 님·<NAME>. KB에 그대로 있는 [메뉴 이름]과 경로([설정 > 계정])는 허용.
// 사람 직접 답장의 <…>는 "님"이 붙거나 식별자 모양일 때만 — 사람은 <help@acme.example>(주소)·<안내문>(제목 인용)을 쓴다.
// 에이전트 초안은 @·/·. 없는 <…> 전부(<링크>·<고객명> 고객님·Hi <name>) — 모델이 남긴 빈칸이다.
const SLOT_RES = [/\{[^{}\n]{0,40}\}/, /(?:[○◯●△▲□■◇◆*＊]{2,}|\b(?:o{2,}|x{2,})\b)\s*님/i, /<[^<>\n@]{1,20}>\s*님|<(?:[A-Z][A-Z_]+|\w+_\w+)>/];
const AGENT_SLOT_RE = /<[^<>\n@/.]{1,20}>/;
const BRACKET_RE = /\[[^\]\n]{1,20}\]/g;

// 금액 — 통화 기호·코드가 앞뒤에 붙은 숫자, "10만 정도"처럼 만·천·억 뒤에 어림말이 오는 것, 천 단위 쉼표 숫자.
// 수량(명·건·개·편)은 팩 guard.allowQuantities === false일 때만.
const AMOUNT_RE = /[$₩€£¥]\s*\d|\b(?:USD|KRW|EUR|JPY|GBP|CNY)\s*\d|\d[\d,.]*\s*(?:만\s*원|천\s*원|억\s*원?|원|달러|USD|KRW|EUR|%|퍼센트|percent\b|dollars?\b|bucks\b|won\b|euros?\b|유로|위안)|\d\s*(?:불|엔)(?=$|[^가-힣]|이|은|을|의|에|도|씩|입|정도|가량|짜리)|\d[\d,.]*\s*[만천억]\s*(?:정도|가량|선|내외|안팎|$|[.,!?)~])|(?<![\d.])\d{1,3}(?:,\d{3})+(?![\d])/i;
const QTY_RE = /\d[\d,.]*\s*(?:[만천억]\s*)?(?:명|건|개|편)/;

// 날짜 "약속" — 날짜·기한 말 + 40자 안의 약속 동사. 항상 검사한다(allowDates와 무관).
// 숫자 기간은 기한 꼬리(까지·이내·안에·내·후…)가 붙을 때만 — "30일간 보관", "24시간 고객센터"는 사실이다. "다음 주소"·"이번 주문"은 날짜가 아니다.
// "주말에는 답변이 늦어질 수 있습니다"는 일정 안내다("주말까지 답변드리겠습니다"는 약속). "주말에는 …드리겠습니다"처럼 약속 어미가 오면 약속.
const DATE_WORD = String.raw`(?:오늘|금일|당일|내일|명일|익일|모레|금주|차주|익주|(?:이번|다음|다다음)\s*(?:주|달|분기)(?=\s|$|[에까중말내안부초])|이달|금월|익월|월말|월초|연말|연내|주말(?!에는|에도|엔|은)|즉시|(?:다음|익)\s*영업일|[월화수목금토일]요일|\d+\s*(?:영업일|시간|주일|주|일|개월|달)\s*(?:까지|이내|안에|안으로|내로|내에|내(?![가-힣])|후|뒤))`;
const PROMISE_VERB = String.raw`(?:드리겠|드릴게|드립니다|하겠|해\s*드리|보내|처리[되됩될]|완료[되됩될]|전달|연락|회신|답변|발송|예정|도착)`;
const DATE_PROMISE_RE = new RegExp(String.raw`${DATE_WORD}[^.\n]{0,40}?${PROMISE_VERB}|주말(?:에는|에도|엔|은)[^.\n]{0,40}?(?:드리겠|드릴게|하겠|해\s*드리)`);
// 영어 — "by <날짜>"·"within/in <기간>"·"next business day"는 그 자체로 기한, 그 밖의 날짜 말은 앞뒤 40자 안의 약속 주어(we will·you'll receive…)와 같이 있을 때.
const EN_DAY = String.raw`(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)`;
const EN_DATE = String.raw`(?:today|tonight|tomorrow|(?:this|next) (?:week|month|${EN_DAY})|${EN_DAY}|end of (?:the )?(?:day|week|month))`;
const EN_PROMISE = String.raw`(?:we(?:['’]ll| will| shall| are going to)|i(?:['’]ll| will)|you(?:['’]ll| will) (?:receive|get|hear))`;
const DATE_PROMISE_EN_RE = new RegExp(String.raw`\bby (?:the )?(?:${EN_DATE}|end of)\b|\bwithin (?:the next |a|an|one|two|three|few|a few|\d+)\s*(?:business\s*|working\s*)?(?:hours?|days?|weeks?|months?)\b|\bin (?:\d+|a few)\s*(?:business\s*|working\s*)?(?:hours?|days?)\b|\bnext (?:business|working) day\b|\b${EN_PROMISE}\b[^.\n]{0,40}\b${EN_DATE}\b|\b${EN_DATE}\b[^.\n]{0,40}\b${EN_PROMISE}\b`, 'i');
// 날짜 "사실" — allowDates가 false인 채널만 막는다(예: 온보딩의 "3월 2일 세션"은 허용).
const PLAIN_DATE_RE = /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}-\d{2}-\d{2}|(?<![\d.])\d{1,2}\/\d{1,2}(?![\d/])/;

const trimUrl = (u) => u.replace(/[.,<>"')\]]+$/, '');
// 링크 비교 키 — 스킴·www.를 뗀다(help.example.com/guide == https://help.example.com/guide).
const linkKey = (u) => trimUrl(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
// KB 문장(20자 이상) — intent를 모를 때 "KB를 옮겨 놓고 근거를 비운" 본문을 알아보는 데 쓴다.
const kbSentences = (kb) => Object.values(kb?.sections || {}).flatMap((s) => s.text.split(/(?<=[.!?])\s+/)).map((x) => x.trim()).filter((x) => x.length >= 20);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{body, usedFacts?, pack, kb, intent?: string, only?: string[], human?: boolean}} p only = 이 코드만 본다(사람 직접 답장은 empty·unresolved_slot만)
 *   human = 사람 직접 답장. <…> 자리표시를 좁게 본다.
 *   intent = 분류된 intent. 주면 usedFacts가 팩의 그 intent KB 절 안에 있는지(fact_off_intent)까지 본다. 안 주면(옛 호출) 그 검사는 건너뛴다.
 * @returns {{code:string, quote:string}[]} 빈 배열 = 통과
 */
function check({ body, usedFacts = [], pack, kb, intent = null, only = null, human = false }) {
  const hits = [];
  const hit = (code, quote = '') => { if (!only || only.includes(code)) hits.push({ code, quote: String(quote).slice(0, 60) }); };
  const t = String(body || '');
  if (!t.trim()) { hit('empty'); return hits; }
  const g = pack?.guard || {};
  const max = pack?.thresholds?.maxLength ?? 600;
  if (t.length > max) hit('too_long', `${t.length}자`);
  const scan = t.replace(LINK_RE, ' ');
  const words = (g.forbiddenWords || []).filter((w) => scan.includes(w));
  const wordsEn = (g.forbiddenWordsEn || []).filter((w) => new RegExp(`\\b${escapeRe(w)}`, 'i').test(scan));
  if (words.length || wordsEn.length) hit('forbidden_word', [...words, ...wordsEn].join('·'));
  if (!g.allowAmounts) {
    const m = scan.match(AMOUNT_RE) || (g.allowQuantities === false && scan.match(QTY_RE));
    if (m) hit('amount', m[0]);
  }
  const dp = scan.match(DATE_PROMISE_RE) || scan.match(DATE_PROMISE_EN_RE);
  if (dp) hit('date_promise', dp[0]);
  else if (!g.allowDates) { const m = scan.match(PLAIN_DATE_RE); if (m) hit('date', m[0]); }
  const c = scan.match(CONTACT_RE); if (c) hit('contact', c[0]);
  const kbText = Object.values(kb?.sections || {}).map((s) => s.text).join('\n');
  const kbLinks = new Set((kbText.match(LINK_RE) || []).map(linkKey));
  const badUrl = (t.match(LINK_RE) || []).map(trimUrl).find((u) => !kbLinks.has(linkKey(u)));
  if (badUrl) hit('link_not_in_kb', badUrl);
  const facts = Array.isArray(usedFacts) ? usedFacts : [];
  const unknown = facts.filter((k) => !kb?.sections?.[k]);
  if (unknown.length) hit('unknown_fact', unknown.join(','));
  // 근거는 그 intent에 팩이 허용한 KB 절 안에서만
  const allowed = intent ? pack?.intents?.[intent]?.kb : undefined;
  const off = Array.isArray(allowed) ? facts.filter((k) => kb?.sections?.[k] && !allowed.includes(k)) : [];
  if (off.length) hit('fact_off_intent', off.join(','));
  // 근거를 비운 채 사실을 말함 — intent가 KB 절을 쓰는 답이면 실패(감사·보류처럼 절이 없는 intent는 통과).
  // intent를 모르면 KB 문장을 그대로 옮긴 경우만 잡는다.
  if (!facts.length && (Array.isArray(allowed) ? allowed.length > 0 : kbSentences(kb).some((x) => t.includes(x)))) hit('no_fact');
  const slot = SLOT_RES.map((re) => t.match(re)).find(Boolean) || (!human && t.match(AGENT_SLOT_RE))
    || (scan.match(BRACKET_RE) || []).find((b) => !/[>→]/.test(b) && !kbText.includes(b));
  if (slot) hit('unresolved_slot', Array.isArray(slot) ? slot[0] : slot);
  const e = t.match(EMOJI_RE); if (e) hit('emoji', e[0]);
  return hits;
}

module.exports = { check, maskContacts, CONTACT_RE, URL_RE };
