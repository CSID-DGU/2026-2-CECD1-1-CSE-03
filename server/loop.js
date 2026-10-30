'use strict';
// 에이전트 루프 러너(spec §3) + 사람 행동(승인·폐기·인수·반환·종결·직접 답장·섀도 평가) + 재시작 복구.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const events = require('./events');
const cases = require('./cases');
const policy = require('./policy');
const kbLoader = require('./kb');
const guard = require('./guard');
const prefilter = require('./prefilter');
const mail = require('./mail');
const llm = require('./llm');
const triageAgent = require('./agents/triage');
const responder = require('./agents/responder');
const reviewer = require('./agents/reviewer');
const briefer = require('./agents/briefer');

const { HttpError } = cases;
// 리스: 한 케이스에 회차는 하나만. 프로세스가 죽으면 recover()가 시작할 때 전부 푼다.
const LEASE_MS = 10 * 60 * 1000;
// LLM 장애 재시도 간격(분). 4번 재시도까지 실패하면 사람에게. LLM_RETRY_SCALE로 테스트에서 줄인다.
const RETRY_MINUTES = [2, 5, 10, 30];
const retryScale = () => Number(process.env.LLM_RETRY_SCALE) || 1;
const AGENT = () => process.env.AGENT_NAME || 'Aria';
const DRAFTY = ['DRAFT', 'ANSWER_AND_HANDOFF', 'SHADOW'];
// L2 자동 발송·접수 안내의 행위자. 넘김 사유가 이 목록이면 접수 안내도 보내지 않는다(지시 변경 시도·법적 언급·다른 사람의 회신).
const AUTO_BY = 'agent:auto';
const ACK_SKIP = ['injection', 'legal_threat', 'sender_changed'];
// 비교 실험 전용 스위치 — 장치를 하나씩 꺼 효과를 잰다.
// inbound·answered·inflight = 발송 시점 확인, ack = 접수 안내를 답으로 셈(기준 표지·반환 미답 선택 모두), guard = 발송 시점 본문·렌더 재검사.
// mock 메일일 때만 먹는다: 실발송 경로에선 CS_ABLATE가 있어도 늘 다 켠다.
const ABLATE = new Set(String(process.env.CS_ABLATE || '').split(',').map((k) => k.trim()).filter(Boolean));
const off = (k) => ABLATE.has(k) && mail.name() === 'mock';

const st = { active: new Set(), cyclesToday: 0, lastCycleAt: null, day: new Date().toISOString().slice(0, 10) };
// 단순화: 프로세스 메모리 — 단일 프로세스 전제(deployment.md). 여러 프로세스면 claim에 소유자·시각을 적는다.
const inflight = new Set(); // 지금 회차가 도는 claim 키
const sending = new Set();  // 지금 mail.send 중인 초안 id
const loopKey = (caseId, messageId) => `loop:${caseId}:${messageId}`;
/** 다시 판단하려고 claim을 푼다. 그 메시지 회차가 돌고 있으면 풀지 않는다(false) — 같은 메시지를 두 번 판단하지 않게. */
function releaseForRerun(caseId, messageId) {
  const key = loopKey(caseId, messageId);
  if (inflight.has(key)) return false;
  cases.releaseClaim(key);
  return true;
}
const queueOf = (caseId) => JSON.parse(db.get('SELECT queue FROM loops WHERE case_id=?', caseId)?.queue || '[]');
function bump() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== st.day) { st.day = day; st.cyclesToday = 0; }
  st.cyclesToday += 1; st.lastCycleAt = db.now();
}

/** 판단 기록 + SSE. 연락처는 여기서 한 번 가린다 — 기록·브로드캐스트되는 모든 판단이 이 함수를 지난다. */
function record(caseId, messageId, step, agent, output, { action = null, reason = null, inputSummary = null, versions = {}, latencyMs = null } = {}) {
  const summary = guard.maskContacts(inputSummary);
  const row = {
    id: db.uuid(), case_id: caseId, message_id: messageId, step, agent, input_summary: summary, output: guard.maskContacts(JSON.stringify(output ?? {})),
    action, reason, prompt_version: versions.prompt ?? null, kb_version: versions.kb ?? null, policy_version: versions.policy ?? null,
    latency_ms: latencyMs, created_at: db.now(),
  };
  db.insert('decisions', row);
  // auto: L2 자동 발송으로 갈 초안(판단 2·실행) — 대시보드가 "승인 대기"로 잘못 보이지 않게
  events.emit('agent.step', { caseId, messageId, step, agent, action, reason, latencyMs, at: row.created_at, summary, auto: !!(output?.autoSend ?? output?.inputs?.autoSend) });
  return row;
}

const activity = (caseId, type, actor, payload) => db.insert('activities', { id: db.uuid(), case_id: caseId, type, actor, payload: payload ? JSON.stringify(payload) : null, created_at: db.now() });
const mustCase = (id) => db.get('SELECT * FROM cases WHERE id=?', id) || (() => { throw new HttpError(404, 'case 없음'); })();
const mustDraft = (id) => db.get('SELECT * FROM drafts WHERE id=?', id) || (() => { throw new HttpError(404, 'draft 없음'); })();
const rowidOf = (messageId) => db.get('SELECT rowid r FROM messages WHERE id=?', messageId)?.r ?? 0;
/** 이 메시지보다 늦게 도착한 고객 메시지가 있나(도착 순서 = rowid). */
const newerInbound = (caseId, messageId) => !!db.get("SELECT 1 FROM messages WHERE case_id=? AND direction='in' AND rowid > ? LIMIT 1", caseId, rowidOf(messageId));
// 접수 안내(sent_by='ack')는 답이 아니다 — 미답·이미 답함 판정에서 뺀다.
const answerOut = () => (off('ack') ? "direction='out'" : "direction='out' AND COALESCE(sent_by, '')<>'ack'");
const lastOutRowid = (caseId) => db.get(`SELECT COALESCE(MAX(rowid), 0) r FROM messages WHERE case_id=? AND ${answerOut()}`, caseId).r;
/** 회차가 맥락을 읽은 뒤(seen_out_rowid) 다른 답장이 나갔나 — 그 답장을 못 보고 쓴 초안이다. 예전 행(NULL)은 0으로 본다(안전 쪽). */
const answeredSince = (d) => !!db.get(`SELECT 1 FROM messages WHERE case_id=? AND ${answerOut()} AND rowid > ? LIMIT 1`, d.case_id, d.seen_out_rowid ?? 0);
const assertNotSending = (caseId) => { if (cases.hasSending(caseId)) throw new HttpError(409, 'sending'); };
const clearRetry = (caseId) => db.run('UPDATE loops SET next_retry_at=NULL, retry_count=0, retry_message_id=NULL WHERE case_id=?', caseId);
/**
 * 재시도 예약은 그 메시지 회차가 끝났거나, 그 메시지를 맥락에 본 더 뒤 메시지가 답장·넘김으로 끝났을 때만 지운다.
 * 자동 회신·감사 인사(IGNORE)가 앞 메시지의 예약을 지우면 그 메시지는 영영 판단되지 않는다.
 */
function settleRetry(caseId, messageId, action) {
  const r = db.get('SELECT retry_message_id FROM loops WHERE case_id=?', caseId)?.retry_message_id;
  if (!r) return;
  const supersedes = ['DRAFT', 'ANSWER_AND_HANDOFF', 'SHADOW', 'HANDOFF'].includes(action) && rowidOf(r) < rowidOf(messageId);
  if (r === messageId || supersedes) clearRetry(caseId);
}

/** 정책 팩 원문을 해시로 저장 — policy_version으로 그때 팩을 되찾는다. policy.js가 원문을 내주지 않아 파일을 다시 읽고 해시가 맞을 때만 쓴다. */
function savePolicyVersion(channel, pack) {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'policy', `${channel}.json`), 'utf8');
    if (kbLoader.sha(text) === pack.version) db.saveVersion(pack.version, `policy:${channel}`, text);
  } catch { /* 그 사이 파일이 바뀌거나 지워졌으면 다음 회차에 저장된다 */ }
}

