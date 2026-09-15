import crypto from 'node:crypto';

/**
 * 备用号池导入：四段格式解析（邮箱----密码----clientId----refreshToken）+ 校验。
 * 与 v1 parseOutlookEntries 语义一致，但逐行返回结果（不因单行失败中断）。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseImportLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const results = [];
  const seenInBatch = new Map(); // email -> line

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const parts = line.split('----');
    if (parts.length < 4) {
      results.push({ line: lineNo, ok: false, reason: '格式错误，需要 4 段：邮箱----密码----clientId----refreshToken' });
      return;
    }
    const email = parts[0].trim().toLowerCase();
    const password = parts[1].trim();
    const clientId = parts[2].trim();
    const refreshToken = parts.slice(3).join('----').trim();

    if (!EMAIL_PATTERN.test(email)) {
      results.push({ line: lineNo, ok: false, reason: '邮箱格式错误', raw: maskRaw(parts[0]) });
      return;
    }
    if (!password) {
      results.push({ line: lineNo, ok: false, reason: '邮箱密码不能为空' });
      return;
    }
    if (!UUID_PATTERN.test(clientId)) {
      results.push({ line: lineNo, ok: false, reason: 'clientId 不是 UUID', raw: maskRaw(parts[2]) });
      return;
    }
    if (refreshToken.length < 100) {
      results.push({ line: lineNo, ok: false, reason: 'refresh_token 长度不足', raw: maskRaw(parts[3]) });
      return;
    }
    if (seenInBatch.has(email)) {
      results.push({ line: lineNo, ok: false, duplicateInBatch: true, email, reason: '与第 ' + seenInBatch.get(email) + ' 行重复' });
      return;
    }
    seenInBatch.set(email, lineNo);
    results.push({ line: lineNo, ok: true, email, password, clientId, refreshToken });
  });

  return results;
}

function maskRaw(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 6)}...` : '***';
}

/**
 * 2FA 取件码导入：两段格式解析（邮箱----2FA取件码）。
 * 返回逐行结果；ok 行带 { email, pickupCode }，供路由按邮箱关联到账号。
 */
const PICKUP_CODE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function parseTwofaLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const results = [];
  const seenInBatch = new Map(); // email -> line

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const parts = line.split('----');
    if (parts.length !== 2) {
      results.push({ line: lineNo, ok: false, reason: '格式错误，需要 2 段：邮箱----2FA取件码' });
      return;
    }
    const email = parts[0].trim().toLowerCase();
    const pickupCode = parts[1].trim();

    if (!EMAIL_PATTERN.test(email)) {
      results.push({ line: lineNo, ok: false, reason: '邮箱格式错误', raw: maskRaw(parts[0]) });
      return;
    }
    if (!PICKUP_CODE_PATTERN.test(pickupCode)) {
      results.push({ line: lineNo, ok: false, reason: '2FA 取件码应为 8-128 位字母数字', raw: maskRaw(parts[1]) });
      return;
    }
    if (seenInBatch.has(email)) {
      results.push({ line: lineNo, ok: false, duplicateInBatch: true, email, reason: '与第 ' + seenInBatch.get(email) + ' 行重复' });
      return;
    }
    seenInBatch.set(email, lineNo);
    results.push({ line: lineNo, ok: true, email, pickupCode });
  });

  return results;
}

export function credentialsForImport(entry) {
  // 无 Outlook 取件凭据的条目（如仅有 2FA / ChatGPT 密码）不落空 outlook 对象
  const credentials = {};
  if (entry.password || entry.clientId || entry.refreshToken) {
    credentials.outlook = {
      password: entry.password,
      client_id: entry.clientId,
      refresh_token: entry.refreshToken,
    };
  }
  if (entry.pickupCode) credentials.totp_pickup_code = entry.pickupCode;
  if (entry.chatgptPassword) credentials.password = entry.chatgptPassword;
  if (entry.totpSecret) credentials.totp_secret = entry.totpSecret;
  if (entry.phone) credentials.phone = entry.phone;
  if (entry.mailApiUrl) credentials.mail_api_url = entry.mailApiUrl;
  return credentials;
}

/**
 * tocodex2 跨实例导出文件解析：与 buildTocodex2ExportPayload 互逆。
 * 返回 { ok, error, entries }；entries 与 parseImportLines 的 ok 行同构，
 * 额外携带 note / banned / bannedReason / initialBalance / hasBalance 供建号时还原。
 */
