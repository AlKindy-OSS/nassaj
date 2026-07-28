import os from 'node:os';
import path from 'node:path';

import { userDb } from '@/modules/database/index.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { readOptionalString } from '@/shared/utils.js';

/**
 * codex-home — B-152: resolves WHICH Codex home dir(s) hold a user's session
 * transcripts, config and credentials, honoring the per-user CODEX_HOME
 * isolation wired on the spawn path in B-136.
 *
 * B-136 isolated the SPAWN env (`new Codex({ env: resolveProviderEnv(userId,
 * 'codex') })`) so each user's Codex writes into ~/.nassaj-users/<userId>/.codex,
 * but the session synchronizer, the filesystem watcher and the read-side codex
 * providers still hard-coded ~/.codex (the operator home) with no userId — so an
 * isolated user's sessions were written to their tree yet never indexed, watched
 * or surfaced. These helpers reuse the SAME central resolver (resolveProviderEnv)
 * rather than re-deriving the isolated path, so the admin sharing policy and the
 * anonymous/shared fallback stay in exactly one place.
 */

/** Operator (non-isolated / shared) Codex home: ~/.codex. */
export function operatorCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

/**
 * Resolves one user's effective CODEX_HOME through the central B-136 resolver.
 * When codex is isolated this is ~/.nassaj-users/<userId>/.codex; when codex is
 * shared (admin policy) or the id is anonymous/null, resolveProviderEnv returns
 * the base env with no CODEX_HOME and this falls back to the operator ~/.codex —
 * i.e. the exact pre-isolation behavior.
 */
export function resolveCodexHomeForUser(userId: string | number | null): string {
  const env = resolveProviderEnv(userId, 'codex', process.env);
  return readOptionalString(env.CODEX_HOME) ?? operatorCodexHome();
}

/**
 * The DISTINCT set of Codex home dirs whose sessions must be indexed/watched:
 * the operator ~/.codex plus, when codex is isolated, each registered user's
 * per-user CODEX_HOME. Deduped via a Set so that in shared mode every user
 * collapses back to the single operator home (byte-for-byte the pre-B-152 scan).
 *
 * Enumerating users is best-effort: any DB anomaly degrades to watching/scanning
 * only the operator home rather than throwing, so a transient failure can never
 * take session indexing down.
 */
export function resolveCodexHomes(): string[] {
  const homes = new Set<string>([operatorCodexHome()]);

  try {
    for (const user of userDb.listUsers()) {
      homes.add(resolveCodexHomeForUser(user.id));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to enumerate per-user Codex homes; using operator home only', {
      error: message,
    });
  }

  return [...homes];
}

/**
 * Derives the owning CODEX_HOME from a single session transcript path. Codex
 * writes rollouts under <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, so the
 * home is the prefix before the first "/sessions/" path segment. This lets the
 * single-file (watcher-triggered) sync build the name-index lookup from the SAME
 * tree the changed file lives in, regardless of which user it belongs to. Falls
 * back to the operator home when the marker is absent (defensive; never thrown).
 */
export function codexHomeForSessionFile(filePath: string): string {
  const marker = `${path.sep}sessions${path.sep}`;
  const markerIndex = filePath.indexOf(marker);
  if (markerIndex !== -1) {
    return filePath.slice(0, markerIndex);
  }
  return operatorCodexHome();
}
