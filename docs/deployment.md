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

코드가 읽는 환경 변수 전부다(`grep -rn process.env server scripts` 와 `server/mail/smtp.js config` 기준). `.env.example` 도 같은 목록이고, `test/fix2-core.test.js` C-6 이 둘이 코드와 맞는지 확인한다.

| 변수 | 읽는 곳 | 뜻 |
|---|---|---|
| `PORT` (3000) | `server/index.js` | 서버 포트 |
| `HOST` (모든 인터페이스) | `server/index.js` | 바인드 주소. 로컬 시연은 `127.0.0.1`(`npm run demo:mail` 이 그렇게 띄운다). 컨테이너 안에서는 비워 두고 `-p 127.0.0.1:3000:3000` 으로 막는다 |
| `DB_PATH` (`data/cs-agent.db`, 컨테이너는 `/app/data/cs-agent.db`) | `server/db.js` | SQLite 파일. 테스트는 `:memory:` |
| `NODE_ENV` | `server/index.js` | `production` 이면 테스트 주입(`/api/test/inbound`)이 꺼지고, `MAIL_PROVIDER=mock` 이면 **시작을 거부한다**(`ALLOW_MOCK_MAIL=1` 이면 경고만) |
| `LLM_PROVIDER` | `server/llm/index.js` | `mock` · `anthropic`. 없으면 `ANTHROPIC_API_KEY` 가 있을 때 `anthropic`, 없을 때 `mock`. 테스트·데모는 mock 강제 |
| `ANTHROPIC_API_KEY` | `server/llm/anthropic.js` | Claude API 키. `npm run smoke:llm` 은 없으면 거부 |
| `ANTHROPIC_MODEL` (`claude-sonnet-5-5`) | `server/llm/anthropic.js` | 모델 id |
| `ANTHROPIC_BASE_URL` (`https://api.anthropic.com/v1/messages`) | `server/llm/anthropic.js` | Messages 엔드포인트. `fetch` 직접 호출, `anthropic-version: 2026-10-21`, JSON 은 `output_config.format: json_schema` |
| `LLM_TIMEOUT_MS` (30000) | `server/llm/anthropic.js` | LLM 호출 하나의 제한 시간(`AbortSignal.timeout`) |
| `LLM_RETRY_SCALE` (1) | `server/loop.js` `server/llm/index.js` | 장애 재시도 간격(2·5·10·30분)과 차단기 열림 시간(60초)의 배수. 테스트에서 줄인다 |
| `LLM_MOCK_DELAY_MS` (0) | `server/llm/mock.js` | mock 응답 지연. 대시보드에서 "돌아가는 중"을 보려면 1500 정도 |
| `MAIL_PROVIDER` (`mock`, 컨테이너는 `smtp`) | `server/mail/index.js` | `mock` DB 기록만 / `smtp` 실제 발송 |
| `MAIL_ALLOWED_DOMAINS` | `server/mail/index.js` | 쉼표 구분. 실발송 provider 는 **이 목록 밖 수신자를 전부 막는다**(비어 있으면 전부 차단 — fail-closed) |
| `ALLOW_MOCK_MAIL` | `server/index.js` | `1` 이면 production 에서도 mock 메일로 시작한다(발송 없는 시연용). SENT 가 허구라 기동 경고·`/api/health.mailWarning`·대시보드 배너가 뜬다 |
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
| `ENABLE_TEST_INJECT` | `server/index.js` | `1` 이면 production 에서도 `/api/test/inbound`(대시보드 "테스트 문의"·sim)를 켠다 |
| `SHADOW_CHANNELS` | `server/policy.js` | 쉼표 구분 채널 이름. 이 채널은 정책 팩과 무관하게 섀도(L0) — **재빌드 없는 kill switch** |
| `AUTO_SEND` | `server/policy.js` | `1`·`true`·`on`·`yes` 또는 비우면 켜짐. 그 밖의 값(`0`·`false`·`off`·오타)은 L2 자동 발송과 넘김 접수 안내를 전부 끈다(L2 intent도 승인 대기, fail-closed). `MAIL_PROVIDER=smtp` 인데 `INBOUND_SECRET` 이 비면 값과 상관없이 꺼진다. 시작 로그에 `auto_send=on`/`off` — **재빌드 없는 kill switch** |
| `NOTIFY_WEBHOOK_URL` | `server/notify.js` | Slack 호환 웹훅. 넘김·승인 대기 초안을 알린다. 본문은 채널·케이스 번호·사유만(PII 없음) |
| `AUTO_CLOSE_DAYS` (30) | `server/sweeper.js` | 마지막 메시지·활동 뒤 이 기간 조용한 케이스를 스위퍼가 닫는다(승인 대기·발송 중 제외, 고객에게는 아무것도 안 보냄) |
| `INTERNAL_DOMAINS` | `server/prefilter.js` | 쉼표 구분. 이 도메인 발신은 사내 메일로 보고 무시 |
| `COMPANY_NAME` (`ACME`), `AGENT_NAME` (`Aria`) | `server/mail/index.js` `server/loop.js` `server/index.js` | 메일 템플릿 인사·자기소개, `/api/health.company` |
| `SIM_URL` (`http://localhost:$PORT`) | `server/mock/sim.js` | `npm run sim` 주입 대상(`--url` 이 우선) |
| `IMAP_HOST` (`imap.gmail.com`) `IMAP_PORT` (`993`) `IMAP_MAILBOX` (`INBOX`) | `scripts/inbound-imap.js` | 로컬 E2E 수신 어댑터(§4). TLS로 붙어 메일함을 읽기 전용(EXAMINE)으로 5초마다 연다. 로그인은 `SMTP_USER`·`SMTP_PASS`(같은 Gmail 계정·앱 비밀번호) |
| `IMAP_TO` `IMAP_ALLOWED_FROM` | `scripts/inbound-imap.js` | 받는 주소가 `IMAP_TO` 이고 보낸 주소가 `IMAP_ALLOWED_FROM`(쉼표)인 메일만, 어댑터를 켠 뒤 도착한 것만 넘긴다. `IMAP_TO` 가 허용 발신자에 있으면 시작 거부 — 에이전트 답장이 다시 문의로 들어오는 메일 루프 |
| `IMAP_CHANNEL` (`support`) | `scripts/inbound-imap.js` | 넘길 채널 |

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
- **헬스체크** `GET /api/health` → `{ok, auth, provider:{llm, mail}, version, mailWarning?, testInject}`.

