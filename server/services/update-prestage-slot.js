/**
 * ADR-207 §3.3 (T-2024 S2): the prestage slot — mechanism only, no policy and
 * no database access (the caller passes job facts in).
 *
 * Layout under the update control root (the same filesystem as candidates):
 *
 *   candidates/update-pre-<nonce>/   the candidate, laid out like a job's
 *   plan-update-pre-<nonce>.json     its build plan
 *   prestage/lock                    exclusive flock target; never deleted
 *   prestage/slot.json               nassaj-prestage-slot/v1
 *   prestage/first-seen.json         nassaj-prestage-first-seen/v1 (quarantine clock)
 *   prestage/history.jsonl           last 50 outcomes, no secrets
 *
 * States: (empty) → building → ready → adopted:<jobId> → (empty), and
 * building|ready → discarding → (empty). Every write is atomic (tmp, fsync,
 * rename, directory fsync) and happens only under the exclusive flock on
 * `prestage/lock` (M3); every transition is a compare-and-swap on the slot's
 * `slotId`, `revision` and `state`. Before anything of a slot is deleted its
 * build group is killed and verified gone (update-prestage-process-group.js).
 *
 * The prestager must write `building` (with its transactionId) BEFORE it
 * creates `candidates/<transactionId>`, so a directory is never unnamed while
 * its build runs; the orphan sweep relies on it.
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { flockAsync } from './update-maintenance-gate.js';
import { buildMutexHolder } from './source-update-build-mutex.js';
import { canonicalJson, sha256Hex } from './update-prestage-identity.js';
import {
    currentProcessIdentity, isCurrentProcess, isProcessIdentityAlive, isValidEffectIdentity, killVerifiedBuildGroup, linuxProc,
} from './update-prestage-process-group.js';

export const PRESTAGE_SLOT_SCHEMA = 'nassaj-prestage-slot/v1';
export const PRESTAGE_FIRST_SEEN_SCHEMA = 'nassaj-prestage-first-seen/v1';
export const PRESTAGE_TX_PREFIX = 'update-pre-';
export const PRESTAGE_REF_ROOT = 'refs/nassaj-prestage';
export const PRESTAGE_BUILD_MUTEX_KIND = 'source-update-prestage';

const PRESTAGE_TX = /^update-pre-([A-Za-z0-9][A-Za-z0-9._-]{0,83})$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ADOPTED = /^adopted:(.+)$/;
// manual_recovery_required is deliberately absent, as in candidate retention.
const TERMINAL_JOB_STATES = new Set(['activated', 'rolled_back', 'failed', 'superseded', 'cancelled']);
const HISTORY_LIMIT = 50;
const FIRST_SEEN_LIMIT = 32;
/** B-1627 (S4 qa b): a private ref younger than this may belong to a run in flight; it is never removed. */
export const PRIVATE_REF_MIN_AGE_MS = 10 * 60_000;
// `<pid>-<Date.now()>-<random>`: the nonce of a job run (createRunState) or a prestage transaction.
const NONCE_REF = /^refs\/nassaj-(?:update|prestage)\/\d+-(\d{10,16})-[^/]+\//;

export class PrestageSlotError extends Error {
    constructor(code, details = {}) {
        super(code);
        this.code = code;
        Object.assign(this, details);
    }
}

/** The prestage paths under an update control root. */
export function prestagePaths(controlRoot) {
    const root = path.join(controlRoot, 'prestage');
    return {
        controlRoot, root, lock: path.join(root, 'lock'), slot: path.join(root, 'slot.json'),
        firstSeen: path.join(root, 'first-seen.json'), history: path.join(root, 'history.jsonl'),
        candidatesRoot: path.join(controlRoot, 'candidates'),
    };
}

