/**
 * resolveProviderEnv(userId, provider) — central credential-isolation seam.
 *
 * Per ADR-014, this is the SOLE source of truth for isolating provider
 * credentials per user. Every provider spawn (claude/gemini/codex/agy) builds
 * its child-process environment through this function and no other path.
 *
 * Isolation model (Phase-MU):
 *   - claude:  CLAUDE_CONFIG_DIR=~/.nassaj-users/<userId>/.claude   (B-ISO-CLAUDE)
 *   - gemini:  HOME=~/.nassaj-users/<userId> — same knob as agy, and for the
 *              same reason: the CLI reads no dedicated env var. This used to set
 *              GEMINI_CLI_HOME, which NOTHING reads (B-548, measured — see the
 *              `case 'gemini'` body); the variable reached the spawn and was
 *              ignored, so every member's gemini turn ran on the OPERATOR's
 *              ~/.gemini credentials.
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
 *   - cursor:  HOME=~/.nassaj-users/<userId> — cursor-agent has no dedicated env
 *              knob, but it derives every path it uses from $HOME (login + chat
 *              state in ~/.cursor, its own install under ~/.local/share/cursor-agent),
 *              so the HOME override isolates all of them at once, like agy. The
 *              binary stays reachable because PATH is inherited untouched.
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
 * The default policy is now 'isolated' for every provider that HAS an isolation
 * case (ADR-105, superseding the ADR-016 default): nassaj is open source, so a
 * fresh install belongs to somebody else's team, and defaulting to shared there
 * spends one person's credentials on another's work.
 *
 * Conversations/instructions stay SHARED: provisionUserDirs symlinks each
 * per-user config dir's `projects/` and CLAUDE.md/NASSAJ.md back to the shared
 * root, so isolating credentials never forks the chat history or instructions.
 *
 * When userId is null/undefined (system/anonymous/platform-mode), no isolation
 * is applied and the base environment is returned unchanged — preserving the
 * single-user behavior the app had before multi-user.
 *
 * @typedef {'claude'|'gemini'|'codex'|'agy'|'cursor'|'opencode'|'hermes'|'kimi'|'deepseek'|'glm'|'qwen'} ProviderName
 *
 * Spawn mode for a provider (SL-5/ADR-062). 'chat' is the historical toolless
 * HTTP path (the default — identical to the pre-SL-5 behavior for EVERY
 * provider); 'agent' is the governed native-CLI path that some providers (kimi)
 * back with an isolated config-home. Providers with no native CLI ignore mode.
 * @typedef {'chat'|'agent'} ProviderMode
 */

import path from 'path';

import { AppError } from '../../shared/utils.js';
import { isProviderIsolated, KNOWN_PROVIDERS } from '../provider-sharing.js';

