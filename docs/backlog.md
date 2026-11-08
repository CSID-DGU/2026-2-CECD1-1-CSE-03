# 백로그 — Why · What · Acceptance (2026-10-24)

제품: 범용 CS 응대 에이전트 + 휴먼인더루프 백오피스. 계약서 `docs/spec.md`. 각 항목은 독립적으로 착수 가능하고 한 스프린트 안에 끝나는 크기다. 설계 참조는 `docs/diagrams/*.html`.

전략적 맥락: 반복 문의(탈퇴·영수증·해지·온보딩 안내)를 에이전트가 초안까지 만들고, 사람은 승인·수정만 한다. 환불·클레임·정책 예외는 사람에게 바로 간다. **에이전트는 제안하고 사람이 결정한다.** 2026-10-27 결정 변경: 정책 팩이 L2 로 지정한 intent 만 같은 발송 경로로 자동 발송하고 넘김엔 접수 안내를 보낸다(목표 1차 응대율 ≥ 80%, `AUTO_SEND=0` 으로 끔) — B16. 2026-10-31: 실제 공유 메일함을 읽는 파일럿 전에 인증·개인정보·발송 통제·보존을 코드로 닫았다 — B18–B24, 계약은 `docs/spec.md` 부록 E. 2026-11-01: CRM 컬렉션·케이스 상태 5단계를 넣었다. 종결 뒤 회신은 같은 케이스를 다시 연다(처음 넣은 "새 연결 케이스" 방식은 철회) — B25, 계약은 부록 F.

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
- 접수 Agent(Triage)는 답장을 쓰지 않고 `TriageResult` 스키마만 낸다; 답장 Agent(Responder)는 본문만 쓰고 인사·서명은 코드가 붙인다
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

**What:** `server/guard.js` 위반 코드 10종 §4, 검수 Agent(Reviewer) 7항목, 실패 시 걸린 구절 전부 붙여 1회 재작성, 또 실패면 `guard_failed` 넘김. 승인 시점에도 `final_body`에 guard 재검사.

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

**What:** `/takeover` `/return` `/human-reply` `/close` `/note` §5(`/reopen` 은 B25 에서 라우트를 뺐다 — 종결 케이스는 고객 회신으로만 다시 열린다). 반환은 마지막 미답 고객 메시지를 큐에 넣어 즉시 1회전. 넘김 뒤 재문의는 알림 없이 목록 표시만(예외: 사람 전담 종결 케이스가 회신으로 다시 열리면 알림 한 통 — B25).

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
- `test/autosend.test.js` 19건, `npm test` 171/171 (코드 리뷰 REQUEST_CHANGES 반영)

### B17. 문의 폼 경유 메일의 실제 고객 주소 (2026-10-27 추가)

**Why:** 실데이터 support 문의 중 최소 124건은 발신 도메인이 하나(문의 폼)이고 실제 고객 메일은 제목에 있다. 이대로 실발송하면 자동 답장·접수 안내·사람 승인 답장이 고객이 아니라 폼 발신 주소로 간다.

**What:** 수신 어댑터(`/api/inbound` 앞단)가 폼 메일이면 Reply-To 또는 폼 제목·본문 필드에서 고객 주소와 이름을 뽑아 `from` 으로 넘긴다. 폼 발신 도메인 목록은 설정으로 둔다.

**Acceptance Criteria:**
- 폼 발신 도메인의 메일은 추출한 고객 주소로 케이스가 열리고 답장이 그 주소로 나간다
- 추출 실패면 자동 발송·접수 안내 없이 넘김(사유 `unclear`)
- 자동 메일 제목 검사에서 뺀 이메일 주소 예외(`server/loop.js autoSubjectViolations`)를 다시 넣을 수 있다

**상태(2026-10-31):** 어댑터가 아니라 서버(`server/cases.js addInbound`)에서 구현했다 — `FORM_SENDER_DOMAINS` 발신이면 Reply-To(페이로드 `replyTo`) → 제목의 주소 → 본문 이메일 칸 순으로 고객 주소를 뽑아 케이스 주소와 메시지 발신자로 쓴다. 뽑은 주소는 고객이 친 값이라 누구 주소든 넣을 수 있으므로 `sender_auth='form'`(늘 미신뢰)으로 두고, 자동 답장·접수 안내 없이 사람 승인 답장만 그 주소로 나간다(첫 AC 의 "답장"은 사람 승인 답장). 추출 실패 → `unclear` 넘김(두 번째 AC 충족). 세 번째 AC(제목 검사 예외 복원)는 보류 — 수신·판단 단계 밖이고, 폼 메일엔 자동 메일이 없어 아직 필요가 없다.

