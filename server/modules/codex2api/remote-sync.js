/**
 * codex2api 远端同步服务：
 *  - syncRemoteStatus：按 email/ID 把远端账号关联回本地（回填 codex2api_account_id），
 *    并镜像远端真实 status 到 codex2api_status；远端已不存在的本地关联一并清除
 *  - resolveCodex2apiProxy：余额查询选路——号已上传 codex2api 时返回其在远端绑定的
 *    代理 URL（codex2api 账号自带 proxy_url 字符串，无需再查代理表拼 URL）
 *  - resolveDiscardRemote：废弃瞬间的远端事实快照（出口代理 + Codex 指纹收敛档位）
 *
 * 远端全量索引（账号/代理列表）带 60s TTL 缓存：批量余额查询、巡检、同步共享一次拉取。
 */

import { normalizeCodexFingerprintMode } from './upload.js';

const CACHE_TTL_MS = 60_000;

/** 废弃时代理快照的邮箱查找上限：查不到就认「找不到」，codex2api 服务端 search 一次即达。 */
const DISCARD_PROXY_EMAIL_LOOKUP_MAX = 200;

/**
 * 从 codex2api 远端账号对象提取「当前出口代理」快照，用于废弃号池的 IP 归因。
 *
 * codex2api 的代理绑定是账号上的 proxy_url 字符串（protocol://user:pass@host:port），
 * 解析出 host/port/认证账号；label（代理名）不随账号返回，由 completeDiscardProxy
 * 按需查代理列表补齐。认证账号（username）是判断「同一个 IP 上是不是同一批号」的关键：
 * 同一台代理服务器换个认证账号就是另一条出口，只看 host 会误判。只取身份，不取密码。
 */
