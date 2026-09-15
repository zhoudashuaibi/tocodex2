-- codex2api 监控巡检日志：每轮一条 + 每账号明细
CREATE TABLE monitor_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'manual',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  summary TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_monitor_logs_started ON monitor_logs(started_at DESC);

CREATE TABLE monitor_log_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL REFERENCES monitor_logs(id) ON DELETE CASCADE,
  email TEXT,
  remote_id INTEGER,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_monitor_log_items_log ON monitor_log_items(log_id);
