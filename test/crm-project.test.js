'use strict';
// CRM 투영 순수 함수 — 상태 매핑·이력·파생 필드·명령·목록·이벤트(server/crm.js). DB 없이 처리 테이블 모양 행만 넣는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crm = require('../server/crm');
const policy = require('../server/policy');

const pack = policy.load('support');
const T = (s) => `2026-11-01T00:00:${String(s).padStart(2, '0')}.000Z`;
let seq = 0;
const id = (p) => `${p}${(seq += 1)}`;
const kase = (o = {}) => ({ id: 'c1', channel: 'support', customer_email: 'kim@acme.example', customer_name: '김', subject: '영수증', state: 'OPEN', responder: 'agent',
  responder_changed_at: null, responder_changed_by: null, responder_change_reason: null, assignee: null, created_at: T(0), updated_at: T(0), closed_at: null, purged_at: null,
  related_case_id: null, hold_note: null, held_at: null, close_reason: null, close_detail: null, ...o });
const inMsg = (at = T(0), o = {}) => ({ id: id('m'), direction: 'in', sent_by: null, sender: 'kim@acme.example', body: '본문', body_clean: '본문', occurred_at: at, ...o });
const dec = (step, action, reason, at, o = {}) => ({ id: id('d'), step, action, reason, created_at: at, output: {}, input_summary: null, ...o });
const act = (type, actor, at, payload = null) => ({ id: id('a'), type, actor, payload, created_at: at });
const detail = (o = {}) => ({ case: kase(o.case), messages: o.messages || [inMsg()], drafts: o.drafts || [], decisions: o.decisions || [], handoffs: o.handoffs || [], activities: o.activities || [], loop: null });
const ctx = { pack, caseNumber: 42, contactId: 'p1', companyId: null, eventIdOf: (mid) => `ev-${mid}` };
const project = (o, prev = null, x = ctx) => crm.projectCase(detail(o), prev, x);

test('U1 상태 매핑 — 위에서부터 처음 맞는 행', () => {
  const ex = [dec('execute', 'DRAFT', null, T(1))];
  const rows = [
    [{ state: 'CLOSED', responder: 'human', held_at: T(1) }, [], ['Closed', null]],
    [{ state: 'HANDED_OFF', responder: 'human', held_at: T(1) }, [], ['On Hold', null]],
    [{ state: 'WAITING_CUSTOMER', responder: 'human' }, [], ['Escalated', 'Waiting on Customer']],
    [{ state: 'AWAITING_APPROVAL', responder: 'human' }, [], ['Escalated', null]],
    [{ state: 'HANDED_OFF', responder: 'human' }, [], ['Escalated', null]],
    [{ state: 'AWAITING_APPROVAL' }, ex, ['Working', 'Awaiting Approval']],
    [{ state: 'WAITING_CUSTOMER' }, ex, ['Working', 'Waiting on Customer']],
    [{ state: 'AGENT_ACTIVE' }, [], ['Working', null]],
    [{ state: 'HANDED_OFF' }, ex, ['Working', null]], // 반환이 큐에 줄 선 경로
    [{ state: 'OPEN' }, [dec('error', 'RETRY', 'llm_error', T(1))], ['Working', null]], // 재시도 대기
    [{ state: 'OPEN' }, [dec('execute', 'SHADOW', 'shadow', T(1))], ['Working', null]], // 섀도 케이스
    [{ state: 'OPEN' }, [dec('execute', 'IGNORE', 'ack', T(1))], ['Working', null]],
    [{ state: 'OPEN' }, [dec('prefilter', 'PASS', null, T(1))], ['New', null]],
    [{ state: 'OPEN' }, [], ['New', null]],
  ];
  for (const [c, decisions, want] of rows) {
    const { doc } = project({ case: c, decisions });
    assert.deepEqual([doc.status, doc.subStatus], want, JSON.stringify(c));
    assert.equal(doc.isClosed, want[0] === 'Closed');
    assert.deepEqual([doc.statusHistory.at(-1).toStatus, doc.statusHistory.at(-1).toSubStatus], want, '현재 상태 = 마지막 이력');
  }
});

