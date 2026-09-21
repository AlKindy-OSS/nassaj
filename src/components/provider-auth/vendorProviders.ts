import { filterDisabledProviders } from '../../../shared/disabledProviders';
import { isEngineProviderEligible } from '../../../shared/engineProviders';
import type { LLMProvider } from '../../types/app';

/**
 * Hosted vendor providers (ADR-036): Kimi (Moonshot), DeepSeek, GLM (Zhipu/Z.ai).
 *
 * Unlike the CLI providers (claude/cursor/codex/gemini/antigravity/opencode),
 * these are authenticated purely by an API key stored in the encrypted per-user
 * secrets store. They have no CLI `login` flow — the UI collects/clears the key
 * via `/api/providers/:provider/api-key` and reflects connection state through
 * the shared `/auth/status` endpoint (ADR-030 filtering).
 */
export const VENDOR_PROVIDERS = ['kimi', 'deepseek', 'glm'] as const;

export type VendorProvider = (typeof VENDOR_PROVIDERS)[number];

/**
 * Vendor providers that are not globally disabled (T-864). UI enumeration
 * points (key-status fan-out, "Claude engine on <vendor>" groups) iterate this
 * list; VENDOR_PROVIDERS itself stays complete so type guards and historical
 * session rendering keep recognizing the disabled ids.
 */
export const ENABLED_VENDOR_PROVIDERS: readonly VendorProvider[] =
  filterDisabledProviders(VENDOR_PROVIDERS);

/**
 * Vendors that may drive the Claude ENGINE (ADR-073 engine axis, declared in
 * `shared/engineProviders.ts`). Deliberately NOT derived from the disabled-body
 * list: `glm` is not an agent system you can pick, yet it is a first-class
 * engine — conflating the two is what silently re-routed engine sessions to
 * official Anthropic (B-218). Use this for engine surfaces (the "Claude engine
 * on X" picker groups, the engines settings panel, engine key status); use
 * ENABLED_VENDOR_PROVIDERS for body surfaces.
 */
export const ENGINE_VENDOR_PROVIDERS: readonly VendorProvider[] =
  VENDOR_PROVIDERS.filter((provider) => isEngineProviderEligible(provider));

/** Narrowing guard: is this LLMProvider one of the API-key vendor providers? */
export function isVendorProvider(provider: LLMProvider): provider is VendorProvider {
  return (VENDOR_PROVIDERS as readonly string[]).includes(provider);
}

export type VendorProviderMeta = {
  /** Display name (latin; kept identical across locales as a brand name). */
  name: string;
  /** Default model id used as a local fallback before the live catalog loads. */
  defaultModel: string;
  /** Where the operator obtains an API key (shown in the key-entry helper). */
  apiKeyUrl: string;
  /** Tailwind accent classes for the provider's badge/icon (decorative). */
  accentClass: string;
  iconBgClass: string;
};

/**
 * Static, presentation-only metadata for the three vendor providers. Model ids
 * here are only a pre-catalog fallback; the authoritative list comes live from
 * `/api/providers/:provider/models` (see VENDOR_RUNTIME on the backend).
 */
export const VENDOR_PROVIDER_META: Record<VendorProvider, VendorProviderMeta> = {
  kimi: {
    name: 'Kimi',
    defaultModel: 'kimi-k2.6',
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    accentClass: 'bg-rose-500',
    iconBgClass: 'bg-rose-50 dark:bg-rose-900/20',
  },
  deepseek: {
    name: 'DeepSeek',
    defaultModel: 'deepseek-v4-pro',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    accentClass: 'bg-sky-500',
    iconBgClass: 'bg-sky-50 dark:bg-sky-900/20',
  },
  glm: {
    name: 'GLM',
    defaultModel: 'glm-5.2',
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    accentClass: 'bg-violet-500',
    iconBgClass: 'bg-violet-50 dark:bg-violet-900/20',
  },
};
