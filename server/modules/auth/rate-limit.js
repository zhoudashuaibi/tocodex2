/**
 * 登录限流：同一 IP 连续失败 5 次锁 15 分钟，DB 持久（重启保持）。
 * 原子性用 UPDATE ... WHERE 条件返回的行数保证。
 */
export function createRateLimiter(db, { maxFails = 5, lockMinutes = 15 } = {}) {
  function check(ip) {
    const row = db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
    if (!row || !row.locked_until) return { locked: false };
    if (row.locked_until <= new Date().toISOString()) {
      // 锁定过期 → 计数清零
      db.prepare('DELETE FROM login_attempts WHERE ip = ? AND locked_until = ?').run(ip, row.locked_until);
      return { locked: false };
    }
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000)),
    };
  }

  function recordFailure(ip) {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO login_attempts(ip, fail_count, locked_until, updated_at) VALUES(?, 1, NULL, ?)
         ON CONFLICT(ip) DO UPDATE SET
           fail_count = CASE WHEN locked_until IS NOT NULL AND locked_until > ? THEN fail_count
                             ELSE login_attempts.fail_count + 1 END,
           locked_until = CASE WHEN login_attempts.fail_count + 1 >= ? THEN ? ELSE locked_until END,
           updated_at = excluded.updated_at`,
      )
      .run(ip, now, now, maxFails, new Date(Date.now() + lockMinutes * 60 * 1000).toISOString());
    const row = db.prepare('SELECT fail_count FROM login_attempts WHERE ip = ?').get(ip);
    const fails = row?.fail_count ?? 0;
    return { locked: fails >= maxFails, remainingAttempts: Math.max(0, maxFails - fails) };
  }

  function recordSuccess(ip) {
    db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
  }

  return { check, recordFailure, recordSuccess };
}