test('U2 statusHistory — 바뀔 때만 한 줄, 원천 행 우선순위·시각, 같은 입력이면 prev 그대로', () => {
  const m = inMsg(T(0));
  const first = project({ messages: [m] });
  assert.equal(first.changed, true);
  assert.equal(first.doc.caseNumber, '00000042');
  assert.deepEqual(first.doc.statusHistory, [{ fromStatus: null, toStatus: 'New', fromSubStatus: null, toSubStatus: null, changedAt: T(0), changedBy: { type: 'system', id: 'intake' }, reason: 'inbound', sourceId: `msg:${m.id}` }]);
  const again = crm.projectCase(detail({ messages: [m] }), first.doc, { ...ctx, caseNumber: 99 });
  assert.equal(again.changed, false); assert.equal(again.doc, first.doc, '같은 입력이면 prev 객체 그대로');
  // 승인 대기 — 실행 판단(agent)
  const d1 = dec('execute', 'DRAFT', null, T(2));
  const s2 = crm.projectCase(detail({ case: { state: 'AWAITING_APPROVAL', updated_at: T(2) }, messages: [m], decisions: [d1] }), first.doc, { ...ctx, caseNumber: 99 });
  assert.equal(s2.doc.caseNumber, '00000042', 'caseNumber는 복사만');
  assert.equal(s2.doc.statusHistory.length, 2);
  assert.deepEqual(s2.doc.statusHistory[1], { fromStatus: 'New', toStatus: 'Working', fromSubStatus: null, toSubStatus: 'Awaiting Approval', changedAt: T(2), changedBy: { type: 'agent', id: 'agent' }, reason: 'DRAFT', sourceId: `decision:${d1.id}` });
  // 같은 시각이면 사람 행동 > 담당 변경 > 넘김 > 판단. changedAt은 원천 행 시각(동기화 시각 아님)
  const tk = act('takeover', '김담당', T(5));
  const s3 = crm.projectCase(detail({ case: { state: 'HANDED_OFF', responder: 'human', responder_changed_at: T(5), responder_changed_by: '김담당', responder_change_reason: 'takeover', assignee: '김담당', updated_at: T(5) },
    messages: [m], decisions: [d1, dec('execute', 'HANDOFF', 'x', T(5))], activities: [tk] }), s2.doc, ctx);
  assert.deepEqual(s3.doc.statusHistory.at(-1), { fromStatus: 'Working', toStatus: 'Escalated', fromSubStatus: 'Awaiting Approval', toSubStatus: null, changedAt: T(5), changedBy: { type: 'user', id: '김담당' }, reason: 'takeover', sourceId: `act:${tk.id}` });
  assert.deepEqual(s3.doc.audit.updatedBy, { type: 'user', id: '김담당' });
  // 상태가 같으면 다른 칸이 바뀌어도 이력은 그대로
  const s4 = crm.projectCase(detail({ case: { state: 'HANDED_OFF', responder: 'human', responder_changed_at: T(5), responder_changed_by: '김담당', responder_change_reason: 'takeover', assignee: '박담당', updated_at: T(6) },
    messages: [m], decisions: [d1], activities: [tk] }), s3.doc, ctx);
  assert.equal(s4.changed, true); assert.equal(s4.doc.statusHistory.length, 3); assert.deepEqual(s4.doc.owner, { type: 'user', id: '박담당' });
  // 행위자 매핑: system → system, agent:auto → agent
  const ac = act('auto_close', 'system', T(9), { reason: 'inactive' });
  assert.deepEqual(project({ case: { state: 'CLOSED' }, activities: [ac] }).doc.statusHistory[0].changedBy, { type: 'system', id: 'system' });
  assert.deepEqual(project({ case: { state: 'WAITING_CUSTOMER' }, activities: [act('auto_send', 'agent:auto', T(9))] }).doc.statusHistory[0].changedBy, { type: 'agent', id: 'agent:auto' });
});

