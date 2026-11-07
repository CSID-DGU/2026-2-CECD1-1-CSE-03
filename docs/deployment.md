# 로컬 실행과 배포

구성도: [`diagrams/cs-agent-system.html`](diagrams/cs-agent-system.html). 코어(`server/`)는 로컬과 배포가 **같은 코드**다. 바뀌는 건 바깥 어댑터(LLM·메일·DB 위치·인증·알림)와 환경 변수뿐.

## 1. 로컬

```bash
node -v            # 22.13+ (node:sqlite 플래그 없이). 의존성 설치 없음
npm start          # http://localhost:3000  대시보드 + API
npm test           # node:test
npm run demo       # 합성 문의 주입 → 루프 → 기대 행동 대조표. 불일치 있으면 exit 1
npm run sim        # 서버에 15초마다 합성 문의 1건 주입 (대시보드 라이브 데모)
npm run sim -- --every=5 --url=http://localhost:3000 --once   # 간격 · 대상 서버 · 1건만
```

`package.json` 스크립트가 `--no-warnings=ExperimentalWarning` 을 넘기므로 `node:sqlite` 경고는 안 보인다.
서버는 기동할 때 `server/loop.js recover` 로 죽은 리스를 풀고, 발송 중에 멈춘 초안(SENDING)을 "발송 확인 필요"로 표시하고, claim 만 되고 끝나지 않은 메시지를 다시 돌린다. 그다음 `server/sweeper.js` 타이머(15초)와 `server/notify.js` 를 켠다.

`.env.example` 을 복사해 `.env` 로 쓰고 쉘에서 로드한다(`set -a; source .env; set +a`). `.env` 는 gitignore, `.env.example` 만 추적한다.

### 환경 변수 (전부 선택, 괄호가 기본값)

코드가 읽는 환경 변수 전부다(`server`·`scripts` 의 `env.X` — `preflight(env)` 처럼 매개변수로 읽는 것 포함 — 와 `server/mail/smtp.js config` 기준). `.env.example` 도 같은 목록이고, `test/repo-contract.test.js` 가 둘이 코드와 맞는지 확인한다.

