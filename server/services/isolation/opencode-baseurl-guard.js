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

import { GLM_CARRIER_BASE_URL } from './opencode-config-material.js';

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
 * Collects every effective baseURL declared in an opencode config object. opencode
 * carries provider base URLs at `provider.<id>.options.baseURL`; a defensive scan
 * also picks up a `provider.<id>.baseURL` shorthand if one ever appears. Returns a
 * label + the RAW (pre-expansion) value for each.
 *
 * @param {unknown} config parsed opencode.json
 * @returns {Array<{ label: string, raw: string }>}
 */
export function collectOpenCodeBaseUrls(config) {
  const out = [];
  const providers = config && typeof config === 'object' ? config.provider : null;
  if (!providers || typeof providers !== 'object') {
    return out;
  }
  for (const [name, block] of Object.entries(providers)) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const optionsBase = block.options && typeof block.options === 'object'
      ? block.options.baseURL
      : undefined;
    if (typeof optionsBase === 'string' && optionsBase.trim() !== '') {
      out.push({ label: `provider.${name}.options.baseURL`, raw: optionsBase });
    }
    if (typeof block.baseURL === 'string' && block.baseURL.trim() !== '') {
      out.push({ label: `provider.${name}.baseURL`, raw: block.baseURL });
    }
  }
  return out;
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
 * it declares resolves — AFTER `${VAR}`/`{env:…}` expansion — to the single approved
 * carrier host. Throws OpenCodeBaseUrlError on the first violation. No-op when the file
 * is absent (nothing routes).
 *
 * @param {string} configPath absolute path to opencode.json
 * @param {NodeJS.ProcessEnv} [env] effective env used to expand interpolations
 * @throws {OpenCodeBaseUrlError} code OPENCODE_BASEURL_NOT_ALLOWED on any violation
 */
export function assertOpenCodeBaseUrlAllowed(configPath, env = process.env) {
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

  for (const { label, raw: rawUrl } of collectOpenCodeBaseUrls(config)) {
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
    if (!isCarrierHostAllowed(host)) {
      throw notAllowedError(label, host, `points at a disallowed host (only "${ALLOWED_CARRIER_HOST}" is approved)`, 'disallowed_host');
    }
  }
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
