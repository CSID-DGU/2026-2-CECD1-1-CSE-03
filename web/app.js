'use strict';
// CS Agent 백오피스(CRM 화면) — 바닐라 JS, 빌드 없음. API 계약: docs/spec.md §5 · GET /api/crm/cases[/:id]
// 모든 서버 문자열은 DOM 노드(textContent)로만 넣는다. innerHTML에 데이터 삽입 금지.
// 화면은 결과만 보인다 — 판단 기록·규칙 번호·단계 로그는 싣지 않는다(내부 기록은 /api/cases/:id에 그대로 있다).

// ---------- 상수 ----------
const STATUSES = ['New', 'Working', 'Escalated', 'On Hold', 'Closed']; // 탭 순서 = Path·칸반 순서
const SUB_STATUSES = ['Awaiting Approval', 'Waiting on Customer'];
const TABS = [['', '전체', 'all'], ...STATUSES.map((s) => [s, null, s])]; // [status 필터, 이름(null = LABELS.status), counts 키]
const EDIT_TAGS = [['fact', '사실오류'], ['tone', '어조'], ['missing', '누락'], ['excess', '과잉'], ['policy', '정책'], ['critical', '치명 오류']];
// 코드(상태·필드·사유)를 사람 말로. 모르는 코드는 그대로 보인다. server/labels.js와 같은 표를 공유한다(intent).
const LABELS = {
  status: { New: '신규', Working: '응대 중', 'On Hold': '보류', Escalated: '사람 전담', Closed: '종결' },
  subStatus: { 'Awaiting Approval': '승인 대기', 'Waiting on Customer': '고객 회신 대기' },
  caseType: { Question: '질문', Problem: '문제' },
  caseReason: {
    account: '계정', billing: '결제·요금', howto: '사용법', data: '데이터', onboarding: '온보딩', scheduling: '일정',
    sales: '영업', complaint: '불만', other: '기타',
  },
  priority: { High: '높음', Medium: '보통', Low: '낮음' },
  origin: { Email: '이메일', Web: '웹 폼' },
  closeReason: { resolved: '해결됨', no_response: '고객 무응답', duplicate: '중복', spam: '스팸', not_applicable: '응대 불필요', other: '기타' },
  outcome: {
    auto_answered: '자동 답변', answered_after_approval: '승인 후 답변', answered_and_handed_off: '답변 후 사람 전담',
    handed_off: '사람에게 넘김', human_answered: '사람이 답변', ignored: '응대 불필요', shadow: '섀도(기록만)',
  },
  reason: {
    refund_request: '환불 요청', billing_dispute: '결제 분쟁', data_export: '데이터 반출', complaint: '불만·항의', legal_threat: '법적 언급',
    human_request: '사람 연결 요청', call_meeting: '통화·미팅 요청', contract_documents: '계약 서류', purchase_intent: '진행 의사', price_contract: '금액·계약 조건',
    list_request: '명단 요청', pricing: '요금 문의', policy_exception: '정책 예외', account_identity: '본인 확인 필요', injection: '지시 변경 시도',
    custom_data: '맞춤 데이터 요청', custom_quote: '맞춤 견적', pricing_exception: '요금 예외', access_grant: '권한·라이선스 부여', trial_access: '체험 권한',
    out_of_knowledge: 'KB에 없음', low_confidence: '확신 낮음', no_progress: '같은 질문 반복', round_limit: '왕복 한도', guard_failed: '검사 실패',
    llm_error: 'LLM 장애', internal_error: '내부 오류', unclear: '뜻 불분명', sender_changed: '보낸 사람 바뀜', sender_unverified: '발신자 인증 실패', language_unsupported: '지원 안 하는 언어',
    discarded: '초안 폐기', auto_reply_or_empty: '자동 회신·빈 메일', internal_sender: '사내 발신', responder_human: '사람이 맡은 케이스',
    case_changed: '회차 중 상황 바뀜', shadow: '섀도 채널', ack: '감사·확인 인사', ignore: '무시 대상', answer_and_handoff: '답장 + 넘김',
    ignored_first_message: '첫 메시지 무시', inactive: '장기 무응답', already_answered: '다른 답장이 먼저 나감', newer_inbound: '더 새 고객 메시지',
    // 담당 전환 사유(사람 행동)
    takeover: '사람이 인수', discard: '초안 폐기', human_reply: '사람이 직접 답장', return: '에이전트에게 반환',
    // guard·검수 위반 코드
    amount: '금액 언급', contact: '연락처 노출', date_promise: '날짜 약속', date: '날짜 언급', emoji: '이모지', empty: '빈 본문', forbidden_word: '금지어',
    link_not_in_kb: 'KB에 없는 링크', too_long: '너무 김', unknown_fact: '근거 없는 사실', unresolved_slot: '자리표시 남음', not_answered: '질문에 답 안 함',
    no_fact: '근거 절 표시 없음', fact_off_intent: '문의 유형 밖 근거',
    // 원문 파기 사유
    retention: '보존 기간 만료', subject_request: '정보주체 요청',
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
};
// guard 판단 사유는 "forbidden_word,date_promise"처럼 쉼표로 이어져 온다.
const label = (kind, code) => (code == null ? '' : String(code).split(',').map((k) => LABELS[kind][k] || k).join(', '));
const AGENT_LABEL = { triage: '접수 Agent', responder: '답장 Agent', reviewer: '검수 Agent', briefer: '인계 Agent' };
// 유형 칩 — 한국어 이름, 마우스를 올리면 코드
const intentChip = (code) => (code ? h('span', { class: 'chip', text: label('intent', code), title: code }) : null);
// 활동 문서 subtype → 사람 말
const ACTIVITY_LABEL = {
  approve: '승인 발송', edit_approve: '수정 후 승인 발송', discard: '초안 폐기', takeover: '인수', return: '에이전트에게 반환',
  close: '종결', note: '메모', human_reply: '직접 답장', hold: '보류', unhold: '보류 해제', handoff: '사람에게 넘김',
  shadow_rating: '섀도 평가', auto_close: '자동 종결', send_unconfirmed: '발송 확인 필요', resolve_sending: '발송 확인 처리',
  auto_send: '자동 발송(L2)', auto_send_failed: '자동 발송 막힘', auto_ack: '접수 안내 자동 발송', purge: '원문 파기',
};
const SENDER_AUTH = { fail: ['발신자 인증 실패', 'warn'], form: ['폼에 적힌 주소', ''] };
// 상세의 명령 버튼. 펼치는 입력 칸이 있는 것(compose)과 바로 보내는 것.
const ACTION_LABEL = { takeover: '인수', unhold: '보류 해제', return: '반환 (에이전트에게)' };
const COMPOSE = {
  reply: { action: 'human_reply', label: '직접 답장', submit: '직접 답장 보내기', cls: 'btn-ok', placeholder: '고객에게 실제로 발송됩니다(담당자 이름으로, AI 고지 없이). 보내면 이 케이스는 사람이 맡고 대기 중 초안은 미선택 처리됩니다.' },
  note: { action: 'note', label: '메모', submit: '메모 저장', cls: 'btn-primary', placeholder: '내부 메모 (고객에게 가지 않습니다)', hint: '메모는 활동 기록에 남습니다' },
  hold: { action: 'hold', label: '보류', submit: '보류', cls: 'btn-primary', placeholder: '보류 메모(필수) — 무엇을 기다리는지 적어 주세요. 고객에게 가지 않습니다.', hint: '보류 중에는 자동 종결되지 않습니다', max: 500 },
  close: { action: 'close', label: '종결', submit: '종결', cls: 'btn-danger', placeholder: '상세 — 기타를 고르면 필수', hint: '종결 뒤 고객이 회신하면 이 케이스가 다시 열립니다', max: 500 },
};
const RATING_LABEL = { good: '좋음', needs_edit: '수정 필요', critical: '치명 오류' };
// 섀도 평가는 "그대로 보내도 되는가"만 묻는다 — 사람 팀이 실제로 보낸 답장은 읽지 않으므로 비교 기준이 없다.
const RATING_HINT = { good: '그대로 보내도 됨', needs_edit: '고치면 보낼 수 있음', critical: '보내면 사고(금액·약속·오발송·치환 안 된 슬롯)' };
const SHADOW_GUIDE = `고객에게 나가지 않았습니다. 이 초안을 그대로 보내도 되는지 평가하세요 — ${Object.keys(RATING_LABEL).map((k) => `${RATING_LABEL[k]}: ${RATING_HINT[k]}`).join(' · ')}`;
const LIST_PAGE = 100, LIST_MAX = 500; // 서버 ?limit 상한 500
const SHADOW_PAGE = 100;
const FILTERS = [['caseType', '유형'], ['caseReason', '사유'], ['priority', '우선순위'], ['origin', '접수 경로'], ['recordType', '사업 라인']];
// 이 이벤트가 오면 목록·열린 상세를 다시 읽기만 한다(내용은 표시하지 않는다).
const RELOAD_ON = ['case.updated', 'message.created', 'draft.created', 'draft.updated', 'handoff.created', 'auto_send.failed'];

// ---------- 상태 ----------
const S = {
  items: [], counts: null, subCounts: null, listError: null, selectedId: null, detail: null, detailError: null,
  filters: { status: '', subStatus: '', caseType: '', caseReason: '', priority: '', origin: '', recordType: '', q: '' },
  policy: [], stats: null, health: null, agent: null,
  es: null, backoff: 1000, compose: null, // compose: COMPOSE 키 | null
  pathTarget: null, // Path에서 고른 다음 상태(PATH_MOVES 키) | null
  draftEdit: {}, // draftId -> { body, tags:Set, error } — error: 마지막 승인 실패(재렌더에도 남는다)
  composeDraft: {}, // `${caseId}:${mode}` -> { text, reason, error } — 보내기 전 입력(재렌더·케이스 전환에도 남는다)
  composing: false, renderDeferred: false, // 한글 IME 조합 중에는 상세를 다시 그리지 않는다(글자가 깨진다)
  inflight: new Set(), // 진행 중인 사람 행동 키 — 버튼을 잠가 두 번 누르지 않게
  limit: LIST_PAGE,
  flash: null, // { caseId, node, at } — 상세 상단 배너(재렌더에도 남는 오류 메시지)
  me: null, // 인증 헤더 모드면 서버가 알려 준 사용자
  seq: { list: 0, detail: 0, shadow: 0 }, // 늦게 도착한 응답이 최신 화면을 덮지 않게
  view: 'cases', // 목록 칸: 'cases' 케이스 표 | 'shadow' 미평가 섀도 초안
  board: 'list', // 케이스 보기: 'list' 표 | 'kanban' 상태별 칸(브라우저에 기억)
  dragId: null, boardDeferred: false, boardFocus: null, // 칸반: 끄는 카드 · 끄는 동안 미룬 다시 그리기 · 다시 그린 뒤 초점
  detailFocus: null, // 카드에서 연 상세 { id, step } — 읽어 온 뒤 진행 단계로 포커스(키보드)·한 칸 화면이면 상세로 스크롤
  liveKey: '', // 에이전트가 지금 회차를 도는 케이스(activeCases) — 바뀔 때만 목록·칸반을 다시 그린다
  shadow: null, shadowError: null, // 미평가 섀도 초안 — null = 서버에 목록 API가 없다(정적 프로토타입)
  report: null, reportError: null, reportAt: null,
  workload: null, // 업무 대체율 — null = 서버에 API가 없다(정적 프로토타입)
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
  return iso && !Number.isNaN(d.getTime()) ? d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
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
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function packOf(channel) { return S.policy.find((p) => p.channel === channel) || null; }
function channelLabel(channel) { return packOf(channel)?.label || channel || '–'; }
function channelBadge(channel) { return h('span', { class: `badge ch-${channel}`, text: channelLabel(channel) }); }
const slug = (s) => String(s || '').replace(/\s+/g, '');
// 칸반 칸 = Path 단계 + 승인 대기(응대 중 안의 세부 상태)를 따로 세운 칸. 목록·상세의 상태 표시도 같은 이름을 쓴다.
const APPROVAL = 'Awaiting Approval';
const COLUMNS = [['New', '신규'], ['Working', '응대 중'], ['Approval', '승인 대기'], ['Escalated', '사람 전담'], ['On Hold', '보류'], ['Closed', '종결']];
const colOf = (c) => (c.status === 'Working' && c.subStatus === APPROVAL ? 'Approval' : c.status);
/** 상태 = 점 + 글자. 색은 승인 대기(사람이 결정할 일)에만. 세부 상태(고객 회신 대기)는 회색 꼬리. */
function statusMark(c) {
  const col = colOf(c);
  const sub = c.subStatus && col !== 'Approval' ? label('subStatus', c.subStatus) : null;
  return h('span', { class: `status s-${slug(col)}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }),
    col === 'Approval' ? label('subStatus', APPROVAL) : label('status', c.status) || '–', sub ? h('span', { class: 'status-sub', text: ` · ${sub}` }) : null);
}
const priorityText = (p) => (p ? h('span', { class: `prio pr-${p}`, text: label('priority', p) }) : null);
const isLive = (id) => !!(S.agent && Array.isArray(S.agent.activeCases) && S.agent.activeCases.includes(id));
const liveMark = () => h('span', { class: 'live' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), '에이전트 응대 중');
const ownerText = (o) => (!o ? '–' : o.type === 'agent' ? '에이전트' : o.id || '사람');
const actorText = (a) => (!a ? '–' : a.type === 'system' ? '시스템' : a.type === 'agent' ? '에이전트' : a.id || '사람');
const purgedChip = () => h('span', { class: 'chip purged', text: '원문 파기됨' });
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
  // 헬스체크(/api/health)는 무인증 {ok:true}뿐 — 회사명·인증 방식·메일 provider는 인증 뒤 /api/status
  try { S.health = await api('/api/status'); } catch { S.health = null; }
  if (S.health && S.health.auth === 'header') {
    try { S.me = (await api('/api/me')).user || null; } catch { S.me = null; }
  }
  renderHealth();
}
async function loadStats() {
  try { S.stats = await api('/api/stats'); } catch { /* keep last */ }
  renderStats();
}
/**
 * 업무 대체율(메시지 단위) — 집계가 무거워 클라이언트마다 30초 폴링과 리포트를 열 때·새로고침 때만 부른다(stats.updated마다 부르지 않는다).
 * 404(정적 프로토타입)면 타일·리포트 칸을 그리지 않는다. 그 밖의 오류는 마지막 값을 둔다.
 */
async function loadWorkload() {
  try { S.workload = await api('/api/report/workload'); } catch (e) { if (e.status === 404) S.workload = null; }
  renderKpis();
  if ($('#report-dialog').open) renderReport();
}
function renderStats() { renderKpis(); renderPromotion(); }
async function loadAgent() {
  try { S.agent = await api('/api/agent/status'); } catch { S.agent = null; }
  renderAgent();
}
async function loadPolicy() {
  try {
    const p = await api('/api/policy');
    S.policy = Array.isArray(p) ? p : Object.values(p || {});
  } catch { S.policy = []; }
  renderFilterOptions();
  renderInjectChannels();
  renderPromotion();
}
async function loadCases() {
  const seq = ++S.seq.list;
  const qs = new URLSearchParams();
  const kanban = S.board === 'kanban'; // 칸반은 상태 칸을 모두 그린다 — 상태·세부 상태 필터만 빼고 같은 필터
  for (const [k, v] of Object.entries(S.filters)) if (v && !(kanban && (k === 'status' || k === 'subStatus'))) qs.set(k, v);
  qs.set('limit', String(kanban ? LIST_MAX : S.limit));
  let r = null; let err = null;
  try { r = await api(`/api/crm/cases?${qs}`); } catch (e) { err = humanError(e); }
  if (seq !== S.seq.list) return; // 그 사이 필터가 바뀌었거나 새 요청이 나갔다
  S.items = (r && r.items) || []; S.listError = err;
  if (r) { S.counts = r.counts || null; S.subCounts = r.subCounts || null; }
  renderTabs(); renderList();
}
async function loadDetail(id) {
  if (!id) { S.detail = null; renderDetail(); return; }
  const seq = ++S.seq.detail;
  let d = null; let err = null;
  try { d = await api(`/api/crm/cases/${encodeURIComponent(id)}`); } catch (e) { err = humanError(e); }
  // 다른 케이스를 고른 뒤 도착한 응답·더 늦게 보낸 요청보다 먼저 도착한 응답은 버린다 — 엉뚱한 케이스에 메모·답장이 가지 않게.
  if (S.selectedId !== id || seq !== S.seq.detail) return;
  S.detail = d; S.detailError = err;
  renderDetail();
}
/** 미평가 섀도 초안(사업 라인 필터 따름). 서버에 목록이 없으면(404 — 정적 프로토타입) S.shadow = null로 두고 버튼을 숨긴다. */
async function loadShadow() {
  const seq = ++S.seq.shadow;
  const qs = new URLSearchParams({ limit: String(SHADOW_PAGE) });
  if (S.filters.recordType) qs.set('channel', S.filters.recordType);
  let items = null; let err = null;
  try { items = (await api(`/api/shadow?${qs}`))?.items || []; } catch (e) { err = e; }
  if (seq !== S.seq.shadow) return;
  if (err && err.status === 404) { S.shadow = null; S.view = 'cases'; }
  else { S.shadow = items || S.shadow || []; S.shadowError = err ? humanError(err) : null; }
  renderShadow();
}
/** 운영 리포트 — 집계가 무거워 페이지를 열 때·리포트를 열 때·새로고침 때만 부른다. 404(정적 프로토타입)면 버튼을 숨긴다. */
async function loadReport() {
  let r = null; let err = null;
  loadWorkload(); // 업무 대체 칸 — 리포트와 같이(열 때·새로고침 때)
  try { r = await api('/api/report'); } catch (e) { err = e; }
  $('#btn-report').hidden = !!err && err.status === 404;
  S.report = r; S.reportError = err ? humanError(err) : null; S.reportAt = new Date().toISOString();
  renderReport();
}
const reloadList = debounce(loadCases, 300);
const reloadDetail = debounce(() => loadDetail(S.selectedId), 300);
const refreshShadow = debounce(loadShadow, 500);

/** 케이스를 연다. d = 이미 읽은 상세(칸반에서 끌어 놓을 때 읽은 것)면 다시 읽지 않는다. */
function selectCase(id, d = null) {
  if (S.selectedId === id && !d) return;
  S.selectedId = id; S.detail = d; S.detailError = null; S.compose = null; S.pathTarget = null; S.flash = null;
  if (d) S.seq.detail++; // 먼저 나간 상세 요청이 늦게 와서 덮지 않게
  renderList();
  if (S.view === 'shadow') renderShadow();
  renderDetail();
  if (!d) loadDetail(id);
}

// ---------- 렌더: 상단 ----------
function renderHealth() {
  const hlt = S.health;
  $('#brand-name').textContent = (hlt && (hlt.company || hlt.companyName)) || 'CS Agent';
  const mock = hlt && hlt.provider && hlt.provider.mail === 'mock';
  const banner = $('#mail-banner');
  banner.hidden = !mock;
  banner.textContent = mock ? `메일 발송이 mock입니다 — 승인해도 고객에게 실제로 나가지 않습니다${hlt.mailWarning ? ` (${hlt.mailWarning})` : ''}` : '';
  $('#btn-inject').hidden = !(hlt && hlt.testInject); // 테스트 모드에서만
  const rv = $('#reviewer');
  if (S.me) { rv.value = S.me; rv.readOnly = true; rv.title = '로그인 사용자(프록시 인증)'; }
  if (S.agent) renderAgent(); // provider·버전은 배지 대신 에이전트 상태의 툴팁에
}
function renderKpis() {
  const s = S.stats || {};
  const ok = Number(s.approvedNoEdit || 0), ed = Number(s.approvedEdited || 0);
  const rate = (ok + ed) ? `${Math.round((ok / (ok + ed)) * 100)}%` : '–';
  const val = (v) => (v == null ? '–' : String(v));
  const fr = s.firstResponse || {};
  const wl = S.workload;
  const tiles = [
    ['미종결', val(s.unresolved), { title: '종결되지 않은 케이스 전부' }],
    ['승인 대기', val(s.awaitingApproval), { hue: true, title: '에이전트 초안이 사람의 승인을 기다리는 케이스' }],
    ['오늘 인입', val(s.todayInbound)],
    ['무수정 승인률', rate, { title: `무수정 ${ok} · 수정 ${ed}` }],
    // 업무 대체(메시지 단위) — 자세한 표는 운영 리포트
    wl ? ['업무 대체율', pct(wl.agentRate), { title: `${WORKLOAD_HELP}\n전체 ${fmtN(wl.total)}단위 · ${WORKLOAD_BUCKETS.map(([k, t]) => `${t} ${fmtN(wl[k])}`).join(' · ')}\n${ackText(wl)} · ${pendingText(wl)}` }] : null,
    // 1차 응대(케이스 단위) — 완전 자동응대 · 사람에게 넘김(접수 안내·초안 포함) · 응대 못함
    ['1차 응대율', fr.rate == null ? '–' : `${Math.round(fr.rate * 100)}%`, { title: `응대 필요 ${val(fr.base)}건 중 에이전트가 답·접수 안내·초안을 낸 비율` }],
    ['완전 자동응대', val(fr.auto), { title: '승인 없이 자동 발송(L2)되고 사람 손이 가지 않은 케이스' }],
    ['넘김(요약·접수 안내)', val(fr.handedOff), { title: '에이전트가 접수 안내·답장+넘김·승인 대기 초안을 내고 사람에게 넘긴 케이스' }],
    ['응대 못함', val(fr.none), { warn: Number(fr.none) > 0, title: '에이전트가 보낸 답·접수 안내도, 승인 대기 초안도 없는 케이스(지시 변경 시도·법적 언급 등 접수 안내 제외 사유, 사람 직접 답장만 나간 케이스 포함)' }],
  ];
  replace($('#kpis'), tiles.filter(Boolean).map(([text, value, o = {}]) => h('div', { class: `kpi${o.hue ? ' hue' : o.warn ? ' warn' : ''}`, title: o.title || text },
    h('span', { class: 'kpi-label', text }), h('span', { class: 'kpi-value', text: value }))));
}
/** 에이전트 상태 — 점 하나와 글자. 회차를 도는 케이스(activeCases)가 바뀌면 카드·행의 「에이전트 응대 중」도 다시 그린다. */
function renderAgent() {
  const el = $('#agent-status'), txt = $('#agent-status-text');
  const a = S.agent;
  el.classList.remove('running', 'offline', 'degraded');
  const live = (a && a.activeCases) || [];
  const key = live.join(',');
  if (key !== S.liveKey) { S.liveKey = key; if (S.items.length) renderList(); }
  if (!a) { el.classList.add('offline'); txt.textContent = '에이전트 상태 모름'; el.title = '에이전트 상태'; return; }
  // 상단 바는 한 줄 — 글자는 짧은 상태만, 큐·재시도·마지막 회전·공급자는 툴팁으로
  if (a.llm && a.llm !== 'ok') { el.classList.add('degraded'); txt.textContent = a.llm === 'open' ? 'LLM 차단 중' : 'LLM 불안정'; }
  else if (a.running) { el.classList.add('running'); txt.textContent = `에이전트 응대 중 ${live.length}건`; }
  else txt.textContent = '에이전트 대기 중';
  const prov = a.provider || (S.health && S.health.provider) || {};
  el.title = [a.llm === 'open' ? 'LLM 장애로 차단 중' : null, a.queueDepth ? `큐 ${a.queueDepth}` : null, a.retriesPending ? `재시도 대기 ${a.retriesPending}` : null,
    a.lastCycleAt ? `마지막 회전 ${relTime(a.lastCycleAt)}` : null, `오늘 ${a.cyclesToday ?? '-'}회전`, `LLM ${prov.llm || '?'} · 메일 ${prov.mail || '?'}`,
    S.health && S.health.version ? `v${S.health.version}` : null].filter(Boolean).join(' · ');
}

// ---------- 렌더: 상태 탭·필터 ----------
// 탭·칩·필터가 바뀌면 케이스 표로 돌아가고 처음 100건부터 다시 읽는다.
function setFilter(patch) {
  Object.assign(S.filters, patch);
  S.limit = LIST_PAGE; S.view = 'cases';
  renderShadow(); renderTabs(); loadCases();
}
const setStatus = (status) => setFilter({ status, subStatus: '' });
const toggleSubStatus = (s) => setFilter({ subStatus: S.filters.subStatus === s ? '' : s });
function renderTabs() {
  const f = S.filters; const n = S.counts;
  // 다시 그리면 버튼이 바뀐다 — 탭·칩에 있던 키보드 초점을 같은 자리로 돌려준다
  const tabs = $('#status-tabs'); const sub = $('#sub-chips');
  const tabFocus = tabs.contains(document.activeElement); const chipAt = [...sub.children].indexOf(document.activeElement);
  replace(tabs, TABS.map(([status, text, key]) => {
    const on = f.status === status;
    return h('button', {
      type: 'button', role: 'tab', class: `tab${on ? ' active' : ''}`, 'aria-selected': String(on), tabindex: on ? '0' : '-1',
      'aria-controls': 'case-table-wrap', onclick: () => setStatus(status),
    }, text || label('status', status), n ? h('span', { class: 'count', text: String(n[key] ?? 0) }) : null);
  }));
  if (tabFocus) tabs.querySelector('[aria-selected="true"]')?.focus();
  // 응대 중 안의 세부 상태 칩(subCounts = 응대 중 케이스의 세부 상태별 수)
  sub.hidden = S.board === 'kanban' || f.status !== 'Working';
  replace(sub, SUB_STATUSES.map((s) => h('button', {
    type: 'button', class: `chip-btn${f.subStatus === s ? ' active' : ''}`, 'aria-pressed': String(f.subStatus === s), onclick: () => toggleSubStatus(s),
  }, label('subStatus', s), S.subCounts ? h('span', { class: 'count', text: String(S.subCounts[s] ?? 0) }) : null)));
  if (chipAt >= 0 && !sub.hidden) sub.children[chipAt]?.focus();
}
/** 좌우 화살표·Home·End로 탭 이동(WAI-ARIA 탭 패턴). */
function onTabKey(e) {
  const step = { ArrowRight: 1, ArrowLeft: -1, Home: -TABS.length, End: TABS.length }[e.key];
  if (!step) return;
  e.preventDefault();
  const i = TABS.findIndex(([s]) => s === S.filters.status);
  const j = Math.max(0, Math.min(TABS.length - 1, i + step));
  setStatus(TABS[j][0]);
  $('#status-tabs').children[j]?.focus();
}
function renderFilterOptions() {
  for (const [key, text] of FILTERS) {
    const sel = $(`#f-${key}`);
    const opts = key === 'recordType' ? S.policy.map((p) => [p.channel, p.label || p.channel]) : Object.entries(LABELS[key]);
    replace(sel, h('option', { value: '', text: `${text}: 전체` }), opts.map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = S.filters[key];
  }
}
function renderInjectChannels() {
  const sel = $('#inject-channel');
  replace(sel, (S.policy.length ? S.policy : [{ channel: 'support', label: 'support' }]).map((p) => h('option', { value: p.channel, text: `${p.label || p.channel} (${p.channel})` })));
}
/** 채널별 승격 지표(L0→L1): 검토 수 / 무수정 비율 / 치명 오류 — 기준은 서버 상수. 운영 리포트 안에 보인다. */
function renderPromotion() {
  const box = $('#promotion');
  const pr = (S.stats && S.stats.promotion) || {};
  if (!S.policy.length) { replace(box); return; }
  replace(box, S.policy.map((p) => {
    const m = pr[p.channel];
    if (!m) return null;
    const c = m.criteria || {};
    return h('div', { class: `promo${m.eligible ? ' ok' : ''}`, title: `기준: 검토 ${c.minReviewed}건 이상 · 무수정 ${Math.round((c.minNoEditRate || 0) * 100)}% 이상 · 치명 오류 ${c.maxCritical}건` },
      h('b', { text: `${p.label || p.channel}${p.shadow ? ' · L0 섀도' : p.maxLevel ? ` · ${p.maxLevel}` : ''}` }),
      h('span', { text: `검토 ${m.reviewed}${c.minReviewed ? `/${c.minReviewed}` : ''}` }),
      h('span', { text: `무수정 ${Math.round(m.approvedNoEditRate * 100)}%` }),
      h('span', { class: m.criticalCount ? 'bad' : '', text: `치명 ${m.criticalCount}` }),
      h('span', { class: 'promo-state', text: m.eligible ? '승격 가능' : '기준 미달' }));
  }));
}

// ---------- 렌더: 목록 ----------
/** 필터에 맞는 전체 건수 — counts(상태별)·subCounts(응대 중 안의 세부 상태). */
function listTotal() {
  const f = S.filters;
  if (!S.counts) return null;
  const n = f.subStatus ? (f.status === 'Working' && S.subCounts ? S.subCounts[f.subStatus] : null) : S.counts[f.status || 'all'];
  return n == null ? null : Math.max(Number(n), S.items.length);
}
function renderListCount() {
  if (S.view === 'shadow') {
    const n = S.shadow ? S.shadow.length : 0;
    $('#list-count').textContent = `섀도 평가 · 미평가 ${n}건${n >= SHADOW_PAGE ? '+' : ''}`;
    return;
  }
  if (S.board === 'kanban') { $('#list-count').textContent = `칸반 · ${S.counts ? S.counts.all : S.items.length}건`; return; }
  const f = S.filters;
  const scope = [f.status ? label('status', f.status) : '전체', f.subStatus ? label('subStatus', f.subStatus) : null].filter(Boolean).join(' · ');
  const total = listTotal();
  $('#list-count').textContent = total == null ? `${scope} · ${S.items.length}건` : `${scope} · ${total}건 중 ${S.items.length}건 표시`;
}
function renderList() {
  if (S.board === 'kanban') { renderBoard(); return; }
  renderListCount();
  const body = $('#case-rows');
  const msg = (cls, text) => h('tr', {}, h('td', { class: cls, colspan: '8', text }));
  const total = listTotal();
  $('#list-more').hidden = !(S.items.length >= S.limit && S.limit < LIST_MAX && (total == null || total > S.items.length));
  if (S.listError) { replace(body, msg('error-box', `목록을 불러오지 못했습니다: ${S.listError}`)); return; }
  if (!S.items.length) { replace(body, msg('empty', '조건에 맞는 케이스가 없습니다')); return; }
  replace(body, S.items.map(caseRow));
}
/** 문의자(고객사) — 목록 문서에는 고객사 이름이 없어 업무 도메인(고객사 문서가 있는 경우)만 덧붙인다. */
function whoCell(c) {
  if (c.lifecycleStatus === 'anonymized') return h('span', { class: 'muted', text: '(파기됨)' });
  const domain = c.companyId && c.suppliedEmail ? String(c.suppliedEmail).split('@')[1] : null;
  return h('span', { title: c.suppliedEmail || '' }, c.suppliedName || c.suppliedEmail || '(이름 없음)', domain ? h('small', { text: ` (${domain})` }) : null);
}
function caseRow(c) {
  const selected = c.id === S.selectedId;
  const open = () => selectCase(c.id);
  return h('tr', {
    class: selected ? 'selected' : null, tabindex: '0', 'aria-current': selected ? 'true' : null, dataset: { id: c.id }, onclick: open,
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.currentTarget[e.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling']?.focus(); }
    },
  },
  h('td', { class: 'no num', text: c.caseNumber || shortId(c.id) }),
  h('td', { class: 'subj' }, // 제목 위, 문의자(고객사) 아래 — 두 줄 한 칸
    h('span', { class: 'subj-line', text: c.subject || '(제목 없음)', title: c.subject || '' }), h('span', { class: 'who-line' }, whoCell(c))),
  h('td', { text: label('caseType', c.caseType) || '–' }),
  h('td', { text: label('caseReason', c.caseReason) || '–' }),
  h('td', {}, priorityText(c.priority) || '–'),
  h('td', {}, statusMark(c)),
  h('td', {}, isLive(c.id) ? liveMark() : ownerText(c.owner)),
  h('td', { class: 'time', text: relTime(c.audit && c.audit.updatedAt), title: (c.audit && c.audit.updatedAt) || '' }));
}

// ---------- 렌더: 칸반 ----------
// 칸 = 신규 · 응대 중 · 승인 대기 · 사람 전담 · 보류 · 종결(COLUMNS). 카드를 다른 칸에 놓으면 Path와 같은 표(PATH_MOVES)로 행동 하나를 부른다.
// 신규·승인 대기는 놓는 칸이 아니다 — 초안은 에이전트만 만들고, 승인·발송은 상세의 승인 버튼으로만 한다(끌어서 보내지 않는다).
const BOARD_CLOSED = 20; // 종결 칸은 최근 20장, 나머지는 「더 보기」로 목록에서
function applyView() {
  const kanban = S.board === 'kanban'; const shadow = S.view === 'shadow';
  $('#case-table-wrap').hidden = shadow || kanban;
  $('#board').hidden = shadow || !kanban;
  $('#shadow-list').hidden = !shadow;
  $('#status-tabs').hidden = kanban;
  $('.layout').classList.toggle('kanban', kanban && !shadow);
  $('#sub-chips').hidden = kanban || S.filters.status !== 'Working';
  $('#view-list').setAttribute('aria-pressed', String(!kanban));
  $('#view-kanban').setAttribute('aria-pressed', String(kanban));
}
function setBoard(v, patch = {}) {
  S.board = v;
  try { localStorage.setItem('cs-agent.board', v); } catch { /* storage unavailable */ }
  setFilter(patch);
}
const say = (text) => { $('#board-live').textContent = text; };
/** 칸의 건수 — 서버 counts(상태별)에서. 응대 중 칸은 승인 대기(subCounts)를 뺀 나머지. */
function columnCount(key, shown) {
  if (!S.counts) return shown.length;
  const approval = S.subCounts ? Number(S.subCounts[APPROVAL] || 0) : null;
  if (key === 'Approval') return approval ?? shown.length;
  if (key === 'Working') return approval == null ? shown.length : Math.max(0, Number(S.counts.Working || 0) - approval);
  return S.counts[key] ?? shown.length;
}
function renderBoard() {
  if (S.dragId) { S.boardDeferred = true; return; } // 끄는 중에 카드를 바꾸면 끌기가 끊긴다 — 놓은 뒤 그린다
  renderListCount();
  const root = $('#board-cols');
  const active = document.activeElement;
  const focusKey = S.boardFocus || (active && root.contains(active) ? active.dataset.focusKey : null);
  S.boardFocus = null;
  if (S.listError) { replace(root, h('p', { class: 'error-box', text: `목록을 불러오지 못했습니다: ${S.listError}` })); return; }
  replace(root, COLUMNS.map(([key, name], i) => {
    const all = S.items.filter((c) => colOf(c) === key);
    const cards = key === 'Closed' ? all.slice(0, BOARD_CLOSED) : all;
    const n = columnCount(key, all);
    return h('section', {
      class: `kcol k-${slug(key)}`, dataset: { col: key }, 'aria-labelledby': `kcol-${i}`,
      ondragover: (e) => { if (S.dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }, // 안 되는 칸에도 놓게 둔다 — 놓으면 이유를 알린다
      ondrop: (e) => { e.preventDefault(); const id = S.dragId || e.dataTransfer.getData('text/plain'); endDrag(); if (id) boardMove(id, key); },
    },
    h('h3', { class: 'kcol-head', id: `kcol-${i}`, title: PATH_MOVES[key] ? null : PATH_WHY[key] }, h('span', { text: name }), h('span', { class: 'count', text: String(n) })),
    cards.length ? h('ol', { class: 'kcards' }, cards.map(kanbanCard)) : h('p', { class: 'kcol-empty', text: '없음' }),
    key === 'Closed' && n > cards.length
      ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost kcol-more', onclick: () => setBoard('list', { status: 'Closed', subStatus: '' }) }, `더 보기 (${n - cards.length}건 목록에서)`)
      : null);
  }));
  const el = focusKey && root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  if (el && (!active || active === document.body || root.contains(active))) el.focus({ preventScroll: true }); // 보드 밖 입력 칸(검토자 이름 등)의 포커스는 빼앗지 않는다
}
const oneColumn = () => matchMedia('(max-width: 900px)').matches; // 목록 위·상세 아래 한 칸(style.css와 같은 경계)
/** 카드에서 상세를 연다. 키보드면 포커스를 상세의 진행 단계(현재 상태)로, 한 칸 화면이면 상세가 보이게 내린다. */
function openDetail(id, kb) {
  S.detailFocus = { id, step: kb };
  if (S.selectedId === id && S.detail) focusDetail(); else selectCase(id);
}
function focusDetail() {
  const want = S.detailFocus; const c = S.detail && S.detail.case;
  if (!want || !c || c.id !== want.id) return;
  S.detailFocus = null;
  if (want.step) focusStep(c.status);
  if (oneColumn()) $('#detail').scrollIntoView({ block: 'start' });
}
const focusStep = (status) => $(`#detail [data-focus-key="path:${CSS.escape(status)}"]`)?.focus({ preventScroll: true });
const colName = (k) => (COLUMNS.find(([key]) => key === k) || [])[1] || k;
/** 카드 = 끌 수 있는 버튼 하나. 키보드: Tab으로 오고 Enter·Space로 상세를 연다(상태 변경은 상세의 진행 단계에서). */
function kanbanCard(c) {
  const sel = c.id === S.selectedId;
  const when = c.audit && c.audit.updatedAt;
  return h('li', {},
    h('div', {
      class: `kcard${sel ? ' selected' : ''}`, role: 'button', tabindex: '0', draggable: 'true', 'data-focus-key': `kopen:${c.id}`, 'aria-current': sel ? 'true' : null, dataset: { id: c.id },
      onclick: () => openDetail(c.id, false),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(c.id, true); } },
      ondragstart: (e) => { S.dragId = c.id; e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); markDropTargets(c); },
      ondragend: endDrag,
    },
    h('span', { class: 'kcard-top' }, h('span', { text: c.caseNumber || shortId(c.id) }), c.priority === 'High' ? priorityText(c.priority) : null),
    h('span', { class: 'kcard-subj', text: c.subject || '(제목 없음)' }),
    h('span', { class: 'kcard-who' }, whoCell(c)),
    c.subStatus === 'Waiting on Customer' ? h('span', { class: 'kcard-note', text: label('subStatus', c.subStatus) }) : null,
    h('span', { class: 'kcard-meta', text: [label('caseType', c.caseType), label('caseReason', c.caseReason)].filter(Boolean).join(' · ') || '–' }),
    isLive(c.id) ? h('span', { class: 'kcard-live' }, liveMark()) : null,
    h('span', { class: 'kcard-meta' }, h('span', { text: ownerText(c.owner) }), h('span', { text: relTime(when), title: when || '' }))));
}
/** 끄는 동안 이 카드가 갈 수 있는 칸은 표시하고 나머지는 흐리게(같은 표로 미리 계산 — 최종 판단은 놓은 뒤 서버 actions). */
function markDropTargets(c) {
  for (const col of $('#board-cols').children) {
    const k = col.dataset.col; const here = !!c && colOf(c) === k;
    const ok = !!c && !here && moveTo(k, guessActions(c));
    col.classList.toggle('drop-ok', !!ok); col.classList.toggle('drop-no', !!c && !ok && !here);
  }
}
function endDrag() {
  if (!S.dragId) return;
  S.dragId = null; markDropTargets(null);
  for (const el of document.querySelectorAll('.kcard.dragging')) el.classList.remove('dragging');
  if (S.boardDeferred) { S.boardDeferred = false; renderBoard(); }
}
/**
 * 카드 한 장을 status 칸으로 — 상세를 새로 읽어 그 actions에 있는 행동 하나만 보낸다(그 상세의 revision으로).
 * 보류·종결은 상세의 입력 칸(메모·사유)을 열고, 승인 대기 초안을 내리는 인수는 상세의 Path 확인으로 넘긴다 — 놓기만으로 초안이 사라지지 않게.
 */
async function boardMove(id, status) {
  const it = S.items.find((x) => x.id === id);
  if (!it || colOf(it) === status) return;
  const busy = `board:${id}`;
  if (S.inflight.has(busy)) return; // 이 카드의 앞선 놓기가 아직 끝나지 않았다 — 두 번째 놓기는 버린다(알림도 한 번)
  S.inflight.add(busy);
  try { await boardMoveOnce(it, status); } finally { S.inflight.delete(busy); }
}
async function boardMoveOnce(it, status) {
  const id = it.id;
  const no = `#${it.caseNumber || shortId(id)}`;
  S.boardFocus = `kopen:${id}`;
  if (!moveTo(status, guessActions(it))) { say(`${no}: ${whyNot(it, status)}`); renderBoard(); return; } // 제자리로
  let d;
  try { d = await api(`/api/crm/cases/${encodeURIComponent(id)}`); } catch (e) { say(`${no}: ${humanError(e)}`); loadCases(); return; }
  if (colOf(d.case) === status) { say(`${no}: 이미 ${colName(status)} 칸에 있습니다. 보드를 새로 읽었습니다.`); loadCases(); return; } // 보드가 늦었다
  const move = moveTo(status, new Set(d.case.lifecycleStatus === 'anonymized' ? [] : d.actions || []));
  if (!move) { say(`${no}: ${whyNot(d.case, status)}`); loadCases(); return; }
  const drops = d.pendingDraft ? DRAFT_DROP[move] : null;
  if (NEEDS_INPUT.has(move) || drops) { // 입력이 필요하거나 대기 초안이 내려간다 — 상세를 열고 그 입력 칸·확인 패널로
    selectCase(id, d);
    if (NEEDS_INPUT.has(move)) toggleCompose(move); else pickStep(status);
    if (oneColumn()) ($('#detail .compose') || $('#detail .path-panel'))?.scrollIntoView({ block: 'center' }); // 한 칸 화면에선 보드 아래에 열린다
    const how = move === 'hold' ? '보류 메모를 적고 「보류」를' : move === 'close' ? '종결 사유를 고르고 「종결」을' : '상세에서 「현재 상태로 변경」을';
    say(`${no}: ${drops ? `${drops}. ` : ''}${PATH_TO[status]} 바꾸려면 ${how} 누르세요.`);
    return;
  }
  const key = `${move}:${id}`;
  if (S.inflight.has(key)) return;
  S.inflight.add(key);
  let ok = false;
  try { await MOVE[move](d.case, d.revision); ok = true; }
  catch (e) { say(`${no}: ${humanError(e)}`); }
  finally { S.inflight.delete(key); }
  await Promise.all([loadCases(), loadStats(), S.selectedId === id ? loadDetail(id) : null]);
  if (!ok) return;
  const now = S.items.find((x) => x.id === id); // 다시 읽은 뒤의 칸으로 알린다 — 에이전트가 곧바로 사람 전담으로 돌렸을 수 있다
  say(!now || colOf(now) === status ? `${no}: ${PATH_TO[status]} 옮겼습니다.` : `${no}: ${PATH_TO[status]} 옮겼지만 지금은 ${colName(colOf(now))} 칸에 있습니다.`);
}

// ---------- 렌더: 섀도 평가 목록 ----------
function renderShadow() {
  const btn = $('#quick-shadow');
  // 섀도 채널이 없고 남은 초안도 없으면 버튼을 숨긴다
  btn.hidden = S.shadow === null || (!S.shadow.length && !S.policy.some((p) => p.shadow));
  btn.classList.toggle('active', S.view === 'shadow');
  btn.setAttribute('aria-pressed', String(S.view === 'shadow'));
  replace(btn, '섀도 평가', S.shadow ? h('span', { class: 'count', text: ` ${S.shadow.length}${S.shadow.length >= SHADOW_PAGE ? '+' : ''}` }) : null);
  const ul = $('#shadow-list');
  applyView();
  renderListCount();
  if (S.view !== 'shadow') return;
  if (S.shadowError) { replace(ul, h('li', { class: 'error-box', text: `섀도 초안을 불러오지 못했습니다: ${S.shadowError}` })); return; }
  if (!S.shadow.length) { replace(ul, h('li', { class: 'empty', text: '평가할 섀도 초안이 없습니다' })); return; }
  replace(ul, h('li', { class: 'shadow-guide', text: SHADOW_GUIDE }), S.shadow.map(shadowItem));
}
function toggleShadowView() { S.view = S.view === 'shadow' ? 'cases' : 'shadow'; renderShadow(); if (S.view === 'shadow') loadShadow(); }
/** 미평가 섀도 초안 한 건 — 머리 줄을 누르면 케이스 상세, 평가하면 목록에서 빠진다. */
function shadowItem(it) {
  const open = () => selectCase(it.caseId);
  return h('li', { class: `shadow-item${it.caseId === S.selectedId ? ' selected' : ''}`, dataset: { id: it.caseId } },
    h('div', {
      class: 'row-top', role: 'button', tabindex: '0', title: '케이스 상세 열기', onclick: open,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    }, channelBadge(it.channel), h('span', { class: 'row-subject', text: it.subject || '(제목 없음)' }), h('span', { class: 'row-time', text: relTime(it.createdAt), title: it.createdAt || '' })),
    shadowCard({ id: it.draftId, intent: it.intent, created_at: it.createdAt, original_body: it.body }, { question: it.question || '' }));
}

// ---------- 렌더: 상세 ----------
function renderDetail() {
  if (S.composing && $('#detail').contains(document.activeElement)) { S.renderDeferred = true; return; } // 포커스가 떠났으면 플래그가 남아도 그린다
  const root = $('#detail');
  if (!S.selectedId) { replace(root, h('div', { class: 'empty', text: '케이스를 선택하세요' })); return; }
  if (S.detailError) { replace(root, h('div', { class: 'error-box', text: `상세를 불러오지 못했습니다: ${S.detailError}` })); return; }
  if (!S.detail) { replace(root, h('div', { class: 'loading', text: '불러오는 중…' })); return; }
  const d = S.detail;
  const c = d.case;
  const anon = c.lifecycleStatus === 'anonymized';
  const actions = new Set(anon ? [] : d.actions || []); // 서버가 준 행동만 버튼으로 — 파기된 케이스는 없음
  const pd = d.pendingDraft;
  // 끝난 초안의 편집본·오류는 버린다(승인 요청이 진행 중인 초안은 실패하면 다시 대기로 돌아오니 남긴다)
  for (const id of Object.keys(S.draftEdit)) if ((!pd || pd.id !== id) && !S.inflight.has(`draft:${id}`)) delete S.draftEdit[id];
  if (S.compose && !actions.has(COMPOSE[S.compose].action)) S.compose = null;
  // 다시 그려도 입력 중인 칸의 포커스·커서를 되살린다(data-focus-key로 같은 칸을 찾는다)
  const active = document.activeElement;
  const focusKey = active && root.contains(active) ? active.dataset.focusKey : null;
  const caret = focusKey ? [active.selectionStart, active.selectionEnd, active.scrollTop] : null;
  // 새 케이스면 위(필드·결과)부터, 승인할 초안이 있으면 맨 아래(승인 패널)로. 다시 그릴 때는 맨 아래를 보던 중이면 맨 아래, 아니면 위치 유지.
  const fresh = root.dataset.caseId !== c.id;
  const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
  const decide = pd && ['approve', 'edit_approve', 'discard'].some((a) => actions.has(a));
  replace(root,
    h('div', { class: 'detail-top' },
      detailHead(c, d, actions),
      S.flash && S.flash.caseId === c.id ? flashBanner() : null,
      actions.has('resolve_sending') && d.sendingDraft ? sendCheckPanel(d.sendingDraft) : null),
    h('div', { class: 'detail-summary' }, fieldPanel(c), resultCard(c)),
    h('section', { class: 'detail-body', 'aria-label': '대화' },
      h('h3', { class: 'sec-title', text: '대화' }),
      conversation(d.timeline || []),
      d.shadowDraft ? shadowCard({ id: d.shadowDraft.id, original_body: d.shadowDraft.body }, { locked: !actions.has('rate_shadow') }) : null),
    decide ? approvalPanel(c, pd, actions) : null,
    S.compose ? composePanel(c) : null);
  root.dataset.caseId = c.id;
  if (fresh) root.scrollTop = decide ? root.scrollHeight : 0;
  else if (atBottom) root.scrollTop = root.scrollHeight;
  const el = focusKey && root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
  if (el) {
    el.focus({ preventScroll: true });
    if (el.setSelectionRange && caret[0] != null) { el.setSelectionRange(caret[0], caret[1]); el.scrollTop = caret[2]; }
  }
  if (S.detailFocus) focusDetail(); // 카드에서 연 상세 — 읽어 온 뒤 진행 단계로
}

function detailHead(c, d, actions) {
  const anon = c.lifecycleStatus === 'anonymized';
  const name = (d.contact && d.contact.current && d.contact.current.name && d.contact.current.name.value) || c.suppliedName;
  const email = (d.contact && d.contact.primaryEmail) || c.suppliedEmail;
  return h('div', { class: 'detail-head' },
    h('div', { class: 'detail-title' },
      h('span', { class: 'case-no', text: `#${c.caseNumber || shortId(c.id)}`, title: c.id }),
      h('h2', { class: 'detail-subject', text: c.subject || (anon ? '(원문 파기됨)' : '(제목 없음)') }),
      statusMark(c), priorityText(c.priority), anon ? purgedChip() : null),
    h('div', { class: 'detail-meta' },
      h('span', { class: 'name', text: name || (anon ? '(파기됨)' : '(이름 없음)') }),
      email ? h('span', { text: email }) : null,
      d.company && d.company.canonicalName ? h('span', { text: `· ${d.company.canonicalName}` }) : null),
    pathBar(c, actions),
    anon ? h('p', { class: 'purged-note', text: '원문을 파기했습니다 — 본문·주소·이름·메모를 비우고 상태·결과 기록만 남았습니다. 이 케이스에는 행동할 수 없습니다.' }) : actionBar(c, actions));
}
// Path: 신규 → 응대 중 → 사람 전담 → 보류 → 종결. 현재 단계 강조, 거쳐 온 단계는 완료 표시, 현재 단계 밑에 세부 상태.
// 단계는 버튼 — 고르고 「현재 상태로 변경」을 누르면 그 단계로 가는 행동 하나를 부른다(서버가 준 actions에 있을 때만, 버튼 줄과 같은 요청).
// 칸반에서 끌어 놓을 수 없을 때 키보드로 상태를 바꾸는 길도 이것이다.
const PATH = [['New', '신규'], ['Working', '응대 중'], ['Escalated', '사람 전담'], ['On Hold', '보류'], ['Closed', '종결']];
const PATH_MOVES = { Working: ['return'], Escalated: ['takeover', 'unhold'], 'On Hold': ['hold'], Closed: ['close'] };
const PATH_TO = { Working: '응대 중으로', Escalated: '사람 전담으로', 'On Hold': '보류로', Closed: '종결로' };
const MOVE_HINT = { return: '에이전트에게 반환합니다', takeover: '사람이 인수합니다', unhold: '보류를 풉니다', hold: '보류 메모를 적습니다', close: '종결 사유를 고릅니다' };
const PATH_WHY = {
  New: '신규로는 되돌릴 수 없습니다', Working: '사람 전담 케이스만 에이전트에게 반환할 수 있습니다',
  Approval: '승인 대기 칸에는 놓을 수 없습니다. 초안은 에이전트가 만들고, 승인은 상세의 승인 버튼으로 합니다',
  Escalated: '에이전트가 맡은 케이스를 인수하거나 보류를 풀 때만 바꿀 수 있습니다', 'On Hold': '사람 전담 케이스만 보류할 수 있습니다', Closed: '지금은 종결할 수 없습니다',
};
// 인수·종결은 승인 대기 초안을 보내지 않고 내린다(서버가 대기 초안을 미선택 처리) — 그 행동을 확정하기 전에 화면에 이 문장을 보인다.
const DRAFT_DROP = { takeover: '승인 대기 초안은 보내지 않고 미선택 처리됩니다', close: '승인 대기 초안은 보내지 않고 닫힙니다' };
const draftDrop = (move) => (S.detail && S.detail.pendingDraft ? DRAFT_DROP[move] || null : null);
/** Path의 한 단계를 골라 「현재 상태로 변경」 확인 패널을 연다. */
function pickStep(status) { S.pathTarget = status; renderDetail(); $('#path-mark')?.focus(); }
// 행동마다 서버가 내주는 현재 상태(서버 actionsFor와 같은 표) — 칸반이 끌기 전에 갈 수 있는 칸을 미리 보이는 데만 쓴다. 최종 판단은 상세의 actions.
const MOVE_FROM = { takeover: ['New', 'Working'], unhold: ['On Hold'], hold: ['Escalated'], return: ['Escalated'], close: ['New', 'Working', 'Escalated', 'On Hold'] };
const stepOf = (s) => PATH.findIndex(([k]) => k === s);
const moveTo = (status, actions) => (PATH_MOVES[status] || []).find((a) => actions.has(a)) || null;
const guessActions = (c) => new Set(c.lifecycleStatus === 'anonymized' ? [] : Object.keys(MOVE_FROM).filter((a) => MOVE_FROM[a].includes(c.status)));
const whyNot = (c, status) => (c.lifecycleStatus === 'anonymized' ? '파기된 케이스는 상태를 바꿀 수 없습니다' : c.status === 'Closed' ? '종결된 케이스는 상태를 바꿀 수 없습니다' : PATH_WHY[status]);
function pathBar(c, actions) {
  const cur = stepOf(c.status);
  const seen = new Set((c.statusHistory || []).map((x) => stepOf(x.toStatus)));
  if (S.pathTarget && !moveTo(S.pathTarget, actions)) S.pathTarget = null; // 그 사이 갈 수 없게 됐으면 고른 것을 푼다
  const steps = h('ol', { class: 'path', 'aria-label': '진행 단계 — 단계를 골라 상태를 바꿉니다' }, PATH.map(([status, name], i) => {
    const now = i === cur;
    const move = now ? null : moveTo(status, actions);
    const why = now ? `지금 상태입니다${c.subStatus ? ` (${label('subStatus', c.subStatus)})` : ''}` : move ? `${PATH_TO[status]} — ${MOVE_HINT[move]}${draftDrop(move) ? ` (${draftDrop(move)})` : ''}` : whyNot(c, status);
    const picked = S.pathTarget === status;
    return h('li', { class: `step${now ? ' current' : i < cur && seen.has(i) ? ' done' : ''}${picked ? ' picked' : ''}` },
      h('button', {
        type: 'button', class: 'step-btn', 'data-focus-key': `path:${status}`, title: why, 'aria-describedby': `path-why-${i}`,
        'aria-label': `${name} 단계${now && c.subStatus ? ` · ${label('subStatus', c.subStatus)}` : ''}`, // 버튼 줄의 「보류」·「종결」과 이름이 겹치지 않게
        'aria-current': now ? 'step' : null, 'aria-pressed': move ? String(picked) : null, 'aria-disabled': move ? null : 'true',
        onclick: () => { if (!move) return; S.pathTarget = picked ? null : status; renderDetail(); if (S.pathTarget) $('#path-mark')?.focus(); },
      }, h('span', { class: 'step-name', text: name }), now && c.subStatus ? h('span', { class: 'step-sub', text: label('subStatus', c.subStatus) }) : null),
      h('span', { id: `path-why-${i}`, class: 'sr-only', text: why }));
  }));
  const move = S.pathTarget && moveTo(S.pathTarget, actions);
  if (!move) return steps;
  return [steps, h('div', { class: 'path-panel', role: 'group', 'aria-label': '상태 변경' },
    h('span', { class: 'hint', text: `${PATH_TO[S.pathTarget]} 바꿉니다 — ${MOVE_HINT[move]}` }),
    draftDrop(move) ? h('p', { class: 'warn-text', text: draftDrop(move) }) : null,
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { const t = S.pathTarget; S.pathTarget = null; renderDetail(); focusStep(t); } }, '취소'),
    h('button', { type: 'button', id: 'path-mark', class: 'btn btn-primary btn-sm', disabled: S.inflight.has(`${move}:${c.id}`), onclick: () => markStep(c, move) }, '현재 상태로 변경'))];
}
/** Path의 「현재 상태로 변경」 — 입력이 없는 행동은 바로, 보류·종결은 버튼 줄과 같은 입력 칸(메모·사유)을 연다. */
function markStep(c, move) {
  const target = S.pathTarget; S.pathTarget = null;
  if (!NEEDS_INPUT.has(move)) { const rev = S.detail.revision; runAction(`${move}:${c.id}`, () => MOVE[move](c, rev)); focusStep(target); return; } // 다시 그려도 그 단계에 포커스가 남는다(data-focus-key)
  S.compose = null; toggleCompose(move); // 입력 칸을 열고 그 칸으로
}
// 상태를 바꾸는 행동 — 버튼 줄·Path·입력 칸·칸반이 모두 이 요청을 쓴다. rev = 지금 보고 있는 판(그 사이 바뀌었으면 서버가 409 stale)
const NEEDS_INPUT = new Set(['hold', 'close']); // 보류 메모·종결 사유
const MOVE = {
  takeover: (c) => post(`/api/cases/${c.id}/takeover`, { by: reviewer() }),
  unhold: (c, rev) => post(`/api/cases/${c.id}/unhold`, { by: reviewer(), expectedRevision: rev }),
  return: (c) => post(`/api/cases/${c.id}/return`, { by: reviewer() }),
  hold: (c, rev, x) => post(`/api/cases/${c.id}/hold`, { by: reviewer(), note: x.note, expectedRevision: rev }),
  close: (c, rev, x) => post(`/api/cases/${c.id}/close`, { by: reviewer(), reason: x.reason, detail: x.detail || undefined, expectedRevision: rev }),
};
function actionBar(c, actions) {
  const rev = S.detail.revision;
  const act = (kind) => {
    const key = `${kind}:${c.id}`;
    return h('button', { type: 'button', class: 'btn btn-sm', disabled: S.inflight.has(key), onclick: () => runAction(key, () => MOVE[kind](c, rev)) }, ACTION_LABEL[kind]);
  };
  const open = (mode) => h('button', {
    type: 'button', class: `btn btn-sm${S.compose === mode ? ' btn-primary' : mode === 'close' ? ' btn-danger' : ''}`,
    'aria-expanded': String(S.compose === mode), onclick: () => toggleCompose(mode),
  }, COMPOSE[mode].label);
  const btns = [
    // 승인 대기 초안이 있으면 인수는 바로 보내지 않고 Path 확인(초안이 미선택된다는 문장)을 거친다
    actions.has('takeover') ? (draftDrop('takeover') ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => pickStep('Escalated') }, ACTION_LABEL.takeover) : act('takeover')) : null,
    actions.has('human_reply') ? open('reply') : null,
    actions.has('note') ? open('note') : null,
    actions.has('hold') ? open('hold') : null,
    actions.has('unhold') ? act('unhold') : null,
    actions.has('return') ? act('return') : null,
    actions.has('close') ? open('close') : null,
  ].filter(Boolean);
  return btns.length ? h('div', { class: 'detail-actions' }, btns) : null;
}
function fieldPanel(c) {
  const rows = [
    ['접수 경로', label('origin', c.origin)], ['유형', label('caseType', c.caseType)], ['사유', label('caseReason', c.caseReason)],
    ['우선순위', label('priority', c.priority)], ['사업 라인', channelLabel(c.recordType)], ['담당', ownerText(c.owner)],
    ['문의 유형', c.intent ? label('intent', c.intent) : null],
    ['접수', fmtTime(c.audit && c.audit.createdAt)], ['최근 갱신', fmtTime(c.audit && c.audit.updatedAt)],
  ];
  return h('section', { class: 'card fields', 'aria-label': '케이스 필드' },
    h('dl', {}, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', {}, v == null || v === '' ? '–' : v)])));
}
function resultCard(c) {
  const r = c.resolution || {};
  const rows = [
    ['결과', label('outcome', r.outcome)],
    ['넘김 사유', label('reason', r.handoffReason)],
    ['다음 행동', r.nextAction],
    ['종결 사유', c.closeReason ? `${label('closeReason', c.closeReason)}${c.closeDetail ? ` — ${c.closeDetail}` : ''}` : null],
    ['보류', c.hold ? `${c.hold.note || ''}${c.hold.since ? ` (${fmtTime(c.hold.since)}부터)` : ''}` : null],
    ['문의 요약', c.summary],
  ].filter(([, v]) => v);
  return h('section', { class: 'card result', 'aria-label': '처리 결과' },
    h('div', { class: 'card-title', text: '처리 결과' }),
    rows.length ? h('dl', {}, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])) : h('p', { class: 'muted', text: '아직 결과가 없습니다' }));
}
function conversation(timeline) {
  if (!timeline.length) return h('div', { class: 'empty', text: '아직 기록이 없습니다' });
  let closed = false; // 종결 뒤 온 고객 메일 = 같은 케이스가 다시 열린 곳
  return [...timeline].sort((a, b) => String(a.at).localeCompare(String(b.at))).map((x) => {
    if (x.kind !== 'inbound') { const a = x.activity || {}; if (a.subtype === 'close' || a.subtype === 'auto_close') closed = true; return activityItem(a); }
    const again = closed; closed = false;
    return [again ? h('div', { class: 'activity' }, h('span', { class: 'time', text: fmtTime(x.at), title: x.at || '' }), h('b', { text: '시스템' }), h('span', { text: '종결 뒤 고객 회신 — 케이스 다시 열림' })) : null, inboundBubble(x)];
  });
}
function inboundBubble(x) {
  const auth = SENDER_AUTH[x.senderAuth];
  return h('div', { class: 'msg in' },
    h('div', { class: 'msg-head' }, h('b', { text: '고객' }), h('span', { text: x.sender || '' }),
      auth ? h('span', { class: `chip${auth[1] ? ` ${auth[1]}` : ''}`, text: auth[0] }) : null,
      h('span', { text: fmtTime(x.at), title: x.at || '' })),
    x.subject ? h('div', { class: 'msg-subject', text: x.subject }) : null,
    h('div', { class: x.body == null ? 'purged-text' : null, text: x.body ?? '(원문 파기됨)' }));
}
function activityItem(a) {
  if (a.type === 'email') {
    const human = a.subtype === 'human_reply';
    const who = human ? '사람 발신' : a.subtype === 'ack' ? '에이전트 접수 안내' : '에이전트 발신';
    return h('div', { class: `msg out${human ? ' by-human' : ''}` },
      h('div', { class: 'msg-head' }, h('b', { text: who }), human ? h('span', { text: actorText(a.actor) }) : null, h('span', { text: fmtTime(a.occurredAt), title: a.occurredAt || '' })),
      h('div', { class: a.body == null ? 'purged-text' : null, text: a.body ?? '(원문 파기됨)' }));
  }
  const m = a.meta || {};
  const tags = (m.editTags || []).map((t) => (EDIT_TAGS.find(([k]) => k === t) || [t, t])[1]);
  const extra = [m.handoffReason ? label('reason', m.handoffReason) : null, tags.length ? `수정 사유: ${tags.join(', ')}` : null, m.nextAction ? `다음 행동: ${m.nextAction}` : null].filter(Boolean).join(' · ');
  return h('div', { class: `activity${a.subtype === 'handoff' ? ' handoff' : ''}` },
    h('span', { class: 'time', text: fmtTime(a.occurredAt), title: a.occurredAt || '' }),
    h('b', { text: actorText(a.actor) }),
    h('span', { text: ACTIVITY_LABEL[a.subtype] || a.summary || a.subtype || '' }),
    extra ? h('span', { class: 'muted', text: extra }) : null,
    a.body ? h('span', { class: 'note-text', text: a.body }) : null);
}
/**
 * 섀도 초안 평가 카드 — 케이스 상세와 섀도 평가 목록이 같이 쓴다.
 * question이 있으면 목록용(고객 질문을 함께 보이고 안내는 목록 머리에 한 번), locked면 평가 버튼 없음.
 */
