/**
 * 2FA 在线取件（2fa.show 风格）：URL 模板解析 + HTTP 取码。
 * 模板中的 {code}（或结尾 xxx）占位符替换为账号的 2FA 取件码；
 * 响应支持纯文本 6 位码、HTML（id="code" 元素）与任意文本中的首个 6 位数字。
 */

export const TOTP_WINDOW_MS = 30_000;
export const DEFAULT_TWOFA_FETCH_TEMPLATE = 'https://2fa.show/2fa/{code}';

/** 模板 + 取件码 -> 实际取码 URL；无取件码返回空串（表示该账号未启用在线取件）。 */
export function resolveTotpPickupUrl(template, pickupCode) {
  const code = String(pickupCode || '').trim();
  if (!code) return '';
  const tpl = String(template || '').trim() || DEFAULT_TWOFA_FETCH_TEMPLATE;
  if (tpl.includes('{code}')) return tpl.replaceAll('{code}', encodeURIComponent(code));
  if (/xxx$/i.test(tpl)) return tpl.slice(0, -3) + encodeURIComponent(code);
  return `${tpl.replace(/\/+$/, '')}/${encodeURIComponent(code)}`;
}

/** 距下一个 TOTP 30s 窗口边界的毫秒数（+0.5s 余量，供验证码被拒后等待换码）。 */
export function msUntilNextTotpWindow(now = Date.now()) {
  return TOTP_WINDOW_MS - (now % TOTP_WINDOW_MS) + 500;
}

/** 从响应文本提取 6 位验证码；提取不到返回 null。 */
export function extractTotpCodeFromText(text) {
  const raw = String(text || '').trim();
  if (/^\d{6}$/.test(raw)) return raw;
  const tagged = raw.match(/id=["']code["'][^>]*>\s*(\d{6})\b/i);
  if (tagged) return tagged[1];
  const loose = raw.match(/\b(\d{6})\b/);
  return loose ? loose[1] : null;
}

/** GET 取码 URL 并解析 6 位验证码；失败抛错（调用方决定重试或转人工）。 */
export async function fetchTotpCodeFromPickupUrl(url, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) throw new Error('2FA pickup URL invalid');
  const response = await fetchImpl(target, {
    headers: {
      accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`2FA pickup HTTP ${response.status}`);
  const code = extractTotpCodeFromText(await response.text());
  if (!code) throw new Error('2FA pickup response contains no 6-digit code');
  return code;
}
