import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

export function listMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  return files.map((name) => {
    const version = Number.parseInt(name.slice(0, 4), 10);
    return { version, name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') };
  });
}

export function openDatabase(dataDir, { logger = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'tocodex2.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const current = db.pragma('user_version', { simple: true });
  const migrations = listMigrations();
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      logger?.info?.({ migration: m.name }, 'applied migration');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.name} 执行失败：${error.message}`);
    }
  }
  return db;
}

/** 清理 N 天前的终态任务（连日志/产物文件），任务全量保留、仅由手动清理接口触发。 */
export function cleanupFinishedJobs(db, dataDir, retentionDays = 30, logger = null) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, log_path, result_path FROM jobs
       WHERE status IN ('completed','failed','canceled') AND COALESCE(finished_at, updated_at, created_at) < ?`,
    )
    .all(cutoff);
  if (!rows.length) return 0;
  const remove = db.prepare('DELETE FROM jobs WHERE id = ?');
  const run = db.transaction((list) => {
    for (const row of list) {
      remove.run(row.id);
      for (const p of [row.log_path, row.result_path]) {
        if (!p) continue;
        const resolved = path.resolve(dataDir, p);
        if (!resolved.startsWith(path.resolve(dataDir))) continue;
        fs.rmSync(resolved, { force: true });
      }
    }
  });
  run(rows);
  logger?.info?.({ removed: rows.length }, 'cleaned finished jobs');
  return rows.length;
}

export function paginated(items, total, page, pageSize) {
  return { items, total, page, page_size: pageSize };
}

export function parsePagination(query, { maxPageSize = 200 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.parseInt(query.page_size || '50', 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
