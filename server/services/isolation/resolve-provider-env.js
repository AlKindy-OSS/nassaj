/**
 * resolveProviderEnv(userId, provider) — central credential-isolation seam.
 *
 * Per ADR-014, this is the SOLE source of truth for isolating provider
 * credentials per user. Every provider spawn (claude/gemini/codex/agy) builds
 * its child-process environment through this function and no other path.
 *
 * Isolation model (Phase-MU):
 *   - claude:  CLAUDE_CONFIG_DIR=~/.nassaj-users/<userId>/.claude   (B-ISO-CLAUDE)
 *   - gemini:  GEMINI_CLI_HOME=~/.nassaj-users/<userId>/.gemini     (B-ISO-GEMINI)
 *   - codex:   CODEX_HOME=~/.nassaj-users/<userId>/.codex           (B-ISO-CODEX, wired)
 *   - agy:     HOME=~/.nassaj-users/<userId> so its brain store under
 *              ~/.gemini/antigravity-cli resolves into the isolated tree
 *   - opencode: XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_STATE_HOME all
 *              point into ~/.nassaj-users/<userId>/ so auth.json, opencode.db and
 *              config isolate at once while HOME stays operator (shared skills).
 *              In the GOVERNED CARRIER shape (mode==='agent', GL-4/ADR-062) —
 *              where opencode runs the custom `glm` provider — the resolved env is
 *              additionally passed through sanitizeVendorAgentEnv (SL-3) as its
 *              last step, stripping any inherited ANTHROPIC_ / CLAUDE_ namespace,
 *              the Claude OAuth token, and intrusive base-URL redirects. The
 *              default chat mode (the built-in anthropic
 *              DEFAULT_TARGET path) is byte-for-byte unchanged. The GLM key lives
 *              in auth.json, not env, so sanitizing never breaks the carrier.
 *   - cursor:  no env knob yet — shared
 *   - kimi/deepseek/glm: hosted third-party HTTP APIs that read no nassaj config
 *              tree. Their isolation is the OPPOSITE shape from the CLIs above:
 *              instead of pointing a CONFIG_DIR at the user's tree, we fetch the
 *              user's API key from the encrypted provider-secrets store and
 *              inject it as an explicit env VALUE (KIMI_API_KEY / DEEPSEEK_API_KEY
 *              / GLM_API_KEY) for the child process. IRON RULE: these cases must
 *              NEVER set ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, or any key
 *              under the ANTHROPIC or CLAUDE namespace — doing so would route a
 *              Claude client to a competitor. The base URL is hard-coded in each
 *              vendor's own HTTP client, not here.
 *   - kimi (AGENT mode only, SL-5/ADR-062): kimi ALSO ships a native CLI
 *              (@moonshot-ai/kimi-code) that, unlike the toolless chat path, reads
 *              AND writes credential/session state to disk under KIMI_CODE_HOME.
 *              When resolveProviderEnv is called with mode==='agent' for kimi we
 *              additionally point KIMI_CODE_HOME at ~/.nassaj-users/<userId>/.kimi
 *              (the KIMI_HOME_SUBDIR constant, imported from provision-user-dirs.js —
 *              the single source of truth shared with the code that materializes the
 *              tree, so the env var and the on-disk root can never drift; the root is
 *              .kimi, NOT .kimi-code, because .kimi-code/mcp.json is a SUBDIR of it)
 *              so that on-disk state isolates per user (the config-home shape of
 *              the CLIs above), on TOP of the KIMI_API_KEY value injection. The
 *              default (chat) mode is byte-for-byte unchanged — no KIMI_CODE_HOME.
 *              KIMI_CODE_HOME is outside the ANTHROPIC/CLAUDE namespace, so the
 *              IRON RULE above is preserved. deepseek/glm have no native CLI and
 *              ignore mode entirely.
 *
 * Whether a given provider is isolated at all is now an admin-configurable
 * policy (see services/provider-sharing.js). resolveProviderEnv consults
 * isProviderIsolated(provider) on every call: when a provider is marked
 * 'shared' the base (operator) environment is returned unchanged even for
 * claude/gemini/codex; when marked 'isolated' the per-user override is applied.
 * The default policy mirrors the original behavior (claude/gemini/codex
 * isolated, agy/cursor shared — ADR-016) so an install with no stored config is
 * unchanged.
 *
 * Conversations/instructions stay SHARED: provisionUserDirs symlinks each
 * per-user config dir's `projects/` and CLAUDE.md/NASSAJ.md back to the shared
 * root, so isolating credentials never forks the chat history or instructions.
 *
 * When userId is null/undefined (system/anonymous/platform-mode), no isolation
 * is applied and the base environment is returned unchanged — preserving the
 * single-user behavior the app had before multi-user.
 *
 * @typedef {'claude'|'gemini'|'codex'|'agy'|'cursor'|'opencode'|'hermes'|'kimi'|'deepseek'|'glm'} ProviderName
 *
 * Spawn mode for a provider (SL-5/ADR-062). 'chat' is the historical toolless
 * HTTP path (the default — identical to the pre-SL-5 behavior for EVERY
 * provider); 'agent' is the governed native-CLI path that some providers (kimi)
 * back with an isolated config-home. Providers with no native CLI ignore mode.
 * @typedef {'chat'|'agent'} ProviderMode
 */

