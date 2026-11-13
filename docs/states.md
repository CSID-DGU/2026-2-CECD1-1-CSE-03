# 상태·코드 카탈로그

이 문서는 코드가 쓰는 열거값을 한곳에 모은 색인이다. 값마다 뜻과 그 값을 정하는 코드를 적고, 각 절 머리에 그 값이 나오는 다이어그램을 걸었다. 정본은 언제나 코드(`server/`)이며, 이 문서와 코드가 다르면 코드가 옳다. 다이어그램 목록은 [`diagrams/README.md`](diagrams/README.md)에 있다.

에이전트는 네 역할로 나뉜다. 접수 Agent(triage)는 문의를 분류하고, 답장 Agent(responder)는 답장 본문을 쓰며, 검수 Agent(reviewer)는 그 본문을 검사하고, 인계 Agent(briefer)는 사람 담당자에게 넘길 브리핑을 쓴다. 이하에서는 표시 이름만 쓰고, 코드 값이 필요한 표 칸에만 코드 이름을 둔다.

발송은 이 문서에서 하나의 단계(「발송」)로만 다룬다. 발송 단계 내부에서 쓰는 값은 이 카탈로그의 범위가 아니다.

---

## 1. 케이스 (`cases`)

다이어그램: [케이스 상태](diagrams/cs-agent-case-lifecycle.html) · [데이터 모델](diagrams/cs-agent-data-model.html)

케이스 하나는 문의 하나다. 상태(`state`)와 응대 주체(`responder`)는 따로 움직인다. 상태 전이는 모두 `cases.setState` 한 함수를 지나며, 승인 대기인데 대기 초안이 없으면 `cases.settle`이 쉬는 상태로 되돌린다.

### 1.1 `cases.state`

| 값 | 뜻 | 이 값을 쓰는 코드 |
|---|---|---|
| `OPEN` | 접수됐고 아직 답한 적이 없다(쉬는 상태). LLM 재시도를 기다리는 케이스도 여기에 있다. | `cases.addInbound`(새 케이스·종결 뒤 회신으로 재오픈), `loop.scheduleRetry`, `cases.restingState` |
| `AGENT_ACTIVE` | 에이전트 회차가 도는 중이다. 종결 케이스에는 쓰지 않는다. | `loop.cycle` 시작 |
| `AWAITING_APPROVAL` | 대기(`PENDING`) 초안이 있어 사람 승인을 기다린다. | `loop.execute`(DRAFT·ANSWER_AND_HANDOFF), `loop.carryOver`, `cases.restingState` |
| `WAITING_CUSTOMER` | 답장이 나갔고 고객 회신을 기다린다. | 발송 뒤 기록(에이전트 답장·사람 직접 답장), `cases.restingState` |
| `HANDED_OFF` | 사람이 맡았다. 이 동안 들어온 고객 메시지는 판단하지 않고 기록만 한다. | `loop.execute`(HANDOFF), `loop.failSafe`, `loop.discardDraft`, `loop.takeover`, 사람 전담 케이스의 회차, 답장+넘김 초안 발송 뒤 |
| `CLOSED` | 종결. 같은 케이스로 회신이 오면 다시 열린다. | `loop.closeCase`(사람 종결), `loop.execute`(자동 종결), `cases.recloseCourtesy`, `sweeper.autoClose` |

`cases.restingState`는 대기 초안이 있으면 `AWAITING_APPROVAL`, 나간 메일이 있으면 `WAITING_CUSTOMER`, 둘 다 없으면 `OPEN`을 고른다.

### 1.2 `cases.responder`와 `responder_change_reason`

| `responder` | 뜻 |
|---|---|
| `agent` | 에이전트가 응대한다. 새 케이스의 기본값이다. |
| `human` | 사람이 응대한다. 고객 메시지가 와도 회차는 `IGNORE`(`responder_human`)로 끝난다. |

`responder_change_reason`에는 담당이 바뀐 이유가 남는다. `cases.setResponder`가 쓴다.

| 값 | 뜻 | 쓰는 곳 |
|---|---|---|
| 넘김 사유 코드(§6) | 에이전트가 넘겼다. | `loop.execute`(HANDOFF) |
| `internal_error` | 회차 바깥 예외로 사람에게 넘겼다. | `loop.failSafe` |
| `answer_and_handoff` | 답장+넘김 초안이 나간 뒤 사람에게 넘어갔다. | 발송 뒤 기록 |
| `discard` | 담당자가 초안을 폐기했다. | `loop.discardDraft` |
| `takeover` | 담당자가 인수했다. | `loop.takeover` |
| `human_reply` | 담당자가 직접 답장했다. | `loop.humanReply` |
| `return` | 담당자가 에이전트에게 반환했다. | `loop.returnToAgent` |

### 1.3 `cases.close_reason`

사람 종결은 사유가 필수다(`crm.CLOSE_REASONS`, `server/index.js` `close`). `other`이면 상세(`close_detail`)도 필수다.

| 값 | 표시 라벨 | 뜻 |
|---|---|---|
| `resolved` | 해결됨 | 문의가 해결됐다. |
| `no_response` | 고객 무응답 | 고객이 더 답하지 않았다. |
| `duplicate` | 중복 | 다른 케이스와 같은 문의다. |
| `spam` | 스팸 | 응대 대상이 아닌 메일이다. |
| `not_applicable` | 응대 불필요 | 답할 필요가 없는 메일이다. |
| `other` | 기타 | 상세에 적은 이유다. |

자동 종결은 `close_reason`을 비워 두고, CRM 케이스 문서가 자동 종결 사유를 `closeReason`으로 옮긴다(§10.2).

### 1.4 보류 (`held_at`·`hold_note`)

