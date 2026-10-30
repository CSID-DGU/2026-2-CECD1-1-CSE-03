# 아키텍처 — 범용 CS 응대 에이전트 + 휴먼인더루프

계약(이름·상태값·API)은 [`spec.md`](spec.md)가 정본이다. 이 문서는 **왜 이렇게 생겼는지**와 **어느 코드가 그것을 지키는지**를 적는다. 코드 위치는 `파일 함수` 로 적는다(줄 번호는 바뀐다).

다이어그램(브라우저로 열면 됨, 오프라인 단일 파일):

| 파일 | 내용 |
|---|---|
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
| **Triage(분류)** `server/agents/triage.js` | 냉정한 접수 담당자. 과잉 해석 않음. 사람 신호 탐지가 1순위 | 최근 메시지 · known_facts · 채널 KB 절 목록 | `TriageResult` — intent · confidence · kbHit(true/partial/false) · riskSignals · language(ko/en) · questionSummary · handoffTopic | 답장 작성, 추측 |
| **Responder(응대)** `server/agents/responder.js` | 채널 정책 팩의 `persona`. 존댓말, 짧은 문장, 과장 없음 | TriageResult · KB 절 본문(고객 언어 KB, 영어는 `kb/<channel>.en.md`) · known_facts · 스레드 | `ResponderResult` — body(본문만) · usedFacts · humanCommitments · needsHandoff | 금액·날짜·결과 약속, KB 밖 사실, 사람인 척, 인사·서명(코드가 붙임) |
| **Reviewer(검수)** `server/agents/reviewer.js` | 의심 많은 선임. "떨어뜨리는 쪽이 안전" | body · usedFacts 절 본문 · questionSummary · humanCommitments | `ReviewResult` — pass · reasons[{code, quote}] (7항목) | 본문 수정 |
| **Briefer(브리핑)** `server/agents/briefer.js` | 인수인계 잘하는 동료 | 스레드 · TriageResult · 넘김 사유 | `Briefing` — summary · request · knownFacts · recommendedReply · nextAction | 고객에게 직접 말하기 |

Reviewer 7항목 코드: `unsupported_claim` `forbidden_content` `not_answered` `commitment_touched` `tone` `no_bridge` `reasked_known`.
LLM 을 못 쓰는 넘김(장애·내부 예외·폐기)은 Briefer 대신 코드 브리핑(`briefer.fallback`)을 쓴다.

## 3. 한 회차 (`server/loop.js runCycle` → `cycle` → `execute`)

