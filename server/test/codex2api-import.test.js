import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodex2apiAccountsExport, credentialsForImport } from '../modules/accounts/import.js';

const UUID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const RT = 'M.C550_BL2.' + 'x'.repeat(120);
const SECRET = 'BRPYNJJCVO27O4LQOIMD57BERTMJHLQC';

/** 构造 example.json 同构的 codex2api 账号导出条目 */
function codex2apiAccount(overrides = {}) {
  return {
    name: 'a@b.com----1tS2leMD7gdy792qhgOVVEBr----AO35bAvvGcgghqYcA1!',
    notes: JSON.stringify({
      mailbox: {
        bind_email: 'a@b.com',
        password: 'cwbzea24279',
        client_id: UUID,
        refresh_token: RT,
        pickup_password: '1tS2leMD7gdy792qhgOVVEBr',
      },
      gpt: { password: 'AO35bAvvGcgghqYcA1!' },
      two_factor: { enabled_by_config: true, enabled: true, status: 'enabled', secret: SECRET },
    }),
    platform: 'openai',
    type: 'oauth',
    credentials: {
      access_token: 'at-123',
      refresh_token: 'rt-456',
      email: 'a@b.com',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    },
    extra: { email: 'a@b.com', two_factor_enabled: true },
    ...overrides,
  };
}

