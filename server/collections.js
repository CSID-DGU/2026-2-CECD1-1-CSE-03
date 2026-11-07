'use strict';
// CRM 컬렉션 쓰기 — 처리 테이블이 진실이고 문서는 거기서 언제든 다시 계산되는 투영이다(server/crm.js).
// 수신 이벤트 문서만 수신 트랜잭션 안에서 바로 넣는다(ingest). 케이스·활동·문의자·고객사·이벤트 결과 칸은 지연 동기화가 쓴다.
// 규칙(바꾸지 않는다):
//   - 이벤트는 다른 모듈의 트랜잭션 안에서도 나온다. 구독자는 dirty 표시와 flush 예약(setImmediate)만 한다 — 그 트랜잭션에 쓰기를 더하지 않는다.
//   - syncCase는 이벤트를 내지 않고 트랜잭션을 열지 않는다. flush가 케이스마다 자기 트랜잭션을 연다.
//   - emit이 없거나 마지막 쓰기가 emit 뒤인 경로는 호출자가 markDirty한다(index.js 사람 명령, sweeper.js 자동 종결, 기동 복구).
// 단순화: 동기화마다 그 케이스 원천 행을 전부 읽고 활동 문서를 전부 다시 계산한다(케이스당 쿼리 ~10개) — 케이스·활동이 수천 건이면 이벤트별 부분 갱신.
const crypto = require('node:crypto');
const db = require('./db');
const events = require('./events');
const store = require('./store');
const crm = require('./crm');
const policy = require('./policy');

const FORM_TYPE = { support: 'customer_support_form', onboarding: 'onboarding_form', sales: 'sales_inquiry_form' };
const INTAKE = { type: 'system', id: 'intake' };
const AGENT = { type: 'agent', id: 'agent' };
const envList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const last = (a) => a[a.length - 1];
const max = (xs) => xs.filter(Boolean).reduce((a, b) => (b > a ? b : a));
const obj = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v || null; } catch { return null; } };
// retention.js가 이 모듈을 부른다 — 보존 기간은 쓸 때 읽는다(순환 require)
const retentionDays = () => require('./retention').days();

const dirty = new Set();
const st = { failures: 0, lastFlushAt: null };
let scheduled = false;

/**
 * 수신 이벤트 문서 — addInbound 트랜잭션 안, messages insert 뒤·message.created emit 전. 실패하면 수신 트랜잭션째 롤백된다.
 * m = messages 행(event_id 포함) + 수신 원값. matching = {method, reasonCode?, form?, system?, recordedAt?}.
 */
function ingest(m, caseRow, { method, reasonCode = null, form = false, system, recordedAt } = {}) {
  const sourceType = form ? FORM_TYPE[caseRow.channel] || 'customer_support_form'
    : String(m.provider_message_id || '').startsWith('local:') ? 'manual' : method === 'new_case' ? 'email_inbound' : 'email_reply';
  const e = crm.eventFromMessage(m, caseRow, { sourceType, method, reasonCode, system, recordedAt });
  store.insert('inbound_events', caseRow.purged_at ? anonymizeEvent(e) : e); // 파기된 케이스의 백필은 처음부터 비운 채로
}

/**
 * 이벤트 원문·개인 칸 비우기(파기). rawPayload는 키만 남기고 전부 null, 출처의 Message-ID·스레드 id도 null.
 * dedupeKey의 Message-ID 자리는 sha256 앞 32자로 바꾼다 — 유일·결정적이라 파기 뒤 flush가 같은 값을 낸다. `msg:<messages.id>`(provider id 없음)는 그대로.
 * 이미 비운 문서는 그대로 돌려준다(두 번 비우면 해시가 또 바뀐다). 시각·처리 결과 코드는 남는다.
 */
function anonymizeEvent(e) {
  if (e.lifecycleStatus === 'anonymized') return e;
  const [kind, channel, ...rest] = String(e.dedupeKey).split(':'); const pid = rest.join(':');
  return {
    ...e, source: { ...e.source, providerObjectId: null, threadId: null },
    dedupeKey: pid.startsWith('msg:') ? e.dedupeKey : `${kind}:${channel}:${crypto.createHash('sha256').update(pid).digest('hex').slice(0, 32)}`,
    rawPayload: Object.fromEntries(Object.keys(e.rawPayload || {}).map((k) => [k, null])),
    parsed: { ...e.parsed, email: null, name: null }, lifecycleStatus: 'anonymized',
  };
}

