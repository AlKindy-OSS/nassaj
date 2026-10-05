/**
 * opencode-baseurl-guard (GL-3, ADR-062) — fail-closed allowlist guard for the GLM
 * OpenCode carrier, the carrier-path equivalent of the iron rule's
 * anthropic-base-url-guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * The iron-rule guard (anthropic-base-url-guard.js) validates every *_BASE_URL the
 * CLAUDE/Anthropic subprocess would honor — but it reads the spawn ENV, and the
 * OpenCode carrier routes GLM through a per-user `opencode.json` FILE instead
 * (provider.glm.options.baseURL, GL-2). That file is a routing surface the iron-rule
 * guard never inspects. GL-3 closes exactly that gap: before an opencode carrier turn
 * is spawned, EVERY effective baseURL declared in the user's opencode.json is
 * validated against the single vetted carrier host, so the carrier can NEVER be
 * pointed at a host the reviewed chat path did not use.
 *
 * INTERPOLATION IS EXPANDED BEFORE THE ALLOWLIST CHECK (the OCC-2 condition)
 * -------------------------------------------------------------------------
 * opencode expands variables inside config string values. Two forms are handled:
 *   - `${VAR}`    — shell-style expansion, CONFIRMED from the opencode binary (OCC-2).
 *   - `{env:VAR}` — opencode's documented `{env:…}` interpolation.
 * A baseURL like `${GLM_HOST}/api/anthropic` or `{env:BASE}` must be RESOLVED against
 * the effective env FIRST, then the resulting host compared to the allowlist —
 * otherwise a template that expands to a competitor host would slip a naive
 * string-equality check. Any residual, un-resolvable interpolation left after
 * expansion (a missing var, or an unsupported form such as `{file:…}`) is treated as
 * un-vettable and REFUSED (fail-closed): we never guess what an unknown template
 * resolves to.
 *
 * ALLOWLIST = ONE HOST, from ONE constant
 * ---------------------------------------
 * The only approved carrier host is the host of GLM_CARRIER_BASE_URL
 * (api.z.ai — the Anthropic-wire z.ai endpoint), imported from the SAME isolation-layer
 * constant the materialized opencode.json is built from (opencode-config-material.js).
 * Guard and material therefore share one source of truth and can never drift. Matching
 * is an EXACT host comparison (no subdomain widening) — strictly fail-closed.
 *
 * FAIL-CLOSED POSTURE (mirrors assertSettingsEnvAllowed):
 *   - opencode.json ABSENT / unreadable-ENOENT → no provider override to validate →
 *     NO-OP (nothing routes; opencode falls back to its built-in providers).
 *   - opencode.json is a SYMLINK → REFUSE (the GL-2 copy invariant forbids a symlink;
 *     a followed link is a write-through vector and an un-attestable routing source).
 *   - present but INVALID JSON → REFUSE (cannot prove the absence of a bad override).
 *   - a baseURL that expands to a disallowed / unparseable host → REFUSE.
 *
 * SCOPE: this guard governs ONLY the opencode carrier's routing file. It is invoked by
 * the single opencode launcher (server/opencode-cli.js) in CARRIER MODE ONLY; the
 * live, non-carrier opencode path never calls it, so that path is byte-for-byte
 * unchanged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GLM_CARRIER_BASE_URL, GLM_CARRIER_PROVIDER_ID } from './opencode-config-material.js';

/** Structured error code carried on every GL-3 refusal (assert without string match). */
export const OPENCODE_BASEURL_NOT_ALLOWED = 'OPENCODE_BASEURL_NOT_ALLOWED';

/** The config filename opencode reads from XDG_CONFIG_HOME/opencode. */
export const OPENCODE_CONFIG_FILENAME = 'opencode.json';

/** The `opencode` subdir under XDG_CONFIG_HOME that holds opencode.json + AGENTS.md. */
const OPENCODE_CONFIG_SUBDIR = 'opencode';

/**
 * Extracts the lowercased hostname from a URL string, normalizing a single trailing
 * DNS-root dot. Returns null when the value cannot be parsed as a URL with a host
 * (the caller treats null as disallowed — fail-closed, never guess).
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function hostOf(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname;
    if (!host) {
      return null;
    }
    return host.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** The single approved carrier host, derived from the vetted GLM carrier constant. */