보류는 사람 전담이고 종결되지 않은 케이스에만 걸 수 있다(`server/index.js` `hold`). 메모가 필수이며, 메모는 개인정보를 가린 뒤 500자로 자른다. 보류 중에는 자동 종결하지 않는다. 반환·종결하면 보류가 풀린다.

---

## 2. 회차 (`loops.state`)

다이어그램: [한 회차 루프](diagrams/cs-agent-loop.html)

| 값 | 뜻 | 쓰는 곳 |
|---|---|---|
| `IDLE` | 회차가 돌지 않는다. | 케이스 생성(`cases.addInbound`), 회차 종료, 반환(`loop.returnToAgent`) |
| `RUNNING` | 이 케이스의 회차가 도는 중이다. 이때 도착한 메시지는 `loops.queue`에 줄 선다. | `loop.runCycle` |
| `HANDED_OFF` | 사람에게 넘어갔다. | `loop.execute`(HANDOFF), `loop.failSafe`, `loop.discardDraft`, `loop.takeover`, 답장+넘김 초안 발송 뒤 |

LLM 장애 재시도는 `loops.next_retry_at`·`retry_count`·`retry_message_id`에 남고, Sweeper가 예정 시각에 다시 돌린다(2·5·10·30분).

---

## 3. 메시지 (`messages`)

다이어그램: [수신 경로](diagrams/cs-agent-intake.html) · [데이터 모델](diagrams/cs-agent-data-model.html)

| 칸 | 값 | 뜻 |
|---|---|---|
| `direction` | `in` · `out` | 고객이 보낸 메일 · 우리가 보낸 메일 |
| `sent_by`(out) | `agent` | 에이전트 초안이 승인·자동 발송으로 나갔다. |
| | `human` | 담당자가 직접 답장했다. |
| | `ack` | 넘김 접수 안내다. 답으로 치지 않는다. |
| `edited`(out) | `0` · `1` | `1`이면 사람이 고친 뒤 승인한 에이전트 초안이며, 그 안의 약속은 사람 약속으로 본다. |
| `sender_auth`(in) | `pass` · `fail` | 수신 어댑터가 넘긴 발신자 인증(DMARC) 결과다. `INBOUND_SECRET`으로 검증된 요청만 넘길 수 있다. |
| | `form` | 문의 폼 메일 본문에서 뽑은 주소다. 누구 주소든 넣을 수 있으므로 자동 메일을 보내지 않는다. |
| | `NULL` | 정보가 없다. |
| `auto_submitted`(in) | `0` · `1` | 수신 어댑터가 `Auto-Submitted`·`X-Autoreply`·`Precedence` 헤더로 표시한 자동 회신이다. |

---

## 4. 초안 (`drafts`)

다이어그램: [초안 상태](diagrams/cs-agent-draft-lifecycle.html)

### 4.1 `drafts.status`

| 값 | 뜻 | 쓰는 곳 |
|---|---|---|
| `PENDING` | 승인 큐에 있다. 담당자가 그대로 또는 고쳐서 승인한다. L2 초안은 기록 직후 `agent:auto`가 승인한다. | `loop.execute`(DRAFT·ANSWER_AND_HANDOFF), `loop.carryOver` |
| `SENT` | 발송이 끝났다. 나간 본문은 `messages`(out)에 있다. | 발송 뒤 기록 |
| `STALE` | 그 뒤에 고객 메시지가 또 와서 낡은 초안이다. | `loop.cycle` ①(이전 대기 초안), `loop.execute`(회차 도중 새 메시지가 오면 기록만) |
| `DISCARDED` | 담당자가 폐기했거나, 직접 답장·접수 안내가 발송되지 않았다. | `loop.discardDraft`, 직접 답장·접수 안내 경로 |
| `NOT_SELECTED` | 사람이 인수·직접 답장·종결해서 쓰이지 않았다. | `loop.takeover`·`loop.humanReply`·`loop.closeCase`(대기 초안 정리), `loop.execute`(회차 도중 종결·인수되면 기록만) |
| `SHADOW` | 섀도(L0) 초안이다. 승인 큐에 나오지 않고 평가만 받는다. | `loop.execute`(SHADOW) |
| `SUPERSEDED` | 스키마 주석에만 있는 예약값이다. 코드가 만들지 않는다. | — |

### 4.2 `drafts.action`

| 값 | 뜻 |
|---|---|
| `DRAFT` | 순수 답장 초안이다. L2 자동 발송은 이 종류만 탄다. |
| `ANSWER_AND_HANDOFF` | 답장과 함께 사람에게 넘긴다. 승인돼 나가면 사람 전담이 된다. |
| `SHADOW` | 섀도 초안이다. |
| `HUMAN_REPLY` | 담당자 직접 답장을 담은 행이다. |
| `ACK` | 넘김 접수 안내(팩 `ackReply` 고정 문구) 행이다. 케이스당 한 통이다. |

### 4.3 수정 사유 (`drafts.edit_tags`)와 섀도 평가

수정 승인 때 담당자가 고르는 사유다(`web/app.js` `EDIT_TAGS`). 승격 지표(`cases.promotion`)는 `critical`을 센다.

| 값 | 라벨 |
|---|---|
| `fact` | 사실오류 |
| `tone` | 어조 |
| `missing` | 누락 |
| `excess` | 과잉 |
| `policy` | 정책 |
| `critical` | 치명 오류 |

섀도 초안 평가(`activities.type = shadow_rating`, `loop.rateShadow`)는 `good`(좋음) · `needs_edit`(수정 필요) · `critical`(치명 오류) 셋 중 하나다. 승격 기준은 `policy.PROMOTION`(검토 50건 이상, 무수정 비율 0.9 이상, 치명 0건)이다.

---

## 5. 판단 기록 (`decisions`)

다이어그램: [한 회차 루프](diagrams/cs-agent-loop.html) · [E2E](diagrams/cs-agent-e2e.html)

