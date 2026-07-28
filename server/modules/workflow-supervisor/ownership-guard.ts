/**
 * GATE2 — the fail-closed isolation guard (ADR-053 §ج-3, the ToS blocker).
 *
 * THE RISK IT DEFENDS AGAINST
 * ---------------------------
 * A launch intent is web-originated and untrusted. If the supervisor launched a
 * `claude -p` scope for a user who does NOT own the target project, that run
 * would execute on a subscription it has no right to (per-user
 * CLAUDE_CONFIG_DIR isolation) — a silent subscription-sharing ToS breach
 * (memory project_is_platform_shared_sub_risk). Worse would be to `unset` the
 * config dir on a bad identity and fall back to the SYSTEM/OWNER credentials.
 *
 * THE GUARANTEE (fail-closed, no fallback)
 * ----------------------------------------
 * `authorizeLaunch` returns a DENY for every one of:
 *   1. an intent that fails syntactic validation (validateIntent),
 *   2. a userId that is not a real integer (redundant with (1), kept explicit),
 *   3. a userId that does NOT own / is not a member of the project — checked via
 *      the STRICT ownership predicate `isProjectPathOwnedOrMemberedBy`, NOT a
 *      visibility predicate (a visibility predicate returns true for every public
 *      project for every user — §ج-3 حرج-2, projects.db.ts:297).
 * On DENY the caller launches NOTHING. There is no code path here that clears the
 * config dir and proceeds: the env is only ever built for an ALLOW, and it is
 * built via the same isolation seam every provider spawn uses (resolveProviderEnv
 * → CLAUDE_CONFIG_DIR=~/.nassaj-users/<userId>/.claude), which the supervisor
 * passes to systemd-run with `--setenv` (GATE1 proved --setenv is respected).
 *
 * DEPENDENCY INJECTION (so GATE2 is testable without a live DB)
 * ------------------------------------------------------------
 * The ownership predicate and the env resolver are injected. In production the
 * supervisor wires the real `projectsDb.isProjectPathOwnedOrMemberedBy` and
 * `resolveProviderEnv`; a test wires stubs to exercise every branch. This keeps
 * the security decision pure and deterministic.
 */

import { validateIntent, type DurableTask, type LaunchIntent } from './intent.js';

/** Predicate: does `userId` own or is a member of the project at `projectPath`? */
export type OwnershipPredicate = (projectPath: string, userId: number) => boolean;

/** Resolver: builds the isolated child env for a user's claude spawn. */
export type EnvResolver = (
  userId: number,
  provider: 'claude',
  baseEnv: NodeJS.ProcessEnv,
) => NodeJS.ProcessEnv;

export type AuthorizeDeps = {
  isOwnedOrMembered: OwnershipPredicate;
  resolveEnv: EnvResolver;
  baseEnv?: NodeJS.ProcessEnv;
};

/**
 * Authorization outcome. On ALLOW the isolated `env` and the validated `intent`
 * are returned; on DENY only a machine-stable `reason` (never launch on deny).
 * `task` is the full DurableTask when the intent was a schema_version "2" blob
 * (so the caller can persist the delivery context); undefined for legacy v1.
 */
export type AuthorizeResult =
  | { allow: true; intent: LaunchIntent; env: NodeJS.ProcessEnv; task?: DurableTask }
  | { allow: false; reason: string };

/**
 * The single decision point every launch must pass. Pure given its deps; never
 * throws (a thrown ownership predicate is caught and mapped to DENY so a DB blip
 * fails CLOSED, never open).
 */
export function authorizeLaunch(raw: unknown, deps: AuthorizeDeps): AuthorizeResult {
  // 1) Syntactic validation (integer userId, safe id, absolute path, non-empty
  //    script). A malformed/forged blob is denied before any DB touch.
  const validation = validateIntent(raw);
  if (!validation.ok) {
    return { allow: false, reason: `invalid intent: ${validation.reason}` };
  }
  const intent = validation.intent;
  const task = validation.task;

  // 2) Redundant explicit integer gate (validateIntent already enforced it) —
  //    keeps the ToS-critical invariant visible at the security boundary.
  if (!Number.isInteger(intent.userId)) {
    return { allow: false, reason: 'userId is not an integer' };
  }

  // 3) STRICT ownership — NOT visibility. Any throw fails closed to DENY.
  let owned = false;
  try {
    owned = deps.isOwnedOrMembered(intent.projectPath, intent.userId);
  } catch {
    return { allow: false, reason: 'ownership check failed (fail-closed deny)' };
  }
  if (!owned) {
    return {
      allow: false,
      reason: 'user does not own or is not a member of the project',
    };
  }

  // ALLOW: build the isolated env via the same seam every provider spawn uses.
  // CLAUDE_CONFIG_DIR is set to the per-user tree; nothing is unset, nothing
  // falls back to the owner/system credentials. A THROWING resolver (e.g. the
  // fail-closed strict wrapper on a bad id) maps to DENY — never launch on a
  // resolver failure. (validateIntent already guaranteed an integer userId, so
  // the strict wrapper does not throw on this path; this is defense-in-depth.)
  let env: NodeJS.ProcessEnv;
  try {
    env = deps.resolveEnv(intent.userId, 'claude', deps.baseEnv ?? process.env);
  } catch (error) {
    return {
      allow: false,
      reason: `env resolution failed (fail-closed deny): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { allow: true, intent, env, task };
}