export const ALLOWED_CARRIER_HOST = hostOf(GLM_CARRIER_BASE_URL);

/**
 * True iff `host` is the one approved carrier host. EXACT match (no subdomain
 * widening) — the carrier constant names one host, so anything else fails closed.
 * @param {string|null} host
 * @returns {boolean}
 */
export function isCarrierHostAllowed(host) {
  return typeof host === 'string' && host !== '' && host === ALLOWED_CARRIER_HOST;
}

/** Fail-closed error for a disallowed / un-vettable carrier baseURL (or config). */
export class OpenCodeBaseUrlError extends Error {
  /**
   * @param {string} message
   * @param {{ reason?: string, label?: string|null, shown?: string|null }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'OpenCodeBaseUrlError';
    this.code = OPENCODE_BASEURL_NOT_ALLOWED;
    this.reason = details.reason ?? 'disallowed_host';
    this.label = details.label ?? null;
    this.shown = details.shown ?? null;
    /** @type {string|null} 'project' when a project-level config file caused it. */
    this.scope = null;
    /** @type {string|null} the offending config file (project scope only). */
    this.file = null;
  }
}

/**
 * Expands opencode config interpolation in a string value against `env`, handling
 * BOTH `${VAR}` (shell-style, OCC-2-confirmed) and `{env:VAR}` (opencode's `{env:…}`
 * form). A referenced-but-unset var expands to the empty string (which yields an
 * unparseable URL downstream → refused). Bounded iteration resolves a value that
 * itself expands to another reference, and prevents an infinite loop.
 *
 * FAIL-CLOSED on any un-vettable value (`unresolved:true`): a non-string, a
 * referenced-but-UNSET var (we never let a missing var silently expand to empty and
 * possibly form the allowed host by accident), or a residual/unsupported template left
 * after expansion (`{file:…}`, or a malformed `${`/`{env:`).
 *
 * @param {unknown} value the raw config string (non-string → unresolved)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ expanded: string|null, unresolved: boolean }}
 */
export function expandOpenCodeInterpolation(value, env = process.env) {
  if (typeof value !== 'string') {
    return { expanded: null, unresolved: true };
  }

  let sawMissing = false;
  const lookup = (name) => {
    const resolved = env?.[name];
    if (typeof resolved === 'string') {
      return resolved;
    }
    sawMissing = true;
    return '';
  };

  let result = value;
  for (let i = 0; i < 12; i += 1) {
    let changed = false;
    result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      changed = true;
      return lookup(name);
    });
    result = result.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      changed = true;
      return lookup(name);
    });
    if (!changed) {
      break;
    }
  }

  // Un-vettable when a referenced var was unset, or when residual templating remains (a
  // leftover `${…}`, `{env:…}`, or an unsupported form like `{file:…}`) → fail-closed.
  const residual = /\$\{[^}]*\}|\{[a-z]+:[^}]*\}/i.test(result);
  return { expanded: result, unresolved: sawMissing || residual };
}

/**
 * Collects every effective endpoint declared in an opencode config object. opencode
 * resolves a provider's URL from `provider.<id>.api` first, then
 * `provider.<id>.options.baseURL` (B-1367: `api` was the unseen bypass), and a model can
 * carry its own `provider.<id>.models.<m>.provider.api`. A `provider.<id>.baseURL`
 * shorthand is scanned defensively. With `includeMcp`, every remote MCP
 * `mcp.<name>.url` is collected too under the pseudo-provider `mcp:<name>`, which no
 * origin is ever bound to — so any remote MCP endpoint is refused.
 *
 * A present, non-blank value that is not a string is still returned (and refused
 * downstream as un-vettable) rather than skipped.
 *
 * @param {unknown} config parsed opencode config
 * @param {{ includeMcp?: boolean }} [options]
 * @returns {Array<{ provider: string, label: string, raw: unknown }>}
 */
