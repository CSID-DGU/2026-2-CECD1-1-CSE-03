'use strict';
// node:sqlite 싱글턴. init(path)로 열고 모든 모듈은 여기 함수만 쓴다. 테스트는 init(':memory:').
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let db = null;

// 예전 DB 파일에 나중에 생긴 칼럼을 붙인다(schema.sql은 CREATE IF NOT EXISTS라 기존 테이블을 안 바꾼다).
const MIGRATIONS = [
  ['messages', 'auto_submitted', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'edited', 'INTEGER NOT NULL DEFAULT 0'],
  ['loops', 'lease_token', 'TEXT'],
  ['loops', 'next_retry_at', 'TEXT'],
  ['loops', 'retry_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['loops', 'retry_message_id', 'TEXT'],
  ['drafts', 'seen_out_rowid', 'INTEGER'],
];

function init(dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cs-agent.db')) {
  if (db) db.close();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  for (const [table, col, ddl] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
  return module.exports;
}

const need = () => db || init() && db;
const nz = (v) => (v === undefined ? null : v); // node:sqlite는 undefined 바인딩을 거부한다
const all = (sql, ...p) => need().prepare(sql).all(...p.map(nz));
const get = (sql, ...p) => need().prepare(sql).get(...p.map(nz)) ?? null;
const run = (sql, ...p) => need().prepare(sql).run(...p.map(nz));

function insert(table, row) {
  const keys = Object.keys(row);
  return run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
}

function tx(fn) {
  const d = need();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const isUnique = (e) => /UNIQUE constraint failed/.test(e?.message || '');

/** 프롬프트·KB·정책 팩 원문을 해시로 한 번만 저장 — decisions의 버전 해시로 그때 무엇이 쓰였는지 되찾는다. */
const saveVersion = (hash, kind, content) => {
  if (hash && content != null) run('INSERT OR IGNORE INTO versions (hash, kind, content, created_at) VALUES (?,?,?,?)', hash, kind, String(content), now());
};

module.exports = { init, all, get, run, insert, tx, now, uuid, isUnique, saveVersion };
