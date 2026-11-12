'use strict';
// 임베딩 확인 — 지금 env의 공급자(EMBED_PROVIDER)로 한국어 질문 3개(query)와 support KB 절 전부(document, 색인과 같은 "제목 + 본문")를 임베딩하고,
// 공급자·모델·차원·리전·호출 시간과 질문별 가장 가까운 절·유사도를 출력한다.
//   node --env-file=.env scripts/embed-check.js
// 키 값·서명 헤더는 출력하지 않는다. 실패하면 오류 코드(embed_auth 등)와 짧은 이유만 내고 exit 1.
const embed = require('../server/embed');
const kbLoader = require('../server/kb');
const kbIndex = require('../server/kb-index');

const QUERIES = [
  '비밀번호를 잊어버려서 로그인이 안 돼요',
  '구독을 해지하고 환불받고 싶습니다',
  '결제 영수증은 어디서 받을 수 있나요?',
];

async function main() {
  let info;
  try { info = embed.info(); } catch (e) { console.error(`실패: ${e.code || 'embed_error'} — ${e.message}`); return 1; }
  console.log(`공급자 ${info.provider} · 모델 ${info.model} · 차원 ${info.dim}${info.region ? ` · 리전 ${info.region} · 추론 ${info.inference}` : ''}`);
  // 절 제목 = 본문의 "제목:" 줄(없으면 절 머리 title)
  const titleOf = (s) => /^제목:\s*(.+)$/m.exec(s.text || '')?.[1].trim() || s.title;
  // 임베딩 입력은 색인과 같다(kb-index.inputOf = 절 제목 + 본문)
  const sections = Object.values(kbLoader.load('support', 'ko').sections || {}).map((s) => ({ key: s.key, title: titleOf(s), input: kbIndex.inputOf(s) }));
  if (!sections.length) { console.error('실패: index_empty — support KB에 절이 없다'); return 1; }
  try {
    const d = await embed.embed(sections.map((s) => s.input), { inputType: 'document' });
    console.log(`document ${sections.length}개 임베딩 ${d.ms}ms`);
    const q = await embed.embed(QUERIES, { inputType: 'query' });
    console.log(`query ${QUERIES.length}개 임베딩 ${q.ms}ms`);
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    QUERIES.forEach((text, i) => {
      const scored = d.vectors.map((v, j) => ({ title: sections[j].title, key: sections[j].key, score: dot(q.vectors[i], v) })).sort((a, b) => b.score - a.score);
      console.log(`- "${text}" → ${scored[0].key}(${scored[0].title}) ${scored[0].score.toFixed(4)}  [${scored.map((x) => `${x.key} ${x.score.toFixed(4)}`).join(', ')}]`);
    });
    return 0;
  } catch (e) {
    console.error(`실패: ${e.code || 'embed_error'} — ${String(e.message || '').slice(0, 200)}`);
    return 1;
  }
}

if (require.main === module) main().then((c) => { process.exitCode = c; });
module.exports = { main, QUERIES };
