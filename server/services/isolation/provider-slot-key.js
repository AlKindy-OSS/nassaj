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
 * ADR-152 A1 §3.8 (D1) settled the precedence: there is no org fallback any
 * more. The install-wide slot is inert data; only a member's own key resolves.
 *
 * The precedent this follows is voice-transcription.service.ts's
 * `resolveTranscriptionKey`: one function returning `{ key, scope }` so the
 * answer and the provenance of the answer can never disagree — which is what the
 * wave-C disclosure contract will read from.
 */

import { isMemberActor } from './credential-actor.js';
import { getProviderKey, isCanonicalVendorSecretId } from './provider-secrets-store.js';

/**
 * @typedef {'kimi'|'deepseek'|'glm'|'qwen'} SlotProvider
 * @typedef {{ key: string, scope: 'user' }} ResolvedSlotKey
 */

/**
 * Resolves one slot for one member: their OWN key, or null.
 *
 * ADR-152 A1 §3.8 (D1): the install-wide ("shared") slot is retired as a
 * runtime source. `sharedFallback` is gone, and a caller with no member — null,
 * undefined or the system actor — gets null instead of the install-wide key. Keys
 * stored there stay on disk, inert (listed by the retirement snapshot); a team
 * key is shared by a member who stores it as their own and grants it. Callers
 * that honour grants pass the credential principal (credential-principal.js).
 *
 * @param {string|number|null|undefined|object} userId the member whose slot to
 *   read. An EMPTY STRING is a call-site bug and the store still throws on it.
 * @param {SlotProvider} slot vendor slot id. An id outside the vendor set
 *   resolves to null; a canonical vendor id (ADR-200) throws.
 * @returns {ResolvedSlotKey|null}
 */
export function resolveSlotKey(userId, slot) {
  // ADR-200 S1: a canonical `vendor:*` record (Anthropic, OpenAI, OpenRouter) is
  // never a slot. It feeds harness files only, so a caller asking for one here
  // is a call-site bug — refused loudly, never resolved to a key.
  if (isCanonicalVendorSecretId(slot)) {
    throw new TypeError(`provider-slot-key: "${slot}" is a canonical vendor record, not a slot`);
  }
  if (userId === '') {
    // B-342: an empty scope is a call-site bug; the store reports it loudly.
    getProviderKey(userId, slot);
  }
  if (!isMemberActor(userId)) {
    return null;
  }
  const own = getProviderKey(userId, slot);
  return own ? { key: own, scope: 'user' } : null;
}
