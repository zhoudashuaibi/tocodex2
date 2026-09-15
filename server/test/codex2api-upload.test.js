import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createUploader, balanceTierScoreBias, mergeUploadOptions } from '../modules/codex2api/upload.js';
import { buildMainBalanceEstimate } from '../modules/accounts/index.js';
import { createCodex2apiClient } from '../modules/codex2api/client.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tocodex2-upload-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const created = [];
  const deleted = [];
  const schedulerPatches = [];
  const remote = new Map(); // email → 远端账号（mock 的远端状态，创建后即可被索引到）
  let nextRemoteId = 100;
  const client = {
    listAllAccounts: async () => [...remote.values()],
    accountEmail: (account) => account?.email || null,
    createAccount: async (payload) => {
      created.push(payload);
      const email = String(payload.name || '').replace(/^oauth---/, '').split('---')[0];
      const account = { id: nextRemoteId, email, name: payload.name, status: 'active', ...(payload.proxy_url ? { proxy_url: payload.proxy_url } : {}) };
      remote.set(email, account);
      nextRemoteId += 1;
      return { success: 1, updated: 0, duplicate: 0, failed: 0, created_ids: [account.id] };
    },
    deleteAccount: async (id) => {
      deleted.push(Number(id));
      for (const [email, account] of remote) {
        if (Number(account.id) === Number(id)) remote.delete(email);
      }
    },
    updateScheduler: async (id, patch) => {
      schedulerPatches.push({ id: Number(id), patch });
    },
    setAccountModels: async () => {},
    listProxies: async () => [],
  };
  const uploader = createUploader({
    db,
    crypto,
    client,
    getConfig: () => ({ base_url: 'http://codex2api.test', admin_key: 'sk-test', group_ids: [], upload_defaults: {} }),
    settingsGet: () => null,
    dataDir,
    proxySelector: null,
    logger,
  });
  return { dataDir, db, crypto, uploader, client, created, deleted, schedulerPatches, remote };
}

// 不带 access_token：余额为空时跳过实时补查，保持「未查过」口径
function insertAccount(db, crypto, { email, balance = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, tokens_enc, credentials_enc, balance, imported_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      email,
      'main',
      'active',
      'ok',
      crypto.encryptJson({ refresh_token: 'rt', email }, 'accounts.tokens_enc'),
      null,
      balance,
      now,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

/** email → 创建载荷（createAccount 收到的请求体） */
function payloadByEmail() {
  const map = new Map();
  for (const payload of ctx.created) {
    const email = String(payload.name || '').replace(/^oauth---/, '').split('---')[0];
    map.set(email, payload);
  }
  return map;
}

function estimateOptions() {
  return {
    accountEmail: (account) => account?.email || null,
    accountUsedAmount: (account) => {
      const value = account.total_account_billed ?? account.usage_5h_detail?.account_billed;
      return Number.isFinite(Number(value)) ? { amount: Number(value), source: 'test' } : null;
    },
  };
}

beforeEach(() => {
  ctx = setup();
});

test('balanceTierScoreBias：四档边界与未知余额默认档', () => {
  assert.equal(balanceTierScoreBias(0), 40);
  assert.equal(balanceTierScoreBias(9.4), 40);
  assert.equal(balanceTierScoreBias(9.6), 40); // 四舍五入到 10，与 ---N 名称后缀同口径
  assert.equal(balanceTierScoreBias(10), 40);
  assert.equal(balanceTierScoreBias(10.6), 20);
  assert.equal(balanceTierScoreBias(15), 20);
  assert.equal(balanceTierScoreBias(19.6), 30);
  assert.equal(balanceTierScoreBias(25), 30);
  assert.equal(balanceTierScoreBias(39.4), 30);
  assert.equal(balanceTierScoreBias(39.6), 10);
  assert.equal(balanceTierScoreBias(40), 10);
  assert.equal(balanceTierScoreBias(null), 20); // 未查过按默认 10 刀档
  assert.equal(balanceTierScoreBias(undefined), 20);
});

test('上传默认按余额分档补写调度偏置，并追加余额后缀', async () => {
  const cases = [
    { email: 'small@test.local', balance: 5.4, bias: 40, suffix: '---5' },
    { email: 'mid@test.local', balance: 15, bias: 20, suffix: '---15' },
    { email: 'mid-high@test.local', balance: 25, bias: 30, suffix: '---25' },
    { email: 'big@test.local', balance: 40, bias: 10, suffix: '---40' },
    { email: 'unknown@test.local', balance: null, bias: 20, suffix: null },
  ];
  const ids = cases.map((c) => insertAccount(ctx.db, ctx.crypto, c));
  const result = await ctx.uploader.uploadAccounts(ids, {});
  assert.equal(result.created, 5);
  assert.equal(result.failed.length, 0);
  const byEmail = payloadByEmail();
  for (const c of cases) {
    const payload = byEmail.get(c.email);
    assert.ok(payload, `missing payload for ${c.email}`);
    // RT-only 载荷：只带 refresh_token，不带 AT/凭据对象
    assert.ok(payload.refresh_token, `${c.email} refresh_token`);
    assert.equal('access_token' in payload, false, `${c.email} 不应携带 access_token`);
    // skip_refresh 默认开（防批量上传打爆上游刷新）
    assert.equal(payload.skip_refresh, true);
    if (c.suffix) assert.ok(String(payload.name).endsWith(c.suffix), `${c.email} name suffix`);
    else assert.equal(String(payload.name), `oauth---${c.email}`);
    // 余额分档的调度偏置经创建后 scheduler PATCH 补写
    const patch = ctx.schedulerPatches.find((entry) => entry.id === ctx.remote.get(c.email).id);
    assert.ok(patch, `${c.email} scheduler patch`);
    assert.equal(patch.patch.score_bias_override, c.bias, `${c.email} score_bias_override`);
  }
});

test('显式指定调度偏置时不做余额分档', async () => {
  const ids = [
    insertAccount(ctx.db, ctx.crypto, { email: 'a@test.local', balance: 5 }),
    insertAccount(ctx.db, ctx.crypto, { email: 'b@test.local', balance: 30 }),
  ];
  await ctx.uploader.uploadAccounts(ids, { score_bias: 99 });
  for (const email of ['a@test.local', 'b@test.local']) {
    const patch = ctx.schedulerPatches.find((entry) => entry.id === ctx.remote.get(email).id);
    assert.ok(patch, `${email} scheduler patch`);
    assert.equal(patch.patch.score_bias_override, 99);
  }
});

test('并发上传串行执行：同一个号只创建一次，后到的那次走替换（先建新后删旧）', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'race@test.local', balance: 20 });

  const [first, second] = await Promise.all([
    ctx.uploader.uploadAccounts([id], {}),
    ctx.uploader.uploadAccounts([id], {}),
  ]);

  // 第二次进入时索引里已有这个号 → 走替换：createAccount（新 RT）+ deleteAccount（旧实体）
  assert.equal(ctx.created.length, 2, '两次上传各建一份（第二次是替换建新）');
  assert.equal(first.created, 1);
  assert.equal(first.updated, 0);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(ctx.deleted.length, 1, '替换路径应删掉旧实体');
  assert.equal(
    ctx.db.prepare('SELECT codex2api_account_id FROM accounts WHERE id=?').get(id).codex2api_account_id,
    ctx.remote.get('race@test.local').id,
  );
  const events = ctx.db.prepare('SELECT type FROM account_events WHERE account_id=? ORDER BY id').all(id);
  assert.deepEqual(events.map((e) => e.type), ['uploaded_codex2api', 'codex2api_replaced']);
});

