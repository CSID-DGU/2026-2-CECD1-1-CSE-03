'use strict';
// KB 절 벡터 저장소. VECTOR_STORE = memory(기본) | pgvector(server/vector-store-pg.js, PGVECTOR_URL — KB 벡터 전용, 운영 데이터는 SQLite).
// 메모리 구현은 테스트·단일 프로세스 실험용 — 프로세스가 끝나면 사라진다(기동 때 다시 색인한다). 두 구현은 같은 인터페이스(모두 async)다.
// 항목: { channel, language, key, hash(임베딩 입력의 해시), model, dim, vector(길이 1) }. 한 (channel, language, model, key)에 한 항목.
//   get({channel, language, model, key}) → 항목 | null
//   hashes({channel, language, model}) → { [key]: {hash, dim} }  — 색인 맞춤이 절마다 묻지 않게 한 번에
//   upsert(items)                                     — 같은 자리면 바꾼다(여러 개를 한 번에)
//   prune({channel, language, model, keepKeys}) → 지운 수 — keepKeys 밖의 항목(지워졌거나 만료된 절)
//   search({channel, language, model, dim, vector, topK}) → [{key, hash, score}] 점수(코사인) 내림차순, 같으면 키 순
// 검색은 같은 채널·언어·모델·차원 안에서만 한다 — 모델을 바꾸면 다른 색인이다.
const fail = (code, message) => Object.assign(new Error(message || code), { code });

function createMemoryStore() {
  const items = new Map();
  const id = (x) => JSON.stringify([x.channel, x.language, x.model, x.key]);
  const scope = (x, q) => x.channel === q.channel && x.language === q.language && x.model === q.model;
  return {
    name: 'memory',
    async get(q) { const x = items.get(id(q)); return x ? { ...x, vector: [...x.vector] } : null; },
    async hashes(q) {
      const out = {};
      for (const x of items.values()) if (scope(x, q)) out[x.key] = { hash: x.hash, dim: x.dim };
      return out;
    },
    async upsert(list) {
      for (const x of list) items.set(id(x), { channel: x.channel, language: x.language, key: x.key, hash: x.hash, model: x.model, dim: x.dim, vector: [...x.vector] });
    },
    async prune(q) {
      const keep = new Set(q.keepKeys);
      let n = 0;
      for (const [k, x] of items) if (scope(x, q) && !keep.has(x.key)) { items.delete(k); n += 1; }
      return n;
    },
    async search(q) {
      const out = [];
      for (const x of items.values()) {
        if (!scope(x, q) || x.dim !== q.dim || x.vector.length !== q.vector.length) continue;
        let s = 0;
        for (let i = 0; i < x.vector.length; i += 1) s += x.vector[i] * q.vector[i];
        out.push({ key: x.key, hash: x.hash, score: s });
      }
      return out.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, q.topK);
    },
    async size() { return items.size; },
    async close() {},
  };
}

// pgvector는 쓸 때만 읽는다(pg 패키지를 memory·full 실행이 읽지 않게)
const STORES = { memory: createMemoryStore, pgvector: () => require('./vector-store-pg').createPgStore() };
let current = null; let currentName = null; let forced = null;
/** 테스트가 저장소를 바꿔 끼운다 — null이면 env로 돌아간다(메모리 저장소는 새로 만든다). 앞 저장소(연결 풀)는 닫는다. */
const use = (s) => {
  if (current && current !== s) current.close?.().catch(() => {});
  forced = s || null; current = null; currentName = null;
};
function store() {
  if (forced) return forced;
  const name = (process.env.VECTOR_STORE || 'memory').trim();
  if (!STORES[name]) throw fail('store_config', `VECTOR_STORE=${name} — 지원: ${Object.keys(STORES).join(', ')}`);
  if (currentName !== name) {
    if (current) current.close?.().catch(() => {});
    current = STORES[name](); currentName = name;
  }
  return current;
}

module.exports = { store, use, createMemoryStore, STORES };
