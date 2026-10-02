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
 * project root so the client imports it directly). For `deepseek` and `glm`
 * (never retired bodies), disabling — not deleting — keeps upstream sync and
 * reversibility: to re-enable, remove the id from this list; their provider
 * implementations, `resolve-provider-env` cases and `<provider>-cli.js` files
 * stay in place as dormant code. `hermes`, `qwen`, `cursor` and `kimi` are
 * DIFFERENT: they are also in `shared/retiredProviders.ts` now, so the server
 * refuses them with `provider_removed` before this list is ever consulted,
 * and (for hermes) the body's server code was deleted outright. They remain
 * in this list only so the client filters that still lean on it keep hiding
 * them; re-enabling one is no longer the one-line change it is for the other
 * two — it needs the id removed from `RETIRED_PROVIDER_IDS` first (and, for
 * hermes, the deleted body code rebuilt).
 *
 * Rationale per id: `deepseek` stays disabled — still a plain API vendor, not
 * an agent environment. `kimi` was RE-ENABLED per ADR-062: it is a governed
 * agent environment with its own native `kimi-agent-cli` launcher, so it is
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
 *
 * `hermes` is disabled (owner decision 2026-09-28): Hermes is hidden from every
 * surface — no settings card, no chat-picker group, no model fetch, no login
 * CTA — and new runs are refused at the dispatch seam. Its server body was then
 * deleted (T-1953, ADR-192): there is no launcher, provider module, login or
 * updater left, so removing the id from this list does NOT re-enable it.
 * Historical Hermes sessions stay listable and readable through the
 * history-only reader in `provider.registry.ts`.
 *
 * `qwen` is disabled (owner decision 2026-09-28): the Qwen body is hidden from
 * every surface — no settings card, no chat-picker group, no model fetch, no
 * login CTA — and new runs are refused at the dispatch seam. Its Coding Plan
 * key is now a plain key field used through the OpenCode carrier, like GLM
 * (implemented: `qwen-plan/*` models dispatched under provider `opencode`).
 * The Qwen launcher, provider module and auth/login wiring stay in place as
 * dormant code, and historical Qwen sessions stay listable and readable.
 *
 * `cursor` and `kimi` are disabled, and `deepseek` loses its "coming soon"
 * settings tile (owner decision 2026-09-29): all three are hidden from every
 * surface and new runs are refused at the dispatch seam. Launchers, provider
 * modules and auth wiring stay as dormant code; historical sessions stay
 * listable and readable. For `deepseek` alone, re-enabling is removing the id
 * from this list; `cursor` and `kimi` are also retired bodies (see above) —
 * re-enabling either needs the id removed from `RETIRED_PROVIDER_IDS` first.
 *
 * NOTE: the provider registry itself is NOT filtered — `resolveProvider` must
 * keep returning disabled providers so historical sessions stay listable and
 * readable (sessions.service fetchHistory/normalizeMessage, synchronizers).
 * Enforcement happens at the spawn/dispatch seam only.
 */
export const DISABLED_PROVIDERS = [
  'cursor',
  'deepseek',
  'glm',
  'hermes',
  'kimi',
  'qwen',
] as const;

export type DisabledProviderId = (typeof DISABLED_PROVIDERS)[number];

/** True when the provider id is globally disabled (hidden + spawn-blocked). */
export function isProviderGloballyDisabled(provider: string): boolean {
  return (DISABLED_PROVIDERS as readonly string[]).includes(provider);
}

/** Returns the list without the globally disabled providers (order preserved). */
export function filterDisabledProviders<T extends string>(providers: readonly T[]): T[] {
  return providers.filter((provider) => !isProviderGloballyDisabled(provider));
}
