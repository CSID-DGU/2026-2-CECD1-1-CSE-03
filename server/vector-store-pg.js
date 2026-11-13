'use strict';
// KB 절 벡터 저장소 — PostgreSQL + pgvector(VECTOR_STORE=pgvector, PGVECTOR_URL). 인터페이스는 vector-store.js 메모리 구현과 같다.
// KB 벡터만 둔다 — 운영 데이터(문의·결정·발송)는 그대로 SQLite다.
// 표: kb_vectors(channel, language, model, key, hash, dim, embedding vector, updated_at), PK (channel, language, model, key).
// embedding은 차원 없는 vector 열이고 dim 열로 거른다(모델·차원이 바뀌어도 표를 바꾸지 않는다). 절 수가 작으므로 정확 검색(색인 없음, HNSW 없음).
// 점수 = 내적(<#>는 음의 내적) — 벡터가 L2 정규화돼 있으므로 코사인과 같다. 같은 점수는 키 순.
// 값은 모두 매개변수로 넘긴다. 표·스키마 이름만 식별자로 넣으므로 형식을 검사한다.
// 오류는 모두 store_error(접속 문자열은 메시지에 넣지 않는다) — 접수 Agent는 full로 폴백한다.
const fail = (code, message) => Object.assign(new Error(message || code), { code });
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const CONNECT_MS = 3000;
const QUERY_MS = 5000;

const vec = (v) => `[${v.join(',')}]`;
const unvec = (s) => JSON.parse(s);
// pg 오류 메시지는 SQL 상태만 남긴다(호스트·사용자 이름이 섞일 수 있다)
const why = (e) => (e && e.code ? `pg ${e.code}` : (e && e.message) || 'pg error').replace(/postgres(ql)?:\/\/\S+/gi, '<url>');

function createPgStore({ url = process.env.PGVECTOR_URL, table = 'kb_vectors', schema = null, pool: given = null } = {}) {
  if (!IDENT.test(table) || (schema != null && !IDENT.test(schema))) throw fail('store_config', '표·스키마 이름 형식이 아니다');
  const T = schema ? `"${schema}"."${table}"` : `"${table}"`;
  let pool = given;
  let ready = null;

  function getPool() {
    if (pool) return pool;
    if (!String(url || '').trim()) throw fail('store_config', 'PGVECTOR_URL이 비어 있다');
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: url, max: 5, allowExitOnIdle: true,
      connectionTimeoutMillis: CONNECT_MS, statement_timeout: QUERY_MS, query_timeout: QUERY_MS, idleTimeoutMillis: 10000,
    });
    pool.on('error', () => {}); // 놀고 있는 연결이 끊겨도 프로세스를 죽이지 않는다(다음 질의가 store_error로 받는다)
    return pool;
  }
  async function q(text, params) {
    try { return await getPool().query(text, params); } catch (e) { throw e.code === 'store_config' ? e : fail('store_error', why(e)); }
  }
  function init() {
    ready ||= (async () => {
      await q('CREATE EXTENSION IF NOT EXISTS vector');
      if (schema) await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await q(`CREATE TABLE IF NOT EXISTS ${T} (
        channel text NOT NULL, language text NOT NULL, model text NOT NULL, key text NOT NULL,
        hash text NOT NULL, dim integer NOT NULL, embedding vector NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (channel, language, model, key))`);
    })().catch((e) => { ready = null; throw e; }); // 실패하면 다음 호출이 다시 시도한다
    return ready;
  }
  const run = async (text, params) => { await init(); return q(text, params); };

  return {
    name: 'pgvector',
    init,
    async get({ channel, language, model, key }) {
      const r = await run(`SELECT channel, language, model, key, hash, dim, embedding::text AS e FROM ${T}
        WHERE channel = $1 AND language = $2 AND model = $3 AND key = $4`, [channel, language, model, key]);
      const x = r.rows[0];
      return x ? { channel: x.channel, language: x.language, key: x.key, hash: x.hash, model: x.model, dim: x.dim, vector: unvec(x.e) } : null;
    },
    async hashes({ channel, language, model }) {
      const r = await run(`SELECT key, hash, dim FROM ${T} WHERE channel = $1 AND language = $2 AND model = $3`, [channel, language, model]);
      return Object.fromEntries(r.rows.map((x) => [x.key, { hash: x.hash, dim: x.dim }]));
    },
    async upsert(list) {
      if (!list.length) return;
      const col = (f) => list.map(f);
      await run(`INSERT INTO ${T} (channel, language, model, key, hash, dim, embedding, updated_at)
        SELECT c, l, m, k, h, d, e::vector, now()
        FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[]) AS u(c, l, m, k, h, d, e)
        ON CONFLICT (channel, language, model, key)
        DO UPDATE SET hash = EXCLUDED.hash, dim = EXCLUDED.dim, embedding = EXCLUDED.embedding, updated_at = now()`,
      [col((x) => x.channel), col((x) => x.language), col((x) => x.model), col((x) => x.key), col((x) => x.hash), col((x) => x.dim), col((x) => vec(x.vector))]);
    },
    async prune({ channel, language, model, keepKeys }) {
      const r = await run(`DELETE FROM ${T} WHERE channel = $1 AND language = $2 AND model = $3 AND NOT (key = ANY($4::text[]))`,
        [channel, language, model, keepKeys]);
      return r.rowCount;
    },
    async search({ channel, language, model, dim, vector, topK }) {
      const r = await run(`SELECT key, hash, -(embedding <#> $5::vector) AS score FROM ${T}
        WHERE channel = $1 AND language = $2 AND model = $3 AND dim = $4
        ORDER BY embedding <#> $5::vector, key LIMIT $6`, [channel, language, model, dim, vec(vector), topK]);
      return r.rows.map((x) => ({ key: x.key, hash: x.hash, score: Number(x.score) }));
    },
    async size() { const r = await run(`SELECT count(*)::int AS n FROM ${T}`); return r.rows[0].n; },
    /** 테스트가 쓴다 — 이 표를 지운다. */
    async drop() { await q(`DROP TABLE IF EXISTS ${T}`); if (schema) await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); ready = null; },
    async close() { const p = pool; pool = given; ready = null; if (p && p !== given) await p.end(); },
  };
}

module.exports = { createPgStore, CONNECT_MS, QUERY_MS };
