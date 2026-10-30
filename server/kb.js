'use strict';
// kb/<channel>.md (+ 선택 kb/<channel>.en.md) → { sections: {key: {key,title,meta,text,raw}}, version, text, language }.
// `## kb:<key>` 절 단위, validUntil 지난 절은 뺀다. 버전 = 걸러진 뒤 실제로 쓰이는 본문의 해시.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KB_DIR = path.join(__dirname, '..', 'kb');
const META_RE = /^(제목|title|출처|source|검토일|reviewed|validUntil):\s*(.*)$/;

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

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
 * language='en'이면 kb/<channel>.en.md가 있을 때 그것을, 없으면 한국어 KB를 준다(실제 LLM이 번역해 답한다).
 * 반환 language는 실제로 읽은 파일의 언어.
 */
function load(channel, language = 'ko') {
  const en = path.join(KB_DIR, `${channel}.en.md`);
  const useEn = language === 'en' && fs.existsSync(en);
  const file = useEn ? en : path.join(KB_DIR, `${channel}.md`);
  const lang = useEn ? 'en' : 'ko';
  if (!fs.existsSync(file)) return { channel, language: lang, sections: {}, version: 'none', text: '' };
  const sections = parse(fs.readFileSync(file, 'utf8'));
  const text = Object.values(sections).map((s) => s.raw).join('\n\n');
  return { channel, language: lang, sections, version: sha(text), text };
}

module.exports = { parse, load, sha };
