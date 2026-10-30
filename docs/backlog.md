# 백로그 — Why · What · Acceptance (2026-10-24)

제품: 범용 CS 응대 에이전트 + 휴먼인더루프 백오피스. 계약서 `docs/spec.md`. 각 항목은 독립적으로 착수 가능하고 한 스프린트 안에 끝나는 크기다. 설계 참조는 `docs/diagrams/*.html`.

전략적 맥락: 반복 문의(탈퇴·영수증·해지·온보딩 안내)를 에이전트가 초안까지 만들고, 사람은 승인·수정만 한다. 환불·클레임·정책 예외는 사람에게 바로 간다. **에이전트는 제안하고 사람이 결정한다.** 2026-10-27 결정 변경: 정책 팩이 L2 로 지정한 intent 만 같은 발송 경로로 자동 발송하고 넘김엔 접수 안내를 보낸다(목표 1차 응대율 ≥ 80%, `AUTO_SEND=0` 으로 끔) — B16.

## 가능성 검토 요약

| 항목 | 판정 | 근거 · 위험 · 대응 |
|---|---|---|
| Node 22 내장 `node:sqlite` | 가능 | 실험 플래그지만 API 안정. 경고는 `--no-warnings=ExperimentalWarning`. 막히면 `better-sqlite3`로 1파일 교체 |
| 의존성 0 서버(`node:http` + SSE) | 가능 | SSE는 `text/event-stream` 스트림 유지 + 25초 ping. 프록시 뒤에선 버퍼링 해제 필요(배포 문서) |
| 결정적 mock LLM | 가능 | 20건 합성 문의에 키워드 규칙. 위험: 규칙 과적합 → 실제 품질 판단 불가. 대응: 같은 프롬프트를 쓰는 `anthropic` provider로 수동 스모크 |
| Claude API provider | 조건부 | `ANTHROPIC_API_KEY` 있어야 검증. CI는 mock만. JSON 출력 파싱 실패 1회 재시도 → `llm_error` 넘김 |
| 실제 메일 수신·발송 | 범위 밖(프로토) | 수신 = `POST /api/inbound` 웹훅 계약만. 발송 = `mock`. 배포 시 SMTP/Gmail 어댑터 1파일 |
| 멱등·동시성 | 가능 | `claims` PK insert, 케이스 리스 10분 + 큐, `drafts.idempotency_key` unique, PENDING→SENDING 선점 UPDATE. SQLite 단일 writer라 경쟁 단순 |
| 프레임워크 없는 대시보드 | 가능 | 위험: XSS → 서버 문자열은 전부 노드 생성·이스케이프. 오프라인 동작(CDN 없음) |
| archify 다이어그램 | 가능 | 도구가 지원하지 않는 형식(ERD)은 아키텍처형으로 대체 + `docs/db.md` Mermaid |
| 한국어 답변 품질 평가 | 보류 | mock으론 문체 평가 불가. 실제 provider + 평가셋 필요. 프로토는 행동(답/넘김/무시) 일치만 검증 |
| L0→L1 승격 지표 | 가능(기록만) | 무수정 승인률·치명 오류를 `activities`·`drafts`에서 계산. 판단 자동화는 물량 쌓인 뒤 |
| 일본어 등 추가 언어 | 제외 | `language`는 `ko`·`en`만. 그 외는 `unclear`로 사람 전담 |
| 가능성 검토 — 실데이터 | 조건부 | 내부 메일 표본 765건 로컬 mock 실행(`scripts/eval-real.js`). 수정 패스 2 뒤 `human_only` 넘김 재현율 60.6%→70.2%, 치명 누락(→DRAFT) 25→4건(평가셋 3→0), 보조율 66.9%→66.0%. L0 섀도(미러) 조건부 GO, L1 NO-GO(실제 LLM으로 평가셋 치명 0 확인 전) → `docs/feasibility.md` |

## 항목

### B1. 케이스 저장소와 멱등 claim