/**
 * 케이스 주소의 문의자·업무 도메인 고객사를 찾거나 만든다. 파기됐으면 직전 문서의 연결을 그대로 둔다.
 * 주소가 비었거나 문의 폼 주소(고객 주소를 못 뽑은 폼 메일)면 아무것도 만들거나 잇지 않는다.
 */
function link(c, ins, firstEventId, prev) {
  if (c.purged_at) return { contactId: prev?.contactId ?? null, companyId: prev?.companyId ?? null };
  const email = crm.contactKey(c.customer_email);
  if (!email || policy.isFormAddress(email)) return { contactId: null, companyId: null };
  const domain = crm.companyDomain(email, { formDomains: envList(process.env.FORM_SENDER_DOMAINS), internalDomains: envList(process.env.INTERNAL_DOMAINS) });
  let companyId = null;
  if (domain) {
    const factName = obj(c.known_facts)?.회사 ? String(obj(c.known_facts).회사) : null;
    const co = store.find('companies', { primaryDomain: domain }, { limit: 1 })[0];
    if (!co) {
      companyId = db.uuid();
      store.put('companies', { id: companyId, type: 'unknown', primaryDomain: domain, canonicalName: factName || domain, normalizedName: (factName || domain).toLowerCase(), aliases: [],
        domains: [{ value: domain, status: 'observed' }], lifecycleStatus: 'active', audit: { createdAt: c.created_at, createdBy: { ...INTAKE }, updatedAt: c.created_at, updatedBy: { ...INTAKE } } });
    } else {
      companyId = co.id;
      if (co.canonicalName == null && factName) store.put('companies', { ...co, canonicalName: factName, normalizedName: factName.toLowerCase() }); // 파기로 비운 폼 이름을 살아 있는 케이스가 다시 채운다
    }
  }
  // 관찰 시각 = 케이스 주소로 온 수신 메일. 이름은 케이스를 열 때 정해진다(sanitizeName 기본값 「고객」은 이름이 아니다).
  const seen = ins.filter((m) => crm.contactKey(m.sender) === email);
  const first = seen[0]?.occurred_at ?? c.created_at; const lastAt = last(seen)?.occurred_at ?? c.created_at;
  const name = { value: c.customer_name && c.customer_name !== '고객' ? c.customer_name : null, observedAt: c.created_at, sourceEventId: firstEventId, confidence: 1, manuallyVerified: false };
  const p = store.find('contacts', { primaryEmail: email }, { limit: 1 })[0];
  if (!p) {
    const id = db.uuid();
    store.put('contacts', { id, companyId, type: 'person', primaryEmail: email, emails: [{ value: email, normalizedValue: email, kind: 'observed', verified: false, firstObservedAt: first, lastObservedAt: lastAt }],
      current: { name }, lifecycleStatus: 'active', audit: { createdAt: first, createdBy: { ...INTAKE }, updatedAt: lastAt, updatedBy: { ...INTAKE } } });
    return { contactId: id, companyId };
  }
  const e0 = p.emails[0] || {};
  const firstObservedAt = e0.firstObservedAt && e0.firstObservedAt < first ? e0.firstObservedAt : first;
  const lastObservedAt = e0.lastObservedAt && e0.lastObservedAt > lastAt ? e0.lastObservedAt : lastAt;
  const newer = name.value && !(p.current?.name?.observedAt >= name.observedAt); // 이름은 더 새 관찰일 때만
  store.put('contacts', { ...p, companyId: p.companyId ?? companyId, emails: [{ ...e0, value: email, normalizedValue: email, firstObservedAt, lastObservedAt }, ...p.emails.slice(1)],
    current: { ...p.current, name: newer ? name : p.current?.name ?? name }, audit: { ...p.audit, updatedAt: lastObservedAt } });
  return { contactId: p.id, companyId: p.companyId ?? companyId };
}

/**
 * 케이스 하나를 처리 테이블에서 다시 계산해 문서에 쓴다(내용이 같으면 쓰지 않는다). 트랜잭션·emit 없음. 케이스 행이 없으면 false.
 * 파기된 케이스면 이벤트 원문도 비운다 — 파기 트랜잭션과 기동 백필이 같은 길을 탄다.
 */
