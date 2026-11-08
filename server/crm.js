'use strict';
// CRM 투영 — 처리 테이블 행(cases.getCase 모양)에서 컬렉션 문서(케이스·활동·수신 이벤트)와 CRM 화면 응답을 만든다.
// 순수 모듈: require·현재 시각 없음. 서버(server/collections.js)와 프로토타입 심이 같은 코드로 같은 문서를 낸다 — 같은 입력이면 같은 문서.
// 문서의 시각은 전부 원천 행에서 온다. 한국어 라벨은 활동 summary(코드가 만든 짧은 이름)에만 — 결과 코드(resolution 등)는 화면이 옮긴다.

const STATUSES = ['New', 'Working', 'On Hold', 'Escalated', 'Closed'];
const SUB_STATUSES = ['Awaiting Approval', 'Waiting on Customer'];
const CASE_TYPES = ['Question', 'Problem'];
const CASE_REASONS = ['account', 'billing', 'howto', 'data', 'onboarding', 'scheduling', 'sales', 'complaint', 'other'];
const CLOSE_REASONS = ['resolved', 'no_response', 'duplicate', 'spam', 'not_applicable', 'other'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const ORIGINS = ['Email', 'Web'];
// 목록 필터 → 허용 값. null = 값 집합이 팩 수만큼 열려 있다(사업 라인 = 채널 이름 모양만 본다).
const FILTERS = { status: STATUSES, subStatus: SUB_STATUSES, caseType: CASE_TYPES, caseReason: CASE_REASONS, priority: PRIORITIES, origin: ORIGINS, recordType: null };
const ACTIONS = ['approve', 'edit_approve', 'discard', 'takeover', 'human_reply', 'note', 'hold', 'unhold', 'return', 'close', 'rate_shadow', 'resolve_sending'];
// 공용 메일 도메인 — 고객사를 만들지 않는다(B2C 문의자는 companyId null).
const PUBLIC_DOMAINS = ['gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'nate.com'];
// 우선순위 High — 이 넘김 사유이거나 분류 위험 신호가 이것
const HIGH_REASONS = ['legal_threat', 'injection', 'billing_dispute', 'complaint', 'sender_unverified', 'sender_changed'];
const HIGH_RISKS = ['legal', 'billing', 'complaint'];
// 자동 종결 사유 → closeReason
const AUTO_CLOSE = { ignored_first_message: 'not_applicable', declined_ack: 'resolved', courtesy_reply: 'resolved', inactive: 'no_response' };
// 상태를 바꾸는 사람·시스템 행동(activities.type). 메모·평가·발송 실패 기록은 상태를 안 바꾼다.
const STATE_ACTS = ['takeover', 'return', 'close', 'hold', 'unhold', 'auto_close', 'approve', 'edit_approve', 'auto_send', 'human_reply', 'discard', 'resolve_sending'];
const LABEL = {
  inbound: '고객 메일', agent_reply: '에이전트 답장', ack: '접수 안내', human_reply: '담당자 직접 답장', approve: '초안 승인', edit_approve: '초안 수정 후 승인',
  discard: '초안 폐기', takeover: '담당자 인수', return: '에이전트에게 반환', close: '종결', hold: '보류', unhold: '보류 해제', note: '메모', handoff: '사람에게 넘김',
  auto_close: '자동 종결', auto_send: '자동 발송', auto_ack: '접수 안내 자동 발송', auto_send_failed: '자동 발송 실패', send_unconfirmed: '발송 확인 필요',
  resolve_sending: '발송 확인 처리', shadow_rating: '섀도 초안 평가', purge: '원문 파기', reopen: '재오픈',
};
const INTAKE = { type: 'system', id: 'intake' };
const AGENT = { type: 'agent', id: 'agent' };

const obj = (v) => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };
const last = (a) => a[a.length - 1];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** 처리 테이블의 행위자 문자열 → ActorRef. */
const actorOf = (s) => (s === 'system' ? { type: 'system', id: 'system' } : s === 'agent' || s === 'agent:auto' ? { type: 'agent', id: s } : { type: 'user', id: s ?? null });
const has = (q, k) => q[k] !== undefined && q[k] !== null && q[k] !== '';

/** 상태 매핑(위에서부터 처음 맞는 행). */
function statusOf(c, decisions) {
  if (c.state === 'CLOSED') return ['Closed', null];
  if (c.responder === 'human') return c.held_at ? ['On Hold', null] : ['Escalated', c.state === 'WAITING_CUSTOMER' ? 'Waiting on Customer' : null];
  if (c.state === 'AWAITING_APPROVAL') return ['Working', 'Awaiting Approval'];
  if (c.state === 'WAITING_CUSTOMER') return ['Working', 'Waiting on Customer'];
  if (c.state === 'AGENT_ACTIVE' || c.state === 'HANDED_OFF') return ['Working', null]; // HANDED_OFF + 에이전트 = 반환이 큐에 줄 선 경로
  return [decisions.some((d) => d.step === 'execute' || d.step === 'error') ? 'Working' : 'New', null];
}

/**
 * 상태에 영향을 주는 원천 행 중 가장 최근 것 — statusHistory 귀속·audit.updatedBy.
 * 순위(시각이 같으면 앞이 이긴다): 사람·시스템 행동 → 담당 변경(cases.responder_*) → 넘김 → 실행·오류 판단 → 수신 메일.
 */
function latestSource({ case: c, activities = [], handoffs = [], decisions = [], messages = [] }) {
  const rows = [];
  for (const a of activities) if (STATE_ACTS.includes(a.type)) rows.push([a.created_at, 0, actorOf(a.actor), a.type, `act:${a.id}`]);
  if (c.responder_changed_at) rows.push([c.responder_changed_at, 1, actorOf(c.responder_changed_by), c.responder_change_reason ?? null, `case:${c.id}`]);
  for (const h of handoffs) rows.push([h.created_at, 2, AGENT, h.reason, `handoff:${h.id}`]);
  for (const d of decisions) if (d.step === 'execute' || d.step === 'error') rows.push([d.created_at, 3, AGENT, d.action ?? null, `decision:${d.id}`]);
  for (const m of messages) if (m.direction === 'in') rows.push([m.occurred_at, 4, INTAKE, 'inbound', `msg:${m.id}`]);
  let b = null;
  for (const r of rows) if (!b || r[0] > b[0] || (r[0] === b[0] && r[1] <= b[1])) b = r; // 같은 시각·같은 순위면 나중 행
  return b ? { at: b[0], by: b[2], reason: b[3], sourceId: b[4] } : { at: c.created_at, by: INTAKE, reason: 'inbound', sourceId: `case:${c.id}` };
}

/** 마지막 답장·넘김·판단 → 결과 코드. 답장 뒤 감사 인사(IGNORE)는 결과를 덮지 않는다. */
function outcomeOf(c, drafts, handoffs, decisions) {
  const sent = last(drafts.filter((d) => d.status === 'SENT' && d.action !== 'ACK').sort((a, b) => cmp(a.sent_at, b.sent_at)));
  const ho = last(handoffs);
  if (sent && (!ho || sent.sent_at >= ho.created_at)) {
    return sent.action === 'HUMAN_REPLY' ? 'human_answered' : sent.approved_by === 'agent:auto' ? 'auto_answered'
      : sent.action === 'ANSWER_AND_HANDOFF' ? 'answered_and_handed_off' : 'answered_after_approval';
  }
  if (ho || c.responder === 'human') return 'handed_off';
  const ex = last(decisions.filter((d) => d.step === 'execute'))?.action;
  return ex === 'SHADOW' ? 'shadow' : ex === 'IGNORE' ? 'ignored' : null;
}

/**
 * 케이스 문서. detail = {case, messages, drafts, decisions, handoffs, activities, loop}(cases.getCase 모양, JSON 칼럼은 풀었거나 문자열 그대로).
 * ctx = {pack, caseNumber(cases.rowid), contactId, companyId, eventIdOf(messageId), sourceTypeOf?(messageId)}.
 * prev = 직전 문서 — caseNumber는 복사만, statusHistory는 (status, subStatus)가 바뀔 때만 한 줄 덧붙인다.
 * @returns {{doc, changed}} changed=false면 doc은 prev 그대로
 */
function projectCase(detail, prev, ctx = {}) {
  const c = detail.case;
  const messages = detail.messages || []; const drafts = detail.drafts || []; const decisions = detail.decisions || [];
  const handoffs = detail.handoffs || []; const acts = detail.activities || [];
  const purged = !!c.purged_at;
  const ins = messages.filter((m) => m.direction === 'in');
  const tri = decisions.filter((d) => d.step === 'triage');
  const lead = last(tri.filter((d) => d.reason !== 'ack' && d.reason !== 'ignore')); // ack·ignore는 유형을 바꾸지 않는다
  const intent = lead?.reason ?? null;
  const def = intent ? ctx.pack?.intents?.[intent] : null;
  const risks = obj(lead?.output)?.riskSignals || [];
  const lastHo = last(handoffs);
  const [status, subStatus] = statusOf(c, decisions);
  const src = latestSource(detail);
  const history = prev?.statusHistory ? [...prev.statusHistory] : [];
  const top = last(history);
  if (!top || top.toStatus !== status || top.toSubStatus !== subStatus) {
    history.push({ fromStatus: top?.toStatus ?? null, toStatus: status, fromSubStatus: top?.toSubStatus ?? null, toSubStatus: subStatus, changedAt: src.at, changedBy: src.by, reason: src.reason, sourceId: src.sourceId });
  }
  const lc = last(acts.filter((a) => a.type === 'close' || a.type === 'auto_close'));
  const closeReason = status !== 'Closed' ? null : c.close_reason ?? (lc?.type === 'auto_close' ? AUTO_CLOSE[obj(lc.payload)?.reason] ?? null : null);
  const st = ins[0] && ctx.sourceTypeOf?.(ins[0].id);
  const lastReply = last(messages.filter((m) => m.direction === 'out' && m.sent_by !== 'ack'));
  const doc = {
    id: c.id, caseNumber: prev?.caseNumber ?? String(ctx.caseNumber ?? 0).padStart(8, '0'), recordType: c.channel,
    origin: st ? (/_form$/.test(st) ? 'Web' : 'Email') : prev?.origin ?? 'Email',
    caseType: def?.caseType ?? null, caseReason: def?.caseReason ?? null, intent,
    priority: HIGH_REASONS.includes(lastHo?.reason) || risks.some((r) => HIGH_RISKS.includes(r)) ? 'High'
      : handoffs.length || def?.level === 'H' || c.state === 'AWAITING_APPROVAL' ? 'Medium' : 'Low',
    status, subStatus, isClosed: status === 'Closed', isEscalated: handoffs.length > 0 || !!c.responder_changed_at, // 담당이 바뀐 적 있다 = 사람이 맡은 적 있다
    closeReason, closeDetail: c.close_detail ?? null,
    subject: purged ? null : c.subject ?? null, summary: purged ? null : lead?.input_summary ?? null,
    contactId: ctx.contactId ?? null, companyId: ctx.companyId ?? null,
    suppliedName: purged ? null : c.customer_name ?? null, suppliedEmail: purged ? null : c.customer_email || null,
    owner: c.responder === 'human' ? { type: 'user', id: c.assignee ?? null } : { ...AGENT },
    hold: c.held_at ? { note: c.hold_note ?? null, since: c.held_at } : null, relatedCaseId: c.related_case_id ?? null,
    resolution: {
      outcome: outcomeOf(c, drafts, handoffs, decisions),
      handoffReason: lastHo?.reason ?? (c.responder === 'human' ? c.responder_change_reason ?? null : null),
      nextAction: obj(lastHo?.briefing)?.nextAction || null,
      lastReplyActivityId: lastReply ? `msg:${lastReply.id}` : null,
    },
    attribution: { caseCreationEventId: ins[0] ? ctx.eventIdOf?.(ins[0].id) ?? null : null, latestInboundEventId: ins.length ? ctx.eventIdOf?.(last(ins).id) ?? null : null },
    statusHistory: history, lifecycleStatus: purged ? 'anonymized' : 'active',
    audit: { createdAt: c.created_at, createdBy: { ...INTAKE }, updatedAt: [c.updated_at, ...acts.map((a) => a.created_at)].reduce((a, b) => (b > a ? b : a)), updatedBy: src.by },
  };
  const changed = !prev || JSON.stringify(prev) !== JSON.stringify(doc);
  return { doc: changed ? doc : prev, changed };
}

/** 활동 문서 — 메일(수신·발신) + 사람·시스템 행동 + 넘김. 매번 원천 행에서 다시 계산한다(판단 트레이스는 넣지 않는다). */
function projectActivities(detail, ctx = {}) {
  const c = detail.case;
  const base = { caseId: c.id, contactId: ctx.contactId ?? null, companyId: ctx.companyId ?? null };
  const life = c.purged_at ? 'anonymized' : 'active';
  const mk = (key, type, direction, at, inboundEventId, subtype, body, meta, actor) => ({
    id: key, dedupeKey: key, type, direction, occurredAt: at, ...base, inboundEventId, subtype, summary: LABEL[subtype] || subtype, body,
    meta: { editTags: [], handoffReason: null, nextAction: null, ...meta }, actor, lifecycleStatus: life,
    audit: { createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor },
  });
  const out = [];
  for (const m of detail.messages || []) {
    if (m.direction === 'in') { out.push(mk(`msg:${m.id}`, 'email', 'inbound', m.occurred_at, ctx.eventIdOf?.(m.id) ?? null, 'inbound', null, {}, { ...INTAKE })); continue; }
    const sub = m.sent_by === 'human' ? 'human_reply' : m.sent_by === 'ack' ? 'ack' : 'agent_reply';
    out.push(mk(`msg:${m.id}`, 'email', 'outbound', m.occurred_at, null, sub, m.body || null, {}, sub === 'human_reply' ? actorOf(m.sender) : { ...AGENT }));
  }
  for (const a of detail.activities || []) {
    const p = obj(a.payload) || {};
    const note = a.type === 'note' || a.type === 'shadow_rating';
    const body = a.type === 'note' ? p.text : a.type === 'shadow_rating' || a.type === 'hold' ? p.note : null;
    out.push(mk(`act:${a.id}`, note ? 'note' : 'status_change', 'internal', a.created_at, null, a.type, body ?? null, { editTags: Array.isArray(p.editTags) ? p.editTags : [] }, actorOf(a.actor)));
  }
  for (const h of detail.handoffs || []) {
    out.push(mk(`handoff:${h.id}`, 'status_change', 'internal', h.created_at, null, 'handoff', null, { handoffReason: h.reason, nextAction: obj(h.briefing)?.nextAction || null }, { ...AGENT }));
  }
  return out;
}

/**
 * 수신 이벤트 문서(문의 한 건). message = messages 행(event_id 포함) + 있으면 수신 원값 {from, name, replyTo, inReplyTo, references, knownFacts, parsedName}.
 * opts = {sourceType, method, reasonCode, system?, recordedAt?}. parsed·processing·matching 결과는 처음 값 — 이후 동기화가 채운다.
 */
function eventFromMessage(m, caseRow, { sourceType, method, reasonCode = null, system = 'inbound_api', recordedAt } = {}) {
  const at = recordedAt || m.occurred_at;
  const kind = /_form$/.test(sourceType) ? 'form' : sourceType === 'manual' ? 'manual' : 'email';
  const v = (x) => x ?? null;
  return {
    id: m.event_id, sourceType,
    source: { system, accountId: caseRow.channel, providerObjectId: v(m.provider_message_id), threadId: v(m.thread_id) },
    dedupeKey: `${kind}:${caseRow.channel}:${m.provider_message_id ?? `msg:${m.id}`}`, occurredAt: m.occurred_at, recordedAt: at,
    rawPayload: {
      from: m.from ?? m.sender ?? null, name: v(m.name), subject: v(m.subject), body: v(m.body), replyTo: v(m.replyTo), inReplyTo: v(m.inReplyTo),
      references: v(m.references), senderAuth: v(m.sender_auth), autoSubmitted: !!m.auto_submitted, knownFacts: v(m.knownFacts),
    },
    rawPayloadSchemaVersion: 1,
    parsed: { parserVersion: 1, email: contactKey(m.sender), name: v(m.parsedName), language: null, intent: null, caseType: null, caseReason: null, riskSignals: [] },
    processing: { status: 'pending', attempts: 0, nextRetryAt: null, errorCode: null },
    matching: { status: 'resolved', method, reasonCode },
    resolvedCaseId: caseRow.id, resolvedContactId: null, resolvedCompanyId: null,
    privacy: { classification: 'personal', retentionUntil: null, legalHold: false },
    lifecycleStatus: 'active',
    audit: { createdAt: at, createdBy: { ...INTAKE }, updatedAt: at, updatedBy: { ...INTAKE } },
  };
}

/** 문의자 키 — 소문자·trim 주소. 비면(파기) null. */
const contactKey = (email) => String(email ?? '').trim().toLowerCase() || null;

/** 고객사 도메인 — 공용 메일·문의 폼·사내 도메인(하위 도메인 포함)이면 null. */
function companyDomain(email, { formDomains = [], internalDomains = [] } = {}) {
  const d = (contactKey(email)?.match(/@([^@\s>]+)$/) || [])[1];
  if (!d) return null;
  const under = (list) => list.map((x) => String(x).trim().toLowerCase()).filter(Boolean).some((f) => d === f || d.endsWith(`.${f}`));
  return PUBLIC_DOMAINS.includes(d) || under(formDomains) || under(internalDomains) ? null : d;
}

/** 이 케이스 문서에서 지금 누를 수 있는 명령. 파기된 케이스는 없다. */
function actionsFor(doc, { pendingDraft, shadowDraft, sendingDraft } = {}) {
  if (doc.lifecycleStatus === 'anonymized') return [];
  const on = new Set({
    New: ['takeover', 'note', 'close'], Working: ['takeover', 'note', 'close'], Escalated: ['human_reply', 'note', 'hold', 'return', 'close'],
    'On Hold': ['unhold', 'human_reply', 'note', 'close'], Closed: [],
  }[doc.status] || []);
  if (pendingDraft && (doc.status === 'New' || doc.status === 'Working')) for (const a of ['approve', 'edit_approve', 'discard']) on.add(a);
  if (shadowDraft) on.add('rate_shadow');
  if (sendingDraft?.needsSendCheck) on.add('resolve_sending');
  return ACTIONS.filter((a) => on.has(a));
}

/** 목록 질의 검사 — 집합 밖 값이면 그 필드 이름, 아니면 null. 빈 값은 필터 없음. */
function badFilter(q = {}) {
  for (const [k, set] of Object.entries(FILTERS)) {
    if (has(q, k) && (set ? !set.includes(q[k]) : !/^[a-z0-9_-]{1,40}$/.test(String(q[k])))) return k;
  }
  return has(q, 'q') && String(q.q).length > 100 ? 'q' : null;
}

/**
 * 목록 — status·subStatus 외 필터를 먼저 걸고 counts(상태별)·subCounts(응대 중 안의 세부 상태)를 센 뒤 status·subStatus로 거른다.
 * 정렬: audit.updatedAt 내림차순, 같으면 caseNumber 내림차순. limit 1–500(기본 100). q = 제목·이름·주소·케이스 번호 부분 일치(대소문자 무시).
 * 단순화: 케이스 문서 전체를 JS로 거른다 — 수만 건이면 status 인덱스 + SQL 필터.
 */
function listView(docs, q = {}) {
  const needle = String(q.q ?? '').trim().toLowerCase();
  const base = docs.filter((d) => ['caseType', 'caseReason', 'priority', 'origin', 'recordType'].every((k) => !has(q, k) || d[k] === q[k])
    && (!needle || [d.subject, d.suppliedName, d.suppliedEmail, d.caseNumber].some((v) => String(v ?? '').toLowerCase().includes(needle))));
  const counts = { all: base.length, ...Object.fromEntries(STATUSES.map((s) => [s, 0])) };
  const subCounts = Object.fromEntries(SUB_STATUSES.map((s) => [s, 0]));
  for (const d of base) { counts[d.status] += 1; if (d.status === 'Working' && d.subStatus) subCounts[d.subStatus] += 1; }
  const lim = Math.min(Math.max(Math.trunc(Number(q.limit)) || 100, 1), 500);
  const items = base.filter((d) => (!has(q, 'status') || d.status === q.status) && (!has(q, 'subStatus') || d.subStatus === q.subStatus))
    .sort((a, b) => cmp(b.audit.updatedAt, a.audit.updatedAt) || cmp(b.caseNumber, a.caseNumber)).slice(0, lim);
  return { items, counts, subCounts };
}

/**
 * 상세 응답. related = 이 케이스와 이어진 케이스 문서(지금은 비어 있다 — 종결 뒤 회신은 같은 케이스를 다시 연다), events = 이 케이스 수신 이벤트 문서, activities = 활동 문서.
 * 초안 셋은 drafts 행(getCase 모양) 또는 이미 줄인 모양 — 화면에 필요한 칸만 남긴다. 판단·규칙·프롬프트 해시는 없다.
 */
function detailView({ doc, revision, contact = null, company = null, related = [], events = [], activities = [], pendingDraft = null, shadowDraft = null, sendingDraft = null }) {
  const pd = pendingDraft && { id: pendingDraft.id, intent: pendingDraft.intent ?? null, action: pendingDraft.action ?? null, body: pendingDraft.original_body ?? pendingDraft.body ?? null, preview: pendingDraft.preview ?? null, kbPassages: pendingDraft.kbPassages ?? {} };
  const sd = shadowDraft && { id: shadowDraft.id, body: shadowDraft.original_body ?? shadowDraft.body ?? null };
  const xd = sendingDraft && { id: sendingDraft.id, needsSendCheck: !!(sendingDraft.needs_send_check ?? sendingDraft.needsSendCheck) };
  const rank = (r) => (r.relation === 'previous' ? 0 : 1);
  const relatedCases = related.filter((r) => r.id === doc.relatedCaseId || r.relatedCaseId === doc.id)
    .map((r) => ({ id: r.id, caseNumber: r.caseNumber, status: r.status, subject: r.subject, relation: r.id === doc.relatedCaseId ? 'previous' : 'followup' }))
    .sort((a, b) => rank(a) - rank(b) || cmp(a.caseNumber, b.caseNumber));
  const timeline = [
    ...events.map((e) => ({ kind: 'inbound', at: e.occurredAt, eventId: e.id, sender: e.parsed?.email ?? null, subject: e.rawPayload?.subject ?? null, body: e.rawPayload?.body ?? null, senderAuth: e.rawPayload?.senderAuth ?? null })),
    ...activities.filter((a) => !(a.type === 'email' && a.direction === 'inbound')).map((a) => ({ kind: 'activity', at: a.occurredAt, activity: a })),
  ].sort((a, b) => cmp(a.at, b.at) || cmp(a.kind === 'inbound' ? 0 : 1, b.kind === 'inbound' ? 0 : 1) || cmp(a.eventId ?? a.activity.id, b.eventId ?? b.activity.id));
  return {
    case: doc, revision, contact, company, relatedCases, timeline, pendingDraft: pd || null, shadowDraft: sd || null, sendingDraft: xd || null,
    actions: actionsFor(doc, { pendingDraft: pd, shadowDraft: sd, sendingDraft: xd }),
  };
}

module.exports = {
  projectCase, projectActivities, eventFromMessage, contactKey, companyDomain, actionsFor, badFilter, listView, detailView,
  FILTERS, STATUSES, SUB_STATUSES, CASE_TYPES, CASE_REASONS, CLOSE_REASONS, PRIORITIES, ORIGINS,
};
