'use strict';
// 구조 불변 — 기존 테이블의 열(PRAGMA table_info 행 전체)과 CRM 컬렉션 5종 문서의 재귀 키 경로가 BASE 사본과 같다.
// sqlite_master의 테이블·인덱스 이름 목록 = BASE 이름 + config_changes, config_changes_target, kb_drafts(새 테이블·인덱스는 이 셋뿐).
// 새 테이블의 열·정의는 여기서 보지 않는다(NEW_TABLES는 table_info 비교에서 뺀다). 그 정의는 schema.sql의 BASE 대비 diff(1회 검증)가 잡는다.
// 그래서 BASE 사본에서 뜬 스냅숏은 이 리터럴과 master 목록의 세 이름만 다르고, 나머지(tables·docs)는 같다.
// 리터럴 뜨기: SCHEMA_SNAPSHOT=<파일 경로>면 비교하지 않고 현재 값을 그 파일에 JSON으로 쓴다(node --test가 stdout을 TAP으로 감싸므로 파일로).
// 고정 환경: 어떤 모듈도 읽기 전에 env를 허용 목록만 남기고 지운 뒤 고정값만 넣는다 — 시드 경로를 바꾸는 변수가 새지 않게.
const SNAPSHOT = process.env.SCHEMA_SNAPSHOT;
for (const k of Object.keys(process.env)) if (!['PATH', 'HOME', 'TMPDIR', 'NODE_TEST_CONTEXT'].includes(k)) delete process.env[k];
Object.assign(process.env, {
  AUTO_SEND: '0', SHADOW_CHANNELS: 'sales', FORM_SENDER_DOMAINS: 'form.example.net', INTERNAL_DOMAINS: 'internal.example.net', RETENTION_DAYS: '30',
  NODE_ENV: 'development', REQUIRE_SENDER_AUTH: '0', LLM_PROVIDER: 'mock', MAIL_PROVIDER: 'mock',
});
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const db = require('../server/db');
const store = require('../server/store');
const collections = require('../server/collections');
const retention = require('../server/retention');
const { createServer } = require('../server/index');

