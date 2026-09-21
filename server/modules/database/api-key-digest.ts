import crypto from 'node:crypto';

export const API_KEY_DIGEST_TAG = 'sha256:';
export const API_KEY_PREFIX_LENGTH = 10;
export const API_KEY_PATTERN = /^ck_[0-9a-f]{64}$/;
export const API_KEY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const API_KEY_PREFIX_PATTERN = /^ck_[0-9a-f]{7}$/;

/** Converts a valid raw API key into the tagged, one-way SQLite representation. */
export function digestApiKey(apiKey: string): string | null {
  if (!API_KEY_PATTERN.test(apiKey)) return null;
  return API_KEY_DIGEST_TAG + crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}
