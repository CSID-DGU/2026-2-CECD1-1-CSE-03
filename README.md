# 2026-2-CECD1-1-CSE-03
동국대학교 2026 2학기 종합설계1 01분반 팀 컴퓨터공학 레포지토리입니다.

## 범용 CS 응대 에이전트 + 휴먼인더루프 대시보드

고객 문의(메일·폼)를 받아 **분류 → 작성 → 검수** 세 에이전트가 답장 초안을 만들고, 사람이 백오피스(CRM 대시보드)에서 **승인·수정·폐기**한다. 반복 문의 중 정책 팩이 L2 로 지정한 유형(탈퇴·영수증·구독 해지·온보딩 신청·미팅·서비스 질문)은 같은 검사·발송 경로로 **자동 발송**한다. 사람 판단이 필요한 문의(환불·클레임·법적·데이터 반출 등)는 네 번째 에이전트가 **브리핑 노트**를 써서 바로 담당자에게 넘기고, 고객에게는 사실 없는 **접수 안내**를 한 통 보낸다.

- 자율 등급 L0(섀도) · L1(승인) · L2(자동 발송) · H(사람 전용). L2 는 팩 `maxLevel` 과 intent `level` 이 둘 다 L2 일 때만이고, `AUTO_SEND=0` 한 줄로 전부 끈다(2026-10-27 결정, 목표 1차 응대율 ≥ 80%). 대시보드 KPI 에 1차 응대율 · 완전 자동응대 · 넘김 · 응대 못함.
- 채널(고객문의·온보딩·영업 문의)은 **정책 팩 json + KB 마크다운**으로 추가한다. 루프 코드는 채널을 모른다.
- CRM 화면은 처리 테이블에서 계산한 컬렉션 문서(케이스·활동·문의자·고객사·수신 이벤트)를 읽고, 케이스 상태는 New · Working · On Hold · Escalated · Closed 5단계다(화면 이름 신규 · 응대 중 · 보류 · 사람 전담 · 종결, 칸반은 승인 대기 칸을 따로 둔다). 종결한 케이스에 고객이 회신하면 같은 케이스가 다시 열리고 담당(에이전트·사람)은 그대로 이어진다. 자동 회신은 다시 열지 않고, 에이전트가 맡던 케이스에 온 감사 인사뿐인 회신은 답 없이 원래 종결 사유로 다시 닫는다(사람이 맡던 케이스는 감사 인사여도 다시 열고 담당자에게 알린다 — `docs/spec.md` 부록 F).
- 의존성 0 — Node 22 내장(`node:http` · `node:sqlite` · `node:test` · `fetch` · `node:tls`)만 쓴다.
- 고객 언어는 한국어·영어만. 채널 팩 `languages` 밖이면 사람에게 넘긴다.

### 빠른 시작

```bash
node -v          # 22.13+
npm start        # http://localhost:3000  대시보드
npm run demo     # 합성 문의 → 루프 → 기대 행동 대조표
npm run sim      # 15초마다 합성 문의 주입 (대시보드 라이브 데모). -- --every=5 --once
npm test
```

**고객 KB·정책 콘솔.** 대시보드 상단 「지식·정책」 버튼으로 연다. 고객 관리자가 매뉴얼을 KB 형식으로 바꿔 넣고, 채널 정책 팩의 고객 편집 항목을 고친다. 편집은 `ADMIN_USERS` 에 적은 사람만 한다(쉼표 목록, 바꾸면 재시작). 로컬에서는 `ADMIN_USERS=<검토자 이름> npm start` 로 켜고, 화면의 검토자 이름에 같은 값을 넣는다. 게시 전에 검사와 승격 게이트를 거친다. 자세한 규칙은 [`docs/spec.md`](docs/spec.md) 부록 H, 운영 설정은 [`docs/deployment.md`](docs/deployment.md) §7.

`ANTHROPIC_API_KEY` 가 있으면 자동으로 Claude API(`claude-sonnet-5-5`)를 쓰고, 없으면 결정적 mock 으로 돈다. 대시보드 "테스트 문의" 버튼은 개발 + mock 메일(기본)이면 그대로 쓰고, 로컬에서 `MAIL_PROVIDER=smtp` 로 띄울 때는 `ENABLE_TEST_INJECT=1` 을 준다. 서버는 기본으로 `127.0.0.1` 에만 열린다. 나머지 환경 변수와 Docker 배포·파일럿 체크리스트는 [`docs/deployment.md`](docs/deployment.md).