### B18. 발신자 인증 게이트 (2026-10-31 추가)

**Why:** 인증되지 않은 발신 주소로 회사 명의 자동 메일(L2 자동 발송·접수 안내)이 나가면 위조 메일 한 통으로 엉뚱한 사람에게 우리 메일이 간다(백스캐터). 위조 메일 본문을 외부 LLM 에 보낼 이유도 없다.

**What:** `messages.sender_auth`(`pass`·`fail`·`form`·NULL), 페이로드 `senderAuth`(시크릿으로 검증된 요청만), IMAP 어댑터 `IMAP_AUTHSERV_ID`(맨 위 `Authentication-Results` 의 DMARC), `server/prefilter.js` `sender_unverified`, `server/policy.js requireSenderAuth`·`senderTrusted`, `decide` 의 `inputs.senderTrusted`, `execute` 의 접수 안내 호출 조건, 기동 경고·`/api/status.senderAuth`.

**Acceptance Criteria:**
- `fail` → HANDED_OFF `sender_unverified`, LLM 호출 0(`llm_calls` 0행), 접수 안내 없음
- `REQUIRE_SENDER_AUTH` 켬 + 정보 없음 → L2 intent 도 승인 대기·넘김 접수 안내 없음, `pass` → 자동 발송, 끔 + 정보 없음 → 지금처럼
- 기본값 production 켬·그 밖 끔, `0`·`false`·`off`·`no` 는 끔, 그 밖의 값(오타 포함)은 켬
- 테스트 주입·시크릿 없는 요청의 `senderAuth` 는 버린다(저장값 NULL)
- 어댑터는 authserv-id 가 맞는 맨 위 헤더만 본다 — 아래에 붙은 위조 `dmarc=pass`·id 불일치는 무시, `mx.example.com 1;`·괄호 주석은 허용

### B19. LLM 입력 최소화 · 계량 · 예산 (2026-10-31 추가)

**Why:** 실제 LLM 은 국외 처리다. 고객 식별자가 프롬프트로 나가지 않아야 하고, 실평가·파일럿 규모를 정하려면 호출당 토큰·비용·지연과 하루 상한이 있어야 한다.

**What:** `server/guard.js maskPii`(ASCII 토큰), `server/loop.js cycle` 의 LLM 맥락 마스킹 + 4,000자 상한, 메모·섀도 평가 메모 마스킹, `llm_calls`, `server/agents/common.js call` 의 일일 토큰 예산(`LLM_DAILY_TOKEN_BUDGET`), `server/report.js llmUsage`.

**Acceptance Criteria:**
- 네 에이전트가 실제로 받은 `user` 문자열에 주민번호 세 형태·카드·계좌·여권·주문 번호·이메일·국내외 전화·서명 속 실명·외부 URL·도로명 주소의 원문이 없고, KB 본문·KB 링크는 그대로다
- 날짜·금액·버전·"말씀하신대로 2번"은 바뀌지 않고, 영어 메일은 영어로 판정된다(접수 안내도 영어)
- 토큰이 섞인 초안은 guard `unresolved_slot` 으로 넘어간다
- 호출마다(실패 포함) `llm_calls` 한 행, 예산을 다 쓰면 호출 없이 즉시 넘김(재시도 없음)
- 비용은 단가 env 둘이 있을 때만 계산한다

### B20. 원문 보존 기간 · 정보주체 요청 (2026-10-31 추가)

**Why:** 실고객 원문을 기한 없이 쌓을 수 없고, 열람·삭제 요구에 답해야 한다. 그러나 행을 지우면 FK 와 승격 지표(섀도 평가 증거)가 깨진다.

**What:** `cases.purged_at`, `server/retention.js`(제자리 가명화 — `purge`·`purgeExpired`·`findSubject`), 스위퍼의 `RETENTION_DAYS`, `scripts/subject-request.js` `export`·`delete`, 파기된 케이스 행동 409 `purged`, 파일 DB `busy_timeout`.

