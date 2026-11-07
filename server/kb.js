'use strict';
// kb/<channel>.md (+ 선택 kb/<channel>.en.md) → { sections: {key: {key,title,meta,text,raw}}, version, text, language }.
// `## kb:<key>` 절 단위, validUntil 지난 절은 뺀다. 버전 = 걸러진 뒤 실제로 쓰이는 본문의 해시.
// 고객이 게시한 원문은 주입된 reader로 읽는다(setReader). reader가 없거나 null을 주면 이미지 파일을 쓴다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KB_DIR = path.join(__dirname, '..', 'kb');
const META_RE = /^(제목|title|출처|source|검토일|reviewed|validUntil):\s*(.*)$/;
// 채널 이름은 파일 경로가 된다 — 이 모양이 아니면 없는 채널로 본다(../ 같은 값으로 폴더 밖 파일을 읽지 않게). policy.load도 같은 규칙.
const CHANNEL_RE = /^[a-z0-9_-]{1,40}$/;
const KEY_RE = /^[a-z0-9_]{2,40}$/;
const KB_MAX_BYTES = 256 * 1024;
const LANGS = ['ko', 'en'];
// 프롬프트가 KB를 <<<KB … KB>>>로 감싼다 — 울타리를 닫고 지시를 끼워 넣지 못하게 원문에 이 토큰이 있으면 쓰지 않는다.
const FENCE_RE = /<<<|>>>/;

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

let reader = null;
let onInvalid = null;
let warned = new Set();
/** fn(kind, channel, lang) → null | {raw, hash, changeId} | {error, changeId}. onInvalid({kind, channel, lang, changeId, error})는 대상을 닫을 때 (대상, changeId)당 한 번. */
function setReader(fn, { onInvalid: cb = null } = {}) { reader = fn || null; onInvalid = cb; warned = new Set(); }
const read = (channel, lang) => {
  if (!reader) return null;
  try { return reader('kb', channel, lang) || null; } catch { return { error: 'reader' }; }
};

function parse(text, now = new Date()) {
  const sections = {};
  for (const part of String(text).split(/^## kb:/m).slice(1)) {
    const lines = part.split('\n');
    const key = lines[0].trim();
    const meta = {};
    const body = [];
    for (const line of lines.slice(1)) {
      const m = line.match(META_RE);
      if (m && body.join('').trim() === '') meta[m[1]] = m[2].trim();
      else body.push(line);
    }
    if (meta.validUntil && new Date(`${meta.validUntil}T23:59:59Z`) < now) continue;
    sections[key] = { key, title: meta['제목'] || meta.title || key, meta, text: body.join('\n').trim(), raw: `## kb:${part.trim()}` };
  }
  return sections;
}

/**
 * 이 채널·언어에 지금 쓰이는 KB 원문. 고객 원문이 하나라도 라이브이면 채널 전체가 고객 소유다(이미지 KB를 보지 않는다).
 * 그때 en 요청은 고객 en → 고객 ko, ko 요청은 고객 ko. 고객 원문이 없으면 이미지 en(요청 시, 있으면) → 이미지 ko.
 * @returns {{raw, srcHash, language, live, invalid, changeId, error?} | null} 채널 이름이나 언어가 잘못되면 null.
 */
function source(channel, language = 'ko') {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel) || !LANGS.includes(language)) return null;
  const mine = { ko: read(channel, 'ko'), en: read(channel, 'en') };
  let out;
  if (!mine.ko && !mine.en) {
    const en = path.join(KB_DIR, `${channel}.en.md`);
    const useEn = language === 'en' && fs.existsSync(en);
    const file = useEn ? en : path.join(KB_DIR, `${channel}.md`);
    out = { raw: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, language: useEn ? 'en' : 'ko', live: false, changeId: null };
  } else {
    const lang = language === 'en' && mine.en ? 'en' : 'ko';
    const r = mine[lang];
    out = { raw: typeof r?.raw === 'string' && !r.error ? r.raw : null, language: lang, live: true, changeId: r?.changeId ?? null };
    // 고객 en만 라이브인 ko 요청(DB 변조)은 이미지 ko로 가지 않고 닫는다.
    if (out.raw === null) out.error = r ? String(r.error || 'bad_raw') : 'no_ko';
  }
  if (out.raw !== null && Buffer.byteLength(out.raw, 'utf8') > KB_MAX_BYTES) out.error = 'too_large';
  else if (out.raw !== null && FENCE_RE.test(out.raw)) out.error = 'fence';
  return { ...out, srcHash: out.raw === null ? null : sha(out.raw), invalid: !!out.error };
}

/**
 * language='en'이면 en KB(고객 en, 이미지 en)가 있을 때 그것을, 없으면 한국어 KB를 준다(실제 LLM이 번역해 답한다).
 * 반환 language는 실제로 읽은 원문의 언어. 닫힌 원문(reader 오류·크기·울타리)은 던지지 않고 빈 KB(version 'invalid')다.
 */
function load(channel, language = 'ko') {
  const src = source(channel, language === 'en' ? 'en' : 'ko');
  const lang = src?.language ?? 'ko';
  if (src?.invalid) {
    const key = `kb:${channel}:${lang}\u0000${src.changeId}`;
    if (!warned.has(key)) {
      warned.add(key);
      const info = { kind: 'kb', channel, lang, changeId: src.changeId, error: src.error };
      try { if (onInvalid) onInvalid(info); else console.warn(`[kb] ${channel}:${lang} 원문을 쓸 수 없어 빈 KB로 닫음(${src.error})`); } catch { /* 콜백 오류로 load가 던지지 않게 */ }
    }
    return { channel, language: lang, sections: {}, text: '', version: 'invalid', error: 'kb_invalid' };
  }
  if (!src || src.raw === null) return { channel, language: lang, sections: {}, version: 'none', text: '' };
  const sections = parse(src.raw);
  const text = Object.values(sections).map((s) => s.raw).join('\n\n');
  return { channel, language: lang, sections, version: sha(text), text };
}

module.exports = { parse, load, source, setReader, sha, CHANNEL_RE, KEY_RE, KB_MAX_BYTES, META_RE };