test('codex2api 导出解析：notes 四段 / GPT 密码 / 两步验证全量映射，OAuth tokens 忽略', () => {
  const parsed = parseCodex2apiAccountsExport(JSON.stringify({ exported_at: 'x', proxies: [], accounts: [codex2apiAccount()] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  const [entry] = parsed.entries;
  assert.equal(entry.email, 'a@b.com');
  // mailbox.password 是邮箱密码（四段第 2 段），gpt.password 才是 ChatGPT 密码
  assert.equal(entry.password, 'cwbzea24279');
  assert.equal(entry.clientId, UUID);
  assert.equal(entry.refreshToken, RT);
  assert.equal(entry.chatgptPassword, 'AO35bAvvGcgghqYcA1!');
  assert.equal(entry.totpSecret, SECRET);
  // 两步验证密钥同时作为在线取件码（模板 URL 拼接取码）
  assert.equal(entry.pickupCode, SECRET);
  // credentials 里的 OAuth tokens 一律忽略：全部进备用池，主号池走 join-main 登录授权
  assert.equal(entry.tokens, null);
  assert.equal(entry.hasBalance, false);

  const credentials = credentialsForImport(entry);
  assert.deepEqual(credentials, {
    outlook: { password: 'cwbzea24279', client_id: UUID, refresh_token: RT },
    totp_pickup_code: SECRET,
    totp_secret: SECRET,
    password: 'AO35bAvvGcgghqYcA1!',
  });
});

test('codex2api 导出解析：无 tokens 的条目按备用池四段导入', () => {
  const account = codex2apiAccount({ credentials: {}, name: 'c@d.com----pick----GptPass9!' });
  account.notes = JSON.stringify({
    mailbox: { bind_email: 'c@d.com', password: 'mail-pw', client_id: UUID, refresh_token: RT },
  });
  const parsed = parseCodex2apiAccountsExport(JSON.stringify({ accounts: [account] }));
  assert.equal(parsed.ok, true);
  const [entry] = parsed.entries;
  assert.equal(entry.tokens, null);
  assert.equal(entry.email, 'c@d.com');
  assert.equal(entry.password, 'mail-pw');
  // notes 缺 gpt 段时回退 name 第 3 段
  assert.equal(entry.chatgptPassword, 'GptPass9!');
  assert.equal(entry.totpSecret, '');
  assert.equal(entry.pickupCode, '');
});

test('codex2api 导出解析：two_factor 未开启时忽略 secret', () => {
  const account = codex2apiAccount();
  account.notes = JSON.stringify({
    mailbox: { bind_email: 'a@b.com', password: 'p', client_id: UUID, refresh_token: RT },
    two_factor: { enabled: false, status: 'disabled', secret: SECRET },
  });
  const parsed = parseCodex2apiAccountsExport(JSON.stringify({ accounts: [account] }));
  const [entry] = parsed.entries;
  assert.equal(entry.totpSecret, '');
  assert.equal(entry.pickupCode, '');
});

test('codex2api 导出解析：notes 缺失时按 name/credentials.email 兜底', () => {
  const parsed = parseCodex2apiAccountsExport(
    JSON.stringify({
      accounts: [
        {
          name: 'e@f.com----token----GptPw1!',
          credentials: { refresh_token: 'rt-only', access_token: 'at', email: 'e@f.com' },
        },
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  const [entry] = parsed.entries;
  assert.equal(entry.email, 'e@f.com');
  assert.equal(entry.chatgptPassword, 'GptPw1!');
  assert.equal(entry.password, '');
  assert.equal(entry.tokens, null);
  // credentials.email 大写时归一到小写
  const [upper] = parseCodex2apiAccountsExport(
    JSON.stringify({ accounts: [{ name: 'G@H.com----x----p', credentials: { refresh_token: 'rt', email: 'G@H.com' } }] }),
  ).entries;
  assert.equal(upper.email, 'g@h.com');
});

test('codex2api 导出解析：裸数组与密钥归一化', () => {
  const parsed = parseCodex2apiAccountsExport(
    JSON.stringify([
      codex2apiAccount({ status: 'expired', name: 'i@j.com----x----p' }),
      codex2apiAccount({
        name: 'k@l.com----x----p',
        notes: JSON.stringify({
          mailbox: { bind_email: 'k@l.com', password: 'p', client_id: UUID, refresh_token: RT },
          two_factor: { enabled: true, secret: 'jbsw y3dp ehpk 3pxp=' },
        }),
        credentials: {},
      }),
    ]),
  );
  assert.equal(parsed.ok, true);
  const [expired, normalized] = parsed.entries;
  assert.equal(expired.tokens, null);
  assert.equal(normalized.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(normalized.pickupCode, 'JBSWY3DPEHPK3PXP');
});

test('codex2api 导出解析：非法文件与非法条目逐条报错', () => {
  assert.equal(parseCodex2apiAccountsExport('').ok, false);
  assert.equal(parseCodex2apiAccountsExport('not json').ok, false);
  assert.equal(parseCodex2apiAccountsExport('{"foo":1}').ok, false);

  const parsed = parseCodex2apiAccountsExport(
    JSON.stringify({
      accounts: [
        { name: 'bad-email----x----p', credentials: { refresh_token: 'rt' } },
        codex2apiAccount(),
        codex2apiAccount({ name: 'A@B.com----x----p' }), // 批内重复（大小写不敏感）
        {
          name: 'm@n.com----x----p',
          credentials: {},
          notes: JSON.stringify({ mailbox: { bind_email: 'm@n.com', password: 'p', client_id: 'not-uuid', refresh_token: RT } }),
        },
        {
          name: 'o@p.com----x----p',
          credentials: {},
          notes: JSON.stringify({
            mailbox: { bind_email: 'o@p.com', password: 'p', client_id: UUID, refresh_token: 'short' },
          }),
        },
        {
          name: 's@t.com----x----p',
          credentials: {},
          notes: JSON.stringify({
            mailbox: { bind_email: 's@t.com', password: 'p', client_id: UUID, refresh_token: RT },
            two_factor: { enabled: true, secret: 'not-base32!' },
          }),
        },
        { name: 'q@r.com----p' }, // 无任何凭据
      ],
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
  const reasons = parsed.invalid.map((i) => i.reason).join('\n');
  assert.match(reasons, /邮箱格式错误/);
  assert.match(reasons, /重复/);
  assert.match(reasons, /clientId 不是 UUID/);
  assert.match(reasons, /refresh_token 长度不足/);
  assert.match(reasons, /Base32/);
  assert.match(reasons, /没有任何凭据字段/);
});
