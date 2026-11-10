'use strict';
// 대시보드 정적 검사 — 서버 CSP(default-src 'self')가 막는 인라인 스타일·스크립트·HTML 문자열 삽입이 web/에 다시 들어오지 않게.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8');
const app = read('app.js');
const html = read('index.html');

test('app.js: h() 속성에 style 없음, HTML 문자열 삽입 없음', () => {
  assert.doesNotMatch(app, /\bstyle\s*:/, 'h() 속성의 style은 CSP가 막는다 — style.css 클래스로');
  assert.doesNotMatch(app, /\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML/);
});

test('index.html: 인라인 스크립트 본문·<style>·style 속성·on* 속성 없음', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc=/, '외부 파일만');
    assert.equal(body.trim(), '', '인라인 스크립트 본문');
  }
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('app.js: 브랜드·에이전트 상태는 인증 뒤 /api/status, 발신자 인증 실패 사유에 이름 — 공급자 배지는 그리지 않는다', () => {
  assert.match(app, /api\('\/api\/status'\)/);
  for (const src of [app, html, read('style.css')]) {
    assert.doesNotMatch(src, /provider-badges|class="badges"|agent-pill/, '상단 공급자 배지(llm·mail) 없음');
    assert.doesNotMatch(src, /테스트용/, '테스트용 꼬리표 없음');
  }
  assert.match(html, /id="agent-status"/, '에이전트 상태는 점과 글자');
  assert.doesNotMatch(app, /'\/api\/health'/);
  assert.match(app, /sender_unverified: '/);
});

test('style.css: 지표 타일은 줄어들어 잘리지 않고, 자리가 모자라면 오른쪽 묶음이 다음 줄로(1440px에서 지표 전부 보임)', () => {
  const css = read('style.css');
  const rule = (sel) => (css.match(new RegExp(`^${sel.replace('.', '\\.')} \\{([^}]*)\\}`, 'm')) || [])[1] || '';
  assert.match(rule('.topbar'), /flex-wrap:\s*wrap/);
  assert.match(rule('.kpis'), /flex:\s*1 0 auto/, '타일 폭 아래로 줄지 않는다');
  assert.match(rule('.kpis'), /max-width:\s*100%/, '좁은 화면에서는 줄 안에서 가로 스크롤');
  assert.match(rule('.topbar-right'), /margin-left:\s*auto/);
});

test('CRM 화면: /api/crm/ 목록·상세, 상태 탭 5개+전체(role=tablist), 라이브 피드·버전 다이얼로그·재오픈 없음', () => {
  assert.match(app, /api\(`\/api\/crm\/cases\?/);
  assert.match(app, /api\(`\/api\/crm\/cases\/\$\{/);
  assert.doesNotMatch(app, /api\(`\/api\/cases[?/]/, '목록·상세는 컬렉션(/api/crm/)만 읽는다');
  assert.match(html, /id="status-tabs" role="tablist"/);
  assert.match(app, /role: 'tab'/);
  const statuses = app.match(/const STATUSES = \[([^\]]*)\]/)[1];
  for (const s of ['New', 'Working', 'On Hold', 'Escalated', 'Closed']) assert.match(statuses, new RegExp(`'${s}'`));
  assert.match(app, /\['', '전체', 'all'\]/);
  for (const t of ['신규', '응대 중', '보류', '사람 전담', '종결', '승인 대기', '고객 회신 대기']) assert.match(app, new RegExp(`: '${t}'`));
  assert.match(app, /Working: '응대 중'/, 'Working 표시 이름은 응대 중');
  assert.doesNotMatch(app, /'처리 중'/, '옛 이름이 남지 않는다');
  assert.match(html, /<table class="case-table">/);
  for (const src of [app, html, read('style.css')]) {
    assert.doesNotMatch(src, /reopen|재오픈/);
    // 실시간 단계 피드·버전 다이얼로그는 없다. 답장 Agent 툴 기록(판정 기록의 trace)은 상세에서 보여 준다 — test/dashboard-trace.test.js
    assert.doesNotMatch(src, /트레이스|live-feed|에이전트 라이브|version-dialog|\/api\/versions/);
  }
  assert.doesNotMatch(app, /'agent\.step'/, '단계 이벤트를 받지 않는다');
});

test('CRM 화면: 종결 뒤 회신은 같은 케이스를 다시 연다 — 연결 케이스·후속 문의 칸 없음, 같은 질문 반복 사유에 이름', () => {
  assert.doesNotMatch(app, /후속 문의|relatedCase|followup:/);
  assert.match(app, /'종결 뒤 고객이 회신하면 이 케이스가 다시 열립니다'/);
  assert.match(app, /no_progress: '같은 질문 반복'/);
});

test('CRM 화면: 종결은 reason, 보류는 note, 보류·해제·종결은 expectedRevision, 409 stale이면 다시 읽기', () => {
  assert.match(app, /\/close`, \{[^}]*\breason: [^}]*\bexpectedRevision: /);
  assert.match(app, /\/hold`, \{[^}]*\bnote: [^}]*\bexpectedRevision: /);
  assert.match(app, /\/unhold`, \{[^}]*\bexpectedRevision: /);
  assert.match(app, /code === 'stale' && e\.data\.revision != null/);
  for (const k of ['resolved', 'no_response', 'duplicate', 'spam', 'not_applicable', 'other']) assert.match(app.match(/closeReason: \{[^}]*\}/)[0], new RegExp(`\\b${k}: '`));
  assert.match(app, /actions\.has\('hold'\)/, '버튼은 서버가 준 actions에서만');
});

test('CRM 화면: Path 단계 전환은 기존 행동(takeover·unhold·hold·return·close)만, 새 요청 경로 없음', () => {
  const moves = app.match(/const PATH_MOVES = \{([^}]*)\}/)[1];
  const used = [...moves.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['close', 'hold', 'return', 'takeover', 'unhold']);
  assert.doesNotMatch(moves, /\bNew\b/, '신규로는 가지 않는다');
  assert.match(app, /\(PATH_MOVES\[status\] \|\| \[\]\)\.find\(\(a\) => actions\.has\(a\)\)/, '단계는 서버가 준 actions에 있을 때만');
  assert.match(app, /'현재 상태로 변경'/);
  assert.doesNotMatch(app, /\b(alert|confirm|prompt)\(/, '확인은 화면 안 패널로');
  const posts = new Set([...app.matchAll(/post\(`\/api\/([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ':id')));
  assert.deepEqual([...posts].sort(), ['cases/:id/close', 'cases/:id/hold', 'cases/:id/human-reply', 'cases/:id/note', 'cases/:id/return',
    'cases/:id/takeover', 'cases/:id/unhold', 'drafts/:id/:id', 'drafts/:id/rate', 'drafts/:id/resolve-sending'], '명령 경로는 기존 것만');
  assert.match(app, /'aria-current': now \? 'step'/, '단계는 버튼, 현재 단계에 aria-current');
});

test('CRM 화면: 칸반 이동도 Path와 같은 표(takeover·unhold·hold·return·close)로 행동 하나, 카드는 키보드로 열고 aria-live', () => {
  const from = app.match(/const MOVE_FROM = \{([^}]*)\}/)[1];
  assert.deepEqual([...from.matchAll(/(\w+): \[/g)].map((m) => m[1]).sort(), ['close', 'hold', 'return', 'takeover', 'unhold']);
  const move = app.match(/const MOVE = \{([\s\S]*?)\n\};/)[1];
  assert.deepEqual([...move.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]).sort(), ['close', 'hold', 'return', 'takeover', 'unhold']);
  const board = app.slice(app.indexOf('async function boardMove('), app.indexOf('// ---------- 렌더: 섀도 평가 목록'));
  assert.match(board, /api\(`\/api\/crm\/cases\/\$\{/, '놓으면 상세를 새로 읽는다');
  assert.match(board, /moveTo\(status, new Set\(/, '그 상세의 actions로 행동을 고른다');
  assert.match(board, /MOVE\[move\]\(d\.case, d\.revision\)/, '그 상세의 revision을 expectedRevision으로');
  assert.doesNotMatch(board, /post\(/, '칸반은 자기 요청을 만들지 않는다');
  assert.doesNotMatch(app, /'상태 이동'|move-menu|kcard-move/, '카드의 상태 이동 메뉴 없음 — 키보드 대안은 상세의 진행 단계');
  const card = app.slice(app.indexOf('function kanbanCard('), app.indexOf('function markDropTargets('));
  assert.match(card, /role: 'button', tabindex: '0'/, '카드는 Tab으로 온다');
  assert.match(card, /e\.key === 'Enter' \|\| e\.key === ' '/, 'Enter·Space로 상세를 연다');
  assert.match(html, /id="board-live" role="status" aria-live="polite"/);
  assert.match(html, /id="view-list"[^>]*aria-pressed/);
  assert.match(app, /try \{ localStorage\.setItem\('cs-agent\.board'/);
  assert.match(app, /try \{ S\.board = localStorage\.getItem\('cs-agent\.board'\)/);
});

test('CRM 화면: 칸반 칸은 신규 · 응대 중 · 승인 대기 · 사람 전담 · 보류 · 종결, 승인 대기는 놓는 칸이 아니다', () => {
  const cols = app.match(/const COLUMNS = \[([\s\S]*?)\];\n/)[1];
  assert.deepEqual([...cols.matchAll(/\['([\w ]+)', '([^']+)'\]/g)].map((m) => [m[1], m[2]]),
    [['New', '신규'], ['Working', '응대 중'], ['Approval', '승인 대기'], ['Escalated', '사람 전담'], ['On Hold', '보류'], ['Closed', '종결']]);
  assert.match(app, /const colOf = \(c\) => \(c\.status === 'Working' && c\.subStatus === APPROVAL \? 'Approval' : c\.status\)/, '승인 대기 = Working + Awaiting Approval');
  const moves = app.match(/const PATH_MOVES = \{([^}]*)\}/)[1];
  assert.doesNotMatch(moves, /Approval|\bNew\b/, '승인 대기·신규 칸으로 가는 행동 없음 — 끌어서 승인·발송하지 않는다');
  assert.doesNotMatch(app, /approve.*boardMove|boardMove[\s\S]{0,400}approve/, '칸반은 승인 행동을 부르지 않는다');
  assert.match(app, /Approval: '승인 대기 칸에는 놓을 수 없습니다/, '놓으면 이유를 알린다');
  // 인수·종결은 대기 초안을 보내지 않고 내린다 — 확정 전에 그 문장을 보인다(칸반 놓기·버튼 줄·Path·종결 입력 칸)
  assert.match(app, /takeover: '승인 대기 초안은 보내지 않고 미선택 처리됩니다', close: '승인 대기 초안은 보내지 않고 닫힙니다'/);
  const board = app.slice(app.indexOf('async function boardMove('), app.indexOf('// ---------- 렌더: 섀도 평가 목록'));
  assert.match(board, /d\.pendingDraft \? DRAFT_DROP\[move\]/, '대기 초안이 있으면 놓기만으로 보내지 않고 상세 확인으로');
});

test('CRM 화면: 에이전트가 회전 중인 케이스에 「에이전트 응대 중」 — /api/agent/status의 activeCases로, 단계 이벤트는 받지 않는다', () => {
  assert.match(app, /activeCases\.includes\(id\)/);
  assert.match(app, /'에이전트 응대 중'/);
  assert.match(app, /api\('\/api\/agent\/status'\)/);
});

test('CRM 화면: 칸반 놓기는 카드당 한 번에 하나, 늦은 보드는 다시 읽고, 결과는 다시 읽은 칸으로 알린다 — 보드 밖 입력 칸의 포커스는 빼앗지 않는다', () => {
  const board = app.slice(app.indexOf('async function boardMove('), app.indexOf('// ---------- 렌더: 섀도 평가 목록'));
  assert.match(board, /const busy = `board:\$\{id\}`;\n {2}if \(S\.inflight\.has\(busy\)\) return;/, '같은 카드의 두 번째 놓기는 버린다');
  assert.match(board, /if \(colOf\(d\.case\) === status\)/, '다시 읽은 케이스가 이미 그 칸이면 새로 읽고 알린다');
  assert.match(board, /colOf\(now\) === status \?/, '옮긴 뒤 다시 읽은 칸으로 알린다');
  assert.match(app, /root\.contains\(active\)\)\) el\.focus/, '보드를 다시 그려도 검토자 이름 칸 등 보드 밖 포커스는 그대로');
  const agent = app.slice(app.indexOf('function renderAgent('), app.indexOf('// ---------- 렌더: 상태 탭'));
  for (const m of agent.matchAll(/txt\.textContent = ([^;]*);/g)) assert.doesNotMatch(m[1], /마지막|큐|재시도/, '상단 바 글자는 짧은 상태만 — 나머지는 툴팁');
});

// ---------- 지식·정책 화면(console.js, console.css) ----------
const cjs = read('console.js');
const ccss = read('console.css');

test('console: style 속성·HTML 문자열 삽입·확인창 없음, 인라인 핸들러 없음, 외부 주소 없음', () => {
  assert.doesNotMatch(cjs, /\bstyle\s*:/, 'h() 속성의 style은 CSP가 막는다');
  assert.doesNotMatch(cjs, /\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML/);
  assert.doesNotMatch(cjs, /\b(alert|confirm|prompt)\(/, '확인은 화면 안 패널로');
  assert.doesNotMatch(cjs, /\bon(click|change|input|submit|keydown)\s*=\s*["']/i);
  assert.doesNotMatch(cjs + ccss, /https?:\/\//i);
  assert.doesNotMatch(cjs + ccss, /@import|\burl\(/i, '외부 자원 없음');
});

test('console: index.html은 console.css·console.js 두 줄만 더하고 app.js 다음에 읽는다 — 버튼은 JS가 만들어 프로토타입에서 빠진다', () => {
  assert.match(html, /<link rel="stylesheet" href="console\.css">/);
  assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="console.js"'), 'console.js는 app.js 다음');
  assert.doesNotMatch(html, /지식·정책|console-dialog/, '진입 버튼과 다이얼로그는 console.js가 만든다');
  assert.match(cjs, /h\('dialog', \{ id: 'console-dialog'/);
  assert.match(cjs, /insertBefore\(open, rep\)/, '리포트 버튼 앞');
});

test('console: 운영 대시보드 금지 목록(트레이스·버전 보기 등)과 발송 시점 처리 용어가 화면 코드에 없다', () => {
  for (const [name, src] of [['console.js', cjs], ['console.css', ccss]]) {
    assert.doesNotMatch(src, /trace|트레이스|live-feed|에이전트 라이브|version-dialog|\/api\/versions/i, name);
    assert.doesNotMatch(src, /reopen|재오픈/, name);
    assert.doesNotMatch(src, /선점|claim|재확인|recheck|멱등|idempoten|SENDING|seen_?out|already_?answered|answered_?since|last_?out_?rowid|needs_?send_?check|sending_?draft|resolve[-_]?sending|send_?unconfirmed|send[-_]?check|발송 중/i, name);
  }
  // 고객사·CRM 상표 이름 없음
  assert.doesNotMatch(cjs + ccss, /salesforce|hubspot|zendesk|freshdesk|intercom|세일즈포스|허브스팟/i);
});

test('console: 에이전트 이름은 접수·답장·검수·인계 Agent, 단계 코드(phase)·영어 에이전트 이름이 화면 글자에 없다', () => {
  assert.match(cjs, /답장 Agent/);
  assert.doesNotMatch(cjs, /['"`][^'"`\n]*\b(triage|responder|reviewer agent|briefer)\b[^'"`\n]*['"`]/i, '코드 이름은 화면에 쓰지 않는다');
  assert.doesNotMatch(cjs, /\bphase\s*\d|P0|P1\b(?!.)/i);
});

test('console: 모든 입력은 ctl()로만 만들고 라벨 문자열을 받는다 — 라벨 없는 input·select·textarea 없음', () => {
  assert.doesNotMatch(cjs, /\bh\(\s*['"`](input|select|textarea)['"`]/, '컨트롤은 ctl(tag, 라벨, 속성)으로');
  assert.doesNotMatch(cjs, /createElement\(\s*['"`](input|select|textarea)/);
  assert.match(cjs, /const ctl = \(tag, label, attrs\) => h\(tag, \{ \.\.\.attrs, 'aria-label': label \}\)/);
  const calls = [...cjs.matchAll(/\bctl\(\s*'(input|select|textarea)'\s*,\s*([^,]*),/g)];
  assert.ok(calls.length >= 25, `ctl 호출 ${calls.length}개`);
  for (const [all, , lab] of calls) assert.match(lab.trim(), /^(label|'[^']+'|`[^`]+`)$/, `라벨이 문자열이어야 한다: ${all}`);
  assert.equal([...cjs.matchAll(/\bctl\(/g)].length, calls.length, 'ctl 호출은 모두 태그와 라벨을 문자열로 준다');
  // 사용자가 보는 라벨 칸: field()는 <label>로 감싼다
  assert.match(cjs, /const field = \(text, control, hint\) => h\('label'/);
  assert.match(cjs, /const check = \(text, input\) => h\('label'/);
});

test('console: 쓰기 버튼은 admin일 때만, 쓰기 접속이 아니면 이유를 보인다, 확인 단계는 화면 안에서', () => {
  assert.match(cjs, /const isAdmin = \(\) => !!\(C\.data && C\.data\.admin\)/);
  assert.match(cjs, /편집 권한 없음\(ADMIN_USERS\)/);
  assert.match(cjs, /이 접속 경로로는 편집할 수 없음/);
  assert.match(cjs, /isAdmin\(\) \? btn\('편집 초안 만들기'/);
  assert.match(cjs, /by = reviewer\(\);\n\s*if \(by\) u\.set\('by', by\)/, '루프백 접속의 GET은 ?by=');
  for (const lit of ['출하 데모 내용 — 고객 지식베이스 게시 전 자동 발송 금지', '올린 매뉴얼 본문은 변환을 위해 Anthropic API로 전송됩니다. 개인정보·내부 전용 문서는 빼고 올려 주세요.', '지금은 목업 변환 — 외부 전송 없음',
    '저장된 설정을 쓸 수 없어 이 채널은 모든 문의를 사람에게 넘기는 중', '한글에서 PDF로 내보내 주세요', '쪽을 나눠 PDF로 저장해 따로 올려 주세요']) assert.ok(cjs.includes(lit), lit);
});

test('console: 쓰기 요청은 정해진 경로만 — 게시·되돌리기·복원·폐기는 확인 패널을 거치고 L2 확인은 체크박스와 채널 이름 입력', () => {
  const paths = new Set([...cjs.matchAll(/(?:send|probe|get|api)\(`(\/api\/console[^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ':x').replace(/\?.*/, '')));
  for (const p of paths) assert.match(p, /^\/api\/console(\/(kb|drafts|policy|history)(\/:x)*(\/(check|publish|rollback|reset|drafts|convert|save|discard))?)?$/, p);
  for (const p of ['check', 'publish', 'rollback', 'reset', 'convert', 'save', 'discard']) assert.match(cjs, new RegExp(`/${p}\``), p);
  assert.match(cjs, /S2\.typed\.trim\(\) !== o\.channel/, '채널 이름을 쳐야 게시 버튼이 켜진다');
  assert.match(cjs, /!S2\.ackL2/, '체크박스');
  assert.match(cjs, /그 intent를 L1로 내리고 게시/);
  assert.match(cjs, /막힌 intent를 L1로 내리고 게시/);
  assert.match(cjs, /draft_busy|변환이 진행 중이라/);
  assert.match(cjs, /setTimeout\(\(\) => \{ if \(C\.tab === 'kb' && C\.draftId === id\)/, '변환 중 폴링');
  assert.match(cjs, /, 2000\)/, '2초마다');
});

test('console.css: 토큰만 쓰고 그라데이션·그림자 장식·색 값 직접 지정이 없다', () => {
  assert.doesNotMatch(ccss, /gradient|box-shadow|text-shadow|filter:|backdrop-filter/i);
  assert.doesNotMatch(ccss, /#[0-9a-f]{3,8}\b|rgba?\(/i, '색은 var(--…) 토큰으로');
  assert.match(ccss, /var\(--border\)/);
  assert.doesNotMatch(ccss, /!important/);
});
