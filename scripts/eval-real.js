'use strict';
// 실데이터 가능성 검토(docs/feasibility.md). 레포 밖에 둔 라벨 메일 쌍을 실제 루프(runCycle) + mock LLM으로 로컬에서만 돌린다.
// 사용: LLM_PROVIDER=mock node scripts/eval-real.js [데이터 폴더=../data] [출력 폴더=../eval-out]
// 개인정보: 네트워크 차단(fetch 무력화, mock 강제). 행별 결과는 출력 폴더(레포 밖 강제)에만, 표준 출력엔 집계만. 본문은 어디에도 안 쓴다.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

/** RFC 4180: 따옴표 필드, 필드 안 줄바꿈·"" 이스케이프, 앞 BOM. 행 = 헤더 키 객체. */
function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1 || r[0]).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// 라벨 문의유형 → 채널(수신함). 실서비스에선 메일이 어느 수신함으로 오든 그 채널 팩이 판단한다.
// 가정: 진행 중 캠페인 실무·제휴 제안은 B2B 메일이라 영업 수신함(sales)으로 들어온다 — 팩에 맞는 intent가 없으면 unclear로 넘긴다.
const CHANNEL = {
  '플랫폼 이용 문의': 'support', '크리에이터·채널 측 문의': 'support',
  '온보딩·도입': 'onboarding',
  '광고대행 견적·단가': 'sales', '캠페인 기획 문의': 'sales', '진행 중 캠페인 실무': 'sales', '제휴·협업 제안': 'sales',
};
const ROUTED = ['진행 중 캠페인 실무', '제휴·협업 제안']; // 위 가정으로 붙인 유형(보고서에 따로 표시)
const ASSIST = ['DRAFT', 'ANSWER_AND_HANDOFF'];
// stripQuotes가 못 걷은 인용 머리(줄 중간·콜론 끝 변형). 집계만 한다.
const QUOTE_LEFT_RE = /님이 작성|wrote:|Original Message|^\s*(보낸 사람|From):/m;

function guardEnv() {
  // 명시적 LLM_PROVIDER=mock만 받는다(비우면 ANTHROPIC_API_KEY가 있을 때 anthropic이 기본이 된다).
  const p = process.env.LLM_PROVIDER;
  if (p !== 'mock') { console.error(`거부: LLM_PROVIDER=${p ?? '(없음)'}. 실데이터는 LLM_PROVIDER=mock으로만 돈다.`); process.exit(1); }
  Object.assign(process.env, { LLM_PROVIDER: 'mock', MAIL_PROVIDER: 'mock', MAIL_MOCK_LOG: '0' });
  // CS_ABLATE: mock 메일이라 비교 실험 스위치가 먹는다 — 실데이터 평가는 늘 장치를 다 켠 채로
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'NOTIFY_WEBHOOK_URL', 'LLM_MOCK_DELAY_MS', 'SHADOW_CHANNELS', 'CS_ABLATE']) delete process.env[k];
  globalThis.fetch = () => { throw new Error('eval-real: 네트워크 차단'); };
}

