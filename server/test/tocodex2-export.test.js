import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTocodex2ExportPayload, tocodex2ExportFilename } from '../modules/accounts/export.js';
import { parseTocodex2Export, credentialsForImport } from '../modules/accounts/import.js';

const UUID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const RT = 'M.C509_BL2.' + 'x'.repeat(120);

function fakeRow(overrides = {}) {
  return {
    id: 1,
    email: 'a@b.com',
    pool: 'reserve',
    note: null,
    banned: 0,
    banned_reason: null,
    initial_balance: 12.5,
    has_balance: 1,
    credentials_enc: 'v1:xxx',
    ...overrides,
  };
}

test('tocodex2 导出：完整凭据 + 备用池元数据，空字段不落键', () => {
  const payload = buildTocodex2ExportPayload({
    rows: [
      fakeRow({
        note: '测试号',
        banned: 1,
        banned_reason: 'ban mail',
        credentials_enc: 'enc',
      }),
      fakeRow({ id: 2, email: 'c@d.com', has_balance: 0, initial_balance: null, credentials_enc: 'enc' }),
    ],
    decryptCredentials: (row) =>
      row.id === 1
        ? {
            password: 'chatgpt-pass',
            totp_pickup_code: 'PICKUP123',
            totp_secret: 'jbswy3dpehpk3pxp',
            outlook: { password: 'mail-pass', client_id: UUID, refresh_token: RT },
          }
        : { totp_pickup_code: 'CODE456' },
  });
  assert.equal(payload.type, 'tocodex2-accounts');
  assert.equal(payload.version, 1);
  assert.equal(payload.accounts.length, 2);

  const [full, minimal] = payload.accounts;
  assert.deepEqual(full.credentials, {
    password: 'chatgpt-pass',
    totp_pickup_code: 'PICKUP123',
    totp_secret: 'jbswy3dpehpk3pxp',
    outlook: { password: 'mail-pass', client_id: UUID, refresh_token: RT },
  });
  assert.equal(full.note, '测试号');
  assert.equal(full.banned, true);
  assert.equal(full.banned_reason, 'ban mail');
  assert.equal(full.initial_balance, 12.5);

  // 只有取件码的账号：无 outlook 键、无余额
  assert.deepEqual(minimal.credentials, { totp_pickup_code: 'CODE456' });
  assert.equal(minimal.initial_balance, null);
  assert.equal(minimal.banned, false);
  assert.match(tocodex2ExportFilename(new Date('2026-08-20T12:34:56Z')), /^tocodex2-accounts-\d{8}-\d{4}\.json$/);
});

