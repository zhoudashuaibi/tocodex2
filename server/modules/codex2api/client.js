import { AppError, errors } from '../../lib/http-errors.js';
import { sanitizeText } from '../../lib/sanitize.js';

/**
 * codex2api admin API 客户端：X-Admin-Key 头、120s 超时。
 * 错误信息过脱敏后抛 CODEX2API_UNAVAILABLE / 504。
 *
 * 与 sub2api 客户端的关键契约差异：
 *  - 认证头 X-Admin-Key（sub2api 是 x-api-key），路由前缀 /api/admin（sub2api 是 /api/v1/admin）
 *  - 所有账号列表/搜索强制 channel=codex（codex2api 是多渠道网关，不带渠道会混入 grok/claude 号）
 *  - 代理是 URL 实体：账号绑 proxy_url 字符串；列表/创建响应都不以 proxy_id 关联账号
 *  - 创建账号只收 refresh_token（可多行批量），邮箱/AT 由 codex2api 首次刷新回填
 *  - batch-update / scheduler 接口 DisallowUnknownFields，未知字段直接 400
 */

const REQUEST_TIMEOUT_MS = 120_000;
const ACCOUNT_PAGE_SIZE = 500; // codex2api accountListPageMax 上限，一页拉满减少请求轮数
const ACCOUNT_PAGE_HARD_LIMIT = 1000; // 防御性翻页封顶（50 万号）

/**
 * batch-update / PATCH scheduler 允许的字段白名单（codex2api 侧 DisallowUnknownFields）。
 * 客户端统一在这张表上过滤，调用方传错字段名只会被丢弃而不是 400 整批失败。
 */
export const SCHEDULER_PATCH_FIELDS = new Set([
  'upstream_request_id_header',
  'score_bias_override',
  'base_concurrency_override',
  'skip_warm_tier',
  'allowed_api_key_ids',
  'tags',
  'group_ids',
  'auto_pause_5h_threshold',
  'auto_pause_7d_threshold',
  'auto_pause_5h_disabled',
  'auto_pause_7d_disabled',
  'ignore_usage_limit_status_override',
  'dispatch_count_limit',
  'scheduler_priority',
  'proxy_url',
  'custom_headers',
  'codex_fingerprint_mode',
  'claude_fingerprint_mode',
  'claude_client_platform',
  'claude_version_policy',
  'claude_client_version',
  'timezone',
]);