export function extractRemoteProxy(account) {
  const raw = String(account?.proxy_url || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname || null;
  const port = Number(parsed.port) || null;
  const username = parsed.username ? decodeURIComponent(parsed.username) : null;
  if (!host && !username) return null;
  return { id: null, name: null, username, host, port };
}

/**
 * 从 codex2api 远端账号对象提取「当前 Codex 指纹收敛档位」，用于废弃号池的封号归因。
 *
 * codex2api 把档位作为平铺字段下发（codex 渠道账号恒有、已归一为
 * off/device/session/full），「字段存在且值为 off」是**确定**的关闭；
 * 只有字段缺失（非 codex 渠道 / 响应被裁剪）才返回 null，交给 UI 显示「—」。
 * 值存在时按四档白名单归一，非法值归为 off —— 与上传侧 normalizeCodexFingerprintMode 同一口径。
 */
export function extractCodexFingerprintMode(account) {
  if (!account || typeof account !== 'object') return null;
  const raw = account.codex_fingerprint_mode;
  if (raw === null || raw === undefined) return null;
  if (String(raw).trim() === '') return null;
  return normalizeCodexFingerprintMode(raw);
}

export function createRemoteSync({ db, client, getConfig, logger }) {
  let cache = { accounts: null, accountsAt: 0, proxies: null, proxiesAt: 0 };

  function buildAccountIndex(list) {
    const byId = new Map();
    const byEmail = new Map();
    const emailRank = new Map(); // email → 已收录账号的 id，用于保留最小 id
    // email → 远端 id 列表（按出现顺序）。只有真的出现多份的邮箱会留下记录：
    // 历史上传并发（手动上传 × 巡检补号）会在远端给同一个号建两份，本地只可能关联其中一份，
    // 另一份既没人回推凭据、又还在接流量，必须能被巡检发现。
    const idsByEmail = new Map();
    for (const account of list) {
      const id = Number(account?.id);
      const validId = Number.isSafeInteger(id) && id > 0;
      if (validId) byId.set(id, account);
      const email = client.accountEmail(account);
      if (!email) continue;
      const key = email.toLowerCase();
      // 同一邮箱多份时取最小 id（最早创建），与上传回填口径一致，且与远端返回顺序无关
      const rank = validId ? id : Number.POSITIVE_INFINITY;
      if (!emailRank.has(key) || rank < emailRank.get(key)) {
        byEmail.set(key, account);
        emailRank.set(key, rank);
      }
      if (validId) {
        const ids = idsByEmail.get(key);
        if (ids) ids.push(id);
        else idsByEmail.set(key, [id]);
      }
    }
    const duplicatesByEmail = new Map();
    for (const [email, ids] of idsByEmail) {
      if (ids.length > 1) duplicatesByEmail.set(email, ids.slice().sort((a, b) => a - b));
    }
    return { byId, byEmail, duplicatesByEmail };
  }

  async function remoteAccountIndex() {
    if (!cache.accounts || Date.now() - cache.accountsAt > CACHE_TTL_MS) {
      const index = buildAccountIndex(await client.listAllAccounts());
      cache = { ...cache, accounts: index, accountsAt: Date.now() };
    }
    return cache.accounts;
  }

  /** 代理索引按 URL 建（codex2api 代理实体与账号都靠 URL 关联），供 label 补齐。 */
  async function remoteProxyIndex() {
    if (!cache.proxies || Date.now() - cache.proxiesAt > CACHE_TTL_MS) {
      const byUrl = new Map();
      for (const proxy of await client.listProxies()) {
        const url = String(proxy?.url || '').trim();
        if (url) byUrl.set(url, proxy);
      }
      cache = { ...cache, proxies: byUrl, proxiesAt: Date.now() };
    }
    return cache.proxies;
  }

  function recordEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail || {}),
      new Date().toISOString(),
    );
  }

  /**
   * 重复远端账号：同一邮箱在远端存在多份（并发上传遗留的孤儿副本）。
   * 只在「重复集合发生变化」时记事件，避免每轮巡检刷屏；返回值用于汇总与告警。
   */
  function noteDuplicate(accountId, email, remoteIds, linkedId) {
    const detail = { remote_ids: remoteIds, linked_remote_id: linkedId ?? null };
    const last = db
      .prepare(`SELECT detail FROM account_events WHERE account_id=? AND type='codex2api_duplicate' ORDER BY id DESC LIMIT 1`)
      .get(accountId);
    if (last?.detail === JSON.stringify(detail)) return false;
    recordEvent(accountId, 'codex2api_duplicate', detail);
    logger?.warn?.({ accountId, email, remoteIds }, '远端存在同邮箱重复账号，孤儿副本不会被回推凭据，建议清理');
    return true;
  }

  /**
   * 同步远端状态到本地主号池：
   *  - 远端存在 → 回填 codex2api_account_id（缺失/不符时）+ 镜像 status + codex2api_synced_at
   *  - 远端不存在 → 清除本地 codex2api_account_id / codex2api_status（远端已被删除）
   *  - 同邮箱多份 → 记 codex2api_duplicate 事件（集合变化时才记），并统计 stats.duplicates
   * remoteAccounts：调用方已拉取的全量远端账号（巡检复用），缺省自行拉取。
   */
  async function syncRemoteStatus({ remoteAccounts = null } = {}) {
    const index = remoteAccounts ? buildAccountIndex(remoteAccounts) : await remoteAccountIndex();
    const rows = db
      .prepare(`SELECT id, email, codex2api_account_id, codex2api_status FROM accounts WHERE pool = 'main'`)
      .all();
    const now = new Date().toISOString();
    const stats = { scanned: rows.length, linked: 0, unlinked: 0, status_updated: 0, duplicates: 0, duplicate_new: 0, duplicate_items: [] };
    const tx = db.transaction(() => {
      for (const row of rows) {
        const remote =
          (Number.isInteger(Number(row.codex2api_account_id)) && index.byId.get(Number(row.codex2api_account_id))) ||
          index.byEmail.get(String(row.email || '').toLowerCase()) ||
          null;
        if (remote) {
          const remoteId = Number(remote.id);
          const remoteStatus = String(remote.status || 'unknown');
          const idChanged = Number(row.codex2api_account_id) !== remoteId;
          const duplicates = index.duplicatesByEmail.get(String(row.email || '').toLowerCase());
          if (duplicates) {
            // duplicates 每轮都计数（未清理的重复会一直挂在巡检日志里提醒），
            // duplicate_items 只在集合变化时带明细，避免每轮往 monitor_logs.summary 里塞大数组
            stats.duplicates += 1;
            const extras = duplicates.filter((id) => id !== remoteId);
            if (noteDuplicate(row.id, row.email, duplicates, remoteId) && stats.duplicate_items.length < 10) {
              stats.duplicate_new += 1;
              stats.duplicate_items.push({ email: row.email, remote_ids: duplicates, extras });
            }
          }
          if (!idChanged && row.codex2api_status === remoteStatus) continue;
          db.prepare(
            `UPDATE accounts SET codex2api_account_id=?, codex2api_status=?, codex2api_synced_at=?,
               codex2api_uploaded_at=COALESCE(codex2api_uploaded_at, ?), updated_at=? WHERE id=?`,
          ).run(remoteId, remoteStatus, now, now, now, row.id);
          if (idChanged) {
            recordEvent(row.id, 'codex2api_linked', { remote_id: remoteId, source: 'sync' });
            stats.linked += 1;
          } else {
            stats.status_updated += 1;
          }
        } else if (row.codex2api_account_id != null || row.codex2api_status != null) {
          db.prepare(
            `UPDATE accounts SET codex2api_account_id=NULL, codex2api_status=NULL, codex2api_synced_at=?, updated_at=? WHERE id=?`,
          ).run(now, now, row.id);
          recordEvent(row.id, 'codex2api_unlinked', { source: 'sync', reason: 'remote_missing' });
          stats.unlinked += 1;
        }
      }
    });
    tx();
    // 只在重复集合变化时告警：未清理的重复仍会以 duplicates 计数留在每轮 info 日志与巡检汇总里
    if (stats.duplicate_new) {
      logger?.warn?.(
        { duplicates: stats.duplicates, emails: stats.duplicate_items.map((item) => item.email) },
        '远端存在重复账号，孤儿副本不会被回推凭据，需要清理',
      );
    }
    logger?.info?.(stats, 'codex2api remote sync done');
    return stats;
  }

  /**
   * 余额查询选路：号已上传 codex2api（按 ID 或 email 命中远端）且绑定了代理时，
   * 返回该代理 URL；未配置 codex2api / 号不在远端 / 未绑代理返回 null（走本机选路）。
   * 代理展示名（label）顺带解析，供任务日志标注出口。
   */
  async function resolveCodex2apiProxy(accountId) {
    const config = getConfig();
    if (!config?.base_url || !config?.admin_key) return null;
    const row = db.prepare('SELECT email, codex2api_account_id FROM accounts WHERE id = ?').get(accountId);
    if (!row) return null;
    const index = await remoteAccountIndex();
    const remote =
      (Number.isInteger(Number(row.codex2api_account_id)) && index.byId.get(Number(row.codex2api_account_id))) ||
      index.byEmail.get(String(row.email || '').toLowerCase()) ||
      null;
    const proxyUrl = String(remote?.proxy_url || '').trim();
    if (!proxyUrl) return null;
    const proxy = (await remoteProxyIndex()).get(proxyUrl);
    return {
      url: proxyUrl,
      remote_id: Number(remote.id),
      proxy_name: proxy?.label != null && String(proxy.label).trim() ? String(proxy.label).trim() : null,
    };
  }

  /**
   * 废弃瞬间解析远端账号对象：优先用调用方已经拿到的那个（巡检本来就有，
   * 且那是「废弃那一刻」的真实状态，事后 60s 缓存过期重查可能已被改绑/改配置）；
   * 没有时按 id → 邮箱回退查一次远端。
   *
   * 回退刻意分两档，避免批量废弃把 codex2api 打爆（每次废弃都会走这里，量大时会被放大千倍）：
   *   · 有 codex2api_account_id → 只查单个账号（1 次请求，与远端总量无关）
   *   · 没有 ID → 才走邮箱查找（client.findAccountByEmail，服务端 search 一次即达）。
   * 远端账号已不存在（本地号从未上传 / 远端已被清理）时返回 null —— 不猜。
   */
  async function fetchDiscardRemote({ remote = null, accountId = null, email = null } = {}) {
    let target = remote;
    if (!target) {
      const linked = Number(accountId);
      if (Number.isSafeInteger(linked) && linked > 0 && typeof client.getAccount === 'function') {
        try {
          const account = await client.getAccount(linked);
          if (account && Number(account.id ?? linked)) target = account;
        } catch (error) {
          logger?.debug?.({ accountId: linked, err: error.message }, 'discard remote: getAccount failed');
        }
      }
    }
    if (!target) {
      const key = String(email || '').trim().toLowerCase();
      if (!key || typeof client.findAccountByEmail !== 'function') return null;
      try {
        target = (await client.findAccountByEmail(key, { maxAccounts: DISCARD_PROXY_EMAIL_LOOKUP_MAX })) ?? null;
      } catch (error) {
        logger?.debug?.({ err: error.message }, 'discard remote: email lookup failed');
        return null;
      }
    }
    return target ?? null;
  }

  /**
   * 废弃瞬间的「远端事实」快照：出口代理 + Codex 指纹收敛档位。
   *
   * 两者都只存在于同一个远端账号对象上（proxy_url 与 codex_fingerprint_mode），
   * 所以共用一次远端解析 —— 分两次查等于把同一个号查两遍，批量废弃时会被放大千倍。
   *
   * @returns {Promise<{ proxy: object|null, codex_fingerprint_mode: string|null }>}
   *   proxy 为 null 表示「没绑代理 / 拿不到」（不猜直连）；
   *   codex_fingerprint_mode 为四档之一或 null（null = 读不到，绝不代填 off）
   */
  async function resolveDiscardRemote(args = {}) {
    const target = await fetchDiscardRemote(args);
    // 远端账号查不到：两个字段一起留空，而不是只让其中一个变成「未知」
    if (!target) return { proxy: null, codex_fingerprint_mode: null };
    return {
      proxy: await completeDiscardProxy(target),
      codex_fingerprint_mode: extractCodexFingerprintMode(target),
    };
  }

  /**
   * 代理快照补齐：账号上的 proxy_url 只解得出 host/port/认证账号，
   * 代理名（label）要另查一次代理列表（有 60s 缓存，批量废弃不会放大请求量）。
   * 拿不到 label 就原样返回，不猜。
   */
  async function completeDiscardProxy(target) {
    const snapshot = extractRemoteProxy(target);
    if (!snapshot) return null;
    const proxyUrl = String(target?.proxy_url || '').trim();
    if (!proxyUrl) return snapshot;
    const proxy = (await remoteProxyIndex()).get(proxyUrl);
    if (!proxy) return snapshot;
    const label = proxy.label != null && String(proxy.label).trim() ? String(proxy.label).trim() : null;
    return { ...snapshot, name: label ?? snapshot.name };
  }

  /** 按代理 URL 解析 label（60s 缓存的代理索引），供废弃快照补齐代理名。 */
  async function resolveProxyLabel(proxyUrl) {
    const url = String(proxyUrl || '').trim();
    if (!url) return null;
    const proxy = (await remoteProxyIndex()).get(url);
    return proxy?.label != null && String(proxy.label).trim() ? String(proxy.label).trim() : null;
  }

  /** 只要出口代理的旧入口（保留给只关心代理的调用方与既有单测）：语义与历史行为一致。 */
  async function resolveDiscardProxy(args = {}) {
    return (await resolveDiscardRemote(args)).proxy;
  }

  return { syncRemoteStatus, resolveCodex2apiProxy, resolveDiscardProxy, resolveDiscardRemote, resolveProxyLabel };
}