| 변수 | 읽는 곳 | 뜻 |
|---|---|---|
| `PORT` (3000) | `server/index.js` | 서버 포트 |
| `HOST` (`127.0.0.1`, 컨테이너는 `0.0.0.0`) | `server/index.js` | 바인드 주소. 기본은 이 컴퓨터에서만 열린다. 이미지가 `ENV HOST=0.0.0.0` 이라 컨테이너 포트 매핑이 살고, 밖에서는 `-p 127.0.0.1:3000:3000` 으로 막는다. `--env-file` 의 빈 `HOST=` 줄은 이미지 값을 덮는다 |
| `DB_PATH` (`data/cs-agent.db`, 컨테이너는 `/app/data/cs-agent.db`) | `server/db.js` | SQLite 파일. 테스트는 `:memory:`. 같은 폴더에 접속기록 `access.jsonl` 과 미러 수신 상태 `imap-state.json` 이 생긴다(`:memory:` 면 둘 다 끔). 파일 DB 는 잠금을 5초 기다린다(`busy_timeout`) |
| `NODE_ENV` | `server/index.js` `server/policy.js` | `production` 이면 `INBOUND_SECRET`·`AUTH_USER_HEADER`·`PROXY_SHARED_SECRET` 중 하나라도 없을 때, 그리고 `MAIL_PROVIDER=mock` 일 때(`ALLOW_MOCK_MAIL=1` 이면 경고만) **시작을 거부한다**. 테스트 주입이 꺼지고 `REQUIRE_SENDER_AUTH` 기본값이 켬이 된다. 발송 없는 로컬 시연은 비워 둔다(Docker 는 `-e NODE_ENV=` 에 `-e MAIL_PROVIDER=mock` 도 — 비워도 `MAIL_PROVIDER=smtp` + 루프백 아닌 `HOST` 면 세 시크릿을 요구한다) |
| `LLM_PROVIDER` | `server/llm/index.js` | `mock` · `anthropic`. 없으면 `ANTHROPIC_API_KEY` 가 있을 때 `anthropic`, 없을 때 `mock`. 테스트·데모는 mock 강제 |
| `ANTHROPIC_API_KEY` | `server/llm/anthropic.js` | Claude API 키. `npm run smoke:llm` 은 없으면 거부 |
| `ANTHROPIC_MODEL` (`claude-sonnet-5-5`) | `server/llm/anthropic.js` | 모델 id |
| `ANTHROPIC_BASE_URL` (`https://api.anthropic.com/v1/messages`) | `server/llm/anthropic.js` | Messages 엔드포인트. `fetch` 직접 호출, `anthropic-version: 2026-10-21`, JSON 은 `output_config.format: json_schema` |
| `LLM_TIMEOUT_MS` (30000) | `server/llm/anthropic.js` | LLM 호출 하나의 제한 시간(`AbortSignal.timeout`) |
| `LLM_RETRY_SCALE` (1) | `server/loop.js` `server/llm/index.js` | 장애 재시도 간격(2·5·10·30분)과 차단기 열림 시간(60초)의 배수. 테스트에서 줄인다 |
| `LLM_MOCK_DELAY_MS` (0) | `server/llm/mock.js` | mock 응답 지연. 대시보드에서 "돌아가는 중"을 보려면 1500 정도 |
| `LLM_DAILY_TOKEN_BUDGET` (무제한) | `server/agents/common.js` `server/index.js` | 하루 입력+출력 토큰 상한(`llm_calls` 합계, 기준일 UTC — 한국 시간 09:00 초기화). 넘으면 LLM 을 부르지 않고 재시도 없이 담당자에게 넘긴다(`llm_error`). 1 이상 정수가 아니면 시작 거부. production + `anthropic` 인데 비어 있으면 기동 경고 |
| `LLM_PRICE_INPUT_PER_MTOK` `LLM_PRICE_OUTPUT_PER_MTOK` | `server/report.js` | 백만 토큰당 USD 단가. `/api/report` 의 비용 계산에만 쓴다. 비우면 비용 `null`(모델 가격을 코드에 두지 않는다) |
| `MAIL_PROVIDER` (`mock`, 컨테이너는 `smtp`) | `server/mail/index.js` | `mock` DB 기록만 / `smtp` 실제 발송 |
| `MAIL_ALLOWED_DOMAINS` | `server/mail/index.js` | 쉼표 구분. 실발송 provider 는 **이 목록 밖 수신자를 전부 막는다**(비어 있으면 전부 차단 — fail-closed) |
| `ALLOW_MOCK_MAIL` | `server/index.js` | `1` 이면 production 에서도 mock 메일로 시작한다(발송 없는 시연용). SENT 가 허구라 기동 경고·`/api/status.mailWarning`·대시보드 배너가 뜬다 |
| `SMTP_HOST` `SMTP_FROM` | `server/mail/smtp.js` | smtp provider 필수값(발송 때 없으면 `smtp config` 오류 → 502, 초안 PENDING 복귀) |
| `SMTP_PORT` (587) `SMTP_SECURE` | `server/mail/smtp.js` | 기본은 STARTTLS. `SMTP_SECURE=1` 이면 암묵 TLS(보통 465) |
| `SMTP_USER` `SMTP_PASS` | `server/mail/smtp.js` | AUTH 자격증명(비우면 AUTH 생략) |
| `SMTP_ALLOW_PLAIN` | `server/mail/smtp.js` | `1` 이면 STARTTLS 없이 평문 허용(로컬 테스트용) |
| `SMTP_TIMEOUT_MS` (15000) | `server/mail/smtp.js` | SMTP 단계별 제한 시간 |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `server/mail/smtp.js` | `0` 이면 자체 서명 인증서 허용 |
| `MAIL_MOCK_FAIL` `MAIL_MOCK_LOG` `MAIL_MOCK_DELAY_MS` | `server/mail/mock.js` | mock 발송 실패 재현(`1`) / 발송 로그 끔(`0`) / 발송 지연(ms) |
| `CS_ABLATE` (없음) | `server/loop.js` | 비교 실험 전용. `inbound,answered,inflight,ack,guard` 중 고른 장치를 끈다(`ack`는 기준 표지·반환 미답 선택까지, `guard`는 발송 시점 본문·렌더 재검사 전체). mock 메일일 때만 먹고 실발송(`MAIL_PROVIDER=smtp`)에선 무시한다. 값이 있으면 서버는 시작을 거부하고, 데모·프로토타입 빌드·실데이터 평가(`eval-real.js`)는 지운 뒤 돈다 |
| `INBOUND_SECRET` (없음) | `server/index.js` `server/mock/sim.js` | 있으면 `POST /api/inbound` 에 `X-Inbound-Secret` 헤더 필요(`crypto.timingSafeEqual`). sim 은 이 값을 헤더로 보낸다 |
| `AUTH_USER_HEADER` (없음) | `server/index.js` | 리버스 프록시가 넣는 사용자 헤더 이름(예: `x-forwarded-user`). 있으면 **`/api` 전부(GET·SSE 포함)** 가 그 헤더 없이 401, `by` 는 헤더 값으로 덮어쓴다. `/api/inbound`·`/api/health` 만 예외 |
| `PROXY_SHARED_SECRET` (없음) | `server/index.js` | 있으면 `/api` 요청(웹훅·헬스체크 제외)에 `X-Proxy-Secret` 헤더가 이 값이어야 한다. 프록시만 넣으므로 앱 포트에 직접 붙어 사용자 헤더를 위조한 요청은 401 |
| `ADMIN_USERS` (없음 = 아무도 고칠 수 없음) | `server/console.js` `server/index.js` | 고객 KB·정책 콘솔에서 **쓰기**(게시·되돌리기·복원·초안 저장·변환)를 할 수 있는 사람의 쉼표 목록. 값은 actor 와 같은 형식이다 — 프록시가 사용자 헤더에 넣는 문자열(이메일이든 아이디든 그 값 그대로). 비교는 양쪽을 trim·소문자로 바꾼 뒤 한다. 빈 항목은 버린다. **기동 때 한 번 읽으므로 바꾸면 재시작해야 한다.** production 인데 비어 있으면 기동 경고(시작은 한다). 읽기는 인증된 누구나 한다 |
| `AUDIT_SALT` (없음) | `scripts/audit-export.js` | 감사 내보내기가 고객 주소를 `customer_hash`(HMAC-SHA256)로 가리는 키. **32자 이상**이어야 하고 짧거나 비면 CLI가 exit 2 로 거부한다. 같은 주소라도 키가 바뀌면 해시가 달라지므로 키는 운영 시크릿으로 보관하고 바꾸지 않는다. 서버는 이 값을 읽지 않는다 |
| `KB_CONVERT_PDF_TOKENS` (없음, 코드 상수 30000) | `server/convert.js` `PDF_TOKEN_CAP` | 환경 변수가 아니다. 매뉴얼 PDF 한 번 호출의 입력 토큰 상한이다. 넘으면 `413 pdf_too_large`. 값을 바꾸려면 코드를 고치고 리뷰를 거쳐야 한다. `.env` 에 넣어도 읽히지 않는다 |
| `ENABLE_TEST_INJECT` | `server/index.js` | `1` 이면 `/api/test/inbound`(대시보드 "테스트 문의"·sim)를 켠다. 비우면 개발(`NODE_ENV` 가 `production` 아님) + `MAIL_PROVIDER=mock` 일 때만 켜진다 — production 과 실발송(smtp)은 꺼진다 |
| `REQUIRE_SENDER_AUTH` (production 켬, 그 밖 끔) | `server/policy.js` | 켜면 발신자 인증 결과가 없는 메일에 자동 메일(L2 자동 발송·접수 안내)이 없다 — 회차는 돌고 초안은 승인 대기. `0`·`false`·`off`·`no` 는 끔, 그 밖의 값(오타 포함)은 켬(fail-closed). 인증 실패(`fail`)는 설정과 무관하게 1차 거르기에서 넘긴다(`sender_unverified`, LLM 호출 없음). `MAIL_PROVIDER=smtp` 인데 꺼져 있으면 기동 경고 |
| `FORM_SENDER_DOMAINS` | `server/policy.js` `server/cases.js` | 쉼표 구분. 이 도메인 발신은 문의 폼 메일로 보고 Reply-To → 제목의 주소 → 본문 이메일 칸 순으로 고객 주소를 뽑는다. 뽑은 주소는 `sender_auth=form` — 고객이 친 값이라 **항상 미신뢰**(자동 메일 없음, 사람 승인 초안만). 못 뽑으면 `unclear` 로 넘긴다 |
| `SHADOW_CHANNELS` | `server/policy.js` | 쉼표 구분 채널 이름. 이 채널은 정책 팩과 무관하게 섀도(L0) — **재빌드 없는 kill switch**. 파일럿 권장값: 받는 채널 전부(미러 모드에선 `IMAP_CHANNEL` 이 필수) |
| `AUTO_SEND` | `server/policy.js` | `1`·`true`·`on`·`yes` 또는 비우면 켜짐. 그 밖의 값(`0`·`false`·`off`·오타)은 L2 자동 발송과 넘김 접수 안내를 전부 끈다(L2 intent도 승인 대기, fail-closed). `MAIL_PROVIDER=smtp` 인데 `INBOUND_SECRET` 이 비면 값과 상관없이 꺼진다. 시작 로그에 `auto_send=on`/`off` — **재빌드 없는 kill switch**. 파일럿 권장값 `0`(미러 모드에선 필수) |
| `NOTIFY_WEBHOOK_URL` | `server/notify.js` | Slack 호환 웹훅. 넘김·승인 대기 초안(자동 발송 예정분 제외)·자동 발송 막힘(초안이 승인 대기로 남을 때)과, 사람 전담 종결 케이스가 고객 회신으로 다시 열린 일을 알린다. 본문은 채널·케이스 번호·사유만(PII 없음) |
| `AUTO_CLOSE_DAYS` (30) | `server/sweeper.js` | 마지막 메시지·활동 뒤 이 기간 조용한 케이스를 스위퍼가 닫는다(승인 대기·발송 중·보류 제외, 고객에게는 아무것도 안 보냄) |
| `RETENTION_DAYS` (끔) | `server/retention.js` `server/sweeper.js` `server/index.js` | 종결 뒤 이 기간(일)이 지난 케이스의 원문·주소·이름을 스위퍼가 제자리 가명화한다(`cases.purged_at`, 승격 지표는 그대로). 1 이상 정수가 아니면 시작 거부. 승인 대기는 자동 종결되지 않으므로 파기되지 않는다 |
| `INTERNAL_DOMAINS` | `server/prefilter.js` | 쉼표 구분. 이 도메인 발신은 사내 메일로 보고 무시 |
| `COMPANY_NAME` (`ACME`), `AGENT_NAME` (`Aria`) | `server/mail/index.js` `server/loop.js` `server/index.js` | 메일 템플릿 인사·자기소개, `/api/status.company` |
| `SIM_URL` (`http://localhost:$PORT`) | `server/mock/sim.js` | `npm run sim` 주입 대상(`--url` 이 우선) |
| `IMAP_HOST` (`imap.gmail.com`) `IMAP_PORT` (`993`) `IMAP_MAILBOX` (`INBOX`) | `scripts/inbound-imap.js` | 로컬 E2E 수신 어댑터(§4). TLS로 붙어 메일함을 읽기 전용(EXAMINE)으로 5초마다 연다. 로그인은 `SMTP_USER`·`SMTP_PASS`(같은 Gmail 계정·앱 비밀번호) |
| `IMAP_TO` `IMAP_ALLOWED_FROM` | `scripts/inbound-imap.js` | 받는 주소가 `IMAP_TO` 이고 보낸 주소가 `IMAP_ALLOWED_FROM`(쉼표)인 메일만, 어댑터를 켠 뒤 도착한 것만 넘긴다. `IMAP_TO` 가 허용 발신자에 있으면 시작 거부 — 에이전트 답장이 다시 문의로 들어오는 메일 루프. 미러 모드는 `IMAP_ALLOWED_FROM` 을 쓰지 않는다 |
| `IMAP_CHANNEL` (`support`) | `scripts/inbound-imap.js` `server/index.js` | 넘길 채널(서버는 미러 모드 시작 검사에 쓴다) |
| `IMAP_MODE` (시연) | `scripts/inbound-imap.js` `server/index.js` | `mirror` = 공유 메일함 읽기 전용 미러. 받는 주소가 `IMAP_TO` 인 메일을 발신자와 무관하게 넘기되 `IMAP_TO`·`SMTP_FROM` 발신은 뺀다. 명령은 `EXAMINE`·`BODY.PEEK` 뿐이라 메일함이 바뀌지 않는다. UID 진행을 DB 폴더의 `imap-state.json` 에 저장해 재시작 뒤 이어 읽는다(`DB_PATH=:memory:` 면 어댑터 시작 거부). **어떤 메일도 나가지 않게** 서버와 어댑터 모두 `MAIL_PROVIDER=mock` + `AUTO_SEND` 끔 + `SHADOW_CHANNELS` 에 `IMAP_CHANNEL` 이 없으면 시작을 거부하고(production 이면 `ALLOW_MOCK_MAIL=1` 도), 서버는 이 조건이 아닌 미러 페이로드(`mirror: true`)를 저장하지 않고 503 으로 돌려보낸다(어댑터는 보류했다가 다시 보낸다). 서버와 어댑터는 같은 env 파일로 띄운다 |
| `IMAP_AUTHSERV_ID` | `scripts/inbound-imap.js` | 우리 수신 메일 서버의 authserv-id(예: `mx.google.com`). 이 id 가 붙은 맨 위 `Authentication-Results` 헤더의 `dmarc=` 결과(`pass`·`fail`)를 페이로드 `senderAuth` 로 넘긴다. 그 아래 붙은 헤더는 발신자가 위조할 수 있어 보지 않는다. 비우면 넘기지 않는다(정보 없음 — 기동 시 경고) |
| `AWS_REGION` (`ap-northeast-2`) | `server/aws.js` | SigV4 서명·엔드포인트 리전 |
| `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` `AWS_SESSION_TOKEN` | `server/aws.js` | 로컬 시험용 자격 증명. 비우면 EC2 인스턴스 역할(IMDSv2 — 토큰 → 역할 → 임시 자격 증명, 만료 5분 전 갱신). EC2 에서는 비운다 |
| `SES_QUEUE_URL` `SES_BUCKET` | `scripts/inbound-ses.js` | SES 수신 어댑터(필수). SES 알림(SNS 원문 전달)을 받는 SQS 큐 URL과 원문 MIME 버킷. 큐에서 한 통씩 받아 S3 원문을 `SIM_URL` 의 `/api/inbound` 로 넘긴다. 서버 `/api/health` 가 실패하면 큐를 읽지 않는다 |
| `SES_PREFIX` (`inbound/`) | `scripts/inbound-ses.js` | 객체 키 접두어. 다른 버킷·접두어 밖·이상한 글자의 키는 원문을 받지 않고 지운다 |
| `SES_CHANNELS` | `scripts/inbound-ses.js` | `받는주소=채널` 쉼표 목록(필수). 봉투 수신자로 채널을 고르고, 매핑이 없으면 지운다. 이 주소들과 `SMTP_FROM` 발신은 넘기지 않는다 |
| `SES_MODE` (비움) | `scripts/inbound-ses.js` | `mirror` 면 페이로드에 `mirror: true` 를 싣고, `MAIL_PROVIDER=mock` + `AUTO_SEND` 끔 + 매핑된 채널 전부 `SHADOW_CHANNELS` 가 아니면 시작하지 않는다(종료 코드 2). 설정 오류(401·403, 503 `mirror_unsafe`, 미러의 4xx, S3 403)는 메시지를 돌려놓고 5→10→20→40→60분 정지하며 로그 머리말은 `[ses] 정지` |

