import type { LLMProvider } from '../../../types/app';

/**
 * Resolves which provider a chat turn must be dispatched to (B-167).
 *
 * A conversation is a sealed box of (provider + model): once created it must keep
 * running on the provider it was created with. The composer, however, keeps a
 * single GLOBAL provider selection (localStorage `selected-provider`) that the
 * empty-state picker mutates. Without sealing, opening an existing conversation of
 * provider Y and sending — while the global selection has drifted to X (because a
 * model was picked for a brand-new chat) — would dispatch an X-command against Y's
 * session id, corrupting a running conversation across provider systems.
 *
 * Rules:
 * - Brand-new conversation (`isResume === false`): use the global selection, so a
 *   new chat inherits the current picker choice at creation (requirement 3).
 * - Resumed conversation with a known session provider: use the SESSION's provider
 *   (requirement 1), never the global. `sessionProvider` comes from the selected
 *   session's `__provider`.
 * - Resumed conversation whose provider is not yet known (e.g. a session just
 *   minted in this view, before it becomes the selected session): fall back to the
 *   global provider — which is exactly the provider it was created under.
 */
export function resolveSendProvider(
  isResume: boolean,
  sessionProvider: LLMProvider | null | undefined,
  globalProvider: LLMProvider,
): LLMProvider {
  if (isResume && sessionProvider) {
    return sessionProvider;
  }
  return globalProvider;
}
