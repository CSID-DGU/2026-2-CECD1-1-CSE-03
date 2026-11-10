'use strict';
// 시나리오 세트 도구 — 검증, 중복 제거, 동결(sha256 MANIFEST), 로드 시 해시 대조.
//   node --no-warnings=ExperimentalWarning scripts/sim/scenarios.js check --version=v1
//   node --no-warnings=ExperimentalWarning scripts/sim/scenarios.js validate <후보.jsonl>
//   node --no-warnings=ExperimentalWarning scripts/sim/scenarios.js freeze <후보.jsonl> --version=v1 [--out=eval]
// 오류 코드(종료 2): 설정·거부. 검사 실패(종료 1): 스키마·해시 불일치.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 금지 목록 시작 (기존 화면 코드 금지 테스트의 정규식 두 개와 같다. 이 구간만 금지 단어 원문을 둔다)
const BANNED = [
  /선점|claim|재확인|recheck|멱등|idempoten|SENDING|seen_?out|already_?answered|answered_?since|last_?out_?rowid|needs_?send_?check|sending_?draft|resolve[-_]?sending|send_?unconfirmed|send[-_]?check|발송 중/i,
  /salesforce|hubspot|zendesk|freshdesk|intercom|세일즈포스|허브스팟/i,
];
// 금지 목록 끝

// 라이선스 → 허용 use
const LICENSES = {
  own: ['seed', 'handwritten'],
  MIT: ['text-adapted', 'pattern-only', 'taxonomy-only'],
  'CC-BY-4.0': ['text-adapted', 'taxonomy-only'],
  'CC-BY-3.0': ['text-adapted', 'taxonomy-only'],
  'CDLA-Sharing-1.0': ['taxonomy-only'],
  'US-gov-public': ['taxonomy-only'],
  'data.go.kr-unrestricted': ['taxonomy-only'],
};
const TAGS = ['multi_turn', 'injection', 'legal_threat', 'refund_dispute', 'repeat', 'auto_reply', 'ack', 'hard_negative', 'english', 'goal_chain', 'smoke', 'registered'];

const CHANNELS = ['support', 'onboarding', 'sales'];
const ABBR = { support: 'sup', onboarding: 'onb', sales: 'sal' };
const OUTCOMES = ['auto', 'approve', 'handoff', 'ignore'];
// expect.tools에 쓸 수 있는 이름(server/agents/tools/의 툴). 툴을 더하면 여기도 더한다 — test/sim-scenarios.test.js가 맞춰 본다
const TOOL_NAMES = ['search_knowledge_base', 'read_knowledge_base', 'report_knowledge_gap', 'search_past_cases', 'get_customer_record', 'lookup_order',
  'lookup_billing', 'lookup_account', 'find_meeting_slots', 'read_official_page', 'check_draft', 'submit_draft', 'request_handoff'];
const ORIGINS = ['seed', 'adapted', 'handwritten'];
const ID_RE = /^(sup|onb|sal)-[a-z0-9_]+-[a-z]-\d{2}$/;
const FAMILY_RE = /^(sup|onb|sal)-[a-z0-9_]+-[a-z]$/;
// 스키마 칸 순서(동결본이 이 순서로 쓰인다)
const KEYS = ['id', 'family', 'bundle', 'split', 'channel', 'difficulty', 'tags', 'persona', 'customer', 'opening', 'formFacts', 'hiddenGoal',
  'facts', 'unknown', 'steps', 'end', 'grade', 'maxTurns', 'mock', 'adversarial', 'source'];

// 경로 검사. 저장소 옆 실고객 데이터·참고 자료·특허·평가 출력 폴더는 막는다(평가 출력 중 sim만 허용).
// 실데이터 폴더 이름은 리터럴을 피하려고 조립한다.
const ROOT = path.resolve(__dirname, '..', '..');
const SIM_OUT = path.join(ROOT, '..', 'eval-out', 'sim');
const BLOCKED = ['da' + 'ta', 'reference', 'patent', 'eval-out'].map((d) => path.join(ROOT, '..', d));
const refused = () => Object.assign(new Error('path_refused'), { code: 'path_refused' });

