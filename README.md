# 2026-2-CECD1-1-CSE-03
동국대학교 2026 2학기 종합설계1 01분반 팀 컴퓨터공학 레포지토리입니다.

## 범용 CS 응대 에이전트 + 휴먼인더루프 백오피스

고객 문의 메일을 받아 네 에이전트가 분류하고, 답장 초안을 쓰고, 검수한다. 담당자는 백오피스에서 초안을 **승인·수정·폐기**하거나 직접 맡는다. 문의 한 건은 세 가지 처리 방식 중 하나로 끝난다.

| 처리 방식 | 뜻 | 예 |
|---|---|---|
| **자동 발송** | 정책 팩이 허용한 반복 문의는 검사를 통과하면 사람 승인 없이 나간다 | 탈퇴 · 영수증 · 구독 해지 · 온보딩 신청 |
| **초안 검토** | 답장 Agent가 쓴 초안을 담당자가 승인해야 나간다 | 일반 서비스 질문 |
| **사람 처리** | 인계 Agent가 브리핑 노트를 써서 담당자에게 넘기고, 고객에게는 접수 안내만 보낸다 | 환불 · 클레임 · 법적 언급 · 데이터 반출 |

한 회차의 흐름은 다음과 같다.

```
메일 도착 → 1차 거르기(코드) → 접수 Agent(분류) → 처리 방식 1차 판단(코드)
          → 답장 Agent(초안) → 본문 검사(코드: 금액·링크·날짜·금지어) → 필요하면 한 번 다시 씀
          → 검수 Agent(내용 판단) → 처리 방식 최종 판단(코드) → 발송 · 승인 대기 · 사람에게 넘김
```

- 채널(고객문의 · 온보딩 · 영업 문의)은 **정책 팩 JSON + 지식베이스 마크다운**으로 추가한다. 루프 코드는 채널을 모른다.
- 자동 발송은 `AUTO_SEND=0` 한 줄로 전부 끈다. 대시보드 지표는 1차 응대율 · 완전 자동응대 · 넘김 · 응대 못함.
- 케이스 상태는 신규 · 응대 중 · 보류 · 사람 전담 · 종결 5단계이고, 칸반은 승인 대기 칸을 따로 둔다. 종결한 케이스에 고객이 회신하면 같은 케이스가 다시 열린다.
- 의존성 0 — Node 22 내장 모듈(`node:http` · `node:sqlite` · `node:test` · `fetch` · `node:tls`)만 쓴다.
- 고객 언어는 한국어 · 영어만. 채널 팩 `languages` 밖이면 사람에게 넘긴다.

## 빠른 시작

```bash
node -v          # 22.13+
npm start        # http://localhost:3000  백오피스
npm run demo     # 합성 문의 → 루프 → 기대 행동 대조표
npm run sim      # 15초마다 합성 문의 주입 (백오피스 라이브 데모). -- --every=5 --once
npm test
```

`ANTHROPIC_API_KEY`가 있으면 Claude API(`claude-sonnet-5-5`)를 쓰고, 없으면 결정적 mock으로 돈다. 서버는 기본으로 `127.0.0.1`에만 열린다. 환경 변수 전체는 [`.env.example`](.env.example)과 [`docs/deployment.md`](docs/deployment.md).

```bash
npm run demo:mail -- --check                                                       # 가짜 메일 서버로 수신→답장 왕복 확인
npm run sim:eval                                                                   # 고객 시뮬레이터로 고정 평가 세트 v1 채점
node --no-warnings=ExperimentalWarning scripts/subject-request.js export <email> --by <이름>   # 정보주체 열람(삭제는 delete)
```

### 백오피스 쓰는 법

| 하고 싶은 일 | 어디서 |
|---|---|
| 내 이름 남기기 | 상단 「검토자 이름」 — 승인·인수 기록에 남는다 |
| 볼 건 고르기 | 상태 탭 · 필터, 또는 「칸반」 보기의 **승인 대기** 칸 |
| 초안 승인 | 카드 상세의 초안 패널 — 「승인」(원문 그대로) · 「수정 후 승인」(본문을 고치고 수정 사유 체크) · 「폐기」 |
| 사람이 직접 처리 | 「인수」로 가져오고 「직접 답장」 · 「메모」 · 「보류」(메모 필수) · 「종결」(사유 필수), 다시 맡기려면 「반환」 |
| 상태 바꾸기 | 칸반 카드를 다른 칸에 끌어 놓거나 상세의 진행 단계를 누른다 |
| 지식베이스 · 정책 고치기 | 상단 「지식·정책」 — 편집은 `ADMIN_USERS`에 적은 사람만. 매뉴얼 파일을 지식베이스 초안으로 바꾸는 「매뉴얼 변환」 포함 |
| 운영 숫자 보기 | 상단 「리포트」 — 업무 대체 비율, LLM 호출 · 토큰 · 비용 |

