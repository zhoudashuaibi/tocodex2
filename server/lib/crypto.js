import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;

/**
 * 加密信封格式：v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
 * AAD 绑定字段用途（fieldPath），防跨字段替换攻击。
 */
export function createCrypto({ dataDir, secretKeyEnv = '', logger = null }) {
  const key = loadOrCreateKey(dataDir, secretKeyEnv, logger);

  function encrypt(plaintext, fieldPath) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    if (fieldPath) cipher.setAAD(Buffer.from(fieldPath, 'utf8'));
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  function decrypt(envelope, fieldPath) {
    const text = String(envelope || '');
    const parts = text.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('ENVELOPE_INVALID: 不是合法的加密信封');
    }
    try {
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const ct = Buffer.from(parts[3], 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      if (fieldPath) decipher.setAAD(Buffer.from(fieldPath, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`DECRYPT_FAILED: 字段 ${fieldPath || '<unknown>'} 解密失败（密钥不匹配或数据损坏）`);
    }
  }

  function tryDecrypt(envelope, fieldPath) {
    try {
      return decrypt(envelope, fieldPath);
    } catch {
      return null;
    }
  }

  return {
    encrypt,
    decrypt,
    tryDecrypt,
    encryptJson(value, fieldPath) {
      return encrypt(JSON.stringify(value ?? null), fieldPath);
    },
    decryptJson(envelope, fieldPath) {
      const text = decrypt(envelope, fieldPath);
      return text === null || text === '' ? null : JSON.parse(text);
    },
    tryDecryptJson(envelope, fieldPath) {
      try {
        return envelope ? this.decryptJson(envelope, fieldPath) : null;
      } catch {
        return null;
      }
    },
    hashPassword(password) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
      return { salt, hash };
    },
    verifyPassword(password, stored) {
      if (!stored || typeof stored !== 'object') return false;
      const expected = Buffer.from(String(stored.hash || ''), 'hex');
      if (expected.length === 0) return false;
      const actual = crypto.scryptSync(String(password), String(stored.salt || ''), 64);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    },
    randomToken() {
      return crypto.randomBytes(32).toString('base64url');
    },
    sha256Hex(value) {
      return crypto.createHash('sha256').update(String(value)).digest('hex');
    },
  };
}

function loadOrCreateKey(dataDir, secretKeyEnv, logger) {
  const envValue = String(secretKeyEnv || '').trim();
  if (envValue) {
    // 32 字节 base64 直接使用；任意字符串经 sha256 派生
    try {
      const decoded = Buffer.from(envValue, 'base64');
      if (decoded.length === KEY_BYTES && decoded.toString('base64') === envValue) return decoded;
    } catch {
      // fallthrough
    }
    return crypto.createHash('sha256').update(envValue).digest();
  }

  const keyPath = path.join(dataDir, 'secret.key');
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === KEY_BYTES) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const generated = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(keyPath, generated, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，忽略
  }
  logger?.warn?.('已自动生成 data/secret.key 加密密钥；建议通过 TOCODEX2_SECRET_KEY 环境变量显式提供以便备份与迁移');
  return generated;
}
