import { TlsFingerprintTransport } from '../core/tls-transport.mjs';

/**
 * 用 curl_cffi TLS 指纹传输构造 fetch 兼容函数（供 chatgpt-credits 等服务端直调场景）。
 * 返回对象带 status/ok/text()/json()，与 fetch Response 最小兼容。
 */
export async function fetchWithTls(url, options = {}, { proxyUrl = null, timeoutMs = 30_000 } = {}) {
  const transport = new TlsFingerprintTransport({
    enabled: true,
    profile: proxyUrl ? 'chrome146' : 'auto',
    maxProxySessionAttempts: 3,
  });
  try {
    await transport.configure(proxyUrl || null, { force: true });
    return await transport.request(options.method || 'GET', url, {
      headers: options.headers,
      body: options.body,
      timeoutMs,
      retryRiskControl: true,
    });
  } finally {
    await transport.close();
  }
}

/** 一次性请求助手：带代理与超时，返回 { status, ok, json }。 */
export async function fetchJsonWithTls(url, options = {}, tlsOptions = {}) {
  const res = await fetchWithTls(url, options, tlsOptions);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}
