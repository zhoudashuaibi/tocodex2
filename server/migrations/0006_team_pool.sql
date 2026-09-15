-- Team 号池：卡密（team_cards）与卡密提取出的账号（team_accounts）。
-- 与现有 free 号 accounts 表完全独立，不参与号池流转/巡检。
CREATE TABLE team_cards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  card_code        TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'unextracted'
                   CHECK (status IN ('unextracted','healthy','need_reclaim','cannot_reclaim','mixed')),
  health           TEXT,
  note             TEXT,
  last_extracted_at TEXT,
  last_reclaim_at  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE team_accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id          INTEGER NOT NULL REFERENCES team_cards(id) ON DELETE CASCADE,
  email            TEXT NOT NULL COLLATE NOCASE,
  short_name       TEXT,
  name             TEXT,
  order_no         TEXT,
  account_enc      TEXT,
  health_status    TEXT,
  codex2api_account_id INTEGER,
  codex2api_uploaded_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(card_id, email)
);
CREATE INDEX idx_team_accounts_card ON team_accounts(card_id);
CREATE INDEX idx_team_accounts_email ON team_accounts(email);
