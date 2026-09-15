/**
 * tocodex2 跨实例导出：把账号行（含解密后的完整凭据）组装成可再导入的 JSON 载荷。
 * 凭据字段与 accounts.credentials_enc 结构一一对应，导入侧见 parseTocodex2Export。
 * 主号池条目额外携带 OAuth tokens（tokens_enc 解密结果）与余额/状态。
 */

export const TOCODEX2_EXPORT_TYPE = 'tocodex2-accounts';
export const TOCODEX2_EXPORT_VERSION = 1;

export function buildTocodex2ExportPayload({ rows, decryptCredentials, decryptTokens, now = new Date() }) {
  const accounts = rows.map((row) => {
    const credentials = decryptCredentials(row) || {};
    const entry = {
      email: row.email,
      pool: row.pool,
      note: row.note || null,
      banned: Boolean(row.banned),
      banned_reason: row.banned_reason || null,
      initial_balance: row.has_balance ? row.initial_balance : null,
      credentials: {},
    };
    if (row.pool === 'main') {
      entry.status = row.status === 'needs_reauth' ? 'needs_reauth' : 'active';
      entry.balance = Number.isFinite(row.balance) ? Number(row.balance) : null;
      entry.last_login_at = row.last_login_at || null;
      const tokens = decryptTokens ? decryptTokens(row) : null;
      if (tokens && typeof tokens === 'object') entry.tokens = tokens;
    }
    const c = entry.credentials;
    if (credentials.password) c.password = credentials.password;
    if (credentials.totp_pickup_code) c.totp_pickup_code = credentials.totp_pickup_code;
    if (credentials.totp_secret) c.totp_secret = credentials.totp_secret;
    if (credentials.phone) c.phone = credentials.phone;
    if (credentials.mail_api_url) c.mail_api_url = credentials.mail_api_url;
    if (credentials.outlook && typeof credentials.outlook === 'object') {
      const outlook = {};
      if (credentials.outlook.password) outlook.password = credentials.outlook.password;
      if (credentials.outlook.client_id) outlook.client_id = credentials.outlook.client_id;
      if (credentials.outlook.refresh_token) outlook.refresh_token = credentials.outlook.refresh_token;
      if (Object.keys(outlook).length) c.outlook = outlook;
    }
    return entry;
  });
  return {
    type: TOCODEX2_EXPORT_TYPE,
    version: TOCODEX2_EXPORT_VERSION,
    exported_at: now.toISOString(),
    accounts,
  };
}

export function tocodex2ExportFilename(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  return `tocodex2-accounts-${stamp}.json`;
}
