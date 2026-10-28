/**
 * ADR-207 §3.2, §3.3, §3.7 (T-2024 S3): the update prestager — policy only.
 *
 * A polling loop on the node's existing release discovery keeps at most one
 * un-adopted prestaged candidate for the latest release. Each cycle, under the
 * prestage build mutex: per-cycle recovery of the slot (and of leftover private
 * refs, B-1627), then discovery, the settle window, supersede, the eligibility
 * rules (decision-4 policy, mode, job, journal, preflight, resources, backoff)
 * and, when all pass, one background build through the prestage builder. A
 * minimal watchdog aborts the build under resource pressure or after 20 min.
 *
 * Job always wins (§3.4): `abortForJob()` aborts a running prestage, waits for
 * its discard and for the mutex, and only then lets the job take the mutex.
 *
 * Every refusal is a reason code in `status()` (S5 shows it to the owner);
 * each change of state or reason code is also logged (T-2025), so a node that
 * did not prestage can be diagnosed from its logs.
 *
 * T-2025: `noteRelease()` lets another discovery (the banner's
 * /release/latest) wake one cycle per newly seen release instead of waiting
 * for the next poll; the cycle keeps every gate and the settle window. The
 * prestager's own probe (every 5.5–6 min, just past the 5 min discovery TTL)
 * feeds the same path from the node's shared discovery cache, so a node
 * prestages soon after a release even when nobody opens the update screen:
 * discovery within ~6 min, then the 5 min settle window, then the build.
 * The mechanism (slot.json, flock, verified kill, discard) is the slot module's.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { compareNassajReleaseVersions, releaseTagForVersion } from '../../shared/release-version-policy.js';
import { tryAcquireBuildMutex } from './source-update-build-mutex.js';
import { journalRefusal } from './source-update-candidate-retention.js';
import {
    PRESTAGE_BUILD_MUTEX_KIND, adoptedJobId, isStalePrivateRef, isValidSlot, newPrestageTransactionId, prestagePaths,
    prestageRefPrefix, quarantineRemainingMs,
} from './update-prestage-slot.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Default of the eligibility policy (ADR-207 §8 decision 4, owner 2026-10-15):
 * prestage immediately on every node — policy `quarantine` with 0 hours. The
 * owner turns it off or adds a delay in the node settings
 * (update-prestage-settings.js); the environment still overrides both.
 */
export const PRESTAGE_POLICY_DEFAULT = Object.freeze({ policy: 'quarantine', quarantineHours: 0 });
export const PRESTAGE_POLICIES = Object.freeze(['quarantine', 'owner-node', 'verified', 'off']);

export const PRESTAGE_DEFAULTS = Object.freeze({
    pollMs: 30 * MINUTE, minPollMs: 5 * MINUTE, firstPollMs: 5 * MINUTE, jitter: 0.2,
    // T-2025: just past the 5 min discovery TTL, jittered upward only, so each probe reads a fresh listing.
    probeMs: 5.5 * MINUTE, probeJitter: 0.1, maxWokenReleases: 32,
    settleMs: 5 * MINUTE, buildTimeoutMs: 20 * MINUTE, watchdogMs: 5_000,
    minMemBytes: 3072 * MIB, minFreeBytes: Math.round(2 * GIB * 1.2 + 4 * GIB),
    watchdogMinFreeBytes: 2 * GIB, watchdogMinMemBytes: 1024 * MIB,
    resourceCeilingPercent: 80, resourceSamples: 3, resourceSampleGapMs: 1_000,
    backoffBaseMs: 30 * MINUTE, backoffMaxMs: 24 * HOUR, maxFailuresPerTarget: 3,
    abortWaitMs: 60_000,
});

// Aborts that are not the build's fault never count toward the backoff.
const NO_BACKOFF_ABORTS = new Set(['superseded', 'job_claimed', 'drain', 'stopped', 'disabled']);

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Invalid quarantine values already warned about (the config is re-read every cycle).
const warnedQuarantineValues = new Set();

/**
 * NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: unset/empty = not set (null); `0` is
 * a valid explicit "no quarantine" (the policy still applies); negative or
 * non-numeric is ignored (null) with one warning per distinct value.
 */
function envQuarantineHours(value, logger) {
    const raw = String(value ?? '').trim();
    if (raw === '') return null;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    if (!warnedQuarantineValues.has(raw)) {
        warnedQuarantineValues.add(raw);
        try {
            logger?.warn?.('[update-prestager]', JSON.stringify({ event: 'invalid_quarantine_hours', fallback: 'setting' }));
        } catch { /* config resolution never fails on logging */ }
    }
    return null;
}

/** The owner's stored setting, or the defaults when absent (T-2030). */
function storedSettingsOrDefault(stored) {
    return {
        enabled: typeof stored?.prestageEnabled === 'boolean' ? stored.prestageEnabled : true,
        quarantineHours: Number.isFinite(stored?.prestageQuarantineHours) && stored.prestageQuarantineHours >= 0
            ? stored.prestageQuarantineHours : PRESTAGE_POLICY_DEFAULT.quarantineHours,
    };
}

