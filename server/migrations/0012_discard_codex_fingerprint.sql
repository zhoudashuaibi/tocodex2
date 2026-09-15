-- 废弃号池「封号时的 Codex 指纹收敛档位」快照。
--
-- 这一列要回答的是「这个号被封的时候，codex2api 侧给它开的是哪一档收敛」——
-- 与「代理 IP」同属封号归因：同一档收敛下死了一批号，就是该档位可疑的信号。
--
-- 为什么必须落库快照而不是打开列表时现查：
--   · 档位只存在于远端账号的 codex_fingerprint_mode 平铺字段上，本地库没有第二份；
--   · 账号废弃后会退出远端调度，远端记录也可能被清理，事后现查只会得到「现在是什么」，
--     与废弃当时的配置无关，甚至什么都查不到。
--   所以与 discard_proxy_* / discard_used_amount_* 同一手法：废弃当下抓一次后不再改写。
--
-- 取值口径（codex2api 账号平铺字段 codex_fingerprint_mode，恒有值且已归一）：
--   'off'     远端确实关闭收敛（有效值，不代填：字段缺失才记 NULL，UI 显示 —）
--   'device'  仅收敛 installation_id
--   'session' 再收敛 session_id
--   'full'    三类标识全收敛
--   NULL      读不到（从未上传过远端 / 远端账号已删除 / 远端对象不带 extra）—— 不猜，UI 显示「—」
ALTER TABLE accounts ADD COLUMN discard_codex_fingerprint_mode TEXT;
ALTER TABLE accounts ADD COLUMN discard_codex_fingerprint_at TEXT;

-- 刻意不建索引（与 0011 的 idx_accounts_discard_proxy 不同）：这一列只有四个取值，
-- 选择性极差，过滤/分组都走 pool='discard' 的部分扫描更快；写入侧却要为每次废弃多维护一棵 B 树。
