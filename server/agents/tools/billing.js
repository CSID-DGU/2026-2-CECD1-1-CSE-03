'use strict';
// 결제·구독 조회 툴. 원본은 business.js(목 데이터 또는 고객사 결제 시스템). 읽기 전용 — 환불·해지·결제 취소는 툴로 열지 않는다(사람 담당자).
// 금액·카드번호·계좌는 돌려주지 않는다: 답장 정책이 금액을 막고(guard), 결제 수단 번호는 응대에 필요 없다.
const crm = require('../../crm');
const { obj, out } = require('./schema');
const { customerScoped } = require('./customer');
const biz = require('./business');

const RECENT = 5;

function defs(ctx) {
  if (!biz.file() || !customerScoped(ctx)) return [];
  return [{
    name: 'lookup_billing',
    strict: true,
    description: '이 고객(현재 케이스의 주소)의 결제·구독 상태를 고객사 결제 시스템에서 찾아 돌려준다: 요금제·구독 상태·결제 주기·다음 결제일·자동 갱신 여부, 최근 결제 5건(결제일·상태·결제 수단 종류·환불 진행 상태), 같은 날 같은 금액으로 두 번 결제된 건의 표시. 고객이 메일이나 폼에 결제 번호를 적었으면 그 결제를 돌려준다. 결제 실패·중복 결제·환불 진행·구독 해지 여부를 묻는 질문에 쓰고, 영수증 발급처럼 일반 절차 질문에는 쓰지 않는다. 금액·카드번호·계좌는 돌려주지 않고, 환불·해지·결제 취소를 실행하지 않는다 — 그런 요청은 사람에게 넘긴다. 이 고객의 상태를 답장에 쓰면 근거에 tool:lookup_billing을 넣는다. 절차·조건의 근거는 지식베이스다.',
    input_schema: obj(),
  }];
}

function lookup(ctx) {
  const email = crm.contactKey(ctx.case.customer_email);
  const rec = biz.load().billing.find((b) => crm.contactKey(b.email) === email);
  if (!rec) return { found: false, subscription: null, payments: [], possibleDuplicates: [] };
  const all = [...(rec.payments || [])].sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)));
  const asked = biz.mentioned(ctx);
  const named = all.filter((p) => asked.has(String(p.paymentId).toUpperCase()));
  // 중복 표시는 금액을 쓰지만 금액 자체는 내보내지 않는다
  const seen = new Map(); const dup = new Set();
  for (const p of all.filter((x) => x.status === 'paid')) {
    const k = `${biz.day(p.paidAt)}|${p.amount}`;
    if (seen.has(k)) { dup.add(p.paymentId); dup.add(seen.get(k)); } else seen.set(k, p.paymentId);
  }
  const s = rec.subscription || null;
  return {
    found: true,
    matchedBy: named.length ? 'payment_id' : 'recent',
    subscription: s && { plan: s.plan ?? null, status: s.status ?? null, billingCycle: s.billingCycle ?? null, nextBillingOn: biz.day(s.nextBillingAt), autoRenew: s.autoRenew ?? null },
    payments: (named.length ? named : all.slice(0, RECENT)).map((p) => ({
      ref: biz.tail(p.paymentId), paidOn: biz.day(p.paidAt), status: p.status ?? null, method: p.method ?? null,
      refund: p.refund ? { status: p.refund.status ?? null, requestedOn: biz.day(p.refund.requestedAt), completedOn: biz.day(p.refund.completedAt) } : null,
    })),
    possibleDuplicates: [...dup].map(biz.tail),
  };
}

function handlers(ctx) {
  return { lookup_billing: () => out(lookup(ctx)) };
}

module.exports = { defs, handlers };