### 실 LLM 스모크 실행

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run smoke:llm     # 합성 20건 → 실제 Claude → docs/runs/<날짜>-anthropic.json
```

`server/mock/demo.js --provider=anthropic --record` 와 같다. 케이스별 기대·실제 행동(intent·사유·언어·confidence·kbHit), 지연(ms), 응답 `usage`(input·output·cache 토큰, 호출 수)를 남긴다. 키·URL·본문은 기록하지 않는다. 메일은 항상 mock 이다. 키가 없으면 실행 방법을 출력하고 exit 2. 불일치가 있으면 기록은 남기고 exit 1.

## 2. 배포 토폴로지

```
메일 provider ──웹훅(X-Inbound-Secret)──▶ ┐
운영자 브라우저 ──HTTPS──▶ 리버스 프록시(인증, AUTH_USER_HEADER·X-Proxy-Secret 주입) ─▶ 127.0.0.1:3000 node server/index.js ──▶ Claude API
                                                                     │  ├──▶ SMTP (MAIL_ALLOWED_DOMAINS)
                                                                     │  └──▶ 알림 웹훅 (NOTIFY_WEBHOOK_URL)
                                                                     └──▶ /app/data/cs-agent.db (영속 볼륨)
```

- **단일 컨테이너 1 프로세스.** 수평 확장은 하지 않는다 — 동기 `node:sqlite` 단일 writer 전제다. 규모가 커지면 Postgres 로 옮기고(`db.md` §5) 그때 늘린다.
- **리버스 프록시**(Caddy·nginx·플랫폼 내장)가 HTTPS 와 사람 인증을 맡고 `AUTH_USER_HEADER` 로 사용자를 넘긴다. 프록시가 바깥에서 들어온 같은 이름의 헤더를 지우도록 설정할 것.
- **앱 포트는 프록시만 닿게 한다.** 사용자 헤더는 프록시를 거쳤다는 전제에서만 믿을 수 있다 — 앱 포트에 직접 붙으면 아무 이름이나 넣어 승인할 수 있다. 두 겹으로 막는다: ① 컨테이너 포트를 루프백에만 연다(`-p 127.0.0.1:3000:3000`, 같은 호스트의 프록시만 접근) ② `PROXY_SHARED_SECRET` 을 정하고 프록시가 모든 요청에 `X-Proxy-Secret: <값>` 을 넣게 한다(바깥에서 온 같은 헤더는 지운다). 헤더가 없거나 다르면 `/api` 는 401 이다.
- `AUTH_USER_HEADER` 를 켜면 GET(목록·상세 — 고객 주소·본문)과 SSE(`/api/events`)도 사용자 헤더가 있어야 열린다. 예외는 웹훅 `POST /api/inbound`(`INBOUND_SECRET` 으로 지킨다)와 `GET /api/health`(컨테이너 헬스체크가 프록시 없이 부른다)뿐이다. 정적 파일(대시보드 HTML·JS)은 데이터가 없어 열려 있다.
- 서버는 POST 를 `application/json` 만 받는다(아니면 415) — 쿠키 인증 뒤의 교차 출처 폼 요청을 막는다.
- **헬스체크** `GET /api/health` → `{ok:true}` 뿐(무인증 — 정보를 내주지 않는다). 상세는 인증 뒤 **`GET /api/status`** → `{ok, company, auth, provider:{llm, mail}, version, mailWarning?, testInject, autoSend, senderAuth:'required'|'optional', retentionDays, tokenBudget}`.
- **보안 헤더** — 모든 응답(JSON·정적·SSE·401)에 `content-security-policy: default-src 'self'; frame-ancestors 'none'`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. HSTS 는 TLS 를 끝내는 프록시가 붙인다.
- **시작 검사**(`server/index.js preflight`) — 걸린 것을 전부 출력하고 exit 1: production 이거나 `MAIL_PROVIDER=smtp` + 루프백(`127.0.0.1`·`::1`·`localhost`, 비우면 `127.0.0.1`) 아닌 `HOST` 인데 `INBOUND_SECRET`·`AUTH_USER_HEADER`·`PROXY_SHARED_SECRET` 중 빈 것(예외 없음 — 발송 없는 로컬 시연은 `NODE_ENV` 를 비운다. Docker 는 `-e NODE_ENV=` 만으로는 이미지의 smtp·`0.0.0.0` 이 남아 거부되므로 `-e MAIL_PROVIDER=mock` 도. 루프백 smtp 의 로컬 메일 E2E 와 mock 메일 LAN 시연은 시크릿 없이 뜬다), production + mock 메일(`ALLOW_MOCK_MAIL=1` 없을 때), `CS_ABLATE`, 미러 모드 조건(§7), `RETENTION_DAYS`·`LLM_DAILY_TOKEN_BUDGET` 이 비었거나 1 이상 정수가 아님. 시작은 하되 경고하는 것 둘: smtp + 자동 발송 켬인데 `REQUIRE_SENDER_AUTH` 꺼짐, production + anthropic 인데 일일 토큰 예산 없음. 기동 로그 한 줄에 `auto_send=on|off sender_auth=required|optional retention=<일|off> budget=<토큰|none>`.

레포 루트의 [`Dockerfile`](../Dockerfile):

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY policy ./policy
COPY kb ./kb
COPY web ./web
COPY scripts/inbound-imap.js scripts/subject-request.js scripts/audit-export.js ./scripts/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/cs-agent.db LLM_PROVIDER=anthropic MAIL_PROVIDER=smtp
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
```

