/**
 * sanitize-vendor-agent-env — SL-3 (ADR-062 §3), the LOAD-BEARING compliance
 * defense line for the governed vendor-CLI providers (Kimi native + GLM via the
 * OpenCode carrier).
 *
 * WHY THIS EXISTS (the corrected compliance model — §2 of the plan):
 *
 *   The v2 framing assumed the vendor CLIs are "structurally blind to anthropic".
 *   Gate KG-1 disproved that: `@moonshot-ai/kimi-code` is multi-provider and
 *   READS `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` from its environment, exactly
 *   like `@ai-sdk/anthropic` inside the OpenCode carrier does when its explicit
 *   options are absent. So "compliance by blindness" is INVALID. Compliance is:
 *
 *     compliance = (explicit private key config) ∧ (sanitize env fail-closed)
 *
 *   This module is the second conjunct. It is applied as the LAST step before a
 *   vendor-agent spawn — after resolveProviderEnv has injected the target
 *   provider's own key — so that a Claude-subscription token, an Anthropic key,
 *   or an inherited base-URL redirect can NEVER be inherited by the child vendor
 *   process. Without it, a vendor turn inheriting `CLAUDE_CODE_OAUTH_TOKEN` or
 *   `ANTHROPIC_BASE_URL` from the operator env would silently bill / route the
 *   owner's Claude subscription through a competitor harness (IRON RULE / ToS
 *   violation — the single worst outcome this codebase guards against).
 *
 * FAIL-CLOSED, DENYLIST-DOCUMENTED (M-2):
 *   The plan prefers allowlist semantics "unless an operational blocker exists".
 *   The blocker is real: vendor CLIs consume an open-ended set of benign process
 *   env (PATH, HOME, LANG, TERM, TMPDIR, NODE_OPTIONS, XDG_* dirs, config-home,
 *   knobs, …) that cannot be exhaustively enumerated per vendor without breaking
 *   the CLI. So we use a COMPREHENSIVE, EXPLICITLY-DOCUMENTED denylist (the escape
 *   hatch M-2 grants) that removes every sensitive namespace fail-closed, and we
 *   still expose allowlist-flavored control via `options.keep` for callers that
 *   want to preserve a specific var, and `options.extraDeny` to strip sibling
 *   vendor keys per target (used by the single launcher).
 *
 *   Matching is CASE-INSENSITIVE on the variable NAME (B-173 lesson: a
 *   case-variant like `anthropic_base_url` must not slip a gate). The input env
 *   object is never mutated — a fresh object is returned.
 *
 * WHAT IS REMOVED (denylist):
 *   - EXACT, most-dangerous first:
 *       • CLAUDE_CODE_OAUTH_TOKEN  ← Claude subscription OAuth token (THE worst)
 *       • GITHUB_TOKEN
 *   - PREFIX namespaces (every var starting with, case-insensitive):
 *       • ANTHROPIC_   (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, _AUTH_TOKEN,
 *                       _BEDROCK_BASE_URL, _VERTEX_BASE_URL, …)
 *       • CLAUDE_      (CLAUDE_CONFIG_DIR, CLAUDE_CODE_*, CLAUDE_CODE_USE_BEDROCK…)
 *       • OPENAI_ · GEMINI_ · CURSOR_ · GH_ · GITHUB_   (other harness secrets)
 *   - SUFFIX: any `*_BASE_URL` (an inherited, intrusive base-URL redirect for the
 *     vendor is never legitimate — the target base URL is hard-coded in the
 *     vendor's own client / opencode.json, guarded separately by GL-3).
 *
 * WHAT IS PRESERVED (deliberately NOT in the denylist):
 *   - The target hosted-vendor key namespaces KIMI_ / DEEPSEEK_ / GLM_ / ZAI_ —
 *     these ARE the explicit private key that resolveProviderEnv injects for the
 *     target provider (first conjunct of the compliance model). Stripping them
 *     would break the very provider we are launching. Cross-vendor sibling keys
 *     (e.g. a GLM key leaking into a Kimi turn) are handled by the single
 *     launcher passing `options.extraDeny` for the non-target vendors.
 *
 * No project imports: this is a pure primitive shared by every governed launcher
 * seam (KM-1 kimi, GL-4 opencode carrier) and by their static isolation tests.
 *
 * @typedef {Record<string, string | undefined>} EnvLike
 */