export function parseTocodex2Export(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '内容为空', entries: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件', entries: [] };
  }
  // 兼容 tosub2 时代导出的旧文件（type: tosub2-accounts），格式本体一致
  const EXPORT_TYPES = ['tocodex2-accounts', 'tosub2-accounts'];
  if (!data || !EXPORT_TYPES.includes(data.type) || !Array.isArray(data.accounts)) {
    return { ok: false, error: '不是 tocodex2 账号导出文件（缺少 type: tocodex2-accounts）', entries: [] };
  }

  const entries = [];
  const invalid = [];
  const seenInBatch = new Map();
  data.accounts.forEach((item, index) => {
    const lineNo = index + 1;
    const email = String(item?.email || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      invalid.push({ line: lineNo, reason: `邮箱格式错误：${maskRaw(item?.email)}` });
      return;
    }
    const c = item?.credentials && typeof item.credentials === 'object' ? item.credentials : {};
    const outlook = c.outlook && typeof c.outlook === 'object' ? c.outlook : {};
    // 带 OAuth tokens 的条目视为主号池账号，导入时直入主号池
    const rawTokens = item?.tokens && typeof item.tokens === 'object' && !Array.isArray(item.tokens) ? item.tokens : null;
    const tokens = rawTokens && (rawTokens.refresh_token || rawTokens.access_token) ? rawTokens : null;
    const entry = {
      email,
      tokens,
      mainStatus: tokens && item?.status === 'needs_reauth' ? 'needs_reauth' : 'active',
      balance: Number.isFinite(item?.balance) ? Number(item.balance) : null,
      lastLoginAt: typeof item?.last_login_at === 'string' ? item.last_login_at : null,
      password: outlook.password || '',
      clientId: outlook.client_id || '',
      refreshToken: outlook.refresh_token || '',
      pickupCode: c.totp_pickup_code || '',
      totpSecret: c.totp_secret ? String(c.totp_secret).toUpperCase().replace(/[\s=]/g, '') : '',
      chatgptPassword: c.password || '',
      phone: c.phone || '',
      mailApiUrl: c.mail_api_url || '',
      note: typeof item.note === 'string' ? item.note.slice(0, 500) : '',
      banned: Boolean(item.banned),
      bannedReason: typeof item.banned_reason === 'string' ? item.banned_reason.slice(0, 500) : '',
      initialBalance: Number.isFinite(item?.initial_balance) ? Number(item.initial_balance) : null,
      hasBalance: item?.initial_balance != null && Number.isFinite(item?.initial_balance),
    };
    const hasAnyCredential =
      entry.password || entry.clientId || entry.refreshToken || entry.pickupCode || entry.totpSecret || entry.chatgptPassword || entry.phone || entry.mailApiUrl;
    if (!hasAnyCredential && !tokens) {
      invalid.push({ line: lineNo, reason: `账号 ${email} 没有任何凭据字段` });
      return;
    }
    if (entry.totpSecret && !/^[A-Z2-7]{16,128}$/.test(entry.totpSecret)) {
      invalid.push({ line: lineNo, reason: `账号 ${email} 的 2FA 密钥不是合法 Base32` });
      return;
    }
    if (seenInBatch.has(email)) {
      invalid.push({ line: lineNo, reason: `与第 ${seenInBatch.get(email)} 个账号重复` });
      return;
    }
    seenInBatch.set(email, lineNo);
    entries.push(entry);
  });

  return { ok: true, error: null, entries, invalid };
}

/**
 * codex2api 账号导出文件解析（{ accounts: [...] } 或裸数组，注册号交付格式）。
 * accounts[].notes 是 JSON 字符串，携带账号全部凭据：
 *  - mailbox：邮箱四段（bind_email / password 邮箱密码 / client_id / refresh_token）
 *  - gpt.password：ChatGPT 登录密码（勿与 mailbox.password 邮箱密码混淆）
 *  - two_factor.enabled + secret：两步验证开关与密钥（同时作为本地 TOTP 密钥与在线取件码）
 * accounts[].credentials 的 access/refresh token 一律忽略：加入主号池必须走本系统
 * 自己的登录授权（join-main），原登录态不带入；credentials.email 仅作邮箱兜底。
 * 返回结构同 parseTocodex2Export（tokens 恒为空），entries 直接复用导入路由的入库逻辑。
 */
