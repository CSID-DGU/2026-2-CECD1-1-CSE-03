# 아키텍처 — 범용 CS 응대 에이전트 + 휴먼인더루프

계약(이름·상태값·API)은 [`spec.md`](spec.md)가 정본이다. 이 문서는 **왜 이렇게 생겼는지**와 **어느 코드가 그것을 지키는지**를 적는다. 코드 위치는 `파일 함수` 로 적는다(줄 번호는 바뀐다).

다이어그램(브라우저로 열면 됨, 오프라인 단일 파일):

| 파일 | 내용 |
|---|---|
| [`diagrams/cs-agent-e2e.html`](diagrams/cs-agent-e2e.html) | E2E — 수신 창구 → 코드 게이트·LLM 에이전트 → 승인 큐·넘김 → 담당자 → 발송. 설명은 [`e2e.md`](e2e.md) |
| [`diagrams/cs-agent-architecture.html`](diagrams/cs-agent-architecture.html) | 현재 아키텍처 — IMAP 수신 어댑터 → 서버 → SMTP 메일 왕복, 판단·기록, 백오피스 승인 |
| [`diagrams/cs-agent-loop.html`](diagrams/cs-agent-loop.html) | 한 회차 루프 — 코드 lane · 네 페르소나(에이전트) lane · HITL lane, 넘김 분기 · L2 자동 발송 · 접수 안내 |
| [`diagrams/cs-agent-system.html`](diagrams/cs-agent-system.html) | 시스템 구성 — 공통 코어와 LOCAL / DEPLOYED 어댑터 |
| [`diagrams/cs-agent-case-lifecycle.html`](diagrams/cs-agent-case-lifecycle.html) | 케이스 상태 전이 |
| [`diagrams/cs-agent-draft-lifecycle.html`](diagrams/cs-agent-draft-lifecycle.html) | 초안(draft) 상태 전이 |
| [`diagrams/cs-agent-data-model.html`](diagrams/cs-agent-data-model.html) | 데이터 모델 (테이블·관계·멱등 키) |

같은 이름의 `.json`이 원본 명세다. 고치려면 json을 고쳐 다시 렌더한다(`archify deliver`).

## 1. 한 문장

고객 문의 1건 = **케이스** 1개. 메시지가 올 때마다 코드가 네 에이전트를 순서대로 불러 **초안 또는 넘김**을 만든다. 발송은 **사람 승인 뒤**(L1) 또는 **정책 팩이 L2 로 지정한 intent 만 같은 발송 경로로 자동**(L2, 2026-10-27~)이고, 넘김에는 사실 없는 **접수 안내**가 한 번 나간다. 단일 Node 프로세스, 의존성 0, SQLite. 지원 언어는 **한국어(ko)와 영어(en)** 뿐이고, 채널 정책 팩 `languages` 에 없는 언어는 사람에게 넘긴다.

## 2. 네 페르소나

LLM 호출은 네 종류뿐이고 각각 역할이 다르다. 페르소나 원문은 `server/agents/personas.md`, 각 에이전트 파일(`server/agents/*.js run`)이 그대로 읽는다.

| 에이전트 | 페르소나 | 입력 | 출력 | 절대 안 하는 것 |
|---|---|---|---|---|
| **접수 Agent(Triage)** `server/agents/triage.js` | 냉정한 접수 담당자. 과잉 해석 않음. 사람 신호 탐지가 1순위 | 최근 메시지 · known_facts · 채널 KB 절 목록 | `TriageResult` — intent · confidence · kbHit(true/partial/false) · riskSignals · language(ko/en) · questionSummary · handoffTopic | 답장 작성, 추측 |
| **답장 Agent(Responder)** `server/agents/responder.js` | 채널 정책 팩의 `persona`. 존댓말, 짧은 문장, 과장 없음 | TriageResult · KB 절 본문(고객 언어 KB, 영어는 `kb/<channel>.en.md`) · known_facts · 스레드 | `ResponderResult` — body(본문만) · usedFacts · humanCommitments · needsHandoff | 금액·날짜·결과 약속, KB 밖 사실, 사람인 척, 인사·서명(코드가 붙임) |
| **검수 Agent(Reviewer)** `server/agents/reviewer.js` | 의심 많은 선임. "떨어뜨리는 쪽이 안전" | body · usedFacts 절 본문 · questionSummary · humanCommitments | `ReviewResult` — pass · reasons[{code, quote}] (7항목) | 본문 수정 |
| **인계 Agent(Briefer)** `server/agents/briefer.js` | 인수인계 잘하는 동료 | 스레드 · TriageResult · 넘김 사유 | `Briefing` — summary · request · knownFacts · recommendedReply · nextAction | 고객에게 직접 말하기 |

