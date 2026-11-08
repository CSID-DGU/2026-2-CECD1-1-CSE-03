CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,                 -- support | onboarding | sales
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  subject TEXT,
  state TEXT NOT NULL,                   -- OPEN | AGENT_ACTIVE | AWAITING_APPROVAL | WAITING_CUSTOMER | HANDED_OFF | CLOSED
  responder TEXT NOT NULL DEFAULT 'agent', -- agent | human
  responder_changed_at TEXT, responder_changed_by TEXT, responder_change_reason TEXT,
  assignee TEXT,                         -- 사람 담당자 표시 이름(넘김·인수 시)
  known_facts TEXT,                      -- JSON {라벨: 값} 폼 값. 이메일·전화 넣지 않음
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
  purged_at TEXT,                        -- 원문 파기 시각(보존 기간·정보주체 삭제). 행은 제자리 가명화로 남아 지표가 그대로다
  related_case_id TEXT,                  -- 이어진 이전 케이스. 지금은 항상 NULL — 종결 뒤 회신은 같은 케이스를 다시 연다
  hold_note TEXT, held_at TEXT,          -- 사람 전담 케이스 보류(메모는 가린 뒤 500자). 보류 중엔 자동 종결하지 않는다
  close_reason TEXT, close_detail TEXT   -- 종결 사유(resolved | no_response | duplicate | spam | not_applicable | other) + 기타 상세
);
CREATE INDEX IF NOT EXISTS cases_state ON cases(state, updated_at);
CREATE INDEX IF NOT EXISTS cases_email ON cases(customer_email);

CREATE TABLE IF NOT EXISTS case_threads (
  thread_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL,               -- in | out
  sent_by TEXT,                          -- out일 때 agent | human | ack(넘김 접수 안내 — 답으로 치지 않는다)
  sender TEXT NOT NULL,                  -- 표시용 주소/이름
  subject TEXT,
  body TEXT NOT NULL,                    -- 원문
  body_clean TEXT NOT NULL,              -- 인용·서명 제거본
  provider_message_id TEXT UNIQUE,       -- 메일 provider id(멱등)
  occurred_at TEXT NOT NULL,
  auto_submitted INTEGER NOT NULL DEFAULT 0, -- 수신 어댑터가 Auto-Submitted·X-Autoreply·Precedence 헤더로 표시한 자동 회신
  edited INTEGER NOT NULL DEFAULT 0,     -- out: 사람이 고친 뒤 승인한 에이전트 초안(사람 약속으로 취급)
  sender_auth TEXT,                      -- in: 발신자 인증 pass | fail | form(폼 메일 본문에서 뽑은 주소 — 항상 미신뢰). NULL = 정보 없음
  event_id TEXT                          -- in: 수신 이벤트 문서 id(documents inbound_events). out은 NULL
);
CREATE INDEX IF NOT EXISTS messages_case ON messages(case_id, occurred_at);

