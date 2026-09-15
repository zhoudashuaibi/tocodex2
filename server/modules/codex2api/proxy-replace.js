import { AppError, errors } from '../../lib/http-errors.js';

/**
 * 一键更换 codex2api 代理 IP：
 * 解析粘贴文本（ip:port:user:pass）→ 构造代理 URL → 批量创建新代理（label 纯数字续接自增）→
 * 把绑定在旧代理 URL 上的远端账号洗牌均分改绑到新代理 URL → 批量删除旧代理。
 *
 * codex2api 代理是 URL 实体：账号直接绑 proxy_url，删除代理会自动解绑账号，
 * 因此**必须先改绑再删旧**；改绑存在失败组时跳过删除（整批保留），防止账号裸奔直连。
 */

const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h'];

/** 输入行身份（去重用）：host|port|username|password 四元组。 */
export function proxyIdentity({ host, port, username, password }) {
  return `${String(host || '').toLowerCase()}|${Number(port)}|${String(username || '')}|${String(password || '')}`;
}

/** 由解析段构造完整代理 URL：protocol://user:pass@host:port。 */
export function buildProxyUrl({ host, port, username, password }, protocol = 'http') {
  const safeProtocol = PROXY_PROTOCOLS.includes(protocol) ? protocol : 'http';
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
  return `${safeProtocol}://${auth}${host}:${port}`;
}

/** 解析整段粘贴文本：ip:端口:用户名:密码（或 ip:端口），兼容完整 URL 行；返回可用行 / 非法行 / 输入内重复数。 */
export function parseReplaceLines(text) {
  const items = [];
  const invalidLines = [];
  const seen = new Set();
  let duplicates = 0;

  String(text || '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = index + 1;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const parsed = parseProxyLine(trimmed);
      if (!parsed) {
        invalidLines.push({ line, reason: '格式应为 ip:端口:用户名:密码（或 ip:端口）' });
        return;
      }
      const identity = proxyIdentity(parsed);
      if (seen.has(identity)) {
        duplicates += 1;
        return;
      }
      seen.add(identity);
      items.push(parsed);
    });

  return { items, invalid_lines: invalidLines, duplicates_in_input: duplicates };
}

