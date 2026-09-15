import { AppError, errors } from '../../lib/http-errors.js';
import { createSessionService, parseSessionCookie, buildSessionCookie, clearSessionCookie } from './session.js';
import { createRateLimiter } from './rate-limit.js';

const PASSWORD_KEY = 'console.password';

export function createAuthModule({ config, logger }) {
  return async function authModule(app) {
    const db = app.db;
    const crypto = app.crypto;
    const sessionService = createSessionService(db, crypto, { ttlDays: config.sessionTtlDays });
    const rateLimiter = createRateLimiter(db, {
      maxFails: config.loginMaxFails,
      lockMinutes: config.loginLockMinutes,
    });
    app.decorate('sessionService', sessionService);

    function getPasswordRecord() {
      const value = app.settings.get(PASSWORD_KEY);
      return value && typeof value === 'object' && value.hash ? value : null;
    }

    function passwordInitialized() {
      return getPasswordRecord() != null;
    }

    function ensurePasswordSeed() {
      if (getPasswordRecord()) return;
      if (config.consolePasswordSeed) {
        app.settings.set(PASSWORD_KEY, crypto.hashPassword(config.consolePasswordSeed));
        logger.info('已用 TOCODEX2_CONSOLE_PASSWORD 环境变量初始化控制台密码');
      }
    }

    function isSecureRequest(request) {
      if (config.forceSecureCookie) return true;
      return String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    }

    // ---------- 认证 hook：全 API 生效 ----------
    app.addHook('onRequest', async (request, reply) => {
      const url = request.raw.url || '';
      if (!url.startsWith('/api/')) return;
      const pathname = url.split('?')[0];
      const isPublic =
        pathname === '/api/v1/auth/login' ||
        pathname === '/api/v1/auth/session' ||
        pathname === '/api/v1/health' ||
        pathname.startsWith('/api/v1/health/');
      if (isPublic) return;

      const token = parseSessionCookie(request.headers.cookie);
      const session = sessionService.verify(token);
      if (!session) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '未登录或会话已过期' } });
      }
      request.session = session;
      request.sessionToken = token;

      // CSRF 双保险：SameSite=Strict 之外，写方法校验 Origin + X-Requested-With
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const requestedWith = String(request.headers['x-requested-with'] || '');
        if (requestedWith.toLowerCase() !== 'xmlhttprequest') {
          return reply.code(403).send({ error: { code: 'CSRF_REJECTED', message: '请求缺少必要的 CSRF 校验头' } });
        }
        const origin = request.headers.origin;
        if (origin) {
          try {
            const originHost = new URL(origin).host;
            const host = request.headers.host;
            if (originHost !== host) {
              return reply.code(403).send({ error: { code: 'CSRF_REJECTED', message: 'Origin 与 Host 不同源' } });
            }
          } catch {
            return reply.code(403).send({ error: { code: 'CSRF_REJECTED', message: 'Origin 非法' } });
          }
        }
      }
    });

    // ---------- 路由 ----------
    app.get('/api/v1/auth/session', async (request) => {
      const token = parseSessionCookie(request.headers.cookie);
      const session = sessionService.verify(token);
      const countRow = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
      return {
        authenticated: Boolean(session),
        password_initialized: passwordInitialized(),
        expires_at: session?.expiresAt ?? null,
        sessions_count: countRow?.n ?? 0,
      };
    });

    app.post(
      '/api/v1/auth/login',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              password: { type: 'string', maxLength: 512 },
              new_password: { type: 'string', maxLength: 512 },
            },
          },
        },
      },
      async (request, reply) => {
        ensurePasswordSeed();
        const ip = request.ip;
        const limit = rateLimiter.check(ip);
        if (limit.locked) {
          throw errors.rateLimited(limit.retryAfterSeconds);
        }

        const { password, new_password: newPassword } = request.body || {};
        const record = getPasswordRecord();

        // 首访设置密码
        if (!record) {
          if (typeof newPassword !== 'string' || newPassword.length < 8) {
            throw errors.validation('访问密码至少 8 位');
          }
          app.settings.set(PASSWORD_KEY, crypto.hashPassword(newPassword));
          rateLimiter.recordSuccess(ip);
          const session = sessionService.create({ ip, userAgent: request.headers['user-agent'] });
          logger.info({ ip }, 'console password initialized');
          reply.header('set-cookie', buildSessionCookie(session.token, { secure: isSecureRequest(request) }));
          return { ok: true, password_initialized: true };
        }

        if (typeof password !== 'string' || !crypto.verifyPassword(password, record)) {
          const fail = rateLimiter.recordFailure(ip);
          logger.warn({ ip }, 'console login failed');
          throw new AppError(
            401,
            'INVALID_PASSWORD',
            fail.locked ? '密码错误次数过多，已锁定' : '密码错误',
            { remaining_attempts: fail.remainingAttempts },
          );
        }

        rateLimiter.recordSuccess(ip);
        // 登录总是新 token，防会话固定
        const session = sessionService.create({ ip, userAgent: request.headers['user-agent'] });
        logger.info({ ip }, 'console login success');
        reply.header('set-cookie', buildSessionCookie(session.token, { secure: isSecureRequest(request) }));
        return { ok: true };
      },
    );

    app.post('/api/v1/auth/logout', async (request, reply) => {
      sessionService.revoke(request.sessionToken);
      reply.header('set-cookie', clearSessionCookie());
      return { ok: true };
    });

    app.post('/api/v1/auth/logout-all', async (request, reply) => {
      const revoked = sessionService.revokeAll(request.session?.tokenHash);
      reply.header('set-cookie', clearSessionCookie());
      return { ok: true, revoked };
    });

    app.get('/api/v1/auth/sessions', async (request) => {
      return { items: sessionService.list(request.session?.tokenHash) };
    });

    app.post(
      '/api/v1/auth/password',
      {
        schema: {
          body: {
            type: 'object',
            required: ['current_password', 'new_password'],
            additionalProperties: false,
            properties: {
              current_password: { type: 'string', maxLength: 512 },
              new_password: { type: 'string', minLength: 8, maxLength: 512 },
            },
          },
        },
      },
      async (request, reply) => {
        const ip = request.ip;
        const limit = rateLimiter.check(ip);
        if (limit.locked) throw errors.rateLimited(limit.retryAfterSeconds);
        const { current_password: current, new_password: next } = request.body;
        const record = getPasswordRecord();
        if (!record || !crypto.verifyPassword(current, record)) {
          const fail = rateLimiter.recordFailure(ip);
          throw new AppError(401, 'INVALID_PASSWORD', fail.locked ? '密码错误次数过多，已锁定' : '当前密码错误', {
            remaining_attempts: fail.remainingAttempts,
          });
        }
        rateLimiter.recordSuccess(ip);
        const tx = db.transaction(() => {
          app.settings.set(PASSWORD_KEY, crypto.hashPassword(next));
          sessionService.revokeAll(); // 改密 = 全端登出
        });
        tx();
        const session = sessionService.create({ ip, userAgent: request.headers['user-agent'] });
        reply.header('set-cookie', buildSessionCookie(session.token, { secure: isSecureRequest(request) }));
        logger.info({ ip }, 'console password changed');
        return { ok: true };
      },
    );
  };
}
