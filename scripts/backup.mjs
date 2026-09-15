#!/usr/bin/env node
/**
 * SQLite 在线备份（docs/v2/08-部署与运维.md §7）
 *
 * 用法：node scripts/backup.mjs [目标目录] [--with-secret]
 * 内部：db.backup()（SQLite backup API，WAL 安全）+ 复制 checkpoints/ + results/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const withSecret = argv.includes('--with-secret');
const targetArg = argv.find((a) => !a.startsWith('--')) || path.join(root, 'backups', `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);

const dataDir = process.env.TOCODEX2_DATA_DIR || path.join(root, 'data');
const dbPath = path.join(dataDir, 'tocodex2.db');

if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(targetArg, { recursive: true });

// 1. 在线备份 SQLite
const source = new Database(dbPath, { readonly: true });
const backupPath = path.join(targetArg, 'tocodex2.db');
await source.backup(backupPath);
source.close();
console.log(`✔ 数据库 → ${backupPath}`);

// 2. checkpoints / results
for (const dir of ['checkpoints', 'results', 'logs']) {
  const src = path.join(dataDir, dir);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(targetArg, dir);
  fs.cpSync(src, dest, { recursive: true });
  console.log(`✔ ${dir}/ → ${dest}`);
}

// 3. secret.key（可选；没有它备份无法解密）
const secretPath = path.join(dataDir, 'secret.key');
if (withSecret && fs.existsSync(secretPath)) {
  fs.copyFileSync(secretPath, path.join(targetArg, 'secret.key'));
  console.log(`✔ secret.key → ${targetArg}/secret.key`);
} else {
  console.log('⚠ 未包含 secret.key（加 --with-secret 一并备份；恢复时需同一密钥才能解密库内密文）');
}

console.log(`\n备份完成：${targetArg}`);