- `npm install` 단계가 없다 — dependencies 가 0 이다. `.dockerignore` 가 `data` `docs` `test` `.env*` 를 뺀다.
- 서버 기본 바인드는 `127.0.0.1` 이라 이미지가 `HOST=0.0.0.0` 을 준다(그래야 포트 매핑이 산다). 미러 수신 어댑터(`scripts/inbound-imap.js`)와 정보주체 요청 스크립트(`scripts/subject-request.js`)와 감사 내보내기(`scripts/audit-export.js`)도 이미지에 있어 같은 이미지·같은 볼륨으로 돌린다(§7).
- 이미지 기본은 **`MAIL_PROVIDER=smtp`** 다. `SMTP_HOST`·`SMTP_FROM`·`MAIL_ALLOWED_DOMAINS` 를 넣어야 실제로 나간다(허용 목록이 비면 전부 차단, smtp 설정이 없으면 승인이 502 로 실패하고 초안은 PENDING 으로 돌아간다 — 어느 쪽이든 "보냈다"고 거짓 기록하지 않는다).
- production 에서 `MAIL_PROVIDER=mock` 은 **시작을 거부한다**(`server/index.js`). mock 은 승인해도 SENT 로만 기록되고 고객에게 아무것도 안 나가기 때문이다. 발송 없는 시연이 목적이면 `ALLOW_MOCK_MAIL=1` 을 같이 줘야 뜨고, 그때는 기동 로그·`/api/status.mailWarning`·대시보드 배너가 계속 경고한다.
- `docker run -v cs-agent-data:/app/data -e ANTHROPIC_API_KEY=… -e INBOUND_SECRET=… -e AUTH_USER_HEADER=x-forwarded-user -e PROXY_SHARED_SECRET=… -e SMTP_HOST=… -e SMTP_FROM=… -e MAIL_ALLOWED_DOMAINS=… -p 127.0.0.1:3000:3000 <image>`. 포트는 **루프백에만** 연다 — `-p 3000:3000` 은 모든 인터페이스에 열어 프록시를 우회할 수 있다. 시크릿은 플랫폼 시크릿으로 주입하고 이미지에 굽지 않는다.
- 비루트 `node` 사용자로 돈다. 볼륨 소유권이 맞지 않으면 `chown 1000:1000`.

### 고객 KB·정책의 저장 위치

- 고객 관리자가 콘솔에서 게시한 KB·정책 원문은 **DB 파일**(컨테이너는 `/app/data/cs-agent.db`)에 있다. 게시는 원문을 `versions` 에, 라이브 포인터와 감사 기록을 `config_changes` 에 같은 트랜잭션으로 쓴다(`db.md` §1.4).
- 이미지의 `kb/`·`policy/` 는 **기본값**이다. 고객이 고친 적 없는 대상은 이미지 파일을 쓴다. 기본값으로 되돌리면(`reset`) 다시 이미지 파일을 따른다.
- **백업은 DB 파일 하나다.** 볼륨의 `cs-agent.db` 를 백업하면 라이브 설정과 이력이 함께 간다. 레포나 이미지의 `kb/`·`policy/` 로는 고객 설정을 되살릴 수 없다.
- **파일을 직접 고치는 경로는 없다.** 고객 원문이 라이브인 대상은 이미지 파일을 고쳐도 반영되지 않는다. DB 에 직접 쓰는 것은 운영자 권한이며 콘솔 감사를 거치지 않는다. 그래서 DB 쓰기 권한은 운영자에게만 준다.
- 원문 보기: 콘솔의 기록 탭(내용 보기)과 `scripts/audit-export.js --include-versions`.
- **업그레이드 주의.** 릴리스에서 정책 하한을 조이면 이미 게시된 고객 팩이 그 하한에 걸릴 수 있다. 그 채널은 이미지 팩의 `maxLevel` 을 H 로 돌려 모든 문의를 사람에게 넘긴다(접수 안내 자동 발송 없음). 기동 로그와 접속기록에 `config.invalid` 가 남고, `/api/health` 는 `config:'invalid'` 를 준다. 서버는 뜨지만 그 채널은 고칠 때까지 사람이 맡는다. 이미지 팩 자체가 하한을 어기면 시작을 거부한다. 릴리스 전에 콘솔 정책 검사로 기존 고객 팩을 확인하고, 걸리는 항목은 게시로 고친 뒤 올린다.

## 3. 로컬 vs 배포 — 무엇이 바뀌고 왜

