import crypto from 'node:crypto';

/** SHA-256 digest of a string; fixed length so timingSafeEqual never sees a length mismatch. */
function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time comparison of a caller-supplied secret against the expected one.
 * Both sides are hashed first, so neither the content nor the length of the
 * expected secret leaks through timing. Anything that is not a non-empty string
 * (missing header, repeated header array, number) never matches.
 */
export function secretsEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}