```bash
npm run demo:mail -- --check                                                       # 가짜 메일 서버로 수신→답장 왕복 확인
node --no-warnings=ExperimentalWarning scripts/subject-request.js export <email> --by <이름>   # 정보주체 열람(삭제는 delete <email> --by <이름>)
```

### 디렉터리

```
server/      루프 엔진 · 네 에이전트 · guard · 정책 · KB 로더 · HTTP/SSE · 스위퍼 · 알림 · mock
  console.js · convert.js · config-read.js   고객 KB·정책 콘솔(게시·감사·L2 게이트), 매뉴얼 변환, DB 원문 읽기
  agents/    triage · responder · reviewer · briefer (+ personas.md)
  llm/       mock | anthropic        mail/  mock | smtp
  mock/      합성 문의 세트 · demo · sim
policy/      채널 정책 팩  support.json · onboarding.json · sales.json
kb/          채널 KB      support.md · support.en.md · onboarding.md · sales.md
web/         대시보드 (바닐라 HTML/CSS/JS, 빌드 없음) · console.js·console.css 는 고객 KB·정책 콘솔
scripts/     IMAP 수신 어댑터(시연 · 미러) · 메일 E2E 데모 · 실데이터 평가 · 정보주체 요청 · 감사 내보내기 · 프로토타입 빌드
test/        node:test
docs/        설계 문서 · 다이어그램
```

### 문서

| 문서 | 내용 |
|---|---|
| [`docs/spec.md`](docs/spec.md) | 구현 계약 — 스키마 · 루프 · API · SSE · 정책 팩 · 목데이터 · 테스트 |
| [`docs/architecture.md`](docs/architecture.md) | 네 페르소나 · 한 회차 루프 · 정책 팩 · 자율 등급 · 불변식 |
| [`docs/db.md`](docs/db.md) | 테이블 · 멱등 제약 · ER · SQLite→Postgres |
| [`docs/deployment.md`](docs/deployment.md) | 로컬 vs 배포 · 환경 변수 · Dockerfile · 웹훅 · 롤아웃 L0→L1→L2 · 파일럿(미러 · 보존 · 콘솔 · 감사 내보내기 · 접속기록 · 체크리스트) |
| [`docs/compliance.md`](docs/compliance.md) | 고객사 약관·처리방침에 넣을 AI 응대 고지 문안 템플릿, 메일 안 표시 위치 (법률 자문 아님) |

### 다이어그램 (브라우저로 열기, 오프라인 단일 HTML)

| 다이어그램 | 보여 주는 것 |
|---|---|
| [`docs/diagrams/cs-agent-loop.html`](docs/diagrams/cs-agent-loop.html) | 한 회차 루프 — 코드 lane · 네 페르소나(접수 · 답장 · 검수 · 인계 Agent, 코드명 Triage · Responder · Reviewer · Briefer) lane · HITL lane, 넘김 분기 |
| [`docs/diagrams/cs-agent-system.html`](docs/diagrams/cs-agent-system.html) | 시스템 구성 — 공통 코어와 LOCAL / DEPLOYED 어댑터 |
| [`docs/diagrams/cs-agent-case-lifecycle.html`](docs/diagrams/cs-agent-case-lifecycle.html) | 케이스 상태 전이 |
| [`docs/diagrams/cs-agent-draft-lifecycle.html`](docs/diagrams/cs-agent-draft-lifecycle.html) | 초안 상태 전이 (승인 · L2 자동 발송 · 접수 안내 · STALE · 멱등 발송) |
| [`docs/diagrams/cs-agent-data-model.html`](docs/diagrams/cs-agent-data-model.html) | 데이터 모델 |

같은 이름의 `.json` 이 원본 명세(archify). 고치면 다시 렌더한다.

### 산출물 체크리스트

- [ ] 에이전트 루프가 돌아가는 것 확인 — `npm run demo` 기대 행동 일치, 대시보드 에이전트 피드에 단계별 `agent.step` 표시
- [ ] 휴먼인더루프 대시보드 — 케이스 목록 · 대화 타임라인 · 승인 큐(승인/수정 승인/폐기) · 인수/반환 · 넘김 브리핑 · 1차 응대율 KPI
- [ ] 루프 아키텍처 — 네 페르소나와 분류 과정 (`cs-agent-loop.html`)
- [ ] DB 설계 (`docs/db.md`, `cs-agent-data-model.html`)
- [ ] 로컬 vs 배포 차이 (`docs/deployment.md`, `cs-agent-system.html`)
- [ ] 목데이터 테스트 (`npm test`, `npm run demo`)
- [ ] 독립 리뷰 결함 수정·재검증
