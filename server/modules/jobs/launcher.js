import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTotpPickupUrl, DEFAULT_TWOFA_FETCH_TEMPLATE } from '../../lib/totp-pickup.js';

/**
 * spawn protocol-login 子进程 + env 注入 + stdout 逐行 json-events 解析 + stderr 落日志文件。
 * 凭据全部走环境变量，不进 argv、不写日志。
 */
export function createLauncher({ config, logger }) {
  function launch(job, { account, proxyUrl, attempt }, callbacks) {
    const logPath = path.resolve(config.dataDir, job.log_path);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const args = buildArgs(job, account, config.dataDir);
    const env = {
      ...process.env,
      CHATGPT_PROXY_URL: proxyUrl ?? '',
      CHATGPT_PROXY_MAX_ATTEMPTS: String(Math.max(1, 10 - (job.proxy_attempts || 0))),
      CHATGPT_LOGIN_PASSWORD: account?.credentials?.password ?? '',
      CHATGPT_TOTP_SECRET: account?.credentials?.totp_secret ?? '',
      // 2FA 在线取件：模板 + 账号取件码在此解析成完整 URL，子进程直接 GET
      CHATGPT_TOTP_PICKUP_URL: resolveTotpPickupUrl(
        config.settingsGet?.('twofa.fetch')?.template || DEFAULT_TWOFA_FETCH_TEMPLATE,
        account?.credentials?.totp_pickup_code,
      ),
      TOCODEX2_JOB_ATTEMPT: String(attempt),
      TOCODEX2_TLS_PROFILE: '',
    };

    logLine(logStream, `[engine] spawn attempt=${attempt} proxy=${proxyUrl ? 'yes' : 'direct'} type=${job.type}`);

    const child = spawn(process.execPath, args, {
      cwd: config.serverRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          logLine(logStream, `[stdout-non-json] ${line.slice(0, 500)}`);
          continue;
        }
        logLine(logStream, `[event] ${line.slice(0, 1000)}`);
        callbacks.onEvent?.(event);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) logLine(logStream, line);
      }
    });

    child.on('error', (error) => {
      logLine(logStream, `[engine] spawn error: ${error.message}`);
      callbacks.onExited?.(-1, null, new Error(`spawn failed: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      logLine(logStream, `[engine] child exited code=${code} signal=${signal ?? ''}`);
      logStream.end();
      callbacks.onExited?.(code, signal, null);
    });

    return {
      child,
      sendCommand(command) {
        return new Promise((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode) {
            reject(new Error('JOB_NOT_AWAITING_INPUT'));
            return;
          }
          child.stdin.write(`${JSON.stringify(command)}\n`, (error) => (error ? reject(error) : resolve()));
        });
      },
      kill() {
        return new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode) {
            resolve();
            return;
          }
          const forceTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
          }, 3000);
          child.once('close', () => {
            clearTimeout(forceTimer);
            resolve();
          });
          try {
            child.kill('SIGTERM');
          } catch {
            clearTimeout(forceTimer);
            resolve();
          }
        });
      },
    };
  }

  return { launch };
}

function buildArgs(job, account, dataDir) {
  // TOCODEX2_PROTOCOL_SCRIPT: 测试时替换子进程脚本（默认真实协议登录）
  const script = process.env.TOCODEX2_PROTOCOL_SCRIPT || 'core/protocol-login.mjs';
  const args = [script, '--json-events', '--verbose'];
  const resultPath = (name) => path.resolve(dataDir, 'results', name);
  if (job.type === 'refresh') {
    // refresh 源 = 账号当前导出文件（tokens 入库时同步维护），产物写到本 job 专属文件
    const source = job.account_id
      ? resultPath(`account-${job.account_id}.json`)
      : path.resolve(job.result_path || resultPath(`${job.id}.json`));
    args.push(
      '--refresh-codex2api',
      source,
      '--codex2api-out',
      resultPath(`${job.id}.json`),
    );
    return args;
  }
  if (job.type === 'totp_setup') {
    args.push(
      '--email',
      account?.email || '',
      '--setup-totp',
      '--totp-result',
      job.totp_result_path || resultPath(`${job.id}-totp.json`),
    );
    return args;
  }
  // login
  args.push(
    '--email',
    account?.email || '',
    '--output-mode',
    'codex2api',
    '--codex2api-out',
    resultPath(`${job.id}.json`),
  );
  if (job.account_id) {
    const checkpoint = path.resolve(dataDir, 'checkpoints', String(job.account_id), 'login.json');
    args.push('--checkpoint', checkpoint, '--resume-checkpoint', checkpoint);
  }
  return args;
}

function logLine(stream, line) {
  const ts = new Date().toISOString().slice(11, 19);
  stream.write(`[${ts}] ${line}\n`);
}