export function parseCodex2apiAccountsExport(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '内容为空', entries: [], invalid: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件', entries: [], invalid: [] };
  }
  const accounts = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : null;
  if (!accounts) {
    return { ok: false, error: '不是 codex2api 账号导出文件（缺少 accounts 数组）', entries: [], invalid: [] };
  }

  const entries = [];
  const invalid = [];
  const seenInBatch = new Map();
  accounts.forEach((item, index) => {
    const lineNo = index + 1;
    const account = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    let notes = {};
    try {
      const parsedNotes = JSON.parse(String(account.notes || ''));
      if (parsedNotes && typeof parsedNotes === 'object' && !Array.isArray(parsedNotes)) notes = parsedNotes;
    } catch {
      // notes 缺失或不是 JSON：退化为 name/credentials 兜底解析
    }
    const mailbox = notes.mailbox && typeof notes.mailbox === 'object' ? notes.mailbox : {};
    const gpt = notes.gpt && typeof notes.gpt === 'object' ? notes.gpt : {};
    const twoFactor = notes.two_factor && typeof notes.two_factor === 'object' ? notes.two_factor : {};
    // name 形如 email----取件密码----GPT密码：notes 缺失时按段兜底
    const nameParts = String(account.name || '').split('----').map((p) => p.trim());

    const email = String(
      mailbox.bind_email || mailbox.primary_email || account.credentials?.email || account.extra?.email || nameParts[0] || '',
    )
      .trim()
      .toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      invalid.push({ line: lineNo, reason: `邮箱格式错误：${maskRaw(mailbox.bind_email || account.credentials?.email || account.extra?.email || nameParts[0])}` });
      return;
    }

    const password = String(mailbox.password || '').trim();
    const clientId = String(mailbox.client_id || '').trim();
    const refreshToken = String(mailbox.refresh_token || '').trim();
    const chatgptPassword = String(gpt.password || (nameParts.length >= 3 ? nameParts[2] : '')).trim();
    const twoFactorEnabled = twoFactor.enabled === true || twoFactor.status === 'enabled';
    const totpSecret = twoFactorEnabled ? String(twoFactor.secret || '').toUpperCase().replace(/[\s=]/g, '') : '';

    if (clientId && !UUID_PATTERN.test(clientId)) {
      invalid.push({ line: lineNo, reason: `账号 ${email} 的 clientId 不是 UUID`, raw: maskRaw(clientId) });
      return;
    }
    if (refreshToken && refreshToken.length < 100) {
      invalid.push({ line: lineNo, reason: `账号 ${email} 的 refresh_token 长度不足`, raw: maskRaw(refreshToken) });
      return;
    }
    if (totpSecret && !/^[A-Z2-7]{16,128}$/.test(totpSecret)) {
      invalid.push({ line: lineNo, reason: `账号 ${email} 的两步验证密钥不是合法 Base32` });
      return;
    }
    const hasAnyCredential = password || clientId || refreshToken || totpSecret || chatgptPassword;
    if (!hasAnyCredential) {
      invalid.push({ line: lineNo, reason: `账号 ${email} 没有任何凭据字段（credentials 里的 OAuth tokens 不导入）` });
      return;
    }
    if (seenInBatch.has(email)) {
      invalid.push({ line: lineNo, reason: `与第 ${seenInBatch.get(email)} 个账号重复` });
      return;
    }
    seenInBatch.set(email, lineNo);
    entries.push({
      email,
      tokens: null,
      password,
      clientId,
      refreshToken,
      // 两步验证密钥同时落在本地 TOTP 密钥与在线取件码（模板 URL 拼接取码）
      pickupCode: totpSecret || '',
      totpSecret,
      chatgptPassword,
      phone: '',
      mailApiUrl: '',
      note: '',
      banned: false,
      bannedReason: '',
      initialBalance: null,
      hasBalance: false,
    });
  });

  return { ok: true, error: null, entries, invalid };
}

/**
 * ChatGPT 会话导出文件解析：密码在 meta.label 的第 3 段（label 形如 "email----xxxx----密码"）。
 * 只有邮箱或不足 3 段的条目视为无密码账号，跳过；也兼容直接粘贴 label 行。
 * 返回 { ok, passwords: Map<email, password>, error }。
 */
export function parsePasswordFileText(text) {
  const raw = String(text || '').trim();
  const passwords = new Map();
  if (!raw) return { ok: true, passwords, error: null };

  const addLabel = (label) => {
    const parts = String(label || '').split('----').map((p) => p.trim());
    if (parts.length < 3) return;
    const email = parts[0].toLowerCase();
    const password = parts[2];
    if (!EMAIL_PATTERN.test(email) || !password) return;
    if (!passwords.has(email)) passwords.set(email, password);
  };

  if (raw.startsWith('[') || raw.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, passwords, error: '密码文件不是合法的 JSON' };
    }
    for (const item of Array.isArray(data) ? data : [data]) addLabel(item?.meta?.label);
    return { ok: true, passwords, error: null };
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    addLabel(trimmed);
  }
  return { ok: true, passwords, error: null };
}

export function proxyUrlHash(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}