| 항목 | 로컬 | 배포 | 왜 다른가 |
|---|---|---|---|
| LLM | 키 없으면 `mock`, 있으면 `anthropic` | `anthropic` | mock 은 합성 세트를 결정적으로 통과시키는 규칙이라 테스트·데모용. 실제 문의는 LLM 이어야 한다 |
| 메일 수신 | `npm run sim` · 대시보드 "테스트 문의" → `/api/test/inbound` | 메일 provider 웹훅 → `POST /api/inbound` + `X-Inbound-Secret` | 로컬엔 받을 메일함이 없다. 배포에선 공개 엔드포인트라 시크릿 검증이 필수. 테스트 주입은 개발 + mock 메일일 때만 켜진다(그 밖은 `ENABLE_TEST_INJECT=1`) |
| 메일 발송 | `mock` — `dispatches` 에 기록, `messages(out)` 추가 | `smtp`(STARTTLS·AUTH). `MAIL_ALLOWED_DOMAINS` 밖은 차단. production 에서 mock 은 시작 거부(`ALLOW_MOCK_MAIL=1` 예외) | 로컬에서 진짜 고객에게 나가면 안 된다. 배포에서도 허용 목록이 비면 fail-closed, 허구 SENT 도 막는다 |
| DB | `data/cs-agent.db` 파일 | `/app/data` 영속 볼륨의 SQLite → 규모 커지면 Postgres | 파일 하나가 가장 단순. 볼륨만 있으면 재시작에도 남는다 |
| 인증 | 없음(`by` 는 입력값) | 리버스 프록시 + `AUTH_USER_HEADER` 가 `by` 를 덮어씀(`/api` 전부), `PROXY_SHARED_SECRET` + 루프백 포트로 프록시 우회 차단 | 승인 버튼은 발송 권한이다. 누가 눌렀는지가 감사 로그의 핵심. 목록·상세엔 고객 주소·본문이 있다 |
| 알림 | 대시보드 SSE 만 | + `NOTIFY_WEBHOOK_URL` (넘김 · 승인 대기 초안 · 자동 발송 막힘 · 사람 전담 종결 케이스의 고객 회신 재오픈) | 대시보드를 안 보고 있어도 사람이 알아야 한다 |
| 비밀 | `.env` | 플랫폼 시크릿 | 이미지·레포에 키를 두지 않는다 |
| 실행 | `npm start` | Dockerfile, `/api/health` 헬스체크, stdout 로그 수집 | |
| 자율 등급 | 정책 팩 그대로(L1) — 승인 큐가 보여야 데모가 된다 | 채널별 **L0 섀도부터**(`SHADOW_CHANNELS`), 기준 통과 후 L1 | 실제 고객에겐 사람이 먼저 답하고 에이전트는 기록만. 통과 기준은 §5 |

## 4. 인바운드 웹훅

```
POST /api/inbound
X-Inbound-Secret: <INBOUND_SECRET>
Content-Type: application/json

{ "channel": "support", "from": "customer@example.com", "name": "홍길동",
  "subject": "영수증 요청", "body": "...", "threadId": "<provider thread id>",
  "providerMessageId": "<Message-ID 헤더 값>", "autoSubmitted": false,
  "inReplyTo": "<In-Reply-To 헤더 값>", "references": "<References 헤더 값>",
  "occurredAt": "2026-10-24T01:23:45Z", "knownFacts": { "회사": "…" },
  "senderAuth": "pass", "replyTo": "<Reply-To 주소>" }
```

- 시크릿 불일치·누락은 401. 비교는 `crypto.timingSafeEqual`.
- `channel` 은 `[a-z0-9_-]` 이름이고 정책 팩이 있어야 한다(아니면 400). 채널 이름은 팩·KB 파일 경로가 되므로 이 모양 밖은 없는 채널로 본다.
- `providerMessageId` 로 `claims(mailbox:…)` 와 `messages.provider_message_id` 가 중복 수신을 막는다 — 웹훅 재전송은 안전하다(`{duplicate: true}`).
- `autoSubmitted` 는 어댑터가 `Auto-Submitted`·`X-Autoreply`·`Precedence` 헤더를 보고 채운다. 본문 키워드만으로 자동 회신을 판정하지 않는다.
- `occurredAt`·`senderAuth` 는 시크릿으로 검증된 요청만 넘길 수 있다(테스트 주입·`INBOUND_SECRET` 없는 서버에서는 지운다).
- `senderAuth` = 어댑터가 확인한 발신자 인증 결과 `pass`·`fail`(그 밖의 값은 정보 없음 — `messages.sender_auth` NULL). `fail` 은 설정과 무관하게 1차 거르기에서 `sender_unverified` 로 넘기고 LLM 을 부르지 않는다(브리핑도 코드). 정보 없음은 `REQUIRE_SENDER_AUTH` 가 켜져 있으면(production 기본) 자동 메일(L2 자동 발송·접수 안내)이 없다 — 회차는 돌고 초안은 승인 대기. 막는 것은 자동 메일뿐이고 사람 승인 초안은 그대로 만든다. 레포의 IMAP 어댑터는 `IMAP_AUTHSERV_ID` 가 있을 때만 넘긴다.
- `replyTo` 는 문의 폼 메일(`FORM_SENDER_DOMAINS`)의 고객 주소 후보다. 폼 메일은 Reply-To → 제목의 주소 → 본문 이메일 칸 순으로 고객 주소를 뽑아 케이스 주소와 메시지 발신자를 그 주소로 두고 `sender_auth=form` 으로 저장한다. 누구 주소든 칠 수 있는 값이라 `REQUIRE_SENDER_AUTH` 와 무관하게 자동 메일이 없고 사람 승인 초안만 만든다. 못 뽑으면 `unclear` 로 넘긴다.
- `mirror: true` 는 미러 어댑터가 싣는다. 서버가 무발송·섀도 설정이 아니면 저장하지 않고 503 으로 돌려보낸다(§7).
- `threadId` 가 `case_threads` 에 있으면 그 케이스에 메시지 추가(T2). 없으면 `inReplyTo`·`references`(문자열 또는 배열, 꺾쇠 있든 없든)가 받거나 보낸 메일의 `provider_message_id` 와 맞는지 보고, 맞으면 그 케이스에 붙이고 그 `threadId` 도 묶는다. 둘 다 아니면 새 케이스(T1). CLOSED 케이스면 같은 케이스를 다시 연다(응대 주체·담당자 그대로 — spec 부록 F.5). 자동 회신(`autoSubmitted`·부재중 표지)·빈 본문은 다시 열지 않고 붙기만 한다.
- 그래서 메일 어댑터는 `providerMessageId` 에 수신 메일의 `Message-ID` 헤더를 그대로 넣고 `In-Reply-To`·`References` 를 넘긴다. `smtp` 발송은 답장에 `In-Reply-To`(답하는 고객 메일)·`References` 를 달고, 보낸 메일의 `Message-ID` 를 `messages.provider_message_id` 와 케이스 스레드로 남긴다.
- 메일 provider 쪽 어댑터(웹훅 페이로드 → 위 JSON)는 provider 마다 다르므로 서버 바깥(함수·작은 프록시)에 둔다. 서버는 이 JSON 하나만 안다.
- 로컬 E2E 용 어댑터 하나는 레포에 있다: `node scripts/inbound-imap.js`. 실제 메일함(IMAP)의 새 메일을 위 JSON으로 바꿔 `X-Inbound-Secret` 과 함께 넘긴다. 시연 계정 하나로 돌릴 때는 Gmail 별칭을 쓴다 — 고객 역할은 `본인@gmail.com`, 수신함은 `IMAP_TO=본인+cs@gmail.com`, `IMAP_ALLOWED_FROM=본인@gmail.com`, `MAIL_ALLOWED_DOMAINS=gmail.com`, `SMTP_FROM=본인+cs@gmail.com`(고객이 답장하면 별칭으로 돌아와 같은 케이스에 붙는다). 서버(`MAIL_PROVIDER=smtp`)와 어댑터에 같은 환경 변수를 준다. 그 env 파일에 `NODE_ENV=production` 이 있거나 `HOST` 가 루프백이 아니면 `INBOUND_SECRET`·`AUTH_USER_HEADER`·`PROXY_SHARED_SECRET` 을 넣어야 시작한다(`NODE_ENV` 비움 + `HOST` 비움이면 없어도 된다). 실제 회사 CS 메일함에는 시연 모드로 붙이지 않는다 — 읽기만 할 때는 미러 모드(§7).
- 메일 계정 없이 같은 경로를 돌리려면 `npm run demo:mail`. 루프백에 가짜 메일 서버(IMAP·SMTP)와 고객 메일함 화면(`http://localhost:2600`)을 띄우고, 서버(`MAIL_PROVIDER=smtp`)와 위 어댑터를 그 서버에 붙여 실행한다. 실행마다 임시 DB·인증서·비밀번호를 새로 만들고 끝나면 지운다. `ANTHROPIC_API_KEY` 가 있으면 LLM도 실제로 부르고, `-- --check` 는 영수증·환불·로그인 세 문의를 보내 결과를 확인한 뒤 끝낸다.