검수 Agent 7항목 코드: `unsupported_claim` `forbidden_content` `not_answered` `commitment_touched` `tone` `no_bridge` `reasked_known`.
LLM 을 못 쓰는 넘김(장애·내부 예외·폐기)은 인계 Agent 대신 코드 브리핑(`briefer.fallback`)을 쓴다.

## 3. 한 회차 (`server/loop.js runCycle` → `cycle` → `execute`)

```
① claim      cases.claim('loop:<case>:<msg>') — 실패면 이미 처리됨, 종료
   lease      조건부 UPDATE 한 번(lease_until 비었거나 만료)으로 리스 + lease_token. 못 잡으면 loops.queue 에 줄 세움
   stale      이 메시지보다 먼저 온 메시지에 답한 PENDING 초안 → STALE (판단 결과와 무관하게 먼저)
   responder  cases.responder='human' 이면 기록만 하고 HANDED_OFF 로 표시(고객 재문의) — 넘김 뒤 침묵
② context    최근 6개 messages(+ 이미 나간 답장) · known_facts · 채널 KB · 최근 gate 판단 3개 · 사람이 쓴/고친 발신
             LLM 에 가는 고객 유래 텍스트(현재 메시지·이력·폼 값·직전 답 요지)는 guard.maskPii 로 가린다(ASCII 토큰),
             현재 메시지는 4,000자에서 자르고 [TRUNCATED]. 원문(rawMessage)은 1차 거르기·접수 안내 언어 판정에만
③ prefilter  server/prefilter.js check(원문) — 자동응답 표시(헤더·제목 머리·짧은 본문) → IGNORE / 사내 도메인 → IGNORE
             발신자 인증 실패(sender_auth=fail) → HANDOFF sender_unverified(브리핑도 코드 — LLM 호출 0)
             답할 주소를 못 뽑은 폼 메일 → HANDOFF unclear
             인젝션·사람 연결·통화·서류·법적 위협 → HANDOFF (그 사유가 채널 팩 handoffReasons 에 있을 때만)
             통과도 PASS 행으로 기록
④ triage     접수 Agent
⑤ gate1      server/policy.js decide → IGNORE | HANDOFF | COMPOSE  (+ rule 번호 · inputs, senderTrusted 아니면 autoSend 거짓)
⑥ respond    답장 Agent — needsHandoff 거나 본문이 비면 바로 HANDOFF
               └ 이 케이스에서 같은 intent 로 이미 보낸 답과 0.85 이상 비슷하면 본문을 버리고 HANDOFF(no_progress). 재작성 때 걸리면 guard_failed
⑦ guard      server/guard.js check(코드). 위반 없을 때만 검수 Agent를 부른다
   rewrite    guard 위반 또는 검수 Agent fail → 걸린 구절을 붙여 1회 재작성 → 또 실패면 HANDOFF(guard_failed)
⑧ gate2      decide(guard 결과 포함) → SHADOW | DRAFT | ANSWER_AND_HANDOFF | HANDOFF
⑨ execute    케이스를 다시 읽는다 — CLOSED · responder=human · 이 메시지보다 새 수신이 있으면 ABORTED(case_changed), 결과를 쓰지 않음
               (단 새 수신이 IGNORE 로 끝났고 PENDING 초안이 없으면 초안을 그 새 수신에 걸어 만든다 — 늦게 성공한 재시도)
             DRAFT: drafts PENDING + AWAITING_APPROVAL. 반환 안 된 넘김이 남아 있으면 DRAFT 도 ANSWER_AND_HANDOFF 로
             ANSWER_AND_HANDOFF: 초안 + 브리핑, 승인·발송 뒤 HANDED_OFF
               └ 둘 다, gate2 inputs.autoSend(L2)면 기록 뒤 autoSend → approveDraft(by=agent:auto). 막히면 PENDING 그대로 + auto_send_failed
             HANDOFF: 브리핑 → handoffs + responder=human + HANDED_OFF
               └ 기록 뒤 sendAck — 팩 ackReply 접수 안내(ACK 초안 → sent_by=ack), 케이스당 한 번, injection·legal_threat·sender_changed 는 안 보냄
                 발신자를 믿을 수 없으면(policy.senderTrusted 거짓) 부르지 않는다
             SHADOW: drafts(SHADOW) 기록만 / IGNORE: 기록만
               └ 둘 다, 이번 메시지가 STALE 로 만든 초안이 있으면 그 본문을 새 PENDING 으로 복사(CARRY_OVER)
               └ 새 케이스의 첫 메시지가 IGNORE 면 CLOSED (그 뒤 회신은 같은 케이스를 다시 연다 — spec 부록 F.5)
               └ 거절(declined) 다음 ack 가 IGNORE 면 CLOSED (`declined_ack`) — 둘 다 고객 회신으로 다시 연 케이스(활동 `reopen`)면 안 닫는다(감사 인사뿐이면 재종결, 아니면 스위퍼 무응답 종결이 닫는다)
⑩ record     모든 단계를 decisions 에 (prompt·kb·policy 버전, 원문은 versions 표) + SSE agent.step. 리스 해제(토큰 일치 때만), 큐 drain
```

