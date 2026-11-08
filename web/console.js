'use strict';
// 지식·정책 화면 — app.js 다음에 로드한다. app.js의 h, api, post, humanError, clear, $, reviewer, S를 그대로 쓴다.
// 모든 텍스트는 textContent로 넣는다(LLM이 만든 KB도 글자로만 보인다).
(() => {
  const CH_RE = /^[a-z][a-z0-9_]{1,39}$/;
  const RESERVED = ['ack', 'ignore', 'injection', 'human_request'];
  const REQUIRED_REASONS = ['injection', 'legal_threat', 'human_request', 'sender_unverified'];
  const SYSTEM_REASONS = ['unclear', 'out_of_knowledge', 'low_confidence', 'no_progress', 'round_limit', 'guard_failed', 'llm_error', 'internal_error', 'language_unsupported', 'discarded'];
  const LEVELS = ['L0', 'L1', 'L2', 'H'];
  const UPLOAD_MAX = 10 * 1024 * 1024;
  const TABS = [['channels', '채널'], ['kb', 'KB'], ['policy', '정책'], ['convert', '매뉴얼 변환'], ['history', '기록']];

  const ERR_TEXT = {
    console_write_untrusted: '이 접속 경로로는 편집할 수 없습니다.',
    not_admin: '편집 권한이 없습니다. 관리자 목록(ADMIN_USERS)에 이름이 있어야 합니다.',
    stale: '그 사이 다른 곳에서 먼저 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.',
    hash_collision: '같은 번호의 다른 내용이 이미 있어 게시하지 않았습니다. 잠시 뒤 다시 시도하세요.',
    history_mismatch: '기록과 저장된 내용이 맞지 않아 이 버전은 쓸 수 없습니다.',
    ko_first: '영어 KB는 한국어 KB를 먼저 게시한 뒤에 올릴 수 있습니다.',
    draft_busy: '변환이 진행 중이라 지금은 저장하거나 게시할 수 없습니다.',
    no_channel: '이 채널을 찾을 수 없습니다.',
    bad_channel: '채널 이름이 올바르지 않습니다.',
    bad_lang: '언어 값이 올바르지 않습니다.',
    actions_readonly: '"액션" 열은 지금 읽기만 됩니다. 값이 현재와 달라 게시하지 않았습니다.',
    convert_busy: '다른 변환이 진행 중입니다. 끝난 뒤 다시 시작하세요.',
    budget_headroom: '오늘 쓸 수 있는 AI 사용량 여유가 부족해 변환을 시작하지 않았습니다.',
    job_too_large: '한 번에 변환할 수 있는 양을 넘습니다. 파일을 나눠 올려 주세요.',
    too_large: '파일이 10MB를 넘습니다. 나눠서 올려 주세요.',
    too_large_source: '문서 글자 수가 한도(12만 자)를 넘습니다. 나눠서 올려 주세요.',
    pdf_too_large: '쪽을 나눠 PDF로 저장해 따로 올려 주세요.',
    unsupported_format: '지원하지 않는 형식입니다.',
    already_default: '이미 이미지 기본값입니다.',
    no_change: '해당 기록을 찾을 수 없습니다.',
    draft_closed: '이미 게시했거나 폐기한 초안입니다.',
    no_draft: '초안을 찾을 수 없습니다.',
    bad_raw: 'KB 원문 형식이 올바르지 않습니다.',
    bad_file: '파일을 읽을 수 없습니다. 다른 형식으로 저장해 다시 올려 주세요.',
    bad_encoding: '글자 인코딩을 읽을 수 없습니다. UTF-8로 저장해 다시 올려 주세요.',
    count_unavailable: '분량을 재지 못해 변환을 시작하지 않았습니다. 잠시 뒤 다시 시도하세요.',
    kb_injection: '안내 규칙을 바꾸려는 문장이 들어 있어 게시할 수 없습니다. 해당 절을 고치거나 지우세요.',
  };
  const CODE_TEXT = {
    kb_injection: ERR_TEXT.kb_injection,
    duplicate_key: '절 key가 겹칩니다.',
    missing_source: '출처가 없습니다.',
    too_long: '절 본문이 너무 깁니다(1,500자 이하).',
    forbidden_word: '금지어가 들어 있습니다.',
    contact: '연락처로 보이는 내용이 있습니다. 확인하세요.',
  };
  const RULE_TEXT = { structure: '구조가 맞지 않습니다', fixed: '고정된 값은 바꿀 수 없습니다', stricter: '기준보다 느슨하게 할 수 없습니다' };
  const WIDEN_RULES = [
    [/^maxLevel/, '자동 발송 최대 등급을 올립니다.'],
    [/^shadow/, '섀도 모드를 꺼서 고객에게 실제로 발송되게 합니다.'],
    [/^languages/, '자동 응대 언어를 늘립니다.'],
    [/\.level$/, '이 intent를 자동 발송(L2)으로 올립니다.'],
    [/\.description$/, '설명이 바뀌어 문의가 이 intent로 분류되는 범위가 달라질 수 있습니다.'],
    [/\.kb/, '자동 발송이 근거로 쓸 수 있는 KB 절이 늘어납니다.'],
    [/^answerable/, '자동 발송할 수 있는 넘김 사유를 늘립니다.'],
    [/^handoffReasons/, '사람에게 넘기던 사유를 빼서 넘김이 줄어듭니다.'],
    [/^thresholds/, '자동 발송 기준을 느슨하게 합니다.'],
    [/^guard/, '금지어나 허용 범위를 느슨하게 합니다.'],
    [/^intents/, '지운 intent의 문의가 다른 intent로 분류될 수 있습니다.'],
  ];

  // ---------- 상태 ----------
  const C = { data: null, error: null, tab: 'channels', channel: null, lang: 'ko', packs: {}, seq: 0, draftId: null, timer: null, deb: null, histMsg: null };

  // ---------- 작은 도구 ----------
  const ctl = (tag, label, attrs) => h(tag, { ...attrs, 'aria-label': label });
  const field = (text, control, hint) => h('label', { class: 'cf' }, h('span', { text }), control, hint ? h('small', { class: 'hint', text: hint }) : null);
  const check = (text, input) => h('label', { class: 'check' }, input, h('span', { text }));
  const btn = (text, onclick, cls = '', attrs = {}) => h('button', { type: 'button', class: `btn ${cls}`.trim(), onclick, ...attrs, text });
  const chip = (text, cls = '') => h('span', { class: `chip ${cls}`.trim(), text });
  const pct = (v) => (v == null ? '–' : `${Math.round(v <= 1 ? v * 100 : v)}%`);
  const short = (v) => { const t = v === undefined ? '(없음)' : typeof v === 'string' ? v : JSON.stringify(v); return t.length > 90 ? `${t.slice(0, 90)}…` : t; };
  const nm = (x) => (typeof x === 'string' ? x : (x && (x.intent || x.member || x.name || x.key)) || '');
  const memberName = (m) => (m === '@ack' ? '접수 안내 자동 발송' : m);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isAdmin = () => !!(C.data && C.data.admin);
  const body = () => $('#console-body');
  const stopTimers = () => { clearTimeout(C.timer); clearTimeout(C.deb); C.timer = null; C.deb = null; };

  async function get(path, params = {}) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.set(k, v);
    const by = reviewer();
    if (by) u.set('by', by); // 프록시 헤더가 없는 접속에서는 검토자 이름이 사용자 확인에 쓰인다
    const q = u.toString();
    return api(q ? `${path}?${q}` : path);
  }
  const send = (path, payload) => post(path, { ...payload, by: reviewer() });
  const probe = (path, payload) => api(path, { method: 'POST', body: payload }); // 쓰지 않는 검사 요청

  function errList(items) {
    const list = (items || []).map((x) => {
      if (typeof x === 'string') return { where: '', text: CODE_TEXT[x] || x };
      const where = x.path || x.key || x.intent || (x.line != null ? `${x.line}줄` : '');
      const code = x.code || x.rule;
      return { where, text: CODE_TEXT[code] || x.msg || x.message || RULE_TEXT[code] || code || '' };
    });
    return list;
  }
  function problemList(items, cls = 'form-error') {
    const rows = errList(items);
    if (!rows.length) return null;
    return h('ul', { class: `plist ${cls}` }, rows.map((r) => h('li', {}, r.where ? h('code', { text: r.where }) : null, r.where ? ' — ' : '', r.text)));
  }
  function errText(e) {
    const d = e && e.data;
    const code = d && (typeof d.error === 'string' ? d.error : null);
    if (code === 'unsupported_format' && d.hint) return d.hint;
    if (ERR_TEXT[code]) return ERR_TEXT[code];
    if (e && ERR_TEXT[e.message]) return ERR_TEXT[e.message];
    return humanError(e);
  }
  function errBox(e) {
    const d = e && e.data;
    const detail = d && (problemList(d.errors) || problemList(d.problems));
    return h('div', { class: 'form-error', role: 'alert' }, h('span', { text: errText(e) }), detail);
  }

  // ---------- 틀 ----------
  function build() {
    const dlg = h('dialog', { id: 'console-dialog', class: 'console-dialog', 'aria-labelledby': 'console-title' },
      h('div', { class: 'version-head' },
        h('h3', { id: 'console-title', text: '지식·정책' }),
        h('span', { class: 'hint', id: 'console-perm', role: 'status' }),
        btn('새로고침', () => reload(), 'btn-ghost btn-sm'),
        btn('닫기', () => dlg.close(), 'btn-ghost btn-sm', { id: 'console-close' })),
      h('div', { class: 'tabs', id: 'console-tabs', role: 'tablist', 'aria-label': '지식·정책 메뉴' }),
      h('div', { class: 'console-bar', id: 'console-bar' }),
      h('div', { class: 'console-body', id: 'console-body', tabindex: '-1' }));
    dlg.addEventListener('close', stopTimers);
    document.body.append(dlg);
    const open = h('button', { type: 'button', class: 'btn', id: 'btn-console', text: '지식·정책' });
    open.addEventListener('click', async () => { dlg.showModal(); await reload(); });
    const rep = $('#btn-report');
    rep.parentNode.insertBefore(open, rep);
  }

  function renderTabs() {
    const bar = $('#console-tabs');
    clear(bar);
    for (const [key, text] of TABS) {
      bar.append(h('button', {
        type: 'button', class: `tab${C.tab === key ? ' active' : ''}`, role: 'tab', id: `ctab-${key}`, 'aria-selected': C.tab === key ? 'true' : 'false',
        tabindex: C.tab === key ? '0' : '-1', onclick: () => go(key), onkeydown: (e) => tabKey(e, key), text,
      }));
    }
  }
  function tabKey(e, key) {
    const i = TABS.findIndex((t) => t[0] === key);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    go(TABS[(i + d + TABS.length) % TABS.length][0]);
    $(`#ctab-${C.tab}`).focus();
  }
  function go(tab) { stopTimers(); C.tab = tab; C.draftId = tab === 'kb' ? C.draftId : null; render(); }

  function renderPerm() {
    const el = $('#console-perm');
    const d = C.data;
    let t = '';
    if (d) {
      if (!d.writable) t = '이 접속 경로로는 편집할 수 없음';
      else if (!d.admin) t = reviewer() ? '편집 권한 없음(ADMIN_USERS)' : '편집하려면 상단에 검토자 이름을 입력하세요';
      else t = `편집 가능 · ${d.actor || reviewer()}`;
    }
    el.textContent = t;
  }

  function renderBar() {
    const bar = $('#console-bar');
    clear(bar);
    if (!C.data || C.tab === 'channels') return;
    const chs = C.data.channels.map((c) => c.channel);
    const sel = ctl('select', '채널', { id: 'console-channel' });
    for (const c of C.data.channels) sel.append(h('option', { value: c.channel, selected: c.channel === C.channel, text: `${c.channel} · ${c.label || ''}` }));
    sel.addEventListener('change', () => { C.channel = sel.value; C.draftId = null; render(); });
    bar.append(field('채널', sel));
    if (C.tab === 'kb' || C.tab === 'convert' || C.tab === 'history') {
      const ls = ctl('select', '언어', { id: 'console-lang' });
      for (const [v, t] of [['ko', '한국어'], ['en', '영어']]) ls.append(h('option', { value: v, selected: v === C.lang, text: t }));
      ls.addEventListener('change', () => { C.lang = ls.value; C.draftId = null; render(); });
      bar.append(field('언어', ls));
    }
    if (!chs.includes(C.channel)) C.channel = chs[0];
  }

  async function reload() {
    const my = ++C.seq;
    try { C.data = await get('/api/console'); C.error = null; } catch (e) { C.data = null; C.error = e; }
    if (my !== C.seq) return;
    if (C.data) {
      if (!C.data.channels.some((c) => c.channel === C.channel)) C.channel = (C.data.channels[0] || {}).channel || null;
      C.packs = {};
      await Promise.all(C.data.channels.map(async (c) => {
        try { C.packs[c.channel] = await get(`/api/console/policy/${encodeURIComponent(c.channel)}`); } catch { /* 목록에서는 없어도 된다 */ }
      }));
    }
    render();
  }

  function render() {
    stopTimers();
    renderTabs(); renderPerm(); renderBar();
    const root = body();
    clear(root);
    if (C.error) { root.append(errBox(C.error)); return; }
    if (!C.data) { root.append(h('p', { class: 'muted', text: '불러오는 중…' })); return; }
    if (!C.data.channels.length) { root.append(h('p', { class: 'muted', text: '채널이 없습니다.' })); return; }
    const view = { channels: viewChannels, kb: viewKb, policy: viewPolicy, convert: viewConvert, history: viewHistory }[C.tab];
    view(root);
  }

  // ---------- 채널 ----------
  function viewChannels(root) {
    const rows = C.data.channels.map((c) => {
      const pack = (C.packs[c.channel] || {}).pack;
      const kbDefault = !(c.kb.ko && c.kb.ko.live);
      const demo = kbDefault && pack && pack.maxLevel === 'L2' && !pack.shadow;
      const invalid = c.policy.invalid || (c.kb.ko && c.kb.ko.invalid) || (c.kb.en && c.kb.en.invalid);
      const kbCell = ['ko', 'en'].filter((l) => c.kb[l]).map((l) => h('div', {}, `${l === 'ko' ? '한국어' : '영어'} · 절 ${c.kb[l].sections}개 · ${Number(c.kb[l].chars).toLocaleString()}자 `,
        chip(c.kb[l].live ? '고객 수정' : '이미지 기본값')));
      return h('tr', {},
        h('th', { scope: 'row', text: c.channel }),
        h('td', { text: c.label || '–' }),
        h('td', {}, kbCell),
        h('td', {}, h('span', { class: 'num', text: c.policy.version || '–' }), ' ', chip(c.policy.live ? '고객 수정' : '이미지 기본값')),
        h('td', {},
          demo ? h('div', { class: 'warn-text', text: '출하 데모 내용 — 고객 KB 게시 전 자동 발송 금지' }) : null,
          invalid ? h('div', { class: 'danger-text', text: '저장된 설정을 쓸 수 없어 이 채널은 모든 문의를 사람에게 넘기는 중' }) : null,
          !demo && !invalid ? h('span', { class: 'muted', text: '–' }) : null),
        h('td', {}, btn('열기', () => { C.channel = c.channel; C.draftId = null; go('kb'); }, 'btn-sm')));
    });
    root.append(h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable' },
      h('thead', {}, h('tr', {}, ['채널', '표시 이름', 'KB', '정책 버전', '상태', ''].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, rows))));
    root.append(h('p', { class: 'hint', text: '새 채널 만들기는 아직 지원하지 않습니다.' }));
  }

  // ---------- KB ----------
  async function viewKb(root) {
    if (C.draftId) return viewDraft(root);
    const my = C.seq;
    root.append(h('p', { class: 'muted', text: '불러오는 중…' }));
    let kb, drafts = [];
    try {
      [kb, drafts] = await Promise.all([
        get(`/api/console/kb/${encodeURIComponent(C.channel)}`, { lang: C.lang }),
        get('/api/console/drafts', { channel: C.channel }).then((r) => r.items || []).catch(() => []),
      ]);
    } catch (e) { if (my === C.seq && C.tab === 'kb') { clear(root); root.append(errBox(e)); } return; }
    if (my !== C.seq || C.tab !== 'kb' || C.draftId) return;
    clear(root);
    const note = h('div', { id: 'kb-msg' });
    const mk = async (from) => {
      try { const r = await send(`/api/console/kb/${encodeURIComponent(C.channel)}/drafts`, { lang: C.lang, from }); C.draftId = r.draftId; render(); } catch (e) { replace(note, errBox(e)); }
    };
    root.append(h('div', { class: 'row-gap' },
      chip(kb.live ? '고객 수정' : '이미지 기본값'), kb.invalid ? chip('쓸 수 없는 상태 — 모든 문의를 사람에게 넘김', 'warn') : null,
      h('span', { class: 'muted', text: `버전 ${kb.version || '–'}` }),
      isAdmin() ? btn('편집 초안 만들기', () => mk('live'), 'btn-primary btn-sm') : null,
      isAdmin() ? btn('빈 초안으로 시작', () => mk('blank'), 'btn-sm') : null), note);
    root.append(h('h4', { class: 'sec-title', text: '절 목록' }));
    const secs = kb.sections || [];
    root.append(secs.length ? h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable' },
      h('thead', {}, h('tr', {}, ['key', '제목', '출처', '검토일', '유효 기한', '글자', '상태'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, secs.map((s) => h('tr', {},
        h('th', { scope: 'row' }, h('code', { text: s.key })), h('td', { text: s.title }), h('td', { text: s.source || '–' }), h('td', { text: s.reviewed || '–' }),
        h('td', { text: s.validUntil || '–' }), h('td', { class: 'num', text: String(s.chars ?? '') }),
        h('td', {}, s.expired ? chip('기한 지남', 'warn') : null)))))) : h('p', { class: 'muted', text: '절이 없습니다.' }));
    const ck = kb.check || {};
    if ((ck.errors || []).length || (ck.warnings || []).length) {
      root.append(h('h4', { class: 'sec-title', text: '검사 결과' }), problemList(ck.errors) || h('p', { class: 'muted', text: '오류 없음' }), problemList(ck.warnings, 'warn-list'));
    }
    root.append(h('details', { class: 'raw-view' }, h('summary', { text: '원문 보기' }), h('pre', { class: 'raw', text: kb.raw || '' })));
    const open = drafts.filter((d) => d.language === C.lang && ['converting', 'ready', 'failed'].includes(d.status));
    root.append(h('h4', { class: 'sec-title', text: '진행 중인 초안' }));
    root.append(open.length ? h('ul', { class: 'plain' }, open.map((d) => h('li', { class: 'row-gap' },
      chip(DRAFT_STATUS[d.status] || d.status), h('span', { text: d.origin === 'convert' ? `변환: ${d.sourceName || ''}` : '직접 편집' }),
      h('span', { class: 'muted', text: `${d.createdBy || ''} · ${when(d.updatedAt)}` }), btn('열기', () => { C.draftId = d.id; render(); }, 'btn-sm'))))
      : h('p', { class: 'muted', text: '없습니다.' }));
  }
  const DRAFT_STATUS = { converting: '변환 중', ready: '검토 대기', failed: '실패', published: '게시됨', discarded: '폐기됨' };
  const when = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '');

  // ---------- 초안 편집기 / 검토 ----------
  async function viewDraft(root) {
    const id = C.draftId;
    const my = C.seq;
    let d;
    try { d = await get(`/api/console/drafts/${encodeURIComponent(id)}`); } catch (e) { clear(root); root.append(errBox(e), btn('목록으로', () => { C.draftId = null; render(); })); return; }
    if (my !== C.seq || C.tab !== 'kb' || C.draftId !== id) return;
    clear(root);
    const dr = d.draft || {};
    const converting = d.status === 'converting';
    const editable = isAdmin() && !converting && d.status !== 'published' && d.status !== 'discarded';
    const st = { revision: d.revision, dirty: false, check: d.check, diff: d.diff };
    root.append(h('div', { class: 'row-gap' },
      btn('← 초안 목록', () => { C.draftId = null; render(); }, 'btn-ghost btn-sm'),
      chip(DRAFT_STATUS[d.status] || d.status), h('strong', { text: dr.origin === 'convert' ? `변환 초안 · ${dr.sourceName || ''}` : '직접 편집 초안' }),
      h('span', { class: 'muted', text: `${dr.channel || C.channel} · ${dr.language === 'en' ? '영어' : '한국어'}` })));
    const slot = h('div', { id: 'draft-slot' });
    if (converting) {
      const ch = (d.report && d.report.chunks) || {};
      root.append(h('div', { class: 'card' }, h('div', { class: 'card-title', text: '변환 중' }),
        h('progress', { max: String(ch.total || 1), value: String(ch.done || 0), 'aria-label': '변환 진행' }),
        h('p', { class: 'muted', role: 'status', text: ch.total ? `청크 ${ch.done || 0}/${ch.total}` : '준비 중…' }),
        isAdmin() ? btn('변환 취소하고 폐기', () => discardPanel(slot, id), 'btn-danger btn-sm') : null), slot);
      C.timer = setTimeout(() => { if (C.tab === 'kb' && C.draftId === id) { clear(root); viewDraft(root); } }, 2000);
      return;
    }
    if (d.status === 'failed' || dr.error) root.append(h('div', { class: 'form-error', role: 'alert', text: `변환이 끝까지 가지 못했습니다${dr.error ? ` (${dr.error})` : ''}. 끝난 부분은 아래 초안에 남아 있습니다.` }));
    if (d.report) root.append(reportPanel(d.report, d.sourceText));

    const ta = ctl('textarea', 'KB 원문', { id: 'draft-raw', rows: '24', spellcheck: 'false', readonly: !editable, class: 'raw-edit' });
    ta.value = d.raw || '';
    const checkSlot = h('div', { id: 'draft-check' });
    const diffSlot = h('div', { id: 'draft-diff' });
    const drawResult = () => {
      replace(checkSlot, h('h4', { class: 'sec-title', text: '검사 결과' }), problemList((st.check || {}).errors) || h('p', { class: 'muted', text: '오류 없음' }), problemList((st.check || {}).warnings, 'warn-list'));
      replace(diffSlot, h('h4', { class: 'sec-title', text: '변경 비교' }), diffView(st.diff, d.sourceText));
    };
    drawResult();
    const saveBtn = btn('저장', () => save(), '', { disabled: !editable });
    const pubBtn = btn('게시', () => publish(), 'btn-primary', { disabled: !editable });
    const dirtyNote = h('span', { class: 'hint', role: 'status' });
    const sync = () => { pubBtn.disabled = !editable || st.dirty || !!((st.check || {}).errors || []).length; dirtyNote.textContent = st.dirty ? '저장하지 않은 변경이 있습니다. 저장한 뒤 게시할 수 있습니다.' : ''; };
    const runCheck = async () => {
      try { const r = await probe(`/api/console/kb/${encodeURIComponent(dr.channel || C.channel)}/check`, { lang: dr.language || C.lang, raw: ta.value }); st.check = r; st.diff = r.diff; st.impact = r; drawResult(); sync(); } catch (e) { replace(checkSlot, errBox(e)); }
    };
    ta.addEventListener('input', () => { st.dirty = true; sync(); clearTimeout(C.deb); C.deb = setTimeout(runCheck, 1000); });
    async function save() {
      saveBtn.disabled = true;
      try {
        const r = await send(`/api/console/drafts/${encodeURIComponent(id)}/save`, { raw: ta.value, revision: st.revision });
        st.revision = r.revision; st.check = r.check; st.diff = r.diff; st.dirty = false; drawResult(); sync();
        replace(slot, h('p', { class: 'ok-text', role: 'status', text: '저장했습니다.' }));
      } catch (e) { replace(slot, errBox(e)); }
      saveBtn.disabled = !editable;
    }
    async function publish() {
      let base = dr.baseHash;
      try { if (!base) base = (await get(`/api/console/kb/${encodeURIComponent(dr.channel || C.channel)}`, { lang: dr.language || C.lang })).srcHash; } catch (e) { replace(slot, errBox(e)); return; }
      const chName = dr.channel || C.channel;
      const submit = (note, ack) => send(`/api/console/drafts/${encodeURIComponent(id)}/publish`, { baseHash: base, revision: st.revision, note, ack });
      replace(slot, publishPanel({
        channel: chName, title: 'KB를 게시합니다', confirmText: '게시',
        impact: st.impact && st.impact.l2Impact, hosts: st.impact && st.impact.newLinkHosts, packRows: (C.packs[chName] || {}).promotion,
        submit, demote: (names, note) => demoteIntents(chName, names, note),
        onDone: () => { C.draftId = null; C.packs = {}; reload(); },
      }));
    }
    const left = h('div', { class: 'col' }, field('KB 원문', ta), h('div', { class: 'row-gap' }, saveBtn, pubBtn,
      isAdmin() && d.status !== 'published' && d.status !== 'discarded' ? btn('초안 폐기', () => discardPanel(slot, id), 'btn-danger') : null, dirtyNote), slot, checkSlot);
    if (!isAdmin()) left.append(h('p', { class: 'hint', text: '읽기 전용입니다. 편집 권한이 있는 사용자만 저장·게시할 수 있습니다.' }));
    root.append(h('div', { class: 'split' }, left, h('div', { class: 'col' }, diffSlot)));
    sync();
    if (editable) runCheck(); // 게시 확인에 L2 영향과 새 링크 주소를 미리 싣는다
  }

  function discardPanel(slot, id) {
    replace(slot, confirmBar('이 초안을 폐기합니다. 변환 중이면 작업도 멈추고, 되돌릴 수 없습니다.', '폐기', async () => {
      try { await send(`/api/console/drafts/${encodeURIComponent(id)}/discard`, {}); C.draftId = null; render(); } catch (e) { replace(slot, errBox(e)); }
    }, () => replace(slot)));
  }
  function confirmBar(text, yes, onYes, onNo) {
    const busy = { v: false };
    const y = btn(yes, async () => { if (busy.v) return; busy.v = true; y.disabled = true; try { await onYes(); } finally { busy.v = false; y.disabled = false; } }, 'btn-danger');
    return h('div', { class: 'confirm', role: 'group', 'aria-label': '확인' }, h('p', { text }), h('div', { class: 'row-gap' }, y, btn('취소', onNo, 'btn-ghost')));
  }

  // diff는 {added, removed, changed, unchanged} 또는 [{key, op, before, after}] 어느 쪽이든 읽는다.
  function normDiff(df) {
    if (!df) return [];
    if (Array.isArray(df)) return df.map((x) => ({ key: x.key, op: x.op || x.type, before: x.before ?? x.from, after: x.after ?? x.to }));
    const out = [];
    for (const x of df.added || []) out.push({ key: nm(x), op: 'added', after: x.after ?? x.to ?? x });
    for (const x of df.changed || []) out.push({ key: nm(x), op: 'changed', before: x.before ?? x.from, after: x.after ?? x.to });
    for (const x of df.removed || []) out.push({ key: nm(x), op: 'removed', before: x.before ?? x.from ?? x });
    return out;
  }
  const secText = (s) => (s == null ? '' : typeof s === 'string' ? s : [s.title ? `제목: ${s.title}` : '', s.source ? `출처: ${s.source}` : '', s.body ?? s.text ?? ''].filter(Boolean).join('\n'));
  function diffView(df, sourceText) {
    const items = normDiff(df).filter((x) => x.op !== 'unchanged');
    if (!items.length) return h('p', { class: 'muted', text: '라이브 KB와 달라진 절이 없습니다.' });
    const OP = { added: '추가', changed: '변경', removed: '삭제' };
    return h('div', { class: 'diff' }, items.map((x) => h('div', { class: `dcard op-${x.op}` },
      h('div', { class: 'row-gap' }, chip(OP[x.op] || x.op), h('code', { text: x.key })),
      h('div', { class: x.op === 'changed' ? 'pair' : '' },
        x.before != null ? h('div', {}, h('small', { class: 'hint', text: '이전' }), h('pre', { class: 'raw', text: secText(x.before) })) : null,
        x.after != null ? h('div', {}, h('small', { class: 'hint', text: '이후' }), h('pre', { class: 'raw', text: secText(x.after) })) : null),
      sourceText ? refButton(x.after, sourceText) : null)));
  }
  function refButton(sec, sourceText) {
    const src = sec && typeof sec === 'object' ? String(sec.source || '') : '';
    const ref = src.includes('§') ? src.split('§').pop().trim() : '';
    const lines = sourceText.split('\n');
    const at = ref ? lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(ref)) : -1;
    if (at < 0) return null;
    const out = h('pre', { class: 'raw', hidden: true });
    const b = btn('원문에서 찾기', () => { out.textContent = lines.slice(at, at + 30).join('\n'); out.hidden = !out.hidden; }, 'btn-ghost btn-sm');
    return h('div', {}, b, out);
  }

  function reportPanel(rep, sourceText) {
    const parts = [];
    const ch = rep.chunks || {};
    const u = rep.usage || {}, es = rep.estimate || {};
    parts.push(h('p', { class: 'muted', text: `청크 ${ch.done ?? 0}/${ch.total ?? 0}${(ch.failed || []).length ? ` · 실패 ${ch.failed.length}` : ''}` }
    ));
    const used = u.input != null ? Number(u.input) + Number(u.output || 0) : null;
    const est = es.totalTokens ?? es.total;
    if (est != null || used != null) {
      parts.push(h('p', { class: 'muted', text: `토큰 — 예상 ${est != null ? Number(est).toLocaleString() : '–'} · 실제 ${used != null ? used.toLocaleString() : '–'}` }));
    }
    if ((ch.failed || []).length) {
      parts.push(h('div', {}, h('strong', { text: '실패한 청크' }), h('ul', { class: 'plain' }, ch.failed.map((f) => h('li', {}, h('code', { text: f.ref || '' }), ' — ', f.error || '')))));
    }
    if ((rep.omitted || []).length) {
      parts.push(h('div', {}, h('strong', { text: '제외된 내용' }), h('ul', { class: 'plain' }, rep.omitted.map((o) => h('li', { text: typeof o === 'string' ? o : [o.ref, o.reason, o.text].filter(Boolean).join(' — ') })))));
    }
    if (sourceText) parts.push(h('details', { class: 'raw-view' }, h('summary', { text: '원문 대조' }), h('pre', { class: 'raw', text: sourceText })));
    return h('div', { class: 'card' }, h('div', { class: 'card-title', text: '변환 결과' }), parts);
  }

  // ---------- 게시 확인 패널 ----------
  // impact: {intents, keys, blocked} | null, hosts: string[] | null
  function publishPanel(o) {
    const S2 = { note: '', ackL2: false, typed: '', ackHosts: false, impact: o.impact, hosts: o.hosts, gate: null, err: null, busy: false };
    const root = h('div', { class: 'confirm', role: 'group', 'aria-label': o.title });
    const rowsOf = (n) => ((o.packRows && o.packRows.intents) || []).find((r) => (r.intent || r.name) === n);
    const metric = (r) => (r ? `검토 ${r.reviewed ?? 0}건 · 무수정 ${pct(r.approvedNoEditRate)} · 치명 ${r.criticalCount ?? 0}건` : '표본 없음');
    const ready = () => {
      if (S2.busy) return false;
      const hasImpact = S2.impact && (S2.impact.intents || []).length;
      if (hasImpact && ((S2.impact.blocked || []).length || !S2.ackL2 || S2.typed.trim() !== o.channel)) return false;
      if ((S2.hosts || []).length && !S2.ackHosts) return false;
      return true;
    };
    const draw = () => {
      const noteIn = ctl('textarea', '게시 메모', { rows: '2', maxlength: '500' });
      noteIn.value = S2.note;
      noteIn.addEventListener('input', () => { S2.note = noteIn.value; });
      const go2 = btn(o.confirmText, () => run((ack) => o.submit(S2.note, ack)), 'btn-primary', { disabled: !ready() });
      const upd = () => { go2.disabled = !ready(); };
      const kids = [h('p', { class: 'strong', text: o.title }), field('메모(기록에 남습니다)', noteIn)];
      const imp = S2.impact;
      if (imp && (imp.intents || []).length) {
        const blocked = (imp.blocked || []).length > 0;
        kids.push(h('div', { class: 'gate' },
          h('p', { class: 'warn-text', text: '이 채널에는 지금 자동으로 발송되는 intent가 있습니다. KB 전체가 그 답장을 만드는 데 쓰이므로 어느 절을 바꿔도 확인이 필요합니다.' }),
          h('ul', { class: 'plain' }, imp.intents.map((n) => h('li', {}, h('code', { text: nm(n) }), ` — ${metric(rowsOf(nm(n)))}`))),
          (imp.keys || []).length ? h('p', { class: 'hint', text: `바뀌는 절: ${imp.keys.join(', ')}` }) : null));
        if (blocked) {
          kids.push(h('p', { class: 'danger-text', text: '아래 intent는 아직 자동 발송 근거(검토 건수·무수정률·치명 건수)가 모자라 이 절을 바꿀 수 없습니다. 먼저 사람 검토 단계(L1)로 내려야 합니다.' }),
            h('ul', { class: 'plain' }, imp.blocked.map((b) => h('li', {}, h('code', { text: memberName(nm(b)) }), ` — ${metric(typeof b === 'object' ? b : rowsOf(nm(b)))}`))));
          if (o.demote) kids.push(btn('그 intent를 L1로 내리고 게시', () => run((ack) => o.demote(imp.blocked.map(nm), S2.note).then(() => o.submit(S2.note, ack))), 'btn-primary'));
        } else {
          const c1 = ctl('input', '영향을 확인했습니다', { type: 'checkbox' }); c1.checked = S2.ackL2;
          c1.addEventListener('change', () => { S2.ackL2 = c1.checked; upd(); });
          const tn = ctl('input', '채널 이름 입력', { type: 'text', autocomplete: 'off', placeholder: o.channel }); tn.value = S2.typed;
          tn.addEventListener('input', () => { S2.typed = tn.value; upd(); });
          kids.push(check('자동 발송에 쓰이는 내용이 바뀌는 것을 확인했습니다', c1), field(`확인을 위해 채널 이름(${o.channel})을 입력하세요`, tn));
        }
      }
      if ((S2.hosts || []).length) {
        const c2 = ctl('input', '새 링크 호스트를 확인했습니다', { type: 'checkbox' }); c2.checked = S2.ackHosts;
        c2.addEventListener('change', () => { S2.ackHosts = c2.checked; upd(); });
        kids.push(h('div', { class: 'gate' }, h('p', { class: 'warn-text', text: '고객에게 나가는 답장에 새 링크 주소가 들어갈 수 있습니다.' }),
          h('ul', { class: 'plain' }, S2.hosts.map((x) => h('li', {}, h('code', { text: x })))), check('이 주소들을 확인했습니다', c2)));
      }
      if (S2.gate) { const g = S2.gate; kids.push(gateBox(g, o.demote2 ? () => run(() => o.demote2(g, S2.note)) : null)); }
      if (S2.err) kids.push(S2.err);
      kids.push(h('div', { class: 'row-gap' }, go2, btn('취소', () => (o.onCancel ? o.onCancel() : root.replaceWith(h('span'))), 'btn-ghost')));
      replace(root, kids);
    };
    async function run(fn) {
      S2.busy = true; S2.err = null; S2.gate = null; draw();
      const ack = {};
      if (S2.ackL2) ack.l2Impact = true;
      if (S2.ackHosts) ack.linkHosts = true;
      try { const r = await fn(Object.keys(ack).length ? ack : undefined); S2.busy = false; root.replaceChildren(h('p', { class: 'ok-text', role: 'status', text: '게시했습니다.' })); if (o.onDone) o.onDone(r); return; } catch (e) {
        S2.busy = false;
        const d = e.data || {};
        if (e.status === 409 && d.error === 'l2_impact') S2.impact = { intents: d.intents, keys: d.keys, blocked: [] };
        else if (e.status === 409 && d.error === 'l2_impact_ineligible') S2.impact = { intents: d.intents, keys: d.keys || [], blocked: d.blocked || d.intents };
        else if (e.status === 409 && d.error === 'new_link_hosts') S2.hosts = d.hosts;
        else if (e.status === 409 && d.error === 'l2_not_eligible') S2.gate = d;
        else S2.err = errBox(e);
      }
      draw();
    }
    draw();
    return root;
  }

  // 게이트가 막은 구성원과 지표를 쉬운 말로 — 정책 게시·되돌리기·복원 공용
  function gateBox(g, onDemote) {
    const blocked = g.blocked || [];
    return h('div', { class: 'gate' },
      h('p', { class: 'danger-text', text: '자동 발송을 넓히는 변경인데, 아래 항목은 사람이 검토한 근거가 아직 모자라 게시할 수 없습니다.' }),
      blocked.length ? h('ul', { class: 'plain' }, blocked.map((b) => h('li', {}, h('code', { text: memberName(b.member) }),
        ` — 검토 ${b.reviewed ?? 0}건 · 무수정 ${pct(b.approvedNoEditRate)} · 치명 ${b.criticalCount ?? 0}건`))) : null,
      g.channelCritical > 0 ? h('p', { class: 'danger-text', text: `이 채널에 치명 건수가 ${g.channelCritical}건 있어 자동 발송을 넓힐 수 없습니다.` }) : null,
      (g.widenings || []).length ? widenList(g.widenings) : null,
      onDemote ? btn('막힌 intent를 L1로 내리고 게시', onDemote, 'btn-primary') : null);
  }
  function widenList(ws) {
    return h('ul', { class: 'plain' }, ws.map((w) => {
      const path = w.path || '';
      const why = (WIDEN_RULES.find(([re]) => re.test(path)) || [null, '자동 발송 범위를 넓히는 변경입니다.'])[1];
      return h('li', {}, chip(w.scope === 'intent' ? `intent ${w.intent}` : '채널 전체', 'warn'), ' ', h('code', { text: path }), ` — ${why}`);
    }));
  }

  // 정책 팩 후보에서 막힌 구성원을 L1로 내린다(서버에는 내리기 기능이 없다)
  function demoted(pack, members, channelCritical) {
    const p = clone(pack);
    for (const m of members) {
      if (m === '@ack') p.maxLevel = 'L1';
      else if (p.intents && p.intents[m]) p.intents[m].level = 'L1';
    }
    if (channelCritical > 0) p.maxLevel = 'L1';
    return p;
  }
  // KB 게시가 막혔을 때: 영향 intent만 L1로 바꾼 정책을 먼저 게시한다
  async function demoteIntents(channel, names, note) {
    const res = await get(`/api/console/policy/${encodeURIComponent(channel)}`);
    const pack = JSON.parse(res.raw);
    await send(`/api/console/policy/${encodeURIComponent(channel)}/publish`, { pack: demoted(pack, names, 0), baseVersion: res.version, note: note || 'KB 게시를 위해 L1로 내림' });
  }

  // ---------- 매뉴얼 변환 ----------
  function viewConvert(root) {
    if (!isAdmin()) { root.append(h('p', { class: 'muted', text: '변환은 편집 권한이 있는 사용자만 시작할 수 있습니다.' })); }
    const mock = C.data.provider === 'mock';
    const file = ctl('input', '매뉴얼 파일', { type: 'file', id: 'conv-file', accept: '.md,.txt,.html,.htm,.docx,.pdf,.hwp,.hwpx,.doc' });
    const mode = ctl('select', '합치는 방식', { id: 'conv-mode' });
    mode.append(h('option', { value: 'merge', text: '병합 — 같은 key는 교체하고 새 절은 뒤에 붙임' }), h('option', { value: 'replace', text: '교체 — 변환 결과만 사용' }));
    const msg = h('div', { id: 'conv-msg', role: 'status' });
    const go2 = btn('변환 시작', start, 'btn-primary', { disabled: !isAdmin() });
    file.addEventListener('change', () => {
      const f = file.files[0];
      const ext = f ? f.name.split('.').pop().toLowerCase() : '';
      if (f && (ext === 'hwp' || ext === 'hwpx')) replace(msg, h('p', { class: 'warn-text', text: '한글 파일은 바로 읽을 수 없습니다. 한글에서 PDF로 내보내 주세요.' }));
      else if (f && ext === 'doc') replace(msg, h('p', { class: 'warn-text', text: 'Word에서 DOCX로 저장해 주세요.' }));
      else if (f && f.size > UPLOAD_MAX) replace(msg, h('p', { class: 'warn-text', text: '파일이 10MB를 넘습니다. 나눠서 올려 주세요.' }));
      else replace(msg);
    });
    async function start() {
      const f = file.files[0];
      if (!f) { replace(msg, h('p', { class: 'form-error', text: '파일을 먼저 고르세요.' })); return; }
      const ext = f.name.split('.').pop().toLowerCase();
      if (['hwp', 'hwpx', 'doc'].includes(ext) || f.size > UPLOAD_MAX) return;
      go2.disabled = true;
      try {
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onerror = () => rej(new Error('파일을 읽지 못했습니다.')); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(f); });
        const r = await send(`/api/console/kb/${encodeURIComponent(C.channel)}/convert`, { lang: C.lang, filename: f.name, contentBase64: b64, mode: mode.value });
        C.draftId = r.draftId; C.tab = 'kb'; render();
        return;
      } catch (e) { replace(msg, errBox(e)); }
      go2.disabled = !isAdmin();
    }
    root.append(h('div', { class: 'card conv' },
      h('p', { class: 'notice', text: '올린 매뉴얼 본문은 변환을 위해 Anthropic API로 전송됩니다. 개인정보·내부 전용 문서는 빼고 올려 주세요.' }),
      mock ? h('p', { class: 'hint', text: '지금은 목업 변환 — 외부 전송 없음' }) : null,
      field('파일(MD, TXT, HTML, DOCX, PDF · 10MB 이하)', file),
      h('div', { class: 'row-gap' }, field('합치는 방식', mode)),
      h('p', { class: 'hint', text: `대상: ${C.channel} · ${C.lang === 'en' ? '영어' : '한국어'} (위 줄에서 바꿀 수 있습니다). 예상 토큰과 작업 상한은 시작하면 초안 화면에 표시됩니다. PDF가 상한을 넘으면 쪽을 나눠 따로 올려 주세요.` }),
      go2, msg));
  }

  // ---------- 정책 ----------
  async function viewPolicy(root) {
    const my = C.seq;
    root.append(h('p', { class: 'muted', text: '불러오는 중…' }));
    let res;
    try { res = await get(`/api/console/policy/${encodeURIComponent(C.channel)}`); } catch (e) { if (my === C.seq && C.tab === 'policy') { clear(root); root.append(errBox(e)); } return; }
    if (my !== C.seq || C.tab !== 'policy') return;
    clear(root);
    const P = { res, pack: clone(C.pendingPack && C.pendingPack.channel === C.channel ? C.pendingPack.pack : res.pack), check: null, panel: null };
    const carry = C.pendingPack && C.pendingPack.channel === C.channel ? C.pendingPack.msg : null;
    C.pendingPack = null;
    drawPolicy(root, P, carry);
  }

  function drawPolicy(root, P, carry, auto) {
    const { res } = P;
    const rules = res.rules || {};
    const rng = (path, lo, hi) => { const r = rules[path] || {}; return { min: String(r.min ?? lo), max: String(r.max ?? hi) }; };
    const can = isAdmin();
    const resultSlot = h('div', { id: 'policy-result' });
    const pubSlot = h('div', { id: 'policy-pub' });
    let pubBtn;
    const touch = () => { P.check = null; replace(resultSlot, h('p', { class: 'hint', text: '내용이 바뀌었습니다. [검사]를 다시 누르세요.' })); replace(pubSlot); if (pubBtn) pubBtn.disabled = true; };
    const pack = () => P.pack;
    const txt = (label, hint, getv, setv, attrs = {}) => { const i = ctl('input', label, { type: 'text', value: getv() ?? '', readonly: !can, ...attrs }); i.addEventListener('input', () => { setv(i.value); touch(); }); return field(label, i, hint); };
    const area = (label, getv, setv, attrs = {}) => { const i = ctl('textarea', label, { rows: '2', readonly: !can, ...attrs }); i.value = getv() ?? ''; i.addEventListener('input', () => { setv(i.value); touch(); }); return field(label, i); };
    const num = (label, path, lo, hi, step) => { const i = ctl('input', label, { type: 'number', ...rng(path, lo, hi), step, readonly: !can, value: String(pack().thresholds[path.split('.')[1]] ?? '') }); i.addEventListener('input', () => { pack().thresholds[path.split('.')[1]] = i.value === '' ? undefined : Number(i.value); touch(); }); return field(label, i, `${rng(path, lo, hi).min} ~ ${rng(path, lo, hi).max}`); };
    const flag = (label, getv, setv, off) => { const i = ctl('input', label, { type: 'checkbox', disabled: !can || off }); i.checked = !!getv(); i.addEventListener('change', () => { setv(i.checked); touch(); }); return check(label, i); };

    pack().thresholds = pack().thresholds || {};
    pack().guard = pack().guard || {};
    pack().ackReply = pack().ackReply || {};
    pack().notify = pack().notify || {};

    if (res.invalid) root.append(h('div', { class: 'form-error', role: 'alert' }, '저장된 설정을 쓸 수 없어 이 채널은 모든 문의를 사람에게 넘기는 중입니다. 고쳐서 다시 게시하거나 이미지 기본값으로 복원해야 풀립니다.', res.error ? h('div', { class: 'hint', text: String(res.error) }) : null));
    if (carry) root.append(h('p', { class: 'warn-text', role: 'status', text: carry }));
    root.append(h('div', { class: 'row-gap' }, chip(res.live ? '고객 수정' : '이미지 기본값'), h('span', { class: 'muted', text: `버전 ${res.version || '–'} (이미지 ${res.shippedVersion || '–'})` })));

    // 기본
    const langBox = h('div', { class: 'row-gap', role: 'group', 'aria-label': '응대 언어' });
    for (const [v, t] of [['ko', '한국어'], ['en', '영어']]) {
      const i = ctl('input', `응대 언어 ${t}`, { type: 'checkbox', disabled: !can }); i.checked = (pack().languages || ['ko']).includes(v);
      i.addEventListener('change', () => { const s = new Set(pack().languages || ['ko']); if (i.checked) s.add(v); else s.delete(v); pack().languages = [...s]; touch(); });
      langBox.append(check(t, i));
    }
    const lvl = ctl('select', '자동 발송 최대 등급', { disabled: !can });
    for (const l of LEVELS) lvl.append(h('option', { value: l, selected: pack().maxLevel === l, text: l }));
    lvl.addEventListener('change', () => { pack().maxLevel = lvl.value; touch(); });

    const sec = (title, ...kids) => h('section', { class: 'psec' }, h('h4', { class: 'sec-title', text: title }), ...kids);
    const form = h('div', { class: 'pform' },
      sec('기본', txt('표시 이름', '1~40자', () => pack().label, (v) => { pack().label = v; }, { maxlength: '40' }),
        area('답장 Agent 말투(persona)', () => pack().persona, (v) => { pack().persona = v; }, { maxlength: '300' }),
        h('div', {}, h('span', { class: 'lbl', text: '응대 언어' }), langBox)),
      sec('등급', field('자동 발송 최대 등급', lvl, 'L0·L1·H로 내리는 것은 자유이고, L2로 올리는 것은 근거 확인을 거칩니다.'),
        flag('섀도 모드(고객에게 나가지 않고 초안만 만듭니다)', () => pack().shadow, (v) => { pack().shadow = v; }),
        h('p', { class: 'hint', text: '자동 발송 대상은 [검사] 결과의 게이트 항목에 표시됩니다.' })),
      sec('임계값', h('div', { class: 'grid4' },
        num('접수 확신도 하한', 'thresholds.confidenceMin', 0.8, 1, '0.01'), num('최대 왕복 횟수', 'thresholds.maxRounds', 1, 10, '1'),
        num('같은 질문 반복 한도', 'thresholds.repeatLimit', 1, 2, '1'), num('답장 최대 글자 수', 'thresholds.maxLength', 200, 1000, '10'))),
      sec('금지어와 허용 범위', chipEditor('금지어(한국어)', pack().guard, 'forbiddenWords', can, touch), chipEditor('금지어(영어)', pack().guard, 'forbiddenWordsEn', can, touch),
        flag('날짜 언급 허용(날짜 약속은 늘 막힙니다)', () => pack().guard.allowDates, (v) => { pack().guard.allowDates = v; }),
        flag('수량 언급 허용', () => pack().guard.allowQuantities !== false, (v) => { pack().guard.allowQuantities = v; }),
        h('div', { class: 'locked' }, chip('고정'), ' 금액 언급 허용: 끔 — 바꿀 수 없습니다.')));
    // 넘김 사유
    const used = new Set(Object.values(pack().intents || {}).map((v) => v.reason).filter(Boolean));
    const reasonsBox = h('div', {});
    const drawReasons = () => {
      const rs = pack().handoffReasons || (pack().handoffReasons = []);
      const ans = new Set(pack().answerableHandoffReasons || []);
      replace(reasonsBox,
        h('ul', { class: 'plain reasons' }, rs.map((r) => {
          const locked = REQUIRED_REASONS.includes(r) || SYSTEM_REASONS.includes(r) || used.has(r);
          const ai = ctl('input', `${r} 자동 응답 허용`, { type: 'checkbox', disabled: !can }); ai.checked = ans.has(r);
          ai.addEventListener('change', () => { const s = new Set(pack().answerableHandoffReasons || []); if (ai.checked) s.add(r); else s.delete(r); pack().answerableHandoffReasons = [...s]; touch(); });
          return h('li', { class: 'row-gap' }, h('code', { text: r }),
            locked ? chip(REQUIRED_REASONS.includes(r) ? '필수 · 잠금' : SYSTEM_REASONS.includes(r) ? '시스템 · 잠금' : 'intent가 사용 중') : null,
            check('자동 응답 허용', ai),
            !locked && can ? btn('삭제', () => { pack().handoffReasons = rs.filter((x) => x !== r); pack().answerableHandoffReasons = (pack().answerableHandoffReasons || []).filter((x) => x !== r); touch(); drawReasons(); }, 'btn-ghost btn-sm', { 'aria-label': `${r} 삭제` }) : null);
        })),
        can ? addRow('사유 이름 추가', /^[a-z][a-z0-9_]{1,39}$/, (v) => { if (!rs.includes(v)) { rs.push(v); touch(); drawReasons(); } }) : null);
    };
    drawReasons();
    form.append(sec('넘김 사유', h('p', { class: 'hint', text: '일부 사유는 코드 규칙과 연결돼 있어, 빼면 그 규칙이 꺼지고 자동 발송 확대로 검사됩니다. "자동 응답 허용"은 코드가 정한 상한 안에서만 켤 수 있습니다.' }), reasonsBox));
    form.append(sec('접수 안내와 알림',
      area('접수 안내 문장(한국어, 필수)', () => pack().ackReply.ko, (v) => { pack().ackReply.ko = v; }, { maxlength: '500' }),
      area('접수 안내 문장(영어)', () => pack().ackReply.en, (v) => { if (v) pack().ackReply.en = v; else delete pack().ackReply.en; }, { maxlength: '500' }),
      txt('알림 채널(선택)', '80자 이하', () => pack().notify.channel, (v) => { if (v) pack().notify.channel = v; else delete pack().notify.channel; }, { maxlength: '80' })));
    // intent 표
    const tbody = h('tbody', {});
    const promo = new Map(((res.promotion && res.promotion.intents) || []).map((r) => [r.intent || r.name, r]));
    const drawIntents = () => {
      clear(tbody);
      const kbKeys = res.kbKeys || [];
      for (const [name, it] of Object.entries(pack().intents)) {
        const fixed = name === 'ack' || name === 'ignore';
        const reserved = RESERVED.includes(name);
        const reasonLocked = REQUIRED_REASONS.includes(it.reason);
        const row = promo.get(name);
        if (fixed) { tbody.append(h('tr', {}, h('th', { scope: 'row' }, h('code', { text: name })), h('td', { colspan: '9' }, chip('고정'), ' 시스템이 쓰는 이름이라 바꿀 수 없습니다.'))); continue; }
        const desc = ctl('input', `${name} 설명`, { type: 'text', value: it.description || '', maxlength: '200', readonly: !can });
        desc.addEventListener('input', () => { if (desc.value.trim()) it.description = desc.value; else delete it.description; touch(); });
        const lv = ctl('select', `${name} 등급`, { disabled: !can || reserved || reasonLocked });
        for (const l of LEVELS) lv.append(h('option', { value: l, selected: it.level === l, text: l }));
        lv.addEventListener('change', () => { it.level = lv.value; if (it.level === 'L2' && !Array.isArray(it.kb)) it.kb = []; touch(); });
        const kbs = ctl('select', `${name} KB 절`, { multiple: true, size: '3', disabled: !can });
        for (const k of new Set([...kbKeys, ...(it.kb || [])])) kbs.append(h('option', { value: k, selected: (it.kb || []).includes(k), text: k }));
        kbs.addEventListener('change', () => { const v = [...kbs.selectedOptions].map((o) => o.value); if (v.length || it.level === 'L2') it.kb = v; else delete it.kb; touch(); });
        const rs = ctl('select', `${name} 넘김 사유`, { disabled: !can || reserved || reasonLocked });
        rs.append(h('option', { value: '', text: '(없음)' }));
        for (const r of pack().handoffReasons || []) rs.append(h('option', { value: r, selected: it.reason === r, text: r }));
        rs.addEventListener('change', () => { if (rs.value) it.reason = rs.value; else delete it.reason; touch(); });
        const ct = ctl('input', `${name} 문의 유형`, { type: 'text', value: it.caseType || '', readonly: !can || reserved });
        ct.addEventListener('input', () => { if (ct.value) it.caseType = ct.value; else delete it.caseType; touch(); });
        const cr = ctl('input', `${name} 문의 사유`, { type: 'text', value: it.caseReason || '', readonly: !can || reserved });
        cr.addEventListener('input', () => { if (cr.value) it.caseReason = cr.value; else delete it.caseReason; touch(); });
        tbody.append(h('tr', {},
          h('th', { scope: 'row' }, h('code', { text: name }), reserved ? h('div', {}, chip('잠금')) : null),
          h('td', {}, desc), h('td', {}, lv), h('td', {}, kbs), h('td', {}, rs), h('td', {}, ct), h('td', {}, cr),
          h('td', { class: 'small' }, row ? `검토 ${row.reviewed ?? 0} · 무수정 ${pct(row.approvedNoEditRate)} · 치명 ${row.criticalCount ?? 0}` : '표본 없음', row && row.eligible != null ? h('div', {}, chip(row.eligible ? '자동 발송 가능' : '근거 부족', row.eligible ? '' : 'warn')) : null),
          h('td', { class: 'small' }, it.actions !== undefined ? h('pre', { class: 'raw', text: JSON.stringify(it.actions, null, 1) }) : h('span', { class: 'muted', text: '추후 연결' })),
          h('td', {}, can && !reserved ? btn('삭제', () => { delete pack().intents[name]; touch(); drawIntents(); }, 'btn-ghost btn-sm', { 'aria-label': `${name} 삭제` }) : null)));
      }
    };
    drawIntents();
    form.append(sec('intent 표', h('div', { class: 'ctable-wrap' }, h('table', { class: 'ctable itable' },
      h('thead', {}, h('tr', {}, ['이름', '설명', '등급', 'KB 절', '넘김 사유', '문의 유형', '문의 사유', '승격 지표', '액션', ''].map((t) => h('th', { scope: 'col', text: t })))), tbody)),
    can ? addRow('새 intent 이름', CH_RE, (v) => { if (!pack().intents[v]) { pack().intents[v] = { level: 'L1', caseType: 'Question', caseReason: 'other' }; touch(); drawIntents(); } }) : null));
    root.append(form);

    // 검사 · 게시
    const checkBtn = btn('검사', async () => {
      checkBtn.disabled = true;
      try { P.check = await probe(`/api/console/policy/${encodeURIComponent(C.channel)}/check`, { pack: pack() }); drawCheck(); } catch (e) { P.check = null; replace(resultSlot, errBox(e)); }
      checkBtn.disabled = false;
    });
    pubBtn = btn('게시', () => openPublish(), 'btn-primary', { disabled: true });
    function drawCheck() {
      const c = P.check;
      const g = c.gate || {};
      const widened = new Set((g.widenings || []).map((w) => w.path));
      const hasProblems = (c.problems || []).length > 0;
      pubBtn.disabled = !can || hasProblems;
      replace(resultSlot,
        hasProblems ? h('div', {}, h('h4', { class: 'sec-title', text: '고쳐야 할 항목' }), problemList(c.problems)) : null,
        (c.warnings || []).length ? h('div', {}, h('h4', { class: 'sec-title', text: '경고' }), problemList(c.warnings, 'warn-list')) : null,
        h('h4', { class: 'sec-title', text: '바뀐 항목' }),
        (c.diff || []).length ? h('table', { class: 'ctable' }, h('thead', {}, h('tr', {}, ['항목', '이전', '이후', ''].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, c.diff.map((d) => h('tr', {}, h('th', { scope: 'row' }, h('code', { text: d.path })), h('td', { text: short(d.from) }), h('td', { text: short(d.to) }),
            h('td', {}, widened.has(d.path) ? chip('자동 발송 확대', 'warn') : null))))) : h('p', { class: 'muted', text: '바뀐 항목이 없습니다.' }),
        (g.widenings || []).length ? h('div', {}, h('h4', { class: 'sec-title', text: '자동 발송을 넓히는 변경' }), widenList(g.widenings)) : null,
        h('h4', { class: 'sec-title', text: '자동 발송 게이트' }),
        h('p', { text: `지금 자동 발송: ${(g.live || []).map(memberName).join(', ') || '없음'} → 게시 뒤: ${(g.next || []).map(memberName).join(', ') || '없음'}` }),
        g.pass === false || (g.blocked || []).length ? gateBox(g, can ? () => { P.pack = demoted(P.pack, (g.blocked || []).map((b) => b.member), g.channelCritical); clear(root); drawPolicy(root, P, '막힌 구성원을 L1로 내렸습니다. 아래에서 메모를 적고 게시하세요.', true); } : null) : h('p', { class: 'ok-text', text: '게이트를 통과했습니다.' }));
    }
    // 게이트가 막은 구성원을 L1로 바꾼 후보로 같은 게시를 다시 부른다
    async function demoteAndPublish(g, note) {
      P.pack = demoted(P.pack, (g.blocked || []).map((b) => b.member), g.channelCritical);
      const r = await send(`/api/console/policy/${encodeURIComponent(C.channel)}/publish`, { pack: P.pack, baseVersion: P.res.version, note });
      return r;
    }
    function openPublish() {
      const chName = C.channel;
      replace(pubSlot, publishPanel({
        channel: chName, title: '정책을 게시합니다', confirmText: '게시',
        submit: (note) => send(`/api/console/policy/${encodeURIComponent(chName)}/publish`, { pack: P.pack, baseVersion: P.res.version, note }),
        demote2: (g, note) => demoteAndPublish(g, note),
        onCancel: () => replace(pubSlot),
        onDone: () => { C.packs = {}; reload(); },
      }));
    }
    root.append(h('div', { class: 'row-gap pbar' }, can ? checkBtn : null, can ? pubBtn : null,
      !can ? h('span', { class: 'hint', text: '읽기 전용입니다.' }) : null), pubSlot, resultSlot);
    if (auto) {
      (async () => {
        try { P.check = await probe(`/api/console/policy/${encodeURIComponent(C.channel)}/check`, { pack: pack() }); drawCheck(); openPublish(); } catch (e) { replace(resultSlot, errBox(e)); }
      })();
    }
  }

  function addRow(label, re, onAdd) {
    const i = ctl('input', label, { type: 'text', placeholder: label, autocomplete: 'off' });
    const err = h('span', { class: 'danger-text', role: 'alert' });
    const add = () => {
      const v = i.value.trim();
      if (!(re instanceof RegExp ? re.test(v) : false)) { err.textContent = '영문 소문자로 시작하는 2~40자(소문자·숫자·밑줄)여야 합니다.'; return; }
      err.textContent = ''; i.value = ''; onAdd(v);
    };
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return h('div', { class: 'row-gap add-row' }, i, btn('추가', add, 'btn-sm'), err);
  }
  function chipEditor(label, obj, key, can, touch) {
    const wrap = h('div', { class: 'cf' }, h('span', { class: 'lbl', text: label }));
    const list = h('ul', { class: 'chips' });
    const draw = () => {
      clear(list);
      for (const w of obj[key] || []) list.append(h('li', {}, h('span', { class: 'chip', text: w }), can ? btn('×', () => { obj[key] = obj[key].filter((x) => x !== w); touch(); draw(); }, 'chip-x', { 'aria-label': `${w} 삭제` }) : null));
      if (!(obj[key] || []).length) list.append(h('li', { class: 'muted', text: '없음' }));
    };
    draw();
    const i = ctl('input', `${label} 추가`, { type: 'text', maxlength: '20', placeholder: '추가할 단어', autocomplete: 'off' });
    const add = () => { const v = i.value.trim(); if (!v || (obj[key] || []).includes(v)) { i.value = ''; return; } (obj[key] = obj[key] || []).push(v); i.value = ''; touch(); draw(); };
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    wrap.append(list, can ? h('div', { class: 'row-gap' }, i, btn('추가', add, 'btn-sm')) : null);
    return wrap;
  }

  // ---------- 기록 ----------
  async function viewHistory(root) {
    const my = C.seq;
    const kindSel = ctl('select', '종류', { id: 'hist-kind' });
    for (const [v, t] of [['', '전체'], ['kb', 'KB'], ['policy', '정책']]) kindSel.append(h('option', { value: v, text: t, selected: v === (C.histKind || '') }));
    kindSel.addEventListener('change', () => { C.histKind = kindSel.value; render(); });
    root.append(h('div', { class: 'row-gap' }, field('종류', kindSel),
      isAdmin() ? btn('KB를 이미지 기본값으로 복원', () => resetPanel('kb'), 'btn-danger btn-sm') : null,
      isAdmin() ? btn('정책을 이미지 기본값으로 복원', () => resetPanel('policy'), 'btn-danger btn-sm') : null));
    const slot = h('div', { id: 'hist-slot' });
    const listEl = h('div', { id: 'hist-list' }, h('p', { class: 'muted', text: '불러오는 중…' }));
    root.append(slot, listEl);
    let items;
    try { items = (await get('/api/console/history', { kind: C.histKind || '', channel: C.channel, lang: C.lang, limit: 100 })).items || []; } catch (e) { replace(listEl, errBox(e)); return; }
    if (my !== C.seq || C.tab !== 'history') return;
    const ACTION = { publish: '게시', rollback: '되돌리기', reset: '기본값 복원' };
    replace(listEl, items.length ? h('table', { class: 'ctable' },
      h('thead', {}, h('tr', {}, ['언제', '누가', '무엇을', '버전', '메모', ''].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, items.map((it) => h('tr', {},
        h('td', { text: when(it.created_at) }), h('td', { text: it.actor || '' }),
        h('td', { text: `${it.kind === 'kb' ? `KB(${it.language === 'en' ? '영어' : '한국어'})` : '정책'} ${ACTION[it.action] || it.action}` }),
        h('td', {}, h('code', { text: `${it.from_hash || '–'} → ${it.to_hash || '이미지'}` })), h('td', { text: it.note || '' }),
        h('td', {}, btn('내용 보기', () => showContent(it, slot), 'btn-sm'),
          isAdmin() && it.action !== 'reset' ? btn('이 버전으로 되돌리기', () => rollbackPanel(it, slot), 'btn-sm') : null))))) : h('p', { class: 'muted', text: '기록이 없습니다.' }));
  }
  async function showContent(it, slot) {
    try {
      const r = await get(`/api/console/history/${encodeURIComponent(it.id)}`);
      replace(slot, h('div', { class: 'card' }, h('div', { class: 'card-title', text: `${when(it.created_at)} · ${it.actor || ''}` }),
        r.shipped ? h('p', { class: 'muted', text: '이미지 기본값으로 복원한 기록입니다. 별도 내용은 없습니다.' }) : h('pre', { class: 'raw', text: typeof r.content === 'string' ? r.content : JSON.stringify(r.content, null, 2) }),
        btn('닫기', () => replace(slot), 'btn-ghost btn-sm')));
    } catch (e) { replace(slot, errBox(e)); }
  }
  async function rollbackPanel(it, slot) {
    const chName = C.channel;
    try {
      if (it.kind === 'policy') {
        const cur = await get(`/api/console/policy/${encodeURIComponent(chName)}`);
        replace(slot, publishPanel({
          channel: chName, title: '이 정책 버전으로 되돌립니다', confirmText: '되돌리기',
          submit: (note) => send(`/api/console/policy/${encodeURIComponent(chName)}/rollback`, { changeId: it.id, baseVersion: cur.version, note }),
          demote2: (g) => openInEditor(it, g), onCancel: () => replace(slot), onDone: () => { C.packs = {}; reload(); },
        }));
      } else {
        const cur = await get(`/api/console/kb/${encodeURIComponent(chName)}`, { lang: it.language || C.lang });
        replace(slot, publishPanel({
          channel: chName, title: '이 KB 버전으로 되돌립니다', confirmText: '되돌리기', packRows: (C.packs[chName] || {}).promotion,
          submit: (note, ack) => send(`/api/console/kb/${encodeURIComponent(chName)}/rollback`, { changeId: it.id, baseHash: cur.srcHash, note, ack }),
          demote: (names, note) => demoteIntents(chName, names, note), onCancel: () => replace(slot), onDone: () => { C.packs = {}; reload(); },
        }));
      }
    } catch (e) { replace(slot, errBox(e)); }
  }
  function resetPanel(kind) {
    const slot = $('#hist-slot');
    const chName = C.channel;
    const go2 = async () => {
      const cur = kind === 'policy' ? await get(`/api/console/policy/${encodeURIComponent(chName)}`) : await get(`/api/console/kb/${encodeURIComponent(chName)}`, { lang: 'ko' });
      return cur;
    };
    go2().then((cur) => {
      replace(slot, publishPanel({
        channel: chName, title: kind === 'policy' ? '정책을 이미지 기본값으로 복원합니다' : 'KB를 이미지 기본값으로 복원합니다(한국어·영어 모두)', confirmText: '복원', packRows: (C.packs[chName] || {}).promotion,
        submit: (note, ack) => (kind === 'policy' ? send(`/api/console/policy/${encodeURIComponent(chName)}/reset`, { baseVersion: cur.version, note })
          : send(`/api/console/kb/${encodeURIComponent(chName)}/reset`, { baseHash: cur.srcHash, note, ack })),
        demote: kind === 'kb' ? (names, note) => demoteIntents(chName, names, note) : null,
        demote2: kind === 'policy' ? (g) => openInEditor(null, g) : null,
        onCancel: () => replace(slot), onDone: () => { C.packs = {}; reload(); },
      }));
    }).catch((e) => replace(slot, errBox(e)));
  }
  // 복원·되돌리기가 게이트에 막히면 정책 편집기로 가서 막힌 구성원을 L1로 내린 상태에서 이어 간다
  async function openInEditor(it, g) {
    let pack;
    if (it) { const r = await get(`/api/console/history/${encodeURIComponent(it.id)}`); pack = typeof r.content === 'string' ? JSON.parse(r.content) : r.content; }
    if (!pack) pack = clone((await get(`/api/console/policy/${encodeURIComponent(C.channel)}`)).pack);
    C.pendingPack = { channel: C.channel, pack: demoted(pack, (g.blocked || []).map((b) => b.member), g.channelCritical), msg: '막힌 구성원을 L1로 내린 상태입니다. [검사]로 확인한 뒤 게시하세요.' };
    go('policy');
    return new Promise(() => {});
  }

  build();
})();
