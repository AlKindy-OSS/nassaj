import os from 'node:os';
import path from 'node:path';

import { userDb } from '@/modules/database/index.js';
import { readOptionalString } from '@/shared/utils.js';

import { resolveProviderEnv } from './resolve-provider-env.js';
import { KIMI_HOME_SUBDIR } from './provision-user-dirs.js';

/**
 * kimi-agent-home — KM-2 (ADR-062 §4.2, wave W4-C): resolves WHICH Kimi
 * config-home dir(s) hold a user's native-agent session transcripts and MCP
 * config, honoring the per-user KIMI_CODE_HOME isolation that SL-5
 * (resolve-provider-env, agent mode) wires on the spawn path (KM-1).
 *
 * WHY (the codex B-152 lesson, applied to kimi): SL-5 isolates the SPAWN env so
 * each user's `@moonshot-ai/kimi-code` writes into
 * ~/.nassaj-users/<userId>/.kimi, but the session synchronizer, the filesystem
 * watcher and the MCP-config seam would otherwise hard-code the operator ~/.kimi
 * with no userId — so an isolated user's sessions would be written to their tree
 * yet never indexed, watched or surfaced. These helpers reuse the SAME central
 * resolver (resolveProviderEnv) rather than re-deriving the isolated path, so the
 * admin sharing policy and the anonymous/shared fallback stay in exactly one
 * place, and the config-home root has a SINGLE source of truth: KIMI_HOME_SUBDIR,
 * imported from the provisioner that materializes the very tree (sessions/ and
 * .kimi-code/) beneath it — the env var and the on-disk layout can never drift.
 *
 * MODE MATTERS: kimi's config-home is isolated ONLY in AGENT mode (the native
 * CLI; the toolless chat path speaks a hosted HTTP wire and keeps no on-disk
 * tree), so every resolveProviderEnv call here passes mode='agent' — matching the
 * launcher (KM-1) exactly. In CHAT mode (or when kimi is admin-marked 'shared',
 * or the id is anonymous/null) resolveProviderEnv returns the base env with no
 * KIMI_CODE_HOME and this falls back to the operator ~/.kimi.
 */

/** Operator (non-isolated / shared) Kimi config-home: ~/.kimi. */
export function operatorKimiHome(): string {
  return path.join(os.homedir(), KIMI_HOME_SUBDIR);
}

/**
 * Resolves one user's effective KIMI_CODE_HOME through the central SL-5 resolver
 * (agent mode). When kimi is isolated this is ~/.nassaj-users/<userId>/.kimi;
 * when kimi is admin-marked 'shared' or the id is anonymous/null,
 * resolveProviderEnv returns the base env with no KIMI_CODE_HOME and this falls
 * back to the operator ~/.kimi — i.e. the exact non-isolated behavior.
 */
export function resolveKimiHomeForUser(userId: string | number | null): string {
  const env = resolveProviderEnv(userId, 'kimi', process.env, 'agent');
  return readOptionalString(env.KIMI_CODE_HOME) ?? operatorKimiHome();
}

/**
 * The DISTINCT set of Kimi config-home dirs whose sessions must be indexed and
 * watched: the operator ~/.kimi plus, when kimi is isolated, each registered
 * user's per-user KIMI_CODE_HOME. Deduped via a Set so that in shared mode every
 * user collapses back to the single operator home.
 *
 * Enumerating users is best-effort: any DB anomaly degrades to scanning only the
 * operator home rather than throwing, so a transient failure can never take Kimi
 * session indexing down.
 */
export function resolveKimiHomes(): string[] {
  const homes = new Set<string>([operatorKimiHome()]);

  try {
    for (const user of userDb.listUsers()) {
      homes.add(resolveKimiHomeForUser(user.id));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to enumerate per-user Kimi homes; using operator home only', {
      error: message,
    });
  }

  return [...homes];
}

/**
 * Derives the owning KIMI_CODE_HOME from a single session transcript path. Kimi
 * writes agent transcripts under
 * <KIMI_CODE_HOME>/sessions/<id>/agents/<agentId>/wire.jsonl, so the home is the
 * prefix before the first "/sessions/" path segment. This lets the single-file
 * (watcher-triggered) sync and the MCP-config seam resolve state from the SAME
 * tree the changed file lives in, regardless of which user it belongs to. Falls
 * back to the operator home when the marker is absent (defensive; never thrown).
 */
export function kimiHomeForSessionFile(filePath: string): string {
  const marker = `${path.sep}sessions${path.sep}`;
  const markerIndex = filePath.indexOf(marker);
  if (markerIndex !== -1) {
    return filePath.slice(0, markerIndex);
  }
  return operatorKimiHome();
}
