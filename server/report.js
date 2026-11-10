'use strict';
// 운영 리포트(읽기 전용): LLM 사용량·비용·지연(llm_calls), intent별 승격 지표, 미평가 섀도 초안 목록, 업무 대체율.
const db = require('./db');
const policy = require('./policy');

// 숫자 env — 비었거나 숫자가 아니면 null
const num = (v) => { const s = String(v ?? '').trim(); return s && Number.isFinite(Number(s)) ? Number(s) : null; };
const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const day = (now) => now.toISOString().slice(0, 10);
const nextDay = (now) => new Date(Date.parse(day(now)) + 86_400_000).toISOString().slice(0, 10);

/** 오늘(UTC — 한국 시간 09:00 초기화) 쓴 입력+출력 토큰과 일일 상한. 상한이 비면 null(무제한), 잘못된 값은 0(전부 차단 — 서버는 시작 검사가 막는다). */
function budget(now = new Date()) {
  const raw = String(process.env.LLM_DAILY_TOKEN_BUDGET || '').trim();
  const { used } = db.get('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) used FROM llm_calls WHERE created_at >= ? AND created_at < ?', day(now), nextDay(now));
  return { limit: raw ? Math.max(Number(raw) || 0, 0) : null, used };
}

/** 백만 토큰당 USD 단가 두 개가 다 있을 때만 비용, 아니면 null(모델 가격을 코드에 박지 않는다). */
function costUsd(inputTokens, outputTokens) {
  const pi = num(process.env.LLM_PRICE_INPUT_PER_MTOK); const po = num(process.env.LLM_PRICE_OUTPUT_PER_MTOK);
  return pi == null || po == null ? null : round((inputTokens * pi + outputTokens * po) / 1e6, 6);
}

const SUMS = 'COUNT(*) calls, COALESCE(SUM(input_tokens), 0) inputTokens, COALESCE(SUM(output_tokens), 0) outputTokens';
const withCost = (r) => ({ ...r, costUsd: costUsd(r.inputTokens, r.outputTokens) });

/** /api/report의 llm 칸. perCase = 케이스가 붙은 호출만, 케이스당 토큰·비용·LLM 지연 합의 평균. */
function llmUsage(now = new Date()) {
  const pc = db.get(`SELECT COUNT(DISTINCT case_id) cases, ${SUMS}, COALESCE(SUM(latency_ms), 0) latencyMs FROM llm_calls WHERE case_id IS NOT NULL`);
  const per = (v) => (pc.cases ? v / pc.cases : null);
  const pcCost = costUsd(pc.inputTokens, pc.outputTokens);
  return {
    today: withCost(db.get(`SELECT ${SUMS} FROM llm_calls WHERE created_at >= ? AND created_at < ?`, day(now), nextDay(now))),
    budget: budget(now),
    total: withCost(db.get(`SELECT ${SUMS} FROM llm_calls`)),
    perCase: {
      cases: pc.cases,
      avgTokens: round(per(pc.inputTokens + pc.outputTokens), 0),
      avgCostUsd: pcCost == null ? null : round(per(pcCost), 6),
      avgLatencyMs: round(per(pc.latencyMs), 0),
    },
    byAgent: db.all(`SELECT agent, ${SUMS}, COALESCE(SUM(ok = 0), 0) failures, CAST(ROUND(AVG(latency_ms)) AS INTEGER) avgLatencyMs FROM llm_calls GROUP BY agent ORDER BY agent`).map(withCost),
    models: db.all('SELECT provider, model, COUNT(*) calls FROM llm_calls GROUP BY provider, model ORDER BY calls DESC'),
  };
}

/**
 * intent별 L0→L1 승격 지표. 표본은 cases.promotion(channel)과 같다 — 발송된 에이전트 초안(사람 승인, ACK·직접 답장 제외, 무수정 = final_body 없음)
 * + 섀도 초안 평가(초안당 마지막 평가). 채널별로 합하면 cases.promotion과 같은 값이 나온다. 기준은 policy.PROMOTION.
 */
