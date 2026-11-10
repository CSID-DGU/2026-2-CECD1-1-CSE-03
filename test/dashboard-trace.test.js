'use strict';
// 답장 Agent 툴 기록 · 고객 감정 신호 — 화면 문구가 web/app.js에 있는지
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

test('답장 Agent 툴 기록: 구역 제목·툴 이름·빈 곳 문구', () => {
  for (const s of ['답장 Agent 툴 기록', '지식베이스에 없던 질문', '걸음 상한 도달', '지식베이스 찾기', '지식베이스 빈 곳 남기기', '지난 케이스 조회', '고객 기록 조회', '주문 조회', '결제·구독 조회', '공식 사이트 읽기', '초안 검사', '초안 제출', '사람에게 넘김']) {
    assert.ok(app.includes(s), s);
  }
});

test('고객 감정 신호: 패널·단계·긴급도·위협', () => {
  for (const s of ['고객 감정 신호', '고객 감정', '매우 화남', '차분', '긴급도', '위협 신호', '원하는 것', '낮음', '보통', '높음']) {
    assert.ok(app.includes(s), s);
  }
});
