'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../server/guard');
const policy = require('../server/policy');
const kbLoader = require('../server/kb');

const pack = policy.load('support');
const kb = kbLoader.load('support');
const codes = (body, usedFacts = []) => guard.check({ body, usedFacts, pack, kb }).map((h) => h.code);

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
test('빈 본문·길이 초과', () => {
  assert.deepEqual(codes('   '), ['empty']);
  assert.ok(codes('가'.repeat(601)).includes('too_long'));
});
test('연락처 마스킹은 긴 a.a.a. 문자열에서도 선형 — 1초 안에 끝나고 같은 문자열 안의 주소는 가린다', () => {
  const s = `${'a.'.repeat(100_000)} 문의는 foo.bar+x@example.co.kr 로`;
  const t0 = Date.now();
  const out = guard.maskPii(s);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  assert.ok(out.includes('[CONTACT]') && !out.includes('foo.bar+x@example.co.kr'));
  assert.equal(guard.maskContacts('메일 foo.bar+x@example.co.kr 주세요'), '메일 [연락처] 주세요');
});

describe('규칙별 놓침과 오탐', () => {
  const packs = { support: policy.load('support'), onboarding: policy.load('onboarding'), sales: policy.load('sales') };
  const kbs = { support: kbLoader.load('support'), onboarding: kbLoader.load('onboarding'), sales: kbLoader.load('sales') };
  // usedFacts를 채워 근거 검사와 섞이지 않게 한다
  const codes = (body, ch = 'support', o = {}) => guard.check({ body, usedFacts: ['features'], pack: packs[ch], kb: kbs[ch], ...o }).map((h) => h.code);

  test('금액: 통화 코드·기호 앞뒤, "10만 정도", 영어 단위', () => {
    for (const b of ['10만 정도 예상됩니다', 'USD 50입니다', 'It costs 50 dollars', '$50 fee', '₩50,000입니다', 'EUR 30', '30 euros', '50불입니다', '5천 원', '10만원'])
      assert.ok(codes(b).includes('amount'), b);
  });

  test('금액 오탐 없음: 인원·단계 번호·메뉴 경로·버전·KB 문장', () => {
    for (const b of ['팀원 10명 규모면 기본 설정으로 충분합니다.', '1) 설정 열기 2) 계정 선택', '[설정 > 계정 > 탈퇴하기]에서 진행하실 수 있습니다.',
      '버전 2.3.1에서 수정됐습니다.', '10만 명이 쓰는 기능입니다.', '작업이 불가합니다.'])
      assert.ok(!codes(b, 'onboarding').includes('amount'), b);
    assert.ok(codes('1만 명 이상', 'sales').includes('amount'), 'sales는 수량도 막는다(allowQuantities=false)');
  });

  test('날짜 약속: 금일·이번 달·영업일·영어 순서 무관', () => {
    for (const b of ['금일 중 처리해 드리겠습니다', '이번 달 안에 처리해 드리겠습니다', '3영업일 이내 답변드리겠습니다', '3영업일 이내에 처리됩니다',
      '내일 회신하겠습니다', '다음 주 중으로 발송 예정입니다', 'We will send it tomorrow', 'We’ll get back to you tomorrow',
      'We will reply by next Monday', 'by next Monday', 'It will be resolved within a week', 'within 3 business days'])
      assert.ok(codes(b, 'onboarding').includes('date_promise'), b);
  });

  test('날짜 약속 오탐 없음: 기간 사실·24시간 고객센터·KB 문장', () => {
    for (const b of ['삭제된 데이터는 30일간 보관됩니다.', '24시간 고객센터에 연락 주시면 됩니다.', '3월 2일 세션은 화상으로 진행됩니다.',
      '온보딩 미팅은 화상으로 진행되며 보통 한 시간 안에 끝납니다.', 'We will point you to the right one.',
      'You will not be charged from the next billing date.', '다음 주소로 보내드리겠습니다.', '이번 주문 건은 확인 후 처리됩니다.'])
      assert.ok(!codes(b, 'onboarding').includes('date_promise'), b);
    for (const ch of Object.keys(packs)) for (const lang of ['ko', 'en']) {
      const k = kbLoader.load(ch, lang);
      for (const s of Object.values(k.sections)) assert.deepEqual(guard.check({ body: s.text, usedFacts: [s.key], pack: packs[ch], kb: k }), [], `${ch}/${lang}/${s.key}`);
    }
  });

  test('™ ® ©는 이모지가 아니다', () => {
    assert.ok(!codes('ACME™ 서비스 ® © 안내입니다').includes('emoji'));
    assert.ok(codes('감사합니다 😊').includes('emoji'));
  });

  test('스킴 없는 링크도 KB 링크와 대조한다', () => {
    assert.ok(codes('www.evil.example.net 참고').includes('link_not_in_kb'));
    assert.ok(codes('evil.example.net/x 에서 받으세요').includes('link_not_in_kb'));
    assert.ok(!codes('help.example.com/guide 참고').includes('link_not_in_kb'), 'KB 링크의 스킴 없는 표기');
    assert.ok(!codes('www.help.example.com/guide 참고').includes('link_not_in_kb'));
    assert.ok(!codes('소개서 intro.pdf 참고').includes('link_not_in_kb'), '파일명은 링크가 아니다');
    assert.ok(!codes('cs@example.com').includes('link_not_in_kb'), '이메일 도메인은 링크가 아니다');
  });

  test('근거: 빈 usedFacts는 사실을 말하면 실패, intent 밖 KB 절은 fact_off_intent', () => {
    const s = packs.support; const k = kbs.support; const del = k.sections.account_deletion.text;
    const c = (o) => guard.check({ pack: s, kb: k, ...o }).map((h) => h.code);
    assert.ok(c({ body: del, usedFacts: [], intent: 'account_deletion' }).includes('no_fact'));
    assert.deepEqual(c({ body: del, usedFacts: ['account_deletion'], intent: 'account_deletion' }), []);
    assert.deepEqual(c({ body: del, usedFacts: ['receipt'], intent: 'account_deletion' }).filter((x) => x.startsWith('fact')), ['fact_off_intent']);
    // KB 절이 없는 intent(검토 중 회신)는 근거 없이 통과
    assert.deepEqual(guard.check({ body: '검토해 주신다니 감사합니다. 궁금한 점이 생기면 언제든 알려주세요.', usedFacts: [], pack: packs.sales, kb: kbs.sales, intent: 'reviewing' }), []);
    // intent 없이(옛 호출): KB 문장을 그대로 옮기고 근거를 비우면 실패, 짧은 일반 문장은 통과
    assert.ok(c({ body: del, usedFacts: [] }).includes('no_fact'));
    assert.deepEqual(c({ body: '확인해 보겠습니다.', usedFacts: [] }), []);
    assert.ok(!c({ body: del, usedFacts: ['receipt'] }).includes('fact_off_intent'), 'intent 없으면 절 제한은 건너뛴다');
  });

  test('스킴 없는 도메인/경로는 TLD 목록과 무관하게 링크, 파일명·버전·소수·이메일은 아니다', () => {
    for (const b of ['help.evil.example/reset 에서 재설정하세요', 'evil.dev/x', 'a.b.example/path 참고']) assert.ok(codes(b).includes('link_not_in_kb'), b);
    for (const b of ['소개서 intro.pdf 참고', 'v1.2/v1.3 차이입니다', '1.5/2.0 비율입니다', 'cs@help.example.com', 'help.example.com/guide 참고'])
      assert.ok(!codes(b).includes('link_not_in_kb'), b);
  });

  test('XXX 님·xxx님·△△님·홍OO 님도 미치환 자리표시', () => {
    for (const b of ['XXX 님 안녕하세요', 'xxx님', 'OOO 님', '○○ 님', '△△님', '[이름]님', '홍OO 님']) assert.ok(codes(b).includes('unresolved_slot'), b);
    for (const b of ['Box 님', 'Max님 안녕하세요', 'OX 퀴즈 기능', '[설정 > 계정 > 탈퇴하기]에서 진행하세요']) assert.ok(!codes(b).includes('unresolved_slot'), b);
  });

  test('미탐: 공백 뒤 "내"·다음 영업일·영어 in N days·next business day', () => {
    for (const b of ['3일 내 처리됩니다', '24시간 내 답변드리겠습니다', '다음 영업일에 연락드리겠습니다', '주말까지 답변드리겠습니다',
      'You will receive it the next business day.', 'It ships in 3 days', 'Expect a reply in 24 hours', 'We will fix it within the next week.'])
      assert.ok(codes(b).includes('date_promise'), b);
    for (const b of ['3일 내용을 확인했습니다.', '주말에는 답변이 늦어질 수 있습니다.']) assert.ok(!codes(b).includes('date_promise'), b);
  });

  test('오탐: <주소>·<제목>, 확장자/목록, v2 엔드포인트는 막지 않는다', () => {
    const slot = (b, human = true) => guard.check({ body: b, pack: packs.support, kb: kbs.support, only: ['unresolved_slot'], human }).length > 0;
    for (const b of ['<help@acme.example> 로 회신 부탁드립니다', '<안내문>을 참고해 주세요']) assert.ok(!slot(b), b);
    for (const b of ['<이름> 님', '<NAME>', '<customer_name> 고객님께', '{name}', '{{x}}', '[이름]님', 'XXX 님']) assert.ok(slot(b), b);
    // C-10: 에이전트 초안은 @·/·. 없는 <…>를 계속 자리표시로 본다
    for (const b of ['<링크>에서 확인하세요', '<고객명> 고객님', '<담당자 이름>에게 전달했습니다', 'Hi <name>,']) assert.ok(slot(b, false), b);
    for (const b of ['<help@acme.example> 로 회신 부탁드립니다', '<https://help.example.com/guide> 참고']) assert.ok(!slot(b, false), b);
    for (const b of ['Node.js/Python SDK를 지원합니다.', '파일 이름(예: report.csv/xlsx)을 확인해 주세요.']) assert.ok(!codes(b).includes('link_not_in_kb'), b);
    assert.ok(codes('help.evil.example/reset').includes('link_not_in_kb'));
    for (const b of ['API v2 엔드포인트를 사용하시면 됩니다.', 'v2 불러오기 기능입니다.']) assert.ok(!codes(b).includes('amount'), b);
    for (const b of ['50불입니다', '1000엔이에요', '5 엔입니다', '5 엔']) assert.ok(codes(b).includes('amount'), b);
    assert.ok(codes('주말에는 처리해 드리겠습니다').includes('date_promise'));
  });
});

