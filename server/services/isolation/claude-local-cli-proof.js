/**
 * claude-local-cli-proof — which Claude CLI versions may run on a local model
 * server (ADR-227 Consequences, T-2098 qa item 3).
 *
 * Stage 2 measured that the CLI's credential behaviour toward a custom base URL
 * depends on its version (a stored claude.ai login reached the server when no
 * ANTHROPIC_AUTH_TOKEN was set). A version is therefore admitted only after the
 * header-echo proof (claude-local-engine.header-echo.test.ts) passed against it,
 * recorded by `node scripts/prove-local-engine.mjs`. The registry is a
 * committed JSON file, so a node admits a version only once a release ships the
 * proof for it. Fails closed: an unreadable or malformed registry proves nothing.
 *
 * T-2107: the Codex body has its own registry (codex-local-proven-versions.json,
 * proven by codex-local-engine.header-echo.test.ts); `body` selects it. T-2108:
 * the DSH body has dsh-local-proven-versions.json (dsh-local-engine.header-echo.test.ts,
 * through the corrector); dsh versions carry a prerelease tag (`0.2.2-rc.1`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported (not read from disk) so the server build carries them into dist-server.
import claudeRegistry from './claude-local-proven-versions.json' with { type: 'json' };
import codexRegistry from './codex-local-proven-versions.json' with { type: 'json' };
import dshRegistry from './dsh-local-proven-versions.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One committed registry per body: what ships, and the source path the proof script writes. */
const REGISTRIES = Object.freeze({
  claude: Object.freeze({ shipped: claudeRegistry, file: path.join(HERE, 'claude-local-proven-versions.json') }),
  codex: Object.freeze({ shipped: codexRegistry, file: path.join(HERE, 'codex-local-proven-versions.json') }),
  dsh: Object.freeze({ shipped: dshRegistry, file: path.join(HERE, 'dsh-local-proven-versions.json') }),
});

/** Bodies with a local-engine CLI proof. */
export const LOCAL_CLI_PROOF_BODIES = Object.freeze(Object.keys(REGISTRIES));

/** The committed Claude registry's source path. */
export const PROVEN_VERSIONS_FILE = REGISTRIES.claude.file;

/**
 * The registry of a body; throws on an unknown body.
 * @param {string} body
 * @returns {{shipped: unknown, file: string}}
 */
function registryOf(body) {
  if (!Object.hasOwn(REGISTRIES, body)) throw new Error(`No local CLI proof registry for body: ${body}`);
  return REGISTRIES[body];
}

/**
 * The committed registry source path of a body; the proof script writes here.
 * @param {string} body
 * @returns {string}
 */
export function provenVersionsFile(body) {
  return registryOf(body).file;
}

/** x.y.z with an optional semver prerelease tag (dsh ships `0.2.2-rc.1`). */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * Well-formed version entries of a parsed registry; `{}` for anything malformed.
 * @param {unknown} parsed
 * @returns {Record<string, Record<string, unknown>>}
 */
function versionsOf(parsed) {
  const versions = /** @type {{versions?: unknown}} */ (parsed)?.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return {};
  return Object.fromEntries(Object.entries(versions).filter(([version]) => VERSION_PATTERN.test(version)));
}

/**
 * Proven versions and their evidence: the body's shipped registry, or `file` when
 * given; `{}` when that file is absent or malformed.
 * @param {string} [file]
 * @param {string} [body]
 * @returns {Record<string, Record<string, unknown>>}
 */
export function readProvenVersions(file, body = 'claude') {
  if (file === undefined) return versionsOf(registryOf(body).shipped);
  try {
    return versionsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/**
 * True when `version` of the body's CLI passed its header-echo proof.
 * @param {string} body `claude`, `codex` or `dsh`
 * @param {string|null|undefined} version installed CLI version (`2.1.312`)
 * @param {string} [file]
 * @returns {boolean}
 */
export function isLocalCliVersionProven(body, version, file) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) return false;
  return Object.hasOwn(readProvenVersions(file, body), version);
}

/**
 * True when `version` passed the Claude header-echo proof.
 * @param {string|null|undefined} version installed Claude CLI version (`2.1.312`)
 * @param {string} [file]
 * @returns {boolean}
 */
export function isClaudeLocalVersionProven(version, file) {
  return isLocalCliVersionProven('claude', version, file);
}

/**
 * Records a version as proven, with its evidence (pass count, probe name).
 * @param {string} version
 * @param {Record<string, unknown>} evidence
 * @param {string} [file]
 * @returns {void}
 */
export function recordProvenVersion(version, evidence, file = PROVEN_VERSIONS_FILE) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Not a CLI version: ${version}`);
  const versions = { ...readProvenVersions(file), [version]: { ...evidence, provenAt: new Date().toISOString() } };
  const sorted = Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  fs.writeFileSync(file, `${JSON.stringify({ versions: sorted }, null, 2)}\n`);
}