function notSelectPending(caseId) {
  for (const d of db.all("SELECT id FROM drafts WHERE case_id=? AND status='PENDING'", caseId)) {
    db.run("UPDATE drafts SET status='NOT_SELECTED' WHERE id=?", d.id);
    events.emit('draft.updated', { caseId, draftId: d.id, status: 'NOT_SELECTED' });
  }
}

/* ---------------- 루프 ---------------- */

/** @param {{detachDrain?: boolean}} opts detachDrain = 줄 선 메시지는 기다리지 않고 뒤에서 돌린다(반환·재오픈 응답용) */
async function runCycle(caseId, messageId, { detachDrain = false } = {}) {
  const key = loopKey(caseId, messageId);
  if (!cases.claim(key)) return { skipped: 'already_processed' };
  if (!db.get('SELECT 1 FROM loops WHERE case_id=?', caseId)) { cases.releaseClaim(key); throw new HttpError(404, 'loop 없음'); }
  // 리스는 조건부 UPDATE 한 번으로 잡는다. 못 잡으면 큐에 줄 세운다(리스 주인이 끝나면 꺼내 돌린다).
  const token = db.uuid(); const nowIso = db.now();
  const got = db.run(`UPDATE loops SET lease_until=?, lease_token=?, state=CASE WHEN state='IDLE' THEN 'RUNNING' ELSE state END, updated_at=?
    WHERE case_id=? AND (lease_until IS NULL OR lease_until < ?)`, new Date(Date.now() + LEASE_MS).toISOString(), token, nowIso, caseId, nowIso).changes;
  if (!got) {
    const q = JSON.parse(db.get('SELECT queue FROM loops WHERE case_id=?', caseId).queue || '[]');
    if (!q.includes(messageId)) q.push(messageId);
    db.run('UPDATE loops SET queue=?, updated_at=? WHERE case_id=?', JSON.stringify(q), db.now(), caseId);
    cases.releaseClaim(key); // 큐에서 꺼낼 때 다시 claim한다
    return { queued: true };
  }
  st.active.add(caseId); inflight.add(key);
  let result;
  try { result = await cycle(caseId, messageId); } catch (e) { result = await failSafe(caseId, messageId, e); } finally {
    db.run(`UPDATE loops SET lease_until=NULL, lease_token=NULL, state=CASE WHEN state='RUNNING' THEN 'IDLE' ELSE state END, updated_at=?
      WHERE case_id=? AND lease_token=?`, db.now(), caseId, token);
    st.active.delete(caseId); inflight.delete(key); bump();
    // 예외가 나도 줄 선 회신은 처리한다
    if (detachDrain) setImmediate(() => drain(caseId).catch((e) => console.error('[loop] drain', e)));
    else await drain(caseId);
  }
  return result;
}

async function drain(caseId) {
  const q = queueOf(caseId);
  if (!q.length) return;
  const next = q.shift();
  db.run('UPDATE loops SET queue=?, updated_at=? WHERE case_id=?', JSON.stringify(q), db.now(), caseId);
  try { await runCycle(caseId, next); } catch (e) { console.error('[loop] drain', e); }
}

async function cycle(caseId, messageId) {
  const c = db.get('SELECT * FROM cases WHERE id=?', caseId);
  const msg = db.get('SELECT rowid AS rid, * FROM messages WHERE id=?', messageId);
  if (!c || !msg) throw new HttpError(404, 'case/message 없음');
  const summary = String(msg.body_clean).slice(0, 80);
  // ① 이 메시지 이전(같은 메시지 재판단 포함)에 답한 대기 초안은 판단 결과와 무관하게 STALE — 한 메시지에 PENDING은 하나
  for (const d of db.all("SELECT d.id FROM drafts d JOIN messages m ON m.id=d.trigger_message_id WHERE d.case_id=? AND d.status='PENDING' AND m.rowid <= ?", caseId, msg.rid)) {
    db.run("UPDATE drafts SET status='STALE' WHERE id=?", d.id);
    events.emit('draft.updated', { caseId, draftId: d.id, status: 'STALE' });
  }
  const pack = policy.load(c.channel);
  if (!pack) throw new HttpError(400, `정책 팩 없음: ${c.channel}`);
  const kb = kbLoader.load(c.channel, 'ko');
  db.saveVersion(kb.version, `kb:${c.channel}:ko`, kb.text);
  savePolicyVersion(c.channel, pack);
  const versions = { kb: kb.version, policy: pack.version };
  if (c.responder === 'human') {
    // 넘김 뒤 고객 재문의 — 자동 회신·알림 없음. 목록에 "고객 재문의"로만 보인다.
    record(caseId, messageId, 'gate1', 'code', { responder: 'human' }, { action: 'IGNORE', reason: 'responder_human', inputSummary: summary, versions });
    if (c.state !== 'CLOSED') cases.setState(caseId, 'HANDED_OFF');
    clearRetry(caseId); // 사람이 맡았다 — 재시도할 판단이 없다
    record(caseId, messageId, 'execute', 'code', { action: 'IGNORE', reason: 'responder_human' }, { action: 'IGNORE', reason: 'responder_human', versions });
    return { action: 'IGNORE', reason: 'responder_human' };
  }
  cases.setState(caseId, 'AGENT_ACTIVE');
  // ② 맥락 — 이 메시지까지의 고객 메시지 + 지금까지 나간 답장 전부(발송 중 들어온 메시지도 그 답장을 보게)
  const history = db.all(`SELECT id, direction, sent_by, edited, body_clean, occurred_at FROM messages
    WHERE case_id=? AND (rowid <= ? OR direction='out') ORDER BY rowid DESC LIMIT 6`, caseId, msg.rid).reverse();
  const seenOutRowid = lastOutRowid(caseId); // 이 회차가 본 마지막 답장 — 이 뒤로 나간 답장이 있으면 초안은 already_answered
  const loop = db.get('SELECT * FROM loops WHERE case_id=?', caseId);
  const knownFacts = JSON.parse(c.known_facts || '{}');
  const ctx = {
    caseId, messageId, versions, seenOutRowid, channel: c.channel, pack, kb, case: c, message: msg, history, knownFacts,
    lastOutboundGist: loop.last_outbound_gist, rounds: loop.rounds,
    humanMessages: history.filter((m) => m.direction === 'out' && (m.sent_by === 'human' || m.edited)),
    recentDecisions: db.all("SELECT step, action, reason FROM decisions WHERE case_id=? AND step IN ('gate1','gate2') ORDER BY created_at DESC, rowid DESC LIMIT 3", caseId),
  };
  // ③ 1차 거르기(코드)
  const pf = prefilter.check({ body: msg.body_clean, subject: msg.subject, sender: msg.sender, pack, autoSubmitted: !!msg.auto_submitted, senderChanged: msg.sender !== c.customer_email });
  if (pf) {
    const d = pf.action === 'IGNORE' ? pf : { action: 'HANDOFF', reason: policy.normalizeReason(pack, pf.reason) };
    record(caseId, messageId, 'prefilter', 'code', pf, { action: d.action, reason: d.reason, inputSummary: summary, versions });
    return execute(d, { ...ctx, triage: null });
  }
  // 통과도 남긴다 — 모든 트레이스가 1차 거르기로 시작한다
  record(caseId, messageId, 'prefilter', 'code', { pass: true }, { action: 'PASS', inputSummary: summary, versions });
  let decision; let extra;
  try {
    // ④ 분류
    const tri = await triageAgent.run(ctx);
    const triage = tri.result;
    record(caseId, messageId, 'triage', 'triage', triage, { action: 'CLASSIFIED', reason: triage.intent, inputSummary: triage.questionSummary, versions: { ...versions, prompt: tri.promptVersion }, latencyMs: tri.latencyMs });
    const repeatStreak = triage.repeatsPrevious ? loop.repeat_streak + 1 : 0;
    db.run('UPDATE loops SET repeat_streak=?, updated_at=? WHERE case_id=?', repeatStreak, db.now(), caseId);
    // ⑤ 판단 1차
    const d1 = policy.decide({ pack, triage, rounds: loop.rounds, repeatStreak });
    record(caseId, messageId, 'gate1', 'code', d1, { action: d1.action, reason: d1.reason ?? null, versions });
    if (d1.action !== 'COMPOSE') { decision = d1; extra = { triage }; } else {
      // ⑥ 작성 — 고객 언어의 KB(없으면 한국어 KB를 실제 LLM이 옮긴다)
      const rkb = triage.language === 'en' ? kbLoader.load(c.channel, 'en') : kb;
      if (rkb !== kb) db.saveVersion(rkb.version, `kb:${c.channel}:${rkb.language}`, rkb.text);
      const rv = { ...versions, kb: rkb.version };
      const rctx = { ...ctx, kb: rkb, versions: rv, triage };
      let resp = await responder.run(rctx);
      record(caseId, messageId, 'respond', 'responder', resp.result, { action: 'COMPOSE', inputSummary: (resp.result.body || '').slice(0, 80), versions: { ...rv, prompt: resp.promptVersion }, latencyMs: resp.latencyMs });
      if (resp.result.needsHandoff || !resp.result.body) {
        decision = { action: 'HANDOFF', reason: policy.normalizeReason(pack, resp.result.handoffReason || 'out_of_knowledge'), rule: null, inputs: { from: 'responder' } };
        record(caseId, messageId, 'gate2', 'code', decision, { action: decision.action, reason: decision.reason, versions: rv });
        extra = { triage, kb: rkb, versions: rv };
      } else {
        // ⑦ 검사: 코드 guard → LLM 검수 → 실패면 1회 재작성
        let verdict; let attempt = 0;
        for (;;) {
          const violations = guard.check({ body: resp.result.body, usedFacts: resp.result.usedFacts, pack, kb: rkb, intent: triage.intent });
          record(caseId, messageId, 'guard', 'code', { violations }, { action: violations.length ? 'FAIL' : 'PASS', reason: violations.map((v) => v.code).join(',') || null, versions: rv });
          let reasons = violations;
          if (!violations.length) {
            const r = await reviewer.run({ ...rctx, body: resp.result.body, usedFacts: resp.result.usedFacts, humanCommitments: resp.result.humanCommitments });
            record(caseId, messageId, 'review', 'reviewer', r.result, { action: r.result.pass ? 'PASS' : 'FAIL', reason: r.result.reasons.map((x) => x.code).join(',') || null, versions: { ...rv, prompt: r.promptVersion }, latencyMs: r.latencyMs });
            if (!r.result.pass) reasons = r.result.reasons;
          }
          if (!reasons.length) { verdict = { pass: true }; break; }
          if (attempt >= 1) { verdict = { pass: false, reasons }; break; }
          attempt += 1;
          resp = await responder.run({ ...rctx, violations: reasons, previousBody: resp.result.body, previousUsedFacts: resp.result.usedFacts });
          record(caseId, messageId, 'respond', 'responder', resp.result, { action: 'REWRITE', inputSummary: (resp.result.body || '').slice(0, 80), versions: { ...rv, prompt: resp.promptVersion }, latencyMs: resp.latencyMs });
          if (!resp.result.body) { verdict = { pass: false, reasons }; break; }
        }
        // ⑧ 판단 2차
        decision = policy.decide({ pack, triage, rounds: loop.rounds, repeatStreak, guard: verdict });
        record(caseId, messageId, 'gate2', 'code', decision, { action: decision.action, reason: decision.reason ?? null, versions: rv });
        extra = { triage, body: resp.result.body, usedFacts: resp.result.usedFacts, kb: rkb, versions: rv };
      }
    }
  } catch (e) {
    return scheduleRetry(e, ctx);
  }
  return execute(decision, { ...ctx, ...extra });
}