function parseProxyLine(value) {
  // 完整 URL（或 user:pass@host:port）形式：借 URL 解析器拆字段
  if (value.includes('://') || value.includes('@')) {
    try {
      const url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`);
      const port = url.port ? Number(url.port) : null;
      if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      return {
        host: url.hostname,
        port,
        username: url.username ? decodeURIComponent(url.username) : null,
        password: url.password ? decodeURIComponent(url.password) : null,
      };
    } catch {
      return null;
    }
  }

  const parts = value.split(':').map((part) => part.trim());
  if (parts.length !== 2 && parts.length !== 4) return null;
  const [host, portRaw, username, password] = parts;
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (parts.length === 4 && (!username || !password)) return null;
  return {
    host,
    port,
    username: parts.length === 4 ? username : null,
    password: parts.length === 4 ? password : null,
  };
}

/** 现有代理 label 尾部的最大数字 + 1，作为新代理 label 编号起点（保持纯数字命名的可读性）。 */
export function nextLabelStart(existingLabels) {
  let max = 0;
  for (const label of existingLabels || []) {
    const match = String(label || '').trim().match(/(\d+)\s*$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** 账号洗牌后轮发均分到目标代理（各组数量差 ≤ 1）。 */
export function distributeAccounts(accountIds, targets) {
  const shuffled = [...accountIds];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return targets.map((proxy, index) => ({
    proxy,
    ids: shuffled.filter((_, i) => i % targets.length === index),
  }));
}

export function createProxyReplacer({ client, logger }) {
  return async function replaceProxies({ text, protocol = 'http', deleteOld = true }) {
    if (!PROXY_PROTOCOLS.includes(protocol)) {
      throw errors.validation('代理协议仅支持 http / https / socks5 / socks5h');
    }
    const parsed = parseReplaceLines(text);
    if (parsed.items.length === 0) {
      throw errors.validation('没有可用的代理行，请检查输入格式');
    }

    const existing = await client.listProxies();
    const existingByUrl = new Map(existing.map((proxy) => [String(proxy?.url || '').trim(), proxy]));
    // 与现有代理 URL 完全一致的输入行视为复用：作为改绑目标但不重建、不删除
    const reused = [];
    const reusedIds = new Set();
    const toCreate = [];
    for (const item of parsed.items) {
      const url = buildProxyUrl(item, protocol);
      const match = existingByUrl.get(url);
      if (match) {
        reused.push(match);
        reusedIds.add(Number(match.id));
      } else {
        toCreate.push({ ...item, url });
      }
    }

    // 批量创建（一次请求）；codex2api 响应不含新代理 ID，client 侧重拉列表按 URL 解析。
    // label 用纯数字续接自增（整批一个编号即可，URL 本身才是身份）。
    const labelStart = nextLabelStart(existing.map((proxy) => proxy.label));
    const created = [];
    const createFailed = [];
    if (toCreate.length) {
      const resolved = await client.createProxies(
        toCreate.map((item) => item.url),
        String(labelStart),
      );
      toCreate.forEach((item, index) => {
        const proxy = resolved[index];
        if (proxy && Number.isSafeInteger(Number(proxy.id)) && Number(proxy.id) > 0) {
          created.push({ id: Number(proxy.id), url: item.url, label: proxy.label ?? String(labelStart) });
        } else {
          createFailed.push({ proxy: `${item.host}:${item.port}`, reason: '创建后未能在代理列表中解析到新代理' });
          logger?.warn?.({ host: item.host, port: item.port }, 'codex2api create proxy failed');
        }
      });
    }

    const targets = [
      ...created,
      ...reused.map((proxy) => ({ id: Number(proxy.id), url: String(proxy.url), label: proxy.label ?? null })),
    ];
    if (targets.length === 0) {
      throw new AppError(502, 'CODEX2API_PROXY_CREATE_FAILED', `新代理创建全部失败：${createFailed[0]?.reason ?? '未知错误'}`);
    }

    // 只改绑"绑定在待删旧代理 URL 上"的账号；复用代理上已有的绑定保持不动。
    // view=lite 单次全量拉取（大号池下不带富化字段），按 proxy_url 过滤。
    const deletableOld = existing.filter((proxy) => !reusedIds.has(Number(proxy.id)));
    const deletableOldUrls = new Set(deletableOld.map((proxy) => String(proxy?.url || '').trim()).filter(Boolean));
    const accounts = await client.listAccountsLite();
    const boundAccountIds = accounts
      .filter((account) => deletableOldUrls.has(String(account?.proxy_url || '').trim()))
      .map((account) => Number(account.id));

    const groups = [];
    const failedGroups = [];
    for (const { proxy, ids } of distributeAccounts(boundAccountIds, targets)) {
      if (ids.length === 0) continue;
      try {
        await client.bulkUpdateAccounts(ids, { proxy_url: proxy.url });
        groups.push({ proxy_url: proxy.url, proxy_id: proxy.id, name: proxy.label ?? proxy.url, count: ids.length });
      } catch (error) {
        failedGroups.push({ proxy_url: proxy.url, proxy_id: proxy.id, name: proxy.label ?? proxy.url, count: ids.length, reason: error.message });
        logger?.warn?.({ proxyUrl: proxy.url, count: ids.length, err: error.message }, 'codex2api bulk rebind failed');
      }
    }

    // 删除前置条件：改绑全部成功，或本来就没有账号绑在旧代理上（无账号可裸奔）。
    // 有失败组时整批保留旧代理，失败的账号继续走原出口，留待下次重试。
    const oldProxies = { deleted: 0, skipped: [] };
    const rebindSafe = failedGroups.length === 0 || boundAccountIds.length === 0;
    if (deleteOld && deletableOld.length > 0 && rebindSafe) {
      const oldIds = deletableOld
        .map((proxy) => Number(proxy.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      try {
        const result = await client.deleteProxiesBatch(oldIds);
        oldProxies.deleted = Number(result?.deleted) || 0;
      } catch (error) {
        logger?.warn?.({ err: error.message }, 'codex2api batch delete proxies failed');
      }
    }
    if (deleteOld && deletableOld.length > 0 && !rebindSafe) {
      oldProxies.skipped = deletableOld.map((proxy) => ({
        id: Number(proxy.id),
        name: proxy.label ?? proxy.url,
        reason: '存在改绑失败组，跳过删除以防账号裸奔',
      }));
    }

    return {
      created,
      reused: reused.map((proxy) => ({ id: Number(proxy.id), url: String(proxy.url), label: proxy.label ?? null })),
      create_failed: createFailed,
      invalid_lines: parsed.invalid_lines,
      duplicates_in_input: parsed.duplicates_in_input,
      name_start: labelStart,
      rebound: {
        total: boundAccountIds.length,
        groups,
        failed_groups: failedGroups,
      },
      old_proxies: oldProxies,
    };
  };
}