모든 판단은 `loop.record`를 지나 한 행으로 남고, 같은 내용이 SSE `agent.step`으로 나간다. 행마다 `prompt_version`·`kb_version`·`policy_version` 해시가 붙는다(§13).

### 5.1 `step` · `agent` · `action`

| `step` | `agent` | `action` | `reason` |
|---|---|---|---|
| `prefilter` | `code` | `PASS` · `IGNORE` · `HANDOFF` | 1차 거르기 규칙 사유(§6.3). 통과도 `PASS`로 남긴다. |
| `retrieve` | `code` | `RAG` · `FALLBACK` | `KB_MODE=rag`일 때만, 접수 Agent 바로 앞. `RAG`는 사유 없음, `FALLBACK`은 폴백 사유(`kb_invalid` · `index_empty` · `embed_*` · `store_*` · `no_hits`) — 그 회차 접수 Agent는 KB 전체를 받는다 |
| `triage` | `triage` | `CLASSIFIED` | 분류된 intent |
| `gate1` | `code` | `COMPOSE` · `IGNORE` · `HANDOFF` | 판단 규칙 1–8의 사유(§6.4). 사람 전담 케이스는 `IGNORE`(`responder_human`) |
| `respond` | `responder` | `COMPOSE` · `REWRITE` | 없음. 검사에 떨어져 다시 쓰면 `REWRITE`(1회) |
| `guard` | `code` | `PASS` · `FAIL` | 실패 코드를 쉼표로 이은 값(§9.1) |
| `review` | `reviewer` | `PASS` · `FAIL` | 검수 코드(§9.2). guard를 통과한 본문만 받는다. |
| `gate2` | `code` | `HANDOFF` · `SHADOW` · `ANSWER_AND_HANDOFF` · `DRAFT` | 판단 규칙 9–12의 사유. 답장 Agent가 `needsHandoff`를 내면 규칙 번호 없이 `HANDOFF` |
| `brief` | `briefer` | `HANDOFF` | 넘김 사유. 인계 Agent 브리핑을 저장할 때 |
| `error` | `code` | `RETRY` · `HANDOFF` | `llm_error`(재시도 예약 또는 포기) · `internal_error`(회차 바깥 예외) |
| `execute` | `code` | `IGNORE` · `HANDOFF` · `DRAFT` · `ANSWER_AND_HANDOFF` · `SHADOW` · `CARRY_OVER` · `ABORTED` | 최종 action과 사유 |

스키마 주석(`server/schema.sql`)에는 `brief`와 `error`가 빠져 있으나 코드는 두 단계를 쓴다.

### 5.2 `execute`의 특수 값

| 값 | 뜻 |
|---|---|
| `CARRY_OVER` | 회차가 `IGNORE`·`SHADOW`로 끝났는데 아직 답하지 못한 `STALE` 초안이 있으면, 그 본문을 새 메시지 기준의 `PENDING`으로 다시 올린다(`loop.carryOver`). |
| `ABORTED` | 회차 도중 케이스가 종결·인수되었거나 고객이 또 썼다. 결과를 쓰지 않고 초안은 기록으로만 남긴다. 사유는 `case_changed`이고 출력의 `why`는 `closed` · `responder_human` · `newer_inbound` 중 하나다. |

---

## 6. 넘김 사유

다이어그램: [한 회차 루프](diagrams/cs-agent-loop.html) · [루프 개요](diagrams/cs-agent-overview.html)

넘김 사유는 채널 정책 팩(`policy/*.json`)의 `handoffReasons` 목록 안에서만 쓴다. 목록 밖의 값은 `policy.normalizeReason`이 `unclear`로 바꾼다. 넘기면 `handoffs` 행에 사유와 인계 Agent 브리핑(`summary` · `request` · `knownFacts` · `recommendedReply` · `nextAction`)이 남는다.

### 6.1 필수 사유 (`policy.REQUIRED_REASONS`)

모든 팩의 `handoffReasons`에 반드시 있어야 한다. 빠지면 팩 검증(`policy.validate`)이 시작을 막는다. 1차 거르기의 안전 규칙이 팩에서 조용히 꺼지지 않게 하기 위해서다.

`injection` · `legal_threat` · `human_request` · `sender_unverified`

### 6.2 위험 신호 → 사유 (`policy.RISK_REASON`)

접수 Agent가 `riskSignals`에 아래 신호를 하나라도 적으면 KB 근거와 무관하게 통째로 넘긴다(판단 규칙 2).

| 위험 신호 | 넘김 사유 |
|---|---|
| `refund` | `refund_request` |
| `legal` | `legal_threat` |
| `complaint` | `complaint` |
| `injection` | `injection` |

### 6.3 1차 거르기 규칙 (`server/prefilter.js`)

LLM 전에 코드가 위에서부터 첫 매치를 고른다. 규칙의 사유가 그 채널 팩의 `handoffReasons`에 없으면 그 규칙은 그 채널에서 돌지 않는다.