/** A fresh `update-pre-<nonce>` transaction id (the action schema's TX pattern). */
export function newPrestageTransactionId() {
    return `${PRESTAGE_TX_PREFIX}${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Whether a private `refs/nassaj-update/*` or `refs/nassaj-prestage/*` ref is
 * old enough to be leftover (B-1627, S4 qa condition b): its nonce timestamp is
 * at least PRIVATE_REF_MIN_AGE_MS old. A ref of any other shape, or with a
 * timestamp in the future, is never stale: the sweep keeps what it cannot date.
 */
export function isStalePrivateRef(ref, nowMs, minAgeMs = PRIVATE_REF_MIN_AGE_MS) {
    const stamp = Number(NONCE_REF.exec(ref || '')?.[1]);
    return Number.isSafeInteger(stamp) && stamp <= nowMs && nowMs - stamp >= minAgeMs;
}

/** The private ref namespace of one prestage transaction (`--refmap=` fetch target, S3). */
export function prestageRefPrefix(transactionId) {
    const match = PRESTAGE_TX.exec(transactionId || '');
    if (!match) throw new PrestageSlotError('prestage_transaction_invalid');
    return `${PRESTAGE_REF_ROOT}/${match[1]}/`;
}

// ---------------------------------------------------------------------------
// Durable files
// ---------------------------------------------------------------------------

function fsyncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** tmp (wx, 0600) + write + fsync + rename + directory fsync. */
export function writeJsonAtomic(file, value) {
    const directory = path.dirname(file);
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
        fs.fsyncSync(fd);
    } catch (error) {
        fs.closeSync(fd);
        fs.rmSync(temporary, { force: true });
        throw error;
    }
    fs.closeSync(fd);
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
}

function removeDurably(file) {
    fs.rmSync(file, { force: true });
    fsyncDirectory(path.dirname(file));
}

function readJsonFile(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
        if (error?.code === 'ENOENT') return { missing: true };
        return { corrupt: true };
    }
    try { return { value: JSON.parse(raw) }; } catch { return { corrupt: true }; }
}

function ensurePrestageRoot(paths) {
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    const metadata = fs.lstatSync(paths.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new PrestageSlotError('prestage_root_unsafe');
    }
    fs.closeSync(fs.openSync(paths.lock, 'a', 0o600));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function isIdentity(identity) {
    return Boolean(identity) && Number.isSafeInteger(identity.pid) && identity.pid > 0
        && typeof identity.startTicks === 'string' && typeof identity.bootId === 'string';
}

function isOutputs(outputs) {
    return Boolean(outputs) && SHA256.test(outputs.manifestSha256 || '')
        && ['client', 'server', 'nodeModules'].every((tree) => SHA256.test(outputs.trees?.[tree] || ''));
}

/** The adopting job id of an `adopted:<jobId>` state, or null. */
export function adoptedJobId(state) {
    return ADOPTED.exec(state || '')?.[1] ?? null;
}

function stateIsValid(slot) {
    const job = adoptedJobId(slot.state);
    if (job !== null) return JOB_ID.test(job) && isOutputs(slot.outputs);
    if (slot.state === 'ready') return isOutputs(slot.outputs) && slot.build.effect === null;
    return slot.state === 'building' || slot.state === 'discarding';
}

/** Strict validation of a slot record; false for anything this module did not write. */
export function isValidSlot(slot) {
    return Boolean(slot) && slot.schema === PRESTAGE_SLOT_SCHEMA
        && typeof slot.slotId === 'string' && /^[0-9a-f-]{36}$/.test(slot.slotId)
        && Number.isSafeInteger(slot.revision) && slot.revision > 0
        && PRESTAGE_TX.test(slot.transactionId || '')
        && typeof slot.target?.version === 'string' && typeof slot.target?.tag === 'string'
        && SHA1.test(slot.target?.releaseCommit || '')
        && slot.identity?.releaseCommit === slot.target.releaseCommit
        && slot.keyDigest === sha256Hex(canonicalJson(slot.identity))
        && isIdentity(slot.build?.owner)
        && (slot.build.effect === null || isValidEffectIdentity(slot.build.effect))
        && stateIsValid(slot);
}

// ---------------------------------------------------------------------------
// The slot
// ---------------------------------------------------------------------------

function defaultRunGit(appRoot) {
    return (args) => new Promise((resolve) => {
        const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
            cwd: appRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
        });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
        child.once('error', () => resolve({ code: -1, stdout }));
        child.once('close', (code) => resolve({ code: code ?? -1, stdout }));
    });
}

