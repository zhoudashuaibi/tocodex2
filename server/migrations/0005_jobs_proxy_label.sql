-- 任务选路标签：余额任务走 codex2api 绑定代理时记录代理信息
-- （codex2api 代理 ID 非本机 proxies 表外键，不能写 jobs.proxy_id，独立列展示）
ALTER TABLE jobs ADD COLUMN proxy_label TEXT;
