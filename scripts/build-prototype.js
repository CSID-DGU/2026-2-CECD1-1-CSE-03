'use strict';
// node --no-warnings=ExperimentalWarning scripts/build-prototype.js
// 실제 서버 코드(:memory: DB, mock LLM, mock 메일)로 합성 문의를 돌려 대시보드 초기 상태와 "앞으로 올 문의" 녹화를 만들고,
// web/ 대시보드 + 브라우저 안 백엔드 심(fetch·EventSource)을 HTML 파일 하나로 묶는다 → dist/cs-agent-prototype.html.
// server/·web/ 파일은 빌드할 때마다 새로 읽는다 — 다시 돌리면 그쪽 수정이 그대로 들어간다.
// 끝에서 심의 조회(목록·통계·상세)와 사람 행동(승인·폐기·인수·반환…)을 실제 서버 결과와 대조한다. 어긋나거나 결과 HTML에 금지어(FORBIDDEN)가 남으면 exit 1.
const fs = require('node:fs');
const path = require('node:path');

Object.assign(process.env, { LLM_PROVIDER: 'mock', MAIL_PROVIDER: 'mock', MAIL_MOCK_LOG: '0' });
delete process.env.CS_ABLATE; // 비교 실험 스위치는 프로토타입 대조에 쓰지 않는다
// 판단·발송·지표를 바꾸는 설정은 지운다 — 셸에 남은 값이 프로토타입을 바꾸지 않게(같은 코드 = 같은 결과)
for (const k of ['AUTO_SEND', 'SHADOW_CHANNELS', 'INBOUND_SECRET', 'AUTH_USER_HEADER', 'NODE_ENV', 'LLM_MOCK_DELAY_MS', 'MAIL_MOCK_FAIL', 'MAIL_MOCK_DELAY_MS', 'INTERNAL_DOMAINS', 'ENABLE_TEST_INJECT',
  'REQUIRE_SENDER_AUTH', 'FORM_SENDER_DOMAINS', 'LLM_DAILY_TOKEN_BUDGET', 'LLM_PRICE_INPUT_PER_MTOK', 'LLM_PRICE_OUTPUT_PER_MTOK', 'RETENTION_DAYS', 'AUTO_CLOSE_DAYS', 'LLM_RETRY_SCALE']) delete process.env[k];

// 가상 시계 — 합성 문의가 몇 시간에 걸쳐 들어온 것처럼 타임스탬프를 벌린다. 서버 모듈을 읽기 전에 건다.
const RealDate = Date;
// 타임라인(약 7.5시간)과 대조가 UTC 자정을 넘으면 '오늘 인입'이 서버 스냅숏과 대조 사이에 달라진다 — 넘을 것 같으면 전날 안으로 당긴다.
const SPAN = 8 * 3600e3;
let start = RealDate.now() - 9 * 3600e3;
const midnight = new RealDate(start + SPAN); midnight.setUTCHours(0, 0, 0, 0);
if (midnight.getTime() > start) start = midnight.getTime() - SPAN;
let skew = start - RealDate.now();
global.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + skew); }
  static now() { return RealDate.now() + skew; }
};
const advance = (min) => { skew += min * 60e3; };

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const OUT = path.join(ROOT, 'dist', 'cs-agent-prototype.html');
const db = require('../server/db');
const llm = require('../server/llm');
const cases = require('../server/cases');
const loop = require('../server/loop');
const store = require('../server/store');
const events = require('../server/events');
const policy = require('../server/policy');
const kbLoader = require('../server/kb');
const prefilter = require('../server/prefilter');
const llmMock = require('../server/llm/mock');
const { createServer } = require('../server/index');
const INQ = require('../server/mock/inquiries');

// 브라우저로 그대로 묶는 서버 모듈(순수 JS). node:crypto·agents/common·mail/mock은 심이 대신한다.
const BUNDLE = ['guard', 'labels', 'mail/index', 'prefilter', 'llm/mock', 'agents/briefer', 'crm'];
const COMMON_STUB = "module.exports = { persona: () => '', factsBlock: () => '', historyBlock: () => '', decisionsBlock: () => '', promptSource: () => '', call: () => { throw new Error('프로토타입: LLM 호출 없음'); } };";
// 프로토타입 발송 — 아무 데도 안 보내고 메시지 id만 돌려준다.
const MAIL_STUB = "const { randomUUID } = require('node:crypto'); module.exports = { send: async () => ({ id: 'mock:' + randomUUID(), provider: 'mock' }) };";
// 공개 프로토타입에 싣지 않는 초안 칸 — 녹화 데이터에서 빼고, 심 대조도 양쪽에서 이 칸만 빼고 본다.
const HIDDEN_KEYS = ['idempotency_key', 'seen_out_rowid', 'needsSendCheck', 'sendingDraft'];
const hideKeys = (k, v) => (HIDDEN_KEYS.includes(k) ? undefined : v); // JSON.stringify replacer — 키 순서는 그대로
// 프로토타입에선 나오지 않는 화면 문구·칸을 묶기 전에 뺀다 — [정규식(g), 기대 개수]. 개수가 다르면(원본이 바뀌면) 빌드를 멈춘다.
const LABEL_RE = /\s*\b(?:send_unconfirmed|resolve_sending): '[^']*',/g;
const CUTS = {
  'web/app.js': [[/\s*\balready_answered: '[^']*',/g, 2], [/\n\s*SENDING: '[^']*',/g, 1], [/\n\s*sending(?:_in_progress)?: '[^']*',/g, 2], [LABEL_RE, 2],
    [/,\s*actions\.has\('resolve_sending'\) && d\.sendingDraft \? sendCheckPanel\(d\.sendingDraft\) : null/g, 1], [/\nfunction sendCheckPanel\(sd\) \{[\s\S]*?\n\}\n/g, 1]],
  'web/style.css': [[/\n\.send-check \{[^}]*\}/g, 1]],
  'server/crm.js': [[/, 'resolve_sending'/g, 2], [LABEL_RE, 2], [/\n\s*if \(sendingDraft\?\.needsSendCheck\)[^\n]*/g, 1], [/\n\s*const xd = sendingDraft[^\n]*/g, 1],
    [/, sendingDraft\b(?: = null|: xd(?: \|\| null)?)?/g, 4]],
};
// 빌드 끝 검사: 결과 HTML에 남으면 안 되는 말
const FORBIDDEN = [/seen_?out/i, /already_?answered/i, /idempoten/i, /멱등/, /SENDING/, /answered_?since/i, /last_?out_?rowid/i, /선점/,
  /needs_?send_?check/i, /sending_?draft/i, /resolve[-_]?sending/i, /send_?unconfirmed/i, /sending_in_progress/, /send[-_]?check/i, /발송 중/];

// 그 외 합성 문의(전부 가공). 새 문의 주입 폼이 고른 채널·문장에 맞는 녹화를 찾을 수 있게 채널별 유형을 채운다.
const EXTRA = [
  { id: 'x1', channel: 'support', name: '노은서', from: 'eunseo.noh@example.com', subject: '팀원 초대 기능', body: '팀원 초대 기능은 어떻게 사용하나요? 메뉴를 찾기가 어렵네요.' },
  { id: 'x2', channel: 'support', name: '송유나', from: 'yuna.song@example.com', subject: '지난번 문의 건', body: '지난번에 말씀드린 건 어떻게 됐는지 궁금합니다.' },
  { id: 'x3', channel: 'support', name: '유태오', from: 'taeo.yoo@example.com', subject: '응대가 너무 늦습니다', body: '응대가 너무 늦어서 불만입니다. 벌써 세 번째 문의예요.' },
  { id: 'x4', channel: 'support', name: '남궁별', from: 'byeol.namgung@example.com', subject: '상담원 연결', body: '상담원 연결해 주세요. 메일로는 설명이 어렵습니다.' },
  { id: 'x5', channel: 'onboarding', name: '차민서', from: 'minseo.cha@example.com', subject: '메일 확인 부탁', body: '안녕하세요, 지난주에 보낸 메일 확인 부탁드립니다.' },
  { id: 'x6', channel: 'sales', name: '표하준', from: 'hajun.pyo@example.com', subject: '진행 절차 문의', body: '서비스 진행 절차가 어떻게 되는지 궁금합니다.' },
  { id: 'x7', channel: 'sales', name: '고서윤', from: 'seoyun.ko@example.com', subject: '내부 검토', body: '내부에서 검토해 보고 다시 연락드리겠습니다.' },
  { id: 'x8', channel: 'sales', name: '설도하', from: 'doha.seol@example.com', subject: '이번 건은 보류', body: '이번에는 진행이 어렵겠습니다. 다음에 다시 연락드릴게요.' },
  { id: 'x9', channel: 'sales', name: '변지환', from: 'jihwan.byun@example.com', subject: '수수료 문의', body: '수수료를 조금 조정할 수 있을까요?' },
  { id: 'x10', channel: 'sales', name: '탁예린', from: 'yerin.tak@example.com', subject: '확인 요청', body: '보내드린 내용 확인 부탁드립니다.' },
];
// 자동 재생 순서. F = 초기 상태의 고객 회신 대기 케이스에 오는 후속 회신(FOLLOWUPS 인덱스).
const QUEUE = ['q3', 'q4', 'F0', 'q12', 'q16', 'x6', 'F1', 'q9', 'q15', 'q7', 'F2', 'q19', 'q13', 'x9', 'q5', 'x1', 'q17', 'x7'];
const REVIEWERS = ['박지은', '이현우'];

/* ======================= 브라우저로 들어가는 코드 (바깥 변수 참조 금지) ======================= */

/** 새 문의 → 녹화 고르기용 서명. 빌드(Node)와 브라우저가 같은 함수·같은 서버 모듈로 계산한다. */
function protoSig(q, pack, kb, prefilter, mock) {
  const pf = prefilter.check({ body: q.body, subject: q.subject, sender: q.from, pack });
  if (pf) return `pf:${pf.reason}`;
  const t = mock.triage({ message: { body_clean: q.body }, pack, history: [], kb });
  return `tri:${t.intent}:${t.language}`;
}

