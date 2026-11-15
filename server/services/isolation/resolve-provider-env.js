/**
 * resolveProviderEnv(userId, provider) — central credential-isolation seam.
 *
 * Per ADR-014, this is the SOLE source of truth for isolating provider
 * credentials per user. Every provider spawn (claude/codex/agy/…) builds
 * its child-process environment through this function and no other path.
 *
 * Isolation model (Phase-MU):
 *   - claude:  CLAUDE_CONFIG_DIR=~/.nassaj-users/<userId>/.claude   (B-ISO-CLAUDE)
 *   - codex:   CODEX_HOME=~/.nassaj-users/<userId>/.codex           (B-ISO-CODEX, wired)
 *   - agy:     HOME=~/.nassaj-users/<userId> so its brain store under
 *              ~/.gemini/antigravity-cli resolves into the isolated tree (HOME is
 *              the only knob it reads, B-548 — measured)
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
 *              kimi/deepseek/glm have no native CLI here and ignore mode entirely
 *              (the kimi native agent body was removed, ADR-229).
 *
 * Every known provider is ALWAYS isolated per user (ADR-152 amendment 1): the
 * install-wide sharing policy is retired, no role or stored value can return
 * the operator environment to a member, and another member's credential is
 * reachable only through a grant its owner made (credential-principal.js).
 *
 * Conversations/instructions stay SHARED: provisionUserDirs symlinks each
 * per-user config dir's `projects/` and CLAUDE.md/NASSAJ.md back to the shared
 * root, so isolating credentials never forks the chat history or instructions.
 *
 * Every call names its ACTOR (credential-actor.js, ADR-152 A1 §3.4): a member
 * id, or SYSTEM_ACTOR for non-inference work, which gets a credential-less tree
 * under ~/.nassaj-users/.system/. A missing actor (null, undefined, '', 0, …)
 * throws CREDENTIAL_ACTOR_REQUIRED and builds no environment — there is no
 * "anonymous means operator" path any more.
 *
 * @typedef {'claude'|'codex'|'agy'|'cursor'|'opencode'|'kimi'|'deepseek'|'glm'|'qwen'|'dsh'} ProviderName
 *
 * Spawn mode for a provider (SL-5/ADR-062). 'chat' is the historical toolless
 * HTTP path (the default — identical to the pre-SL-5 behavior for EVERY
 * provider); 'agent' is the governed native-CLI path (opencode sanitizes its
 * env for it). Providers with no native CLI ignore mode.
 * @typedef {'chat'|'agent'} ProviderMode
 */

import path from 'path';

import { AppError } from '../../shared/utils.js';

import { applyOperatorPolicy } from './claude-managed-settings.js';
import { SYSTEM_ACTOR, normalizeCredentialActor, systemActorHome } from './credential-actor.js';
import { KNOWN_PROVIDERS } from './known-providers.js';
import { INHERITED_CREDENTIAL_ENV } from './provider-credential-env.js';
import { listDelegatedOwners, listDelegatedProvidersFromOwner, resolveCredentialPrincipal } from './credential-principal.js';
import { materializeGrantHome, sweepGrantHomes } from './grant-home.js';
import { resolveSlotKey } from './provider-slot-key.js';
import { provisionUserDirs, userConfigDir } from './provision-user-dirs.js';
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

// The list lives in a dependency-free module so test tooling imports the same names (B-1771).
export { INHERITED_CREDENTIAL_ENV };

/**
 * B-1745: providers steered by HOME alone. The resolver sets no XDG_* for them,
 * so an inherited XDG base dir would point their config/data/state/cache at the
 * OPERATOR's tree. They are removed for every actor.
 * @type {ReadonlySet<string>}
 */
