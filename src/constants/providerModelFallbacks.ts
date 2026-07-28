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
 *   - gemini:      `server/modules/providers/list/gemini/gemini-models.provider.ts`
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
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../types/app.js';
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
      description: 'Use the default model (currently Opus 4.7 (1M context)) · Most capable for complex work',
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Sonnet 4.6 · Best for everyday tasks · $3/$15 per Mtok',
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet 4.6 with 1M context · Requires 1M-context access · draws from usage credits · $3/$15 per Mtok',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok',
    },
    {
      value: 'claude-opus-4-8',
      label: 'Opus 4.8',
      description: 'Opus 4.8 · Latest, most capable Opus for complex work',
    },
  ],
  DEFAULT: 'default',
};

export const CURSOR_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: "auto",
      label: "auto",
      description: "Auto",
    },
    {
      value: "composer-2-fast",
      label: "composer-2-fast",
      description: "Composer 2 Fast",
    },
    {
      value: "composer-2",
      label: "composer-2",
      description: "Composer 2",
    },
    {
      value: "gpt-5.3-codex-low",
      label: "gpt-5.3-codex-low",
      description: "Codex 5.3 Low",
    },
    {
      value: "gpt-5.3-codex-low-fast",
      label: "gpt-5.3-codex-low-fast",
      description: "Codex 5.3 Low Fast",
    },
    {
      value: "gpt-5.3-codex",
      label: "gpt-5.3-codex",
      description: "Codex 5.3",
    },
    {
      value: "gpt-5.3-codex-fast",
      label: "gpt-5.3-codex-fast",
      description: "Codex 5.3 Fast",
    },
    {
      value: "gpt-5.3-codex-high",
      label: "gpt-5.3-codex-high",
      description: "Codex 5.3 High",
    },
    {
      value: "gpt-5.3-codex-high-fast",
      label: "gpt-5.3-codex-high-fast",
      description: "Codex 5.3 High Fast",
    },
    {
      value: "gpt-5.3-codex-xhigh",
      label: "gpt-5.3-codex-xhigh",
      description: "Codex 5.3 Extra High",
    },
    {
      value: "gpt-5.3-codex-xhigh-fast",
      label: "gpt-5.3-codex-xhigh-fast",
      description: "Codex 5.3 Extra High Fast",
    },
    {
      value: "gpt-5.2",
      label: "gpt-5.2",
      description: "GPT-5.2",
    },
    {
      value: "gpt-5.2-codex-low",
      label: "gpt-5.2-codex-low",
      description: "Codex 5.2 Low",
    },
    {
      value: "gpt-5.2-codex-low-fast",
      label: "gpt-5.2-codex-low-fast",
      description: "Codex 5.2 Low Fast",
    },
    {
      value: "gpt-5.2-codex",
      label: "gpt-5.2-codex",
      description: "Codex 5.2",
    },
    {
      value: "gpt-5.2-codex-fast",
      label: "gpt-5.2-codex-fast",
      description: "Codex 5.2 Fast",
    },
    {
      value: "gpt-5.2-codex-high",
      label: "gpt-5.2-codex-high",
      description: "Codex 5.2 High",
    },
    {
      value: "gpt-5.2-codex-high-fast",
      label: "gpt-5.2-codex-high-fast",
      description: "Codex 5.2 High Fast",
    },
    {
      value: "gpt-5.2-codex-xhigh",
      label: "gpt-5.2-codex-xhigh",
      description: "Codex 5.2 Extra High",
    },
    {
      value: "gpt-5.2-codex-xhigh-fast",
      label: "gpt-5.2-codex-xhigh-fast",
      description: "Codex 5.2 Extra High Fast",
    },
    {
      value: "gpt-5.1-codex-max-low",
      label: "gpt-5.1-codex-max-low",
      description: "Codex 5.1 Max Low",
    },
    {
      value: "gpt-5.1-codex-max-low-fast",
      label: "gpt-5.1-codex-max-low-fast",
      description: "Codex 5.1 Max Low Fast",
    },
    {
      value: "gpt-5.1-codex-max-medium",
      label: "gpt-5.1-codex-max-medium",
      description: "Codex 5.1 Max",
    },
    {
      value: "gpt-5.1-codex-max-medium-fast",
      label: "gpt-5.1-codex-max-medium-fast",
      description: "Codex 5.1 Max Medium Fast",
    },
    {
      value: "gpt-5.1-codex-max-high",
      label: "gpt-5.1-codex-max-high",
      description: "Codex 5.1 Max High",
    },
    {
      value: "gpt-5.1-codex-max-high-fast",
      label: "gpt-5.1-codex-max-high-fast",
      description: "Codex 5.1 Max High Fast",
    },
    {
      value: "gpt-5.1-codex-max-xhigh",
      label: "gpt-5.1-codex-max-xhigh",
      description: "Codex 5.1 Max Extra High",
    },
    {
      value: "gpt-5.1-codex-max-xhigh-fast",
      label: "gpt-5.1-codex-max-xhigh-fast",
      description: "Codex 5.1 Max Extra High Fast",
    },
    {
      value: "composer-2.5",
      label: "composer-2.5",
      description: "Composer 2.5",
    },
    {
      value: "gpt-5.5-high",
      label: "gpt-5.5-high",
      description: "GPT-5.5 1M High",
    },
    {
      value: "gpt-5.5-high-fast",
      label: "gpt-5.5-high-fast",
      description: "GPT-5.5 High Fast",
    },
    {
      value: "claude-opus-4-7-thinking-high",
      label: "claude-opus-4-7-thinking-high",
      description: "Opus 4.7 1M High Thinking",
    },
    {
      value: "gpt-5.4-high",
      label: "gpt-5.4-high",
      description: "GPT-5.4 1M High",
    },
    {
      value: "gpt-5.4-high-fast",
      label: "gpt-5.4-high-fast",
      description: "GPT-5.4 High Fast",
    },
    {
      value: "claude-4.6-opus-high-thinking",
      label: "claude-4.6-opus-high-thinking",
      description: "Opus 4.6 1M Thinking",
    },
    {
      value: "claude-4.6-opus-high-thinking-fast",
      label: "claude-4.6-opus-high-thinking-fast",
      description: "Opus 4.6 1M Thinking Fast",
    },
    {
      value: "composer-2.5-fast",
      label: "composer-2.5-fast",
      description: "Composer 2.5 Fast",
    },
    {
      value: "gpt-5.5-none",
      label: "gpt-5.5-none",
      description: "GPT-5.5 1M None",
    },
    {
      value: "gpt-5.5-none-fast",
      label: "gpt-5.5-none-fast",
      description: "GPT-5.5 None Fast",
    },
    {
      value: "gpt-5.5-low",
      label: "gpt-5.5-low",
      description: "GPT-5.5 1M Low",
    },
    {
      value: "gpt-5.5-low-fast",
      label: "gpt-5.5-low-fast",
      description: "GPT-5.5 Low Fast",
    },
    {
      value: "gpt-5.5-medium",
      label: "gpt-5.5-medium",
      description: "GPT-5.5 1M",
    },
    {
      value: "gpt-5.5-medium-fast",
      label: "gpt-5.5-medium-fast",
      description: "GPT-5.5 Fast",
    },
    {
      value: "gpt-5.5-extra-high",
      label: "gpt-5.5-extra-high",
      description: "GPT-5.5 1M Extra High",
    },
    {
      value: "gpt-5.5-extra-high-fast",
      label: "gpt-5.5-extra-high-fast",
      description: "GPT-5.5 Extra High Fast",
    },
    {
      value: "claude-4.6-sonnet-medium",
      label: "claude-4.6-sonnet-medium",
      description: "Sonnet 4.6 1M",
    },
    {
      value: "claude-4.6-sonnet-medium-thinking",
      label: "claude-4.6-sonnet-medium-thinking",
      description: "Sonnet 4.6 1M Thinking",
    },
    {
      value: "claude-opus-4-7-low",
      label: "claude-opus-4-7-low",
      description: "Opus 4.7 1M Low",
    },
    {
      value: "claude-opus-4-7-low-fast",
      label: "claude-opus-4-7-low-fast",
      description: "Opus 4.7 1M Low Fast",
    },
    {
      value: "claude-opus-4-7-medium",
      label: "claude-opus-4-7-medium",
      description: "Opus 4.7 1M Medium",
    },
    {
      value: "claude-opus-4-7-medium-fast",
      label: "claude-opus-4-7-medium-fast",
      description: "Opus 4.7 1M Medium Fast",
    },
    {
      value: "claude-opus-4-7-high",
      label: "claude-opus-4-7-high",
      description: "Opus 4.7 1M High",
    },
    {
      value: "claude-opus-4-7-high-fast",
      label: "claude-opus-4-7-high-fast",
      description: "Opus 4.7 1M High Fast",
    },
    {
      value: "claude-opus-4-7-xhigh",
      label: "claude-opus-4-7-xhigh",
      description: "Opus 4.7 1M",
    },
    {
      value: "claude-opus-4-7-xhigh-fast",
      label: "claude-opus-4-7-xhigh-fast",
      description: "Opus 4.7 1M Fast",
    },
    {
      value: "claude-opus-4-7-max",
      label: "claude-opus-4-7-max",
      description: "Opus 4.7 1M Max",
    },
    {
      value: "claude-opus-4-7-max-fast",
      label: "claude-opus-4-7-max-fast",
      description: "Opus 4.7 1M Max Fast",
    },
    {
      value: "claude-opus-4-7-thinking-low",
      label: "claude-opus-4-7-thinking-low",
      description: "Opus 4.7 1M Low Thinking",
    },
    {
      value: "claude-opus-4-7-thinking-low-fast",
      label: "claude-opus-4-7-thinking-low-fast",
      description: "Opus 4.7 1M Low Thinking Fast",
    },
    {
      value: "claude-opus-4-7-thinking-medium",
      label: "claude-opus-4-7-thinking-medium",
      description: "Opus 4.7 1M Medium Thinking",
    },
    {
      value: "claude-opus-4-7-thinking-medium-fast",
      label: "claude-opus-4-7-thinking-medium-fast",
      description: "Opus 4.7 1M Medium Thinking Fast",
    },
    {
      value: "claude-opus-4-7-thinking-high-fast",
      label: "claude-opus-4-7-thinking-high-fast",
      description: "Opus 4.7 1M High Thinking Fast",
    },
    {
      value: "claude-opus-4-7-thinking-xhigh",
      label: "claude-opus-4-7-thinking-xhigh",
      description: "Opus 4.7 1M Thinking",
    },
    {
      value: "claude-opus-4-7-thinking-xhigh-fast",
      label: "claude-opus-4-7-thinking-xhigh-fast",
      description: "Opus 4.7 1M Thinking Fast",
    },
    {
      value: "claude-opus-4-7-thinking-max",
      label: "claude-opus-4-7-thinking-max",
      description: "Opus 4.7 1M Max Thinking",
    },
    {
      value: "claude-opus-4-7-thinking-max-fast",
      label: "claude-opus-4-7-thinking-max-fast",
      description: "Opus 4.7 1M Max Thinking Fast",
    },
    {
      value: "grok-build-0.1",
      label: "grok-build-0.1",
      description: "Grok Build 0.1 1M",
    },
    {
      value: "gpt-5.4-low",
      label: "gpt-5.4-low",
      description: "GPT-5.4 1M Low",
    },
    {
      value: "gpt-5.4-medium",
      label: "gpt-5.4-medium",
      description: "GPT-5.4 1M",
    },
    {
      value: "gpt-5.4-medium-fast",
      label: "gpt-5.4-medium-fast",
      description: "GPT-5.4 Fast",
    },
    {
      value: "gpt-5.4-xhigh",
      label: "gpt-5.4-xhigh",
      description: "GPT-5.4 1M Extra High",
    },
    {
      value: "gpt-5.4-xhigh-fast",
      label: "gpt-5.4-xhigh-fast",
      description: "GPT-5.4 Extra High Fast",
    },
    {
      value: "claude-4.6-opus-high",
      label: "claude-4.6-opus-high",
      description: "Opus 4.6 1M",
    },
    {
      value: "claude-4.6-opus-max",
      label: "claude-4.6-opus-max",
      description: "Opus 4.6 1M Max",
    },
    {
      value: "claude-4.6-opus-max-thinking",
      label: "claude-4.6-opus-max-thinking",
      description: "Opus 4.6 1M Max Thinking",
    },
    {
      value: "claude-4.6-opus-max-thinking-fast",
      label: "claude-4.6-opus-max-thinking-fast",
      description: "Opus 4.6 1M Max Thinking Fast",
    },
    {
      value: "claude-4.5-opus-high",
      label: "claude-4.5-opus-high",
      description: "Opus 4.5",
    },
    {
      value: "claude-4.5-opus-high-thinking",
      label: "claude-4.5-opus-high-thinking",
      description: "Opus 4.5 Thinking",
    },
    {
      value: "gpt-5.2-low",
      label: "gpt-5.2-low",
      description: "GPT-5.2 Low",
    },
    {
      value: "gpt-5.2-low-fast",
      label: "gpt-5.2-low-fast",
      description: "GPT-5.2 Low Fast",
    },
    {
      value: "gpt-5.2-fast",
      label: "gpt-5.2-fast",
      description: "GPT-5.2 Fast",
    },
    {
      value: "gpt-5.2-high",
      label: "gpt-5.2-high",
      description: "GPT-5.2 High",
    },
    {
      value: "gpt-5.2-high-fast",
      label: "gpt-5.2-high-fast",
      description: "GPT-5.2 High Fast",
    },
    {
      value: "gpt-5.2-xhigh",
      label: "gpt-5.2-xhigh",
      description: "GPT-5.2 Extra High",
    },
    {
      value: "gpt-5.2-xhigh-fast",
      label: "gpt-5.2-xhigh-fast",
      description: "GPT-5.2 Extra High Fast",
    },
    {
      value: "gemini-3.1-pro",
      label: "gemini-3.1-pro",
      description: "Gemini 3.1 Pro",
    },
    {
      value: "gpt-5.4-mini-none",
      label: "gpt-5.4-mini-none",
      description: "GPT-5.4 Mini None",
    },
    {
      value: "gpt-5.4-mini-low",
      label: "gpt-5.4-mini-low",
      description: "GPT-5.4 Mini Low",
    },
    {
      value: "gpt-5.4-mini-medium",
      label: "gpt-5.4-mini-medium",
      description: "GPT-5.4 Mini",
    },
    {
      value: "gpt-5.4-mini-high",
      label: "gpt-5.4-mini-high",
      description: "GPT-5.4 Mini High",
    },
    {
      value: "gpt-5.4-mini-xhigh",
      label: "gpt-5.4-mini-xhigh",
      description: "GPT-5.4 Mini Extra High",
    },
    {
      value: "gpt-5.4-nano-none",
      label: "gpt-5.4-nano-none",
      description: "GPT-5.4 Nano None",
    },
    {
      value: "gpt-5.4-nano-low",
      label: "gpt-5.4-nano-low",
      description: "GPT-5.4 Nano Low",
    },
    {
      value: "gpt-5.4-nano-medium",
      label: "gpt-5.4-nano-medium",
      description: "GPT-5.4 Nano",
    },
    {
      value: "gpt-5.4-nano-high",
      label: "gpt-5.4-nano-high",
      description: "GPT-5.4 Nano High",
    },
    {
      value: "gpt-5.4-nano-xhigh",
      label: "gpt-5.4-nano-xhigh",
      description: "GPT-5.4 Nano Extra High",
    },
    {
      value: "grok-4.3",
      label: "grok-4.3",
      description: "Grok 4.3 1M",
    },
    {
      value: "claude-4.5-sonnet",
      label: "claude-4.5-sonnet",
      description: "Sonnet 4.5",
    },
    {
      value: "claude-4.5-sonnet-thinking",
      label: "claude-4.5-sonnet-thinking",
      description: "Sonnet 4.5 Thinking",
    },
    {
      value: "gpt-5.1-low",
      label: "gpt-5.1-low",
      description: "GPT-5.1 Low",
    },
    {
      value: "gpt-5.1",
      label: "gpt-5.1",
      description: "GPT-5.1",
    },
    {
      value: "gpt-5.1-high",
      label: "gpt-5.1-high",
      description: "GPT-5.1 High",
    },
    {
      value: "gemini-3-flash",
      label: "gemini-3-flash",
      description: "Gemini 3 Flash",
    },
    {
      value: "gemini-3.5-flash",
      label: "gemini-3.5-flash",
      description: "Gemini 3.5 Flash",
    },
    {
      value: "gpt-5.1-codex-mini-low",
      label: "gpt-5.1-codex-mini-low",
      description: "Codex 5.1 Mini Low",
    },
    {
      value: "gpt-5.1-codex-mini",
      label: "gpt-5.1-codex-mini",
      description: "Codex 5.1 Mini",
    },
    {
      value: "gpt-5.1-codex-mini-high",
      label: "gpt-5.1-codex-mini-high",
      description: "Codex 5.1 Mini High",
    },
    {
      value: "claude-4-sonnet",
      label: "claude-4-sonnet",
      description: "Sonnet 4",
    },
    {
      value: "claude-4-sonnet-thinking",
      label: "claude-4-sonnet-thinking",
      description: "Sonnet 4 Thinking",
    },
    {
      value: "gpt-5-mini",
      label: "gpt-5-mini",
      description: "GPT-5 Mini",
    },
    {
      value: "kimi-k2.5",
      label: "kimi-k2.5",
      description: "Kimi K2.5",
    },
  ],
  DEFAULT: "composer-2.5-fast",
};

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-5.5', label: 'gpt-5.5' },
    { value: 'gpt-5.4', label: 'gpt-5.4' },
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
    { value: 'gpt-5.2', label: 'gpt-5.2' },
  ],
  DEFAULT: 'gpt-5.4',
};

