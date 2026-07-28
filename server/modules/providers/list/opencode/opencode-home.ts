import os from 'node:os';
import path from 'node:path';

import { userDb } from '@/modules/database/index.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { readOptionalString } from '@/shared/utils.js';

/**
 * opencode-home — OC-07: resolves WHICH opencode data dir(s) hold a user's
 * session database, credentials and config, honoring the per-user XDG_* env
 * isolation wired on the spawn path in resolveProviderEnv.
 *
 * resolveProviderEnv(userId, 'opencode') redirects XDG_DATA_HOME (and the other
 * three XDG base dirs) into ~/.nassaj-users/<userId>/, so an isolated user's
 * opencode.db lives under <userTree>/.local/share/opencode/. The session
 * synchronizer, the filesystem watcher and the read-side providers must resolve
 * the SAME dir(s) — otherwise an isolated user's sessions are written to their
 * tree yet never indexed, watched or surfaced (the exact codex B-152 bug).
 *
 * These helpers reuse the central resolver rather than re-deriving the isolated
 * path, so the admin sharing policy and the anonymous/shared fallback live in
 * exactly one place. In shared mode (the default) every helper collapses to the
 * single operator data dir, leaving the pre-OC-07 behavior byte-for-byte.
 */

/** The opencode.db filename inside an opencode data dir. */
const OPENCODE_DB_FILENAME = 'opencode.db';

/** The `opencode` subdir opencode creates under its XDG data home. */
const OPENCODE_DATA_SUBDIR = 'opencode';

/**
 * Operator (non-isolated / shared) opencode data dir: honors a server-level
 * XDG_DATA_HOME when present (opencode itself does), else ~/.local/share, then
 * appends the `opencode` subdir. This is the single dir used in shared mode.
 */
export function operatorOpenCodeDataHome(): string {
  const xdgDataHome = readOptionalString(process.env.XDG_DATA_HOME)
    ?? path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, OPENCODE_DATA_SUBDIR);
}

/**
 * Resolves one user's effective opencode data dir through the central resolver.
 * When opencode is isolated this is ~/.nassaj-users/<userId>/.local/share/opencode;
 * when opencode is shared (admin policy) or the id is anonymous/null,
 * resolveProviderEnv returns the base env with no XDG_DATA_HOME override and this
 * falls back to the operator dir — i.e. the exact pre-isolation behavior.
 */
export function resolveOpenCodeDataHomeForUser(userId: string | number | null): string {
  const env = resolveProviderEnv(userId, 'opencode', process.env);
  const xdgDataHome = readOptionalString(env.XDG_DATA_HOME);
  if (xdgDataHome) {
    return path.join(xdgDataHome, OPENCODE_DATA_SUBDIR);
  }
  return operatorOpenCodeDataHome();
}

/**
 * The DISTINCT set of opencode data dirs whose sessions must be indexed/watched:
 * the operator dir plus, when opencode is isolated, each registered user's
 * per-user opencode data dir. Deduped via a Set so that in shared mode every
 * user collapses back to the single operator dir (byte-for-byte the pre-OC-07
 * scan). Enumerating users is best-effort: any DB anomaly degrades to the
 * operator dir only rather than throwing, so a transient failure can never take
 * session indexing down.
 */
export function resolveOpenCodeDataHomes(): string[] {
  const homes = new Set<string>([operatorOpenCodeDataHome()]);

  try {
    for (const user of userDb.listUsers()) {
      homes.add(resolveOpenCodeDataHomeForUser(user.id));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to enumerate per-user opencode data dirs; using operator dir only', {
      error: message,
    });
  }

  return [...homes];
}

/**
 * The opencode.db path for one user (operator dir in shared mode). Callers with
 * an authenticated userId use this instead of the userId-less
 * getOpenCodeDatabasePath so isolated sessions read/write the right database.
 */
export function resolveOpenCodeDatabasePathForUser(userId: string | number | null): string {
  return path.join(resolveOpenCodeDataHomeForUser(userId), OPENCODE_DB_FILENAME);
}

/**
 * Derives the owning opencode data dir from a changed opencode.db path. opencode
 * writes its DB at <dataHome>/opencode.db, so the data dir is simply the parent
 * directory. Lets the single-file (watcher-triggered) sync build its lookup from
 * the SAME tree the changed file lives in, regardless of which user owns it.
 */
export function openCodeDataHomeForSessionFile(filePath: string): string {
  return path.dirname(filePath);
}

/**
 * The nassaj user id that OWNS an opencode data dir — the attribution target for
 * externally-created (TUI) sessions found in that dir (T-857, part ب).
 *
 * Data-provenance ownership, honoring the exact isolation map wired on the spawn
 * path (resolveProviderEnv → resolveOpenCodeDataHomeForUser):
 *   - The SHARED operator dir (~/.local/share/opencode, the only dir in shared
 *     mode) belongs to the PLATFORM OWNER (userDb.getPlatformOwnerId — the
 *     role='owner' account the whole server treats as super-user). Attributing
 *     the operator dir to a specific human keeps the visibility semantics of
 *     ADR-052 intact WITHOUT poking a hole in NATIVE_SESSION_PREDICATE.
 *   - A per-user isolated dir (~/.nassaj-users/<id>/.local/share/opencode, only
 *     when opencode is isolated) belongs to THAT user — matched by comparing the
 *     resolved isolated dir for each registered user against this dir.
 *
 * Comparison is on resolved absolute paths so a trailing-slash or relative form
 * can never mis-match. Best-effort: any DB/enumeration anomaly degrades to the
 * platform owner (or null when no user exists at all) rather than throwing —
 * attribution must never take session indexing down. Returns null only when the
 * install has no users yet, in which case the caller simply skips attribution.
 */
export function resolveOpenCodeDataHomeOwner(dataHome: string): number | null {
  const operatorDir = path.resolve(operatorOpenCodeDataHome());
  const target = path.resolve(dataHome);

  if (target !== operatorDir) {
    try {
      for (const user of userDb.listUsers()) {
        if (path.resolve(resolveOpenCodeDataHomeForUser(user.id)) === target) {
          return Number(user.id);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to resolve per-user opencode data dir owner; using platform owner', {
        error: message,
      });
    }
  }

  try {
    return userDb.getPlatformOwnerId();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to resolve platform owner for opencode attribution', { error: message });
    return null;
  }
}