## 폴더 구조

| 경로 | 무엇 |
|---|---|
| `server/` | 서버 전체. 진입점 `index.js`(HTTP · SSE · 라우트), 에이전트 루프 `loop.js`, 1차 거르기 `prefilter.js`, 본문 검사 `guard.js`, 정책 판단 `policy.js`, 지식베이스 로더 `kb.js`, 저장소 `store.js` · `db.js` · `schema.sql`, CRM 투영 `crm.js` · `collections.js` · `cases.js`, 콘솔 `console.js` · `convert.js`(매뉴얼 → 지식베이스), 리포트 `report.js`, 보존 · 파기 `retention.js`, 접속기록 `accesslog.js`, 스위퍼 `sweeper.js`, 알림 `notify.js`, AWS 서명 `aws.js` |
| `server/agents/` | 네 에이전트 — 접수 `triage.js` · 답장 `responder.js` · 검수 `reviewer.js` · 인계 `briefer.js`, 페르소나 문서 `personas.md`, 답장 Agent 툴 `tools.js` |
| `server/llm/` | 모델 어댑터 — `mock.js` · `anthropic.js`, 선택은 `index.js` |
| `server/mail/` | 발송 어댑터 — `mock.js` · `smtp.js` |
| `server/mock/` | 합성 문의 세트 `inquiries.js`, `npm run demo` · `npm run sim` 본체 |
| `web/` | 백오피스 화면 (바닐라 HTML · CSS · JS, 빌드 없음). `app.js`는 목록 · 칸반 · 상세 · 리포트, `console.js`는 지식·정책 콘솔 |
| `policy/` | 채널 정책 팩 — `support.json` · `onboarding.json` · `sales.json` |
| `kb/` | 채널 지식베이스 — `support.md` · `support.en.md` · `onboarding.md` · `sales.md` |
| `scripts/` | 서버 밖에서 도는 도구. 수신 어댑터 `inbound-imap.js`(IMAP, 미러 모드) · `inbound-ses.js`(SES → S3 → SQS), 메일 왕복 데모 `demo-mail.js`, 실데이터 평가 `eval-real.js`, 감사 내보내기 `audit-export.js`, 정보주체 요청 `subject-request.js`, 검사 도구 CLI `engine.js`(플러그인과 같이 씀), 단일 HTML 프로토타입 빌드 `build-prototype.js` |
| `scripts/sim/` | 고객 시뮬레이터 — 시나리오 · 초안 · 채점 · 실행(`npm run sim:eval`) |
| `eval/` | 고정 평가 세트 v1 — 시나리오 120건 `scenarios.v1.jsonl`, 고객 페르소나, 해시 목록 `MANIFEST.json`, 출처 표시 `SOURCES.md` |
| `infra/` | AWS 운영 스택 CloudFormation 템플릿 `cs-agent.cfn.json` (작성 · 테스트만, 배포 안 함) |
| `test/` | `node:test` — 모듈별 한 파일. 인프라 템플릿 불변식, AWS 서명, SES 수신도 여기서 검사 |
| `docs/` | 설계 문서 (아래 표) |
| `docs/diagrams/` | 다이어그램 — JSON 원본과 단독 HTML 한 쌍씩. 목록은 [`docs/diagrams/README.md`](docs/diagrams/README.md) |
| `docs/runs/` | 실제 모델로 돌린 기록 (`2026-11-01-anthropic.json`) |
| `dist/` | `scripts/build-prototype.js`가 만드는 단일 HTML 프로토타입 — 빌드 산출물이라 저장소에는 올리지 않는다 |
| `Dockerfile` | 운영 이미지 |

## 지금까지 한 것