**Why:** 리드·주소가 아니라 "문의 하나 = 케이스 하나"로 상태·소유·이력을 묶어야 채널이 늘어도 루프가 같은 모양을 유지한다. 중복 수신·중복 판단은 여기서 막아야 뒤 단계가 단순해진다.

**What:** `server/schema.sql` §2 테이블 전부와 `server/db.js`, `server/cases.js`(케이스 생성, 스레드 매핑, 메시지 추가, 인용·서명 제거). `claims` insert 성공만 처리 권한으로 본다.

**Acceptance Criteria:**
- 같은 `providerMessageId`로 두 번 수신해도 메시지 1건, 루프 1회
- 같은 고객 주소의 새 스레드는 새 케이스로 생기고, 목록에 "같은 주소 열린 케이스 N"으로만 보인다
- 스레드 → 케이스 매핑: 수신 때 고객이 연 스레드 id를 그 케이스에 매핑하고, 발신 성공 때 provider가 돌려준 스레드 id(SMTP는 보낸 메일의 Message-ID)도 같은 케이스로 등록한다. 한 스레드 id는 케이스 하나
- 답장 메일에 `In-Reply-To`·`References`(고객 메일의 Message-ID)를 달고, 스레드 id를 모르는 고객 회신도 `In-Reply-To`·`References`가 받거나 보낸 메일을 가리키면 같은 케이스로 붙는다
- `:memory:` DB로 테스트가 돈다

### B2. 에이전트 루프 러너

**Why:** 한 회차의 순서(잠금 → 맥락 → 거르기 → 분류 → 판단 → 작성 → 검사 → 판단 → 실행 → 기록)가 코드로 고정돼야 채널별로 바뀌는 건 정책 팩뿐이 된다.

**What:** `server/loop.js` `runCycle(caseId, messageId)` §3. 케이스 리스 10분, 리스 중 도착한 메시지는 큐, 회차 시작 시 PENDING 초안 STALE, `responder=human`이면 판단 없이 기록만.

**Acceptance Criteria:**
- 리스 중 도착한 회신은 큐에 들어가고 리스 해제 후 순서대로 처리된다
- 고객 재회신 시 기존 PENDING 초안은 판단 결과와 무관하게 STALE이 된다
- 모든 단계가 `decisions`에 프롬프트·KB·정책 버전과 함께 남는다
- 사람 전담 케이스에선 LLM 호출이 0회다

### B3. 네 페르소나 에이전트와 LLM provider

**Why:** 분류·작성·검수·브리핑을 한 프롬프트에 섞으면 검사가 작성을 봐주고, 넘김 사유가 흐려진다. 역할을 나눠야 "누가 왜 그렇게 판단했나"를 대시보드에서 읽을 수 있다.

**What:** `server/agents/{triage,responder,reviewer,briefer}.js` + `personas.md` §3.2. `server/llm/{mock,anthropic}.js`, `llm.json()` 단일 인터페이스(temperature 0, JSON). 프롬프트 버전 = 내용 해시.

**Acceptance Criteria:**
- Triage는 답장을 쓰지 않고 `TriageResult` 스키마만 낸다; Responder는 본문만 쓰고 인사·서명은 코드가 붙인다
- `evidence`·`knownFacts`에 이메일·전화번호가 들어가지 않는다
- `LLM_PROVIDER=mock`으로 네트워크 없이 전체 루프가 돈다; `anthropic`은 같은 프롬프트로 호출된다
- LLM 오류·파싱 실패는 1회 재시도 후 `llm_error` 넘김으로 끝난다

### B4. 채널 정책 팩과 판단 함수

**Why:** 허용 범위를 코드 상수로 두고 설정은 좁히기만 허용해야, 운영 중 설정 실수로 자동화 범위가 넓어지는 사고를 구조적으로 막는다.

**What:** `policy/{support,onboarding,sales}.json` §4와 `server/policy.js` `decide()` 12규칙. 등급 L0/L1/H(2026-10-27 L2 추가 — B16).

