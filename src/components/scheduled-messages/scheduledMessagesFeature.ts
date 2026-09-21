/**
 * Enabled for every authenticated user by default.
 * The server scopes every operation to the requesting user's own messages,
 * so widening the gate here does not loosen data isolation.
 * An explicit build flag can still restrict (off/0) or force-enable (all/1).
 */
export function isScheduledMessagesCenterEnabled(
  role: string | null | undefined,
  flag: string | undefined = import.meta.env.VITE_SCHEDULED_MESSAGES_CENTER_ENABLED,
): boolean {
  const normalized = flag?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'all') return true;
  if (normalized === '0' || normalized === 'off') return false;
  // Any authenticated role can access their own scheduled messages.
  return role != null && role !== '';
}
