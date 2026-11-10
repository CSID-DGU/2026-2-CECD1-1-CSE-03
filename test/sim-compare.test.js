'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compare } = require('../scripts/sim/compare');

function run(dir, meta, summary) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
  return dir;
}

test('실행 비교: 방향에 맞춰 나음·나쁨을 표시하고 다른 조건을 적는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-compare-'));
  const base = { set: { sha256: 'a' }, split: 'test', subset: 'smoke', provider: 'anthropic', models: { agent: 'm' }, sim: { files: {} }, versions: {}, autoSend: true };
  const a = run(path.join(root, 'a'), { ...base, runId: 'A' }, { pass1: 0.5, critical: { count: 1 }, latency: { p50: 100 } });
  const b = run(path.join(root, 'b'), { ...base, runId: 'B', responderMode: 'react', models: { agent: 'n' } }, { pass1: 0.6, critical: { count: 2 }, latency: { p50: 100 } });
  const out = compare([a, b]);
  assert.match(out, /A<br>anthropic · single · m/, '칸이 없던 실행은 single');
  assert.match(out, /B<br>anthropic · react · n/);
  assert.match(out, /\| 통과율 pass\^1 \| 0\.500 \| 0\.600 ▲ \|/, '높을수록 좋은 지표');
  assert.match(out, /\| 치명 건수 \| 1 \| 2 ▼ \|/, '낮을수록 좋은 지표');
  assert.match(out, /\| 턴 지연 p50\(ms\) \| 100 \| 100 \|/, '같으면 표시 없음');
  assert.match(out, /B: 기준과 다른 조건 — 에이전트 모델, 고객·채점 모델/);
  fs.rmSync(root, { recursive: true, force: true });
});
