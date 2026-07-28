/**
 * Session process state monitor (frozen-session indicator).
 *
 * Provider runs spawn a child CLI process (claude via the Agent SDK) that an
 * operator may freeze externally with `kill -STOP <pid>` to save usage quota
 * and later resume with `kill -CONT <pid>`. While frozen the run produces no
 * stream events, so the UI shows an everlasting spinner with no hint that the
 * process is suspended. This module closes that gap:
 *
 *  - Each active run registers here with the session's WebSocketWriter and
 *    either a known child `pid` or a `runTag` (a unique value injected into
 *    the spawned process env when the spawner — e.g. the Claude Agent SDK —
 *    does not expose the child pid). The tag is resolved to a pid by scanning
 *    the server's direct children in /proc and matching the tag in
 *    `/proc/<pid>/environ`.
 *
 *  - A single lazy interval (started on first registration, stopped when the
 *    registry empties) polls each run's `/proc/<pid>/stat` every
 *    POLL_INTERVAL_MS and reads the state field (the token after the last
 *    `)` — comm may contain spaces/parens): `T` = stopped/frozen, anything
 *    else = running.
 *
 *  - State transitions are broadcast as a NormalizedMessage of kind 'status'
 *    with `text: 'process_state'` through the run's writer. WebSocketWriter
 *    fans every payload out to the session's read-only mirrors, so refreshed
 *    tabs and additional viewers receive the indicator too. The state is
 *    re-broadcast on every tick (not only on change) so a viewer that
 *    attached mid-run still learns about it within one poll.
 *
 *  - `unregisterSessionProcess` broadcasts a final 'idle' so the UI clears
 *    the badge when the turn completes, errors, or is aborted.
 *
 * Linux-only by design (/proc); on platforms without /proc every poll is a
 * silent no-op and the UI simply never sees a 'frozen' state.
 */

import fs from 'fs';

import {
  openSessionStarted,
  openSessionStopped,
} from '../modules/websocket/services/open-sessions.service.js';
import {
  presenceRunStarted,
  presenceRunState,
  presenceRunStopped,
} from '../modules/websocket/services/presence.service.js';
import { createNormalizedMessage } from '../shared/utils.js';

// ADR-053 (T-53-B1): the workflow-liveness registry is independent of this
// module's presence-coupled `runs` map and survives removeSession, so a
// coordinator-orphaned workflow (B-103) stays probeable by its child pid.
import { registerWorkflowPid } from './workflow-liveness.js';

/** Env var injected into spawned provider processes to map pid → session. */
export const PROCESS_TAG_ENV_VAR = 'CCUI_PROCESS_TAG';

const POLL_INTERVAL_MS = 5000;

/**
 * B-269: how many consecutive polls may fail to read /proc/<pid>/stat for an
 * ALREADY-RESOLVED pid before the run is treated as dead and torn down.
 *
 * Two ticks (~10s) rather than one: a single unreadable read is indistinguishable
 * from a transient /proc hiccup, and tearing a live run down would clear a badge
 * that is still legitimately busy. A reaped pid never comes back, so the second
 * miss is conclusive.
 */
const DEAD_PID_MISSES_BEFORE_UNREGISTER = 2;

/** sessionId → { provider, writer, pid, runTag, lastState, statMisses } */
const runs = new Map();

let pollTimer = null;

/** Parses /proc/<pid>/stat; returns { state, ppid } or null when unreadable. */
function readProcStat(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // Field 2 (comm) is parenthesised and may itself contain ')' or spaces,
        // so split after the LAST ')': "<pid> (<comm>) <state> <ppid> ...".
        const close = raw.lastIndexOf(')');
        if (close === -1) return null;
        const rest = raw.slice(close + 1).trim().split(/\s+/);
        if (rest.length < 2) return null;
        return { state: rest[0], ppid: Number(rest[1]) };
    } catch {
        return null;
    }
}

/** Lists direct children of this server process: [{ pid }]. */
function listServerChildren() {
    let names;
    try {
        names = fs.readdirSync('/proc');
    } catch {
        return [];
    }
    const children = [];
    for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        const stat = readProcStat(pid);
        if (stat && stat.ppid === process.pid) {
            children.push({ pid });
        }
    }
    return children;
}

/** True when /proc/<pid>/environ contains `PROCESS_TAG_ENV_VAR=<tag>`. */
function environHasTag(pid, tag) {
    try {
        const environ = fs.readFileSync(`/proc/${pid}/environ`);
        return environ.includes(`${PROCESS_TAG_ENV_VAR}=${tag}`);
    } catch {
        return false;
    }
}

/**
 * Emits the process state to the session's primary socket AND its read-only
 * mirrors (WebSocketWriter.send fans out by the payload's sessionId).
 */
function broadcastState(sessionId, run, processState) {
    try {
        run.writer.send(createNormalizedMessage({
            kind: 'status',
            text: 'process_state',
            processState,
            sessionId,
            provider: run.provider,
        }));
    } catch (error) {
        console.warn(`[process-monitor] broadcast failed for ${sessionId}:`, error?.message || error);
    }
}