function shadowCard(dr, { question, locked } = {}) {
  const queued = question !== undefined;
  const err = h('p', { class: 'form-error', hidden: true });
  const rate = async (r) => {
    try { await post(`/api/drafts/${dr.id}/rate`, { by: reviewer(), rating: r }); await Promise.all([afterAction(), S.shadow ? loadShadow() : null]); }
    catch (e) { err.textContent = humanError(e); err.hidden = false; }
  };
  return h('div', { class: 'card shadow-card' },
    h('div', { class: 'card-title' }, h('span', { class: 'chip dr-SHADOW', text: '섀도 초안' }), intentChip(dr.intent),
      h('span', { class: 'time', text: fmtTime(dr.created_at) })),
    queued || locked ? null : h('p', { class: 'shadow-guide', text: SHADOW_GUIDE }),
    queued ? [h('div', { class: 'hist-label', text: '고객 질문' }), h('div', { class: 'hist-body question', text: question || '(본문 없음)' }), h('div', { class: 'hist-label', text: '에이전트 초안' })] : null,
    h('div', { class: 'hist-body', text: dr.original_body || '' }),
    locked ? null : h('div', { class: 'rate-row' }, '그대로 보내도 되는가:',
      Object.entries(RATING_LABEL).map(([k, t]) => h('button', { type: 'button', title: RATING_HINT[k], class: `btn btn-sm${k === 'critical' ? ' btn-danger' : ''}`, onclick: () => rate(k) }, t))),
    err);
}
function sendCheckPanel(sd) {
  const err = h('p', { class: 'form-error', hidden: true });
  const resolve = async (outcome) => {
    try { await post(`/api/drafts/${sd.id}/resolve-sending`, { by: reviewer(), outcome }); await afterAction(); }
    catch (e) { err.textContent = humanError(e); err.hidden = false; }
  };
  return h('section', { class: 'send-check', role: 'alert' },
    h('b', { text: '발송 확인 필요' }),
    h('span', { text: ' 승인된 메일이 발송 중 상태로 멈췄습니다. 메일함에서 실제로 나갔는지 확인하세요.' }),
    h('div', { class: 'approval-actions' },
      h('button', { type: 'button', class: 'btn btn-sm btn-ok', onclick: () => resolve('sent') }, '발송됨으로 처리'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => resolve('pending') }, '대기로 되돌리기')),
    err);
}

