/**
 * claude-shared-resume-proof — which Claude CLI versions may resume a conversation
 * whose transcript another user's config tree reaches through a symlink
 * (ADR-173 rev.3 P0, qa M5).
 *
 * Two link modes: `file_link` (the writer has a real project dir holding a link
 * `<sid>.jsonl` → the recorded file and a link `<sid>/` → its sidecar dir) and
 * `dir_link` (the writer's encoded project dir is itself a link). A mode is
 * admitted for a version only after `node scripts/prove-claude-shared-resume.mjs`
 * passed every required check live against that CLI. The registry is committed,
 * so a node admits a version only once a release ships its proof. Fails closed.
 * The bridge uses `file_link` only (ADR-173 M-d: a dir link would share the creator's
 * `memory/`); `dir_link` is still probed and recorded as data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported (not read from disk) so the server build carries it into dist-server.
import shippedRegistry from './claude-shared-resume-proven-versions.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The committed registry's source path; the proof script writes here. */
export const SHARED_RESUME_PROVEN_FILE = path.join(HERE, 'claude-shared-resume-proven-versions.json');

/** Link modes the proof probes and records (the bridge admits `file_link` only). */
export const SHARED_RESUME_MODES = Object.freeze(['file_link', 'dir_link']);

/** Every check the live proof probes and records per mode. */
export const SHARED_RESUME_CHECKS = Object.freeze([
  'three_turns', // 3 consecutive resumed turns keep the session id and append to the recorded file
  'compaction', // an automatic compaction lands in the recorded file
  'subagent', // a subagent transcript lands under the recorded <sid>/subagents
  'tool_result', // a large tool result lands under the recorded <sid>/tool-results
  'inode_stable', // the recorded file keeps its inode across every turn (no rename-writes)
  'link_preserved', // the writer's link is still a link to the same target after every turn
  'cleanup_safe', // the CLI's cleanupPeriodDays sweep never deletes the creator's files through the link
]);

/**
 * Checks a mode must pass (`pass`) to be admitted. `tool_result` is recorded but not
 * required (owner decision 2026-11-15): the CLI refuses a tool-results folder behind a
 * link and truncates the output inline, a documented limitation of shared-writer turns.
 */
export const SHARED_RESUME_REQUIRED_CHECKS = Object.freeze(SHARED_RESUME_CHECKS.filter((check) => check !== 'tool_result'));

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

/**
 * Well-formed entries of a parsed registry; `{}` for anything malformed.
 * @param {unknown} parsed
 * @returns {Record<string, {modes: Record<string, Record<string, string>>, evidence: Record<string, unknown>}>}
 */
function versionsOf(parsed) {
  const versions = /** @type {{versions?: unknown}} */ (parsed)?.versions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return {};
  return Object.fromEntries(Object.entries(versions).filter(([version, entry]) => VERSION_PATTERN.test(version)
    && entry && typeof entry === 'object' && entry.modes && typeof entry.modes === 'object'));
}

/**
 * Recorded versions: the shipped registry, or `file` when given; `{}` when absent or malformed.
 * @param {string} [file]
 */
export function readSharedResumeProven(file) {
  if (file === undefined) return versionsOf(shippedRegistry);
  try {
    return versionsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/**
 * True when `mode` passed every required check on CLI `version` (recorded verdicts of
 * optional checks, such as a `tool_result` fail, stay in the registry as data).
 * @param {string|null|undefined} version installed Claude CLI version (`2.1.325`)
 * @param {string} mode `file_link` or `dir_link`
 * @param {string} [file]
 * @returns {boolean}
 */
export function isSharedResumeModeProven(version, mode, file) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version) || !SHARED_RESUME_MODES.includes(mode)) return false;
  const checks = readSharedResumeProven(file)[version]?.modes?.[mode];
  return Boolean(checks) && SHARED_RESUME_REQUIRED_CHECKS.every((check) => checks[check] === 'pass');
}

/**
 * Records a version's per-mode check verdicts (`pass` | `fail` | `unproven`) and evidence.
 * @param {string} version
 * @param {Record<string, Record<string, string>>} modes
 * @param {Record<string, unknown>} evidence
 * @param {string} [file]
 * @returns {void}
 */
export function recordSharedResumeProof(version, modes, evidence, file = SHARED_RESUME_PROVEN_FILE) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Not a CLI version: ${version}`);
  const entry = { modes, evidence, recordedAt: new Date().toISOString() };
  const versions = { ...readSharedResumeProven(file), [version]: entry };
  const sorted = Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  fs.writeFileSync(file, `${JSON.stringify({ versions: sorted }, null, 2)}\n`);
}
