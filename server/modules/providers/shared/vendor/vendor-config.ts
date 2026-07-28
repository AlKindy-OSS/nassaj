import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';

import type { VendorTextualToolCall } from './vendor-sessions.provider.js';

/**
 * Single source of truth for the three hosted vendor providers' static runtime
 * config: the hard-coded base URL, the derived endpoints, the env var their HTTP
 * client reads, and the conservative fallback model catalog.
 *
 * BASE URLs ARE HARD-CODED HERE, NOT READ FROM ENV. This is deliberate and is
 * part of the iron-rule boundary: the only per-user value that ever flows from
 * config is the API key (injected by resolveProviderEnv as KIMI_API_KEY /
 * DEEPSEEK_API_KEY / GLM_API_KEY). No base URL is overridable, and none of these
 * values live under the ANTHROPIC/CLAUDE namespace.
 *
 * Model ids track the providers' current generation at authoring time; they are
 * only a fallback — the live `/v1/models` catalog is authoritative when reachable
 * (see VendorCatalogClient), so a newer id (e.g. a promoted code model) surfaces
 * automatically without a code change.
 */

export type VendorRuntimeConfig = {
  provider: LLMProvider;
  /** Anthropic-compatible base, ending in `/anthropic`. */
  baseUrl: string;
  /** `<baseUrl>/v1/messages` — the chat/stream endpoint the seam POSTs to. */
  messagesUrl: string;
  /** `<baseUrl>/v1/models` — the live catalog endpoint. */
  modelsUrl: string;
  /** Env var holding the API key (provider-specific, never ANTHROPIC_*). */
  keyEnv: string;
  /** Conservative built-in catalog used when the live fetch is unavailable. */
  fallbackModels: ProviderModelsDefinition;
};

const KIMI_BASE = 'https://api.moonshot.ai/anthropic';
const DEEPSEEK_BASE = 'https://api.deepseek.com/anthropic';
const GLM_BASE = 'https://api.z.ai/api/anthropic';
/**
 * z.ai's OpenAI-compatible coding-plan endpoint — the CARRIER wire (see
 * GLM_CARRIER_BASE_URL below). Same HOST as GLM_BASE, different path: the chat seam
 * speaks the Anthropic wire, the opencode carrier speaks the OpenAI wire.
 */
const GLM_CARRIER_BASE = 'https://api.z.ai/api/coding/paas/v4';

export const KIMI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'kimi-k2.6', label: 'Kimi K2.6', description: 'Moonshot Kimi K2.6 (256K context)' },
    { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'Moonshot Kimi K2.7 Code' },
  ],
  DEFAULT: 'kimi-k2.6',
};

export const DEEPSEEK_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'DeepSeek V4 Pro (1M context)' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'DeepSeek V4 Flash (1M context)' },
  ],
  DEFAULT: 'deepseek-v4-pro',
};

/**
 * B-220 (2026-07-27): `glm-5.2[1m]` was DELETED, not corrected. It is not a wire model
 * id — z.ai answers `1211 Unknown Model` for it. The bracketed suffix is opencode's own
 * variant notation, never part of a vendor id, and `glm-5.2` is already a 1M-context
 * model, so the entry advertised a model that does not exist on either the chat wire or
 * the carrier wire.
 */
export const GLM_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'glm-5.2', label: 'GLM 5.2', description: 'Zhipu/Z.ai GLM 5.2' },
  ],
  DEFAULT: 'glm-5.2',
};

export const VENDOR_RUNTIME: Record<'kimi' | 'deepseek' | 'glm', VendorRuntimeConfig> = {
  kimi: {
    provider: 'kimi',
    baseUrl: KIMI_BASE,
    messagesUrl: `${KIMI_BASE}/v1/messages`,
    modelsUrl: `${KIMI_BASE}/v1/models`,
    keyEnv: 'KIMI_API_KEY',
    fallbackModels: KIMI_FALLBACK_MODELS,
  },
  deepseek: {
    provider: 'deepseek',
    baseUrl: DEEPSEEK_BASE,
    messagesUrl: `${DEEPSEEK_BASE}/v1/messages`,
    modelsUrl: `${DEEPSEEK_BASE}/v1/models`,
    keyEnv: 'DEEPSEEK_API_KEY',
    fallbackModels: DEEPSEEK_FALLBACK_MODELS,
  },
  glm: {
    provider: 'glm',
    baseUrl: GLM_BASE,
    messagesUrl: `${GLM_BASE}/v1/messages`,
    modelsUrl: `${GLM_BASE}/v1/models`,
    keyEnv: 'GLM_API_KEY',
    fallbackModels: GLM_FALLBACK_MODELS,
  },
};

