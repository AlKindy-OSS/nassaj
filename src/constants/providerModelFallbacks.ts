/**
 * Client-side fallback model catalog.
 *
 * This is the client source of truth used when the live model catalog fails to
 * load from `/api/providers/:provider/models` (network error, single provider
 * returning an error, etc.).
 *
 * Source of truth to mirror: the per-provider server modules, which are what the
 * live `/api/providers/:provider/models` endpoint actually serves:
 *   - claude:      `server/modules/providers/list/claude/claude-models.provider.ts`
 *   - cursor:      `server/modules/providers/list/cursor/cursor-models.provider.ts`
 *   - codex:       `server/modules/providers/list/codex/codex-models.provider.ts`
 *   - antigravity: `server/modules/providers/list/antigravity/antigravity-models.provider.ts`
 *   - opencode:    `server/modules/providers/list/opencode/opencode-models.provider.ts`
 * (NOT `public/modelConstants.js`, which is static documentation and is never
 * imported by client code.)
 *
 * Keeping a typed copy inside `src/` lets the self-sanitizer
 * (`pickStoredOrCurrent`) and the initial localStorage read always run against a
 * known-good option list, so a stale value such as `"auto"` or `"opus"` can
 * never leak through to the server while the async catalog is still loading or
 * after it has failed.
 *
 * Keep the `DEFAULT` of each provider in sync with the matching server provider
 * module. The Claude default is `"default"` (NOT `"opus"`).
 *
 * The type-only import below uses an explicit `.js` extension and the per-option
 * parameter is annotated with `ProviderModelOption` so this file stays
 * importable from a NodeNext server-build context (e.g. a future server-side
 * drift-guard test that imports the client catalog).
 */
import type { ActiveBodyProvider, LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../types/app.js';
// Explicit .js extension: keeps this file importable from a NodeNext
// server-build context (see the file header note).
import { isProviderGloballyDisabled } from '../../shared/disabledProviders.js';

// Mirror of the server's claude degraded-fallback catalog
// (server/modules/providers/list/claude/claude-models.provider.ts →
// CLAUDE_FALLBACK_MODELS). The live catalog now comes from the installed Claude
// Code via the server's getClaudeModelCatalog(); this client copy is only the
// last-resort safety net used when /api/providers/claude/models cannot load.
// Keep it byte-for-byte aligned with the server fallback (values + DEFAULT).
// `claude-fable-5` is intentionally omitted here too: it is advertised by the
// CLI but not released by Anthropic (hidden in claude-catalog.client.ts). A
// server-side drift-guard test asserts these option values + DEFAULT match.
export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the default model (currently Opus 5.5 (1M context)) · Most capable for complex work',
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Sonnet 5 · Best for everyday tasks',
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet 5 with 1M context · Requires 1M-context access · draws from usage credits',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers',
    },
    {
      value: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'Opus 5.5 · Latest, most capable Opus for complex work',
    },
  ],
  DEFAULT: 'default',
};

// Mirror of the server's codex degraded-fallback catalog
// (server/modules/providers/list/codex/codex-models.provider.ts →
// CODEX_FALLBACK_MODELS), snapshotted from the locally installed `codex` CLI's
// own live catalog (~/.codex/models_cache.json, client_version 0.156.0).
export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { value: 'gpt-6-sol', label: 'gpt-6-sol' },
    { value: 'gpt-6-luna', label: 'gpt-6-luna' },
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
    { value: 'gpt-5.5', label: 'gpt-5.5' },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    // Snapshot of `agy models` (agy 1.1.9, 2026-08-01) — keep in sync with
    // server/modules/providers/list/antigravity/antigravity-models.provider.ts.
    { value: 'auto', label: 'agy default' },
    { value: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' },
    { value: 'gemini-3.6-flash-medium', label: 'gemini-3.6-flash-medium' },
    { value: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low' },
    { value: 'gemini-3.5-flash-high', label: 'gemini-3.5-flash-high' },
    { value: 'gemini-3.5-flash-medium', label: 'gemini-3.5-flash-medium' },
    { value: 'gemini-3.5-flash-low', label: 'gemini-3.5-flash-low' },
    { value: 'gemini-3.1-pro-high', label: 'gemini-3.1-pro-high' },
    { value: 'gemini-3.1-pro-low', label: 'gemini-3.1-pro-low' },
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { value: 'claude-opus-4-6-thinking', label: 'claude-opus-4-6-thinking' },
    { value: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium' },
  ],
  DEFAULT: 'auto',
};

export const OPENCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      description: 'anthropic - anthropic/claude-sonnet-4-5',
    },
    {
      value: 'anthropic/claude-opus-4-1',
      label: 'Claude Opus 4.1',
      description: 'anthropic - anthropic/claude-opus-4-1',
    },
    {
      value: 'anthropic/claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      description: 'anthropic - anthropic/claude-haiku-4-5',
    },
    {
      value: 'openai/gpt-5.1',
      label: 'GPT-5.1',
      description: 'openai - openai/gpt-5.1',
    },
    {
      value: 'openai/gpt-5.1-codex',
      label: 'GPT-5.1 Codex',
      description: 'openai - openai/gpt-5.1-codex',
    },
    {
      value: 'openai/gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'openai - openai/gpt-5.4-mini',
    },
    {
      value: 'google/gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      description: 'google - google/gemini-2.5-pro',
    },
    {
      value: 'google/gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      description: 'google - google/gemini-2.5-flash',
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
};

