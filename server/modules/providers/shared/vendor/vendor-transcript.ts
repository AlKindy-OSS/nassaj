import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider } from '@/shared/types.js';
import { sanitizeLeafDirectoryName } from '@/shared/utils.js';

/**
 * On-disk transcript layout for hosted vendor providers (kimi/deepseek/glm).
 *
 * Unlike the first-party CLIs, these providers are remote HTTP APIs that write no
 * local transcript. nassaj therefore owns their transcript: the run seam appends
 * each normalized turn as one JSONL line under a stable, content-addressed path,
 * the session synchronizer indexes those files into sessionsDb, and the sessions
 * facet reads them back for history. Keeping this in one shared module means all
 * three providers share an identical, auditable storage shape.
 *
 * Path: ~/.nassaj-vendor-sessions/<provider>/<projectHash>/<sessionId>.jsonl
 *   - <projectHash> = md5(projectPath || cwd), matching how Cursor keys its
 *     per-project chat store, so transcripts for different workspaces never mix.
 *   - <sessionId> is sanitized before being used as a leaf filename.
 */

/** Root of every vendor provider's nassaj-owned transcript tree. */
export function vendorSessionsRoot(): string {
  return path.join(os.homedir(), '.nassaj-vendor-sessions');
}

/** Per-provider transcript directory (used as the watcher root). */
export function vendorProviderRoot(provider: LLMProvider): string {
  return path.join(vendorSessionsRoot(), provider);
}

/** md5 of the project path, matching Cursor's per-project keying. */
export function vendorProjectHash(projectPath: string | undefined): string {
  return crypto.createHash('md5').update(projectPath || process.cwd()).digest('hex');
}

/**
 * Resolves the absolute JSONL transcript path for one session, guarding against
 * path traversal via a crafted session id. Throws when the resolved path would
 * escape the provider's project directory.
 */
export function vendorTranscriptPath(
  provider: LLMProvider,
  sessionId: string,
  projectPath: string | undefined,
): string {
  const projectDir = path.join(vendorProviderRoot(provider), vendorProjectHash(projectPath));
  const safeSessionId = sanitizeLeafDirectoryName(sessionId, `${provider} session id`);
  const filePath = path.join(projectDir, `${safeSessionId}.jsonl`);

  const relative = path.relative(path.resolve(projectDir), path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid ${provider} session path for "${sessionId}".`);
  }
  return filePath;
}