| 순서 | 결과 | 사유 | 조건 |
|---|---|---|---|
| 1 | IGNORE | `auto_reply_or_empty` | 빈 본문, 자동 회신 헤더, 제목이나 짧은 본문(200자 이하)의 자동 회신 표지 |
| 2 | IGNORE | `internal_sender` | 발신 도메인이 `INTERNAL_DOMAINS` |
| 3 | HANDOFF | `sender_unverified` | 발신자 인증 실패(`sender_auth = fail`). 팩·설정과 무관하며, 브리핑도 LLM 없이 코드가 쓴다. |
| 4 | HANDOFF | `unclear` | 문의 폼 메일인데 고객 주소를 뽑지 못했다. |
| 5 | HANDOFF | `sender_changed` | 같은 스레드에 케이스 주소와 다른 주소가 끼어들었다. |
| 6 | HANDOFF | `injection` | 지시 변경 시도 문장 |
| 7 | HANDOFF | `human_request` | 사람·담당자 연결 요청 문장 |
| 8 | HANDOFF | `call_meeting` | 통화·미팅 요청 문장 |
| 9 | HANDOFF | `contract_documents` | 계약서·사업자등록증 등 서류 요청 문장 |
| 10 | HANDOFF | `legal_threat` | 법적 언급 |
| 11 | HANDOFF | `refund_request` | 결제 취소·환급, 구독 중도 해지(규칙 2개) |
| 12 | HANDOFF | `billing_dispute` | 해지 뒤 결제, 계속 빠져나가는 결제(규칙 2개) |
| 13 | HANDOFF | `complaint` | 분석 결과로 피해를 봤다·내려 달라는 항의 |
| 14 | HANDOFF | `pricing` | 엔터프라이즈 요금·가격 불일치. 할인 요청은 support 채널에서만 돈다. |
| 15 | HANDOFF | `policy_exception` | 크레딧·쿼터·라이선스·권한·체험 계정 부여 요청 |
| 16 | HANDOFF | `list_request` | 크리에이터 리스트업 요청 |

### 6.4 판단 규칙이 붙이는 사유 (`policy.decide`)

판단은 두 번 돈다. 분류 뒤(guard 결과 없음)에는 규칙 1–8, 검사 뒤에는 9–12까지 본다. 위에서부터 처음 맞는 규칙을 쓴다.

| 규칙 | action | 사유 | 조건 |
|---|---|---|---|
| 1 | IGNORE | `ack` · `ignore` | intent가 감사 인사·무시 대상 |
| 2 | HANDOFF | `language_unsupported` 또는 모델·intent 사유 | 미지원 언어, H 등급 intent, 팩 `maxLevel = H`, 위험 신호, 답할 몫이 없는 사유 |
| 3 | HANDOFF | `no_progress` | 같은 질문 반복이 `repeatLimit`에 닿았다. |
| 4 | HANDOFF | `low_confidence` | 확신도가 `confidenceMin` 미만이다. |
| 5 | HANDOFF | `round_limit` | 에이전트 답장 횟수가 `maxRounds`에 닿았다. |
| 6 | HANDOFF | `unclear` | 팩에 없는 intent다. |
| 7 | HANDOFF | `out_of_knowledge` | KB에 답이 없다(`kbHit = false`). |
| 8 | COMPOSE | — | 답장 Agent가 쓴다. |
| 9 | HANDOFF | `guard_failed` | 재작성 뒤에도 guard·검수에 떨어졌다. |
| 10 | SHADOW | `shadow` | 섀도 채널, 팩 `maxLevel = L0`, 또는 L0 intent |
| 11 | ANSWER_AND_HANDOFF | `price_contract` · `out_of_knowledge` · 모델 사유 | 견적 문의, KB 일부만 맞음(`partial`), 답해도 되는 사람 신호 |
| 12 | DRAFT | — | 순수 답장 초안 |

답해도 되는 사람 신호의 기본값은 `policy.DEFAULT_ANSWERABLE`(`human_request` · `call_meeting` · `contract_documents` · `purchase_intent` · `out_of_knowledge` · `price_contract`) 중 그 팩의 `handoffReasons`에 있는 것이다. 팩의 `answerableHandoffReasons`가 있으면 그 값을 쓴다.

### 6.5 그 밖에 코드가 붙이는 사유

| 사유 | 붙는 곳 |
|---|---|
| `llm_error` | LLM 재시도 4회가 모두 실패했거나 일일 토큰 예산을 다 썼다(`loop.scheduleRetry`). 브리핑은 코드가 쓴다. |
| `internal_error` | 회차 바깥 예외(`loop.failSafe`) |
| `discarded` | 담당자가 초안을 폐기했다(`loop.discardDraft`). |
| `account_identity` · `data_export` · `custom_data` | 접수 Agent가 사람 신호로 적었거나 해당 H intent의 사유다. |
| `purchase_intent` · `price_contract` | 영업 채널의 H intent 사유이거나 답장+넘김 사유다. |

---

## 7. intent 등급

다이어그램: [루프 개요](diagrams/cs-agent-overview.html) · [한 회차 루프](diagrams/cs-agent-loop.html)

등급은 `policy.LEVELS`(`L0` · `L1` · `L2` · `H`)다. 팩의 `maxLevel`과 intent의 `level`이 함께 정한다. 환경 변수는 좁히기만 한다(`SHADOW_CHANNELS`는 섀도로 내리고, `AUTO_SEND=0`은 자동 발송을 끈다).

| 등급 | 뜻 |
|---|---|
| `L0` | 섀도. 초안을 기록·평가만 하고 고객에게 보내지 않는다. |
| `L1` | 초안을 만들고 사람이 승인해야 나간다. |
| `L2` | 승인 없이 자동 발송한다. 단, `AUTO_SEND`가 켜져 있고, 팩 `maxLevel`과 intent가 모두 L2이며, 섀도 채널이 아니고, 발신자를 신뢰할 수 있을 때만이다(`policy.autoAllowed` · `policy.senderTrusted`). 그 밖에는 L1처럼 승인 대기다. |
| `H` | 사람 전용. 판단 규칙 2가 바로 넘긴다. |

출하 팩의 L2 intent는 6개다. support는 `account_deletion` · `receipt` · `cancel_subscription`, onboarding은 `onboarding_request` · `meeting_request`, sales는 `service_question`이다. `ack`·`ignore`는 등급이 없고 규칙 1이 무시한다.

---

## 8. 접수 Agent 출력값

다이어그램: [한 회차 루프](diagrams/cs-agent-loop.html)

접수 Agent의 출력 스키마(`server/agents/triage.js`)에서 열거값을 갖는 칸이다.