export const GEMINI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-2.0-pro-exp', label: 'Gemini 2.0 Pro Experimental' },
    { value: 'gemini-2.0-flash-thinking-exp', label: 'Gemini 2.0 Flash Thinking' },
  ],
  DEFAULT: 'gemini-3.1-pro-preview',
};

export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'agy default' },
    { value: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
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

// Client-side mirror of the server's HERMES_FALLBACK_MODELS
// (server/modules/providers/list/hermes/hermes.provider.ts). Used when the live
// /api/providers/hermes/models call fails. Keep in sync with the server list.
export const HERMES_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'nous/stepfun/step-3.7-flash:free', label: 'Step 3.7 Flash (free)', description: 'nous — default free tier' },
    { value: 'nous/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'nous' },
    { value: 'nous/glm-5.2', label: 'GLM 5.2', description: 'nous' },
    { value: 'nous/kimi-k2.5', label: 'Kimi K2.5', description: 'nous' },
    { value: 'nous/minimax-m3', label: 'MiniMax M3', description: 'nous' },
    { value: 'nous/qwen3-coder:480b', label: 'Qwen3 Coder 480B', description: 'nous' },
    { value: 'copilot/claude-opus-4.8', label: 'Claude Opus 4.8', description: 'copilot' },
    { value: 'copilot/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'copilot' },
    { value: 'copilot/gpt-5.5', label: 'GPT-5.5', description: 'copilot' },
    { value: 'copilot/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', description: 'copilot' },
  ],
  DEFAULT: 'nous/stepfun/step-3.7-flash:free',
};

