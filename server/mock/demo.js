'use strict';
// npm run demo — 합성 문의 전부를 인메모리 DB에 주입해 루프를 돌리고, 기대 행동과 맞는지 표로 보여 준다. 불일치 있으면 exit 1.
// npm run smoke:llm — 같은 20건을 실제 Claude(--provider=anthropic)로 돌리고 실행 기록(--record)을 docs/runs/<날짜>-anthropic.json에 남긴다.
//   기록: 케이스별 기대·실제 행동, 지연, 토큰 사용량(응답 usage), 이번 실행이 쓴 프롬프트·KB·정책 버전 해시(원문은 GET /api/versions/<hash>).
//   본문·키·URL은 넣지 않는다. 메일은 항상 mock(발송 없음).
process.env.MAIL_MOCK_LOG = process.env.MAIL_MOCK_LOG || '0';
const fs = require('node:fs');
const path = require('node:path');

const arg = (k) => { const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); return a === undefined ? undefined : (a.split('=')[1] ?? true); };
const PROVIDER = arg('provider') || 'mock';
const RECORD = arg('record');

if (PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error([
    '거부: ANTHROPIC_API_KEY가 없다. 실제 Claude API를 부르는 실행이라 키가 필요하다(호출 20건 × 3~4회, 비용 발생).',
    '  ANTHROPIC_API_KEY=sk-ant-... npm run smoke:llm',
    '  모델 바꾸기: ANTHROPIC_MODEL=<모델 id> (기본 claude-sonnet-5-5) · 기록 위치: --record=<경로>',
  ].join('\n'));
  process.exit(2);
}
if (!['mock', 'anthropic'].includes(PROVIDER)) { console.error(`알 수 없는 --provider=${PROVIDER} (mock | anthropic)`); process.exit(2); }
process.env.MAIL_PROVIDER = 'mock'; // 데모·스모크는 절대 실발송하지 않는다
delete process.env.CS_ABLATE; // 비교 실험 스위치가 셸에 남아 있어도 데모는 장치를 다 켠 채 돈다

const db = require('../db');
const llm = require('../llm');
const anthropic = require('../llm/anthropic');
const cases = require('../cases');
const loop = require('../loop');
const INQUIRIES = require('./inquiries');

// 터미널 칸 너비 — 한글·전각은 두 칸.
const width = (s) => [...String(s ?? '')].reduce((n, c) => n + (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => { const t = String(s ?? ''); return t + ' '.repeat(Math.max(0, n - width(t))); };
const usageDiff = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]));
// 기대와 다를 때 어느 쪽으로 틀렸나 — 사람 쪽(보수적)은 비용, 에이전트 쪽은 위험.
const verdict = (expect, action, ok) => {
  if (ok) return '일치';
  if (action === expect.action) return '사유·분류만 다름';
  if (action === 'HANDOFF') return '더 보수적(사람에게)';
  if (expect.action === 'HANDOFF') return '위험(사람 몫을 에이전트가)';
  if (expect.action === 'IGNORE') return '불필요한 응대';
  if (action === 'IGNORE') return '놓침(응대 안 함)';
  return '다름';
};

async function main() {
  db.init(':memory:');
  llm.use(PROVIDER);
  const rows = []; const runs = [];
  let okAll = true;
  const startedAt = new Date().toISOString();
  for (const q of INQUIRIES) {
    const u0 = { ...anthropic.usage }; const t0 = Date.now();
    const r = cases.addInbound({ ...q, threadId: `demo-${q.id}`, providerMessageId: `demo-${q.id}` });
    await loop.runCycle(r.caseId, r.messageId);
    const latencyMs = Date.now() - t0;
    const ex = db.get("SELECT action, reason FROM decisions WHERE case_id=? AND step='execute' ORDER BY created_at DESC, rowid DESC LIMIT 1", r.caseId) || {};
    const tri = db.get("SELECT output FROM decisions WHERE case_id=? AND step='triage' ORDER BY created_at DESC LIMIT 1", r.caseId);
    const t = tri ? JSON.parse(tri.output) : null;
    const reasons = q.expect.reasons == null ? null : [].concat(q.expect.reasons);
    const ok = ex.action === q.expect.action
      && (!q.expect.intent || t?.intent === q.expect.intent)
      && (!reasons || reasons.includes(ex.reason))
      && (!q.expect.language || t?.language === q.expect.language);
    okAll = okAll && ok;
    const v = verdict(q.expect, ex.action, ok);
    rows.push([q.id, q.channel, q.subject, `${q.expect.action}${reasons ? '/' + reasons.join('|') : ''}`,
      `${t?.intent ?? '(사전 거름)'} → ${ex.action}${ex.reason ? '/' + ex.reason : ''}`, `${ok ? '✓' : '✗'} ${v}`]);
    runs.push({
      id: q.id, channel: q.channel, subject: q.subject, expected: q.expect, ok, verdict: v, latencyMs,
      actual: { action: ex.action ?? null, reason: ex.reason ?? null, intent: t?.intent ?? null, language: t?.language ?? null, confidence: t?.confidence ?? null, kbHit: t?.kbHit ?? null },
      ...(PROVIDER === 'anthropic' ? { usage: usageDiff(u0, anthropic.usage) } : {}),
    });
  }
  const head = ['#', '채널', '문의', '기대', '결과(분류 → 행동/사유)', '판정'];
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (r) => r.map((c, i) => pad(c, widths[i])).join(' | ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  rows.forEach((r) => console.log(line(r)));
  const s = cases.stats();
  const matched = runs.filter((x) => x.ok).length;
  console.log(`\n케이스 ${s.total} · 승인 대기 ${s.awaitingApproval} · 넘김 ${s.handedOff} · 초안 ${s.agentDrafts} · ${okAll ? '전부 일치' : `불일치 있음(${matched}/${runs.length})`}`);
  const byVerdict = runs.reduce((m, x) => ({ ...m, [x.verdict]: (m[x.verdict] || 0) + 1 }), {});
  console.log(`판정: ${Object.entries(byVerdict).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  if (RECORD) {
    const file = path.resolve(typeof RECORD === 'string' ? RECORD : path.join(__dirname, '..', '..', 'docs', 'runs', `${startedAt.slice(0, 10)}-${PROVIDER}.json`));
    const out = fs.existsSync(file) ? file.replace(/\.json$/, `-${Date.now()}.json`) : file; // 같은 날 두 번 돌려도 앞 기록을 덮지 않는다
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({
      provider: PROVIDER, model: PROVIDER === 'anthropic' ? anthropic.model() : 'mock', startedAt, finishedAt: new Date().toISOString(),
      matched, total: runs.length, ...(PROVIDER === 'anthropic' ? { usage: { ...anthropic.usage } } : {}),
      versions: db.all('SELECT kind, hash FROM versions ORDER BY kind'), cases: runs,
    }, null, 2)}\n`);
    console.log(`기록: ${path.relative(process.cwd(), out)}`);
  }
  process.exit(okAll ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
