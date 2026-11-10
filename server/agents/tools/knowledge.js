'use strict';
// 지식베이스 툴: 찾기·읽기·빈 곳 남기기. 답에 쓰는 사실의 근거는 읽은 절뿐이다(검사기가 fact_not_read로 본다).
const guard = require('../../guard');
const { prop, obj, out, keysOf, sectionKeys } = require('./schema');

const HITS = 5;
const SNIPPET = 120;
const GAP_LIMIT = 3;
const GAP_CHARS = 200;

// 글자 2-gram — 조사가 붙어도(영수증은/영수증을) 같은 낱말로 잡힌다. 공백·문장부호는 뺀다.
const grams = (s) => {
  const t = String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i += 1) g.add(t.slice(i, i + 2));
  return g;
};
const snippet = (text, query) => {
  const words = String(query).split(/[\s\p{P}]+/u).filter((w) => w.length >= 2);
  const at = Math.max(0, Math.min(...words.map((w) => { const i = text.indexOf(w.slice(0, 2)); return i < 0 ? Infinity : i; }), text.length) - 20);
  return text.slice(at, at + SNIPPET).replace(/\s+/g, ' ').trim();
};

/** 점수 = 질의 2-gram 중 절(제목 2배 가중)에 있는 비율. 0.2 미만은 버린다. */
function search(ctx, query) {
  const q = grams(query);
  if (!q.size) return [];
  return Object.values(ctx.kb?.sections || {}).map((s) => {
    const title = grams(s.title); const body = grams(s.text);
    let hit = 0;
    for (const g of q) hit += title.has(g) ? 2 : body.has(g) ? 1 : 0;
    return { key: s.key, title: s.title, score: Math.round((hit / (2 * q.size)) * 100) / 100, snippet: snippet(String(s.text || ''), query) };
  }).filter((r) => r.score >= 0.2).sort((a, b) => b.score - a.score).slice(0, HITS);
}

function defs(ctx) {
  const d = [];
  if (keysOf(ctx).length) {
    d.push({
      name: 'search_knowledge_base',
      strict: true,
      description: '이 채널 지식베이스에서 질의와 겹치는 절을 점수순으로 최대 5개 찾아 키·제목·점수·앞부분 120자를 돌려준다. 목차 제목만으로 어느 절이 답인지 모를 때, 고객이 목차와 다른 말로 물었을 때 쓴다. 목차에서 바로 고를 수 있으면 쓰지 않는다. 찾기만 해서는 읽은 것이 아니다 — 답에 쓰려면 지식베이스 읽기 툴로 그 절을 읽는다. 겹치는 절이 없으면 빈 목록이 온다.',
      input_schema: obj({ query: prop('string', '찾을 말. 고객 질문의 핵심 낱말을 띄어 쓴다.') }),
    });
    d.push({
      name: 'read_knowledge_base',
      strict: true,
      description: '이 채널 지식베이스에서 고른 절의 본문을 읽는다. 프롬프트에는 지식베이스 목차(키·제목)만 있으므로, 답에 사실(절차·조건·링크·기한 규정)을 하나라도 쓰려면 먼저 이 툴로 해당 절을 읽어야 한다. 질문에 필요한 절을 한 번에 여러 개 읽을 수 있고, 같은 절을 다시 읽을 필요는 없다. 고객의 이전 문의·계정 이력·주문은 돌려주지 않는다(그건 각각의 조회 툴). 없는 키는 missing으로 돌아온다.',
      input_schema: obj({ keys: prop('array', '읽을 절 키 목록(목차의 키 그대로).', { items: { type: 'string', enum: keysOf(ctx) } }) }),
    });
  }
  d.push({
    name: 'report_knowledge_gap',
    strict: true,
    description: '고객이 물었는데 지식베이스에 답이 없는 내용을 운영 리포트의 매뉴얼 보강 목록에 남긴다. 지식베이스를 찾고 읽어 봤는데도 답할 사실이 없을 때, 사람에게 넘기거나 일부만 답하기 전에 쓴다. 찾아보지 않았거나 답이 있는 질문이면 쓰지 않는다. 사이클을 끝내지 않는다 — 남긴 뒤 초안을 내거나 사람에게 넘긴다. 한 사이클에 3건까지 남고, 고객 식별 정보는 가려서 저장된다.',
    input_schema: obj({
      question: prop('string', '지식베이스에 없던 내용을 한 문장으로. 고객 이름·연락처·주문번호는 넣지 않는다.'),
      nearestKeys: sectionKeys(ctx, '가장 가까웠지만 답이 되지 못한 절 키. 없으면 빈 배열.'),
    }),
  });
  return d;
}

function handlers(ctx, state) {
  const secs = ctx.kb?.sections || {};
  return {
    search_knowledge_base: ({ query = '' }) => out({ hits: search(ctx, query) }),
    read_knowledge_base({ keys = [] }) {
      const found = keys.filter((k) => secs[k]);
      found.forEach((k) => state.read.add(k));
      return out({ sections: found.map((k) => ({ key: k, title: secs[k].title, text: secs[k].text })), missing: keys.filter((k) => !secs[k]) });
    },
    report_knowledge_gap({ question = '', nearestKeys = [] }) {
      const q = guard.maskPii(String(question), { name: ctx.case?.customer_name, kbText: ctx.kb?.text || '' }).replace(/\s+/g, ' ').trim().slice(0, GAP_CHARS);
      if (!q) return out({ error: '빈 질문', next: '지식베이스에 없던 내용을 한 문장으로 적어 다시 부른다.' }, true);
      if (state.gaps.length >= GAP_LIMIT) return out({ error: `이 사이클에는 ${GAP_LIMIT}건까지 남는다`, next: '초안을 내거나 사람에게 넘긴다.' }, true);
      state.gaps.push({ question: q, nearestKeys: nearestKeys.filter((k) => secs[k]) });
      return out({ recorded: true, next: '초안을 내거나 사람에게 넘긴다.' });
    },
  };
}

module.exports = { defs, handlers, search };
