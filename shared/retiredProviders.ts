/**
 * Provider ids whose runtime was deleted from the codebase (T-1853).
 *
 * A request that still names one of them — a stale client selection, an old
 * bookmark, or a persisted session row — must get a typed refusal instead of a
 * crash, a silent drop, or a spawn. Nothing else may branch on these ids.
 *
 * Note: the id 'gemini' also survives as agy's on-disk credential unit
 * (~/.gemini); that use lives in services/isolation and is unrelated to this list.
 */
export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set(['gemini']);

/** Stable machine-readable code carried by every retired-provider refusal. */
export const PROVIDER_REMOVED_CODE = 'provider_removed';

/** User-facing refusal text shared by the chat and shell sockets. */
export const PROVIDER_REMOVED_MESSAGE = 'This provider has been removed and can no longer start sessions.';

/** True when `value` names a provider whose runtime was deleted. */
export function isRetiredProvider(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_PROVIDER_IDS.has(value.trim().toLowerCase());
}

/**
 * Returns the retired provider id encoded in a chat command type
 * (`<provider>-command`), or null when the type names no retired provider.
 */
export function retiredProviderOfCommandType(messageType: unknown): string | null {
  if (typeof messageType !== 'string' || !messageType.endsWith('-command')) return null;
  const provider = messageType.slice(0, -'-command'.length);
  return isRetiredProvider(provider) ? provider : null;
}
