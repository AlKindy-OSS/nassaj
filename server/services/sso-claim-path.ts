/**
 * Claim-path language (ADR-194 D4, T-1962 S2).
 *
 *   path    := segment (('.' segment) | bracket)*
 *   segment := ident | bracket
 *   bracket := '[' JSON-string ']'
 *   ident   := [A-Za-z0-9_$-]{1,64}
 *
 * A bracket may follow the previous segment directly (`a["b"]`) or after a dot
 * (`a.["b"]`). At most 8 segments and 256 characters. `__proto__`,
 * `constructor` and `prototype` are rejected at parse (save) and again at
 * evaluation. Evaluation walks OWN properties of plain objects only
 * (`Object.hasOwn`), on verified id_token claims only, and never throws.
 *
 * Normalization of the value found: string → [s]; array → its string
 * elements; object → its keys; anything else → absent. More than 64 names or
 * any name over 128 characters → `claim_too_large` (refused, never truncated).
 */

export const CLAIM_PATH_MAX_LENGTH = 256;
export const CLAIM_PATH_MAX_SEGMENTS = 8;
export const CLAIM_MAX_NAMES = 64;
export const CLAIM_MAX_NAME_LENGTH = 128;

const IDENT = /^[A-Za-z0-9_$-]{1,64}/u;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** I9: user-editable OIDC claims may never be the top-level segment of a role or tenant path. */
export const USER_EDITABLE_CLAIMS: ReadonlySet<string> = new Set([
  'name', 'given_name', 'family_name', 'middle_name', 'nickname', 'preferred_username', 'profile',
  'picture', 'website', 'locale', 'zoneinfo', 'gender', 'birthdate', 'phone_number', 'address',
]);

/** The only top-level claim allowed for a tenant path and refused for a role path (D4/D5). */
export const EMAIL_CLAIM = 'email';

export type ClaimPathParse = { ok: true; segments: string[] } | { ok: false; reason: 'claim_path_invalid' };

const INVALID: ClaimPathParse = Object.freeze({ ok: false, reason: 'claim_path_invalid' });

/** Reads one `[ "…" ]` segment at `start`; returns the decoded string and the index after `]`. */
function readBracket(raw: string, start: number): { value: string; end: number } | null {
  if (raw[start] !== '[' || raw[start + 1] !== '"') return null;
  let index = start + 2;
  while (index < raw.length && raw[index] !== '"') {
    index += raw[index] === '\\' ? 2 : 1;
  }
  if (index >= raw.length || raw[index + 1] !== ']') return null;
  try {
    const value: unknown = JSON.parse(raw.slice(start + 1, index + 1));
    return typeof value === 'string' && value.length > 0 ? { value, end: index + 2 } : null;
  } catch {
    return null;
  }
}

/** Reads one segment (ident or bracket) at `start`. */
function readSegment(raw: string, start: number): { value: string; end: number } | null {
  if (raw[start] === '[') return readBracket(raw, start);
  const match = IDENT.exec(raw.slice(start));
  if (!match) return null;
  const end = start + match[0].length;
  // An ident longer than 64 characters is not a shorter ident followed by junk.
  return /[A-Za-z0-9_$-]/u.test(raw[end] ?? '') ? null : { value: match[0], end };
}

function scanSegments(raw: string): string[] | null {
  const segments: string[] = [];
  let index = 0;
  for (;;) {
    const segment = readSegment(raw, index);
    if (!segment || FORBIDDEN_SEGMENTS.has(segment.value)) return null;
    segments.push(segment.value);
    if (segments.length > CLAIM_PATH_MAX_SEGMENTS) return null;
    index = segment.end;
    if (index === raw.length) return segments;
    if (raw[index] === '.') index += 1;
    else if (raw[index] !== '[') return null;
  }
}

/** Parses a claim path per the D4 grammar and caps. Never throws. */
export function parseClaimPath(raw: unknown): ClaimPathParse {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CLAIM_PATH_MAX_LENGTH) return INVALID;
  const segments = scanSegments(raw);
  return segments === null ? INVALID : { ok: true, segments };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type ClaimLookup = { present: false } | { present: true; value: unknown };

/** Walks own properties of plain objects only; a forbidden segment is never followed. */
export function resolveClaimPath(claims: unknown, segments: readonly string[]): ClaimLookup {
  let current: unknown = claims;
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment) || !isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return { present: false };
    }
    current = current[segment];
  }
  return { present: true, value: current };
}

export type ClaimNames =
  | { status: 'absent' }
  | { status: 'too_large' }
  | { status: 'ok'; names: string[] };

const tooLarge = (names: readonly string[]): boolean =>
  names.length > CLAIM_MAX_NAMES || names.some((name) => name.length > CLAIM_MAX_NAME_LENGTH);

/** D4 normalization with caps; nothing is truncated. */
export function normalizeClaimValue(value: unknown): ClaimNames {
  let names: string[];
  if (typeof value === 'string') {
    names = [value];
  } else if (Array.isArray(value)) {
    if (value.length > CLAIM_MAX_NAMES) return { status: 'too_large' };
    names = value.filter((entry): entry is string => typeof entry === 'string');
  } else if (isPlainObject(value)) {
    names = Object.keys(value);
  } else {
    return { status: 'absent' };
  }
  return tooLarge(names) ? { status: 'too_large' } : { status: 'ok', names };
}

/** Resolve + normalize in one step. An absent path or a non-collection value is `absent`. */
export function claimNames(claims: unknown, segments: readonly string[]): ClaimNames {
  const lookup = resolveClaimPath(claims, segments);
  return lookup.present ? normalizeClaimValue(lookup.value) : { status: 'absent' };
}

export type ClaimPathUse = 'role' | 'tenant';

/**
 * Save-time validation of a role or tenant path: grammar, caps, forbidden
 * segments, the I9 user-editable list, and `email` only for a tenant path.
 */
export function claimPathRefusal(raw: unknown, use: ClaimPathUse): string | null {
  const parsed = parseClaimPath(raw);
  const invalid = use === 'role' ? 'role_claim_path_invalid' : 'tenant_claim_path_invalid';
  if (!parsed.ok) return invalid;
  const [top] = parsed.segments;
  if (USER_EDITABLE_CLAIMS.has(top)) return 'claim_path_user_editable';
  if (top === EMAIL_CLAIM && (use === 'role' || parsed.segments.length !== 1)) return 'claim_path_user_editable';
  return null;
}