function syncCase(id) {
  const c = db.get('SELECT rowid AS rid, * FROM cases WHERE id=?', id);
  if (!c) return false;
  const detail = {
    case: c,
    messages: db.all('SELECT * FROM messages WHERE case_id=? ORDER BY occurred_at, rowid', id),
    drafts: db.all('SELECT * FROM drafts WHERE case_id=? ORDER BY created_at, rowid', id),
    decisions: db.all('SELECT * FROM decisions WHERE case_id=? ORDER BY created_at, rowid', id),
    handoffs: db.all('SELECT * FROM handoffs WHERE case_id=? ORDER BY created_at', id),
    activities: db.all('SELECT * FROM activities WHERE case_id=? ORDER BY created_at, rowid', id),
    loop: db.get('SELECT * FROM loops WHERE case_id=?', id),
  };
  const ins = detail.messages.filter((m) => m.direction === 'in');
  const evs = new Map(ins.map((m) => [m.id, m.event_id ? store.get('inbound_events', m.event_id)?.doc : null]));
  const pack = policy.load(c.channel);
  const prev = store.get('cases', id)?.doc ?? null;
  const { contactId, companyId } = link(c, ins, ins[0]?.event_id ?? null, prev);
  const ctx = { pack, caseNumber: c.rid, contactId, companyId, eventIdOf: (mid) => evs.get(mid)?.id ?? null, sourceTypeOf: (mid) => evs.get(mid)?.sourceType ?? null };
  store.put('cases', crm.projectCase(detail, prev, ctx).doc);
  for (const a of crm.projectActivities(detail, ctx)) store.put('activities', a);
  // 이벤트 결과 칸 — 그 메시지의 판단·재시도 예약·케이스 종결 시각에서. rawPayload는 파기 때만 바뀐다.
  const days = retentionDays(); const lp = detail.loop;
  for (const m of ins) {
    const e = evs.get(m.id);
    if (!e) continue;
    const ds = detail.decisions.filter((d) => d.message_id === m.id);
    const tri = last(ds.filter((d) => d.step === 'triage')); const out = obj(tri?.output) || {};
    const exec = last(ds.filter((d) => d.step === 'execute')); const errs = ds.filter((d) => d.step === 'error');
    const retry = lp?.retry_message_id === m.id && lp.next_retry_at ? lp.next_retry_at : null;
    const def = tri?.reason ? pack?.intents?.[tri.reason] : null;
    const doc = {
      ...(c.purged_at ? anonymizeEvent(e) : e),
      processing: { status: exec ? (errs.some((d) => d.action === 'HANDOFF') ? 'terminal_error' : 'succeeded') : retry ? 'retryable_error' : 'pending', attempts: errs.length, nextRetryAt: retry, errorCode: last(errs)?.reason ?? null },
      // 케이스를 연 첫 메시지가 무시(자동 회신·감사 인사)로 끝나면 연결할 문의가 없었다. 회신의 매칭 결과(재오픈 등)는 수신 때 값 그대로.
      matching: exec?.action === 'IGNORE' && e.matching.method === 'new_case' ? { ...e.matching, status: 'not_applicable', reasonCode: exec.reason } : { ...e.matching, status: 'resolved' },
      resolvedCaseId: c.id, resolvedContactId: contactId, resolvedCompanyId: companyId,
      privacy: { ...e.privacy, retentionUntil: c.closed_at && days ? new Date(Date.parse(c.closed_at) + days * 86_400_000).toISOString() : null },
    };
    doc.parsed = { ...doc.parsed, language: out.language ?? null, intent: tri?.reason ?? null, caseType: def?.caseType ?? null, caseReason: def?.caseReason ?? null, riskSignals: out.riskSignals || [] };
    doc.audit = { ...e.audit, updatedAt: max([e.recordedAt, ...ds.map((d) => d.created_at)]), updatedBy: ds.length ? { ...AGENT } : e.audit.createdBy };
    store.put('inbound_events', doc);
  }
  return true;
}

function markDirty(caseId) {
  if (!caseId) return;
  dirty.add(caseId);
  if (!scheduled) { scheduled = true; setImmediate(flush); }
}

