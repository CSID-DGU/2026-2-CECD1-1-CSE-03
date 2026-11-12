'use strict';
// 접수 Agent RAG — KB 절 색인과 검색. KB_MODE=rag일 때만 쓰인다(기본 full은 이 모듈을 부르지 않는다).
// 색인 입력 = 절 제목 + 본문. 그 입력의 해시와 모델이 그대로인 절은 다시 임베딩하지 않는다.
// 원문은 kb.load가 고른 것(이미지 md 또는 콘솔에 게시된 KB)을 그대로 쓴다 — 지워졌거나 만료된 절은 load에서 빠지고, 색인에서도 지운다.
// 검색 결과는 지금 KB의 절과 해시로 다시 대조한다(색인과 원문이 어긋난 항목은 버린다).
// 맞춤은 저장소에 키별 해시를 한 번에 묻는다. 이 프로세스가 같은 (채널, 언어, 모델, 차원, kbVersion)을 이미 맞췄으면 retrieve는 맞춤을 건너뛴다
// — kbVersion은 load가 고른 원문 전체의 해시라 콘솔 게시·만료로 절이 바뀌면 달라지고, 그때 다시 맞춘다.
const crypto = require('node:crypto');
const embedder = require('./embed');
const vstore = require('./vector-store');
const kbLoader = require('./kb');

const TOPK_MAX = 50;
const fail = (code, message) => Object.assign(new Error(message || code), { code });

/** 요청 설정. 값 검사는 기동 검사(preflight)가 한다 — 여기서는 기본값만 채운다. */
function config(env = process.env) {
  const k = String(env.KB_TOPK ?? '').trim();
  return {
    mode: String(env.KB_MODE ?? '').trim() === 'rag' ? 'rag' : 'full',
    topK: /^[1-9]\d*$/.test(k) && Number(k) <= TOPK_MAX ? Number(k) : 5,
    toc: String(env.KB_TRIAGE_TOC ?? '').trim() !== '0',
  };
}

const inputOf = (s) => `${s.title}\n${s.text}`;
const hashOf = (s) => crypto.createHash('sha256').update(inputOf(s)).digest('hex');
// 저장소 호출 오류는 store_error로 모은다(이미 코드가 있으면 그대로)
const inStore = async (fn) => { try { return await fn(); } catch (e) { throw e.code ? e : fail('store_error', e.message); } };
const inEmbed = async (fn) => { try { return await fn(); } catch (e) { throw e.code ? e : fail('embed_error', e.message); } };

// 저장소마다(바꿔 끼우면 새로) 이 프로세스가 맞춘 자리. 저장소 쪽을 다른 프로세스가 바꾸는 일은 없다고 본다(색인은 이 서버만 쓴다).
const syncedBy = new WeakMap();
const synced = (store) => { let s = syncedBy.get(store); if (!s) syncedBy.set(store, (s = new Set())); return s; };
const syncKey = (x) => JSON.stringify([x.channel, x.language, x.model, x.dim, x.kbVersion]);

/** 이 채널·언어 KB의 색인을 지금 원문에 맞춘다. 반환: 다시 임베딩한 절 수·그대로 둔 수·지운 수·걸린 시간. */
async function sync({ channel, kb }) {
  if (!kb || kb.version === 'invalid') throw fail('kb_invalid');
  const secs = Object.values(kb.sections || {});
  if (!secs.length) throw fail('index_empty');
  const t0 = Date.now();
  const { model, dim, provider } = await inEmbed(async () => embedder.info());
  const store = await inStore(async () => vstore.store());
  const language = kb.language;
  const want = secs.map((s) => ({ key: s.key, hash: hashOf(s), input: inputOf(s) }));
  const have = await inStore(() => store.hashes({ channel, language, model }));
  const stale = want.filter((w) => !have[w.key] || have[w.key].hash !== w.hash || have[w.key].dim !== dim);
  if (stale.length) {
    const e = await inEmbed(() => embedder.embed(stale.map((w) => w.input), { inputType: 'document' }));
    if (e.model !== model || e.dim !== dim) throw fail('embed_invalid', '색인 중 모델·차원이 바뀌었다');
    await inStore(() => store.upsert(stale.map((w, i) => ({ channel, language, key: w.key, hash: w.hash, model, dim, vector: e.vectors[i] }))));
  }
  const removed = await inStore(() => store.prune({ channel, language, model, keepKeys: want.map((w) => w.key) }));
  synced(store).add(syncKey({ channel, language, model, dim, kbVersion: kb.version }));
  return { channel, language, kbVersion: kb.version, provider, model, dim, store: store.name, embedded: stale.length, kept: want.length - stale.length, removed, ms: Date.now() - t0 };
}

