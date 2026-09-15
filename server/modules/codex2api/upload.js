import { errors } from '../../lib/http-errors.js';

/**
 * codex2api 上传管线：查重索引 → 新增/替换分流 → 最少绑定代理分配 → 余额后缀 → 回填。
 *
 * 与 sub2api 版的语义差异：
 *  - 创建载荷只带 refresh_token（codex2api 契约）；邮箱/AT 由其后台刷新回填，
 *    查重索引靠 name 里的 oauth---<email> 命名约定兜底（见 client.accountEmail）
 *  - skip_refresh 默认开：批量上传时不让 codex2api 立刻拉起无上限上游刷新
 *  - 指纹收敛 / 基础并发 / 调度偏置 / 自动暂停开关在创建后经 scheduler PATCH 补写
 *    （codex2api 创建接口不收这些字段；新账号指纹档位取其系统默认）
 *  - 替换凭据 = 「先建新（沿用原名/代理/分组）→ 再删旧」：codex2api 没有更新
 *    凭据的接口，且 RT 每次重登会轮换、其 RT 原文查重拦不住新 RT，只能换实体
 */

export function createUploader({ db, crypto, client, getConfig, settingsGet, dataDir, proxySelector, logger }) {
  // 上传闸门：手动批量上传与巡检自动补号共用本管线，必须串行执行。
  // 并发进入时两次调用会在各自开头各自快照远端索引，双双判定「远端还没有这个号」，
  // 于是对同一个号各建一份远端账号；先建的那份随即失去本地关联（回填只认一个 id），
  // 变成仍在接流量、却再也不会被修复（凭据不回推）的孤儿。
  let uploadChain = Promise.resolve();
  function enqueueUpload(task) {
    const result = uploadChain.then(task);
    // 闸门本身不被单次失败打断，失败只回传给调用方
    uploadChain = result.then(() => undefined, () => undefined);
    return result;
  }

  function uploadAccounts(accountIds, optionsOverride = {}) {
    return enqueueUpload(() => runUpload(accountIds, optionsOverride));
  }

  /**
   * 远端账号 email 索引（email → 远端账号，同邮箱多份取最小 id）。
   * 保留整个账号对象（替换凭据时要用 name/proxy_url/group_ids 快照）。
   */
  function emailIndex(accounts) {
    const byEmail = new Map();
    for (const acc of accounts) {
      const email = client.accountEmail(acc);
      const id = Number(acc?.id);
      if (!email || !Number.isSafeInteger(id) || id <= 0) continue;
      const key = email.toLowerCase();
      const current = byEmail.get(key);
      if (current === undefined || id < Number(current.id)) byEmail.set(key, acc);
    }
    return byEmail;
  }

  /**
   * 创建前二次校验：重拉远端索引，把「决策快照」之后已被别处建好的号从新增降级为替换。
   * 拉取失败不阻断（退回原有行为），只是少一层保护。
   */
  async function demoteExistingCreates(toCreate, toUpdate) {
    if (!toCreate.length) return;
    let latest;
    try {
      latest = emailIndex(await client.listAllAccounts());
    } catch (error) {
      logger?.warn?.({ err: error.message }, '创建前二次校验失败，按原计划创建');
      return;
    }
    for (let i = toCreate.length - 1; i >= 0; i -= 1) {
      const item = toCreate[i];
      const remote = latest.get(item.email);
      const remoteId = Number(remote?.id);
      if (!Number.isSafeInteger(remoteId) || remoteId <= 0) continue;
      logger?.warn?.({ accountId: item.row.id, remoteId }, '账号在创建前已存在于远端，转为替换凭据');
      toUpdate.push({ ...item, remote, remoteId });
      toCreate.splice(i, 1);
    }
  }

  async function runUpload(accountIds, optionsOverride = {}) {
    const config = getConfig();
    if (!config?.base_url || !config?.admin_key) {
      throw errors.codex2apiNotConfigured('请先配置 codex2api 后端地址与管理员密钥');
    }
    // 默认分组取顶层 group_ids（与监控分组同源）；调用方显式传 group_ids 时以覆盖为准
    const options = mergeUploadOptions(
      { ...config.upload_defaults, group_ids: config.group_ids ?? [] },
      optionsOverride,
    );

    // 去重：同一账号在一次批次里出现两次会在远端建成两份
    const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map(Number))].filter(
      (id) => Number.isSafeInteger(id) && id > 0,
    );

    // codex2api 只需要 RT：直接解 tokens_enc，不再依赖 data/results 导出文件
    const targets = [];
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      if (!row || !row.tokens_enc) continue;
      const tokens = crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc') || {};
      if (!tokens.refresh_token) continue;
      targets.push({
        row,
        tokens,
        email: String(tokens.email || row.email || '').trim().toLowerCase(),
      });
    }
    if (!targets.length) {
      return { created: 0, updated: 0, failed: ids.map((id) => ({ id, email: null, error: '账号不存在或缺少 refresh_token' })), updated_account_ids: [] };
    }

    // 远端全量索引
    const existing = await client.listAllAccounts();
    const remoteByEmail = emailIndex(existing);

    // 代理分配（最少绑定 + 整批均匀）：codex2api 账号直接绑 proxy_url，
    // 绑定数用代理的 bound_count（服务端聚合），无需再遍历账号计数
    let proxySelection = null;
    if (!options.proxy_url && options.auto_select_proxy) {
      try {
        const proxies = await client.listProxies();
        const active = proxies.filter(
          (proxy) => proxy && proxy.enabled !== false && String(proxy.url || '').trim(),
        );
        if (active.length) {
          const counts = new Map(active.map((proxy) => [String(proxy.url).trim(), Number(proxy.bound_count) || 0]));
          proxySelection = { urls: [...counts.keys()], counts };
        }
      } catch {
        proxySelection = null;
      }
    }

    const toCreate = [];
    const toUpdate = [];
    for (const target of targets) {
      const remote = target.email ? remoteByEmail.get(target.email) : null;
      const remoteId = Number(remote?.id);
      const payload = buildPayload(target, options, proxySelection);
      if (Number.isSafeInteger(remoteId) && remoteId > 0) toUpdate.push({ ...target, payload, remote, remoteId });
      else toCreate.push({ ...target, payload });
    }

    // 新增组：余额未查过则先实时查一次，追加 ---N 后缀
    for (const item of toCreate) {
      await appendBalanceSuffix(item, options, db, crypto);
    }

    // 创建前二次校验：上面的索引是「决策快照」，到真正落库之间还隔着代理分配与余额补查（可能数秒），
    // 期间别处（并发上传、另一个实例）可能已经把这个号建好，直接创建会在远端留下两份。
    await demoteExistingCreates(toCreate, toUpdate);

    let created = 0;
    const failed = [];
    const updatedAccountIds = [];

    // 新增：逐个创建（保留各自的余额后缀名与代理分配；响应直接给 created_ids）
    for (const item of toCreate) {
      try {
        const { score_bias, ...send } = item.payload;
        const result = await client.createAccount(send);
        const createdIds = Array.isArray(result?.created_ids) ? result.created_ids.map(Number) : [];
        const remoteId = createdIds.find((id) => Number.isSafeInteger(id) && id > 0);
        if (Number.isSafeInteger(remoteId)) {
          created += 1;
          await applyAccountConfig(remoteId, item, options);
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE accounts SET codex2api_uploaded_at=?, codex2api_account_id=?, updated_at=? WHERE id=?`,
          ).run(now, remoteId, now, item.row.id);
          recordEvent(item.row.id, 'uploaded_codex2api', { mode: 'create', name: send.name, remote_id: remoteId });
          continue;
        }
        // 未拿到新 id：多半是 RT 原文命中 codex2api 服务端查重被跳过/复活了旧号。
        // 按 email 回找远端实体回填关联（复活语义计入 updated），找不到只记上传时间。
        const revived = item.email ? remoteByEmail.get(item.email) : null;
        const revivedId = Number(revived?.id);
        const now = new Date().toISOString();
        if (Number.isSafeInteger(revivedId) && revivedId > 0) {
          await applyAccountConfig(revivedId, item, options);
          db.prepare(
            `UPDATE accounts SET codex2api_uploaded_at=?, codex2api_account_id=?, updated_at=? WHERE id=?`,
          ).run(now, revivedId, now, item.row.id);
          updatedAccountIds.push(item.row.id);
          recordEvent(item.row.id, 'uploaded_codex2api', {
            mode: 'revived',
            remote_id: revivedId,
            note: 'codex2api 服务端按 RT 查重跳过/复活旧号',
          });
        } else {
          db.prepare(`UPDATE accounts SET codex2api_uploaded_at=?, updated_at=? WHERE id=?`).run(now, now, item.row.id);
          recordEvent(item.row.id, 'uploaded_codex2api', { mode: 'dedup_no_id', response: result ?? null });
        }
      } catch (error) {
        failed.push({ id: item.row.id, email: item.email, error: String(error.message || error).slice(0, 400) });
      }
    }

    // 替换凭据：先建新（沿用远端原名/代理/分组 + 新 RT）→ 再删旧 → 回填新 id
    for (const item of toUpdate) {
      try {
        const replacement = await replaceAccountCredentials(client, {
          remoteId: item.remoteId,
          name: item.remote?.name || item.payload.name,
          proxyUrl: item.remote?.proxy_url || item.payload.proxy_url || null,
          groupIds: Array.isArray(item.remote?.group_ids) && item.remote.group_ids.length ? item.remote.group_ids : item.payload.group_ids || null,
          refreshToken: item.tokens.refresh_token,
          sessionToken: item.tokens.session_token || null,
          skipRefresh: options.skip_refresh !== false,
          logger,
        });
        await applyAccountConfig(replacement.remoteId, item, options);
        updatedAccountIds.push(item.row.id);
        const now = new Date().toISOString();
        db.prepare(
          `UPDATE accounts SET codex2api_uploaded_at=?, codex2api_account_id=?, updated_at=? WHERE id=?`,
        ).run(now, replacement.remoteId, now, item.row.id);
        recordEvent(item.row.id, 'codex2api_replaced', {
          mode: 'replace',
          remote_id: replacement.remoteId,
          old_remote_id: item.remoteId,
        });
      } catch (error) {
        failed.push({ id: item.row.id, email: item.email, error: String(error.message || error).slice(0, 400) });
      }
    }

    return { created, updated: updatedAccountIds.length, failed, updated_account_ids: updatedAccountIds };
  }

  /**
   * 创建后补写 codex2api 创建接口不收的账号配置（全部 best-effort：补写失败不算上传失败，
   * 指纹/并发档位可在 codex2api 管理页手动改）：
   *   codex_fingerprint_mode / base_concurrency_override / score_bias_override /
   *   auto_pause_5h_disabled / auto_pause_7d_disabled → scheduler PATCH
   *   model_whitelist → PATCH /accounts/:id/models
   */
  async function applyAccountConfig(remoteId, item, options) {
    const patch = {};
    const fingerprintMode = normalizeCodexFingerprintMode(options.codex_fingerprint_mode);
    if (fingerprintMode !== 'off') patch.codex_fingerprint_mode = fingerprintMode;
    const concurrency = Number(options.base_concurrency);
    if (Number.isFinite(concurrency) && concurrency > 0) patch.base_concurrency_override = Math.floor(concurrency);
    const scoreBias = Number(item.payload.score_bias);
    if (Number.isFinite(scoreBias) && scoreBias !== 0) patch.score_bias_override = Math.max(-200, Math.min(200, Math.floor(scoreBias)));
    if (options.disable_auto_pause_5h) patch.auto_pause_5h_disabled = true;
    if (options.disable_auto_pause_7d) patch.auto_pause_7d_disabled = true;
    if (Object.keys(patch).length) {
      try {
        await client.updateScheduler(remoteId, patch);
      } catch (error) {
        logger?.warn?.({ remoteId, err: error.message }, 'apply account config after upload failed');
      }
    }
    if (options.model_whitelist?.length) {
      try {
        await client.setAccountModels(remoteId, options.model_whitelist);
      } catch (error) {
        logger?.warn?.({ remoteId, err: error.message }, 'apply model whitelist after upload failed');
      }
    }
  }

  function buildPayload(target, options, proxySelection) {
    let proxyUrl = options.proxy_url || null;
    if (!proxyUrl && proxySelection) {
      let minBound = Infinity;
      const candidates = [];
      for (const url of proxySelection.urls) {
        const bound = proxySelection.counts.get(url) || 0;
        if (bound < minBound) {
          minBound = bound;
          candidates.length = 0;
          candidates.push(url);
        } else if (bound === minBound) {
          candidates.push(url);
        }
      }
      if (candidates.length) {
        proxyUrl = candidates[Math.floor(Math.random() * candidates.length)];
        proxySelection.counts.set(proxyUrl, (proxySelection.counts.get(proxyUrl) || 0) + 1);
      }
    }
    return {
      name: `oauth---${target.email || target.row.email || 'account'}`,
      refresh_token: target.tokens.refresh_token,
      ...(target.tokens.session_token ? { session_token: target.tokens.session_token } : {}),
      ...(proxyUrl ? { proxy_url: proxyUrl } : {}),
      skip_refresh: options.skip_refresh !== false,
      allow_duplicate: false,
      ...(options.group_ids?.length ? { group_ids: options.group_ids } : {}),
      // 本地暂存字段（createAccount 前剥离，不进 codex2api 请求体）：
      // 未显式配置调度偏置时按余额分档，余额后缀补查后同步校正
      score_bias: options.score_bias ?? balanceTierScoreBias(target.row?.balance),
    };
  }

  async function appendBalanceSuffix(item, options, db, crypto) {
    const payload = item.payload;
    if (/---\d+$/.test(String(payload.name || ''))) return;
    const row = db.prepare('SELECT balance, balance_checked_at, tokens_enc FROM accounts WHERE id = ?').get(item.row.id);
    if (!row) return;
    let balance = row.balance;
    if (balance === null || balance === undefined) {
      // 实时查一次余额（失败不阻断，保持原名）。此时号尚未上传 codex2api，
      // 选路与登录一致：账号绑定代理 > 全局 alive 代理；无代理时受 strict_proxy 管控
      try {
        const tokens = crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc') || {};
        if (!tokens.access_token) return;
        const { fetchChatgptCredits } = await import('../../core/chatgpt-credits.mjs');
        const { fetchWithTls } = await import('../../lib/openai-fetch.js');
        const credentials = crypto.tryDecryptJson(item.row.credentials_enc, 'accounts.credentials_enc') || {};
        const proxyUrl =
          credentials.proxy_url ||
          (proxySelector ? proxySelector.pickRandomAliveProxy()?.url : null) ||
          null;
        // 无可用代理且开启禁止直连时跳过补查（保持原名上传），绝不以本机 IP 直连
        if (!proxyUrl && settingsGet?.('engine.config')?.strict_proxy !== false) return;
        const result = await fetchChatgptCredits({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          clientId: tokens.client_id,
          fetchImpl: (url, fetchOptions) => fetchWithTls(url, fetchOptions, { proxyUrl }),
        });
        balance = result.balance;
        db.prepare('UPDATE accounts SET balance=?, balance_checked_at=?, balance_error=NULL WHERE id=?').run(
          balance,
          new Date().toISOString(),
          item.row.id,
        );
      } catch {
        return;
      }
    }
    const usd = Math.round(Number(balance));
    if (Number.isFinite(usd)) {
      payload.name = `${payload.name}---${usd}`;
      // 实时补查到余额后同步校正分档偏置（buildPayload 构建时余额还是空）
      if (options.score_bias == null) payload.score_bias = balanceTierScoreBias(usd);
    }
  }

  function recordEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail || {}),
      new Date().toISOString(),
    );
  }

  return { uploadAccounts };
}

/**
 * 替换远端账号凭据（上传替换流与巡检修复回推共用）：
 * 先用新 RT 建新号（沿用原名/代理/分组，创建成功拿到新 id）→ 再删旧号。
 *
 * 顺序刻意是「先建后删」：创建失败时旧号原样保留（还在接流量、还能再试），
 * 反过来先把旧号删了、创建再失败，号就没了。旧号删除失败只告警——新号已建好，
 * 留着旧号顶多是同邮箱双份，下一轮同步会报 duplicates 提醒人工清理。
 *
 * @returns {Promise<{remoteId: number}>} 新远端账号 ID
 */
export async function replaceAccountCredentials(client, { remoteId, name, proxyUrl, groupIds, refreshToken, sessionToken = null, skipRefresh = true, logger = null }) {
  const payload = {
    name: name || 'oauth---account',
    refresh_token: refreshToken,
    ...(sessionToken ? { session_token: sessionToken } : {}),
    ...(proxyUrl ? { proxy_url: proxyUrl } : {}),
    skip_refresh: skipRefresh !== false,
    allow_duplicate: false,
    ...(Array.isArray(groupIds) && groupIds.length ? { group_ids: groupIds } : {}),
  };
  const result = await client.createAccount(payload);
  const createdIds = Array.isArray(result?.created_ids) ? result.created_ids.map(Number) : [];
  const newId = createdIds.find((id) => Number.isSafeInteger(id) && id > 0);
  if (!Number.isSafeInteger(newId)) {
    throw new Error('codex2api 未返回新账号 ID（创建未生效，旧账号保持原样）');
  }
  try {
    await client.deleteAccount(remoteId);
  } catch (error) {
    logger?.warn?.({ remoteId, newId, err: error.message }, '旧远端账号删除失败，暂留双份待清理');
  }
  return { remoteId: newId };
}

export function buildExportFromTokens(row, tokens) {
  return {
    type: 'codex2api-data',
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: [],
    accounts: [
      {
        name: `oauth---${tokens.email || row.email}`,
        type: 'oauth',
        credentials: {
          access_token: tokens.access_token,
          chatgpt_account_id: tokens.chatgpt_account_id,
          email: tokens.email || row.email,
          id_token: tokens.id_token,
          refresh_token: tokens.refresh_token,
        },
        extra: {
          account_id: tokens.chatgpt_account_id,
          chatgpt_account_id: tokens.chatgpt_account_id,
          chatgpt_user_id: tokens.chatgpt_user_id,
          client_id: tokens.client_id,
          email: tokens.email || row.email,
        },
      },
    ],
  };
}

/**
 * 余额分档默认调度偏置（仅在未显式配置 score_bias 时生效）：
 * ≤10 刀 → +40（优先消耗小额号），11-19 刀 → +20，20-39 刀 → +30，≥40 刀 → +10（大额号留作兜底）。
 * codex2api 的 score_bias_override 取值 -200~200，正向 = 调度优先；
 * 档位取四舍五入后的整数余额，与名称 ---N 后缀同口径；未查过余额按 +20 计。
 */
export function balanceTierScoreBias(balance) {
  if (balance === null || balance === undefined || balance === '') return 20;
  const usd = Math.round(Number(balance));
  if (!Number.isFinite(usd)) return 20;
  if (usd <= 10) return 40;
  if (usd < 20) return 20;
  if (usd < 40) return 30;
  return 10;
}

/**
 * Codex 指纹收敛档位（codex2api codex_fingerprint_mode），取值两边一一对应：
 * off=原样透传客户端设备/会话标识（默认）｜device=仅收敛 installation_id（上游见 1 设备 + N 会话）｜
 * session=再收敛 session_id（thread_id 按客户端原始会话派生，最接近正常用户）｜full=三类标识全收敛。
 */
export const CODEX_FINGERPRINT_MODES = ['off', 'device', 'session', 'full'];

/**
 * 归一化收敛档位：缺省、空值、非法值一律按 off（透传）处理。
 * 收敛在上游是显式 opt-in，绝不放行未知值，避免把脏值写进远端后被当成收敛开启。
 */
export function normalizeCodexFingerprintMode(value) {
  const mode = String(value ?? '').trim();
  return CODEX_FINGERPRINT_MODES.includes(mode) ? mode : 'off';
}

/**
 * 上传默认项合并（codex2api 口径）：
 *   base_concurrency  每号并发上限（→ base_concurrency_override）
 *   score_bias        调度偏置 -200~200（→ score_bias_override；缺省按余额分档）
 *   skip_refresh      创建后是否跳过 codex2api 的即时上游刷新（默认 true，防批量上传打卡网关）
 *   proxy_url         指定代理 URL（优先于 auto_select_proxy）
 */
export function mergeUploadOptions(defaults = {}, override = {}) {
  const merged = {
    group_ids: Array.isArray(defaults.group_ids)
      ? defaults.group_ids.map(Number).filter((v) => Number.isSafeInteger(v) && v > 0)
      : [],
    base_concurrency: defaults.base_concurrency ?? null,
    score_bias: defaults.score_bias ?? null,
    skip_refresh: defaults.skip_refresh !== false,
    model_whitelist: defaults.model_whitelist || [],
    disable_auto_pause_5h: Boolean(defaults.disable_auto_pause_5h),
    disable_auto_pause_7d: Boolean(defaults.disable_auto_pause_7d),
    auto_select_proxy: defaults.auto_select_proxy !== false,
    proxy_url: defaults.proxy_url || null,
    codex_fingerprint_mode: normalizeCodexFingerprintMode(defaults.codex_fingerprint_mode),
    ...override,
  };
  // 请求级覆盖也走白名单：弹窗漏传/传了旧值时收敛档位仍落在合法集合内
  merged.codex_fingerprint_mode = normalizeCodexFingerprintMode(merged.codex_fingerprint_mode);
  return merged;
}
