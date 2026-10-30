'use strict';
// CS Agent 백오피스 — 바닐라 JS, 빌드 없음. API 계약: docs/spec.md §5·§5.1
// 모든 서버 문자열은 DOM 노드(textContent)로만 넣는다. innerHTML에 데이터 삽입 금지.

// ---------- 상수 ----------
const STATES = ['OPEN', 'AGENT_ACTIVE', 'AWAITING_APPROVAL', 'WAITING_CUSTOMER', 'HANDED_OFF', 'CLOSED'];
const STATE_LABEL = {
  OPEN: '신규', AGENT_ACTIVE: '에이전트 처리 중', AWAITING_APPROVAL: '승인 대기',
  WAITING_CUSTOMER: '고객 회신 대기', HANDED_OFF: '사람 전담', CLOSED: '종결',
};
const DRAFT_LABEL = {
  PENDING: '승인 대기', SENDING: '발송 중', SENT: '발송됨', STALE: '낡음(고객 재회신)',
  DISCARDED: '폐기', NOT_SELECTED: '미선택(사람 전담)', SUPERSEDED: '대체됨', SHADOW: '섀도(기록만)',
};
// 미선택 초안: 초안 뒤 처음 나온 이 활동이 그 이유다(없으면 DRAFT_LABEL의 중립 문구).
const NOT_SELECTED_BY = { human_reply: '미선택(사람이 답함)', takeover: '미선택(사람이 인수)', close: '미선택(종결)', auto_close: '미선택(종결)' };
const EDIT_TAGS = [['fact', '사실오류'], ['tone', '어조'], ['missing', '누락'], ['excess', '과잉'], ['policy', '정책'], ['critical', '치명 오류']];
const STEP_LABEL = {
  prefilter: '1차 거르기', triage: '분류', gate1: '판단 1', respond: '작성',
  guard: '검사', review: '검수', gate2: '판단 2', execute: '실행', brief: '브리핑', error: '오류', rewrite: '재작성',
};
// 판단 기록에 나오는 코드(행동·사유·규칙)를 사람 말로. 모르는 코드는 그대로 보인다.
const LABELS = {
  action: {
    IGNORE: '무시', HANDOFF: '사람에게 넘김', COMPOSE: '작성으로', DRAFT: '승인 대기 초안', ANSWER_AND_HANDOFF: '답장 + 넘김', SHADOW: '섀도(기록만)',
    REWRITE: '재작성', PASS: '통과', FAIL: '실패', CLASSIFIED: '분류됨', CARRY_OVER: '이전 답 다시 올림', ABORTED: '중단(상황 바뀜)',
    RETRY: '재시도 예약', HUMAN_REPLY: '사람 답장', SENT: '발송됨', ACK: '접수 안내(자동)', AUTO_SEND: '자동 발송(L2)',
  },
  reason: {
    refund_request: '환불 요청', billing_dispute: '결제 분쟁', data_export: '데이터 반출', complaint: '불만·항의', legal_threat: '법적 언급',
    human_request: '사람 연결 요청', call_meeting: '통화·미팅 요청', contract_documents: '계약 서류', purchase_intent: '진행 의사', price_contract: '금액·계약 조건',
    list_request: '명단 요청', pricing: '요금 문의', policy_exception: '정책 예외', account_identity: '본인 확인 필요', injection: '지시 변경 시도',
    custom_data: '맞춤 데이터 요청', custom_quote: '맞춤 견적', pricing_exception: '요금 예외', access_grant: '권한·라이선스 부여', trial_access: '체험 권한',
    out_of_knowledge: 'KB에 없음', low_confidence: '확신 낮음', no_progress: '같은 질문 반복', round_limit: '왕복 한도', guard_failed: '검사 실패',
    llm_error: 'LLM 장애', internal_error: '내부 오류', unclear: '뜻 불분명', sender_changed: '보낸 사람 바뀜', language_unsupported: '지원 안 하는 언어',
    discarded: '초안 폐기', auto_reply_or_empty: '자동 회신·빈 메일', internal_sender: '사내 발신', responder_human: '사람이 맡은 케이스',
    case_changed: '회차 중 상황 바뀜', shadow: '섀도 채널', ack: '감사·확인 인사', ignore: '무시 대상', answer_and_handoff: '답장 + 넘김',
    ignored_first_message: '첫 메시지 무시', inactive: '장기 무응답', already_answered: '다른 답장이 먼저 나감', newer_inbound: '더 새 고객 메시지',
    // guard·검수 위반 코드
    amount: '금액 언급', contact: '연락처 노출', date_promise: '날짜 약속', date: '날짜 언급', emoji: '이모지', empty: '빈 본문', forbidden_word: '금지어',
    link_not_in_kb: 'KB에 없는 링크', too_long: '너무 김', unknown_fact: '근거 없는 사실', unresolved_slot: '자리표시 남음', not_answered: '질문에 답 안 함',
    no_fact: '근거 절 표시 없음', fact_off_intent: '문의 유형 밖 근거',
  },
  // 문의 유형 — policy/*.json의 intent 전부(server/labels.js와 같은 표)
  intent: {
    account_deletion: '계정 탈퇴', receipt: '영수증', cancel_subscription: '구독 해지', feature_howto: '기능 사용법', login_issue: '로그인 문제',
    refund: '환불', billing_dispute: '결제 분쟁', data_export: '데이터 반출', pricing_exception: '요금 예외', access_grant: '권한·라이선스 부여',
    custom_data: '맞춤 데이터 요청', complaint: '불만·항의', legal: '법적 언급', human_request: '사람 연결 요청', unclear: '뜻 불분명',
    injection: '지시 변경 시도', ack: '감사·확인 인사', ignore: '무시 대상', onboarding_request: '온보딩 요청', meeting_request: '미팅 요청',
    pricing_question: '요금 문의', trial_access: '체험 권한', service_question: '서비스 문의', material_request: '자료 요청', quote_request: '견적 요청',
    reviewing: '검토 중', declined: '진행 거절', purchase_intent: '진행 의사', price_negotiation: '가격 협상', custom_quote: '맞춤 견적',
    list_request: '명단 요청', contract_documents: '계약 서류',
  },
  rule: {
    1: '감사·자동 회신은 무시', 2: '사람 전용 신호(H 등급·위험 신호·답할 수 없는 사유·미지원 언어)', 3: '같은 질문 반복', 4: '확신도 기준 미달', 5: '왕복 한도',
    6: '채널에 없는 문의 유형', 7: 'KB에 답이 없음', 8: '답장 작성으로', 9: '검사 실패', 10: '섀도 채널(기록만)', 11: '답하고 일부는 사람에게', 12: '승인 대기 초안',
  },
};
// guard 판단 사유는 "forbidden_word,date_promise"처럼 쉼표로 이어져 온다.
const label = (kind, code) => (code == null ? '' : String(code).split(',').map((k) => LABELS[kind][k] || k).join(', '));
const AGENT_LABEL = { triage: 'Triage', responder: 'Responder', reviewer: 'Reviewer', briefer: 'Briefer' };
const LOOP_LABEL = { IDLE: '대기', RUNNING: '처리 중', HANDED_OFF: '사람에게 넘김' };
// 유형 칩 — 한국어 이름, 마우스를 올리면 코드
const intentChip = (code) => (code ? h('span', { class: 'chip', text: label('intent', code), title: code }) : null);
const ACTIVITY_LABEL = {
  approve: '승인', edit_approve: '수정 후 승인', discard: '폐기', takeover: '인수', return: '반환',
  close: '종결', reopen: '재오픈', note: '메모', human_reply: '직접 답장',
  shadow_rating: '섀도 평가', auto_close: '자동 종결', send_unconfirmed: '발송 확인 필요', resolve_sending: '발송 확인 처리',
  auto_send: '자동 발송(L2)', auto_send_failed: '자동 발송 막힘', auto_ack: '접수 안내 자동 발송',
};
const RATING_LABEL = { good: '좋음', needs_edit: '수정 필요', critical: '치명 오류' };
const LIVE_MAX = 200;
const LIST_PAGE = 100, LIST_MAX = 500; // 서버 ?limit 상한 500 (server/cases.js listCases)