// ---------------------------------------------------------------------------
// Governed CLI agent catalogs (ADR-062) — ADDITIVE, separate from the chat-path
// exports above. VENDOR_RUNTIME / KIMI_FALLBACK_MODELS / GLM_FALLBACK_MODELS stay
// byte-for-byte unchanged so the live toolless chat seam (vendor-runtime.js) is
// untouched. These new exports serve the agent/carrier paths only.
// ---------------------------------------------------------------------------

/**
 * baseURL for the GLM OpenCode carrier (GL-2): z.ai's OpenAI-compatible coding-plan
 * endpoint. Exported under a carrier name so the governed opencode.json material
 * (opencode-config-material.js) and the GL-3 baseURL allowlist guard share ONE constant.
 * Hard-coded here, never from env (iron-rule boundary): only the per-user API key ever
 * flows from config, into auth.json — never a base URL.
 *
 * IT NO LONGER EQUALS GLM_BASE (changed 2026-07-27, B-221). The carrier's SDK moved from
 * `@ai-sdk/anthropic` to `@ai-sdk/openai-compatible` because opencode 1.17.18 cannot
 * drive the former (it never issues the request — see OPENCODE_GLM_NPM in
 * opencode-config-material.js for the proof), and the wire path has to follow the SDK:
 *   chat    → GLM_BASE          = https://api.z.ai/api/anthropic       (Anthropic wire)
 *   carrier → GLM_CARRIER_BASE  = https://api.z.ai/api/coding/paas/v4  (OpenAI wire)
 * The security property is UNCHANGED because it was always host-scoped, not path-scoped:
 * GL-3's ALLOWED_CARRIER_HOST is hostOf(this constant) = `api.z.ai` = the host of
 * GLM_BASE. The carrier still cannot point at a host the vetted chat path did not use,
 * and the guard was not widened to admit this value.
 */
export const GLM_CARRIER_BASE_URL: string = GLM_CARRIER_BASE;

/**
 * Model catalog for the GLM carrier, shaped for the opencode.json
 * `provider.glm.models` block (a record keyed by model id). Derived from
 * GLM_FALLBACK_MODELS so the carrier and the chat path enumerate the SAME models from
 * ONE source; opencode's live catalog stays authoritative at runtime.
 */
export const GLM_CARRIER_MODELS: Record<string, { name: string }> = Object.fromEntries(
  GLM_FALLBACK_MODELS.OPTIONS.map((m) => [m.value, { name: m.label }]),
);

/**
 * Kimi agent (native `@moonshot-ai/kimi-code` CLI) model catalog. The agent path
 * reuses the SAME conservative catalog as the chat path (ADR-062 §4.6 M-1 — one source
 * of truth), exported under an agent-scoped name so KM-4 can import it without
 * depending on the chat-path symbol. The live `/v1/models` catalog stays authoritative.
 */
export const KIMI_AGENT_MODELS: ProviderModelsDefinition = KIMI_FALLBACK_MODELS;

/**
 * DeepSeek quirk: ~11% of tool calls can arrive as plain assistant text that is
 * really a JSON tool_call object. This best-effort extractor recognizes a JSON
 * payload shaped like `{ "name": "...", "arguments"|"input": {...} }` (optionally
 * wrapped in a ```json fence or a <tool_call> tag) and converts it to a tool_use
 * descriptor. Anything that does not clearly look like a tool call is left as
 * ordinary text (returns null), so normal prose is never misclassified.
 */
export function extractDeepSeekTextualToolCall(text: string): VendorTextualToolCall | null {
  const trimmed = text.trim();
  if (!trimmed.includes('"name"') || (!trimmed.includes('"arguments"') && !trimmed.includes('"input"'))) {
    return null;
  }

  const candidate = unwrapToolCallCandidate(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const toolName = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null;
  if (!toolName) {
    return null;
  }

  const toolInput = record.arguments ?? record.input ?? {};
  const toolId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
  return { toolName, toolInput, toolId };
}

/** Strips a ```json fence or <tool_call> wrapper, returning the inner JSON text. */
function unwrapToolCallCandidate(text: string): string {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  const tagMatch = /<tool_call>\s*([\s\S]*?)<\/tool_call>/.exec(text);
  if (tagMatch?.[1]) {
    return tagMatch[1].trim();
  }
  return text;
}
