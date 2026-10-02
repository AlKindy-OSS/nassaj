/**
 * Provider ids that are retired AS AGENT BODIES (T-1853, T-1953).
 *
 * `gemini` has no runtime left in the codebase. `hermes`'s body code was
 * deleted (T-1953, ADR-192), keeping only a history-only reader so past
 * conversations stay listable. `cursor`, `qwen` and `kimi` are refused on
 * every body surface while their body code (launchers, provider modules,
 * auth wiring) still exists as dormant code — deleting it is a separate,
 * not-yet-scheduled step; this list is what makes that later deletion safe
 * by making the code unreachable now.
 *
 * A request that still names one of them as a body — a stale client selection,
 * an old bookmark, a persisted session row, or an external API caller — must get
 * a typed refusal instead of a crash, a silent drop, or a spawn. Historical
 * conversations of these ids stay listable and readable; only new runs, logins
 * and body configuration are refused.
 *
 * BODY AXIS ONLY. This list must never be consulted on the engine axis or for
 * credentials: `kimi` remains a live engine of the Claude body and a live key
 * slot, and `qwen` remains a live key slot and an OpenCode carrier model family
 * (`qwen-plan/*`, dispatched under provider `opencode`). Those meanings live in
 * `shared/engineProviders.ts` and `services/isolation`, which do not import this
 * file. Likewise the id 'gemini' survives as agy's on-disk credential unit
 * (~/.gemini); that use lives in services/isolation and is unrelated to this list.
 */
export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'gemini',
  'cursor',
  'hermes',
  'qwen',
  'kimi',
]);

/** Stable machine-readable code carried by every retired-provider refusal. */
export const PROVIDER_REMOVED_CODE = 'provider_removed';

/** User-facing refusal text shared by the sockets and the REST surfaces. */
export const PROVIDER_REMOVED_MESSAGE = 'This provider has been removed and can no longer start sessions.';

/** True when `value` names a provider that is retired as an agent body. */
export function isRetiredProvider(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_PROVIDER_IDS.has(value.trim().toLowerCase());
}

/** Chat message types that start a body run: `<provider>-command` and the legacy `<provider>-resume`. */
const BODY_RUN_MESSAGE_TYPE = /^(.+)-(?:command|resume)$/;

/**
 * Returns the retired provider id encoded in a chat message type that starts a
 * body run (`<provider>-command`, or the legacy `cursor-resume`), or null when
 * the type names no retired provider.
 */
export function retiredProviderOfCommandType(messageType: unknown): string | null {
  if (typeof messageType !== 'string') return null;
  const provider = BODY_RUN_MESSAGE_TYPE.exec(messageType)?.[1];
  return provider !== undefined && isRetiredProvider(provider) ? provider : null;
}