export function collectOpenCodeBaseUrls(config, { includeMcp = false } = {}) {
  const out = [];
  const root = isObject(config) ? config : {};
  for (const [name, block] of Object.entries(isObject(root.provider) ? root.provider : {})) {
    if (!isObject(block)) continue;
    pushEndpoint(out, name, `provider.${name}.api`, block.api);
    pushEndpoint(out, name, `provider.${name}.options.baseURL`, isObject(block.options) ? block.options.baseURL : undefined);
    pushEndpoint(out, name, `provider.${name}.baseURL`, block.baseURL);
    for (const [modelId, model] of Object.entries(isObject(block.models) ? block.models : {})) {
      const modelProvider = isObject(model) && isObject(model.provider) ? model.provider : null;
      pushEndpoint(out, name, `provider.${name}.models.${modelId}.provider.api`, modelProvider?.api);
    }
  }
  if (includeMcp) {
    for (const [name, server] of Object.entries(isObject(root.mcp) ? root.mcp : {})) {
      pushEndpoint(out, `mcp:${name}`, `mcp.${name}.url`, isObject(server) ? server.url : undefined);
    }
  }
  return out;
}

/** @param {unknown} value @returns {value is Record<string, any>} plain non-array object */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Records one endpoint unless it is absent or a blank string.
 * @param {Array<{ provider: string, label: string, raw: unknown }>} out
 * @param {string} provider
 * @param {string} label
 * @param {unknown} value
 */
function pushEndpoint(out, provider, label, value) {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value.trim() === '') return;
  out.push({ provider, label, raw: value });
}

/**
 * Resolves the per-user opencode.json path from a spawn env's XDG_CONFIG_HOME (set by
 * resolveProviderEnv for an isolated user), falling back to the operator config dir
 * (~/.config/opencode) in shared mode — mirroring opencode-home.ts's data-dir logic.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path to the effective opencode.json
 */
export function resolveOpenCodeConfigPath(env = process.env) {
  const xdgConfigHome = typeof env?.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim() !== ''
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdgConfigHome, OPENCODE_CONFIG_SUBDIR, OPENCODE_CONFIG_FILENAME);
}

/**
 * Fail-closed guard for a per-user opencode.json (GL-3). Validates that EVERY baseURL
 * it declares resolves — AFTER `${VAR}`/`{env:…}` expansion — to the ONE origin its own
 * block is bound to (B-1268): the `glm` block to the vetted carrier origin, a
 * `nassaj_local_<id>` block to that row's own endpoint (ADR-163), and any other block
 * carrying a baseURL to nothing at all. A per-block binding is what stops a `glm` block
 * — which carries the GLM key — from being pointed at a user-controlled endpoint.
 * Throws OpenCodeBaseUrlError on the first violation. No-op when the file is absent
 * (nothing routes).
 *
 * @param {string} configPath absolute path to opencode.json
 * @param {NodeJS.ProcessEnv} [env] effective env used to expand interpolations
 * @param {Record<string, string>} [localServerBaseUrls] providerId → endpoint for the
 *   caller's own local servers, read from the server table, never from request data.
 *   An unparseable row is dropped here, so it can only fail its OWN local block and
 *   never blocks a carrier turn.
 * @throws {OpenCodeBaseUrlError} code OPENCODE_BASEURL_NOT_ALLOWED on any violation
 */