**Acceptance Criteria:**
- 12규칙 각각에 단위 테스트가 있고 순서가 첫 매치다
- H 등급 intent가 섞인 문의는 통째로 HANDOFF다(부분 답 없음)
- `quote_request`·`kbHit=partial`은 ANSWER_AND_HANDOFF다
- `shadow=true`면 초안이 승인 큐에 보이지 않고 `SHADOW`로만 남는다

### B5. 코드 guard와 검수·재작성

**Why:** 실발송 사고 유형(금액·날짜 약속·미치환 슬롯·타 고객 정보)은 LLM 검수 전에 코드가 결정적으로 막아야 한다. LLM 검수는 그 위에서 근거·응답성·어조를 본다.

**What:** `server/guard.js` 위반 코드 10종 §4, Reviewer 7항목, 실패 시 걸린 구절 전부 붙여 1회 재작성, 또 실패면 `guard_failed` 넘김. 승인 시점에도 `final_body`에 guard 재검사.

**Acceptance Criteria:**
- 금액·날짜 약속·금지어·연락처·KB 밖 링크·`unknown_fact`·`{슬롯}`·이모지가 각각 걸린다
- 재작성은 정확히 1회이며 `REWRITE` 판단이 기록된다
- 사람이 수정한 본문에 `{고객명}` 같은 미치환 슬롯이 남으면 승인이 422로 막힌다
- 채널 guard 예외(`allowDates`)가 정책 팩으로 동작한다

### B6. 승인 큐와 발송 경로

**Why:** 발송은 이 시스템에서 유일하게 되돌릴 수 없는 행동이다. 사람 승인, 낡은 초안 차단, 두 번 눌러도 한 통이 보장돼야 L1을 열 수 있다.

**What:** `approveDraft` §3 — PENDING→SENDING 선점, STALE 재확인, responder 재확인, guard 재검사, `mail.send(idempotency_key)`, `dispatches`·`messages(out)` 기록. 수정 후 승인은 `original_body`·`final_body`·`edit_tags` 보존. 폐기.

**Acceptance Criteria:**
- 승인 중 새 고객 메시지가 있으면 409 `stale`이고 초안은 STALE로 남는다
- 같은 초안을 두 번 승인하면 두 번째는 409이고 발송은 1건이다
- 발송 실패 시 초안이 PENDING으로 돌아오고 오류가 기록된다
- 승인 후 케이스는 WAITING_CUSTOMER, ANSWER_AND_HANDOFF면 HANDED_OFF + responder=human

### B7. 인수 · 반환 · 직접 답장 · 종결

**Why:** 사람이 언제든 이어받고 다시 맡길 수 있어야 담당자가 에이전트를 신뢰한다. 반환 시 묻힌 고객 메시지가 없어야 한다.

**What:** `/takeover` `/return` `/human-reply` `/close` `/reopen` `/note` §5. 반환은 마지막 미답 고객 메시지를 큐에 넣어 즉시 1회전. 넘김 뒤 재문의는 알림 없이 목록 표시만.

**Acceptance Criteria:**
- 인수하면 PENDING 초안이 NOT_SELECTED가 되고 이후 승인은 409다
- 반환 직후 미답 메시지에 대한 판단이 1회 생긴다
- 사람이 직접 답하면 `messages(out, sent_by=human)`이 남고 상태가 WAITING_CUSTOMER가 된다
- 모든 사람 행동이 `activities`에 actor와 함께 남는다

### B8. REST + SSE API

**Why:** 대시보드와 시뮬레이터, 나중의 메일 웹훅이 같은 문을 쓴다. 실시간은 폴링이 아니라 서버 푸시여야 "에이전트가 돌아간다"가 보인다.

**What:** `server/index.js` §5 전체, `/api/events` SSE §5.1, `web/` 정적 서빙.

**Acceptance Criteria:**
- 20개 엔드포인트가 spec의 응답 모양을 지킨다(통합 테스트 1개 이상)
- SSE가 `agent.step`을 루프 단계마다 보내고 25초마다 ping을 보낸다
- 오류 응답이 `{error, ...}` JSON이고 상태 코드가 spec과 같다
- 서버 1프로세스, 외부 의존성 0

### B9. CRM 대시보드(휴먼인더루프)

