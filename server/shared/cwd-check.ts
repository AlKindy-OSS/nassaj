/**
 * Shared pre-spawn cwd existence check (B-31).
 *
 * Before any provider spawns a child process, call `assertCwdExists` to verify
 * that the working directory is present on disk.  When the directory is missing
 * the function returns a structured error result instead of throwing so the
 * caller can forward it to the frontend without additional try/catch nesting.
 *
 * WebSocket error envelope sent on failure:
 *   {
 *     kind:            'error',
 *     code:            'project_dir_missing',
 *     content:         <human-readable fallback>,
 *     sessionId:       <sessionId or null>,
 *     provider:        <provider>,
 *   }
 */

import { access } from 'node:fs/promises';

import type { LLMProvider } from '@/shared/types.js';
import { type MappedSpawnError } from '@/shared/spawn-error.js';

/**
 * Result returned by `checkCwdExists`.
 *
 * `ok === true`  — the directory exists; proceed with spawn.
 * `ok === false` — the directory is missing; forward `error` to the client.
 */
export type CwdCheckResult =
  | { ok: true }
  | { ok: false; error: MappedSpawnError };

/**
 * Checks whether `cwd` exists as an accessible path on disk.
 *
 * Returns `{ ok: true }` when the path is accessible.
 * Returns `{ ok: false, error }` with a `project_dir_missing` code when the
 * path does not exist or is not accessible.
 *
 * An empty / falsy `cwd` is treated as a missing directory: provider code
 * should always resolve a concrete cwd before calling spawn.
 */
export async function checkCwdExists(cwd: string | undefined | null): Promise<CwdCheckResult> {
  if (!cwd || !cwd.trim()) {
    return {
      ok: false,
      error: {
        code: 'project_dir_missing',
        fallbackMessage: 'Project directory path is required but was not provided.',
      },
    };
  }

  try {
    await access(cwd);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: {
        code: 'project_dir_missing',
        fallbackMessage: `Project directory not found: ${cwd}`,
      },
    };
  }
}

/**
 * Builds the WS error message object to send when the cwd check fails.
 * Callers pass this to `ws.send(createNormalizedMessage(...))`.
 */
export function buildCwdMissingPayload(
  error: MappedSpawnError,
  opts: {
    sessionId?: string | null;
    provider: LLMProvider;
    requestId?: string | null;
    /** True when the error occurs before a sessionId has been assigned (new
     *  session attempt). Lets the frontend correlate the failure with the
     *  originating request without a second duplicate error message. */
    isNewSessionError?: boolean;
  },
): Record<string, unknown> {
  return {
    kind: 'error' as const,
    code: error.code,
    content: error.fallbackMessage,
    sessionId: opts.sessionId ?? null,
    provider: opts.provider,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.isNewSessionError ? { isNewSessionError: true } : {}),
  };
}