export function pickSchedulerPatch(patch) {
  const cleaned = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (SCHEDULER_PATCH_FIELDS.has(key) && value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export function createCodex2apiClient(getConfig) {
  async function request(endpoint, options = {}, configOverride = null) {
    const config = configOverride || getConfig();
    if (!config?.base_url) throw errors.codex2apiNotConfigured('请先配置 codex2api 后端地址');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.base_url.replace(/\/+$/, '')}${endpoint}`, {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-admin-key': config.admin_key,
          ...(options.headers || {}),
        },
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = responseMessage(payload, text).slice(0, 400);
        throw new AppError(502, 'CODEX2API_UNAVAILABLE', `codex2api 返回 HTTP ${response.status}${message ? `：${message}` : ''}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError') {
        throw new AppError(504, 'CODEX2API_UNAVAILABLE', 'codex2api 请求超时（120s）');
      }
      throw new AppError(502, 'CODEX2API_UNAVAILABLE', `无法连接 codex2api：${sanitizeText(String(error.message || error))}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------- 分组 ----------------

  /**
   * codex 渠道分组列表。codex2api 的分组带 channel 字段（空/未知归一为 codex），
   * 只保留 codex 渠道，避免把 grok/claude 分组当成监控目标。
   */
  async function listGroups(configOverride = null) {
    const payload = await request('/api/admin/account-groups', {}, configOverride);
    const groups = Array.isArray(payload?.groups) ? payload.groups : [];
    return groups.filter((group) => String(group?.channel || 'codex').toLowerCase() === 'codex');
  }

  // ---------------- 代理 ----------------

  /** 代理列表：{id,url,label,enabled,bound_count}。账号与代理通过 URL 字符串关联。 */
  async function listProxies(configOverride = null) {
    const payload = await request('/api/admin/proxies', {}, configOverride);
    return Array.isArray(payload?.proxies) ? payload.proxies : [];
  }

  /**
   * 批量创建代理并解析出实体。codex2api 的创建响应不含新代理 ID，
   * 这里重拉一次列表按 URL 匹配补齐（调用方需要 id 做批量删除）。
   * 返回与入参 urls 同序的对象数组（解析失败的槽位为 null）。
   */
  async function createProxies(urls, label = null, configOverride = null) {
    const cleaned = urls.map((url) => String(url || '').trim()).filter(Boolean);
    if (!cleaned.length) return [];
    await request(
      '/api/admin/proxies',
      { method: 'POST', body: JSON.stringify(label ? { urls: cleaned, label } : { urls: cleaned }) },
      configOverride,
    );
    const byUrl = new Map((await listProxies(configOverride)).map((proxy) => [String(proxy?.url || '').trim(), proxy]));
    return cleaned.map((url) => byUrl.get(url) ?? null);
  }

  function deleteProxiesBatch(ids) {
    return request('/api/admin/proxies/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
  }

  // ---------------- 账号列表 ----------------

  async function requestAccountsPage({ page = 1, pageSize = ACCOUNT_PAGE_SIZE, search = null } = {}, configOverride = null) {
    const query = new URLSearchParams({
      view: 'page',
      page: String(page),
      page_size: String(pageSize),
      channel: 'codex',
    });
    if (search) query.set('search', search);
    return request(`/api/admin/accounts?${query}`, {}, configOverride);
  }

  /**
   * 全量 codex 账号（分页聚合，view=page：含 group_ids / 状态 / reset_5h_at /
   * reset_7d_at / proxy_url / codex_fingerprint_mode 等巡检与同步所需字段）。
   */
  async function listAllAccounts(configOverride = null) {
    const accounts = [];
    let page = 1;
    for (;;) {
      const payload = await requestAccountsPage({ page }, configOverride);
      const items = Array.isArray(payload?.accounts) ? payload.accounts : [];
      accounts.push(...items);
      const total = Number(payload?.total);
      if (items.length < ACCOUNT_PAGE_SIZE) break;
      if (Number.isFinite(total) && page * ACCOUNT_PAGE_SIZE >= total) break;
      page += 1;
      if (page > ACCOUNT_PAGE_HARD_LIMIT) break;
    }
    return accounts;
  }

  /**
   * 轻量全量（view=lite：只有 id/name/email/plan_type/status/enabled/proxy_url）。
   * 供代理改绑这类只关心「账号是谁、绑了哪条代理」的场景，大号池下不分页、零富化。
   */
  async function listAccountsLite(configOverride = null) {
    const payload = await request('/api/admin/accounts?view=lite&channel=codex', {}, configOverride);
    return Array.isArray(payload?.accounts) ? payload.accounts : [];
  }

  /**
   * 按邮箱查找单个远端账号。codex2api 支持服务端 search（命中 name/email），
   * 一页足够；客户端再按 accountEmail 精确收口（search 也可能命中名字里恰好含
   * 该邮箱串的其他账号）。刚上传未刷新的号 email 为空，靠 name 里的邮箱兜底命中。
   */
  async function findAccountByEmail(email, { maxAccounts = 2000, configOverride = null } = {}) {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return null;
    const payload = await requestAccountsPage(
      { page: 1, pageSize: Math.min(100, Math.max(10, maxAccounts)), search: target },
      configOverride,
    );
    const items = Array.isArray(payload?.accounts) ? payload.accounts : [];
    return items.find((account) => accountEmail(account) === target) ?? null;
  }

  /** 单账号完整对象（codex2api 平铺返回，无 data 包裹；兼容历史包裹形状）。 */
  async function getAccount(id) {
    const payload = await request(`/api/admin/accounts/${encodeURIComponent(id)}`);
    return payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
  }

  /**
   * 账号累计用量统计。days<=0 在 codex2api 侧是「全部历史」，
   * 与 sub2api 的累计口径对齐（废弃用量快照传 0，主池预估余额传 90）。
   */
  function getAccountStats(id, days = 0) {
    const safeDays = Math.min(3650, Math.max(0, Math.floor(Number(days) || 0)));
    return request(`/api/admin/accounts/${encodeURIComponent(id)}/usage?days=${safeDays}`);
  }

  // ---------------- 账号写操作 ----------------

  /**
   * 创建账号（单个）。payload：{name, refresh_token, session_token?, proxy_url?,
   * custom_headers?, allow_duplicate?, skip_refresh?, group_ids?}。
   * 响应：{success, updated, duplicate, failed, bound_groups, group_ids, created_ids}。
   */
  function createAccount(payload, configOverride = null) {
    return request('/api/admin/accounts', { method: 'POST', body: JSON.stringify(payload) }, configOverride);
  }

  function deleteAccount(id) {
    return request(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** 重置账号状态为正常（清冷却/模型冷却），对应 sub2api 的 clear-error。 */
  function resetStatus(id) {
    return request(`/api/admin/accounts/${encodeURIComponent(id)}/reset-status`, { method: 'POST', body: '{}' });
  }

  /** 启用/禁用账号，对应 sub2api 的 setSchedulable。 */
  function setEnabled(id, enabled) {
    return request(`/api/admin/accounts/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
      body: JSON.stringify({ enabled: Boolean(enabled) }),
    });
  }

  /** 用存量 RT 重新换 AT（轻量复活路径：凭据未轮换、只是状态坏了时用）。 */
  function refreshAccount(id) {
    return request(`/api/admin/accounts/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: '{}' });
  }

  /** 单账号调度配置 PATCH（字段白名单过滤）。 */
  function updateScheduler(id, patch) {
    return request(`/api/admin/accounts/${encodeURIComponent(id)}/scheduler`, {
      method: 'PATCH',
      body: JSON.stringify(pickSchedulerPatch(patch)),
    });
  }

  /** 账号可用模型白名单（模型数 ≤200，逐个校验）。 */
  function setAccountModels(id, models) {
    return request(`/api/admin/accounts/${encodeURIComponent(id)}/models`, {
      method: 'PATCH',
      body: JSON.stringify({ models }),
    });
  }

  /** 账号备注（≤500 字符）。 */
  function setAccountNote(id, note) {
    return request(`/api/admin/accounts/${encodeURIComponent(id)}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    });
  }

  /** 批量更新（字段白名单过滤），对应 sub2api 的 bulk-update。 */
  function bulkUpdateAccounts(ids, patch) {
    return request('/api/admin/accounts/batch-update', {
      method: 'POST',
      body: JSON.stringify({ ids, ...pickSchedulerPatch(patch) }),
    });
  }

  // ---------------- 形状适配 ----------------

  /**
   * 账号邮箱提取：email 平铺字段 → name 里的邮箱兜底。
   *
   * 兜底是必须的：上传侧默认 skip_refresh=true（防批量导入把上游刷新打爆），
   * 此时 codex2api 解不出邮箱（RT 不是 JWT），credentials.email 要等它的后台
   * 刷新调度器跑过才会回填。我们上传时的命名约定 oauth::<email>::N 保证
   * name 兜底在窗口期内依然能建 email 索引。
   */
  function accountEmail(account) {
    const direct = String(account?.email || '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(direct)) return direct;
    // 先剥掉本系统命名前缀（新 oauth:: 与历史遗留 oauth---）：前缀字符都在
    // 邮箱本地部分字符类里，不剥会被一并吞进提取结果（旧名 oauth---a@b.c
    // 曾被整串当成"邮箱"导致查重索引失配）
    const stripped = String(account?.name || '').replace(/^oauth(-{2,}|:{1,})/i, '');
    const match = stripped.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return match ? match[0] : null;
  }

  /**
   * 从 codex2api 账号/用量对象读取累计消费：
   * /accounts/:id/usage 的 total_account_billed（官方按账号计费金额）为主，
   * 列表对象自带的 5h/7d 窗口 account_billed 作次选。
   */
  function accountUsedAmount(account) {
    const candidates = [
      ['total_account_billed', account?.total_account_billed],
      ['usage_5h_detail.account_billed', account?.usage_5h_detail?.account_billed],
      ['usage_7d_detail.account_billed', account?.usage_7d_detail?.account_billed],
    ];
    for (const [source, value] of candidates) {
      const amount = Number(value);
      if (value !== null && value !== undefined && value !== '' && Number.isFinite(amount) && amount >= 0) {
        return { amount, source };
      }
    }
    return null;
  }

  /** 错误信息提取，供巡检分类器拼接匹配。 */
  function accountErrorMessage(account) {
    return [account?.error_message, account?.last_error, account?.message]
      .map((value) => (typeof value === 'string' ? value : ''))
      .filter(Boolean)
      .join(' | ');
  }

  /**
   * 限流态：codex2api 用状态枚举表达（rate_limited / usage_exhausted），
   * 窗口重置时间在 reset_5h_at / reset_7d_at（RFC3339）。
   * 返回形状与 sub2api 版对齐（rate_limited_at / rate_limit_reset_at / limited_now），
   * 巡检侧逻辑不用改。
   */
  function accountRateLimit(account) {
    const status = String(account?.status || '').toLowerCase();
    const limitedNow = status === 'rate_limited' || status === 'usage_exhausted';
    const resetAt = account?.reset_5h_at || account?.reset_7d_at || null;
    return {
      rate_limited_at: limitedNow ? (account?.last_used_at ?? null) : null,
      rate_limit_reset_at: resetAt,
      limited_now: limitedNow,
    };
  }

  /** 每号并发取值：账号覆盖（生效值优先）> 上传默认 > 0。 */
  function accountConcurrency(account, fallback = 0) {
    for (const value of [account?.base_concurrency_effective, account?.base_concurrency_override]) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) return num;
    }
    const fb = Number(fallback);
    return Number.isFinite(fb) && fb > 0 ? fb : 0;
  }

  async function testConnection(configOverride) {
    const t0 = Date.now();
    const groups = await listGroups(configOverride);
    return { ok: true, groups: groups.length, latency_ms: Date.now() - t0 };
  }

  return {
    request,
    listGroups,
    listProxies,
    createProxies,
    deleteProxiesBatch,
    requestAccountsPage,
    listAllAccounts,
    listAccountsLite,
    findAccountByEmail,
    getAccount,
    getAccountStats,
    createAccount,
    deleteAccount,
    resetStatus,
    setEnabled,
    refreshAccount,
    updateScheduler,
    setAccountModels,
    setAccountNote,
    bulkUpdateAccounts,
    accountEmail,
    accountUsedAmount,
    accountErrorMessage,
    accountRateLimit,
    accountConcurrency,
    testConnection,
  };
}

function responseMessage(payload, text) {
  const message =
    payload?.error?.message ||
    (typeof payload?.error === 'string' ? payload.error : null) ||
    payload?.message ||
    '';
  return typeof message === 'string' && message.trim() ? message.trim() : String(text || '').slice(0, 160);
}
