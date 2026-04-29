import crypto from 'crypto';

export function hash64(value) {
  const digest = crypto.createHash('sha256').update(String(value || '')).digest();
  return digest.readBigUInt64BE(0);
}
