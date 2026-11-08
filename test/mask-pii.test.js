'use strict';
// guard.maskPii 연락처 표기 변형 — 괄호 지역번호, 여러 대시·띄어 쓴 구분자, 전각 숫자, 한글 도메인 메일. 날짜·금액·주문 번호는 그대로.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../server/guard');

test('표기 변형 전화·메일을 [CONTACT]로 가린다', () => {
  for (const t of ['(02) 1234-5678', '(010)1234-5678', '+1 (415) 555-1234', '010–1234–5678', '010—1234—5678', '010 - 1234 - 5678', '０１０-1234-5678', '０１０－１２３４－５６７８', '홍길동@회사.한국', 'ｈｏｎｇ＠ｅｘａｍｐｌｅ．ｃｏｍ']) {
    assert.equal(guard.maskPii(t), '[CONTACT]', t);
  }
  assert.equal(guard.maskPii('연락은 (02) 1234-5678 또는 홍길동@회사.한국 으로 주세요'), '연락은 [CONTACT] 또는 [CONTACT] 으로 주세요');
});

test('전각 글자는 맞출 때만 펼치고 매치 밖 원문은 바꾸지 않는다', () => {
  assert.equal(guard.maskPii('전각ＡＢＣ와 ㈜에이 ０１０-1234-5678 끝'), '전각ＡＢＣ와 ㈜에이 [CONTACT] 끝');
});

test('한글 도메인 메일을 더해도 영문 메일 앞 한글은 먹지 않는다', () => {
  assert.equal(guard.maskPii('문의는support@acme.com으로 주세요'), '문의는[CONTACT]으로 주세요');
  assert.equal(guard.maskPii('메일 foo.bar+x@example.co.kr 주세요'), '메일 [CONTACT] 주세요');
});

test('날짜·금액·주문 번호·버전·시각은 연락처가 아니다', () => {
  for (const t of ['2026-11-06', '2026–11–06', '2026. 11. 06', '2025-2026', '1,234,000원', '₩50,000', '5,000원입니다', 'ORD-2026-000123', 'v1.2.3', '10:30', '3~5영업일', '회사.한국 도메인']) {
    assert.equal(guard.maskPii(t), t, t);
  }
});

test('초안 검사·판단 기록 쪽 연락처 식(CONTACT_RE·maskContacts)은 그대로다', () => {
  assert.equal(guard.maskContacts('(02) 1234-5678'), '(02) 1234-5678');
  assert.equal(guard.CONTACT_RE.test('홍길동@회사.한국'), false);
  assert.equal(guard.maskContacts('010-1234-5678'), '[연락처]');
});
