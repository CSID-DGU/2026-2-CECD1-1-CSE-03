'use strict';
// 가상 고객 평가 실행끼리 지표를 나란히 놓는다(읽기 전용, 집계만 읽는다).
//   node scripts/sim/compare.js <실행 폴더> <실행 폴더> [...]
// 실행 폴더 = eval-out/sim/<runId>(meta.json·summary.json이 있는 곳). 첫 폴더가 기준이다.
const fs = require('node:fs');
const path = require('node:path');

const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const sum = (u) => (u ? u.input + u.output : null);

// [이름, 좋은 방향(+1 높을수록, -1 낮을수록), 값 꺼내기]
const ROWS = [
  ['통과율 pass^1', 1, (s) => s.pass1],
  ['치명 건수', -1, (s) => s.critical?.count],
  ['첫 턴 정확도', 1, (s) => s.accuracy?.firstTurn],
  ['전 턴 정확도', 1, (s) => s.accuracy?.allTurns],
  ['의도 정확도(첫 턴)', 1, (s) => s.intentAccuracy],
  ['기대 툴 사용률', 1, (s) => s.toolUse],
  ['목표 달성률', 1, (s) => s.goalRate],
  ['평균 턴 수', -1, (s) => s.avgTurns],
  ['턴 지연 p50(ms)', -1, (s) => s.latency?.p50],
  ['턴 지연 p95(ms)', -1, (s) => s.latency?.p95],
  ['근거(grounded, 0~2)', 1, (s) => s.quality?.items?.grounded],
  ['약속 없음(noPromise, 0~2)', 1, (s) => s.quality?.items?.noPromise],
  ['답함(answered, 0~2)', 1, (s) => s.quality?.items?.answered],
  ['어조(tone, 0~2)', 1, (s) => s.quality?.items?.tone],
  ['자동 처리 비율', 1, (s) => s.workload?.agentRate],
  ['에이전트 토큰', -1, (s) => sum(s.usage?.agent)],
  ['전체 토큰', -1, (s) => s.tokens?.total],
  ['비용(USD)', -1, (s) => s.cost?.total ?? null],
];

function fmt(v) {
  if (v === null || v === undefined) return '-';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

function compare(dirs) {
  const runs = dirs.map((d) => ({ meta: read(d, 'meta.json'), s: read(d, 'summary.json') }));
  const head = runs.map(({ meta }) => `${meta.runId}<br>${meta.provider} · ${meta.responderMode ?? 'single'} · ${meta.models?.agent ?? '-'}`);
  const lines = [`| 지표 | ${head.join(' | ')} |`, `| --- | ${runs.map(() => '---').join(' | ')} |`];
  for (const [name, dir, get] of ROWS) {
    const vals = runs.map(({ s }) => get(s));
    const base = vals[0];
    const cells = vals.map((v, i) => {
      if (i === 0 || typeof v !== 'number' || typeof base !== 'number' || v === base) return fmt(v);
      return `${fmt(v)} ${(v - base) * dir > 0 ? '▲' : '▼'}`; // ▲ 기준보다 나음, ▼ 나쁨
    });
    lines.push(`| ${name} | ${cells.join(' | ')} |`);
  }
  // 같은 조건에서 돌았는지: 다르면 수치 차이가 방식 때문이라고 말하기 어렵다
  const notes = [];
  const b = runs[0].meta;
  for (const { meta } of runs.slice(1)) {
    const diff = [];
    if (meta.set?.sha256 !== b.set?.sha256) diff.push('시나리오 세트');
    if (meta.split !== b.split || meta.subset !== b.subset) diff.push('분할·부분집합');
    if (meta.provider !== b.provider) diff.push('공급자');
    if (meta.models?.agent !== b.models?.agent) diff.push('에이전트 모델');
    if (JSON.stringify(meta.models) !== JSON.stringify(b.models)) diff.push('고객·채점 모델');
    if (JSON.stringify(meta.sim?.files) !== JSON.stringify(b.sim?.files)) diff.push('시뮬레이터 파일');
    if (JSON.stringify(meta.versions?.kb) !== JSON.stringify(b.versions?.kb)) diff.push('지식베이스');
    if (JSON.stringify(meta.versions?.policy) !== JSON.stringify(b.versions?.policy)) diff.push('정책');
    if (meta.autoSend !== b.autoSend) diff.push('자동 발송 설정');
    if (meta.businessDataSha256 !== b.businessDataSha256) diff.push('업무 데이터');
    if (JSON.stringify(meta.tools) !== JSON.stringify(b.tools)) diff.push('툴 목록');
    notes.push(`- ${meta.runId}: 기준과 다른 조건 — ${diff.length ? diff.join(', ') : '없음(프롬프트·답장 방식만 다를 수 있음)'}`);
  }
  return `${lines.join('\n')}\n\n▲ 기준(첫 열)보다 나음 · ▼ 나쁨\n\n${notes.join('\n')}\n`;
}

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (dirs.length < 2) { console.error('쓰는 법: node scripts/sim/compare.js <기준 실행 폴더> <비교 실행 폴더> [...]'); process.exit(2); }
  process.stdout.write(compare(dirs.map((d) => path.resolve(d))));
}

module.exports = { compare, ROWS };
