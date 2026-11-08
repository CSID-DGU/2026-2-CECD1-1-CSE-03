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
  ['messages', 'sender_auth', 'TEXT'],
  ['cases', 'purged_at', 'TEXT'],
  ['cases', 'related_case_id', 'TEXT'],
  ['cases', 'hold_note', 'TEXT'],
  ['cases', 'held_at', 'TEXT'],
  ['cases', 'close_reason', 'TEXT'],
  ['cases', 'close_detail', 'TEXT'],
  ['messages', 'event_id', 'TEXT'],
];

/** 실제 DB 파일 경로. `:memory:`면 null — 접속기록·수신 상태 파일·정보주체 스크립트가 이 파일의 폴더를 쓴다. */
function file(env = process.env) {
  const p = env.DB_PATH || path.join(__dirname, '..', 'data', 'cs-agent.db');
  return p === ':memory:' ? null : p;
}

function init(dbPath = file() || ':memory:') {
  if (db) db.close();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  // 정보주체 스크립트와 서버가 같은 파일에 쓴다 — 잠금을 5초 기다린다(없으면 쓰기가 바로 SQLITE_BUSY). 스키마 실행 전에 건다.
  if (dbPath !== ':memory:') db.exec('PRAGMA busy_timeout = 5000');
  // 파기(retention)한 원문이 빈 페이지·셀 자리에 남지 않게 지운 자리를 0으로 덮는다 — 연결마다 걸리는 설정이라 정보주체 스크립트도 여기서 켠다
  if (dbPath !== ':memory:') db.exec('PRAGMA secure_delete = ON');
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

module.exports = { init, file, all, get, run, insert, tx, now, uuid, isUnique, saveVersion };
