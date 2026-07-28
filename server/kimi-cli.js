/**
 * kimi-cli — Kimi (Moonshot) run seam.
 *
 * A thin binding over the shared vendor runtime (independent HTTP client, no
 * @anthropic-ai SDK, no claude-sdk.js). The per-user key is injected by
 * resolveProviderEnv inside the runtime; the base URL is hard-coded in
 * vendor-config.ts. Exposes the same surface as the CLI providers so index.js and
 * the chat dispatcher can treat it uniformly.
 */

import {
  abortVendorSession,
  createVendorSpawn,
  getActiveVendorSessions,
  isVendorSessionActive,
} from './modules/providers/shared/vendor/vendor-runtime.js';

const spawnKimi = createVendorSpawn('kimi');

function abortKimiSession(sessionId) {
  return abortVendorSession('kimi', sessionId);
}

function isKimiSessionActive(sessionId) {
  return isVendorSessionActive('kimi', sessionId);
}

function getActiveKimiSessions() {
  return getActiveVendorSessions('kimi');
}

export { spawnKimi, abortKimiSession, isKimiSessionActive, getActiveKimiSessions };
