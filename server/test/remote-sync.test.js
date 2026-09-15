import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createRemoteSync, extractRemoteProxy } from '../modules/codex2api/remote-sync.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tocodex2-remote-sync-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  return { dataDir, db, crypto };
}

beforeEach(() => {
  ctx = setup();
});

function insertMain(db, { email, codex2apiAccountId = null, codex2apiStatus = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, codex2api_account_id, codex2api_status, created_at, updated_at)
       VALUES(?, 'main', 'active', 'ok', ?, ?, ?, ?)`,
    )
    .run(email, codex2apiAccountId, codex2apiStatus, now, now);
  return Number(result.lastInsertRowid);
}

/** codex2api 账号形状：email 平铺、代理绑定是 proxy_url 字符串。 */
function remoteAccount({ id, email, status = 'active', proxyUrl = null }) {
  return { id, email, status, ...(proxyUrl ? { proxy_url: proxyUrl } : {}) };
}

function buildSync({ remoteAccounts = [], proxies = [], configured = true } = {}) {
  const client = {
    listAllAccounts: async () => remoteAccounts,
    listProxies: async () => proxies,
    accountEmail: (account) => account?.email || null,
  };
  return createRemoteSync({
    db: ctx.db,
    client,
    getConfig: () => (configured ? { base_url: 'http://codex2api.test', admin_key: 'sk-test' } : {}),
    logger,
  });
}

test('syncRemoteStatus：按 email 回填远端 ID 并镜像 status', async () => {
  const id = insertMain(ctx.db, { email: 'a@test.local' });
  const sync = buildSync({
    remoteAccounts: [remoteAccount({ id: 7, email: 'a@test.local' })],
  });

  const stats = await sync.syncRemoteStatus();

  assert.equal(stats.scanned, 1);
  assert.equal(stats.linked, 1);
  const row = ctx.db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  assert.equal(row.codex2api_account_id, 7);
  assert.equal(row.codex2api_status, 'active');
  assert.ok(row.codex2api_uploaded_at);
  const events = ctx.db.prepare(`SELECT type FROM account_events WHERE account_id=?`).all(id);
  assert.deepEqual(events.map((e) => e.type), ['codex2api_linked']);
});

test('syncRemoteStatus：ID 已正确时仅镜像 status，无变化不写库', async () => {
  const id = insertMain(ctx.db, { email: 'a@test.local', codex2apiAccountId: 7 });
  const sync = buildSync({
    remoteAccounts: [remoteAccount({ id: 7, email: 'a@test.local', status: 'error' })],
  });

  const first = await sync.syncRemoteStatus();
  assert.equal(first.status_updated, 1);
  assert.equal(ctx.db.prepare('SELECT codex2api_status FROM accounts WHERE id=?').get(id).codex2api_status, 'error');

  const second = await sync.syncRemoteStatus();
  assert.equal(second.status_updated, 0);
  assert.equal(second.linked, 0);
});

test('syncRemoteStatus：远端已不存在 → 清除本地关联并记事件', async () => {
  const id = insertMain(ctx.db, { email: 'gone@test.local', codex2apiAccountId: 9, codex2apiStatus: 'active' });
  const sync = buildSync({ remoteAccounts: [] });

  const stats = await sync.syncRemoteStatus();

  assert.equal(stats.unlinked, 1);
  const row = ctx.db.prepare('SELECT codex2api_account_id, codex2api_status FROM accounts WHERE id=?').get(id);
  assert.equal(row.codex2api_account_id, null);
  assert.equal(row.codex2api_status, null);
});

test('syncRemoteStatus：优先按本地 ID 匹配（email 变更仍能关联）', async () => {
  const id = insertMain(ctx.db, { email: 'renamed@test.local', codex2apiAccountId: 5 });
  const sync = buildSync({
    remoteAccounts: [remoteAccount({ id: 5, email: 'old@test.local' })],
  });

  await sync.syncRemoteStatus();

  const row = ctx.db.prepare('SELECT codex2api_account_id, codex2api_status FROM accounts WHERE id=?').get(id);
  assert.equal(row.codex2api_account_id, 5);
  assert.equal(row.codex2api_status, 'active');
});

test('syncRemoteStatus：同邮箱多远端账号 → 记一次 codex2api_duplicate 事件并统计', async () => {
  const id = insertMain(ctx.db, { email: 'dup@test.local', codex2apiAccountId: 20 });
  const sync = buildSync({
    remoteAccounts: [
      remoteAccount({ id: 20, email: 'dup@test.local' }),
      remoteAccount({ id: 30, email: 'dup@test.local', status: 'error' }),
    ],
  });

  const first = await sync.syncRemoteStatus();
  assert.equal(first.duplicates, 1);
  assert.equal(first.duplicate_new, 1);
  assert.deepEqual(first.duplicate_items, [
    { email: 'dup@test.local', remote_ids: [20, 30], extras: [30] },
  ]);
  const events = ctx.db.prepare(`SELECT type FROM account_events WHERE account_id=? ORDER BY id`).all(id);
  assert.deepEqual(events.map((e) => e.type), ['codex2api_duplicate']);
  // 关联仍指向最早的那份，不会被重复账号带偏
  assert.equal(ctx.db.prepare('SELECT codex2api_account_id FROM accounts WHERE id=?').get(id).codex2api_account_id, 20);

  // 重复集合未变 → 不重复记事件，但每轮仍然统计到，方便巡检日志持续提醒
  const second = await sync.syncRemoteStatus();
  assert.equal(second.duplicates, 1);
  assert.equal(second.duplicate_new, 0);
  assert.equal(second.duplicate_items.length, 0);
  assert.equal(
    ctx.db.prepare(`SELECT COUNT(*) n FROM account_events WHERE account_id=? AND type='codex2api_duplicate'`).get(id).n,
    1,
  );
});

test('syncRemoteStatus：未关联时按 email 命中最早的一份（与远端返回顺序无关）', async () => {
  const id = insertMain(ctx.db, { email: 'dup2@test.local' });
  const sync = buildSync({
    remoteAccounts: [
      remoteAccount({ id: 30, email: 'dup2@test.local', status: 'error' }),
      remoteAccount({ id: 20, email: 'dup2@test.local' }),
    ],
  });

  await sync.syncRemoteStatus();

  assert.equal(ctx.db.prepare('SELECT codex2api_account_id FROM accounts WHERE id=?').get(id).codex2api_account_id, 20);
});

test('resolveCodex2apiProxy：账号自带 proxy_url 直读，label 从代理列表补齐', async () => {
  const proxies = [{ id: 3, url: 'http://u:p@10.0.0.1:8080', label: 'p3', enabled: true, bound_count: 4 }];
  const remoteAccounts = [
    remoteAccount({ id: 7, email: 'bound@test.local', proxyUrl: 'http://u:p@10.0.0.1:8080' }),
    remoteAccount({ id: 8, email: 'noproxy@test.local' }),
  ];
  const boundId = insertMain(ctx.db, { email: 'bound@test.local' });
  insertMain(ctx.db, { email: 'noproxy@test.local' });
  const localOnlyId = insertMain(ctx.db, { email: 'local-only@test.local' });
  const configured = buildSync({ remoteAccounts, proxies });
  const unconfigured = buildSync({ remoteAccounts, proxies, configured: false });

  const bound = await configured.resolveCodex2apiProxy(boundId);
  assert.equal(bound.url, 'http://u:p@10.0.0.1:8080');
  assert.equal(bound.remote_id, 7);
  assert.equal(bound.proxy_name, 'p3');

  assert.equal(await configured.resolveCodex2apiProxy(localOnlyId), null);
  assert.equal(await unconfigured.resolveCodex2apiProxy(boundId), null);

  // 未绑代理的远端号：codex2api 账号没带 proxy_url → 返回 null（不猜直连）
  const noProxyId = ctx.db.prepare(`SELECT id FROM accounts WHERE email='noproxy@test.local'`).get().id;
  assert.equal(await configured.resolveCodex2apiProxy(noProxyId), null);
});

test('extractRemoteProxy：解析 proxy_url 字符串，没绑代理返回 null', () => {
  // 完整 URL（含认证）
  assert.deepEqual(extractRemoteProxy({ proxy_url: 'http://u123:p@1.2.3.4:8080' }), {
    id: null,
    name: null,
    username: 'u123',
    host: '1.2.3.4',
    port: 8080,
  });
  // 无认证
  assert.deepEqual(extractRemoteProxy({ proxy_url: 'socks5://a.com:1080' }), {
    id: null,
    name: null,
    username: null,
    host: 'a.com',
    port: 1080,
  });
  // 空串 / 未绑 / 非法 URL 都不算信息
  assert.equal(extractRemoteProxy({ proxy_url: '' }), null);
  assert.equal(extractRemoteProxy({ proxy_url: '   ' }), null);
  assert.equal(extractRemoteProxy({}), null);
  assert.equal(extractRemoteProxy(null), null);
});

test('resolveDiscardProxy：按 proxy_url 补齐代理 label', async () => {
  const proxies = [{ id: 3, url: 'http://u123:p@a.com:8080', label: '23', enabled: true, bound_count: 1 }];
  const bound = remoteAccount({ id: 7, email: 'bound@test.local', proxyUrl: 'http://u123:p@a.com:8080' });
  const sync = buildSync({ remoteAccounts: [bound], proxies });

  // 1) 巡检手里已有远端账号 → 用 proxy_url 去代理列表补齐 label
  assert.deepEqual(await sync.resolveDiscardProxy({ remote: bound }), {
    id: null,
    name: '23',
    username: 'u123',
    host: 'a.com',
    port: 8080,
  });

  // 2) 只有本地的 codex2api_account_id → 单账号接口（不拉全量列表）
  let getAccountCalls = 0;
  const byIdSync = createRemoteSync({
    db: ctx.db,
    client: {
      listAllAccounts: async () => {
        throw new Error('不应调用全量列表接口');
      },
      getAccount: async (id) => {
        getAccountCalls += 1;
        assert.equal(Number(id), 7);
        return bound;
      },
      listProxies: async () => proxies,
      accountEmail: (account) => account?.email || null,
    },
    getConfig: () => ({ base_url: 'http://codex2api.test', admin_key: 'sk-test' }),
    logger,
  });
  assert.equal((await byIdSync.resolveDiscardProxy({ accountId: 7 })).name, '23');
  assert.equal(getAccountCalls, 1);

  // 3) 远端没有这个号 → null，不猜
  const empty = buildSync({ remoteAccounts: [], proxies: [] });
  assert.equal(await empty.resolveDiscardProxy({ accountId: 999 }), null);
  assert.equal(await empty.resolveDiscardProxy({ email: 'nobody@test.local' }), null);
  // 4) 远端号没绑代理 → null（与「直连」区分：空就是没记录）
  const unbound = buildSync({
    remoteAccounts: [remoteAccount({ id: 8, email: 'noproxy@test.local' })],
    proxies,
  });
  assert.equal(await unbound.resolveDiscardProxy({ accountId: 8 }), null);
  // 5) 没有 ID 时走服务端 search 邮箱查找，且**不许**退化成全量远端列表
  //    （废池里成百上千个「从未上传」的号都会走到这条回退，全量列表会被放大上千倍）
  let lookupArgs = null;
  const byEmailSync = createRemoteSync({
    db: ctx.db,
    client: {
      listAllAccounts: async () => {
        throw new Error('不应调用全量列表接口');
      },
      findAccountByEmail: async (email, options) => {
        lookupArgs = { email, options };
        return bound;
      },
      listProxies: async () => proxies,
      accountEmail: (account) => account?.email || null,
    },
    getConfig: () => ({ base_url: 'http://codex2api.test', admin_key: 'sk-test' }),
    logger,
  });
  assert.equal((await byEmailSync.resolveDiscardProxy({ email: 'bound@test.local' })).name, '23');
  assert.equal(lookupArgs.email, 'bound@test.local');
  assert.ok(
    Number.isSafeInteger(lookupArgs.options?.maxAccounts) && lookupArgs.options.maxAccounts <= 500,
    '邮箱回退必须带上限，否则大号池实例会退化成全量遍历',
  );
});