function pollOnce() {
    if (runs.size === 0) {
        stopPolling();
        return;
    }

    let children = null; // Lazily scanned, at most once per tick.

    for (const [sessionId, run] of runs) {
        // Resolve runTag → pid once; the child pid is stable for the run's life.
        if (!run.pid && run.runTag) {
            if (children === null) children = listServerChildren();
            const match = children.find((child) => environHasTag(child.pid, run.runTag));
            if (match) run.pid = match.pid;
        }
        if (!run.pid) continue; // Unknown yet — UI keeps the initial 'running'.

        // ADR-053 (T-53-B1): hand the resolved child pid to the INDEPENDENT
        // workflow-liveness registry while the run is still live. That registry
        // is NOT torn down by removeSession/unregisterSessionProcess, so a
        // background workflow whose coordinator turn already ended (B-103) can
        // still be probed for liveness by its child pid — the presence-coupled
        // `runs` map here is dropped on turn-end and cannot serve that purpose.
        // Read-only, idempotent; does not touch the frozen-broadcast below.
        registerWorkflowPid(sessionId, run.pid);

        const stat = readProcStat(run.pid);
        if (!stat) {
            // B-269: the child is gone. This used to just `continue`, trusting
            // removeSession to arrive — but a run whose SDK generator never
            // settles (the [WS-DIAG] stream-orphaned case: socket dead, stream
            // never completes) never reaches removeSession, so its presence run
            // stayed counted as an active conversation until the server was
            // restarted. Reap it here instead, after DEAD_PID_MISSES_BEFORE_
            // UNREGISTER consecutive misses, which emits the same terminal
            // 'idle' + presence stop the normal path emits.
            run.statMisses = (run.statMisses ?? 0) + 1;
            if (run.statMisses >= DEAD_PID_MISSES_BEFORE_UNREGISTER) {
                console.log(
                    `[process-monitor] reaping ${sessionId} — pid ${run.pid} gone `
                    + `for ${run.statMisses} consecutive polls`
                );
                unregisterSessionProcess(sessionId);
            }
            continue;
        }
        run.statMisses = 0;

        // T→frozen is the EXISTING mirror-fanned indicator semantic and is left
        // exactly as-is (ADR-053 "لا تُمَسّ"). Z/X (zombie/dead) exclusion for
        // the liveness verdict lives in workflow-liveness.js (isPidAlive), not
        // here, so this broadcast is unchanged: a still-listed dead pid keeps
        // reporting 'running' to the badge exactly as before until unregister.
        const processState = stat.state === 'T' ? 'frozen' : 'running';
        // Re-broadcast EVERY tick (not only on change) so late-joining viewers
        // (page refresh, extra mirrors) learn the current state — including
        // 'running', which the sidebar busy dot depends on — within one poll
        // instead of never. One tiny status payload per run per 5s is cheap.
        run.lastState = processState;
        // B-269: mirror the state into presence so the per-session badge reaches
        // EVERY client, not just the sockets mirroring this session. No-op when
        // the value is unchanged, so the 5s re-broadcast below stays local.
        presenceRunState({
            userId: run.writer?.userId ?? null,
            sessionId,
            processState,
        });
        broadcastState(sessionId, run, processState);
    }
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    // Never keep the server process alive just for monitoring.
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
}

/**
 * Registers an in-flight provider run for state monitoring and immediately
 * broadcasts 'running'. Re-registering the same sessionId (e.g. the second
 * addSession call once the real sessionId is captured) refreshes the writer
 * without duplicating state.
 *
 * @param {string} sessionId - Session identifier the UI keys badges on.
 * @param {Object} details
 * @param {string} details.provider - Provider name ('claude', ...).
 * @param {Object} details.writer - WebSocketWriter for this session.
 * @param {number|null} [details.pid] - Child pid when the spawner exposes it.
 * @param {string|null} [details.runTag] - Env tag to resolve the pid from /proc.
 * @param {string|null} [details.projectPath] - Working dir of the run, surfaced
 *   in the live presence panel ("what is this brother working on now").
 */
function registerSessionProcess(sessionId, { provider, writer, pid = null, runTag = null, projectPath = null }) {
    if (!sessionId || !writer) return;

    // Live presence (B-MU-UX-PRESENCE): attribute this run to the authenticated
    // user that owns the session's writer. The userId comes from the JWT (set on
    // the WebSocketWriter at connect time), never from client input.
    presenceRunStarted({
        userId: writer.userId ?? null,
        sessionId,
        projectPath,
        provider,
    });

    // Open-sessions counter: this session has a running provider command.
    // Idempotent — the re-register that refreshes the writer changes nothing.
    openSessionStarted(sessionId);

    const existing = runs.get(sessionId);
    if (existing) {
        existing.writer = writer;
        if (pid) existing.pid = pid;
        if (runTag) existing.runTag = runTag;
        if (projectPath) existing.projectPath = projectPath;
        return;
    }

    const run = { provider, writer, pid, runTag, projectPath, lastState: 'running' };
    runs.set(sessionId, run);
    broadcastState(sessionId, run, 'running');
    startPolling();
}

/**
 * Drops a run from monitoring and broadcasts a final 'idle' so every viewer
 * clears the badge. Safe to call for unknown sessions (no-op).
 */
function unregisterSessionProcess(sessionId) {
    const run = runs.get(sessionId);
    if (!run) return;
    runs.delete(sessionId);
    // Live presence (B-MU-UX-PRESENCE): the user is no longer active on this
    // session. Read the userId from the run's writer (JWT-sourced).
    presenceRunStopped({ userId: run.writer?.userId ?? null, sessionId });
    // Open-sessions counter: the run reached a terminal state.
    openSessionStopped(sessionId);
    broadcastState(sessionId, run, 'idle');
    if (runs.size === 0) stopPolling();
}

export { registerSessionProcess, unregisterSessionProcess };