/**
 * ---------------------------------------------------------------------------
 * NASSAJ HOST-PROCESS SECRETS (SEC-ENV-1) — the SECOND, provider-agnostic layer
 * ---------------------------------------------------------------------------
 *
 * The vendor lists below defend the IRON RULE (never route a Claude credential
 * to a competitor). They say nothing about nassaj's OWN process secrets, which
 * `load-env.js` injects into `process.env` at boot and which every provider
 * spawn used to inherit wholesale (`resolveProviderEnv` starts from
 * `{ ...baseEnv }`, baseEnv defaulting to process.env).
 *
 * That inheritance was a full-takeover primitive: an injected instruction in ANY
 * agent turn (`env | grep JWT_SECRET`) hands the attacker the token-signing key,
 * with which they mint a JWT for any userId/role. `DATABASE_PATH` points at the
 * live sqlite file (read the hashes, write a row). `NASSAJ_PROVIDER_SECRETS_KEY`
 * decrypts EVERY user's stored provider API keys. With a hosted vendor provider
 * the same value also leaves the machine.
 *
 * These names are secrets of the HOST APPLICATION. No provider CLI (claude,
 * codex, gemini, agy, cursor, opencode, hermes, kimi, deepseek, glm) reads any
 * of them — they are stripped for EVERY provider, in every mode, at the single
 * `resolveProviderEnv` choke point. Everything a CLI actually needs (PATH, HOME,
 * USER, LOGNAME, SHELL, LANG, TERM, TMPDIR, XDG_*, NODE_*, npm_*, and the
 * isolation knobs CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME /
 * KIMI_CODE_HOME / the vendor KEY vars) is deliberately NOT listed here.
 *
 * @type {ReadonlyArray<string>}
 */
export const NASSAJ_HOST_SECRET_EXACT_DENY = Object.freeze([
  'JWT_SECRET', // signs every session token — forgery ⇒ full account takeover
  'DATABASE_PATH', // absolute path of the live sqlite DB (users, hashes, keys)
  'NASSAJ_PROVIDER_SECRETS_KEY', // master key of the encrypted provider-secrets store
  'NASSAJ_FAKE_PROVIDER_KEY', // test-only override of the same store
  'OIDC_CLIENT_SECRET', // relying-party secret (OIDC_CLIENT_ID/ISSUER stay: public)
  'BOOTSTRAP_OWNER_PASSWORD', // first-owner bootstrap credential
  'SESSION_SECRET',
  'COOKIE_SECRET',
  'ENCRYPTION_KEY',
  'INTERNAL_SHARED_SECRET',
  'API_KEY', // middleware/auth.js validateApiKey — the global gate key.
  //          EXACT only: the hosted-vendor keys KIMI_API_KEY / DEEPSEEK_API_KEY /
  //          GLM_API_KEY / GEMINI_API_KEY must survive (they are the injected,
  //          per-user credential the target provider needs).
]);

/**
 * Host-secret SUFFIXES (case-insensitive) — fail-closed cover for a future
 * `*_SECRET` / `*_PASSWORD` variable nobody remembers to enumerate. Verified
 * against the live process env, `.env` and `.env.example`: no variable any
 * provider CLI needs ends in one of these.
 * @type {ReadonlyArray<string>}
 */
export const NASSAJ_HOST_SECRET_SUFFIX_DENY = Object.freeze([
  '_SECRET',
  '_PASSWORD',
  '_PASSPHRASE',
  '_PRIVATE_KEY',
]);

/**
 * True when `name` is a nassaj host-process secret that must never reach ANY
 * child provider process. Case-insensitive (B-173 lesson).
 *
 * @param {string} name env variable name
 * @returns {boolean}
 */
export function isDeniedHostSecretEnvKey(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const upper = name.toUpperCase();
  if (NASSAJ_HOST_SECRET_EXACT_DENY.some((d) => d === upper)) return true;
  if (NASSAJ_HOST_SECRET_SUFFIX_DENY.some((s) => upper.endsWith(s))) return true;
  return false;
}

/**
 * Returns a NEW env object with every nassaj host-process secret removed.
 * Provider-agnostic and applied unconditionally by resolveProviderEnv, so it is
 * impossible for a provider to be added later and silently skip it. Never
 * mutates the input.
 *
 * @param {EnvLike} env
 * @returns {EnvLike} sanitized shallow copy
 */