LLM 장애(`server/loop.js scheduleRetry`): `llm_error` 를 기록하고 케이스를 OPEN 으로 둔 채 2·5·10·30분 뒤 재시도(`loops.next_retry_at`, `server/sweeper.js tick` 이 돌림). 4번 재시도도 실패하면(5번째 실패) 코드 브리핑으로 HANDOFF. 재시도 표시는 그 메시지의 회차가 끝나거나 더 새 메시지의 회차가 그 메시지를 덮는 결과를 냈을 때만 지운다(`settleRetry`). 돌고 있는 회차의 claim 은 재시도·복구·반환이 지우지 않는다(`releaseForRerun`, 프로세스 메모리 `inflight`). 회로 차단기(`server/llm/index.js`)가 연속 실패 때 호출을 멈춘다. 일일 토큰 예산(`LLM_DAILY_TOKEN_BUDGET`)을 다 쓰면 `server/agents/common.js call` 이 호출 없이 `llm_budget` 을 던지고, 재시도해도 오늘은 또 막히므로 바로 코드 브리핑으로 넘긴다. 호출마다 성공·실패 모두 `llm_calls` 에 한 행(토큰·지연·모델).
회차 바깥 예외(`server/loop.js failSafe`): 메시지가 묻히지 않게 `internal_error` 로 사람에게 넘긴다.
종결 뒤 회신(`server/cases.js addInbound`): 찾은 케이스가 CLOSED 면 같은 케이스를 OPEN 으로 다시 열고(이전 종결 사유는 활동 `reopen` 에) 회차를 돌린다. 응대 주체·담당자는 그대로다 — 에이전트 담당이면 평소 회차, 사람 전담이면 감사 인사여도 `responder_human` 으로 HANDED_OFF 가 되고 담당자에게 알림 한 통(`server/notify.js`). 자동 회신·빈 본문(`prefilter.isAutoReply`)은 다시 열지 않고 붙기만 한다 — 회차 시작이 종결 케이스를 열지 않으므로(`cases.setState`) 그 회차는 상태를 바꾸지 않는다. 에이전트 담당 케이스를 다시 연 뒤 감사 인사·자동 회신만 왔으면 회차 실행 기록 이벤트를 구독한 `server/cases.js recloseCourtesy` 가 답 없이 원래 종결 사유로 다시 닫는다(`courtesy_reply`, 회차가 어디서 돌았든). 파기된 케이스에는 회신이 붙지 않고 새 케이스가 된다. 계약은 spec 부록 F.5.

코드 guard 위반 코드: `empty` `too_long` `forbidden_word` `amount` `date_promise` `date` `contact` `link_not_in_kb` `unknown_fact` `fact_off_intent` `no_fact` `unresolved_slot` `emoji`(뜻은 `spec.md` §4). 승인 때는 렌더된 메일 전체(인사말에 들어간 고객 이름까지)도 검사한다(`server/loop.js agentViolations`).

**왜 분류와 작성을 나누나.** 분류가 "KB로 답할 수 있나(kbHit)"를 먼저 보고 kbHit=false 면 작성하지 않고 바로 넘긴다 — 써 놓고 검사에서 떨어지는 회차 낭비를 없앤다.
**왜 코드 guard 가 검수 Agent 앞인가.** 금액·날짜·미치환 슬롯처럼 정규식이 확실한 건 코드가 먼저 막고, 통과한 본문만 LLM 이 의미(근거·응답성)를 본다. 떨어질 게 확실한 본문에 LLM 호출을 쓰지 않는다.
**왜 재작성은 1회뿐인가.** 두 번 떨어지면 KB 밖 질문이거나 금지 영역이다. 사람에게 넘기는 게 맞다.

## 4. 정책 팩 — 코드 상한, 설정은 좁히기만

채널마다 `policy/<channel>.json` 하나. 루프 엔진은 채널을 모르고, 정책 팩이 채널을 정의한다. 팩은 시작할 때 `server/policy.js validate` 로 검사하고 잘못되면 서버가 뜨지 않는다.