/** 인메모리 백엔드 — server/cases.js(조회)·server/loop.js(사람 행동)를 옮긴 것. guard·메일 템플릿·브리핑은 서버 모듈을 그대로 쓴다. */
function protoCore(DATA, req, hooks) {
  const guard = req('guard'); const mail = req('mail/index'); const briefer = req('agents/briefer');
  const now = () => new Date().toISOString();
  const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16); }));
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const fail = (status, error, extra) => { throw Object.assign(new Error(error), { status, extra }); };
  const AGENT = () => DATA.env.AGENT_NAME || 'Aria';
  // L2 자동 발송·접수 안내(loop.js AUTO_BY·ACK_SKIP·policy.autoSendOn). 접수 안내(sent_by='ack')는 답으로 치지 않는다(ANSWER_OUT).
  const AUTO_BY = 'agent:auto'; const ACK_SKIP = ['injection', 'legal_threat', 'sender_changed'];
  const autoSendOn = () => ['1', 'true', 'on', 'yes'].includes(String(DATA.env.AUTO_SEND || '1').trim().toLowerCase()); // 프로토타입은 mock 메일뿐(smtp 조건 없음)
  const autoAllowed = (pack) => autoSendOn() && pack.maxLevel === 'L2' && !pack.shadow; // policy.autoAllowed
  const autoSubjectViolations = (d, pack, kb) => { const s = `Re: ${d.case.subject || '문의'}`; // loop.js 같은 식
    return [...guard.check({ body: s, pack, kb, only: ['link_not_in_kb'] }), ...guard.check({ body: s.replace(/[^\s@<>()]+@[^\s@<>()]+/g, ' '), pack, kb, only: ['contact'] })]; };
  const answerOut = (m) => m.direction === 'out' && m.sent_by !== 'ack';
  const humanSeen = (x) => !['HUMAN_REPLY', 'ACK'].includes(x.action || '') && x.approved_by !== AUTO_BY; // 무수정 승인률·승격 지표에 넣는 초안
  const packOf = (ch) => DATA.policy.find((p) => p.channel === ch) || null;
  const kbOf = (ch, lang) => (DATA.kb[ch] && DATA.kb[ch][lang === 'en' ? 'en' : 'ko']) || { sections: {}, text: '' };

  const store = new Map(); // caseId → 상세(파생 필드 뺀 원본). 넣은 순서 = rowid
  for (const d of DATA.cases) {
    const x = clone(d);
    for (const dr of x.drafts) { delete dr.preview; delete dr.kbPassages; }
    store.set(x.case.id, x);
  }
  // 메시지 rowid(도착 순서). 반환 때 아직 답하지 않은 메시지를 찾는다 — 서버 rowid를 그대로 가져오고 새 메시지는 그 뒤 번호.
  const rowid = new Map(Object.entries(DATA.rowids || {}));
  let maxRow = Math.max(0, ...rowid.values(), ...[...(DATA.pool || []), ...(DATA.followups || [])].flatMap((r) => Object.values(r.rowids || {})));
  const rid = (m) => rowid.get(m.id) ?? 0;
  const newRow = (id) => rowid.set(id, ++maxRow);
  const playing = new Map();
  const st = { active: new Set(), lastCycleAt: DATA.status.lastCycleAt, cyclesToday: DATA.status.cyclesToday };
  const bump = () => { st.cyclesToday += 1; st.lastCycleAt = now(); };
  let buf = null; // 반환 회차: 이벤트를 모았다가 시차를 두고 흘린다
  const emit = (name, data) => (buf ? buf.push([name, data]) : hooks.emit(name, data));

  /* ---- 조회 ---- */
  function getCase(id) {
    const raw = store.get(id); if (!raw) return null;
    const d = clone(raw); const c = d.case;
    for (const x of d.drafts) {
      if (x.status === 'PENDING') {
        const kb = kbOf(c.channel, mail.langOf(x.original_body));
        x.preview = mail.renderAgent({ name: c.customer_name, body: x.original_body });
        x.kbPassages = Object.fromEntries((x.used_facts || []).map((k) => [k, kb.sections[k] ? kb.sections[k].text : guard.isToolFact(k) ? '(고객사 시스템 조회 결과 — 이 고객의 상태·일정)' : '(KB에 없음 — 기한 지남 또는 삭제)']));
      }
    }
    return { case: c, threadIds: d.threadIds, messages: d.messages, drafts: d.drafts,
      decisions: d.decisions, handoffs: d.handoffs, activities: d.activities, loop: d.loop };
  }
  const lastBy = (arr, key) => arr.reduce((b, x, i) => (!b || x[key] > b.x[key] || (x[key] === b.x[key] && i > b.i) ? { x, i } : b), null)?.x || null;
  function signalsOf(d) { // 최신 접수 판단의 감정 신호 — 목록 두 곳이 같이 쓴다
    const tri = [...d.decisions].reverse().find((r) => r.step === 'triage');
    const o = tri && (typeof tri.output === 'string' ? JSON.parse(tri.output) : tri.output);
    return o ? { sentiment: o.sentiment ?? null, urgency: o.urgency ?? null, threat: o.threat ?? null } : null;
  }
  function listRow(d, all) {
    const c = clone(d.case);
    const last = lastBy(d.messages, 'occurred_at');
    const pend = lastBy(d.drafts.filter((x) => x.status === 'PENDING'), 'created_at');
    const lastHandoff = d.handoffs.reduce((m, h) => (h.created_at > m ? h.created_at : m), '');
    const since = [lastHandoff, c.responder_changed_at || ''].sort().pop();
    return { ...c, threadId: d.threadIds[0] ?? null, lastMessageAt: last ? last.occurred_at : null, lastMessageDirection: last ? last.direction : null,
      lastMessagePreview: last ? [...String(last.body_clean)].slice(0, 120).join('') : null, pendingDraftId: pend ? pend.id : null,
      sameEmailOpenCases: all.filter((o) => o.case.customer_email === c.customer_email && o.case.id !== c.id && o.case.state !== 'CLOSED').length,
      reaskedAfterHandoff: c.state === 'HANDED_OFF' && d.messages.some((m) => m.direction === 'in' && m.occurred_at > since),
      signals: signalsOf(d) };
  }
  function listCases({ state, channel, q, limit = 50 } = {}) {
    const states = state ? String(state).split(',') : null; const like = q ? String(q).toLowerCase() : null;
    const lim = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 500);
    const all = [...store.values()];
    return all.map((d, i) => [d, i])
      .filter(([d]) => (!states || states.includes(d.case.state)) && (!channel || d.case.channel === channel)
        && (!like || [d.case.subject, d.case.customer_email, d.case.customer_name].some((v) => v != null && String(v).toLowerCase().includes(like))))
      .sort(([a, i], [b, j]) => (a.case.updated_at < b.case.updated_at ? 1 : a.case.updated_at > b.case.updated_at ? -1 : i - j))
      .slice(0, lim).map(([d]) => listRow(d, all));
  }
  function promotion(channel) {
    const ds = []; const ratings = [];
    for (const d of store.values()) {
      if (d.case.channel !== channel) continue;
      for (const x of d.drafts) if (x.status === 'SENT' && humanSeen(x)) ds.push(x);
      for (const a of d.activities) if (a.type === 'shadow_rating') ratings.push(a);
    }
    const crit = ds.filter((x) => JSON.stringify(x.edit_tags ?? '').includes('critical')).length;
    const last = new Map();
    for (const a of ratings.map((a, i) => [a, i]).sort(([a, i], [b, j]) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : i - j))) {
      const p = a[0].payload || {}; if (p.draftId) last.set(p.draftId, p.rating);
    }
    const rated = [...last.values()];
    const reviewed = ds.length + rated.length;
    const good = ds.filter((x) => x.final_body == null).length + rated.filter((r) => r === 'good').length;
    const criticalCount = crit + rated.filter((r) => r === 'critical').length;
    const approvedNoEditRate = reviewed ? Math.round((good / reviewed) * 1000) / 1000 : 0;
    const P = DATA.promotion;
    return { reviewed, approvedNoEditRate, criticalCount, eligible: reviewed >= P.minReviewed && approvedNoEditRate >= P.minNoEditRate && criticalCount <= P.maxCritical, criteria: P };
  }
  function stats() {
    const by = {}; const byCh = {}; const today = new Date().toISOString().slice(0, 10);
    let total = 0; let todayInbound = 0; const dr = { total: 0, noEdit: 0, edited: 0, discarded: 0 };
    const fr = { n: 0, auto: 0, responded: 0, human: 0 }; // 1차 응대 3분류(cases.js stats)
    for (const d of store.values()) {
      const out = d.messages.some((m) => m.direction === 'out');
      if (out || d.decisions.some((r) => r.step === 'execute' && (r.action || '') !== 'IGNORE')) {
        fr.n += 1;
        if (d.case.responder === 'agent' && d.drafts.some((x) => x.status === 'SENT' && x.approved_by === AUTO_BY && x.action !== 'ACK')
          && !d.activities.some((a) => ['approve', 'edit_approve', 'discard', 'human_reply', 'takeover', 'return'].includes(a.type))) fr.auto += 1;
        if (d.messages.some((m) => m.direction === 'out' && ['agent', 'ack'].includes(m.sent_by)) || d.drafts.some((x) => x.status === 'PENDING')) fr.responded += 1;
        if (d.case.responder === 'human') fr.human += 1;
      }
      const s = d.case.state; by[s] = (by[s] || 0) + 1; total += 1;
      ((byCh[d.case.channel] ??= {})[s] ??= 0); byCh[d.case.channel][s] += 1;
      todayInbound += d.messages.filter((m) => m.direction === 'in' && m.occurred_at >= today).length;
      for (const x of d.drafts) {
        if (!humanSeen(x)) continue;
        dr.total += 1; if (x.status === 'SENT') { if (x.final_body == null) dr.noEdit += 1; else dr.edited += 1; } if (x.status === 'DISCARDED') dr.discarded += 1;
      }
    }
    const byChannel = {};
    for (const ch of Object.keys(byCh).sort()) {
      byChannel[ch] = { total: 0 };
      for (const s of Object.keys(byCh[ch]).sort()) { byChannel[ch][s] = byCh[ch][s]; byChannel[ch].total += byCh[ch][s]; }
    }
    return {
      total, unresolved: total - (by.CLOSED || 0), open: (by.OPEN || 0) + (by.AGENT_ACTIVE || 0), agentActive: by.AGENT_ACTIVE || 0, awaitingApproval: by.AWAITING_APPROVAL || 0,
      handedOff: by.HANDED_OFF || 0, waitingCustomer: by.WAITING_CUSTOMER || 0, closed: by.CLOSED || 0, todayInbound,
      agentDrafts: dr.total, approvedNoEdit: dr.noEdit, approvedEdited: dr.edited, discarded: dr.discarded, byChannel,
      firstResponse: { base: fr.n, auto: fr.auto, handedOff: fr.responded - fr.auto, none: fr.n - fr.responded, human: fr.human, rate: fr.n ? Math.round((1000 * fr.responded) / fr.n) / 1000 : null },
      promotion: Object.fromEntries(DATA.policy.map((p) => [p.channel, promotion(p.channel)])),
    };
  }
  function status() {
    const loops = [...store.values()].map((d) => d.loop || {});
    return { running: st.active.size > 0, activeCases: [...st.active], queueDepth: loops.reduce((n, l) => n + (l.queue || []).length, 0),
      retriesPending: loops.filter((l) => l.next_retry_at).length, lastCycleAt: st.lastCycleAt, cyclesToday: st.cyclesToday, llm: DATA.status.llm, provider: DATA.status.provider };
  }

  /* ---- 상태 헬퍼 (cases.js) ---- */
  const touch = (id) => { const p = playing.get(id); if (p) p.aborted = true; }; // 재생 중인 케이스를 사람이 건드리면 녹화 적용을 멈춘다
  const mustCase = (id) => { const d = store.get(id); if (!d) fail(404, 'case 없음'); touch(id); return d; };
  const mustDraft = (id) => { for (const d of store.values()) { const x = d.drafts.find((y) => y.id === id); if (x) { touch(d.case.id); return [d, x]; } } return fail(404, 'draft 없음'); };
  const idx = (d, mid) => d.messages.findIndex((m) => m.id === mid); // 도착 순서(rowid) 대용
  const hasPending = (d) => d.drafts.some((x) => x.status === 'PENDING');
  const restingState = (d) => (hasPending(d) ? 'AWAITING_APPROVAL' : d.messages.some((m) => m.direction === 'out') ? 'WAITING_CUSTOMER' : 'OPEN');
  function setState(d, state, patch = {}) {
    Object.assign(d.case, { state, updated_at: now() }, patch);
    emit('case.updated', { caseId: d.case.id, state: d.case.state, responder: d.case.responder });
  }
  const settle = (d) => { if (d.case.state === 'AWAITING_APPROVAL' && !hasPending(d)) setState(d, restingState(d)); };
  function setResponder(d, responder, { by, reason }) {
    const t = now(); Object.assign(d.case, { responder, responder_changed_at: t, responder_changed_by: by, responder_change_reason: reason, updated_at: t });
  }
  const loopSet = (d, patch) => Object.assign(d.loop, patch, { updated_at: now() });
  const activity = (d, type, actor, payload) => d.activities.push({ id: uuid(), case_id: d.case.id, type, actor, payload: payload ? clone(payload) : null, created_at: now() });
  function notSelectPending(d) {
    for (const x of d.drafts) if (x.status === 'PENDING') { x.status = 'NOT_SELECTED'; emit('draft.updated', { caseId: d.case.id, draftId: x.id, status: 'NOT_SELECTED' }); }
  }
  const draftRow = (o) => ({
    id: o.id, case_id: o.case_id, trigger_message_id: o.trigger_message_id, status: o.status, intent: o.intent ?? null, action: o.action ?? null, original_body: o.original_body,
    final_body: null, edited_by: null, edit_tags: null, used_facts: o.used_facts ?? [], approved_by: o.approved_by ?? null,
    approved_at: o.approved_at ?? null, sent_at: null, error: null, created_at: o.created_at,
  });
  function saveHandoff(d, reason, briefing, before) {
    const id = uuid();
    d.handoffs.push({ id, case_id: d.case.id, reason, briefing: clone(briefing), assignee: null, created_at: now(), returned_at: null });
    if (before) before();
    emit('handoff.created', { caseId: d.case.id, handoffId: id, reason });
  }
  function replayRow(d, src, mid, override = {}) {
    const row = { ...clone(src), id: uuid(), message_id: mid, created_at: now(), ...clone(override) };
    row.input_summary = guard.maskContacts(row.input_summary);
    d.decisions.push(row);
    emit('agent.step', { caseId: d.case.id, messageId: mid, step: row.step, agent: row.agent, action: row.action, reason: row.reason, latencyMs: row.latency_ms, at: row.created_at, summary: row.input_summary });
  }

  /* ---- 발송 (loop.js) ---- */
  function agentViolations({ body, usedFacts, pack, kb, rendered, intent }) {
    const all = [...guard.check({ body, usedFacts, pack, kb, intent }),
      ...guard.check({ body: rendered, usedFacts, pack: { ...pack, thresholds: { ...pack.thresholds, maxLength: Infinity } }, kb, intent })];
    const seen = new Set();
    return all.filter((v) => { const k = `${v.code}|${v.quote}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  const newerInbound = (d, mid) => { const i = idx(d, mid); return d.messages.some((m, j) => m.direction === 'in' && j > i); };
  function finalizeSent(x, d, { body, rendered, by, sentBy, edited, editTags, activityType, provider, providerMessageId, expiredFacts }) {
    const t = now(); const messageId = uuid(); const dispatchId = uuid();
    Object.assign(x, { status: 'SENT', approved_by: x.approved_by ?? by, approved_at: x.approved_at ?? t, sent_at: t, error: null });
    const tid = d.messages.find((m) => m.id === x.trigger_message_id)?.thread_id || d.threadIds[0];
    newRow(messageId);
    d.messages.push({ id: messageId, case_id: d.case.id, thread_id: tid, direction: 'out', sent_by: sentBy, sender: sentBy === 'human' ? by : `${AGENT()} (agent)`,
      subject: `Re: ${d.case.subject || '문의'}`, body: rendered, body_clean: body, provider_message_id: providerMessageId, occurred_at: t, auto_submitted: 0, edited: edited ? 1 : 0, sender_auth: null, event_id: null });
    if (sentBy !== 'ack') Object.assign(d.loop, { rounds: d.loop.rounds + (sentBy === 'agent' ? 1 : 0), last_outbound_gist: body.slice(0, 300), updated_at: t });
    activity(d, activityType, by, { draftId: x.id, editTags: editTags || [], ...(expiredFacts && expiredFacts.length ? { expiredFacts } : {}) });
    if (sentBy === 'human') setState(d, 'WAITING_CUSTOMER', { assignee: by });
    else if (d.case.responder === 'agent' && d.case.state !== 'CLOSED' && !hasPending(d)) {
      if (x.action === 'ANSWER_AND_HANDOFF') {
        setResponder(d, 'human', { by: 'agent', reason: 'answer_and_handoff' }); d.loop.state = 'HANDED_OFF'; setState(d, 'HANDED_OFF');
      } else setState(d, 'WAITING_CUSTOMER');
    }
    emit('draft.updated', { caseId: d.case.id, draftId: x.id, status: 'SENT' });
    emit('message.created', { caseId: d.case.id, messageId, direction: 'out' });
    return { dispatchId, draftId: x.id, caseId: d.case.id, edited: !!edited, messageId };
  }
  async function deliver(x, d, opts) {
    let sent;
    try { sent = await mail.send({ to: d.case.customer_email, subject: `Re: ${d.case.subject || '문의'}`, body: opts.rendered }); }
    catch (e) { opts.onFail(String(e.message)); fail(502, 'send_failed', { detail: e.message }); }
    return finalizeSent(x, d, { ...opts, provider: sent.provider, providerMessageId: sent.id });
  }
  async function approveDraft(draftId, { by, finalBody, editTags }) {
    const [d, x] = mustDraft(draftId);
    if (x.action === 'HUMAN_REPLY' || x.status !== 'PENDING') fail(409, 'not_pending', { status: x.status });
    const back = (status, error) => {
      Object.assign(x, { status, approved_by: null, approved_at: null, final_body: null, edited_by: null, edit_tags: null }); if (error != null) x.error = error;
      emit('draft.updated', { caseId: d.case.id, draftId, status }); settle(d);
    };
    if (d.case.state === 'CLOSED') { back('NOT_SELECTED'); fail(409, 'closed'); }
    if (newerInbound(d, x.trigger_message_id)) { back('STALE'); fail(409, 'stale'); }
    if (d.case.responder === 'human') { back('NOT_SELECTED'); fail(409, 'responder_human'); }
    if (by === AUTO_BY && !(autoAllowed(packOf(d.case.channel)) && packOf(d.case.channel).intents[x.intent]?.level === 'L2')) fail(409, 'auto_not_allowed');
    const body = typeof finalBody === 'string' && finalBody.trim() ? finalBody.trim() : x.original_body;
    const edited = body !== x.original_body;
    const pack = packOf(d.case.channel); const kb = kbOf(d.case.channel, mail.langOf(body));
    const rendered = mail.renderAgent({ name: d.case.customer_name, body, auto: by === AUTO_BY });
    const used = x.used_facts || [];
    const expiredFacts = edited ? used.filter((k) => !kb.sections[k]) : [];
    const violations = agentViolations({ body, usedFacts: used.filter((k) => !expiredFacts.includes(k)), pack, kb, rendered, intent: edited ? null : x.intent });
    if (by === AUTO_BY) violations.push(...autoSubjectViolations(d, pack, kb));
    if (violations.length) fail(422, 'guard', { violations });
    if (edited) Object.assign(x, { final_body: body, edited_by: by, edit_tags: clone(editTags || []) });
    return deliver(x, d, { body, rendered, by, sentBy: 'agent', edited, editTags, expiredFacts, activityType: by === AUTO_BY ? 'auto_send' : edited ? 'edit_approve' : 'approve',
      onFail: (err) => back(d.case.responder === 'human' ? 'NOT_SELECTED' : 'PENDING', err) });
  }
  async function humanReply(caseId, { by, body }) {
    const d = mustCase(caseId);
    const text = String(body || '').trim();
    if (!text) fail(400, 'body 필요');
    const pack = packOf(d.case.channel); const kb = kbOf(d.case.channel, mail.langOf(text));
    const rendered = mail.renderHuman({ name: d.case.customer_name, by, body: text });
    const violations = guard.check({ body: rendered, pack, kb, only: ['empty', 'unresolved_slot'], human: true });
    if (violations.length) fail(422, 'guard', { violations });
    notSelectPending(d);
    setResponder(d, 'human', { by, reason: 'human_reply' });
    loopSet(d, { state: 'HANDED_OFF' });
    d.case.assignee = by;
    const trigger = [...d.messages].reverse().find((m) => m.direction === 'in')?.id ?? null;
    const id = uuid(); const t = now();
    const x = draftRow({ id, case_id: d.case.id, trigger_message_id: trigger, status: 'SENT', intent: null, action: 'HUMAN_REPLY', original_body: text,
      used_facts: [], approved_by: by, approved_at: t, created_at: t });
    d.drafts.push(x);
    emit('draft.created', { caseId: d.case.id, draftId: id, status: 'SENT' });
    return deliver(x, d, { body: text, rendered, by, sentBy: 'human', edited: false, activityType: 'human_reply',
      onFail: (err) => { Object.assign(x, { status: 'DISCARDED', error: err }); emit('draft.updated', { caseId: d.case.id, draftId: id, status: 'DISCARDED' }); } });
  }

  /* ---- 사람 행동 (loop.js) ---- */
  function discardDraft(draftId, { by, reason }) {
    const [d, x] = mustDraft(draftId);
    if (x.status !== 'PENDING') fail(409, 'not_pending', { status: x.status });
    x.status = 'DISCARDED';
    emit('draft.updated', { caseId: d.case.id, draftId, status: 'DISCARDED' });
    activity(d, 'discard', by, { draftId, reason: reason || null });
    const message = d.messages.find((m) => m.id === x.trigger_message_id);
    saveHandoff(d, 'discarded', briefer.fallback({ reason: 'discarded', message, knownFacts: d.case.known_facts || {}, note: `${by}가 에이전트 초안을 폐기했다${reason ? `(${reason})` : ''} — 사람이 직접 답해야 한다.` }));
    setResponder(d, 'human', { by, reason: 'discard' });
    loopSet(d, { state: 'HANDED_OFF' });
    setState(d, 'HANDED_OFF', { assignee: by });
    return { draftId, caseId: d.case.id, status: 'DISCARDED' };
  }
  function takeover(caseId, { by }) {
    const d = mustCase(caseId);
    setResponder(d, 'human', { by, reason: 'takeover' });
    loopSet(d, { state: 'HANDED_OFF' });
    notSelectPending(d);
    setState(d, 'HANDED_OFF', { assignee: by });
    activity(d, 'takeover', by);
    return { caseId, responder: 'human', state: 'HANDED_OFF' };
  }
  const GOOD = ['IGNORE', 'SHADOW', 'DRAFT', 'ANSWER_AND_HANDOFF', 'HANDOFF'];
  /** 판단 기록을 메시지별 회차로 묶는다(실행 행으로 끝남). 다시 돌릴 수 있는 회차만. */
  function cycles(d) {
    const gs = []; let cur = null;
    for (const r of d.decisions) {
      if (!cur || cur.closed || cur.mid !== r.message_id) { cur = { mid: r.message_id, rows: [], closed: false }; gs.push(cur); }
      cur.rows.push(r); if (r.step === 'execute') cur.closed = true;
    }
    return gs.filter((g) => { const ex = g.rows[g.rows.length - 1]; return g.closed && GOOD.includes(ex.action) && ex.reason !== 'responder_human' && !g.rows.some((r) => r.step === 'error'); });
  }
  /**
   * 반환 뒤 회차. mock LLM은 결정적이라 같은 메시지를 다시 판단하면 같은 결과가 나온다 — 그 메시지의 지난 회차를 새 id로 다시 기록한다.
   * 단순화: 그 메시지로 돈 회차가 없으면(사람 전담 중 재문의) 이 케이스의 마지막 회차를 이 메시지에 붙인다. 실제 재판단은 서버에서.
   */
  async function replayCycle(d, mid) {
    const gs = cycles(d);
    const g = [...gs].reverse().find((x) => x.mid === mid) || gs[gs.length - 1];
    const caseId = d.case.id; const mi = idx(d, mid);
    for (const x of d.drafts) {
      if (x.status === 'PENDING' && idx(d, x.trigger_message_id) <= mi) { x.status = 'STALE'; emit('draft.updated', { caseId, draftId: x.id, status: 'STALE' }); }
    }
    if (d.case.responder === 'human') { // 사람 전담 — 판단하지 않고 "고객 재문의"로만 보인다
      const pack = packOf(d.case.channel); const versions = { kb_version: kbOf(d.case.channel, 'ko').version, policy_version: pack.version };
      const base = { step: 'gate1', agent: 'code', input_summary: String(d.messages[mi].body_clean).slice(0, 80), output: { responder: 'human' }, action: 'IGNORE', reason: 'responder_human', prompt_version: null, ...versions, latency_ms: null };
      replayRow(d, base, mid);
      if (d.case.state !== 'CLOSED') setState(d, 'HANDED_OFF');
      replayRow(d, { ...base, step: 'execute', input_summary: null, output: { action: 'IGNORE', reason: 'responder_human' } }, mid);
      bump();
      return { action: 'IGNORE', reason: 'responder_human' };
    }
    if (!g) { setState(d, restingState(d)); return { action: 'IGNORE', reason: 'no_recording' }; }
    const rows = g.rows; const ex = rows[rows.length - 1];
    const tri = rows.find((r) => r.step === 'triage')?.output || null;
    const resp = [...rows].reverse().find((r) => r.step === 'respond')?.output || null;
    const briefRow = rows.find((r) => r.step === 'brief');
    setState(d, 'AGENT_ACTIVE');
    for (const r of rows) {
      if (r.step === 'brief' || r.step === 'execute') continue;
      replayRow(d, r, mid);
      if (r.step === 'triage') loopSet(d, { repeat_streak: tri && tri.repeatsPrevious ? d.loop.repeat_streak + 1 : 0 });
    }
    let action = ex.action; let reason = ex.reason ?? null;
    const open = d.handoffs.filter((h) => !h.returned_at);
    if (action === 'DRAFT' && open.length) { action = 'ANSWER_AND_HANDOFF'; reason = open[open.length - 1].reason; }
    const needBrief = action === 'HANDOFF' || (action === 'ANSWER_AND_HANDOFF' && !open.some((h) => h.reason === reason));
    if (needBrief) {
      const message = d.messages.find((m) => m.id === mid);
      const briefing = briefRow && briefRow.reason === reason ? briefRow.output : briefer.fallback({ reason, message, knownFacts: d.case.known_facts || {} });
      const src = briefRow && briefRow.reason === reason ? briefRow : { step: 'brief', agent: 'briefer', input_summary: briefing.request, output: briefing, action: 'HANDOFF', reason, prompt_version: null, kb_version: ex.kb_version, policy_version: ex.policy_version, latency_ms: null };
      saveHandoff(d, reason, briefing, () => replayRow(d, src, mid));
    }
    let auto = null;
    const insertDraft = (status) => {
      const id = uuid();
      d.drafts.push(draftRow({ id, case_id: caseId, trigger_message_id: mid, status, intent: tri ? tri.intent : null, action, original_body: resp ? resp.body : null,
        used_facts: (resp && resp.usedFacts) || [], created_at: now() }));
      emit('draft.created', { caseId, draftId: id, status });
      return id;
    };
    if (action === 'IGNORE' || action === 'SHADOW') {
      if (action === 'SHADOW') insertDraft('SHADOW');
      // 단순화: carryOver(낡은 초안 다시 올림)는 재현 안 함 — 반환 직후엔 그럴 STALE 초안이 거의 없다.
      const reopened = d.activities.some((a) => a.type === 'reopen');
      const prevIntent = [...d.decisions].reverse().find((r) => r.step === 'triage' && r.message_id !== mid)?.reason;
      if (action === 'IGNORE' && d.messages.length === 1 && !reopened) { setState(d, 'CLOSED', { closed_at: now() }); activity(d, 'auto_close', 'system', { reason: 'ignored_first_message' }); }
      else if (action === 'IGNORE' && tri && tri.intent === 'ack' && prevIntent === 'declined' && !reopened) { setState(d, 'CLOSED', { closed_at: now() }); activity(d, 'auto_close', 'system', { reason: 'declined_ack' }); }
      else setState(d, restingState(d));
    } else if (action === 'DRAFT' || action === 'ANSWER_AND_HANDOFF') {
      const id = insertDraft('PENDING');
      if (ex.output && ex.output.autoSend) auto = id; // 같은 메시지·같은 mock 판단 → 녹화 때와 같은 L2 여부
      setState(d, 'AWAITING_APPROVAL');
    } else if (action === 'HANDOFF') { setResponder(d, 'human', { by: 'agent', reason }); loopSet(d, { state: 'HANDED_OFF' }); setState(d, 'HANDED_OFF'); }
    replayRow(d, ex, mid, { output: { action, reason, rule: (ex.output && ex.output.rule) ?? null, autoSend: !!auto }, action, reason });
    bump();
    if (auto) { try { await approveDraft(auto, { by: AUTO_BY }); } catch (e) { activity(d, 'auto_send_failed', AUTO_BY, { draftId: auto, error: e.message }); } }
    if (action === 'HANDOFF') await sendAck(d, mid, reason);
    return { action, reason, ...(auto ? { autoSend: true } : {}) };
  }
  /** 넘김 접수 안내(loop.js sendAck) — 팩 템플릿, 케이스당 한 번, 사람 전담 그대로. */
  async function sendAck(d, mid, reason) {
    const pack = packOf(d.case.channel);
    if (!pack.ackReply || !autoAllowed(pack) || ACK_SKIP.includes(reason)) return;
    if (d.drafts.some((x) => x.action === 'ACK' && x.status === 'SENT')) return;
    const message = d.messages.find((m) => m.id === mid);
    const body = pack.ackReply[mail.langOf(message && message.body_clean)] || pack.ackReply.ko;
    const rendered = mail.renderAgent({ name: d.case.customer_name, body, auto: true });
    const kb = kbOf(d.case.channel, mail.langOf(body));
    if (guard.check({ body: rendered, pack: { ...pack, thresholds: { ...pack.thresholds, maxLength: Infinity } }, kb }).length || autoSubjectViolations(d, pack, kb).length) {
      activity(d, 'auto_send_failed', AUTO_BY, { ack: true, error: 'guard' }); return;
    }
    const id = uuid(); const t = now();
    const x = draftRow({ id, case_id: d.case.id, trigger_message_id: mid, status: 'SENT', intent: null, action: 'ACK', original_body: body,
      used_facts: [], approved_by: AUTO_BY, approved_at: t, created_at: t });
    d.drafts.push(x);
    emit('draft.created', { caseId: d.case.id, draftId: id, status: 'SENT' });
    try {
      await deliver(x, d, { body, rendered, by: AUTO_BY, sentBy: 'ack', edited: false, activityType: 'auto_ack',
        onFail: (err) => { Object.assign(x, { status: 'DISCARDED', error: err }); emit('draft.updated', { caseId: d.case.id, draftId: id, status: 'DISCARDED' }); } });
    } catch { /* onFail이 기록했다 */ }
  }
  const lastUnanswered = (d) => { const lo = Math.max(0, ...d.messages.filter(answerOut).map(rid)); return [...d.messages].reverse().find((m) => m.direction === 'in' && rid(m) > lo) || null; };
  async function returnToAgent(caseId, { by }) {
    if (playing.has(caseId) && lastUnanswered(store.get(caseId))) fail(409, 'busy'); // 그 메시지 회차가 아직 도는 중
    const d = mustCase(caseId);
    if (d.case.responder !== 'human') fail(409, 'not_handed_off');
    buf = [];
    try {
      setResponder(d, 'agent', { by, reason: 'return' });
      loopSet(d, { state: 'IDLE', rounds: 0, repeat_streak: 0 });
      const t = now(); for (const h of d.handoffs) if (!h.returned_at) h.returned_at = t;
      activity(d, 'return', by);
      d.case.assignee = null;
      const pending = lastUnanswered(d);
      if (!pending) { setState(d, restingState(d)); return { caseId, cycled: false }; }
      return { caseId, cycled: true, result: await replayCycle(d, pending.id), queued: 0 };
    } finally { const b = buf; buf = null; hooks.stagger(b); }
  }
  /** 반환 — 보류 중이면 먼저 풀고, 반환이 거절되면(409 등) 보류를 되돌린다(index.js returnCase). */
  async function returnCase(caseId, b) {
    const d = store.get(caseId) || fail(404, 'case 없음');
    const held = d.case.held_at ? { held_at: d.case.held_at, hold_note: d.case.hold_note } : null;
    if (held) Object.assign(d.case, { held_at: null, hold_note: null });
    try { return await returnToAgent(caseId, b); } catch (e) { if (held) Object.assign(d.case, held); throw e; }
  }
  function closeCase(caseId, { by }) {
    const d = mustCase(caseId);
    notSelectPending(d);
    setState(d, 'CLOSED', { closed_at: now() });
    activity(d, 'close', by);
    return { caseId, state: 'CLOSED' };
  }
  function addNote(caseId, { by, text }) {
    const d = mustCase(caseId);
    if (!text || !String(text).trim()) fail(400, 'text 필요');
    activity(d, 'note', by, { text: String(text).trim() });
    emit('case.updated', { caseId, state: d.case.state, responder: d.case.responder });
    return { caseId };
  }
  function rateShadow(draftId, { by, rating, note }) {
    const [d, x] = mustDraft(draftId);
    if (x.status !== 'SHADOW') fail(409, 'not_shadow', { status: x.status });
    if (!['good', 'needs_edit', 'critical'].includes(rating)) fail(400, 'rating은 good | needs_edit | critical');
    activity(d, 'shadow_rating', by, { draftId, rating, note: note ? String(note).slice(0, 500) : null });
    emit('draft.updated', { caseId: d.case.id, draftId, status: 'SHADOW' });
    return { draftId, rating };
  }

  /* ---- CRM 컬렉션 (server/collections.js syncCase·index.js /api/crm/*) ----
   * 스냅숏 문서에서 시작해, 읽을 때마다 지금 store로 crm.projectCase(직전 문서 = prev)를 다시 부른다 — 바뀌었으면 revision+1.
   * 문의자·고객사·수신 이벤트는 새 케이스(녹화 재생)에만 만든다. 종결 후 회신 경로는 녹화에 없어 재현하지 않는다. */
  const crm = req('crm');
  const docs = { cases: new Map(), contacts: new Map(), companies: new Map(), events: new Map() };
  for (const k of Object.keys(docs)) for (const [id, x] of Object.entries(DATA.crm[k])) docs[k].set(id, clone(x));
  let caseNo = Math.max(0, ...[...docs.cases.values()].map((x) => Number(x.doc.caseNumber)));
  const INTAKE = { type: 'system', id: 'intake' };
  /** 문의자·업무 도메인 고객사 찾기/만들기(collections.js link, 새 케이스 몫만). */
  function crmLink(c, firstEventId) {
    const email = crm.contactKey(c.customer_email);
    if (!email || c.purged_at) return { contactId: null, companyId: null };
    const domain = crm.companyDomain(email, {});
    const audit = { createdAt: c.created_at, createdBy: { ...INTAKE }, updatedAt: c.created_at, updatedBy: { ...INTAKE } };
    let co = domain ? [...docs.companies.values()].find((x) => x.primaryDomain === domain) : null;
    if (domain && !co) {
      const name = (c.known_facts && c.known_facts.회사) || domain;
      co = { id: uuid(), type: 'unknown', primaryDomain: domain, canonicalName: name, normalizedName: name.toLowerCase(), aliases: [], domains: [{ value: domain, status: 'observed' }], lifecycleStatus: 'active', audit };
      docs.companies.set(co.id, co);
    }
    let p = [...docs.contacts.values()].find((x) => x.primaryEmail === email);
    if (!p) {
      p = { id: uuid(), companyId: co ? co.id : null, type: 'person', primaryEmail: email, emails: [{ value: email, normalizedValue: email, kind: 'observed', verified: false, firstObservedAt: c.created_at, lastObservedAt: c.created_at }],
        current: { name: { value: c.customer_name && c.customer_name !== '고객' ? c.customer_name : null, observedAt: c.created_at, sourceEventId: firstEventId, confidence: 1, manuallyVerified: false } }, lifecycleStatus: 'active', audit };
      docs.contacts.set(p.id, p);
    }
    return { contactId: p.id, companyId: p.companyId ?? (co ? co.id : null) };
  }
  function crmCtx(d) {
    const ins = d.messages.filter((m) => m.direction === 'in');
    for (const [i, m] of ins.entries()) { // 녹화 재생으로 들어온 수신 메일 — 이벤트 문서(collections.js ingest)
      if (m.event_id && !docs.events.has(m.event_id)) {
        docs.events.set(m.event_id, crm.eventFromMessage(m, d.case, { sourceType: m.sender_auth === 'form' ? 'customer_support_form' : i ? 'email_reply' : 'email_inbound', method: i ? 'thread' : 'new_case' }));
      }
    }
    const ev = (mid) => docs.events.get(d.messages.find((m) => m.id === mid)?.event_id) || null;
    const prev = docs.cases.get(d.case.id);
    const link = prev ? { contactId: prev.doc.contactId, companyId: prev.doc.companyId } : crmLink(d.case, ins[0]?.event_id ?? null);
    return { pack: packOf(d.case.channel), caseNumber: prev ? Number(prev.doc.caseNumber) : caseNo + 1, ...link,
      eventIdOf: (mid) => ev(mid)?.id ?? null, sourceTypeOf: (mid) => ev(mid)?.sourceType ?? null };
  }
  /** 케이스 문서 {doc, revision} — 지금 store로 다시 계산(collections.js syncCase + store.put). */
  function crmCase(id) {
    const d = store.get(id); if (!d) return null;
    const prev = docs.cases.get(id);
    const ctx = crmCtx(d);
    const { doc, changed } = crm.projectCase(d, prev ? prev.doc : null, ctx);
    if (!prev) caseNo += 1;
    if (changed) docs.cases.set(id, { doc, revision: prev ? prev.revision + 1 : 1 });
    return { ...docs.cases.get(id), ctx };
  }
  function crmList(q) {
    const bad = crm.badFilter(q); if (bad) fail(400, 'bad_filter', { field: bad });
    const view = crm.listView([...store.keys()].map((id) => crmCase(id).doc), q);
    view.items = view.items.map((x) => ({ ...x, signals: signalsOf(store.get(x.id)) }));
    return view;
  }
  function crmDetail(id) {
    const x = crmCase(id) || fail(404, 'case 없음');
    const g = getCase(id); const doc = x.doc;
    const rated = new Set(g.activities.filter((a) => a.type === 'shadow_rating').map((a) => a.payload && a.payload.draftId));
    return crm.detailView({ // 이어진 케이스 없음 — 종결 뒤 회신은 같은 케이스를 다시 연다(cases.js addInbound)
      doc, revision: x.revision, contact: docs.contacts.get(doc.contactId) ?? null, company: docs.companies.get(doc.companyId) ?? null,
      events: g.messages.filter((m) => m.direction === 'in').map((m) => docs.events.get(m.event_id)).filter(Boolean),
      activities: crm.projectActivities(store.get(id), x.ctx),
      pendingDraft: g.drafts.filter((y) => y.status === 'PENDING').at(-1) ?? null,
      shadowDraft: g.drafts.filter((y) => y.status === 'SHADOW' && !rated.has(y.id)).at(-1) ?? null,
      agentLog: crm.agentLog(g.decisions),
    });
  }
  /** 화면이 본 revision이 지금과 다르면 409 stale(index.js fresh). 보내지 않았으면 검사하지 않는다. */
  const assertRevision = (id, expected) => { if (expected != null) { const { revision } = crmCase(id); if (revision !== Number(expected)) fail(409, 'stale', { revision }); } };
  const note500 = (t) => guard.maskPii(t).slice(0, 500);
  const caseActivity = (d, type, by, payload) => { activity(d, type, by, payload); emit('case.updated', { caseId: d.case.id, state: d.case.state, responder: d.case.responder }); };
  function holdCase(caseId, { by, note, expectedRevision }) {
    const d = mustCase(caseId);
    const text = String(note ?? '').trim();
    if (!text) fail(400, 'note 필요');
    assertRevision(caseId, expectedRevision);
    if (d.case.responder !== 'human' || d.case.state === 'CLOSED') fail(409, 'not_escalated');
    if (d.case.held_at) fail(409, 'already_held');
    const t = now(); const masked = note500(text);
    Object.assign(d.case, { held_at: t, hold_note: masked, updated_at: t });
    caseActivity(d, 'hold', by, { note: masked });
    return { caseId, held: true };
  }
  function unholdCase(caseId, { by, expectedRevision }) {
    const d = mustCase(caseId);
    assertRevision(caseId, expectedRevision);
    if (!d.case.held_at) fail(409, 'not_held');
    Object.assign(d.case, { held_at: null, hold_note: null, updated_at: now() });
    caseActivity(d, 'unhold', by, null);
    return { caseId, held: false };
  }
  /** 종결 — 사유 필수(기타면 상세도). */
  function closeWithReason(caseId, { by, reason, detail, expectedRevision }) {
    const d = mustCase(caseId);
    if (!crm.CLOSE_REASONS.includes(reason)) fail(400, 'bad_reason');
    const text = String(detail ?? '').trim();
    if (reason === 'other' && !text) fail(400, 'detail 필요');
    assertRevision(caseId, expectedRevision);
    if (d.case.state === 'CLOSED') fail(409, 'already_closed');
    Object.assign(d.case, { close_reason: reason, close_detail: text ? note500(text) : null, held_at: null, hold_note: null });
    return { ...closeCase(caseId, { by }), closeReason: reason };
  }

  /* ---- 녹화 재생: 서버가 실제로 낸 SSE 이벤트 순서대로 상태를 조금씩 바꾼다 ---- */
  function canPlay(rec) {
    if (rec.kind === 'new') return !store.has(rec.caseId);
    const d = store.get(rec.caseId);
    return !!d && !playing.has(rec.caseId) && d.case.state === rec.pre.state && d.case.responder === rec.pre.responder;
  }
  function applyEv(rec, ev) {
    const F = rec.final; let d = store.get(rec.caseId);
    const pick = (arr, id) => arr.find((x) => x.id === id);
    if (ev.name === 'message.created') {
      const m = pick(F.messages, ev.data.messageId);
      if (!d) {
        d = { case: { ...clone(F.case), state: 'OPEN', responder: 'agent', responder_changed_at: null, responder_changed_by: null, responder_change_reason: null, assignee: null, closed_at: null, updated_at: m.occurred_at },
          threadIds: clone(F.threadIds), messages: [], drafts: [], decisions: [], handoffs: [], activities: [], loop: { ...clone(F.loop), state: 'RUNNING' } };
        store.set(rec.caseId, d);
      }
      if (m && !pick(d.messages, m.id)) { d.messages.push(clone(m)); d.case.updated_at = m.occurred_at; rowid.set(m.id, (rec.rowids || {})[m.id] ?? ++maxRow); }
    } else if (!d) return;
    else if (ev.name === 'case.updated') Object.assign(d.case, { state: ev.data.state, responder: ev.data.responder, updated_at: now() });
    else if (ev.name === 'agent.step') { const r = F.decisions.find((x) => !pick(d.decisions, x.id)); if (r) d.decisions.push(clone(r)); }
    else if (ev.name === 'draft.created') { const x = pick(F.drafts, ev.data.draftId); if (x && !pick(d.drafts, x.id)) d.drafts.push({ ...clone(x), status: ev.data.status }); }
    else if (ev.name === 'draft.updated') { const x = pick(d.drafts, ev.data.draftId); if (x) x.status = ev.data.status; }
    else if (ev.name === 'handoff.created') { const x = pick(F.handoffs, ev.data.handoffId); if (x && !pick(d.handoffs, x.id)) d.handoffs.push(clone(x)); }
  }
  function finalize(rec) {
    const F = rec.final; const d = store.get(rec.caseId); if (!d) return;
    d.case = clone(F.case); d.threadIds = clone(F.threadIds); d.loop = clone(F.loop);
    for (const m of F.messages) if (!rowid.has(m.id)) rowid.set(m.id, (rec.rowids || {})[m.id] ?? ++maxRow);
    for (const k of ['messages', 'drafts', 'decisions', 'handoffs', 'activities']) {
      for (const x of F[k]) {
        const y = clone(k === 'drafts' ? Object.fromEntries(Object.entries(x).filter(([key]) => !['preview', 'kbPassages'].includes(key))) : x);
        const i = d[k].findIndex((z) => z.id === y.id); if (i >= 0) d[k][i] = y; else d[k].push(y);
      }
    }
  }
  function startPlay(rec) { const p = { rec, i: 0, aborted: false }; playing.set(rec.caseId, p); st.active.add(rec.caseId); return p; }
  function stepPlay(p) { const ev = p.rec.events[p.i++]; if (!ev) return false; if (!p.aborted) applyEv(p.rec, ev); emit(ev.name, ev.data); return true; }
  function endPlay(p) { if (!p.aborted) finalize(p.rec); playing.delete(p.rec.caseId); st.active.delete(p.rec.caseId); bump(); }

  /* ---- 라우팅 (index.js) ---- */
  const by = (b) => { if (!b || typeof b.by !== 'string' || !b.by.trim()) fail(400, 'by(표시 이름) 필요'); return b; };
  function inbound(b) {
    if (!b.channel || !b.from || !b.body) fail(400, 'channel, from, body 필수');
    if (!packOf(b.channel)) fail(400, `알 수 없는 channel: ${b.channel}`);
    return hooks.inbound(b);
  }
  const routes = [
    ['GET', /^\/api\/health$/, () => DATA.health],
    ['GET', /^\/api\/status$/, () => DATA.appStatus],
    ['GET', /^\/api\/me$/, () => ({ user: null, auth: 'none' })],
    ['GET', /^\/api\/stats$/, () => stats()],
    ['GET', /^\/api\/policy$/, () => DATA.policy],
    ['GET', /^\/api\/agent\/status$/, () => status()],
    ['GET', /^\/api\/cases$/, (_m, q) => listCases(q)],
    ['GET', /^\/api\/cases\/([^/]+)$/, (m) => getCase(m[1]) || fail(404, 'case 없음')],
    ['GET', /^\/api\/crm\/cases$/, (_m, q) => crmList(q)],
    ['GET', /^\/api\/crm\/cases\/([^/]+)$/, (m) => crmDetail(m[1])],
    ['POST', /^\/api\/(?:test\/)?inbound$/, (_m, _q, b) => inbound(b)],
    ['POST', /^\/api\/drafts\/([^/]+)\/approve$/, (m, _q, b) => approveDraft(m[1], by(b))],
    ['POST', /^\/api\/drafts\/([^/]+)\/discard$/, (m, _q, b) => discardDraft(m[1], by(b))],
    ['POST', /^\/api\/drafts\/([^/]+)\/rate$/, (m, _q, b) => rateShadow(m[1], by(b))],
    ['POST', /^\/api\/cases\/([^/]+)\/takeover$/, (m, _q, b) => takeover(m[1], by(b))],
    ['POST', /^\/api\/cases\/([^/]+)\/return$/, (m, _q, b) => returnCase(m[1], by(b))],
    ['POST', /^\/api\/cases\/([^/]+)\/close$/, (m, _q, b) => closeWithReason(m[1], by(b))],
    ['POST', /^\/api\/cases\/([^/]+)\/hold$/, (m, _q, b) => holdCase(m[1], by(b))],
    ['POST', /^\/api\/cases\/([^/]+)\/unhold$/, (m, _q, b) => unholdCase(m[1], by(b))],
    ['POST', /^\/api\/cases\/([^/]+)\/note$/, (m, _q, b) => addNote(m[1], by(b))],
    ['POST', /^\/api\/cases\/([^/]+)\/human-reply$/, (m, _q, b) => humanReply(m[1], by(b))],
  ];
  async function handle(method, url, body) {
    const [pathname, qs = ''] = String(url).split('?');
    try {
      for (const [mth, re, fn] of routes) {
        if (mth !== method) continue;
        const m = pathname.match(re); if (!m) continue;
        const out = await fn(m, Object.fromEntries(new URLSearchParams(qs)), method === 'POST' ? (body ?? {}) : null);
        return { status: 200, body: out ?? {} };
      }
      return { status: 404, body: { error: 'not found' } };
    } catch (e) {
      if (e && e.status) return { status: e.status, body: { error: e.message, ...(e.extra || {}) } };
      console.error('[proto]', e);
      return { status: 500, body: { error: 'internal' } };
    }
  }
  return { handle, stats, status, listCases, getCase, crmList, crmDetail, canPlay, startPlay, stepPlay, endPlay, store };
}

/** 브라우저 접착부 — 시간 이동, 모듈 require, fetch·EventSource 가로채기, 자동 재생. */
function protoBrowser(RAW, SNAP, MODS, protoCore, protoSig, sanitizeName) {
  const ISO = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"/g;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const STATS_TRIGGERS = ['case.updated', 'draft.created', 'draft.updated', 'handoff.created', 'message.created'];
  const shift = (json, from, delta) => json.replace(ISO, (m, s) => (s >= from ? `"${new Date(Date.parse(s) + delta).toISOString()}"` : m));
  // 빌드 시각 기준 타임스탬프를 지금 기준으로 옮긴다 — "3시간 전"이 늘 3시간 전으로 보이게.
  const DATA = JSON.parse(shift(RAW, '', Date.now() - Date.parse(SNAP)));
  const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16); }));

  // 아주 작은 CommonJS — server/ 경로 기준 상대 require만.
  const PROCESS = { env: DATA.env };
  const BUILTIN = { 'node:crypto': { randomUUID: uuid } };
  const cache = {};
  const resolve = (from, name) => { const parts = from.split('/').slice(0, -1); for (const s of name.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); } return parts.join('/'); };
  const makeReq = (from) => (name) => {
    if (BUILTIN[name]) return BUILTIN[name];
    const key = resolve(from, name);
    if (!cache[key]) { if (!MODS[key]) throw new Error(`proto: 모듈 없음 ${key}`); const m = (cache[key] = { exports: {} }); MODS[key](m, m.exports, makeReq(key), PROCESS); }
    return cache[key].exports;
  };
  const req = makeReq('');

  // ---- SSE 흉내 ----
  const sources = new Set();
  function deliver(name, data) {
    for (const s of [...sources]) s._msg(name, data);
    if (STATS_TRIGGERS.includes(name) && sources.size) { const st = core.stats(); for (const s of [...sources]) s._msg('stats.updated', st); }
  }
  function stagger(list) { let t = 0; for (const [n, d] of list) { t += n === 'agent.step' ? 350 : 40; setTimeout(() => deliver(n, d), t); } }
  class FakeEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url); this.readyState = 0; this.withCredentials = false; this.onopen = null; this.onmessage = null; this.onerror = null;
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1; sources.add(this);
        const ev = new Event('open'); this.dispatchEvent(ev); if (typeof this.onopen === 'function') this.onopen(ev);
        this._msg('hello', { at: new Date().toISOString(), status: core.status(), stats: core.stats() });
      }, 150);
    }
    close() { this.readyState = 2; sources.delete(this); }
    _msg(name, data) {
      const ev = new MessageEvent(name, { data: JSON.stringify(data), lastEventId: '' });
      this.dispatchEvent(ev);
      if (name === 'message' && typeof this.onmessage === 'function') this.onmessage(ev);
    }
  }
  FakeEventSource.CONNECTING = 0; FakeEventSource.OPEN = 1; FakeEventSource.CLOSED = 2;

  // ---- 녹화 준비: 새 id·지금 시각 ----
  const restamp = (rec) => JSON.parse(shift(JSON.stringify(rec), rec.t0, Date.now() - Date.parse(rec.t0)));
  function fresh(rec) {
    const map = new Map();
    return restamp(JSON.parse(JSON.stringify(rec).replace(UUID, (u) => { if (!map.has(u)) map.set(u, uuid()); return map.get(u); })));
  }
  function play(rec, syncFirst = 0) {
    const p = core.startPlay(rec);
    for (let k = 0; k < syncFirst; k++) core.stepPlay(p);
    return new Promise((done) => {
      const next = () => {
        const ev = rec.events[p.i];
        if (!ev) { core.endPlay(p); done(); return; }
        setTimeout(() => { core.stepPlay(p); next(); }, ev.name === 'agent.step' ? 350 : 60);
      };
      next();
    });
  }

  // ---- 새 문의 주입: 입력 문장을 서버의 prefilter·mock 분류로 서명 → 같은 서명의 녹화에 입력 문장을 갈아 끼워 재생 ----
  const firstSentence = (s) => String(s || '').trim().split(/(?<=[.!?])\s+|\n/)[0].slice(0, 80);
  let injectN = 0;
  function substitute(rec, b) {
    const o = rec.orig; const esc = (s) => JSON.stringify(String(s)).slice(1, -1);
    const name = sanitizeName(b.name || String(b.from).replace(/@.*/, '')); const from = String(b.from).trim().toLowerCase();
    let j = JSON.stringify(rec);
    const pairs = [[o.body, b.body], [firstSentence(o.body), firstSentence(b.body)], [o.body.slice(0, 80), String(b.body).slice(0, 80)], [o.subject, b.subject || ''], [o.from, from], [o.name, name]];
    for (const [a, z] of pairs) if (a) j = j.split(esc(a)).join(esc(z));
    const r = JSON.parse(j);
    r.final.case.known_facts = {}; // 녹화 쪽 폼 값은 이 문의와 무관
    for (const h of r.final.handoffs) h.briefing.knownFacts = [];
    for (const x of r.final.decisions) if (x.step === 'brief' && x.output) x.output.knownFacts = [];
    return r;
  }
  function inbound(b) {
    const pack = DATA.policy.find((p) => p.channel === b.channel);
    const sig = protoSig({ subject: b.subject, body: String(b.body), from: b.from }, pack, DATA.kb[b.channel].ko, req('prefilter'), req('llm/mock'));
    const inCh = DATA.pool.filter((r) => r.channel === b.channel);
    let cand = inCh.filter((r) => r.sig === sig);
    if (!cand.length) cand = inCh.filter((r) => r.sig.startsWith('tri:unclear'));
    let rec;
    if (cand.length) rec = substitute(fresh(cand[injectN++ % cand.length]), b);
    else { rec = fresh(DATA.pool[injectN++ % DATA.pool.length]); console.info('[proto] 맞는 녹화가 없어 다른 합성 문의를 그대로 재생합니다', sig); }
    play(rec, 2); // message.created + case.updated(OPEN)까지는 응답 전에 — 서버 addInbound와 같은 시점
    return { caseId: rec.caseId, messageId: rec.final.messages[0].id, threadId: rec.final.threadIds[0], created: true };
  }

  const core = protoCore(DATA, req, { emit: deliver, stagger, inbound });

  // ---- fetch 가로채기: /api/*만, 나머지는 막는다(네트워크 없음) ----
  function apiPath(input) {
    const s = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (s.startsWith('/api/')) return s;
    try { const u = new URL(s, location.href); if (u.origin === location.origin && u.pathname.startsWith('/api/')) return u.pathname + u.search; } catch { /* about:srcdoc 등 */ }
    return null;
  }
  window.fetch = async (input, init = {}) => {
    const p = apiPath(input);
    if (!p) throw new TypeError('프로토타입: 외부 네트워크 요청은 막혀 있습니다');
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    let body;
    if (init.body != null) { try { body = JSON.parse(init.body); } catch { body = undefined; } }
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
    const r = await core.handle(method, p, body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  window.EventSource = FakeEventSource;

  // ---- 자동 재생: 10–14초마다 다음 녹화. 끝나면 새 id로 처음부터 ----
  let qi = 0; let busy = false;
  function nextRec() {
    for (let n = 0; n < DATA.queue.length; n++) {
      const ref = DATA.queue[qi]; qi = (qi + 1) % DATA.queue.length;
      if (ref.startsWith('F')) { const r = restamp(DATA.followups[Number(ref.slice(1))]); if (core.canPlay(r)) return r; continue; }
      return fresh(DATA.pool.find((x) => x.id === ref));
    }
    return null;
  }
  function tick() {
    setTimeout(tick, 10000 + Math.random() * 4000);
    if (busy || document.hidden) return;
    const rec = nextRec(); if (!rec) return;
    busy = true; play(rec).then(() => { busy = false; });
  }
  setTimeout(tick, 6000);
}

/* ======================= 빌드 (Node) ======================= */

const clone = (v) => JSON.parse(JSON.stringify(v));
let tape = null;
events.subscribe((ev) => { if (tape) tape.push({ name: ev.name, data: ev.data }); });

async function inbound(q, extra = {}) {
  const r = cases.addInbound({ channel: q.channel, from: q.from, name: q.name, subject: q.subject, body: q.body, knownFacts: q.knownFacts, ...extra });
  await loop.runCycle(r.caseId, r.messageId);
  return r;
}
async function replyTo(caseId, body) {
  const c = db.get('SELECT channel, customer_email, customer_name, subject FROM cases WHERE id=?', caseId);
  const t = db.get('SELECT thread_id FROM case_threads WHERE case_id=? ORDER BY created_at LIMIT 1', caseId).thread_id;
  const r = cases.addInbound({ channel: c.channel, from: c.customer_email, name: c.customer_name, subject: `Re: ${c.subject || '문의'}`, body, threadId: t });
  await loop.runCycle(r.caseId, r.messageId);
  return r;
}
const rowidsOf = (caseId) => Object.fromEntries(db.all('SELECT id, rowid r FROM messages WHERE case_id=? ORDER BY rowid', caseId).map((m) => [m.id, m.r]));
const pendingOf = (caseId) => db.get("SELECT id FROM drafts WHERE case_id=? AND status='PENDING' ORDER BY created_at DESC, rowid DESC LIMIT 1", caseId)?.id;
const inq = (id) => (typeof id === 'number' ? INQ.find((x) => x.id === id) : EXTRA.find((x) => x.id === id));

/** 초기 상태 — 실제 서비스 함수로 약 7시간 동안의 하루를 만든다. */
async function scenario() {
  const C = {};
  const [A, B] = REVIEWERS;
  const inb = (id) => async () => { C[id] = (await inbound(inq(id))).caseId; };
  // 메일 장애 흉내 — 이 한 걸음만 발송 실패(L2 자동 발송 → 승인 대기로 남음, 접수 안내 → DISCARDED)
  const mailDown = (fn) => async () => { process.env.MAIL_MOCK_FAIL = '1'; try { await fn(); } finally { delete process.env.MAIL_MOCK_FAIL; } };
  const steps = [
    [0, inb(10)], // 부재중 → 자동 종결
    [12, inb(4)], // 환불 → 넘김
    [25, inb(2)], // 영수증 — L2 자동 발송
    [38, inb(9)], // 지시 변경 시도 → 넘김(prefilter), 접수 안내 안 보냄
    [66, mailDown(inb(6))], // 데이터 반출 → 넘김, 접수 안내 발송 실패(DISCARDED)
    [80, inb(13)], // 미팅 — L2 자동 발송
    [93, inb(8)],
    [101, async () => loop.takeover(C[8], { by: B })],
    [109, async () => loop.humanReply(C[8], { by: B, body: '비밀번호 재설정 메일이 스팸함으로 분류되는 경우가 있습니다. 스팸함을 확인해 보시고, 그래도 없으면 이 메일로 회신해 주세요. 계정 상태를 직접 확인해 드리겠습니다.' })],
    [124, inb(3)],
    [128, inb('x7')], // 검토 중(L1) → 승인 대기
    [133, async () => {
      const d = db.get('SELECT original_body FROM drafts WHERE id=?', pendingOf(C.x7));
      await loop.approveDraft(pendingOf(C.x7), { by: A, finalBody: `검토해 주셔서 감사합니다. ${d.original_body}`, editTags: ['tone'] });
    }],
    [150, inb(11)], // 감사 인사 → 자동 종결
    [166, inb(14)],
    [181, inb(7)],
    [212, inb(18)],
    [230, async () => replyTo(C[2], '감사합니다. 확인했습니다.')],
    [236, async () => loop.closeCase(C[2], { by: A })],
    [251, inb(5)],
    [266, inb(17)],
    [282, async () => { // 섀도 — SHADOW_CHANNELS(설정은 좁히기만)로 이 한 건만 L0로 돌린다
      process.env.SHADOW_CHANNELS = 'support';
      try { C.shadow = (await inbound(inq('x1'))).caseId; } finally { delete process.env.SHADOW_CHANNELS; }
    }],
    [300, inb(12)],
    [318, async () => replyTo(C[4], '아직 답이 없네요. 언제쯤 처리되나요?')], // 넘김 뒤 재문의
    [329, async () => loop.addNote(C[4], { by: B, text: '결제 이력 확인 중 — 자동결제 일자와 사용 기록 대조 후 직접 회신 예정' })],
    [341, inb(20)],
    [357, inb(16)], // 견적 → 답장+넘김(승인 대기)
    [384, async () => replyTo(C[12], '도입 전에 팀원 교육 자료도 함께 받을 수 있을까요? 온보딩 순서가 궁금합니다.')], // 후속 질문도 L2 자동 발송
    [401, inb(15)],
    [423, mailDown(inb(19))], // 영어 구독 해지 — L2 자동 발송 실패 → 승인 대기(auto_send_failed)
    [435, inb('x8')], // 진행 거절(L1) → 사람이 그대로 승인
    [441, async () => loop.approveDraft(pendingOf(C.x8), { by: B })],
    [447, inb(1)],
  ];
  let at = 0;
  for (const [min, fn] of steps) { advance(min - at); at = min; await fn(); }
  advance(4);
  return C;
}

async function main() {
  db.init(':memory:');
  llm.use('mock');
  const C = await scenario();

  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const get = async (p) => { const r = await http('GET', p); if (r.status !== 200) throw new Error(`GET ${p} → ${r.status}`); return r.body; };

  // ---- 1. 대시보드가 읽는 것 전부 스냅숏 ----
  const SNAP = new Date().toISOString();
  const snap = { health: await get('/api/health'), appStatus: await get('/api/status'), stats: await get('/api/stats'), policy: await get('/api/policy'), status: await get('/api/agent/status'), list: await get('/api/cases?limit=500') };
  const ids = db.all('SELECT id FROM cases ORDER BY rowid').map((r) => r.id);
  const details = [];
  for (const id of ids) details.push(await get(`/api/cases/${id}`));
  // CRM 화면: 상세를 먼저 읽고(그 케이스를 다시 동기화한다) 목록 → 그 뒤 문서 저장소를 그대로 스냅숏. 심은 이 문서를 직전 문서(prev)로 다시 투영한다.
  const crmDetails = [];
  for (const id of ids) crmDetails.push(await get(`/api/crm/cases/${id}`));
  snap.crmList = await get('/api/crm/cases?limit=500');
  const crmDocs = { cases: Object.fromEntries(ids.map((id) => [id, store.get('cases', id)])), contacts: {}, companies: {}, events: {} };
  for (const [k, c] of [['contacts', 'contacts'], ['companies', 'companies'], ['events', 'inbound_events']]) for (const doc of store.all(c)) crmDocs[k][doc.id] = doc;
  const rowids = Object.fromEntries(db.all('SELECT id, rowid r FROM messages ORDER BY rowid').map((m) => [m.id, m.r]));
  const kb = Object.fromEntries(snap.policy.map((p) => [p.channel, { ko: kbLoader.load(p.channel, 'ko'), en: kbLoader.load(p.channel, 'en') }]));
  const env = { MAIL_PROVIDER: 'mock', MAIL_MOCK_LOG: '0' };
  for (const k of ['COMPANY_NAME', 'AGENT_NAME']) if (process.env[k]) env[k] = process.env[k];

  // ---- 2. 앞으로 올 문의 녹화: 새 케이스 하나씩, 서버가 내는 SSE 이벤트 순서 그대로 ----
  const pool = [];
  for (const q of [...INQ, ...EXTRA]) {
    advance(0.5);
    const tag = `p${q.id}`;
    const t0 = new Date().toISOString();
    tape = [];
    const r = await inbound({ ...q, from: q.from.replace('@', `+${tag}@`) });
    const evs = tape; tape = null;
    const final = await get(`/api/cases/${r.caseId}`);
    const pack = policy.load(q.channel);
    pool.push({ kind: 'new', id: typeof q.id === 'number' ? `q${q.id}` : q.id, channel: q.channel, sig: protoSig({ ...q, body: cases.stripQuotes(q.body) }, pack, kbLoader.load(q.channel, 'ko'), prefilter, llmMock),
      caseId: r.caseId, t0, rowids: rowidsOf(r.caseId), orig: { subject: final.case.subject, body: q.body, name: final.case.customer_name, from: final.case.customer_email }, events: evs, final });
  }
  // 고객 회신 대기 케이스에 오는 후속 회신
  const FOLLOWUPS = [
    [C[3], '안내대로 했는데 해지 메뉴가 안 보여요. 구독 해지는 어디서 하나요?'],
    [C[13], '감사합니다. 도입 안내 자료도 받아볼 수 있을까요?'],
    [C[8], '안내대로 했는데 로그인이 여전히 안 됩니다.'],
  ];
  const followups = [];
  for (const [caseId, body] of FOLLOWUPS) {
    advance(0.5);
    const pre = db.get('SELECT state, responder FROM cases WHERE id=?', caseId);
    const t0 = new Date().toISOString();
    tape = [];
    await replyTo(caseId, body);
    const evs = tape; tape = null;
    followups.push({ kind: 'followup', caseId, pre: { ...pre }, t0, rowids: rowidsOf(caseId), events: evs, final: await get(`/api/cases/${caseId}`) });
  }
  // 접수 안내 초안 생성 이벤트는 심이 내는 모양(SENT)으로 싣는다
  for (const r of [...pool, ...followups]) for (const e of r.events) if (e.name === 'draft.created' && e.data.status === 'SENDING') e.data.status = 'SENT';

  const DATA = { env, rowids, health: snap.health, appStatus: snap.appStatus, policy: snap.policy, status: snap.status, kb, promotion: policy.PROMOTION, cases: details, crm: crmDocs, pool, followups, queue: QUEUE };

  // ---- 3. HTML ----
  const read = (p) => (CUTS[p] || []).reduce((s, [re, n]) => {
    const hits = (s.match(re) || []).length;
    if (hits !== n) throw new Error(`${p}에서 ${re}를 ${n}곳 기대했는데 ${hits}곳`);
    return s.replace(re, '');
  }, fs.readFileSync(path.join(ROOT, p), 'utf8'));
  const escJs = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  const mods = BUNDLE.map((m) => `${JSON.stringify(m)}: function (module, exports, require, process) {\n${read(`server/${m}.js`)}\n}`);
  mods.push(`"agents/common": function (module) { ${COMMON_STUB} }`);
  mods.push(`"mail/mock": function (module, exports, require) { ${MAIL_STUB} }`);
  const html = read('web/index.html');
  const bodyMarkup = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, html])[1].replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>\s*/gi, '').trim();
  const shim = `(function () {
'use strict';
const PROTO_MODS = {
${mods.join(',\n')}
};
const PROTO_SANITIZE = ${cases.sanitizeName.toString()};
${protoSig.toString()}
${protoCore.toString()}
${protoBrowser.toString()}
protoBrowser(document.getElementById('proto-data').textContent, ${JSON.stringify(SNAP)}, PROTO_MODS, protoCore, protoSig, PROTO_SANITIZE);
})();`;
  const appText = read('web/app.js');
  // CUTS가 문법을 깨지 않았는지 — 심 대조는 원본 모듈로 돌아 묶은 글을 보지 않는다
  for (const s of [shim, appText]) new (require('node:vm').Script)(s);
  const tail = `(function () {
  // 검토자 이름이 비어 있으면 데모 이름을 넣는다(승인·인수에 필요). 문서가 이미 다 읽힌 뒤 붙은 경우 init을 직접 부른다.
  const ready = () => { const r = document.getElementById('reviewer'); if (r && !r.value) r.value = '데모 검토자'; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else { if (typeof init === 'function') init(); ready(); }
})();`;
  // 배너는 그리드 밖(고정)에 둔다 — 앱 레이아웃의 행 번호가 바뀌어도 밀리지 않게. 좁은 화면(본문이 블록 흐름)에선 일반 흐름.
  const PROTO_CSS = `body { padding-top: 24px; }
.proto-banner { position: fixed; top: 0; left: 0; right: 0; z-index: 5; height: 24px; line-height: 24px; padding: 0 16px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  background: var(--surface-3); color: var(--text); border-bottom: 1px solid var(--border); font-size: 12px; }
@media (max-width: 900px) {
  body { padding-top: 0; }
  .proto-banner { position: static; height: auto; line-height: 1.45; padding: 4px 16px; white-space: normal; }
}`;
  const out = [
    '<title>CS 에이전트 백오피스</title>',
    `<style>\n${read('web/style.css')}\n</style>`,
    `<style>\n${PROTO_CSS}\n</style>`,
    '<div class="proto-banner" role="note">프로토타입 — 합성 데이터로 브라우저 안에서 재현합니다. 실제 메일은 나가지 않습니다.</div>',
    bodyMarkup,
    `<script type="application/json" id="proto-data">${JSON.stringify(DATA, hideKeys).replace(/</g, '\\u003c')}</script>`,
    `<script>\n${escJs(shim)}\n</script>`,
    `<script>\n${escJs(appText)}\n</script>`,
    `<script>\n${tail}\n</script>`,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  const kbSize = (Buffer.byteLength(out) / 1024).toFixed(0);
  console.log(`${path.relative(ROOT, OUT)}  ${kbSize} KB  (케이스 ${details.length} · 녹화 ${pool.length}+${followups.length})`);
  if (Buffer.byteLength(out) > 3 * 1024 * 1024) { console.error('3 MB 초과'); process.exitCode = 1; }

  // ---- 4. 대조: 심 vs 실제 서버 ----
  const { problems, checked } = await verify({ DATA: JSON.parse(JSON.stringify({ ...DATA, cases: details }, hideKeys)), snap, details, crmDetails, C, http });
  server.close();
  if (problems.length) { console.error(`심 대조 불일치 ${problems.length}건:\n${problems.join('\n')}`); process.exitCode = 1; }
  else console.log(`심 대조: 조회(목록·통계·상세 전부, CRM 목록·상세 전부) + 사람 행동 ${checked}가지(처리 상세·CRM 상세) 실제 서버와 일치`);

  // ---- 5. 금지어: 디스크에 쓴 결과를 다시 읽어 본다. 남았으면 파일을 지우고 실패 ----
  const written = fs.readFileSync(OUT, 'utf8');
  const leaks = FORBIDDEN.map((re) => [re, (written.match(new RegExp(re.source, `${re.flags}g`)) || []).length]).filter(([, n]) => n);
  if (leaks.length) { fs.rmSync(OUT); console.error(`금지어 남음(결과 파일 지움): ${leaks.map(([re, n]) => `${re} ${n}곳`).join(', ')}`); process.exit(1); }
  console.log(`금지어 검사: ${FORBIDDEN.length}개 패턴 0곳`);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
function norm(v) {
  const ids = new Map();
  return JSON.stringify(sortKeys(v), hideKeys).replace(UUID_RE, (u) => { if (!ids.has(u)) ids.set(u, `U${ids.size}`); return ids.get(u); })
    .replace(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g, '"T"').replace(/"(latency_ms|latencyMs|llmMs|toolMs)":\d+/g, '"$1":0');
}
function diff(label, a, b) {
  if (a === b) return null;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return `  ${label}: 서버 …${a.slice(Math.max(0, i - 60), i + 80)}…\n  ${' '.repeat(label.length)}  심   …${b.slice(Math.max(0, i - 60), i + 80)}…`;
}

/** CRM 상세 비교용 — revision은 서버 flush 시점에 따라 달라진다. 발송 활동과 담당 변경이 서로 다른 시계 읽기라
 * ms가 갈리면 audit.updatedBy와 이력의 changedBy·reason이 서버·심에서 따로 뒤집힌다 → updatedBy를 빼고 이력은 마지막 항목의 상태만.
 * 대화 칸은 같은 ms 안 행의 순서가 서버·심 시계에 따라 달라져 시각을 지운 내용으로 정렬해 비교한다. */
function crmNorm(x) {
  if (!x || !x.case) return norm(x);
  const h = x.case.statusHistory || []; const l = h[h.length - 1] || {};
  return norm({ ...x, revision: 0, case: { ...x.case, audit: { ...x.case.audit, updatedBy: undefined }, statusHistory: [{ toStatus: l.toStatus, toSubStatus: l.toSubStatus }] },
    timeline: x.timeline.map((t) => norm(t)).sort() });
}

async function verify({ DATA, snap, details, crmDetails, C, http }) {
  const problems = [];
  const nodeReq = (n) => require(path.join(SERVER, n));
  const noHooks = { emit() {}, stagger() {}, inbound() { throw new Error('n/a'); } };
  // 조회: 바이트 단위로 같아야 한다
  const v = protoCore(DATA, nodeReq, noHooks);
  const eq = (label, server, shim) => { const p = diff(label, JSON.stringify(server, hideKeys), JSON.stringify(shim, hideKeys)); if (p) problems.push(p); };
  eq('GET /api/cases', snap.list, v.listCases({ limit: '500' }));
  eq('GET /api/stats', snap.stats, v.stats());
  for (const d of details) eq(`GET /api/cases/${d.case.id.slice(0, 8)}`, d, v.getCase(d.case.id));
  eq('GET /api/crm/cases', snap.crmList, v.crmList({ limit: '500' }));
  for (const d of crmDetails) eq(`GET /api/crm/cases/${d.case.id.slice(0, 8)}`, d, v.crmDetail(d.case.id));

  // 사람 행동: 같은 요청을 실제 서버와 심에 보내고 응답·상세를 비교(id·시각은 정규화)
  const p = protoCore(DATA, nodeReq, noHooks);
  const det = (id) => details.find((d) => d.case.id === id);
  const pend = (id) => det(id).drafts.find((d) => d.status === 'PENDING');
  const by = REVIEWERS[0];
  const actions = [
    ['승인', C[15], `/api/drafts/${pend(C[15]).id}/approve`, { by }],
    ['두 번째 승인 → 409', C[15], `/api/drafts/${pend(C[15]).id}/approve`, { by }],
    ['by 없음 → 400', C[16], `/api/drafts/${pend(C[16]).id}/approve`, {}],
    ['guard 422', C[16], `/api/drafts/${pend(C[16]).id}/approve`, { by, finalBody: '50,000원 환불해 드리겠습니다' }],
    ['수정 후 승인(답장+넘김)', C[16], `/api/drafts/${pend(C[16]).id}/approve`, { by, finalBody: `${pend(C[16]).original_body}\n\n추가로 궁금하신 점은 이 메일로 회신해 주세요.`, editTags: ['missing'] }],
    ['에이전트 담당 반환 → 409', C[19], `/api/cases/${C[19]}/return`, { by }],
    ['폐기(자동 발송 실패분)', C[19], `/api/drafts/${pend(C[19]).id}/discard`, { by }],
    ['반환(L2 자동 발송)', C[19], `/api/cases/${C[19]}/return`, { by }],
    ['인수', C[12], `/api/cases/${C[12]}/takeover`, { by }], // FOLLOWUPS(C[3]·C[13]·C[8])는 녹화 때 서버에서 더 진행됐다 — 대조 대상에서 뺀다
    ['직접 답장', C[4], `/api/cases/${C[4]}/human-reply`, { by, body: '확인해 보니 사용 기록이 없어 결제 건을 취소 처리했습니다.' }],
    ['반환(재판단, 접수 안내 이미 있음)', C[5], `/api/cases/${C[5]}/return`, { by }],
    ['반환(재판단, 접수 안내 다시)', C[6], `/api/cases/${C[6]}/return`, { by }],
    ['종결 사유 없음 → 400', C[17], `/api/cases/${C[17]}/close`, { by }],
    ['종결', C[17], `/api/cases/${C[17]}/close`, { by, reason: 'resolved' }],
    ['재오픈 → 404', C[2], `/api/cases/${C[2]}/reopen`, { by }],
    ['메모', C[7], `/api/cases/${C[7]}/note`, { by, text: '법무팀 공유 완료' }],
    ['보류', C[7], `/api/cases/${C[7]}/hold`, { by, note: '법무 검토 회신 대기' }],
    ['에이전트 케이스 보류 → 409', C[15], `/api/cases/${C[15]}/hold`, { by, note: '확인 대기' }],
    ['보류 해제', C[7], `/api/cases/${C[7]}/unhold`, { by }],
    ['섀도 평가', C.shadow, `/api/drafts/${det(C.shadow).drafts.find((d) => d.status === 'SHADOW').id}/rate`, { by, rating: 'good' }],
  ];
  for (const [label, caseId, url, body] of actions) {
    try {
      const real = await http('POST', url, body);
      const sim = await p.handle('POST', url, clone(body));
      const a = diff(`${label} 응답`, norm(real), norm(sim)); if (a) problems.push(a);
      const b = diff(`${label} 상세`, norm((await http('GET', `/api/cases/${caseId}`)).body), norm(p.getCase(caseId))); if (b) problems.push(b);
      const c = diff(`${label} CRM 상세`, crmNorm((await http('GET', `/api/crm/cases/${caseId}`)).body), crmNorm(p.crmDetail(caseId))); if (c) problems.push(c);
    } catch (e) { problems.push(`  ${label}: 예외 ${e.stack}`); }
  }
  return { problems, checked: actions.length };
}

main().catch((e) => { console.error(e); process.exit(1); });
