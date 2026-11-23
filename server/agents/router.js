'use strict';
// 결정 모델 툴 라우터(TOOL_ROUTER=decision) — 답장 Agent의 첫 걸음을 결정 모델이 고르고 코드가 실행한다.
// LLM이 "어느 절을 읽고 어느 조회를 부를지" 고르는 첫 왕복(약 2초)을 결정 모델 한 번(약 0.6초)으로 바꾼다. 본문은 여전히 LLM이 쓴다.
// 고른 결과는 tool_use·tool_result 한 쌍으로 대화 앞에 붙는다 — 이어지는 ReAct가 읽은 것으로 보고, 근거 검사(읽은 절·부른 조회)도 같은 runner 상태를 쓴다.
// 탈퇴: 결정 모델이 "본인이 지금 탈퇴를 분명히 요청한다"를 DELETE_MIN 이상으로 판정하고 탈퇴 요청 툴이 열린 사이클이면 등록 주소로 확인 코드를 보낸다(계정은 고객이 코드로 회신해야 꺼진다).
// 결정 모델이 실패하거나 확신이 낮으면 아무것도 붙이지 않는다(원래 ReAct 그대로).
const decision = require('../llm/decision');
const account = require('./tools/account');

const PICK_MIN = 0.6;   // 조회·절 고르기 — 틀려도 LLM이 다음 걸음에서 더 읽는다
const DELETE_MIN = 0.9; // 확인 코드 메일을 고객에게 보내는 일 — 높게
const on = () => process.env.TOOL_ROUTER === 'decision';

const FACT = {
  lookup_order: '이 고객의 주문·배송 상태를 알아야 답할 수 있다',
  lookup_billing: '이 고객의 결제·구독 상태를 알아야 답할 수 있다',
  lookup_account: '이 고객의 계정 상태(로그인 잠김, 탈퇴 진행, 권한)를 알아야 답할 수 있다',
  find_meeting_slots: '담당자와 미팅할 수 있는 시간을 알려 줘야 한다',
};

function questions(ctx, names) {
  const q = {};
  const facts = Object.keys(FACT).filter((n) => names.has(n));
  if (facts.length) {
    q.lookup = { type: 'choice', instructions: '고객 메일에 답하려면 이 고객의 어떤 정보를 먼저 조회해야 하는가?',
      criteria: { ...Object.fromEntries(facts.map((n) => [n, FACT[n]])), none: '이 고객의 상태·일정 조회 없이 일반 안내로 답할 수 있다' } };
  }
  const secs = Object.values(ctx.kb?.sections || {});
  if (names.has('read_knowledge_base') && secs.length >= 1) {
    q.section = { type: 'choice', instructions: '이 메일에 답하려면 지식베이스의 어느 절을 먼저 읽어야 하는가?',
      criteria: { ...Object.fromEntries(secs.map((x) => [x.key, x.title || ''])), none: '읽을 절이 없다' } };
  }
  if (names.has('request_account_deletion')) {
    q.delete_now = { type: 'noul', instructions: '고객이 이 메일에서 본인 계정의 탈퇴(회원 탈퇴·계정 삭제)를 지금 처리해 달라고 분명히 요청하는가? 방법·조건·진행 상황만 묻거나 망설이면 아니다.' };
  }
  return q;
}

/**
 * 첫 걸음을 고르고 실행한다. 반환: {messages: [assistant, user] 또는 [], entry: trace 한 줄} 또는 null(라우터 꺼짐·실패).
 * tr = tools.runner(ctx), defs = 이 사이클 툴 정의.
 */
async function route(ctx, tr, defs) {
  if (!on()) return null;
  const names = new Set(defs.map((d) => d.name));
  const q = questions(ctx, names);
  if (!Object.keys(q).length) return null;
  const d = await decision.decide({ input: `제목: ${ctx.message?.subject || ''}\n\n${ctx.message?.body_clean || ''}`, questions: q });
  if (!d) return { messages: [], entry: { step: 0, router: true, ok: false, calls: [] } };
  const a = d.answers;
  const plan = [];
  if (a.delete_now?.noul >= DELETE_MIN && names.has('request_account_deletion')) plan.push({ name: 'request_account_deletion' });
  const sec = a.section?.choice;
  if (sec && sec !== 'none' && a.section.confidence >= PICK_MIN && ctx.kb?.sections?.[sec]) plan.push({ name: 'read_knowledge_base', input: { keys: [sec] } });
  const look = a.lookup?.choice;
  if (look && look !== 'none' && a.lookup.confidence >= PICK_MIN && names.has(look)) plan.push({ name: look, input: {} });
  const uses = []; const results = []; const calls = []; let done = null;
  for (const [i, p] of plan.entries()) {
    const id = `router_${i + 1}`;
    const t1 = Date.now();
    let x;
    if (p.name === 'request_account_deletion') {
      const r = await account.requestFor(ctx, tr.state, 'agent:router');
      x = r.ok ? { content: JSON.stringify({ codeSent: !r.already, already: !!r.already, by: 'decision_model', next: '답장에는 등록된 메일 주소로 확인 코드를 보냈고 그 코드로 회신해야 탈퇴가 진행된다고 쓴다. 아직 탈퇴된 것이 아니다.' }), isError: false }
        : { content: JSON.stringify({ error: r.error === 'owner' ? '팀 소유자 계정 — 확인 코드를 보내지 않았다' : r.error, next: '사람에게 넘긴다(request_handoff human_request).' }), isError: true };
      // 소유자 계정은 툴 경로와 같이 모델 판단 없이 넘긴다
      if (r.error === 'owner') done = { body: null, usedFacts: [], humanCommitments: [], needsHandoff: true, handoffReason: 'human_request' };
      uses.push({ type: 'tool_use', id, name: p.name, input: { customerQuote: '(결정 모델 판정)' } });
    } else {
      x = await tr.run(p.name, p.input);
      uses.push({ type: 'tool_use', id, name: p.name, input: p.input });
    }
    calls.push({ tool: p.name, ok: !x.isError, toolMs: Date.now() - t1 });
    results.push({ type: 'tool_result', tool_use_id: id, content: x.content, ...(x.isError ? { is_error: true } : {}) });
  }
  const picks = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.type === 'noul' ? Math.round(v.noul * 100) / 100 : v.choice]));
  const entry = { step: 0, router: true, ok: true, llmMs: d.ms, picks, calls };
  return { messages: uses.length ? [{ role: 'assistant', content: uses }, { role: 'user', content: results }] : [], entry, ...(done ? { done } : {}) };
}

module.exports = { route, on, PICK_MIN, DELETE_MIN };
