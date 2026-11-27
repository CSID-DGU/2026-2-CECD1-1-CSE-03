// 기존 백엔드(server/index.js · server/console.js) HTTP API 호출 모음.
// 서버에 없는 기능은 여기에 만들지 않는다 — 화면에서 "기능 구현 필요"로 표시한다.

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    const code = typeof body.error === 'string' ? body.error : `http_${status}`;
    super(code);
    this.status = status;
    this.code = code;
    this.extra = body;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(res.status, (json as Record<string, unknown>) ?? {});
  return json as T;
}

export const get = <T>(path: string) => request<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);

// ───────── 타입 (서버 응답 그대로) ─────────

export type Actor = { type: 'system' | 'agent' | 'user'; id: string | null };

export type Signals = { sentiment: number; urgency: 'low' | 'normal' | 'high'; threat: boolean } | null;

export type CrmStatus = 'New' | 'Working' | 'On Hold' | 'Escalated' | 'Closed';
export type CrmSubStatus = 'Awaiting Approval' | 'Waiting on Customer' | null;

export type StatusHistory = {
  fromStatus: CrmStatus | null;
  toStatus: CrmStatus;
  fromSubStatus: CrmSubStatus;
  toSubStatus: CrmSubStatus;
  changedAt: string;
  changedBy: Actor;
  reason: string | null;
  sourceId: string | null;
};

export type CaseDoc = {
  id: string;
  caseNumber: string;
  recordType: string;
  origin: 'Email' | 'Web';
  caseType: string;
  caseReason: string;
  intent: string | null;
  priority: 'High' | 'Medium' | 'Low';
  status: CrmStatus;
  subStatus: CrmSubStatus;
  isClosed: boolean;
  isEscalated: boolean;
  closeReason: string | null;
  closeDetail: string | null;
  subject: string;
  summary: string | null;
  suppliedName: string | null;
  suppliedEmail: string | null;
  owner: Actor;
  hold: { note: string; since: string } | null;
  relatedCaseId: string | null;
  resolution: {
    outcome: string | null;
    handoffReason: string | null;
    nextAction: string | null;
    lastReplyActivityId: string | null;
  };
  statusHistory: StatusHistory[];
  audit: { createdAt: string; createdBy: Actor; updatedAt: string; updatedBy: Actor };
  signals?: Signals;
};

export type CrmList = {
  items: CaseDoc[];
  counts: Record<string, number>;
  subCounts: Record<string, number>;
};

/** GET /api/cases 의 한 줄 — CRM 목록에 없는 마지막 메시지 정보를 여기서 가져온다. */
export type RawCase = {
  id: string;
  state: string;
  responder: 'agent' | 'human';
  assignee: string | null;
  known_facts: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  lastMessageAt: string | null;
  lastMessageDirection: 'in' | 'out' | null;
  lastMessagePreview: string | null;
  pendingDraftId: string | null;
  sameEmailOpenCases: number;
  reaskedAfterHandoff: boolean;
};

export type Activity = {
  id: string;
  type: 'email' | 'note' | 'status_change';
  direction: 'inbound' | 'outbound' | 'internal';
  occurredAt: string;
  subtype: string | null;
  summary: string | null;
  body: string | null;
  meta: { editTags?: string[]; handoffReason?: string | null; nextAction?: string | null };
  actor: Actor;
};

export type TimelineItem =
  | { kind: 'inbound'; at: string; eventId: string; sender: string; subject: string; body: string; senderAuth: string | null }
  | { kind: 'activity'; at: string; activity: Activity };

export type AgentLog = {
  id: string;
  step: 'triage' | 'respond';
  at: string;
  output: {
    sentiment?: number;
    urgency?: string;
    threat?: boolean;
    customerWants?: string;
    mode?: string;
    steps?: number;
    trace?: { step: number; calls: { tool: string; input: Record<string, unknown>; ok: boolean }[] }[];
    knowledgeGaps?: unknown[];
    actions?: unknown[];
  };
};

export type CaseAction =
  | 'approve'
  | 'edit_approve'
  | 'discard'
  | 'takeover'
  | 'human_reply'
  | 'note'
  | 'hold'
  | 'unhold'
  | 'return'
  | 'close'
  | 'rate_shadow'
  | 'resolve_sending';