| 필드 | 뜻 |
|---|---|
| `maxLevel` | 자율 등급 상한 (`L0` `L1` `L2` `H`). **팩 파일 = 코드 리뷰 대상** |
| `shadow` | true 면 L0. 실효값 = `pack.shadow` **또는** env `SHADOW_CHANNELS` 에 채널 이름 — env 는 섀도로 내리기만 한다(재빌드 없는 kill switch) |
| `languages` | 받는 언어(`ko` `en`). 밖이면 `language_unsupported` 로 넘김 |
| `persona` | 답장 Agent 어조 |
| `intents` | intent → `level`(L1 · L2 · H) + `kb`(답에 쓸 KB 절) + `reason`(H 등급의 기본 넘김 사유) |
| `handoffReasons` | 허용된 넘김 사유 목록. 모델이 다른 값을 적으면 `unclear` |
| `answerableHandoffReasons` | "다른 질문엔 답하고 그 신호만 넘겨도 되는" 사유. 기본값 `server/policy.js DEFAULT_ANSWERABLE` |
| `thresholds` | `confidenceMin`(0.8) `maxRounds`(10) `repeatLimit`(2) `maxLength`(600) |
| `guard` | `forbiddenWords` · `allowDates` · `allowAmounts` — 채널별 예외 |
| `ackReply` | 넘김 접수 안내 `{ko, en}` — 사실·날짜·약속 없는 고정 문구. 있을 때만 보낸다(`server/loop.js sendAck`) |
| `notify` | 알림 채널 이름(`server/notify.js` 가 웹훅 본문에 씀) |

**세 분류 — 고객 콘솔이 여기에 맞춘다**(`docs/spec.md` 부록 H). 고객이 콘솔에서 정책 팩을 고칠 때 항목마다 셋 중 하나다.

- **고객 편집:** 범위 안에서 자유롭게 바꾼다. 라벨, 페르소나, 언어, intent 이름과 설명, intent 가 쓰는 KB 절, 금지어, 날짜·수량 허용, 최대 길이, 접수 안내 문구, 알림 채널.
- **조이기만:** 코드 하한보다 엄격하게만 바꾼다. 신뢰도 하한은 올리고, 최대 라운드와 반복 한도는 내리고, 답할 수 있는 사유 목록은 줄인다.
- **코드 고정:** 바꿀 수 없다. 필수 넘김 사유와 시스템 사유, 예약 intent(`ack`·`ignore`·`injection`·`human_request`), 금액 허용(끔), 감사용 허용 목록 밖의 키.

자동 발송을 넓히는 변경(확대)은 §6 의 21번 게이트를 지난다. 하한을 어기는 팩은 게시되지 않는다.

**라이브 원문을 찾는 순서.** 대상(정책 팩, 채널 KB 언어별)마다 DB 의 가장 최근 `config_changes` 행이 가리키는 원문이 먼저다. 행이 없거나 기본값 복원 행이면 이미지 파일(`policy/`, `kb/`)을 쓴다. 원문이 깨졌으면 정책은 이미지 팩을 `maxLevel` H 로 돌리고, KB 는 빈 KB 로 닫는다. 그 채널은 사람이 맡는다(`docs/db.md` §1.4).

`server/policy.js decide` 는 `{action, reason, rule, inputs}` 를 돌려준다. `rule` 은 아래 번호, `inputs` 는 판단에 쓴 값(confidence·임계값·rounds·streak·riskSignals·language·shadow·guardPass·senderTrusted·autoSend)이고 decisions 와 대시보드 트레이스에 그대로 남는다.

| rule | 조건(첫 매치) | 결과 |
|---|---|---|
| 1 | intent `ignore` · `ack` | IGNORE |
| 2 | language 가 팩 `languages` 밖 | HANDOFF `language_unsupported` |
| 2 | intent 등급 H · 팩 maxLevel H · **riskSignals 에 refund·legal·complaint·injection** · handoffReason 이 있고 (kbHit=false 거나 답할 수 있는 사유 목록 밖) | **kbHit 와 무관하게 통째 HANDOFF** |
| 3 · 4 · 5 | 되묻기 ≥ repeatLimit · confidence < confidenceMin · 왕복 ≥ maxRounds | HANDOFF `no_progress` · `low_confidence` · `round_limit` |
| 6 · 7 | 팩에 없는 intent · kbHit=false | HANDOFF `unclear` · `out_of_knowledge` (작성 안 함) |
| 8 | guard 미평가(gate1) | COMPOSE |
| 9 | guard·검수 실패 | HANDOFF `guard_failed` |
| 10 | 실효 shadow · maxLevel L0 · intent L0 | SHADOW |
| 11 | quote_request · kbHit=partial · 답할 수 있는 handoffReason | ANSWER_AND_HANDOFF |
| 12 | 나머지 | DRAFT |

