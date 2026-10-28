/**
 * ADR-216 — governed re-attach of a detached release checkout.
 *
 * One module for the server operation, `doctor --attach-release-branch` /
 * `--revert-release-attach` and the installer's `release-checkout` step. The
 * order is the same everywhere (§3.3): a non-blocking `source-attach.lock`,
 * the network-free inspection and quiescence (L1–L7), the online proof into
 * private refs, and only then the exclusive source-ref lease, inside which the
 * work is local only: L7 again, HEAD and the private refs re-verified, then the
 * apply. Nothing here writes the work tree, the index, the journal or
 * `.git/shallow`; every ref write is a compare-and-swap and HEAD flips last.
 *
 * Trust is the update path's own (`checkReleaseRemote`, `proveTagOnBranch`),
 * stricter only in requiring an annotated tag, as discovery already does.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isNassajReleaseVersion, releaseTagForVersion } from '../../shared/release-version-policy.js';
import {
    SAFE_UPDATE_BRANCH, SAFE_UPDATE_REMOTE, advanceRemoteTrackingRef, checkReleaseRemote, proveTagOnBranch,
    releaseGitEnvironment,
} from '../../server/services/source-updater.js';
import { parsePorcelainStatus } from './update-worktree-cleanliness.mjs';

/** t2: scoped to this path only; the updater's own runner is unchanged. */
export const ATTACH_GIT_CONFIG = Object.freeze([
    '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.fsmonitor=false',
]);
/** Same registry symbol the gate brands its lease with (update-maintenance-gate.js). */
export const SOURCE_REF_LEASE = Symbol.for('nassaj.exclusiveSourceRefLease');
export const ATTACH_REF_ROOT = 'refs/nassaj-attach';
export const ATTACH_RECEIPT_SCHEMA = 'nassaj-source-attach-receipt/v1';
export const ATTACH_LOCK_NAME = 'source-attach.lock';
export const ATTACH_RECEIPT_DIR = 'source-attach';
export const DEFAULT_ATTACH_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 1024 * 1024;
const ZERO_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;
const HEAD_FLIP_MESSAGE = 'nassaj: attach release branch';
const ATTACH_LOG_MESSAGE = 'nassaj: attach release branch ref';
const REVERT_LOG_MESSAGE = 'nassaj: revert release attach';
/** Prove codes that mean "this HEAD is not a published release commit". */
export const RELEASE_IDENTITY_CODES = Object.freeze([
    'head_not_release', 'local_tag_mismatch', 'tag_not_annotated', 'head_not_release_tag',
    'tag_not_on_release_branch', 'ancestry_unproven',
]);

/** An attach refusal or failure that carries one public code. */
export class ReleaseAttachError extends Error {
    constructor(code, details = null) {
        super(code);
        this.name = 'ReleaseAttachError';
        this.code = code;
        this.details = details;
    }
}

/** `NASSAJ_ATTACH_FETCH_TIMEOUT_MS`, else the 120 s default (§3.1 step 2). */
export function attachFetchDeadlineMs(env = process.env) {
    const value = Number(env.NASSAJ_ATTACH_FETCH_TIMEOUT_MS);
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ATTACH_FETCH_TIMEOUT_MS;
}

/**
 * Run one governed git command: its own process group (a hung fetch dies with
 * its ssh), a hard deadline, bounded stdout. stderr is kept bounded for the
 * caller's diagnosis only and is never part of a public result.
 */
function runAttachGit({ appRoot, args, env, timeoutMs, signal }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn('git', [...ATTACH_GIT_CONFIG, ...args], {
                cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
            });
        } catch { resolve({ code: -1, stdout: '', stderr: '', timedOut: false }); return; }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const killGroup = () => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        };
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = () => { killGroup(); finish({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }); };
        const timer = setTimeout(() => { killGroup(); finish({ code: -1, stdout: '', stderr, timedOut: true }); }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > OUTPUT_LIMIT) { killGroup(); finish({ code: -1, stdout: '', stderr: '', timedOut: false }); }
        });
        child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
        child.once('error', () => finish({ code: -1, stdout: '', stderr: '', timedOut: false }));
        child.once('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut: false }));
    });
}

