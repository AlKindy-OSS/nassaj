/**
 * claude-local-cli-proof — which Claude CLI versions may run on a local model
 * server (ADR-227 Consequences, T-2098 qa item 3).
 *
 * Stage 2 measured that the CLI's credential behaviour toward a custom base URL
 * depends on its version (a stored claude.ai login reached the server when no
 * ANTHROPIC_AUTH_TOKEN was set). A version is therefore admitted only after the
 * header-echo proof (claude-local-engine.header-echo.test.ts) passed against it,
 * recorded by `node scripts/prove-claude-local-engine.mjs`. The registry is a
 * committed JSON file, so a node admits a version only once a release ships the
 * proof for it. Fails closed: an unreadable or malformed registry proves nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported (not read from disk) so the server build carries it into dist-server.
import shippedRegistry from './claude-local-proven-versions.json' with { type: 'json' };

/** The committed registry's source path; the proof script writes here. */
export const PROVEN_VERSIONS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'claude-local-proven-versions.json',
);

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

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
 * Proven versions and their evidence: the shipped registry, or `file` when given;
 * `{}` when that file is absent or malformed.
 * @param {string} [file]
 * @returns {Record<string, Record<string, unknown>>}
 */
export function readProvenVersions(file) {
  if (file === undefined) return versionsOf(shippedRegistry);
  try {
    return versionsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/**
 * True when `version` passed the header-echo proof.
 * @param {string|null|undefined} version installed Claude CLI version (`2.1.312`)
 * @param {string} [file]
 * @returns {boolean}
 */
export function isClaudeLocalVersionProven(version, file) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) return false;
  return Object.hasOwn(readProvenVersions(file), version);
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
