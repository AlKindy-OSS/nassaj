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
 * Rationale per id: `deepseek` stays disabled — still a plain API vendor, not
 * an agent environment. `kimi` was RE-ENABLED per ADR-062: it is a governed
 * agent environment with its own native `kimi-agent-cli` launcher, so it is
 * selectable and accepts an API key.
 *
 * `gemini` was RE-ENABLED (T-1211). Its old rationale here read "superseded by
 * Antigravity", and that conflated two things that only LOOK alike because both
 * say Google and both keep state under `~/.gemini/`:
 *
 *   • **agy (Antigravity)** authenticates by GOOGLE OAUTH and nothing else
 *     (`antigravity-auth.provider.ts` reports `method: 'google-oauth'`; its
 *     credential is `~/.gemini/antigravity-cli/antigravity-oauth-token`). It
 *     resolves its model INSIDE its own CLI and accepts no external engine
 *     (`bodyEngineMatrix`: `antigravity × anthropic = closed_at_vendor`). There
 *     is no key to bring: the account IS the credential.
 *   • **gemini** accepts a plain API key (`gemini-auth.provider.ts` knows
 *     `gemini-api-key` alongside `oauth-personal` and `vertex-ai`). That is a
 *     BYOK path — metered, per-key, and revocable without touching an account.
 *
 * So one is not a substitute for the other; they differ on the axis that
 * matters here — how we pay and what we hand over. "Superseded" was never a
 * technical finding either: the body is complete and maintained (`gemini-cli.js`
 * plus auth/sessions/models/mcp/skills providers, `gemini` 1.1.10 installed on
 * this host), and only this one line kept it hidden.
 *
 * TWO THINGS THIS RE-ENABLE DOES **NOT** DECIDE, both owner policy:
 *  1. WHICH credential gemini runs on. The free AI Studio tier and the paid tier
 *     differ in how Google may use the content sent to them, so "which key" is a
 *     data-governance choice (T-1212), not a default this file may set.
 *  2. That agy is redundant. It stays enabled and untouched; the two are
 *     alternatives, and the reason to keep both is exactly the difference above.
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
 * `gemini` is INTERIM-DISABLED (T-1760, owner decision 2026-09-12). The branch
 * fe4bfe4fb (T-1749) removes the provider entirely; once that lands this entry
 * disappears with it. Keep the diff here minimal so T-1749 wins cleanly on
 * merge. Historical gemini sessions remain readable; the spawn-block prevents
 * new ones until the full removal is merged.
 *
 * NOTE: the provider registry itself is NOT filtered — `resolveProvider` must
 * keep returning disabled providers so historical sessions stay listable and
 * readable (sessions.service fetchHistory/normalizeMessage, synchronizers).
 * Enforcement happens at the spawn/dispatch seam only.
 */
export const DISABLED_PROVIDERS = [
  'deepseek',
  'gemini',
  'glm',
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