/**
 * The prestage configuration of this node. Precedence (T-2030):
 * `NASSAJ_UPDATE_PRESTAGE=0|off` is the kill switch and wins over everything;
 * a valid `NASSAJ_UPDATE_PRESTAGE_POLICY` / `NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS`
 * overrides the owner's stored setting (`stored`); the stored setting
 * overrides the defaults. `NASSAJ_UPDATE_PRESTAGE=1` is the operator's
 * explicit opt-in that the `owner-node` and `verified` policies honour
 * (ADR-207 §8 b, c).
 * @param {object} [env]
 * @param {{ logger?: object, stored?: {prestageEnabled?: boolean, prestageQuarantineHours?: number} | null }} [options]
 */
export function resolvePrestageConfig(env = process.env, { logger = console, stored = null } = {}) {
    const switchValue = String(env.NASSAJ_UPDATE_PRESTAGE ?? '').trim().toLowerCase();
    const requested = String(env.NASSAJ_UPDATE_PRESTAGE_POLICY ?? '').trim().toLowerCase();
    const envPolicy = PRESTAGE_POLICIES.includes(requested) ? requested : null;
    const owner = storedSettingsOrDefault(stored);
    const policy = envPolicy ?? (owner.enabled ? PRESTAGE_POLICY_DEFAULT.policy : 'off');
    const envHours = envQuarantineHours(env.NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS, logger);
    const quarantineHours = envHours ?? owner.quarantineHours;
    return {
        killed: switchValue === '0' || switchValue === 'off',
        optedIn: switchValue === '1' || switchValue === 'on',
        ownerNode: String(env.NASSAJ_UPDATE_PRESTAGE_OWNER_NODE ?? '').trim() === '1',
        policy, policyInvalid: requested !== '' && !envPolicy,
        envOverrides: { policy: envPolicy !== null, quarantineHours: envHours !== null },
        quarantineMs: Math.round(quarantineHours * HOUR),
        pollMs: Math.max(PRESTAGE_DEFAULTS.minPollMs, positiveNumber(env.NASSAJ_UPDATE_PRESTAGE_POLL_MS, PRESTAGE_DEFAULTS.pollMs)),
        settleMs: positiveNumber(env.NASSAJ_UPDATE_PRESTAGE_SETTLE_MS, PRESTAGE_DEFAULTS.settleMs),
        minMemBytes: positiveNumber(env.NASSAJ_UPDATE_PRESTAGE_MIN_MEM_MB, PRESTAGE_DEFAULTS.minMemBytes / MIB) * MIB,
        minFreeBytes: positiveNumber(env.NASSAJ_UPDATE_PRESTAGE_MIN_FREE_BYTES, PRESTAGE_DEFAULTS.minFreeBytes),
    };
}

/** Whether the decision-4 policy lets this node build `target` now; `{ok}` or `{reason, until?}`. */
export async function evaluatePrestagePolicy(config, { firstSeen, nowMs, verifySignedRelease, target }) {
    if (config.policy === 'off') return { reason: 'policy_off' };
    if (config.policy === 'owner-node') {
        return config.ownerNode || config.optedIn ? { ok: true } : { reason: 'not_owner_node' };
    }
    if (config.policy === 'verified') {
        if (config.optedIn) return { ok: true };
        let verified = false;
        try { verified = (await verifySignedRelease(target)) === true; } catch { verified = false; }
        return verified ? { ok: true } : { reason: 'release_unverified' };
    }
    const remaining = quarantineRemainingMs(firstSeen, config.quarantineMs, nowMs);
    return remaining > 0 ? { reason: 'quarantine', until: nowMs + remaining } : { ok: true };
}

/** ADR-207 §3.2 rule 2: only release-mode git-checkout-v2 nodes prestage. */
export function prestageModeRefusal({ updateMode, isPlatform, hostReady, jobStrategy }) {
    if ((updateMode ?? 'release') !== 'release') return 'update_mode_not_release';
    if (isPlatform) return 'platform_mode';
    if (!hostReady) return 'update_host_not_ready';
    if (jobStrategy !== 'git-checkout-v2') return 'strategy_not_git_checkout';
    return null;
}

/** Signed-release verification hook (ADR-174, policy `verified`). Not built yet: never verified. */
export async function verifySignedReleaseStub() {
    return false;
}

/**
 * The ADR-174 signed-release port the attach proof calls (ADR-216 §3.1 step 8).
 * Same hook as the prestager's `verified` policy; never verified while the
 * signing work is not built.
 */
export const verifySignedReleasePort = verifySignedReleaseStub;