**10월 31일까지 — 동작하는 코어**
- 네 에이전트와 한 회차 루프, 자동 발송 · 초안 검토 · 사람 처리 분기, 접수 안내
- SQLite 저장소, HTTP · SSE 서버, 스위퍼, 알림 웹훅
- 메일 어댑터(mock · SMTP), IMAP 수신과 메일 왕복 데모
- 백오피스 대시보드, 합성 문의 데모 · 시뮬레이터
- 설계 문서 · 다이어그램, 리뷰에서 찾은 결함의 회귀 테스트

**11월 8일 — 파일럿 준비**
- CRM 문서 투영(케이스 · 활동 · 문의자 · 고객사 · 수신 이벤트), 원문 파기, 접속기록
- LLM 사용량 · 비용 기록, 일일 토큰 예산, 운영 리포트
- 지식·정책 콘솔과 매뉴얼 → 지식베이스 변환, 정책 하한, 개인정보 마스킹 확대
- 백오피스 개편, 칸반을 노션 보드 형태(상태 알약 · 속성 칩)로
- IMAP 미러 모드 · DMARC 판정, 감사 내보내기, 정보주체 요청
- 고객 시뮬레이터와 고정 평가 세트 v1
- 플러그인과 같이 쓰는 검사 도구 CLI (`scripts/engine.js`)
- AWS 준비: CloudFormation 템플릿, SigV4 서명 · IMDSv2 자격 증명, SES 수신 어댑터
- 테스트를 기능별 파일로 재정리

## 남은 것

- AWS 실제 배포 — 템플릿만 있고 올리지 않았다(비용 발생). 운영 모델은 Claude API 키로 직접 호출한다.
- 기동 전 점검 스크립트, AWS 배포 문서
- CloudFormation 정적 검사(cfn-lint · cfn-guard) 실행

## 문서

| 문서 | 내용 |
|---|---|
| [`docs/spec.md`](docs/spec.md) | 구현 계약 — 스키마 · 루프 · API · SSE · 정책 팩 · 목데이터 · 테스트 |
| [`docs/architecture.md`](docs/architecture.md) | 네 페르소나 · 한 회차 루프 · 정책 팩 · 처리 방식 · 불변식 |
| [`docs/e2e.md`](docs/e2e.md) | 문의 한 통이 들어와서 나가기까지 |
| [`docs/states.md`](docs/states.md) | 코드가 쓰는 상태 · 코드 값 색인 |
| [`docs/tools.md`](docs/tools.md) | 답장 Agent 툴 — 목록 · 한 사이클 · 작성 규칙 · 안전 규칙 · 기록 |
| [`docs/db.md`](docs/db.md) | 테이블 · 제약 · ER · SQLite→Postgres |
| [`docs/deployment.md`](docs/deployment.md) | 로컬 vs 배포 · 환경 변수 · Dockerfile · 웹훅 · 단계적 도입 · 파일럿 운영 체크리스트 |
| [`docs/compliance.md`](docs/compliance.md) | 고객사 약관 · 처리방침에 넣을 AI 응대 고지 문안 템플릿 (법률 자문 아님) |
| [`docs/feasibility.md`](docs/feasibility.md) | 실데이터 가능성 검토 |
| [`docs/backlog.md`](docs/backlog.md) | 백로그 (Why · What · Acceptance) |

## 산출물 체크리스트

- [x] 에이전트 루프 동작 — `npm run demo` 기대 행동 일치, 백오피스 에이전트 피드에 단계별 표시
- [x] 휴먼인더루프 백오피스 — 케이스 목록 · 칸반 · 대화 타임라인 · 승인(승인 · 수정 후 승인 · 폐기) · 인수 · 반환 · 보류 · 종결 · 넘김 브리핑 · 지표
- [x] 루프 아키텍처 — 네 페르소나와 분류 과정 ([`cs-agent-loop.html`](docs/diagrams/cs-agent-loop.html))
- [x] DB 설계 ([`docs/db.md`](docs/db.md), [`cs-agent-data-model.html`](docs/diagrams/cs-agent-data-model.html))
- [x] 로컬 vs 배포 차이 ([`docs/deployment.md`](docs/deployment.md), [`cs-agent-system.html`](docs/diagrams/cs-agent-system.html))
- [x] 목데이터 테스트 (`npm test`, `npm run demo`)
- [x] 독립 리뷰 결함 수정 · 재검증
- [ ] AWS 배포
