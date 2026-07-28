import type { LLMProvider } from '../../types/app';

/**
 * Providers the Account tab *attempts* to render an API-key entry section for
 * (T-866/F1). This is only the candidate set — the definitive per-provider
 * write method (`native_file` | `cli_stdin` | `none`) and its credential
 * targets are advertised live by the backend
 * (`GET /:provider/api-key/capability`, provider-credentials.service.ts) via
 * `useProviderApiKeyCapability`. `ProviderApiKeySection` hides itself whenever
 * that live descriptor comes back `none`, so a backend policy change (a
 * provider losing its credential-writer facet) degrades safely without a
 * frontend redeploy — the capability descriptor leads, this list just avoids
 * firing a request for providers that can never have one.
 *
 * claude/opencode/codex: facet writers (native_file/cli_stdin) added in T-866.
 * kimi/deepseek/glm: the pre-existing hosted-vendor API-key path (ADR-036).
 * hermes/cursor: terminal-only CLI login, no key entry.
 * antigravity (agy): no credential-writer facet, no vendor path — not attempted.
 * gemini/sakana: same as agy — not attempted.
 */
export const API_KEY_CANDIDATE_PROVIDERS: readonly LLMProvider[] = [
  'claude',
  'opencode',
  'codex',
  'kimi',
  'deepseek',
  'glm',
];

export function isApiKeyCandidateProvider(provider: LLMProvider): boolean {
  return (API_KEY_CANDIDATE_PROVIDERS as readonly string[]).includes(provider);
}

export type ProviderApiKeyMeta = {
  /** Display name (latin; kept identical across locales as a brand name). */
  name: string;
  /**
   * Where the operator obtains a key. A single URL for single-target
   * providers; a per-target map for a multi-target provider (opencode), keyed
   * by the same target ids the backend's `targets` list uses.
   */
  apiKeyUrl: string | Readonly<Record<string, string>>;
};

/**
 * Static, presentation-only metadata (name + "get a key" link). The write
 * method and target list themselves are never hardcoded here — they come live
 * from the backend so the two can never drift out of sync silently.
 */
export const PROVIDER_API_KEY_META: Readonly<Partial<Record<LLMProvider, ProviderApiKeyMeta>>> = {
  claude: {
    name: 'Anthropic',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  codex: {
    name: 'OpenAI (Codex)',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  opencode: {
    name: 'OpenCode',
    apiKeyUrl: {
      anthropic: 'https://console.anthropic.com/settings/keys',
      openai: 'https://platform.openai.com/api-keys',
      openrouter: 'https://openrouter.ai/keys',
      // GLM is carried BY opencode (ADR-062): it is a credential target of this
      // card, never a provider card of its own — so its "get a key" link lives
      // here, next to its siblings.
      glm: 'https://z.ai/manage-apikey/apikey-list',
    },
  },
  kimi: {
    name: 'Kimi',
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
  },
  deepseek: {
    name: 'DeepSeek',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  glm: {
    name: 'GLM',
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
};

/**
 * Presentation fallback for a credential target that has no i18n label yet.
 *
 * Target ids are wire identifiers (`glm`, `openrouter`, …) and must never be
 * renamed — they key opencode's `auth.json` entries and its provider blocks.
 * They are also never shown raw: a lowercase `glm` sitting next to `Anthropic`
 * and `OpenRouter` reads as a bug. Labels come from
 * `agents.apiKey.targets.<id>`; this is what a *new* target id falls back to
 * until a label lands, so no future target can regress to a bare wire id:
 * a short all-letter id reads as an acronym (`glm` → `GLM`), anything else is
 * capitalized (`zhipu` → `Zhipu`).
 */
export function formatCredentialTargetFallback(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return target;
  }
  if (/^[a-z]{2,4}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Resolves the "get a key" URL for a provider + optional selected target. */
export function resolveApiKeyUrl(provider: LLMProvider, target?: string): string | undefined {
  const meta = PROVIDER_API_KEY_META[provider];
  if (!meta) {
    return undefined;
  }
  if (typeof meta.apiKeyUrl === 'string') {
    return meta.apiKeyUrl;
  }
  return target ? meta.apiKeyUrl[target] : undefined;
}