/**
 * ADR-216 §3.1 step 8: whether this node's release policy is `verified`, from
 * the same configuration the prestager reads (env over the owner's setting).
 * @param {object} [env]
 * @param {{prestageEnabled?: boolean, prestageQuarantineHours?: number} | null} [stored]
 */
export function releasePolicyRequiresVerification(env = process.env, stored = null) {
    const silent = { warn() {}, error() {}, info() {} };
    return resolvePrestageConfig(env, { logger: silent, stored }).policy === 'verified';
}

/**
 * ADR-216 §3.1 L7: the prestage slot state, read without the slot lock and
 * without writing anything. `null` when there is no slot; `'corrupt'` when
 * slot.json is unreadable or not a record this module wrote (callers fail
 * closed on it); otherwise the slot's `state` (`building`, `ready`,
 * `discarding`, `adopted:<jobId>`).
 * @param {string} controlRoot `<git common dir>/nassaj-source-update`
 * @returns {string|null}
 */
export function readPrestageSlotState(controlRoot) {
    let raw;
    try { raw = fs.readFileSync(prestagePaths(controlRoot).slot, 'utf8'); } catch (error) {
        return error?.code === 'ENOENT' ? null : 'corrupt';
    }
    let slot;
    try { slot = JSON.parse(raw); } catch { return 'corrupt'; }
    return isValidSlot(slot) ? slot.state : 'corrupt';
}

/**
 * @param {object} deps
 * @param {string} deps.appRoot
 * @param {ReturnType<import('./update-prestage-slot.js').createPrestageSlot>} deps.slot
 * @param {ReturnType<import('./source-updater.js').createPrestageCandidateBuilder>} deps.buildPrestage
 * @param {() => Promise<{release: {version: string, tagName: string, commit: string}}>} deps.discoverRelease
 * @param {() => {updateMode?: string, isPlatform?: boolean, hostReady?: boolean, jobStrategy?: string|null,
 *   runtimeVersion?: string|null, runtimeCommit?: string|null, builderBuildId?: string|null}} deps.readRuntime
 * @param {() => boolean} deps.hasActiveJob
 * @param {() => Array<{transactionId: string|null, state: string}>} deps.listJobReferences every job row
 * @param {(jobId: string) => ({state: string, transactionId: string|null} | null)} deps.lookupJob
 * @param {() => object} deps.readJournal maintenance-gate recovery evidence
 * @param {() => Promise<{ok: boolean, blocker?: {code: string}|null}>} [deps.runPreflight]
 * @param {() => Promise<{cpuPercent: number, memoryPercent: number}>} deps.sampleResources
 * @param {() => number} deps.readMemAvailable bytes
 * @param {() => number} deps.readFreeDisk bytes free on the control root's filesystem
 * @param {(args: string[]) => Promise<{code: number, stdout: string}>} [deps.runGit] for B-1627 ref cleanup
 * @param {() => ({prestageEnabled?: boolean, prestageQuarantineHours?: number} | null)} [deps.readSettings]
 *   the owner's stored setting (T-2030), read once per cycle; null = absent (defaults);
 *   throws when the store cannot be read (never defaults then, see currentConfig)
 */