// ---------- 상태 ----------
const S = {
  cases: [], listError: null, selectedId: null, detail: null, detailError: null,
  filters: { state: '', channel: '', q: '', pendingOnly: false },
  policy: [], stats: null, health: null, agent: null, lastStepAt: 0,
  live: [], es: null, backoff: 1000, compose: null, // compose: 'note' | 'reply' | null
  draftEdit: {}, // draftId -> { body, tags:Set, error } — error: 마지막 승인 실패(재렌더에도 남는다)
  composeDraft: {}, // `${caseId}:${note|reply}` -> { text, error } — 보내기 전 메모·직접 답장(재렌더·케이스 전환에도 남는다)
  composing: false, renderDeferred: false, // 한글 IME 조합 중에는 상세를 다시 그리지 않는다(글자가 깨진다)
  inflight: new Set(), // 진행 중인 사람 행동 키 — 버튼을 잠가 두 번 누르지 않게
  limit: LIST_PAGE,
  flash: null, // { caseId, node, at } — 상세 상단 배너(재렌더에도 남는 오류 메시지)
  me: null, // 인증 헤더 모드면 서버가 알려 준 사용자
  seq: { list: 0, detail: 0 }, // 늦게 도착한 응답이 최신 화면을 덮지 않게
};

// ---------- DOM 헬퍼 ----------
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function replace(el, ...children) { clear(el); el.append(...children.flat(Infinity).filter(Boolean)); }