/** LLM 장애 — 바로 넘기지 않고 2·5·10·30분 뒤 다시 돌린다(sweeper). 그래도 실패하면 코드 브리핑으로 사람에게. */
async function scheduleRetry(e, ctx) {
  const { caseId, messageId } = ctx;
  const loop = db.get('SELECT retry_count, retry_message_id FROM loops WHERE case_id=?', caseId);
  const attempt = (loop.retry_message_id === messageId ? loop.retry_count : 0) + 1;
  const giveUp = attempt > RETRY_MINUTES.length;
  const nextRetryAt = giveUp ? null : new Date(Date.now() + RETRY_MINUTES[attempt - 1] * 60_000 * retryScale()).toISOString();
  record(caseId, messageId, 'error', 'code', { error: String(e && e.message), attempt, nextRetryAt }, { action: giveUp ? 'HANDOFF' : 'RETRY', reason: 'llm_error', inputSummary: String(ctx.message.body_clean).slice(0, 80), versions: ctx.versions });
  if (giveUp) return execute({ action: 'HANDOFF', reason: 'llm_error' }, { ...ctx, triage: null, noLlm: true });
  db.run('UPDATE loops SET next_retry_at=?, retry_count=?, retry_message_id=?, updated_at=? WHERE case_id=?', nextRetryAt, attempt, messageId, db.now(), caseId);
  cases.setState(caseId, 'OPEN'); // 응대 주체는 그대로 에이전트
  return { action: 'RETRY', reason: 'llm_error', attempt, nextRetryAt };
}

/** 회차 바깥 예외(버그·DB 오류) — LLM 없이 사람에게 넘긴다. 메시지가 조용히 묻히지 않게. */
async function failSafe(caseId, messageId, e) {
  console.error('[loop] 회차 예외', e);
  try {
    const c = db.get('SELECT * FROM cases WHERE id=?', caseId);
    if (!c) return { action: 'ERROR', reason: 'case_missing' };
    // 판단 행은 버전을 남긴다 — 팩·KB를 못 읽은 예외면 비운다
    let versions = {};
    try { versions = { kb: kbLoader.load(c.channel, 'ko').version, policy: policy.load(c.channel)?.version }; } catch { /* 버전 없이 기록 */ }
    record(caseId, messageId, 'error', 'code', { error: String(e && e.message) }, { action: 'HANDOFF', reason: 'internal_error', versions });
    const message = db.get('SELECT * FROM messages WHERE id=?', messageId);
    if (c.state !== 'CLOSED') {
      saveHandoff({ caseId, messageId, versions }, 'internal_error', briefer.fallback({ reason: 'internal_error', message, knownFacts: JSON.parse(c.known_facts || '{}') }));
      cases.setResponder(caseId, 'human', { by: 'agent', reason: 'internal_error' });
      db.run("UPDATE loops SET state='HANDED_OFF', updated_at=? WHERE case_id=?", db.now(), caseId);
      cases.setState(caseId, 'HANDED_OFF');
    }
    record(caseId, messageId, 'execute', 'code', { action: 'HANDOFF', reason: 'internal_error' }, { action: 'HANDOFF', reason: 'internal_error', versions });
  } catch (e2) { console.error('[loop] failSafe 실패', e2); }
  return { action: 'HANDOFF', reason: 'internal_error' };
}

async function makeBriefing(x, reason, draftBody) {
  const fb = () => ({ briefing: briefer.fallback({ reason, message: x.message, knownFacts: x.knownFacts }), pv: null, lat: null });
  if (x.noLlm) return fb();
  try { const b = await briefer.run({ ...x, reason, draftBody }); return { briefing: b.result, pv: b.promptVersion, lat: b.latencyMs }; } catch { return fb(); }
}

