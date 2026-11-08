'use strict';
// 저장소 계약 — 환경 변수 문서, 시연 스크립트, 문서·대시보드 문구와 코드의 일치, 배포 이미지, 프로토타입 빌드.
process.env.MAIL_MOCK_LOG = '0';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mock = require('../server/llm/mock');
const kbLoader = require('../server/kb');
const { spawn, execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('.env.example와 deployment.md 표가 코드가 읽는 환경 변수를 전부 담는다', () => {
  const names = new Set();
  // 추적 파일 + 무시 목록 밖 새 파일 — 로컬에만 있는 무시 파일까지 보면 체크아웃마다 결과가 달라진다.
  // env.X는 preflight(env)처럼 매개변수로 읽는 변수까지 잡는다(process.env.X도 여기에 걸린다).
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', 'server', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f.endsWith('.js'));
  for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]*)|\be\.(SMTP_[A-Z0-9_]+)/g)) names.add(m[1] || m[2]);
  assert.ok(names.size > 20);
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const deploy = fs.readFileSync(path.join(ROOT, 'docs/deployment.md'), 'utf8');
  for (const k of names) {
    assert.match(example, new RegExp(`^${k}=`, 'm'), `.env.example에 ${k}`);
    assert.match(deploy, new RegExp(`\`${k}\``), `deployment.md에 ${k}`);
  }
  assert.doesNotMatch(example, /어댑터 추가 필요/);
});

test('smoke:llm — npm 스크립트가 있고, ANTHROPIC_API_KEY 없으면 실행 방법을 알리고 거부한다', async () => {
  assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['smoke:llm'], /demo\.js --provider=anthropic --record/);
  const env = { PATH: process.env.PATH };
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server/mock/demo.js'), '--provider=anthropic', '--record'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 2, r.out); assert.match(r.out, /ANTHROPIC_API_KEY=.*npm run smoke:llm/);
});

test('문의 유형·넘김 사유는 사람 말로 — 정책 팩의 intent 전부에 한국어 이름(서버·대시보드), 브리핑 요약에 코드 없음', () => {
  const labels = require('../server/labels');
  const web = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  const webIntent = web.match(/\n {2}intent: \{([\s\S]*?)\n {2}\},/)[1];
  for (const ch of ['support', 'onboarding', 'sales']) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, `policy/${ch}.json`), 'utf8'));
    for (const k of Object.keys(pack.intents)) {
      assert.ok(labels.INTENT[k], `server/labels.js intent ${k}`);
      assert.match(webIntent, new RegExp(`\\b${k}: '`), `web/app.js intent ${k}`);
    }
    for (const k of pack.handoffReasons) assert.ok(labels.REASON[k], `server/labels.js reason ${k}`);
  }
  const fb = require('../server/agents/briefer').fallback({ reason: 'refund_request', message: { body_clean: '환불' } });
  assert.match(fb.summary, /넘김\(환불 요청\)/);
  const { summary } = mock.brief({ pack: { label: '고객문의' }, triage: { intent: 'refund' }, reason: 'refund_request', message: { body_clean: '환불해 주세요' }, kb: kbLoader.load('support', 'ko') });
  assert.match(summary, /분류 「환불」으로 넘김\(환불 요청\)/); assert.doesNotMatch(summary, /refund/);
});

test('프로토타입 빌드는 셸에 남은 판단 설정(발신자 인증 요구·폼 도메인·예산·보존·smtp)과 무관하게 같은 결과로 대조를 통과한다', () => {
  const env = { ...process.env, REQUIRE_SENDER_AUTH: '1', FORM_SENDER_DOMAINS: 'example.com', LLM_DAILY_TOKEN_BUDGET: '1', RETENTION_DAYS: '1', MAIL_PROVIDER: 'smtp', AUTO_CLOSE_DAYS: '1' };
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'build-prototype.js')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.match(r.stdout, /심 대조: .*일치/);
});

test('이미지에 운영 스크립트가 있다 — 배포 문서의 docker run 예시가 부르는 scripts/*.js를 Dockerfile이 복사한다', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'deployment.md'), 'utf8');
  const used = [...new Set(doc.split('\n').filter((l) => l.includes('docker run')).flatMap((l) => l.match(/scripts\/[\w-]+\.js/g) || []))];
  assert.ok(used.includes('scripts/subject-request.js'), used.join(','));
  for (const f of used) assert.match(docker, new RegExp(`^COPY .*${f.replace('.', '\\.')}`, 'm'), f);
});