**Why:** 담당자가 에이전트 대화와 판단 근거를 보고 승인·수정·인수까지 한 화면에서 끝내야 응답 지연이 실제로 줄어든다.

**What:** `web/` 3열 레이아웃 §(web 갈래 프롬프트): KPI·에이전트 상태, 필터·목록, 상세(타임라인 + agent trace + 브리핑 카드 + 승인 패널), 하단 라이브 피드(SSE), 테스트용 문의 주입.

**Acceptance Criteria:**
- 승인·수정 후 승인·폐기·인수·반환·직접 답장이 UI에서 되고 409/422가 사람 말로 보인다
- 루프 단계가 라이브 피드에 1초 안에 나타난다
- 서버 문자열이 HTML로 해석되지 않는다(스크립트 삽입 시도가 텍스트로 보인다)
- 외부 네트워크 없이 로드된다; 다크/라이트 모두 가독

### B10. 합성 목데이터 · 데모 · 시뮬레이터

**Why:** 실제 고객 메일은 쓸 수 없다. 기대 행동이 적힌 합성 세트가 있어야 루프 변경 때 회귀를 바로 안다.

**What:** `server/mock/inquiries.js` 20건 §6, `npm run demo`(표 출력·불일치 시 exit 1), `npm run sim`(N초마다 주입 + 후속 회신).

**Acceptance Criteria:**
- 20건 전부 기대 action·reason과 일치한다
- 데이터에 실제 인물·회사·주소가 없다
- `sim`이 돌면 대시보드 목록·KPI·피드가 사람 조작 없이 바뀐다
- 한국어 19건 + 영어 1건, 그 외 언어 없음

### B11. 자동 테스트

**Why:** 멱등·STALE·승인 경쟁은 손으로 재현하기 어렵다. 테스트가 없으면 다음 변경이 사고를 만든다.

**What:** `test/*.test.js` §7, `node:test`, 인메모리 DB.

**Acceptance Criteria:**
- `npm test`가 네트워크 없이 통과한다
- 정책 12규칙·guard 10코드·승인 경쟁 4경로·루프 20건이 커버된다
- 테스트 총 실행 10초 이내

### B12. archify 다이어그램 4종

**Why:** 팀과 심사자가 코드 없이 루프·페르소나·분류·상태·데이터 모델을 이해해야 한다.

**What:** `docs/diagrams/` — 루프 워크플로(페르소나 레인 + 분기), 시스템 아키텍처(로컬 vs 배포), 케이스·초안 상태 기계, 데이터 모델. 원본 json 동봉.

**Acceptance Criteria:**
- 단일 HTML, 오프라인, 다크/라이트
- 다이어그램 이름·상태·단계가 spec 용어와 일치한다
- 회사 고유 명칭이 없다

### B13. 문서 — 아키텍처 · DB · 배포

**Why:** 로컬과 배포의 차이(LLM·메일·DB·인증·시크릿)를 글로 고정해야 배포 때 안전장치를 빼먹지 않는다.

**What:** `docs/architecture.md` `docs/db.md` `docs/deployment.md`, 루트 `README.md` 빠른 시작.

**Acceptance Criteria:**
- 불변식 목록이 있고 각 항목이 코드 위치를 가리킨다
- SQLite→Postgres 전환 변경점이 적혀 있다
- 롤아웃 L0→L1 기준과 "일부러 안 만든 것"이 적혀 있다

### B14. 배포 패키징

**Why:** "실제 배포"가 목표다. 컨테이너 1개 + 영속 볼륨이면 소규모 운영에 충분하다.

**What:** `Dockerfile`(node:22-alpine, `HEALTHCHECK /api/health`), `.env.example`, 수신 웹훅 `INBOUND_SECRET` 검증, 발송 도메인 허용 목록.

**Acceptance Criteria:**
- `docker build && docker run -p 3000:3000 -v …:/app/data`로 대시보드가 뜬다
- `INBOUND_SECRET` 설정 시 헤더 없는 `POST /api/inbound`는 401
- 허용 목록이 비어 있으면 `smtp` provider는 전체 차단