/**
 * The governed runner of the attach path: the updater's git environment
 * (`releaseGitEnvironment`: no system/global config, no prompt, governed ssh)
 * plus `GIT_OPTIONAL_LOCKS=0` and the t2 flags.
 * @returns {(args: string[], options?: {timeoutMs?: number, signal?: AbortSignal}) => Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function createAttachGit({ appRoot, env = process.env, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
    if (!appRoot) throw new TypeError('createAttachGit requires appRoot');
    const gitEnv = { ...releaseGitEnvironment(env, { appRoot }), GIT_OPTIONAL_LOCKS: '0' };
    return (args, options = {}) => runAttachGit({
        appRoot, args, env: gitEnv, timeoutMs: options.timeoutMs ?? timeoutMs, signal: options.signal,
    });
}

const trimmed = (result) => (result.code === 0 ? String(result.stdout).trim() : null);

async function readOid(git, rev) {
    const value = trimmed(await git(['rev-parse', '--verify', '--quiet', rev]));
    return value && OID.test(value) ? value : null;
}

/** t1: every status of this path runs with `--no-optional-locks`. */
async function trackedChanges(git) {
    const status = await git(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=no', '-z']);
    if (status.code !== 0) return null;
    return parsePorcelainStatus(status.stdout).tracked;
}

async function versionAt(git, rev) {
    const shown = await git(['show', `${rev}:package.json`]);
    if (shown.code !== 0) return null;
    try {
        const version = JSON.parse(shown.stdout)?.version;
        return typeof version === 'string' ? version : null;
    } catch { return null; }
}

/** The release facts of one HEAD (L3–L5), shared by the detached and attached shapes. */
async function headReleaseFacts(git, head) {
    const tracked = await trackedChanges(git);
    if (tracked === null) return { reason: 'git_status_failed', version: null, tag: null };
    if (tracked.length) return { reason: 'dirty_worktree', version: null, tag: null };
    const version = await versionAt(git, 'HEAD');
    if (!isNassajReleaseVersion(version)) return { reason: 'head_not_release', version, tag: null };
    const tag = releaseTagForVersion(version);
    const localTag = await readOid(git, `refs/tags/${tag}^{commit}`);
    if (localTag && localTag !== head) return { reason: 'local_tag_mismatch', version, tag };
    return { reason: null, version, tag };
}

/**
 * ADR-216 §3.1: read-only, network-free; never throws for a git failure.
 * L1 (checkout + safe remote/branch), L2 (detached), L3–L6; L7 is
 * `evaluateAttachQuiescence`, because it reads the journal, the jobs and the
 * prestage slot rather than the repository.
 */
export async function inspectReleaseCheckout({ appRoot, remote, branch, git }) {
    const result = {
        shape: 'unsupported', head: null, shallow: false, version: null, tag: null,
        localBranch: { exists: false, oid: null }, eligible: false, reason: null,
    };
    if (!appRoot || !fs.existsSync(path.join(appRoot, '.git'))) return { ...result, reason: 'unsupported_install_mode' };
    if (!SAFE_UPDATE_REMOTE.test(remote || '') || !SAFE_UPDATE_BRANCH.test(branch || '')) {
        return { ...result, reason: 'invalid_update_source' };
    }
    const top = trimmed(await git(['rev-parse', '--show-toplevel']));
    let sameRoot = false;
    try { sameRoot = Boolean(top) && fs.realpathSync(top) === fs.realpathSync(appRoot); } catch { sameRoot = false; }
    if (!sameRoot) return { ...result, reason: 'unsupported_install_mode' };
    const head = await readOid(git, 'HEAD^{commit}');
    if (!head) return { ...result, reason: 'head_unavailable' };
    const shallow = trimmed(await git(['rev-parse', '--is-shallow-repository'])) === 'true';
    const localOid = await readOid(git, `refs/heads/${branch}`);
    const base = { ...result, head, shallow, localBranch: { exists: Boolean(localOid), oid: localOid } };
    const symbolic = await git(['symbolic-ref', '--quiet', 'HEAD']);
    const facts = await headReleaseFacts(git, head);
    const withFacts = { ...base, version: facts.version, tag: facts.tag };
    if (symbolic.code === 0) {
        const attached = String(symbolic.stdout).trim() === `refs/heads/${branch}`;
        // Shape and verdict are separate (qa M2): an attached HEAD still carries
        // its L3–L5 verdict, which the installer refuses on.
        return { ...withFacts, shape: attached ? 'attached' : 'wrong_branch', reason: attached ? facts.reason : 'wrong_branch' };
    }
    if (symbolic.code !== 1) return { ...withFacts, reason: 'head_unavailable' };
    const detached = { ...withFacts, shape: 'detached' };
    if (facts.reason) return { ...detached, reason: facts.reason };
    if (localOid && localOid !== head
        && (await git(['merge-base', '--is-ancestor', localOid, head])).code !== 0) {
        return { ...detached, reason: 'local_branch_diverged' };
    }
    return { ...detached, eligible: true };
}

/** Prestage states that block an attach (L7); `corrupt` fails closed. */
const BLOCKING_PRESTAGE_STATES = new Set(['building', 'ready', 'discarding', 'corrupt']);

/**
 * L7 (§3.1): the update machinery must be idle. `journal` is the raw journal
 * (null on a never-updated node); `unfinishedJobs` is true/false, or null when
 * the job table could not be read (fail closed).
 * @returns {string|null} the refusal code, or null when quiet
 */
export function evaluateAttachQuiescence({ journal, unfinishedJobs, prestageState }) {
    if (journal && (journal.state !== 'OPEN' || journal.gateClosed
        || (typeof journal.degraded === 'string' && journal.degraded))) return 'update_maintenance_active';
    if (unfinishedJobs === null || unfinishedJobs === undefined) return 'update_job_state_unavailable';
    if (unfinishedJobs) return 'update_job_active';
    if (prestageState && BLOCKING_PRESTAGE_STATES.has(prestageState)) return 'prestage_active';
    return null;
}

/** Remove this run's private refs; best effort (stale ones are harmless and namespaced). */
export async function dropAttachRefs(git, refs) {
    for (const ref of [refs?.tagRef, refs?.branchRef]) {
        if (typeof ref === 'string' && ref.startsWith(`${ATTACH_REF_ROOT}/`)) {
            await git(['update-ref', '-d', ref]).catch(() => undefined);
        }
    }
}

function newAttachRefs() {
    const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    return { nonce, tagRef: `${ATTACH_REF_ROOT}/${nonce}/tag`, branchRef: `${ATTACH_REF_ROOT}/${nonce}/branch` };
}

/**
 * ADR-216 §3.1 online proof. Writes only `refs/nassaj-attach/<nonce>/*`, which
 * are dropped before returning unless `keepRefs` (the server operation keeps
 * them until the in-lease re-verification ends). Works for an attached HEAD too.
 * @returns {Promise<{ok: true, head: string, tag: string, version: string, tagObject: string,
 *   remoteBranchOid: string, remoteIdentity: string, refs: {tagRef: string, branchRef: string}}
 *   | {ok: false, code: string}>}
 */
export async function proveReleaseCommit({
    remote, branch, configuredRemoteUrl, git, deadlineMs = DEFAULT_ATTACH_FETCH_TIMEOUT_MS,
    verifySignedRelease = async () => false, requireVerified = false, keepRefs = false, signal,
}) {
    const refs = newAttachRefs();
    let keep = false;
    try {
        const before = await checkReleaseRemote(git, { remote, configuredRemoteUrl });
        if (!before.ok) return { ok: false, code: before.code };
        const head = await readOid(git, 'HEAD^{commit}');
        if (!head) return { ok: false, code: 'head_unavailable' };
        const version = await versionAt(git, 'HEAD');
        if (!isNassajReleaseVersion(version)) return { ok: false, code: 'head_not_release' };
        const tag = releaseTagForVersion(version);
        const fetched = await git(['fetch', '--no-tags', '--refmap=', '--no-write-fetch-head', remote,
            `refs/tags/${tag}:${refs.tagRef}`, `refs/heads/${branch}:${refs.branchRef}`], { timeoutMs: deadlineMs, signal });
        if (fetched.code !== 0) return { ok: false, code: 'release_fetch_failed' };
        const after = await checkReleaseRemote(git, { remote, configuredRemoteUrl });
        if (!after.ok || after.identity !== before.identity) return { ok: false, code: 'remote_changed' };
        const proof = await proveTagOnBranch(git, { tagRef: refs.tagRef, branchRef: refs.branchRef, expectedCommit: head });
        if (!proof.ok) return { ok: false, code: proof.code === 'tag_unresolved' ? 'head_not_release_tag' : proof.code };
        if (releaseTagForVersion(await versionAt(git, `${refs.tagRef}^{commit}`)) !== tag) {
            return { ok: false, code: 'tag_version_mismatch' };
        }
        const tagObject = await readOid(git, refs.tagRef);
        const remoteBranchOid = await readOid(git, `${refs.branchRef}^{commit}`);
        if (!tagObject || !remoteBranchOid) return { ok: false, code: 'release_fetch_failed' };
        if (requireVerified) {
            let verified = false;
            try { verified = (await verifySignedRelease({ tag, version, releaseCommit: head, tagObject })) === true; }
            catch { verified = false; }
            if (!verified) return { ok: false, code: 'release_unverified' };
        }
        keep = keepRefs;
        return { ok: true, head, tag, version, tagObject, remoteBranchOid, remoteIdentity: before.identity, refs };
    } finally {
        if (!keep) await dropAttachRefs(git, refs);
    }
}

/**
 * `local-main` installs (§3.6 step 2): only the ancestry of HEAD on the remote
 * release branch is required. Private ref, dropped before returning.
 */
export async function proveHeadOnBranch({ remote, branch, configuredRemoteUrl, git, deadlineMs = DEFAULT_ATTACH_FETCH_TIMEOUT_MS }) {
    const refs = newAttachRefs();
    try {
        const before = await checkReleaseRemote(git, { remote, configuredRemoteUrl });
        if (!before.ok) return { ok: false, code: before.code };
        const head = await readOid(git, 'HEAD^{commit}');
        if (!head) return { ok: false, code: 'head_unavailable' };
        const fetched = await git(['fetch', '--no-tags', '--refmap=', '--no-write-fetch-head', remote,
            `refs/heads/${branch}:${refs.branchRef}`],
            { timeoutMs: deadlineMs });
        if (fetched.code !== 0) return { ok: false, code: 'release_fetch_failed' };
        const ancestry = await git(['merge-base', '--is-ancestor', head, refs.branchRef]);
        if (ancestry.code === 1) return { ok: false, code: 'head_not_on_release_branch' };
        if (ancestry.code !== 0) return { ok: false, code: 'ancestry_unproven' };
        const remoteBranchOid = await readOid(git, `${refs.branchRef}^{commit}`);
        return remoteBranchOid ? { ok: true, head, remoteBranchOid } : { ok: false, code: 'release_fetch_failed' };
    } finally {
        await dropAttachRefs(git, refs);
    }
}

function assertLease(lease) {
    if (!lease || lease[SOURCE_REF_LEASE] !== true || lease.held !== true) throw new ReleaseAttachError('lease_required');
}

function fsyncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Durable replace (tmp + fsync + rename + dir fsync), 0600. */
function writeReceiptFile(file, receipt) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 1)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
}