| 칸 | 값 | 뜻 |
|---|---|---|
| `intent` | 팩의 intent 이름 | 분류 결과. 판단 기록 `triage` 행의 `reason`에 그대로 남는다. |
| `handoffReason` | 팩 `handoffReasons`의 값 또는 `null` | 사람 신호가 있을 때의 사유 |
| `kbHit` | `true` · `partial` · `false` | KB로 다 답할 수 있음 · 일부만 · 전혀 없음 |
| `riskSignals` | `refund` · `billing` · `legal` · `complaint` · `injection` · `pii` | 앞의 넷(refund·legal·complaint·injection)은 통째로 넘김(§6.2). `billing`·`legal`·`complaint`는 CRM 우선순위를 높인다. |
| `language` | `ko` · `en` | 팩 `languages`에 없으면 `language_unsupported`로 넘긴다. |
| `repeatsPrevious` | `true` · `false` | 이미 답한 질문을 다시 물었다. `loops.repeat_streak`를 올린다. |

---

## 9. 검사 실패 코드

다이어그램: [한 회차 루프](diagrams/cs-agent-loop.html)

### 9.1 guard 코드 (`server/guard.js` `check`)

| 코드 | 표시 라벨 | 뜻 |
|---|---|---|
| `empty` | 빈 본문 | 본문이 비었다. |
| `too_long` | 너무 김 | 팩 `maxLength`를 넘었다. |
| `forbidden_word` | 금지어 | 팩 `guard.forbiddenWords`·`forbiddenWordsEn` |
| `amount` | 금액 언급 | 금액·비율. 팩이 `allowAmounts`이면 검사하지 않는다. |
| `date_promise` | 날짜 약속 | 날짜·기한과 약속 동사가 함께 있다. 항상 검사한다. |
| `date` | 날짜 언급 | 날짜 사실. 팩 `allowDates`가 false인 채널만 검사한다. |
| `contact` | 연락처 노출 | 이메일·전화번호 |
| `link_not_in_kb` | KB에 없는 링크 | KB 본문에 없는 링크 |
| `unknown_fact` | 근거 없는 사실 | `usedFacts`에 KB에 없는 절이 있다. |
| `fact_off_intent` | 문의 유형 밖 근거 | 그 intent에 팩이 허용하지 않은 KB 절을 근거로 썼다. |
| `no_fact` | 근거 절 표시 없음 | 근거를 비운 채 사실을 말했다. |
| `unresolved_slot` | 자리표시 남음 | `{슬롯}` · `○○ 님` · `<이름>` 같은 미치환 자리표시 |
| `emoji` | 이모지 | 이모지(™·®·©는 제외) |

### 9.2 검수 Agent 코드 (`server/agents/reviewer.js`)

| 코드 | 뜻 |
|---|---|
| `unsupported_claim` | 근거 자료에 없는 사실 주장 |
| `forbidden_content` | 금액·날짜 약속·결과 약속·계약 조건·경쟁사 언급 |
| `not_answered` | 이번 메시지의 질문에 답하지 않았다. |
| `commitment_touched` | 사람 담당자가 한 약속을 다시 말하거나 바꿨다. |
| `tone` | 사람인 척, 반말, 과장, 고객 탓 |
| `no_bridge` | 범위 밖 요청에 대안 없이 거절만 했다. |
| `reasked_known` | 이미 아는 값을 되물었거나 빈 값을 둘 이상 물었다. |

guard나 검수에 떨어지면 답장 Agent가 한 번 다시 쓴다. 다시 떨어지면 판단 규칙 9(`guard_failed`)로 넘긴다.

---

## 10. 활동 (`activities`)

다이어그램: [케이스 상태](diagrams/cs-agent-case-lifecycle.html) · [수신 경로](diagrams/cs-agent-intake.html)

### 10.1 `activities.type`

사람·시스템 행동의 감사 로그다. `actor`는 담당자 표시 이름, `system`, `agent`, `agent:auto`(L2 자동 발송·접수 안내) 중 하나다.

| 값 | 표시 라벨 | 뜻 | 쓰는 곳 |
|---|---|---|---|
| `approve` | 초안 승인 | 담당자가 초안을 그대로 승인해 발송했다. | 발송 뒤 기록 |
| `edit_approve` | 초안 수정 후 승인 | 고쳐서 승인했다. `editTags`가 함께 남는다. | 발송 뒤 기록 |
| `auto_send` | 자동 발송 | L2 초안이 `agent:auto` 승인으로 나갔다. | 발송 뒤 기록 |
| `auto_ack` | 접수 안내 자동 발송 | 넘김 접수 안내가 나갔다. | 발송 뒤 기록 |
| `auto_send_failed` | 자동 발송 실패 | 자동 발송·접수 안내가 나가지 않았다. L2 초안은 승인 대기로 남는다. | `loop.autoSend` · `loop.sendAck` |
| `human_reply` | 담당자 직접 답장 | 담당자가 직접 쓴 답장이 나갔다. | 발송 뒤 기록 |
| `discard` | 초안 폐기 | 담당자가 초안을 버렸다. 케이스는 사람 전담이 된다. | `loop.discardDraft` |
| `takeover` | 담당자 인수 | 담당자가 케이스를 맡았다. | `loop.takeover` |
| `return` | 에이전트에게 반환 | 사람 전담 케이스를 에이전트에게 돌려줬다. 마지막 미답 메시지로 즉시 회차를 돈다. | `loop.returnToAgent` |
| `close` | 종결 | 담당자가 닫았다. | `loop.closeCase` |
| `reopen` | 재오픈 | 종결 케이스에 고객 회신이 와서 다시 열렸다. 이전 종결 사유를 payload에 남긴다. | `cases.addInbound` |
| `hold` · `unhold` | 보류 · 보류 해제 | 사람 전담 케이스를 보류하거나 푼다. | `server/index.js` |
| `note` | 메모 | 담당자 메모(개인정보를 가린 뒤 저장) | `loop.addNote` |
| `shadow_rating` | 섀도 초안 평가 | 섀도 초안 평가(§4.3) | `loop.rateShadow` |
| `auto_close` | 자동 종결 | 시스템이 닫았다(§10.2). | `loop.execute`, `cases.recloseCourtesy`, `sweeper.autoClose` |
| `purge` | 원문 파기 | 원문을 제자리 가명화했다(§10.3). | `retention.purge` |