새 채널 추가 = 정책 팩 json 1개 + KB md 1개(영어도 받으면 `kb/<channel>.en.md`). 루프 코드는 손대지 않는다.

## 5. 자율 등급

| 등급 | 에이전트 | 사람 | 비고 |
|---|---|---|---|
| **L0 섀도** | 판단·초안을 기록만 (`drafts.status=SHADOW`) | 평소대로 응대. 섀도 초안에 good/needs_edit/critical 평가(`server/loop.js rateShadow`) | 모든 채널의 시작점 |
| **L1 승인** | 초안을 승인 큐에 | 승인 / 수정 후 승인 / 폐기 | L2 로 지정 안 된 intent 전부 |
| **L2 자동** | 초안을 같은 발송 경로로 바로 보냄(`approved_by=agent:auto`) | 막힌 초안만 승인 큐에서 처리. 대화는 평소처럼 인수 가능 | 팩 `maxLevel=L2` **그리고** intent `level=L2` **그리고** `AUTO_SEND≠0`. 지금 L2 intent: support 탈퇴·영수증·구독 해지, onboarding 온보딩 신청·미팅, sales 서비스 질문 |
| **H 사람 전용** | 브리핑 노트 + 접수 안내 한 통(L2 팩) | 직접 응대 | 환불·클레임·법적·데이터 반출 등 |

L2 는 2026-10-27 결정("L2 바로 켬", 목표 1차 응대율 ≥ 80%)으로 L0·L1 단계를 건너뛰고 켰다. intent 고르기는 실데이터 평가에서 `human_only` 라벨이 0건인 초안 intent(onboarding_request 는 같은 폼 본문의 라벨 충돌 1건, sales reviewing 은 사람 몫 1건이 자동 발송돼 L1 로 되돌림) — [`feasibility.md`](feasibility.md) 「L2 자동 발송 + 1차 응대 (2026-10-27 2차)」. 끄기는 `AUTO_SEND=0`(재빌드 없음).

1차 응대 지표는 `/api/stats.firstResponse`(`server/cases.js stats`) — 케이스 단위 완전 자동응대 · 사람에게 넘김(접수 안내·답장+넘김·승인 대기 초안) · 응대 못함. 자동 발송분과 접수 안내는 무수정 승인률·승격 지표에서 뺀다(사람이 본 적 없는 초안).

승격은 채널 단위다. 지표는 `/api/stats.promotion`(`server/cases.js promotion`)이 SENT 에이전트 초안 + 섀도 평가로 계산한다. 기준 상수 `server/policy.js PROMOTION` = 누적 50건 · 무수정 90% 이상 · 치명 0건. 롤아웃은 `deployment.md` §5.

## 6. 불변식 — 지키는 코드