/**
 * 질문(가린 제목·본문)과 가까운 절 상위 topK. 색인을 먼저 맞추고(index 시간은 따로), 질문은 한 번만 임베딩한다.
 * 이미 맞춘 KB 판이면 맞춤을 건너뛴다(index.skipped, index 시간 0).
 * 던지는 오류의 code가 폴백 사유다(kb_invalid · index_empty · embed_* · store_* · no_hits).
 */
async function retrieve({ channel, kb, query, topK = config().topK }) {
  if (!kb || kb.version === 'invalid') throw fail('kb_invalid');
  if (!Object.keys(kb.sections || {}).length) throw fail('index_empty');
  const info = await inEmbed(async () => embedder.info());
  const cur = await inStore(async () => vstore.store());
  const sk = syncKey({ channel, language: kb.language, model: info.model, dim: info.dim, kbVersion: kb.version });
  const skip = synced(cur).has(sk);
  const idx = skip
    ? { language: kb.language, provider: info.provider, model: info.model, dim: info.dim, store: cur.name, embedded: 0, kept: 0, removed: 0, ms: 0, skipped: true }
    : await sync({ channel, kb });
  const t1 = Date.now();
  const q = await inEmbed(() => embedder.embed([query], { inputType: 'query' }));
  if (q.model !== idx.model || q.dim !== idx.dim) throw fail('embed_invalid', '질문과 색인의 모델·차원이 다르다');
  const t2 = Date.now();
  const store = cur;
  // 검색이 실패하거나 비면 다음 주기는 다시 맞춘다(저장소가 밖에서 비워졌을 수 있다)
  const forget = (e) => { synced(cur).delete(sk); throw e; };
  const found = await inStore(() => store.search({ channel, language: idx.language, model: idx.model, dim: idx.dim, vector: q.vectors[0], topK })).catch(forget);
  const t3 = Date.now();
  const hits = found.filter((h) => kb.sections[h.key] && h.hash === hashOf(kb.sections[h.key])).map((h) => ({ key: h.key, score: Math.round(h.score * 1e4) / 1e4 }));
  if (!hits.length) forget(fail('no_hits'));
  return {
    topK, hits, kbVersion: kb.version, kbLanguage: kb.language, kbKeys: Object.keys(kb.sections),
    embed: { provider: idx.provider, model: idx.model, dim: idx.dim, ...(info.region ? { region: info.region, inference: info.inference } : {}) }, store: idx.store,
    // embed = 공급자 호출 시간(embed가 잰 값 — 원격이면 네트워크 왕복 포함)
    ms: { index: idx.ms, embed: Number.isFinite(q.ms) ? q.ms : t2 - t1, search: t3 - t2 }, index: { embedded: idx.embedded, kept: idx.kept, removed: idx.removed, skipped: !!idx.skipped },
  };
}

/**
 * 접수 Agent에게만 주는 KB 보기 — 검색된 절 본문(점수 순) + 목차(toc, 모든 절의 키·제목). sections에는 검색된 절만 있다.
 * 답장·검수·인계·툴·guard는 이 보기를 받지 않는다(loop가 전체 KB를 따로 넘긴다).
 */
function triageView(kb, hits, { toc = config().toc } = {}) {
  const keys = hits.map((h) => h.key).filter((k) => kb.sections[k]);
  return {
    channel: kb.channel, language: kb.language, version: kb.version, mode: 'rag',
    sections: Object.fromEntries(keys.map((k) => [k, kb.sections[k]])),
    text: keys.map((k) => kb.sections[k].raw).join('\n\n'),
    toc: toc ? Object.values(kb.sections).map((s) => ({ key: s.key, title: s.title })) : null,
  };
}

/** 미리 색인 — 접수 Agent가 읽는 한국어 KB를 채널마다 맞춘다. 채널별 결과 또는 {channel, error}. */
async function warm(channels) {
  const out = [];
  for (const channel of channels) {
    try { out.push(await sync({ channel, kb: kbLoader.load(channel, 'ko') })); } catch (e) { out.push({ channel, error: e.code || 'index_error' }); }
  }
  return out;
}

module.exports = { config, sync, retrieve, triageView, warm, hashOf, inputOf, TOPK_MAX };
