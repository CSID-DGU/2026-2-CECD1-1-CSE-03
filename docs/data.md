# 데이터 파일 목록

저장소에 있는 데이터 파일은 모두 지어낸 값이다. 회사·제품은 가상의 SaaS "ACME"이고, 고객 이름·이메일·주문번호도 모두 가상이다. 실제 고객 정보는 저장소에 넣지 않는다.

새 데이터 파일을 추가하거나 성격이 바뀌면 이 표에 한 줄을 고친다.

## 저장소 안

| 파일 | 무엇 | 성격 | 읽는 곳 | 파일럿 때 |
|---|---|---|---|---|
| `kb/support.md` · `kb/support.en.md` | 고객지원 채널 지식베이스(탈퇴, 영수증, 해지, 기능 사용법, 로그인) | 가상. 절마다 붙은 `출처`·`검토일`도 지어낸 값 | `server/kb.js`를 거쳐 답장 Agent | 고객사 매뉴얼로 바꾼다(콘솔 「매뉴얼 변환」) |
| `kb/onboarding.md` | 온보딩 채널 지식베이스(진행 순서, 미팅, 안내 자료) | 가상. 자료 주소는 `example.com` | 같음 | 같음 |
| `kb/sales.md` | 영업 채널 지식베이스(서비스 소개, 상품 구성, 진행 순서, 비용 구조) | 가상. 금액은 넣지 않는다 | 같음 | 같음 |
| `policy/*.json` | 채널 정책 팩. 의도별 처리 수준(자동 발송, 초안 검토, 사람 처리)과 금지 규칙 | 우리가 정한 설계값 | `server/policy.js` | 고객사와 수준을 합의해 고친다 |
| `server/mock/inquiries.js` | 합성 문의 20건과 기대 처리 결과 | 가상 | `npm run demo`, `npm run sim`, 테스트 | 그대로 둔다(회귀 검사용) |
| `server/mock/business-data.json` | 주문·결제·계정 조회 툴과 담당자 빈 시간 툴의 시험용 원본(`orders`·`billing`·`accounts`·`meeting`). 이메일은 `inquiries.js`의 가상 고객, 평가 세트 v2의 등록 고객과 맞춘다 | 가상 | `BUSINESS_DATA_FILE`로 지정했을 때 `server/agents/tools/business.js`. 평가 실행기는 늘 이 파일로 고정 | 고객사 주문·결제·계정 시스템과 캘린더 연동으로 바꾼다 |
| `eval/scenarios.v2.jsonl` | v1 120건 + 등록 고객 시나리오 8건(`registered` 태그, 기대 툴 `expect.tools`) | 우리가 새로 쓴 문장 | `scripts/sim/`(`--set=v2`) | 동결본. 고치려면 v3 |
| `eval/scenarios.v1.jsonl` | 가상 고객 평가 시나리오 120건 | 우리가 새로 쓴 문장. 외부 데이터셋은 [`eval/SOURCES.md`](../eval/SOURCES.md)의 범위에서만 참고 | `scripts/sim/` | 동결본이라 고치지 않는다. 바꾸려면 새 버전(v2)을 만든다 |
| `eval/personas.v1.json` | 시나리오의 고객 페르소나 | 가상 | 같음 | 같음 |
| `eval/MANIFEST.json` | 평가 세트의 해시와 동결 당시 지식베이스·정책 해시 | 기록 | `scripts/sim/scenarios.js`가 로드할 때 해시를 대조 | 손으로 고치지 않는다 |
| `docs/runs/*.json` | 실제 모델로 돌린 기록. 케이스별 처리 결과, 지연, 토큰, 버전 해시 | 집계만, 메일 본문 없음 | 사람이 읽는다 | — |

## 저장소 밖

| 경로 | 무엇 | 규칙 |
|---|---|---|
| `data/` · `reference/` | 로컬 작업 자료 | `.gitignore`에 있다. 외부 서비스, 공개 저장소, 공유 링크에 올리지 않는다 |
| `../eval-out/` | 평가 실행 산출물(`npm run sim:eval`, `scripts/eval-real.js`) | 저장소 밖에 둔다. 비교는 `scripts/sim/compare.js`로 집계만 읽는다 |
| `.env` | 키와 운영 설정 | `.gitignore`에 있다. 항목 설명은 `.env.example`과 [`deployment.md`](deployment.md) |

## 지식베이스를 고칠 때

- `kb.js`는 `validUntil`이 지난 절을 빼고 남은 본문으로 버전 해시를 만든다. 지식베이스를 고치면 해시가 바뀌고, 평가 실행 비교표에 「지식베이스」가 다른 조건으로 표시된다.
- 금액, 할인, 수수료율, 환불 결정은 넣지 않는다. 사람만 정한다.
- 고객 한 사람에 대한 정보는 지식베이스가 아니라 케이스의 `known_facts`에 둔다.

## 알려진 빈칸

ReAct 실행에서 답장 Agent가 지식베이스에 답이 없다고 보고한 항목이다. 고객사 답을 받으면 해당 절에 넣는다.

| 채널 | 빠진 내용 | 넣을 절 |
|---|---|---|
| sales | 기본형 초기 설정 비용이 따로 있는지(금액 없이 있다/없다만) | `cost_structure` |
| onboarding | 온보딩 전에 미리 준비하거나 설정할 것 | `onboarding_steps` 또는 `materials` |
| onboarding | 미팅 전에 팀원을 먼저 초대할 수 있는지 | `onboarding_steps` |
| support | 앱에서 해지 신청한 뒤 처리됐는지 확인하는 방법 | `cancel_subscription` |
