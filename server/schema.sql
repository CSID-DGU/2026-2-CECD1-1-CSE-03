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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
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
  edited INTEGER NOT NULL DEFAULT 0      -- out: 사람이 고친 뒤 승인한 에이전트 초안(사람 약속으로 취급)
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
  step TEXT NOT NULL,                    -- prefilter | triage | gate1 | respond | guard | review | gate2 | execute
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
  type TEXT NOT NULL,                    -- approve | edit_approve | discard | takeover | return | close | reopen | note | human_reply | shadow_rating | auto_close | send_unconfirmed | resolve_sending | auto_send | auto_send_failed | auto_ack
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
