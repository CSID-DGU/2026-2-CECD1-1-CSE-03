// 서버 enum → 화면 문구. 값 목록은 server/crm.js · policy/*.json · docs/states.md 기준.

export const CHANNEL_LABEL: Record<string, string> = {
  support: '고객문의',
  onboarding: '온보딩',
  sales: '영업 문의',
};

export const ORIGIN_LABEL: Record<string, string> = { Email: '이메일', Web: '웹' };

/** 카테고리 칸 — Figma의 쇼핑몰 카테고리 대신 백엔드 caseReason을 쓴다. */
export const REASON_LABEL: Record<string, string> = {
  account: '계정',
  billing: '결제 · 요금',
  howto: '사용 방법',
  data: '데이터',
  onboarding: '온보딩',
  scheduling: '일정 · 미팅',
  sales: '영업 · 견적',
  complaint: '불만',
  other: '기타',
};

/** 검토 사유 칸 — 접수 · 검수 Agent가 사람에게 넘긴 이유. */
export const HANDOFF_LABEL: Record<string, string> = {
  refund_request: '환불 요청',
  billing_dispute: '결제 분쟁',
  data_export: '데이터 반출',
  complaint: '불만',
  legal_threat: '법적 언급',
  human_request: '사람 요청',
  call_meeting: '통화 · 미팅',
  injection: '프롬프트 조작 의심',
  out_of_knowledge: '지식 밖',
  low_confidence: '확신도 낮음',
  no_progress: '진전 없음',
  round_limit: '왕복 한도',
  guard_failed: '본문 검사 실패',
  llm_error: 'AI 오류',
  unclear: '의도 불명확',
  policy_exception: '정책 예외',
  pricing: '가격 문의',
  custom_data: '맞춤 데이터',
  account_identity: '본인 확인',
  sender_changed: '발신자 변경',
  sender_unverified: '발신자 미확인',
  internal_error: '내부 오류',
  language_unsupported: '미지원 언어',
  discarded: '초안 폐기',
  threat: '위협',
  price_contract: '가격 · 계약',
  contract_documents: '계약 서류',
  purchase_intent: '구매 의사',
  list_request: '목록 요청',
  takeover: '사람이 인수',
  human_reply: '사람이 답변',
  answer_and_handoff: '답변 후 넘김',
};

/** 위험 신호로 빨갛게 보여줄 사유 (Figma: 법적 언급 · 금지 표현 감지). */
export const RISK_REASONS = new Set(['legal_threat', 'threat', 'injection', 'guard_failed', 'complaint']);

export const CLOSE_REASON_LABEL: Record<string, string> = {
  resolved: '해결됨',
  no_response: '고객 무응답',
  duplicate: '중복 문의',
  spam: '스팸',
  not_applicable: '해당 없음',
  other: '기타',
  ignored_first_message: '응대 불필요 (자동)',
  declined_ack: '거절 회신 (자동)',
  courtesy_reply: '인사 답장 (자동)',
  inactive: '장기 무응답 (자동)',
};

/** 사람이 고를 수 있는 종결 사유 (server/crm.js CLOSE_REASONS). */
export const CLOSE_REASONS = ['resolved', 'no_response', 'duplicate', 'spam', 'not_applicable', 'other'] as const;

export const OUTCOME_LABEL: Record<string, string> = {
  auto_answered: 'AI 자동 답변',
  answered_after_approval: '승인 후 발송',
  answered_and_handed_off: '답변 후 넘김',
  human_answered: '직접 작성',
  handed_off: '사람에게 넘김',
  shadow: '섀도 (미발송)',
  ignored: '응대 불필요',
};

export const URGENCY_LABEL: Record<string, string> = { low: '낮음', normal: '보통', high: '높음' };

export const TOOL_LABEL: Record<string, string> = {
  read_knowledge_base: '지식 조회',
  check_draft: '초안 검사',
  submit_draft: '초안 제출',
};

export function label(map: Record<string, string>, key: string | null | undefined, fallback = '—'): string {
  if (!key) return fallback;
  return map[key] ?? key;
}
