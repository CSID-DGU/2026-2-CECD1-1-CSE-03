'use strict';
// 임베딩 — embed(texts, {inputType: 'document' | 'query'}) → {vectors, model, dim, provider}. 벡터는 길이 1로 정규화해 돌려준다.
// 공급자는 EMBED_PROVIDER(기본 mock). 지금은 mock뿐이다(네트워크 없음, 이번 단계와 테스트용).
// 다음 단계: Amazon Bedrock Cohere Embed v4(1536차원)를 PROVIDERS에 같은 모양({name, model, dim, raw(texts, inputType)})으로 붙인다.
//   inputType은 Cohere input_type(search_document · search_query)으로 옮긴다. 차원·NaN·영벡터 검사는 공급자와 무관하게 여기서 한다.
const crypto = require('node:crypto');

const INPUT_TYPES = ['document', 'query'];
const fail = (code, message) => Object.assign(new Error(message || code), { code });

// mock: 글자 2-gram(한글·영숫자 묶음)과 단어를 해시해 고정 차원에 더한다. 같은 입력 → 같은 벡터. 문서·질문을 같은 공간에 둔다
const MOCK_DIM = 256;
function mockVector(text) {
  const v = new Array(MOCK_DIM).fill(0);
  const add = (tok, w) => {
    const h = crypto.createHash('sha1').update(tok).digest();
    v[h.readUInt16BE(0) % MOCK_DIM] += (h[2] & 1 ? 1 : -1) * w;
  };
  for (const run of String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    add(`w:${run}`, 1);
    for (let i = 0; i + 1 < run.length; i += 1) add(`b:${run.slice(i, i + 2)}`, 1);
  }
  return v;
}
const mock = { name: 'mock', model: 'mock-hash-2gram-v1', dim: MOCK_DIM, raw: (texts) => texts.map(mockVector) };

const PROVIDERS = { mock };
let forced = null;
/** 테스트가 공급자를 바꿔 끼운다(같은 모양의 객체) — null이면 env로 돌아간다. */
const use = (p) => { forced = p || null; };
function provider() {
  if (forced) return forced;
  const name = (process.env.EMBED_PROVIDER || 'mock').trim();
  const p = PROVIDERS[name];
  if (!p) throw fail('embed_config', `EMBED_PROVIDER=${name} — 지원: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}
/** 지금 쓰는 공급자·모델·차원(호출 없이). 색인 항목의 모델 식별자가 이것이다. */
const info = () => { const p = provider(); return { provider: p.name, model: p.model, dim: p.dim }; };

/** 공급자가 준 벡터를 검사하고 길이 1로 편다. 개수·차원이 틀리거나 NaN·무한·영벡터면 embed_invalid. */
function normalize(vectors, n, dim) {
  if (!Array.isArray(vectors) || vectors.length !== n) throw fail('embed_invalid', `벡터 수 ${Array.isArray(vectors) ? vectors.length : '-'} ≠ 입력 ${n}`);
  return vectors.map((v, i) => {
    if (!Array.isArray(v) && !ArrayBuffer.isView(v)) throw fail('embed_invalid', `#${i} 배열 아님`);
    if (v.length !== dim) throw fail('embed_invalid', `#${i} 차원 ${v.length} ≠ ${dim}`);
    let s = 0;
    for (const x of v) { if (typeof x !== 'number' || !Number.isFinite(x)) throw fail('embed_invalid', `#${i} 수가 아닌 값`); s += x * x; }
    if (!(s > 0)) throw fail('embed_invalid', `#${i} 영벡터`);
    const len = Math.sqrt(s);
    return Array.from(v, (x) => x / len);
  });
}

async function embed(texts, { inputType } = {}) {
  if (!INPUT_TYPES.includes(inputType)) throw fail('embed_input', `inputType=${inputType} — document | query`);
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) throw fail('embed_input', 'texts는 문자열 배열');
  const p = provider();
  if (!texts.length) return { vectors: [], model: p.model, dim: p.dim, provider: p.name };
  const vectors = normalize(await p.raw(texts, inputType), texts.length, p.dim);
  return { vectors, model: p.model, dim: p.dim, provider: p.name };
}

module.exports = { embed, info, use, normalize, PROVIDERS, INPUT_TYPES };
