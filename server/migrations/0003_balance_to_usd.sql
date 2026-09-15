-- 余额单位统一为美元：主号池 accounts.balance 历史存的是 ChatGPT 原始 credits（25 credits = $1），
-- 与备用号池邮件提取口径（credits / 25）对齐，存量一次性除以 25 修正
UPDATE accounts SET balance = balance / 25.0 WHERE balance IS NOT NULL;
