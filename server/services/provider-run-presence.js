/**
 * provider-run-presence — one run-lifecycle handle for NON-Claude providers.
 *
 * WHY THIS EXISTS (B-395). The green "Running" badge on a sidebar row, the blue
 * busy dot on a project, the "N active conversations" count and the workflow
 * liveness probe are all fed from ONE place: `registerSessionProcess` in
 * session-process-monitor.js. Until this module, the only caller in the whole
 * server was `server/claude-sdk.js` — so the badge was a Claude-only feature and
 * a Codex/Cursor/OpenCode/… run that was demonstrably mid-turn (STOP
 * button on screen, tokens streaming) showed no badge at all, and its header
 * read "Unknown liveness" because no pid ever reached the liveness registry.
 *
 * The monitor's API is not hard, but every provider hits the same three traps,
 * and each one is a stuck-forever badge if it is handled ad hoc:
 *
 *   1. LATE SESSION ID. A fresh run starts under a temporary key (`agy_…`,
 *      a process key, or the resume id) and only learns its real provider
 *      session id from the first stream event. Registering the temp key and
 *      then the real one leaves the temp key registered for the life of the
 *      process — a badge on a row that no longer exists. `rekey()` moves the
 *      registration instead of adding one.
 *   2. DOUBLE END. Provider runs end through several paths at once (`close`,
 *      `error`, abort, a terminal-failure branch). `end()` is idempotent, so
 *      belt-and-braces calls are safe and encouraged.
 *   3. NO PID. Some providers have no child process at all (the vendor HTTP
 *      runtime behind glm/kimi/deepseek). The monitor accepts that: it emits
 *      the initial 'running' and the terminal 'idle', and simply never reports
 *      'frozen' for a run it cannot see in /proc. Degrading to a badge without
 *      freeze-detection is the point — a correct badge beats no badge.
 *
 * WHAT EACH INPUT BUYS
 *   - `pid`     → full fidelity: frozen (kill -STOP) detection, dead-child
 *                 reaping, workflow-liveness probing. Use it whenever the
 *                 provider spawns its own child and exposes `child.pid`.
 *   - `runTag`  → same, one poll later: the monitor resolves the tag to a pid by
 *                 scanning its own direct children's `/proc/<pid>/environ`. For
 *                 SDKs that spawn the CLI for you but let you set the child env
 *                 (Codex). Inject `PROCESS_TAG_ENV_VAR` with the same value.
 *   - neither   → badge + presence + open-session counter only (see trap 3).
 */

import {
  registerSessionProcess,
  unregisterSessionProcess,
} from './session-process-monitor.js';
import { beginHarnessLaunch } from '../modules/providers/harness-update/spawn-admission.js';

/**
 * Registers a provider run and returns its lifecycle handle.
 *
 * Safe to call with a missing sessionId or writer: the handle is then inert and
 * `rekey()` is what actually starts the registration, which is exactly the shape
 * of a run whose id only arrives with the first stream event.
 *
 * @param {Object} details
 * @param {string} details.provider - Provider name ('codex', 'cursor', …).
 * @param {Object|null} details.writer - WebSocketWriter for the run (the `ws`
 *   the provider already streams through). Supplies the JWT-sourced userId.
 * @param {string|null} [details.sessionId] - Best-known session id at spawn time.
 * @param {string|null} [details.projectPath] - Working dir, shown in the live
 *   presence panel.
 * @param {number|null} [details.pid] - Child pid when the provider spawns it.
 * @param {string|null} [details.runTag] - PROCESS_TAG_ENV_VAR value injected
 *   into the child env, for spawners that hide the pid.
 * @param {(() => void)|null} [details.launchReservation] - Atomic reservation
 *   acquired immediately before spawn; omitted when this call precedes spawn.
 * @returns {{ rekey: (sessionId: string|null|undefined) => void,
 *             setPid: (pid: number|null|undefined) => void,
 *             end: () => void }}
 */
export function beginProviderRun({
  provider,
  writer,
  sessionId = null,
  projectPath = null,
  pid = null,
  runTag = null,
  launchReservation = null,
}) {
  const releaseHarnessLaunch = launchReservation ?? beginHarnessLaunch(provider);
  let currentId = null;
  let currentPid = pid ?? null;
  let ended = false;

  const register = (id) => {
    if (!id || !writer) {
      return;
    }
    currentId = id;
    registerSessionProcess(id, {
      provider,
      writer,
      pid: currentPid,
      runTag,
      projectPath,
    });
  };

  register(sessionId);

  return {
    /**
     * Moves the registration onto the run's real session id. A no-op when the
     * id is unchanged or the run already ended, so it may be called from every
     * stream event that carries an id without bookkeeping at the call site.
     */
    rekey(nextSessionId) {
      if (ended || !nextSessionId || nextSessionId === currentId) {
        return;
      }
      // Order matters: drop the old key FIRST so the badge never appears on two
      // rows at once, then claim the new one.
      if (currentId) {
        unregisterSessionProcess(currentId);
      }
      register(nextSessionId);
    },

    /**
     * Supplies the child pid once it is known (a provider that spawns after the
     * first registration). Re-registering the same id only refreshes the entry.
     */
    setPid(nextPid) {
      if (ended || !nextPid || nextPid === currentPid) {
        return;
      }
      currentPid = nextPid;
      register(currentId);
    },

    /** Terminal: clears the badge everywhere. Idempotent. */
    end() {
      if (ended) {
        return;
      }
      ended = true;
      if (currentId) {
        unregisterSessionProcess(currentId);
      }
      releaseHarnessLaunch();
    },
  };
}