### B15. 독립 리뷰 패스

**Why:** 작성자와 검수자는 같은 사람이면 안 된다. 승인 경로·멱등·XSS는 별도 리뷰어가 봐야 한다.

**What:** 정확성·보안 리뷰와 설계 대비 누락 리뷰를 작성자가 아닌 리뷰어가 한다 → 발견 사항 수정 → 테스트·데모·대시보드 재검증.

**Acceptance Criteria:**
- critical·major 발견 0 또는 전부 수정·기록
- 수정 후 `npm test`·`npm run demo` 통과, 대시보드 승인 왕복 재확인
- 리뷰 기록을 남긴다

### B16. L2 자동 발송 · 넘김 접수 안내 · 1차 응대율 (2026-10-27 추가)

**Why:** 목표가 "에이전트 1차 응대율 ≥ 80%"로 바뀌었다. 승인 대기만으로는 사람이 볼 때까지 고객이 아무 답도 받지 못하고, 넘김 문의는 담당자가 답할 때까지 침묵이다.

**What:** `server/policy.js` L2 등급(`inputs.autoSend`) + `AUTO_SEND` kill switch, `server/loop.js execute` → `autoSend`(승인과 같은 `approveDraft`, `by=agent:auto`) · `sendAck`(팩 `ackReply`, 케이스당 한 번), `ANSWER_OUT`(접수 안내는 답이 아님), `server/cases.js stats.firstResponse`, 대시보드 KPI. 계약은 `docs/spec.md` 부록 D.

**Acceptance Criteria:**
- L2 intent 는 승인 없이 SENT(`approved_by=agent:auto`, 활동 `auto_send`), L1 intent 는 승인 대기, H·prefilter 넘김은 자동 발송 없음
- 자동 발송이 막히거나 실패하면 초안이 PENDING 으로 남아 사람이 승인한다(`auto_send_failed`)
- 넘김엔 접수 안내 한 통(케이스 HANDED_OFF 그대로), 지시 변경 시도·법적 언급·보낸 사람 바뀜엔 없음, 반환 뒤 다시 넘겨도 두 번째는 없음
- `AUTO_SEND` 가 켜는 값(`1`·`true`·`on`·`yes`, 비면 켬)이 아니면 L2 intent 도 승인 대기, 접수 안내 없음. smtp + `INBOUND_SECRET` 없음이면 꺼짐. 섀도 채널엔 자동 발송·접수 안내 없음
- 자동 발송은 순수 답장(DRAFT)만, 같은 케이스 답장이 발송 중이면 409 `sending`, 자동 메일 제목의 링크·전화번호는 막힘
- 자동 발송분·접수 안내는 무수정 승인률·승격 지표에 안 들어가고, `firstResponse` 가 완전 자동응대 · 넘김 · 응대 못함으로 센다
- `test/l2-ack.test.js` 19건, `npm test` 171/171 (코드 리뷰 REQUEST_CHANGES 반영)

### B17. 문의 폼 경유 메일의 실제 고객 주소 (2026-10-27 추가)

**Why:** 실데이터 support 문의 중 최소 124건은 발신 도메인이 하나(문의 폼)이고 실제 고객 메일은 제목에 있다. 이대로 실발송하면 자동 답장·접수 안내·사람 승인 답장이 고객이 아니라 폼 발신 주소로 간다.

**What:** 수신 어댑터(`/api/inbound` 앞단)가 폼 메일이면 Reply-To 또는 폼 제목·본문 필드에서 고객 주소와 이름을 뽑아 `from` 으로 넘긴다. 폼 발신 도메인 목록은 설정으로 둔다.

**Acceptance Criteria:**
- 폼 발신 도메인의 메일은 추출한 고객 주소로 케이스가 열리고 답장이 그 주소로 나간다
- 추출 실패면 자동 발송·접수 안내 없이 넘김(사유 `unclear`)
- 자동 메일 제목 검사에서 뺀 이메일 주소 예외(`server/loop.js autoSubjectViolations`)를 다시 넣을 수 있다

