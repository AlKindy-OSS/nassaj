/**
 * ADR-187 server flag for the internal session team chat. Read per call so a
 * test or an operator toggle is observed without a module reload. Only the exact
 * value '1' enables it; anything else is off.
 */
export function isInternalSessionChatFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED === '1';
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