function promotionByIntent() {
  const P = policy.PROMOTION;
  const acc = new Map();
  const at = (channel, intent) => {
    const k = `${channel}\u0000${intent ?? ''}`;
    if (!acc.has(k)) acc.set(k, { channel, intent, reviewed: 0, good: 0, critical: 0 });
    return acc.get(k);
  };
  for (const r of db.all(`SELECT c.channel, d.intent, COUNT(*) n, COALESCE(SUM(d.final_body IS NULL), 0) ok, COALESCE(SUM(COALESCE(d.edit_tags, '') LIKE '%critical%'), 0) crit
    FROM drafts d JOIN cases c ON c.id=d.case_id WHERE d.status='SENT' AND COALESCE(d.action, '') NOT IN ('HUMAN_REPLY','ACK') AND COALESCE(d.approved_by, '')<>'agent:auto'
    GROUP BY c.channel, d.intent`)) {
    const a = at(r.channel, r.intent); a.reviewed += r.n; a.good += r.ok; a.critical += r.crit;
  }
  const ratings = new Map(); // 초안당 마지막 평가만
  for (const r of db.all(`SELECT c.channel, d.intent, json_extract(a.payload, '$.draftId') draftId, json_extract(a.payload, '$.rating') rating
    FROM activities a JOIN cases c ON c.id=a.case_id LEFT JOIN drafts d ON d.id=json_extract(a.payload, '$.draftId')
    WHERE a.type='shadow_rating' ORDER BY a.created_at, a.rowid`)) if (r.draftId) ratings.set(r.draftId, r);
  for (const r of ratings.values()) {
    const a = at(r.channel, r.intent); a.reviewed += 1; a.good += r.rating === 'good' ? 1 : 0; a.critical += r.rating === 'critical' ? 1 : 0;
  }
  // 등급 칸은 지금 실제로 도는 등급이다(policy.decide와 같은 순서) — H가 어디든 있으면 H, 섀도 채널(팩 shadow·SHADOW_CHANNELS)은 L0,
  // 그 밖에는 intent 등급과 팩 maxLevel 중 낮은 쪽(L0 < L1 < L2는 문자열 순서와 같다), 자동 발송이 꺼져 있으면(policy.autoAllowed) L2도 L1.
  // 등급이 없는 intent(ack·ignore)는 null.
  const packs = {};
  const level = (channel, intent) => {
    const p = (packs[channel] ??= policy.load(channel));
    const lv = p?.intents?.[intent]?.level;
    if (!lv) return null;
    if (lv === 'H' || p.maxLevel === 'H') return 'H';
    if (p.shadow) return 'L0';
    const v = lv < p.maxLevel ? lv : p.maxLevel;
    return v === 'L2' && !policy.autoAllowed(p) ? 'L1' : v;
  };
  const rows = [...acc.values()].map(({ channel, intent, reviewed, good, critical }) => {
    const approvedNoEditRate = reviewed ? Math.round((good / reviewed) * 1000) / 1000 : 0;
    return {
      channel, intent: intent ?? '(없음)', level: level(channel, intent), reviewed, approvedNoEditRate, criticalCount: critical,
      eligible: reviewed >= P.minReviewed && approvedNoEditRate >= P.minNoEditRate && critical <= P.maxCritical,
    };
  }).sort((a, b) => a.channel.localeCompare(b.channel) || a.intent.localeCompare(b.intent));
  return { criteria: P, rows };
}

const CSV_COLS = ['channel', 'intent', 'level', 'reviewed', 'approvedNoEditRate', 'criticalCount', 'eligible'];
// 스프레드시트 수식 주입 — intent는 LLM 출력이라 실제로 닿는다. = + - @ TAB CR로 시작하는 칸은 ' 접두
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** promotionByIntent 표의 CSV(머리줄 + 행). */
const promotionCsv = () => [CSV_COLS, ...promotionByIntent().rows.map((r) => CSV_COLS.map((k) => r[k]))].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';