function saveHandoff(x, reason, briefing, { pv = null, lat = null, recordStep = true } = {}) {
  const id = db.uuid();
  db.insert('handoffs', { id, case_id: x.caseId, reason, briefing: JSON.stringify(briefing), assignee: null, created_at: db.now() });
  if (recordStep) record(x.caseId, x.messageId, 'brief', 'briefer', briefing, { action: 'HANDOFF', reason, inputSummary: briefing.request, versions: { ...x.versions, prompt: pv }, latencyMs: lat });
  events.emit('handoff.created', { caseId: x.caseId, handoffId: id, reason });
  return id;
}

/** 넘김·답장+넘김이 남아 있는(반환 전) 동안에는 새 초안도 답장+넘김이다 — 승인되면 사람에게 간다. */
const openHandoffs = (caseId) => db.all('SELECT reason FROM handoffs WHERE case_id=? AND returned_at IS NULL ORDER BY created_at', caseId);

/** IGNORE·SHADOW로 끝났는데 아직 답 못 한 낡은 초안이 있으면 그 답을 새 메시지 기준으로 다시 승인 대기에 올린다. */
function carryOver(x, reason) {
  const { caseId, messageId, versions } = x;
  if (cases.hasPending(caseId)) return false;
  const lastOut = lastOutRowid(caseId);
  const s = db.get(`SELECT d.* FROM drafts d JOIN messages m ON m.id=d.trigger_message_id
    WHERE d.case_id=? AND d.status='STALE' AND m.rowid > ? ORDER BY m.rowid DESC, d.rowid DESC LIMIT 1`, caseId, lastOut);
  if (!s) return false;
  const id = db.uuid();
  db.insert('drafts', {
    id, case_id: caseId, trigger_message_id: messageId, status: 'PENDING', intent: s.intent, action: s.action, original_body: s.original_body,
    used_facts: s.used_facts, idempotency_key: `draft:${id}`, seen_out_rowid: lastOut, created_at: db.now(),
  });
  events.emit('draft.created', { caseId, draftId: id, status: 'PENDING' });
  cases.setState(caseId, 'AWAITING_APPROVAL');
  record(caseId, messageId, 'execute', 'code', { action: 'CARRY_OVER', reason, from: s.id, draftId: id }, { action: 'CARRY_OVER', reason, versions });
  return true;
}

/** ⑨ 실행 + ⑩ 기록. 느린 일(브리핑 LLM)은 먼저 하고, 쓰기는 사람 행동을 다시 확인한 뒤 한 번에(동기) 한다. */
async function execute(decision, x) {
  const { caseId, messageId, triage, body, usedFacts, versions } = x;
  let { action } = decision; let reason = decision.reason ?? null; let auto = null;
  const open = openHandoffs(caseId);
  if (action === 'DRAFT' && open.length) { action = 'ANSWER_AND_HANDOFF'; reason = open[open.length - 1].reason; }
  const needBrief = action === 'HANDOFF' || (action === 'ANSWER_AND_HANDOFF' && !open.some((h) => h.reason === reason));
  const brief = needBrief ? await makeBriefing(x, reason, action === 'ANSWER_AND_HANDOFF' ? body : null) : null;

  // ---- 여기부터 동기 ----
  const cur = db.get('SELECT state, responder FROM cases WHERE id=?', caseId);
  const drafty = DRAFTY.includes(action);
  let trigger = messageId;
  let newer = drafty && newerInbound(caseId, messageId);
  if (newer) {
    // 재시도로 늦게 끝난 회차: 뒤 메시지 회차가 이미 IGNORE(자동 회신·감사 인사)로 끝났으면 이 답을 받아 줄 회차가 없다.
    // 버리지 않고 마지막 고객 메시지 기준으로 승인 대기에 올린다(CARRY_OVER와 같은 방식).
    const latest = db.get("SELECT id FROM messages WHERE case_id=? AND direction='in' ORDER BY rowid DESC LIMIT 1", caseId).id;
    const done = db.get("SELECT action FROM decisions WHERE message_id=? AND step='execute' ORDER BY rowid DESC LIMIT 1", latest)?.action;
    if (done === 'IGNORE' && !cases.hasPending(caseId)) { newer = false; trigger = latest; }
  }
  const insertDraft = (status, act = action, auto = false) => {
    const id = db.uuid();
    db.insert('drafts', {
      id, case_id: caseId, trigger_message_id: trigger, status, intent: triage?.intent ?? null, action: act, original_body: body,
      used_facts: JSON.stringify(usedFacts || []), idempotency_key: `draft:${id}`, seen_out_rowid: x.seenOutRowid ?? null, created_at: db.now(),
    });
    events.emit('draft.created', { caseId, draftId: id, status, ...(auto ? { auto: true } : {}) }); // auto: 곧 자동 발송 — 승인 대기 알림 안 함
    return id;
  };
  if (cur.state === 'CLOSED' || cur.responder === 'human' || newer) {
    // 회차 도중 사람이 종결·인수·직접 답장했거나 고객이 또 썼다 — 이 결과는 쓰지 않는다(초안은 기록으로만 남긴다).
    if (body && drafty) insertDraft(newer ? 'STALE' : 'NOT_SELECTED');
    const why = cur.state === 'CLOSED' ? 'closed' : cur.responder === 'human' ? 'responder_human' : 'newer_inbound';
    if (cur.state === 'AGENT_ACTIVE') cases.setState(caseId, cases.restingState(caseId));
    settleRetry(caseId, messageId, 'ABORTED');
    record(caseId, messageId, 'execute', 'code', { action: 'ABORTED', planned: action, plannedReason: reason, why }, { action: 'ABORTED', reason: 'case_changed', versions });
    return { action: 'ABORTED', reason: 'case_changed' };
  }
  settleRetry(caseId, messageId, action);
  if (brief) saveHandoff(x, reason, brief.briefing, { pv: brief.pv, lat: brief.lat });
  if (action === 'IGNORE' || action === 'SHADOW') {
    if (action === 'SHADOW') insertDraft('SHADOW');
    if (carryOver(x, reason)) return { action: 'CARRY_OVER', reason };
    const count = db.get('SELECT COUNT(*) n FROM messages WHERE case_id=?', caseId).n;
    const reopened = !!db.get("SELECT 1 FROM activities WHERE case_id=? AND type='reopen' LIMIT 1", caseId);
    // 거절(declined) 뒤 고객의 감사 인사 = 대화 끝(spec §3 종료 조건). 거절 뒤 다른 메시지는 보통 회차로 돈다.
    const prevIntent = db.get("SELECT reason FROM decisions WHERE case_id=? AND step='triage' AND message_id<>? ORDER BY rowid DESC LIMIT 1", caseId, messageId)?.reason;
    if (action === 'IGNORE' && count === 1 && !reopened) {
      // 첫 메시지가 자동 회신·감사 인사뿐이면 열어 둘 이유가 없다. 다시 쓰면 같은 케이스가 재오픈된다(사람이 다시 연 케이스는 닫지 않는다).
      cases.setState(caseId, 'CLOSED', { closed_at: db.now() });
      activity(caseId, 'auto_close', 'system', { reason: 'ignored_first_message' });
    } else if (action === 'IGNORE' && triage?.intent === 'ack' && prevIntent === 'declined' && !reopened) {
      // 사람이 다시 연 케이스는 같은 감사 인사로 곧바로 다시 닫지 않는다
      cases.setState(caseId, 'CLOSED', { closed_at: db.now() });
      activity(caseId, 'auto_close', 'system', { reason: 'declined_ack' });
    } else cases.setState(caseId, cases.restingState(caseId));
  } else if (action === 'DRAFT' || action === 'ANSWER_AND_HANDOFF') {
    // 자동 발송은 순수 답장(DRAFT)만 — 답장+넘김은 사람 신호·부분 근거·견적이 섞여 사람이 본다
    const planned = action === 'DRAFT' && !!decision.inputs?.autoSend;
    const id = insertDraft('PENDING', action, planned);
    if (planned) auto = id;
    cases.setState(caseId, 'AWAITING_APPROVAL');
  } else if (action === 'HANDOFF') {
    cases.setResponder(caseId, 'human', { by: 'agent', reason });
    db.run("UPDATE loops SET state='HANDED_OFF', updated_at=? WHERE case_id=?", db.now(), caseId);
    cases.setState(caseId, 'HANDED_OFF');
  }
  record(caseId, messageId, 'execute', 'code', { action, reason, rule: decision.rule ?? null, autoSend: !!auto, ...(trigger !== messageId ? { trigger } : {}) }, { action, reason, versions });
  // ---- 동기 끝 — 발송은 기록 뒤에(실패해도 판단 기록은 남는다) ----
  if (auto) await autoSend(caseId, auto);
  if (action === 'HANDOFF') await sendAck(x, reason);
  return { action, reason, ...(auto ? { autoSend: true } : {}) };
}

