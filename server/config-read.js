'use strict';
// 고객이 게시한 KB·정책 원문을 DB에서 읽는 reader. kb.setReader·policy.setReader에 넣는다.
// db와 node:crypto만 쓴다 — 운영 CLI가 변환·LLM 코드를 끌어오지 않고 이 파일만 require한다.
const crypto = require('node:crypto');
const db = require('./db');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * 대상(kind, channel, lang)의 라이브 원문. 라이브 = 그 대상의 seq가 가장 큰 config_changes 행.
 * @param {'kb'|'policy'} kind
 * @param {string} channel
 * @param {'ko'|'en'|null} lang 정책은 null
 * @returns {null | {raw, hash, changeId} | {error: 'mismatch', changeId}} null = 이미지 파일을 쓴다(행 없음 또는 reset).
 *   versions 행이 없거나 sha256이 어긋나면 닫힌 쪽(mismatch)이다.
 */
function read(kind, channel, lang) {
  const row = db.get('SELECT id, action, to_hash, to_sha256 FROM config_changes WHERE kind=? AND channel=? AND language IS ? ORDER BY seq DESC LIMIT 1', kind, channel, lang ?? null);
  if (!row || row.action === 'reset') return null;
  const v = db.get('SELECT content FROM versions WHERE hash=?', row.to_hash);
  if (!v || sha256(v.content) !== row.to_sha256) return { error: 'mismatch', changeId: row.id };
  return { raw: v.content, hash: row.to_hash, changeId: row.id };
}

module.exports = { read, sha256 };