/** Read and validate a receipt this module wrote; a symlink or foreign file is refused. */
export function readAttachReceipt(receiptPath) {
    let metadata;
    try { metadata = fs.lstatSync(receiptPath); } catch { throw new ReleaseAttachError('receipt_unavailable'); }
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new ReleaseAttachError('receipt_unsafe');
    }
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { throw new ReleaseAttachError('receipt_invalid'); }
    const plan = receipt?.plan;
    if (receipt?.schema !== ATTACH_RECEIPT_SCHEMA || !OID.test(plan?.head || '')
        || !SAFE_UPDATE_BRANCH.test(plan?.branch || '') || !SAFE_UPDATE_REMOTE.test(plan?.remote || '')
        || !Number.isSafeInteger(receipt.journalSequence) || typeof receipt.createdAt !== 'string'
        || !Array.isArray(receipt.appliedSteps) || !validConfigBefore(receipt.configBefore)
        || !(receipt.localBranchBefore === null || OID.test(receipt.localBranchBefore || ''))
        || !(receipt.trackingBefore === null || OID.test(receipt.trackingBefore || ''))) {
        throw new ReleaseAttachError('receipt_invalid');
    }
    return receipt;
}

/** `configBefore` (T3): exactly the three keys, each a list of bounded single-line strings. */
function validConfigBefore(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
    const keys = Object.keys(config).sort();
    if (keys.join(',') !== 'fetch,merge,remote') return false;
    return keys.every((key) => Array.isArray(config[key]) && config[key].length <= 32
        && config[key].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\n\r]/.test(value)));
}

