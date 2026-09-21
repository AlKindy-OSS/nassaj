/**
 * deepseek-cli — DeepSeek run seam.
 *
 * Thin binding over the shared vendor runtime (independent HTTP client, no
 * @anthropic-ai SDK, no claude-sdk.js). The per-user key is injected by
 * resolveProviderEnv; the base URL is hard-coded in vendor-config.ts. DeepSeek's
 * textual-tool-call quirk is handled in its sessions facet, which the runtime
 * invokes for normalization.
 */

import {
  abortVendorSession,
  createVendorSpawn,
  getActiveVendorSessions,
  isVendorSessionActive,
} from './modules/providers/shared/vendor/vendor-runtime.js';

const spawnDeepSeek = createVendorSpawn('deepseek');

function abortDeepSeekSession(sessionId) {
  return abortVendorSession('deepseek', sessionId);
}

function isDeepSeekSessionActive(sessionId) {
  return isVendorSessionActive('deepseek', sessionId);
}

function getActiveDeepSeekSessions() {
  return getActiveVendorSessions('deepseek');
}

export { spawnDeepSeek, abortDeepSeekSession, isDeepSeekSessionActive, getActiveDeepSeekSessions };