const HOME_STEERED_PROVIDERS = new Set(['agy', 'cursor', 'qwen', 'dsh']);
const XDG_BASE_DIRS = Object.freeze(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']);

/**
 * INTERNAL. The historical resolver body: applies the per-user isolation knob
 * for `provider`. NOT exported — every caller goes through `resolveProviderEnv`
 * below, which adds the unconditional host-secret strip. Splitting it this way
 * means the strip cannot be bypassed by any of the eight `return` paths here,
 * nor by a provider case added later.
 *
 * @param {unknown} actor member id or SYSTEM_ACTOR (credential-actor.js)
 * @param {ProviderName} provider
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {ProviderMode} mode
 * @returns {NodeJS.ProcessEnv}
 */
function resolveIsolatedProviderEnv(actor, provider, baseEnv, mode, honorGrants) {
  // ADR-152 A1 §3.4: the actor check comes first; a missing actor throws before
  // any environment exists.
  const normalized = normalizeCredentialActor(actor);
  const env = { ...baseEnv };
  // ADR-152 A1 §3.5: no inherited credential survives into any child.
  for (const name of INHERITED_CREDENTIAL_ENV) delete env[name];
  if (HOME_STEERED_PROVIDERS.has(provider)) {
    for (const name of XDG_BASE_DIRS) delete env[name];
  }

  // ADR-105 — a provider outside KNOWN_PROVIDERS is REFUSED, never handed the
  // operator's environment.
  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new AppError(
      `Provider "${provider}" is not covered by the credential-isolation policy, so it cannot run `
        + 'on your account. Running it would spend the operator\'s credentials on your work.',
      { code: 'PROVIDER_ISOLATION_UNAVAILABLE', statusCode: 501 },
    );
  }

  if (normalized === SYSTEM_ACTOR) {
    return systemActorEnv(provider, env, mode);
  }
  const userId = normalized;

  // T-1675 / ADR-152 — WHOSE credential this spawn runs on. Isolation is the
  // base, so this is the caller's own id unless another member delegated their
  // credential to them for this provider (`honorGrants`, the default; PTY
  // terminals pass false and always run on the caller's own credential, so no
  // TERMINAL login can land in the owner's tree; agent turns DO run on the
  // owner's credential by design, and a copy taken there outlives the grant —
  // ADR-152 says so, and so does the settings page before a grant is made).
  //   • dedicated-knob providers (claude/codex/vendor keys) point at
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
    case 'dsh': {
      // T-2086/ADR-224: the DeepSeek Harness keys every path off HOME (its
      // DSH_HOME / DSH_AGENTS_HOME / TMPDIR are derived from it by the dsh
      // launcher, which rebuilds the child env from an allow-list). dsh is an
      // OWN-credential body: HOME is always the member's own tree (never a grant
      // home) and the key is the member's own deepseek slot, whatever grants
      // exist. No XDG_* (HOME_STEERED_PROVIDERS) and no *_BASE_URL is ever set.
      provisionUserDirs(userId);
      env.HOME = userConfigDir(userId, '');
      const resolved = resolveSlotKey(userId, 'deepseek');
      if (resolved) env.DEEPSEEK_API_KEY = resolved.key;
      return env;
    }
    case 'kimi':
    case 'deepseek':
    case 'glm': {
      // Hosted vendor: inject the user's decrypted API key as the provider's own
      // env var. No CONFIG_DIR/HOME override — these APIs read no nassaj tree.
      // IRON RULE: only the provider-specific KEY var is ever set here; nothing
      // under the ANTHROPIC_*/CLAUDE_* namespace and no *_BASE_URL is touched.
      // The principal's own key only (ADR-152 A1 §3.8): the install-wide slot is
      // inert, so a member with no key and no grant gets no key here.
      const resolved = resolveSlotKey(credentialUserId, provider);
      if (resolved) {
        env[VENDOR_KEY_ENV[provider]] = resolved.key;
      }
      return env;
    }
    default:
      // ADR-105 — a provider with no isolation case does NOT fall back to the
      // operator's environment. That default was fail-OPEN: it silently ran one
      // member's work on another person's credentials, and it applied to every
      // provider anyone forgot to wire (any provider added tomorrow would reach
      // this line too).
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
 * The SYSTEM_ACTOR environment (ADR-152 A1 §3.4, D2): every provider knob points
 * into the credential-less ~/.nassaj-users/.system/ tree, never the OS user's
 * own credential tree, and no vendor key is injected. For non-inference work
 * only (version, install, update, empty-catalog probes).
 *
 * @param {ProviderName} provider
 * @param {NodeJS.ProcessEnv} env copy of the base env (mutated)
 * @param {ProviderMode} mode
 * @returns {NodeJS.ProcessEnv}
 */
function systemActorEnv(provider, env, mode) {
  const root = systemActorHome();
  switch (provider) {
    case 'claude':
      env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
      return env;
    case 'codex':
      env.CODEX_HOME = path.join(root, '.codex');
      return env;
    case 'agy':
    case 'cursor':
    case 'qwen':
    case 'dsh':
      env.HOME = root;
      return env;
    case 'opencode':
      env.XDG_DATA_HOME = path.join(root, '.local', 'share');
      env.XDG_CONFIG_HOME = path.join(root, '.config');
      env.XDG_CACHE_HOME = path.join(root, '.cache');
      env.XDG_STATE_HOME = path.join(root, '.local', 'state');
      return mode === 'agent' ? sanitizeVendorAgentEnv(env) : env;
    default:
      // kimi/deepseek/glm: hosted APIs with no tree; the system actor has no key.
      return env;
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
 * Shell bookkeeping variables that describe the SERVER's own working directory.
 * `PWD` is the pm2 launch root (the live server root); a child spawned with a
 * different `cwd` inherits it unchanged because only a shell rewrites it.
 */
const INHERITED_WORKING_DIR_ENV = ['PWD', 'OLDPWD'];

/**
 * B-1715: removes the server's inherited `PWD`/`OLDPWD` from a child env.
 *
 * Some harnesses trust `$PWD` over getcwd(): opencode 1.19 resolves its project
 * directory as `resolve(process.env.PWD ?? process.cwd())`, so every opencode
 * session was recorded under the live server root instead of the chat's cwd.
 * Without the variable each child derives its directory from the real `cwd` its
 * spawn site already sets, and a shell recomputes `PWD` itself. Dropping it here,
 * at the env choke point, fixes every provider instead of one spawn site.
 * @param {NodeJS.ProcessEnv} env a fresh env object owned by the caller
 * @returns {NodeJS.ProcessEnv} the same object without the working-dir vars
 */
function dropInheritedWorkingDirEnv(env) {
  for (const name of INHERITED_WORKING_DIR_ENV) delete env[name];
  return env;
}

/**
 * Resolves the environment for spawning a provider CLI on behalf of a user.
 *
 * B-1715: the server's `PWD`/`OLDPWD` never reach the child (see
 * dropInheritedWorkingDirEnv); the child's directory is its spawn `cwd`.
 *
 * SEC-ENV-1 — HOST-SECRET STRIP (unconditional, every provider, every mode):
 * the resolver starts from `{ ...baseEnv }` (process.env by default), so before
 * this fix EVERY child provider process inherited nassaj's own secrets —
 * JWT_SECRET above all, plus DATABASE_PATH and NASSAJ_PROVIDER_SECRETS_KEY.
 * `sanitizeVendorAgentEnv` (SL-3) only ever ran on the kimi/glm carrier paths,
 * so claude / codex / agy / opencode / cursor inherited them
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
 * HOME / the vendor KEY vars) are preserved, so no provider
 * loses anything it actually reads.
 *
 * Signature and every documented behavior are unchanged.
 *
 * @param {unknown} userId the actor: a member id, or SYSTEM_ACTOR (credential-actor.js).
 *   Anything else throws CREDENTIAL_ACTOR_REQUIRED and builds nothing.
 * @param {ProviderName} provider provider identifier
 * @param {NodeJS.ProcessEnv} [baseEnv] base environment to extend (defaults to process.env)
 * @param {{ honorGrants?: boolean }} [options] `honorGrants: false` ignores
 *   credential grants (T-1675) and builds the caller's OWN environment — for PTY
 *   terminals, where an interactive login must never reach a grantor's tree, and
 *   for home enumeration that must see every member's own tree.
 * @param {ProviderMode} [mode] spawn mode (SL-5). Defaults to 'chat' so every
 *   existing 3-arg caller keeps its exact prior behavior. Only 'agent' unlocks
 *   the agent-mode env sanitize (today: opencode); any other value is treated
 *   as the legacy default.
 * @returns {NodeJS.ProcessEnv} env to pass to child_process spawn
 */
export function resolveProviderEnv(userId, provider, baseEnv = process.env, mode = 'chat', options = {}) {
  const honorGrants = options.honorGrants !== false;
  const resolved = resolveIsolatedProviderEnv(userId, provider, baseEnv, mode, honorGrants);
  return dropInheritedWorkingDirEnv(sanitizeHostSecretEnv(applyHarnessUpdaterPolicy(provider, resolved)));
}

/**
 * B-1284 — the environment a MODEL-CATALOG probe runs under, fail-closed.
 *
 * A catalog read (`agy models`, `opencode models`, the agy token for the live
 * catalog) must see exactly the credential tree the member's real turn would
 * run on — otherwise every member is shown, and spends, the operator's account.
 * So this is `resolveProviderEnv` in chat mode with credential grants honoured
 * (the picker must match the spawn, which honours grants too), plus one
 * contract: it never throws a policy refusal at a reader.
 *
 * When isolation is UNAVAILABLE for this caller (`resolveProviderEnv` throws
 * `AppError` — provider outside the policy, or with no isolation case) the
 * answer is `null`, NOT the operator's environment. The caller treats `null` as
 * "no catalog for you": it serves its degraded fallback and spawns nothing.
 *
 * Any other error (EACCES while provisioning the member tree, …) propagates —
 * the readers already turn a throw into a degraded catalog, never a spawn.
 *
 * Side effect, accepted on review: like every isolated spawn, resolving an
 * isolated member provisions their tree (idempotent) and may refresh a grant
 * home; without it the CLI finds no tree and the catalog is a false empty.
 *
 * @param {unknown} userId the actor (a missing actor answers null: no catalog)
 * @param {ProviderName} provider isolation key ('agy' for antigravity)
 * @param {NodeJS.ProcessEnv} [baseEnv] base environment (defaults to process.env)
 * @returns {NodeJS.ProcessEnv|null} sanitized env, or null when isolation is unavailable
 */
export function resolveCatalogEnv(userId, provider, baseEnv = process.env) {
  try {
    return resolveProviderEnv(userId, provider, baseEnv, 'chat', { honorGrants: true });
  } catch (error) {
    if (error instanceof AppError) return null;
    throw error;
  }
}