레포 루트의 [`Dockerfile`](../Dockerfile):

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY policy ./policy
COPY kb ./kb
COPY web ./web
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/cs-agent.db LLM_PROVIDER=anthropic MAIL_PROVIDER=smtp
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
```

- `npm install` 단계가 없다 — dependencies 가 0 이다. `.dockerignore` 가 `data` `docs` `test` `.env*` 를 뺀다.
- 이미지 기본은 **`MAIL_PROVIDER=smtp`** 다. `SMTP_HOST`·`SMTP_FROM`·`MAIL_ALLOWED_DOMAINS` 를 넣어야 실제로 나간다(허용 목록이 비면 전부 차단, smtp 설정이 없으면 승인이 502 로 실패하고 초안은 PENDING 으로 돌아간다 — 어느 쪽이든 "보냈다"고 거짓 기록하지 않는다).
- production 에서 `MAIL_PROVIDER=mock` 은 **시작을 거부한다**(`server/index.js`). mock 은 승인해도 SENT 로만 기록되고 고객에게 아무것도 안 나가기 때문이다. 발송 없는 시연이 목적이면 `ALLOW_MOCK_MAIL=1` 을 같이 줘야 뜨고, 그때는 기동 로그·`/api/health.mailWarning`·대시보드 배너가 계속 경고한다.
- `docker run -v cs-agent-data:/app/data -e ANTHROPIC_API_KEY=… -e INBOUND_SECRET=… -e AUTH_USER_HEADER=x-forwarded-user -e PROXY_SHARED_SECRET=… -e SMTP_HOST=… -e SMTP_FROM=… -e MAIL_ALLOWED_DOMAINS=… -p 127.0.0.1:3000:3000 <image>`. 포트는 **루프백에만** 연다 — `-p 3000:3000` 은 모든 인터페이스에 열어 프록시를 우회할 수 있다. 시크릿은 플랫폼 시크릿으로 주입하고 이미지에 굽지 않는다.
- 비루트 `node` 사용자로 돈다. 볼륨 소유권이 맞지 않으면 `chown 1000:1000`.

## 3. 로컬 vs 배포 — 무엇이 바뀌고 왜

| 항목 | 로컬 | 배포 | 왜 다른가 |
|---|---|---|---|
| LLM | 키 없으면 `mock`, 있으면 `anthropic` | `anthropic` | mock 은 합성 세트를 결정적으로 통과시키는 규칙이라 테스트·데모용. 실제 문의는 LLM 이어야 한다 |
| 메일 수신 | `npm run sim` · 대시보드 "테스트 문의" → `/api/test/inbound` | 메일 provider 웹훅 → `POST /api/inbound` + `X-Inbound-Secret` | 로컬엔 받을 메일함이 없다. 배포에선 공개 엔드포인트라 시크릿 검증이 필수. 테스트 주입은 production 에서 꺼진다 |
| 메일 발송 | `mock` — `dispatches` 에 기록, `messages(out)` 추가 | `smtp`(STARTTLS·AUTH). `MAIL_ALLOWED_DOMAINS` 밖은 차단. production 에서 mock 은 시작 거부(`ALLOW_MOCK_MAIL=1` 예외) | 로컬에서 진짜 고객에게 나가면 안 된다. 배포에서도 허용 목록이 비면 fail-closed, 허구 SENT 도 막는다 |
| DB | `data/cs-agent.db` 파일 | `/app/data` 영속 볼륨의 SQLite → 규모 커지면 Postgres | 파일 하나가 가장 단순. 볼륨만 있으면 재시작에도 남는다 |
| 인증 | 없음(`by` 는 입력값) | 리버스 프록시 + `AUTH_USER_HEADER` 가 `by` 를 덮어씀(`/api` 전부), `PROXY_SHARED_SECRET` + 루프백 포트로 프록시 우회 차단 | 승인 버튼은 발송 권한이다. 누가 눌렀는지가 감사 로그의 핵심. 목록·상세엔 고객 주소·본문이 있다 |
| 알림 | 대시보드 SSE 만 | + `NOTIFY_WEBHOOK_URL` (넘김·승인 대기) | 대시보드를 안 보고 있어도 사람이 알아야 한다 |
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
  "occurredAt": "2026-10-24T01:23:45Z", "knownFacts": { "회사": "…" } }
```