### 10.2 자동 종결 사유 (`auto_close` payload `reason`)

| 사유 | 조건 | CRM `closeReason` |
|---|---|---|
| `ignored_first_message` | 첫 메시지가 자동 회신·감사 인사뿐이다. | `not_applicable` |
| `declined_ack` | 진행 거절(`declined`) 뒤 고객의 감사 인사 | `resolved` |
| `courtesy_reply` | 회신으로 다시 연 에이전트 케이스에 감사 인사·자동 회신만 왔다. 이전 종결 사유로 되돌린다. | `resolved` |
| `inactive` | `AUTO_CLOSE_DAYS`(기본 30일) 동안 조용했다. 승인 대기·보류 중인 케이스는 제외한다. | `no_response` |

### 10.3 파기 사유 (`purge` payload `reason`)

| 사유 | 뜻 |
|---|---|
| `retention` | 종결 뒤 `RETENTION_DAYS`가 지났다(Sweeper). |
| `subject_request` | 정보주체 요청(`scripts/subject-request.js`) |

파기는 행을 지우지 않고 본문·주소·이름·자유 텍스트를 비운다. 상태·행동·intent·수정 사유·승인자는 남으므로 지표가 파기 전후로 같다.

---

## 11. 표시 라벨 (`server/labels.js`)

다이어그램: [E2E](diagrams/cs-agent-e2e.html)

JSON 필드와 문서에는 코드를 그대로 두고, 사람이 읽는 문장(브리핑 요약 등)에서만 한국어 라벨로 옮긴다. 대시보드(`web/app.js` `LABELS`)에도 같은 표가 있으며, 두 표가 모든 팩의 intent·사유를 덮는지는 테스트가 확인한다.

| 표 | 내용 | 예 |
|---|---|---|
| `INTENT` | 세 채널 팩의 intent 전부 | `account_deletion` → 계정 탈퇴, `quote_request` → 견적 요청 |
| `REASON` | 넘김 사유 전부 | `out_of_knowledge` → KB에 없음, `sender_unverified` → 발신자 인증 실패 |
| `CRM.status` | CRM 상태 | `New` 신규 · `Working` 응대 중 · `On Hold` 보류 · `Escalated` 사람 전담 · `Closed` 종결 |
| `CRM.subStatus` | 세부 상태 | `Awaiting Approval` 승인 대기 · `Waiting on Customer` 고객 회신 대기 |
| `CRM.caseType` | 케이스 유형 | `Question` 질문 · `Problem` 문제 |
| `CRM.caseReason` | 케이스 사유 | `account` 계정 · `billing` 결제·요금 · `howto` 사용법 · `data` 데이터 · `onboarding` 온보딩 · `scheduling` 일정 · `sales` 영업 · `complaint` 불만 · `other` 기타 |
| `CRM.priority` | 우선순위 | `High` 높음 · `Medium` 보통 · `Low` 낮음 |
| `CRM.origin` | 유입 경로 | `Email` 이메일 · `Web` 웹 폼 |
| `CRM.closeReason` | 종결 사유 | §1.3 |

---

## 12. CRM 컬렉션 (`documents`)

다이어그램: [수신 경로](diagrams/cs-agent-intake.html) · [데이터 모델](diagrams/cs-agent-data-model.html) · [케이스 상태](diagrams/cs-agent-case-lifecycle.html)

CRM 화면은 CRM 표준형의 다섯 컬렉션을 읽는다. 문서는 `documents` 테이블에 `(collection, id)`로 저장한다.

**도출 규칙: 처리 테이블이 진실, 문서는 투영이다.** 문서는 처리 테이블(`cases` · `messages` · `drafts` · `decisions` · `handoffs` · `activities` · `loops`)에서 언제든 다시 계산된다(`server/crm.js`는 순수 함수다). 수신 이벤트 문서만 접수 트랜잭션 안에서 바로 쓰고(`collections.ingest`), 나머지는 트랜잭션이 끝난 뒤 지연 flush가 케이스 단위로 다시 계산한다(`collections.markDirty` → `flush` → `syncCase`). 내용이 같으면 쓰지 않으며, 바뀔 때만 `revision`이 1 오른다. 서버는 기동할 때 모든 케이스를 다시 계산한다(`collections.resyncAll`). 파기된 케이스의 문서는 같은 트랜잭션에서 비운다.

### 12.1 `inbound_events` — 수신 이벤트

수신 메시지 하나가 문서 하나다. `messages.event_id`가 문서 id다.

