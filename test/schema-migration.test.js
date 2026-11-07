'use strict';
// 스키마·DB 계약 — 옛 DB 파일 마이그레이션, 파일 DB 잠금 대기, 계량 테이블(FK 없음), DB 폴더 계산, env 인자 판단 함수.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../server/db');
const policy = require('../server/policy');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-migration-'));
after(() => { db.init(':memory:'); fs.rmSync(tmp, { recursive: true, force: true }); });
const cols = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);

test('옛 DDL로 만든 파일 DB를 init하면 새 칼럼·계량 테이블이 붙고 잠금 대기가 5초', () => {
  const file = path.join(tmp, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8'));
  old.exec('ALTER TABLE messages DROP COLUMN sender_auth; ALTER TABLE cases DROP COLUMN purged_at; DROP TABLE llm_calls');
  old.close();
  db.init(file);
  assert.ok(cols('messages').includes('sender_auth'));
  assert.ok(cols('cases').includes('purged_at'));
  assert.deepEqual(cols('llm_calls'), ['id', 'case_id', 'message_id', 'agent', 'provider', 'model', 'input_tokens', 'output_tokens', 'latency_ms', 'ok', 'error', 'created_at']);
  assert.equal(Object.values(db.get('PRAGMA busy_timeout'))[0], 5000);
});

test('llm_calls는 FK가 없다 — 없는 케이스 id로도 들어가고 foreign_key_check가 비어 있다', () => {
  db.init(':memory:');
  assert.equal(cols('messages').at(-1), 'event_id'); // 프로토타입 심이 SELECT * 칼럼 순서와 맞춘다
  db.insert('llm_calls', { id: db.uuid(), case_id: 'gone', agent: 'triage', provider: 'mock', ok: 1, created_at: db.now() });
  assert.deepEqual({ ...db.get('SELECT input_tokens, output_tokens FROM llm_calls') }, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});

test('db.file: 기본은 server/../data/cs-agent.db, :memory:면 null, 값이 있으면 그 경로', () => {
  assert.equal(db.file({}), path.join(__dirname, '..', 'data', 'cs-agent.db'));
  assert.equal(db.file({ DB_PATH: '' }), path.join(__dirname, '..', 'data', 'cs-agent.db'));
  assert.equal(db.file({ DB_PATH: ':memory:' }), null);
  assert.equal(db.file({ DB_PATH: '/srv/cs/x.db' }), '/srv/cs/x.db');
});

test('autoSendOn·shadowEnv는 넘긴 env를 읽는다(프로세스 env와 무관)', () => {
  assert.equal(policy.autoSendOn({}), true);
  assert.equal(policy.autoSendOn({ AUTO_SEND: '0' }), false);
  assert.equal(policy.autoSendOn({ MAIL_PROVIDER: 'smtp' }), false);
  assert.equal(policy.autoSendOn({ MAIL_PROVIDER: 'smtp', INBOUND_SECRET: 's' }), true);
  assert.deepEqual(policy.shadowEnv({ SHADOW_CHANNELS: ' support, sales ,' }), ['support', 'sales']);
  assert.deepEqual(policy.shadowEnv({}), []);
});