export type CrmDetail = {
  case: CaseDoc;
  revision: number;
  contact: { primaryEmail: string; current?: { name?: { value: string } } } | null;
  company: { canonicalName?: string; primaryDomain?: string } | null;
  relatedCases: { id: string; caseNumber: string; status: string; subject: string; relation: 'previous' | 'followup' }[];
  timeline: TimelineItem[];
  pendingDraft: { id: string; intent: string; action: string; body: string; preview: string; kbPassages: Record<string, string> } | null;
  shadowDraft: { id: string; body: string } | null;
  sendingDraft: { id: string; needsSendCheck: boolean } | null;
  agentLog: AgentLog[];
  actions: CaseAction[];
};

export type RawDetail = {
  case: RawCase;
  handoffs: {
    id: string;
    reason: string;
    created_at: string;
    briefing: {
      summary?: string;
      request?: string;
      knownFacts?: Record<string, unknown> | string[];
      recommendedReply?: string;
      nextAction?: string;
    } | null;
  }[];
};

export type Stats = {
  total: number;
  unresolved: number;
  awaitingApproval: number;
  handedOff: number;
  waitingCustomer: number;
  closed: number;
  todayInbound: number;
  agentDrafts: number;
  approvedNoEdit: number;
  approvedEdited: number;
  discarded: number;
  firstResponse: { base: number; auto: number; handedOff: number; none: number; human: number; rate: number | null };
};

export type ServerStatus = {
  company: string;
  auth: 'header' | 'none';
  provider: { llm: string; mail: string };
  autoSend: boolean;
  testInject: boolean;
};

// ───────── 호출 ─────────

export const api = {
  status: () => get<ServerStatus>('/api/status'),
  me: () => get<{ user: string | null; auth: 'header' | 'none' }>('/api/me'),
  stats: () => get<Stats>('/api/stats'),
  crmCases: () => get<CrmList>('/api/crm/cases?limit=500'),
  rawCases: () => get<RawCase[]>('/api/cases?limit=500'),
  crmCase: (id: string) => get<CrmDetail>(`/api/crm/cases/${id}`),
  rawCase: (id: string) => get<RawDetail>(`/api/cases/${id}`),

  approve: (draftId: string, by: string, finalBody?: string) =>
    post<{ caseId: string; edited: boolean }>(`/api/drafts/${draftId}/approve`, finalBody ? { by, finalBody } : { by }),
  humanReply: (caseId: string, by: string, body: string) => post(`/api/cases/${caseId}/human-reply`, { by, body }),
  close: (caseId: string, by: string, reason: string, detail?: string, expectedRevision?: number) =>
    post(`/api/cases/${caseId}/close`, { by, reason, detail, expectedRevision }),
  takeover: (caseId: string, by: string) => post(`/api/cases/${caseId}/takeover`, { by }),
  giveBack: (caseId: string, by: string) => post(`/api/cases/${caseId}/return`, { by }),
  note: (caseId: string, by: string, text: string) => post(`/api/cases/${caseId}/note`, { by, text }),
};

/** 서버 오류 코드를 화면 문구로. 모르는 코드는 코드 그대로 보여준다. */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return '서버에 연결하지 못했어요. 백엔드(npm start)가 켜져 있는지 확인해 주세요.';
  const map: Record<string, string> = {
    not_pending: '이미 처리된 초안이에요. 새로고침해 주세요.',
    stale: '그 사이 내용이 바뀌었어요. 새로고침해 주세요.',
    closed: '이미 종결된 문의예요.',
    already_closed: '이미 종결된 문의예요.',
    already_answered: '이미 답변이 나간 문의예요.',
    responder_human: '사람이 맡고 있는 문의라 초안을 승인할 수 없어요.',
    sending: '발송 중이에요. 잠시 후 다시 시도해 주세요.',
    guard: '본문 검사에서 걸렸어요. 금액 · 날짜 · 금지 표현을 확인해 주세요.',
    send_failed: '메일 발송에 실패했어요.',
    unauthorized: '인증되지 않은 요청이에요.',
    purged: '삭제된 문의예요.',
  };
  return map[e.code] ?? e.code;
}