```
① claim      cases.claim('loop:<case>:<msg>') — 실패면 이미 처리됨, 종료
   lease      조건부 UPDATE 한 번(lease_until 비었거나 만료)으로 리스 + lease_token. 못 잡으면 loops.queue 에 줄 세움
   stale      이 메시지보다 먼저 온 메시지에 답한 PENDING 초안 → STALE (판단 결과와 무관하게 먼저)
   responder  cases.responder='human' 이면 기록만 하고 HANDED_OFF 로 표시(고객 재문의) — 넘김 뒤 침묵
② context    최근 6개 messages(+ 이미 나간 답장) · known_facts · 채널 KB · 최근 gate 판단 3개 · 사람이 쓴/고친 발신
③ prefilter  server/prefilter.js check — 자동응답 표시(헤더·제목 머리·짧은 본문) → IGNORE / 사내 도메인 → IGNORE
             인젝션·사람 연결·통화·서류·법적 위협 → HANDOFF (그 사유가 채널 팩 handoffReasons 에 있을 때만)
             통과도 PASS 행으로 기록
④ triage     Triage 에이전트
⑤ gate1      server/policy.js decide → IGNORE | HANDOFF | COMPOSE  (+ rule 번호 · inputs)
⑥ respond    Responder 에이전트 — needsHandoff 거나 본문이 비면 바로 HANDOFF
⑦ guard      server/guard.js check(코드). 위반 없을 때만 Reviewer 를 부른다
   rewrite    guard 위반 또는 Reviewer fail → 걸린 구절을 붙여 1회 재작성 → 또 실패면 HANDOFF(guard_failed)
⑧ gate2      decide(guard 결과 포함) → SHADOW | DRAFT | ANSWER_AND_HANDOFF | HANDOFF
⑨ execute    케이스를 다시 읽는다 — CLOSED · responder=human · 이 메시지보다 새 수신이 있으면 ABORTED(case_changed), 결과를 쓰지 않음
               (단 새 수신이 IGNORE 로 끝났고 PENDING 초안이 없으면 초안을 그 새 수신에 걸어 만든다 — 늦게 성공한 재시도)
             DRAFT: drafts PENDING + AWAITING_APPROVAL. 반환 안 된 넘김이 남아 있으면 DRAFT 도 ANSWER_AND_HANDOFF 로
             ANSWER_AND_HANDOFF: 초안 + 브리핑, 승인·발송 뒤 HANDED_OFF
               └ 둘 다, gate2 inputs.autoSend(L2)면 기록 뒤 autoSend → approveDraft(by=agent:auto). 막히면 PENDING 그대로 + auto_send_failed
             HANDOFF: 브리핑 → handoffs + responder=human + HANDED_OFF
               └ 기록 뒤 sendAck — 팩 ackReply 접수 안내(ACK 초안 → sent_by=ack), 케이스당 한 번, injection·legal_threat·sender_changed 는 안 보냄
             SHADOW: drafts(SHADOW) 기록만 / IGNORE: 기록만
               └ 둘 다, 이번 메시지가 STALE 로 만든 초안이 있으면 그 본문을 새 PENDING 으로 복사(CARRY_OVER)
               └ 새 케이스의 첫 메시지가 IGNORE 면 CLOSED (다시 쓰면 같은 케이스 재오픈)
               └ 거절(declined) 다음 ack 가 IGNORE 면 CLOSED (`declined_ack`) — 둘 다 사람이 재오픈한 케이스면 안 닫는다
⑩ record     모든 단계를 decisions 에 (prompt·kb·policy 버전, 원문은 versions 표) + SSE agent.step. 리스 해제(토큰 일치 때만), 큐 drain
```

LLM 장애(`server/loop.js scheduleRetry`): `llm_error` 를 기록하고 케이스를 OPEN 으로 둔 채 2·5·10·30분 뒤 재시도(`loops.next_retry_at`, `server/sweeper.js tick` 이 돌림). 4번 재시도도 실패하면(5번째 실패) 코드 브리핑으로 HANDOFF. 재시도 표시는 그 메시지의 회차가 끝나거나 더 새 메시지의 회차가 그 메시지를 덮는 결과를 냈을 때만 지운다(`settleRetry`). 돌고 있는 회차의 claim 은 재시도·복구·반환이 지우지 않는다(`releaseForRerun`, 프로세스 메모리 `inflight`). 회로 차단기(`server/llm/index.js`)가 연속 실패 때 호출을 멈춘다.
회차 바깥 예외(`server/loop.js failSafe`): 메시지가 묻히지 않게 `internal_error` 로 사람에게 넘긴다.

코드 guard 위반 코드: `empty` `too_long` `forbidden_word` `amount` `date_promise` `date` `contact` `link_not_in_kb` `unknown_fact` `fact_off_intent` `no_fact` `unresolved_slot` `emoji`(뜻은 `spec.md` §4). 승인 때는 렌더된 메일 전체(인사말에 들어간 고객 이름까지)도 검사한다(`server/loop.js agentViolations`).

**왜 분류와 작성을 나누나.** 분류가 "KB로 답할 수 있나(kbHit)"를 먼저 보고 kbHit=false 면 작성하지 않고 바로 넘긴다 — 써 놓고 검사에서 떨어지는 회차 낭비를 없앤다.
**왜 코드 guard 가 Reviewer 앞인가.** 금액·날짜·미치환 슬롯처럼 정규식이 확실한 건 코드가 먼저 막고, 통과한 본문만 LLM 이 의미(근거·응답성)를 본다. 떨어질 게 확실한 본문에 LLM 호출을 쓰지 않는다.
**왜 재작성은 1회뿐인가.** 두 번 떨어지면 KB 밖 질문이거나 금지 영역이다. 사람에게 넘기는 게 맞다.