**Acceptance Criteria:**
- 파기 뒤 모든 테이블 텍스트 칼럼에서 본문·이름·주소·메모·섀도 평가 메모·폐기 사유·발송 오류의 표지가 0건
- `cases.stats()`·`cases.promotion()` 이 파기 전후 같고 `PRAGMA foreign_key_check` 가 비어 있다. 두 번 파기해도 그대로
- 종결이 아니면 파기하지 않는다(검사와 파기 사이 회신으로 다시 열린 케이스 포함). 파기된 케이스의 옛 스레드 회신은 새 케이스
- `RETENTION_DAYS` 가 비면 아무것도 안 지우고, 값이 있으면 기간이 지난 종결 케이스만
- 파기된 케이스의 케이스·초안 POST 는 409, 스크립트 `delete` 는 열린 케이스가 있으면 exit 1

### B21. 접속기록 (2026-10-31 추가)

**Why:** 누가 언제 고객 정보를 봤고 누가 보냈는지 남아야 한다. 인증 실패도 같이 봐야 우회 시도를 안다.

**What:** `server/accesslog.js`(JSONL 덧붙이기), DB 폴더 `access.jsonl`, HTTP 훅(목록·상세·섀도 목록·SSE·401), 발송은 이벤트 구독, 정보주체 스크립트.

**Acceptance Criteria:**
- `case.list`·`case.view`·`shadow.list`·`events.open`·`auth.fail`·`send`·`subject.*` 가 한 줄씩, 모든 줄에 `ip` 칸
- 검색어 원값·고객 본문·주소가 없다
- 기록 쓰기가 실패해도 승인 발송은 정상으로 끝난다
- `:memory:` DB 면 파일을 만들지 않는다(레포에 남지 않음). 회전·위변조 방지·외부 보관은 후속

### B22. intent 승격 리포트 · 섀도 평가 목록 (2026-10-31 추가)

**Why:** 섀도 파일럿은 사람이 섀도 초안을 평가해야 앞으로 간다. 승격은 채널보다 intent 단위로 봐야 어디부터 켤지 정할 수 있다.

**What:** `server/report.js promotionByIntent`·`promotionCsv`·`unratedShadow`, `GET /api/report`·`/api/report/promotion.csv`·`/api/shadow`, 대시보드 리포트 패널·"섀도 평가" 목록, 섀도 카드 문구("그대로 보내도 되는가").

**Acceptance Criteria:**
- 채널별로 합한 intent 표가 `cases.promotion` 과 같다
- CSV 의 `=`·`+`·`-`·`@`·TAB·CR 로 시작하는 칸에 `'` 접두
- 평가한 초안은 목록에서 빠지고, 파기된 케이스는 안 나온다. 셋 다 인증 대상
- 대시보드에 인라인 스타일·스크립트가 없다(CSP 위반 0)

### B23. 미러 모드 (2026-10-31 추가)

**Why:** 파일럿은 실제 공유 메일함을 읽기만 하며 섀도로 평가한다. 실고객 메일을 읽는 동안 우리 쪽에서 메일 한 통이라도 나가면 되돌릴 수 없다 — 런북 한 줄 실수에 맡길 수 없다.

**What:** `IMAP_MODE=mirror`(발신자 무관·우리 주소 제외·`EXAMINE`/`BODY.PEEK`·DB 폴더 `imap-state.json` 이어 읽기), 서버 시작 검사와 어댑터 `config()` 의 무발송 강제, `mirror: true` 페이로드 503, 같은 이미지로 어댑터 실행.

**Acceptance Criteria:**
- mock 메일·자동 발송 끔·섀도 채널 중 하나라도 없으면 서버와 어댑터 모두 시작 거부
- 조건이 아닌 서버에 온 미러 페이로드는 503 이고 케이스·메시지가 0행
- 재시작 뒤 중단 중 도착 메일을 넘기고, UIDVALIDITY 가 바뀌면 기준점부터
- 메일함을 바꾸는 명령(`SELECT`·`STORE`·`EXPUNGE`·PEEK 없는 `BODY[`)이 없다

### B24. 실평가 모드 (2026-10-31 추가)

**Why:** L1 을 켜려면 실제 LLM 으로 평가셋 치명 누락 0을 확인해야 한다(`docs/feasibility.md`). 실데이터를 국외 LLM 에 보내므로 승인·최소화·전송 대상 제한이 코드에 있어야 한다.

**What:** `scripts/eval-real.js --provider=anthropic --approved-by=<승인>` — 기본 Anthropic 오리진만, 평가셋 행만, 조립된 프롬프트 자기 점검(합성 식별자), `--name-col`(이름 가림), `--mask-terms`(레포 밖 단어 목록 → `[TERM]`), 행별 토큰·지연·모델 기록. 실행은 사용자.

