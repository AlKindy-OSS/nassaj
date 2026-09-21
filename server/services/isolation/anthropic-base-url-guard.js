/**
 * anthropic-base-url-guard — fail-closed enforcement of the vendor-resilience
 * iron rule for the Claude / Anthropic subprocess, with explicit support for the
 * sanctioned "Claude engine on a vendor endpoint" path (ADR-037).
 *
 * IRON RULE: the Claude Code (Anthropic) execution path must NEVER be pointed at
 * a non-Anthropic / competitor endpoint, and a competitor must never be
 * masqueraded as Claude — UNLESS that routing is the deliberate, per-user-keyed
 * engine-provider path (ADR-037), in which case the caller authorizes exactly
 * that one host via `ctx.engineProviderHosts`. Everything else fails closed.
 *
 * Before the host environment is forwarded into the spawned Claude Code
 * subprocess, every base-URL the SDK/CLI will honor is validated:
 *   1. The known ANTHROPIC routing vars (ANTHROPIC_BASE_URL and its
 *      Bedrock/Vertex/Foundry siblings) are checked against the allowlist with
 *      their cloud-apex gating.
 *   2. Any OTHER env key ending in `_BASE_URL` (e.g. OPENAI_BASE_URL, or an
 *      unrecognized routing knob in the ANTHROPIC_ / CLAUDE_ namespace) is a
 *      potential bypass surface and is rejected outright (fail-closed) — the
 *      guard refuses any base-URL override it does not explicitly understand.
 *   3. Extra base-URL values the caller collected from the per-user settings.json
 *      `env` block (ctx.extraValues) are validated with the same host logic, so a
 *      base URL hidden there cannot reach the subprocess undetected.
 *
 * Two convenience entrypoints exist because the Claude CLI reads routing config
 * from BOTH the spawn env AND the per-user settings.json:
 *   - assertAnthropicBaseUrlAllowed(env, ctx) — the spawn env (+ ctx.extraValues).
 *   - assertSettingsEnvAllowed(claudeConfigDir, spawnEnv) — reads settings.json
 *     and validates its `env` block under the SAME allowlist.
 *
 * SCOPE: this guard governs ONLY the Anthropic/Claude subprocess env. It does
 * not touch other providers (agy/AntigravityProvider, codex, cursor, opencode),
 * which legitimately point at their own non-Anthropic endpoints through their
 * own env knobs.
 *
 * Allowlist (a host is approved if ANY of these hold):
 *   1. Official Anthropic hosts: exactly `anthropic.com` or any subdomain.
 *   2. This spawn's engine host(s): ctx.engineProviderHosts (the per-user engine
 *      provider endpoint authorized by applyClaudeEngineProviderEnv).
 *   3. Official managed-cloud endpoints, ONLY when that mode is explicitly
 *      enabled in the same env:
 *        - AWS Bedrock  (CLAUDE_CODE_USE_BEDROCK truthy): `*.amazonaws.com`.
 *        - Google Vertex (CLAUDE_CODE_USE_VERTEX truthy): `*.googleapis.com`.
 *   4. Any host listed (comma/space-separated) in NASSAJ_ALLOWED_ANTHROPIC_HOSTS
 *      — the documented escape hatch for a legitimate corporate proxy / gateway.
 *      Matched exactly OR as a parent domain suffix.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OFFICIAL_ANTHROPIC_HOSTS } from './provider-anthropic-endpoints.js';

/** Official Anthropic apex domain; this apex and all subdomains are allowed. */
const ANTHROPIC_APEX = 'anthropic.com';

/**
 * SDK-honored base-URL routing vars. Each entry names the env var the Claude
 * CLI / Agent SDK reads, and the managed-cloud apex its host must fall under
 * (in addition to the universal Anthropic + engine + operator-allowlist rules).
 * The generic ANTHROPIC_BASE_URL has no fixed managed-cloud apex (cloud is null)
 * and is gated only by the Anthropic apex / engine host / Bedrock-or-Vertex flags
 * / operator list. ANTHROPIC_FOUNDRY_BASE_URL is treated like the generic base
 * URL (cloud null): there is no sanctioned Foundry host pattern and no Foundry
 * mode flag, so its host is approved ONLY when Anthropic / engine / operator-
 * allowlisted — fail-closed.
 */
