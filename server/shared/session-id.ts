import { AppError } from '@/shared/utils.js';

/**
 * One grammar for a session id taken from a request (B-1643, T-2034).
 *
 * Every provider writes ids from `[A-Za-z0-9_-]`; observed live shapes
 * (2026-10-16, 529 rows) are UUIDs (claude/codex/hermes/qwen/antigravity),
 * `agy_<ms>_<suffix>`, `kimi_<uuid>` and opencode `ses_<base62>`, 26–41 chars,
 * none with a dot. A dot stays allowed inside an id for forward compatibility,
 * but never leading and never doubled, so `.`, `..` and `.x` cannot name a
 * directory entry or match as a substring of an unrelated file name.
 */
export const SESSION_ID_MAX_LENGTH = 128;

const SESSION_ID_GRAMMAR = /^[A-Za-z0-9_-](?:[A-Za-z0-9_-]|\.(?!\.)){0,127}$/;

/**
 * True when `value` is a string in the session-id grammar: 1–128 chars from
 * `[A-Za-z0-9._-]`, no leading dot and no `..`. No trimming is applied.
 */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_GRAMMAR.test(value);
}

/**
 * Returns `value` unchanged when it is a valid session id; otherwise throws a
 * 400 `INVALID_SESSION_ID` AppError. Nothing is trimmed or normalized, so the
 * id that is checked is exactly the id that is used.
 */
export function parseSessionIdParam(value: unknown): string {
  if (!isSessionId(value)) {
    throw new AppError('Invalid sessionId.', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  return value;
}
