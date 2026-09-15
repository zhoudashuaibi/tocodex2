/**
 * Team 模块共享工具：简短名分配与账号邮箱提取。
 */

/**
 * 分配简短名 team-MMDD-HHMM-N：时间取分配时刻，编号当天从 1 递增（每天重置）。
 * better-sqlite3 同步执行，查询当日最大编号 +1 无竞态。
 */
export function allocateShortName(db) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const mmdd = `${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const hhmm = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const prefix = `team-${mmdd}-`;
  const rows = db.prepare('SELECT short_name FROM team_accounts WHERE short_name LIKE ?').all(`${prefix}%`);
  let max = 0;
  for (const row of rows) {
    const match = String(row.short_name || '').match(/^team-\d{4}-\d{4}-(\d+)$/);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}${hhmm}-${max + 1}`;
}

/** 账号邮箱提取：credentials.email → extra.email → name 正则（与 codex2api client.accountEmail 同语义）。 */
export function extractAccountEmail(account) {
  const direct = [account?.credentials?.email, account?.extra?.email]
    .map((value) => String(value || '').trim().toLowerCase())
    .find((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  if (direct) return direct;
  const match = String(account?.name || '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0] : null;
}