import { applyOperatorPolicy } from './claude-managed-settings.js';
import { listDelegatedOwners, listDelegatedProvidersFromOwner, resolveCredentialPrincipal } from './credential-principal.js';
import { materializeGrantHome, sweepGrantHomes } from './grant-home.js';
import { resolveSlotKey } from './provider-slot-key.js';
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
function resolveIsolatedProviderEnv(userId, provider, baseEnv, mode, honorGrants) {
  const env = { ...baseEnv };

  // No authenticated user: return the base (shared) environment unchanged.
  if (userId === null || userId === undefined || userId === '') {
    return env;
  }

  // ADR-105 — a provider the policy has never heard of is REFUSED, not silently
  // treated as shared. This gate used to answer `policy[provider] === 'isolated'`,
  // which is false for an unknown key, so a provider missing from KNOWN_PROVIDERS
  // took the operator's environment through the early return below and never
  // reached the switch at all. hermes has been doing exactly that: it is absent
  // from the policy, so neither the admin panel nor the `default:` branch could
  // see it, and every member's hermes turn ran on the operator's login.
  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new AppError(
      `Provider "${provider}" is not covered by the credential-isolation policy, so it cannot run `
        + 'on your account. Running it would spend the operator\'s credentials on your work.',
      { code: 'PROVIDER_ISOLATION_UNAVAILABLE', statusCode: 501 },
    );
  }

  // Admin policy gate: a provider marked 'shared' uses the operator's
  // credentials regardless of its case below — return base env unchanged.
  if (!isProviderIsolated(provider)) {
    return env;
  }

  // T-1675 / ADR-152 — WHOSE credential this spawn runs on. Isolation is the
  // base, so this is the caller's own id unless another member delegated their
  // credential to them for this provider (`honorGrants`, the default; PTY
  // terminals pass false and always run on the caller's own credential, so no
  // TERMINAL login can land in the owner's tree; agent turns DO run on the
  // owner's credential by design, and a copy taken there outlives the grant —
  // ADR-152 says so, and so does the settings page before a grant is made).
  //   • dedicated-knob providers (claude/codex/kimi-agent/vendor keys) point at
  //     the OWNER's provider dir or key directly;
  //   • HOME/XDG-steered providers get a GRANT HOME: the caller's own tree with
  //     only the granted provider dirs linked to the owner's (grant-home.js) —
  //     never the owner's root, which holds every other credential they have.
  const { principalId: credentialUserId, grantedBy } = honorGrants
    ? resolveCredentialPrincipal(userId, provider)
    : { principalId: userId, grantedBy: null };
  /** HOME for a HOME/XDG-steered provider: own root, or the grant home. */
  const homeRoot = () => {
    provisionUserDirs(userId);
    // Drop grant homes of owners this member no longer runs on (revoked,
    // declined, disabled or deleted) — the mirror must not outlive its grants.
    if (honorGrants) sweepGrantHomes(userId, listDelegatedOwners(userId));
    if (grantedBy === null) {
      return userConfigDir(userId, '');
    }
    provisionUserDirs(grantedBy);
    return materializeGrantHome(userId, grantedBy, listDelegatedProvidersFromOwner(userId, grantedBy));
  };

  switch (provider) {
    case 'claude': {
      // Ensure per-user config dir + shared symlinks exist before spawn.
      provisionUserDirs(credentialUserId);
      // B-14 / T-1023: seed/refresh operator policy (hooks, permissions,
      // cleanupPeriodDays, …) into both ~/.claude/managed-settings.json (Layer 1 —
      // the /etc symlink path Claude Code loads unconditionally) and the user's
      // own settings.json (Layer 2 — defense-in-depth, personal prefs preserved).
      // Runs on every spawn so policy changes propagate without server restart.
      // Under a grant this writes into the OWNER's tree on the grantee's behalf:
      // deliberate — it is the same idempotent operator policy the owner's own
      // spawn would seed, so the tree the turn runs in is never unpoliced.
      applyOperatorPolicy(userConfigDir(credentialUserId, '.claude'));
      env.CLAUDE_CONFIG_DIR = userConfigDir(credentialUserId, '.claude');
      // T-1749/ADR-159 D2: disable Claude Code's BUILT-IN auto-updater in the
      // governed spawn env. The server owns harness updates (the allowlisted
      // HARNESS_UPDATE_DESCRIPTORS path, gated on no-live-session + the digest
      // pin); a CLI self-update at launch runs OUTSIDE that gate and would either
      // swap in unverified bytes or leave a sha256 the next pinned spawn refuses
      // fail-closed. DISABLE_AUTOUPDATER is the documented Anthropic knob (Claude
      // Code settings). This is the ONLY built-in-updater flag verified for wiring
      // today; the other harnesses' disable knobs are unverified and stay OFF —
      // the server scheduler is their single controlled update path.
      env.DISABLE_AUTOUPDATER = '1';
      return env;
    }
    case 'gemini': {
      // T-1749/ADR-159 D1: gemini is removed as a DISPATCHABLE provider (registry
      // + WS branch), so no chat turn reaches here with provider='gemini' any
      // more. This case is KEPT because 'gemini' is also agy's on-disk credential
      // UNIT (~/.gemini/antigravity-cli — credential-principal.js maps agy→gemini,
      // grant-home.js links `.gemini`): the grant/isolation machinery resolves the
      // unit through this HOME override. agy's own `case 'agy'` is identical, and
      // both point HOME at the isolated per-user tree. HOME is the only knob that
      // moves this CLI's tree (B-548, measured).
      env.HOME = homeRoot();
      return env;
    }
    case 'codex': {
      provisionUserDirs(credentialUserId);
      env.CODEX_HOME = userConfigDir(credentialUserId, '.codex');
      return env;
    }
    case 'agy': {
      // agy has no dedicated env knob: it resolves its brain store under
      // ~/.gemini/antigravity-cli relative to HOME. Overriding HOME to the
      // per-user root isolates the brain (and anything else agy keys off the
      // home dir) into the user's tree. agy-cli.js mirrors this by computing
      // its BRAIN_DIR from the same per-user home when isolated.
      env.HOME = homeRoot();
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
      // Under a grant only the DATA home (auth.json + opencode.db) follows the
      // owner, through the grant home; config, cache and state stay the caller's.
      env.XDG_DATA_HOME = path.join(homeRoot(), '.local', 'share');
      env.XDG_CONFIG_HOME = userConfigDir(userId, '.config');
      env.XDG_CACHE_HOME = userConfigDir(userId, '.cache');
      env.XDG_STATE_HOME = userConfigDir(userId, '.local/state');
      // T-1749/ADR-159 D2: disable opencode's BUILT-IN auto-updater (verified
      // env knob in the pinned binary). opencode is digest-pinned, so a launch
      // self-update would change the sha256 and the next governed spawn would
      // refuse fail-closed; the server scheduler owns updates instead.
      env.OPENCODE_DISABLE_AUTOUPDATE = '1';
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
    case 'hermes': {
      // hermes has no env knob either: it resolves ~/.hermes from HOME and keeps
      // its OAuth (auth.json), its transcripts (sessions/, state.db) and its
      // caches there. Overriding HOME isolates the credential and the history
      // together, while provisionUserDirs links the operator's config.yaml and
      // bin/ back in so the member inherits the model endpoints and helper tools
      // without inheriting the account.
      const hermesRoot = homeRoot();
      env.HOME = hermesRoot;
      // T-1749 / ADR-159 D3: also set HERMES_HOME explicitly (parity with
      // CLAUDE_CONFIG_DIR / CODEX_HOME / KIMI_CODE_HOME). HOME already isolates
      // ~/.hermes; naming the dedicated knob too makes the isolation independent
      // of the CLI keeping its "~/.hermes derived from HOME" behaviour, and it is
      // the same knob the isolated-cli-cage sandbox already passes through. Stays
      // outside the ANTHROPIC_*/CLAUDE_* namespace so the IRON RULE holds.
      env.HERMES_HOME = path.join(hermesRoot, '.hermes');
      return env;
    }
    case 'cursor': {
      // cursor-agent keeps EVERYTHING under $HOME: the installer puts the binary
      // in ~/.local/share/cursor-agent, and the CLI writes its login and chat
      // state under ~/.cursor. There is no dedicated env knob, so — exactly like
      // agy — overriding HOME moves every one of those paths into the user's own
      // tree at once. Verified against the published installer, which derives all
      // five of its paths from $HOME.
      //
      // The binary itself lives in the OPERATOR's ~/.local/bin, which the child
      // still reaches through PATH: PATH is inherited from the server process and
      // is not rewritten here, so a per-user HOME does not hide the executable.
      env.HOME = homeRoot();
      return env;
    }
    case 'qwen': {
      // ADR-101/T-1374: Qwen Code keeps user state under ~/.qwen. Its package is
      // not installed on this host, so no dedicated QWEN_* variable has been
      // measured. HOME is the fail-closed isolation primitive: it moves the
      // entire user tree without relying on an assumed vendor-specific knob.
      // Credential injection is intentionally absent; the future launcher must
      // consume the personal `sk-sp-*` slot through its measured auth contract.
      env.HOME = homeRoot();
      return env;
    }
    case 'kimi':
    case 'deepseek':
    case 'glm': {
      // Hosted vendor: inject the user's decrypted API key as the provider's own
      // env var. No CONFIG_DIR/HOME override — these APIs read no nassaj tree.
      // IRON RULE: only the provider-specific KEY var is ever set here; nothing
      // under the ANTHROPIC_*/CLAUDE_* namespace and no *_BASE_URL is touched.
      // T-1260: `sharedFallback: false` is this site's behaviour PRESERVED, not
      // chosen — a member with no key of their own gets no key here today, and
      // the run then fails with `missing_key`. Whether that should match the
      // engine path (which does fall back, T-1208) is a wave-B decision; making
      // it here would be a silent spending change under a refactor.
      const resolved = resolveSlotKey(credentialUserId, provider, { sharedFallback: false });
      if (resolved) {
        env[VENDOR_KEY_ENV[provider]] = resolved.key;
      }
      // SL-5 (ADR-062): kimi's native CLI (agent mode) reads AND writes credential
      // and session state to disk under KIMI_CODE_HOME. Isolate that config-home
      // per user so the on-disk state never leaks across users. This runs ONLY for
      // provider==='kimi' AND mode==='agent'; the default chat path (and every
      // deepseek/glm path in any mode) is byte-for-byte unchanged. KIMI_CODE_HOME
      // is outside the ANTHROPIC_*/CLAUDE_* namespace so the IRON RULE holds.
      if (provider === 'kimi' && mode === 'agent') {
        provisionUserDirs(credentialUserId);
        // KIMI_HOME_SUBDIR is the SINGLE source of truth for this root (exported by
        // provision-user-dirs.js, which materializes the very tree — sessions/ and
        // .kimi-code/mcp.json — beneath it). Reading the shared constant instead of a
        // literal makes env-var and on-disk layout impossible to drift apart, and any
        // future correction (the layout is field-CONFIRMED at G-KIMI-LIVE) a one-point edit.
        env.KIMI_CODE_HOME = userConfigDir(credentialUserId, KIMI_HOME_SUBDIR);
      }
      return env;
    }
    default:
      // ADR-105 — a provider with no isolation case does NOT fall back to the
      // operator's environment. That default was fail-OPEN: it silently ran one
      // member's work on another person's credentials, and it applied to every
      // provider anyone forgot to wire (hermes reaches this line today, and any
      // provider added tomorrow would too).
      //
      // Refusing here is deliberately louder than hiding the provider: the
      // member is told the provider has no per-user path yet, instead of
      // wondering why it vanished. The settings screen already reports the same
      // fact ("no isolation path on the server").
      throw new AppError(
        `Provider "${provider}" has no per-user isolation path, so it cannot run on your account. `
          + 'Running it would spend the operator\'s credentials on your work. '
          + 'It stays unavailable until isolation is implemented for it.',
        { code: 'PROVIDER_ISOLATION_UNAVAILABLE', statusCode: 501 },
      );
  }
}