import { isProviderIsolated } from '../provider-sharing.js';

import { applyOperatorPolicy } from './claude-managed-settings.js';
import { getProviderKey } from './provider-secrets-store.js';
import { provisionUserDirs, userConfigDir, KIMI_HOME_SUBDIR } from './provision-user-dirs.js';
import { sanitizeHostSecretEnv, sanitizeVendorAgentEnv } from './sanitize-vendor-agent-env.js';

/**
 * Maps each hosted vendor provider to the single env var its independent HTTP
 * client reads for the API key. These are deliberately provider-specific and
 * outside the ANTHROPIC and CLAUDE namespaces (iron rule).
 * @type {Record<string, string>}
 */
const VENDOR_KEY_ENV = Object.freeze({
  kimi: 'KIMI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  glm: 'GLM_API_KEY',
});

/**
 * INTERNAL. The historical resolver body: applies the per-user isolation knob
 * for `provider`. NOT exported — every caller goes through `resolveProviderEnv`
 * below, which adds the unconditional host-secret strip. Splitting it this way
 * means the strip cannot be bypassed by any of the eight `return` paths here,
 * nor by a provider case added later.
 *
 * @param {string|number|null} userId
 * @param {ProviderName} provider
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {ProviderMode} mode
 * @returns {NodeJS.ProcessEnv}
 */
function resolveIsolatedProviderEnv(userId, provider, baseEnv, mode) {
  const env = { ...baseEnv };

  // No authenticated user: return the base (shared) environment unchanged.
  if (userId === null || userId === undefined || userId === '') {
    return env;
  }

  // Admin policy gate: a provider marked 'shared' uses the operator's
  // credentials regardless of its case below — return base env unchanged.
  if (!isProviderIsolated(provider)) {
    return env;
  }

  switch (provider) {
    case 'claude': {
      // Ensure per-user config dir + shared symlinks exist before spawn.
      provisionUserDirs(userId);
      // B-14 / T-1023: seed/refresh operator policy (hooks, permissions,
      // cleanupPeriodDays, …) into both ~/.claude/managed-settings.json (Layer 1 —
      // the /etc symlink path Claude Code loads unconditionally) and the user's
      // own settings.json (Layer 2 — defense-in-depth, personal prefs preserved).
      // Runs on every spawn so policy changes propagate without server restart.
      applyOperatorPolicy(userConfigDir(userId, '.claude'));
      env.CLAUDE_CONFIG_DIR = userConfigDir(userId, '.claude');
      return env;
    }
    case 'gemini': {
      provisionUserDirs(userId);
      // gemini-cli resolves ~/.gemini relative to GEMINI_CLI_HOME (see
      // server/gemini-cli.js:83). Point it at the per-user home root so the
      // CLI's own ~/.gemini lands inside the isolated tree.
      env.GEMINI_CLI_HOME = userConfigDir(userId, '');
      return env;
    }
    case 'codex': {
      provisionUserDirs(userId);
      env.CODEX_HOME = userConfigDir(userId, '.codex');
      return env;
    }
    case 'agy': {
      // agy has no dedicated env knob: it resolves its brain store under
      // ~/.gemini/antigravity-cli relative to HOME. Overriding HOME to the
      // per-user root isolates the brain (and anything else agy keys off the
      // home dir) into the user's tree. agy-cli.js mirrors this by computing
      // its BRAIN_DIR from the same per-user home when isolated.
      provisionUserDirs(userId);
      env.HOME = userConfigDir(userId, '');
      return env;
    }
    case 'opencode': {
      // OC-07: opencode keys ALL of its per-user state off the XDG base dirs
      // (auth.json + opencode.db under XDG_DATA_HOME/opencode, config + agents
      // under XDG_CONFIG_HOME/opencode, plus cache/state). Redirecting the four
      // XDG_* vars into the user's isolated tree isolates every one of them at
      // once — the OPPOSITE of overriding HOME (agy): HOME stays the operator
      // home so opencode still reads the SHARED ~/.claude/skills library. The
      // reader-side helpers in opencode-home.ts resolve the same paths for the
      // synchronizer/watcher so isolated sessions are still indexed (no B-152).
      provisionUserDirs(userId);
      env.XDG_DATA_HOME = userConfigDir(userId, '.local/share');
      env.XDG_CONFIG_HOME = userConfigDir(userId, '.config');
      env.XDG_CACHE_HOME = userConfigDir(userId, '.cache');
      env.XDG_STATE_HOME = userConfigDir(userId, '.local/state');
      // GL-4 (ADR-062): opencode has TWO shapes. The historical DEFAULT_TARGET
      // path (chat / the built-in `anthropic` provider — mode defaults to 'chat')
      // is a first-party Anthropic client whose env MUST stay untouched. But in
      // the GOVERNED CARRIER shape (mode==='agent'), opencode runs the custom
      // `glm` provider (Anthropic-wire → api.z.ai). Gate OCC-2 confirmed that
      // @ai-sdk/anthropic inside opencode READS ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL
      // from the environment whenever its explicit options are absent — exactly
      // the kimi-native hazard (§2). So a leaked operator CLAUDE_CODE_OAUTH_TOKEN
      // or ANTHROPIC_BASE_URL could route the carrier through the owner's Claude
      // subscription (IRON RULE / ToS). Apply the shared SL-3 sanitizer as the
      // LAST step — ONLY in carrier (agent) mode. The GLM key lives in the
      // per-user auth.json (GL-1), NOT env, and the sanitizer deliberately keeps
      // the GLM_/ZAI_ namespaces anyway, so cleaning env never breaks the carrier
      // (OCC-2 mode (a)). Chat mode returns byte-for-byte as before.
      if (mode === 'agent') {
        return sanitizeVendorAgentEnv(env);
      }
      return env;
    }
    case 'kimi':
    case 'deepseek':
    case 'glm': {
      // Hosted vendor: inject the user's decrypted API key as the provider's own
      // env var. No CONFIG_DIR/HOME override — these APIs read no nassaj tree.
      // IRON RULE: only the provider-specific KEY var is ever set here; nothing
      // under the ANTHROPIC_*/CLAUDE_* namespace and no *_BASE_URL is touched.
      const apiKey = getProviderKey(userId, provider);
      if (apiKey) {
        env[VENDOR_KEY_ENV[provider]] = apiKey;
      }
      // SL-5 (ADR-062): kimi's native CLI (agent mode) reads AND writes credential
      // and session state to disk under KIMI_CODE_HOME. Isolate that config-home
      // per user so the on-disk state never leaks across users. This runs ONLY for
      // provider==='kimi' AND mode==='agent'; the default chat path (and every
      // deepseek/glm path in any mode) is byte-for-byte unchanged. KIMI_CODE_HOME
      // is outside the ANTHROPIC_*/CLAUDE_* namespace so the IRON RULE holds.
      if (provider === 'kimi' && mode === 'agent') {
        provisionUserDirs(userId);
        // KIMI_HOME_SUBDIR is the SINGLE source of truth for this root (exported by
        // provision-user-dirs.js, which materializes the very tree — sessions/ and
        // .kimi-code/mcp.json — beneath it). Reading the shared constant instead of a
        // literal makes env-var and on-disk layout impossible to drift apart, and any
        // future correction (the layout is field-CONFIRMED at G-KIMI-LIVE) a one-point edit.
        env.KIMI_CODE_HOME = userConfigDir(userId, KIMI_HOME_SUBDIR);
      }
      return env;
    }
    default:
      // cursor and any future providers: shared until explicitly isolated.
      return env;
  }
}

