-- ============ 系统配置 ============
-- key 约定（value 为 JSON 字符串；encrypted=1 时 value 为加密信封）：
--   codex2api.config      { base_url, admin_key, group_ids[], upload_defaults{...}, monitor{...} }
--   outlook.fetch       { endpoint }
--   sms.providers       { active, luban:{}, smsbower:{}, custom:{} }
--   engine.config       { max_concurrent_jobs, job_timeout_minutes, proxy_fail_threshold }
--   console.password    { salt, hash }        (encrypted=1)
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  encrypted   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

-- ============ 代理列表 ============
CREATE TABLE proxies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url_enc          TEXT NOT NULL,
  url_hash         TEXT NOT NULL UNIQUE,
  display_url      TEXT NOT NULL,
  protocol         TEXT NOT NULL,
  label            TEXT,
  status           TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (status IN ('unknown','alive','cf_challenge','dead','testing')),
  last_checked_at  TEXT,
  last_latency_ms  INTEGER,
  fail_count       INTEGER NOT NULL DEFAULT 0,
  consecutive_dead INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  rotatable        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_proxies_status ON proxies(status);

-- ============ 账号（三级号池统一表） ============
CREATE TABLE accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pool             TEXT NOT NULL DEFAULT 'reserve'
                   CHECK (pool IN ('reserve','main','discard')),

  status           TEXT NOT NULL DEFAULT 'mail_pending',
  note             TEXT,

  credentials_enc  TEXT,

  -- ---- reserve 专属 ----
  initial_balance  REAL,
  has_balance      INTEGER NOT NULL DEFAULT 0,
  banned           INTEGER NOT NULL DEFAULT 0,
  banned_reason    TEXT,
  mail_status      TEXT CHECK (mail_status IN ('pending','checking','ok','fetch_failed')),
  mail_error       TEXT,
  imported_at      TEXT,
  last_checked_at  TEXT,

  -- ---- main 专属 ----
  tokens_enc       TEXT,
  balance          REAL,
  balance_checked_at TEXT,
  balance_error    TEXT,
  last_login_at    TEXT,
  codex2api_account_id INTEGER,
  codex2api_uploaded_at TEXT,
  auto_repair_blocked INTEGER NOT NULL DEFAULT 0,
  last_auto_repair_at  TEXT,
  repair_fail_count INTEGER NOT NULL DEFAULT 0,

  -- ---- discard 专属 ----
  discard_reason   TEXT CHECK (discard_reason IN
                     ('banned_401','rate_limited_429','repair_failed','login_failed','manual')),
  discard_detail   TEXT,
  discarded_at     TEXT,

  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_accounts_pool_status ON accounts(pool, status);
CREATE INDEX idx_accounts_balance ON accounts(pool, balance) WHERE pool = 'main';

-- ============ 账号流转审计 ============
CREATE TABLE account_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_account_events_account ON account_events(account_id, created_at DESC);
CREATE INDEX idx_account_events_time ON account_events(created_at DESC);

-- ============ 任务 ============
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  type             TEXT NOT NULL CHECK (type IN ('login','refresh','balance','totp_setup')),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','awaiting_input','completed','failed','canceled')),
  stage            TEXT,
  prompt_kind      TEXT,
  attempt          INTEGER NOT NULL DEFAULT 1,
  proxy_id         INTEGER REFERENCES proxies(id),
  proxy_attempts   INTEGER NOT NULL DEFAULT 0,
  log_path         TEXT NOT NULL,
  result_path      TEXT,
  checkpoint_path  TEXT,
  totp_result_path TEXT,
  error            TEXT,
  resume_job_id    TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, created_at);
CREATE INDEX idx_jobs_account ON jobs(account_id, created_at DESC);
CREATE UNIQUE INDEX idx_jobs_active_per_account
  ON jobs(account_id) WHERE status IN ('queued','running','awaiting_input')
  AND account_id IS NOT NULL;

-- ============ 登录会话 ============
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ============ 登录失败计数（按 IP） ============
CREATE TABLE login_attempts (
  ip           TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL
);
