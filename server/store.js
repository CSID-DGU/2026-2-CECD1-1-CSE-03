'use strict';
// JSON 문서 컬렉션(documents 테이블). 컬렉션 이름·JSON 경로는 화이트리스트 SQL 리터럴 — 경로를 바인딩하면 식 인덱스를 안 탄다.
const db = require('./db');

const COLLECTIONS = ['inbound_events', 'companies', 'contacts', 'cases', 'activities'];
const PATHS = { primaryEmail: '$.primaryEmail', primaryDomain: '$.primaryDomain', resolvedCaseId: '$.resolvedCaseId', caseId: '$.caseId', relatedCaseId: '$.relatedCaseId', dedupeKey: '$.dedupeKey' };

const col = (c) => { if (!COLLECTIONS.includes(c)) throw new Error(`알 수 없는 컬렉션: ${c}`); return c; };
const parse = (r) => r && { doc: JSON.parse(r.doc), revision: r.revision };

/** → {doc, revision} | null */
const get = (c, id) => parse(db.get(`SELECT doc, revision FROM documents WHERE collection='${col(c)}' AND id=?`, id));

/** 새 문서. 같은 id가 있으면 아무것도 안 한다(다른 유일 인덱스 충돌은 던진다). */
function insert(c, doc) {
  const now = db.now();
  return db.run(`INSERT INTO documents (collection, id, doc, revision, created_at, updated_at) VALUES ('${col(c)}',?,?,1,?,?) ON CONFLICT(collection, id) DO NOTHING`, doc.id, JSON.stringify(doc), now, now).changes > 0;
}

/** 넣거나 바꾼다. 내용이 같으면 쓰지 않는다(revision·updated_at 그대로). → {revision, changed} */
function put(c, doc) {
  const text = JSON.stringify(doc);
  const cur = db.get(`SELECT doc, revision FROM documents WHERE collection='${col(c)}' AND id=?`, doc.id);
  if (cur && cur.doc === text) return { revision: cur.revision, changed: false };
  const now = db.now();
  if (!cur) { db.run(`INSERT INTO documents (collection, id, doc, revision, created_at, updated_at) VALUES ('${c}',?,?,1,?,?)`, doc.id, text, now, now); return { revision: 1, changed: true }; }
  db.run(`UPDATE documents SET doc=?, revision=revision+1, updated_at=? WHERE collection='${c}' AND id=?`, text, now, doc.id);
  return { revision: cur.revision + 1, changed: true };
}

/** where = {경로 이름: 값} 일치(AND). → doc[] (넣은 순서) */
function find(c, where = {}, { limit } = {}) {
  const keys = Object.keys(where);
  for (const k of keys) if (!PATHS[k]) throw new Error(`알 수 없는 JSON 경로: ${k}`);
  const sql = `SELECT doc FROM documents WHERE collection='${col(c)}'${keys.map((k) => ` AND json_extract(doc,'${PATHS[k]}')=?`).join('')} ORDER BY rowid${limit ? ` LIMIT ${Math.trunc(limit)}` : ''}`;
  return db.all(sql, ...keys.map((k) => where[k])).map((r) => JSON.parse(r.doc));
}

/** 문서 하나를 지운다. */
const remove = (c, id) => db.run(`DELETE FROM documents WHERE collection='${col(c)}' AND id=?`, id).changes > 0;

const all = (c) => db.all(`SELECT doc FROM documents WHERE collection='${col(c)}' ORDER BY rowid`).map((r) => JSON.parse(r.doc));

module.exports = { get, insert, put, remove, find, all, COLLECTIONS, PATHS };
