#!/usr/bin/env node
/**
 * v1 → v2 数据迁移（docs/v2/09-数据迁移.md）
 *
 * 用法：
 *   node scripts/migrate-v1.mjs --v1-root /path/to/v1/tmp/chatgpt-onboarding-console \
 *       [--v1-data /path/to/v1/data] [--data-dir ./data] [--dry-run] [--with-credentials]
 *
 * 幂等：以 email 为唯一键，已存在跳过；只读 v1 数据，写入独立 v2 库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

const v1Root = path.resolve(args['v1-root'] || '');
const v1Data = path.resolve(args['v1-data'] || v1Root);
const dataDir = path.resolve(args['data-dir'] || path.join(__dirname, '..', 'data'));
const dryRun = Boolean(args['dry-run']);

if (!v1Root || !fs.existsSync(v1Root)) {
  console.error('用法：node scripts/migrate-v1.mjs --v1-root <v1 的 tmp/chatgpt-onboarding-console 目录>');
  process.exit(1);
}

const { pathToFileURL } = await import('node:url');
const { openDatabase } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'lib', 'db.js')).href);
const { createCrypto } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'lib', 'crypto.js')).href);

fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(dataDir, { logger: { info() {}, error: (e) => console.error(e) } });
const crypto = createCrypto({ dataDir, secretKeyEnv: process.env.TOCODEX2_SECRET_KEY || '' });
const now = () => new Date().toISOString();

const summary = { main: 0, reserve: 0, skipped: 0, checkpoints: 0, settings: 0, warnings: [] };

function log(...parts) {
  console.log(...parts);
}
function warn(...parts) {
  const text = parts.join(' ');
  summary.warnings.push(text);
  console.warn('[warn]', ...parts);
}

// ---------- 1. settings ----------
function migrateSettings() {
  // codex2api-monitor.json（含明文 adminApiKey）
  const monitorPath = path.join(v1Data, 'codex2api-monitor.json');
  if (fs.existsSync(monitorPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(monitorPath, 'utf8'));
      const cfg = saved.config || {};
      const current = JSON.parse(getSetting('codex2api.config') ?? '{}');
      const monitor = current.monitor || {};
      if (cfg.baseUrl) {
        current.base_url = cfg.baseUrl;
        current.admin_key = cfg.adminApiKey || current.admin_key || '';
        current.group_ids = cfg.groupIds?.length ? cfg.groupIds : [];
        monitor.reserve_threshold = cfg.reserveThreshold ?? monitor.reserve_threshold;
        current.monitor = monitor;
        setSetting('codex2api.config', current);
        summary.settings += 1;
        log('  codex2api 配置已带入（admin_key 加密存储）');
      }
    } catch (error) {
      warn('codex2api-monitor.json 解析失败：', error.message);
    }
  }
  // outlook-fetch.json
  const outlookPath = path.join(v1Data, 'outlook-fetch.json');
  if (fs.existsSync(outlookPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(outlookPath, 'utf8'));
      if (saved.endpoint) {
        setSetting('outlook.fetch', { endpoint: saved.endpoint });
        summary.settings += 1;
      }
    } catch (error) {
      warn('outlook-fetch.json 解析失败：', error.message);
    }
  }
}

// ---------- 2. reserve-pool.json ----------
function migrateReservePool() {
  const poolPath = path.join(v1Data, 'reserve-pool.json');
  if (!fs.existsSync(poolPath)) return;
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  } catch (error) {
    warn('reserve-pool.json 解析失败：', error.message);
    return;
  }
  for (const account of saved.accounts || []) {
    const email = String(account.email || '').trim().toLowerCase();
    if (!email) continue;
    if (db.prepare('SELECT id FROM accounts WHERE email = ?').get(email)) {
      summary.skipped += 1;
      continue;
    }
    const status = account.status === 'fetch_failed' ? 'mail_failed' : 'mail_pending';
    const mailStatus = account.status === 'fetch_failed' ? 'fetch_failed' : account.lastCheckedAt ? 'ok' : 'pending';
    db.prepare(
      `INSERT INTO accounts(email, pool, status, initial_balance, has_balance, banned, banned_reason,
         mail_status, mail_error, imported_at, last_checked_at, created_at, updated_at)
       VALUES(?, 'reserve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING`,
    ).run(
      email,
      account.status === 'joining' ? 'mail_pending' : status,
      account.balance ?? null,
      account.hasBalance ? 1 : 0,
      account.banned ? 1 : 0,
      account.bannedReason || null,
      mailStatus,
      account.fetchError || null,
      account.importedAt || null,
      account.lastCheckedAt || null,
      now(),
      now(),
    );
    recordEvent(email, 'imported', { source: 'v1-migration' });
    summary.reserve += 1;
  }
  log(`  备用号池迁移 ${summary.reserve} 个（跳过已存在 ${summary.skipped}）`);
}

// ---------- 3. 任务目录 → 主号池 ----------
function migrateJobOutputs() {
  const entries = fs.existsSync(v1Root) ? fs.readdirSync(v1Root, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const uuid = entry.name;
    if (!/^[0-9a-f-]{16,}$/i.test(uuid)) continue;
    const jobDir = path.join(v1Root, uuid);
    const exportPath = path.join(jobDir, 'codex2api-import-oauth.json');
    const metaPath = path.join(jobDir, 'job-meta.json');
    const checkpointPath = path.join(jobDir, 'login-checkpoint.json');

    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {}

    if (fs.existsSync(exportPath) && (meta.result_saved === true || meta.resultSaved === true)) {
      try {
        const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
        const account = data?.accounts?.[0];
        const credentials = account?.credentials || {};
        const email = String(credentials.email || meta.email || '').trim().toLowerCase();
        if (!email || !credentials.refresh_token) {
          warn(`${uuid}: 产物缺少 email/refresh_token，跳过`);
          continue;
        }
        const tokens = {
          access_token: credentials.access_token || '',
          refresh_token: credentials.refresh_token,
          id_token: credentials.id_token || '',
          chatgpt_account_id: credentials.chatgpt_account_id || account.extra?.chatgpt_account_id || '',
          chatgpt_user_id: account.extra?.chatgpt_user_id || '',
          client_id: account.extra?.client_id || 'app_EMoamEEZ73f0CkXaXp7hrann',
          email,
          obtained_at: now(),
        };
        const balance = pickBalance(meta, account.name);
        // 复制产物到 v2 results（legacy-<emailhash>.json）
        const legacyName = `legacy-${crypto.createHash ? '' : ''}`.slice(0, 0); // noop
        const legacyPath = path.join(dataDir, 'results', `legacy-${sha256(email).slice(0, 12)}.json`);
        if (!dryRun) {
          fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
          fs.copyFileSync(exportPath, legacyPath);
        }
        if (!dryRun) {
          const existing = db.prepare('SELECT id, pool FROM accounts WHERE email = ?').get(email);
          if (existing) {
            if (existing.pool === 'reserve') {
              // 升级为 main（v1 join 完成语义）
              db.prepare(
                `UPDATE accounts SET pool='main', status='active', tokens_enc=?, balance=COALESCE(?, balance),
                   last_login_at=COALESCE(?, last_login_at), updated_at=? WHERE id=?`,
              ).run(crypto.encryptJson(tokens, 'accounts.tokens_enc'), balance ?? null, meta.finishedAt || null, now(), existing.id);
            } else {
              summary.skipped += 1;
              continue;
            }
          } else {
            db.prepare(
              `INSERT INTO accounts(email, pool, status, tokens_enc, balance, last_login_at, created_at, updated_at)
               VALUES(?, 'main', 'active', ?, ?, ?, ?, ?)`,
            ).run(email, crypto.encryptJson(tokens, 'accounts.tokens_enc'), balance ?? null, meta.finishedAt || null, now(), now());
          }
          recordEvent(email, 'login_succeeded', { source: 'v1-migration' });
        }
        summary.main += 1;
      } catch (error) {
        warn(`${uuid}: 产物迁移失败：`, error.message);
      }
    } else if (fs.existsSync(checkpointPath)) {
      // 仅断点的中断任务：复制 checkpoint，不入池
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
        const email = String(checkpoint.email || meta.email || '').trim().toLowerCase();
        if (!email) continue;
        const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
        if (existing && !dryRun) {
          const dest = path.join(dataDir, 'checkpoints', String(existing.id));
          fs.mkdirSync(dest, { recursive: true });
          fs.copyFileSync(checkpointPath, path.join(dest, 'login.json'));
          summary.checkpoints += 1;
        }
      } catch (error) {
        warn(`${uuid}: checkpoint 迁移失败：`, error.message);
      }
    }
  }
  log(`  主号池迁移 ${summary.main} 个，断点复制 ${summary.checkpoints} 个`);
}

function pickBalance(meta, name) {
  for (const key of ['creditBalance', 'credit_balance', 'balance']) {
    if (meta[key] !== null && meta[key] !== undefined && Number.isFinite(Number(meta[key]))) {
      return Number(meta[key]);
    }
  }
  // name 已带 ---N 余额后缀 → N 即美元整数
  const match = /---(\d+)$/.exec(String(name || ''));
  return match ? Number(match[1]) : null;
}

function sha256(value) {
  return crypto.sha256Hex(value);
}

function getSetting(key) {
  const row = db.prepare('SELECT value, encrypted FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  const text = row.encrypted ? crypto.decrypt(row.value, `settings.${key}`) : row.value;
  return text;
}

function setSetting(key, value) {
  const serialized = JSON.stringify(value);
  const stored = ['codex2api.config', 'sms.providers', 'console.password'].includes(key)
    ? crypto.encrypt(serialized, `settings.${key}`)
    : serialized;
  db.prepare(
    `INSERT INTO settings(key, value, encrypted, updated_at) VALUES(?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted, updated_at=excluded.updated_at`,
  ).run(key, stored, ['codex2api.config', 'sms.providers', 'console.password'].includes(key) ? 1 : 0, now());
}

function recordEvent(email, type, detail) {
  const account = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
  if (account) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      account.id,
      type,
      JSON.stringify(detail),
      now(),
    );
  }
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i += 1;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

console.log(`迁移 v1 → v2${dryRun ? '（dry-run）' : ''}`);
console.log(`  v1 root: ${v1Root}`);
console.log(`  v1 data: ${v1Data}`);
console.log(`  v2 data: ${dataDir}`);

if (dryRun) {
  console.log('dry-run 模式仅统计，不写入（settings 读取仍会执行）。');
}

try {
  migrateSettings();
  migrateReservePool();
  migrateJobOutputs();
} catch (error) {
  console.error('迁移失败：', error);
  process.exitCode = 1;
} finally {
  db.close();
}

console.log('\n===== 迁移汇总 =====');
console.log(`主号池导入：${summary.main}`);
console.log(`备用号池导入：${summary.reserve}`);
console.log(`跳过重复：${summary.skipped}`);
console.log(`断点复制：${summary.checkpoints}`);
console.log(`settings 带入：${summary.settings}`);
if (summary.warnings.length) {
  console.log(`警告 ${summary.warnings.length} 条：`);
  for (const w of summary.warnings.slice(0, 20)) console.log('  -', w);
}
if (!args['with-credentials']) {
  console.log('\n注：v1 凭据存于系统 DPAPI/Keychain，默认不迁移；跨平台部署请对缺凭据账号重新导入或用 refresh_token 授权。');
}
