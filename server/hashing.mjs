// Secrets (pairing credentials, OAuth state, binding cookies) are stored only as SHA-256 hashes,
// and anything secret is compared in constant time.
import crypto from 'node:crypto';

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Constant-time equality of two strings; strings of different length are simply unequal. */
export function constantTimeEqual(first, second) {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  return (
    firstBytes.length === secondBytes.length && crypto.timingSafeEqual(firstBytes, secondBytes)
  );
}