**Acceptance Criteria:**
- `--approved-by` 없음·키 없음·`LLM_PROVIDER` 불일치·레포 안 단어 파일·기본값이 아닌 `ANTHROPIC_BASE_URL` → 각각 거부, 다른 오리진 fetch 거부
- 마스킹을 끈 구현으로는 자기 점검이 실패하고, `--name-col` 로 준 이름이 프롬프트에 없다
- mock 기본 경로는 그대로(네트워크 차단)
- 실행 전 승인 체크리스트: 데이터 소유자 서면 승인, 평가셋 60건 사람 라벨 검수, `--mask-terms` 단어 목록(회사명·주소 등), 국외 이전 근거, **이름 칸 유무 — `--name-col` 로 쓸 칸이 없으면 본문·서명 속 실명은 가려지지 않는다. 이 잔여 위험을 승인 문서에 적고 `--mask-terms` 로 보완한다**

### B25. CRM 컬렉션 · 케이스 상태 5단계 · 재문의 후속 (2026-11-01 추가)

**Why:** 컬렉션·상태 매핑·재문의 규칙은 들어갔지만(`docs/spec.md` 부록 F, `docs/db.md` §1.1–1.3) 파일럿 규모에서 일부러 단순하게 둔 곳과 결정을 미룬 곳이 있다. 규모가 커지거나 운영 데이터가 쌓이면 다시 본다.

**What (후속 작업):**
- **새 intent** `bug_report`·`feature_request` — 트리아지 프롬프트와 평가 기준선 재측정을 함께 한다. caseType `Feature Request`, caseReason `defect`·`feature` 추가.
- **규모** — 케이스 목록을 JS 에서 거르는 부분(`crm.js listView`)과 동기화마다 케이스 원천 행을 전부 다시 읽는 부분(`collections.js syncCase`)이 한계다. 케이스·활동이 수천~수만 건이면 `cases` 문서 상태 인덱스 + SQL 필터, 문서 `synced_at` 칼럼, 이벤트별 부분 갱신.
- **`loop.reopenCase` 제거** — 부르는 라우트가 없다(재오픈은 고객 회신으로만 일어난다). 다음에 루프 코드를 바꿀 때 함께 지운다. 활동 `reopen` 은 지우지 않는다 — 고객 회신 재오픈이 남기고, 첫 메시지 IGNORE·거절 뒤 감사 인사 종결의 "다시 연 케이스" 예외(`reopened`)와 감사 인사 재종결이 그것을 읽는다.
- **사람 전담 케이스의 재문의 알림** — 완료(2026-11-01). 사람 전담 종결 케이스가 고객 회신으로 다시 열리면 웹훅 한 통(「종결 케이스에 고객 회신 — 담당자 확인 필요」). 에이전트 담당 케이스의 재오픈과 다시 열지 않은 자동 회신은 알리지 않는다. spec 부록 F.5.
- **문의자·고객사** — 지금은 생성·연결만 한다. 수동 확인 화면과 병합·검토 큐는 다음 단계.
- **종결 직전 틈** — 종결하는 순간 LLM 응답을 기다리던 회차가 실패하면 재시도 예약이 케이스를 `OPEN` 으로 되돌릴 수 있다(회차 시작은 이제 종결 케이스를 열지 않지만, 재시도 예약 자체는 아직 연다). 문서는 `Closed` 가 아니면 `closeReason` 을 비우므로 틀린 값은 남지 않는다.

**정한 것 (2026-11-01, 앞서 열린 질문이던 것):**
1. 종결 뒤 회신은 새 케이스를 만들지 않고 같은 케이스를 다시 연다(처음 넣은 "새 연결 케이스" 방식은 철회). 자동 회신은 종결 케이스를 다시 열지 않고 붙기만 한다. 에이전트가 맡던 케이스에 온 감사 인사뿐인 회신은 답 없이 원래 종결 사유로 다시 닫는다(`courtesy_reply`, 원래 사유가 없었으면 `resolved`). 사람 전담 케이스는 감사 인사여도 같은 담당자의 `Escalated` 로 다시 열고 알림을 보낸다 — 담당자가 닫는다.
2. 사람 전담 종결 케이스가 회신으로 다시 열리면 알림 웹훅을 한 통 보낸다.
3. 보류에는 만료를 두지 않는다. 사람이 보류를 풀 때까지 남고 자동 종결에서 빠진다 — 보류 탭 건수로 쌓임을 본다.