async function main() {
  guardEnv();
  // 파서 자기 점검 — 따옴표·필드 안 줄바꿈·이스케이프·BOM·CRLF
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,\n""y""",2\r\n'), [{ a: 'x,\n"y"', b: '2' }]);

  const dataDir = path.resolve(process.argv[2] || path.join(ROOT, '..', 'data'));
  const outDir = path.resolve(process.argv[3] || path.join(ROOT, '..', 'eval-out'));
  if (!path.relative(ROOT, outDir).startsWith('..')) { console.error('거부: 출력 폴더가 레포 안이다.'); process.exit(1); }
  const read = (f) => parseCsv(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  const evalSet = read('eval_set.csv'); const labels = read('intent_labels.csv'); const pairs = read('reply_pairs.csv');
  // 종결 대리 지표: 사람 답장 뒤 같은 스레드에 고객 메일이 또 왔나(수신 시각만 본다 — 본문은 안 읽는다)
  const inboundAt = new Map();
  for (const m of read('messages.csv')) if (m['방향'] === '수신') inboundAt.set(m.threadId, [...(inboundAt.get(m.threadId) || []), Date.parse(m.receivedAt)]);
  const followUp = (p) => [p.threadId, p['답장threadId']].some((t) => (inboundAt.get(t) || []).some((x) => x > Date.parse(p['답장시각'])));

  // 조인: 라벨 → 쌍은 (쌍유형, threadId, 문의시각, 답장시각), 행번호(1부터)로 교차 확인. 평가셋 → 라벨은 (threadId, 문의시각).
  const pk = (r) => [r['쌍유형'], r.threadId, r['문의시각'], r['답장시각']].join('|');
  const pairIdx = new Map(pairs.map((p, i) => [pk(p), i]));
  assert.equal(pairIdx.size, pairs.length, '쌍 키 중복');
  for (const l of labels) assert.equal(pairIdx.get(pk(l)), Number(l['행번호']) - 1, '라벨↔쌍 조인 불일치');
  const ek = (r) => `${r.threadId}|${r['문의시각']}`;
  const labelByEval = new Map(); for (const l of labels) labelByEval.set(ek(l), [...(labelByEval.get(ek(l)) || []), l]);
  const evalLabels = evalSet.map((e) => { const m = labelByEval.get(ek(e)) || []; assert.equal(m.length, 1, '평가셋 조인'); return m[0]; });
  const csLabels = labels.filter((l) => l['CS범위여부'] === 'Y');

  const db = require('../server/db');
  const llm = require('../server/llm');
  const cases = require('../server/cases');
  const loop = require('../server/loop');
  const guard = require('../server/guard');
  llm.use('mock');
  // 사람 답장·에이전트 초안에 같은 잣대 — 팩 허용값 무시(pack 없음)로 금액·날짜 약속을 찾고, 링크는 있는지만. 인용 문구는 남기지 않는다.
  const risk = (body) => {
    const codes = new Set(guard.check({ body, only: ['amount', 'date_promise'] }).map((h) => h.code));
    return { amount: codes.has('amount'), datePromise: codes.has('date_promise'), link: !!String(body).match(guard.URL_RE) };
  };

  const cache = new Map(); // 같은 쌍은 한 번만 돌린다(평가셋 ⊂ CS)
  async function runOne(l) {
    const i = Number(l['행번호']) - 1;
    if (cache.has(i)) return cache.get(i);
    const p = pairs[i]; const channel = CHANNEL[l['문의유형']];
    const row = { 행번호: l['행번호'], threadId: l.threadId, 문의시각: l['문의시각'], 쌍유형: l['쌍유형'], 문의유형: l['문의유형'], 우리대응: l['우리대응'], 등급: l['자동화등급'], 필요지식: l['필요지식'], 테스트의심: p['테스트의심'] === 'Y', channel: channel || null, routed: ROUTED.includes(l['문의유형']) };
    // 사람 기준값: 실제 답장까지 걸린 시간·인용 뺀 답장 길이·금액/날짜 약속/링크
    const hBody = cases.stripQuotes(p['답장본문']) || String(p['답장본문']).trim();
    row.human = { hours: (Date.parse(p['답장시각']) - Date.parse(p['문의시각'])) / 36e5, len: hBody.length, ...risk(hBody), followUp: followUp(p) };
    if (!channel) row.skip = 'unmapped';
    else if (!String(p['문의본문']).trim()) row.skip = 'empty_body';
    else {
      db.init(':memory:'); // 쌍마다 새 DB — 스레드 앞 메일 없이 이 메시지 하나만 본다
      // 발신자는 가짜 주소(실주소는 루프 판단에 안 쓰인다). 인용 제거는 addInbound가 stripQuotes로 한다(/api/inbound와 같은 경로).
      const r = cases.addInbound({ channel, from: 'customer@example.invalid', subject: p['문의제목'], body: p['문의본문'], threadId: 'eval', providerMessageId: 'eval' });
      const t0 = performance.now();
      await loop.runCycle(r.caseId, r.messageId);
      const ms = performance.now() - t0;
      const m = db.get('SELECT body, body_clean FROM messages WHERE id=?', r.messageId);
      const draft = db.get("SELECT original_body FROM drafts WHERE case_id=? AND COALESCE(action, '')<>'ACK' ORDER BY created_at DESC LIMIT 1", r.caseId);
      // 1차 응대 3분류: 완전 자동응대(L2 자동 발송된 DRAFT) · 사람에게 넘김(접수 안내 / 답장+넘김 / 승인 대기 초안) · 응대 못함
      const ds = db.all('SELECT action, status, approved_by FROM drafts WHERE case_id=?', r.caseId);
      const autoSent = ds.some((d) => d.status === 'SENT' && d.approved_by === 'agent:auto' && d.action !== 'ACK');
      const ack = ds.some((d) => d.action === 'ACK' && d.status === 'SENT');
      const pending = ds.some((d) => d.status === 'PENDING');
      // LLM 호출 = Triage·Responder·Reviewer 판단 + Briefer(넘김마다 1)
      const llmCalls = db.get("SELECT COUNT(*) n FROM decisions WHERE case_id=? AND agent IN ('triage','responder','reviewer')", r.caseId).n
        + db.get('SELECT COUNT(*) n FROM handoffs WHERE case_id=?', r.caseId).n;
      const steps = db.all('SELECT step, action, reason, output FROM decisions WHERE case_id=? ORDER BY rowid', r.caseId);
      const last = (s) => steps.filter((x) => x.step === s).pop();
      const ex = last('execute') || {}; const tri = last('triage'); const g1 = last('gate1'); const g2 = last('gate2');
      const pf = last('prefilter');
      const by = pf && pf.action !== 'PASS' ? 'prefilter' : g2 ? (JSON.parse(g2.output).inputs?.from === 'responder' ? 'responder' : 'gate2') : g1 ? 'gate1' : 'other';
      const t = tri ? JSON.parse(tri.output) : null;
      Object.assign(row, {
        action: ex.action, reason: ex.reason, by, rule: JSON.parse((g2 || g1)?.output || '{}').rule ?? null,
        intent: t?.intent ?? null, confidence: t?.confidence ?? null, kbHit: t?.kbHit ?? null,
        guard: steps.filter((x) => x.step === 'guard' && x.reason).flatMap((x) => x.reason.split(',')),
        review: steps.filter((x) => x.step === 'review' && x.reason).flatMap((x) => x.reason.split(',')),
        stripped: m.body_clean.length < m.body.trim().length, quoteLeft: QUOTE_LEFT_RE.test(m.body_clean),
        // 에이전트 측정값: 회차 처리 시간(mock — LLM 지연 없음)·LLM 호출 수·초안 길이·같은 잣대 위험·마지막 guard 위반(승인 큐에 오른 초안이면 0이어야 한다)
        agent: { ms, llmCalls, draftLen: draft ? draft.original_body.length : null, ...(draft ? risk(draft.original_body) : {}), finalGuard: last('guard')?.reason || null, autoSent, ack, pending },
        bucket: autoSent && ex.action === 'DRAFT' ? 'auto' : ack || autoSent || pending ? 'handoff' : 'none',
        sub: autoSent && ex.action === 'DRAFT' ? 'auto' : ack ? 'ack' : autoSent ? 'aah_auto' : pending ? (ex.action === 'DRAFT' ? 'draft_pending' : 'aah_pending') : ex.action === 'IGNORE' ? 'ignored' : 'no_ack',
      });
    }
    cache.set(i, row);
    return row;
  }

  const evalRows = []; for (const l of evalLabels) evalRows.push(await runOne(l));
  const csRows = []; for (const l of csLabels) csRows.push(await runOne(l));

  fs.mkdirSync(outDir, { recursive: true });
  const ordered = [...cache.values()].sort((a, b) => a.행번호 - b.행번호);
  fs.writeFileSync(path.join(outDir, 'rows.jsonl'), ordered.map((r) => JSON.stringify({ ...r, inEval: evalRows.includes(r) })).join('\n') + '\n');
  const summary = { joins: { pairs: pairs.length, labels: labels.length, eval: evalLabels.length, cs: csLabels.length }, eval: summarize(evalRows), cs: summarize(csRows) };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  printReport(summary);
  const sc = scenarios(csRows, evalRows);
  fs.writeFileSync(path.join(outDir, 'scenarios.json'), JSON.stringify(sc, null, 2) + '\n');
  printScenarios(sc);
}

/* ---- 시나리오 태스크: (문의유형 · 사람 대응) 조합마다 사람 실제 응대 vs 에이전트 회차 ---- */
const ACK = '단순 확인·감사';
// 분위수(선형 보간). P90은 n<10이면 비운다 — 작은 그룹에선 사실상 최댓값이다
const med = (a, p = 0.5) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length || (p > 0.5 && s.length < 10)) return null;
  const i = (s.length - 1) * p; const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const share = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);

function compare(all) {
  const rows = all.filter((r) => !r.skip);
  const drafted = rows.filter((r) => r.agent.draftLen != null);
  const ho = rows.filter((r) => r.등급 === 'human_only'); const as = rows.filter((r) => r.등급 !== 'human_only');
  const act = (a) => rows.filter((r) => r.action === a).length;
  // 사람 쪽도 에이전트가 돈 행만(같은 분모). 에이전트 채널이 없는 시나리오(SKIP)만 전부
  const h = (rows.length ? rows : all).map((r) => r.human);
  return {
    n: all.length, run: rows.length, skipped: all.length - rows.length,
    grade: tally(all.map((r) => r.등급)),
    human: {
      // 사람은 전부 직접 작성. 응답 시간은 문의 → 실제 답장(시간)
      writes: h.length, hoursP50: med(h.map((x) => x.hours)), hoursP90: med(h.map((x) => x.hours), 0.9),
      sameDay: share(h, (x) => x.hours <= 24), lenP50: med(h.map((x) => x.len)),
      amount: share(h, (x) => x.amount), datePromise: share(h, (x) => x.datePromise), link: share(h, (x) => x.link),
    },
    agent: {
      DRAFT: act('DRAFT'), ANSWER_AND_HANDOFF: act('ANSWER_AND_HANDOFF'), HANDOFF: act('HANDOFF'), IGNORE: act('IGNORE'),
      // 사람이 직접 써야 하는 몫: 넘김(브리핑 받고 작성) + 답장+넘김(후속). DRAFT는 검토·승인만
      writes: rows.filter((r) => ['HANDOFF', 'ANSWER_AND_HANDOFF'].includes(r.action)).length,
      approveOnly: act('DRAFT'),
      msP50: med(rows.map((r) => r.agent.ms)), msP90: med(rows.map((r) => r.agent.ms), 0.9),
      llmCallsP50: med(rows.map((r) => r.agent.llmCalls)), llmCallsMax: rows.length ? Math.max(...rows.map((r) => r.agent.llmCalls)) : null,
      lenP50: med(drafted.map((r) => r.agent.draftLen)),
      amount: share(drafted, (r) => r.agent.amount), datePromise: share(drafted, (r) => r.agent.datePromise), link: share(drafted, (r) => r.agent.link),
      shippedGuard: drafted.filter((r) => r.agent.finalGuard).length,
      // 판단 일치: 사람 몫(human_only)은 넘김·답장+넘김, 보조 대상은 초안·답장+넘김
      agree: share(rows, (r) => (r.등급 === 'human_only' ? ['HANDOFF', 'ANSWER_AND_HANDOFF'] : ASSIST).includes(r.action)),
      critical: ho.filter((r) => r.action === 'DRAFT').length,
      // 사람은 답했는데 에이전트는 조용히 둠(감사 인사 응대는 제외)
      silent: rows.filter((r) => r.action === 'IGNORE' && r.우리대응 !== ACK).length,
      assistRate: as.length ? as.filter((r) => ASSIST.includes(r.action)).length / as.length : null,
    },
    // 1차 응대 3분류 — 완전 자동응대 · 사람에게 넘김(접수 안내·답장+넘김·승인 대기 초안) · 응대 못함
    first: {
      auto: rows.filter((r) => r.bucket === 'auto').length, handoff: rows.filter((r) => r.bucket === 'handoff').length, none: rows.filter((r) => r.bucket === 'none').length,
      sub: tally(rows.map((r) => r.sub)),
      immediate: share(rows, (r) => r.agent.autoSent || r.agent.ack), // 사람 손 없이 고객이 바로 받은 첫 응답(자동 답·접수 안내)
      any: share(rows, (r) => r.bucket !== 'none'), // 승인 대기 초안까지 포함한 1차 응대율
      autoCritical: rows.filter((r) => r.bucket === 'auto' && r.등급 === 'human_only').length, // 사람 몫인데 자동 발송됨
      autoFollowUp: share(rows.filter((r) => r.bucket === 'auto'), (r) => r.human.followUp), // 같은 문의에 사람이 답한 뒤 재문의율(종결 대리)
    },
    humanFollowUp: share(rows.length ? rows : all, (r) => r.human.followUp),
    kb: tally(rows.map((r) => (r.kbHit === true ? 'KB 있음' : r.kbHit === 'partial' ? 'KB 일부' : r.kbHit === false ? 'KB 없음' : '분류 전 거름'))),
  };
}

/** 필요지식(라벨) 주제별 — 그 지식이 KB(FAQ)에 있었나와 3분류. 주제는 라벨 문구(본문 아님). */
function knowledge(rows) {
  const by = new Map();
  for (const r of rows.filter((x) => !x.skip)) {
    for (const k of String(r.필요지식 || '').split(/[,·;|/]/).map((s) => s.trim()).filter((s) => s && s !== '-')) by.set(k, [...(by.get(k) || []), r]);
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 25).map(([topic, rs]) => ({
    topic, n: rs.length, kbYes: share(rs, (r) => r.kbHit === true || r.kbHit === 'partial'),
    auto: rs.filter((r) => r.bucket === 'auto').length, handoff: rs.filter((r) => r.bucket === 'handoff').length, none: rs.filter((r) => r.bucket === 'none').length,
    humanOnly: rs.filter((r) => r.등급 === 'human_only').length,
  }));
}

function scenarios(csRows, evalRows) {
  const groups = new Map();
  for (const r of csRows) { const k = `${r.문의유형} · ${r.우리대응}`; groups.set(k, [...(groups.get(k) || []), r]); }
  const tasks = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, rs], i) => {
    const c = compare(rs);
    const status = !c.run ? 'SKIP' : c.agent.critical ? 'FAIL' : c.agent.silent || c.agent.shippedGuard ? 'WARN' : 'PASS';
    return { id: `S${String(i + 1).padStart(2, '0')}`, scenario: k, channel: rs[0].channel, evalN: rs.filter((r) => evalRows.includes(r)).length, status, ...c };
  });
  const per = Object.fromEntries(['support', 'onboarding', 'sales'].map((ch) => [ch, compare(csRows.filter((r) => r.channel === ch))]));
  return { mode: process.env.AUTO_SEND === '0' ? 'L1(AUTO_SEND=0)' : 'L2', tasks, total: compare(csRows), mapped: compare(csRows.filter((r) => r.channel)), routed: compare(csRows.filter((r) => r.routed)), per, eval: compare(evalRows), knowledge: knowledge(csRows), status: tally(tasks.map((t) => t.status)) };
}

function printScenarios(s) {
  const p = (x) => (x == null ? '-' : `${Math.round(100 * x)}%`);
  const f = (x, d = 1) => (x == null ? '-' : Number(x).toFixed(d));
  const out = ['', '### 시나리오 태스크 — 사람 실제 응대 vs 에이전트(mock LLM)', `상태: ${Object.entries(s.status).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '',
    '| ID | 시나리오 | 채널 | n | 상태 | 사람 응답 P50·P90(h) | 에이전트 코드 처리 P50(ms) · LLM 호출 P50/최대 | 사람 직접 작성 → 에이전트 모드 | 승인만 | 판단 일치 | 치명 | 침묵 | 금액 언급 사람→초안 | 날짜 약속 사람→초안 | 길이 P50 사람→초안 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const line = (id, name, ch, c, st) => out.push(`| ${id} | ${name} | ${ch ?? '-'} | ${c.run && c.run !== c.n ? `${c.n} (실행 ${c.run})` : c.n} | ${st} | ${f(c.human.hoursP50)}·${f(c.human.hoursP90)} | ${c.run ? `${f(c.agent.msP50, 2)} · ${f(c.agent.llmCallsP50)}/${c.agent.llmCallsMax}` : '-'} | ${c.human.writes} → ${c.run ? c.agent.writes : '-'} | ${c.run ? c.agent.approveOnly : '-'} | ${p(c.agent.agree)} | ${c.run ? c.agent.critical : '-'} | ${c.run ? c.agent.silent : '-'} | ${p(c.human.amount)}→${p(c.agent.amount)} | ${p(c.human.datePromise)}→${p(c.agent.datePromise)} | ${f(c.human.lenP50, 0)}→${f(c.agent.lenP50, 0)} |`);
  for (const t of s.tasks) line(t.id, t.scenario, t.channel, t, t.status);
  line('Σ', 'CS 전체', null, s.total, '');
  line('Σ', '에이전트 채널 있는 것', null, s.mapped, '');
  for (const [ch, c] of Object.entries(s.per)) line('Σ', ch, ch, c, '');
  line('Σ', '평가셋', null, s.eval, '');
  // 1차 응대 3분류
  out.push('', `### 1차 응대 3분류 — 모드 ${s.mode}`, '',
    '| ID | 시나리오 | 실행 | 완전 자동응대 | 넘김: 접수 안내 · 답장+넘김 · 승인 대기 초안 | 응대 못함(무시 · 안내 제외) | 즉시 응대 | 초안 포함 응대 | 자동인데 사람 몫 | 사람 답 뒤 재문의(자동 대상) |',
    '|---|---|---|---|---|---|---|---|---|---|');
  const sub = (c, k) => c.first.sub[k] || 0;
  const fl = (id, name, c) => out.push(`| ${id} | ${name} | ${c.run} | ${c.first.auto} | ${c.first.handoff}: ${sub(c, 'ack')} · ${sub(c, 'aah_auto') + sub(c, 'aah_pending')} · ${sub(c, 'draft_pending')} | ${c.first.none}: ${sub(c, 'ignored')} · ${sub(c, 'no_ack')} | ${p(c.first.immediate)} | ${p(c.first.any)} | ${c.first.autoCritical} | ${p(c.first.autoFollowUp)} |`);
  for (const t of s.tasks) if (t.run) fl(t.id, t.scenario, t);
  fl('Σ', 'CS 전체', s.total); for (const [ch, c] of Object.entries(s.per)) fl('Σ', ch, c); fl('Σ', '가정 라우팅(캠페인 실무·제휴)', s.routed); fl('Σ', '평가셋', s.eval);
  out.push('', `사람 답장 뒤 재문의율(전체): ${p(s.total.humanFollowUp)} · KB 근거: ${Object.entries(s.total.kb).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '',
    '### 필요지식(FAQ) 주제별 — KB 있음 · 3분류', '', '| 주제 | n | KB 있음 | 완전 자동 | 넘김 | 응대 못함 | 사람 몫 라벨 |', '|---|---|---|---|---|---|---|');
  for (const k of s.knowledge) out.push(`| ${k.topic} | ${k.n} | ${p(k.kbYes)} | ${k.auto} | ${k.handoff} | ${k.none} | ${k.humanOnly} |`);
  console.log(out.join('\n'));
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
const tally = (arr) => { const m = {}; for (const x of arr) m[x] = (m[x] || 0) + 1; return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))); };

function stats(rows) {
  const ho = rows.filter((r) => r.등급 === 'human_only'); const as = rows.filter((r) => r.등급 !== 'human_only');
  const n = (a, f) => a.filter(f).length;
  return {
    n: rows.length,
    humanOnly: { n: ho.length, HANDOFF: n(ho, (r) => r.action === 'HANDOFF'), DRAFT: n(ho, (r) => r.action === 'DRAFT'), ANSWER_AND_HANDOFF: n(ho, (r) => r.action === 'ANSWER_AND_HANDOFF'), IGNORE: n(ho, (r) => r.action === 'IGNORE') },
    assist: { n: as.length, assisted: n(as, (r) => ASSIST.includes(r.action)), DRAFT: n(as, (r) => r.action === 'DRAFT'), ANSWER_AND_HANDOFF: n(as, (r) => r.action === 'ANSWER_AND_HANDOFF'), HANDOFF: n(as, (r) => r.action === 'HANDOFF'), IGNORE: n(as, (r) => r.action === 'IGNORE') },
    ignore: n(rows, (r) => r.action === 'IGNORE'),
    by: tally(rows.map((r) => r.by)),
    actions: tally(rows.map((r) => r.action)),
    reasons: tally(rows.map((r) => `${r.action}:${r.reason ?? '-'}`)),
    intents: tally(rows.map((r) => r.intent ?? `(prefilter:${r.reason})`)),
    guard: tally(rows.flatMap((r) => r.guard)),
    review: tally(rows.flatMap((r) => r.review)),
    unclearOrLowConf: n(rows, (r) => ['unclear', 'low_confidence'].includes(r.reason)),
    triageUnclear: n(rows, (r) => r.intent === 'unclear'),
    stripped: n(rows, (r) => r.stripped), quoteLeft: n(rows, (r) => r.quoteLeft), test: n(rows, (r) => r.테스트의심),
  };
}

function summarize(all) {
  const rows = all.filter((r) => !r.skip);
  const per = {}; for (const ch of ['support', 'onboarding', 'sales']) per[ch] = stats(rows.filter((r) => r.channel === ch));
  const misses = (f) => tally(rows.filter((r) => r.등급 === 'human_only' && f(r)).map((r) => `${r.channel} · ${r.문의유형} · ${r.우리대응} → ${r.by}/${r.intent ?? '-'}/rule ${r.rule ?? '-'}/${r.action}:${r.reason ?? '-'}`));
  return {
    total: all.length, skipped: tally(all.filter((r) => r.skip).map((r) => `${r.skip}:${r.문의유형}`)),
    all: stats(rows), per,
    criticalDraft: misses((r) => r.action === 'DRAFT'),
    partialAnswerAndHandoff: misses((r) => r.action === 'ANSWER_AND_HANDOFF'),
    ignoredHumanOnly: misses((r) => r.action === 'IGNORE'),
  };
}

function printReport(s) {
  const out = [];
  const head = (h) => out.push('', `### ${h}`);
  const table = (cols, rows) => { out.push(`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`); for (const r of rows) out.push(`| ${r.join(' | ')} |`); };
  const kv = (o, top = 99) => Object.entries(o).slice(0, top).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
  out.push(`조인: 쌍 ${s.joins.pairs} · 라벨 ${s.joins.labels} · 평가셋 ${s.joins.eval} · CS 라벨 ${s.joins.cs}`);
  for (const [name, x] of [['평가셋 60', s.eval], ['CS 전체', s.cs]]) {
    head(`${name} — 대상 ${x.total}, 실행 ${x.all.n}, 건너뜀 ${kv(x.skipped)}`);
    const line = (label, t) => [label, t.n, `${t.humanOnly.HANDOFF}/${t.humanOnly.n} (${pct(t.humanOnly.HANDOFF, t.humanOnly.n)})`, t.humanOnly.DRAFT, t.humanOnly.ANSWER_AND_HANDOFF, t.humanOnly.IGNORE,
      `${t.assist.assisted}/${t.assist.n} (${pct(t.assist.assisted, t.assist.n)})`, `${t.assist.HANDOFF}`, `${t.ignore} (${pct(t.ignore, t.n)})`, `${t.unclearOrLowConf} (${pct(t.unclearOrLowConf, t.n)})`];
    table(['채널', 'n', 'human_only 넘김 재현율', 'human_only→DRAFT(치명)', '→답장+넘김', '→IGNORE', '보조율(draft_approve·auto_ok)', '보조 대상→넘김', 'IGNORE', 'unclear·low_conf 사유'],
      [line('전체', x.all), ...Object.entries(x.per).map(([ch, t]) => line(ch, t))]);
    out.push('', `- 판단 단계: ${kv(x.all.by)}`, `- 최종 행동: ${kv(x.all.actions)}`, `- 최종 행동:사유 상위: ${kv(x.all.reasons, 12)}`,
      `- 분류 intent 상위: ${kv(x.all.intents, 12)}`, `- guard 위반 코드: ${kv(x.all.guard)} · 검수 실패: ${kv(x.all.review)}`,
      `- triage intent=unclear: ${x.all.triageUnclear} · 인용 제거됨 ${x.all.stripped} · 인용 머리 잔존 ${x.all.quoteLeft} · 테스트의심 ${x.all.test}`);
    for (const ch of Object.keys(x.per)) out.push(`- ${ch} 판단 단계: ${kv(x.per[ch].by)} · intent: ${kv(x.per[ch].intents, 6)}`);
    for (const [label, m] of [['치명 누락(human_only→DRAFT)', x.criticalDraft], ['부분(human_only→답장+넘김)', x.partialAnswerAndHandoff], ['무시(human_only→IGNORE)', x.ignoredHumanOnly]]) {
      out.push('', `${label}:`); for (const [k, v] of Object.entries(m)) out.push(`  - ${v} · ${k}`);
    }
  }
  console.log(out.join('\n'));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { parseCsv };
