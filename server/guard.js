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
const CONTACT_SRC = String.raw`(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}|(?<![\w-])(?:\+?82[-\s.]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\w)|(?<![\w-])0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}(?!\w)|(?<![\w-])1[5-9]\d{2}[-\s.]?\d{4}(?!\w)`;
const CONTACT_RE = new RegExp(CONTACT_SRC);
const maskContacts = (s) => (s == null ? s : String(s).replace(new RegExp(CONTACT_SRC, 'g'), '[연락처]'));

// LLM 입력 마스킹 — 고객 유래 텍스트의 식별자를 ASCII 토큰으로 바꾼다. 한글 토큰은 영어 메일의 언어 판정(langOf·mock)을 ko로 뒤집는다.
// 토큰이 초안에 새면 unresolved_slot(KB에 없는 대괄호)이 잡아 넘김으로 끝난다.
const RRN_RE = /(?<!\d)\d{6}[-\s]?[1-8]\d{6}(?!\d)/g; // 주민·외국인등록번호(하이픈·공백·구분자 없음)
const CARD_RE = /(?<![\d-])\d(?:[- ]?\d){12,18}(?![\d-])/g; // 13–19자리
// maskPii 전용 연락처 — 표기 변형(괄호 지역번호, 여러 대시, 띄어 쓴 구분자, 한글 도메인 메일)까지 본다. 전각 글자는 replaceNfkc가 펼쳐서 맞춘다.
// guard.check·maskContacts·cases가 쓰는 CONTACT_RE는 그대로 둔다(초안 검사·판단 기록 마스킹의 범위를 바꾸지 않는다).
const PSEP = String.raw`(?:[ \t]*[-–—.)][ \t]*|\s+)?`;
const PII_PHONE_SRC = String.raw`(?<![\w-])\(?(?:\+?82${PSEP})?0?1[016789]${PSEP}\d{3,4}${PSEP}\d{4}(?!\w)|(?<![\w-])\(?0\d{1,2}${PSEP}\d{3,4}${PSEP}\d{4}(?!\w)|(?<![\w-])1[5-9]\d{2}${PSEP}\d{4}(?!\w)|(?<![\w+])\+\d{1,3}(?:${PSEP}\(?\d{2,4}){2,4}(?!\d)`;
// 메일: 영문 부분은 기존 식 그대로, 비영문 글자로 된 이름·도메인 라벨(홍길동@회사.한국)을 더한다. 비영문 이름은 영문 글자를 품지 않는다 — "문의는support@…"의 "문의는"을 먹지 않게. 앞의 (?=비ASCII)는 ASCII 위치에서 느린 \p 뒤보기를 건너뛰는 지름길
const UCH = String.raw`(?:(?!\w)[\p{L}\p{N}])`;
const ULABEL = String.raw`(?:[\w-]{1,63}|${UCH}{1,63})`;
const PII_EMAIL_SRC = String.raw`(?:(?<![\w.+-])[\w.+-]{1,64}|(?=[^\x00-\x7f])(?<![\p{L}\p{N}_.+-])${UCH}{1,64})@${ULABEL}(?:\.${ULABEL}){1,8}`;
// 영문 메일 → (아직 @가 남았으면) 비영문 메일 → 전화 순서로 나눠 찾는다. 한 식으로 합치거나 u 플래그로 영문 메일까지 보면 긴 입력에서 몇 배 느리다
const PII_EMAIL_ASCII_RE = /(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
const PII_EMAIL_RE = new RegExp(PII_EMAIL_SRC, 'gu');
const PII_PHONE_RE = new RegExp(PII_PHONE_SRC, 'gu');
const PII_STEPS = [
  (t) => replaceNfkc(t, RRN_RE, '[RRN]'), (t) => replaceNfkc(t, CARD_RE, '[CARD]'), (t) => replaceNfkc(t, PII_EMAIL_ASCII_RE, '[CONTACT]'),
  (t) => (/[@＠]/.test(t) ? replaceNfkc(t, PII_EMAIL_RE, '[CONTACT]') : t), (t) => replaceNfkc(t, PII_PHONE_RE, '[CONTACT]'),
];
/**
 * 글자마다 NFKC로 펼친 문자열(전각 숫자·＠ → ASCII)에서 찾고, 원문의 그 구간만 token으로 바꾼다.
 * 매치 밖 글자는 원문 그대로 둔다 — 전각·호환 문자가 든 다른 문장을 바꾸지 않는다.
 */
function replaceNfkc(s, re, token) {
  if (s.normalize('NFKC') === s) return s.replace(re, token); // 펼칠 글자가 없으면 원문 그대로 찾는다
  let norm = ''; const start = []; const end = [];
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)); const n = ch.normalize('NFKC');
    for (let k = 0; k < n.length; k += 1) { start.push(i); end.push(i + ch.length); }
    norm += n; i += ch.length;
  }
  let out = ''; let last = 0;
  for (const m of norm.matchAll(re)) {
    if (!m[0]) continue;
    const a = start[m.index]; const b = end[m.index + m[0].length - 1];
    if (a < last) continue;
    out += s.slice(last, a) + token; last = b;
  }
  return out + s.slice(last);
}
const LABELED_RE = /(계좌(?:\s*번호)?|입금(?:\s*계좌)?|여권(?:\s*번호)?|passport(?:\s*(?:no\.?|number))?|(?:주문|결제|거래|승인|송장)\s*번호|order\s*(?:no\.?|number|id|#))([\s:：#=]*(?:은|는|이|가)?[\s:：#=]*)((?=[A-Za-z-]*\d)[A-Za-z0-9][A-Za-z0-9-]{3,})/gi;
const GROUPED_RE = /(?<![\w-])\d{2,6}-\d{2,6}-\d{2,8}(?![\w-])/g; // 라벨 없는 3묶음 번호(계좌·사업자등록번호), 10–16자리만
// 도로명 주소 — 행정 단위(…시·…군·…구) 뒤의 …로/…길 + 번지만. 앞에 행정 단위가 없거나 번지 뒤가 횟수·단계면 그대로("말씀하신대로 2번").
const ADDRESS_RE = /(?:[가-힣]+(?:시|군|구)\s+)+[가-힣0-9]+(?:로|길)\s*\d+(?:-\d+)?(?![\d-]|\s*(?:번|단계|회|차|개|명|건|원|%))/g;
// 이름 경계. 영문 이름은 영문·숫자 경계만 본다(Ann ≠ announcement, 한글 조사·서명이 바로 붙은 Ann드림은 이름).
// 한글 이름은 앞에 한글이 붙으면 다른 낱말이다. 3음절 이상은 뒤에 무엇이 붙어도 이름(김철수드림·김철수라고·김철수랑),
// 2음절은 다른 낱말 안에 흔히 들어 있어(이수 ⊂ 이수증) 호칭·조사·서술격이 붙을 때만 이름으로 본다.
const NAME_SUFFIX = '님|씨|께|에게|한테|은|는|이|가|을|를|의|도|와|과|로|랑|라고|입니다|예요|에요|드림';
// 표시명이 직함·부서(관리자·고객센터·결제팀·ACME Support …)면 이름이 아니다 — 가리면 본문의 같은 낱말("관리자 권한")까지 [NAME]이 된다.
const ROLE_NAME_RE = /^(고객|관리자|담당자|매니저|대표|팀장)$|(팀|센터|담당)$|(^|\s)(admin|support|team|manager)$/i;
function nameRe(n, flags) {
  const syllables = (n.match(/[가-힣]/g) || []).length;
  if (!syllables) return new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, flags);
  return new RegExp(`(?<![A-Za-z0-9가-힣])${escapeRe(n)}${syllables >= 3 ? '' : `(?=$|[^A-Za-z0-9가-힣]|${NAME_SUFFIX})`}`, flags);
}

/**
 * 순서: 링크(KB에 있는 링크는 둔다) → 주민 → 카드 → 연락처 → 라벨 붙은 계좌·여권·주문 번호 → 3묶음 번호 → 도로명 주소 → 이름.
 * 링크는 guard.check와 같은 비교 키(경로·질의 포함)로 KB와 대조한다 — KB 호스트라도 `?token=…`이 붙은 링크는 가린다.
 * 이름은 대소문자 무시, 낱말 단위 일치. `고객`·직함·부서(ROLE_NAME_RE)·2자 미만·KB 본문에 낱말로 있거나 회사명과 같은 이름은 가리지 않는다(표시명이 회사명인 전달 메일).
 */
function maskPii(text, { name, kbText = '', company } = {}) {
  if (text == null) return text;
  const kbLinks = new Set((String(kbText).match(LINK_RE) || []).map(linkKey));
  let s = String(text).replace(LINK_RE, (u) => { const t = trimUrl(u); return kbLinks.has(linkKey(t)) ? u : `[LINK]${u.slice(t.length)}`; });
  s = PII_STEPS.reduce((t, step) => step(t), s)
    .replace(LABELED_RE, (_m, label, sep) => `${label}${sep}[${/^(계좌|입금)/.test(label) ? 'ACCOUNT' : /^(여권|passport)/i.test(label) ? 'PASSPORT' : 'ORDER'}]`)
    .replace(GROUPED_RE, (m) => (m.replace(/-/g, '').length >= 10 && m.replace(/-/g, '').length <= 16 ? '[ACCOUNT]' : m))
    .replace(ADDRESS_RE, '[ADDRESS]');
  const n = String(name || '').trim();
  if (n.length >= 2 && !ROLE_NAME_RE.test(n) && n.toLowerCase() !== String(company || '').toLowerCase() && !nameRe(n, 'i').test(String(kbText))) {
    s = s.replace(nameRe(n, 'gi'), '[NAME]');
  }
  return s;
}

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

module.exports = { check, maskContacts, maskPii, CONTACT_RE, URL_RE };