/** T3: a revert reads receipts only from this node's own `<controlRoot>/source-attach/`. */
function assertReceiptInside(receiptPath, receiptDir) {
    let metadata;
    try { metadata = fs.lstatSync(receiptPath); } catch { throw new ReleaseAttachError('receipt_unavailable'); }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ReleaseAttachError('receipt_unsafe');
    let parent;
    let expected;
    try {
        parent = fs.realpathSync(path.dirname(path.resolve(receiptPath)));
        expected = fs.realpathSync(receiptDir);
    } catch { throw new ReleaseAttachError('receipt_unavailable'); }
    if (parent !== expected) throw new ReleaseAttachError('receipt_outside_control_root');
}

/** List this node's attach receipts, newest first (basename order is ISO time). */
export function listAttachReceipts(controlRoot) {
    const directory = path.join(controlRoot, ATTACH_RECEIPT_DIR);
    let names = [];
    try { names = fs.readdirSync(directory).filter((name) => /^[0-9TZ:.-]+-[0-9a-f]{12}\.json$/.test(name)); }
    catch { return []; }
    return names.sort().reverse().map((name) => path.join(directory, name));
}

async function configValues(git, key) {
    const result = await git(['config', '--get-all', key]);
    if (result.code === 0) return String(result.stdout).split('\n').filter(Boolean);
    if (result.code === 1) return [];
    throw new ReleaseAttachError('git_config_failed');
}

/** True when a `remote.<r>.fetch` value maps `refs/heads/<branch>` (exact or glob source). */
export function refspecMapsBranch(spec, branch) {
    const source = String(spec).replace(/^\+/, '').split(':')[0];
    if (source === `refs/heads/${branch}`) return true;
    if (!source.includes('*')) return false;
    const [prefix, suffix] = source.split('*');
    const ref = `refs/heads/${branch}`;
    return ref.startsWith(prefix) && ref.endsWith(suffix) && ref.length >= prefix.length + suffix.length;
}

const configKeys = ({ branch, remote }) => ({
    remote: `branch.${branch}.remote`, merge: `branch.${branch}.merge`, fetch: `remote.${remote}.fetch`,
});

async function readConfigState(git, plan) {
    const keys = configKeys(plan);
    return {
        remote: await configValues(git, keys.remote),
        merge: await configValues(git, keys.merge),
        fetch: await configValues(git, keys.fetch),
    };
}

async function requireGitOk(git, args, code) {
    const result = await git(args);
    if (result.code !== 0) throw new ReleaseAttachError(code);
    return result;
}

/** Replace every value of `key` with `values`, only when they differ. */
async function restoreConfigKey(git, key, values) {
    const current = await configValues(git, key);
    if (current.length === values.length && current.every((value, index) => value === values[index])) return false;
    if (current.length) {
        const unset = await git(['config', '--unset-all', key]);
        if (unset.code !== 0 && unset.code !== 5) throw new ReleaseAttachError('git_config_failed');
    }
    for (const value of values) await requireGitOk(git, ['config', '--add', key, value], 'git_config_failed');
    return true;
}