test('guard가 금액·기한 약속의 흔한 표기를 잡는다(영어 포함)', () => {
  const pack = policy.load('support'); const kb = kbLoader.load('support');
  const codes = (b) => guard.check({ body: b, pack, kb }).map((h) => h.code);
  for (const b of ['$50 입니다', '₩50,000 입니다', '50,000 입니다', '20 percent off', '5만원']) assert.ok(codes(b).includes('amount'), b);
  for (const b of ['3영업일 이내에 처리됩니다', '24시간 이내 답변드리겠습니다', '1주일 이내에 보내드립니다', '내일 회신하겠습니다', '월요일에 연락드리겠습니다',
    '내일 오후 중으로 담당 부서에서 확인한 뒤 결과를 정리해서 보내드리겠습니다', 'We will get back to you by tomorrow', 'It will be done within 3 days']) assert.ok(codes(b).includes('date_promise'), b);
  assert.ok(codes('We can refund you').includes('forbidden_word'));
  assert.deepEqual(codes('삭제된 데이터는 30일간 보관됩니다.'), []);
  const ob = policy.load('onboarding');
  assert.deepEqual(guard.check({ body: '팀원 10명 규모면 기본 설정으로 충분합니다.', pack: ob, kb: kbLoader.load('onboarding') }), []);
});

test('자리표시 여러 모양을 막고, KB의 메뉴 이름·경로는 허용', () => {
  const pack = policy.load('support'); const kb = kbLoader.load('support');
  const slot = (b) => guard.check({ body: b, pack, kb }).some((h) => h.code === 'unresolved_slot');
  for (const b of ['[고객명] 님', '○○○ 님 안녕하세요', 'OO 님', '<이름> 님', '{} 님', '{회사명}']) assert.ok(slot(b), b);
  for (const b of ['[설정 > 계정 > 탈퇴하기]에서 진행하세요', '[세금계산서 요청]을 누르세요']) assert.ok(!slot(b), b);
});
