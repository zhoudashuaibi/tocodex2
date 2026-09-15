import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['password', '*.password', 'admin_key', '*.admin_key', 'req.headers.authorization'],
      censor: '[redacted]',
    },
  });
}