## 5. 롤아웃 — L0 → L1 → L2

| 단계 | 스위치 | 통과 기준 |
|---|---|---|
| 0 로컬 | `npm test`, `npm run demo` | 테스트 통과, 합성 세트 기대 행동 100% 일치 |
| 1 섀도 (채널 하나씩) | `SHADOW_CHANNELS=<channel>` (또는 팩 `shadow: true`) | 사람이 섀도 초안을 "그대로 보내도 되는가"로 good / needs_edit / critical 평가(대시보드 "섀도 평가" 목록 → `rateShadow`) |
| 2 승인 | `SHADOW_CHANNELS` 에서 빼기, `AUTO_SEND=0` (L2 intent도 승인 대기) | `/api/stats.promotion.<channel>.eligible = true` |
| 3 자동 (L2) | `AUTO_SEND` 비우기 — 팩 `maxLevel: L2` + intent `level: L2`만 승인 없이 발송, 넘김엔 접수 안내(`ackReply`) | 2026-10-27 결정으로 팩에 바로 켰다(support 탈퇴·영수증·구독 해지, onboarding 온보딩 신청·미팅, sales 서비스 질문). 실제 LLM 평가 전이라 치명 1건이면 `AUTO_SEND=0` |

**고객 콘솔의 게이트(L2 확대).** 콘솔에서 자동 발송을 넓히는 변경(예: intent 를 L1 에서 L2 로 올리거나, L2 intent 의 설명·절을 바꾸거나, 금지어를 지우는 것)은 게시·되돌리기·기본값 복원 모두 **결과 자동 발송 집합 전체**가 승격 기준을 통과해야 한다. 집합의 모든 intent 가 `eligible` 이고 채널 치명 건수가 0 이어야 한다. 막히면 화면이 막힌 intent 를 L1 로 내려 다시 게시하게 안내한다. 표본이 없는 새 intent 는 그 자리에서 막힌다. 릴리스 단계는 이 게이트를 그대로 따른다: 섀도 평가가 쌓인 뒤에만 L2 를 넓힌다. 이 기준은 `/api/stats` 와 `/api/report` 의 승격 표에서 그대로 읽는다.

승격 지표는 `/api/stats.promotion`(`server/cases.js promotion`)이 채널마다 계산한다 — SENT 에이전트 초안(무수정 = `final_body` 없음, `edit_tags` 에 `critical` 이면 치명)과 섀도 평가를 합친다. 기준은 코드 상수 `server/policy.js PROMOTION`: **누적 50건 · 무수정 90% 이상 · 치명 0건**. 같은 표본을 intent 별로 나눈 표는 `/api/report.promotion`·`/api/report/promotion.csv`(대시보드 "리포트")다. 이 표의 등급 칸은 팩에 적힌 값이 아니라 지금 실제로 도는 등급이다 — 섀도 채널(팩 `shadow`·`SHADOW_CHANNELS`)은 L0, 팩 `maxLevel` 이 intent 등급을 깎고(`AUTO_SEND=0` 이면 L2 도 L1), H 는 어느 쪽에 있든 H.

치명 오류 정의: ① 금액·할인·수수료를 말함 ② 날짜·환불·계약을 약속함 ③ 수신자 오류 또는 다른 고객 정보 노출 ④ 사람이 맡은 케이스에 발송 ⑤ 치환 안 된 슬롯. **1건이라도 나오면 그 채널을 `SHADOW_CHANNELS` 에 넣는다**(자동 발송이면 먼저 `AUTO_SEND=0`) — 환경 변수만 바꿔 재시작하면 되고 재빌드는 필요 없다. 자동 발송분(`approved_by=agent:auto`)과 접수 안내(`ACK`)는 승격 지표·무수정 승인률에 넣지 않는다 — 사람이 본 적 없는 초안이다.

## 6. 일부러 만들지 않은 것

| 안 만든 것 | 이유 | 열려면 |
|---|---|---|
| 고객 무회신 팔로업 타이머 | 새 자동 발송이다. 스위퍼는 상태만 닫고 고객에게 보내지 않는다 | L1 안정 후 |
| 고객이 직접 연 새 스레드에 자동 응대 | 웹훅·폼으로 들어온 문의만 케이스 | 채널 정책 팩에 입구 추가 |
| 한국어·영어 밖 언어 | 그 언어 KB·guard 패턴이 없다 | 채널 `languages` + `kb/<channel>.<lang>.md` + guard 패턴 |
| 수평 확장·외부 큐 | SQLite 단일 프로세스로 충분한 규모 | Postgres 전환 뒤 |
| 첨부 파일 해석 | 첨부 유무만 안다 | 별도 파서 |

## 7. 파일럿 운영 — 미러 · 보존 · 접속기록

### 미러 모드 (공유 메일함 읽기 전용)

`IMAP_MODE=mirror` 어댑터는 실제 CS 공유 메일함을 읽어 섀도로 평가한다. 받는 주소가 `IMAP_TO` 인 메일을 발신자와 무관하게 넘기고, 우리 주소(`IMAP_TO`·`SMTP_FROM`) 발신은 뺀다. 명령은 `EXAMINE`·`BODY.PEEK` 뿐이라 메일함(읽음 표시 포함)이 바뀌지 않는다.

- **어떤 메일도 나가지 않는다.** 서버 시작 검사와 어댑터 `config()` 가 둘 다 `MAIL_PROVIDER=mock` + `AUTO_SEND` 끔 + `SHADOW_CHANNELS` 에 `IMAP_CHANNEL`(기본 `support`)을 요구하고, 하나라도 없으면 시작하지 않는다(production 서버는 `ALLOW_MOCK_MAIL=1` 도). mock 메일이라 사람 승인·직접 답장 버튼도 실제로 나가지 않는다.
- **서버가 한 번 더 막는다.** 어댑터는 미러 페이로드에 `mirror: true` 를 싣고, 서버는 그때 mock 메일·자동 발송 꺼짐·그 채널 섀도 중 하나라도 아니면 **저장하지 않고 503 `mirror_unsafe`** 로 돌려보낸다(케이스·메시지 0행). 어댑터와 서버 env 가 달라도 실고객 메일이 자동 발송 경로에 들어가지 않는다. 어댑터는 5xx 를 보류로 보고 다음 바퀴에 같은 메일부터 다시 보낸다 — 서버 설정을 고쳐 다시 띄우면 이어진다.
- **이어 읽기.** 읽은 위치를 DB 폴더의 `imap-state.json`(`{validity, last}`, 메일마다 임시 파일 + rename)에 남겨 재시작 뒤 이어 읽는다. 파일이 없으면 지금부터, UIDVALIDITY 가 바뀌면 기준점부터 다시(경고, 그 사이 메일은 넘기지 않는다). `DB_PATH=:memory:` 면 어댑터가 시작하지 않는다.
- **서버와 어댑터는 같은 env 파일·같은 이미지·같은 볼륨으로** 띄운다. 어댑터는 `http://localhost:$PORT` 로 넘기므로 서버 컨테이너의 네트워크를 같이 쓴다.