export function sanitizeHostSecretEnv(env) {
  const source = env && typeof env === 'object' ? env : {};
  /** @type {EnvLike} */
  const clean = {};
  for (const name of Object.keys(source)) {
    if (isDeniedHostSecretEnvKey(name)) continue;
    clean[name] = source[name];
  }
  return clean;
}

/**
 * Variable names removed by exact (case-insensitive) match. The Claude
 * subscription OAuth token is listed first: it is strictly worse than
 * ANTHROPIC_API_KEY because it authorizes the owner's Claude Max subscription
 * itself, not merely a metered API key. The nassaj host secrets above are folded
 * in so the vendor list is a strict SUPERSET — a vendor spawn can never be less
 * sanitized than a first-party one.
 * @type {ReadonlyArray<string>}
 */
export const VENDOR_AGENT_ENV_EXACT_DENY = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  ...NASSAJ_HOST_SECRET_EXACT_DENY,
]);

/**
 * Variable-name PREFIXES removed (case-insensitive). Covers whole credential /
 * routing namespaces so a newly-added var in any of them is stripped without a
 * code change (fail-closed by construction).
 * @type {ReadonlyArray<string>}
 */
export const VENDOR_AGENT_ENV_PREFIX_DENY = Object.freeze([
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
  'GEMINI_',
  'CURSOR_',
  'GH_',
  'GITHUB_',
]);

/**
 * Variable-name SUFFIXES removed (case-insensitive). Any inherited base-URL
 * redirect is intrusive for a vendor-agent child.
 * @type {ReadonlyArray<string>}
 */
export const VENDOR_AGENT_ENV_SUFFIX_DENY = Object.freeze([
  '_BASE_URL',
  ...NASSAJ_HOST_SECRET_SUFFIX_DENY,
]);

/**
 * Decides whether a single env var name must be stripped from a vendor-agent
 * child environment. Case-insensitive on the name. Exported so the governed
 * launcher static tests (KM-5/GL-10) can assert the exact policy.
 *
 * @param {string} name env variable name
 * @param {{ extraDeny?: ReadonlyArray<string>, keep?: ReadonlyArray<string> }} [options]
 *   - keep: names to PRESERVE even if they would otherwise be denied (allowlist
 *     override; case-insensitive). Use sparingly and document at the call site.
 *   - extraDeny: additional exact names to strip (case-insensitive), e.g. the
 *     single launcher passing sibling hosted-vendor keys for the non-target
 *     provider.
 * @returns {boolean} true when the variable must be removed
 */
export function isDeniedVendorAgentEnvKey(name, options = {}) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const upper = name.toUpperCase();

  // Allowlist override wins over every deny rule.
  const keep = options.keep;
  if (Array.isArray(keep) && keep.some((k) => String(k).toUpperCase() === upper)) {
    return false;
  }

  const extraDeny = options.extraDeny;
  if (Array.isArray(extraDeny) && extraDeny.some((d) => String(d).toUpperCase() === upper)) {
    return true;
  }

  if (VENDOR_AGENT_ENV_EXACT_DENY.some((d) => d.toUpperCase() === upper)) return true;
  if (VENDOR_AGENT_ENV_PREFIX_DENY.some((p) => upper.startsWith(p.toUpperCase()))) return true;
  if (VENDOR_AGENT_ENV_SUFFIX_DENY.some((s) => upper.endsWith(s.toUpperCase()))) return true;

  return false;
}

/**
 * Returns a NEW environment object with every denied variable removed, ready to
 * hand to a vendor-agent `child_process.spawn(..., { env })`. Applied as the LAST
 * step of the single launcher seam, after resolveProviderEnv. Never mutates the
 * input.
 *
 * @param {EnvLike} env the (already resolved) environment to sanitize
 * @param {{ extraDeny?: ReadonlyArray<string>, keep?: ReadonlyArray<string> }} [options]
 * @returns {EnvLike} a sanitized shallow copy of `env`
 */
export function sanitizeVendorAgentEnv(env, options = {}) {
  const source = env && typeof env === 'object' ? env : {};
  /** @type {EnvLike} */
  const clean = {};
  for (const name of Object.keys(source)) {
    if (isDeniedVendorAgentEnvKey(name, options)) continue;
    clean[name] = source[name];
  }
  return clean;
}

export default sanitizeVendorAgentEnv;