test('U3 유형·사유·우선순위·접수 경로·결과·종결 사유 파생', () => {
  const tri = (intent, at, o) => dec('triage', 'CLASSIFIED', intent, at, o);
  // 유형·사유는 팩 intent에서, ack·ignore는 이전 값 유지, 첫 메시지가 ack면 null
  let d = project({ decisions: [tri('receipt', T(1), { input_summary: '영수증 요청' }), tri('ack', T(3))] }).doc;
  assert.deepEqual([d.intent, d.caseType, d.caseReason, d.summary], ['receipt', 'Question', 'billing', '영수증 요청']);
  d = project({ decisions: [tri('ack', T(1))] }).doc;
  assert.deepEqual([d.intent, d.caseType, d.caseReason], [null, null, null]);
  d = project({ decisions: [tri('receipt', T(1)), tri('login_issue', T(2))] }).doc;
  assert.deepEqual([d.caseType, d.caseReason], ['Problem', 'account']);
  // 우선순위
  const ho = (reason, at = T(4)) => ({ id: id('h'), reason, briefing: { nextAction: '법무 공유' }, created_at: at });
  assert.equal(project({ case: { state: 'HANDED_OFF', responder: 'human' }, handoffs: [ho('legal_threat')] }).doc.priority, 'High');
  assert.equal(project({ decisions: [tri('feature_howto', T(1), { output: { riskSignals: ['billing'] } })] }).doc.priority, 'High');
  assert.equal(project({ case: { state: 'HANDED_OFF', responder: 'human' }, handoffs: [ho('out_of_knowledge')] }).doc.priority, 'Medium');
  assert.equal(project({ decisions: [tri('refund', T(1))] }).doc.priority, 'Medium', 'H intent');
  assert.equal(project({ case: { state: 'AWAITING_APPROVAL' } }).doc.priority, 'Medium', '승인 대기');
  assert.equal(project({ decisions: [tri('receipt', T(1))] }).doc.priority, 'Low');
  // 접수 경로 — 첫 이벤트가 폼이면 Web
  const m = inMsg();
  assert.equal(project({ messages: [m] }, null, { ...ctx, sourceTypeOf: () => 'customer_support_form' }).doc.origin, 'Web');
  assert.equal(project({ messages: [m] }, null, { ...ctx, sourceTypeOf: () => 'email_inbound' }).doc.origin, 'Email');
  assert.equal(project({ messages: [m] }).doc.origin, 'Email');
  // 결과
  const sent = (o) => ({ id: id('r'), status: 'SENT', action: 'DRAFT', approved_by: 'kim', sent_at: T(6), ...o });
  const out = (o) => project(o).doc.resolution.outcome;
  assert.equal(out({ drafts: [sent({ approved_by: 'agent:auto' })] }), 'auto_answered');
  assert.equal(out({ drafts: [sent()] }), 'answered_after_approval');
  assert.equal(out({ drafts: [sent({ action: 'ANSWER_AND_HANDOFF' })], handoffs: [ho('price_contract', T(4))] }), 'answered_and_handed_off');
  assert.equal(out({ drafts: [sent({ action: 'HUMAN_REPLY' })] }), 'human_answered');
  assert.equal(out({ drafts: [sent({ action: 'ACK' })], handoffs: [ho('refund_request', T(4))] }), 'handed_off', '접수 안내는 답이 아니다');
  assert.equal(out({ decisions: [dec('execute', 'IGNORE', 'ack', T(2))] }), 'ignored');
  assert.equal(out({ drafts: [sent()], decisions: [dec('execute', 'IGNORE', 'ack', T(9))] }), 'answered_after_approval', '답장 뒤 감사 인사는 결과를 덮지 않는다');
  assert.equal(out({ decisions: [dec('execute', 'SHADOW', 'shadow', T(2))] }), 'shadow');
  assert.equal(out({}), null);
  const r = project({ case: { state: 'HANDED_OFF', responder: 'human', responder_changed_at: T(3), responder_change_reason: 'takeover' } }).doc.resolution;
  assert.deepEqual([r.outcome, r.handoffReason, r.nextAction], ['handed_off', 'takeover', null], '넘김 행이 없으면 담당 변경 사유');
  assert.equal(project({ case: { state: 'HANDED_OFF', responder: 'human' }, handoffs: [ho('legal_threat')] }).doc.resolution.nextAction, '법무 공유');
  // 종결 사유 — 칼럼 우선, 없으면 마지막 자동 종결 사유
  const closed = (o) => project({ case: { state: 'CLOSED', ...o.case }, activities: o.activities || [] }).doc.closeReason;
  assert.equal(closed({ case: { close_reason: 'spam' } }), 'spam');
  assert.equal(closed({ activities: [act('auto_close', 'system', T(2), { reason: 'ignored_first_message' })] }), 'not_applicable');
  assert.equal(closed({ activities: [act('auto_close', 'system', T(2), JSON.stringify({ reason: 'declined_ack' }))] }), 'resolved', 'payload 문자열도');
  assert.equal(closed({ activities: [act('auto_close', 'system', T(2), { reason: 'inactive', days: 30 })] }), 'no_response');
  assert.equal(closed({ activities: [act('auto_close', 'system', T(2), { reason: 'inactive' }), act('close', 'kim', T(3))] }), null, '사유 없는 사람 종결(예전 데이터)');
  assert.equal(project({ case: { state: 'OPEN', close_reason: 'spam' } }).doc.closeReason, null, '열린 케이스는 종결 사유 없음');
});

