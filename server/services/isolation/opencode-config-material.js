/**
 * opencode-config-material — the governed per-user `opencode.json` material for the
 * GLM OpenCode carrier (GL-2, ADR-062). Generates and materializes a real, read-only
 * (0444) `opencode.json` carrying the custom `glm` provider block, with content
 * fingerprinting for drift/self-heal — the same COPY-not-symlink security model the
 * vendor governance material uses.
 *
 * WHY A GENERATED COPY, NOT A FOLLOWED SYMLINK:
 *   Today an isolated user's XDG_CONFIG_HOME/opencode is a symlink to the operator's
 *   shared ~/.config/opencode, and opencode.json is not produced at all (§1.2 OCC-2),
 *   so the carrier has no `glm` provider block. GL-2 materializes a per-user
 *   opencode.json with the vetted glm block instead of relying on a followed operator
 *   symlink. A real per-user COPY (never a symlink) means an opencode turn can only
 *   ever damage its OWN opencode.json — caught next spawn by fingerprint and
 *   rewritten — and can NEVER write THROUGH a link to corrupt a shared operator file.
 *
 * SINGLE SOURCE OF TRUTH:
 *   The baseURL and model catalog come from vendor-config.ts (GLM_CARRIER_BASE_URL /
 *   GLM_CARRIER_MODELS) — the SAME constants the chat runtime and the GL-3 baseURL
 *   allowlist guard read — so the carrier can never point at a host the chat path did
 *   not vet. The baseURL is hard-coded there (never from env), preserving the
 *   iron-rule boundary: only the per-user API KEY flows from config (into auth.json,
 *   a separate DATA-dir file), never a base URL.
 *
 * NEUTRALITY / NO CYCLE: this leaf primitive imports only vendor-config (pure data)
 * and node stdlib — no isolation imports — so both the provisioning fast path
 * (provision-user-dirs.js) and any spawn-time guard can depend on it without a cycle.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// NOTE ON THE CARRIER CONSTANTS BELOW (baseURL / npm / models): they are defined
// LOCALLY here rather than imported from modules/providers/shared/vendor/vendor-config.ts.
// The eslint `boundaries` rule forbids the isolation layer from importing a
// modules/* internal path (only that module's barrel is allowed), which is exactly why
// resolve-provider-env.js defines its own VENDOR_KEY_ENV map locally instead of
// importing it. vendor-config.ts (GLM_CARRIER_BASE_URL / GLM_CARRIER_MODELS) remains
// THE source of truth for the intra-`providers` consumers (GL-3 baseURL guard, GL-9
// models, KM-4); this file mirrors those exact values, and vendor-config's
// agent-catalogs test asserts the two never drift (the providers side may import this
// isolation service, so the equality is checked there).

/** The config filename opencode reads from XDG_CONFIG_HOME/opencode. */
export const OPENCODE_CONFIG_FILENAME = 'opencode.json';

/**
 * Read-only mode for the materialized config. A same-uid agent can still
 * chmod+rewrite it, but 0444 stops accidental/naive writes and signals intent; the
 * hard guarantee is the per-spawn fingerprint re-check + the copy (not link) itself.
 */
export const OPENCODE_CONFIG_FILE_MODE = 0o444;

/**
 * The npm package the custom `glm` opencode provider loads: the OpenAI-compatible SDK.
 *
 * WHY NOT `@ai-sdk/anthropic` — B-221 ROOT CAUSE, proven by experiment 2026-07-27:
 *   opencode 1.17.18 cannot drive `@ai-sdk/anthropic` (v4.0.21). A turn bound to it
 *   ends at `step-finish` with `reason:"unknown"` and input=0/output=0 tokens: the
 *   HTTP request is NEVER issued, and nothing is written to opencode's log. Isolated
 *   single-variable substitution (own XDG_CONFIG_HOME/XDG_DATA_HOME, same key, same
 *   host, same model id, only this constant changed) makes the identical turn answer
 *   normally — `reason:"stop"`, 7012 input / 3 output tokens. The provider ID is NOT
 *   the variable: an `@ai-sdk/anthropic` binding produces the same zero-token
 *   `reason:"unknown"` result under a models.dev-KNOWN provider id too.
 *   This also matches opencode's own catalog: models.dev binds every z.ai provider
 *   (`zai`, `zai-coding-plan`, `zhipuai`) to `@ai-sdk/openai-compatible`.
 *
 * NO INSTALL REQUIRED: opencode bundles `@ai-sdk/openai-compatible`, so the carrier no
 * longer depends on a package being present in the config dir's node_modules (the old
 * binding did, and a missing `@ai-sdk/anthropic` hung opencode's `init` outright).
 *
 * OpenCode injects apiKey (from auth.json) and baseURL (from these options) EXPLICITLY
 * into the SDK, so the glm binding still reads NO credential from the environment and
 * stays outside the anthropic env namespace (OCC-2) — the property that made the
 * previous choice safe is preserved, not traded away.
 */
export const OPENCODE_GLM_NPM = '@ai-sdk/openai-compatible';

