import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountName, sanitizeAccountName, balanceFromAccountName } from '../lib/codex2api-naming.js';
import { createCodex2apiClient } from '../modules/codex2api/client.js';

const getClient = () => createCodex2apiClient(() => ({ base_url: 'http://x', admin_key: 'k' }));

test('buildAccountName：oauth:: 前缀 + 可选余额后缀，输出不含注入特征', () => {
  assert.equal(buildAccountName('a@b.co'), 'oauth::a@b.co');
  assert.equal(buildAccountName('A@B.CO'), 'oauth::a@b.co'); // 邮箱归一小写
  assert.equal(buildAccountName('a@b.co', 5.4), 'oauth::a@b.co::5'); // 四舍五入
  assert.equal(buildAccountName('a@b.co', 40), 'oauth::a@b.co::40');
  assert.equal(buildAccountName('a@b.co', null), 'oauth::a@b.co');
  assert.equal(buildAccountName('', 5), 'oauth::account::5'); // 缺省占位
  // codex2api 注入过滤特征（security.ContainsXSS / ContainsSQLInjection）一律不得出现
  for (const name of [buildAccountName('a@b.co'), buildAccountName('a@b.co', 12)]) {
    assert.doesNotMatch(name, /--|;|\||\/\*|\*\//);
    assert.ok(name.length <= 100);
  }
});

test('sanitizeAccountName：历史 oauth--- 名归一为 ::，注入特征字符剔除，超长截断', () => {
  assert.equal(sanitizeAccountName('oauth---a@b.co---20'), 'oauth::a@b.co::20');
  assert.equal(sanitizeAccountName('oauth---a@b.co'), 'oauth::a@b.co');
  assert.equal(sanitizeAccountName('a;drop@b.co'), 'adrop@b.co'); // ; 剔除
  assert.equal(sanitizeAccountName('a|b@b.co'), 'ab@b.co'); // | 剔除
  assert.equal(sanitizeAccountName('/*a@b.co'), 'a@b.co');
  assert.equal(sanitizeAccountName('  a@b.co  '), 'a@b.co');
  assert.equal(sanitizeAccountName('x--y@b.co'), 'x::y@b.co'); // 连字符对也转 ::
  const long = sanitizeAccountName(`${'a'.repeat(200)}@b.co`);
  assert.equal([...long].length, 100);
});

test('balanceFromAccountName：新旧约定都认，非整数后缀返回 null', () => {
  assert.equal(balanceFromAccountName('oauth::a@b.co::20'), 20);
  assert.equal(balanceFromAccountName('oauth---a@b.co---20'), 20); // 远端历史遗留
  assert.equal(balanceFromAccountName('oauth::a@b.co'), null);
  assert.equal(balanceFromAccountName('oauth::a@b.co::20-extra'), null);
  assert.equal(balanceFromAccountName(''), null);
});

test('accountEmail：name 兜底提取不被前缀污染，新旧命名与裸邮箱都正确', () => {
  const client = getClient();
  assert.equal(client.accountEmail({ email: 'direct@b.co' }), 'direct@b.co'); // 平铺字段优先
  assert.equal(client.accountEmail({ name: 'oauth::a@b.co::5' }), 'a@b.co');
  assert.equal(client.accountEmail({ name: 'oauth::a@b.co' }), 'a@b.co');
  // 回归：旧约定的 oauth--- 前缀字符在邮箱本地部分字符类里，
  // 修复前会被整串吞进「邮箱」导致查重索引失配
  assert.equal(client.accountEmail({ name: 'oauth---a@b.co---20' }), 'a@b.co');
  assert.equal(client.accountEmail({ name: 'oauth::account' }), null);
  assert.equal(client.accountEmail({ name: '' , email: '' }), null);
});
