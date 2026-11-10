'use strict';
// 주문 조회 툴. 원본은 business.js(목 데이터 또는 고객사 주문 시스템). 번호는 코드가 원문에서 찾는다(다른 주문을 넣어 보는 길이 없다).
const crm = require('../../crm');
const { obj, out } = require('./schema');
const { customerScoped } = require('./customer');
const biz = require('./business');

const RECENT = 3;
const ITEM_CHARS = 40;

function defs(ctx) {
  if (!biz.file() || !customerScoped(ctx)) return [];
  return [{
    name: 'lookup_order',
    strict: true,
    description: '이 고객(현재 케이스의 주소)의 주문을 고객사 주문 시스템에서 찾아 상태·주문일·발송일·도착일·상품명·수량·택배사·배송 상태를 돌려준다. 고객이 메일이나 폼에 주문번호를 적었으면 그 주문을, 적지 않았으면 최근 주문 3건을 돌려준다. 배송·주문 상태·교환·반품 진행을 묻는 질문에 쓰고, 일반 절차 질문에는 쓰지 않는다. 금액·결제 수단·주소·연락처는 돌려주지 않는다. 다른 고객의 주문은 번호가 맞아도 돌려주지 않으며, 결과는 맥락일 뿐 절차·조건의 근거는 지식베이스다.',
    input_schema: obj(),
  }];
}

function lookup(ctx) {
  const email = crm.contactKey(ctx.case.customer_email);
  const mine = biz.load().orders.filter((o) => crm.contactKey(o.email) === email);
  const asked = biz.mentioned(ctx);
  const named = mine.filter((o) => asked.has(String(o.orderNumber).toUpperCase()));
  const picked = named.length ? named : [...mine].sort((a, b) => String(b.orderedAt).localeCompare(String(a.orderedAt))).slice(0, RECENT);
  return {
    matchedBy: named.length ? 'order_number' : 'recent',
    orders: picked.map((o) => ({
      ref: biz.tail(o.orderNumber), status: o.status ?? null, orderedOn: biz.day(o.orderedAt), shippedOn: biz.day(o.shippedAt), deliveredOn: biz.day(o.deliveredAt),
      items: (o.items || []).map((i) => ({ name: String(i.name || '').slice(0, ITEM_CHARS), qty: i.qty ?? null })), carrier: o.carrier ?? null, trackingStatus: o.trackingStatus ?? null,
    })),
  };
}

function handlers(ctx) {
  return { lookup_order: () => out(lookup(ctx)) };
}

module.exports = { defs, handlers };