/**
 * The vetted GLM carrier baseURL — z.ai's OpenAI-compatible CODING-PLAN endpoint.
 * MIRRORS vendor-config.ts GLM_CARRIER_BASE_URL (kept in lockstep by the agent-catalogs
 * test). Hard-coded, never from env (iron-rule boundary): only the per-user API key
 * flows from config, into auth.json — never a base URL.
 *
 * SAME HOST as the chat path, DIFFERENT PATH (moved 2026-07-27 alongside
 * OPENCODE_GLM_NPM, because the wire protocol must follow the SDK):
 *   chat    → https://api.z.ai/api/anthropic       (Anthropic wire)
 *   carrier → https://api.z.ai/api/coding/paas/v4  (OpenAI wire)
 * The GL-3 allowlist is — and always was — a HOST allowlist: ALLOWED_CARRIER_HOST is
 * hostOf(this constant) = `api.z.ai`. So the invariant it enforces ("the carrier can
 * never point at a host the reviewed chat path did not use") holds unchanged; the guard
 * is neither widened nor relaxed to admit this value.
 *
 * WHY THE CODING PATH AND NOT `/api/paas/v4`: the operator key is a coding-plan
 * subscription. Verified live — `/api/paas/v4` answers "Insufficient balance or no
 * resource package", while `/api/coding/paas/v4` answers normally. It is the OpenAI-wire
 * twin of the `/api/anthropic` endpoint the chat path already uses with the same key.
 */
export const GLM_CARRIER_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

/**
 * The GLM carrier model catalog, shaped for the opencode.json `provider.glm.models`
 * block (a record keyed by model id). MIRRORS vendor-config.ts GLM_CARRIER_MODELS
 * (derived from GLM_FALLBACK_MODELS); the agent-catalogs test asserts they never drift.
 * opencode's live catalog stays authoritative at runtime.
 *
 * `glm-5.2[1m]` was DELETED, not corrected, 2026-07-27 (B-220): it is not a wire model
 * id — z.ai rejects it with `1211 Unknown Model`. The brackets are opencode's own
 * variant notation and were never part of any vendor id, and `glm-5.2` is already a
 * 1M-context model, so the entry named a model that does not and cannot exist.
 */
export const GLM_CARRIER_MODELS = {
  'glm-5.2': { name: 'GLM 5.2' },
};

/** sha256 hex of a buffer or string. */
export function fingerprintOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Builds the canonical opencode.json object with the governed `glm` provider block.
 * The provider id is deliberately `glm` (NOT `anthropic`, which would collide with the
 * built-in provider — OCC-2).
 *
 * @returns {{ provider: { glm: { npm: string, options: { baseURL: string }, models: Record<string, { name: string }> } } }}
 */
export function buildOpenCodeConfig() {
  return {
    provider: {
      glm: {
        npm: OPENCODE_GLM_NPM,
        options: { baseURL: GLM_CARRIER_BASE_URL },
        models: GLM_CARRIER_MODELS,
      },
    },
  };
}

/**
 * Canonical serialization of the opencode.json content. Stable (insertion-ordered)
 * two-space JSON with a trailing newline so the on-disk fingerprint is deterministic
 * across materializations.
 *
 * @param {ReturnType<typeof buildOpenCodeConfig>} [config]
 * @returns {string}
 */
export function serializeOpenCodeConfig(config = buildOpenCodeConfig()) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * True iff the file at `targetPath` is a real, non-empty regular file (NOT a symlink)
 * whose content EQUALS the expected canonical opencode.json — i.e. authentic, current
 * config. A symlink, a missing/empty file, or any drift returns false so the caller
 * rewrites. lstat (not stat) is deliberate: a symlink must never be accepted as
 * governed — that is the write-through corruption vector this module exists to close.
 *
 * @param {string} targetPath
 * @param {string} [expected] canonical content to compare against (default: generated)
 * @returns {boolean}
 */
export function openCodeConfigMatches(targetPath, expected = serializeOpenCodeConfig()) {
  try {
    const st = fs.lstatSync(targetPath);
    if (!st.isFile()) {
      return false;
    }
    const current = fs.readFileSync(targetPath);
    if (current.length === 0) {
      return false;
    }
    return fingerprintOf(current) === fingerprintOf(expected);
  } catch {
    return false;
  }
}

/**
 * Materializes the governed opencode.json as a real, read-only (0444) COPY at
 * <configDir>/opencode.json, (re)writing it whenever it is missing, a symlink, empty,
 * or drifted from the canonical content. A COPY — never a symlink — is the security
 * invariant (see module header). Never throws.
 *
 * The caller is responsible for ensuring `configDir` is a REAL per-user directory
 * (not the shared operator symlink); if `configDir` is itself a symlink this refuses
 * to write (fail-safe), so a pre-GL-5 shared symlink is never written THROUGH.
 *
 * @param {string} configDir the per-user XDG_CONFIG_HOME/opencode dir to populate
 * @param {{ mode?: number, onError?: (err: unknown) => void }} [options]
 * @returns {boolean} whether the config matches the canonical content after the attempt
 */
export function materializeOpenCodeConfig(configDir, options = {}) {
  const { mode = OPENCODE_CONFIG_FILE_MODE, onError } = options;
  const targetPath = path.join(configDir, OPENCODE_CONFIG_FILENAME);
  const expected = serializeOpenCodeConfig();

  if (openCodeConfigMatches(targetPath, expected)) {
    return true;
  }

  try {
    // Refuse to write THROUGH a symlinked config dir into the shared operator tree —
    // the same write-through vector the COPY invariant closes. Only a real per-user
    // dir is a legitimate materialization target.
    if (fs.lstatSync(configDir).isSymbolicLink()) {
      return false;
    }
  } catch {
    // configDir missing is fine — mkdirSync below creates a real dir.
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    // Remove whatever is there first: a stale copy, a dangling/hostile symlink, or a
    // wrong-type entry. rmSync removes the directory ENTRY — it does NOT follow a
    // symlink to write the target, so a shared source is never touched.
    fs.rmSync(targetPath, { force: true });
    // Write 0600 first (umask-safe, never a transient world-readable window) then
    // tighten to the requested read-only mode.
    fs.writeFileSync(targetPath, expected, { mode: 0o600 });
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if (typeof onError === 'function') {
      onError(err);
    }
    return false;
  }

  return openCodeConfigMatches(targetPath, expected);
}