| 필드 | 값·뜻 |
|---|---|
| `sourceType` | `email_inbound`(새 케이스) · `email_reply`(기존 케이스) · `manual`(`local:` id) · `customer_support_form` · `onboarding_form` · `sales_inquiry_form`(폼 메일, 채널별) |
| `source` | `system`(`inbound_api` · `test`) · `accountId`(채널) · `providerObjectId` · `threadId` |
| `dedupeKey` | `<email|form|manual>:<채널>:<Message-ID 또는 msg:id>` — 유일 인덱스 |
| `rawPayload` | 수신 원값(from·name·subject·body·replyTo·inReplyTo·references·senderAuth·autoSubmitted·knownFacts) |
| `parsed` | `email`·`name`(접수 때), `language`·`intent`·`caseType`·`caseReason`·`riskSignals`(동기화 때 접수 Agent 결과에서) |
| `processing.status` | `pending`(아직 판단 전) · `succeeded`(실행 단계 기록 있음) · `retryable_error`(LLM 재시도 예약) · `terminal_error`(오류로 넘김) |
| `matching` | `method`: `new_case` · `thread` · `in_reply_to`. `status`: `resolved` · `not_applicable`(첫 메시지가 무시로 끝남). `reasonCode`: `reopened_by_reply` 또는 무시 사유 |
| `resolvedCaseId` · `resolvedContactId` · `resolvedCompanyId` | 연결된 케이스·문의자·고객사 |
| `privacy` | `classification`(`personal`) · `retentionUntil`(종결 시각 + 보존 기간) · `legalHold` |
| `lifecycleStatus` | `active` · `anonymized`(파기) |

### 12.2 `companies` — 고객사

케이스 주소의 업무 도메인에서 만든다. 공용 메일·문의 폼·사내 도메인이면 만들지 않는다(`crm.companyDomain`).

| 필드 | 값·뜻 |
|---|---|
| `primaryDomain` | 업무 도메인 — 유일 인덱스 |
| `canonicalName` · `normalizedName` | 폼 값 `회사`가 있으면 그 이름, 없으면 도메인 |
| `type` | `unknown` |
| `domains` | `[{value, status: observed}]` |
| `lifecycleStatus` | `active` |

### 12.3 `contacts` — 문의자

케이스 주소(소문자·trim)마다 하나다. 고객 주소를 뽑지 못한 폼 메일은 만들지 않는다.

| 필드 | 값·뜻 |
|---|---|
| `primaryEmail` | 주소 — 유일 인덱스 |
| `companyId` | 고객사 연결(없으면 `null`) |
| `type` | `person` |
| `emails` | `[{value, normalizedValue, kind: observed, verified: false, firstObservedAt, lastObservedAt}]` — 그 주소로 온 수신 메일 시각 |
| `current.name` | 케이스를 열 때 정한 이름. 더 새 관찰일 때만 바뀐다. 기본값 「고객」은 이름으로 보지 않는다. |
| `lifecycleStatus` | `active` · `anonymized`(그 주소의 마지막 케이스가 파기됨) |

### 12.4 `cases` — 케이스 문서

| 필드 | 값·뜻 |
|---|---|
| `caseNumber` | `cases.rowid`를 8자리로 채운 값 |
| `recordType` | 채널(`support` · `onboarding` · `sales`) |
| `origin` | 첫 이벤트가 폼이면 `Web`, 아니면 `Email` |
| `intent` · `caseType` · `caseReason` | 감사 인사·무시를 뺀 마지막 분류 intent와, 팩이 그 intent에 정한 유형·사유 |
| `status` · `subStatus` | 아래 상태 매핑 |
| `priority` | `High`: 마지막 넘김 사유가 `legal_threat` · `injection` · `billing_dispute` · `complaint` · `sender_unverified` · `sender_changed`이거나 위험 신호가 `legal` · `billing` · `complaint`. `Medium`: 넘김이 있거나 H intent이거나 승인 대기. 그 밖은 `Low` |
| `isClosed` · `isEscalated` | 종결 여부 · 넘김이나 담당 변경이 한 번이라도 있었는지 |
| `closeReason` · `closeDetail` | 사람 종결 사유, 또는 자동 종결 사유를 옮긴 값(§10.2). 종결이 아니면 `null` |
| `owner` | 에이전트 담당이면 `{type: agent}`, 사람 담당이면 `{type: user, id: 담당자}` |
| `hold` | `{note, since}` 또는 `null` |
| `resolution.outcome` | `auto_answered`(L2 자동 발송) · `answered_after_approval` · `answered_and_handed_off` · `human_answered` · `handed_off` · `shadow` · `ignored` · `null` |
| `resolution.handoffReason` · `nextAction` | 마지막 넘김 사유와 브리핑의 다음 행동 |
| `attribution` | 케이스를 만든 이벤트 id · 마지막 수신 이벤트 id |
| `statusHistory` | `(status, subStatus)`가 바뀔 때만 한 줄씩 붙는다. 변경 주체는 가장 최근 원천 행(사람·시스템 행동 → 담당 변경 → 넘김 → 실행 판단 → 수신 메일 순)에서 온다. |
| `lifecycleStatus` | `active` · `anonymized` |

상태 매핑(`crm.statusOf`)은 위에서부터 처음 맞는 행을 쓴다. 처리 테이블의 `state`·`responder`는 바꾸지 않는다.

| 처리 테이블 | `status` | `subStatus` |
|---|---|---|
| `state = CLOSED` | `Closed` | — |
| `responder = human`, 보류 중 | `On Hold` | — |
| `responder = human` | `Escalated` | `state = WAITING_CUSTOMER`이면 `Waiting on Customer` |
| `state = AWAITING_APPROVAL` | `Working` | `Awaiting Approval` |
| `state = WAITING_CUSTOMER` | `Working` | `Waiting on Customer` |
| `state = AGENT_ACTIVE` 또는 `HANDED_OFF` | `Working` | — |
| `state = OPEN`, 실행·오류 판단이 있음 | `Working` | — |
| `state = OPEN`, 판단 기록 없음 | `New` | — |

### 12.5 `activities` — 활동 문서

케이스의 메일(수신·발신), 사람·시스템 행동, 넘김을 시간순으로 다시 계산한다. 판단 트레이스는 넣지 않는다.

