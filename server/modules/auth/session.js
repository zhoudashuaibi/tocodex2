const COOKIE_NAME = 'tocodex2_session';
const SLIDING_THRESHOLD_MS = 5 * 60 * 1000;

export { COOKIE_NAME };

export function createSessionService(db, crypto, { ttlDays = 30 } = {}) {
  const ttlMs = ttlDays * 24 * 3600 * 1000;

  function purgeExpired() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  }

  function create({ ip = null, userAgent = null } = {}) {
    const token = crypto.randomToken();
    const tokenHash = crypto.sha256Hex(token);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    db.prepare(
      `INSERT INTO sessions(token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES(?,?,?,?,?,?)`,
    ).run(tokenHash, now, expiresAt, now, ip, userAgent);
    purgeExpired();
    return { token, tokenHash, expiresAt };
  }

  function verify(token) {
    if (!token) return null;
    const tokenHash = crypto.sha256Hex(token);
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;
    if (row.expires_at < new Date().toISOString()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    // 滑动续期：距上次访问 >5 分钟才写库，减少写放大
    const lastSeen = Date.parse(row.last_seen_at);
    const nowMs = Date.now();
    const newExpiry = new Date(nowMs + ttlMs).toISOString();
    if (nowMs - lastSeen > SLIDING_THRESHOLD_MS || row.expires_at < newExpiry) {
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
        new Date(nowMs).toISOString(),
        row.expires_at > newExpiry ? row.expires_at : newExpiry,
        tokenHash,
      );
    }
    return { tokenHash, expiresAt: row.expires_at, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
  }

  function revoke(token) {
    if (!token) return;
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.sha256Hex(token));
  }

  function revokeAll(exceptTokenHash = null) {
    if (exceptTokenHash) {
      const result = db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(exceptTokenHash);
      return result.changes;
    }
    const result = db.prepare('DELETE FROM sessions').run();
    return result.changes;
  }

  function list(currentTokenHash) {
    const rows = db.prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC').all();
    return rows.map((row) => ({
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
      ip: row.ip,
      user_agent: row.user_agent,
      current: row.token_hash === currentTokenHash,
    }));
  }

  return { create, verify, revoke, revokeAll, list, purgeExpired };
}

export function parseSessionCookie(header) {
  const match = /(?:^|;\s*)tocodex2_session=([^;]+)/.exec(String(header || ''));
  return match ? decodeURIComponent(match[1]) : null;
}

export function buildSessionCookie(token, { maxAge = 2592000, secure = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
