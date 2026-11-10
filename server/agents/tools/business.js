'use strict';
// 고객사 업무 시스템(주문·결제) 원본. 고객사가 정해지기 전에는 JSON 파일(BUSINESS_DATA_FILE)을 쓴다 — 목 데이터는 server/mock/business-data.json.
// 실제 연동은 load()만 바꾼다(주문 API·결제 API). 파일이 없으면 이 원본을 쓰는 툴은 목록에서 빠진다.
// 고객 메일·폼 원문에서 번호 후보를 찾는 일도 여기서 한다 — LLM에는 번호가 가려져([ORDER]) 들어가므로 모델이 번호를 넘기지 않는다.
const fs = require('node:fs');

const file = () => String(process.env.BUSINESS_DATA_FILE || '').trim();
// 매번 읽는다(파일이 작다는 가정) — 커지면 mtime 캐시나 실제 API로 바꾼다
const load = () => { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); return { orders: d.orders || [], billing: d.billing || [] }; };
// 숫자가 섞인 4자 이상 영숫자·대시 토큰(대문자로)
const TOKEN_RE = /(?=[A-Za-z-]*\d)[A-Za-z0-9][A-Za-z0-9-]{3,}/g;
const mentioned = (ctx) => {
  const raw = [ctx.rawMessage?.body_clean, ctx.rawMessage?.subject, ...Object.values(JSON.parse(ctx.case?.known_facts || '{}'))].join(' ');
  return new Set((raw.match(TOKEN_RE) || []).map((t) => t.toUpperCase()));
};
const tail = (n) => `…${String(n).slice(-4)}`;
const day = (t) => (t ? String(t).slice(0, 10) : null);

module.exports = { file, load, mentioned, tail, day };
