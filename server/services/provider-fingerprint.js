/**
 * provider-fingerprint — derives the ANSWERING provider of an assistant turn
 * from the response's own wire identity (T-1144, user request 2026-07-31:
 * "the model name shown must come from the provider's fingerprint").
 *
 * WHY the model id string alone is not enough: a vendor could one day serve
 * aliased `claude-*` ids, and a silently-fallen-back turn records whatever the
 * responder reported. The response ENVELOPE is the stronger evidence:
 *
 *   - Anthropic messages carry `id: "msg_…"` and the transcript entry carries
 *     `requestId: "req_…"` — both absent on vendor wire responses.
 *   - Anthropic-compatible vendor endpoints (Moonshot, z.ai, DeepSeek) answer
 *     with OpenAI-style `id: "chatcmpl-…"` and NO requestId. The envelope
 *     alone cannot tell those vendors apart, so the model id disambiguates
 *     via the measured fallback catalogs (vendor-config.ts) — a catalog hit
 *     names the vendor, a miss degrades to the generic 'openai-compatible'
 *     rather than guessing.
 *
 * Everything here is measured from production-shaped synthetic transcripts, not invented:
 *   43b0dc60 (2026-07-31): kimi-k3 turns → `chatcmpl-6a6c…`, no requestId;
 *                          claude-opus-5 turns → `msg_011Cd…` + `req_011Cd…`.
 *
 * @typedef {'anthropic'|'moonshot'|'zai'|'deepseek'|'openai-compatible'|'unknown'} ResponseProvider
 */

import {
  DEEPSEEK_FALLBACK_MODELS,
  GLM_FALLBACK_MODELS,
  KIMI_FALLBACK_MODELS,
} from '../modules/providers/shared/vendor/vendor-config.js';

const VENDOR_BY_MODEL = new Map();
for (const [provider, catalog] of /** @type {const} */ ([
  ['moonshot', KIMI_FALLBACK_MODELS],
  ['zai', GLM_FALLBACK_MODELS],
  ['deepseek', DEEPSEEK_FALLBACK_MODELS],
])) {
  for (const option of catalog.OPTIONS) {
    VENDOR_BY_MODEL.set(option.value, provider);
  }
}

/** Display names for UI labels (proper nouns — deliberately NOT i18n keys). */
export const PROVIDER_DISPLAY_NAME = Object.freeze({
  anthropic: 'Anthropic',
  moonshot: 'Moonshot',
  zai: 'Z.AI',
  deepseek: 'DeepSeek',
  'openai-compatible': 'OpenAI-compatible',
  unknown: 'Unknown',
});

/**
 * Fingerprints one assistant transcript entry.
 *
 * @param {object} input
 * @param {string|null} [input.messageId]  message.id of the response
 * @param {string|null} [input.requestId]  transcript entry's requestId
 * @param {string|null} [input.modelId]    message.model (vendor disambiguation only)
 * @returns {ResponseProvider}
 */
export function fingerprintResponseProvider({ messageId, requestId, modelId }) {
  const id = typeof messageId === 'string' ? messageId : '';
  const req = typeof requestId === 'string' ? requestId : '';

  // Anthropic: msg_ id, corroborated by a req_ requestId. The msg_ prefix
  // alone is treated as sufficient when requestId is missing (older CLI
  // versions did not record it) — no vendor answers with msg_* ids.
  if (id.startsWith('msg_') || req.startsWith('req_')) {
    return 'anthropic';
  }

  // OpenAI-style envelope: an Anthropic-compatible vendor. Name it from the
  // model id when the id is in a measured vendor catalog, else stay generic —
  // never guess a vendor the evidence does not support.
  if (id.startsWith('chatcmpl-')) {
    const model = typeof modelId === 'string' ? modelId.trim() : '';
    return VENDOR_BY_MODEL.get(model) ?? 'openai-compatible';
  }

  return 'unknown';
}