**Acceptance Criteria (각 항목을 착수할 때):**
- 새 intent: 평가 기준선을 다시 재고 치명 누락 0 을 확인한다. 정책 팩 검증(`policy.validate`)과 팩 전수 테스트가 새 caseType·caseReason 을 본다
- 규모: 같은 입력에서 목록·상세 응답이 전과 바이트 단위로 같다(투영이 결정적이므로 비교 가능)
- 알림: 알림 본문에 고객 정보가 없다(채널 이름·케이스 번호·사유만) — 재오픈 알림이 이 기준으로 들어갔다

### B26. 고객 KB·정책 콘솔 후속 (2026-11-02 추가)

**Why:** 고객 관리자가 매뉴얼을 KB 로 바꿔 넣고 정책 팩의 고객 편집 항목을 고치는 콘솔을 넣었다(`docs/spec.md` 부록 H). 첫 버전은 단일 테넌트, 한 프로세스, 전용 화면 한 벌로 좁게 만들었다. 실제로 쓰면서 막히는 곳을 보고 다시 정한다.

**What (후속 작업):**
- **절 선택(retrieval)** — 매 회차 프롬프트에 KB 전체를 넣는다. KB 상한(유효 본문 50,000자)을 넘기려면 질문별로 절을 골라 넣어야 한다.
- **KB에서 intent 후보 제안** — 참조되지 않은 KB 절마다 L1 후보를 만드는 결정적 제안과, LLM 묶음 제안.
- **바뀐 뒤 표본만 세는 승격 지표** — 지금 지표는 (channel, intent) 누적이다. KB 나 팩이 바뀐 뒤의 표본만 따로 세면 확대 게이트가 더 빨리 열린다.
- **intent 이름 재사용 승계** — 지운 intent 이름을 다시 만들 때 승격 표본을 이어 쓸지 정한다. 지금 기본값은 이어 쓴다.
- **PDF 쪽 창과 캐시** — 긴 PDF 를 쪽 창 여러 번 호출과 문서 블록 캐시로 받는다. 지금은 입력 토큰 상한을 넘으면 거부한다.
- **변환 전용 모델 환경 변수**와 **HWPX 직접 지원**.
- **채널 허용 목록 환경 변수** — 고객 배포에서 출하 데모 채널을 숨긴다.
- **콘솔에서 새 채널 만들기** — 채널 템플릿과 함께. 지금은 이미지에 팩이 있는 채널만 게시할 수 있다.
- **감사 기록 회전과 위변조 방지** — 접속기록과 함께 외부 보관을 정한다.
- **mock 의 새 채널 intent 매칭** — 설명 키워드로 맞춘다. 지금 mock 은 새 채널에서 늘 `unclear` 다.
- **아키텍처 다이어그램 갱신** — 콘솔과 `config_changes` 블록을 `docs/diagrams/` 에 추가한다.

**Acceptance Criteria (각 항목을 착수할 때):**
- 절 선택: 같은 질문에 붙는 절 목록이 결정적이고, 고른 절 밖의 근거가 나오면 guard 가 막는다
- 지표: 바뀐 뒤 표본만 세는 값이 기존 지표와 따로 보이고, 게이트 판정에 어느 쪽을 쓰는지 기록된다
- 채널 만들기: 템플릿에서 만든 팩이 하한 검사를 통과하고 게시·되돌리기가 같은 게이트를 지난다
- 감사: 회전한 파일의 sha256 목록이 manifest 와 같다

### B27. 감사 내보내기와 고지 문안 후속 (2026-11-02 추가)

**Why:** 감사 내보내기 CLI 는 허용 목록으로 줄을 만들고 고객 주소를 HMAC 으로 가린다. 고객사 약관과 처리방침 문안은 고객 법무가 정한다(`docs/compliance.md`). 실제 운영 전에 빠진 것을 채운다.

**What (후속 작업):**
- **비이메일 매체** — 채팅·문자 등 이메일이 아닌 매체의 표시 문구와 감사 줄을 정한다. 지금은 메일만 다룬다.
- **고지 문구 버전 관리** — manifest 의 `templates.email` 해시를 고지 문안 버전과 묶어 기록한다.
- **내보내기 기간 상한** — 기간이 길면 표 하나만큼 메모리를 쓴다. 필요하면 키 범위로 나눠 읽는다.

**Acceptance Criteria:**
- 비이메일 매체를 넣으면 그 매체의 표시 문구 테스트가 같이 늘어난다
- manifest 의 템플릿 해시가 고지 문안 버전과 1:1 로 대응한다
- 긴 기간 내보내기가 같은 입력에서 바이트 단위로 같은 파일을 낸다