// 있는 앞부분까지 실경로로 풀고(링크·/tmp 별칭) 없는 뒷부분을 다시 붙인다
function real(p) {
  let head = path.resolve(p); const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail); } catch (e) {
      // 끊긴 링크·순환 링크처럼 있는데 못 푸는 경로는 거부한다
      if (e.code !== 'ENOENT' || fs.lstatSync(head, { throwIfNoEntry: false })) throw refused();
      tail.unshift(path.basename(head)); head = path.dirname(head);
    }
  }
}
// 대소문자를 구분하지 않는 파일 시스템(macOS·Windows)만 소문자로 맞춘다. 그 밖은 글자 그대로 비교한다
const FOLD = ['darwin', 'win32'].includes(process.platform);
const realKey = (p) => (FOLD ? real(p).toLowerCase() : real(p));
function isUnder(p, dir) {
  const rel = path.relative(realKey(dir), realKey(p));
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}
const blocked = (r) => BLOCKED.some((d) => isUnder(r, d)) && !isUnder(r, SIM_OUT);
// 임시 폴더는 모듈을 읽을 때 한 번 실경로로 푼다. 홈이나 저장소 상위 폴더를 품으면(같거나 루트여도) 임시 폴더 허용을 끈다
const TMP = (() => {
  try {
    const t = real(os.tmpdir());
    return [os.homedir(), path.join(ROOT, '..')].some((d) => isUnder(d, t)) ? null : t;
  } catch { return null; }
})();
// 허용 뿌리(eval·eval-out·eval-out/sim)가 링크면 허용 범위를 다른 곳에 걸 수 있다 — 그때는 모든 경로를 거부한다
const linkedRoot = () => [path.join(ROOT, 'eval'), path.join(ROOT, '..', 'eval-out'), SIM_OUT]
  .some((d) => fs.lstatSync(d, { throwIfNoEntry: false })?.isSymbolicLink());

/** 입력 경로: eval·eval-out/sim·임시 폴더 아래만, 막힌 형제 폴더는 거부. 실경로를 돌려준다.
 *  둘째 인자({out})는 받기만 한다 — 출력 폴더가 허용 폴더를 넓히지 않는다(출력 폴더도 checkOut으로 같은 곳만 된다). */
function checkInput(p) {
  const r = real(p);
  if (linkedRoot() || blocked(r) || ![path.join(ROOT, 'eval'), SIM_OUT, TMP].some((d) => d && isUnder(r, d))) throw refused();
  return r;
}
/** 출력 경로: eval-out/sim·임시 폴더 아래만, 저장소 안과 막힌 형제 폴더는 거부. 실경로를 돌려준다. */
function checkOut(p) {
  const r = real(p);
  if (linkedRoot() || isUnder(r, ROOT) || blocked(r) || ![SIM_OUT, TMP].some((d) => d && isUnder(r, d))) throw refused();
  return r;
}
/** 입력 파일 읽기: checkInput 뒤 마지막 고리가 링크면 열지 않고(O_NOFOLLOW), 연 fd가 일반 파일이고 하드 링크가 하나일 때만 그 fd로 읽는다.
 *  검사와 열기 사이에 파일을 링크로 바꿔치기해도 검사한 파일만 읽는다. FIFO도 열 때 멈추지 않게(O_NONBLOCK) 열고 아래 검사로 거부한다. Buffer를 돌려준다. */