const ROUTING_VARS = [
  { name: 'ANTHROPIC_BASE_URL', cloud: null },
  { name: 'ANTHROPIC_BEDROCK_BASE_URL', cloud: 'amazonaws.com' },
  { name: 'ANTHROPIC_VERTEX_BASE_URL', cloud: 'googleapis.com' },
  { name: 'ANTHROPIC_FOUNDRY_BASE_URL', cloud: null },
];

/** Set of routing var names we explicitly understand and validate above. */
const KNOWN_ROUTING_VARS = new Set(ROUTING_VARS.map((v) => v.name));

/** Matches any env var whose name ends in _BASE_URL. */
const BASE_URL_VAR_PATTERN = /_BASE_URL$/;

/**
 * Reads an env var as a trimmed non-empty string, or null.
 * @param {unknown} value
 * @returns {string|null}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Treats common truthy spellings ("1", "true", "yes", "on") as enabled. Mirrors
 * how the Claude CLI reads its CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX flags. A
 * falsy spelling ("0", "false", "") does NOT enable the flag.
 * @param {unknown} value
 * @returns {boolean}
 */
function isFlagEnabled(value) {
  const v = nonEmpty(value);
  if (v === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Extracts the lowercased hostname from a base-URL string. Returns null when the
 * value cannot be parsed as a URL with a host (which the caller treats as
 * disallowed — fail closed, never guess).
 * @param {string} rawUrl
 * @returns {string|null}
 */
function parseHost(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname;
    if (!host) return null;
    // Normalize a single trailing DNS-root dot (anthropic.com.) to its rootless
    // form so a legit FQDN still matches the allowlist. Anchored dot-suffix
    // matching is preserved (we strip a SINGLE trailing dot, never an internal one).
    return host.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * True when `host` equals `domain` or is a subdomain of it. Suffix matching is
 * anchored on a dot boundary so `evil-anthropic.com` does NOT match
 * `anthropic.com` and `notanthropic.com` does NOT match either.
 * @param {string} host
 * @param {string} domain
 * @returns {boolean}
 */
function hostMatchesDomain(host, domain) {
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Parses NASSAJ_ALLOWED_ANTHROPIC_HOSTS into a list of lowercased host entries.
 * Accepts either bare hosts ("proxy.example.com") or full URLs; a URL entry is
 * reduced to its hostname. Comma- and/or whitespace-separated.
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseAllowedHosts(raw) {
  const value = nonEmpty(raw);
  if (value === null) return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => {
      const e = entry.trim();
      if (e === '') return null;
      return parseHost(e) ?? e.toLowerCase();
    })
    .filter((e) => e !== null);
}

/**
 * Decides whether a base-URL host is approved under the allowlist for the given
 * environment. Pure and side-effect free (no throw) so it is independently
 * testable and reusable.
 *
 * @param {string} host lowercased hostname from a routing var
 * @param {NodeJS.ProcessEnv} env environment that will be handed to the subprocess
 * @param {string|null} [cloud] managed-cloud apex the host MUST fall under when
 *   the var is a dedicated cloud override (e.g. 'amazonaws.com'). When null (the
 *   generic ANTHROPIC_BASE_URL), either managed cloud is acceptable when its flag
 *   is on.
 * @param {Set<string>} [engineHosts] hostnames authorized for THIS spawn (ADR-037)
 * @returns {boolean}
 */
export function isAnthropicHostAllowed(host, env, cloud = null, engineHosts = null) {
  if (!host) return false;

  // 1. Official Anthropic hosts (apex + any subdomain) — always allowed.
  if (hostMatchesDomain(host, ANTHROPIC_APEX)) return true;
  // OFFICIAL_ANTHROPIC_HOSTS exact entries (defensive; normally api.anthropic.com).
  if (OFFICIAL_ANTHROPIC_HOSTS instanceof Set && OFFICIAL_ANTHROPIC_HOSTS.has(host)) {
    return true;
  }

  // 2. This spawn's engine provider host(s) (ADR-037), authorized by the caller.
  if (engineHosts instanceof Set && engineHosts.has(host)) return true;

  // 3. Managed-cloud endpoints, gated on the explicit mode flag being enabled.
  if (cloud === null) {
    if (isFlagEnabled(env.CLAUDE_CODE_USE_BEDROCK) && hostMatchesDomain(host, 'amazonaws.com')) {
      return true;
    }
    if (isFlagEnabled(env.CLAUDE_CODE_USE_VERTEX) && hostMatchesDomain(host, 'googleapis.com')) {
      return true;
    }
  } else {
    const flagEnabled =
      cloud === 'amazonaws.com'
        ? isFlagEnabled(env.CLAUDE_CODE_USE_BEDROCK)
        : cloud === 'googleapis.com'
          ? isFlagEnabled(env.CLAUDE_CODE_USE_VERTEX)
          : false;
    if (flagEnabled && hostMatchesDomain(host, cloud)) return true;
  }

  // 4. Operator-approved hosts via NASSAJ_ALLOWED_ANTHROPIC_HOSTS.
  for (const allowed of parseAllowedHosts(env.NASSAJ_ALLOWED_ANTHROPIC_HOSTS)) {
    if (hostMatchesDomain(host, allowed)) return true;
  }

  return false;
}

/**
 * Builds the fail-closed Error thrown when a base URL points at a non-approved
 * host (or is unparseable, or is an unrecognized routing var). The message is
 * crafted to satisfy both the legacy iron-rule contract (names the host /
 * NASSAJ_ALLOWED_ANTHROPIC_HOSTS) and the ADR-037 engine-path contract
 * ("disallowed host" / "not a parseable URL").
 *
 * @param {string} label the offending env var name / source label
 * @param {string} shown the offending host (or raw value when unparseable)
 * @param {string} [reason] optional clause appended (e.g. unrecognized-var note)
 * @param {boolean} [unparseable] true when the value could not be parsed as a URL
 * @returns {Error}
 */
function notAllowedError(label, shown, reason = '', unparseable = false) {
  const head = unparseable
    ? `Refusing to spawn Claude Code: ${label} is not a parseable URL (${shown}). ` +
      'Every *_BASE_URL must be a valid URL pointing at an allowed host. '
    : `Refusing to spawn Claude Code: ${label} points at a disallowed host "${shown}". `;
  const error = new Error(
    head +
      (reason ? `${reason} ` : '') +
      'The vendor-resilience iron rule forbids routing the Claude/Anthropic path to a non-Anthropic ' +
      'endpoint or masquerading another vendor as Claude. ' +
      'If this host is a legitimate Anthropic-backed proxy/gateway, add it to ' +
      'NASSAJ_ALLOWED_ANTHROPIC_HOSTS (comma-separated) — do NOT remove this guard.'
  );
  error.code = 'ANTHROPIC_BASE_URL_NOT_ALLOWED';
  return error;
}

/**
 * Validates an arbitrary env-like map (process env OR a settings.json `env`
 * block) against the iron rule. Pure w.r.t. the caller's env (reads only),
 * throws on the first violation.
 *
 * @param {Record<string, unknown>} env env-like map to validate
 * @param {NodeJS.ProcessEnv} flagEnv env consulted for the mode flags and the
 *   operator allowlist (same object as `env` for the process path; the merged
 *   effective env for a settings.json block).
 * @param {string} [sourceLabel] human label for error context (e.g. a file path)
 * @param {Set<string>} [engineHosts] hostnames authorized for THIS spawn (ADR-037)
 * @throws {Error} code ANTHROPIC_BASE_URL_NOT_ALLOWED on any violation
 */
function assertRoutingVarsAllowed(env, flagEnv, sourceLabel = '', engineHosts = null) {
  const where = sourceLabel ? ` (in ${sourceLabel})` : '';

  // 1. Known ANTHROPIC routing vars: each must resolve to an approved host.
  for (const { name, cloud } of ROUTING_VARS) {
    const raw = nonEmpty(env[name]);
    if (raw === null) continue; // unset -> default path, no-op.

    const host = parseHost(raw);
    if (host === null) {
      throw notAllowedError(`${name}${where}`, raw, '', true);
    }
    if (isAnthropicHostAllowed(host, flagEnv, cloud, engineHosts)) continue;

    throw notAllowedError(`${name}${where}`, host);
  }

  // 2. Any OTHER *_BASE_URL key is an override we do not understand -> reject
  //    (fail-closed). This catches both unrecognized ANTHROPIC_*/CLAUDE_* proxy
  //    knobs AND foreign vars like OPENAI_BASE_URL.
  for (const key of Object.keys(env)) {
    if (KNOWN_ROUTING_VARS.has(key)) continue;
    if (!BASE_URL_VAR_PATTERN.test(key)) continue;
    const raw = nonEmpty(env[key]);
    if (raw === null) continue; // empty -> harmless.

    const host = parseHost(raw);
    if (host === null) {
      throw notAllowedError(`${key}${where}`, raw, 'This is an unrecognized endpoint-routing override.', true);
    }
    // An unrecognized routing var is refused even if it points at an Anthropic
    // host: we only honor the explicitly-known routing knobs.
    throw notAllowedError(
      `${key}${where}`,
      host,
      'This is an unrecognized endpoint-routing override; the guard refuses unknown routing vars.'
    );
  }
}

/**
 * Fail-closed guard for the PROCESS / spawn env. Validates every base URL the
 * SDK will see — the known ANTHROPIC routing vars, any other *_BASE_URL key, and
 * any caller-collected settings.json base URLs (ctx.extraValues) — before the
 * env is forwarded to the Claude Code subprocess. No-op when nothing routes
 * (default Anthropic).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] environment headed to the subprocess
 * @param {{ engineProviderHosts?: Set<string>, extraValues?: string[] }} [ctx]
 *   ADR-037 context: hostnames authorized for this spawn and extra base-URL
 *   values (e.g. from settings.json) to vet with the same host logic.
 * @throws {Error} when any base URL points at a non-approved host
 */
export function assertAnthropicBaseUrlAllowed(env = process.env, ctx = {}) {
  const engineHosts = ctx && ctx.engineProviderHosts instanceof Set ? ctx.engineProviderHosts : null;

  // 1. Validate the spawn env's routing vars + any other *_BASE_URL keys.
  assertRoutingVarsAllowed(env, env, '', engineHosts);

  // 2. Validate caller-supplied extra base-URL values (settings.json channel).
  if (ctx && Array.isArray(ctx.extraValues)) {
    for (const value of ctx.extraValues) {
      const raw = nonEmpty(value);
      if (raw === null) continue;
      const host = parseHost(raw);
      if (host === null) {
        throw notAllowedError('settings.json *_BASE_URL', raw, '', true);
      }
      if (!isAnthropicHostAllowed(host, env, null, engineHosts)) {
        throw notAllowedError('settings.json *_BASE_URL', host);
      }
    }
  }
}

/**
 * Fail-closed guard for the PER-USER settings.json `env` block that the Claude
 * CLI applies downstream of the spawn env. Reads CLAUDE_CONFIG_DIR/settings.json
 * and validates its `env` routing vars under the SAME allowlist as the process
 * env — closing the bypass where a competitor base URL set in settings.json
 * reaches the subprocess undetected.
 *
 * Fail-closed details:
 *   - settings.json missing / unreadable / not an object / no `env` block -> no-op.
 *   - present & parseable but a routing var is disallowed -> throw.
 *   - present but INVALID JSON -> throw (cannot prove absence of an override).
 *
 * @param {string} claudeConfigDir absolute CLAUDE_CONFIG_DIR (dir of settings.json).
 *   Falsy -> no-op.
 * @param {NodeJS.ProcessEnv} [spawnEnv=process.env] effective spawn env, read only
 *   for the mode flags / operator allowlist (never mutated).
 * @throws {Error} code ANTHROPIC_BASE_URL_NOT_ALLOWED on any violation
 */
export function assertSettingsEnvAllowed(claudeConfigDir, spawnEnv = process.env) {
  if (!claudeConfigDir) return;

  const settingsPath = join(claudeConfigDir, 'settings.json');

  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch {
    return; // Missing / unreadable -> no settings env to honor. No-op.
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    const error = new Error(
      `Refusing to spawn Claude Code: ${settingsPath} is not valid JSON, so its env ` +
        'routing overrides cannot be validated against the vendor-resilience iron rule. ' +
        'Fix the file or remove it.'
    );
    error.code = 'ANTHROPIC_BASE_URL_NOT_ALLOWED';
    throw error;
  }

  const settingsEnv =
    settings && typeof settings === 'object' && !Array.isArray(settings) &&
    settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
      ? settings.env
      : null;
  if (!settingsEnv) return;

  // Effective env: a flag may live in either the spawn env or the settings env.
  const effectiveFlagEnv = { ...spawnEnv, ...settingsEnv };

  assertRoutingVarsAllowed(settingsEnv, effectiveFlagEnv, settingsPath);
}