export function createUpdatePrestager(deps) {
    const {
        appRoot, slot, buildPrestage, discoverRelease, readRuntime, hasActiveJob, listJobReferences, lookupJob,
        readJournal, runPreflight = null, sampleResources, readMemAvailable, readFreeDisk, runGit = null,
        readSettings = () => null, env = process.env, verifySignedRelease = verifySignedReleaseStub, now = Date.now, random = Math.random,
        timers = { setTimeout, clearTimeout, setInterval, clearInterval }, sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms)),
        logger = console, options = {},
    } = deps;
    const settings = { ...PRESTAGE_DEFAULTS, ...options };
    const state = {
        status: { enabled: false, policy: null, state: 'idle', version: null, readyAt: null, reasonCode: 'not_started',
            quarantineUntil: null, updatedAt: null },
        pending: null, build: null, cycle: null, timer: null, probeTimer: null, probeEnded: false, waking: new Set(), stopped: true, failures: new Map(),
        lastSettings: undefined, woken: new Set(),
    };

    /** Update the status; a change of state or reason code is logged (T-2025), a repeat is not. */
    function setStatus(fields) {
        const previous = state.status;
        state.status = { ...previous, ...fields, updatedAt: new Date(now()).toISOString() };
        if (previous.state !== state.status.state || previous.reasonCode !== state.status.reasonCode) {
            log('status_changed', { state: state.status.state, reasonCode: state.status.reasonCode,
                version: state.status.version, previousState: previous.state, previousReasonCode: previous.reasonCode });
        }
        return state.status;
    }

    function log(event, fields = {}) {
        try { logger.info?.('[update-prestager]', JSON.stringify({ event, ...fields })); } catch { /* never fails a cycle */ }
    }

    /**
     * T-2030 (qa condition 1): the configuration with the owner's stored
     * setting. A failed read never falls back to the defaults: it reuses the
     * last value read successfully, and with none yet the result is
     * `unavailable` (the caller then builds nothing and adopts nothing).
     */
    function currentConfig() {
        let stored;
        let unavailable = false;
        try {
            stored = readSettings();
            state.lastSettings = stored;
        } catch {
            if (state.lastSettings === undefined) unavailable = true; else stored = state.lastSettings;
        }
        return { config: resolvePrestageConfig(env, { logger, stored: stored ?? null }), unavailable };
    }

    // -- the cycle -----------------------------------------------------------

    /** One cycle; never throws, never overlaps another, never runs beside its own build's start. */
    function runCycle() {
        if (state.cycle) return state.cycle;
        state.cycle = (state.build ? superviseBuild() : cycle())
            .catch((error) => { setStatus({ state: 'idle', reasonCode: `cycle_failed:${codeOf(error)}` }); })
            .finally(() => { state.cycle = null; });
        return state.cycle;
    }

    async function cycle() {
        const { config, unavailable } = currentConfig();
        const off = offReason(config);
        setStatus({ enabled: !off && !unavailable, policy: config.policy });
        const mutex = tryAcquireBuildMutex(appRoot, { kind: PRESTAGE_BUILD_MUTEX_KIND });
        if (!mutex) return setStatus({ reasonCode: 'build_in_progress' });
        let handedOff = false;
        try {
            await recover();
            if (off) return await standDown(off);
            if (unavailable) return setStatus({ state: 'blocked', reasonCode: 'settings_unavailable', quarantineUntil: null });
            const decision = await decide(config);
            if (!decision.build) return decision.status;
            handedOff = startBuild(mutex, decision.target);
            return state.status;
        } finally {
            if (!handedOff) mutex.release();
        }
    }

    function offReason(config) {
        if (config.killed) return 'killed';
        return prestageModeRefusal(readRuntime()) ?? (config.policy === 'off' ? 'policy_off' : null);
    }

    /** Per-cycle recovery (§3.3) and the orphan sweep, which only runs with no active job (M2). */
    async function recover() {
        const activeJob = safe(hasActiveJob, true);
        const outcome = await slot.recover({
            lookupJob: (jobId) => lookupJob(jobId),
            ownBuildActive: () => false,
            sweep: { allowed: !activeJob, jobReferences: activeJob ? [] : listJobReferences() },
        });
        if (!activeJob) await dropLeftoverUpdateRefs();
        if (outcome.action !== 'none' || outcome.sweep?.status === 'swept') log('recovered', { action: outcome.action, sweep: outcome.sweep });
        return outcome;
    }

    /**
     * B-1627: refs/nassaj-update/* of job runs that ended without dropping them.
     * Safe only with no active job while this process holds the build mutex:
     * a job fetches its refs only after taking that mutex. S4 qa condition (b):
     * and only a ref whose nonce timestamp is at least 10 minutes old, so a run
     * of another server process (drain) is never robbed of its refs. The
     * prestage namespace is swept by the slot module under the same age rule.
     */
    async function dropLeftoverUpdateRefs() {
        if (!runGit) return;
        const listed = await runGit(['for-each-ref', '--format=%(refname)', 'refs/nassaj-update/']);
        if (listed.code !== 0) return;
        const nowMs = now();
        for (const ref of listed.stdout.split('\n').filter(Boolean)) {
            if (isStalePrivateRef(ref, nowMs)) await runGit(['update-ref', '-d', ref]);
        }
    }

    /** Disabled or unsupported: an un-adopted slot is discarded (kill switch takes effect next cycle). */
    async function standDown(reason) {
        await discardUnadopted('disabled');
        state.pending = null;
        return setStatus({ state: 'off', reasonCode: reason, version: null, readyAt: null, quarantineUntil: null });
    }

    /**
     * Discard a `ready` slot, or this process's own `building` one
     * (`ownTransaction`). Another process's building slot (drain) is left to
     * recovery, which waits until its owner is dead; adopted ones belong to a job.
     */
    async function discardUnadopted(reason, { keep = () => false, ownTransaction = null } = {}) {
        return slot.withLock(async (tx) => {
            const current = tx.read();
            if (!current || current.corrupt || adoptedJobId(current.state) || current.state === 'discarding') return null;
            if (current.state === 'building' && current.transactionId !== ownTransaction) return null;
            if (keep(current)) return null;
            return tx.discard(current, reason);
        });
    }

    async function decide(config) {
        let target;
        try { target = await latestTarget(); } catch (error) {
            return { status: setStatus({ state: 'idle', reasonCode: `discovery_failed:${codeOf(error)}` }) };
        }
        if (!target) {
            await discardUnadopted('not_newer');
            return { status: setStatus({ state: 'idle', reasonCode: 'up_to_date', version: null, readyAt: null }) };
        }
        const current = slot.read();
        if (current && !current.corrupt && (current.state === 'building' || current.state === 'discarding')) {
            // Another server process (drain) still owns it; recovery settles it once that owner is gone.
            return { status: setStatus({ state: 'blocked', reasonCode: 'slot_busy_elsewhere', version: target.version }) };
        }
        if (sameTarget(current, target) && current.state === 'ready') {
            return { status: setStatus({ state: 'ready', reasonCode: null, version: target.version, readyAt: current.readyAt, quarantineUntil: null }) };
        }
        // Supersede (§3.3): an older ready slot is discarded first, then the new one settles.
        await discardUnadopted('superseded', { keep: (slotNow) => sameTarget(slotNow, target) });
        const firstSeen = await slot.observeFirstSeen({ tag: target.tag, targetCommit: target.releaseCommit });
        if (!settled(target, config)) {
            return { status: setStatus({ state: 'settling', reasonCode: 'settling', version: target.version, readyAt: null }) };
        }
        const policy = await evaluatePrestagePolicy(config, { firstSeen, nowMs: now(), verifySignedRelease, target });
        if (!policy.ok) {
            return { status: setStatus({ state: 'blocked', reasonCode: policy.reason, version: target.version,
                quarantineUntil: policy.until ? new Date(policy.until).toISOString() : null }) };
        }
        const refusal = await eligibilityRefusal(config, target);
        if (refusal) return { status: setStatus({ state: 'blocked', reasonCode: refusal, version: target.version, quarantineUntil: null }) };
        return { build: true, target };
    }

    /** The latest release when it is strictly newer than the loaded runtime; null otherwise. */
    async function latestTarget() {
        const { release } = await discoverRelease();
        return newerTarget(release, readRuntime());
    }

    function sameTarget(current, target) {
        return Boolean(current) && !current.corrupt && current.target?.version === target.version
            && current.target?.releaseCommit === target.releaseCommit;
    }

    /** §3.2: a newly seen target waits `settleMs` so a burst of releases costs one build. */
    function settled(target, config) {
        const key = targetKey(target);
        if (state.pending?.key !== key) {
            state.pending = { key, since: now() };
            schedule(config.settleMs);
            return false;
        }
        if (now() - state.pending.since < config.settleMs) {
            schedule(state.pending.since + config.settleMs - now());
            return false;
        }
        return true;
    }

    /** §3.2 rules 5–8 and the backoff; null when the build may start. */
    async function eligibilityRefusal(config, target) {
        if (safe(hasActiveJob, true)) return 'job_active';
        const journal = journalRefusal(safe(readJournal, null));
        if (journal) return journal;
        const backoff = backoffRefusal(target);
        if (backoff) return backoff;
        if (runPreflight) {
            let preflight;
            try { preflight = await runPreflight(); } catch (error) { return `blocked:${codeOf(error)}`; }
            const blocker = prestageBlocker(preflight);
            if (blocker) return `blocked:${blocker}`;
        }
        return resourceRefusal(config);
    }

    async function resourceRefusal(config) {
        if (safe(readMemAvailable, 0) < config.minMemBytes) return 'low_memory';
        if (safe(readFreeDisk, 0) < config.minFreeBytes) return 'low_disk';
        const samples = [];
        for (let index = 0; index < settings.resourceSamples; index += 1) {
            if (index > 0) await sleep(settings.resourceSampleGapMs);
            try { samples.push(await sampleResources()); } catch { return 'resource_unavailable'; }
        }
        const mean = (key) => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
        if (mean('cpuPercent') >= settings.resourceCeilingPercent) return 'resource_ceiling_cpu';
        if (mean('memoryPercent') >= settings.resourceCeilingPercent) return 'resource_ceiling_memory';
        return null;
    }

    function backoffRefusal(target) {
        const failure = state.failures.get(target.releaseCommit);
        if (!failure) return null;
        if (failure.count >= settings.maxFailuresPerTarget) return 'failed_gave_up';
        return now() < failure.retryAt ? 'failed_backoff' : null;
    }

    function recordFailure(target, code) {
        const previous = state.failures.get(target.releaseCommit);
        const count = (previous?.count ?? 0) + 1;
        const delay = Math.min(settings.backoffMaxMs, settings.backoffBaseMs * 2 ** (count - 1));
        state.failures.set(target.releaseCommit, { count, retryAt: now() + delay, code });
    }

    // -- the build -----------------------------------------------------------

    /** Start the build in the background; it owns `mutex` from here and releases it last. */
    function startBuild(mutex, target) {
        const controller = new AbortController();
        const transactionId = newPrestageTransactionId();
        const build = { target, transactionId, controller, reason: null, done: null };
        state.build = build;
        setStatus({ state: 'building', reasonCode: null, version: target.version, readyAt: null, quarantineUntil: null });
        build.done = runBuild(build).finally(() => {
            state.build = null;
            mutex.release();
        });
        return true;
    }

    async function runBuild(build) {
        const stopWatch = watch(build);
        let record = null;
        try {
            const builderBuildId = readRuntime().builderBuildId;
            const built = await buildPrestage({
                expectedVersion: build.target.version, transactionId: build.transactionId,
                refPrefix: prestageRefPrefix(build.transactionId), signal: build.controller.signal, builderBuildId,
                beforeCandidate: async ({ releaseCommit, identity }) => {
                    record = await slot.beginBuild({ target: { ...build.target, releaseCommit }, identity: identity.key,
                        transactionId: build.transactionId });
                },
                onBuildEffect: async (effect) => { record = await slot.recordBuildEffect(record, effect); },
            });
            if (build.controller.signal.aborted) throw abortError(build);
            record = await slot.markReady(record, outputsOf(built));
            state.failures.delete(build.target.releaseCommit);
            log('ready', { version: build.target.version, transactionId: build.transactionId });
            setStatus({ state: 'ready', reasonCode: null, readyAt: record.readyAt });
        } catch (error) {
            await failBuild(build, error);
        } finally {
            stopWatch();
        }
    }

    /**
     * The slot outputs of a built candidate. The candidate manifest records each
     * tree as `{sha256, files}` (scripts/source-update-candidate.mjs); the slot
     * keeps the sha256 (S4 fix: S3 passed the objects, which the slot refused).
     */
    function outputsOf(built) {
        const trees = built.manifest?.trees ?? {};
        return {
            manifestSha256: crypto.createHash('sha256').update(built.manifestRaw).digest('hex'),
            trees: { client: trees.client?.sha256, server: trees.server?.sha256, nodeModules: trees.nodeModules?.sha256 },
        };
    }

    async function failBuild(build, error) {
        const reason = build.reason ?? `failed:${codeOf(error)}`;
        try {
            await discardUnadopted(reason.slice(0, 64), {
                keep: (current) => current.transactionId !== build.transactionId, ownTransaction: build.transactionId,
            });
        } catch (discardError) {
            log('discard_deferred', { transactionId: build.transactionId, code: codeOf(discardError) });
        }
        if (!NO_BACKOFF_ABORTS.has(build.reason)) recordFailure(build.target, reason);
        log('build_ended', { version: build.target.version, reason });
        setStatus({ state: 'idle', reasonCode: reason, readyAt: null });
    }

    function abortError(build) {
        return Object.assign(new Error(build.reason ?? 'aborted'), { code: build.reason ?? 'aborted' });
    }

    function abortBuild(reason) {
        const build = state.build;
        if (!build) return null;
        if (!build.reason) build.reason = reason;
        build.controller.abort(new Error(reason));
        return build.done;
    }

    /** Minimal watchdog (§3.7): resource pressure or the 20-minute limit aborts the build. */
    function watch(build) {
        const interval = timers.setInterval(() => {
            if (safe(readFreeDisk, Infinity) < settings.watchdogMinFreeBytes
                || safe(readMemAvailable, Infinity) < settings.watchdogMinMemBytes) abortBuild('aborted_resources');
        }, settings.watchdogMs);
        const timeout = timers.setTimeout(() => abortBuild('timeout'), settings.buildTimeoutMs);
        return () => { timers.clearInterval(interval); timers.clearTimeout(timeout); };
    }

    /** While a build runs, a cycle only checks for a newer release (supersede) and the kill switch. */
    async function superviseBuild() {
        const build = state.build;
        const { config, unavailable } = currentConfig();
        const off = offReason(config) ?? (unavailable ? 'settings_unavailable' : null);
        if (off) {
            await abortBuild(['killed', 'policy_off', 'settings_unavailable'].includes(off) ? 'disabled' : off);
            // S7 finding: report the stand-down now, not at the next poll.
            return setStatus({ state: 'off', reasonCode: off, version: null, readyAt: null, quarantineUntil: null });
        }
        if (safe(hasActiveJob, false)) return abortBuild('job_claimed');
        let target;
        try { target = await latestTarget(); } catch { return null; }
        if (target && targetKey(target) !== targetKey(build.target)) {
            await abortBuild('superseded');
            // The newer target settles afresh from now, with its own timer (T-2025 qa 1b).
            state.pending = { key: targetKey(target), since: now() };
            schedule(config.settleMs);
            // S7 finding: the owner sees the newest release settling at once,
            // not the aborted version until the next poll.
            return setStatus({ state: 'settling', reasonCode: 'settling', version: target.version, readyAt: null,
                quarantineUntil: null });
        }
        return null;
    }

    // -- job and lifecycle ---------------------------------------------------

    /**
     * §3.4: a job claims while a prestage build runs. Abort it, wait for its
     * discard and the mutex release, and wait out a cycle in flight (it may
     * hold the mutex for recovery). Resolves true when the mutex is free of
     * the prestager, false on timeout (the job then reports update_in_progress).
     */
    async function abortForJob({ timeoutMs = settings.abortWaitMs } = {}) {
        let timer;
        let expired = false;
        const deadline = new Promise((resolve) => { timer = timers.setTimeout(() => { expired = true; resolve(); }, timeoutMs); });
        try {
            // A cycle that passed its checks before the job's claim may still start a build: loop until both are gone.
            while (state.build || state.cycle) {
                const waits = [abortBuild('job_claimed'), state.cycle].filter(Boolean);
                await Promise.race([Promise.allSettled(waits), deadline]);
                if (expired) return false;
            }
            return true;
        } finally {
            timers.clearTimeout(timer);
        }
    }

    /**
     * S4 (ADR-207 §3.4, §3.5, qa condition a): a job, holding its own build
     * mutex, asks for the slot to go — a `ready` slot it will not adopt
     * (another version, another identity, adoption off) or its own adopted
     * slot that failed verification. The discard runs here, under the slot
     * flock, with the job's authority, and resolves only once the candidate is
     * gone (frees the disk before the job's build). A `building` slot is never
     * this process's at this point (abortForJob ran before the job took the
     * mutex); one owned by another live process (drain) is left to recovery.
     * @returns {Promise<{discarded: boolean, reason?: string}>}
     */
    async function discardForJob({ jobId, reason }) {
        const outcome = await slot.withLock(async (tx) => {
            const current = tx.read();
            if (!current || current.corrupt) return { discarded: false, reason: current ? 'slot_corrupt' : 'slot_empty' };
            if (current.state === 'ready') return tx.discard(current, reason, { jobId });
            if (adoptedJobId(current.state) === jobId) return tx.rejectAdoption(current, { jobId, reason });
            return { discarded: false, reason: `slot_${current.state.split(':')[0]}` };
        });
        log('discarded_for_job', { jobId, reason, discarded: outcome.discarded });
        if (outcome.discarded) setStatus({ state: 'idle', reasonCode: `rejected:${reason}`.slice(0, 64), readyAt: null });
        return outcome;
    }

    /**
     * The port updateSource() adopts through (S4). `adoptable` is false under
     * the kill switch or a disabled mode: the job then discards a ready slot
     * instead of adopting it.
     */
    function adoptionPort() {
        return {
            slot,
            adoptable: () => {
                const { config, unavailable } = currentConfig();
                return !unavailable && !offReason(config);
            },
            discard: discardForJob,
            onAdopted: ({ jobId, version }) => {
                log('adopted', { jobId, version });
                setStatus({ state: 'adopted', reasonCode: null, version });
            },
        };
    }

    /**
     * T-2025: a release seen by another discovery path wakes one cycle now,
     * once per release (`tag@commit`), instead of waiting up to a poll
     * interval. Nothing is woken when the release is not newer than the
     * runtime, the prestager is stopped, off or without settings, or a job is
     * active. The release's wake is used up only once the woken cycle has
     * taken the release on (settling, or building it); a cycle that could not
     * (mutex taken, discovery failed) leaves it for the next call. The woken
     * cycle keeps every gate (policy and quarantine, journal, backoff,
     * resources) and the settle window. Returns the wake promise, or null.
     * @param {object} release
     * @param {{config: object, unavailable: boolean}} [current] the configuration already read (probe)
     */
    function noteRelease(release, current = null) {
        if (state.stopped || typeof release?.version !== 'string') return null;
        const target = safe(() => newerTarget(release, readRuntime()), null);
        if (!target) return null;
        const key = targetKey(target);
        if (state.woken.has(key) || state.waking.has(key)) return null;
        if (tracking(key)) {
            rememberWoken(key); // the prestager already took it on: its own timers carry it
            return null;
        }
        const { config, unavailable } = current ?? currentConfig();
        if (unavailable || offReason(config) || safe(hasActiveJob, true)) return null;
        state.waking.add(key);
        log('wake_on_discovery', { version: target.version });
        return wake().finally(() => {
            state.waking.delete(key);
            if (tracking(key)) rememberWoken(key);
        });
    }

    /** Whether the prestager is settling, gating or building exactly this release key. */
    function tracking(key) {
        return state.pending?.key === key || (Boolean(state.build) && targetKey(state.build.target) === key);
    }

    function rememberWoken(key) {
        state.woken.add(key);
        if (state.woken.size > settings.maxWokenReleases) state.woken.delete(state.woken.values().next().value);
    }

    function schedule(delayMs) {
        if (state.stopped) return;
        const delay = Math.max(1_000, Math.round(delayMs));
        if (state.timer && state.timer.at <= now() + delay) return;
        if (state.timer) timers.clearTimeout(state.timer.handle);
        const handle = timers.setTimeout(() => { state.timer = null; void runCycle().finally(scheduleNextPoll); }, delay);
        handle?.unref?.();
        state.timer = { handle, at: now() + delay };
    }

    function scheduleNextPoll() {
        const { pollMs } = resolvePrestageConfig(env, { logger });
        schedule(Math.max(settings.minPollMs, pollMs * (1 + settings.jitter * (2 * random() - 1))));
    }

    /**
     * T-2025: the lightweight discovery probe. It reads the shared discovery
     * (cached: at most one ls-remote per TTL) and hands the release to
     * noteRelease(); it never builds, recovers or takes the mutex itself.
     * Off (setting or mode) skips the discovery; the kill switch, fixed for
     * the process, ends the probe; stop() clears it.
     * @returns {Promise<unknown>} the wake noteRelease() started, or null
     */
    async function probe() {
        if (state.stopped) return null;
        const { config, unavailable } = currentConfig();
        if (config.killed) { state.probeEnded = true; clearProbe(); return null; }
        if (unavailable || offReason(config)) return null;
        let release;
        try { ({ release } = await discoverRelease()); } catch { return null; }
        return state.stopped ? null : noteRelease(release, { config, unavailable });
    }

    function scheduleProbe() {
        if (state.stopped || state.probeEnded) return;
        const delay = Math.max(1_000, Math.round(settings.probeMs * (1 + settings.probeJitter * random())));
        const handle = timers.setTimeout(() => {
            state.probeTimer = null;
            void probe().catch(() => null).finally(() => { if (!state.probeTimer) scheduleProbe(); });
        }, delay);
        handle?.unref?.();
        state.probeTimer = handle;
    }

    function clearProbe() {
        if (state.probeTimer) timers.clearTimeout(state.probeTimer);
        state.probeTimer = null;
    }

    function start() {
        if (!state.stopped) return;
        state.stopped = false;
        state.probeEnded = false;
        schedule(settings.firstPollMs);
        scheduleProbe();
    }

    /**
     * T-2030 (qa condition 3): run a cycle now after the owner changed the
     * setting — off aborts/discards at once, on starts settling. After a
     * cycle already in flight (it may have read the old value); no-op while
     * stopped (not started, or drained).
     */
    function wake() {
        if (state.stopped) return Promise.resolve(null);
        return Promise.resolve(state.cycle).then(() => (state.stopped ? null : runCycle()));
    }

    /** Stop polling; with `drain`, abort a running build (its launcher group dies) and wait for the discard. */
    async function stop({ drain = false } = {}) {
        state.stopped = true;
        if (state.timer) timers.clearTimeout(state.timer.handle);
        state.timer = null;
        clearProbe();
        if (drain) await abortBuild('drain');
    }

    return {
        start, stop, runCycle, wake, noteRelease, probe, abortForJob, discardForJob, adoptionPort,
        status: () => ({ ...state.status }),
        /** Test seam: the running build's transaction, or null. */
        buildInFlight: () => state.build?.transactionId ?? null,
    };
}