/** L2 — 사람 승인 대신 같은 발송 경로(선점·재확인·guard 재검사·멱등키)를 탄다. 막히면 초안은 PENDING으로 남아 사람이 승인한다. */
async function autoSend(caseId, draftId) {
  try { await approveDraft(draftId, { by: AUTO_BY }); } catch (e) {
    activity(caseId, 'auto_send_failed', AUTO_BY, { draftId, error: e.message });
    events.emit('auto_send.failed', { caseId, draftId, status: db.get('SELECT status FROM drafts WHERE id=?', draftId)?.status, reason: e.message });
  }
}

/** 넘김 1차 응대 — 접수 안내(팩 템플릿: 사실·약속 없음)를 자동으로 보낸다. 케이스는 사람 전담 그대로, 케이스당 한 번. */
async function sendAck(x, reason) {
  const { caseId, messageId, pack } = x;
  if (!pack.ackReply || !policy.autoAllowed(pack) || ACK_SKIP.includes(reason)) return;
  if (db.get("SELECT 1 FROM drafts WHERE case_id=? AND action='ACK' AND status IN ('SENDING','SENT') LIMIT 1", caseId)) return;
  try {
    const c = db.get('SELECT * FROM cases WHERE id=?', caseId);
    const body = pack.ackReply[mail.langOf(x.message?.body_clean)] || pack.ackReply.ko;
    const rendered = mail.renderAgent({ name: c.customer_name, body, auto: true });
    // 사람이 안 보는 메일 — 고객이 넣은 이름·제목도 그대로 나가므로 렌더 결과와 제목을 검사한다. 걸리면 안 보낸다(담당자가 답한다).
    const kb = kbLoader.load(c.channel, mail.langOf(body));
    if (!off('guard') && (guard.check({ body: rendered, pack: { ...pack, thresholds: { ...pack.thresholds, maxLength: Infinity } }, kb }).length || autoSubjectViolations(c, pack, kb).length)) {
      activity(caseId, 'auto_send_failed', AUTO_BY, { ack: true, error: 'guard' });
      return;
    }
    const id = db.uuid(); const now = db.now();
    db.insert('drafts', {
      id, case_id: caseId, trigger_message_id: messageId, status: 'SENDING', intent: null, action: 'ACK', original_body: body,
      used_facts: '[]', idempotency_key: `ack:${id}`, approved_by: AUTO_BY, approved_at: now, created_at: now,
    });
    events.emit('draft.created', { caseId, draftId: id, status: 'SENDING' });
    await deliver(db.get('SELECT * FROM drafts WHERE id=?', id), c, {
      body, rendered, by: AUTO_BY, sentBy: 'ack', edited: false, activityType: 'auto_ack',
      onFail: (err) => { db.run("UPDATE drafts SET status='DISCARDED', error=? WHERE id=?", err, id); events.emit('draft.updated', { caseId, draftId: id, status: 'DISCARDED' }); },
    });
  } catch (e) { if (!(e instanceof HttpError)) console.error('[loop] ack', e); /* 발송 실패는 onFail이 기록했다 — 사람 전담 케이스라 담당자가 답한다 */ }
}

/**
 * 자동 메일 제목(`Re: 고객 제목`)의 링크·전화번호 — 사람이 승인하는 메일은 담당자가 보지만 자동 메일은 아무도 안 본다.
 * 링크는 제목 그대로 본다. 연락처는 이메일 주소를 빼고 본다(전화번호만).
 * 단순화: 실데이터 문의 폼은 제목에 고객 메일을 넣는다(846건 중 124) — 메일 주소 미끼는 놓친다. 수신 어댑터가 폼 제목을 풀면(B17) 다시 넣는다.
 */
function autoSubjectViolations(c, pack, kb) {
  const subject = `Re: ${c.subject || '문의'}`;
  return [...guard.check({ body: subject, pack, kb, only: ['link_not_in_kb'] }),
    ...guard.check({ body: subject.replace(/[^\s@<>()]+@[^\s@<>()]+/g, ' '), pack, kb, only: ['contact'] })];
}

/* ---------------- 발송 ---------------- */