test('tocodex2 往返：导出 JSON → 解析出可导入条目', () => {
  const payload = buildTocodex2ExportPayload({
    rows: [fakeRow({ credentials_enc: 'enc' })],
    decryptCredentials: () => ({
      password: 'chatgpt-pass',
      totp_pickup_code: 'PICKUP123',
      totp_secret: 'JBSW Y3DP EHPK 3PXP=',
      outlook: { password: 'mail-pass', client_id: UUID, refresh_token: RT },
    }),
  });
  const parsed = parseTocodex2Export(JSON.stringify(payload));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  const [entry] = parsed.entries;
  assert.equal(entry.email, 'a@b.com');
  assert.equal(entry.password, 'mail-pass');
  assert.equal(entry.clientId, UUID);
  assert.equal(entry.refreshToken, RT);
  assert.equal(entry.pickupCode, 'PICKUP123');
  assert.equal(entry.chatgptPassword, 'chatgpt-pass');
  // 2FA 密钥归一化（大写、去空格与 =）
  assert.equal(entry.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(entry.hasBalance, true);
  assert.equal(entry.initialBalance, 12.5);

  const credentials = credentialsForImport(entry);
  assert.deepEqual(credentials, {
    outlook: { password: 'mail-pass', client_id: UUID, refresh_token: RT },
    totp_pickup_code: 'PICKUP123',
    totp_secret: 'JBSWY3DPEHPK3PXP',
    password: 'chatgpt-pass',
  });
});

test('tocodex2 解析：无 Outlook 凭据的条目合法且不落空 outlook 对象', () => {
  const parsed = parseTocodex2Export(
    JSON.stringify({
      type: 'tocodex2-accounts',
      version: 1,
      accounts: [{ email: 'x@y.com', credentials: { password: 'p1', totp_pickup_code: 'CODE123' } }],
    }),
  );
  assert.equal(parsed.ok, true);
  const credentials = credentialsForImport(parsed.entries[0]);
  assert.equal('outlook' in credentials, false);
  assert.equal(credentials.password, 'p1');
  assert.equal(credentials.totp_pickup_code, 'CODE123');
});

test('tocodex2 主号池导出：携带 tokens/余额/状态，往返后完整还原', () => {
  const tokens = {
    access_token: 'at-123',
    refresh_token: 'rt-456',
    id_token: 'idt',
    chatgpt_account_id: 'acc-1',
    client_id: 'cli',
    email: 'main@b.com',
  };
  const payload = buildTocodex2ExportPayload({
    rows: [
      fakeRow({
        id: 3,
        email: 'main@b.com',
        pool: 'main',
        status: 'needs_reauth',
        balance: 88.8,
        last_login_at: '2026-08-01T00:00:00.000Z',
        has_balance: 0,
        initial_balance: null,
        tokens_enc: 'enc',
      }),
    ],
    decryptCredentials: () => ({ password: 'chatgpt-pass' }),
    decryptTokens: (row) => (row.pool === 'main' ? tokens : null),
  });
  const [entry] = payload.accounts;
  assert.equal(entry.pool, 'main');
  assert.equal(entry.status, 'needs_reauth');
  assert.equal(entry.balance, 88.8);
  assert.equal(entry.last_login_at, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(entry.tokens, tokens);

  const parsed = parseTocodex2Export(JSON.stringify(payload));
  assert.equal(parsed.ok, true);
  const [importEntry] = parsed.entries;
  assert.deepEqual(importEntry.tokens, tokens);
  assert.equal(importEntry.mainStatus, 'needs_reauth');
  assert.equal(importEntry.balance, 88.8);
  assert.equal(importEntry.lastLoginAt, '2026-08-01T00:00:00.000Z');
  assert.equal(importEntry.chatgptPassword, 'chatgpt-pass');
});

test('tocodex2 解析：仅有 tokens 无凭据的主号池条目合法', () => {
  const parsed = parseTocodex2Export(
    JSON.stringify({
      type: 'tocodex2-accounts',
      accounts: [{ email: 'tok@b.com', pool: 'main', status: 'active', tokens: { refresh_token: 'rt' } }],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(parsed.entries[0].tokens, { refresh_token: 'rt' });
  assert.deepEqual(credentialsForImport(parsed.entries[0]), {});
});

test('tocodex2 解析：tokens 缺少 refresh/access 的条目按无凭据处理', () => {
  const parsed = parseTocodex2Export(
    JSON.stringify({
      type: 'tocodex2-accounts',
      accounts: [{ email: 'tok@b.com', tokens: { foo: 'bar' } }],
    }),
  );
  assert.equal(parsed.entries.length, 0);
  assert.match(parsed.invalid[0].reason, /没有任何凭据字段/);
});

test('tocodex2 解析：非法文件/条目逐条报错', () => {
  assert.equal(parseTocodex2Export('').ok, false);
  assert.equal(parseTocodex2Export('not json').ok, false);
  assert.equal(parseTocodex2Export('{"type":"other"}').ok, false);
  assert.equal(parseTocodex2Export('[]').ok, false);

  const parsed = parseTocodex2Export(
    JSON.stringify({
      type: 'tocodex2-accounts',
      accounts: [
        { email: 'bad', credentials: { password: 'p' } },
        { email: 'none@b.com', credentials: {} },
        { email: 'bad2fa@b.com', credentials: { totp_secret: 'not-base32!' } },
        { email: 'dup@b.com', credentials: { password: 'p' } },
        { email: 'DUP@b.com', credentials: { password: 'p' } },
        { email: 'ok@b.com', credentials: { password: 'p' } },
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.entries.map((e) => e.email),
    ['dup@b.com', 'ok@b.com'],
  ); // 大小写不敏感去重，保留首个
  const reasons = parsed.invalid.map((i) => i.reason).join('\n');
  assert.match(reasons, /邮箱格式错误/);
  assert.match(reasons, /没有任何凭据字段/);
  assert.match(reasons, /Base32/);
  assert.match(reasons, /重复/);
});