```bash
docker run -d --name cs-agent --env-file pilot.env -v cs-agent-data:/app/data -p 127.0.0.1:3000:3000 <image>
docker run -d --name cs-imap  --env-file pilot.env -v cs-agent-data:/app/data --network container:cs-agent <image> \
  node --no-warnings=ExperimentalWarning scripts/inbound-imap.js
```

### 원문 보존 · 파기

- `RETENTION_DAYS=N` 이면 스위퍼가 종결(`CLOSED`) 뒤 N일 지난 케이스를 케이스마다 한 트랜잭션으로 **제자리 가명화**한다(`server/retention.js purge`). 비우면 끈다(기본).
- 비우는 것: 메일 본문·인용 제거본·발신 주소·제목·고객 이름·폼 값·초안 본문·메모·섀도 평가 메모·폐기 사유·발송 오류 문구·판단 입력 요약과 출력·브리핑. `case_threads` 행은 지운다 — 옛 스레드로 온 회신은 새 케이스가 된다. LLM 재시도 예약·회차 claim 도 지워 파기된 케이스에 회차가 다시 돌지 않고, 회차가 도는 중(리스)인 케이스는 건너뛰고 다음에 다시 본다.
- 파일 DB 는 `secure_delete` 를 켜고 파기 묶음 뒤 WAL 을 비운다(`wal_checkpoint(TRUNCATE)`) — 지운 원문이 빈 페이지·WAL 에 남지 않게. 서버가 읽는 중이면 WAL 을 다 못 비울 수 있다(뒤의 체크포인트가 덮는다).
- 남는 것: 상태·행동·intent·`edit_tags`·승인자·`final_body` 의 NULL 여부(무수정 승인률·승격 지표가 파기 전후 같다), `llm_calls`(본문 없음), `claims` 의 `mailbox:<Message-ID>`(중복 수신 방지 — Message-ID 에 발신 도메인 정도가 보일 수 있다), 활동 `purge`(`reason`: `retention` · `subject_request`).
- 파기된 케이스는 대시보드에 "원문 파기됨"으로 보이고, 그 케이스·초안에 대한 POST(승인·폐기·메모·평가·인수·반환·보류·종결·직접 답장)는 전부 409 `purged` 다.
- 승인 대기(`AWAITING_APPROVAL`)는 자동 종결되지 않으므로 파기되지도 않는다 — 사람이 처리하거나 종결해야 기간이 시작된다.
- **켜기 전에** 치명(critical) 평가 건과 필요한 증거를 내보낸다(`/api/report/promotion.csv`, 케이스 상세). 값과 적법성은 법무 결정이고, 백업 파기는 이 기능 밖이다(백업에는 원문이 남는다).

### 정보주체 요청 (열람 · 삭제)

```bash
node --no-warnings=ExperimentalWarning scripts/subject-request.js export <email> --by <이름>  # 그 주소의 케이스 묶음 JSON → stdout
node --no-warnings=ExperimentalWarning scripts/subject-request.js delete <email> --by <이름>  # 종결 케이스를 위와 같이 가명화
```

- 대상은 케이스 주소 또는 받은 메시지 발신 주소가 그 이메일인 케이스다(폼 메일은 둘이 다를 수 있다).
- 둘 다 `--by`(처리자)가 있어야 한다(없으면 exit 2) — 접속기록에 누가 열람·삭제했는지 남는다.
- `delete` 는 종결 케이스만 다룬다. 종결 아닌 케이스가 있으면 그 id 를 출력하고 exit 1 — 대시보드에서 종결한 뒤 다시 실행한다. 그 사이 회신으로 다시 열렸거나 회차가 도는 중인 케이스는 건너뛰고 id 를 출력한다(exit 1).
- 서버와 같은 `DB_PATH` 로 실행한다. 서버가 돌고 있어도 된다(파일 DB 는 잠금을 5초 기다린다). DB 파일이 없으면 exit 2(경로 오타를 "대상 없음"으로 끝내지 않는다).
- 이미지에 이 스크립트가 있다. 컨테이너 볼륨에 대고 돌린다: `docker run --rm -v cs-agent-data:/app/data <image> node --no-warnings=ExperimentalWarning scripts/subject-request.js export <email> --by <이름>`.
- 처리 정지 요구(파기 없이 처리만 멈춤)는 아직 없다.

### 고객 KB·정책 콘솔 (관리자)

- 대시보드 상단 「지식·정책」 버튼으로 연다. 채널별 KB(절 목록·원문), 정책 팩 편집 폼, 기록 탭을 본다. **읽기는 인증된 누구나 한다.** 쓰기는 관리자만 한다.
- **쓰기 조건은 두 가지가 다 맞아야 한다.** ① actor 가 `ADMIN_USERS` 에 있다. ② 쓰기 경로가 믿을 만하다. 믿을 만한 경로는 둘 중 하나다.
  - 사용자 헤더(`AUTH_USER_HEADER`)와 프록시 시크릿(`PROXY_SHARED_SECRET`)이 둘 다 설정돼 있고, 프록시 시크릿이 맞는 요청. actor 는 헤더 값이다.
  - 그 밖의 설정: 루프백 소켓에서 온 요청이고, `Host`·`Origin` 이 루프백 이름(`localhost`·`127.0.0.1`·`[::1]`)이며, `x-forwarded-for`·`forwarded`·`x-real-ip`·`via` 같은 중계 헤더가 없는 요청. actor 는 `AUTH_USER_HEADER` 가 있으면 헤더 값, 없으면 화면의 검토자 이름(`body.by`)이다.
  - 둘 다 아니면 `403 console_write_untrusted` 이고 접속기록에 `console.denied` 가 남는다. 판단은 본문을 읽기 전에 한다.
- **같은 호스트의 리버스 프록시를 쓰면 `PROXY_SHARED_SECRET` 을 반드시 설정한다.** 시크릿이 없고 프록시가 전달 헤더를 빼고 루프백으로 넘기면, 그 요청은 루프백 경로로 들어와 사용자 이름을 위조할 수 있다.
- 게시 순서: 편집 또는 초안 → 검사(오류·경고, 바뀐 절 비교, L2 영향, 새 링크 호스트) → 메모 → 게시. 오류가 있으면 게시되지 않는다. 확인이 필요한 게시(L2 intent 가 있는 채널의 KB 절 변경, 새 링크 호스트)는 화면의 확인 체크를 거쳐야 한다. 검사 규칙은 `docs/spec.md` 부록 H 다.
- 되돌리기와 기본값 복원도 같은 검사와 같은 게이트를 지난다. 기록 탭에서 과거 원문을 보고 그 버전으로 되돌릴 수 있다.
- **매뉴얼 변환(관리자만).** MD·TXT·HTML·DOCX·PDF 파일을 올리면 서버가 백그라운드로 KB 초안을 만든다. 초안은 사람이 검토해 게시할 때만 라이브가 된다. HWP 는 한글에서 PDF 로, DOC 는 Word 에서 DOCX 로 저장해 올린다. **올린 매뉴얼 본문은 변환을 위해 LLM 제공자 API 로 전송된다.** 화면에 이 고지가 고정으로 나온다. 개인정보나 내부 전용 문서는 빼고 올린다. mock 모드에서는 외부로 나가지 않는다. 고지 문안은 `docs/compliance.md` 를 본다.

### 감사 내보내기 (CLI)

```bash
AUDIT_SALT=<32자 이상> node --no-warnings=ExperimentalWarning scripts/audit-export.js --from 2026-11-01 --to 2026-11-30 --by <이름> --out <파일> [--channel <ch>] [--bodies] [--include-versions]
```

