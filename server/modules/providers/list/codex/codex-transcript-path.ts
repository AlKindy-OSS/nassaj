import os from 'node:os';
import path from 'node:path';

import { resolveProviderTranscript } from '../../shared/contained-file.js';
import { vendorProviderRoot } from '../../shared/vendor/vendor-transcript.js';

/** Codex rollouts live under `<CODEX_HOME>/sessions`; a member's CODEX_HOME is `<member tree>/.codex`. */
const SESSIONS_UNDER_HOME = path.join('.codex', 'sessions');

const isJsonl = (resolved: string): boolean => resolved.endsWith('.jsonl');

/**
 * B-1564: rollout file for a Codex session's stored `jsonl_path`, or null. The
 * file must realpath-resolve to a regular `.jsonl` under the operator's (or the
 * configured) `<CODEX_HOME>/sessions`, under a member tree's `.codex/sessions`
 * (a session is readable by every member allowed to see it, not only its
 * author), or under the nassaj-owned Codex transcript tree that supervised
 * ephemeral turns write. A stored path outside every such root, or a symlink
 * escaping one, is never opened.
 */
export async function resolveCodexHistoryTranscriptPath(stored: string | null | undefined): Promise<string | null> {
  const operator = path.join(os.homedir(), '.codex');
  const shared = [operator, process.env.CODEX_HOME?.trim() || operator].map((home) => path.join(home, 'sessions'));
  shared.push(vendorProviderRoot('codex'));
  return resolveProviderTranscript(stored, shared, SESSIONS_UNDER_HOME, isJsonl);
}
