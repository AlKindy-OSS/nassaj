/**
 * The iron-rule check every Claude-body spawn env must pass (B-446).
 *
 * One function, shared by the central run profile (resolve-claude-run-profile.js)
 * and by spawn sites that cannot load the profile itself — the workflow unit's
 * task-runner runs out-of-process without the database. It validates the two
 * routing channels the Claude CLI honours: the spawn env's ANTHROPIC_* and other
 * *_BASE_URL vars, and the `env` block of EVERY settings file the CLI loads for
 * the spawn's cwd. DB-free on purpose.
 *
 * B-1764: the settings channel used to cover only CLAUDE_CONFIG_DIR/settings.json.
 * The CLI also loads project, local and managed settings, so a base URL one member
 * planted in a shared project reached another member's spawn with that member's
 * subscription login. The file set now comes from claudeSpawnSettingsFiles — the
 * same list the B-1541 guard and the permission mirrors read.
 *
 * B-1541: when the spawn is engine-pinned (ctx.engineHosts non-empty, or
 * ctx.engineOrigins non-empty for a local model server, ADR-227) it also refuses
 * if any source the CLI loads holds an Anthropic credential, because the CLI
 * would send it to the engine.
 */

import { assertAnthropicBaseUrlAllowed, assertSettingsRoutingAllowed } from './anthropic-base-url-guard.js';
import { readClaudeSpawnSettings } from './claude-spawn-settings.js';
import { assertNoAnthropicCredentialForEngine } from './engine-anthropic-credential-guard.js';

/**
 * Throws (code ANTHROPIC_BASE_URL_NOT_ALLOWED) when any settings file the Claude
 * CLI loads for this spawn — managed policy (managed-settings.json and
 * managed-settings.d/*.json), user, project and local, at the cwd and its git
 * root — routes it away from official Anthropic. A file that exists but cannot be
 * read or parsed refuses the spawn: absence of an override cannot be proven.
 *
 * Use this alone where the spawn env was already vetted with its engine verdict
 * (the managed terminal wrapper re-checking a broker-resolved env).
 *
 * @param {NodeJS.ProcessEnv} env the exact env the child will receive (HOME /
 *   CLAUDE_CONFIG_DIR locate the user tier; flags and the operator allowlist)
 * @param {{ cwd?: string|null, managedSettingsDir?: string,
 *   engineOrigins?: Set<string>|null }} [ctx] the child's
 *   working directory (omitted ⇒ this process's cwd, which the child inherits);
 *   engineOrigins non-empty marks a local-engine spawn, on which no settings file
 *   may route at all (ADR-227); managedSettingsDir is a test seam only
 * @returns {void}
 */
export function assertClaudeSettingsRoutingAllowed(env, ctx = {}) {
  const localEngine = hasLocalEngineOrigins(ctx.engineOrigins);
  const sources = readClaudeSpawnSettings(env, ctx.cwd ?? null, { managedSettingsDir: ctx.managedSettingsDir });
  for (const source of sources) {
    if (source.status === 'missing') continue;
    if (source.status !== 'ok') {
      const error = new Error(
        `Refusing to spawn Claude Code: ${source.label} (${source.file}) exists but cannot be read ` +
          'as a JSON object, so its env routing overrides cannot be validated against the ' +
          'vendor-resilience iron rule. Fix the file or remove it.'
      );
      error.code = 'ANTHROPIC_BASE_URL_NOT_ALLOWED';
      throw error;
    }
    assertSettingsRoutingAllowed(source.settings, env, `${source.label} ${source.file}`, { localEngine });
  }
}

/**
 * True when a local-engine origin set was authorized for this spawn.
 * @param {unknown} origins
 * @returns {boolean}
 */
function hasLocalEngineOrigins(origins) {
  return origins instanceof Set && origins.size > 0;
}

/**
 * True when the spawn runs on an engine (vendor host or local origin), i.e. the
 * runs whose Anthropic credentials would reach a non-Anthropic endpoint.
 * @param {{ engineHosts?: Set<string>|null, engineOrigins?: Set<string>|null }} verdict
 * @returns {boolean}
 */
export function isEngineRoutedVerdict(verdict) {
  return (verdict?.engineHosts instanceof Set && verdict.engineHosts.size > 0)
    || hasLocalEngineOrigins(verdict?.engineOrigins);
}

/**
 * Throws (code ANTHROPIC_BASE_URL_NOT_ALLOWED) when the env headed to a Claude
 * child, or any settings file it will load, would route it anywhere other than
 * official Anthropic or the hosts the resolved engine authorized.
 *
 * Also throws (code ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED) when the run is
 * engine-pinned and an Anthropic credential would reach the vendor (B-1541).
 *
 * @param {NodeJS.ProcessEnv} env the exact env the child will receive
 * @param {{ engineHosts?: Set<string>|null, engineOrigins?: Set<string>|null,
 *   cwd?: string|null, managedSettingsDir?: string }} [ctx] hosts
 *   authorized by the engine verdict (ADR-037; omitted ⇒ official Anthropic
 *   only), origins authorized by the local-engine verdict (ADR-227) and the
 *   child's working directory (project/local settings live there;
 *   omitted ⇒ this process's cwd, which the child inherits); managedSettingsDir
 *   is a test seam only — production callers never pass it
 * @returns {Promise<void>}
 */
export async function assertClaudeSpawnEnvAllowed(env, ctx = {}) {
  assertAnthropicBaseUrlAllowed(env, {
    engineProviderHosts: ctx.engineHosts ?? undefined,
    engineOrigins: ctx.engineOrigins ?? undefined,
  });
  // B-1541 activation keys on engineHosts: it is the engine verdict itself
  // (apply-claude-engine-provider-env set a vendor ANTHROPIC_BASE_URL + token),
  // so it is exactly the runs whose Anthropic credentials would reach a vendor.
  // The official path legitimately carries ANTHROPIC_API_KEY and must not be
  // refused. A host admitted via NASSAJ_ALLOWED_ANTHROPIC_HOSTS is deliberately
  // NOT treated as engine-pinned: that list is an operator-controlled gate for a
  // corporate Anthropic proxy that is meant to receive the operator's key.
  if (isEngineRoutedVerdict(ctx)) {
    assertNoAnthropicCredentialForEngine(env, {
      cwd: ctx.cwd ?? null,
      managedSettingsDir: ctx.managedSettingsDir,
      localEngine: hasLocalEngineOrigins(ctx.engineOrigins),
    });
  }
  // After B-1541 so a pinned run's credential findings keep their own code; both refuse.
  assertClaudeSettingsRoutingAllowed(env, ctx);
}
