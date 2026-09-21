/**
 * engineProviderSession.ts — T-915 (ADR-037/B-ENG) pure-storage helpers.
 *
 * Extracted from useChatProviderState.ts so they can be:
 *   a) imported by useChatRealtimeHandlers.ts without pulling in React, and
 *   b) unit-tested in node:test without browser/React stubs.
 *
 * Three orthogonal storage slots:
 *
 *   1. GLOBAL key  (`claude-engine-provider`)           — user's current picker choice.
 *      Written by persistEngineProvider; read on app boot.
 *
 *   2. SESSION key (`claude-engine-provider-<sessionId}`) — engine stamped when the
 *      session was CREATED (the value actually sent in the claude-command).
 *      Written by stampSessionEngineProvider, read by readSessionEngineProvider.
 *
 *   3. PENDING slot (sessionStorage `__nassaj_pending_engine_stamp`) — one-shot
 *      handoff between dispatchProviderCommand (send time) and the session_created
 *      handler (stamp time). Written by writePendingEngineStamp, consumed+cleared
 *      by consumePendingEngineStamp.  Prevents the global key (slot 1) from being
 *      read at stamp time, which would leak a stale selection into a new session
 *      whose React state had been reset to null when opening an older session.
 */
import { type VendorProvider } from '../../provider-auth/vendorProviders';
import { isEngineProviderEligible } from '../../../../shared/engineProviders';

/**
 * The active "Claude engine on a vendor endpoint" selection (ADR-037). A vendor
 * id means the Claude engine runs against that vendor's Anthropic-compatible
 * endpoint; null is the normal official-Anthropic path.
 */
export type EngineProvider = VendorProvider | null;

const ENGINE_PROVIDER_STORAGE_KEY = 'claude-engine-provider';

/**
 * key used for the pending one-shot handoff (T-915). Must be in sessionStorage
 * (tab-scoped) so it never survives across browser sessions or tabs.
 */
const PENDING_ENGINE_STAMP_KEY = '__nassaj_pending_engine_stamp';

/**
 * Validates that a raw localStorage value names an engine that may drive the
 * Claude body (shared/engineProviders.ts). Returns null for anything else.
 *
 * B-218 — this gate is the ENGINE axis, never the BODY axis. It used to run the
 * stored stamp through `isProviderGloballyDisabled`, so the moment `glm` was
 * disabled as an agent SYSTEM (the 2026-07-26 fold into OpenCode, 4aac5467)
 * every session stamped `glm` read back as null — and null means "official
 * Anthropic". The chat kept showing Claude while the payload the user had
 * pinned to z.ai went to Anthropic instead, with no notice anywhere. A body
 * being unavailable says nothing about whether its endpoint is a legal engine
 * (ADR-073), so eligibility now comes from its own declaration.
 */
export function sanitizeEngineProviderValue(stored: string | null): EngineProvider {
  return stored && isEngineProviderEligible(stored) ? (stored as VendorProvider) : null;
}

function sessionEngineProviderKey(sessionId: string): string {
  return `${ENGINE_PROVIDER_STORAGE_KEY}-${sessionId}`;
}

// ─── Slot 1: global key ────────────────────────────────────────────────────

/**
 * Reads the GLOBAL engine-provider key (the user's current picker choice).
 * Used only at app boot to initialise React state. Do NOT read this at
 * session_created time — use consumePendingEngineStamp() instead (T-915).
 */
export function readStoredEngineProvider(): EngineProvider {
  return sanitizeEngineProviderValue(localStorage.getItem(ENGINE_PROVIDER_STORAGE_KEY));
}

// ─── Slot 2: per-session stamp ─────────────────────────────────────────────

/**
 * Reads the engine provider stamped onto a specific session (T-915). Unlike
 * readStoredEngineProvider() above, this NEVER falls back to the global
 * preference: a session with no stamp of its own (created before this feature,
 * or created on the official-Anthropic path) returns null.
 *
 * This is the fail-safe that prevents a "Claude via Kimi" choice made for an
 * unrelated new chat from leaking into an existing session whose React state
 * was reset to null when the user navigated to it.
 */
export function readSessionEngineProvider(sessionId: string): EngineProvider {
  return sanitizeEngineProviderValue(localStorage.getItem(sessionEngineProviderKey(sessionId)));
}

/**
 * Writes the engine provider that was active when a session was CREATED onto
 * that session's own localStorage key, mirroring the permissionMode-${sessionId}
 * pattern. Passing null removes the key (no entry = official-Anthropic default).
 */
export function stampSessionEngineProvider(sessionId: string, value: EngineProvider): void {
  const key = sessionEngineProviderKey(sessionId);
  if (value) {
    localStorage.setItem(key, value);
  } else {
    localStorage.removeItem(key);
  }
}

// ─── Slot 3: pending one-shot stamp (T-915 fix) ─────────────────────────────

/**
 * Records the engine provider that is ABOUT TO BE SENT in a brand-new
 * claude-command (resume=false). Must be called by dispatchProviderCommand
 * just before sendMessage() so that the session_created handler can consume
 * it instead of reading the (potentially stale) global key.
 *
 * Uses sessionStorage so:
 *   • it is tab-scoped (no cross-tab pollution), and
 *   • it is automatically cleared when the tab closes.
 */
export function writePendingEngineStamp(value: EngineProvider): void {
  if (value) {
    sessionStorage.setItem(PENDING_ENGINE_STAMP_KEY, value);
  } else {
    sessionStorage.removeItem(PENDING_ENGINE_STAMP_KEY);
  }
}

/**
 * Reads and immediately clears the pending engine stamp. Called once by the
 * session_created handler at the moment a new session id is announced by the
 * server, so the stamp is consumed at most once per session.
 *
 * Returns null when no stamp was written (official-Anthropic path) or when
 * the stored value fails validation (stale / disabled vendor).
 */
export function consumePendingEngineStamp(): EngineProvider {
  const val = sessionStorage.getItem(PENDING_ENGINE_STAMP_KEY);
  sessionStorage.removeItem(PENDING_ENGINE_STAMP_KEY);
  return sanitizeEngineProviderValue(val);
}
