import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AntigravityActiveModel } from '@/shared/types.js';

/**
 * Path (relative to the user's home directory) of the Antigravity CLI session
 * log. This is a symlink that the `agy` CLI repoints at the newest session log
 * on each launch, so reading it always resolves to the active session.
 */
const ANTIGRAVITY_LOG_RELATIVE_PATH = path.join('.gemini', 'antigravity-cli', 'cli.log');

/**
 * Maximum number of bytes to read from the tail of the log. The model-override
 * line we care about is the most recent one, so it lives near the end of the
 * file; reading only the tail bounds memory regardless of how large the log has
 * grown over a long session. A label split across the 64KB boundary is
 * acceptable to miss because a newer, fully-contained line supersedes it.
 */
const MAX_TAIL_BYTES = 64 * 1024;

/**
 * In-memory cache TTL. The log is read on a best-effort basis; a short TTL keeps
 * the value fresh for the UI while avoiding a file read on every request.
 */
const CACHE_TTL_MS = 30_000;

type CacheEntry = {
  result: AntigravityActiveModel;
  expiresAt: number;
};

/**
 * Builds the model-override matcher. Created per call (rather than module-scoped)
 * so the stateful `lastIndex` of the `/g` flag is never shared across reads.
 *
 * Matches lines such as:
 *   Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"
 */
function createModelOverridePattern(): RegExp {
  return /Propagating selected model override to backend: label="([^"]*)"/g;
}

/**
 * Scans the log text for the last `Propagating selected model override` match
 * and returns its quoted label, trimmed. Returns `null` when no match exists or
 * the matched label is empty/whitespace.
 *
 * Exported for unit testing; uses a function-local regex so no `lastIndex`
 * state is shared between invocations.
 */
export function extractLastLabel(contents: string): string | null {
  let lastLabel: string | null = null;

  for (const match of contents.matchAll(createModelOverridePattern())) {
    lastLabel = match[1];
  }

  if (lastLabel === null) {
    return null;
  }

  const trimmed = lastLabel.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves the active Antigravity model label by tailing the CLI session log.
 *
 * This is strictly read-only: the model cannot be changed from here, and a
 * missing log, unreadable file, or absence of any selection all degrade
 * gracefully to `{ label: null }` rather than throwing.
 */
export class AntigravityActiveModelService {
  private cache: CacheEntry | null = null;

  /**
   * Returns the most recently selected model label, or `null` when none has
   * been recorded. Served from a short-lived in-memory cache.
   */
  async getActiveModel(): Promise<AntigravityActiveModel> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.result;
    }

    const label = await this.readActiveModelLabel();
    const result: AntigravityActiveModel = {
      label,
      fetchedAt: new Date(now).toISOString(),
    };

    this.cache = { result, expiresAt: now + CACHE_TTL_MS };
    return result;
  }

  /**
   * Reads the tail of the log and extracts the label from the last
   * model-override line. Any I/O failure (missing file, permissions) resolves
   * to `null`.
   */
  private async readActiveModelLabel(): Promise<string | null> {
    const logPath = path.join(os.homedir(), ANTIGRAVITY_LOG_RELATIVE_PATH);

    const contents = await this.readTail(logPath);
    if (contents === null) {
      return null;
    }

    return extractLastLabel(contents);
  }

  /**
   * Reads at most {@link MAX_TAIL_BYTES} from the end of the file, following the
   * symlink to the real session log. Returns the decoded text, or `null` on any
   * I/O failure (missing/rotated log, no permissions, empty file).
   *
   * The path and contents are never logged, to avoid leaking session details.
   */
  private async readTail(logPath: string): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      // `stat` (not `lstat`) so the symlink is resolved to the real log file.
      const { size } = await stat(logPath);
      if (size <= 0) {
        return null;
      }

      const readLength = Math.min(size, MAX_TAIL_BYTES);
      const start = size - readLength;

      handle = await open(logPath, 'r');
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, start);

      return buffer.toString('utf8', 0, bytesRead);
    } catch {
      // Missing/unreadable log is an expected state (CLI never run, rotated
      // away, no permissions). Treat as "no active model".
      return null;
    } finally {
      await handle?.close().catch(() => {
        // Best-effort close; nothing actionable if it fails.
      });
    }
  }
}

export const antigravityActiveModelService = new AntigravityActiveModelService();