| # | 불변식 | 지키는 곳 |
|---|---|---|
| 1 | **자동 발송은 L2 로 지정된 intent 만, 사람 승인과 같은 경로로.** 그 밖의 초안은 사람 승인 뒤에만 나간다. H intent · 위험·사람 신호(rule 2 — 평가 라벨 `human_only` 에 해당하는 것) · prefilter 넘김 · guard 실패에는 자동 발송이 없다(넘김엔 사실 없는 접수 안내만, 지시 변경 시도·법적 언급·보낸 사람 바뀜엔 그것도 없음). `AUTO_SEND=0` 이면 전부 꺼진다 | `server/policy.js decide` 의 `inputs.autoSend` = `autoAllowed(pack)`(kill switch·`maxLevel=L2`·섀도 아님) && intent `level=L2`. `server/loop.js execute` 는 결과가 DRAFT(규칙 12 — 사람 신호·부분 근거가 섞인 ANSWER_AND_HANDOFF 는 아님)일 때만 `autoSend`, `approveDraft` 가 보내는 순간 자격을 다시 본다 → `approveDraft(by='agent:auto')`(선점·재확인·guard 재검사·멱등키 그대로, 막히면 PENDING). `deliver` 를 부르는 곳은 `approveDraft` · `humanReply` · `sendAck`(팩 `ackReply` 고정 문구, `ACK_SKIP`, 케이스당 한 번) 셋뿐 |
| 2 | **KB 밖 사실 금지 · 금액·날짜·결과 약속 금지** | `server/guard.js check` (`unknown_fact` 로 usedFacts 실재 대조, amount·date_promise·unresolved_slot), 승인 때 `server/loop.js agentViolations` 가 렌더된 메일 전체를 다시 검사 |
| 3 | **중복 처리 0** | 수신 `server/cases.js addInbound`(`claims mailbox:<id>` 를 메시지 insert 와 같은 트랜잭션에서 + `messages.provider_message_id` UNIQUE), 회차 `server/loop.js runCycle`(`claims loop:<case>:<msg>` + 조건부 UPDATE 리스 + lease_token 일치 때만 해제), 발송 `drafts.idempotency_key`/`dispatches.idempotency_key` UNIQUE |
| 4 | **낡은 초안은 나가지 않는다** | `server/loop.js cycle` 시작에서 PENDING → STALE, `approveDraft` 가 SENDING 선점 뒤 새 수신(rowid 순서)·초안을 쓴 뒤 나간 답장(`drafts.seen_out_rowid`)·responder=human·guard 를 다시 확인(409 `stale` · 409 `already_answered` · 409 `responder_human` · 422 `guard`), 발송 중이면 사람 직접 답장도 409 `sending` |
| 5 | **회차 도중 바뀐 케이스엔 결과를 쓰지 않는다** | `server/loop.js execute` 가 쓰기 직전 케이스를 다시 읽어 CLOSED · responder=human · 새 수신이면 ABORTED `case_changed` |
| 6 | **넘김 뒤 침묵(접수 안내 한 통 뒤), 반환 시 즉시** | `server/loop.js cycle` 의 responder=human 분기(기록만), 접수 안내는 `sendAck` 가 케이스당 한 번이고 답으로 치지 않아(`ANSWER_OUT`) 반환 때 그 메시지는 미답, `returnToAgent` 가 마지막 미답 고객 메시지로 바로 1회전(그 회차가 이미 돌고 있으면 409 `busy`, 사람이 맡은 케이스가 아니면 409 `not_handed_off`) |
| 7 | **메시지가 조용히 묻히지 않는다** | `server/loop.js failSafe`(예외 → internal_error 넘김), `scheduleRetry`(LLM 장애 백오프), `recover`(기동 시 리스 해제·고착 SENDING 표시·미처리 메시지 재실행), `server/sweeper.js tick` |
| 8 | **고착 발송은 사람이 정리** | SENDING 이 2분을 넘으면 "발송 확인 필요"(`server/cases.js SEND_CHECK_MS`), `server/loop.js resolveSending` 으로 SENT 또는 PENDING. 발송이 진행 중이거나 승인 2분 안이면 409 `sending_in_progress` |
| 9 | **모든 판단에 버전, 버전에 원문** | `server/loop.js record` 가 prompt·kb·policy 해시를 decisions 에, `server/db.js saveVersion` 이 해시 → 원문을 `versions` 표에. `GET /api/versions/:hash` 로 조회 |
| 10 | **PII 는 판단 기록·SSE·LLM 근거에 안 옮긴다** | `server/guard.js maskContacts`(`server/loop.js record` 의 input_summary·output, `server/agents/triage.js normalize` 의 questionSummary·handoffTopic, `server/agents/briefer.js` 브리핑 필드), `server/cases.js sanitizeFacts`(known_facts 에서 연락처 제거) · `sanitizeName`(인사말 이름 정제), `server/notify.js` 는 채널·케이스 번호·사유만 |
| 11 | **승인자는 인증된 사람** | `server/index.js preflight` — production 은 `INBOUND_SECRET`·`AUTH_USER_HEADER`·`PROXY_SHARED_SECRET` 이 모두 없으면 시작하지 않는다. `AUTH_USER_HEADER` 가 있으면 웹훅·헬스체크를 뺀 `/api/*`(GET·SSE 포함)에서 그 헤더 없는 요청을 거부하고 `by` 를 헤더 값으로 덮어쓴다. `PROXY_SHARED_SECRET` 이 있으면 헤더 `x-proxy-secret` 도 요구(앱 포트 직결로 사용자 헤더를 위조하는 요청 차단). 웹훅은 `INBOUND_SECRET` 을 `crypto.timingSafeEqual` 로 비교. 운영 + mock 메일은 `ALLOW_MOCK_MAIL=1` 없으면 시작 거부 |
| 12 | **섀도 → 승인 순서**(L2 는 2026-10-27 결정으로 건너뜀 — §5) | 정책 팩 `shadow` + env `SHADOW_CHANNELS`(`server/policy.js load`), 승격 지표 `server/cases.js promotion` |
| 13 | **LLM 에는 가린 고객 텍스트만** | `server/loop.js cycle` 이 ctx 의 현재 메시지·이력·폼 값·직전 답 요지를 `server/guard.js maskPii` 로 가리고 4,000자 상한(`MAX_INPUT_CHARS`). KB·페르소나는 원문이라 근거 대조가 그대로다. 메모·섀도 평가 메모도 저장 때 가린다(`addNote`·`rateShadow`). 네 에이전트가 실제로 받은 `user` 문자열을 테스트가 spy 로 대조한다 |
| 14 | **인증 실패·폼 메일에는 자동 메일이 없다** | 수신 `server/cases.js addInbound`(`messages.sender_auth` — 시크릿으로 검증된 요청의 `pass`·`fail`만, 폼 추출은 `form`), `server/prefilter.js check`(`fail` → `sender_unverified`, 폼 미해결 → `unclear`), `server/policy.js senderTrusted`(`form`·폼 주소는 늘 거짓, 정보 없음은 `REQUIRE_SENDER_AUTH` 를 따름) → `decide` 의 `autoSend`·`execute` 의 접수 안내 호출 조건. 사람 승인 초안은 그대로 만든다 |
| 15 | **미러 모드에서는 어떤 메일도 나가지 않는다** | `server/index.js preflight` 와 `scripts/inbound-imap.js config` 가 둘 다 mock 메일 + `AUTO_SEND` 끔 + 그 채널 섀도를 요구(아니면 시작 거부), `server/index.js inbound` 는 그 조건이 아닌 `mirror: true` 페이로드를 저장 전에 503 |
| 16 | **파기 전후 지표가 같다** | `server/retention.js purge` — 종결·미파기를 트랜잭션 첫 문장에서 다시 확인, 본문·주소·자유 텍스트만 비우고 상태·intent·`edit_tags`·승인자·`final_body` NULL 여부는 남긴다(지우는 행은 `case_threads` 뿐). 파기된 케이스의 행동은 `server/index.js` 가 409 `purged` |
| 17 | **CRM 문서는 처리 테이블의 결정적 투영이다** | `server/crm.js`(순수 — `require`·현재 시각 없음)가 계산, `server/collections.js` 가 이벤트 문서만 수신 트랜잭션에서 넣고 나머지는 지연 flush 로 쓴다. 문서를 지워도 `resyncAll`(기동)이 처리 테이블에서 다시 만든다. §8 |
| 18 | **수신 본문의 사본은 파기가 같이 비운다** | `server/retention.js purge` 가 같은 트랜잭션에서 `collections.anonymizeCase` 를 불러 `inbound_events.rawPayload`·케이스·활동·문의자 문서를 비운다. §8 |
| 19 | **라이브 설정은 감사 행과 같은 트랜잭션에서만 바뀐다.** 게시·되돌리기·기본값 복원은 `versions` 행과 `config_changes` 행을 한 `db.tx` 에 쓴다. 이벤트와 접속기록은 커밋 뒤에 낸다 | `server/console.js` 게시 트랜잭션, `server/config-read.js` 원문 대조(sha256) |
| 20 | **LLM 변환은 사람이 게시하기 전에는 라이브가 되지 않는다.** 변환 결과는 `kb_drafts` 초안이고, 라이브에 넣는 길은 관리자의 게시 요청 하나뿐이다 | `server/convert.js` 는 DB 에 쓰지 않는다. 작업 흐름은 `server/console.js` 가 맡고 초안 행에만 쓴다 |
| 21 | **자동 발송을 넓히는 변경은 결과 집합 전체가 승격 기준을 통과해야 한다.** 게시·되돌리기·기본값 복원이 같은 게이트를 지난다. 막히면 화면이 막힌 intent 를 L1 로 내려 다시 보낸다 | `server/console.js gate`(`report.promotionByIntent`, `cases.promotion`) |
| 22 | **고객 설정 한 대상이 깨져도 그 채널만 사람에게 넘긴다.** 기동 뒤의 `policy.load`·`policy.all()` 은 던지지 않고 이미지 팩을 H 로 돌려 돌려준다. 수신 트랜잭션 안에서 불려도 다른 채널의 수신은 계속된다. 이미지 팩 자체가 하한을 어기면 기동 때 거부한다 | `server/policy.js load`(reader 결과 검사), `server/policy.js assertShipped` |