// ---------- 입력 칸: 직접 답장·메모·보류·종결 ----------
function toggleCompose(mode) {
  S.compose = S.compose === mode ? null : mode;
  renderDetail();
  if (S.compose) $(S.compose === 'close' ? '#close-reason' : '#compose-text')?.focus();
}
function composePanel(c) {
  const mode = S.compose; const m = COMPOSE[mode];
  const rev = S.detail.revision;
  const dk = `${c.id}:${mode}`;
  const draft = S.composeDraft[dk] || (S.composeDraft[dk] = { text: '', reason: '', error: null });
  const ta = h('textarea', { id: 'compose-text', 'data-focus-key': `compose:${mode}`, placeholder: m.placeholder, 'aria-label': `${m.label} 내용`, maxlength: m.max ? String(m.max) : null });
  ta.value = draft.text;
  ta.addEventListener('input', () => { draft.text = ta.value; });
  let reason = null;
  if (mode === 'close') {
    reason = h('select', { id: 'close-reason', 'data-focus-key': 'close-reason', 'aria-label': '종결 사유', required: true },
      h('option', { value: '', text: '종결 사유 선택' }), Object.entries(LABELS.closeReason).map(([v, t]) => h('option', { value: v, text: t })));
    reason.value = draft.reason;
    reason.addEventListener('change', () => { draft.reason = reason.value; });
  }
  const err = h('p', { class: 'form-error', role: 'alert', hidden: !draft.error, text: draft.error || '' });
  const key = `compose:${c.id}`;
  const btnSubmit = h('button', { type: 'button', class: `btn btn-sm ${m.cls}`, disabled: S.inflight.has(key) }, m.submit);
  btnSubmit.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (mode === 'close' && !draft.reason) { reason.focus(); return; }
    if (mode === 'close' && draft.reason === 'other' && !text) { draft.error = '기타를 고르면 상세를 적어 주세요.'; renderDetail(); ta.focus(); return; }
    if (mode !== 'close' && !text) { ta.focus(); return; }
    if (S.inflight.has(key)) return;
    draft.error = null; S.inflight.add(key); renderDetail();
    try {
      if (mode === 'reply') await post(`/api/cases/${c.id}/human-reply`, { by: reviewer(), body: text });
      else if (mode === 'note') await post(`/api/cases/${c.id}/note`, { by: reviewer(), text });
      else await MOVE[mode](c, rev, { note: text, reason: draft.reason, detail: text });
      delete S.composeDraft[dk]; // 보낸 뒤에만 지운다
      S.compose = null;
      await afterAction();
    } catch (e) {
      if (e.status === 409) { setFlash(c.id, h('span', { text: humanError(e) })); await afterAction(); } // 케이스가 바뀌었다 — 다시 읽고 배너로 알린다(입력은 남긴다)
      else draft.error = humanError(e);
    } finally { S.inflight.delete(key); renderDetail(); }
  });
  const hint = mode === 'reply' ? `담당자 이름으로 발송: ${reviewer() || '(검토자 이름 필요)'}` : m.hint;
  return h('section', { class: `compose compose-${mode}`, 'aria-label': m.label },
    reason, ta, err,
    mode === 'close' && draftDrop('close') ? h('p', { class: 'warn-text', text: draftDrop('close') }) : null,
    h('div', { class: 'compose-actions' },
      h('span', { class: 'hint', text: hint }),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { S.compose = null; renderDetail(); } }, '취소'),
      btnSubmit));
}

