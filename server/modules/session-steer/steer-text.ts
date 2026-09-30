/**
 * Text handling for mid-turn steering (T-1903). The model-facing wrapper is
 * generated HERE only; user text can never form or close a wrapper tag because
 * every `&`, `<` and `>` it contains is entity-escaped first, which also defeats
 * entity-encoded, case-varied and whitespace-padded variants of the tag.
 */

export const STEER_MAX_CHARS = 4000;
const DISPLAY_NAME_MAX = 64;
// C0 (minus \t \n), DEL, C1, zero-width/bidi marks, line/paragraph separators,
// bidi overrides/isolates and BOM (written as escapes: invisible characters in source are a trap).
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

export type SanitizeResult = { ok: true; text: string } | { ok: false; code: 'text_empty' | 'text_too_long' };

/** NFC-normalizes, strips control characters and enforces the length bound. */
export function sanitizeSteerText(raw: unknown): SanitizeResult {
  if (typeof raw !== 'string') return { ok: false, code: 'text_empty' };
  // Bound the work before normalizing an attacker-sized string.
  if (raw.length > STEER_MAX_CHARS * 4) return { ok: false, code: 'text_too_long' };
  const text = raw.normalize('NFC').replace(/\r\n?/gu, '\n').replace(CONTROL_CHARS, '').trim();
  if (!text) return { ok: false, code: 'text_empty' };
  if (text.length > STEER_MAX_CHARS) return { ok: false, code: 'text_too_long' };
  return { ok: true, text };
}

function escapeMarkup(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function unescapeMarkup(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&amp;/gu, '&');
}

/** Attribute-safe display name (never an email or id). */
export function escapeDisplayName(name: unknown): string {
  const plain = typeof name === 'string' ? name.normalize('NFC').replace(CONTROL_CHARS, '').trim() : '';
  const bounded = (plain || 'member').slice(0, DISPLAY_NAME_MAX);
  return escapeMarkup(bounded).replace(/"/gu, '&quot;');
}

/** Who wrote a steer, relative to the running turn: its own starter, or another member. */
export type SteerAuthorRole = 'owner' | 'member';

/**
 * The exact model-facing payload; `null` when wrapping exceeds the bound.
 * `role="owner"` marks a note from the turn's own starter (a self-steer);
 * `role="member"` one from another session member.
 */
export function buildSteerWrapper(displayName: string, text: string, role: SteerAuthorRole = 'member'): string | null {
  const tagRole = role === 'owner' ? 'owner' : 'member';
  const wrapped = `<nassaj-steer from="${escapeDisplayName(displayName)}" role="${tagRole}">\n`
    + `${escapeMarkup(text)}\n</nassaj-steer>`;
  return wrapped.length > STEER_MAX_CHARS ? null : wrapped;
}

const WRAPPER = /^<nassaj-steer from="([^"<>]*)" role="(?:member|owner)">\n([^<>]*)\n<\/nassaj-steer>$/u;

/**
 * Strips the server wrapper for DISPLAY. Callers must only use it on a row whose
 * identity was proven from the ingress table; it is never an authorship signal.
 */
export function unwrapSteerForDisplay(wrapped: string): string | null {
  const match = WRAPPER.exec(wrapped);
  return match ? unescapeMarkup(match[2]) : null;
}