const NEW_TABLES = ['config_changes', 'kb_drafts'];
const EXPECTED = {
  master: [
    'activities', 'activities_case', 'case_threads', 'cases', 'cases_email', 'cases_state', 'claims', 'config_changes', 'config_changes_target',
    'decisions', 'decisions_case', 'dispatches', 'doc_activity_case', 'doc_company_domain', 'doc_contact_email', 'doc_event_case', 'doc_event_dedupe',
    'documents', 'drafts', 'drafts_case', 'drafts_status', 'handoffs', 'kb_drafts', 'llm_calls', 'llm_calls_case', 'llm_calls_created', 'loops',
    'messages', 'messages_case', 'versions',
  ],
  tables: {
    activities: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'case_id', 'TEXT', 1, null, 0],
      [2, 'type', 'TEXT', 1, null, 0],
      [3, 'actor', 'TEXT', 1, null, 0],
      [4, 'payload', 'TEXT', 0, null, 0],
      [5, 'created_at', 'TEXT', 1, null, 0],
    ],
    case_threads: [
      [0, 'thread_id', 'TEXT', 0, null, 1],
      [1, 'case_id', 'TEXT', 1, null, 0],
      [2, 'created_at', 'TEXT', 1, null, 0],
    ],
    cases: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'channel', 'TEXT', 1, null, 0],
      [2, 'customer_email', 'TEXT', 1, null, 0],
      [3, 'customer_name', 'TEXT', 0, null, 0],
      [4, 'subject', 'TEXT', 0, null, 0],
      [5, 'state', 'TEXT', 1, null, 0],
      [6, 'responder', 'TEXT', 1, "'agent'", 0],
      [7, 'responder_changed_at', 'TEXT', 0, null, 0],
      [8, 'responder_changed_by', 'TEXT', 0, null, 0],
      [9, 'responder_change_reason', 'TEXT', 0, null, 0],
      [10, 'assignee', 'TEXT', 0, null, 0],
      [11, 'known_facts', 'TEXT', 0, null, 0],
      [12, 'created_at', 'TEXT', 1, null, 0],
      [13, 'updated_at', 'TEXT', 1, null, 0],
      [14, 'closed_at', 'TEXT', 0, null, 0],
      [15, 'purged_at', 'TEXT', 0, null, 0],
      [16, 'related_case_id', 'TEXT', 0, null, 0],
      [17, 'hold_note', 'TEXT', 0, null, 0],
      [18, 'held_at', 'TEXT', 0, null, 0],
      [19, 'close_reason', 'TEXT', 0, null, 0],
      [20, 'close_detail', 'TEXT', 0, null, 0],
    ],
    claims: [
      [0, 'key', 'TEXT', 0, null, 1],
      [1, 'created_at', 'TEXT', 1, null, 0],
    ],
    decisions: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'case_id', 'TEXT', 1, null, 0],
      [2, 'message_id', 'TEXT', 0, null, 0],
      [3, 'step', 'TEXT', 1, null, 0],
      [4, 'agent', 'TEXT', 0, null, 0],
      [5, 'input_summary', 'TEXT', 0, null, 0],
      [6, 'output', 'TEXT', 1, null, 0],
      [7, 'action', 'TEXT', 0, null, 0],
      [8, 'reason', 'TEXT', 0, null, 0],
      [9, 'prompt_version', 'TEXT', 0, null, 0],
      [10, 'kb_version', 'TEXT', 0, null, 0],
      [11, 'policy_version', 'TEXT', 0, null, 0],
      [12, 'latency_ms', 'INTEGER', 0, null, 0],
      [13, 'created_at', 'TEXT', 1, null, 0],
    ],
    dispatches: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'draft_id', 'TEXT', 1, null, 0],
      [2, 'idempotency_key', 'TEXT', 1, null, 0],
      [3, 'provider', 'TEXT', 1, null, 0],
      [4, 'status', 'TEXT', 1, null, 0],
      [5, 'provider_message_id', 'TEXT', 0, null, 0],
      [6, 'error', 'TEXT', 0, null, 0],
      [7, 'created_at', 'TEXT', 1, null, 0],
    ],
    documents: [
      [0, 'collection', 'TEXT', 1, null, 1],
      [1, 'id', 'TEXT', 1, null, 2],
      [2, 'doc', 'TEXT', 1, null, 0],
      [3, 'revision', 'INTEGER', 1, '1', 0],
      [4, 'created_at', 'TEXT', 1, null, 0],
      [5, 'updated_at', 'TEXT', 1, null, 0],
    ],
    drafts: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'case_id', 'TEXT', 1, null, 0],
      [2, 'trigger_message_id', 'TEXT', 1, null, 0],
      [3, 'status', 'TEXT', 1, null, 0],
      [4, 'intent', 'TEXT', 0, null, 0],
      [5, 'action', 'TEXT', 0, null, 0],
      [6, 'original_body', 'TEXT', 1, null, 0],
      [7, 'final_body', 'TEXT', 0, null, 0],
      [8, 'edited_by', 'TEXT', 0, null, 0],
      [9, 'edit_tags', 'TEXT', 0, null, 0],
      [10, 'used_facts', 'TEXT', 0, null, 0],
      [11, 'idempotency_key', 'TEXT', 1, null, 0],
      [12, 'approved_by', 'TEXT', 0, null, 0],
      [13, 'approved_at', 'TEXT', 0, null, 0],
      [14, 'sent_at', 'TEXT', 0, null, 0],
      [15, 'error', 'TEXT', 0, null, 0],
      [16, 'seen_out_rowid', 'INTEGER', 0, null, 0],
      [17, 'created_at', 'TEXT', 1, null, 0],
    ],
    handoffs: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'case_id', 'TEXT', 1, null, 0],
      [2, 'reason', 'TEXT', 1, null, 0],
      [3, 'briefing', 'TEXT', 1, null, 0],
      [4, 'assignee', 'TEXT', 0, null, 0],
      [5, 'created_at', 'TEXT', 1, null, 0],
      [6, 'returned_at', 'TEXT', 0, null, 0],
    ],
    llm_calls: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'case_id', 'TEXT', 0, null, 0],
      [2, 'message_id', 'TEXT', 0, null, 0],
      [3, 'agent', 'TEXT', 1, null, 0],
      [4, 'provider', 'TEXT', 1, null, 0],
      [5, 'model', 'TEXT', 0, null, 0],
      [6, 'input_tokens', 'INTEGER', 1, '0', 0],
      [7, 'output_tokens', 'INTEGER', 1, '0', 0],
      [8, 'latency_ms', 'INTEGER', 0, null, 0],
      [9, 'ok', 'INTEGER', 1, null, 0],
      [10, 'error', 'TEXT', 0, null, 0],
      [11, 'created_at', 'TEXT', 1, null, 0],
    ],
    loops: [
      [0, 'case_id', 'TEXT', 0, null, 1],
      [1, 'state', 'TEXT', 1, null, 0],
      [2, 'rounds', 'INTEGER', 1, '0', 0],
      [3, 'repeat_streak', 'INTEGER', 1, '0', 0],
      [4, 'lease_until', 'TEXT', 0, null, 0],
      [5, 'lease_token', 'TEXT', 0, null, 0],
      [6, 'queue', 'TEXT', 1, "'[]'", 0],
      [7, 'last_outbound_gist', 'TEXT', 0, null, 0],
      [8, 'next_retry_at', 'TEXT', 0, null, 0],
      [9, 'retry_count', 'INTEGER', 1, '0', 0],
      [10, 'retry_message_id', 'TEXT', 0, null, 0],
      [11, 'updated_at', 'TEXT', 1, null, 0],
    ],
    messages: [
      [0, 'id', 'TEXT', 0, null, 1],
      [1, 'case_id', 'TEXT', 1, null, 0],
      [2, 'thread_id', 'TEXT', 1, null, 0],
      [3, 'direction', 'TEXT', 1, null, 0],
      [4, 'sent_by', 'TEXT', 0, null, 0],
      [5, 'sender', 'TEXT', 1, null, 0],
      [6, 'subject', 'TEXT', 0, null, 0],
      [7, 'body', 'TEXT', 1, null, 0],
      [8, 'body_clean', 'TEXT', 1, null, 0],
      [9, 'provider_message_id', 'TEXT', 0, null, 0],
      [10, 'occurred_at', 'TEXT', 1, null, 0],
      [11, 'auto_submitted', 'INTEGER', 1, '0', 0],
      [12, 'edited', 'INTEGER', 1, '0', 0],
      [13, 'sender_auth', 'TEXT', 0, null, 0],
      [14, 'event_id', 'TEXT', 0, null, 0],
    ],
    versions: [
      [0, 'hash', 'TEXT', 0, null, 1],
      [1, 'kind', 'TEXT', 1, null, 0],
      [2, 'content', 'TEXT', 1, null, 0],
      [3, 'created_at', 'TEXT', 1, null, 0],
    ],
  },
  docs: {
    inbound_events: [
      'audit', 'audit.createdAt', 'audit.createdBy', 'audit.createdBy.id', 'audit.createdBy.type', 'audit.updatedAt', 'audit.updatedBy',
      'audit.updatedBy.id', 'audit.updatedBy.type', 'dedupeKey', 'id', 'lifecycleStatus', 'matching', 'matching.method', 'matching.reasonCode',
      'matching.status', 'occurredAt', 'parsed', 'parsed.caseReason', 'parsed.caseType', 'parsed.email', 'parsed.intent', 'parsed.language',
      'parsed.name', 'parsed.parserVersion', 'parsed.riskSignals', 'privacy', 'privacy.classification', 'privacy.legalHold', 'privacy.retentionUntil',
      'processing', 'processing.attempts', 'processing.errorCode', 'processing.nextRetryAt', 'processing.status', 'rawPayload',
      'rawPayload.autoSubmitted', 'rawPayload.body', 'rawPayload.from', 'rawPayload.inReplyTo', 'rawPayload.knownFacts', 'rawPayload.name',
      'rawPayload.references', 'rawPayload.replyTo', 'rawPayload.senderAuth', 'rawPayload.subject', 'rawPayloadSchemaVersion', 'recordedAt',
      'resolvedCaseId', 'resolvedCompanyId', 'resolvedContactId', 'source', 'source.accountId', 'source.providerObjectId', 'source.system',
      'source.threadId', 'sourceType',
    ],
    companies: [
      'aliases', 'audit', 'audit.createdAt', 'audit.createdBy', 'audit.createdBy.id', 'audit.createdBy.type', 'audit.updatedAt', 'audit.updatedBy',
      'audit.updatedBy.id', 'audit.updatedBy.type', 'canonicalName', 'domains', 'domains[].status', 'domains[].value', 'id', 'lifecycleStatus',
      'normalizedName', 'primaryDomain', 'type',
    ],
    contacts: [
      'audit', 'audit.createdAt', 'audit.createdBy', 'audit.createdBy.id', 'audit.createdBy.type', 'audit.updatedAt', 'audit.updatedBy',
      'audit.updatedBy.id', 'audit.updatedBy.type', 'companyId', 'current', 'current.name', 'current.name.confidence',
      'current.name.manuallyVerified', 'current.name.observedAt', 'current.name.sourceEventId', 'current.name.value', 'emails',
      'emails[].firstObservedAt', 'emails[].kind', 'emails[].lastObservedAt', 'emails[].normalizedValue', 'emails[].value', 'emails[].verified', 'id',
      'lifecycleStatus', 'primaryEmail', 'type',
    ],
    cases: [
      'attribution', 'attribution.caseCreationEventId', 'attribution.latestInboundEventId', 'audit', 'audit.createdAt', 'audit.createdBy',
      'audit.createdBy.id', 'audit.createdBy.type', 'audit.updatedAt', 'audit.updatedBy', 'audit.updatedBy.id', 'audit.updatedBy.type', 'caseNumber',
      'caseReason', 'caseType', 'closeDetail', 'closeReason', 'companyId', 'contactId', 'hold', 'hold.note', 'hold.since', 'id', 'intent', 'isClosed',
      'isEscalated', 'lifecycleStatus', 'origin', 'owner', 'owner.id', 'owner.type', 'priority', 'recordType', 'relatedCaseId', 'resolution',
      'resolution.handoffReason', 'resolution.lastReplyActivityId', 'resolution.nextAction', 'resolution.outcome', 'status', 'statusHistory',
      'statusHistory[].changedAt', 'statusHistory[].changedBy', 'statusHistory[].changedBy.id', 'statusHistory[].changedBy.type',
      'statusHistory[].fromStatus', 'statusHistory[].fromSubStatus', 'statusHistory[].reason', 'statusHistory[].sourceId', 'statusHistory[].toStatus',
      'statusHistory[].toSubStatus', 'subStatus', 'subject', 'summary', 'suppliedEmail', 'suppliedName',
    ],
    activities: [
      'actor', 'actor.id', 'actor.type', 'audit', 'audit.createdAt', 'audit.createdBy', 'audit.createdBy.id', 'audit.createdBy.type',
      'audit.updatedAt', 'audit.updatedBy', 'audit.updatedBy.id', 'audit.updatedBy.type', 'body', 'caseId', 'companyId', 'contactId', 'dedupeKey',
      'direction', 'id', 'inboundEventId', 'lifecycleStatus', 'meta', 'meta.editTags', 'meta.handoffReason', 'meta.nextAction', 'occurredAt',
      'subtype', 'summary', 'type',
    ],
  },
};