// ---------- 승인 패널 ----------
function approvalPanel(c, dr, actions) {
  const original = dr.body || '';
  const edit = S.draftEdit[dr.id] || (S.draftEdit[dr.id] = { body: original, tags: new Set(), error: null });
  const key = `draft:${dr.id}`;
  const facts = Object.keys(dr.kbPassages || {});
  // 승인 실패(422 guard 등)는 edit.error에 남긴다 — guard 실패 뒤 서버가 보내는 draft.updated로 다시 그려도 사라지지 않게.
  const err = h('p', { class: 'form-error', role: 'alert', hidden: !edit.error }, edit.error ? approvalError(edit.error) : null);
  const ta = h('textarea', { 'aria-label': '초안 본문', spellcheck: 'false', 'data-focus-key': `draft:${dr.id}`, readonly: !actions.has('edit_approve') });
  ta.value = edit.body;
  const btnApprove = actions.has('approve') ? h('button', { type: 'button', class: 'btn btn-sm btn-ok' }, '승인 (원문 그대로 발송)') : null;
  const btnEdit = actions.has('edit_approve') ? h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, '수정 후 승인') : null;
  const btnDiscard = actions.has('discard') ? h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, '폐기') : null;
  const hint = h('span', { class: 'hint' });
  const sync = () => {
    const changed = ta.value !== original;
    const busy = S.inflight.has(key);
    if (btnApprove) btnApprove.disabled = busy || changed;
    if (btnEdit) btnEdit.disabled = busy || !changed;
    if (btnDiscard) btnDiscard.disabled = busy;
    hint.textContent = changed ? '본문이 바뀌었습니다 — 수정 후 승인으로 발송됩니다' : `발송 시 인사·맺음·AI 고지는 서버 템플릿이 붙입니다 · 승인자 ${reviewer() || '(검토자 이름 필요)'}`;
  };
  ta.addEventListener('input', () => { edit.body = ta.value; sync(); });
  sync();
  const tagBoxes = btnEdit ? h('div', { class: 'edit-tags' }, '수정 사유:', EDIT_TAGS.map(([k, text]) => {
    const cb = h('input', { type: 'checkbox', value: k });
    cb.checked = edit.tags.has(k);
    cb.addEventListener('change', () => { if (cb.checked) edit.tags.add(k); else edit.tags.delete(k); });
    return h('label', {}, cb, text);
  })) : null;
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
  btnApprove?.addEventListener('click', () => send('approve', { by: reviewer() }));
  btnEdit?.addEventListener('click', () => send('approve', { by: reviewer(), finalBody: ta.value, editTags: [...edit.tags] }));
  btnDiscard?.addEventListener('click', () => send('discard', { by: reviewer() }));
  return h('section', { class: 'approval', 'aria-label': '승인 대기 초안' },
    h('div', { class: 'approval-head' },
      h('span', { class: 'chip dr-PENDING', text: '승인 대기 초안' }),
      intentChip(dr.intent),
      dr.action === 'ANSWER_AND_HANDOFF' ? h('span', { class: 'warn-text', text: '발송 후 사람 전담으로 전환됩니다' }) : null),
    facts.length ? h('div', { class: 'facts' }, '근거(KB):', facts.map((f) => h('span', { class: 'chip fact', text: f }))) : h('div', { class: 'facts', text: '근거(KB): 없음 — 사실 주장이 있으면 확인하세요' }),
    facts.length ? h('details', { class: 'kb-passages' }, h('summary', { text: '근거 KB 원문 보기' }),
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
  purged: '원문을 파기한 케이스라 처리할 수 없습니다.',
  not_escalated: '사람이 맡은 케이스만 보류할 수 있습니다.',
  already_held: '이미 보류 중인 케이스입니다.',
  not_held: '보류 중인 케이스가 아닙니다.',
  already_closed: '이미 종결된 케이스입니다.',
  bad_reason: '종결 사유를 고르세요.',
  'detail 필요': '기타를 고르면 상세를 적어 주세요.',
  'note 필요': '보류 메모를 적어 주세요.',
};
// 명령(보류·보류 해제·종결)의 expectedRevision이 지금 판과 다르다 — 초안의 stale(본문에 revision 없음)과 구별한다.
const REVISION_STALE = '그 사이 케이스가 바뀌었습니다. 최신 내용을 다시 읽었습니다 — 확인한 뒤 다시 시도하세요.';
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
  if (code === 'stale' && e.data.revision != null) return REVISION_STALE;
  if (CONFLICT_TEXT[code]) return CONFLICT_TEXT[code];
  if (e.status === 401) return '인증이 필요합니다 — 프록시를 통해 접속하세요';
  if (e.status === 422 && e.data && e.data.violations) return `검사에 걸렸습니다: ${e.data.violations.map((v) => `${label('reason', v.code)}${v.quote ? ` "${v.quote}"` : ''}`).join(', ')}`;
  if (e.status === 400 && e.data && e.data.field) return `필터 값이 잘못됐습니다: ${e.data.field}`;
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
  catch (e) { setFlash(S.selectedId, h('span', { text: humanError(e) })); if (e.status === 409) await afterAction(); }
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

// ---------- 운영 리포트 ----------
const fmtN = (v) => (v == null ? '–' : Number(v).toLocaleString('ko-KR'));
const fmtUsd = (v) => (v == null ? '–' : `$${Number(v).toFixed(v < 1 ? 4 : 2)}`);
const fmtMs = (v) => (v == null ? '–' : `${fmtN(v)}ms`);
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const NO_PRICE = '단가 미설정 — LLM_PRICE_INPUT_PER_MTOK·LLM_PRICE_OUTPUT_PER_MTOK를 넣으면 계산합니다';
const stat = (text, value, title) => h('div', { class: 'stat', title: title || text }, h('span', { class: 'kpi-value', text: value }), h('span', { class: 'kpi-label', text }));
const cost = (text, v, title) => stat(text, fmtUsd(v), v == null ? NO_PRICE : title);
/** cols: [머리글, 행 → 칸 내용, 숫자 칸 여부] */
function table(cols, rows, rowClass) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'report-table' },
    h('thead', {}, h('tr', {}, cols.map(([t, , num]) => h('th', { class: num ? 'num' : null, text: t })))),
    h('tbody', {}, rows.length
      ? rows.map((r) => h('tr', { class: rowClass ? rowClass(r) : null }, cols.map(([, f, num]) => h('td', { class: num ? 'num' : null }, f(r)))))
      : h('tr', {}, h('td', { class: 'empty-cell', colspan: String(cols.length), text: '아직 기록이 없습니다' })))));
}
function budgetRow(b) {
  if (b.limit == null) return h('p', { class: 'budget', text: `일일 토큰 예산 없음(무제한) · 오늘 ${fmtN(b.used)} 토큰` });
  const max = Math.max(b.limit, 1);
  const out = b.used >= b.limit;
  return h('div', { class: 'budget' },
    h('span', { text: `일일 토큰 예산 ${fmtN(b.used)} / ${fmtN(b.limit)} (${Math.min(100, Math.round((b.used / max) * 100))}%)` }),
    h('meter', { min: '0', max: String(max), low: String(max * 0.8), high: String(max * 0.95), optimum: '0', value: String(Math.min(b.used, max)), 'aria-label': '일일 토큰 예산 사용률' }),
    out ? h('span', { class: 'marker', text: '소진 — 오늘은 LLM을 부르지 않습니다' }) : null);
}
// 업무 대체 — 서버 report.workload와 같은 정의(docs/spec.md 부록 G)
const WORKLOAD_HELP = '업무 대체율 = 에이전트 처리 ÷ 전체 단위(고객 메시지 1통 · 나간 답장 1통 = 1단위, 내부 메모·접수 안내 제외). 1000건 중 400건을 에이전트가 처리했으면 40%';
const WORKLOAD_BUCKETS = [
  ['agent', '에이전트 처리', '사람 손 없이 끝남 — 승인 없이 나간 자동 답변(L2), 자동 회신·사내 발신·감사 인사·무시 대상'],
  ['assisted', '에이전트 보조', '접수·답장·검수·인계 Agent가 분류·초안·브리핑을 내고 사람이 결정 — 승인·수정 승인한 답장, 넘김, 승인 대기 초안. 1차 거르기에서 바로 넘긴 문의는 브리핑이 있어도 사람 처리로 센다'],
  ['human', '사람 처리', '에이전트 일 없음 — 규칙에 걸려 바로 사람에게 넘김, 사람이 맡은 케이스에 온 메시지, 사람이 직접 쓴 답장'],
];
const share = (r, k) => `${fmtN(r[k])} (${pct(r[`${k}Rate`])})`;
const ackText = (r) => `접수 안내 ${fmtN(r.ackCount)}통 (단위 제외)`; // 넘김 접수 안내는 답장이 아니라 단위에 넣지 않는다
const pendingText = (r) => `판단 대기 ${fmtN(r.pendingCount)}통 (단위 제외)`; // 아직 판단 전인 수신 — 끝나면 단위에 들어간다
function workloadSection(w) {
  return h('section', { class: 'report-sec', 'aria-label': '업무 대체' },
    h('div', { class: 'report-sec-head' }, h('h4', { text: '업무 대체', title: WORKLOAD_HELP }),
      h('span', { class: 'hint', title: WORKLOAD_HELP, text: '메시지 1통 = 1단위 · 누적 — 1000건 중 400건을 에이전트가 처리했으면 40%' }),
      h('span', { class: 'hint', text: `${ackText(w)} · ${pendingText(w)}` })),
    h('div', { class: 'stats' }, stat('전체 단위', fmtN(w.total), `고객 메시지 ${fmtN(w.byDirection?.in?.total)} · 나간 답장 ${fmtN(w.byDirection?.out?.total)}`),
      WORKLOAD_BUCKETS.map(([k, text, title]) => stat(text, share(w, k), title))),
    table([['채널', (r) => channelBadge(r.channel)], ['전체', (r) => fmtN(r.total), 1], ...WORKLOAD_BUCKETS.map(([k, text]) => [text, (r) => share(r, k), 1]),
      ['접수 안내(단위 제외)', (r) => `${fmtN(r.ackCount)}통`, 1]], w.byChannel || []));
}
function renderReport() {
  const body = $('#report-body');
  $('#report-at').textContent = S.reportAt ? `${clock(S.reportAt)} 기준` : '';
  const wl = S.workload ? workloadSection(S.workload) : null; // 통계 주기로 갱신 — 리포트 본문과 따로 온다
  if (S.reportError) { replace(body, wl, h('div', { class: 'error-box', text: `리포트를 불러오지 못했습니다: ${S.reportError}` })); return; }
  if (!S.report) { replace(body, wl, h('div', { class: 'loading', text: '불러오는 중…' })); return; }
  const llm = S.report.llm || {}, promo = S.report.promotion || {};
  const t = llm.today || {}, pc = llm.perCase || {}, tot = llm.total || {}, c = promo.criteria || {};
  replace(body, wl,
    h('section', { class: 'report-sec', 'aria-label': 'LLM 사용량' },
      h('div', { class: 'report-sec-head' }, h('h4', { text: 'LLM 사용량 · 오늘' }), h('span', { class: 'hint', text: 'UTC 기준 — 한국 시간 09:00에 초기화' })),
      h('div', { class: 'stats' }, stat('호출', fmtN(t.calls)), stat('입력 토큰', fmtN(t.inputTokens)), stat('출력 토큰', fmtN(t.outputTokens)), cost('비용', t.costUsd)),
      budgetRow(llm.budget || {}),
      h('div', { class: 'report-sec-head' }, h('h4', { text: '케이스당 평균' }), h('span', { class: 'hint', text: `LLM을 부른 케이스 ${fmtN(pc.cases)}건 누적` })),
      h('div', { class: 'stats' }, stat('토큰', fmtN(pc.avgTokens)), cost('비용', pc.avgCostUsd), stat('LLM 지연', fmtMs(pc.avgLatencyMs), '케이스 하나에서 부른 LLM 호출 지연의 합'), stat('누적 호출', fmtN(tot.calls), `누적 토큰 ${fmtN((tot.inputTokens || 0) + (tot.outputTokens || 0))} · 비용 ${fmtUsd(tot.costUsd)}`)),
      table([
        ['에이전트', (r) => AGENT_LABEL[r.agent] || r.agent],
        ['호출', (r) => fmtN(r.calls), 1], ['입력 토큰', (r) => fmtN(r.inputTokens), 1], ['출력 토큰', (r) => fmtN(r.outputTokens), 1],
        ['실패', (r) => h('span', { class: r.failures ? 'bad' : null, text: fmtN(r.failures) }), 1],
        ['평균 지연', (r) => fmtMs(r.avgLatencyMs), 1],
        ['비용', (r) => h('span', { title: r.costUsd == null ? NO_PRICE : null, text: fmtUsd(r.costUsd) }), 1],
      ], llm.byAgent || []),
      (llm.models || []).length ? h('div', { class: 'facts' }, '모델:', llm.models.map((m) => h('span', { class: 'chip fact', text: `${m.provider}/${m.model || '?'} · ${fmtN(m.calls)}회` }))) : null),
    h('section', { class: 'report-sec', 'aria-label': '문의 유형별 승격 지표' },
      h('div', { class: 'report-sec-head' }, h('h4', { text: '문의 유형별 승격 지표 (L0→L1)' }),
        h('span', { class: 'hint', text: `기준: 검토 ${c.minReviewed ?? '–'}건 이상 · 무수정 ${pct(c.minNoEditRate)} 이상 · 치명 오류 ${c.maxCritical ?? '–'}건 이하` }),
        h('a', { class: 'btn btn-sm', href: '/api/report/promotion.csv', download: true }, 'CSV 내보내기')),
      table([
        ['채널', (r) => channelBadge(r.channel)],
        ['문의 유형', (r) => h('span', { title: r.intent, text: label('intent', r.intent) })],
        ['등급', (r) => r.level || '–'],
        ['검토', (r) => fmtN(r.reviewed), 1], ['무수정', (r) => pct(r.approvedNoEditRate), 1],
        ['치명', (r) => h('span', { class: r.criticalCount ? 'bad' : null, text: fmtN(r.criticalCount) }), 1],
        ['승격', (r) => h('span', { class: r.eligible ? 'ok-text' : 'muted', text: r.eligible ? '승격 가능' : '기준 미달' })],
      ], promo.rows || [], (r) => (r.eligible ? 'ok' : null))));
}

