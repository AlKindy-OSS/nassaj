/**
 * engine-pin — server-authoritative engine axis for a Claude-body session
 * (ADR-088, B-258/B-262/B-358, advances wave م3 of
 * docs/design/provider-model-redesign-2026-07-31.md §ف-9).
 *
 * The engine choice used to live ONLY in the browser's localStorage; losing
 * that stamp (another device, cleared storage, a refresh mid-race) silently
 * re-routed a vendor-pinned conversation to official Anthropic on the owner's
 * subscription (incident: session 43b0dc60, 2026-07-31). This module is the
 * pure decision core for the fix:
 *
 *   - `sessions.engine_provider` holds the server's own record, written from
 *     the RESOLVED spawn verdict ({status:'applied'} / official), never from
 *     the client's request — the client value is readable over the wire and
 *     differs between browsers, which is exactly why it cannot be trusted.
 *   - Three explicit states: OFFICIAL_ENGINE ('anthropic'), an engine id
 *     ('kimi'/'glm'), and NULL = UNKNOWN. NULL never means official: legacy
 *     rows predate the column and some of them are vendor sessions.
 *   - On conflict the SERVER WINS (no visible rejection): a client value that
 *     disagrees with the stored pin can only come from a stale localStorage
 *     stamp or a forged payload, and rejecting would let anyone who can send a
 *     claude-command freeze someone else's session. The one legitimate visible
 *     failure stays ENGINE_PROVIDER_UNAVAILABLE (pinned engine, no key).
 *   - Enforcement is ON by default. An operator may explicitly set
 *     NASSAJ_ENGINE_PIN_ENFORCE=0/false for emergency shadow-only rollback.
 *
 * Deliberately out of scope: the vendor-delegate MCP path — it runs on its own
 * vendor key, never through ANTHROPIC_BASE_URL, so the pin does not apply to it
 * and its tokens must never be attributed to the session engine
 * (provider-model-redesign §1.12 rule 6).
 */

import { ELIGIBLE_ENGINE_PROVIDERS } from '../../../shared/engineProviders.js';

/** Stored value meaning "runs on official Anthropic". Distinct from NULL=unknown. */
export const OFFICIAL_ENGINE = 'anthropic';

/** engine_provider_source values: how the stored pin was obtained. */
export const PIN_SOURCE = Object.freeze({
  /** Written from an actual resolved spawn verdict — authoritative, never downgraded. */
  SERVER_VERDICT: 'server_verdict',
  /** Backfilled by transcript inference — upgradable by a later SERVER_VERDICT. */
  INFERRED: 'inferred',
  /**
   * ADR-099: the session owner's explicit re-stamp. The only INTENT among these
   * sources — the other two record what was observed, this one states what shall
   * happen next — so it is the only one allowed to overwrite a settled pin, and
   * the only one no spawn may write (sessions.db enforces both).
   */
  USER_SWITCH: 'user_switch',
});

/**
 * Enforcement flag. Default ON; only explicit 0/false opts out to shadow mode.
 */
export function enginePinEnforceEnabled(env = process.env) {
  const raw = env.NASSAJ_ENGINE_PIN_ENFORCE;
  return raw !== '0' && raw !== 'false';
}

/**
 * The decision table (ADR-088). Pure — no I/O, no env reads.
 *
 * @param {object} input
 * @param {string|null} input.storedEngine   sessions.engine_provider: OFFICIAL_ENGINE,
 *   an engine id, or null = unknown (no row counts as unknown too)
 * @param {string|null} input.clientEngine   options.engineProvider as sent by the
 *   client (already trimmed/nullified), null = official requested
 * @param {boolean} input.enforce            enginePinEnforceEnabled()
 * @returns {{engine: string|null, decision: string, mismatch: boolean}}
 *   `engine` is what the spawn should engage (null = official). `decision`:
 *   - 'client'       unknown stored state → honour the client (today's behaviour)
 *   - 'match'        stored and client agree
 *   - 'server-wins'  enforce=true and stored overrode a disagreeing client
 *   - 'shadow'       enforce=false and stored disagrees — client honoured, log only
 */
