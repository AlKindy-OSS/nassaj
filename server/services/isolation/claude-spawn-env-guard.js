/**
 * The iron-rule check every Claude-body spawn env must pass (B-446).
 *
 * One function, shared by the central run profile (resolve-claude-run-profile.js)
 * and by spawn sites that cannot load the profile itself — the workflow unit's
 * task-runner runs out-of-process without the database. It validates the three
 * routing channels the Claude CLI honours: the spawn env's ANTHROPIC_* and other
 * *_BASE_URL vars, the per-user settings.json `env` block, and any base URL the
 * settings files declare. DB-free on purpose.
 *
 * B-1541: when the spawn is engine-pinned (ctx.engineHosts non-empty) it also
 * refuses if any source the CLI loads holds an Anthropic credential, because the
 * CLI would send it to the vendor host.
 */

import { assertAnthropicBaseUrlAllowed, assertSettingsEnvAllowed } from './anthropic-base-url-guard.js';
import { collectSettingsBaseUrls } from './collect-settings-base-urls.js';
import { assertNoAnthropicCredentialForEngine } from './engine-anthropic-credential-guard.js';

/**
 * Throws (code ANTHROPIC_BASE_URL_NOT_ALLOWED) when the env headed to a Claude
 * child would route it anywhere other than official Anthropic or the hosts the
 * resolved engine authorized.
 *
 * Also throws (code ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED) when the run is
 * engine-pinned and an Anthropic credential would reach the vendor (B-1541).
 *
 * @param {NodeJS.ProcessEnv} env the exact env the child will receive
 * @param {{ engineHosts?: Set<string>|null, cwd?: string|null,
 *   managedSettingsDir?: string }} [ctx] hosts
 *   authorized by the engine verdict (ADR-037; omitted ⇒ official Anthropic
 *   only) and the child's working directory (project/local settings live there;
 *   omitted ⇒ this process's cwd, which the child inherits); managedSettingsDir
 *   is a test seam only — production callers never pass it
 * @returns {Promise<void>}
 */
export async function assertClaudeSpawnEnvAllowed(env, ctx = {}) {
  assertSettingsEnvAllowed(env.CLAUDE_CONFIG_DIR, env);
  const settingsBaseUrls = await collectSettingsBaseUrls(env);
  assertAnthropicBaseUrlAllowed(env, {
    engineProviderHosts: ctx.engineHosts ?? undefined,
    extraValues: settingsBaseUrls,
  });
  // B-1541 activation keys on engineHosts: it is the engine verdict itself
  // (apply-claude-engine-provider-env set a vendor ANTHROPIC_BASE_URL + token),
  // so it is exactly the runs whose Anthropic credentials would reach a vendor.
  // The official path legitimately carries ANTHROPIC_API_KEY and must not be
  // refused. A host admitted via NASSAJ_ALLOWED_ANTHROPIC_HOSTS is deliberately
  // NOT treated as engine-pinned: that list is an operator-controlled gate for a
  // corporate Anthropic proxy that is meant to receive the operator's key.
  if (ctx.engineHosts instanceof Set && ctx.engineHosts.size > 0) {
    assertNoAnthropicCredentialForEngine(env, {
      cwd: ctx.cwd ?? null,
      managedSettingsDir: ctx.managedSettingsDir,
    });
  }
}