## 7. 왜 이 스택인가

- **의존성 0**: `node:http` · `node:sqlite` · `node:test` · `fetch` · `node:net/tls`(SMTP). 설치가 없으니 로컬·CI·컨테이너가 똑같이 돈다.
- **SQLite 파일 하나**: 케이스 규모(수천 건/월)에 충분. Postgres 로 옮길 때 무엇이 바뀌는지는 `db.md` §5.
- **바닐라 SPA + SSE**: 빌드 없음. 대시보드는 `/api/events` 를 구독해 에이전트 단계·초안·상태 변화를 실시간으로 본다.
- **LLM/메일은 provider**: 로컬은 `mock`(결정적, 테스트용), 배포는 `anthropic`/`smtp`. 루프 코드는 같다.

## 8. CRM 컬렉션 — 투영이 놓인 자리

CRM 화면은 처리 테이블이 아니라 **컬렉션 문서**(`documents` 테이블, 필드는 [`db.md`](db.md) §1.1)를 읽는다. 문서는 처리 테이블에서 계산한 투영이고, 루프 엔진(`server/loop.js`)은 문서를 쓰지 않는다.

```
수신 ─ addInbound 트랜잭션 ─┬─ cases · messages 쓰기
                            └─ inbound_events 문서 insert        (이 트랜잭션 안, 유일한 동기 쓰기)
루프·사람 명령·스위퍼 ─ 처리 테이블 쓰기 ─▶ 이벤트(events.emit) ─▶ dirty 집합에 케이스 id + setImmediate 예약
                                                                      │ (트랜잭션 밖)
                                              flush ─ 케이스마다 db.tx(syncCase) ─▶ 케이스·활동·문의자·고객사·이벤트 결과 칸
CRM 화면 ◀── GET /api/crm/cases[/:id] ── (읽기 전에 flush) ── documents
```

