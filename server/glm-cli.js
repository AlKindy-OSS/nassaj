/**
 * glm-cli — GLM (Zhipu / Z.ai) run seam.
 *
 * Thin binding over the shared vendor runtime (independent HTTP client, no
 * @anthropic-ai SDK, no claude-sdk.js). The per-user key is injected by
 * resolveProviderEnv; the base URL is hard-coded in vendor-config.ts. GLM's long
 * streams are recorded per-event to the JSONL transcript so history never drops
 * messages even if the live stream is interrupted.
 */

import {
  abortVendorSession,
  createVendorSpawn,
  getActiveVendorSessions,
  isVendorSessionActive,
} from './modules/providers/shared/vendor/vendor-runtime.js';

const spawnGlm = createVendorSpawn('glm');

function abortGlmSession(sessionId) {
  return abortVendorSession('glm', sessionId);
}

function isGlmSessionActive(sessionId) {
  return isVendorSessionActive('glm', sessionId);
}

function getActiveGlmSessions() {
  return getActiveVendorSessions('glm');
}

export { spawnGlm, abortGlmSession, isGlmSessionActive, getActiveGlmSessions };