/**
 * Upstream config (§3.1 apply step 3): `branch.<b>.remote/merge`, plus the
 * branch refspec when no `remote.<r>.fetch` value maps it. The tag-only refspec
 * of a `--branch <tag>` clone stays. Shared with the installer.
 * @returns {Promise<boolean>} whether anything changed
 */
export async function ensureUpstreamConfig(git, { remote, branch }) {
    const keys = configKeys({ remote, branch });
    let changed = false;
    if ((await configValues(git, keys.remote)).join('\n') !== remote) {
        changed = await restoreConfigKey(git, keys.remote, [remote]) || changed;
    }
    if ((await configValues(git, keys.merge)).join('\n') !== `refs/heads/${branch}`) {
        changed = await restoreConfigKey(git, keys.merge, [`refs/heads/${branch}`]) || changed;
    }
    if (!(await configValues(git, keys.fetch)).some((spec) => refspecMapsBranch(spec, branch))) {
        await requireGitOk(git, ['config', '--add', keys.fetch, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
            'git_config_failed');
        changed = true;
    }
    return changed;
}

/** HEAD's symbolic target (`refs/heads/...`), `null` when detached, throws when unreadable. */
async function symbolicHead(git) {
    const result = await git(['symbolic-ref', '--quiet', 'HEAD']);
    if (result.code === 0) return String(result.stdout).trim();
    if (result.code === 1) return null;
    throw new ReleaseAttachError('head_unavailable');
}

/**
 * The inverse of an apply, from its receipt (§3.1 revert, and the automatic
 * post-flip rollback). Each write is CAS on the value it replaces; a value that
 * moved is left alone and reported.
 * @returns {Promise<{ok: boolean, failures: string[]}>}
 */
async function rollbackFromReceipt(git, receipt) {
    const { head, branch, remote } = receipt.plan;
    const branchRef = `refs/heads/${branch}`;
    const trackingRef = `refs/remotes/${remote}/${branch}`;
    const failures = [];
    const attempt = async (name, action) => { try { await action(); } catch { failures.push(name); } };
    await attempt('head', async () => {
        if ((await symbolicHead(git)) === null) return;
        if ((await readOid(git, 'HEAD^{commit}')) !== head) throw new ReleaseAttachError('source_changed');
        await requireGitOk(git, ['update-ref', '--no-deref', '-m', REVERT_LOG_MESSAGE, 'HEAD', head], 'ref_write_failed');
    });
    await attempt('branch', async () => {
        const current = await readOid(git, branchRef);
        const before = receipt.localBranchBefore ?? null;
        if (current === before) return;
        if (before === null) {
            if (current !== head) throw new ReleaseAttachError('branch_moved');
            await requireGitOk(git, ['update-ref', '-d', branchRef, head], 'ref_write_failed');
        } else {
            await requireGitOk(git, ['update-ref', '-m', REVERT_LOG_MESSAGE, branchRef, before, current ?? ZERO_OID], 'ref_write_failed');
        }
    });
    await attempt('config', async () => {
        const keys = configKeys(receipt.plan);
        for (const name of ['remote', 'merge', 'fetch']) {
            const values = receipt.configBefore[name];
            if (Array.isArray(values)) await restoreConfigKey(git, keys[name], values);
        }
    });
    await attempt('tracking', async () => {
        const current = await readOid(git, trackingRef);
        const before = receipt.trackingBefore ?? null;
        if (current === before) return;
        if (before === null) await requireGitOk(git, ['update-ref', '-d', trackingRef, current], 'ref_write_failed');
        else await requireGitOk(git, ['update-ref', '-m', REVERT_LOG_MESSAGE, trackingRef, before, current ?? ZERO_OID], 'ref_write_failed');
    });
    return { ok: failures.length === 0, failures };
}

async function verifyAttached(git, plan) {
    if ((await symbolicHead(git).catch(() => null)) !== `refs/heads/${plan.branch}`) return false;
    if ((await readOid(git, 'HEAD^{commit}')) !== plan.head) return false;
    const tracked = await trackedChanges(git);
    return Array.isArray(tracked) && tracked.length === 0;
}

function validatePlan(plan) {
    if (!plan || !OID.test(plan.head || '') || !OID.test(plan.remoteBranchOid || '')
        || !SAFE_UPDATE_REMOTE.test(plan.remote || '') || !SAFE_UPDATE_BRANCH.test(plan.branch || '')
        || typeof plan.tag !== 'string' || !plan.tag) throw new ReleaseAttachError('attach_plan_invalid');
}

/**
 * §3.1 apply, under an already-held exclusive source-ref lease. Receipt first,
 * then branch ref (CAS), upstream config, tracking ref (fast-forward CAS), and
 * the commit point: `symbolic-ref HEAD`. A failed post-flip verification rolls
 * back from the receipt, still under the lease. Every step is idempotent; a
 * crash before the flip leaves a detached HEAD that L6 accepts on a re-run.
 * `hooks` are injection points for the crash/verify tests only.
 * @returns {Promise<{ok: true, receiptPath: string, changed: string[], tracking: string}
 *   | {ok: false, code: string, rolledBack: boolean, receiptPath?: string}>}
 */
export async function applyReleaseAttachment({ plan, git, receiptDir, lease, operationId = null, now = () => new Date(), hooks = {} }) {
    const prepared = await prepareAttachReceipt({ plan, git, receiptDir, lease, operationId, now });
    if (!prepared.ok) return prepared;
    const { receipt, receiptPath } = prepared;
    const save = (outcome) => {
        receipt.outcome = { ...outcome, at: now().toISOString() };
        try { writeReceiptFile(receiptPath, receipt); } catch { receipt.receiptWriteFailed = true; }
    };
    let changed;
    try {
        changed = await runAttachSteps({ plan, git, receipt, receiptPath, hooks });
    } catch (error) {
        if (!(error instanceof ReleaseAttachError)) throw error;
        save({ state: 'failed', code: error.code });
        return { ok: false, code: error.code, rolledBack: false, receiptPath };
    }
    if (!(await verifyAttached(git, plan)) || await hooks.failVerify?.()) {
        const rollback = await rollbackFromReceipt(git, receipt);
        save({ state: 'rolled_back', code: 'attach_verify_failed', rolledBack: rollback.ok, failures: rollback.failures });
        return { ok: false, code: 'attach_verify_failed', rolledBack: rollback.ok, receiptPath };
    }
    save({ state: 'applied' });
    return { ok: true, receiptPath, changed, tracking: receipt.tracking, receiptWriteFailed: receipt.receiptWriteFailed === true };
}

/**
 * The checks of an apply (lease, plan, HEAD still detached at the proven
 * commit, L6) and the receipt, written durably before the first ref write.
 */
async function prepareAttachReceipt({ plan, git, receiptDir, lease, operationId, now }) {
    try {
        assertLease(lease);
        validatePlan(plan);
    } catch (error) {
        return { ok: false, code: error.code || 'attach_failed', rolledBack: false };
    }
    if ((await symbolicHead(git).catch(() => 'unreadable')) !== null
        || (await readOid(git, 'HEAD^{commit}')) !== plan.head) {
        return { ok: false, code: 'source_changed', rolledBack: false };
    }
    const localBranchBefore = await readOid(git, `refs/heads/${plan.branch}`);
    if (localBranchBefore && localBranchBefore !== plan.head
        && (await git(['merge-base', '--is-ancestor', localBranchBefore, plan.head])).code !== 0) {
        return { ok: false, code: 'local_branch_diverged', rolledBack: false };
    }
    let configBefore;
    try { configBefore = await readConfigState(git, plan); } catch (error) {
        return { ok: false, code: error.code || 'git_config_failed', rolledBack: false };
    }
    const createdAt = now().toISOString();
    const receipt = {
        schema: ATTACH_RECEIPT_SCHEMA, operationId, createdAt,
        plan: {
            head: plan.head, branch: plan.branch, remote: plan.remote, tag: plan.tag, version: plan.version ?? null,
            remoteBranchOid: plan.remoteBranchOid, shallow: Boolean(plan.shallow),
        },
        journalSequence: lease.journalSequence, localBranchBefore, configBefore,
        trackingBefore: await readOid(git, `refs/remotes/${plan.remote}/${plan.branch}`),
        appliedSteps: [], outcome: null,
    };
    fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(receiptDir, `${createdAt.replace(/:/g, '-')}-${crypto.randomBytes(6).toString('hex')}.json`);
    writeReceiptFile(receiptPath, receipt);
    return { ok: true, receipt, receiptPath };
}

/** Apply steps 2–5 (§3.1), each recorded in the receipt as it completes; HEAD flips last. */
async function runAttachSteps({ plan, git, receipt, receiptPath, hooks }) {
    const branchRef = `refs/heads/${plan.branch}`;
    const changed = [];
    const done = async (step) => {
        receipt.appliedSteps.push(step);
        try { writeReceiptFile(receiptPath, receipt); } catch (error) {
            // T1: once HEAD has flipped the attach is real; a receipt that cannot
            // be updated must not skip the verification (and its rollback).
            if (step !== 'head') throw error;
            receipt.receiptWriteFailed = true;
        }
        await hooks.afterStep?.(step);
    };
    if (receipt.localBranchBefore !== plan.head) {
        await requireGitOk(git, ['update-ref', '-m', ATTACH_LOG_MESSAGE, branchRef, plan.head,
            receipt.localBranchBefore ?? ZERO_OID], 'ref_write_failed');
        changed.push('branch');
    }
    await done('branch');
    if (await ensureUpstreamConfig(git, plan)) changed.push('upstream');
    await done('upstream');
    receipt.tracking = await advanceRemoteTrackingRef({ git, remote: plan.remote, branch: plan.branch, fetchedRef: plan.remoteBranchOid });
    if (receipt.tracking === 'advanced') changed.push('tracking');
    await done('tracking');
    await requireGitOk(git, ['symbolic-ref', '-m', HEAD_FLIP_MESSAGE, 'HEAD', branchRef], 'attach_head_flip_failed');
    changed.push('head');
    await done('head');
    return changed;
}

/**
 * Record the operation outcome (restart action, final state) in the receipt so
 * the server can answer a poll after its own restart (§3.3).
 */
export function recordAttachOutcome(receiptPath, patch) {
    const receipt = readAttachReceipt(receiptPath);
    receipt.outcome = { ...(receipt.outcome || {}), ...patch };
    writeReceiptFile(receiptPath, receipt);
    return receipt;
}

/**
 * §3.1 revert (doctor only), under the lease. Refuses `source_changed` if HEAD
 * or the branch moved, `update_since_attach` after a journal sequence bump, a
 * job created at or after the receipt, or any prestage slot.
 * `jobs.createdSince(iso)` and `jobs.prestageSlotExists()` come from the caller;
 * the receipt must sit in `receiptDir` (`<controlRoot>/source-attach`).
 * @returns {Promise<{ok: boolean, code: string|null, failures?: string[]}>}
 */
export async function revertReleaseAttachment({ receiptPath, receiptDir, git, lease, jobs, now = () => new Date() }) {
    let receipt;
    try {
        assertLease(lease);
        assertReceiptInside(receiptPath, receiptDir);
        receipt = readAttachReceipt(receiptPath);
    } catch (error) {
        return { ok: false, code: error.code || 'revert_failed' };
    }
    const { head, branch } = receipt.plan;
    const symbolic = await symbolicHead(git).catch(() => 'unreadable');
    if (![null, `refs/heads/${branch}`].includes(symbolic) || (await readOid(git, 'HEAD^{commit}')) !== head) {
        return { ok: false, code: 'source_changed' };
    }
    const branchOid = await readOid(git, `refs/heads/${branch}`);
    if (branchOid && branchOid !== head) return { ok: false, code: 'source_changed' };
    let moved;
    try {
        moved = lease.journalSequence !== receipt.journalSequence
            || jobs.createdSince(receipt.createdAt) !== false
            || jobs.prestageSlotExists() !== false;
    } catch { moved = true; }
    if (moved) return { ok: false, code: 'update_since_attach' };
    const rollback = await rollbackFromReceipt(git, receipt);
    let receiptWriteFailed = false;
    try {
        recordAttachOutcome(receiptPath, { reverted: { at: now().toISOString(), ok: rollback.ok, failures: rollback.failures } });
    } catch { receiptWriteFailed = true; }
    return rollback.ok
        ? { ok: true, code: null, receiptWriteFailed }
        : { ok: false, code: 'revert_incomplete', failures: rollback.failures, receiptWriteFailed };
}

/**
 * The non-blocking per-node attach lock (§3.2, t6): `O_CREAT|O_NOFOLLOW`, 0600,
 * a regular file owned by this uid, flock'd exclusively without waiting. Held
 * for the whole operation, including the proof outside the lease. A second
 * acquire — in this process or another — is refused at once.
 * @returns {{path: string, release: () => void}}
 */
export function acquireSourceAttachLock(controlRoot) {
    fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
    const file = path.join(controlRoot, ATTACH_LOCK_NAME);
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    } catch (error) {
        if (error?.code === 'ELOOP') throw new ReleaseAttachError('source_attach_lock_unsafe');
        throw new ReleaseAttachError('source_attach_lock_unavailable');
    }
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        fs.closeSync(fd);
        throw new ReleaseAttachError('source_attach_lock_unsafe');
    }
    const locked = spawnSync('flock', ['-x', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    if (locked.status !== 0) {
        fs.closeSync(fd);
        throw new ReleaseAttachError(locked.error ? 'source_attach_lock_unavailable' : 'source_attach_in_progress');
    }
    let released = false;
    return {
        path: file,
        release() {
            if (released) return;
            released = true;
            try { fs.closeSync(fd); } catch { /* already closed */ }
        },
    };
}

/** Map a lease refusal to its public code (§3.2). */
function leaseRefusalCode(error) {
    const code = error?.message;
    return ['update_maintenance_active', 'source_attach_writers_active', 'unsupported_install_mode'].includes(code)
        ? code : 'update_maintenance_active';
}

/** In-lease, local-only re-verification of the proof (§3.3 step 3). */
async function recheckProof(git, proof) {
    if ((await symbolicHead(git).catch(() => 'unreadable')) !== null) return false;
    if ((await readOid(git, 'HEAD^{commit}')) !== proof.head) return false;
    const tracked = await trackedChanges(git);
    if (!Array.isArray(tracked) || tracked.length) return false;
    if ((await readOid(git, `${proof.refs.tagRef}^{commit}`)) !== proof.head) return false;
    return (await readOid(git, `${proof.refs.branchRef}^{commit}`)) === proof.remoteBranchOid;
}

/**
 * The whole attach in the §3.3 order, shared by the server operation, the
 * doctor and the installer. Never throws for a refusal: returns
 * `{ ok, state: 'succeeded'|'refused'|'failed', code, step, ... }`.
 *
 * @param {object} options
 * @param {string} options.appRoot
 * @param {string} options.controlRoot  `<git common dir>/nassaj-source-update`
 * @param {string} options.remote
 * @param {string} options.branch
 * @param {string} options.configuredRemoteUrl  the configured release source
 * @param {Function} options.git  createAttachGit(...)
 * @param {(options: object) => Promise<object>} options.acquireLease  the gate's acquireExclusiveSourceRefLease
 * @param {() => Promise<{journal: object|null, unfinishedJobs: boolean|null, prestageState: string|null}>} options.readQuiescence
 * @param {{release: () => void}} [options.lock]  an already-held source-attach lock (server POST)
 * @param {string} [options.expectedHead]  the HEAD the owner saw (server POST CAS)
 */
export async function runReleaseAttachment(options) {
    const { controlRoot, lock = null } = options;
    const progress = { step: 'lock' };
    const outcome = (state, code, extra = {}) => ({ ok: state === 'succeeded', state, code, step: progress.step, ...extra });
    let held = lock;
    try {
        if (!held) held = acquireSourceAttachLock(controlRoot);
    } catch (error) {
        return outcome('refused', error.code || 'source_attach_lock_unavailable');
    }
    try {
        return await attachOutsideLease(options, progress, outcome);
    } catch (error) {
        return outcome('failed', error instanceof ReleaseAttachError ? error.code : 'source_attach_failed');
    } finally {
        held.release();
    }
}

function advanceStep(progress, onStep, name) {
    progress.step = name;
    try { onStep?.(name); } catch { /* progress is best-effort */ }
}

/** §3.3 step 1: read-only checks and the network proof, all before the lease. */
async function attachOutsideLease(options, progress, outcome) {
    const { appRoot, remote, branch, configuredRemoteUrl, git, readQuiescence, expectedHead = null,
        deadlineMs = DEFAULT_ATTACH_FETCH_TIMEOUT_MS, verifySignedRelease, requireVerified = false, onStep, signal } = options;
    advanceStep(progress, onStep, 'inspect');
    const inspection = await inspectReleaseCheckout({ appRoot, remote, branch, git });
    if (inspection.shape === 'attached') return outcome('refused', 'already_attached', { inspection });
    if (!inspection.eligible) return outcome('refused', inspection.reason || 'release_checkout_invalid', { inspection });
    if (expectedHead && inspection.head !== expectedHead) return outcome('refused', 'source_changed', { inspection });
    advanceStep(progress, onStep, 'quiescence');
    const quiet = evaluateAttachQuiescence(await readQuiescence());
    if (quiet) return outcome('refused', quiet, { inspection });
    advanceStep(progress, onStep, 'prove');
    const proof = await proveReleaseCommit({
        remote, branch, configuredRemoteUrl, git, deadlineMs, verifySignedRelease, requireVerified, keepRefs: true, signal,
    });
    if (!proof.ok) return outcome('refused', proof.code, { inspection });
    try {
        return await attachUnderLease(options, { inspection, proof }, progress, outcome);
    } finally {
        await dropAttachRefs(git, proof.refs);
    }
}

/** §3.3 steps 2–3: take the lease; inside it only L7, the local re-verification and the apply. */
async function attachUnderLease(options, { inspection, proof }, progress, outcome) {
    const { controlRoot, remote, branch, git, acquireLease, readQuiescence, leaseWaitMs, operationId = null, onStep, hooks = {} } = options;
    advanceStep(progress, onStep, 'lease');
    let lease;
    try { lease = await acquireLease({ kind: 'source-attach', ...(leaseWaitMs !== undefined ? { waitMs: leaseWaitMs } : {}) }); }
    catch (error) { return outcome('refused', leaseRefusalCode(error), { inspection }); }
    const leaseAcquiredAt = Date.now();
    try {
        advanceStep(progress, onStep, 'recheck');
        const quietInside = evaluateAttachQuiescence(await readQuiescence());
        if (quietInside) return outcome('refused', quietInside, { inspection });
        if (!(await recheckProof(git, proof))) return outcome('refused', 'source_changed', { inspection });
        advanceStep(progress, onStep, 'apply');
        const plan = { head: proof.head, branch, remote, tag: proof.tag, version: proof.version,
            remoteBranchOid: proof.remoteBranchOid, shallow: inspection.shallow };
        const applied = await applyReleaseAttachment({
            plan, git, receiptDir: path.join(controlRoot, ATTACH_RECEIPT_DIR), lease, operationId, hooks,
        });
        const exclusiveHoldMs = Date.now() - leaseAcquiredAt;
        return applied.ok
            ? outcome('succeeded', null, { inspection, plan, receiptPath: applied.receiptPath, changed: applied.changed,
                tracking: applied.tracking, exclusiveHoldMs, receiptWriteFailed: applied.receiptWriteFailed === true })
            : outcome('failed', applied.code, { inspection, plan, rolledBack: applied.rolledBack,
                receiptPath: applied.receiptPath ?? null, exclusiveHoldMs });
    } finally {
        lease.release();
    }
}