/**
 * The prestage slot of one source tree.
 * @param {object} deps
 * @param {string} deps.appRoot      the live source tree (git cwd for worktree/ref cleanup)
 * @param {string} deps.controlRoot  the update control root (`<common-git-dir>/nassaj-source-update`)
 * @param {typeof flockAsync} [deps.flock]
 * @param {typeof linuxProc} [deps.proc]
 * @param {(pid: number, signal: string) => void} [deps.kill]
 * @param {(args: string[]) => Promise<{code: number, stdout: string}>} [deps.runGit]
 * @param {() => number} [deps.now]
 * @param {number} [deps.lockWaitMs]
 * @param {number} [deps.killWaitMs]
 */
export function createPrestageSlot({
    appRoot, controlRoot, flock = flockAsync, proc = linuxProc, kill = process.kill.bind(process),
    runGit = defaultRunGit(appRoot), now = Date.now, lockWaitMs = 10_000, killWaitMs = 5_000,
} = {}) {
    if (!appRoot || !controlRoot) throw new TypeError('prestage slot needs appRoot and controlRoot');
    const paths = prestagePaths(controlRoot);
    const iso = () => new Date(now()).toISOString();

    /** Snapshot read without the lock (status display); null when empty. */
    function readSlot() {
        const read = readJsonFile(paths.slot);
        if (read.missing) return null;
        if (read.corrupt || !isValidSlot(read.value)) return { corrupt: true };
        return read.value;
    }

    function appendHistory(entry) {
        let lines = [];
        try { lines = fs.readFileSync(paths.history, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
        lines.push(JSON.stringify({ at: iso(), ...entry }));
        const kept = lines.slice(-HISTORY_LIMIT);
        const temporary = `${paths.history}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, `${kept.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, paths.history);
    }

    function writeSlot(slot) {
        writeJsonAtomic(paths.slot, slot);
        return slot;
    }

    /** Compare-and-swap guard: the slot on disk must be exactly the one the caller holds. */
    function requireSlot(expected, states) {
        const current = readSlot();
        if (!current || current.corrupt || current.slotId !== expected.slotId
            || current.revision !== expected.revision || !states(current.state)) {
            throw new PrestageSlotError('prestage_slot_conflict', { current: current?.corrupt ? 'corrupt' : current?.state ?? null });
        }
        return current;
    }

    function advance(current, fields) {
        return writeSlot({ ...current, ...fields, revision: current.revision + 1, updatedAt: iso() });
    }

    /**
     * qa S3 condition 2: every delete of slot state happens under the build
     * mutex of this source tree, so no prestage build of this process can run
     * beside it. Normally that is the prestage mutex. S4 (ADR-207 §3.4, §3.5):
     * a job never deletes a prestage directly, it asks the prestager
     * (`discardForJob`), which passes `{jobId}` — accepted only while the
     * build mutex is held by that same job's update, never by another job.
     * @param {{jobId?: string|null}} [authority]
     */
    function assertDeleteAuthority(authority = {}) {
        const holder = buildMutexHolder(appRoot);
        if (holder?.kind === PRESTAGE_BUILD_MUTEX_KIND) return;
        if (holder?.kind === 'source-update' && typeof authority?.jobId === 'string' && JOB_ID.test(authority.jobId)
            && holder.jobId === authority.jobId) return;
        throw new PrestageSlotError('prestage_mutex_not_held');
    }

    // -- locked operations (the caller holds the flock) ----------------------

    const locked = {
        read: readSlot,
        recover: (input) => recoverLocked(input),

        /** (empty) → building. `identity` is buildPrestageIdentityKey().key; its digest is the slot's key. */
        beginBuild({ target, identity, transactionId, owner = currentProcessIdentity(proc) }) {
            const current = readSlot();
            if (current) throw new PrestageSlotError('prestage_slot_occupied', { current: current.corrupt ? 'corrupt' : current.state });
            const slot = {
                schema: PRESTAGE_SLOT_SCHEMA, slotId: crypto.randomUUID(), revision: 1, state: 'building',
                transactionId, target: { version: target?.version, tag: target?.tag, releaseCommit: target?.releaseCommit },
                identity, keyDigest: identity ? sha256Hex(canonicalJson(identity)) : null,
                build: { owner, effect: null, startedAt: iso() },
                outputs: null, readyAt: null, discardReason: null, createdAt: iso(), updatedAt: iso(),
            };
            if (!isValidSlot(slot)) throw new PrestageSlotError('prestage_slot_invalid');
            return writeSlot(slot);
        },

        recordBuildEffect(expected, effect) {
            if (!isValidEffectIdentity(effect)) throw new PrestageSlotError('prestage_effect_invalid');
            const current = requireSlot(expected, (state) => state === 'building');
            return advance(current, { build: { ...current.build, effect: { ...effect } } });
        },

        markReady(expected, outputs) {
            if (!isOutputs(outputs)) throw new PrestageSlotError('prestage_outputs_invalid');
            const current = requireSlot(expected, (state) => state === 'building');
            // The launcher reported completion: its group is gone, so no kill is ever aimed at it again.
            return advance(current, { state: 'ready', outputs: { ...outputs, trees: { ...outputs.trees } },
                readyAt: iso(), build: { ...current.build, effect: null } });
        },

        adopt(expected, { jobId, keyDigest }) {
            if (!JOB_ID.test(jobId || '')) throw new PrestageSlotError('prestage_job_invalid');
            const current = requireSlot(expected, (state) => state === 'ready');
            if (current.keyDigest !== keyDigest) throw new PrestageSlotError('prestage_identity_mismatch');
            const adopted = advance(current, { state: `adopted:${jobId}` });
            appendHistory({ outcome: 'adopted', slotId: current.slotId, version: current.target.version, jobId });
            return adopted;
        },

        /**
         * building|ready → discarding → (empty). Returns the finish outcome.
         * `authority` is `{jobId}` when a job asked for it (assertDeleteAuthority).
         */
        async discard(expected, reason, authority = {}) {
            assertDeleteAuthority(authority);
            const current = requireSlot(expected, (state) => state === 'building' || state === 'ready');
            const discarding = advance(current, { state: 'discarding', discardReason: String(reason).slice(0, 64) });
            return finishDiscard(discarding, authority);
        },

        /**
         * S4 (ADR-207 §3.5 step 6): the adopting job found the adopted candidate
         * unfit (worktree, manifest or tree hashes) before it handed it to
         * sealAndQueue(): `adopted:<jobId>` → discarding → (empty). Only that
         * job may ask, under its own build mutex; the candidate was never sealed.
         */
        async rejectAdoption(expected, { jobId, reason }) {
            assertDeleteAuthority({ jobId });
            const current = requireSlot(expected, (state) => state === `adopted:${jobId}`);
            appendHistory({ outcome: 'adoption_rejected', slotId: current.slotId, jobId, reason: String(reason).slice(0, 64) });
            const discarding = advance(current, { state: 'discarding', discardReason: String(reason).slice(0, 64) });
            return finishDiscard(discarding, { jobId });
        },

        /** Remove the `adopted:<jobId>` marker once the job owns the candidate. The candidate stays. */
        releaseAdopted(expected) {
            assertDeleteAuthority();
            const current = requireSlot(expected, (state) => adoptedJobId(state) !== null);
            removeDurably(paths.slot);
            appendHistory({ outcome: 'adoption_settled', slotId: current.slotId, jobId: adoptedJobId(current.state) });
            return { released: true };
        },
    };

    async function removeCandidateFiles(transactionId) {
        if (!PRESTAGE_TX.test(transactionId)) throw new PrestageSlotError('prestage_transaction_invalid');
        const candidate = path.join(paths.candidatesRoot, transactionId);
        if (path.dirname(candidate) !== paths.candidatesRoot) throw new PrestageSlotError('prestage_transaction_invalid');
        await runGit(['worktree', 'remove', '--force', path.join(candidate, 'source')]);
        await fs.promises.rm(candidate, { recursive: true, force: true });
        fs.rmSync(path.join(controlRoot, `plan-${transactionId}.json`), { force: true });
        await dropRefs((ref) => ref.startsWith(prestageRefPrefix(transactionId)));
    }

    async function dropRefs(select) {
        const listed = await runGit(['for-each-ref', '--format=%(refname)', `${PRESTAGE_REF_ROOT}/`]);
        if (listed.code !== 0) return 0;
        let dropped = 0;
        for (const ref of listed.stdout.split('\n').filter(Boolean)) {
            if (!select(ref)) continue;
            if ((await runGit(['update-ref', '-d', ref])).code === 0) dropped += 1;
        }
        return dropped;
    }

    /** Kill-verify the build group, delete the candidate, then the slot file. Kept `discarding` if unverified. */
    async function finishDiscard(slot, authority = {}) {
        assertDeleteAuthority(authority);
        const killed = await killVerifiedBuildGroup(slot.build.effect, { proc, kill, waitMs: killWaitMs });
        if (!killed.verified) {
            appendHistory({ outcome: 'discard_deferred', slotId: slot.slotId, reason: killed.reason });
            return { discarded: false, reason: killed.reason };
        }
        await removeCandidateFiles(slot.transactionId);
        removeDurably(paths.slot);
        appendHistory({ outcome: 'discarded', slotId: slot.slotId, version: slot.target.version,
            reason: slot.discardReason, killed: killed.killed });
        return { discarded: true, reason: slot.discardReason, killed: killed.killed };
    }

    /** Run `fn(locked)` under the exclusive flock on prestage/lock. */
    async function withLock(fn, { signal } = {}) {
        ensurePrestageRoot(paths);
        const held = await flock(paths.lock, 'exclusive', { signal, waitMs: lockWaitMs });
        try {
            return await fn(locked);
        } finally {
            held.release();
        }
    }

    // -- recovery (ADR-207 §3.3: every cycle, not only at boot) ---------------

    /**
     * One recovery pass under the flock.
     * @param {object} input
     * @param {(jobId: string) => ({state: string, transactionId: string|null} | null | undefined)} input.lookupJob
     *   null = no such job row; undefined = unknown (the marker is kept)
     * @param {string|null} [input.expectedKeyDigest] the current identity digest; a ready slot that differs is discarded
     * @param {() => boolean} [input.ownBuildActive] whether this process's prestage build is still running
     *   (the caller's own flag: the recovery itself runs under the prestage mutex, so the mutex cannot tell)
     * @param {{allowed: boolean, jobReferences: Iterable<string | {transactionId: string|null}>}} [input.sweep]
     *   the orphan sweep; allowed only while no job is active (M2). `jobReferences` must be EVERY job
     *   row, whatever its state (qa S3 condition 1: an activated job's candidate is its rollback).
     */
    async function recoverLocked({ lookupJob, expectedKeyDigest = null, ownBuildActive = () => false, sweep = null }) {
        assertDeleteAuthority();
        let slot = readSlot();
        const outcome = { slot: null, action: 'none', sweep: null };
        if (slot?.corrupt) {
            quarantineCorruptSlot();
            outcome.action = 'corrupt_quarantined';
            slot = null;
        } else if (slot) {
            Object.assign(outcome, await recoverSlot(slot, { lookupJob, expectedKeyDigest, ownBuildActive }));
        }
        outcome.slot = readSlot()?.state ?? null;
        outcome.sweep = await sweepOrphans(sweep);
        return outcome;
    }

    async function recoverSlot(slot, { lookupJob, expectedKeyDigest, ownBuildActive }) {
        if (slot.state === 'discarding') return { action: 'discard_finished', ...(await finishDiscard(slot)) };
        if (slot.state === 'building') return recoverBuilding(slot, ownBuildActive);
        if (slot.state === 'ready') return recoverReady(slot, expectedKeyDigest);
        const jobId = adoptedJobId(slot.state);
        let job;
        try { job = lookupJob(jobId); } catch { job = undefined; }
        if (job === undefined) return { action: 'adopted_kept_unknown_job' };
        const settled = job === null || TERMINAL_JOB_STATES.has(job.state) || job.transactionId === slot.transactionId;
        if (!settled) return { action: 'adopted_kept' };
        locked.releaseAdopted(slot);
        return { action: 'adoption_settled' };
    }

    async function recoverBuilding(slot, ownBuildActive) {
        if (isCurrentProcess(slot.build.owner, proc)) {
            if (ownBuildActive()) return { action: 'building_kept_own' };
            return { action: 'discarded_own_lost', ...(await locked.discard(slot, 'own_build_lost')) };
        }
        // Drain: another live server process owns it; leave it until that identity is dead.
        if (isProcessIdentityAlive(slot.build.owner, proc)) return { action: 'building_kept_foreign_live' };
        return { action: 'discarded_owner_dead', ...(await locked.discard(slot, 'owner_dead')) };
    }

    async function recoverReady(slot, expectedKeyDigest) {
        if (!fs.existsSync(path.join(paths.candidatesRoot, slot.transactionId))) {
            return { action: 'discarded_candidate_missing', ...(await locked.discard(slot, 'candidate_missing')) };
        }
        if (expectedKeyDigest && expectedKeyDigest !== slot.keyDigest) {
            return { action: 'discarded_identity_mismatch', ...(await locked.discard(slot, 'identity_mismatch')) };
        }
        return { action: 'ready_kept' };
    }

    function quarantineCorruptSlot() {
        const target = path.join(paths.root, `slot.corrupt-${now()}.json`);
        fs.renameSync(paths.slot, target);
        fsyncDirectory(paths.root);
        appendHistory({ outcome: 'corrupt_quarantined', file: path.basename(target) });
    }

    /**
     * Invariant (M4): at most one un-adopted `update-pre-*` candidate. Removes
     * every `update-pre-*` directory, plan and ref that neither slot.json nor a
     * job names. Refused unless the caller proves it may sweep.
     */
    async function sweepOrphans(sweep) {
        const named = new Set();
        for (const reference of sweep?.jobReferences ?? []) {
            const transactionId = typeof reference === 'string' ? reference : reference?.transactionId;
            if (typeof transactionId === 'string' && transactionId) named.add(transactionId);
        }
        const current = readSlot();
        if (current && !current.corrupt) named.add(current.transactionId);
        const orphans = listPrestageEntries().filter((name) => !named.has(name));
        if (!sweep?.allowed) return { status: 'deferred', orphans: orphans.length };
        assertDeleteAuthority();
        for (const name of orphans) {
            await runGit(['worktree', 'remove', '--force', path.join(paths.candidatesRoot, name, 'source')]);
            await fs.promises.rm(path.join(paths.candidatesRoot, name), { recursive: true, force: true });
        }
        for (const plan of listPrestagePlans().filter((tx) => !named.has(tx))) {
            fs.rmSync(path.join(controlRoot, `plan-${plan}.json`), { force: true });
        }
        const keepRefs = [...named].filter((tx) => PRESTAGE_TX.test(tx)).map(prestageRefPrefix);
        const nowMs = now();
        // B-1627 (S4 qa b): an unnamed ref younger than 10 min may be a run in flight; it stays.
        const refs = await dropRefs((ref) => !keepRefs.some((prefix) => ref.startsWith(prefix)) && isStalePrivateRef(ref, nowMs));
        return { status: 'swept', removed: orphans.sort(), refs };
    }

    function listPrestageEntries() {
        let names;
        try { names = fs.readdirSync(paths.candidatesRoot); } catch { return []; }
        return names.filter((name) => PRESTAGE_TX.test(name)
            && fs.lstatSync(path.join(paths.candidatesRoot, name)).isDirectory());
    }

    function listPrestagePlans() {
        return fs.readdirSync(controlRoot)
            .map((name) => /^plan-(update-pre-[A-Za-z0-9._-]+)\.json$/.exec(name)?.[1])
            .filter((tx) => tx && PRESTAGE_TX.test(tx));
    }

    // -- first-seen store (quarantine clock, ADR-207 §3.2 rule 4) -------------

    function readFirstSeenFile() {
        const read = readJsonFile(paths.firstSeen);
        const value = read.value;
        if (value?.schema !== PRESTAGE_FIRST_SEEN_SCHEMA || !value.entries || typeof value.entries !== 'object') return {};
        return value.entries;
    }

    /** The node-local first sighting of `tag` at `targetCommit`, or null. Never the tag's own date. */
    function readFirstSeen(tag) {
        const entry = readFirstSeenFile()[tag];
        return entry && SHA1.test(entry.targetCommit || '') && Number.isSafeInteger(entry.firstSeenAt) ? entry : null;
    }

    /**
     * Record that this node sees `tag` at `targetCommit` now. The clock starts
     * at the first sighting and restarts when the tag moves to another commit.
     */
    function observeFirstSeenLocked({ tag, targetCommit }) {
        if (typeof tag !== 'string' || !tag || !SHA1.test(targetCommit || '')) throw new PrestageSlotError('prestage_first_seen_invalid');
        const entries = readFirstSeenFile();
        const previous = entries[tag];
        if (previous?.targetCommit === targetCommit && Number.isSafeInteger(previous.firstSeenAt)) {
            return { ...previous, reset: false };
        }
        const entry = { targetCommit, firstSeenAt: now() };
        const kept = Object.entries({ ...entries, [tag]: entry })
            .sort(([, left], [, right]) => (right.firstSeenAt ?? 0) - (left.firstSeenAt ?? 0)).slice(0, FIRST_SEEN_LIMIT);
        writeJsonAtomic(paths.firstSeen, { schema: PRESTAGE_FIRST_SEEN_SCHEMA, entries: Object.fromEntries(kept) });
        return { ...entry, reset: Boolean(previous) };
    }

    return {
        paths, read: readSlot, withLock,
        beginBuild: (input) => withLock((tx) => tx.beginBuild(input)),
        recordBuildEffect: (expected, effect) => withLock((tx) => tx.recordBuildEffect(expected, effect)),
        markReady: (expected, outputs) => withLock((tx) => tx.markReady(expected, outputs)),
        adopt: (expected, input) => withLock((tx) => tx.adopt(expected, input)),
        discard: (expected, reason, authority) => withLock((tx) => tx.discard(expected, reason, authority)),
        rejectAdoption: (expected, input) => withLock((tx) => tx.rejectAdoption(expected, input)),
        recover: (input) => withLock(() => recoverLocked(input)),
        observeFirstSeen: (input) => withLock(() => observeFirstSeenLocked(input)),
        readFirstSeen,
    };
}

/** Milliseconds left of a quarantine of `quarantineMs` from a first sighting; 0 when over. */
export function quarantineRemainingMs(firstSeen, quarantineMs, nowMs = Date.now()) {
    if (!firstSeen || !Number.isSafeInteger(firstSeen.firstSeenAt)) return quarantineMs;
    return Math.max(0, firstSeen.firstSeenAt + quarantineMs - nowMs);
}