test('创建前二次校验：快照之后远端已出现的号降级为替换，不再重复创建', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'stale@test.local', balance: 20 });
  // 第一次拉取是空的（=陈旧快照），之后远端已经有这个号（=别处并发建好了）
  let calls = 0;
  ctx.client.listAllAccounts = async () => {
    calls += 1;
    return calls === 1 ? [] : [{ id: 777, email: 'stale@test.local', status: 'active', name: 'oauth---stale@test.local---20' }];
  };

  const result = await ctx.uploader.uploadAccounts([id], {});

  // 降级为替换：仍会建新（新 RT）+ 删旧（777），但事件与回填走 replaced 口径
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.ok(ctx.deleted.includes(777), '旧实体 777 应被删除');
  assert.notEqual(
    ctx.db.prepare('SELECT codex2api_account_id FROM accounts WHERE id=?').get(id).codex2api_account_id,
    777,
  );
});

test('同一批次内重复的账号 id 去重：不会在远端建出两份', async () => {
  const id = insertAccount(ctx.db, ctx.crypto, { email: 'twice@test.local', balance: 20 });

  const result = await ctx.uploader.uploadAccounts([id, id], {});

  assert.equal(ctx.created.length, 1);
  assert.equal(result.created, 1);
});

test('Codex2API 管理端账号统计：使用 /usage 接口并携带管理员密钥', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ total_account_billed: 3.25, total_requests: 10 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = createCodex2apiClient(() => ({ base_url: 'https://codex2api.example/', admin_key: 'admin-secret' }));
    const result = await client.getAccountStats(42, 90);
    assert.equal(result.total_account_billed, 3.25);
    assert.equal(calls[0].url, 'https://codex2api.example/api/admin/accounts/42/usage?days=90');
    assert.equal(calls[0].options.headers['x-admin-key'], 'admin-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('主号池预估余额：名称后缀回退、邮箱匹配和负数归零', () => {
  const result = buildMainBalanceEstimate(
    [
      { id: 1, email: 'a@test.local', initial_balance: 20, codex2api_account_id: null },
      { id: 2, email: 'b@test.local', initial_balance: 5, codex2api_account_id: 22 },
      { id: 3, email: 'c@test.local', initial_balance: null, codex2api_account_id: 33 },
    ],
    [
      { id: 11, email: 'a@test.local', total_account_billed: 6.4 },
      { id: 22, email: 'b@test.local', usage_5h_detail: { account_billed: 8 } },
      { id: 33, name: 'oauth---c@test.local---20', email: 'c@test.local', total_account_billed: 1 },
    ],
    estimateOptions(),
  );
  assert.equal(result.total_estimated_remaining, 32.6);
  assert.equal(result.calculable_count, 3);
  assert.equal(result.unknown_count, 0);
  assert.equal(result.items[1].estimated_remaining, 0);
  assert.equal(result.items[2].initial_balance, 20);
  assert.equal(result.items[2].initial_balance_source, 'codex2api_name_suffix');
  assert.equal(result.items[2].estimated_remaining, 19);
});

