/** Kill-switch values; compared after trim + lower-case. */
const INTERNAL_SESSION_CHAT_OFF_VALUES = new Set(['0', 'false']);

/**
 * ADR-187 server flag for the internal session team chat. Read per call so a
 * test or an operator toggle is observed without a module reload. ON by default
 * (owner decision 2026-10-18); only NASSAJ_INTERNAL_SESSION_CHAT_ENABLED set to
 * '0' or 'false' (case-insensitive, trimmed) turns it off.
 */
export function isInternalSessionChatFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED;
  if (raw === undefined) return true;
  return !INTERNAL_SESSION_CHAT_OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Set by the startup migration when a populated legacy-shaped chat schema was
 * found and left untouched; the feature then stays unavailable for the process.
 */
let schemaBlocked = false;

export function setInternalSessionChatSchemaBlocked(blocked: boolean): void {
  schemaBlocked = blocked;
}

export function isInternalSessionChatSchemaBlocked(): boolean {
  return schemaBlocked;
}