CREATE TABLE IF NOT EXISTS claims (                 -- 멱등 claim. insert 성공 = 내가 처리
  key TEXT PRIMARY KEY,                  -- mailbox:<provider_message_id> | loop:<case_id>:<message_id>
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loops (
  case_id TEXT PRIMARY KEY REFERENCES cases(id),
  state TEXT NOT NULL,                   -- IDLE | RUNNING | HANDED_OFF
  rounds INTEGER NOT NULL DEFAULT 0,     -- 에이전트 답장 횟수
  repeat_streak INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,                      -- 리스 만료(ISO). 리스 중 도착한 메시지는 queue
  lease_token TEXT,                      -- 리스 주인. 해제는 이 토큰이 맞을 때만
  queue TEXT NOT NULL DEFAULT '[]',      -- JSON [message_id]
  last_outbound_gist TEXT,
  next_retry_at TEXT,                    -- LLM 장애 재시도 예정 시각(sweeper가 돌린다)
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_message_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  trigger_message_id TEXT NOT NULL,      -- 이 초안이 답하는 고객 메시지
  status TEXT NOT NULL,                  -- PENDING | SENDING | SENT | STALE | DISCARDED | NOT_SELECTED | SUPERSEDED | SHADOW
  intent TEXT, action TEXT,              -- 판단 결과 복사(목록 표시용)
  original_body TEXT NOT NULL,           -- 에이전트 원문
  final_body TEXT,                       -- 사람이 고친 본문(승인 시)
  edited_by TEXT, edit_tags TEXT,        -- edit_tags JSON ["fact","tone","missing","excess","policy"]
  used_facts TEXT,                       -- JSON [kb key]
  idempotency_key TEXT UNIQUE NOT NULL,  -- draft:<draft_id>
  approved_by TEXT, approved_at TEXT, sent_at TEXT, error TEXT,
  seen_out_rowid INTEGER,                -- 회차가 맥락을 읽을 때 본 마지막 발신 messages.rowid(0 = 없음). 이 뒤 발신이 있으면 승인 시 already_answered
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_case ON drafts(case_id, created_at);
CREATE INDEX IF NOT EXISTS drafts_status ON drafts(status);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  message_id TEXT,                       -- 트리거 메시지
  step TEXT NOT NULL,                    -- prefilter | triage | gate1 | respond | guard | review | gate2 | execute | brief | error
  agent TEXT,                            -- triage | responder | reviewer | briefer | (code)
  input_summary TEXT,                    -- 사람이 읽을 한 줄
  output TEXT NOT NULL,                  -- JSON 원본
  action TEXT,                           -- IGNORE | HANDOFF | COMPOSE | DRAFT | ANSWER_AND_HANDOFF | SHADOW | REWRITE
  reason TEXT,
  prompt_version TEXT, kb_version TEXT, policy_version TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_case ON decisions(case_id, created_at);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  reason TEXT NOT NULL,                  -- 정책 팩 handoffReasons 중 하나
  briefing TEXT NOT NULL,                -- JSON {summary, request, knownFacts, recommendedReply, nextAction}
  assignee TEXT,
  created_at TEXT NOT NULL, returned_at TEXT
);

CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  idempotency_key TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,                -- mock | smtp
  status TEXT NOT NULL,                  -- SENT | FAILED
  provider_message_id TEXT, error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (            -- 사람 행동 감사 로그
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  type TEXT NOT NULL,                    -- approve | edit_approve | discard | takeover | return | close | reopen | note | human_reply | shadow_rating | auto_close | send_unconfirmed | resolve_sending | auto_send | auto_send_failed | auto_ack | purge
  actor TEXT NOT NULL,
  payload TEXT,                          -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_case ON activities(case_id, type);

CREATE TABLE IF NOT EXISTS versions (              -- 프롬프트 원본·KB 본문·정책 팩 원문. decisions의 *_version 해시로 찾는다
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- prompt:<agent> | kb:<channel>:<lang> | policy:<channel>
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (             -- LLM 호출 1건 계량(토큰·지연·실패). 본문 없음 — FK 없이 파기와 무관하게 남는다. 비용·예산의 출처
  id TEXT PRIMARY KEY,
  case_id TEXT,
  message_id TEXT,
  agent TEXT NOT NULL,                   -- triage | responder | reviewer | briefer
  provider TEXT NOT NULL,                -- mock | anthropic
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,  -- 캐시 생성·읽기 포함
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  ok INTEGER NOT NULL,                   -- 1 성공 | 0 실패
  error TEXT,                            -- 오류 코드·HTTP 상태만(응답 본문 안 넣음)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_calls_created ON llm_calls(created_at);
CREATE INDEX IF NOT EXISTS llm_calls_case ON llm_calls(case_id);

-- CRM 컬렉션 — inbound_events | companies | contacts | cases | activities. 처리 테이블에서 다시 계산되는 JSON 문서(server/collections.js).
-- 수신 이벤트만 수신 트랜잭션에서 바로 쓰고, 나머지는 지연 동기화가 쓴다. 내용이 같으면 쓰지 않는다(revision·updated_at 그대로).
CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  doc TEXT NOT NULL,                     -- JSON
  revision INTEGER NOT NULL DEFAULT 1,   -- 내용이 바뀔 때만 +1
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
-- 식 인덱스는 질의가 같은 JSON 경로 리터럴을 써야 탄다(server/store.js PATHS)
CREATE UNIQUE INDEX IF NOT EXISTS doc_event_dedupe ON documents(json_extract(doc,'$.dedupeKey')) WHERE collection='inbound_events';
CREATE UNIQUE INDEX IF NOT EXISTS doc_contact_email ON documents(json_extract(doc,'$.primaryEmail')) WHERE collection='contacts';
CREATE UNIQUE INDEX IF NOT EXISTS doc_company_domain ON documents(json_extract(doc,'$.primaryDomain')) WHERE collection='companies' AND json_extract(doc,'$.primaryDomain') IS NOT NULL;
CREATE INDEX IF NOT EXISTS doc_event_case ON documents(json_extract(doc,'$.resolvedCaseId')) WHERE collection='inbound_events';
CREATE INDEX IF NOT EXISTS doc_activity_case ON documents(json_extract(doc,'$.caseId')) WHERE collection='activities';

CREATE TABLE IF NOT EXISTS config_changes (          -- 고객 설정 변경 감사이자 라이브 포인터(대상별 최근 행)
  seq INTEGER PRIMARY KEY,               -- rowid 별칭. VACUUM에도 값이 유지된다. 라이브·이력 순서는 이것만 본다
  id TEXT UNIQUE NOT NULL,               -- changeId(API·감사용)
  kind TEXT NOT NULL,                    -- kb | policy
  channel TEXT NOT NULL,
  language TEXT,                         -- kb: ko | en, policy: NULL
  action TEXT NOT NULL,                  -- publish | rollback | reset
  from_hash TEXT,                        -- 바꾸기 전 라이브 원문 해시
  to_hash TEXT,                          -- 바꾼 뒤 원문 해시(kb.sha, versions 키). reset이면 이미지 파일 해시, 이미지에 없으면 NULL
  to_sha256 TEXT,                        -- 바꾼 뒤 원문의 전체 sha256. 로드·되돌리기·내용 보기 때 versions 내용을 대조한다
  actor TEXT NOT NULL,
  note TEXT,                             -- 게시 메모(500자, maskPii)
  summary TEXT,                          -- JSON {diff, warnings, gate:{live, next, widenings, blocked}, ackL2Impact, ackLinkHosts, rollbackOf, draftId, source, kbVersion}
                                         -- KB의 diff 항목은 {key, op, fromHash, toHash}만 둔다. 절 본문은 넣지 않는다
  created_at TEXT NOT NULL               -- 표시용. 순서는 seq
);
CREATE INDEX IF NOT EXISTS config_changes_target ON config_changes(kind, channel, language);

CREATE TABLE IF NOT EXISTS kb_drafts (               -- KB 초안(직접 편집·매뉴얼 변환). 게시 전엔 라이브가 아니다
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL, language TEXT NOT NULL,
  status TEXT NOT NULL,                  -- converting | ready | failed | published | discarded
  origin TEXT NOT NULL,                  -- edit | convert
  source_name TEXT, source_kind TEXT,    -- 파일 이름, md|txt|html|docx|pdf
  source_text TEXT,                      -- 추출 원문(대조용, pdf는 NULL). 게시·폐기 때 지운다
  base_hash TEXT,                        -- 시작 때 라이브 KB 원문 해시
  raw TEXT NOT NULL,                     -- 후보 KB 원문 전체
  report TEXT,                           -- JSON {chunks:{done,total,failed:[{ref,error}]}, omitted:[], usage, estimate}
  revision INTEGER NOT NULL DEFAULT 1,   -- 저장 충돌 검사
  error TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