- 시크릿 불일치·누락은 401. 비교는 `crypto.timingSafeEqual`.
- `providerMessageId` 로 `claims(mailbox:…)` 와 `messages.provider_message_id` 가 중복 수신을 막는다 — 웹훅 재전송은 안전하다(`{duplicate: true}`).
- `autoSubmitted` 는 어댑터가 `Auto-Submitted`·`X-Autoreply`·`Precedence` 헤더를 보고 채운다. 본문 키워드만으로 자동 회신을 판정하지 않는다.
- `occurredAt` 은 시크릿으로 검증된 요청만 넘길 수 있다(테스트 주입은 무시).
- `threadId` 가 `case_threads` 에 있으면 그 케이스에 메시지 추가(T2). 없으면 `inReplyTo`·`references`(문자열 또는 배열, 꺾쇠 있든 없든)가 받거나 보낸 메일의 `provider_message_id` 와 맞는지 보고, 맞으면 그 케이스에 붙이고 그 `threadId` 도 묶는다. 둘 다 아니면 새 케이스(T1). CLOSED 케이스면 재오픈.
- 그래서 메일 어댑터는 `providerMessageId` 에 수신 메일의 `Message-ID` 헤더를 그대로 넣고 `In-Reply-To`·`References` 를 넘긴다. `smtp` 발송은 답장에 `In-Reply-To`(답하는 고객 메일)·`References` 를 달고, 보낸 메일의 `Message-ID` 를 `messages.provider_message_id` 와 케이스 스레드로 남긴다.
- 메일 provider 쪽 어댑터(웹훅 페이로드 → 위 JSON)는 provider 마다 다르므로 서버 바깥(함수·작은 프록시)에 둔다. 서버는 이 JSON 하나만 안다.
- 로컬 E2E 용 어댑터 하나는 레포에 있다: `node scripts/inbound-imap.js`. 실제 메일함(IMAP)의 새 메일을 위 JSON으로 바꿔 `X-Inbound-Secret` 과 함께 넘긴다. 시연 계정 하나로 돌릴 때는 Gmail 별칭을 쓴다 — 고객 역할은 `본인@gmail.com`, 수신함은 `IMAP_TO=본인+cs@gmail.com`, `IMAP_ALLOWED_FROM=본인@gmail.com`, `MAIL_ALLOWED_DOMAINS=gmail.com`, `SMTP_FROM=본인+cs@gmail.com`(고객이 답장하면 별칭으로 돌아와 같은 케이스에 붙는다). 서버(`MAIL_PROVIDER=smtp`)와 어댑터에 같은 환경 변수를 준다. 실제 회사 CS 메일함에는 붙이지 않는다.
- 메일 계정 없이 같은 경로를 돌리려면 `npm run demo:mail`. 루프백에 가짜 메일 서버(IMAP·SMTP)와 고객 메일함 화면(`http://localhost:2600`)을 띄우고, 서버(`MAIL_PROVIDER=smtp`)와 위 어댑터를 그 서버에 붙여 실행한다. 실행마다 임시 DB·인증서·비밀번호를 새로 만들고 끝나면 지운다. `ANTHROPIC_API_KEY` 가 있으면 LLM도 실제로 부르고, `-- --check` 는 영수증·환불·로그인 세 문의를 보내 결과를 확인한 뒤 끝낸다.