test('U4 actionsFor — 상태별 명령 + 섀도 평가·발송 확인, 파기면 없음', () => {
  const a = (status, x = {}, life = 'active') => crm.actionsFor({ status, lifecycleStatus: life }, x);
  assert.deepEqual(a('New'), ['takeover', 'note', 'close']);
  assert.deepEqual(a('Working', { pendingDraft: { id: 'd' } }), ['approve', 'edit_approve', 'discard', 'takeover', 'note', 'close']);
  assert.deepEqual(a('Escalated', { pendingDraft: { id: 'd' } }), ['human_reply', 'note', 'hold', 'return', 'close'], '사람 전담엔 승인 없음');
  assert.deepEqual(a('On Hold'), ['human_reply', 'note', 'unhold', 'close']);
  assert.deepEqual(a('Closed'), []);
  assert.deepEqual(a('Closed', { shadowDraft: { id: 's' } }), ['rate_shadow']);
  assert.deepEqual(a('Working', { sendingDraft: { id: 'x', needsSendCheck: false } }), ['takeover', 'note', 'close']);
  assert.deepEqual(a('Working', { sendingDraft: { id: 'x', needsSendCheck: true }, shadowDraft: { id: 's' } }), ['takeover', 'note', 'close', 'rate_shadow', 'resolve_sending']);
  assert.deepEqual(a('Escalated', { shadowDraft: { id: 's' } }, 'anonymized'), []);
});

test('U5 listView·badFilter — 필터·counts·subCounts·정렬·limit·q·집합 밖 값', () => {
  const doc = (n, o) => ({ caseNumber: String(n).padStart(8, '0'), subject: `제목${n}`, suppliedName: `고객${n}`, suppliedEmail: `u${n}@x.example`, recordType: 'support', origin: 'Email',
    caseType: 'Question', caseReason: 'billing', priority: 'Low', status: 'New', subStatus: null, audit: { updatedAt: T(n) }, ...o });
  const docs = [
    doc(1), doc(2, { status: 'Working', subStatus: 'Awaiting Approval' }), doc(3, { status: 'Working', subStatus: 'Waiting on Customer', priority: 'High' }),
    doc(4, { status: 'Escalated', subStatus: 'Waiting on Customer', recordType: 'sales' }), doc(5, { status: 'Closed', audit: { updatedAt: T(1) } }), doc(6, { status: 'On Hold', origin: 'Web' }),
  ];
  const v = crm.listView(docs, {});
  assert.deepEqual(v.items.map((d) => d.caseNumber), ['00000006', '00000004', '00000003', '00000002', '00000005', '00000001'], 'updatedAt 내림차순, 같으면 caseNumber 내림차순');
  assert.deepEqual(v.counts, { all: 6, New: 1, Working: 2, 'On Hold': 1, Escalated: 1, Closed: 1 });
  assert.deepEqual(v.subCounts, { 'Awaiting Approval': 1, 'Waiting on Customer': 1 }, '세부 상태는 응대 중(Working) 안에서만 센다');
  const w = crm.listView(docs, { status: 'Working', subStatus: 'Waiting on Customer' });
  assert.deepEqual(w.items.map((d) => d.caseNumber), ['00000003']);
  assert.deepEqual(w.counts, v.counts, 'status·subStatus는 counts에 안 걸린다');
  const s = crm.listView(docs, { recordType: 'support', origin: 'Email', status: '' });
  assert.equal(s.counts.all, 4); assert.equal(s.counts.Escalated, 0);
  assert.deepEqual(crm.listView(docs, { priority: 'High' }).items.map((d) => d.caseNumber), ['00000003']);
  assert.deepEqual(crm.listView(docs, { q: '00000005' }).items.map((d) => d.caseNumber), ['00000005'], 'q는 케이스 번호도');
  assert.deepEqual(crm.listView(docs, { q: 'U4@X' }).items.map((d) => d.caseNumber), ['00000004'], '주소·대소문자 무시');
  assert.deepEqual(crm.listView(docs, { q: '고객2' }).items.map((d) => d.caseNumber), ['00000002']);
  assert.equal(crm.listView(docs, { limit: '2' }).items.length, 2);
  assert.equal(crm.listView(docs, { limit: '0' }).items.length, 6, '0·이상한 값은 기본 100');
  assert.equal(crm.listView(docs, { limit: '-3' }).items.length, 1, '1 미만은 1');
  assert.equal(crm.badFilter({}), null);
  assert.equal(crm.badFilter({ status: 'Working', subStatus: '', caseType: 'Problem', caseReason: 'howto', priority: 'Medium', origin: 'Web', recordType: 'sales', q: 'x' }), null);
  assert.equal(crm.badFilter({ status: 'Open' }), 'status');
  assert.equal(crm.badFilter({ subStatus: 'waiting' }), 'subStatus');
  assert.equal(crm.badFilter({ caseReason: 'refund' }), 'caseReason');
  assert.equal(crm.badFilter({ origin: 'Phone' }), 'origin');
  assert.equal(crm.badFilter({ recordType: 'Sales; DROP' }), 'recordType');
  assert.equal(crm.badFilter({ q: 'x'.repeat(101) }), 'q');
  assert.equal(crm.badFilter({ q: 'x'.repeat(100) }), null);
});