export function resolveSpawnEngine({ storedEngine, clientEngine, enforce }) {
  const stored = typeof storedEngine === 'string' && storedEngine.trim() !== ''
    ? storedEngine.trim()
    : null;
  const client = typeof clientEngine === 'string' && clientEngine.trim() !== ''
    ? clientEngine.trim()
    : null;

  // Unknown server state: the client is the only signal we have. This is
  // today's behaviour and MUST stay identical for the pure-official fleet.
  if (stored === null) {
    return { engine: client, decision: 'client', mismatch: false };
  }

  const storedAsEngine = stored === OFFICIAL_ENGINE ? null : stored;
  if (storedAsEngine === client) {
    return { engine: client, decision: 'match', mismatch: false };
  }

  // Disagreement. Server wins under enforcement; shadow-only otherwise.
  if (enforce) {
    return { engine: storedAsEngine, decision: 'server-wins', mismatch: true };
  }
  return { engine: client, decision: 'shadow', mismatch: true };
}

/**
 * Backfill inference over the DISTINCT model ids seen in a session's history
 * (from session_agents_cache.agent_model or the transcript itself).
 *
 * Rule (qa-critic بند 1/10): "ANY engine-catalog model id anywhere in the
 * history pins the session to that engine" — NOT "the last model id". A stolen
 * official turn writes claude-* ids INSIDE a vendor session (incident 43b0dc60:
 * kimi-k3 ×21 → claude-opus-5 ×43 → kimi-k2.6 ×44), so last-id would launder
 * the leak into a permanent official pin.
 *
 * Fail-closed shape: this function returns a HINT, never a verdict —
 *   { kind: 'engine', engine }  exactly one eligible engine matched
 *   { kind: 'ambiguous', engines } two+ engines matched — caller must refuse, not guess
 *   { kind: 'none' }            nothing attributable (official ids, retired vendor
 *                               ids, sentinels) — stays unknown, never "official"
 *
 * @param {string[]} historyModelIds distinct model ids from the session history
 * @param {Record<string, Set<string>|string[]>} engineCatalogs map engineId →
 *   model ids in that engine's catalog (caller loads via providerModelsService;
 *   model ids. The I/O caller must reject incomplete catalogs before invoking
 *   this pure helper; a partial universe can produce a false single match.
 */
export function inferEngineFromHistory(historyModelIds, engineCatalogs) {
  const matched = new Set();
  for (const engine of ELIGIBLE_ENGINE_PROVIDERS) {
    const catalog = engineCatalogs?.[engine];
    if (!catalog) continue;
    const ids = catalog instanceof Set ? catalog : new Set(catalog);
    for (const modelId of historyModelIds || []) {
      if (typeof modelId === 'string' && ids.has(modelId)) {
        matched.add(engine);
        break;
      }
    }
  }
  if (matched.size === 1) {
    return { kind: 'engine', engine: [...matched][0] };
  }
  if (matched.size > 1) {
    return { kind: 'ambiguous', engines: [...matched].sort() };
  }
  return { kind: 'none' };
}

/**
 * Picks the model id to send on an ENGINE-driven run (qa-critic بند 9).
 * `resolvedModel` (from the session's own transcript) is preferred over the
 * client's value, but ONLY when it belongs to the engine's catalog — a vendor
 * session whose transcript was polluted by a leaked official turn resolves to
 * claude-opus-5, and sending that to Moonshot is a guaranteed dead turn.
 * Falls back to the engine catalog default, with a non-silent warning hook.
 *
 * @param {object} input
 * @param {string} input.engine            engaged engine id (for messages only)
 * @param {string|null} input.resolvedModel  transcript-resolved model, if any
 * @param {string|null} input.clientModel    options.model as sent
 * @param {{OPTIONS?: {value:string}[], DEFAULT?: string}|null} input.catalog
 *   the ENGINE's model catalog (null/undefined = unavailable)
 * @param {(msg:string)=>void} [input.warn]
 * @returns {string|null} model id to set, or null to leave sdkOptions.model alone
 */
export function pickEngineModel({ engine, resolvedModel, clientModel, catalog, warn = () => {} }) {
  const options = Array.isArray(catalog?.OPTIONS) ? catalog.OPTIONS : [];
  const members = new Set(options.map((o) => o?.value).filter(Boolean));
  const candidates = [resolvedModel, clientModel]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of candidates) {
    // With no catalog loaded we cannot check membership; trust the first
    // candidate rather than inventing a value (catalog outages must not
    // rewrite models).
    if (members.size === 0) return candidate;
    if (members.has(candidate)) return candidate;
  }

  const fallback = typeof catalog?.DEFAULT === 'string' && catalog.DEFAULT.trim() !== ''
    ? catalog.DEFAULT.trim()
    : options[0]?.value ?? null;
  if (candidates.length > 0 && fallback) {
    warn(
      `engine-pin: model "${candidates[0]}" is not in the ${engine} catalog; ` +
      `using the ${engine} default "${fallback}" instead`,
    );
  }
  return fallback;
}