## 5. 롤아웃 — L0 → L1 → L2

| 단계 | 스위치 | 통과 기준 |
|---|---|---|
| 0 로컬 | `npm test`, `npm run demo` | 테스트 통과, 합성 세트 기대 행동 100% 일치 |
| 1 섀도 (채널 하나씩) | `SHADOW_CHANNELS=<channel>` (또는 팩 `shadow: true`) | 사람이 섀도 초안을 good / needs_edit / critical 로 평가(대시보드 → `rateShadow`) |
| 2 승인 | `SHADOW_CHANNELS` 에서 빼기, `AUTO_SEND=0` (L2 intent도 승인 대기) | `/api/stats.promotion.<channel>.eligible = true` |
| 3 자동 (L2) | `AUTO_SEND` 비우기 — 팩 `maxLevel: L2` + intent `level: L2`만 승인 없이 발송, 넘김엔 접수 안내(`ackReply`) | 2026-10-27 결정으로 팩에 바로 켰다(support 탈퇴·영수증·구독 해지, onboarding 온보딩 신청·미팅, sales 서비스 질문). 실제 LLM 평가 전이라 치명 1건이면 `AUTO_SEND=0` |

승격 지표는 `/api/stats.promotion`(`server/cases.js promotion`)이 채널마다 계산한다 — SENT 에이전트 초안(무수정 = `final_body` 없음, `edit_tags` 에 `critical` 이면 치명)과 섀도 평가를 합친다. 기준은 코드 상수 `server/policy.js PROMOTION`: **누적 50건 · 무수정 90% 이상 · 치명 0건**.

치명 오류 정의: ① 금액·할인·수수료를 말함 ② 날짜·환불·계약을 약속함 ③ 수신자 오류 또는 다른 고객 정보 노출 ④ 사람이 맡은 케이스에 발송 ⑤ 치환 안 된 슬롯. **1건이라도 나오면 그 채널을 `SHADOW_CHANNELS` 에 넣는다**(자동 발송이면 먼저 `AUTO_SEND=0`) — 환경 변수만 바꿔 재시작하면 되고 재빌드는 필요 없다. 자동 발송분(`approved_by=agent:auto`)과 접수 안내(`ACK`)는 승격 지표·무수정 승인률에 넣지 않는다 — 사람이 본 적 없는 초안이다.

## 6. 일부러 만들지 않은 것

| 안 만든 것 | 이유 | 열려면 |
|---|---|---|
| 고객 무회신 팔로업 타이머 | 새 자동 발송이다. 스위퍼는 상태만 닫고 고객에게 보내지 않는다 | L1 안정 후 |
| 고객이 직접 연 새 스레드에 자동 응대 | 웹훅·폼으로 들어온 문의만 케이스 | 채널 정책 팩에 입구 추가 |
| 한국어·영어 밖 언어 | 그 언어 KB·guard 패턴이 없다 | 채널 `languages` + `kb/<channel>.<lang>.md` + guard 패턴 |
| 수평 확장·외부 큐 | SQLite 단일 프로세스로 충분한 규모 | Postgres 전환 뒤 |
| 첨부 파일 해석 | 첨부 유무만 안다 | 별도 파서 |