function readChecked(p) {
  const r = checkInput(p);
  let fd;
  try { fd = fs.openSync(r, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) { throw e.code === 'ELOOP' ? refused() : e; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw refused();
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
const refuseData = (p, opt) => checkInput(p, opt);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// 모든 문자열 값, 숫자(문자열로), 모든 깊이의 객체 칸 이름을 낸다
function* strings(v) {
  if (typeof v === 'string') yield v;
  else if (typeof v === 'number') yield String(v);
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { yield k; yield* strings(x); }
}

const canaryOf = (id) => 'K' + sha256(id).slice(0, 6).toUpperCase();

function personaIds(personas) {
  const list = Array.isArray(personas) ? personas : Object.values(personas || {});
  return new Set(list.map((p) => p.id));
}

// 오류 문자열 배열을 돌려준다. 정상은 []. 각 문자열은 '코드' 또는 '코드: 값'이고 코드에는 레코드 값이 없다.
function validate(rec, { packs = {}, personas = [] } = {}) {
  const errs = [];
  const bad = (m) => errs.push(m);
  if (!isObj(rec)) return ['레코드가 객체가 아니다'];
  for (const k of ['id', 'family', 'bundle', 'split', 'channel', 'difficulty', 'tags', 'persona', 'customer', 'opening', 'hiddenGoal',
    'facts', 'unknown', 'steps', 'end', 'maxTurns', 'mock', 'source']) if (rec[k] === undefined || rec[k] === null) bad(`필수 칸 없음(${k})`);
  if ('inspiration' in rec) bad('inspiration 칸은 동결본에 둘 수 없다');
  if (errs.length) return errs;

  if (!ID_RE.test(rec.id)) bad(`id 형식 위반: ${rec.id}`);
  if (!FAMILY_RE.test(rec.family)) bad(`family 형식 위반: ${rec.family}`);
  if (ID_RE.test(rec.id) && FAMILY_RE.test(rec.family) && !new RegExp(`^${rec.family}-\\d{2}$`).test(rec.id)) bad('id가 family로 시작하지 않는다');
  if (!CHANNELS.includes(rec.channel)) bad(`channel 값 오류: ${rec.channel}`);
  else if (FAMILY_RE.test(rec.family) && !rec.family.startsWith(ABBR[rec.channel] + '-')) bad('family 약자와 channel이 다르다');
  if (!/^[A-J]$/.test(rec.bundle)) bad('bundle은 A~J');
  if (!['dev', 'test'].includes(rec.split)) bad('split은 dev 또는 test');
  if (![1, 2, 3].includes(rec.difficulty)) bad('difficulty는 1~3');
  if (!Array.isArray(rec.tags) || rec.tags.some((t) => !TAGS.includes(t))) bad('허용 목록 밖 태그');
  if (!personaIds(personas).has(rec.persona)) bad(`없는 페르소나: ${rec.persona}`);
  if (!isObj(rec.customer) || !isStr(rec.customer.name)) bad('customer.name 없음');
  // 등록 고객: 가상 업무 데이터(server/mock/business-data.json)에 있는 주소. 가상 도메인만 허용하고 registered 태그와 짝을 맞춘다
  else if (rec.customer.email !== undefined && !(isStr(rec.customer.email) && /^[a-z0-9.+-]+@example\.com$/.test(rec.customer.email))) bad('customer.email은 @example.com 주소');
  else if (Array.isArray(rec.tags) && rec.tags.includes('registered') !== (rec.customer.email !== undefined)) bad('registered 태그와 customer.email은 함께 둔다');
  const op = rec.opening;
  if (!isObj(op) || !isStr(op.subject) || !isStr(op.body) || !Array.isArray(op.stepIds) || !op.stepIds.length) bad('opening은 {subject, body, stepIds}');
  // english 태그가 없으면 첫 메일 본문에 한글이 있어야 한다
  else if (Array.isArray(rec.tags) && !rec.tags.includes('english') && !/[가-힣]/.test(op.body)) bad('no_hangul');
  if (rec.formFacts != null && (!isObj(rec.formFacts) || Object.values(rec.formFacts).some((v) => typeof v !== 'string'))) bad('formFacts는 문자열 쌍 또는 null');
  if (!isStr(rec.hiddenGoal)) bad('hiddenGoal 없음');
  if (!Array.isArray(rec.facts) || rec.facts.some((f) => !isObj(f) || !isStr(f.key) || typeof f.value !== 'string')) bad('facts는 {key, value} 배열');
  if (!Array.isArray(rec.unknown) || rec.unknown.some((u) => typeof u !== 'string')) bad('unknown은 문자열 배열');
  if (!Number.isInteger(rec.maxTurns) || rec.maxTurns < 2 || rec.maxTurns > 6) bad('maxTurns는 2~6');
  else if (rec.bundle === 'E' && rec.maxTurns < 3) bad('E 묶음 maxTurns는 3 이상');
  if (rec.grade != null && !['turns', 'end'].includes(rec.grade)) bad('grade는 turns 또는 end');
  if (!isObj(rec.mock)) bad('mock은 객체');

  const pack = packs[rec.channel];
  const intents = pack ? Object.keys(pack.intents) : null;
  const reasons = pack ? pack.handoffReasons : null;
  const checkReasons = (rs, where) => {
    if (!Array.isArray(rs) || !rs.length) return bad(`reasons 배열 필요: ${where}`);
    if (reasons) for (const r of rs) if (!reasons.includes(r)) bad(`팩에 없는 사유: ${where} ${r}`);
  };
  const stepIds = new Set();
  if (!Array.isArray(rec.steps) || !rec.steps.length) bad('steps 없음');
  else {
    for (const s of rec.steps) {
      if (!isObj(s) || !isStr(s.id)) { bad('step id 없음'); continue; }
      if (stepIds.has(s.id)) bad(`step id 중복: ${s.id}`);
      stepIds.add(s.id);
      if (!isStr(s.ask)) bad(`ask 없음: ${s.id}`);
      const ex = s.expect;
      if (!isObj(ex)) { bad(`expect 없음: ${s.id}`); continue; }
      if (!OUTCOMES.includes(ex.outcome)) bad(`outcome 값 오류: ${s.id}`);
      const list = ex.intent == null ? [] : [].concat(ex.intent);
      for (const i of list) if (typeof i !== 'string' || (intents && !intents.includes(i))) bad(`팩에 없는 intent: ${s.id} ${i}`);
      if (ex.outcome === 'handoff') checkReasons(ex.reasons, `${s.id}`);
      else if (ex.reasons != null) checkReasons(ex.reasons, `${s.id}`);
      if (ex.tools != null && (!Array.isArray(ex.tools) || !ex.tools.length || ex.tools.some((t) => !TOOL_NAMES.includes(t)))) bad(`expect.tools는 답장 Agent 툴 이름 배열: ${s.id}`);
      const d = s.doneWhen;
      if (!isObj(d) || [d.mentions != null, d.handoff === true, d.ignore === true].filter(Boolean).length !== 1) bad(`doneWhen은 mentions·handoff·ignore 중 하나: ${s.id}`);
      else if (d.mentions != null && (!Array.isArray(d.mentions) || !d.mentions.length)) bad(`mentions는 비지 않은 배열: ${s.id}`);
    }
    if (isObj(op) && Array.isArray(op.stepIds)) for (const id of op.stepIds) if (!stepIds.has(id)) bad(`opening.stepIds에 없는 단계: ${id}`);
    if (Number.isInteger(rec.maxTurns) && rec.steps.length > rec.maxTurns) bad('maxTurns가 단계 수보다 작다');
  }
  if (isObj(rec.mock)) for (const id of Object.keys(rec.mock)) if (!stepIds.has(id)) bad(`mock에 없는 단계: ${id}`);

  const end = rec.end;
  if (!isObj(end) || !['resolved', 'handoff', 'ignored'].includes(end.kind)) bad('end.kind 오류');
  else if (end.kind === 'handoff') checkReasons(end.reasons, 'end');

  const adv = rec.adversarial;
  if (adv != null) {
    if (!isObj(adv) || !['injection', 'auto_reply'].includes(adv.kind)) bad('adversarial.kind 오류');
    else if (adv.kind === 'injection' && adv.canary !== canaryOf(rec.id)) bad('canary가 id에서 만든 값과 다르다');
    else if (adv.kind === 'auto_reply' && typeof adv.flagged !== 'boolean') bad('adversarial.flagged는 boolean');
  }

  const src = rec.source;
  if (!isObj(src)) bad('source 오류');
  else {
    if (!ORIGINS.includes(src.origin)) bad('source.origin 오류');
    if (!isStr(src.dataset) || !isStr(src.ref)) bad('source.dataset·ref 없음');
    else if (/ai[\s_-]?hub|aihub/i.test(src.dataset)) bad('사용할 수 없는 데이터셋');
    if (typeof src.license !== 'string' || /NC/i.test(src.license) || !Object.hasOwn(LICENSES, src.license)) bad(`허용되지 않는 라이선스: ${src.license}`);
    else if (!LICENSES[src.license].includes(src.use)) bad(`허용되지 않는 use: ${src.license} ${src.use}`);
  }

  // 금지 목록(모든 문자열·숫자 값과 칸 이름)
  const all = [...strings(rec)];
  for (const re of BANNED) if (all.some((s) => re.test(s))) bad('금지 목록에 걸리는 문자열');
  // 개인정보: 모든 문자열·숫자 값과 칸 이름에서 example.com 주소를 지운 뒤 마스킹이 글을 바꾸면 거부
  const guard = require('../../server/guard');
  for (const t of all) {
    const s = t.replace(/[\w.+-]+@example\.com/gi, '');
    if (guard.maskPii(s) !== s) { bad('개인정보로 보이는 문자열'); break; }
  }
  return errs;
}

// 출력용: 오류 문자열에서 값을 떼고 코드만 남긴다
const errorCode = (msg) => String(msg).split(': ')[0];
// 출력용 오류 줄: 형식에 맞는 id(아니면 순번) + 코드. 레코드 값은 싣지 않는다
const errorLines = (recs, check) => recs.flatMap((r, i) => [...new Set(check(r).map(errorCode))]
  .map((c) => `${isObj(r) && ID_RE.test(r.id) ? r.id : `#${i + 1}`}: ${c}`));

// 3-gram Jaccard(공백·구두점 뺀 소문자 글자 기준)
function grams(t) {
  const s = String(t).toLowerCase().replace(/[\s\p{P}]+/gu, '');
  const out = new Set();
  if (s.length < 3) { if (s) out.add(s); return out; }
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}
function similar(a, b) {
  const x = grams(a); const y = grams(b);
  if (!x.size && !y.size) return 1;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return n / (x.size + y.size - n);
}

const textOf = (r) => `${r.opening.subject} ${r.opening.body}`;
const groupKey = (r) => `${r.channel}\u0000${JSON.stringify(r.steps[0].expect.intent)}`;

// 같은 (채널, 첫 단계 intent) 안에서 비교한다. 시드와 겹치는 test는 뺀다.
// 한계: 그룹 안 O(n²). 수백 건까지는 충분하고, 늘면 3-gram 색인으로 바꾼다.
function dedup(records, { threshold = 0.8, reviewFrom = 0.5, seeds = [] } = {}) {
  const kept = []; const dropped = []; const review = [];
  const keptBy = new Map();
  const seedBy = new Map();
  for (const s of seeds) { const k = groupKey(s); if (!seedBy.has(k)) seedBy.set(k, []); seedBy.get(k).push(s); }
  for (const r of records) {
    const k = groupKey(r);
    let drop = null;
    for (const s of seedBy.get(k) || []) {
      if (s.id === r.id) continue;
      const score = similar(textOf(r), textOf(s));
      if (score >= threshold && r.split === 'test') { drop = { of: s.id, score }; break; }
      if (score >= reviewFrom && score < threshold) review.push({ a: s.id, b: r.id, score });
    }
    if (!drop) {
      for (const o of keptBy.get(k) || []) {
        const score = similar(textOf(r), textOf(o));
        if (score >= threshold) { drop = { of: o.id, score }; break; }
        if (score >= reviewFrom) review.push({ a: o.id, b: r.id, score });
      }
    }
    if (drop) { dropped.push(r); continue; }
    kept.push(r);
    if (!keptBy.has(k)) keptBy.set(k, []);
    keptBy.get(k).push(r);
  }
  return { kept, dropped, review };
}

function readManifest(manifest, dir, out) {
  if (isObj(manifest)) return manifest;
  const file = refuseData(manifest || path.join(dir, 'MANIFEST.json'), { out });
  return fs.existsSync(file) ? JSON.parse(readChecked(file).toString('utf8')) : { sets: {} };
}
const parseLines = (buf) => buf.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// 파일 해시를 MANIFEST와 맞춰 보고 불일치면 거부한다.
function load(file, { manifest, version, personasFile, out } = {}) {
  const f = refuseData(file, { out });
  const m = readManifest(manifest, path.dirname(f), out);
  const entry = m.sets && m.sets[version];
  if (!entry) throw new Error('version_missing');
  const buf = readChecked(f);
  const hash = sha256(buf);
  if (hash !== entry.sha256) throw new Error('set_hash_mismatch');
  const pf = refuseData(personasFile || path.join(path.dirname(f), path.basename(entry.personasFile)), { out });
  const pbuf = readChecked(pf);
  const personasSha256 = sha256(pbuf);
  if (personasSha256 !== entry.personasSha256) throw new Error('personas_hash_mismatch');
  return { records: parseLines(buf), personas: JSON.parse(pbuf.toString('utf8')), sha256: hash, personasSha256 };
}

const tally = (records, k) => records.reduce((o, r) => { o[r[k]] = (o[r[k]] || 0) + 1; return o; }, {});

// 후보 JSONL을 검사해 id 순으로 쓰고 MANIFEST에 올린다. 같은 버전이 있으면 거부한다.
function freeze(candidatesFile, { version, outDir = 'eval', personasFile } = {}) {
  if (!/^v\d+$/.test(String(version))) throw new Error('version_invalid');
  const src = refuseData(candidatesFile);
  const dir = path.resolve(outDir);
  const manPath = path.join(dir, 'MANIFEST.json');
  const man = readManifest(manPath, dir, dir);
  man.sets = man.sets || {};
  if (man.sets[version]) throw new Error('version_exists');
  const pf = refuseData(personasFile || path.join(dir, `personas.${version}.json`), { out: dir });
  const pbuf = readChecked(pf);
  const personas = JSON.parse(pbuf.toString('utf8'));
  const policy = require('../../server/policy');
  const kb = require('../../server/kb');
  const packs = Object.fromEntries(CHANNELS.map((c) => [c, policy.load(c)]));
  const records = parseLines(readChecked(src));
  const seen = new Set();
  const errs = errorLines(records, (r) => {
    const dup = seen.has(r.id) ? ['id 중복'] : [];
    seen.add(r.id);
    return [...dup, ...validate(r, { packs, personas })];
  });
  if (errs.length) { const e = new Error(`validation_failed\n${errs.join('\n')}`); e.errors = errs; throw e; }
  const lines = records.slice().sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((r) => JSON.stringify(Object.fromEntries(KEYS.filter((k) => k in r).map((k) => [k, r[k]]))));
  const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const name = `scenarios.${version}.jsonl`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf, { flag: 'wx' });
  man.sets[version] = {
    file: `eval/${name}`, sha256: sha256(buf), count: records.length,
    composition: { bundle: tally(records, 'bundle'), split: tally(records, 'split'), channel: tally(records, 'channel') },
    frozenAt: new Date().toISOString(),
    personasFile: `eval/${path.basename(pf)}`, personasSha256: sha256(pbuf),
    policySha256: Object.fromEntries(CHANNELS.map((c) => [c, packs[c].version])),
    kbSha256: Object.fromEntries(CHANNELS.map((c) => [c, kb.load(c).version])),
  };
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');
  return man.sets[version];
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
  const pos = rest.filter((a) => !a.startsWith('--'));
  const usage = '사용법: scenarios.js check --version=v1 | validate <후보.jsonl> | freeze <후보.jsonl> --version=v1 [--out=eval]';
  try {
    const policy = require('../../server/policy');
    const packs = () => Object.fromEntries(CHANNELS.map((c) => [c, policy.load(c)]));
    if (cmd === 'check') {
      const dir = path.resolve(__dirname, '..', '..', 'eval');
      const v = opt.version;
      if (!v || v === true) { console.error(usage); return 2; }
      const m = readManifest(null, dir);
      const { records, personas } = load(path.join(dir, `scenarios.${v}.jsonl`), { manifest: m, version: v });
      const errs = errorLines(records, (r) => validate(r, { packs: packs(), personas }));
      if (records.length !== m.sets[v].count) errs.push(`건수 불일치: ${records.length} / ${m.sets[v].count}`);
      if (errs.length) { console.error(errs.join('\n')); return 1; }
      console.log(`${v}: ${records.length}건, 시나리오·페르소나 sha256 일치`);
      return 0;
    }
    if (cmd === 'validate' && pos[0]) {
      const dir = path.resolve(__dirname, '..', '..', 'eval');
      const personas = JSON.parse(readChecked(path.join(dir, 'personas.v1.json')).toString('utf8'));
      const recs = parseLines(readChecked(pos[0]));
      const errs = errorLines(recs, (r) => validate(r, { packs: packs(), personas }));
      if (errs.length) { console.error(errs.join('\n')); return 1; }
      console.log(`${recs.length}건 통과`);
      return 0;
    }
    if (cmd === 'freeze' && pos[0] && opt.version && opt.version !== true) {
      const entry = freeze(pos[0], { version: opt.version, outDir: opt.out && opt.out !== true ? opt.out : 'eval' });
      console.log(`${opt.version}: ${entry.count}건 동결, sha256 ${entry.sha256}`);
      return 0;
    }
  } catch (e) {
    // 입력 내용이 터미널에 새지 않게 코드만 낸다(JSON 오류 메시지는 파일 앞부분을 싣는다)
    console.error(e instanceof SyntaxError ? 'JSON 형식 오류' : (e.code ?? e.message));
    return /^(set_hash_mismatch|personas_hash_mismatch|validation_failed)/.test(e.message) ? 1 : 2;
  }
  console.error(usage);
  return 2;
}

module.exports = { BANNED, LICENSES, TAGS, TOOL_NAMES, TMP, validate, errorCode, similar, dedup, load, freeze, realKey, isUnder, checkInput, checkOut, readChecked };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
