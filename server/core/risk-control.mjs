/**
 * 与 core/protocol-login.mjs 的 isRiskControlResponse 同一判定口径的共享副本
 * （docs 01 §3.2.2：允许复制该函数作为共享工具，避免改动协议文件）。
 */
export function isRiskControlResponse(res, text) {
  const mitigated = res?.headers?.get?.('cf-mitigated') || res?.headers?.get?.('x-cf-mitigated');
  if (mitigated && /challenge/i.test(mitigated)) return true;
  const contentType = String(res?.headers?.get?.('content-type') || '');
  const body = String(text || '');
  const challengePage = /Just a moment|cdn-cgi|challenge-platform|cf-challenge/i.test(body);
  if (res?.status === 403) return /text\/html/i.test(contentType) || challengePage;
  const htmlPage = /text\/html/i.test(contentType) || /<(?:!doctype\s+html|html|head|body)\b/i.test(body);
  return [400, 409].includes(Number(res?.status)) && htmlPage && challengePage;
}

/** 归一化代理 URL（与 core normalizeProxyUrl 语义一致），返回 null 表示空。 */
export function normalizeProxyUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let withScheme = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(withScheme)) withScheme = `http://${withScheme}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址');
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('代理只支持 http、https、socks5 和 socks5h 协议');
  }
  return parsed.toString();
}