## 4. 정책 팩 — 코드 상한, 설정은 좁히기만

채널마다 `policy/<channel>.json` 하나. 루프 엔진은 채널을 모르고, 정책 팩이 채널을 정의한다. 팩은 시작할 때 `server/policy.js validate` 로 검사하고 잘못되면 서버가 뜨지 않는다.

| 필드 | 뜻 |
|---|---|
| `maxLevel` | 자율 등급 상한 (`L0` `L1` `L2` `H`). **팩 파일 = 코드 리뷰 대상** |
| `shadow` | true 면 L0. 실효값 = `pack.shadow` **또는** env `SHADOW_CHANNELS` 에 채널 이름 — env 는 섀도로 내리기만 한다(재빌드 없는 kill switch) |
| `languages` | 받는 언어(`ko` `en`). 밖이면 `language_unsupported` 로 넘김 |
| `persona` | Responder 어조 |
| `intents` | intent → `level`(L1 · L2 · H) + `kb`(답에 쓸 KB 절) + `reason`(H 등급의 기본 넘김 사유) |
| `handoffReasons` | 허용된 넘김 사유 목록. 모델이 다른 값을 적으면 `unclear` |
| `answerableHandoffReasons` | "다른 질문엔 답하고 그 신호만 넘겨도 되는" 사유. 기본값 `server/policy.js DEFAULT_ANSWERABLE` |
| `thresholds` | `confidenceMin`(0.8) `maxRounds`(10) `repeatLimit`(2) `maxLength`(600) |
| `guard` | `forbiddenWords` · `allowDates` · `allowAmounts` — 채널별 예외 |
| `ackReply` | 넘김 접수 안내 `{ko, en}` — 사실·날짜·약속 없는 고정 문구. 있을 때만 보낸다(`server/loop.js sendAck`) |
| `notify` | 알림 채널 이름(`server/notify.js` 가 웹훅 본문에 씀) |

`server/policy.js decide` 는 `{action, reason, rule, inputs}` 를 돌려준다. `rule` 은 아래 번호, `inputs` 는 판단에 쓴 값(confidence·임계값·rounds·streak·riskSignals·language·shadow·guardPass·autoSend)이고 decisions 와 대시보드 트레이스에 그대로 남는다.

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
| 11 | **승인자는 인증된 사람** | `server/index.js` — `AUTH_USER_HEADER` 가 있으면 웹훅·헬스체크를 뺀 `/api/*`(GET·SSE 포함)에서 그 헤더 없는 요청을 거부하고 `by` 를 헤더 값으로 덮어쓴다. `PROXY_SHARED_SECRET` 이 있으면 헤더 `x-proxy-secret` 도 요구(앱 포트 직결로 사용자 헤더를 위조하는 요청 차단). 웹훅은 `INBOUND_SECRET` 을 `crypto.timingSafeEqual` 로 비교. 운영 + mock 메일은 `ALLOW_MOCK_MAIL=1` 없으면 시작 거부 |
| 12 | **섀도 → 승인 순서**(L2 는 2026-10-27 결정으로 건너뜀 — §5) | 정책 팩 `shadow` + env `SHADOW_CHANNELS`(`server/policy.js load`), 승격 지표 `server/cases.js promotion` |

## 7. 왜 이 스택인가

- **의존성 0**: `node:http` · `node:sqlite` · `node:test` · `fetch` · `node:net/tls`(SMTP). 설치가 없으니 로컬·CI·컨테이너가 똑같이 돈다.
- **SQLite 파일 하나**: 케이스 규모(수천 건/월)에 충분. Postgres 로 옮길 때 무엇이 바뀌는지는 `db.md` §5.
- **바닐라 SPA + SSE**: 빌드 없음. 대시보드는 `/api/events` 를 구독해 에이전트 단계·초안·상태 변화를 실시간으로 본다.
- **LLM/메일은 provider**: 로컬은 `mock`(결정적, 테스트용), 배포는 `anthropic`/`smtp`. 루프 코드는 같다.
