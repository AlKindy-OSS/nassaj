/**
 * provider-slot-key — the ONE function that answers "which key does this vendor
 * slot hand out, and whose is it?".
 *
 * T-1260 (wave A of the shared-credential path, T-1043). Before this module the
 * answer was spelled inline at eighteen call sites, in two mutually incompatible
 * dialects:
 *
 *   getProviderKey(userId ?? SYSTEM_SCOPE, p)                  // no org fallback
 *   getProviderKey(userId) || getProviderKey(SYSTEM_SCOPE, p)  // org fallback
 *
 * Whether a member's turn spent the ORG's money therefore depended on which file
 * happened to serve the request — the run path fell back (T-1208) while the
 * catalog path did not, which is precisely how B-436 shipped. Wave B is going to
 * put a DECLARATION in front of the shared slot ("this key is shared, by whom,
 * since when"); a declaration is only as strong as the narrowest door into the
 * store, so the door had to become one door first.
 *
 * WHAT THIS MODULE DOES NOT DO — YET. It changes no precedence. `sharedFallback`
 * is a REQUIRED option with no default precisely so that every converted site
 * restates the behaviour it already had, out loud, and so the compiler refuses a
 * site that has not decided. Unifying those two dialects is a behavioural change
 * and belongs to a later wave, on the record, not smuggled in under a refactor.
 *
 * The precedent this follows is voice-transcription.service.ts's
 * `resolveTranscriptionKey`: one function returning `{ key, scope }` so the
 * answer and the provenance of the answer can never disagree — which is what the
 * wave-C disclosure contract will read from.
 */

import { getProviderKey, getSharedVendorKey } from './provider-secrets-store.js';

/**
 * @typedef {'kimi'|'deepseek'|'glm'|'qwen'} SlotProvider
 * @typedef {{ key: string, scope: 'user'|'shared' }} ResolvedSlotKey
 */

/**
 * Resolves one slot for one caller.
 *
 * @param {string|number|null|undefined} userId the authenticated member, or
 *   null/undefined for a caller with no identity (system task, unauthenticated
 *   single-user mode). An EMPTY STRING is not an identity and not an absence —
 *   it is a call-site bug, and the store still throws on it, exactly as today.
 * @param {SlotProvider} slot vendor slot id. An id outside the vendor set
 *   resolves to null at runtime rather than throwing, matching the store's read
 *   contract — but the type keeps that from being the normal way in.
 * @param {{ sharedFallback: boolean }} options `sharedFallback: true` consults
 *   the operator-wide slot when the member holds no key of their own. Required,
 *   never defaulted — see the module note.
 * @returns {ResolvedSlotKey|null} null when no key is resolvable in any scope.
 */
export function resolveSlotKey(userId, slot, options) {
  const { sharedFallback } = options;

  // ADR-101: Coding Plan credentials are personal subscriptions. A Qwen run
  // may never consume the operator/org slot, including when the caller has no
  // authenticated identity. Make that invariant structural at the one key
  // resolution seam rather than trusting every future caller to remember it.
  if (slot === 'qwen') {
    if (userId === null || userId === undefined) {
      return null;
    }
    const personal = getProviderKey(userId, slot);
    return personal ? { key: personal, scope: 'user' } : null;
  }

  // No identity at all: there is no member slot to prefer, so the operator-wide
  // slot is the only candidate — with or without a fallback. This reproduces
  // `userId ?? SYSTEM_SCOPE` byte-for-byte, including for the sites that never
  // fell back.
  if (userId !== null && userId !== undefined) {
    const own = getProviderKey(userId, slot);
    if (own) {
      return { key: own, scope: 'user' };
    }
    if (!sharedFallback) {
      return null;
    }
  }

  const shared = getSharedVendorKey(slot);
  return shared ? { key: shared, scope: 'shared' } : null;
}
