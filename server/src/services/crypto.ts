import crypto from 'crypto';
import { config } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = config.encryptionKey;
  if (!hex || hex.length < 64) {
    throw new Error('ENCRYPTION_KEY must be at least 64 hex characters');
  }
  return Buffer.from(hex.slice(0, 64), 'hex');
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string: iv(12) + tag(16) + ciphertext
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a base64 AES-256-GCM payload back to plaintext.
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return '';
  const key = getKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
