import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReplaceLines,
  nextLabelStart,
  distributeAccounts,
  proxyIdentity,
  buildProxyUrl,
} from '../modules/codex2api/proxy-replace.js';

test('解析：标准 ip:port:用户名:密码 四段', () => {
  const { items, invalid_lines, duplicates_in_input } = parseReplaceLines('198.23.128.39:5667:cxzoljuy:cefn2yq3q0vn');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { host: '198.23.128.39', port: 5667, username: 'cxzoljuy', password: 'cefn2yq3q0vn' });
  assert.equal(invalid_lines.length, 0);
  assert.equal(duplicates_in_input, 0);
});

test('解析：无认证的 ip:port 两段', () => {
  const { items } = parseReplaceLines('1.2.3.4:8080');
  assert.deepEqual(items[0], { host: '1.2.3.4', port: 8080, username: null, password: null });
});

test('解析：完整 URL 行 http://user:pass@host:port', () => {
  const { items } = parseReplaceLines('http://cxzoljuy:cefn2yq3q0vn@198.23.128.39:5667');
  assert.deepEqual(items[0], { host: '198.23.128.39', port: 5667, username: 'cxzoljuy', password: 'cefn2yq3q0vn' });
});

test('解析：空行与 # 注释行跳过，非法行记录行号', () => {
  const text = ['# 注释', '', '1.2.3.4:5667:u:p', '垃圾行', '1.2.3.4:0:u:p'].join('\n');
  const { items, invalid_lines } = parseReplaceLines(text);
  assert.equal(items.length, 1);
  assert.equal(invalid_lines.length, 2);
  assert.equal(invalid_lines[0].line, 4);
  assert.equal(invalid_lines[1].line, 5);
});

test('解析：端口非法（非数字 / 超范围）拒绝', () => {
  const { items } = parseReplaceLines(['1.2.3.4:abc:u:p', '1.2.3.4:65536:u:p', '1.2.3.4:-1:u:p'].join('\n'));
  assert.equal(items.length, 0);
});

test('解析：段数不是 2 或 4 拒绝（三段 / 五段）', () => {
  const { items } = parseReplaceLines(['1.2.3.4:8080:u', '1.2.3.4:8080:u:p:x'].join('\n'));
  assert.equal(items.length, 0);
});

test('解析：输入内重复行计数且只保留一条', () => {
  const line = '198.23.128.39:5667:cxzoljuy:cefn2yq3q0vn';
  const { items, duplicates_in_input } = parseReplaceLines([line, line, line].join('\n'));
  assert.equal(items.length, 1);
  assert.equal(duplicates_in_input, 2);
});

test('解析：同一 host:port 不同凭据不算重复', () => {
  const { items, duplicates_in_input } = parseReplaceLines(
    ['1.2.3.4:8080:userA:passA', '1.2.3.4:8080:userB:passB'].join('\n'),
  );
  assert.equal(items.length, 2);
  assert.equal(duplicates_in_input, 0);
});

test('命名：从现有 label 尾部最大数字续接 +1', () => {
  assert.equal(nextLabelStart(['代理9', '代理10', 'ip-3']), 11);
  assert.equal(nextLabelStart(['3', '17']), 18);
});

test('命名：无数字 label 时从 1 开始', () => {
  assert.equal(nextLabelStart(['家宽', 'dc-proxy']), 1);
  assert.equal(nextLabelStart([]), 1);
});

test('URL 构造：协议 + 认证 + 端口，认证段 percent-encode', () => {
  assert.equal(buildProxyUrl({ host: '1.2.3.4', port: 8080, username: null, password: null }), 'http://1.2.3.4:8080');
  assert.equal(
    buildProxyUrl({ host: 'a.com', port: 1080, username: 'u', password: 'p@ss' }, 'socks5'),
    'socks5://u:p%40ss@a.com:1080',
  );
  // 非法协议回落 http
  assert.equal(buildProxyUrl({ host: '1.2.3.4', port: 8080, username: null, password: null }, 'ssh'), 'http://1.2.3.4:8080');
});

test('分配：总数守恒、无丢失无重复、各组差 ≤ 1', () => {
  const ids = Array.from({ length: 101 }, (_, i) => i + 1);
  const targets = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
  const groups = distributeAccounts(ids, targets);
  const all = groups.flatMap((group) => group.ids);
  assert.equal(all.length, ids.length);
  assert.equal(new Set(all).size, ids.length);
  const counts = groups.map((group) => group.ids.length);
  assert.equal(Math.max(...counts) - Math.min(...counts), 1);
});

test('分配：账号数少于代理数时每个账号只落一组', () => {
  const groups = distributeAccounts([10, 20], [{ id: 1 }, { id: 2 }, { id: 3 }]);
  const all = groups.flatMap((group) => group.ids);
  assert.equal(all.length, 2);
  assert.deepEqual(all.sort(), [10, 20]);
  groups.forEach((group) => assert.ok(group.ids.length <= 1));
});

test('分配：0 账号时各组为空', () => {
  const groups = distributeAccounts([], [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(groups.map((group) => group.ids), [[], []]);
});

test('身份键：大小写 host 归一，凭据区分', () => {
  assert.equal(proxyIdentity({ host: 'A.com', port: 1, username: 'u', password: 'p' }), proxyIdentity({ host: 'a.com', port: 1, username: 'u', password: 'p' }));
  assert.notEqual(proxyIdentity({ host: 'a.com', port: 1, username: 'u', password: 'p' }), proxyIdentity({ host: 'a.com', port: 1, username: 'u', password: 'q' }));
});
