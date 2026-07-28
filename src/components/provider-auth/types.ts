import { filterDisabledProviders } from '../../../shared/disabledProviders';
import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  authenticated: boolean;
  installed: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
  /**
   * True only when the HTTP request itself failed (non-2xx response or network
   * error). Distinct from `error`, which the backend fills for legitimate
   * negative states (e.g. "Not installed", "Not authenticated") on a successful
   * 200 response. Filtering logic uses this flag for fail-open decisions so that
   * a populated `error` from a successful check still triggers hide/disable.
   */
  checkFailed: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

// Providers actively probed by the auth status refresher. Antigravity is
// enabled again over the provider-models layer (live agy catalog with a
// graceful fallback); its auth status endpoint reports the real agy auth state.
// Hermes is a CLI agent with a real backend probe. The hosted vendor providers
// (kimi/deepseek/glm) report authenticated=true via the same endpoint once their
// API key is configured (ADR-036 / ADR-030), so they are probed too. Only
// `sakana` stays excluded — a union-only placeholder with no real backend.
// Globally disabled providers (T-864, shared/disabledProviders.ts) are filtered
// out so no auth probe (and no login CTA) fires for them.
export const CLI_PROVIDERS: LLMProvider[] = filterDisabledProviders([
  'claude',
  'cursor',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
  'hermes',
  'kimi',
  'deepseek',
  'glm',
]);

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  gemini: '/api/providers/gemini/auth/status',
  antigravity: '/api/providers/antigravity/auth/status',
  opencode: '/api/providers/opencode/auth/status',
  kimi: '/api/providers/kimi/auth/status',
  deepseek: '/api/providers/deepseek/auth/status',
  glm: '/api/providers/glm/auth/status',
  hermes: '/api/providers/hermes/auth/status',
  // sakana: union-only placeholder (absent from CLI_PROVIDERS). Endpoint kept on
  // the same shape for when a real backend lands.
  sakana: '/api/providers/sakana/auth/status',
};

// fail-open: installed defaults to true so providers remain visible before the
// first auth-status response arrives. Only an explicit installed===false hides them.
const initialStatus = (loading: boolean): ProviderAuthStatus => ({
  authenticated: false,
  installed: true,
  email: null,
  method: null,
  error: null,
  loading,
  checkFailed: false,
});

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: initialStatus(loading),
  cursor: initialStatus(loading),
  codex: initialStatus(loading),
  gemini: initialStatus(loading),
  antigravity: initialStatus(loading),
  opencode: initialStatus(loading),
  // Hosted vendors (kimi/deepseek/glm) and Hermes are real probed providers
  // (in CLI_PROVIDERS) — start in the loading state until their probe returns.
  kimi: initialStatus(loading),
  deepseek: initialStatus(loading),
  glm: initialStatus(loading),
  hermes: initialStatus(loading),
  // sakana is a union-only placeholder, never probed by CLI_PROVIDERS — start
  // not-loading and not-installed so its UI does not spin forever.
  sakana: { authenticated: false, installed: false, email: null, method: null, error: null, loading: false, checkFailed: false },
});