/**
 * Applies the built-in updater kill switches to every credential mode. These
 * flags govern the binary itself, so shared/system launches need them just as
 * much as isolated member launches do.
 * @param {ProviderName} provider
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function applyHarnessUpdaterPolicy(provider, env) {
  if (provider === 'claude') env.DISABLE_AUTOUPDATER = '1';
  if (provider === 'opencode') env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  return env;
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
 * KIMI_CODE_HOME / HOME / the vendor KEY vars) are preserved, so no provider
 * loses anything it actually reads.
 *
 * Signature and every documented behavior are unchanged.
 *
 * @param {string|number|null} userId authenticated user id (null = system/anon)
 * @param {ProviderName} provider provider identifier
 * @param {NodeJS.ProcessEnv} [baseEnv] base environment to extend (defaults to process.env)
 * @param {{ honorGrants?: boolean }} [options] `honorGrants: false` ignores
 *   credential grants (T-1675) and builds the caller's OWN environment — for PTY
 *   terminals, where an interactive login must never reach a grantor's tree, and
 *   for home enumeration that must see every member's own tree.
 * @param {ProviderMode} [mode] spawn mode (SL-5). Defaults to 'chat' so every
 *   existing 3-arg caller keeps its exact prior behavior. Only 'agent' unlocks
 *   the native-CLI config-home isolation (today: KIMI_CODE_HOME for kimi); any
 *   other value is treated as the legacy default.
 * @returns {NodeJS.ProcessEnv} env to pass to child_process spawn
 */
export function resolveProviderEnv(userId, provider, baseEnv = process.env, mode = 'chat', options = {}) {
  const honorGrants = options.honorGrants !== false;
  const resolved = resolveIsolatedProviderEnv(userId, provider, baseEnv, mode, honorGrants);
  return sanitizeHostSecretEnv(applyHarnessUpdaterPolicy(provider, resolved));
}