**왜 트랜잭션이 끝난 뒤에 쓰나.**
- 이벤트는 다른 모듈의 트랜잭션 안에서도 나온다. 구독자가 거기서 문서를 쓰면 그 트랜잭션에 쓰기와 실패 모드가 더해진다. 그래서 구독자는 dirty 표시와 flush 예약만 하고, `syncCase` 는 이벤트를 내지 않고 트랜잭션도 열지 않는다(flush 가 케이스마다 자기 트랜잭션을 연다).
- 문서는 처리 테이블에서 언제든 다시 계산되므로 원본과 한 트랜잭션에서 원자적으로 쓸 이유가 없다. 늦게 쓰면 뒤따르는 활동 행까지 본 뒤 상태와 귀속을 정하므로 더 정확하다.
- 이벤트 없이 끝나는 쓰기나 이벤트 뒤에 오는 쓰기(사람 명령의 활동 기록, 자동 종결, 감사 인사 회신의 재종결, 기동 복구)는 호출자가 dirty 로 표시한다. 읽기(목록·상세)는 먼저 flush 해서 따라잡는다.
- 수신 이벤트 문서만 예외로 수신 트랜잭션 안에서 넣는다. 원장이므로 메시지와 함께 들어가거나 함께 롤백돼야 한다.

**수신 메일 본문은 두 곳에 있다.** `messages.body`(처리 테이블)와 `inbound_events.rawPayload.body`(문서)다. 개인정보 사본이 하나 더 생긴 것이므로 보존 기간이 지난 파기와 정보주체 삭제는 둘 다 비운다(`server/retention.js purge` → `collections.anonymizeCase`, 같은 트랜잭션). 이벤트 문서의 `source.providerObjectId`(Message-ID)도 비우고, 유일 키 `dedupeKey` 의 Message-ID 자리는 해시로 바꾼다([`db.md`](db.md) §1.3). 정보주체 열람도 문서를 포함한다. 새 컬렉션이나 사본을 만들 때는 파기 경로도 같이 넓힌다.

**종결 뒤 회신은 같은 문서에 이어진다.** 회신은 처리 테이블의 같은 `cases` 행을 다시 열 뿐이라(spec 부록 F.5) 케이스 문서도 그대로 하나다. `statusHistory` 에 `Closed` 다음 줄이 붙고, `closeReason` 은 다시 닫힐 때까지 비며, 그 회신의 수신 이벤트 문서에 `matching.reasonCode=reopened_by_reply` 가 남는다. 다시 열지 않은 자동 회신은 이벤트·타임라인에만 더해지고 상태 이력은 그대로다. 케이스를 잇는 필드(`relatedCaseId`, 상세의 `relatedCases`)는 호환용으로 남았지만 채우는 경로가 없다. 파기된 케이스는 스레드 매핑과 메일 id 가 지워져 회신이 새 케이스 문서가 된다.

**대가.** 서버 기동이 전체 재동기화만큼 느려진다. `statusHistory` 는 flush 시점 표본이라 빠른 중간 상태가 합쳐질 수 있다(처리 테이블·`decisions` 에는 전부 남는다). 동기화 실패는 수신·파기를 막지 않고 `failures` 로 보이며, 다음 flush 가 다시 한다.
