import { errors } from '../../lib/http-errors.js';
import { mergeUploadOptions, normalizeCodexFingerprintMode, replaceAccountCredentials } from '../codex2api/upload.js';
import { allocateShortName, extractAccountEmail } from './names.js';

/**
 * Team 号上传器：与 codex2api/upload.js 同一套创建/替换语义（RT-only 载荷、
 * 创建后 scheduler PATCH 补写、替换 = 先建新后删旧），但
 * - 数据源为 team_accounts（凭据存 account_enc，兑换服务返回的完整 account 对象，取其 refresh_token）
 * - 上传选项取 team.config（与现有号池的上传默认配置完全独立）
 * - 账号名使用简短名 team-MMDD-HHMM-N，remark 记录所属卡密
 * - 不做余额后缀
 */

export function createTeamUploader({ db, crypto, client, getCodex2apiConfig, getTeamConfig, logger }) {
  function loadRows(accountIds) {
    const rows = [];
    for (const id of accountIds) {
      const row = db
        .prepare(
          `SELECT a.*, c.card_code FROM team_accounts a JOIN team_cards c ON c.id = a.card_id WHERE a.id = ?`,
        )
        .get(Number(id));
      if (!row || !row.account_enc) continue;
      rows.push(row);
    }
    return rows;
  }

  function ensureShortName(row, now) {
    if (row.short_name) return row.short_name;
    const shortName = allocateShortName(db);
    db.prepare('UPDATE team_accounts SET short_name = ?, updated_at = ? WHERE id = ?').run(shortName, now, row.id);
    return shortName;
  }

  /** 最少绑定代理分配（URL 维度，绑定数用代理的 bound_count 服务端聚合值）。 */
  async function buildProxySelection(options) {
    if (options.proxy_url || !options.auto_select_proxy) return null;
    try {
      const proxies = await client.listProxies();
      const active = proxies.filter((proxy) => proxy && proxy.enabled !== false && String(proxy.url || '').trim());
      if (!active.length) return null;
      return { counts: new Map(active.map((proxy) => [String(proxy.url).trim(), Number(proxy.bound_count) || 0])) };
    } catch {
      return null;
    }
  }

  function pickLeastBoundProxyUrl(proxySelection) {
    let minBound = Infinity;
    const candidates = [];
    for (const [url, bound] of proxySelection.counts) {
      if (bound < minBound) {
        minBound = bound;
        candidates.length = 0;
        candidates.push(url);
      } else if (bound === minBound) {
        candidates.push(url);
      }
    }
    if (!candidates.length) return null;
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    proxySelection.counts.set(picked, (proxySelection.counts.get(picked) || 0) + 1);
    return picked;
  }

  function buildPayload(account, row, options, proxySelection, now) {
    let proxyUrl = options.proxy_url || null;
    if (!proxyUrl && proxySelection) proxyUrl = pickLeastBoundProxyUrl(proxySelection);
    return {
      name: ensureShortName(row, now),
      // remark 是本地暂存字段（createAccount 前剥离），创建后经 setAccountNote 补写为 codex2api 备注
      remark: row.card_code,
      refresh_token: account.credentials?.refresh_token,
      ...(account.credentials?.session_token ? { session_token: account.credentials.session_token } : {}),
      ...(proxyUrl ? { proxy_url: proxyUrl } : {}),
      skip_refresh: options.skip_refresh !== false,
      allow_duplicate: false,
      ...(options.group_ids?.length ? { group_ids: options.group_ids } : {}),
      // 本地暂存字段（createAccount 前剥离）：Team 号不做余额分档，未配置就不补写
      score_bias: options.score_bias ?? null,
    };
  }

  /** 创建后补写指纹/并发/自动暂停（与主上传器同一套，best-effort）。 */
  async function applyAccountConfig(remoteId, options, scoreBias) {
    const patch = {};
    const fingerprintMode = normalizeCodexFingerprintMode(options.codex_fingerprint_mode);
    if (fingerprintMode !== 'off') patch.codex_fingerprint_mode = fingerprintMode;
    const concurrency = Number(options.base_concurrency);
    if (Number.isFinite(concurrency) && concurrency > 0) patch.base_concurrency_override = Math.floor(concurrency);
    const bias = Number(scoreBias);
    if (Number.isFinite(bias) && bias !== 0) patch.score_bias_override = Math.max(-200, Math.min(200, Math.floor(bias)));
    if (options.disable_auto_pause_5h) patch.auto_pause_5h_disabled = true;
    if (options.disable_auto_pause_7d) patch.auto_pause_7d_disabled = true;
    if (Object.keys(patch).length) {
      try {
        await client.updateScheduler(remoteId, patch);
      } catch (error) {
        logger?.warn?.({ remoteId, err: error.message }, 'team upload: apply account config failed');
      }
    }
  }

  /** 创建后补写备注（card_code；codex2api 创建接口不收 remark）。 */
  async function applyAccountNote(remoteId, note) {
    if (!note) return;
    try {
      await client.setAccountNote(remoteId, String(note).slice(0, 500));
    } catch (error) {
      logger?.warn?.({ remoteId, err: error.message }, 'team upload: set account note failed');
    }
  }

  async function uploadTeamAccounts(accountIds, optionsOverride = {}) {
    const codex2apiConfig = getCodex2apiConfig();
    if (!codex2apiConfig?.base_url || !codex2apiConfig?.admin_key) {
      throw errors.codex2apiNotConfigured('请先在 Codex2API 页面配置后端地址与管理员密钥');
    }
    const teamConfig = getTeamConfig() || {};
    const options = mergeUploadOptions(
      { ...(teamConfig.upload_defaults || {}), group_ids: teamConfig.group_ids ?? [] },
      optionsOverride,
    );

    const rows = loadRows(accountIds);
    if (!rows.length) {
      return {
        created: 0,
        updated: 0,
        failed: accountIds.map((id) => ({ id: Number(id), email: null, error: '账号不存在或缺少凭据' })),
      };
    }
    const now = new Date().toISOString();

    // 远端全量索引（按 email 查重分流）
    const existing = await client.listAllAccounts();
    const remoteByEmail = new Map();
    for (const acc of existing) {
      const email = client.accountEmail(acc);
      if (email && !remoteByEmail.has(email)) remoteByEmail.set(email, acc);
    }
    const proxySelection = await buildProxySelection(options);

    const toCreate = [];
    const toUpdate = [];
    const failed = [];
    const emailById = new Map();
    for (const row of rows) {
      const account = crypto.tryDecryptJson(row.account_enc, 'team_accounts.account_enc');
      const refreshToken = account?.credentials?.refresh_token;
      if (!account || typeof account !== 'object' || !refreshToken) {
        failed.push({ id: row.id, email: row.email, error: '凭据解密失败或缺少 refresh_token' });
        continue;
      }
      const email = extractAccountEmail(account) || String(row.email || '').toLowerCase();
      emailById.set(row.id, email);
      const payload = buildPayload(account, row, options, proxySelection, now);
      const remote = email ? remoteByEmail.get(email) : null;
      const remoteId = Number(remote?.id);
      if (Number.isSafeInteger(remoteId) && remoteId > 0) toUpdate.push({ id: row.id, payload, remote, remoteId });
      else toCreate.push({ id: row.id, payload, email });
    }

    let created = 0;
    const updatedIds = [];

    // 逐个创建（保留各自的简短名；响应直接给 created_ids，无需重拉索引回填）
    for (const item of toCreate) {
      try {
        const { score_bias, remark, ...send } = item.payload;
        if (!send.refresh_token) {
          failed.push({ id: item.id, email: item.email, error: '缺少 refresh_token' });
          continue;
        }
        const result = await client.createAccount(send);
        const createdIds = Array.isArray(result?.created_ids) ? result.created_ids.map(Number) : [];
        const remoteId = createdIds.find((id) => Number.isSafeInteger(id) && id > 0);
        if (Number.isSafeInteger(remoteId)) {
          created += 1;
          await applyAccountConfig(remoteId, options, score_bias);
          await applyAccountNote(remoteId, remark);
          db.prepare(
            `UPDATE team_accounts SET codex2api_uploaded_at = ?, codex2api_account_id = ?, updated_at = ? WHERE id = ?`,
          ).run(now, remoteId, now, item.id);
          continue;
        }
        // RT 查重被跳过/复活旧号：按 email 回找实体回填（复活语义计入 updated）
        const revived = item.email ? remoteByEmail.get(item.email) : null;
        const revivedId = Number(revived?.id);
        if (Number.isSafeInteger(revivedId) && revivedId > 0) {
          await applyAccountConfig(revivedId, options, item.payload.score_bias);
          updatedIds.push(item.id);
          db.prepare(
            `UPDATE team_accounts SET codex2api_uploaded_at = ?, codex2api_account_id = ?, updated_at = ? WHERE id = ?`,
          ).run(now, revivedId, now, item.id);
        } else {
          db.prepare(`UPDATE team_accounts SET codex2api_uploaded_at = ?, updated_at = ? WHERE id = ?`).run(now, now, item.id);
        }
      } catch (error) {
        failed.push({ id: item.id, email: item.email, error: String(error.message || error).slice(0, 400) });
      }
    }

    // 替换凭据：先建新（沿用远端原名/代理/分组 + 新 RT）→ 再删旧 → 回填新 id
    for (const item of toUpdate) {
      try {
        const { score_bias, remark, ...send } = item.payload;
        const replacement = await replaceAccountCredentials(client, {
          remoteId: item.remoteId,
          name: item.remote?.name || send.name,
          proxyUrl: item.remote?.proxy_url || send.proxy_url || null,
          groupIds: Array.isArray(item.remote?.group_ids) && item.remote.group_ids.length ? item.remote.group_ids : send.group_ids || null,
          refreshToken: send.refresh_token,
          sessionToken: send.session_token || null,
          skipRefresh: options.skip_refresh !== false,
          logger,
        });
        await applyAccountConfig(replacement.remoteId, options, score_bias);
        await applyAccountNote(replacement.remoteId, remark);
        updatedIds.push(item.id);
        db.prepare(
          `UPDATE team_accounts SET codex2api_uploaded_at = ?, codex2api_account_id = ?, updated_at = ? WHERE id = ?`,
        ).run(now, replacement.remoteId, now, item.id);
      } catch (error) {
        failed.push({ id: item.id, email: emailById.get(item.id), error: String(error.message || error).slice(0, 400) });
      }
    }

    return { created, updated: updatedIds.length, failed, updated_account_ids: updatedIds };
  }

  return { uploadTeamAccounts };
}
