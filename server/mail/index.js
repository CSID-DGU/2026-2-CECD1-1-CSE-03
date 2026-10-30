'use strict';
// MAIL_PROVIDER=mock | smtp. 프로토타입 기본은 mock(DB 기록만). 메일 템플릿(인사·맺음·AI 고지)도 여기 둔다.
const mock = require('./mock');

const name = () => process.env.MAIL_PROVIDER || 'mock';
const COMPANY = () => process.env.COMPANY_NAME || 'ACME';
const AGENT = () => process.env.AGENT_NAME || 'Aria';

/** 본문에 한글이 없으면 영어 메일로 본다. */
const langOf = (body) => (/[가-힣]/.test(String(body || '')) ? 'ko' : 'en');

/** auto = 사람 승인 없이 나가는 메일(L2 자동 발송·접수 안내) — 맺음말이 "담당자 검토"라고 말하면 안 된다. */
function renderAgent({ name: customer, body, auto = false }) {
  return langOf(body) === 'en'
    ? `Hello ${customer || 'there'},\nThis is ${AGENT()}, the AI support agent at ${COMPANY()}.\n\n${body}\n\nPlease reply to this email if you have any questions.\n\n— ${auto ? 'This email was sent automatically by our AI support agent.' : 'This email was sent after review by our staff.'}`
    : `안녕하세요, ${customer || '고객'} 님.\n${COMPANY()}의 AI 상담 에이전트 ${AGENT()}입니다.\n\n${body}\n\n궁금하신 점은 이 메일에 회신해 주세요. 감사합니다.\n\n— ${auto ? '이 메일은 AI 상담 에이전트가 자동으로 보냈습니다.' : '이 메일은 담당자 검토 후 발송되었습니다.'}`;
}

function renderHuman({ name: customer, by, body }) {
  return langOf(body) === 'en'
    ? `Hello ${customer || 'there'},\nThis is ${by} from ${COMPANY()}.\n\n${body}\n\nBest regards.`
    : `안녕하세요, ${customer || '고객'} 님.\n${COMPANY()} ${by}입니다.\n\n${body}\n\n감사합니다.`;
}

// 실발송 provider는 수신자 도메인 허용 목록(MAIL_ALLOWED_DOMAINS, 쉼표)이 비어 있으면 전체 차단.
function assertRecipientAllowed(to) {
  const allowed = String(process.env.MAIL_ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const domain = String(to || '').split('@').pop().toLowerCase();
  if (!allowed.includes(domain)) throw new Error(`recipient_not_allowed: ${domain || '(없음)'}`);
}

async function send(msg) {
  if (name() === 'mock') return mock.send(msg);
  assertRecipientAllowed(msg.to);
  if (name() === 'smtp') return require('./smtp').send(msg); // smtp 어댑터는 실발송 때만 읽는다
  throw new Error(`알 수 없는 MAIL_PROVIDER: ${name()}`);
}

module.exports = { send, name, assertRecipientAllowed, renderAgent, renderHuman, langOf };
