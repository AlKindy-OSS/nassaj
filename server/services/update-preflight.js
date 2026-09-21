/**
 * Update pre-flight service (ADR-156, WI-7, T-1719).
 *
 * Wraps the shared read-only diagnosis of `scripts/lib/update-preflight-checks.mjs`
 * — the same module `scripts/doctor.mjs --update-preflight` runs — with the
 * transport concerns the endpoint needs: single-flight so a burst of clicks
 * spawns one `git ls-remote` and not five, and an explicit deadline.
 *
 * READ-ONLY by contract. Nothing here writes a file, a ref, or a database row;
 * `repairs` names the codes the update job may fix later under the writer lease
 * and the fence, never this `GET`.
 */
import { NODE_ENV_ALLOWLIST, runUpdatePreflightChecks } from '../../scripts/lib/update-preflight-checks.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
/** The whole diagnosis may take a few probe deadlines, never unbounded time. */
const OVERALL_TIMEOUT_FACTOR = 3;

function positiveInteger(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

/**
 * Build the preflight runner. Every host effect is injected so the route wires
 * the live session counter and restart queue while tests wire stubs.
 *
 * @returns {() => Promise<object>} a single-flight runner; concurrent callers
 *   share the in-flight result rather than each starting their own probe, the
 *   `inFlight` pattern of `git-tag-release-discovery.js`.
 */
export function createUpdatePreflight({
    appRoot,
    env = process.env,
    activeSessionCount,
    listQueuedSafeRestarts,
    isSourceUpdateJobLive,
    timeoutMs = positiveInteger(env.NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    runChecks = runUpdatePreflightChecks,
} = {}) {
    if (!appRoot) throw new TypeError('Update preflight requires appRoot');
    if (typeof activeSessionCount !== 'function') throw new TypeError('Update preflight requires activeSessionCount');
    let inFlight = null;

    // An overall deadline on top of each probe's own: a diagnosis that never
    // answers is worse than one that says it could not finish (ت-9).
    const overallTimeoutMs = timeoutMs * OVERALL_TIMEOUT_FACTOR;
    const run = async () => {
        let expire;
        const deadline = new Promise((_resolve, reject) => {
            expire = setTimeout(() => reject(new Error('update_preflight_timeout')), overallTimeoutMs);
        });
        try {
            return await Promise.race([runChecks({
                appRoot,
                env,
                timeoutMs,
                activeSessionCount,
                // This service runs inside the application. /proc/environ and
                // PM2 describe exec-time values, before node.env was loaded.
                readLiveProcessEnv: () => Object.fromEntries(NODE_ENV_ALLOWLIST.map(key => [key, env[key]])),
                listQueuedSafeRestarts: typeof listQueuedSafeRestarts === 'function' ? listQueuedSafeRestarts : () => null,
                isSourceUpdateJobLive: typeof isSourceUpdateJobLive === 'function' ? isSourceUpdateJobLive : () => false,
            }), deadline]);
        } finally {
            clearTimeout(expire);
        }
    };

    return async function preflight() {
        if (inFlight) return inFlight;
        inFlight = run().finally(() => { inFlight = null; });
        return inFlight;
    };
}

/** Shape the diagnosis for the endpoint response contract of plan أ.5. */
export function preflightResponse(result) {
    return {
        ok: result.ok,
        installedVersion: result.installedVersion ?? null,
        target: result.target,
        repairs: result.repairs,
        blocker: result.blocker,
        checks: result.checks.map(({ code, ok, severity, autoFixable, reason_ar, reason_en, action_ar, action_en, command }) => ({
            code, ok, severity, autoFixable, reason_ar, reason_en, action_ar, action_en, command,
        })),
    };
}
