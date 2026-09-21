import { filterDisabledProviders } from '../../../shared/disabledProviders';
import type { LLMProvider } from '../../types/app';

import type { ProviderAuthStatus, ProviderAuthStatusMap } from './types';

/**
 * Returns true when the provider should be shown in the UI.
 * Fail-open: only hide when we have a confirmed installed===false
 * with the check having succeeded (checkFailed===false) and not currently loading.
 *
 * checkFailed===true means the HTTP request itself failed (non-2xx or network
 * error) — in that case we cannot trust installed===false and stay visible.
 * A populated `error` field does NOT trigger fail-open here because the backend
 * fills error for legitimate negative states (e.g. "Not installed") on a
 * successful 200 response.
 */
export function isProviderVisible(status: ProviderAuthStatus): boolean {
  const isDefinitelyNotInstalled =
    status.installed === false && !status.loading && !status.checkFailed;
  return !isDefinitelyNotInstalled;
}

/**
 * Returns true when the provider is visible but not authenticated
 * (show CTA, no models selectable).
 * Only fires when installed===true, auth===false, check succeeded, not loading.
 *
 * checkFailed===true (HTTP/network failure) keeps the provider enabled
 * (fail-open) so a transient error does not block the user.
 */
export function isProviderDisabled(status: ProviderAuthStatus): boolean {
  return (
    status.installed === true &&
    !status.authenticated &&
    !status.checkFailed &&
    !status.loading
  );
}

/**
 * Returns true when the currently selected provider should be reset
 * to a fallback because it is definitively not installed.
 * Same conditions as isProviderVisible===false.
 * Fail-open: never reset during loading or when the check itself failed.
 */
export function shouldResetProvider(status: ProviderAuthStatus): boolean {
  return status.installed === false && !status.loading && !status.checkFailed;
}

/**
 * Picks the provider to bounce the composer to when the selected one turns out
 * to be definitively not installed (see `shouldResetProvider`).
 *
 * `order` is the caller's preference order (the chat surface passes the
 * capability-descriptor key order, so TS guarantees completeness). It is
 * filtered through the global disabled seam FIRST: an auto-reset must never
 * hand the user a provider that is not selectable in the picker and that the
 * dispatch seam refuses — that combination is a dead-end chat, not a fallback.
 * Concretely, the unfiltered order reached `gemini`, `deepseek` and (since the
 * 2026-07-26 GLM fold) `glm`.
 *
 * Fail-open on the status itself: only a confirmed `installed === false`
 * disqualifies a candidate, so a loading/failed probe stays eligible. `claude`
 * is the last-resort default — it is never globally disabled.
 */
export function resolveFallbackProvider(
  order: readonly LLMProvider[],
  status: ProviderAuthStatusMap,
): LLMProvider {
  const selectable = filterDisabledProviders(order);
  return selectable.find((provider) => status[provider]?.installed !== false) ?? 'claude';
}
