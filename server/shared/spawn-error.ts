/**
 * Shared spawn-error mapper (B-32).
 *
 * Converts raw Node.js spawn/exec errors into a stable {code, fallbackMessage}
 * pair the WebSocket layer can forward to the frontend. The frontend translates
 * `code` to a user-facing i18n string; `fallbackMessage` is a fallback for
 * unknown locales or codes.
 *
 * Recognised codes:
 *   project_dir_missing  — cwd (project directory) does not exist on disk (B-31)
 *   cli_not_installed    — the provider binary was not found (ENOENT on the exe)
 *   permission_denied    — the OS refused execution/access (EACCES / EPERM) (T-82)
 *   spawn_failed         — any other spawn-time failure
 */

export type SpawnErrorCode =
  | 'project_dir_missing'
  | 'cli_not_installed'
  | 'permission_denied'
  | 'spawn_failed';

export type MappedSpawnError = {
  code: SpawnErrorCode;
  fallbackMessage: string;
};

/**
 * Maps a raw Node.js error produced during `spawn` / `execFile` into a
 * structured {code, fallbackMessage} that is safe to forward to the frontend.
 *
 * Classification rules (first match wins):
 *   1. ENOENT **and** the error message references a `cwd` directory
 *      → `project_dir_missing`
 *   2. ENOENT (binary not found) or exit code 127
 *      → `cli_not_installed`
 *   3. EACCES / EPERM (OS refused execution or directory access)
 *      → `permission_denied`
 *   4. Everything else
 *      → `spawn_failed`
 *
 * The caller decides which rule applies to `cwd` vs binary ENOENT by passing
 * `context`. When `context === 'cwd'` rule 1 is forced regardless of the error
 * message text (used by the pre-spawn cwd existence check in B-31).
 */
export function mapSpawnError(
  err: unknown,
  context?: 'cwd' | 'binary',
): MappedSpawnError {
  const nodeErr = err as NodeJS.ErrnoException & { code?: string };
  const errCode = typeof nodeErr?.code === 'string' ? nodeErr.code : '';
  const message = nodeErr instanceof Error ? nodeErr.message : String(err ?? 'Unknown spawn error');

  // Caller-forced context takes priority.
  if (context === 'cwd') {
    return {
      code: 'project_dir_missing',
      fallbackMessage: `Project directory not found: ${message}`,
    };
  }

  if (context === 'binary') {
    // Caller explicitly states this is a binary-not-found error.
    return {
      code: 'cli_not_installed',
      fallbackMessage: `Provider CLI not installed or not found in PATH. ${message}`,
    };
  }

  if (errCode === 'ENOENT') {
    // ENOENT can mean either the cwd is missing OR the binary is missing.
    // Classification strategy (first rule wins):
    //   1. err.syscall starts with 'spawn ' → binary not found (cli_not_installed).
    //      Node.js sets syscall to 'spawn <binary>' when execve fails on the
    //      binary path. A binary name may contain hyphens (e.g. 'claude-code')
    //      so the old path-heuristic (no spaces / no '--') was unreliable.
    //   2. err.path is a non-empty string → Node.js recorded the missing
    //      directory path; treat as project_dir_missing.
    //   3. Neither → no extra context available; default to cli_not_installed
    //      because a bare ENOENT without a recorded path is most likely a
    //      missing binary rather than a silently unresolved cwd.
    const nodeErrRecord = nodeErr as unknown as Record<string, unknown>;
    const syscall = typeof nodeErrRecord?.syscall === 'string' ? nodeErrRecord.syscall as string : '';
    const pathHint = typeof nodeErrRecord?.path === 'string' ? nodeErrRecord.path as string : '';

    if (syscall.startsWith('spawn ')) {
      return {
        code: 'cli_not_installed',
        fallbackMessage: `Provider CLI not installed or not found in PATH. ${message}`,
      };
    }

    if (pathHint.length > 0) {
      return {
        code: 'project_dir_missing',
        fallbackMessage: `Project directory not found: ${pathHint}`,
      };
    }

    // No syscall context, no path hint — default to binary-missing.
    return {
      code: 'cli_not_installed',
      fallbackMessage: `Provider CLI not installed or not found in PATH. ${message}`,
    };
  }

  // EACCES (access denied) / EPERM (operation not permitted): the path exists
  // but the OS refused to execute the binary or enter the directory. Distinct
  // from a missing cwd and from a missing binary — surfaced so the frontend
  // can prompt the user to check file/dir permissions rather than re-install.
  if (errCode === 'EACCES' || errCode === 'EPERM') {
    return {
      code: 'permission_denied',
      fallbackMessage: `Permission denied while starting the provider. Check file and directory permissions. ${message}`,
    };
  }

  return {
    code: 'spawn_failed',
    fallbackMessage: message,
  };
}