/** dirty 케이스를 케이스마다 한 트랜잭션으로 동기화. 실패는 로그 한 줄(개인정보 없음)·failures+1, 그 id는 dirty에 남아 다음 flush가 다시 한다. */
function flush() {
  scheduled = false;
  for (const id of [...dirty]) {
    dirty.delete(id);
    try { db.tx(() => syncCase(id)); } catch (e) {
      dirty.add(id); st.failures += 1;
      console.error(`[collections] sync 실패 ${String(id).slice(0, 8)} ${e.message}`);
    }
  }
  st.lastFlushAt = db.now();
}

/** 기동 때 한 번 — 이벤트 없는 수신 메시지(예전 데이터)를 백필하고 모든 케이스를 동기화한다. */
function resyncAll() {
  const msgs = db.all(`SELECT m.*, (SELECT COUNT(*) FROM messages p WHERE p.case_id=m.case_id AND p.direction='in' AND p.rowid < m.rowid) AS nth
    FROM messages m WHERE m.direction='in' AND m.event_id IS NULL ORDER BY m.rowid`);
  let n = 0;
  for (const m of msgs) {
    // 메시지·케이스마다 따로 — 하나가 실패해도 failures에 세고 넘어간다(기동을 막지 않는다)
    try {
      db.tx(() => {
        const c = db.get('SELECT * FROM cases WHERE id=?', m.case_id);
        const eventId = db.uuid();
        db.run('UPDATE messages SET event_id=? WHERE id=?', eventId, m.id);
        ingest({ ...m, event_id: eventId, parsedName: m.sender && m.sender === c.customer_email ? c.customer_name : null }, c, { method: m.nth ? 'thread' : 'new_case', form: m.sender_auth === 'form' });
      });
      n += 1;
    } catch (e) {
      st.failures += 1;
      console.error(`[collections] 백필 실패 ${String(m.id).slice(0, 8)} ${e.code || e.name}`);
    }
  }
  for (const { id } of db.all('SELECT id FROM cases ORDER BY rowid')) dirty.add(id);
  flush();
  return { events: n };
}

/**
 * 파기 트랜잭션 안(retention.purge 끝) — 비워진 원천 행으로 케이스·활동·이벤트 문서를 다시 계산하고,
 * 그 주소의 파기 안 된 케이스가 없으면 문의자도 비운다. 고객사 이름이 폼 값에서 왔으면 비운다(도메인 이름은 남는다).
 */
function anonymizeCase(caseId, email) {
  const companyId = store.get('cases', caseId)?.doc.companyId ?? null;
  try { syncCase(caseId); } catch (e) {
    // 파기는 멈추지 않는다 — 그 케이스의 케이스·활동 문서는 지우고 이벤트 원문만 비운다. 다음 flush가 다시 계산한다.
    st.failures += 1; markDirty(caseId);
    console.error(`[collections] 파기 동기화 실패 ${String(caseId).slice(0, 8)} ${e.code || e.name}`);
    store.remove('cases', caseId);
    for (const a of store.find('activities', { caseId })) store.remove('activities', a.id);
    for (const { event_id: id } of db.all('SELECT event_id FROM messages WHERE case_id=? AND event_id IS NOT NULL', caseId)) {
      const ev = store.get('inbound_events', id)?.doc;
      if (ev) store.put('inbound_events', anonymizeEvent(ev));
    }
  }
  const key = crm.contactKey(email);
  if (key && !db.get('SELECT 1 FROM cases WHERE customer_email=? AND purged_at IS NULL LIMIT 1', key)) {
    for (const p of store.find('contacts', { primaryEmail: key })) store.put('contacts', { ...p, primaryEmail: null, emails: [], current: {}, lifecycleStatus: 'anonymized' });
  }
  const co = companyId && store.get('companies', companyId)?.doc;
  if (co && co.canonicalName != null && co.canonicalName !== co.primaryDomain) store.put('companies', { ...co, canonicalName: null, normalizedName: null });
}

const status = () => ({ pending: dirty.size, failures: st.failures, lastFlushAt: st.lastFlushAt });

// 처리 테이블이 바뀌었다는 신호 — dirty 표시와 예약만(위 규칙)
events.subscribe(({ data }) => { if (data?.caseId) markDirty(data.caseId); });

module.exports = { ingest, syncCase, markDirty, flush, resyncAll, anonymizeCase, status };