test('U6 eventFromMessage·contactKey·companyDomain', () => {
  const m = { id: 'm1', event_id: 'e1', thread_id: 't1', direction: 'in', sender: 'Kim@Acme.example', subject: '문의', body: '본문 원문', provider_message_id: '<p1@mail.example>',
    occurred_at: T(1), sender_auth: 'pass', auto_submitted: 0, from: '"김" <Kim@Acme.example>', name: '김', parsedName: '김', replyTo: null, inReplyTo: '<x@y>', references: ['<x@y>'], knownFacts: { 회사: '에이씨미' } };
  const e = crm.eventFromMessage(m, { id: 'c1', channel: 'support' }, { sourceType: 'email_reply', method: 'in_reply_to', recordedAt: T(2) });
  assert.equal(e.id, 'e1'); assert.equal(e.dedupeKey, 'email:support:<p1@mail.example>');
  assert.deepEqual(e.source, { system: 'inbound_api', accountId: 'support', providerObjectId: '<p1@mail.example>', threadId: 't1' });
  assert.deepEqual([e.occurredAt, e.recordedAt, e.audit.createdAt], [T(1), T(2), T(2)]);
  assert.deepEqual(e.rawPayload, { from: '"김" <Kim@Acme.example>', name: '김', subject: '문의', body: '본문 원문', replyTo: null, inReplyTo: '<x@y>', references: ['<x@y>'], senderAuth: 'pass', autoSubmitted: false, knownFacts: { 회사: '에이씨미' } });
  assert.deepEqual(e.parsed, { parserVersion: 1, email: 'kim@acme.example', name: '김', language: null, intent: null, caseType: null, caseReason: null, riskSignals: [] });
  assert.deepEqual(e.matching, { status: 'resolved', method: 'in_reply_to', reasonCode: null });
  assert.equal(e.resolvedCaseId, 'c1'); assert.equal(e.processing.status, 'pending'); assert.equal(e.lifecycleStatus, 'active');
  assert.equal(crm.eventFromMessage(m, { id: 'c1', channel: 'sales' }, { sourceType: 'sales_inquiry_form', method: 'new_case' }).dedupeKey, 'form:sales:<p1@mail.example>');
  const bare = crm.eventFromMessage({ ...m, from: undefined, name: undefined, parsedName: undefined, knownFacts: undefined }, { id: 'c1', channel: 'support' }, { sourceType: 'manual', method: 'thread', system: 'test' });
  assert.equal(bare.dedupeKey, 'manual:support:<p1@mail.example>'); assert.equal(bare.rawPayload.from, 'Kim@Acme.example', '수신 원값이 없으면 메시지 발신 주소');
  assert.equal(bare.recordedAt, T(1)); assert.equal(bare.source.system, 'test'); assert.equal(bare.parsed.name, null);
  assert.equal(crm.contactKey(' Kim@Acme.Example '), 'kim@acme.example');
  assert.equal(crm.contactKey(''), null); assert.equal(crm.contactKey(null), null);
  const o = { formDomains: ['forms.example'], internalDomains: ['acme.example'] };
  assert.equal(crm.companyDomain('a@Partner.co.kr', o), 'partner.co.kr');
  for (const x of ['a@gmail.com', 'a@naver.com', 'a@hanmail.net', 'a@forms.example', 'a@mx.forms.example', 'a@acme.example', 'a@team.acme.example', '', null, 'not-an-email']) {
    assert.equal(crm.companyDomain(x, o), null, String(x));
  }
});
