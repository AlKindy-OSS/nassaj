/**
 * provider-credential-env — the single list of environment names that carry a
 * provider credential or steer where a provider keeps its credential files.
 *
 * Dependency-free on purpose: the credential-isolation seam (resolve-provider-env.js)
 * and plain-node tooling (scripts/run-isolated-node-tests.mjs, the test env
 * wrapper) import the SAME list, so test isolation cannot drift from spawn
 * isolation (B-1771: a test run with the operator's environment rewrote a
 * member's live Claude credentials on 2026-11-09).
 */

/**
 * Credential variables a provider child must never INHERIT from the server
 * process (ADR-152 A1 §3.5). They are removed from the copy of the base env
 * before the per-provider case, for every actor; the resolver then injects only
 * the credential owner's own key. Launchers that deliberately set a key AFTER
 * the resolver (the engine pin, the per-turn OpenCode vendor keys) are unaffected.
 * @type {ReadonlyArray<string>}
 */
export const INHERITED_CREDENTIAL_ENV = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CURSOR_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'GLM_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  // qa M5: switches and cloud credentials that route Claude Code to Bedrock or
  // Vertex on the OPERATOR's cloud account. A member never inherits them.
  // ANTHROPIC_BASE_URL is deliberately NOT stripped: the iron-rule guard
  // (claude-spawn-env-guard / anthropic-base-url-guard) refuses an inherited
  // non-official host visibly, and the engine path sets its own after this.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_VERTEX_PROJECT_ID',
]);

/**
 * Env knobs that choose a provider's credential tree. The first group is every
 * root resolveProviderEnv sets (kept in parity by provider-credential-env.test.ts);
 * the rest are vendor-documented roots a test must not inherit either.
 * HOME itself is handled by callers (it is the primary knob for agy, cursor,
 * qwen, dsh and every dotfile credential such as ~/.hermes/auth.json).
 * @type {ReadonlyArray<string>}
 */
export const PROVIDER_STATE_ROOT_ENV = Object.freeze([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'KIMI_CODE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'QWEN_HOME',
  'KIMI_SHARE_DIR',
  'HERMES_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'CURSOR_CONFIG_DIR',
]);

/** Name suffixes that mark a value as a secret for ANY vendor, listed or not. */
const CREDENTIAL_NAME_SUFFIX = /_(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|SECRET_ACCESS_KEY)$/u;

/**
 * True when an inherited variable named `name` would hand a test or tool a
 * provider credential or a provider's real credential root.
 * @param {string} name
 * @returns {boolean}
 */
export function isProviderCredentialEnvName(name) {
  return INHERITED_CREDENTIAL_ENV.includes(name)
    || PROVIDER_STATE_ROOT_ENV.includes(name)
    || CREDENTIAL_NAME_SUFFIX.test(name);
}