| 필드 | 값·뜻 |
|---|---|
| `id` · `dedupeKey` | `msg:<messages.id>` · `act:<activities.id>` · `handoff:<handoffs.id>` |
| `type` | `email` · `note`(메모·섀도 평가) · `status_change` |
| `direction` | `inbound` · `outbound` · `internal` |
| `subtype` | 메일은 `inbound` · `agent_reply` · `ack` · `human_reply`, 행동은 `activities.type`(§10.1), 넘김은 `handoff` |
| `summary` | `subtype`의 한국어 이름(`crm.js` `LABEL`) |
| `body` | 발신 메일 본문, 메모·평가·보류 메모. 수신 메일 본문은 이벤트 문서에 있다. |
| `meta` | `editTags` · `handoffReason` · `nextAction` |
| `actor` | `{type: system | agent | user, id}` |

---

## 13. 버전 (`versions`)

다이어그램: [데이터 모델](diagrams/cs-agent-data-model.html)

프롬프트 원본·KB 본문·정책 팩 원문을 해시(`hash`)로 한 번만 저장한다(`db.saveVersion`). 판단 행의 `*_version`으로 그때 쓴 원문을 되찾는다(`GET /api/versions/:hash`).

| `kind` | 원문 | 저장하는 곳 | 판단 행 칸 |
|---|---|---|---|
| `prompt:<agent>` | 페르소나 절 + system·user 템플릿 함수 소스 | `server/agents/common.js` `call` | `prompt_version` |
| `kb:<channel>:<lang>` | 채널·언어별 KB 본문 | `loop.cycle`(작성 단계의 영어 KB 포함) | `kb_version` |
| `policy:<channel>` | 정책 팩 JSON 원문(해시가 맞을 때만) | `loop.savePolicyVersion` | `policy_version` |

---

## 14. LLM 호출 계량 (`llm_calls`)

다이어그램: [데이터 모델](diagrams/cs-agent-data-model.html)

LLM 호출 한 번이 한 행이다. 성공·실패 모두 `server/agents/common.js` `call`이 남긴다. 본문은 넣지 않으며, 외래 키가 없어 파기와 무관하게 남는다. 일일 토큰 예산(`LLM_DAILY_TOKEN_BUDGET`)과 운영 리포트(`GET /api/report`)의 출처다.

| 칸 | 뜻 |
|---|---|
| `id` | 행 id |
| `case_id` · `message_id` | 호출한 회차의 케이스·메시지(외래 키 아님) |
| `agent` | `triage` · `responder` · `reviewer` · `briefer` |
| `provider` | `mock` · `anthropic` |
| `model` | 응답이 알려 준 모델 이름 |
| `input_tokens` | 입력 토큰(캐시 생성·읽기 포함) |
| `output_tokens` | 출력 토큰 |
| `latency_ms` | 호출 지연 |
| `ok` | `1` 성공 · `0` 실패 |
| `error` | 오류 코드나 HTTP 상태만(응답 본문은 넣지 않는다) |
| `created_at` | 호출 시각(UTC). 일일 예산은 UTC 날짜로 센다. |

---

## 15. 업무 대체율 분류

다이어그램: [한 회차 루프](diagrams/cs-agent-loop.html)

업무 대체율은 메시지마다 처리 주체를 하나 정해 센다(`server/report.js` `workload()`, `GET /api/report/workload`). 단위는 메시지 한 통이다. 고객이 보낸 메일 한 통이 1단위이고, 나간 답장 한 통이 1단위다(`messages.direction`). 내부 메모는 메시지가 아니므로 단위에 들지 않는다. 넘김 접수 안내(`sent_by = 'ack'`)는 답장이 아니므로 단위에서 빼고 `ackCount`로 따로 센다. 아직 `execute` 판단이 없는 수신 메시지도 단위에서 뺀다. 대기열에 있거나 회차가 도는 중이거나 LLM 재시도를 기다리는 메시지이고, `pendingCount`로 따로 센다. 판단이 끝나면 아래 표의 한 칸에 들어간다.

**업무 대체율 = 에이전트 처리 ÷ 전체 단위**이며, 보조율(에이전트 보조 ÷ 전체 단위)과 건수도 함께 낸다. 비율은 소수 셋째 자리까지이고, 단위가 0이면 `null`이다. 기간(`from` 이상 · `to` 미만, 경계는 UTC)은 `messages.occurred_at`, 채널은 `cases.channel`로 거른다. 분류는 아래 표의 위에서부터 처음 맞는 행을 쓴다.

| 값 | 이름 | 수신(`in`) | 발신(`out`) |
|---|---|---|---|
| `agent` | 에이전트 처리 | 그 메시지의 마지막 `execute` 판단이 `IGNORE`(사람 전담 케이스에 온 메시지의 `responder_human`은 제외)이거나, 그 메시지에 답한 `DRAFT` 초안이 `agent:auto` 승인으로 `SENT`(L2 자동 답변). 종결 케이스라 `execute`가 `ABORTED`로 멈췄어도 그 메시지의 마지막 `prefilter`·`gate1` 판단이 `IGNORE`(`responder_human` 제외)면 여기에 든다. 종결 케이스에 붙은 자동 회신이 그렇다 | `agent:auto`가 승인한 에이전트 초안(L2 자동 답변) |
| `assisted` | 에이전트 보조 | 그 메시지에 `triage` 판단이 있거나, 그 메시지에 답한 에이전트 초안(`ACK`·`HUMAN_REPLY` 제외)이 있음 | 사람이 그대로 또는 고쳐서 승인한 에이전트 초안 |
| `human` | 사람 처리 | 그 밖. 1차 거르기 규칙이 바로 넘긴 메시지(브리핑이 있어도), 분류 전에 사람이 맡은 케이스에 온 메시지 | 담당자가 직접 쓴 답장(`sent_by`가 `agent`가 아님) |

뒤 메시지가 와서 회차가 중단(`ABORTED`)된 메시지는 분류 판단이 있으면 보조로 센다. 그 답은 뒤 메시지의 회차가 냈기 때문이다.
