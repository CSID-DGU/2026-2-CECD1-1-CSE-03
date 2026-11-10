'use strict';
// 사람이 읽는 문장(브리핑 요약 등)에 넣는 코드의 한국어 이름. JSON 필드에는 코드를 그대로 둔다.
// 대시보드(web/app.js LABELS)에도 같은 표가 있다 — 브라우저 파일이라 이 모듈을 못 읽는다. 둘 다 policy/*.json의 intent·사유 전부를 덮는다(test/repo-contract.test.js).
const INTENT = {
  account_deletion: '계정 탈퇴', receipt: '영수증', cancel_subscription: '구독 해지', feature_howto: '기능 사용법', login_issue: '로그인 문제',
  refund: '환불', billing_dispute: '결제 분쟁', data_export: '데이터 반출', pricing_exception: '요금 예외', access_grant: '권한·라이선스 부여',
  custom_data: '맞춤 데이터 요청', complaint: '불만·항의', legal: '법적 언급', human_request: '사람 연결 요청', unclear: '뜻 불분명',
  injection: '지시 변경 시도', ack: '감사·확인 인사', ignore: '무시 대상', onboarding_request: '온보딩 요청', meeting_request: '미팅 요청',
  pricing_question: '요금 문의', trial_access: '체험 권한', service_question: '서비스 문의', material_request: '자료 요청', quote_request: '견적 요청',
  reviewing: '검토 중', declined: '진행 거절', purchase_intent: '진행 의사', price_negotiation: '가격 협상', custom_quote: '맞춤 견적',
  list_request: '명단 요청', contract_documents: '계약 서류',
};
const REASON = {
  refund_request: '환불 요청', billing_dispute: '결제 분쟁', data_export: '데이터 반출', complaint: '불만·항의', legal_threat: '법적 언급',
  human_request: '사람 연결 요청', call_meeting: '통화·미팅 요청', contract_documents: '계약 서류', purchase_intent: '진행 의사', price_contract: '금액·계약 조건',
  list_request: '명단 요청', pricing: '요금 문의', policy_exception: '정책 예외', account_identity: '본인 확인 필요', injection: '지시 변경 시도',
  custom_data: '맞춤 데이터 요청', out_of_knowledge: '지식베이스에 없음', low_confidence: '확신 낮음', no_progress: '같은 질문 반복', round_limit: '왕복 한도',
  guard_failed: '검사 실패', llm_error: 'LLM 장애', internal_error: '내부 오류', unclear: '뜻 불분명', sender_changed: '보낸 사람 바뀜', sender_unverified: '발신자 인증 실패',
  language_unsupported: '지원 안 하는 언어', discarded: '초안 폐기',
};
// CRM 케이스 필드(server/crm.js) — 문서에는 코드를 두고 사람이 읽는 곳에서 옮긴다. 대시보드는 web/app.js LABELS에 같은 표.
const CRM = {
  status: { New: '신규', Working: '응대 중', 'On Hold': '보류', Escalated: '사람 전담', Closed: '종결' },
  subStatus: { 'Awaiting Approval': '승인 대기', 'Waiting on Customer': '고객 회신 대기' },
  caseType: { Question: '질문', Problem: '문제' },
  caseReason: { account: '계정', billing: '결제·요금', howto: '사용법', data: '데이터', onboarding: '온보딩', scheduling: '일정', sales: '영업', complaint: '불만', other: '기타' },
  priority: { High: '높음', Medium: '보통', Low: '낮음' },
  origin: { Email: '이메일', Web: '웹 폼' },
  closeReason: { resolved: '해결됨', no_response: '고객 무응답', duplicate: '중복', spam: '스팸', not_applicable: '응대 불필요', other: '기타' },
};

module.exports = {
  INTENT, REASON, CRM,
  intent: (code) => INTENT[code] || code,
  reason: (code) => REASON[code] || code,
};
