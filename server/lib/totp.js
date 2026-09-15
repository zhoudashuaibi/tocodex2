import crypto from 'node:crypto';

/** RFC6238 TOTP（HMAC-SHA1 / 30s / 6 位），与 core/protocol-login.mjs generateTotp 同构。 */
export function generateTotp(secret, timestamp = Date.now()) {
  const key = decodeBase32Secret(secret);
  const counter = BigInt(Math.floor(timestamp / 30_000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/** 带时钟偏移容错的生成：返回 [当前窗口, -30s, +30s] 中第一个（调用方自行验证）。 */
export function generateTotpCandidates(secret, timestamp = Date.now()) {
  return [
    { code: generateTotp(secret, timestamp), offsetMs: 0 },
    { code: generateTotp(secret, timestamp - 30_000), offsetMs: -30_000 },
    { code: generateTotp(secret, timestamp + 30_000), offsetMs: 30_000 },
  ];
}

function decodeBase32Secret(value) {
  const normalized = String(value || '').toUpperCase().replace(/[\s=]/g, '');
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    throw new Error('2FA 密钥必须是仅含 A-Z 和 2-7 的 Base32 字符串');
  }
  let bits = '';
  for (const char of normalized) {
    const index = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}