export const PROVIDER_FALLBACK_MODELS: Record<LLMProvider, ProviderModelsDefinition> = {
  claude: CLAUDE_FALLBACK_MODELS,
  cursor: CURSOR_FALLBACK_MODELS,
  codex: CODEX_FALLBACK_MODELS,
  gemini: GEMINI_FALLBACK_MODELS,
  antigravity: ANTIGRAVITY_FALLBACK_MODELS,
  opencode: OPENCODE_FALLBACK_MODELS,
  kimi: KIMI_FALLBACK_MODELS,
  deepseek: DEEPSEEK_FALLBACK_MODELS,
  glm: GLM_FALLBACK_MODELS,
  hermes: HERMES_FALLBACK_MODELS,
  sakana: PLACEHOLDER_FALLBACK_MODELS,
};

/**
 * Per-provider default model id, derived from the fallback catalog so it can
 * never drift from a valid option (the previous hard-coded `claude: 'opus'`
 * was not a valid Claude value and produced a stuck/invalid model).
 */
export const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: CLAUDE_FALLBACK_MODELS.DEFAULT,
  cursor: CURSOR_FALLBACK_MODELS.DEFAULT,
  codex: CODEX_FALLBACK_MODELS.DEFAULT,
  gemini: GEMINI_FALLBACK_MODELS.DEFAULT,
  antigravity: ANTIGRAVITY_FALLBACK_MODELS.DEFAULT,
  opencode: OPENCODE_FALLBACK_MODELS.DEFAULT,
  kimi: KIMI_FALLBACK_MODELS.DEFAULT,
  deepseek: DEEPSEEK_FALLBACK_MODELS.DEFAULT,
  glm: GLM_FALLBACK_MODELS.DEFAULT,
  hermes: HERMES_FALLBACK_MODELS.DEFAULT,
  sakana: PLACEHOLDER_FALLBACK_MODELS.DEFAULT,
};

/**
 * Returns a stored model id only when it is a known-valid option for the given
 * provider's fallback catalog; otherwise returns the provider default. Used for
 * the synchronous initial localStorage read so a stale value cannot leak before
 * the async catalog normalization runs (first-render race).
 */
export function sanitizeStoredModel(provider: LLMProvider, stored: string | null): string {
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