/** 아직 평가하지 않은 섀도 초안, 최신순. 원문을 파기한 케이스는 뺀다. question = 트리거 고객 메시지(인용 제거본) 1,000자. */
function unratedShadow({ channel, limit = 100 } = {}) {
  const lim = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
  return db.all(`SELECT d.id draftId, d.case_id caseId, c.channel, d.intent, d.created_at createdAt, COALESCE(m.subject, c.subject) subject,
      substr(m.body_clean, 1, 1000) question, d.original_body body
    FROM drafts d JOIN cases c ON c.id=d.case_id LEFT JOIN messages m ON m.id=d.trigger_message_id
    WHERE d.status='SHADOW' AND c.purged_at IS NULL AND (? IS NULL OR c.channel=?)
      AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.case_id=d.case_id AND a.type='shadow_rating' AND json_extract(a.payload, '$.draftId')=d.id)
    ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`, channel || null, channel || null, lim);
}

/*
 * 업무 대체율 — 1단위 = 메시지 1통(고객 수신 1 · 나간 답장 1, 내부 메모는 messages에 없다). 단위마다 처리 주체 하나(위에서부터 처음 맞는 것).
 * 단위에서 빼고 따로 세는 것: 접수 안내(sent_by='ack', 답장이 아니다) → ackCount, 아직 execute 판단이 없는 수신(대기·회차 중·재시도 대기) → pendingCount.
 *  agent    에이전트 처리 — 사람 손 없이 끝남. 수신: 마지막 execute 판단이 IGNORE(사람 전담 케이스에 온 메시지 제외)이거나, 종결 케이스라 ABORTED로 멈췄는데
 *           그 메시지의 마지막 prefilter·gate1 판단이 IGNORE(사람 전담 제외)이거나, 그 메시지의 답장 초안이 agent:auto로 SENT(L2 자동 답변).
 *           발신: agent:auto 초안(L2 자동 답변)
 *  assisted 에이전트 보조 — 에이전트가 분류·초안을 내고 결정은 사람. 수신: triage 판단 또는 에이전트 초안이 있음. 발신: 사람이 승인·수정한 에이전트 초안
 *  human    사람 처리 — 에이전트 일 없음. 수신: 1차 거르기에서 바로 넘김(브리핑이 있어도), 사람 전담 케이스에 온 메시지. 발신: 사람이 직접 쓴 답장
 * 발신 메시지와 초안은 같은 케이스·같은 시각(drafts.sent_at = messages.occurred_at)으로 잇는다 — 메시지 행에 초안 id가 없다.
 * case_id 조건으로 decisions_case·drafts_case 인덱스를 탄다. `+d.status`는 상태 조건이 drafts_status를 고르지 못하게 막는다(cases.stats와 같다) —
 * 고르면 메시지마다 SENT 초안 전부를 훑는다.
 * 단순화: 뒤 메시지에 밀려 중단(ABORTED)된 회차의 메시지는 보조로 센다 — 그 답은 뒤 메시지 회차가 냈다. 정확히 하려면 뒤 메시지의 분류를 물려받는다.
 */
const WORKLOAD_SQL = `SELECT c.channel, m.direction dir, CASE
    WHEN m.direction='in' THEN CASE
      WHEN x.rowid IS NULL THEN 'pending'
      WHEN (x.action='IGNORE' AND COALESCE(x.reason, '')<>'responder_human')
        OR (x.action='ABORTED' AND EXISTS (SELECT 1 FROM decisions g WHERE g.rowid=(SELECT MAX(rowid) FROM decisions WHERE case_id=m.case_id AND message_id=m.id AND step IN ('prefilter','gate1'))
          AND g.action='IGNORE' AND COALESCE(g.reason, '')<>'responder_human'))
        OR EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=m.case_id AND d.trigger_message_id=m.id AND d.action='DRAFT' AND +d.status='SENT' AND d.approved_by='agent:auto') THEN 'agent'
      WHEN EXISTS (SELECT 1 FROM decisions t WHERE t.case_id=m.case_id AND t.message_id=m.id AND t.step='triage')
        OR EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=m.case_id AND d.trigger_message_id=m.id AND COALESCE(d.action, '') NOT IN ('ACK','HUMAN_REPLY')) THEN 'assisted'
      ELSE 'human' END
    WHEN m.sent_by='ack' THEN 'ack'
    WHEN COALESCE(m.sent_by, '') <> 'agent' THEN 'human'
    WHEN EXISTS (SELECT 1 FROM drafts d WHERE d.case_id=m.case_id AND +d.status='SENT' AND d.sent_at=m.occurred_at AND d.approved_by='agent:auto') THEN 'agent'
    ELSE 'assisted' END bucket, COUNT(*) n
  FROM messages m JOIN cases c ON c.id=m.case_id
  LEFT JOIN decisions x ON m.direction='in' AND x.rowid=(SELECT MAX(rowid) FROM decisions WHERE case_id=m.case_id AND message_id=m.id AND step='execute')
  WHERE (?1 IS NULL OR m.occurred_at>=?1) AND (?2 IS NULL OR m.occurred_at<?2) AND (?3 IS NULL OR c.channel=?3)
  GROUP BY c.channel, dir, bucket ORDER BY c.channel`;

