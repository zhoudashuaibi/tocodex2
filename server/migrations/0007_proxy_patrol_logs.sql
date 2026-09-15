-- 代理巡检日志：每轮一条（summary 为 JSON 汇总），保留最近 100 轮（巡检内自清理）
CREATE TABLE proxy_patrol_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'manual',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  summary TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_proxy_patrol_logs_started ON proxy_patrol_logs(started_at DESC);
