#!/usr/bin/env node
/**
 * mock protocol-login 子进程：按 --mock-script 环境变量给的剧本输出 json-events，
 * 用于任务引擎集成测试（复用 v1 test/mock-protocol-login.mjs 思路）。
 *
 * 剧本协议（TOCODEX2_MOCK_SCRIPT env，JSON）：
 *   { events: [ {type,...}... ], interact?: { kind: "email_otp", expect: "123456" } }
 * interact 到达 input_required 后等待 stdin；收到合法输入输出 input_accepted 并继续。
 */
const scriptPath = process.env.TOCODEX2_MOCK_SCRIPT;
const failPath = process.env.TOCODEX2_MOCK_FAIL; // 输出到此文件供测试断言子进程收到的输入

import fs from 'node:fs';
import path from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!scriptPath) {
    console.error('mock-protocol-login: missing TOCODEX2_MOCK_SCRIPT');
    process.exit(2);
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  if (process.env.TOCODEX2_MOCK_ENV_DUMP) {
    // 测试钩子：断言 launcher 注入的凭据环境变量
    fs.appendFileSync(
      process.env.TOCODEX2_MOCK_ENV_DUMP,
      `${JSON.stringify({ totpPickupUrl: process.env.CHATGPT_TOTP_PICKUP_URL || '', totpSecret: process.env.CHATGPT_TOTP_SECRET || '' })}\n`,
    );
  }
  const attempt = Math.max(1, Number.parseInt(process.env.TOCODEX2_JOB_ATTEMPT || '1', 10) || 1);
  const emit = (type, fields = {}) => {
    process.stdout.write(`${JSON.stringify({ type, ts: new Date().toISOString(), attempt, ...fields })}\n`);
  };

  emit('starting', { mode: 'full', email: 'mock@test.local' });
  for (const event of script.events || []) {
    if (event.type === 'input_required') {
      emit('input_required', event);
      const value = await readCommand();
      if (failPath) fs.appendFileSync(failPath, `${JSON.stringify(value)}\n`);
      if (value?.action === 'quit') {
        emit('error', { code: 'EMAIL_OTP_INVALID', message: 'Stopped before email OTP validation', fatal: true, retry_proxy: false });
        process.exit(1);
      }
      if (value?.action === 'input' && String(value.value) !== String(event.expect ?? '')) {
        emit('log', { level: 'warn', message: '验证码错误，重新要求输入' });
        emit('input_required', event);
        const retry = await readCommand();
        if (retry?.action === 'quit' || String(retry?.value) !== String(event.expect ?? '')) {
          emit('error', { code: 'EMAIL_OTP_INVALID', message: 'Stopped before email OTP validation', fatal: true, retry_proxy: false });
          process.exit(1);
        }
      }
      emit('input_accepted', { kind: event.kind });
      continue;
    }
    if (event.type === '__sleep') {
      await delay(event.ms || 500);
      continue;
    }
    if (event.type === 'result_saved' && process.env.TOCODEX2_MOCK_RESULT_PATH) {
      // 测试钩子：按事件携带的 path 写出真实结构的 codex2api 导出文件
      const exportData = {
        type: 'codex2api-data',
        version: 1,
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts: [
          {
            name: 'oauth---mock@test.local',
            platform: 'openai',
            type: 'oauth',
            credentials: {
              access_token: 'mock-access-token',
              refresh_token: 'mock-refresh-token',
              id_token: 'mock-id-token',
              chatgpt_account_id: 'us_mock',
              email: 'mock@test.local',
            },
            extra: {
              account_id: 'us_mock',
              chatgpt_account_id: 'us_mock',
              chatgpt_user_id: 'user_mock',
              client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
              email: 'mock@test.local',
            },
          },
        ],
      };
      fs.mkdirSync(path.dirname(event.path), { recursive: true });
      fs.writeFileSync(event.path, JSON.stringify(exportData, null, 2));
    }
    emit(event.type, event);
  }
  emit('exit', { ok: true });
}

function readCommand() {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      process.stdin.removeListener('data', onData);
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve(null);
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

main().catch((error) => {
  process.stderr.write(`mock-protocol-login crashed: ${error.stack}\n`);
  process.exit(1);
});
