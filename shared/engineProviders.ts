/**
 * engineProviders.ts — the ENGINE axis (ADR-073), kept strictly apart from the
 * BODY axis in `disabledProviders.ts`.
 *
 * محورا المزوّد متعامدان:
 *
 *   • **الجسد (body)** — هارنس يملك الأدوات والأذونات وMCP والجلسات: claude،
 *     opencode، codex، kimi، antigravity… تعطيله (`DISABLED_PROVIDERS`) يعني
 *     «ليس نظام وكلاء تختاره من الإعدادات».
 *   • **المحرّك (engine)** — نقطة نهاية HTTP تولّد التوكنز فحسب. تشغيل جسد
 *     Claude Code على محرّك آخر يتمّ بحقن `ANTHROPIC_BASE_URL` +
 *     `ANTHROPIC_AUTH_TOKEN` (ADR-037) ولا علاقة له بكون المزوّد جسداً.
 *
 * WHY THIS FILE EXISTS (B-218): `sanitizeEngineProviderValue` used to validate a
 * stored engine stamp through `isProviderGloballyDisabled`. When the 2026-07-26
 * fold moved GLM to "a model inside OpenCode" and added `glm` to
 * `DISABLED_PROVIDERS`, every session stamped `glm` began reading back as
 * `null` — and null means "official Anthropic". The user's payload was
 * re-routed to a different vendor than the one they picked, silently. Disabling
 * a BODY may never revoke an ENGINE. The two lists live apart from now on.
 *
 * This file sits in the top-level `shared/` tree (like `disabledProviders.ts`)
 * because it is the ONE declaration compiled into BOTH bundles: the server
 * tsconfig includes `../shared/**` and emits it to `dist-server/shared/`, and
 * the Vite root is the project root so the client imports it directly. Server
 * and client therefore cannot drift on which engines exist or are eligible —
 * the drift that produced this bug.
 */

/**
 * Every engine that exposes an Anthropic-compatible endpoint, with that
 * endpoint. Declaring an engine here does NOT make it selectable — see
 * `ELIGIBLE_ENGINE_PROVIDERS`. These URLs are the only non-official hosts the
 * iron-rule guard will accept, and only for a spawn that actually engaged them.
 */
export const ENGINE_ANTHROPIC_ENDPOINT = Object.freeze({
  kimi: 'https://api.moonshot.ai/anthropic',
  deepseek: 'https://api.deepseek.com/anthropic',
  glm: 'https://api.z.ai/api/anthropic',
} as const);

export type EngineProviderId = keyof typeof ENGINE_ANTHROPIC_ENDPOINT;

/** All engine ids that have an endpoint (eligible or not). */
export const ENGINE_PROVIDER_IDS = Object.keys(ENGINE_ANTHROPIC_ENDPOINT) as EngineProviderId[];

/**
 * Engines that may drive the Claude body — for a new run AND for honouring a
 * historical session stamp.
 *
 * `deepseek` is deliberately absent: it was already ineligible before the GLM
 * fold (globally disabled since T-864) and widening the engine axis to it is an
 * owner decision, not a side effect of this repair. Adding an id here is the
 * single switch that makes an engine selectable end to end.
 */
export const ELIGIBLE_ENGINE_PROVIDERS = Object.freeze(['kimi', 'glm'] as const);

export type EligibleEngineProviderId = (typeof ELIGIBLE_ENGINE_PROVIDERS)[number];

/**
 * Display names. Kept here — not next to the body cards — so the engine surface,
 * the chat label and the server's error messages all name an engine identically.
 * Never build a label from the wire id (ADR-073 §6).
 */
export const ENGINE_PROVIDER_LABEL: Readonly<Record<EngineProviderId, string>> = Object.freeze({
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
});

/** True when the id names an engine that has an Anthropic-compatible endpoint. */
export function isEngineProvider(provider: string): provider is EngineProviderId {
  return Object.prototype.hasOwnProperty.call(ENGINE_ANTHROPIC_ENDPOINT, provider);
}

/**
 * True when the id may drive the Claude body right now. This — never
 * `isProviderGloballyDisabled` — is the gate for an engine stamp or selection.
 */
export function isEngineProviderEligible(provider: string): provider is EligibleEngineProviderId {
  return (ELIGIBLE_ENGINE_PROVIDERS as readonly string[]).includes(provider);
}

/** The engine's endpoint hostname (for truthful display), or null if unknown. */
export function engineProviderHost(provider: string): string | null {
  if (!isEngineProvider(provider)) {
    return null;
  }
  try {
    return new URL(ENGINE_ANTHROPIC_ENDPOINT[provider]).hostname;
  } catch {
    return null;
  }
}

/** Human label for an engine id, falling back to the id itself. */
export function engineProviderLabel(provider: string): string {
  return isEngineProvider(provider) ? ENGINE_PROVIDER_LABEL[provider] : provider;
}
