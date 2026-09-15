import { maskProxyUrl } from '../../lib/sanitize.js';

/**
 * 随机选路与失败降级记账。
 */
export function createProxySelector(db, crypto) {
  /** 随机选一条 alive 代理；无则返回空（是否允许直连由引擎侧 strict_proxy 决定）。 */
  function pickRandomAliveProxy(excludeIds = []) {
    const rows = db.prepare(`SELECT id, url_enc FROM proxies WHERE status = 'alive'`).all();
    const candidates = excludeIds.length ? rows.filter((r) => !excludeIds.includes(r.id)) : rows;
    if (!candidates.length) return { id: null, url: null };
    const row = candidates[Math.floor(Math.random() * candidates.length)];
    const url = crypto.tryDecrypt(row.url_enc, 'proxies.url_enc');
    if (!url) return { id: null, url: null };
    return { id: row.id, url };
  }

  /** 任务运行中连接失败记账：达到阈值自动置 dead。 */
  function recordFailure(proxyId, threshold = 3) {
    if (!proxyId) return { dead: false };
    const row = db.prepare('SELECT fail_count FROM proxies WHERE id = ?').get(proxyId);
    if (!row) return { dead: false };
    const failCount = row.fail_count + 1;
    const now = new Date().toISOString();
    if (failCount >= threshold) {
      db.prepare(
        `UPDATE proxies SET fail_count=?, status='dead', last_error='任务连接失败累计', updated_at=? WHERE id=?`,
      ).run(failCount, now, proxyId);
      return { dead: true };
    }
    db.prepare('UPDATE proxies SET fail_count=?, updated_at=? WHERE id=?').run(failCount, now, proxyId);
    return { dead: false };
  }

  /** 任务成功一次清零。 */
  function recordSuccess(proxyId) {
    if (!proxyId) return;
    db.prepare('UPDATE proxies SET fail_count=0 WHERE id = ?').run(proxyId);
  }

  return { pickRandomAliveProxy, recordFailure, recordSuccess, maskProxyUrl };
}