/** 객체 키 경로(중첩 포함). 배열 원소는 `[]`로 이어 간다. */
function paths(v, at, out) {
  if (Array.isArray(v)) { for (const x of v) paths(x, `${at}[]`, out); return out; }
  if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) { const p = at ? `${at}.${k}` : k; out.add(p); paths(v[k], p, out); }
  return out;
}

function shape() {
  // sqlite_로 시작하는 이름(UNIQUE·TEXT PK가 만드는 자동 인덱스)은 SQLite 내부 이름이라 뺀다
  const names = (type) => db.all(`SELECT name FROM sqlite_master WHERE type IN (${type}) AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name);
  const tables = {};
  for (const t of names("'table'")) {
    if (!NEW_TABLES.includes(t)) tables[t] = db.all(`PRAGMA table_info(${t})`).map((c) => [c.cid, c.name, c.type, c.notnull, c.dflt_value, c.pk]);
  }
  const docs = {};
  for (const c of store.COLLECTIONS) docs[c] = [...store.all(c).reduce((s, d) => paths(d, '', s), new Set())].sort();
  return { master: names("'table','index'"), tables, docs };
}

test('기존 테이블 열·CRM 문서 키 경로·sqlite_master 이름이 BASE 리터럴과 같다(새 테이블은 config_changes·kb_drafts뿐)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T00:00:00.000Z') });
  db.init(':memory:'); // MIGRATIONS까지 돈다
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    assert.equal(res.status, 200, `${p} ${JSON.stringify(data)}`);
    return data;
  };
  // 수신 라우트는 응답 뒤에 회차를 돌린다 — 모든 수신 메시지에 실행 판단이 생기고 리스가 풀릴 때까지(시계가 멈춰 있으므로 횟수로 끊는다)
  const settle = async () => {
    for (let i = 0; i < 1000; i += 1) {
      const open = db.get("SELECT COUNT(*) n FROM messages m WHERE m.direction='in' AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.message_id=m.id AND d.step='execute')").n;
      if (!open && !db.get('SELECT COUNT(*) n FROM loops WHERE lease_until IS NOT NULL').n) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('회차가 끝나지 않았다');
  };
  const inbound = async (b) => { const r = await post('/api/inbound', { channel: 'support', ...b }); await settle(); return r; };
  try {
    // 폼 메일 수신(sender_auth 'form') — 고객 주소 도메인은 공용·폼·사내 어디에도 들지 않는다(고객사 문서가 생긴다)
    const form = await inbound({ from: 'noreply@form.example.net', replyTo: 'form-user@seed.example.com', subject: '문의 폼 접수', body: '이름: 김폼\n이메일: form-user@seed.example.com\n영수증 발급 방법 알려주세요.' });
    assert.equal(db.get('SELECT sender_auth FROM messages WHERE id=?', form.messageId).sender_auth, 'form');
    // 승인 발송 → 종결 → 같은 스레드 회신으로 재오픈
    const a = await inbound({ from: 'reopen@seed.example.com', subject: '영수증', body: '영수증 발급 방법 알려주세요.', threadId: 'seed-reopen' });
    await post(`/api/drafts/${db.get("SELECT id FROM drafts WHERE case_id=? AND status='PENDING'", a.caseId).id}/approve`, { by: '담당' });
    await post(`/api/cases/${a.caseId}/close`, { by: '담당', reason: 'resolved' });
    const re = await inbound({ from: 'reopen@seed.example.com', subject: 'Re: 영수증', body: '세금계산서도 같은 화면에서 받을 수 있나요?', threadId: 'seed-reopen' });
    assert.equal(re.reopened, true);
    // 넘김 → 보류
    const h = await inbound({ from: 'hold@seed.example.com', subject: '환불', body: '어제 자동결제가 됐는데 환불해 주세요.' });
    assert.ok(db.get('SELECT 1 FROM handoffs WHERE case_id=?', h.caseId));
    await post(`/api/cases/${h.caseId}/hold`, { by: '담당', note: '결제 내역 확인 중' });
    // 종결 → 파기
    const p = await inbound({ from: 'purge@seed.example.com', subject: '로그인', body: '로그인이 안 됩니다. 비밀번호 재설정 메일도 안 와요.' });
    await post(`/api/cases/${p.caseId}/close`, { by: '담당', reason: 'other', detail: '고객 요청으로 정리' });
    assert.equal(retention.purge(p.caseId, { reason: 'subject_request', actor: 'dpo' }), true);
    // 섀도 평가(SHADOW_CHANNELS=sales)
    const s = await inbound({ channel: 'sales', from: 'shadow@seed.example.com', subject: '진행 순서', body: '서비스 진행 순서가 궁금합니다.' });
    await post(`/api/drafts/${db.get("SELECT id FROM drafts WHERE case_id=? AND status='SHADOW'", s.caseId).id}/rate`, { by: '담당', rating: 'good' });
  } finally { server.closeAllConnections(); server.close(); }
  collections.resyncAll();
  // 빈 컬렉션은 키 경로를 비교하지 못한다
  for (const c of store.COLLECTIONS) assert.ok(store.all(c).length >= 1, `${c} 문서 없음`);
  const got = shape();
  if (SNAPSHOT) { fs.writeFileSync(SNAPSHOT, `${JSON.stringify(got, null, 2)}\n`); return; }
  assert.deepEqual(got.master, EXPECTED.master);
  assert.deepEqual(got.tables, EXPECTED.tables);
  assert.deepEqual(got.docs, EXPECTED.docs);
});