export function assertOpenCodeBaseUrlAllowed(configPath, env = process.env, localServerBaseUrls = {}) {
  let stat;
  try {
    stat = fs.lstatSync(configPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // No config → no provider override to validate → opencode uses its built-ins.
      return;
    }
    throw new OpenCodeBaseUrlError(
      `Refusing to spawn the opencode carrier: cannot stat opencode.json at ${configPath} `
        + `(${err?.code || err?.message || 'unknown error'}) — an un-attestable routing source `
        + 'is treated as unsafe (fail-closed).',
      { reason: 'unverifiable', label: configPath },
    );
  }

  if (stat.isSymbolicLink()) {
    throw new OpenCodeBaseUrlError(
      `Refusing to spawn the opencode carrier: opencode.json at ${configPath} is a SYMLINK. `
        + 'The carrier requires a real per-user copy (GL-2) — a followed link is an '
        + 'un-attestable, write-through routing source.',
      { reason: 'symlink', label: configPath },
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new OpenCodeBaseUrlError(
      `Refusing to spawn the opencode carrier: cannot read opencode.json at ${configPath} `
        + `(${err?.code || err?.message || 'unknown error'}) — fail-closed.`,
      { reason: 'unverifiable', label: configPath },
    );
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new OpenCodeBaseUrlError(
      `Refusing to spawn the opencode carrier: opencode.json at ${configPath} is not valid JSON, `
        + 'so its baseURL routing cannot be validated against the carrier allowlist. '
        + 'Fix or remove the file.',
      { reason: 'invalid_json', label: configPath },
    );
  }

  assertParsedConfigAllowed(config, env, expectedOriginByProvider(localServerBaseUrls));
}

/**
 * Validates every baseURL declared in one parsed opencode config object against the
 * per-block origin map. Shared by the per-user (GL-3) and project-level (B-1367) checks
 * so both apply the exact same expansion + binding rules.
 *
 * @param {unknown} config parsed opencode config
 * @param {NodeJS.ProcessEnv} env effective env used to expand interpolations
 * @param {Map<string, string>} expectedOrigins providerId → the one approved origin
 * @param {{ includeMcp?: boolean }} [collectOptions] forwarded to collectOpenCodeBaseUrls
 * @throws {OpenCodeBaseUrlError} on the first violation
 */
function assertParsedConfigAllowed(config, env, expectedOrigins, collectOptions = {}) {
  for (const { provider, label, raw: rawUrl } of collectOpenCodeBaseUrls(config, collectOptions)) {
    const { expanded, unresolved } = expandOpenCodeInterpolation(rawUrl, env);
    if (unresolved) {
      throw notAllowedError(
        label,
        rawUrl,
        'contains an interpolation that cannot be resolved/vetted (missing var or unsupported form)',
        'unresolved_interpolation',
      );
    }
    const host = hostOf(expanded);
    if (host === null) {
      throw notAllowedError(label, expanded ?? rawUrl, 'is not a parseable URL after expansion', 'unparseable');
    }
    let origin;
    try {
      const parsed = new URL(expanded);
      if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
      origin = parsed.origin;
    } catch { throw notAllowedError(label, '', 'is not an allowed endpoint', 'disallowed_origin'); }
    // One block, one approved origin — an unknown block (or a local block with no
    // matching authorized row) has no approved origin at all and fails closed.
    if (origin !== expectedOrigins.get(provider)) {
      throw notAllowedError(label, host, `points at a host this provider block is not bound to (the carrier block may only use "${ALLOWED_CARRIER_HOST}")`, 'disallowed_host');
    }
  }
}

/** Config filenames opencode merges from a project directory and from each `.opencode` dir. */
const OPENCODE_PROJECT_CONFIG_NAMES = Object.freeze(['opencode.json', 'opencode.jsonc']);

/**
 * Env vars through which opencode reads an EXTRA config source (a file path, a config
 * dir, or inline JSON). The carrier launcher strips them before spawn (B-1367); the
 * qwen-plan path re-adds its own OPENCODE_CONFIG_CONTENT afterwards on purpose.
 */
export const OPENCODE_CONFIG_SOURCE_ENV = Object.freeze([
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
]);

/**
 * Strips JSONC comments and trailing commas so a project `opencode.jsonc` can be
 * parsed with JSON.parse. Both passes are string-aware: string literals are copied
 * verbatim (a `//` or `,}` inside a URL is data, not syntax).
 *
 * @param {string} text raw JSONC
 * @returns {string} strict JSON text
 */
export function stripJsonc(text) {
  return dropTrailingCommas(dropJsoncComments(text));
}

/** @param {string} text @returns {string} text without comments outside strings */
function dropJsoncComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = endOfJsonString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** @param {string} text comment-free JSON @returns {string} text without trailing commas */
function dropTrailingCommas(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = endOfJsonString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} start index of the opening quote
 * @returns {number} index just past the closing quote (or text end)
 */
function endOfJsonString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return i + 1;
    else i += 1;
  }
  return text.length;
}

/**
 * Lists every project-level config file opencode would merge for a run in `cwd`:
 * `opencode.json(c)` and `.opencode/opencode.json(c)` in cwd and EVERY ancestor up to
 * the filesystem root (a superset of opencode's walk, which stops at the git worktree),
 * plus `<home>/.opencode/opencode.json(c)`. Only existing paths are returned.
 *
 * @param {string} cwd the run's working directory
 * @param {string} [home] HOME the child will see
 * @returns {string[]} absolute paths of existing candidate files
 */
