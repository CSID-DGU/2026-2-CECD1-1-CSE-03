'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../server/guard');
const policy = require('../server/policy');
const kbLoader = require('../server/kb');

const pack = policy.load('support');
const kb = kbLoader.load('support');
const codes = (body, usedFacts = []) => guard.check({ body, usedFacts, pack, kb }).map((h) => h.code);

test('KB 본문 그대로는 통과(모든 채널·언어)', () => {
  for (const ch of ['support', 'onboarding', 'sales']) {
    for (const lang of ['ko', 'en']) {
      const p = policy.load(ch); const k = kbLoader.load(ch, lang);
      for (const s of Object.values(k.sections)) assert.deepEqual(guard.check({ body: s.text, usedFacts: [s.key], pack: p, kb: k }), [], `${ch}/${lang}/${s.key}`);
    }
  }
});
test('금액', () => assert.ok(codes('비용은 50,000원입니다.').includes('amount')));
test('퍼센트·건수(수량은 allowQuantities=false 채널만)', () => {
  assert.ok(codes('10% 할인').includes('amount'));
  assert.ok(!codes('3건 처리했습니다').includes('amount')); // support는 수량 허용
  const sales = policy.load('sales');
  assert.ok(guard.check({ body: '3건 진행 가능합니다', pack: sales, kb: kbLoader.load('sales') }).some((h) => h.code === 'amount'));
});
test('날짜 약속은 막고 날짜 사실은 통과', () => {
  assert.ok(codes('내일까지 보내드리겠습니다.').includes('date_promise'));
  assert.ok(codes('3일 이내에 처리해 드리겠습니다.').includes('date_promise'));
  assert.ok(!codes('삭제된 데이터는 30일간 보관됩니다.').includes('date_promise'));
});
test('onboarding 팩은 날짜 "사실"만 허용, 기한 약속은 막는다', () => {
  const ob = policy.load('onboarding'); const k = kbLoader.load('onboarding');
  const c = (b) => guard.check({ body: b, pack: ob, kb: k }).map((h) => h.code);
  assert.deepEqual(c('3월 2일 세션은 화상으로 진행됩니다.'), []);
  assert.ok(c('다음 주에 안내드리겠습니다.').includes('date_promise'));
  assert.ok(c('내일까지 담당자 배정해 드리겠습니다').includes('date_promise'));
  assert.ok(codes('3월 2일 세션은 화상으로 진행됩니다.').includes('date')); // support는 날짜도 안 쓴다
});
test('금지어', () => assert.ok(codes('환불은 어렵습니다.').includes('forbidden_word')));
test('연락처', () => {
  assert.ok(codes('010-1234-5678로 연락 주세요').includes('contact'));
  assert.ok(codes('cs@example.com으로 보내주세요').includes('contact'));
});
test('KB 밖 링크 vs KB 링크', () => {
  assert.ok(codes('https://evil.example.net/x 참고').includes('link_not_in_kb'));
  assert.ok(!codes('https://help.example.com/guide 참고').includes('link_not_in_kb'));
});
test('usedFacts에 없는 키', () => assert.ok(codes('본문', ['nope']).includes('unknown_fact')));
test('미치환 슬롯', () => assert.ok(codes('안녕하세요 {회사명} {성함} 님').includes('unresolved_slot')));
test('이모지', () => assert.ok(codes('감사합니다 😊').includes('emoji')));
test('빈 본문·길이 초과', () => {
  assert.deepEqual(codes('   '), ['empty']);
  assert.ok(codes('가'.repeat(601)).includes('too_long'));
});