- 서버와 같은 `DB_PATH` 파일을 읽는다. 서버가 돌고 있어도 된다. 파일 DB 가 없으면 exit 2.
- `--from`·`--to` 는 한국 날짜다. `--from` 0시부터 `--to` 다음 날 0시 전까지를 본다. `--by`(처리자), `--from`, `--to`, `--out` 은 필수다.
- `<파일>` 과 `<파일>.manifest.json` 을 새로 만든다. 둘 중 하나라도 있으면 덮지 않고 exit 2. `AUDIT_SALT` 가 없거나 32자보다 짧아도 exit 2 다. 실행 중 오류는 exit 1.
- 기본은 본문과 자유 텍스트를 뺀다. `--bodies` 는 메일 본문(PII 마스킹 후)과 게시 메모를 넣는다. `--include-versions` 는 기간 안의 행이 참조한 원문을 넣는다.
- 출력은 NDJSON 이다(줄마다 `{"t":"<종류>", …}`). 종류는 `case` `message` `decision` `draft` `handoff` `activity` `config_change` `llm_call` `version` 이다. 줄마다 정해진 열만 나간다. 고객 주소는 `customer_hash`(HMAC-SHA256)로만 나간다. LLM 이 만든 문자열은 알려진 코드값만 남고 나머지는 `(other)` 다.
- manifest 에는 건수, 파일 전체의 sha256, 메일 표시 문구의 해시(`templates.email`), 표시와 발송에 영향을 준 설정값(`env`), 앱 버전이 든다. 접속기록에 `audit.export` 한 줄이 남는다.

### 접속기록

- 파일 DB 일 때 DB 폴더의 `access.jsonl`(컨테이너는 `/app/data/access.jsonl`)에 JSON 한 줄씩 `{at, action, user, ip, …}` 를 덧붙인다. `:memory:` 면 끈다.
- `action`: `case.list`(필터 — 검색어는 원값 없이 `hasQuery`·`qLen`, 건수) · `case.view`(`caseId`) · `shadow.list` · `events.open`(SSE) · `auth.fail`(사유 `proxy`·`user`·`inbound`, 메서드·경로) · `send`(사람 승인·자동 발송, `by`·`auto`, HTTP 밖이라 `ip` 없음) · `subject.export`·`subject.delete`(`by`, 건수).
- 콘솔과 감사 action: `config.publish` · `config.rollback` · `config.reset` · `kb.convert` · `config.invalid`(깨진 고객 설정을 찾았을 때) · `console.denied` · `audit.export`. 게시 메모 원문은 넣지 않고 대상과 해시만 넣는다.
- `ip` 는 소켓 주소다. `x-forwarded-for` 는 `PROXY_SHARED_SECRET` 이 확인된 요청에서만, 프록시가 붙인 마지막 값을 쓴다.
- 고객 본문·주소는 넣지 않는다. 쓰기 실패는 stderr 에만 남기고 요청·발송은 그대로 간다. 단순화: 파일 하나에 덧붙이기만 한다 — 회전·위변조 방지·외부 보관과 보관 기간은 운영에서 정한다.

### LLM 계량 · 예산 · 리포트

- LLM 호출마다 `llm_calls` 한 행(성공·실패, 에이전트·모델·토큰·지연, 오류는 코드·HTTP 상태만).
- `LLM_DAILY_TOKEN_BUDGET` — 오늘(UTC, 한국 시간 09:00 초기화) 입력+출력 합계가 상한 이상이면 LLM 을 부르지 않고 재시도 없이 `llm_error` 로 넘긴다(판단 기록에 `budget: true`, 처음 막힌 날 경고 한 줄). 단순화: 동시 회차가 있으면 몇 호출 넘을 수 있다.
- `GET /api/report` → `{llm:{today, budget:{limit, used}, total, perCase, byAgent, models}, promotion:{criteria, rows}}`(비용은 단가 둘이 있을 때만), `GET /api/report/promotion.csv`(intent 별 승격 표 — `=`·`+`·`-`·`@`·TAB·CR 로 시작하는 칸은 `'` 를 붙인다), `GET /api/shadow?channel=&limit=`(미평가 섀도 초안, 파기된 케이스 제외). 셋 다 인증 대상이고 대시보드 "리포트"·"섀도 평가"가 쓴다.

### 파일럿 설치 체크리스트

신규 설치의 코드 기본값(팩 그대로 L2 자동 발송)은 바꾸지 않았다. 아래는 파일럿 **권장값**이다.

| 항목 | 권장 · 확인 |
|---|---|
| 섀도 | `SHADOW_CHANNELS=<받는 채널 전부>`, `AUTO_SEND=0` |
| 미러 | `IMAP_MODE=mirror` + `MAIL_PROVIDER=mock` + `AUTO_SEND=0` + `SHADOW_CHANNELS` 에 `IMAP_CHANNEL` + production 이면 `ALLOW_MOCK_MAIL=1`. `IMAP_TO`(공유 메일함 주소)·`SMTP_USER`·`SMTP_PASS`(IMAP 로그인)·`INBOUND_SECRET`. 서버·어댑터 같은 env 파일 |
| 인증 | production(또는 smtp + 루프백 아닌 `HOST`)은 `INBOUND_SECRET`·`AUTH_USER_HEADER`·`PROXY_SHARED_SECRET` 필수, 포트는 `-p 127.0.0.1:3000:3000` |
| 발신자 인증 | `IMAP_AUTHSERV_ID` = 우리 수신 서버의 authserv-id(예: `mx.google.com`). `REQUIRE_SENDER_AUTH` 는 비워 둔다(production 켬) |
| 문의 폼 | `FORM_SENDER_DOMAINS` 에 폼 발신 도메인 |
| 보존 | `RETENTION_DAYS` — 값은 법무 결정. 켜기 전에 치명 평가 건을 내보낸다 |
| 예산 | `LLM_DAILY_TOKEN_BUDGET`, 비용을 보려면 `LLM_PRICE_INPUT_PER_MTOK`·`LLM_PRICE_OUTPUT_PER_MTOK` |
| 알림 | 미러 섀도 동안 `NOTIFY_WEBHOOK_URL` 은 비운다(넘김이 담당자를 부르지 않게) |
| env 파일 | `.env.example` 을 `--env-file` 로 그대로 쓰지 않는다 — 빈 `NODE_ENV=`·`HOST=` 가 이미지 ENV 를 덮어 production 검사가 꺼지고 컨테이너 안 `127.0.0.1` 에 바인드된다(헬스체크는 안에서 부르므로 healthy 인데 밖에서는 안 열린다). 빈 줄은 지우고 쓴다 |
| 관리자 | `ADMIN_USERS` 에 고칠 사람만 적는다. 프록시가 사용자 헤더에 넣는 값과 같은 형식이다. 바꾸면 재시작 |
| 콘솔 쓰기 경로 | 프록시를 쓰면 `AUTH_USER_HEADER` 와 `PROXY_SHARED_SECRET` 을 둘 다 설정한다. 앱 포트는 루프백에만 연다 |
| 감사 키 | `AUDIT_SALT`(32자 이상)를 운영 시크릿에 둔다. 감사 내보내기마다 같은 값을 쓰고 바꾸지 않는다 |
| 매뉴얼 전송 고지 | 매뉴얼 변환 화면의 고지 문구를 고객 약관·처리방침에 맞춘다(`docs/compliance.md`) |
| 업그레이드 | 릴리스 전에 콘솔 정책 검사로 고객 팩을 확인한다. 기동 로그에 `config.invalid` 가 없어야 한다 |
| 확인 | 기동 로그 `auto_send=off sender_auth=… retention=… budget=…`, `/api/status`, 대시보드 "섀도 평가" 목록 |