export function listOpenCodeProjectConfigFiles(cwd, home = os.homedir()) {
  const dirs = [];
  let current = path.resolve(cwd);
  for (;;) {
    dirs.push(current, path.join(current, '.opencode'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (typeof home === 'string' && home.trim() !== '') {
    dirs.push(path.join(path.resolve(home), '.opencode'));
  }
  const files = [];
  for (const dir of new Set(dirs)) {
    for (const name of OPENCODE_PROJECT_CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) || isDanglingLink(candidate)) files.push(candidate);
    }
  }
  return files;
}

/** @param {string} candidate @returns {boolean} true for a symlink whose target is missing */
function isDanglingLink(candidate) {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The opencode switch that stops it loading ANY project-level config: the working
 * tree's `opencode.json(c)`, its `.opencode/` dirs (config, plugins, agents) and project
 * AGENTS.md (verified in the installed 1.18.x binary). The carrier launcher sets it
 * after env sanitization (B-1367); governance still arrives through the per-user
 * `$XDG_CONFIG_HOME/opencode/AGENTS.md`, which the switch does not affect.
 */
export const OPENCODE_DISABLE_PROJECT_CONFIG_ENV = 'OPENCODE_DISABLE_PROJECT_CONFIG';

/** Error `scope` marking a refusal caused by a project-level config file. */
export const OPENCODE_PROJECT_CONFIG_SCOPE = 'project';

/**
 * Defense-in-depth guard over the PROJECT-level opencode config (B-1367). The carrier
 * launcher already sets OPENCODE_DISABLE_PROJECT_CONFIG so opencode ignores these files;
 * this check still refuses a carrier turn when one of them declares an endpoint, so a
 * future opencode that stops honoring the switch cannot silently reroute the `glm`
 * block. Every candidate (`opencode.json(c)` and `.opencode/opencode.json(c)` up the
 * tree, plus `~/.opencode/`) is read, symlinks followed, and held to the same per-block
 * origin binding as the per-user file — including `provider.*.api`, per-model
 * `provider.api` and any remote `mcp.*.url`. An unreadable or unparseable candidate is
 * refused, never skipped. Every refusal carries `scope: 'project'` and `file`.
 *
 * @param {string} cwd the run's working directory
 * @param {NodeJS.ProcessEnv} [env] effective child env (expansion + HOME)
 * @param {Record<string, string>} [localServerBaseUrls] providerId → endpoint
 * @throws {OpenCodeBaseUrlError} code OPENCODE_BASEURL_NOT_ALLOWED on any violation
 */
export function assertOpenCodeProjectConfigAllowed(cwd, env = process.env, localServerBaseUrls = {}) {
  const expectedOrigins = expectedOriginByProvider(localServerBaseUrls);
  for (const file of listOpenCodeProjectConfigFiles(cwd, env?.HOME || os.homedir())) {
    try {
      let config;
      try {
        config = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
      } catch (err) {
        throw new OpenCodeBaseUrlError(
          `Refusing to spawn the opencode carrier: project config ${file} cannot be read or parsed `
            + `(${err?.code || 'invalid JSON'}), so its provider routing cannot be validated.`,
          { reason: err?.code ? 'unverifiable' : 'invalid_json', label: file },
        );
      }
      assertParsedConfigAllowed(config, env, expectedOrigins, { includeMcp: true });
    } catch (err) {
      if (err instanceof OpenCodeBaseUrlError) {
        err.scope = OPENCODE_PROJECT_CONFIG_SCOPE;
        err.file = file;
      }
      throw err;
    }
  }
}

/**
 * Builds the providerId → single-approved-origin map: the vetted carrier origin for
 * `glm`, and each authorized local row's own origin for its reserved block. A row whose
 * endpoint cannot be parsed is SKIPPED (its block then has no approved origin and is
 * refused) instead of throwing, so one corrupt row cannot block a carrier turn.
 *
 * @param {Record<string, string>} localServerBaseUrls providerId → endpoint
 * @returns {Map<string, string>}
 */
function expectedOriginByProvider(localServerBaseUrls) {
  const map = new Map([[GLM_CARRIER_PROVIDER_ID, new URL(GLM_CARRIER_BASE_URL).origin]]);
  for (const [providerId, baseUrl] of Object.entries(localServerBaseUrls ?? {})) {
    if (providerId === GLM_CARRIER_PROVIDER_ID) {
      continue;
    }
    try {
      map.set(providerId, new URL(baseUrl).origin);
    } catch {
      // Unparseable stored endpoint: leave the block unbound (refused on use).
    }
  }
  return map;
}

/**
 * Loopback host test: `localhost`, `::1`, or any `127.0.0.0/8` literal. Brackets on an
 * IPv6 literal are tolerated.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLoopbackHost(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const v = value.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '') {
    return false;
  }
  return v === 'localhost' || v === '::1' || v === '127.0.0.1' || v.startsWith('127.');
}

/**
 * Fail-closed confinement guard for the opencode carrier's embedded local HTTP server
 * (OCC-15 condition ج). opencode's one-shot `run` boots an embedded server on the
 * loopback interface by default; this guard asserts OUR constructed spawn args never
 * widen that exposure — it REFUSES:
 *   - a `serve` subcommand (a long-lived, exposed server has no place in a one-shot
 *     carrier turn), and
 *   - any `--hostname` / `--host` / `-h` binding (space- or `=`-form) that is NOT a
 *     loopback address.
 * The default (no hostname flag) is loopback and passes. This makes "the carrier never
 * exposes opencode's HTTP server beyond localhost" a checked invariant rather than a
 * default we merely rely on. The one-shot `run` also means no persistent boot token is
 * published to any network-reachable surface.
 *
 * @param {ReadonlyArray<string>} args the final opencode spawn args
 * @throws {OpenCodeBaseUrlError} code OPENCODE_BASEURL_NOT_ALLOWED when the args would
 *   expose the server beyond loopback
 */
export function assertOpenCodeCarrierServerLocal(args) {
  const list = Array.isArray(args) ? args : [];

  if (list.includes('serve')) {
    throw new OpenCodeBaseUrlError(
      'Refusing to spawn the opencode carrier: the `serve` subcommand starts a long-lived '
        + 'HTTP server and is not permitted in carrier mode — only the one-shot `run` is.',
      { reason: 'server_exposed', label: 'serve' },
    );
  }

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (typeof arg !== 'string') {
      continue;
    }
    if (arg === '--hostname' || arg === '--host' || arg === '-h') {
      const value = list[i + 1];
      if (!isLoopbackHost(value)) {
        throw serverBindError(String(value ?? '(unset)'));
      }
      continue;
    }
    const inline = /^--(?:hostname|host)=(.*)$/.exec(arg);
    if (inline && !isLoopbackHost(inline[1])) {
      throw serverBindError(inline[1]);
    }
  }
}

/**
 * @param {string} shownHost
 * @returns {OpenCodeBaseUrlError}
 */
function serverBindError(shownHost) {
  return new OpenCodeBaseUrlError(
    `Refusing to spawn the opencode carrier: its embedded HTTP server would bind to a `
      + `non-loopback host "${shownHost}". The carrier confines opencode's local server to `
      + 'localhost (127.0.0.0/8 / ::1) so no boot token or endpoint is reachable off-box.',
    { reason: 'server_exposed', shown: shownHost },
  );
}

/**
 * @param {string} label config location of the offending baseURL
 * @param {string|null} shown the offending host / raw value
 * @param {string} clause human explanation appended to the message
 * @param {string} reason machine reason on the thrown error
 * @returns {OpenCodeBaseUrlError}
 */
function notAllowedError(label, shown, clause, reason) {
  return new OpenCodeBaseUrlError(
    `Refusing to spawn the opencode carrier: ${label} ${clause} `
      + `(value/host: "${shown}"). The carrier's routing file may only point at the vetted `
      + `Anthropic-wire host "${ALLOWED_CARRIER_HOST}" — the same host the reviewed chat path uses. `
      + 'Fix opencode.json (GL-2 regenerates the governed copy) — do NOT widen this guard.',
    { reason, label, shown },
  );
}
