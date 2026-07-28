/**
 * disabledProviders.ts — the single source of truth for globally disabled
 * providers (T-864, owner decision 2026-07-11).
 *
 * المصدر الوحيد لقائمة المزوّدات المعطَّلة على مستوى التطبيق كله: تُخفى من
 * الواجهة (شاشة اختيار المزوّد، شريط إعدادات الوكلاء، جلب النماذج، أي CTA
 * مصادقة) ويرفض السيرفر إطلاق تشغيلات جديدة لها. الجلسات التاريخية تبقى
 * مقروءة — التعطيل يمنع الجديد ولا يمحو القديم.
 *
 * This file lives in the top-level `shared/` directory on purpose: it is the
 * only tree compiled into BOTH bundles (the server tsconfig includes
 * `../shared/**` and emits it into `dist-server/shared/`; the Vite root is the
 * project root so the client imports it directly). Disabling — not deleting —
 * keeps upstream sync and reversibility: to re-enable a provider, remove its
 * id from this list. The provider implementations, `resolve-provider-env`
 * cases and `<provider>-cli.js` files stay in place as dormant code.
 *
 * Rationale per id: `gemini` is superseded by Antigravity (agy, which stays
 * enabled); `deepseek` stays disabled — still a plain API vendor, not an
 * agent environment. `kimi` was RE-ENABLED per ADR-062: it is a governed agent
 * environment with its own native `kimi-agent-cli` launcher, so it is
 * selectable and accepts an API key.
 *
 * `glm` is disabled AS A STANDALONE AGENT SYSTEM (owner decision 2026-07-26).
 * The settings screen lists agent SYSTEMS — bodies with a CLI, tools and
 * sessions — and models live INSIDE them. GLM has no body of its own: its
 * governed home is the OpenCode carrier (ADR-062), where it is a credential
 * target (`auth.json` → `glm`) and a model id (`glm/glm-5.2`). Listing it as a
 * peer of Claude/OpenCode advertised a second, tool-less body (`spawnGlm` over
 * raw HTTP) with a SECOND key store, and a "Connected" badge that described
 * neither. So: no GLM card, no GLM group in the chat picker — the one path is
 * OpenCode → a `glm/*` model. The carrier itself is NOT affected (it dispatches
 * under provider `opencode`), and the ADR-062 agent-mode bypass in
 * chat-websocket.service keeps historical GLM agent sessions runnable.
 * Untouched: claude, opencode, antigravity, cursor, codex, hermes.
 *
 * NOTE: the provider registry itself is NOT filtered — `resolveProvider` must
 * keep returning disabled providers so historical sessions stay listable and
 * readable (sessions.service fetchHistory/normalizeMessage, synchronizers).
 * Enforcement happens at the spawn/dispatch seam only.
 */
export const DISABLED_PROVIDERS = ['gemini', 'deepseek', 'glm'] as const;

export type DisabledProviderId = (typeof DISABLED_PROVIDERS)[number];

/** True when the provider id is globally disabled (hidden + spawn-blocked). */
export function isProviderGloballyDisabled(provider: string): boolean {
  return (DISABLED_PROVIDERS as readonly string[]).includes(provider);
}

/** Returns the list without the globally disabled providers (order preserved). */
export function filterDisabledProviders<T extends string>(providers: readonly T[]): T[] {
  return providers.filter((provider) => !isProviderGloballyDisabled(provider));
}