// ---------- 유틸 ----------
function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 45) return '방금 전';
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}일 전`;
  return new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}
function fmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function clock(iso) {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function shortId(id) { return String(id || '').slice(0, 8); }
function parseJson(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
function pretty(v) {
  const o = parseJson(v, undefined);
  if (o === undefined) return String(v ?? '');
  try { return JSON.stringify(o, null, 2); } catch { return String(v); }
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function packOf(channel) { return S.policy.find((p) => p.channel === channel) || null; }
function channelLabel(channel) { return packOf(channel)?.label || channel || '-'; }
function stateChip(state) { return h('span', { class: `chip st-${state}`, text: STATE_LABEL[state] || state || '-' }); }
function channelBadge(channel) { return h('span', { class: `badge ch-${channel}`, text: channelLabel(channel) }); }
// L2 자동 발송으로 갈 초안(auto)은 승인 대기가 아니다 — 판단 2·실행 행을 "자동 발송(L2)"으로 보인다
const autoOf = (r) => !!(r?.output?.autoSend ?? r?.output?.inputs?.autoSend);
function actionTag(action, auto) {
  if (!action) return null;
  const a = auto && action === 'DRAFT' ? 'AUTO_SEND' : action;
  return h('span', { class: `act act-${a}`, text: label('action', a), title: action });
}
function responderChip(c) {
  const human = c.responder === 'human';
  return h('span', { class: `chip resp-${human ? 'human' : 'agent'}` }, human ? `사람${c.assignee ? ` · ${c.assignee}` : ''}` : '에이전트');
}
function reviewer() { return S.me || ($('#reviewer').value || '').trim(); }

// ---------- API ----------
async function api(path, opts = {}) {
  // 사람 행동은 누가 했는지 남아야 한다 — 검토자 이름 없이는 보내지 않는다.
  if (opts.body && Object.prototype.hasOwnProperty.call(opts.body, 'by') && !opts.body.by) {
    $('#reviewer').focus();
    throw Object.assign(new Error('검토자 이름을 입력하세요'), { local: true });
  }
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(path, init);
  if (res.status === 401) $('#auth-banner').hidden = false; // 프록시 밖에서 열었다 — 새로고침 전까지 남긴다
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body });

// ---------- 로더 ----------
async function loadHealth() {
  try { S.health = await api('/api/health'); } catch { S.health = null; }
  if (S.health && S.health.auth === 'header') {
    try { S.me = (await api('/api/me')).user || null; } catch { S.me = null; }
  }
  renderHealth();
}
async function loadStats() {
  try { S.stats = await api('/api/stats'); } catch { /* keep last */ }
  renderStats();
}
function renderStats() { renderKpis(); renderPromotion(); renderStateFilters(); renderListCount(); }
async function loadAgent() {
  try { S.agent = await api('/api/agent/status'); } catch { S.agent = null; }
  renderAgentPill();
}
async function loadPolicy() {
  try {
    const p = await api('/api/policy');
    S.policy = Array.isArray(p) ? p : Object.values(p || {});
  } catch { S.policy = []; }
  renderChannelFilters();
  renderInjectChannels();
}
async function loadCases() {
  const seq = ++S.seq.list;
  const f = S.filters;
  const qs = new URLSearchParams();
  if (f.pendingOnly) qs.set('state', 'AWAITING_APPROVAL');
  else if (f.state) qs.set('state', f.state);
  if (f.channel) qs.set('channel', f.channel);
  if (f.q) qs.set('q', f.q);
  qs.set('limit', String(S.limit));
  let cs = []; let err = null;
  try { const r = await api(`/api/cases?${qs}`); cs = Array.isArray(r) ? r : (r && (r.cases || r.items)) || []; } catch (e) { err = humanError(e); }
  if (seq !== S.seq.list) return; // 그 사이 필터가 바뀌었거나 새 요청이 나갔다
  S.cases = cs; S.listError = err;
  renderList();
}
async function loadDetail(id) {
  if (!id) { S.detail = null; renderDetail(); return; }
  const seq = ++S.seq.detail;
  let d = null; let err = null;
  try { d = await api(`/api/cases/${encodeURIComponent(id)}`); } catch (e) { err = humanError(e); }
  // 다른 케이스를 고른 뒤 도착한 응답·더 늦게 보낸 요청보다 먼저 도착한 응답은 버린다 — 엉뚱한 케이스에 메모·답장이 가지 않게.
  if (S.selectedId !== id || seq !== S.seq.detail) return;
  S.detail = d; S.detailError = err;
  renderDetail();
}
const refreshList = debounce(loadCases, 250);
const refreshDetail = debounce(() => loadDetail(S.selectedId), 250);

function selectCase(id) {
  if (S.selectedId === id) return;
  S.selectedId = id; S.detail = null; S.detailError = null; S.compose = null; S.flash = null;
  renderList();
  renderDetail();
  loadDetail(id);
}

// ---------- 렌더: 상단 ----------
function renderHealth() {
  const hlt = S.health;
  $('#brand-name').textContent = (hlt && (hlt.company || hlt.companyName)) || 'CS Agent';
  const mock = hlt && hlt.provider && hlt.provider.mail === 'mock';
  const banner = $('#mail-banner');
  banner.hidden = !mock;
  banner.textContent = mock ? `메일 발송이 mock입니다 — 승인해도 고객에게 실제로 나가지 않습니다${hlt.mailWarning ? ` (${hlt.mailWarning})` : ''}` : '';
  $('#btn-inject').hidden = !!hlt && hlt.testInject === false;
  const rv = $('#reviewer');
  if (S.me) { rv.value = S.me; rv.readOnly = true; rv.title = '로그인 사용자(프록시 인증)'; }
  const badges = $('#provider-badges');
  if (!hlt) { replace(badges, h('span', { class: 'badge', text: '서버 연결 안 됨' })); return; }
  const prov = hlt.provider || {};
  replace(badges,
    h('span', { class: 'badge', title: 'LLM provider', text: `llm:${prov.llm || '?'}` }),
    h('span', { class: 'badge', title: 'mail provider', text: `mail:${prov.mail || '?'}` }),
    hlt.version ? h('span', { class: 'badge', text: `v${hlt.version}` }) : null);
}
function renderKpis() {
  const s = S.stats || {};
  const ok = Number(s.approvedNoEdit || 0), ed = Number(s.approvedEdited || 0);
  const rate = (ok + ed) ? `${Math.round((ok / (ok + ed)) * 100)}%` : '–';
  const val = (v) => (v == null ? '–' : String(v));
  const fr = s.firstResponse || {};
  const tiles = [
    ['미종결', val(s.unresolved), { onclick: () => setStateFilter(''), title: '종결되지 않은 케이스 전부' }],
    ['승인 대기', val(s.awaitingApproval), { warn: true, active: S.filters.pendingOnly, onclick: () => togglePendingOnly() }],
    ['사람 전담', val(s.handedOff), { onclick: () => setStateFilter('HANDED_OFF') }],
    ['고객 회신 대기', val(s.waitingCustomer), { onclick: () => setStateFilter('WAITING_CUSTOMER') }],
    ['오늘 인입', val(s.todayInbound)],
    ['무수정 승인률', rate, { title: `무수정 ${ok} · 수정 ${ed}` }],
    // 1차 응대(케이스 단위) — 완전 자동응대 · 사람에게 넘김(접수 안내·초안 포함) · 응대 못함
    ['1차 응대율', fr.rate == null ? '–' : `${Math.round(fr.rate * 100)}%`, { title: `응대 필요 ${val(fr.base)}건 중 에이전트가 답·접수 안내·초안을 낸 비율` }],
    ['완전 자동응대', val(fr.auto), { title: '승인 없이 자동 발송(L2)되고 사람 손이 가지 않은 케이스' }],
    ['넘김(요약·접수 안내)', val(fr.handedOff), { title: '에이전트가 접수 안내·답장+넘김·승인 대기 초안을 내고 사람에게 넘긴 케이스' }],
    ['응대 못함', val(fr.none), { warn: Number(fr.none) > 0, title: '에이전트가 보낸 답·접수 안내도, 승인 대기 초안도 없는 케이스(지시 변경 시도·법적 언급 등 접수 안내 제외 사유, 사람 직접 답장만 나간 케이스 포함)' }],
  ];
  replace($('#kpis'), tiles.map(([label, value, o = {}]) => h('button', {
    type: 'button',
    class: `kpi${o.warn ? ' warn' : ''}${o.onclick ? ' clickable' : ''}${o.active ? ' active' : ''}`,
    title: o.title || label, onclick: o.onclick, disabled: !o.onclick,
  }, h('span', { class: 'kpi-value', text: value }), h('span', { class: 'kpi-label', text: label }))));
}
function renderAgentPill() {
  const pill = $('#agent-pill'), txt = $('#agent-pill-text');
  const a = S.agent;
  const recent = Date.now() - S.lastStepAt < 4000;
  pill.classList.remove('running', 'offline');
  pill.classList.remove('degraded');
  if (!a && !recent) { pill.classList.add('offline'); txt.textContent = '에이전트 상태 알 수 없음'; return; }
  const running = recent || (a && a.running);
  const depth = a && a.queueDepth != null ? ` · 큐 ${a.queueDepth}` : '';
  const retry = a && a.retriesPending ? ` · 재시도 대기 ${a.retriesPending}` : '';
  if (a && a.llm && a.llm !== 'ok') { pill.classList.add('degraded'); txt.textContent = `${a.llm === 'open' ? 'LLM 차단 중(장애)' : 'LLM 불안정'}${retry}${depth}`; }
  else if (running) { pill.classList.add('running'); txt.textContent = `에이전트 동작 중${depth}${retry}`; }
  else { txt.textContent = `대기 중${depth}${retry}${a && a.lastCycleAt ? ` · 마지막 ${relTime(a.lastCycleAt)}` : ''}`; }
  pill.title = a ? `오늘 ${a.cyclesToday ?? '-'}회전 · provider ${a.provider ? JSON.stringify(a.provider) : '-'}` : '';
}

// ---------- 렌더: 필터 ----------
function setStateFilter(state) { S.filters.state = state; S.filters.pendingOnly = false; renderStateFilters(); renderKpis(); loadCases(); }
function togglePendingOnly() { S.filters.pendingOnly = !S.filters.pendingOnly; if (S.filters.pendingOnly) S.filters.state = ''; renderStateFilters(); renderKpis(); loadCases(); }
function setChannelFilter(ch) { S.filters.channel = ch; renderChannelFilters(); renderStateFilters(); loadCases(); }
/** 상태(빈 값 = 전체)·채널별 케이스 수 — /api/stats의 byChannel에서 센다. 목록 limit와 무관하다. */
function countFor(state, channel) {
  let n = 0;
  for (const [ch, m] of Object.entries((S.stats && S.stats.byChannel) || {})) if (!channel || ch === channel) n += Number((state ? m[state] : m.total) || 0);
  return n;
}
function renderStateFilters() {
  const btn = (label, state, active) => h('button', { type: 'button', class: `filter-btn${active ? ' active' : ''}`, onclick: () => setStateFilter(state) },
    label, S.stats ? h('span', { class: 'count', text: countFor(state, S.filters.channel) }) : null);
  replace($('#state-filters'), btn('전체', '', !S.filters.state && !S.filters.pendingOnly), STATES.map((s) => btn(STATE_LABEL[s], s, S.filters.state === s && !S.filters.pendingOnly)));
  $('#quick-pending').classList.toggle('active', S.filters.pendingOnly);
}
function renderChannelFilters() {
  const btn = (text, ch) => h('button', { type: 'button', class: `filter-btn${S.filters.channel === ch ? ' active' : ''}`, onclick: () => setChannelFilter(ch) }, text);
  replace($('#channel-filters'), btn('전체', ''), S.policy.map((p) => btn(h('span', {}, p.label || p.channel,
    h('span', { class: 'count', text: ` ${p.shadow ? 'L0 섀도' : p.maxLevel || ''}` })), p.channel)));
  renderPromotion();
}
/** 채널별 승격 지표(L0→L1): 검토 수 / 무수정 비율 / 치명 오류 — 기준은 서버 상수. */
function renderPromotion() {
  const box = $('#promotion');
  const pr = (S.stats && S.stats.promotion) || {};
  if (!S.policy.length) { replace(box); return; }
  replace(box, S.policy.map((p) => {
    const m = pr[p.channel];
    if (!m) return null;
    const c = m.criteria || {};
    return h('div', { class: `promo${m.eligible ? ' ok' : ''}`, title: `기준: 검토 ${c.minReviewed}건 이상 · 무수정 ${Math.round((c.minNoEditRate || 0) * 100)}% 이상 · 치명 오류 ${c.maxCritical}건` },
      h('b', { text: p.label || p.channel }),
      h('span', { text: `검토 ${m.reviewed}${c.minReviewed ? `/${c.minReviewed}` : ''}` }),
      h('span', { text: `무수정 ${Math.round(m.approvedNoEditRate * 100)}%` }),
      h('span', { class: m.criticalCount ? 'bad' : '', text: `치명 ${m.criticalCount}` }),
      h('span', { class: 'promo-state', text: m.eligible ? '승격 가능' : '기준 미달' }));
  }));
}
function renderInjectChannels() {
  const sel = $('#inject-channel');
  replace(sel, (S.policy.length ? S.policy : [{ channel: 'support', label: 'support' }]).map((p) => h('option', { value: p.channel, text: `${p.label || p.channel} (${p.channel})` })));
}

// ---------- 렌더: 목록 ----------
/** 필터에 맞는 전체 건수 — 검색어가 있으면 stats로 셀 수 없어 null. */
function listTotal() {
  const f = S.filters;
  if (f.q || !S.stats) return null;
  return Math.max(countFor(f.pendingOnly ? 'AWAITING_APPROVAL' : f.state, f.channel), S.cases.length); // stats가 목록보다 늦게 올 수 있다
}
function renderListCount() {
  const f = S.filters;
  const scope = f.pendingOnly ? '승인 대기' : f.state ? STATE_LABEL[f.state] : '전체';
  const total = listTotal();
  $('#list-count').textContent = total == null ? `${scope} · ${S.cases.length}건` : `${scope} · ${total}건 중 ${S.cases.length}건 표시`;
}
function renderList() {
  const ul = $('#case-list');
  renderListCount();
  if (S.listError) { replace(ul, h('li', { class: 'error-box', text: `목록을 불러오지 못했습니다: ${S.listError}` })); return; }
  if (!S.cases.length) { replace(ul, h('li', { class: 'empty', text: '조건에 맞는 케이스가 없습니다' })); return; }
  const total = listTotal();
  const more = S.cases.length >= S.limit && S.limit < LIST_MAX && (total == null || total > S.cases.length);
  replace(ul, S.cases.map(caseRow), more ? h('li', { class: 'list-more' },
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { S.limit = Math.min(S.limit + LIST_PAGE, LIST_MAX); loadCases(); } }, '더 보기')) : null);
}
function caseRow(c) {
  const selected = c.id === S.selectedId;
  const reask = !!c.reaskedAfterHandoff;
  const same = Number(c.sameEmailOpenCases || 0);
  return h('li', {
    class: `case-row${selected ? ' selected' : ''}`, role: 'option', tabindex: '0', 'aria-selected': selected ? 'true' : 'false',
    dataset: { id: c.id }, onclick: () => selectCase(c.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCase(c.id); } },
  },
  h('div', { class: 'row-top' },
    channelBadge(c.channel),
    h('span', { class: 'row-name', text: c.customer_name || '(이름 없음)' }),
    h('span', { class: 'row-email', text: c.customer_email || '' }),
    h('span', { class: 'row-time', text: relTime(c.lastMessageAt || c.updated_at), title: c.lastMessageAt || c.updated_at || '' })),
  h('div', { class: 'row-subject', text: c.subject || '(제목 없음)' }),
  c.lastMessagePreview ? h('div', { class: 'row-preview', text: c.lastMessagePreview }) : null,
  h('div', { class: 'row-meta' },
    stateChip(c.state),
    h('span', { class: 'resp' }, c.responder === 'human' ? `사람${c.assignee ? ` · ${c.assignee}` : ''}` : '에이전트'),
    c.pendingDraftId ? h('span', { class: 'warn-text', title: '승인 대기 초안 있음' }, h('span', { class: 'pending-dot' }), ' 초안 대기') : null,
    reask ? h('span', { class: 'marker', text: '고객 재문의' }) : null,
    same > 0 ? h('span', { class: 'warn-text', text: `같은 주소 열린 케이스 ${same}` }) : null));
}

// ---------- 렌더: 상세 ----------
function renderDetail() {
  if (S.composing && $('#detail').contains(document.activeElement)) { S.renderDeferred = true; return; } // 포커스가 떠났으면 플래그가 남아도 그린다
  const root = $('#detail');
  if (!S.selectedId) { replace(root, h('div', { class: 'empty', text: '케이스를 선택하세요' })); return; }
  if (S.detailError) { replace(root, h('div', { class: 'error-box', text: `상세를 불러오지 못했습니다: ${S.detailError}` })); return; }
  if (!S.detail) { replace(root, h('div', { class: 'loading', text: '불러오는 중…' })); return; }
  const d = S.detail;
  const c = d.case || d;
  const messages = d.messages || [], drafts = d.drafts || [], decisions = d.decisions || [], handoffs = d.handoffs || [], activities = d.activities || [];
  const pending = drafts.filter((x) => x.status === 'PENDING');
  // 끝난 초안의 편집본·오류는 버린다(SENDING은 승인 실패 시 PENDING으로 돌아오니 남긴다)
  for (const x of drafts) if (x.status !== 'PENDING' && x.status !== 'SENDING') delete S.draftEdit[x.id];
  const sendCheck = drafts.filter((x) => x.needs_send_check);
  // 다시 그려도 입력 중인 칸의 포커스·커서를 되살린다(data-focus-key로 같은 칸을 찾는다)
  const active = document.activeElement;
  const focusKey = active && root.contains(active) ? active.dataset.focusKey : null;
  const caret = focusKey ? [active.selectionStart, active.selectionEnd, active.scrollTop] : null;
  // 상세 칸 전체가 한 번에 스크롤된다: 새 케이스거나 맨 아래를 보던 중이면 맨 아래(최신·승인 패널)로, 아니면 위치 유지
  const fresh = root.dataset.caseId !== c.id;
  const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
  replace(root,
    h('div', { class: 'detail-top' },
      detailHead(c, d.loop),
      S.flash && S.flash.caseId === c.id ? flashBanner() : null,
      sendCheck.map((dr) => sendCheckPanel(dr))),
    h('div', { class: 'detail-body' }, timeline(c, messages, drafts, decisions, handoffs, activities)),
    pending.length ? pending.map((dr) => approvalPanel(c, dr, messages)) : null,
    S.compose ? composePanel(c) : null);
  root.dataset.caseId = c.id;
  if (fresh || atBottom) root.scrollTop = root.scrollHeight;
  const el = focusKey && root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(caret[0], caret[1]); el.scrollTop = caret[2]; }
}

function detailHead(c, loop) {
  const closed = c.state === 'CLOSED';
  const human = c.responder === 'human';
  const kf = parseJson(c.known_facts, {}) || {};
  const act = (label, kind, fn, cls = '', disabled = false) => {
    const key = `${kind}:${c.id}`;
    return h('button', { type: 'button', class: `btn btn-sm ${cls}`, disabled: disabled || S.inflight.has(key), onclick: () => runAction(key, fn) }, label);
  };
  return h('div', { class: 'detail-head' },
    h('div', { class: 'detail-title' },
      channelBadge(c.channel),
      h('span', { class: 'name', text: c.customer_name || '(이름 없음)' }),
      h('span', { class: 'email', text: c.customer_email || '' }),
      stateChip(c.state), responderChip(c),
      h('span', { class: 'email', text: `#${shortId(c.id)}`, title: c.id })),
    h('div', { class: 'detail-subject', text: c.subject || '(제목 없음)' }),
    h('div', { class: 'detail-meta' },
      h('span', {}, `접수 ${fmtTime(c.created_at)}`),
      loop ? h('span', {}, `· 회차 ${loop.rounds ?? 0}`) : null,
      loop && loop.state ? h('span', {}, `· 루프 ${LOOP_LABEL[loop.state] || loop.state}`) : null,
      c.responder_change_reason ? h('span', { title: c.responder_change_reason, text: `· 응대 전환: ${label('reason', c.responder_change_reason)}${c.responder_changed_by && c.responder_changed_by !== 'agent' ? ` (${c.responder_changed_by})` : ''}` }) : null),
    Object.keys(kf).length ? h('div', { class: 'kf-row' }, Object.entries(kf).map(([k, v]) => h('span', { class: 'chip kf' }, h('b', { text: `${k}: ` }), String(v ?? '미기재')))) : null,
    h('div', { class: 'detail-actions' },
      !human ? act('인수', 'takeover', () => post(`/api/cases/${c.id}/takeover`, { by: reviewer() }), '', closed) : null,
      human ? act('반환 (에이전트에게)', 'return', () => post(`/api/cases/${c.id}/return`, { by: reviewer() }), '', closed) : null,
      !closed ? act('종결', 'close', () => post(`/api/cases/${c.id}/close`, { by: reviewer() }), 'btn-danger') : null,
      closed ? act('재오픈', 'reopen', () => post(`/api/cases/${c.id}/reopen`, { by: reviewer() })) : null,
      h('button', { type: 'button', class: `btn btn-sm${S.compose === 'note' ? ' btn-primary' : ''}`, onclick: () => toggleCompose('note') }, '메모'),
      h('button', { type: 'button', class: `btn btn-sm${S.compose === 'reply' ? ' btn-primary' : ''}`, disabled: closed, onclick: () => toggleCompose('reply') }, '직접 답장')));
}
function toggleCompose(mode) { S.compose = S.compose === mode ? null : mode; renderDetail(); if (S.compose) $('#compose-text')?.focus(); }
function composePanel(c) {
  const reply = S.compose === 'reply';
  const dk = `${c.id}:${S.compose}`;
  const draft = S.composeDraft[dk] || (S.composeDraft[dk] = { text: '', error: null });
  const ta = h('textarea', { id: 'compose-text', 'data-focus-key': 'compose', placeholder: reply ? '고객에게 실제로 발송됩니다(담당자 이름으로, AI 고지 없이). 보내면 이 케이스는 사람이 맡고 대기 중 초안은 미선택 처리됩니다.' : '내부 메모 (고객에게 가지 않습니다)' });
  ta.value = draft.text;
  ta.addEventListener('input', () => { draft.text = ta.value; });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: !draft.error, text: draft.error || '' });
  const key = `compose:${c.id}`;
  const btnSubmit = h('button', { type: 'button', class: `btn btn-sm ${reply ? 'btn-ok' : 'btn-primary'}`, disabled: S.inflight.has(key) }, reply ? '직접 답장 보내기' : '메모 저장');
  btnSubmit.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    if (S.inflight.has(key)) return;
    draft.error = null; S.inflight.add(key); renderDetail();
    try {
      if (reply) await post(`/api/cases/${c.id}/human-reply`, { by: reviewer(), body: text });
      else await post(`/api/cases/${c.id}/note`, { by: reviewer(), text });
      delete S.composeDraft[dk]; // 보낸 뒤에만 지운다
      S.compose = null;
      await afterAction();
    } catch (e) { draft.error = humanError(e); }
    finally { S.inflight.delete(key); renderDetail(); }
  });
  return h('div', { class: 'compose' },
    ta, err,
    h('div', { class: 'compose-actions' },
      h('span', { class: 'hint', text: reply ? `담당자 이름으로 발송: ${reviewer() || '(검토자 이름 필요)'}` : '메모는 활동 로그에 남습니다' }),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { S.compose = null; renderDetail(); } }, '취소'),
      btnSubmit));
}

