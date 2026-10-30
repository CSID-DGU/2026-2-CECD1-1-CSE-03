'use strict';
// npm run sim [--every=15] [--url=http://localhost:3000] — 서버에 합성 문의를 주기적으로 주입한다(대시보드 라이브 데모).
// 70% 새 문의(새 스레드), 30% WAITING_CUSTOMER 케이스에 후속 회신.
const INQUIRIES = require('./inquiries');

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const BASE = arg('url', process.env.SIM_URL || `http://localhost:${process.env.PORT || 3000}`);
const EVERY = Number(arg('every', 15)) * 1000;
const ONCE = process.argv.includes('--once');

const FOLLOWUPS = {
  support: ['확인했습니다. 감사합니다.', '추가로 궁금한 게 있는데 영수증은 어디서 받나요?', '답변 감사합니다. 그런데 환불은 안 되나요?', '안내대로 했는데 로그인이 여전히 안 됩니다.'],
  onboarding: ['네, 다음 주 화요일 오후 괜찮습니다.', '감사합니다. 도입 안내 자료도 받아볼 수 있을까요?', '팀원이 더 늘어날 것 같은데 요금제는 어떻게 되나요?'],
  sales: ['검토 후 연락드리겠습니다.', '담당자와 통화 가능할까요?', '진행 순서가 어떻게 되는지 궁금합니다.', '진행하겠습니다. 계약서 보내주세요.'],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function api(method, p, body) {
  // 배포 서버면 웹훅 시크릿을 같이 보낸다(INBOUND_SECRET).
  const headers = { 'content-type': 'application/json', ...(process.env.INBOUND_SECRET ? { 'x-inbound-secret': process.env.INBOUND_SECRET } : {}) };
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function tick() {
  const waiting = await api('GET', '/api/cases?state=WAITING_CUSTOMER&limit=20');
  if (waiting.length && Math.random() < 0.3) {
    const c = pick(waiting);
    const body = pick(FOLLOWUPS[c.channel] || FOLLOWUPS.support);
    const r = await api('POST', '/api/inbound', { channel: c.channel, from: c.customer_email, name: c.customer_name, subject: `Re: ${c.subject || '문의'}`, body, threadId: c.threadId });
    console.log(`[sim] 후속 회신 → ${c.channel} ${c.customer_name || c.customer_email}: "${body}" (case ${r.caseId.slice(0, 8)})`);
    return;
  }
  const q = pick(INQUIRIES);
  const n = Math.floor(Math.random() * 900 + 100);
  const r = await api('POST', '/api/inbound', {
    channel: q.channel, from: q.from.replace('@', `+${n}@`), name: q.name, subject: q.subject, body: q.body, knownFacts: q.knownFacts, threadId: `sim-${Date.now()}-${n}`,
  });
  console.log(`[sim] 새 문의 → ${q.channel} #${q.id} ${q.subject} (case ${r.caseId.slice(0, 8)}${r.created ? '' : ', 기존'})`);
}

(async () => {
  console.log(`[sim] ${BASE} 에 ${EVERY / 1000}s마다 주입${ONCE ? ' (1회)' : ''}`);
  await tick().catch((e) => console.error('[sim]', e.message));
  if (ONCE) return;
  setInterval(() => tick().catch((e) => console.error('[sim]', e.message)), EVERY);
})();