/**
 * Hosted vendor providers (Kimi / DeepSeek / GLM). The authoritative catalog is
 * the live /v1/models probe; these single-entry fallbacks only seed the degraded
 * picker with each vendor's default model (mirrors VENDOR_PROVIDER_META and the
 * backend <ID>_FALLBACK_MODELS.DEFAULT in shared/vendor/vendor-config.ts).
 */
export const KIMI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'kimi-k2.6', label: 'Kimi K2.6', description: 'Moonshot Kimi · kimi-k2.6' },
    { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'Moonshot Kimi · kimi-k2.7-code' },
    { value: 'kimi-k3', label: 'Kimi K3', description: 'Moonshot Kimi · kimi-k3' },
  ],
  DEFAULT: 'kimi-k2.6',
};

export const DEEPSEEK_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'DeepSeek · deepseek-v4-pro' },
  ],
  DEFAULT: 'deepseek-v4-pro',
};

export const GLM_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'glm-5.2', label: 'GLM 5.2', description: 'Zhipu / Z.ai · glm-5.2' },
  ],
  DEFAULT: 'glm-5.2',
};

// Minimal placeholder catalog for providers declared in the LLMProvider union
// that do not yet expose a live model list. `auto` keeps the picker valid until
// a real catalog (live or fallback) is wired.
export const PLACEHOLDER_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'auto', label: 'Default' }],
  DEFAULT: 'auto',
};

/**
 * Bodies that still have a static fallback catalog here (T-1953): every active
 * body, plus `kimi` — retired as a body but still the id this file's callers
 * key the Claude ENGINE catalog by (`useChatProviderState`'s `kimiModel` slot,
 * `claudeSlotCatalogProvider`). `deepseek`/`glm` are already in
 * `ActiveBodyProvider`. `cursor`/`hermes`/`qwen` had no engine meaning and are
 * dropped outright; a historical session of theirs never reaches this catalog
 * (it opens read-only with its own stored model, not a fresh picker pick).
 */
export type FallbackCatalogProvider = ActiveBodyProvider | 'kimi';

export const PROVIDER_FALLBACK_MODELS: Record<FallbackCatalogProvider, ProviderModelsDefinition> = {
  claude: CLAUDE_FALLBACK_MODELS,
  codex: CODEX_FALLBACK_MODELS,
  antigravity: ANTIGRAVITY_FALLBACK_MODELS,
  opencode: OPENCODE_FALLBACK_MODELS,
  kimi: KIMI_FALLBACK_MODELS,
  deepseek: DEEPSEEK_FALLBACK_MODELS,
  glm: GLM_FALLBACK_MODELS,
  sakana: PLACEHOLDER_FALLBACK_MODELS,
};

/**
 * Per-provider default model id, derived from the fallback catalog so it can
 * never drift from a valid option (the previous hard-coded `claude: 'opus'`
 * was not a valid Claude value and produced a stuck/invalid model).
 */
export const FALLBACK_DEFAULT_MODEL: Record<FallbackCatalogProvider, string> = {
  claude: CLAUDE_FALLBACK_MODELS.DEFAULT,
  codex: CODEX_FALLBACK_MODELS.DEFAULT,
  antigravity: ANTIGRAVITY_FALLBACK_MODELS.DEFAULT,
  opencode: OPENCODE_FALLBACK_MODELS.DEFAULT,
  kimi: KIMI_FALLBACK_MODELS.DEFAULT,
  deepseek: DEEPSEEK_FALLBACK_MODELS.DEFAULT,
  glm: GLM_FALLBACK_MODELS.DEFAULT,
  sakana: PLACEHOLDER_FALLBACK_MODELS.DEFAULT,
};

/**
 * Returns a stored model id only when it is a known-valid option for the given
 * provider's fallback catalog; otherwise returns the provider default. Used for
 * the synchronous initial localStorage read so a stale value cannot leak before
 * the async catalog normalization runs (first-render race).
 */
export function sanitizeStoredModel(provider: FallbackCatalogProvider, stored: string | null): string {
  const def = PROVIDER_FALLBACK_MODELS[provider];
  if (stored && def.OPTIONS.some((option: ProviderModelOption) => option.value === stored)) {
    return stored;
  }
  return def.DEFAULT;
}

/**
 * The default active provider. `claude` is always a valid, authenticated-or-not
 * escape provider and never locks the picker.
 */
export const DEFAULT_PROVIDER: LLMProvider = 'claude';

/**
 * Validates the persisted `selected-provider` value against the known provider
 * list, falling back to {@link DEFAULT_PROVIDER}. A corrupt or unknown stored
 * provider must never be cast straight into app state — that is how the UI could
 * land on a provider with no usable picker affordance and get stuck.
 */
export function sanitizeStoredProvider(stored: string | null): LLMProvider {
  if (
    stored &&
    Object.prototype.hasOwnProperty.call(PROVIDER_FALLBACK_MODELS, stored) &&
    // A persisted selection of a globally disabled provider (T-864) must not
    // revive it — it has no picker affordance anymore and the server refuses
    // to dispatch it; fall back to the default provider instead.
    !isProviderGloballyDisabled(stored)
  ) {
    return stored as LLMProvider;
  }
  return DEFAULT_PROVIDER;
}