function timeline(c, messages, drafts, decisions, handoffs, activities) {
  const items = [];
  for (const m of messages) items.push({ at: m.occurred_at, order: 1, node: messageBubble(m) });
  // 판단: 트리거 메시지별 묶음
  const sorted = [...decisions].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const groups = [];
  for (const dec of sorted) {
    const g = groups[groups.length - 1];
    if (g && g.key === (dec.message_id || '-') && !g.closed) g.rows.push(dec);
    else groups.push({ key: dec.message_id || '-', rows: [dec] });
    if (dec.step === 'execute') groups[groups.length - 1].closed = true;
  }
  for (const g of groups) items.push({ at: g.rows[0].created_at, order: 2, node: traceBlock(g.rows) });
  for (const hf of handoffs) items.push({ at: hf.created_at, order: 3, node: handoffCard(hf) });
  const ratings = {};
  for (const a of activities) if (a.type === 'shadow_rating') { const p = parseJson(a.payload, {}) || {}; if (p.draftId) ratings[p.draftId] = { ...p, by: a.actor }; }
  for (const dr of drafts) {
    if (dr.status === 'PENDING') continue;
    items.push({ at: dr.created_at, order: 4, node: dr.status === 'SHADOW' ? shadowCard(dr, ratings[dr.id]) : draftHistory(dr, activities) });
  }
  for (const a of activities) items.push({ at: a.created_at, order: 5, node: activityRow(a) });
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.order - b.order);
  if (!items.length) return h('div', { class: 'empty', text: '아직 기록이 없습니다' });
  return items.map((i) => i.node);
}
function messageBubble(m) {
  const out = m.direction === 'out';
  const who = out ? (m.sent_by === 'human' ? '사람 발신' : m.sent_by === 'ack' ? '에이전트 접수 안내' : '에이전트 발신') : '고객';
  return h('div', { class: `msg ${out ? 'out' : 'in'}${out && m.sent_by === 'human' ? ' by-human' : ''}` },
    h('div', { class: 'msg-head' }, h('b', { text: who }), h('span', { text: m.sender || '' }), h('span', { text: fmtTime(m.occurred_at), title: m.occurred_at })),
    m.subject && !out ? h('div', { class: 'msg-subject', text: m.subject }) : null,
    h('div', { text: m.body_clean || m.body || '' }));
}
/** 게이트 판단 한 줄 설명: "규칙 N — 설명 · 확신 0.92/0.8 · 회차 0/10 …" */
function gateText(r) {
  const o = parseJson(r.output, {}) || {};
  const i = o.inputs || {};
  const bits = [];
  if (i.intent) bits.push(`유형 ${label('intent', i.intent)}${i.level ? `(${i.level})` : ''}`);
  if (i.confidence != null) bits.push(`확신 ${i.confidence}/${i.confidenceMin}`);
  if (i.kbHit != null) bits.push(`KB ${i.kbHit === true ? '있음' : i.kbHit === 'partial' ? '일부' : '없음'}`);
  if (i.rounds != null) bits.push(`회차 ${i.rounds}/${i.maxRounds}`);
  if (i.repeatStreak) bits.push(`반복 ${i.repeatStreak}/${i.repeatLimit}`);
  if (i.riskSignals && i.riskSignals.length) bits.push(`위험 ${i.riskSignals.join(',')}`);
  if (i.language && i.language !== 'ko') bits.push(`언어 ${i.language}`);
  // L2 자동 발송으로 간 초안은 칩과 같게 "자동 발송(L2)"로 적는다 — "승인 대기 초안"으로 읽히면 모순
  const ruleText = autoOf({ output: o }) && r.action === 'DRAFT' ? label('action', 'AUTO_SEND') : label('rule', o.rule);
  const head = o.rule ? `규칙 ${o.rule} — ${ruleText}` : label('reason', r.reason);
  return `${head}${r.reason && o.rule ? ` (${label('reason', r.reason)})` : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}
function versionLink(kind, hash) {
  return hash ? h('button', { type: 'button', class: 'linkish', title: `${kind} 원본 보기`, onclick: (e) => { e.stopPropagation(); openVersion(hash, kind); } }, `${kind} ${hash}`) : null;
}
async function openVersion(hash, kind) {
  const dlg = $('#version-dialog');
  $('#version-title').textContent = `${kind} ${hash}`;
  $('#version-body').textContent = '불러오는 중…';
  dlg.showModal();
  try { const v = await api(`/api/versions/${encodeURIComponent(hash)}`); $('#version-title').textContent = `${v.kind} · ${hash}`; $('#version-body').textContent = v.content; }
  catch (e) { $('#version-body').textContent = `불러오지 못했습니다: ${humanError(e)}`; }
}
function traceBlock(rows) {
  const total = rows.reduce((s, r) => s + (Number(r.latency_ms) || 0), 0);
  const last = rows[rows.length - 1];
  const rowsEl = h('div', { class: 'trace-rows' });
  for (const r of rows) {
    const pre = h('pre', { hidden: true, text: pretty(r.output) });
    const gate = r.step === 'gate1' || r.step === 'gate2' || r.step === 'execute';
    const reasonText = gate ? gateText(r) : r.step === 'triage' ? `유형 ${r.reason ? label('intent', r.reason) : '-'}` : (r.reason ? label('reason', r.reason) : r.input_summary || '');
    const row = h('div', {
      class: 'trace-row', role: 'button', tabindex: '0', title: r.input_summary || '',
      onclick: () => { pre.hidden = !pre.hidden; }, onkeydown: (e) => { if (e.key === 'Enter') pre.hidden = !pre.hidden; },
    },
    h('span', { class: 't-step', text: STEP_LABEL[r.step] || r.step }),
    h('span', { class: 't-agent', text: r.agent ? (AGENT_LABEL[r.agent] || r.agent) : 'code' }),
    h('span', {}, actionTag(r.action, autoOf(r))),
    h('span', { class: 't-reason', text: reasonText }),
    h('span', { class: 't-lat', text: r.latency_ms != null ? `${r.latency_ms}ms` : '' }));
    rowsEl.append(row, pre);
  }
  // 프롬프트 버전은 에이전트마다 다르다 — 분류·작성 행에서 읽는다
  const pv = (step) => rows.find((r) => r.step === step && r.prompt_version)?.prompt_version;
  const kbv = rows.find((r) => r.kb_version)?.kb_version;
  const head = h('div', { class: 'trace-head', role: 'button', tabindex: '0', onclick: () => { rowsEl.hidden = !rowsEl.hidden; } },
    h('span', {}, h('b', { text: '에이전트 트레이스' }), ` · ${rows.length}단계 · ${total}ms `,
      versionLink('분류 prompt', pv('triage')), ' ', versionLink('작성 prompt', pv('respond')), ' ', versionLink('kb', kbv)),
    h('span', {}, actionTag(last && last.action, autoOf(last)), ' ', h('span', { text: fmtTime(rows[0].created_at) })));
  return h('div', { class: 'trace' }, head, rowsEl);
}
function handoffCard(hf) {
  const b = parseJson(hf.briefing, {}) || {};
  const facts = Array.isArray(b.knownFacts) ? b.knownFacts : (b.knownFacts ? [String(b.knownFacts)] : []);
  const reco = b.recommendedReply || '';
  const copyBtn = h('button', { type: 'button', class: 'btn btn-sm', disabled: !reco }, '추천 답안 복사');
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reco); copyBtn.textContent = '복사됨'; }
    catch { copyBtn.textContent = '복사 실패 (수동 선택)'; }
    setTimeout(() => { copyBtn.textContent = '추천 답안 복사'; }, 1500);
  });
  return h('div', { class: 'card handoff' },
    h('div', { class: 'card-title' }, '사람에게 넘김', h('span', { class: 'chip', text: label('reason', hf.reason) || '-', title: hf.reason || '' }), hf.assignee ? h('span', { class: 'chip resp-human', text: hf.assignee }) : null,
      hf.returned_at ? h('span', { class: 'chip', text: `반환됨 ${relTime(hf.returned_at)}` }) : null,
      h('span', { class: 'time', text: fmtTime(hf.created_at) })),
    h('dl', {},
      h('dt', { text: '요약' }), h('dd', { text: b.summary || '-' }),
      h('dt', { text: '고객 요청' }), h('dd', { text: b.request || '-' }),
      h('dt', { text: '알려진 사실' }), h('dd', {}, facts.length ? facts.map((f) => h('span', { class: 'chip kf', text: f })) : '-'),
      h('dt', { text: '추천 답안' }), h('dd', { class: 'reco', text: reco || '-' }),
      h('dt', { text: '다음 행동' }), h('dd', { text: b.nextAction || '-' })),
    h('div', { class: 'copy-row' }, copyBtn));
}
function draftLabel(dr, activities) {
  if (dr.status !== 'NOT_SELECTED') return DRAFT_LABEL[dr.status] || dr.status;
  const why = activities.find((a) => String(a.created_at) >= String(dr.created_at) && NOT_SELECTED_BY[a.type]);
  return why ? NOT_SELECTED_BY[why.type] : DRAFT_LABEL.NOT_SELECTED;
}
function draftHistory(dr, activities) {
  const tags = parseJson(dr.edit_tags, []) || [];
  return h('details', { class: 'card draft-hist' },
    h('summary', {},
      h('span', { class: `chip dr-${dr.status}`, text: draftLabel(dr, activities) }),
      h('span', { text: dr.action === 'HUMAN_REPLY' ? '사람 답장' : dr.action === 'ACK' ? '에이전트 접수 안내' : '에이전트 초안' }),
      intentChip(dr.intent),
      actionTag(dr.action, dr.approved_by === 'agent:auto'),
      dr.approved_by && dr.approved_by !== 'agent:auto' ? h('span', { class: 'chip resp-human', text: `${dr.approved_by}${dr.final_body ? ' · 수정 후 승인' : ' · 승인'}` }) : null,
      h('span', { class: 'time', style: 'margin-left:auto;color:var(--muted);font-size:12px', text: fmtTime(dr.sent_at || dr.approved_at || dr.created_at) })),
    h('div', { class: 'hist-label', text: '에이전트 원문' }),
    h('div', { class: 'hist-body', text: dr.original_body || '' }),
    dr.final_body && dr.final_body !== dr.original_body ? [
      h('div', { class: 'hist-label' }, '사람 수정본', tags.length ? ` · 사유: ${tags.map((t) => (EDIT_TAGS.find(([k]) => k === t) || [t, t])[1]).join(', ')}` : ''),
      h('div', { class: 'hist-body', text: dr.final_body })] : null,
    dr.error ? h('p', { class: 'form-error', text: `발송 오류: ${dr.error}` }) : null);
}
function shadowCard(dr, rating) {
  const err = h('p', { class: 'form-error', hidden: true });
  const rate = async (r) => {
    try { await post(`/api/drafts/${dr.id}/rate`, { by: reviewer(), rating: r }); await afterAction(); }
    catch (e) { err.textContent = humanError(e); err.hidden = false; }
  };
  return h('div', { class: 'card shadow-card' },
    h('div', { class: 'card-title' }, h('span', { class: 'chip dr-SHADOW', text: '섀도 초안' }), intentChip(dr.intent),
      h('span', { class: 'hint', text: '고객에게 나가지 않았습니다. 사람 답과 비교해 평가하세요.' }),
      h('span', { class: 'time', text: fmtTime(dr.created_at) })),
    h('div', { class: 'hist-body', text: dr.original_body || '' }),
    h('div', { class: 'rate-row' }, '평가:',
      Object.entries(RATING_LABEL).map(([k, t]) => h('button', { type: 'button', class: `btn btn-sm${rating && rating.rating === k ? ' btn-primary' : ''}${k === 'critical' ? ' btn-danger' : ''}`, onclick: () => rate(k) }, t)),
      rating ? h('span', { class: 'hint', text: `현재 ${RATING_LABEL[rating.rating] || rating.rating} · ${rating.by || ''}` }) : null),
    err);
}
function sendCheckPanel(dr) {
  const err = h('p', { class: 'form-error', hidden: true });
  const resolve = async (outcome) => {
    try { await post(`/api/drafts/${dr.id}/resolve-sending`, { by: reviewer(), outcome }); await afterAction(); }
    catch (e) { err.textContent = humanError(e); err.hidden = false; }
  };
  return h('section', { class: 'send-check', role: 'alert' },
    h('b', { text: '발송 확인 필요' }),
    h('span', { text: ` 승인된 메일이 발송 중 상태로 멈췄습니다(${fmtTime(dr.approved_at)}, ${dr.approved_by || '-'}). 메일함에서 실제로 나갔는지 확인하세요.` }),
    h('div', { class: 'approval-actions' },
      h('button', { type: 'button', class: 'btn btn-sm btn-ok', onclick: () => resolve('sent') }, '발송됨으로 처리'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => resolve('pending') }, '대기로 되돌리기')),
    err);
}
function activityRow(a) {
  const p = parseJson(a.payload, {}) || {};
  const text = p.text || (p.rating ? `${RATING_LABEL[p.rating] || p.rating}${p.note ? ` — ${p.note}` : ''}` : '') || (p.reason ? label('reason', p.reason) : '') || p.note || (p.outcome ? `결과: ${p.outcome === 'sent' ? '발송됨' : '대기로'}` : '');
  return h('div', { class: 'activity' },
    h('span', { text: clock(a.created_at), title: a.created_at }),
    h('b', { text: a.actor || '-' }),
    h('span', { text: ACTIVITY_LABEL[a.type] || a.type }),
    text ? h('span', { class: 'note-text', text }) : null);
}

// ---------- 승인 패널 ----------
function approvalPanel(c, dr, messages) {
  const edit = S.draftEdit[dr.id] || (S.draftEdit[dr.id] = { body: dr.original_body || '', tags: new Set(), error: null });
  const key = `draft:${dr.id}`;
  const trigger = messages.find((m) => m.id === dr.trigger_message_id);
  const facts = parseJson(dr.used_facts, []) || [];
  // 승인 실패(422 guard 등)는 edit.error에 남긴다 — guard 실패 뒤 서버가 보내는 draft.updated로 다시 그려도 사라지지 않게.
  const err = h('p', { class: 'form-error', role: 'alert', hidden: !edit.error }, edit.error ? approvalError(edit.error) : null);
  const ta = h('textarea', { 'aria-label': '초안 본문', spellcheck: 'false', 'data-focus-key': `draft:${dr.id}` });
  ta.value = edit.body;
  const btnApprove = h('button', { type: 'button', class: 'btn btn-sm btn-ok' }, '승인 (원문 그대로 발송)');
  const btnEdit = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, '수정 후 승인');
  const btnDiscard = h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, '폐기');
  const hint = h('span', { class: 'hint' });
  const sync = () => {
    const changed = ta.value !== (dr.original_body || '');
    const busy = S.inflight.has(key);
    btnApprove.disabled = busy || changed; btnEdit.disabled = busy || !changed; btnDiscard.disabled = busy;
    hint.textContent = changed ? '본문이 바뀌었습니다 — 수정 후 승인으로 발송됩니다' : `발송 시 인사·맺음·AI 고지는 서버 템플릿이 붙입니다 · 승인자 ${reviewer() || '(검토자 이름 필요)'}`;
  };
  ta.addEventListener('input', () => { edit.body = ta.value; sync(); });
  sync();
  const tagBoxes = h('div', { class: 'edit-tags' }, '수정 사유:', EDIT_TAGS.map(([k, label]) => {
    const cb = h('input', { type: 'checkbox', value: k });
    cb.checked = edit.tags.has(k);
    cb.addEventListener('change', () => { if (cb.checked) edit.tags.add(k); else edit.tags.delete(k); });
    return h('label', {}, cb, label);
  }));
  // 진행 중 표시는 S.inflight에 둔다 — 응답 전에 SSE로 다시 그려져도 버튼이 풀리지 않게.
  const send = async (action, body) => {
    if (S.inflight.has(key)) return;
    edit.error = null; S.inflight.add(key); renderDetail();
    try {
      await post(`/api/drafts/${dr.id}/${action}`, body);
      delete S.draftEdit[dr.id];
      await afterAction();
    } catch (e) {
      if (e.status === 409) { setFlash(c.id, approvalError(e)); await afterAction(); } // 초안 상태가 바뀌었을 수 있다 — 다시 읽고 배너로 알린다
      else edit.error = e; // 422 guard 등: 패널 유지, 본문 고쳐서 재시도
    } finally { S.inflight.delete(key); renderDetail(); }
  };
  btnApprove.addEventListener('click', () => send('approve', { by: reviewer() }));
  btnEdit.addEventListener('click', () => send('approve', { by: reviewer(), finalBody: ta.value, editTags: [...edit.tags] }));
  btnDiscard.addEventListener('click', () => send('discard', { by: reviewer() }));
  return h('section', { class: 'approval', 'aria-label': '승인 대기 초안' },
    h('div', { class: 'approval-head' },
      h('span', { class: 'chip dr-PENDING', text: '승인 대기 초안' }),
      intentChip(dr.intent),
      actionTag(dr.action),
      dr.action === 'ANSWER_AND_HANDOFF' ? h('span', { class: 'warn-text', text: '발송 후 사람 전담으로 전환됩니다' }) : null,
      h('span', { class: 'time', text: `초안 ${fmtTime(dr.created_at)}${trigger ? ` · 답하는 메시지 ${fmtTime(trigger.occurred_at)}` : ''}` })),
    trigger ? h('div', { class: 'facts', title: trigger.body_clean || trigger.body || '' }, '답하는 메시지:', h('span', { class: 'preview-text', text: (trigger.body_clean || trigger.body || '').replace(/\s+/g, ' ').slice(0, 160) })) : null,
    facts.length ? h('div', { class: 'facts' }, '근거(KB):', facts.map((f) => h('span', { class: 'chip fact', text: f }))) : h('div', { class: 'facts', text: '근거(KB): 없음 — 사실 주장이 있으면 확인하세요' }),
    dr.kbPassages && Object.keys(dr.kbPassages).length ? h('details', { class: 'kb-passages' }, h('summary', { text: '근거 KB 원문 보기' }),
      Object.entries(dr.kbPassages).map(([k, t]) => h('div', { class: 'kb-passage' }, h('b', { text: k }), h('div', { text: t })))) : null,
    ta,
    dr.preview ? h('details', { class: 'preview' }, h('summary', { text: '발송 미리보기(원문 기준 — 고친 본문은 승인 때 다시 검사)' }), h('pre', { text: dr.preview })) : null,
    tagBoxes, err,
    h('div', { class: 'approval-actions' }, btnApprove, btnEdit, btnDiscard, hint));
}
// 서버 오류 코드 → 사람 말. not_pending은 초안의 지금 상태(status)로 고른다.
const CONFLICT_TEXT = {
  stale: '고객이 새 메시지를 보냈습니다. 초안이 낡았습니다. 에이전트가 새 메시지를 다시 판단합니다.',
  responder_human: '사람이 이 케이스를 맡고 있어 에이전트 초안을 발송할 수 없습니다. 직접 답장을 쓰거나 반환하세요.',
  already_answered: '이 초안이 쓰이는 동안 다른 답장이 먼저 나갔습니다. 에이전트가 그 답장을 보고 다시 씁니다.',
  closed: '종결된 케이스라 발송하지 않았습니다.',
  sending: '발송 중인 메일이 있어 잠시 후 다시 시도하세요.',
  sending_in_progress: '발송 중입니다. 발송이 끝난 뒤 다시 시도하세요.',
  busy: '이미 처리 중입니다. 잠시 후 결과를 확인하세요.',
  not_handed_off: '이미 에이전트가 맡고 있습니다.',
  not_closed: '종결된 케이스가 아닙니다.',
};
const NOT_PENDING_TEXT = {
  STALE: '고객이 새 메시지를 보냈습니다. 초안이 낡았습니다. 에이전트가 새 메시지를 다시 판단합니다.',
  SENT: '이미 발송된 초안입니다 (다른 검토자가 먼저 승인했을 수 있습니다).',
  SENDING: '이 초안은 지금 발송 중입니다. 잠시 후 결과를 확인하세요.',
  DISCARDED: '이미 폐기된 초안입니다.',
  NOT_SELECTED: '사람이 이 케이스를 맡아 초안이 미선택 처리됐습니다. 직접 답장하거나 반환하세요.',
  SUPERSEDED: '더 새 초안으로 대체됐습니다.',
};
function approvalError(e) {
  if (e.status === 422) {
    const v = (e.data && (e.data.violations || e.data.reasons)) || [];
    const li = v.map((x) => (typeof x === 'string' ? label('reason', x) : `${label('reason', x.code || x.rule) || '위반'}${x.quote ? ` — "${x.quote}"` : ''}`));
    return h('span', {}, 'guard 검사에 걸렸습니다. 본문을 고친 뒤 다시 승인하세요.', li.length ? h('ul', {}, li.map((t) => h('li', { text: t }))) : null);
  }
  return h('span', { text: humanError(e) });
}
function humanError(e) {
  if (e.local) return e.message;
  const code = e.data && e.data.error;
  if (code === 'not_pending') return NOT_PENDING_TEXT[e.data.status] || '이미 처리된 초안입니다 (다른 검토자가 먼저 처리했을 수 있습니다).';
  if (CONFLICT_TEXT[code]) return CONFLICT_TEXT[code];
  if (e.status === 401) return '인증이 필요합니다 — 프록시를 통해 접속하세요';
  if (e.status === 422 && e.data && e.data.violations) return `검사에 걸렸습니다: ${e.data.violations.map((v) => `${label('reason', v.code)}${v.quote ? ` "${v.quote}"` : ''}`).join(', ')}`;
  if (e.status === 409) return `충돌: ${code || e.message}`;
  if (e.status === 404) return '대상을 찾을 수 없습니다 (이미 삭제·변경됨).';
  if (e.status >= 500) return `서버 오류 (${e.status}): ${e.message}`;
  if (!e.status) return '서버에 연결할 수 없습니다.';
  return e.message || '요청 실패';
}
async function runAction(key, fn) {
  if (S.inflight.has(key)) return;
  S.inflight.add(key); renderDetail(); // 응답 전까지 버튼을 잠근다
  try { await fn(); await afterAction(); }
  catch (e) { setFlash(S.selectedId, h('span', { text: humanError(e) })); }
  finally { S.inflight.delete(key); renderDetail(); }
}
function setFlash(caseId, node) {
  const at = Date.now();
  S.flash = { caseId, node, at };
  setTimeout(() => { if (S.flash && S.flash.at === at) { S.flash = null; if (S.selectedId === caseId) renderDetail(); } }, 10000);
}
function flashBanner() {
  return h('div', { class: 'form-error flash', role: 'alert' }, S.flash.node,
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { S.flash = null; renderDetail(); } }, '닫기'));
}
async function afterAction() {
  await Promise.all([loadDetail(S.selectedId), loadCases(), loadStats()]);
}

// ---------- SSE 라이브 ----------
function setSse(state) {
  const dot = $('#sse-dot'), txt = $('#sse-text');
  dot.className = `dot ${state}`;
  txt.textContent = state === 'open' ? '실시간 연결됨' : state === 'error' ? `연결 끊김 · ${Math.round(S.backoff / 1000)}초 후 재시도` : '연결 중';
}
function connectSSE() {
  if (S.es) { S.es.close(); S.es = null; }
  if (typeof EventSource === 'undefined') { setSse('error'); return; }
  setSse('connecting');
  const es = new EventSource('/api/events');
  S.es = es;
  es.onopen = () => { S.backoff = 1000; setSse('open'); };
  // 연결(재연결 포함) 직후 서버가 hello를 보낸다 — 끊긴 동안 놓친 변화를 다시 읽는다.
  es.addEventListener('hello', (e) => {
    const d = data(e);
    if (d.stats) { S.stats = d.stats; renderStats(); }
    if (d.status) { S.agent = d.status; renderAgentPill(); }
    loadCases();
    if (S.selectedId) loadDetail(S.selectedId);
  });
  es.onerror = () => {
    es.close(); if (S.es !== es) return;
    S.es = null; setSse('error');
    setTimeout(connectSSE, S.backoff);
    S.backoff = Math.min(S.backoff * 2, 30000);
  };
  const data = (e) => parseJson(e.data, {}) || {};
  es.addEventListener('agent.step', (e) => onAgentStep(data(e)));
  for (const name of ['case.updated', 'draft.created', 'draft.updated', 'handoff.created', 'message.created']) {
    es.addEventListener(name, (e) => onCaseEvent(name, data(e)));
  }
  es.addEventListener('stats.updated', (e) => { S.stats = data(e); renderStats(); });
}
function onAgentStep(ev) {
  S.lastStepAt = Date.now();
  renderAgentPill();
  S.live.unshift(ev);
  if (S.live.length > LIVE_MAX) S.live.length = LIVE_MAX;
  renderLive(ev);
  if (ev.caseId && ev.caseId === S.selectedId) refreshDetail();
  if (ev.step === 'execute' || ev.step === 'prefilter') refreshList();
}
function onCaseEvent(name, ev) {
  refreshList();
  if (ev.caseId && ev.caseId === S.selectedId) refreshDetail();
  if (name !== 'message.created') loadStats();
}
function liveRow(ev) {
  return h('li', { title: ev.reason || '' },
    h('span', { class: 'l-time', text: clock(ev.at) }),
    h('span', { class: 'l-case', role: 'button', tabindex: '0', text: shortId(ev.caseId), title: ev.caseId || '', onclick: () => ev.caseId && selectCase(ev.caseId) }),
    h('span', { class: 'l-step', text: STEP_LABEL[ev.step] || ev.step || '' }),
    h('span', { class: 'l-agent', text: ev.agent ? (AGENT_LABEL[ev.agent] || ev.agent) : 'code' }),
    h('span', { class: 'l-action' }, actionTag(ev.action, ev.auto), ev.latencyMs != null ? h('span', { class: 'l-agent', text: ` ${ev.latencyMs}ms` }) : null),
    h('span', { class: 'l-reason', text: ev.reason ? label(ev.step === 'triage' ? 'intent' : 'reason', ev.reason) : (ev.summary || '') }));
}
function renderLive(newEv) {
  const ol = $('#live-feed');
  $('#live-count').textContent = S.live.length ? `${S.live.length}건` : '';
  if (!S.live.length) { replace(ol, h('li', { class: 'live-empty', text: '에이전트 단계 이벤트가 여기 실시간으로 쌓입니다' })); return; }
  if (newEv && ol.firstChild && !ol.firstChild.classList.contains('live-empty')) {
    ol.prepend(liveRow(newEv));
    while (ol.children.length > LIVE_MAX) ol.removeChild(ol.lastChild);
    return;
  }
  replace(ol, S.live.map(liveRow));
}

// ---------- 주입 다이얼로그 ----------
function setupInject() {
  const dlg = $('#inject-dialog'), form = $('#inject-form'), err = $('#inject-error');
  $('#btn-inject').addEventListener('click', () => { err.hidden = true; form.reset(); renderInjectChannels(); dlg.showModal(); });
  $('#inject-cancel').addEventListener('click', () => dlg.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = { channel: fd.get('channel'), from: String(fd.get('from') || '').trim(), name: String(fd.get('name') || '').trim() || undefined, subject: String(fd.get('subject') || '').trim(), body: String(fd.get('body') || '').trim() };
    err.hidden = true;
    try {
      const r = await post('/api/test/inbound', body);
      dlg.close();
      await loadCases(); loadStats();
      if (r && r.caseId) selectCase(r.caseId);
    } catch (ex) { err.textContent = humanError(ex); err.hidden = false; }
  });
}

// ---------- 키보드 ----------
function setupKeys() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key !== 'j' && e.key !== 'k') return;
    if (!S.cases.length) return;
    const idx = S.cases.findIndex((c) => c.id === S.selectedId);
    const next = e.key === 'j' ? Math.min(S.cases.length - 1, idx + 1) : Math.max(0, idx - 1);
    const c = S.cases[next];
    if (c) { selectCase(c.id); $(`.case-row[data-id="${CSS.escape(c.id)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  });
}

// ---------- 초기화 ----------
function setupReviewer() {
  const input = $('#reviewer');
  try { input.value = localStorage.getItem('cs-agent.reviewer') || ''; } catch { /* storage unavailable */ }
  input.addEventListener('change', () => { try { localStorage.setItem('cs-agent.reviewer', input.value.trim()); } catch { /* ignore */ } });
}
function setupLiveToggle() {
  const live = $('#live'), btn = $('#live-toggle');
  let collapsed = false;
  try { collapsed = localStorage.getItem('cs-agent.liveCollapsed') === '1'; } catch { /* ignore */ }
  const apply = () => { live.classList.toggle('collapsed', collapsed); btn.setAttribute('aria-expanded', String(!collapsed)); };
  apply();
  btn.addEventListener('click', () => { collapsed = !collapsed; apply(); try { localStorage.setItem('cs-agent.liveCollapsed', collapsed ? '1' : '0'); } catch { /* ignore */ } });
  $('#live-clear').addEventListener('click', () => { S.live = []; renderLive(); });
}
function setupDetailIme() {
  const root = $('#detail');
  root.addEventListener('compositionstart', () => { S.composing = true; });
  // 마지막 input이 compositionend 뒤에 오는 브라우저(Safari)가 있어 한 틱 미룬다
  root.addEventListener('compositionend', () => { S.composing = false; if (S.renderDeferred) { S.renderDeferred = false; setTimeout(renderDetail, 0); } });
}
function init() {
  setupReviewer(); setupLiveToggle(); setupInject(); setupKeys(); setupDetailIme();
  $('#version-close').addEventListener('click', () => $('#version-dialog').close());
  $('#quick-pending').addEventListener('click', togglePendingOnly);
  $('#btn-refresh').addEventListener('click', () => { loadCases(); loadStats(); });
  $('#search').addEventListener('input', debounce((e) => { S.filters.q = e.target.value.trim(); loadCases(); }, 300));
  renderStateFilters(); renderKpis(); renderLive(); renderDetail();
  loadHealth(); loadPolicy().then(loadCases); loadStats(); loadAgent();
  connectSSE();
  setInterval(loadAgent, 5000);
  setInterval(loadStats, 30000);
  setInterval(() => { if (S.cases.length) renderList(); }, 60000); // 상대 시간 갱신
}
document.addEventListener('DOMContentLoaded', init);
