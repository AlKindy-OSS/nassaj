import os from 'node:os';
import path from 'node:path';

import { resolveProviderTranscript } from '../../shared/contained-file.js';

import { AGY_BRAIN_UNDER_HOME } from './agy-brain-layout.js';

const isBrainTranscript = (resolved: string): boolean => path.basename(resolved) === 'transcript.jsonl';

/**
 * B-1564: agy transcript for a stored `jsonl_path`, or null. The file must
 * realpath-resolve to a regular `transcript.jsonl` under the operator's brain or
 * a member tree's brain; a stored path outside every brain, or a symlink
 * escaping one, is never opened.
 */
export async function resolveAgyHistoryTranscriptPath(stored: string | null | undefined): Promise<string | null> {
  return resolveProviderTranscript(stored, [path.join(os.homedir(), AGY_BRAIN_UNDER_HOME)], AGY_BRAIN_UNDER_HOME,
    isBrainTranscript);
}
