import { filterDisabledProviders } from '../../../shared/disabledProviders';
import type { ActiveBodyProvider } from '../../types/app';

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
  /**
   * وضع الاتصال المكتشَف من الخادم: مفتاح API مخزَّن، توكن OAuth صالح، أو
   * الاثنان. `null` = لا وضع مكتشَف بعد.
   */
  authMode?: 'api_key' | 'subscription_oauth' | 'both' | null;
  /**
   * قرب انتهاء صلاحية الربط — حاضرٌ داخل نافذة ثلاثة أيام فقط، `null` خارجها.
   * `daysLeft: 0` تعني «ينتهي اليوم» لا «انتهى». لا يُرسَل مسار مفتاح API.
   */
  linkExpiry?: { expiresAt: string; daysLeft: number } | null;
};

export type ProviderAuthStatusMap = Record<ActiveBodyProvider, ProviderAuthStatus>;

// Providers actively probed by the auth status refresher. Antigravity is
// enabled again over the provider-models layer (live agy catalog with a
// graceful fallback); its auth status endpoint reports the real agy auth state.
// The hosted vendor providers (deepseek/glm) report authenticated=true via the
// same endpoint once their API key is configured (ADR-036 / ADR-030), so they
// are probed too — `deepseek`/`glm` stay in this static list on purpose: their
// exclusion is a DISABLED_PROVIDERS decision, not a retirement, and must keep
// deriving from filterDisabledProviders below. `sakana` stays excluded — a
// union-only placeholder with no real backend.
//
// `cursor`, `hermes`, `kimi` and `qwen` are retired BODIES (T-1953) and are
// dropped from this static list permanently — not merely filtered by
// DISABLED_PROVIDERS, whose list a later step (C4) also empties of these same
// four ids. Leaving them here and relying only on the dynamic filter would have
// silently re-exposed their auth probe and login CTA the moment C4 landed
// (finding H6). `kimi`'s live ENGINE meaning is unaffected: the engine key
// status goes through `/api/providers/kimi/api-key`, probed by
// `useVendorKeyStatuses`, not this body auth-status fan-out.
export const CLI_PROVIDERS: ActiveBodyProvider[] = filterDisabledProviders([
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'deepseek',
  'glm',
]);

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<ActiveBodyProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  codex: '/api/providers/codex/auth/status',
  antigravity: '/api/providers/antigravity/auth/status',
  opencode: '/api/providers/opencode/auth/status',
  deepseek: '/api/providers/deepseek/auth/status',
  glm: '/api/providers/glm/auth/status',
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
  codex: initialStatus(loading),
  antigravity: initialStatus(loading),
  opencode: initialStatus(loading),
  // Hosted vendors (deepseek/glm) are real probed providers (in
  // CLI_PROVIDERS) — start in the loading state until their probe returns.
  deepseek: initialStatus(loading),
  glm: initialStatus(loading),
  // sakana is a union-only placeholder, never probed by CLI_PROVIDERS — start
  // not-loading and not-installed so its UI does not spin forever.
  sakana: { authenticated: false, installed: false, email: null, method: null, error: null, loading: false, checkFailed: false },
});
