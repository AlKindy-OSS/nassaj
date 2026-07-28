/**
 * Scope-liveness source (ADR-053 §ج-2, حرج-3 — NEW code, not existing behavior).
 *
 * WHY THE LAYER-1 PID SOURCE IS BLIND HERE
 * ----------------------------------------
 * The shipped Layer-1 liveness (workflow-liveness.js + workflow-status.service)
 * derives "alive" from a child PID recorded ONLY for DIRECT children of the
 * nassaj-dev process (session-process-monitor.js matches ppid===process.pid). A
 * supervisor-launched workflow runs under a systemd `wf-*.scope` — it is a
 * GRANDCHILD (or wholly detached), never a direct child — so `isWorkflowProcessAlive`
 * returns false for it forever, which would misclassify a live scope workflow as
 * ORPHAN/COMPLETED the instant its journal goes quiet.
 *
 * THE FIX — is-active takes precedence FOR SCOPE WORKFLOWS ONLY
 * ------------------------------------------------------------
 * For a workflow that has a `supervisor.json.session.unit` (i.e. it was launched
 * as a scope), liveness = `systemctl --user is-active <unit>` (active/failed/
 * inactive). This is authoritative and PRECEDES the pid path. For every OTHER
 * workflow (the legacy in-query() path, a direct child) the pid classifier is
 * untouched. This module is ADDED BESIDE Layer-1, never inside it — the existing
 * classifyWorkflowLiveness is not modified.
 *
 * Fail-safe: an unreadable/erroring `is-active` biases toward RUNNING (do not
 * declare a scope dead on a monitoring blip), consistent with Layer-1's
 * conservative direction.
 */

/** Runs `systemctl --user is-active <unit>` and yields its stdout verdict. */
export type IsActiveProbe = (unit: string) => Promise<string>;

/** Verdict for a scope-backed workflow. */
export type ScopeLiveness = 'RUNNING' | 'COMPLETED' | 'ORPHAN';

/**
 * Classify a scope workflow from its unit's `is-active` verdict.
 *   - 'active' / 'activating' / 'reloading' => RUNNING (authoritative; a
 *                                       transient service is briefly 'activating'
 *                                       right after launch — never call that
 *                                       COMPLETED).
 *   - 'failed'                       => ORPHAN  (died abnormally; surface it).
 *   - 'inactive' / 'deactivating'    => COMPLETED (clean unit exit).
 *   - anything else / probe error    => RUNNING (conservative; never a false
 *                                       COMPLETED on a monitoring blip).
 *
 * @param unit   the unit name (from supervisor.json.session.unit)
 * @param probe  injected is-active probe (real: execFile systemctl; test: stub)
 */
export async function classifyScopeLiveness(
  unit: string,
  probe: IsActiveProbe,
): Promise<ScopeLiveness> {
  let verdict: string;
  try {
    verdict = (await probe(unit)).trim();
  } catch {
    // systemctl exits non-zero for inactive/failed AND surfaces the state on
    // stdout; a probe that both throws AND gives no state is a real error =>
    // conservative RUNNING. (The real probe below still returns the state text.)
    return 'RUNNING';
  }

  switch (verdict) {
    case 'active':
    case 'activating':
    case 'reloading':
      return 'RUNNING';
    case 'failed':
      return 'ORPHAN';
    case 'inactive':
    case 'deactivating':
      return 'COMPLETED';
    default:
      return 'RUNNING';
  }
}
