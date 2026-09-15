// 诊断脚本：只读复现 proxy-replace 流程的前置步骤（listProxies / listAllOpenAiAccounts），
// 检查真实 codex2api 返回的数据形状。不做任何创建/改绑/删除操作。
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createSettingsService } from '../lib/settings.js';
import { createCodex2apiClient } from '../modules/codex2api/client.js';

const dataDir = new URL('../../data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const db = openDatabase(dataDir, { logger: null });
const crypto = createCrypto({ dataDir, secretKeyEnv: '', logger: null });
const settings = createSettingsService(db, crypto, { logger: null });
const config = settings.get('codex2api.config');
console.log('base_url =', config?.base_url);
console.log('admin_key set =', Boolean(config?.admin_key), '(len', String(config?.admin_key || '').length + ')');

const client = createCodex2apiClient(() => config);

const proxiesPayload = await client.listProxies({ withCount: true });
const proxies = Array.isArray(proxiesPayload) ? proxiesPayload : proxiesPayload?.data ?? [];
console.log('\n--- proxies list raw (first entry) ---');
console.log(JSON.stringify(proxies[0] ?? null, null, 2));
console.log('proxy count =', proxies.length);
console.log('all proxy keys =', proxies.flatMap((p) => Object.keys(p)));

const accounts = await client.listAllOpenAiAccounts();
console.log('\n--- openai accounts ---');
console.log('account count =', accounts.length);
console.log('first account =', JSON.stringify(accounts[0] ?? null, null, 2).slice(0, 800));

// 模拟 replaceProxies 中"复用匹配"的 identity 计算（只读）
const { proxyIdentity } = await import('../modules/codex2api/proxy-replace.js');
console.log('\n--- identity of existing proxies (fields actually present) ---');
for (const p of proxies) {
  console.log(JSON.stringify({ id: p.id, name: p.name, host: p.host, port: p.port, username: p.username, password: p.password }), '=>', proxyIdentity(p));
}
db.close();