/**
 * Resolves the environment for spawning a provider CLI on behalf of a user.
 *
 * SEC-ENV-1 — HOST-SECRET STRIP (unconditional, every provider, every mode):
 * the resolver starts from `{ ...baseEnv }` (process.env by default), so before
 * this fix EVERY child provider process inherited nassaj's own secrets —
 * JWT_SECRET above all, plus DATABASE_PATH and NASSAJ_PROVIDER_SECRETS_KEY.
 * `sanitizeVendorAgentEnv` (SL-3) only ever ran on the kimi/glm carrier paths,
 * so claude / codex / gemini / agy / opencode / hermes / cursor inherited them
 * raw (e.g. openai-codex.js:535 passes this result straight into `new Codex({
 * env })`). One prompt-injected `env | grep JWT_SECRET` in any agent turn was a
 * full account-takeover primitive.
 *
 * The strip runs as the LAST step here — the SINGLE choke point every provider
 * spawn already funnels through (ADR-014) — rather than in the provider files,
 * so a new provider cannot be added and silently skip it. It removes ONLY
 * host-application secrets (see NASSAJ_HOST_SECRET_EXACT_DENY); PATH, HOME,
 * USER, LOGNAME, SHELL, LANG, TERM, TMPDIR, XDG_*, NODE_*, npm_* and every
 * isolation knob this function itself sets (CLAUDE_CONFIG_DIR / CODEX_HOME /
 * GEMINI_CLI_HOME / KIMI_CODE_HOME / HOME / the vendor KEY vars) are preserved,
 * so no provider loses anything it actually reads.
 *
 * Signature and every documented behavior are unchanged.
 *
 * @param {string|number|null} userId authenticated user id (null = system/anon)
 * @param {ProviderName} provider provider identifier
 * @param {NodeJS.ProcessEnv} [baseEnv] base environment to extend (defaults to process.env)
 * @param {ProviderMode} [mode] spawn mode (SL-5). Defaults to 'chat' so every
 *   existing 3-arg caller keeps its exact prior behavior. Only 'agent' unlocks
 *   the native-CLI config-home isolation (today: KIMI_CODE_HOME for kimi); any
 *   other value is treated as the legacy default.
 * @returns {NodeJS.ProcessEnv} env to pass to child_process spawn
 */
export function resolveProviderEnv(userId, provider, baseEnv = process.env, mode = 'chat') {
  return sanitizeHostSecretEnv(resolveIsolatedProviderEnv(userId, provider, baseEnv, mode));
}
