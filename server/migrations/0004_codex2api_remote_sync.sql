-- 远端状态镜像：codex2api 巡检/手动同步时回写账号在 codex2api 的真实 status，
-- 主号池“远端状态”列优先展示该值（未同步过时回退本地登录状态推导）
ALTER TABLE accounts ADD COLUMN codex2api_status TEXT;
ALTER TABLE accounts ADD COLUMN codex2api_synced_at TEXT;
