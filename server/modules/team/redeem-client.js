import { AppError } from '../../lib/http-errors.js';
import { sanitizeText } from '../../lib/sanitize.js';

/**
 * 30d.team 兑换服务客户端：公开端点，仅需卡密（card_code），无 API Key。
 * 直连不走代理（同 codex2api client 模式）。语义对齐官方 Python SDK redeem_api_sdk.py。
 */

const HEALTH_CHECK_TIMEOUT_MS = 90_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function createRedeemClient(getBaseUrl) {
  async function request(path, { method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const baseUrl = String(getBaseUrl() || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new AppError(400, 'REDEEM_NOT_CONFIGURED', '请先配置兑换服务地址');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = String(payload?.error || payload?.message || text || '').trim().slice(0, 300);
        throw new AppError(502, 'REDEEM_UNAVAILABLE', `兑换服务返回 HTTP ${response.status}${message ? `：${sanitizeText(message)}` : ''}`);
      }
      if (payload && typeof payload === 'object' && payload.ok === false) {
        throw new AppError(502, 'REDEEM_API_ERROR', sanitizeText(String(payload?.error || '兑换服务返回未知错误')).slice(0, 300));
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError') {
        throw new AppError(504, 'REDEEM_UNAVAILABLE', '兑换服务请求超时');
      }
      throw new AppError(502, 'REDEEM_UNAVAILABLE', `无法连接兑换服务：${sanitizeText(String(error.message || error))}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 检测卡密下账号状态（只读）。 */
  async function healthCheck(cardCodes) {
    const payload = await request('/api/redeem/reclaim/health-check', {
      method: 'POST',
      body: { card_codes: cardCodes },
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    });
    return {
      ok: true,
      need_reclaim: Number(payload?.need_reclaim ?? 0),
      healthy: Number(payload?.healthy ?? 0),
      cannot_reclaim: Number(payload?.cannot_reclaim ?? 0),
      unknown: Number(payload?.unknown ?? 0),
      total: Number(payload?.total ?? 0),
      not_loadable: Number(payload?.not_loadable ?? 0),
      credentials: Array.isArray(payload?.credentials) ? payload.credentials.filter((c) => c && typeof c === 'object') : [],
    };
  }

  function parseTask(t, defaultCardCode = '') {
    return {
      card_code: String(t?.card_code || defaultCardCode || ''),
      order_no: String(t?.order_no || ''),
      resource_uid: String(t?.resource_uid || ''),
      status: String(t?.status || ''),
      message: String(t?.message || ''),
      no_action: Boolean(t?.no_action),
      permanent: Boolean(t?.permanent),
      error_code: String(t?.error_code || ''),
      download_token: String(t?.download_token || ''),
      download_error: String(t?.download_error || ''),
    };
  }

  /** 批量找回 / 只读刷新进度（query_only=true 时不入队新任务）。mode: '401' 只找回 401 / 'all' 全部。 */
  async function batchCards(cardCodes, { mode = '401', queryOnly = false } = {}) {
    const payload = await request('/api/redeem/reclaim/batch-cards', {
      method: 'POST',
      body: { card_codes: cardCodes, mode, query_only: queryOnly },
    });
    const tasks = [];
    for (const card of Array.isArray(payload?.cards) ? payload.cards : []) {
      if (!card || typeof card !== 'object') continue;
      const cardCode = String(card.card_code || '');
      for (const t of Array.isArray(card.tasks) ? card.tasks : []) {
        if (t && typeof t === 'object') tasks.push(parseTask(t, cardCode));
      }
    }
    return {
      ok: true,
      total: Number(payload?.total ?? 0),
      requested_cards: Number(payload?.requested_cards ?? 0),
      valid_cards: Number(payload?.valid_cards ?? 0),
      queued: Number(payload?.queued ?? 0),
      already_running: Number(payload?.already_running ?? 0),
      done: Number(payload?.done ?? 0),
      unreclaimable: Number(payload?.unreclaimable ?? 0),
      not_owned: Number(payload?.not_owned ?? 0),
      skipped: Number(payload?.skipped ?? 0),
      failed: Number(payload?.failed ?? 0),
      tracked_tasks: Number(payload?.tracked_tasks ?? 0),
      all_tasks: tasks,
    };
  }

  /** 下载找回后的凭据 JSON（codex2api 格式，accounts 数组）。 */
  async function downloadOrder(orderNo, token) {
    const payload = await request(
      `/api/redeem/orders/${encodeURIComponent(orderNo)}/download?token=${encodeURIComponent(token)}`,
    );
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.accounts)) {
      throw new AppError(502, 'REDEEM_API_ERROR', `订单 ${orderNo} 下载的凭据不是合法的 codex2api JSON`);
    }
    return payload;
  }

  return { healthCheck, batchCards, downloadOrder };
}