// ---------- SSE: 바뀌었다는 신호만 받고 다시 읽는다 ----------
function setSse(state) {
  const dot = $('#sse-dot'), txt = $('#sse-text');
  dot.className = `dot ${state}`;
  txt.textContent = state === 'open' ? '실시간' : state === 'error' ? `연결 끊김 · ${Math.round(S.backoff / 1000)}초 후 재시도` : '연결 중';
}
function connectSSE() {
  if (S.es) { S.es.close(); S.es = null; }
  if (typeof EventSource === 'undefined') { setSse('error'); return; }
  setSse('connecting');
  const es = new EventSource('/api/events');
  S.es = es;
  es.onopen = () => { S.backoff = 1000; setSse('open'); };
  const data = (e) => parseJson(e.data, {}) || {};
  // 연결(재연결 포함) 직후 서버가 hello를 보낸다 — 끊긴 동안 놓친 변화를 다시 읽는다.
  es.addEventListener('hello', (e) => {
    const d = data(e);
    if (d.stats) { S.stats = d.stats; renderStats(); }
    if (d.status) { S.agent = d.status; renderAgent(); }
    reloadList();
    if (S.selectedId) reloadDetail();
  });
  es.onerror = () => {
    es.close(); if (S.es !== es) return;
    S.es = null; setSse('error');
    setTimeout(connectSSE, S.backoff);
    S.backoff = Math.min(S.backoff * 2, 30000);
  };
  for (const name of RELOAD_ON) es.addEventListener(name, (e) => onCaseEvent(name, data(e)));
  es.addEventListener('stats.updated', (e) => { S.stats = data(e); renderStats(); });
}
const reloadAgent = debounce(loadAgent, 300); // 회전이 끝나면 케이스 이벤트가 온다 — 「에이전트 응대 중」 표시를 5초 폴링보다 먼저 내린다
function onCaseEvent(name, ev) {
  reloadList(); reloadAgent();
  if (S.selectedId && (!ev.caseId || ev.caseId === S.selectedId)) reloadDetail();
  if (S.view === 'shadow' && (name === 'draft.created' || name === 'draft.updated')) refreshShadow(); // 열려 있을 때만 — 새 섀도 초안·다른 검토자의 평가
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
    if (!S.items.length || S.view !== 'cases') return;
    const idx = S.items.findIndex((c) => c.id === S.selectedId);
    const next = e.key === 'j' ? Math.min(S.items.length - 1, idx + 1) : Math.max(0, idx - 1);
    const c = S.items[next];
    if (c) { selectCase(c.id); $(`#case-rows tr[data-id="${CSS.escape(c.id)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  });
}

// ---------- 초기화 ----------
function setupReviewer() {
  const input = $('#reviewer');
  try { input.value = localStorage.getItem('cs-agent.reviewer') || ''; } catch { /* storage unavailable */ }
  input.addEventListener('change', () => { try { localStorage.setItem('cs-agent.reviewer', input.value.trim()); } catch { /* ignore */ } });
}
function setupDetailIme() {
  const root = $('#detail');
  root.addEventListener('compositionstart', () => { S.composing = true; });
  // 마지막 input이 compositionend 뒤에 오는 브라우저(Safari)가 있어 한 틱 미룬다
  root.addEventListener('compositionend', () => { S.composing = false; if (S.renderDeferred) { S.renderDeferred = false; setTimeout(renderDetail, 0); } });
}
function setupFilters() {
  for (const [key] of FILTERS) {
    const sel = $(`#f-${key}`);
    sel.addEventListener('change', () => { setFilter({ [key]: sel.value }); if (key === 'recordType' && S.shadow) loadShadow(); });
  }
  $('#search').addEventListener('input', debounce((e) => setFilter({ q: e.target.value.trim().slice(0, 100) }), 300));
  $('#status-tabs').addEventListener('keydown', onTabKey);
}
function init() {
  setupReviewer(); setupInject(); setupKeys(); setupDetailIme(); setupFilters();
  try { S.board = localStorage.getItem('cs-agent.board') === 'kanban' ? 'kanban' : 'list'; } catch { S.board = 'list'; }
  $('#view-list').addEventListener('click', () => setBoard('list'));
  $('#view-kanban').addEventListener('click', () => setBoard('kanban'));
  applyView();
  $('#quick-shadow').addEventListener('click', toggleShadowView);
  $('#btn-refresh').addEventListener('click', () => { loadCases(); loadStats(); if (S.shadow) loadShadow(); });
  $('#btn-more').addEventListener('click', () => { S.limit = Math.min(S.limit + LIST_PAGE, LIST_MAX); loadCases(); });
  $('#btn-report').addEventListener('click', () => { $('#report-dialog').showModal(); loadReport(); });
  $('#report-refresh').addEventListener('click', loadReport);
  $('#report-close').addEventListener('click', () => $('#report-dialog').close());
  renderTabs(); renderFilterOptions(); renderKpis(); renderDetail();
  loadHealth(); loadPolicy().then(() => { loadCases(); loadShadow(); }); loadStats(); loadAgent(); loadReport();
  connectSSE();
  setInterval(loadAgent, 5000);
  setInterval(loadStats, 30000);
  setInterval(loadWorkload, 30000);
  setInterval(() => { if (S.items.length) renderList(); }, 60000); // 상대 시간 갱신
}
document.addEventListener('DOMContentLoaded', init);