/** The identity of a prestage target: a re-tag on a new commit, or a new tag on the same commit, is a new key. */
function targetKey(target) {
    return `${target.tag}@${target.releaseCommit}`;
}

/** The release as a prestage target when it is strictly newer than the loaded runtime; null otherwise. */
function newerTarget(release, runtime) {
    if (release.commit && release.commit === runtime.runtimeCommit) return null;
    if (runtime.runtimeVersion && compareNassajReleaseVersions(release.version, runtime.runtimeVersion) <= 0) return null;
    return { version: release.version, tag: release.tagName || releaseTagForVersion(release.version), releaseCommit: release.commit };
}

/**
 * The first preflight blocker that applies to a prestage. Active sessions do
 * not block prestaging (owner decision 1), so `active_sessions` is skipped and
 * the next blocker in priority order is reported instead.
 */
export function prestageBlocker(preflight) {
    if (!preflight) return null;
    if (Array.isArray(preflight.checks)) {
        return preflight.checks.find((check) => check?.severity === 'blocker' && check.code !== 'active_sessions')?.code ?? null;
    }
    const code = preflight.blocker?.code ?? (preflight.blocker ? 'preflight' : null);
    return code === 'active_sessions' ? null : code;
}

function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
}

function codeOf(error) {
    const code = typeof error?.code === 'string' ? error.code : (typeof error?.message === 'string' ? error.message : '');
    return /^[A-Za-z0-9_:.-]{1,64}$/.test(code) ? code : 'unknown';
}

/** MemAvailable in bytes from /proc/meminfo; 0 when unreadable (the gate then refuses). */
export function readMemAvailableBytes(readFile = fs.readFileSync) {
    try {
        const match = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(readFile('/proc/meminfo', 'utf8'));
        return match ? Number(match[1]) * 1024 : 0;
    } catch {
        return 0;
    }
}

/** Free bytes for an unprivileged writer on `target`'s filesystem; 0 when unreadable. */
export function readFreeBytes(target, statfs = fs.statfsSync) {
    try {
        const stats = statfs(target);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return 0;
    }
}
