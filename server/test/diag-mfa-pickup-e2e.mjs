#!/usr/bin/env node
/**
 * 一次性 E2E：真实 protocol-login.mjs 子进程 + 本地 mock ChatGPT/Auth 服务器。
 * 场景：密码登录 → MFA 挑战 → 从 mock 取件 URL 拿码 → 首次被拒 → 等下一窗口换码 → 通过。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PICKUP = 'E2EPICKUPCODE0000000000000AA';
const windowCode = () => String(100000 + (Math.floor(Date.now() / 30_000) % 900_000));

let verifyAttempts = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': typeof body === 'string' && body.startsWith('<') ? 'text/html' : 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/') return send(200, '<html><body>home</body></html>');
  if (req.method === 'GET' && url.pathname === '/api/auth/providers') return send(200, {});
  if (req.method === 'GET' && url.pathname === '/api/auth/csrf') {
    return send(200, { csrfToken: 'tok' }, { 'set-cookie': '__Host-next-auth.csrf-token=tok; Path=/' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/signin/openai') {
    return send(200, { url: `http://127.0.0.1:${server.port}/log-in/password` });
  }
  if (req.method === 'GET' && url.pathname === '/log-in/password') return send(200, '<html><body>password page</body></html>');
  if (req.method === 'POST' && url.pathname === '/api/accounts/password/verify') {
    return send(200, {
      continue_url: `http://127.0.0.1:${server.port}/mfa-challenge/f_1`,
      page: { type: 'mfa_challenge' },
      'oai-client-auth-session': { mfa_factors: [{ factor_type: 'totp', id: 'f_1' }] },
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/accounts/mfa/issue_challenge') return send(200, {});
  if (req.method === 'POST' && url.pathname === '/api/accounts/mfa/verify') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { code } = JSON.parse(body);
      verifyAttempts += 1;
      // 首次提交一律拒绝（模拟码过期），之后按当前窗口码判定
      if (verifyAttempts === 1) return send(401, { error: 'invalid_totp_code' });
      if (code !== windowCode()) return send(401, { error: 'invalid_totp_code' });
      return send(200, { continue_url: `http://127.0.0.1:${server.port}/done` });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/done') return send(200, '<html><body>done</body></html>');
  if (req.method === 'GET' && url.pathname === `/pickup/${PICKUP}`) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(windowCode());
    return;
  }
  send(404, { error: 'not_found', path: url.pathname });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.port = server.address().port;
console.log(`[e2e] mock server on :${server.port}`);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tocodex2-mfa-e2e-'));
const args = [
  'core/protocol-login.mjs',
  '--email', 'mfa-e2e@test.local',
  '--web-only',
  '--chatgpt-base', `http://127.0.0.1:${server.port}`,
  '--auth-base', `http://127.0.0.1:${server.port}`,
  '--out', path.join(outDir, 'session.json'),
  '--verbose',
];
const child = spawn(process.execPath, args, {
  cwd: path.resolve(process.argv[2] || '.'),
  env: {
    ...process.env,
    CHATGPT_LOGIN_PASSWORD: 'pw',
    CHATGPT_TOTP_SECRET: '',
    CHATGPT_TOTP_PICKUP_URL: `http://127.0.0.1:${server.port}/pickup/${PICKUP}`,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
let stdout = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => {
  stderr += c;
  process.stderr.write(c);
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  stdout += c;
});
const code = await new Promise((resolve) => child.on('close', resolve));
server.close();
const logs = stderr + stdout;

const checks = {
  '取码成功日志': logs.includes('[mfa] Fetched a 6-digit code from the 2FA pickup URL.'),
  '首次被拒后等待换窗口': logs.includes('waiting') && logs.includes('for the next code window'),
  '重试后验证通过': logs.includes('[ok] 2FA verification accepted'),
  '无人工输入请求': !logs.includes('2FA OTP (6 digits'),
  '子进程退出码 0': code === 0,
};
console.log('\n[e2e] 结果：');
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}
console.log(`[e2e] verify 提交次数 = ${verifyAttempts}`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
