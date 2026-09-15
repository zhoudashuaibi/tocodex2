/**
 * codex2api 账号命名约定与安全化。
 *
 * codex2api 自 2026-03「安全加固」起对账号名称做 XSS / SQL 注入过滤
 * （security.ContainsXSS / ContainsSQLInjection），名称里出现 `--`、`;`、`|`、
 * 斜杠星号对或 SQL 关键词后跟空白，即 400「名称包含非法字符」。
 * 历史命名 `oauth---<email>---<N>` 的 `---` 正中 `--` 特征，创建/替换一律被拒。
 *
 * 现约定改用 `::` 分隔：`oauth::<email>`，上传时追加余额后缀成 `oauth::<email>::<N>`。
 * 选 `:` 的两个硬条件：
 *  1. 不在 codex2api 的过滤特征集内；
 *  2. 不在 accountEmail 邮箱本地部分字符类（字母数字与 .!#$%&'*+/=?^_`{|}~- 等）里，
 *     从名称反解邮箱时 `oauth::` 前缀不会被吞进本地部分（旧 `---` 约定正有此隐患）。
 * 邮箱本身不可能含 `:`，反解无歧义；远端历史遗留的 `oauth---` 名字仍可被
 * accountEmail / 余额后缀解析兼容读取，仅在再次写回 codex2api 前被 sanitize 归一。
 */

export const ACCOUNT_NAME_PREFIX = 'oauth';
export const ACCOUNT_NAME_SEPARATOR = '::';
const ACCOUNT_NAME_MAX_LEN = 100; // codex2api AddAccount 名称长度上限（rune 计）

/** 余额后缀（新旧两种命名都要认：新 `::N`，历史遗留 `---N`）。 */
export const BALANCE_SUFFIX_RE = /(?:---|::)(\d+)$/;

/**
 * 把任意来源的账号名称（本地新造 / 远端历史遗留）转成能过 codex2api 过滤的形式：
 *  - `-{2,}`（含历史约定的 `---`）→ `::`
 *  - `;` `|` 与斜杠星号对（其余注入特征）→ 剔除
 *  - 超 100 rune 截断（邮箱超长属于病态输入，截断后靠 codex2api 刷新回填的
 *    email 字段兜底识别）
 */
export function sanitizeAccountName(name) {
  let cleaned = String(name ?? '')
    .trim()
    .replace(/-{2,}/g, ACCOUNT_NAME_SEPARATOR)
    .replace(/[;|]/g, '')
    .replace(/\/\*|\*\//g, '');
  if (cleaned.length > ACCOUNT_NAME_MAX_LEN) cleaned = [...cleaned].slice(0, ACCOUNT_NAME_MAX_LEN).join('');
  return cleaned;
}

/**
 * 构建上传命名：`oauth::<email>`；balance 非空时追加 `::<四舍五入余额>`。
 * email 缺省用 'account' 占位（codex2api 刷新回填 email 前无法从名字识别邮箱）。
 */
export function buildAccountName(email, balance = null) {
  const emailPart = String(email || 'account').trim().toLowerCase() || 'account';
  const usd = Math.round(Number(balance));
  const suffix = balance === null || balance === undefined || balance === '' || !Number.isFinite(usd) ? '' : `${ACCOUNT_NAME_SEPARATOR}${usd}`;
  return sanitizeAccountName(`${ACCOUNT_NAME_PREFIX}${ACCOUNT_NAME_SEPARATOR}${emailPart}${suffix}`);
}

/** 名称里的余额后缀 → 整数美元；无后缀返回 null（口径与 appendBalanceSuffix 一致）。 */
export function balanceFromAccountName(name) {
  const match = String(name || '').match(BALANCE_SUFFIX_RE);
  if (!match) return null;
  const balance = Number(match[1]);
  return Number.isSafeInteger(balance) && balance >= 0 ? balance : null;
}