const rate = (n, total) => (total ? Math.round((n / total) * 1000) / 1000 : null);
const withRates = (o) => ({ ...o, agentRate: rate(o.agent, o.total), assistedRate: rate(o.assisted, o.total), humanRate: rate(o.human, o.total) });
const SIDE = { ack: 'ackCount', pending: 'pendingCount' }; // 단위 밖에서 따로 세는 분류

/**
 * 업무 대체율 집계(읽기 전용). from 이상 · to 미만(messages.occurred_at, ISO), channel = cases.channel. 비면 전체. 비율은 소수 셋째 자리, 단위 0이면 null.
 * ackCount = 단위에서 뺀 접수 안내 통수, pendingCount = 아직 판단 전이라 뺀 수신 통수(둘 다 전체·채널별).
 */
function workload({ from, to, channel } = {}) {
  const zero = () => ({ total: 0, agent: 0, assisted: 0, human: 0 });
  const all = zero(); const byDirection = { in: zero(), out: zero() }; const ch = {}; const side = { ackCount: 0, pendingCount: 0 };
  for (const r of db.all(WORKLOAD_SQL, from || null, to || null, channel || null)) {
    const c = (ch[r.channel] ??= { ...zero(), ackCount: 0, pendingCount: 0 });
    if (SIDE[r.bucket]) { side[SIDE[r.bucket]] += r.n; c[SIDE[r.bucket]] += r.n; continue; }
    for (const o of [all, (byDirection[r.dir] ??= zero()), c]) { o[r.bucket] += r.n; o.total += r.n; }
  }
  return {
    from: from || null, to: to || null, channel: channel || null, ...withRates(all), ...side, byDirection,
    byChannel: Object.entries(ch).map(([c, o]) => ({ channel: c, ...withRates(o) })),
  };
}

/**
 * 매뉴얼 보강 목록: 답장 Agent가 지식베이스에 없다고 남긴 질문(판정 기록 respond 출력의 knowledgeGaps). 최신순, 질문은 저장 때 이미 가렸다.
 * byNearest = 가장 가까웠던 절별 건수 — 어느 절을 보강하면 되는지 본다(가까운 절이 없으면 '(없음)').
 */
function knowledgeGaps({ channel, limit = 50 } = {}) {
  const items = [];
  for (const r of db.all(`SELECT d.output, d.created_at, c.channel, d.case_id FROM decisions d JOIN cases c ON c.id = d.case_id
    WHERE d.step = 'respond' AND d.output LIKE '%"knowledgeGaps"%' AND (? IS NULL OR c.channel = ?) ORDER BY d.created_at DESC, d.rowid DESC`, channel || null, channel || null)) {
    for (const g of JSON.parse(r.output).knowledgeGaps || []) items.push({ channel: r.channel, caseRef: r.case_id.slice(0, 8), at: r.created_at, question: g.question, nearestKeys: g.nearestKeys || [] });
  }
  const byNearest = {};
  for (const it of items) for (const k of it.nearestKeys.length ? it.nearestKeys : ['(없음)']) byNearest[k] = (byNearest[k] || 0) + 1;
  return { total: items.length, byNearest, items: items.slice(0, Math.min(Math.max(1, Number(limit) || 50), 200)) };
}

module.exports = { budget, llmUsage, promotionByIntent, promotionCsv, unratedShadow, workload, knowledgeGaps, WORKLOAD_SQL };