test('主号池预估余额：本地初始化余额优先于远端名称后缀', () => {
  const result = buildMainBalanceEstimate(
    [{ id: 1, email: 'a@test.local', initial_balance: 5, codex2api_account_id: 7 }],
    [{ id: 7, name: 'oauth---a@test.local---20', email: 'a@test.local', total_account_billed: 1 }],
    estimateOptions(),
  );
  assert.equal(result.items[0].initial_balance, 5);
  assert.equal(result.items[0].initial_balance_source, 'local');
  assert.equal(result.items[0].estimated_remaining, 4);
});

test('主号池预估余额：非末尾整数后缀不作为初始化余额', () => {
  const result = buildMainBalanceEstimate(
    [{ id: 1, email: 'a@test.local', initial_balance: null, codex2api_account_id: 7 }],
    [{ id: 7, name: 'oauth---a@test.local---20-extra', email: 'a@test.local', total_account_billed: 1 }],
    estimateOptions(),
  );
  assert.equal(result.unknown_count, 1);
  assert.equal(result.items[0].initial_balance, null);
  assert.equal(result.items[0].initial_balance_source, null);
  assert.equal(result.items[0].reason, 'initial_balance_unknown');
});

test('主号池预估余额：缺少远端用量时保持未知，不写入余额', () => {
  const result = buildMainBalanceEstimate(
    [{ id: 1, email: 'a@test.local', initial_balance: 20, codex2api_account_id: 7 }],
    [{ id: 7, email: 'a@test.local' }],
    { accountEmail: () => 'a@test.local', accountUsedAmount: () => null },
  );
  assert.equal(result.total_estimated_remaining, 0);
  assert.equal(result.unknown_count, 1);
  assert.equal(result.items[0].reason, 'remote_used_amount_unknown');
});

test('mergeUploadOptions：未显式覆盖时 score_bias 保持空，交给分档逻辑；skip_refresh 默认开', () => {
  const merged = mergeUploadOptions({ score_bias: null }, { score_bias: null });
  assert.equal(merged.score_bias, null);
  assert.equal(merged.skip_refresh, true);
  const overridden = mergeUploadOptions({ score_bias: 5 }, { score_bias: null });
  assert.equal(overridden.score_bias, null); // 弹窗清空即显式取消默认值，与既有语义一致
});

test('mergeUploadOptions：Codex 指纹收敛只放行四档，缺省/非法值一律回落到 off', () => {
  // 未配置 = off（透传），不是「未设置就随便收敛」
  assert.equal(mergeUploadOptions({}, {}).codex_fingerprint_mode, 'off');
  assert.equal(mergeUploadOptions({ codex_fingerprint_mode: 'session' }, {}).codex_fingerprint_mode, 'session');
  // 脏值（空格/大小写/未知档位）不得进入补写补丁：收敛在上游是显式 opt-in，放行未知值等于静默开启
  for (const dirty of ['', ' ', 'SESSION', 'on', 'true', null, undefined, 3, {}]) {
    assert.equal(
      mergeUploadOptions({ codex_fingerprint_mode: dirty }, {}).codex_fingerprint_mode,
      'off',
      `defaults=${JSON.stringify(dirty)}`,
    );
  }
  // 请求级覆盖同样过白名单
  assert.equal(mergeUploadOptions({}, { codex_fingerprint_mode: 'full' }).codex_fingerprint_mode, 'full');
  assert.equal(mergeUploadOptions({ codex_fingerprint_mode: 'full' }, { codex_fingerprint_mode: 'bogus' }).codex_fingerprint_mode, 'off');
});

test('上传补写：收敛模式经 scheduler PATCH 写入，off 不写键', async () => {
  const ids = [insertAccount(ctx.db, ctx.crypto, { email: 'fp@test.local', balance: 20 })];
  await ctx.uploader.uploadAccounts(ids, { codex_fingerprint_mode: 'session' });
  const patch = ctx.schedulerPatches.find((entry) => entry.id === ctx.remote.get('fp@test.local').id);
  assert.ok(patch);
  assert.equal(patch.patch.codex_fingerprint_mode, 'session');

  // off / 非法值：补丁里不出现该键（codex2api 新号按其系统默认档位走）
  for (const mode of ['off', 'bogus', undefined]) {
    ctx = setup();
    const target = insertAccount(ctx.db, ctx.crypto, { email: 'fp2@test.local', balance: 20 });
    await ctx.uploader.uploadAccounts([target], { codex_fingerprint_mode: mode });
    const entry = ctx.schedulerPatches.find((item) => item.id === ctx.remote.get('fp2@test.local').id);
    assert.ok(!entry || !('codex_fingerprint_mode' in entry.patch), `mode=${mode}`);
  }
});
