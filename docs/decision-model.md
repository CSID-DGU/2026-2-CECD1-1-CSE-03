# 결정 모델 비교 — 접수 Agent의 intent 분류

접수 Agent의 intent 판단을 결정 모델(Gemini Decision 1, `POST /v1beta/decisions`)로 바꿀 수 있는지 본 실험이다. 서버 코드는 바꾸지 않았다.

## 방법

- 입력: 평가 세트 v3 128건의 첫 메일(제목 + 본문). 모두 합성 데이터다. 실제 고객 메일은 보내지 않았다(무료 등급은 입력을 제품 개선에 쓸 수 있다).
- 접수 Agent: 지금 서버가 쓰는 프롬프트와 모델(`claude-sonnet-5-5`, `KB_MODE=full`)을 그대로 부른다.
- 결정 모델: 채널 팩의 intent 목록과 설명을 `choice` 질문 하나로, 위협·폭언 여부를 `noul` 질문 하나로 보낸다. 지식베이스는 넣지 않는다.
- 두 호출은 한 건씩 차례로 부른다. 시간은 요청을 보내고 응답을 받을 때까지다.
- 다시 돌리기: `node --env-file=.env --no-warnings=ExperimentalWarning scripts/decision-compare.js`. 결과는 `../eval-out/decision/`에 쓴다.

## 결과 (2026-11-16)

정확도는 첫 단계에 기대 intent가 있는 113건으로 쟀다. 나머지 15건은 사전 필터가 먼저 처리하는 시나리오라 intent를 채점하지 않는다.

| | 접수 Agent (Sonnet) | 결정 모델 |
|---|---|---|
| intent 정확도 (113건) | 0.982 | 0.982 |
| 시간 p50 | 2,621ms | 555ms |
| 시간 p95 | 4,092ms | 753ms |
| 입력 토큰 평균 | 약 4,900 | 543 |

- 틀린 건은 두 모델 모두 2건이지만 겹치지 않는다.
  - 결정 모델이 틀린 건: 「unclear」 2건을 complaint와 feature_howto로 골랐다. 확신도는 각각 0.47과 0.55였다.
  - 접수 Agent가 틀린 건: cancel_subscription을 unclear로, purchase_intent를 contract_documents로 골랐다.
- 결정 모델의 확신도가 0.9 이상인 건은 94건이고, 모두 맞았다.
- 위협 판단은 둘이 다르다.
  - 결정 모델은 법적 대응을 예고한 2건(`sal-legal-a-01`, `sup-legal-c-01`)을 위협으로 봤다.
  - 접수 Agent는 128건 모두 위협이 아니라고 봤다.
  - 법적 위협은 사전 필터가 먼저 사람 처리로 넘기므로, 지금 흐름에서는 결과가 바뀌지 않는다.

## 해석과 한계

- 결정 모델은 intent 하나만 고른다. 접수 Agent는 intent 말고도 다음 값을 함께 낸다. 게이트1이 이 값들을 쓰므로, 결정 모델만으로 접수 Agent를 대신할 수는 없다.
  - `kbHit`과 `kbSections`
  - `handoffReason`
  - `confidence`
  - 요약
  - 감정 신호
- 그래서 바로 쓸 수 있는 방안은 둘이다.
  1. 결정 모델의 확신도가 0.9 이상이고 그 intent가 사람 처리(H) 등급이면, 접수 Agent를 부르지 않고 바로 넘긴다.
  2. 결정 모델의 intent를 접수 Agent에 힌트로 준다. 그래도 접수 Agent 호출은 남으므로 시간은 줄지 않는다.
- 이번 실험은 첫 메일만 봤다. 스레드 이력이 있는 후속 메일은 따로 재야 한다.
- 각 건을 한 번씩만 돌렸다.