/** 에이전트 초안 검사 — 본문(길이·근거 포함) + 렌더된 메일 전체(인사말에 들어간 이름까지). */
function agentViolations({ body, usedFacts, pack, kb, rendered, intent }) {
  const all = [...guard.check({ body, usedFacts, pack, kb, intent }),
    ...guard.check({ body: rendered, usedFacts, pack: { ...pack, thresholds: { ...pack.thresholds, maxLength: Infinity } }, kb, intent })];
  const seen = new Set();
  return all.filter((v) => { const k = `${v.code}|${v.quote}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 발송 성공 기록 — 승인·직접 답장·"발송됨으로 처리"가 같이 쓴다. 상태는 그 사이 다른 일이 없었을 때만 바꾼다. */
function finalizeSent(d, c, { body, rendered, by, sentBy, edited, editTags, activityType, provider, providerMessageId, providerThreadId, expiredFacts }) {
  const now = db.now(); const messageId = db.uuid(); const dispatchId = db.uuid();
  db.tx(() => {
    db.run(`INSERT INTO dispatches (id, draft_id, idempotency_key, provider, status, provider_message_id, created_at) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(idempotency_key) DO UPDATE SET status='SENT', provider=excluded.provider, provider_message_id=excluded.provider_message_id, error=NULL, created_at=excluded.created_at`,
    dispatchId, d.id, d.idempotency_key, provider, 'SENT', providerMessageId, now);
    db.run("UPDATE drafts SET status='SENT', approved_by=COALESCE(approved_by, ?), approved_at=COALESCE(approved_at, ?), sent_at=?, error=NULL WHERE id=?", by, now, now, d.id);
    const tid = db.get('SELECT thread_id FROM messages WHERE id=?', d.trigger_message_id)?.thread_id
      || db.get('SELECT thread_id FROM case_threads WHERE case_id=? ORDER BY created_at LIMIT 1', d.case_id)?.thread_id;
    db.insert('messages', {
      id: messageId, case_id: d.case_id, thread_id: tid, direction: 'out', sent_by: sentBy, sender: sentBy === 'human' ? by : `${AGENT()} (agent)`,
      subject: `Re: ${c.subject || '문의'}`, body: rendered, body_clean: body, provider_message_id: providerMessageId, occurred_at: now, edited: edited ? 1 : 0,
    });
    // 고객이 연 스레드가 대화다(수신 때 매핑). provider가 답장을 다른 스레드로 보냈으면 그 id도 이 케이스로 묶는다 — 고객 회신이 새 케이스가 되지 않게.
    if (providerThreadId && providerThreadId !== tid) {
      db.run('INSERT INTO case_threads (thread_id, case_id, created_at) VALUES (?,?,?) ON CONFLICT(thread_id) DO NOTHING', providerThreadId, d.case_id, now);
    }
    // 접수 안내는 답이 아니다 — "직전 답" 요약(반복 판단)을 덮지 않는다
    if (sentBy !== 'ack') db.run(`UPDATE loops SET rounds=rounds+?, last_outbound_gist=?, updated_at=? WHERE case_id=?`, sentBy === 'agent' ? 1 : 0, body.slice(0, 300), now, d.case_id);
    activity(d.case_id, activityType, by, { draftId: d.id, editTags: editTags || [], ...(expiredFacts?.length ? { expiredFacts } : {}) });
    const cur = db.get('SELECT state, responder FROM cases WHERE id=?', d.case_id);
    if (sentBy === 'human') cases.setState(d.case_id, 'WAITING_CUSTOMER', { assignee: by });
    else if (cur.responder === 'agent' && cur.state !== 'CLOSED' && !cases.hasPending(d.case_id)) {
      if (d.action === 'ANSWER_AND_HANDOFF') {
        cases.setResponder(d.case_id, 'human', { by: 'agent', reason: 'answer_and_handoff' });
        db.run("UPDATE loops SET state='HANDED_OFF' WHERE case_id=?", d.case_id);
        cases.setState(d.case_id, 'HANDED_OFF');
      } else cases.setState(d.case_id, 'WAITING_CUSTOMER');
    }
  });
  events.emit('draft.updated', { caseId: d.case_id, draftId: d.id, status: 'SENT' });
  events.emit('message.created', { caseId: d.case_id, messageId, direction: 'out' });
  return { dispatchId, draftId: d.id, caseId: d.case_id, edited: !!edited, messageId };
}

/** 메일 스레드 헤더 — 고객 메일 클라이언트가 답장을 같은 대화로 묶고, 고객 회신의 In-Reply-To/References로 이 케이스를 다시 찾는다(cases.addInbound). */
function threadHeaders(d) {
  const asId = (p) => (/^<[^<>\s]+>$/.test(p) ? p : /^[^<>\s]+@[^<>\s]+$/.test(p) ? `<${p}>` : null); // local:·demo- 같은 내부 id는 메일 id가 아니다
  const ids = db.all('SELECT provider_message_id p FROM messages WHERE case_id=? AND rowid <= (SELECT rowid FROM messages WHERE id=?) ORDER BY rowid', d.case_id, d.trigger_message_id)
    .map((r) => asId(r.p)).filter(Boolean);
  const trig = asId(db.get('SELECT provider_message_id p FROM messages WHERE id=?', d.trigger_message_id)?.p);
  return { inReplyTo: trig || undefined, references: ids };
}

async function deliver(d, c, opts) {
  let sent;
  sending.add(d.id);
  try {
    sent = await mail.send({ to: c.customer_email, subject: `Re: ${c.subject || '문의'}`, body: opts.rendered, idempotencyKey: d.idempotency_key, ...threadHeaders(d) });
  } catch (e) {
    opts.onFail(String(e.message));
    db.run(`INSERT INTO dispatches (id, draft_id, idempotency_key, provider, status, error, created_at) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(idempotency_key) DO UPDATE SET status='FAILED', error=excluded.error, created_at=excluded.created_at`,
    db.uuid(), d.id, d.idempotency_key, mail.name(), 'FAILED', String(e.message), db.now());
    throw new HttpError(502, 'send_failed', { detail: e.message });
  } finally { sending.delete(d.id); }
  return finalizeSent(d, c, { ...opts, provider: sent.provider, providerMessageId: sent.id, providerThreadId: sent.threadId });
}

/** 승인·발송. 실패는 HttpError(409 not_pending|closed|stale|already_answered|responder_human|sending|auto_not_allowed, 422 guard, 502 send_failed). */
async function approveDraft(draftId, { by, finalBody, editTags }) {
  const d = mustDraft(draftId);
  // 1. PENDING → SENDING 선점(두 번 눌러도 한 통). 승인자·시각은 선점 때 적는다(발송 확인용).
  if (d.action === 'HUMAN_REPLY' || !db.run("UPDATE drafts SET status='SENDING', approved_by=?, approved_at=? WHERE id=? AND status='PENDING'", by, db.now(), draftId).changes) {
    throw new HttpError(409, 'not_pending', { status: d.status });
  }
  const back = (status, error) => {
    db.run(`UPDATE drafts SET status=?, approved_by=NULL, approved_at=NULL, final_body=NULL, edited_by=NULL, edit_tags=NULL, error=COALESCE(?, error) WHERE id=?`, status, error ?? null, draftId);
    events.emit('draft.updated', { caseId: d.case_id, draftId, status });
    cases.settle(d.case_id);
  };
  const c = db.get('SELECT * FROM cases WHERE id=?', d.case_id);
  if (c.state === 'CLOSED') { back('NOT_SELECTED'); throw new HttpError(409, 'closed'); }
  // 2. 그 사이 고객 재회신 → STALE (도착 순서 = rowid)
  if (!off('inbound') && newerInbound(d.case_id, d.trigger_message_id)) { back('STALE'); throw new HttpError(409, 'stale'); }
  // 3. 이 초안이 쓰이는 동안 다른 답장이 이미 나갔다(발송 중 들어온 메시지에 쓴 초안) — 그 답장을 보고 다시 쓴다
  if (!off('answered') && answeredSince(d)) {
    back('STALE');
    // 같은 메시지에 이미 답장이 나갔으면(같은 메시지의 다른 초안이 발송됨) 다시 쓰지 않는다 — 답장 두 통 방지
    const sent = db.get("SELECT 1 FROM drafts WHERE case_id=? AND trigger_message_id=? AND status='SENT' AND COALESCE(action, '')<>'ACK' LIMIT 1", d.case_id, d.trigger_message_id);
    if (!sent) setImmediate(() => { if (releaseForRerun(d.case_id, d.trigger_message_id)) runCycle(d.case_id, d.trigger_message_id).catch((e) => console.error('[loop] rerun', e)); });
    throw new HttpError(409, 'already_answered');
  }
  // 4. 사람이 맡은 케이스엔 안 보낸다
  if (c.responder === 'human') { back('NOT_SELECTED'); throw new HttpError(409, 'responder_human'); }
  // 같은 케이스의 다른 답장이 아직 나가는 중 — 그 답장을 못 본 채 또 보내지 않는다(끝나면 already_answered로 다시 쓴다)
  if (!off('inflight') && db.get("SELECT 1 FROM drafts WHERE case_id=? AND status='SENDING' AND id<>? LIMIT 1", d.case_id, draftId)) { back('PENDING'); throw new HttpError(409, 'sending'); }
  const pack = policy.load(c.channel);
  // 자동 발송은 보내는 순간 자격을 다시 본다 — 회차 도중 kill switch·섀도 전환·팩 수정이 있었을 수 있다
  if (by === AUTO_BY && !(policy.autoAllowed(pack) && pack.intents[d.intent]?.level === 'L2')) { back('PENDING'); throw new HttpError(409, 'auto_not_allowed'); }
  // 5. guard 재검사 — 사람이 고친 본문 + 실제로 나갈 메일 전체
  const body = typeof finalBody === 'string' && finalBody.trim() ? finalBody.trim() : d.original_body;
  const edited = body !== d.original_body;
  const kb = kbLoader.load(c.channel, mail.langOf(body));
  const rendered = mail.renderAgent({ name: c.customer_name, body, auto: by === AUTO_BY });
  const used = JSON.parse(d.used_facts || '[]');
  // 고친 본문은 원 초안의 근거 절이 그 뒤 기한(validUntil)이 지났어도 막지 않는다 — 그 절을 아직 인용하는지 코드는 모른다. 발송 활동에 경고로 남긴다.
  const expiredFacts = edited ? used.filter((k) => !kb.sections[k]) : [];
  // intent(근거 범위 fact_off_intent·no_fact 검사)는 고치지 않은 원문에만 — 고친 본문은 만료 근거를 뺀 usedFacts가 비어 no_fact로 막힐 수 있다.
  const violations = off('guard') ? [] : agentViolations({ body, usedFacts: used.filter((k) => !expiredFacts.includes(k)), pack, kb, rendered, intent: edited ? null : d.intent });
  if (by === AUTO_BY && !off('guard')) violations.push(...autoSubjectViolations(c, pack, kb));
  if (violations.length) { back('PENDING'); throw new HttpError(422, 'guard', { violations }); }
  if (edited) db.run('UPDATE drafts SET final_body=?, edited_by=?, edit_tags=? WHERE id=?', body, by, JSON.stringify(editTags || []), draftId);
  // 6. 발송(멱등키 = 초안당 하나)
  return deliver(d, c, {
    body, rendered, by, sentBy: 'agent', edited, editTags, expiredFacts, activityType: by === AUTO_BY ? 'auto_send' : edited ? 'edit_approve' : 'approve',
    onFail: (err) => back(db.get('SELECT responder FROM cases WHERE id=?', d.case_id).responder === 'human' ? 'NOT_SELECTED' : 'PENDING', err),
  });
}

/** 사람이 직접 답장 — 실제로 발송한다. 같은 발송 경로(SENDING 선점 → 멱등키 → dispatches)를 탄다. */
async function humanReply(caseId, { by, body }) {
  const c = mustCase(caseId);
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, 'body 필요');
  assertNotSending(caseId);
  const pack = policy.load(c.channel); const kb = kbLoader.load(c.channel, mail.langOf(text));
  const rendered = mail.renderHuman({ name: c.customer_name, by, body: text });
  // 사람은 환불·금액도 말할 수 있다 — 빈 본문과 미치환 자리표시만 막는다.
  const violations = guard.check({ body: rendered, pack, kb, only: ['empty', 'unresolved_slot'], human: true });
  if (violations.length) throw new HttpError(422, 'guard', { violations });
  // 답장을 쓰는 순간 사람이 맡는다(발송 성공 여부와 무관)
  notSelectPending(caseId);
  cases.setResponder(caseId, 'human', { by, reason: 'human_reply' });
  db.run("UPDATE loops SET state='HANDED_OFF', updated_at=? WHERE case_id=?", db.now(), caseId);
  db.run('UPDATE cases SET assignee=? WHERE id=?', by, caseId);
  const trigger = db.get("SELECT id FROM messages WHERE case_id=? AND direction='in' ORDER BY rowid DESC LIMIT 1", caseId)?.id;
  const id = db.uuid(); const now = db.now();
  db.insert('drafts', {
    id, case_id: caseId, trigger_message_id: trigger, status: 'SENDING', intent: null, action: 'HUMAN_REPLY', original_body: text,
    used_facts: '[]', idempotency_key: `human:${id}`, approved_by: by, approved_at: now, created_at: now,
  });
  events.emit('draft.created', { caseId, draftId: id, status: 'SENDING' });
  const d = db.get('SELECT * FROM drafts WHERE id=?', id);
  return deliver(d, c, {
    body: text, rendered, by, sentBy: 'human', edited: false, activityType: 'human_reply',
    onFail: (err) => { db.run("UPDATE drafts SET status='DISCARDED', error=? WHERE id=?", err, id); events.emit('draft.updated', { caseId, draftId: id, status: 'DISCARDED' }); },
  });
}

/** 재시작·고착으로 SENDING에 남은 초안 — 담당자가 메일함을 보고 "발송됨" 또는 "대기로 되돌리기". */
function resolveSending(draftId, { by, outcome }) {
  const d = mustDraft(draftId);
  if (d.status !== 'SENDING') throw new HttpError(409, 'not_sending', { status: d.status });
  // 발송이 진행 중일 수 있으면 손대지 않는다 — 되돌린 뒤 재승인하면 같은 메일이 두 번 나간다
  // (이 프로세스가 보내는 중이거나, 선점한 지 SEND_CHECK_MS가 안 됐다 — 재시작 직후라도 그만큼은 기다린다)
  if (sending.has(d.id) || (d.approved_at && Date.parse(d.approved_at) > Date.now() - cases.SEND_CHECK_MS)) throw new HttpError(409, 'sending_in_progress');
  const c = db.get('SELECT * FROM cases WHERE id=?', d.case_id);
  if (outcome === 'sent') {
    const human = d.action === 'HUMAN_REPLY';
    const body = d.final_body || d.original_body;
    const rendered = human ? mail.renderHuman({ name: c.customer_name, by: d.approved_by || by, body }) : mail.renderAgent({ name: c.customer_name, body, auto: d.approved_by === AUTO_BY });
    return finalizeSent(d, c, { body, rendered, by: human ? d.approved_by || by : by, sentBy: human ? 'human' : d.action === 'ACK' ? 'ack' : 'agent', edited: !!d.final_body, editTags: JSON.parse(d.edit_tags || '[]'), activityType: 'resolve_sending', provider: 'manual', providerMessageId: null });
  }
  if (outcome !== 'pending') throw new HttpError(400, 'outcome은 sent | pending');
  const status = ['HUMAN_REPLY', 'ACK'].includes(d.action) ? 'DISCARDED' : c.responder === 'human' ? 'NOT_SELECTED' : 'PENDING';
  db.run('UPDATE drafts SET status=?, approved_by=NULL, approved_at=NULL WHERE id=?', status, draftId);
  activity(d.case_id, 'resolve_sending', by, { draftId, outcome });
  events.emit('draft.updated', { caseId: d.case_id, draftId, status });
  if (status === 'PENDING' && c.state !== 'CLOSED') cases.setState(d.case_id, 'AWAITING_APPROVAL'); else cases.settle(d.case_id);
  return { draftId, status };
}

/* ---------------- 사람 행동 ---------------- */

function discardDraft(draftId, { by, reason }) {
  const d = mustDraft(draftId);
  if (!db.run("UPDATE drafts SET status='DISCARDED' WHERE id=? AND status='PENDING'", draftId).changes) throw new HttpError(409, 'not_pending', { status: d.status });
  events.emit('draft.updated', { caseId: d.case_id, draftId, status: 'DISCARDED' });
  activity(d.case_id, 'discard', by, { draftId, reason: reason || null });
  // 초안을 버렸으면 사람이 이어받는다 — 에이전트는 같은 메시지를 다시 쓰지 않는다(claim 됨). 담당자용 노트를 남긴다.
  const c = db.get('SELECT * FROM cases WHERE id=?', d.case_id);
  const message = db.get('SELECT * FROM messages WHERE id=?', d.trigger_message_id);
  saveHandoff({ caseId: d.case_id, messageId: d.trigger_message_id, versions: {} }, 'discarded',
    briefer.fallback({ reason: 'discarded', message, knownFacts: JSON.parse(c.known_facts || '{}'), note: `${by}가 에이전트 초안을 폐기했다${reason ? `(${reason})` : ''} — 사람이 직접 답해야 한다.` }), { recordStep: false });
  cases.setResponder(d.case_id, 'human', { by, reason: 'discard' });
  db.run("UPDATE loops SET state='HANDED_OFF', updated_at=? WHERE case_id=?", db.now(), d.case_id);
  cases.setState(d.case_id, 'HANDED_OFF', { assignee: by });
  return { draftId, caseId: d.case_id, status: 'DISCARDED' };
}

function takeover(caseId, { by }) {
  mustCase(caseId);
  assertNotSending(caseId);
  cases.setResponder(caseId, 'human', { by, reason: 'takeover' });
  db.run("UPDATE loops SET state='HANDED_OFF', updated_at=? WHERE case_id=?", db.now(), caseId);
  notSelectPending(caseId);
  cases.setState(caseId, 'HANDED_OFF', { assignee: by });
  activity(caseId, 'takeover', by);
  return { caseId, responder: 'human', state: 'HANDED_OFF' };
}

/** 반환·재오픈 — 그 메시지를 지금 다시 판단한다. 자기 회차만 기다리고 줄 선 메시지는 뒤에서 돈다. */
async function cycleNow(caseId, messageId) {
  if (!releaseForRerun(caseId, messageId)) return { cycled: false, busy: true };
  const result = await runCycle(caseId, messageId, { detachDrain: true });
  return { cycled: true, result, queued: queueOf(caseId).length };
}

/** 마지막 답장 뒤에 온 고객 메시지 중 마지막 것 — 아직 아무도 답하지 않은 메시지. */
const lastUnanswered = (caseId) => db.get(`SELECT id FROM messages WHERE case_id=? AND direction='in'
  AND rowid > COALESCE((SELECT MAX(rowid) FROM messages WHERE case_id=? AND ${answerOut()}), 0)
  ORDER BY rowid DESC LIMIT 1`, caseId, caseId);

/** 반환 — 회차·되묻기 수를 새로 세고, 마지막 미답 고객 메시지를 즉시 다시 판단한다(다음 회신을 기다리면 그 메시지가 묻힌다). */
async function returnToAgent(caseId, { by }) {
  const c = mustCase(caseId);
  const pending = lastUnanswered(caseId);
  // 그 메시지 회차가 이미 돌고 있으면(반환 두 번 눌림) 아무것도 바꾸지 않는다 — 같은 메시지에 초안이 둘 생긴다
  if (pending && inflight.has(loopKey(caseId, pending.id))) throw new HttpError(409, 'busy');
  // 에이전트가 이미 맡은 케이스를 반환하면 같은 메시지를 다시 판단해 초안이 둘이 되고 앞 초안이 STALE이 된다
  if (c.responder !== 'human') throw new HttpError(409, 'not_handed_off');
  cases.setResponder(caseId, 'agent', { by, reason: 'return' });
  db.run("UPDATE loops SET state='IDLE', rounds=0, repeat_streak=0, updated_at=? WHERE case_id=?", db.now(), caseId);
  db.run('UPDATE handoffs SET returned_at=? WHERE case_id=? AND returned_at IS NULL', db.now(), caseId);
  activity(caseId, 'return', by);
  db.run('UPDATE cases SET assignee=NULL WHERE id=?', caseId);
  if (!pending) { cases.setState(caseId, cases.restingState(caseId)); return { caseId, cycled: false }; }
  return { caseId, ...(await cycleNow(caseId, pending.id)) };
}

function closeCase(caseId, { by }) {
  mustCase(caseId);
  assertNotSending(caseId);
  notSelectPending(caseId);
  cases.setState(caseId, 'CLOSED', { closed_at: db.now() });
  activity(caseId, 'close', by);
  return { caseId, state: 'CLOSED' };
}

/** 재오픈 — 마지막 메시지가 답 못 한 고객 메시지면 바로 한 회차(사람 전담이면 "고객 재문의"로), 아니면 고객 회신 대기로 쉰다. */
async function reopenCase(caseId, { by }) {
  const c = mustCase(caseId);
  if (c.state !== 'CLOSED') throw new HttpError(409, 'not_closed', { state: c.state });
  cases.setState(caseId, 'OPEN', { closed_at: null });
  activity(caseId, 'reopen', by);
  const last = db.get('SELECT id, direction FROM messages WHERE case_id=? ORDER BY rowid DESC LIMIT 1', caseId);
  if (last?.direction === 'in') {
    const r = await cycleNow(caseId, last.id);
    return { caseId, ...r, state: db.get('SELECT state FROM cases WHERE id=?', caseId).state };
  }
  cases.setState(caseId, cases.restingState(caseId));
  return { caseId, cycled: false, state: cases.restingState(caseId) };
}

function addNote(caseId, { by, text }) {
  mustCase(caseId);
  if (!text || !String(text).trim()) throw new HttpError(400, 'text 필요');
  activity(caseId, 'note', by, { text: String(text).trim() });
  events.emit('case.updated', { caseId, ...db.get('SELECT state, responder FROM cases WHERE id=?', caseId) });
  return { caseId };
}

/** 섀도 초안 평가 — L0 채널의 승격 근거(cases.promotion). */
function rateShadow(draftId, { by, rating, note }) {
  const d = mustDraft(draftId);
  if (d.status !== 'SHADOW') throw new HttpError(409, 'not_shadow', { status: d.status });
  if (!['good', 'needs_edit', 'critical'].includes(rating)) throw new HttpError(400, 'rating은 good | needs_edit | critical');
  activity(d.case_id, 'shadow_rating', by, { draftId, rating, note: note ? String(note).slice(0, 500) : null });
  events.emit('draft.updated', { caseId: d.case_id, draftId, status: 'SHADOW' });
  return { draftId, rating };
}

/* ---------------- 시작·상태 ---------------- */

/** 재시작 복구: 죽은 리스 해제 → 발송 미확인 표시 → 판단이 끝나지 않은 메시지 재실행 → 줄 선 메시지 처리. */
async function recover() {
  db.run("UPDATE loops SET lease_until=NULL, lease_token=NULL, state=CASE WHEN state='RUNNING' THEN 'IDLE' ELSE state END");
  for (const d of db.all("SELECT id, case_id FROM drafts WHERE status='SENDING'")) {
    // 재시작했으니 진행 중인 발송은 없다 — 나갔는지 모른다. 담당자가 메일함을 보고 정한다.
    if (!db.get("SELECT 1 FROM activities WHERE type='send_unconfirmed' AND payload LIKE ?", `%${d.id}%`)) activity(d.case_id, 'send_unconfirmed', 'system', { draftId: d.id });
  }
  for (const { key } of db.all("SELECT key FROM claims WHERE key LIKE 'loop:%'")) {
    const [, caseId, messageId] = key.split(':');
    if (db.get("SELECT 1 FROM decisions WHERE message_id=? AND step='execute'", messageId)) continue;
    const lp = db.get('SELECT retry_message_id, next_retry_at FROM loops WHERE case_id=?', caseId);
    if (!lp || (lp.retry_message_id === messageId && lp.next_retry_at)) continue; // 재시도 예정은 sweeper 몫
    // 더 나중 메시지가 이미 처리됐으면 그 판단이 이 메시지까지 봤다 — 순서를 거꾸로 돌리지 않는다
    const done = db.get("SELECT COALESCE(MAX(m.rowid), 0) r FROM decisions x JOIN messages m ON m.id=x.message_id WHERE x.case_id=? AND x.step='execute'", caseId).r;
    if (rowidOf(messageId) < done) continue;
    if (!releaseForRerun(caseId, messageId)) continue; // 그 회차가 이미 돌고 있다(sweeper 재시도와 겹침)
    await runCycle(caseId, messageId).catch((e) => console.error('[recover]', e));
  }
  for (const l of db.all("SELECT case_id FROM loops WHERE queue <> '[]'")) await drain(l.case_id);
}

function status() {
  const queueDepth = db.all('SELECT queue FROM loops').reduce((n, r) => n + JSON.parse(r.queue || '[]').length, 0);
  const retriesPending = db.get('SELECT COUNT(*) n FROM loops WHERE next_retry_at IS NOT NULL').n;
  return {
    running: st.active.size > 0, activeCases: [...st.active], queueDepth, retriesPending, lastCycleAt: st.lastCycleAt, cyclesToday: st.cyclesToday,
    llm: llm.health(), provider: { llm: llm.name(), mail: mail.name() },
  };
}

module.exports = {
  runCycle, approveDraft, discardDraft, takeover, returnToAgent, closeCase, reopenCase, addNote, humanReply, resolveSending, rateShadow,
  recover, status, releaseForRerun, LEASE_MS, RETRY_MINUTES,
};
