import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { fileURLToPath } from 'node:url';

import { assertLegacyTransitionAllowed } from '../bootstrap-startup-context.js';
import { isNassajReleaseVersion, releaseTagForVersion } from '../../shared/release-version-policy.js';
import { resolveDatabaseFilePath } from '../modules/database/database-path.js';
import { detectUpdateStrategy, resolveUpdateRuntimeEntry } from '../../scripts/lib/update-runtime-capability.mjs';
import {
    conflictingPaths, describePaths, nulFields, parsePorcelainStatus,
} from '../../scripts/lib/update-worktree-cleanliness.mjs';
import { gitlinkChangePaths, parseRawDiffEntries } from '../../scripts/lib/source-update-gitlinks.mjs';
import { classifyDivergence, diffDependencyVersions } from '../../scripts/lib/local-divergence.mjs';
import { parseNodeOverlay } from '../../scripts/lib/node-overlay.mjs';
import { planSourceManifest } from '../../scripts/lib/source-update-activation.mjs';
import { buildSourceUpdateAction } from '../../scripts/lib/source-update-action-schema.mjs';
import { supportsAtomicExchange } from '../../scripts/lib/atomic-exchange-capability.mjs';
import { prepareClientPublicationAssets } from '../../scripts/lib/client-publication-archive.mjs';
import { verifyAssetClosure } from '../../scripts/lib/client-publication-artifacts.mjs';
import { reserveFullUpdateWaiter, failReleaseUpdateWaiter } from '../../scripts/lib/client-publication-control.mjs';
import { UPDATE_RUNTIME_CAPABILITY } from '../../scripts/lib/update-runtime-bundle.mjs';

import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';
import { buildMutexHolder, tryAcquireBuildMutex } from './source-update-build-mutex.js';
import { PRESTAGE_BUILD_MUTEX_KIND } from './update-prestage-slot.js';
import {
    buildPrestageIdentityKey, canonicalJson, diffPrestageIdentity, probeNpmIdentity, probeRuntimeIdentity, sha256Hex,
} from './update-prestage-identity.js';
import { TREE_NAMES } from './update-prestage-tree-hasher.js';
import {
    SUPERSEDING_TARGET_CODES, TARGET_ALREADY_LOADED, TARGET_NOT_NEWER, isTargetAlreadyLoaded, readLoadedRuntimeCommit,
} from './source-update-target-guard.js';
import { normalizeGitHubRepositoryIdentity, resolveReleaseSource } from './release-source-config.js';

const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_BRANCH = /^(?![-.])(?!.*(?:\.\.|\/\.|\.\/|\/\/))[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** The update remote/branch shapes every governed git path accepts (shared with ADR-216 attach). */
export const SAFE_UPDATE_REMOTE = SAFE_REMOTE;
export const SAFE_UPDATE_BRANCH = SAFE_BRANCH;
const COMMIT_OID = /^[0-9a-f]{40}$/;
const OUTPUT_LIMIT = 128 * 1024;
// Linux tmpfs superblock magic. A candidate root or build TMPDIR on tmpfs turns
// `npm ci` + build into resident RAM that the kernel never reclaims until an
// explicit rm or reboot (ADR-141 §4.5; the 2026-07-31 swap-exhaustion outage).
const TMPFS_MAGIC = 0x01021994;
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

function positiveIntegerEnv(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve the nearest existing ancestor so statfs works before the leaf is created. */
function existingAncestor(target) {
    let directory = path.resolve(target);
    while (!fs.existsSync(directory)) {
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return directory;
}

// Blocked-storage reasons carry an operator remedy so the message is actionable
// both in the update modal (job error) and in the /health banner (T-1553, م1).
const STORAGE_BLOCKERS = Object.freeze({
    tmpfs_candidate_root: { status: 409,
        message: 'The update candidate root is on a tmpfs (in-memory) filesystem. Move the Nassaj source tree to a disk-backed path, then run the governed safe restart.' },
    tmpfs_build_tmpdir: { status: 409,
        message: 'The build temporary directory uses memory instead of disk. Configure TMPDIR=/var/tmp in config/node.env. If TMPDIR is absent from the running environment, load it through the governed safe restart when idle; if the process manager sets a conflicting value, resolve that through the governed configuration procedure. Then check readiness in the update dialog.' },
    tmpfs_database_root: { status: 409, message: 'The database snapshot must reside on disk, not tmpfs.' },
    insufficient_disk: { status: 507,
        message: 'There is not enough free disk to stage the release candidate. Free space on the database and source device, then retry.' },
    storage_probe_failed: { status: 500,
        message: 'The update storage pre-flight could not read the filesystem. Verify the source and TMPDIR paths, then retry.' },
});

/** Return the device with the largest shortfall (required - available), or null when all fit. */
function worstShortfall(devices) {
    let worst = null;
    for (const device of devices) {
        if (device.available >= device.required) continue;
        if (!worst || device.required - device.available > worst.required - worst.available) worst = device;
    }
    return worst;
}

const MIB = 1024 * 1024;

/**
 * Owner-facing figures for an insufficient_disk blocker, or null for any other
 * result. Never published on the unauthenticated /health; byte counts are still
 * coarsened to whole MiB (available floored, required ceiled) to limit precision
 * leakage about the host.
 */
export function publicStorageFigures(result) {
    if (!result || result.ok !== false || result.code !== 'insufficient_disk') return null;
    if (!Number.isSafeInteger(result.availableBytes) || !Number.isSafeInteger(result.requiredBytes)) return null;
    return {
        availableBytes: Math.floor(result.availableBytes / MIB) * MIB,
        requiredBytes: Math.ceil(result.requiredBytes / MIB) * MIB,
    };
}

/**
 * The default source-update control root (B-1334): `<git common dir>/nassaj-source-update`, the same root update-maintenance-gate.js
 * uses for its locks and journal. In a linked worktree or overlay `<appRoot>/.git` is
 * a file, so the old `<appRoot>/.git/nassaj-source-update` default named a path that
 * cannot exist. Only the checkout itself counts: a directory nested inside another
 * repository keeps the legacy path (which then reports as absent), as does a host
 * without git.
 * @param {string} appRoot checkout root
 * @param {typeof spawnSync} [commandRunner]
 * @returns {string} absolute control root
 */
export function defaultSourceUpdateControlRoot(appRoot, commandRunner = spawnSync) {
    const legacy = path.join(appRoot, '.git', 'nassaj-source-update');
    try {
        const result = commandRunner('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
            cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        const [topLevel, commonDir] = result?.status === 0 && typeof result.stdout === 'string'
            ? result.stdout.trim().split('\n') : [];
        if (!topLevel || !commonDir || fs.realpathSync(topLevel) !== fs.realpathSync(appRoot)) return legacy;
        return path.join(path.resolve(appRoot, commonDir), 'nassaj-source-update');
    } catch {
        return legacy;
    }
}

/**
 * Evaluate the pre-flight storage state without throwing (ADR-141, T-1553).
 * Returns `{ ok: true }` or `{ ok: false, code, message, status }` so both the
 * update job and /health can surface the same actionable blocker. For
 * `insufficient_disk` the result also carries integer `availableBytes` and
 * `requiredBytes` of the device with the largest shortfall.
 */
export function evaluateUpdateStorage({ appRoot, env, statfs = fs.statfsSync, stat = fs.statSync }) {
    const blocked = (code) => ({ ok: false, code, ...STORAGE_BLOCKERS[code] });
    const minFreeBytes = positiveIntegerEnv(env.NASSAJ_UPDATE_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES);
    const controlRoot = env.NASSAJ_UPDATE_CONTROL_ROOT
        ? path.resolve(env.NASSAJ_UPDATE_CONTROL_ROOT)
        : defaultSourceUpdateControlRoot(appRoot);
    const buildTmpdir = env.TMPDIR || env.TMP || env.TEMP || os.tmpdir();
    try {
        const databasePath = resolveDatabaseFilePath(env);
        const databaseBytes = (fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0)
            + (fs.existsSync(`${databasePath}-wal`) ? fs.statSync(`${databasePath}-wal`).size : 0);
        const requests = [
            [controlRoot, minFreeBytes, 'tmpfs_candidate_root'],
            [buildTmpdir, minFreeBytes, 'tmpfs_build_tmpdir'],
            [path.dirname(databasePath), databaseBytes * 2 + 16 * 1024 * 1024, 'tmpfs_database_root'],
            [path.join(path.dirname(databasePath), 'nassaj-update-db-snapshots'), databaseBytes * 2 + 16 * 1024 * 1024, 'tmpfs_database_root'],
        ];
        const devices = new Map();
        for (const [target, required, tmpfsReason] of requests) {
            const ancestor = existingAncestor(target);
            const storage = statfs(ancestor);
            if (Number(storage.type) === TMPFS_MAGIC) return blocked(tmpfsReason);
            const available = Number(storage.bavail) * Number(storage.bsize);
            const device = stat(ancestor).dev;
            if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(device)) return blocked('storage_probe_failed');
            const previous = devices.get(device) || { available, required: 0 };
            devices.set(device, { available: Math.min(previous.available, available), required: previous.required + required });
        }
        const worst = worstShortfall(devices.values());
        if (worst) return { ...blocked('insufficient_disk'), availableBytes: worst.available, requiredBytes: worst.required };
    } catch {
        return blocked('storage_probe_failed');
    }
    return { ok: true };
}

/**
 * Pre-flight storage gate (ADR-141, T-1553): before any git or build work,
 * reject when the candidate root or the build TMPDIR lives on tmpfs, or when the
 * source device lacks the minimum free bytes to stage a release candidate.
 */
export function assertUpdateStorage({ appRoot, env, statfs = fs.statfsSync, stat = fs.statSync }) {
    const result = evaluateUpdateStorage({ appRoot, env, statfs, stat });
    if (!result.ok) throw new SourceUpdateError(result.code, result.message, result.status);
}

function childProcessIdentity(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
        const pgid = Number(fields[2]);
        const startTicks = fields[19];
        const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        if (!Number.isSafeInteger(pgid) || pgid <= 0 || !startTicks || !bootId) return null;
        return { pid, pgid, startTicks, bootId };
    } catch { return null; }
}

export function resolveCandidateScript(appRoot, moduleUrl = import.meta.url, runtimeResolver = resolveUpdateRuntimeEntry) {
    if (moduleUrl.includes('/dist-server/')) {
        try {
            return runtimeResolver(path.join(appRoot, 'dist-server'), 'scripts/source-update-candidate.mjs');
        } catch {
            throw new SourceUpdateError('candidate_runner_unavailable', 'The verified v2 update runtime is unavailable.', 503);
        }
    }
    const development = path.join(appRoot, 'scripts', 'source-update-candidate.mjs');
    const target = development;
    let metadata;
    try { metadata = fs.lstatSync(target); } catch { throw new SourceUpdateError('candidate_runner_unavailable', 'The governed candidate runner is unavailable.', 503); }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new SourceUpdateError('candidate_runner_unsafe', 'The governed candidate runner is unsafe.', 500);
    }
    return target;
}

/**
 * Probe the live source tree for the git-checkout-v2 preconditions: an actual
 * git working copy whose configured update remote is a single credential-free
 * GitHub URL, on the branch the updater is pinned to. Read-only; runs git with
 * a neutralized configuration so a hostile system/global git config cannot
 * influence the answer. Injected in tests so no real repository is required.
 */
export function defaultGitCheckoutProbe({ appRoot, remote, branch }) {
    if (!fs.existsSync(path.join(appRoot, '.git'))) return { ready: false, reason: 'unsupported_install_mode' };
    if (!SAFE_REMOTE.test(remote) || !SAFE_BRANCH.test(branch)) return { ready: false, reason: 'invalid_update_source' };
    const git = (args) => {
        const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
            cwd: appRoot,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_SYSTEM: '/dev/null',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_OPTIONAL_LOCKS: '0',
            },
        });
        return result.status === 0 ? result.stdout.trim() : null;
    };
    const currentBranch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (currentBranch === null) return { ready: false, reason: 'detached_head' };
    if (currentBranch !== branch) return { ready: false, reason: 'wrong_branch' };
    const urls = git(['remote', 'get-url', '--all', remote]);
    if (urls === null) return { ready: false, reason: 'remote_unavailable' };
    const lines = urls.split('\n').filter(Boolean);
    if (lines.length !== 1) return { ready: false, reason: 'ambiguous_remote' };
    const identity = normalizeGitHubRepositoryIdentity(lines[0])?.identity || null;
    if (!identity) return { ready: false, reason: 'unsafe_remote' };
    return { ready: true, branch: currentBranch, remoteIdentity: identity };
}

/**
 * Resolve the updater strategy. The verified artifact-runtime-v2 contract takes
 * precedence when present; otherwise a plain git source installation is offered
 * the credential-free git-checkout-v2 strategy (ADR-141). IS_PLATFORM is applied
 * by the /health and job-create layers, not here.
 */
export function resolveUpdateHostCapability({
    appRoot,
    moduleUrl = import.meta.url,
    env = process.env,
    detector = detectUpdateStrategy,
    gitProbe = defaultGitCheckoutProbe,
} = {}) {
    if (!appRoot) throw new TypeError('appRoot is required');
    const artifactRoot = moduleUrl.includes('/dist-server/') ? path.join(appRoot, 'dist-server') : appRoot;
    const controlRoot = path.resolve(env.NASSAJ_UPDATE_CONTROL_ROOT || defaultSourceUpdateControlRoot(appRoot));
    const capabilityFile = path.resolve(env.NASSAJ_UPDATE_CAPABILITY_FILE || path.join(controlRoot, UPDATE_RUNTIME_CAPABILITY));
    const runtimeStrategy = detector({
        artifactRoot,
        capabilityFile,
        context: { projectRoot: appRoot, controlRoot, nodeInstanceId: env.NASSAJ_NODE_INSTANCE_ID },
    });
    if (runtimeStrategy === 'artifact-runtime-v2') {
        // ADR-135 → Superseded by ADR-141: the fleet moved to git-checkout-v2.
        // The release-layout-v2 path (worker/activation branches and its
        // scripts) is retired but NOT deleted — it stays reachable only behind
        // the default-off NASSAJ_UPDATER_RELEASE_LAYOUT=1 flag, which is the
        // documented rollback for the retirement. When off, a host that would
        // resolve artifact-runtime-v2 is reported as blocked, never silent.
        if (env.NASSAJ_UPDATER_RELEASE_LAYOUT !== '1') {
            return Object.freeze({ ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
                blockedReasonCode: 'release_layout_retired' });
        }
        if (!env.NASSAJ_NODE_INSTANCE_ID || !env.NASSAJ_DEPLOY_ROOT || !env.NASSAJ_UPDATE_CONTROL_ROOT) {
            return Object.freeze({ ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
                blockedReasonCode: 'release_layout_configuration_absent' });
        }
        return Object.freeze({
            ready: true, protocol: 2, runtimeStrategy,
            jobStrategy: 'release-layout-v2',
        });
    }
    const probe = gitProbe({
        appRoot,
        remote: env.NASSAJ_UPDATE_REMOTE || 'origin',
        branch: env.NASSAJ_UPDATE_BRANCH || 'main',
    });
    if (probe?.ready) {
        return Object.freeze({
            ready: true, protocol: 2, runtimeStrategy: 'git-checkout-v2',
            jobStrategy: 'git-checkout-v2', remoteIdentity: probe.remoteIdentity,
        });
    }
    return Object.freeze({ ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
        blockedReasonCode: probe?.reason || 'verified_update_runtime_absent' });
}

export class SourceUpdateError extends Error {
    constructor(code, message, status = 409, details = {}) {
        super(message);
        this.name = 'SourceUpdateError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function appendBounded(current, chunk) {
    const next = current + chunk.toString('utf8');
    return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

export function runFile(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const durable = typeof options.onSpawn === 'function';
        let gatePath = null;
        let launchCommand = command;
        let launchArgs = args;
        if (durable) {
            if (typeof options.effectGateRoot !== 'string' || !path.isAbsolute(options.effectGateRoot)) {
                reject(new Error('source_update_effect_gate_root_unavailable')); return;
            }
            fs.mkdirSync(options.effectGateRoot, { recursive: true, mode: 0o700 });
            fs.chmodSync(options.effectGateRoot, 0o700);
            gatePath = path.join(options.effectGateRoot, `${crypto.randomUUID()}.gate`);
            const parent = childProcessIdentity(process.pid);
            if (!parent) { reject(new Error('source_update_parent_identity_unavailable')); return; }
            launchCommand = process.execPath;
            launchArgs = [fileURLToPath(new URL('./source-update-effect-launcher.js', import.meta.url)), JSON.stringify({
                parent, gate: gatePath, command, args, cwd: options.cwd,
                // ADR-207 §3.7: the launcher lowers its CHILD (nice 19, oom_score_adj 1000), never itself.
                ...(options.lowPriority === true ? { lowPriority: true } : {}),
            })];
        }
        const child = spawn(launchCommand, launchArgs, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let registrationFailed = false;
        const abort = () => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        };
        if (options.signal?.aborted) abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        const failRegistration = (error) => {
            registrationFailed = true;
            abort();
            reject(error);
        };
        let closed = false;
        const releaseGate = () => {
            if (closed) return;
            try {
                const fd = fs.openSync(gatePath, 'wx', 0o600);
                try { fs.writeFileSync(fd, 'go\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                const dirFd = fs.openSync(options.effectGateRoot, 'r');
                try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
            } catch (error) {
                failRegistration(error);
            }
        };
        child.once('spawn', () => {
            if (typeof options.onSpawn !== 'function') return;
            try {
                const identity = childProcessIdentity(child.pid);
                if (!identity) {
                    throw new Error('source_update_effect_identity_unavailable');
                }
                const registered = options.onSpawn(identity);
                // ADR-207 §3.3: an asynchronous registration (the prestage slot
                // records the effect under its flock) opens the gate only once
                // it is durable; a synchronous one opens it in this same turn.
                if (registered && typeof registered.then === 'function') {
                    registered.then(() => releaseGate(), failRegistration);
                } else {
                    releaseGate();
                }
            } catch (error) {
                failRegistration(error);
            }
        });
        // T-1768: the live log sees output as it arrives, decoded per stream so a
        // multi-byte character split across two chunks is never mangled.
        const forward = (decoder) => (chunk) => {
            if (typeof options.onOutput !== 'function') return;
            try { options.onOutput(decoder.write(chunk)); } catch { /* the log never fails a command */ }
        };
        const forwardStdout = forward(new StringDecoder('utf8'));
        const forwardStderr = forward(new StringDecoder('utf8'));
        child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); forwardStdout(chunk); });
        child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); forwardStderr(chunk); });
        child.once('error', reject);
        child.once('close', (code, signal) => {
            closed = true;
            options.signal?.removeEventListener('abort', abort);
            if (gatePath) try { fs.unlinkSync(gatePath); } catch {}
            if (registrationFailed) return;
            resolve({ code, signal, stdout, stderr });
        });
    });
}

function normalizeGitHubRemote(value) {
    return normalizeGitHubRepositoryIdentity(value)?.identity || null;
}

function commandFailure(code, operation) {
    return new SourceUpdateError(code, `The governed update could not ${operation}.`);
}

function releaseBuildEnvironment(env) {
    const allowed = [
        'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
        'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ];
    return Object.fromEntries([
        ...allowed.flatMap((key) => typeof env[key] === 'string' && env[key] ? [[key, env[key]]] : []),
        ['HUSKY', '0'],
    ]);
}

// ADR-156 decision 6 / plan ب.1: never prompt (a prompt is a hang behind pm2),
// and never trust an unknown host key — the installer writes GitHub's published
// keys at install time, so `yes` is safe and `accept-new` would be TOFU on the
// updater's own fetch.
const GOVERNED_SSH_OPTIONS = '-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10';
// An explicit `-o BatchMode …` / `-o StrictHostKeyChecking …` in any spelling ssh accepts.
const GOVERNED_SSH_KEYS = /(?:^|\s)-o\s*["']?\s*(BatchMode|StrictHostKeyChecking)\s*(?:=|\s)\s*["']?([A-Za-z-]+)/gi;

/** Quote one word for the shell git runs GIT_SSH_COMMAND through. */
function shellWord(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The repository's core.sshCommand, read under the same neutralised config governed git uses. */
function repositorySshCommand(appRoot) {
    if (!appRoot) return null;
    const result = spawnSync('git', ['config', '--get', 'core.sshCommand'], {
        cwd: appRoot, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const value = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return value || null;
}

/**
 * The ssh command governed git runs (ADR-156 decision 6, H5). It COMPOSES with
 * the node's own ssh setup rather than replacing it: the command git itself
 * would choose — GIT_SSH_COMMAND, then GIT_SSH, then the repository's
 * core.sshCommand — keeps its program and arguments (a deploy key, port 443
 * via ssh.github.com, a proxy) and gets the governed options appended, the way
 * git appends its own. Replacing it would silently cut such a node off.
 *
 * An existing command that sets BatchMode or StrictHostKeyChecking to anything
 * but `yes` is a CONFLICT and is named, so the update refuses up front
 * instead of trusting an unknown host key.
 *
 * @returns {{ command: string, source: string|null, conflict: string|null }}
 */
export function resolveGovernedSshCommand({ env = process.env, appRoot = null } = {}) {
    const fromEnv = [
        ['GIT_SSH_COMMAND', typeof env.GIT_SSH_COMMAND === 'string' && env.GIT_SSH_COMMAND.trim() ? env.GIT_SSH_COMMAND.trim() : null],
        ['GIT_SSH', typeof env.GIT_SSH === 'string' && env.GIT_SSH.trim() ? shellWord(env.GIT_SSH.trim()) : null],
    ].find(([, value]) => value);
    const configured = fromEnv ? null : repositorySshCommand(appRoot);
    const [source, existing] = fromEnv || (configured ? ['core.sshCommand', configured] : [null, null]);
    if (!existing) return { command: `ssh ${GOVERNED_SSH_OPTIONS}`, source: null, conflict: null };
    const unsafe = [...existing.matchAll(GOVERNED_SSH_KEYS)].find(([, , value]) => value.toLowerCase() !== 'yes');
    return { command: `${existing} ${GOVERNED_SSH_OPTIONS}`, source, conflict: unsafe ? `${unsafe[1]}=${unsafe[2]}` : null };
}

/**
 * The environment every governed git command runs under: the node's own
 * credentials and ssh agent are preserved so a private release source stays
 * reachable, while update-control variables and any GitHub API token are
 * stripped and a hostile system/global git config is neutralized.
 *
 * Exported because the read-only update pre-flight must probe with EXACTLY this
 * environment (ADR-156 م-1): a probe that succeeds under richer credentials
 * than the fetch will have is the false green behind B-1053.
 */
export function releaseGitEnvironment(env = process.env, { appRoot = null } = {}) {
    const nonSecretEnv = Object.fromEntries(Object.entries(env).filter(([key]) => (
        !/^(?:NASSAJ_UPDATE_.*|GH_TOKEN|GITHUB_TOKEN)$/.test(key)
    )));
    return {
        ...nonSecretEnv,
        // Pass `appRoot` so the repository's core.sshCommand is composed too;
        // the fetch always does, and a probe that does not is not the same env.
        GIT_SSH_COMMAND: resolveGovernedSshCommand({ env, appRoot }).command,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
    };
}

/**
 * Classify the local divergence for `details.divergence` on a `non_fast_forward`
 * refusal (contract §3.1 M9, W2 classifier). `git` is the updater's own runner
 * ({ code, stdout }); a pure diagnosis, so any git failure yields null and the
 * refusal message stays unchanged. Never resets or rewrites anything.
 */
async function computeLocalDivergence({ git, originalHead, releaseCommit }) {
    const run = async (args) => { const r = await git(args); return { ok: r.code === 0, stdout: r.stdout }; };
    const mb = await run(['merge-base', originalHead, releaseCommit]);
    const mergeBase = mb.ok ? mb.stdout.trim() : '';
    if (!mergeBase) return null;
    const nameStatus = await run(['diff', '--name-status', '-z', `${mergeBase}..${originalHead}`]);
    if (!nameStatus.ok) return null;
    const targetTree = await run(['ls-tree', '-r', '--name-only', '-z', releaseCommit]);
    const targetTrackedPaths = targetTree.ok ? nulFields(targetTree.stdout) : [];
    const numstat = await run(['diff', '--numstat', '-z', `${mergeBase}..${originalHead}`, '--', '.gitignore']);
    let gitignoreAddedOnly = false;
    if (numstat.ok) {
        const record = numstat.stdout.split('\0').find(Boolean);
        const columns = record ? /^(\d+|-)\t(\d+|-)\t/.exec(record) : null;
        if (columns && columns[2] === '0') gitignoreAddedOnly = true;
    }
    let packages = [];
    try {
        const base = await run(['show', `${mergeBase}:package.json`]);
        const head = await run(['show', `${originalHead}:package.json`]);
        if (base.ok && head.ok) packages = diffDependencyVersions(JSON.parse(base.stdout), JSON.parse(head.stdout));
    } catch { packages = []; }
    return classifyDivergence({ nameStatusZ: nameStatus.stdout, targetTrackedPaths, gitignoreAddedOnly, packages });
}

/**
 * `node_overlay_mount_conflict` (contract §3.1): the target release takes
 * precedence over the operator's overlay, so if it tracks any path under an
 * overlay mount the update is refused BEFORE the build. A malformed overlay is
 * NOT a build blocker (the pre-flight reports it as `node_overlay_invalid`).
 */
async function assertNoOverlayMountConflict({ git, appRoot, releaseCommit, version }) {
    let raw;
    try { raw = fs.readFileSync(path.join(appRoot, 'config', 'node-overlay.json'), 'utf8'); } catch { return; }
    let config;
    try { config = parseNodeOverlay(raw); } catch { return; }
    const conflicts = [];
    for (const { mount } of config.static) {
        const seg = mount.slice(1);
        const tree = await git(['ls-tree', '-r', '--name-only', '-z', releaseCommit, '--', `public/${seg}/`]);
        if (tree.code === 0 && nulFields(tree.stdout).filter(Boolean).length > 0) conflicts.push(mount);
    }
    if (conflicts.length) {
        throw new SourceUpdateError('node_overlay_mount_conflict',
            `Release ${version} tracks paths under overlay mount(s) ${conflicts.join(', ')}; the release takes precedence over the node customization. Change the mount in config/node-overlay.json, then retry.`,
            409, { mounts: conflicts });
    }
}

/**
 * B-1585: remove a candidate this call alone created, after its worker was
 * fenced. The transaction id carries a per-call nonce and was never handed to
 * the job (no seal, no queued action), so no other owner can reference it. The
 * fenced git runner refuses by design, hence the plain runner, scoped to the
 * one worktree path and the private refs.
 */
async function discardPrivateCandidate({ commandRunner, appRoot, gitEnv, stagePath, planPath }) {
    const git = (args) => Promise.resolve(commandRunner('git', ['-c', 'core.hooksPath=/dev/null', ...args],
        { cwd: appRoot, env: gitEnv })).catch(() => undefined);
    if (stagePath) await git(['worktree', 'remove', '--force', stagePath]);
    try {
        if (stagePath) fs.rmSync(path.dirname(stagePath), { recursive: true, force: true });
        if (planPath) fs.rmSync(planPath, { force: true });
    } catch { /* best effort: the next update reports leftover storage */ }
}

/**
 * B-1585 (qa improvement-4): the waiter's requestId is per JOB
 * (`release-update:<jobId>`) and reserveFullUpdateWaiter replays the same
 * record — same revision — for a re-claimed attempt, so the waiter alone cannot
 * tell this attempt from a newer owner's. It is failed only after the worker
 * proves, atomically under this attempt's exact lease, that the job is now
 * terminal (`failed`): a terminal job is never claimed again, so no newer
 * owner can be waiting on it. failReleaseUpdateWaiter adds its own CAS
 * (revision, phase waiting, no effect). Anything else leaves the waiter alone.
 */
async function failAbandonedWaiter({ appRoot, waiter, settleLostLease }) {
    if (typeof settleLostLease !== 'function') return;
    try {
        if ((await settleLostLease()) === 'failed') await failReleaseUpdateWaiter(appRoot, waiter);
    } catch { /* the waiter keeps its durable state; recovery owns it */ }
}

async function dropPrivateRefs({ commandRunner, appRoot, gitEnv, refs }) {
    for (const ref of refs) {
        await Promise.resolve(commandRunner('git', ['-c', 'core.hooksPath=/dev/null', 'update-ref', '-d', ref],
            { cwd: appRoot, env: gitEnv })).catch(() => undefined);
    }
}

/**
 * B-1625: mirror the fetched release branch into `refs/remotes/<remote>/<branch>`,
 * as a plain `git fetch` would, so the pre-flight stops counting the release
 * commits this updater installed as local ones. Fast-forward only (never
 * rewinds), compare-and-swap on the old value, best-effort: a failure is written
 * to the job log and never fails the update. Returns the outcome for the log/tests.
 * The ref intentionally moves to the fetched branch HEAD (as `git fetch` would),
 * which may be ahead of the release tag just installed.
 */
export async function advanceRemoteTrackingRef({ git, remote, branch, fetchedRef, log = () => {} }) {
    const trackingRef = `refs/remotes/${remote}/${branch}`;
    let attempted = false;
    try {
        const fetched = await git(['rev-parse', '--verify', '--quiet', `${fetchedRef}^{commit}`]);
        const target = fetched.stdout?.trim();
        if (fetched.code !== 0 || !target) return skipTrackingAdvance(log, trackingRef, 'fetched_ref_unavailable');
        const current = await git(['rev-parse', '--verify', '--quiet', `${trackingRef}^{commit}`]);
        const previous = current.code === 0 ? current.stdout.trim() : '';
        if (previous === target) return 'unchanged';
        if (previous && (await git(['merge-base', '--is-ancestor', previous, target])).code !== 0) {
            return skipTrackingAdvance(log, trackingRef, 'not_fast_forward');
        }
        attempted = true;
        const moved = await git(['update-ref', '-m', 'nassaj update: advance tracking ref', trackingRef, target, previous]);
        if (moved.code !== 0) return skipTrackingAdvance(log, trackingRef, 'update_ref_failed');
        return 'advanced';
    } catch {
        // Once update-ref was spawned, a throw (e.g. a lost fence after the
        // write) cannot tell whether the ref moved, so the log says so.
        return skipTrackingAdvance(log, trackingRef, 'git_failed', attempted);
    }
}

function skipTrackingAdvance(log, trackingRef, reason, uncertain = false) {
    const state = uncertain ? 'may be unchanged' : 'left unchanged';
    try { log(`tracking ref ${trackingRef} ${state} (${reason}); the update is unaffected\n`); } catch { /* log is best-effort */ }
    return reason;
}

function requireNoActiveSessions(activeSessionCount) {
    let sessions;
    try { sessions = activeSessionCount(); } catch { throw new SourceUpdateError('session_state_unavailable', 'Active session state is unavailable.'); }
    if (!Number.isSafeInteger(sessions) || sessions < 0) throw new SourceUpdateError('session_state_unavailable', 'Active session state is unavailable.');
    if (sessions > 0) throw new SourceUpdateError('active_sessions', 'Finish all active agent sessions before updating.');
}

/**
 * The command runner of one update: every command checks the fence first and,
 * for a durable job, registers its process group as an effect (T-1768 logs it).
 */
function createGuardedRunner({ commandRunner, jobIdentity, assertFence, onOutput }) {
    return async (command, args, options = {}) => {
        assertFence();
        onOutput?.(`$ ${[path.basename(command), ...args].join(' ')}\n`);
        const durable = typeof jobIdentity.jobId === 'string' && jobIdentity.jobId.length > 0;
        if (durable && (typeof jobIdentity.registerEffect !== 'function' || typeof jobIdentity.completeEffect !== 'function')) {
            throw new SourceUpdateError('effect_registry_unavailable', 'The durable update effect registry is unavailable.', 503);
        }
        if (!durable) return commandRunner(command, args, { ...options, signal: jobIdentity.signal, onOutput });
        const effectId = crypto.randomUUID();
        let registered = false;
        const result = await commandRunner(command, args, {
            ...options, signal: jobIdentity.signal, effectGateRoot: jobIdentity.effectGateRoot, onOutput,
            onSpawn: (identity) => {
                jobIdentity.registerEffect({ ...identity, effectId, kind: path.basename(command) });
                registered = true;
            },
        });
        if (!registered) throw new SourceUpdateError('effect_identity_unavailable', 'The update effect identity was not recorded.', 500);
        await jobIdentity.completeEffect(effectId);
        assertFence();
        return result;
    };
}

/**
 * The context one updateSource() call shares between buildCandidate() and
 * sealAndQueue(): the updater's dependencies, the job's fence, the governed git
 * helpers and, once the run starts, `run` (refs, waiter, lease and the B-1585
 * flags every cleanup branch reads).
 */
function createUpdateContext(deps, expectedVersion, jobIdentity) {
    // Resolved per update: core.sshCommand may change between two updates.
    const ssh = resolveGovernedSshCommand({ env: deps.env, appRoot: deps.appRoot });
    const gitEnv = { ...releaseGitEnvironment(deps.env), GIT_SSH_COMMAND: ssh.command };
    const assertFence = typeof jobIdentity.assertFence === 'function' ? jobIdentity.assertFence : () => true;
    // B-1585: renew the worker lease around long synchronous steps (they
    // block the heartbeat timer); falls back to a plain fence check.
    const renewLease = typeof jobIdentity.renewLease === 'function' ? jobIdentity.renewLease : assertFence;
    // T-1768: each command and its output go to the job's live log.
    const onOutput = typeof jobIdentity.onOutput === 'function' ? jobIdentity.onOutput : undefined;
    const guardedRun = createGuardedRunner({ commandRunner: deps.commandRunner, jobIdentity, assertFence, onOutput });
    const git = (args, commandEnv = gitEnv) => guardedRun('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: deps.appRoot, env: commandEnv });
    const requireGitRaw = async (args, code, operation, commandEnv = gitEnv) => {
        const result = await git(args, commandEnv);
        if (result.code !== 0) throw commandFailure(code, operation);
        return result.stdout;
    };
    // NUL-delimited porcelain and path lists must stay untrimmed: trimming a
    // status record eats the leading status column and shifts every path.
    const requireGit = async (args, code, operation, commandEnv = gitEnv) => (
        (await requireGitRaw(args, code, operation, commandEnv)).trim()
    );
    return {
        ...deps, expectedVersion, jobIdentity, ssh, gitEnv, assertFence, renewLease, onOutput,
        guardedRun, git, requireGitRaw, requireGit, maintenance: null, run: null,
    };
}

/** The checks that refuse an update before it takes the in-progress slot. */
function assertUpdateEntry(ctx) {
    const { appRoot, env, statfs, remote, branch, ssh } = ctx;
    if (!isNassajReleaseVersion(ctx.expectedVersion)) {
        throw new SourceUpdateError('invalid_release_version', 'Expected version must be a canonical four-part Nassaj release.', 400);
    }
    if (!SAFE_REMOTE.test(remote) || !SAFE_BRANCH.test(branch)) {
        throw new SourceUpdateError('invalid_update_source', 'The configured update source is invalid.', 500);
    }
    if (!fs.existsSync(path.join(appRoot, '.git'))) {
        throw new SourceUpdateError('unsupported_install_mode', 'This updater requires a Nassaj source installation.');
    }
    // Pre-flight storage gate before any git or build work (ADR-141, T-1553).
    assertUpdateStorage({ appRoot, env, statfs });
    // ADR-156 decision 7 (ج): a degraded reopen blocks the next update. It
    // is refused HERE, before the fetch and the `npm ci`, not at activation
    // where beginUpdate refuses it after a whole candidate was built (C2).
    const maintenance = createUpdateMaintenanceGate({ projectPath: appRoot });
    const gateStatus = maintenance.readPublicStatus();
    if (gateStatus.degraded) {
        throw new SourceUpdateError('update_source_state_degraded',
            'The previous update left the source tree at its release commit. Run `npm run doctor -- --reopen-gate --complete-source-rollback --yes` as the service account, then retry.',
            409, { exitPath: gateStatus.exitPath });
    }
    if (ssh.conflict) {
        throw new SourceUpdateError('ssh_command_conflict',
            `The ssh command from ${ssh.source} sets ${ssh.conflict}; governed updates require BatchMode=yes and StrictHostKeyChecking=yes. Remove that option, then retry.`,
            409);
    }
    return maintenance;
}

/**
 * The per-run state. The job path takes the defaults; the prestager (ADR-207
 * §3.3, §3.8) passes its own transaction id, its private ref prefix, its
 * writer-lease kind and `emptyRefmap` (fetch with `--refmap=` so git's
 * opportunistic remote-tracking update cannot move `origin/<branch>`).
 * @param {{transactionId?: string, refPrefix?: string, leaseKind?: string, emptyRefmap?: boolean}} [options]
 */
function createRunState({ transactionId = null, refPrefix = null, leaseKind = 'source-update-stage', emptyRefmap = false } = {}) {
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const refs = refPrefix ?? `refs/nassaj-update/${nonce}/`;
    return {
        nonce, tagRef: `${refs}tag`, branchRef: `${refs}branch`,
        presetTransactionId: transactionId, leaseKind, emptyRefmap,
        fetchedTemporaryRefs: false, writerLease: null, publicationWaiter: null, stagePath: null, planPath: null,
        transactionId: null, candidatePersisted: false, restartQueued: false, activationEverQueued: false, queuedBuildId: null,
        sealHandedOff: false, hostAdmitted: false,
    };
}

/**
 * The configured release remote of the live checkout (HEAD-independent): one
 * credential-free GitHub URL equal to the configured release source.
 */
const RELEASE_REMOTE_MESSAGES = Object.freeze({
    remote_unavailable: 'The governed update could not verify the configured remote.',
    ambiguous_remote: 'The update remote must have exactly one URL.',
    unsafe_remote: 'The update remote must be a credential-free GitHub HTTPS or SSH URL.',
    remote_mismatch: 'The runtime Git remote does not match the configured release source.',
});

/**
 * The release-remote trust rule (ADR-141; shared with the ADR-216 attach path so
 * the two cannot drift): exactly one credential-free GitHub URL, equal to the
 * configured release source. `git` is any governed runner returning `{ code, stdout }`.
 * @returns {Promise<{ok: true, identity: string} | {ok: false, code: string}>}
 */
export async function checkReleaseRemote(git, { remote, configuredRemoteUrl }) {
    const result = await git(['remote', 'get-url', '--all', remote]);
    if (result.code !== 0) return { ok: false, code: 'remote_unavailable' };
    const remoteUrls = String(result.stdout).trim().split('\n').filter(Boolean);
    if (remoteUrls.length !== 1) return { ok: false, code: 'ambiguous_remote' };
    const identity = normalizeGitHubRemote(remoteUrls[0]);
    if (!identity) return { ok: false, code: 'unsafe_remote' };
    if (normalizeGitHubRemote(configuredRemoteUrl) !== identity) return { ok: false, code: 'remote_mismatch' };
    return { ok: true, identity };
}

/**
 * The tag-on-branch predicate of a release (ADR-216 §3.1 steps 4–6), shared by
 * the updater (`resolveReleaseIdentity`) and the attach proof. Ancestry exit 1
 * is "not on the branch"; any other non-zero exit is never read as success.
 * The updater keeps its historical rule (`requireAnnotated: false`); discovery
 * already offers annotated tags only, and the attach proof requires them.
 * @param {(args: string[]) => Promise<{code: number, stdout: string}>} git
 * @param {{tagRef: string, branchRef: string, expectedCommit?: string|null, requireAnnotated?: boolean,
 *   resolvedCommit?: string|null}} refs
 * @returns {Promise<{ok: true, commit: string} | {ok: false, code: string}>}
 */
export async function proveTagOnBranch(git, {
    tagRef, branchRef, expectedCommit = null, requireAnnotated = true, resolvedCommit = null,
}) {
    if (requireAnnotated) {
        const type = await git(['cat-file', '-t', tagRef]);
        if (type.code !== 0 || String(type.stdout).trim() !== 'tag') return { ok: false, code: 'tag_not_annotated' };
    }
    // The updater has already resolved the tag (and refused a loaded target) by
    // the time it asks; it passes that commit instead of resolving twice.
    const resolved = resolvedCommit ? null : await git(['rev-parse', '--verify', '--quiet', `${tagRef}^{commit}`]);
    const commit = resolvedCommit || (resolved.code === 0 ? String(resolved.stdout).trim() : '');
    if (!COMMIT_OID.test(commit)) return { ok: false, code: 'tag_unresolved' };
    if (expectedCommit && commit !== expectedCommit) return { ok: false, code: 'head_not_release_tag' };
    const ancestry = await git(['merge-base', '--is-ancestor', commit, branchRef]);
    if (ancestry.code === 1) return { ok: false, code: 'tag_not_on_release_branch' };
    if (ancestry.code !== 0) return { ok: false, code: 'ancestry_unproven' };
    return { ok: true, commit };
}

async function verifyReleaseRemote(ctx) {
    const outcome = await checkReleaseRemote(ctx.git, { remote: ctx.remote, configuredRemoteUrl: ctx.configuredRemoteUrl });
    if (!outcome.ok) throw new SourceUpdateError(outcome.code, RELEASE_REMOTE_MESSAGES[outcome.code]);
    return outcome.identity;
}

/** CLICK-TIME: branch, HEAD and remote of the live source tree, before anything is fetched. */
async function verifyLocalSource(ctx) {
    const { requireGit, requireGitRaw, branch } = ctx;
    // Pre-fetch guard, narrowed to MODIFIED TRACKED files (ADR-156 أ.4, WI-10).
    // The release commit is still unknown here, so the set of paths the
    // update rewrites is unknowable and this check cannot be scoped to it.
    // Refusing on untracked files at this point is B-1050 itself: an
    // operator file the release never touches vetoed the whole jump. The
    // binding, scoped cleanliness gate runs below, once `releaseCommit`
    // is resolved.
    const trackedStatus = await requireGitRaw(['status', '--porcelain=v1', '--untracked-files=no', '-z'], 'git_status_failed', 'inspect the working tree');
    const trackedChanges = parsePorcelainStatus(trackedStatus).tracked;
    if (trackedChanges.length) {
        throw new SourceUpdateError('dirty_worktree', `The source tree has uncommitted changes to tracked files: ${describePaths(trackedChanges)}.`);
    }

    const currentBranch = await requireGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'detached_head', 'identify the current branch');
    if (currentBranch !== branch) throw new SourceUpdateError('wrong_branch', `The updater requires branch ${branch}.`);
    const originalHead = await requireGit(['rev-parse', '--verify', 'HEAD^{commit}'], 'head_unavailable', 'read the current commit');
    const runtimeRemote = await verifyReleaseRemote(ctx);
    return { originalHead, runtimeRemote };
}

/**
 * HEAD-independent release identity (ADR-207 §3.1): fetch the exact release
 * into this run's private refs, resolve its commit, refuse a target the running
 * runtime already loads or contains, require the tag on the release branch and
 * the tag's package version to be the expected one.
 * @returns {Promise<{releaseCommit: string}>}
 */
async function resolveReleaseIdentity(ctx, { runtimeRemote }) {
    const { git, requireGit, remote, branch, run, loadedRuntimeCommit, expectedVersion } = ctx;
    const tag = releaseTagForVersion(expectedVersion);
    await requireGit(['fetch', '--no-tags', ...(run.emptyRefmap ? ['--refmap='] : []), remote,
        `refs/tags/${tag}:${run.tagRef}`, `refs/heads/${branch}:${run.branchRef}`], 'release_fetch_failed', 'fetch the exact release', ctx.gitEnv);
    run.fetchedTemporaryRefs = true;
    const remoteAfterFetch = normalizeGitHubRemote(await requireGit(['remote', 'get-url', remote], 'remote_unavailable', 're-verify the configured remote'));
    if (remoteAfterFetch !== runtimeRemote) throw new SourceUpdateError('remote_changed', 'The update remote changed during the update.');

    const releaseCommit = await requireGit(['rev-parse', '--verify', `${run.tagRef}^{commit}`], 'tag_mismatch', 'resolve the release tag');
    // B-1585: never stage the commit the running server already runs
    // (an out-of-band install): it would only queue a redundant restart.
    if (isTargetAlreadyLoaded(releaseCommit, loadedRuntimeCommit)) {
        throw new SourceUpdateError(TARGET_ALREADY_LOADED, SUPERSEDING_TARGET_CODES[TARGET_ALREADY_LOADED], 409);
    }
    // B-1585 (qa mid-1): nor a target the running runtime already
    // contains (e.g. the node was installed to a newer release while a
    // job for an older one was stranded). An unknown loaded commit
    // makes git exit non-zero, which is never read as "contained".
    const loadedCommit = readLoadedRuntimeCommit(loadedRuntimeCommit);
    if (loadedCommit && (await git(['merge-base', '--is-ancestor', releaseCommit, loadedCommit])).code === 0) {
        throw new SourceUpdateError(TARGET_NOT_NEWER, SUPERSEDING_TARGET_CODES[TARGET_NOT_NEWER], 409);
    }
    const onReleaseBranch = await proveTagOnBranch(git, {
        tagRef: run.tagRef, branchRef: run.branchRef, resolvedCommit: releaseCommit, requireAnnotated: false,
    });
    if (!onReleaseBranch.ok) throw new SourceUpdateError('tag_mismatch', 'The release tag is not part of the configured release branch.');
    const packageText = await requireGit(['show', `${releaseCommit}:package.json`], 'release_manifest_unavailable', 'read the release manifest');
    let releaseManifest;
    try { releaseManifest = JSON.parse(packageText); } catch { throw new SourceUpdateError('release_manifest_invalid', 'The release package manifest is invalid.'); }
    if (releaseManifest.version !== expectedVersion) throw new SourceUpdateError('tag_version_mismatch', 'The release tag and package version do not match.');
    return { releaseCommit };
}

/** CLICK-TIME: the release must fast-forward the live HEAD read at click. */
async function assertFastForward(ctx, { originalHead, releaseCommit }) {
    const { git } = ctx;
    const fastForward = await git(['merge-base', '--is-ancestor', originalHead, releaseCommit]);
    if (fastForward.code !== 0) {
        let divergence = null;
        try { divergence = await computeLocalDivergence({ git, originalHead, releaseCommit }); } catch { divergence = null; }
        throw new SourceUpdateError('non_fast_forward', 'The requested release is not a fast-forward update.',
            409, divergence ? { divergence } : {});
    }
}

/** CLICK-TIME: paths the release rewrites from the live HEAD, and the compatibility gates on that diff. */
async function verifyReleaseContent(ctx, { originalHead, releaseCommit }) {
    const { git, requireGitRaw, appRoot, expectedVersion } = ctx;
    // The paths this release rewrites — the only scope in which a local
    // change can collide with it (ADR-156 أ.4). The same set governs the
    // post-build race guard below, so it is read once, here.
    const releasePaths = new Set(nulFields(await requireGitRaw(
        ['diff', '--name-only', '-z', `${originalHead}..${releaseCommit}`],
        'release_diff_failed', 'read the paths the release rewrites')));

    // Compatibility gate (ADR-156 ب.1, WI-11): a release that adds, drops
    // or retargets a submodule gitlink is an UNSUPPORTED STATE, and an
    // unsupported state is settled before any write — here, before the
    // candidate build spends an `npm ci` on it, instead of inside
    // activation where it also broke every rollback (B-1054). The raw
    // diff is bounded by the release, so the whole tree is never listed.
    const changedEntries = parseRawDiffEntries(await requireGitRaw(
        ['diff', '--raw', '-z', '--abbrev=40', `${originalHead}..${releaseCommit}`],
        'release_diff_failed', 'read the entries the release rewrites'));
    const changedGitlinks = gitlinkChangePaths(changedEntries.from, changedEntries.to);
    if (changedGitlinks.length) {
        throw new SourceUpdateError('gitlink_change_unsupported',
            `This release changes ${changedGitlinks.length} submodule gitlink(s), which activation and rollback do not support: ${describePaths(changedGitlinks)}.`, 409);
    }

    // Node overlay mount conflict (contract §3.1): refuse BEFORE the build
    // when the release tracks a path under an overlay mount.
    await assertNoOverlayMountConflict({ git, appRoot, releaseCommit, version: expectedVersion });
    return releasePaths;
}

/** CLICK-TIME: sessions, HEAD, scoped cleanliness and the write-free activation plan, re-checked last. */
async function recheckBeforeStage(ctx, { originalHead, releaseCommit, releasePaths }) {
    const { requireGit, requireGitRaw, renewLease } = ctx;
    requireNoActiveSessions(ctx.activeSessionCount);
    const headBeforeUpdate = await requireGit(['rev-parse', '--verify', 'HEAD^{commit}'], 'head_unavailable', 're-read the current commit');
    if (headBeforeUpdate !== originalHead) throw new SourceUpdateError('source_changed', 'The source tree changed during update preparation.');
    // The single binding cleanliness gate: tracked or untracked, a local
    // change blocks the update only when the release rewrites that exact
    // path, and the message names the collisions (WI-10, B-1050).
    const statusBeforeUpdate = await requireGitRaw(['status', '--porcelain=v1', '--untracked-files=all', '-z'], 'git_status_failed', 'recheck the working tree');
    const collisions = conflictingPaths({ ...parsePorcelainStatus(statusBeforeUpdate), changed: releasePaths });
    if (collisions.length) {
        throw new SourceUpdateError('dirty_worktree', `${collisions.length} local change(s) fall inside the paths this release rewrites: ${describePaths(collisions)}.`);
    }
    // The write-free plan activation runs again before closing the gate
    // (H1). `git status` never shows ignored files, nor a file where the
    // release needs a directory; they used to surface only after the
    // gate closed, as a CAS failure mid-activation.
    renewLease();
    try {
        ctx.sourcePlanner({ projectRoot: ctx.appRoot, originalHead, targetCommit: releaseCommit });
    } catch (error) {
        const detail = String(error?.message || 'unknown').replace(/^Source activation /, '').slice(0, 300);
        throw new SourceUpdateError('source_plan_conflict',
            `The source tree cannot take this release without overwriting local files (${detail}). Move that path aside, then retry.`, 409);
    }
    renewLease();
}

/**
 * CLICK-TIME: reserve the full-update waiter of this job (B-1585 replays the
 * same record for a re-claimed attempt). Runs right before the adopt-or-build
 * point, so a prestaged build never reserves it.
 */
async function reserveReleaseWaiter(ctx, releaseCommit) {
    const { assertFence, appRoot, jobIdentity, run } = ctx;
    assertFence();
    run.publicationWaiter = await reserveFullUpdateWaiter(appRoot, { requestId: `release-update:${jobIdentity.jobId || run.nonce}`,
        ownerId: jobIdentity.ownerId ?? 'release-button', sourceOid: releaseCommit });
}

/**
 * Take the writer lease and run the host-compatibility gates of the
 * candidates root. Once per run (S4): an adoption that falls back to a build
 * does not take the lease twice.
 * @returns {Promise<string>} the candidates root
 */
async function admitCandidateHost(ctx) {
    const { assertFence, appRoot, maintenance, run, stat } = ctx;
    const candidatesRoot = path.join(maintenance.paths.controlRoot, 'candidates');
    if (run.hostAdmitted) return candidatesRoot;
    run.writerLease = await maintenance.acquireWriterLease({ kind: run.leaseKind });
    assertFence();
    assertFence();
    fs.mkdirSync(candidatesRoot, { recursive: true, mode: 0o700 });
    // The other two host-compatibility gates of ADR-156 ب.2, also settled
    // before the build: `mv --exchange --no-copy` is what activation runs
    // with no fallback, and it cannot cross a filesystem boundary. Both
    // used to surface at exchange time — or, worse, at rollback time,
    // where they turned a recoverable update into MANUAL (B-1054).
    // They run BEFORE candidates/<tx> exists: a refusal used to leave that
    // empty directory behind (qa-critic L1). A fresh directory inside
    // candidates/ is on candidates/' own filesystem, so it stands in.
    const generationDevice = stat(appRoot).dev;
    const foreignGenerations = [candidatesRoot, ...['dist', 'dist-server', 'node_modules'].map((name) => path.join(appRoot, name))]
        .filter((target) => fs.existsSync(target) && stat(target).dev !== generationDevice)
        .map((target) => path.relative(appRoot, target) || target);
    if (foreignGenerations.length) {
        throw new SourceUpdateError('activation_filesystem_mismatch',
            `The update generations must share one filesystem with the source tree; these do not: ${describePaths(foreignGenerations)}.`, 409);
    }
    if (ctx.exchangeProbe() !== true) {
        throw new SourceUpdateError('exchange_capability',
            'This host lacks mv --exchange --no-copy, which activation requires with no fallback. Install GNU coreutils 9 or newer.', 409);
    }
    assertFence();
    run.hostAdmitted = true;
    return candidatesRoot;
}

/** Take the writer lease, then create candidates/<tx> on a checked host. */
async function reserveCandidateSlot(ctx) {
    const { assertFence, run } = ctx;
    const candidatesRoot = await admitCandidateHost(ctx);
    const transactionId = run.presetTransactionId ?? `update-${run.nonce}`;
    const candidateRoot = path.join(candidatesRoot, transactionId);
    fs.mkdirSync(candidateRoot, { mode: 0o700 });
    assertFence();
    return { transactionId, candidateRoot };
}

/** The output paths of a candidate plan, derived from its root alone. */
function candidatePlanOutputs(candidateRoot) {
    return {
        client: path.join(candidateRoot, 'client'), server: path.join(candidateRoot, 'server'),
        nodeModules: path.join(candidateRoot, 'node_modules'),
        manifest: path.join(candidateRoot, 'candidate-manifest.json'),
    };
}

/** Write the candidate build plan (`wx`) beside the control root. */
function writeCandidatePlan(ctx, { transactionId, candidateRoot, releaseCommit }) {
    const { run, env, assertFence } = ctx;
    run.planPath = path.join(ctx.maintenance.paths.controlRoot, `plan-${transactionId}.json`);
    const plan = {
        schemaVersion: 1, txId: transactionId, sourceRoot: run.stagePath, candidateRoot,
        releaseCommit, version: ctx.expectedVersion,
        publicVite: Object.fromEntries(
            ['VITE_IS_PLATFORM', 'VITE_PUBLIC_SOURCE_URL']
                .flatMap((key) => typeof env[key] === 'string' ? [[key, env[key]]] : []),
        ),
        outputs: candidatePlanOutputs(candidateRoot),
    };
    assertFence();
    fs.writeFileSync(run.planPath, `${JSON.stringify(plan)}\n`, { flag: 'wx', mode: 0o600 });
    assertFence();
    return plan;
}

/** Read the candidate manifest once and validate it against this run's identity. */
function readCandidateManifest(ctx, plan, { transactionId, releaseCommit }) {
    const manifestRaw = fs.readFileSync(plan.outputs.manifest);
    const manifest = JSON.parse(manifestRaw);
    if (manifest?.schemaVersion !== 1 || manifest.txId !== transactionId
        || manifest.releaseCommit !== releaseCommit || manifest.version !== ctx.expectedVersion
        || !/^[0-9a-f]{64}$/.test(manifest.serverBuildId || '')
        || !/^[0-9a-f]{64}$/.test(manifest.clientBuildId || '')
        || manifest.sourceProvenance?.kind !== 'git-worktree'
        || manifest.sourceProvenance?.commit !== releaseCommit
        || manifest.sourceProvenance?.clean !== true
        || manifest.artifacts?.client?.commit !== releaseCommit
        || manifest.artifacts?.client?.buildId !== manifest.clientBuildId
        || manifest.artifacts?.server?.commit !== releaseCommit
        || manifest.artifacts?.server?.buildId !== manifest.serverBuildId
        || manifest.artifacts?.nodeModules?.commit !== releaseCommit) {
        throw new SourceUpdateError('candidate_manifest_invalid', 'The staged candidate manifest is invalid.');
    }
    return { manifest, manifestRaw };
}

/** Check out the release in a private worktree, build it off-tree and verify the result. */
async function stageCandidate(ctx, slot) {
    const { run, requireGit, guardedRun, renewLease } = ctx;
    const { releaseCommit } = slot;
    run.stagePath = path.join(slot.candidateRoot, 'source');
    try {
        await requireGit(['worktree', 'add', '--detach', run.stagePath, releaseCommit], 'candidate_checkout_failed', 'stage the exact release');
        const plan = writeCandidatePlan(ctx, slot);
        const staged = await guardedRun(process.execPath, [
            resolveCandidateScript(ctx.appRoot), '--plan', run.planPath,
        ], { cwd: ctx.appRoot, env: ctx.releaseBuildEnv });
        if (staged.code !== 0) throw commandFailure('candidate_build_failed', 'build the release candidate');
        const stageHead = await guardedRun('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: run.stagePath, env: ctx.gitEnv });
        if (stageHead.code !== 0 || stageHead.stdout.trim() !== releaseCommit) {
            throw new SourceUpdateError('candidate_identity_mismatch', 'The staged candidate does not match the requested release.');
        }
        renewLease();
        const { manifest, manifestRaw } = readCandidateManifest(ctx, plan, slot);
        renewLease();
        return { plan, manifest, manifestRaw };
    } catch (error) {
        await removeFailedCandidate(ctx);
        throw error;
    }
}

/**
 * B-1585: the cleanup of a candidate whose build or seal failed, driven by the
 * run flags. A queued restart action is withdrawn; a never-persisted candidate
 * is removed by the fenced runner (worktree, `dirname(stagePath)`, plan) unless
 * the run was aborted, in which case only a never-sealed one is discarded by the
 * plain runner. A sealed or queued candidate stays with the activation path.
 */
async function removeFailedCandidate(ctx) {
    const { run, jobIdentity, assertFence } = ctx;
    if (!jobIdentity.signal?.aborted && run.restartQueued && typeof ctx.removeRestartAction === 'function') {
        assertFence();
        await ctx.removeRestartAction({ expectedServerBuildId: run.queuedBuildId, transactionId: run.transactionId }).catch(() => undefined);
        run.restartQueued = false;
    }
    if (!jobIdentity.signal?.aborted && !run.candidatePersisted && run.stagePath) {
        assertFence();
        await ctx.git(['worktree', 'remove', '--force', run.stagePath]).catch(() => undefined);
        fs.rmSync(path.dirname(run.stagePath), { recursive: true, force: true });
        if (run.planPath) fs.rmSync(run.planPath, { force: true });
    } else if (jobIdentity.signal?.aborted && !run.candidatePersisted && !run.restartQueued && !run.sealHandedOff) {
        await discardPrivateCandidate({ commandRunner: ctx.commandRunner, appRoot: ctx.appRoot, gitEnv: ctx.gitEnv,
            stagePath: run.stagePath, planPath: run.planPath });
    }
}

/**
 * A built, verified, UNSEALED candidate as sealAndQueue() consumes it.
 *
 * Two fields are CLICK-TIME facts, not build facts (ADR-207 §3.1, qa A4):
 * `originalHead` and `releasePaths` are computed by updateSource() from the
 * live tree when the job runs (verifyLocalSource, verifyReleaseContent) and
 * merged in after the adopt-or-build point. buildCandidate() never returns
 * them, and they are NEVER taken from a prestaged slot: a slot built hours
 * earlier saw a HEAD and a diff that may no longer hold, and the action's
 * originalHead and the post-queue race guard must describe the tree being
 * activated.
 *
 * @typedef {object} BuiltCandidate
 * @property {string} transactionId  `update-<nonce>`, also the candidate directory name.
 * @property {string} candidateRoot  `<controlRoot>/candidates/<transactionId>`.
 * @property {string} releaseCommit  The fetched, verified release commit.
 * @property {string} version        The expected release version.
 * @property {object} plan           The build plan, incl. `outputs.client|server|nodeModules|manifest`.
 * @property {object} manifest       The validated candidate manifest.
 * @property {Buffer} manifestRaw    The manifest bytes, read once (hashed by sealAndQueue).
 * @property {string} originalHead   CLICK-TIME: the live HEAD read at click by updateSource().
 * @property {Set<string>} releasePaths  CLICK-TIME: paths the release rewrites from that HEAD
 *   (post-queue race guard scope), computed at click by updateSource().
 */

/**
 * ADR-207 §3.1: the HEAD-independent build. It runs only the release identity
 * (fetch, tag on branch, version, not loaded / not older — skipped when the
 * caller already resolved it), the writer lease, candidate creation, the build
 * and the manifest verification. It reads nothing of the live tree's HEAD,
 * index or sessions and reserves no release waiter: those are click-time
 * checks owned by updateSource(). Publishes no client generation and queues
 * nothing. Holds the writer lease in `ctx.run` for the caller to release.
 *
 * Candidate ownership: a failure inside the stage step removes the candidate
 * here (removeFailedCandidate). Once this returns, the candidate belongs to
 * the caller; sealAndQueue() removes it on its own failure by the same rules.
 * @param {object} ctx
 * @param {{releaseCommit: string}|null} [release] an identity the caller resolved in this run
 * @returns {Promise<Omit<BuiltCandidate, 'originalHead' | 'releasePaths'>>}
 */
async function buildCandidate(ctx, release = null) {
    const { releaseCommit } = release
        ?? await resolveReleaseIdentity(ctx, { runtimeRemote: await verifyReleaseRemote(ctx) });
    const slot = { ...await reserveCandidateSlot(ctx), releaseCommit };
    ctx.run.transactionId = slot.transactionId;
    const staged = await stageCandidate(ctx, slot);
    return { ...slot, version: ctx.expectedVersion, ...staged };
}

/**
 * The button path up to the adopt-or-build point, in its defined order
 * (ADR-207 §6 parity): sessions, live source, release identity, fast-forward
 * from the live HEAD, the release diff gates, the last re-checks and the
 * release waiter; then the build; the click-time facts are merged last.
 * @returns {Promise<BuiltCandidate>}
 */
async function prepareCandidateAtClick(ctx) {
    requireNoActiveSessions(ctx.activeSessionCount);
    const { originalHead, runtimeRemote } = await verifyLocalSource(ctx);
    const release = await resolveReleaseIdentity(ctx, { runtimeRemote });
    const { releaseCommit } = release;
    await assertFastForward(ctx, { originalHead, releaseCommit });
    const releasePaths = await verifyReleaseContent(ctx, { originalHead, releaseCommit });
    await recheckBeforeStage(ctx, { originalHead, releaseCommit, releasePaths });
    await reserveReleaseWaiter(ctx, releaseCommit);
    // Adopt-or-build point (ADR-207 §3.5, S4): every click-time check above
    // ran; adoption replaces only buildCandidate(), never a check.
    const built = await adoptPrestagedCandidate(ctx, release) ?? await buildCandidate(ctx, release);
    return { ...built, originalHead, releasePaths };
}

/** Prepare the candidate's client generation (and the live one first) in the client store. */
function publishClientGeneration(ctx, built) {
    const { appRoot, renewLease } = ctx;
    if (!fs.existsSync(path.join(built.plan.outputs.client, 'CLIENT_ASSET_MANIFEST.json'))) return;
    if (fs.existsSync(path.join(appRoot, 'dist/CLIENT_ASSET_MANIFEST.json'))) {
        prepareClientPublicationAssets(appRoot, path.join(appRoot, 'dist'), {}, verifyAssetClosure, { reserveBytes: DEFAULT_MIN_FREE_BYTES });
        renewLease();
    }
    prepareClientPublicationAssets(appRoot, built.plan.outputs.client, { sourceOid: built.releaseCommit, buildId: built.manifest.clientBuildId }, verifyAssetClosure, { reserveBytes: DEFAULT_MIN_FREE_BYTES });
    renewLease();
}

/** Write and fsync the immutable activation action; from here the seal is handed off. */
function sealActivation(ctx, built) {
    const { renewLease, run } = ctx;
    const manifestSha256 = crypto.createHash('sha256').update(built.manifestRaw).digest('hex');
    if (typeof ctx.queueRestartAction !== 'function') {
        throw new SourceUpdateError('restart_queue_unavailable', 'The governed restart queue is unavailable.', 503);
    }
    const actionFile = path.join(built.candidateRoot, 'activation-action.json');
    // B-1264: the commit of the server process now loaded, which a
    // rollback restores. It can be older than originalHead (the source
    // was advanced without a rebuild), so recovery settles by it.
    let previousRuntimeOid = null;
    try { previousRuntimeOid = ctx.loadedRuntimeCommit(); } catch { previousRuntimeOid = null; }
    // B-1583: built by the same module the strict readers validate with.
    const action = buildSourceUpdateAction({
        transactionId: built.transactionId, originalHead: built.originalHead, targetCommit: built.releaseCommit,
        version: built.version, manifestPath: built.plan.outputs.manifest, manifestSha256,
        expectedServerBuildId: built.manifest.serverBuildId, previousRuntimeOid,
    });
    renewLease();
    const actionFd = fs.openSync(actionFile, 'wx', 0o600);
    try { fs.writeFileSync(actionFd, `${JSON.stringify(action)}\n`); fs.fsyncSync(actionFd); } finally { fs.closeSync(actionFd); }
    const activationIdentitySha256 = crypto.createHash('sha256')
        .update(JSON.stringify(action)).digest('hex');
    const candidateFd = fs.openSync(built.candidateRoot, 'r');
    try { fs.fsyncSync(candidateFd); } finally { fs.closeSync(candidateFd); }
    renewLease();
    run.sealHandedOff = true;
    return { manifestSha256, activationIdentitySha256, previousRuntimeOid };
}

/** Hand the sealed identity to the job (beforeQueue), then persist the restart action. */
async function queueActivation(ctx, built, sealed) {
    const { assertFence, jobIdentity, run } = ctx;
    const { manifest, transactionId, releaseCommit } = built;
    if (typeof jobIdentity.beforeQueue === 'function') {
        jobIdentity.beforeQueue({
            transaction_id: transactionId,
            release_commit: releaseCommit,
            expected_server_build_id: manifest.serverBuildId,
            expected_client_build_id: manifest.clientBuildId,
            activation_identity_sha256: sealed.activationIdentitySha256,
            source_tree_sha256: manifest.sourceProvenance?.treeSha256 || null,
        });
        assertFence();
    }
    assertFence();
    const queued = await ctx.queueRestartAction({
        transactionId, expectedServerBuildId: manifest.serverBuildId,
        sourceUpdateJobId: jobIdentity.jobId || null,
        activationIdentitySha256: sealed.activationIdentitySha256,
        releaseCommit,
        reason: `Activate governed Nassaj release ${built.version}`,
    });
    assertFence();
    if (queued !== true) throw new SourceUpdateError('restart_queue_failed', 'The governed restart action could not be persisted.', 500);
    run.restartQueued = true;
    run.activationEverQueued = true;
    run.queuedBuildId = manifest.serverBuildId;
}

/** The post-build race guard, scoped to the release paths so a file written beside the build does not undo a finished candidate. */
async function assertLiveSourceUnchanged(ctx, built) {
    const liveHead = await ctx.requireGit(['rev-parse', '--verify', 'HEAD^{commit}'], 'head_unavailable', 'verify the live source commit');
    const liveStatus = await ctx.requireGitRaw(['status', '--porcelain=v1', '--untracked-files=all', '-z'], 'git_status_failed', 'verify the live source tree');
    const liveCollisions = conflictingPaths({ ...parsePorcelainStatus(liveStatus), changed: built.releasePaths });
    if (liveHead !== built.originalHead || liveCollisions.length) throw new SourceUpdateError('source_changed', 'The live source changed while staging the update.');
}

/**
 * ADR-207 S1: publish the client generation, seal the activation action, hand
 * it to the job (beforeQueue), queue the governed restart and, once the
 * candidate is persisted, advance the tracking ref (B-1625).
 *
 * Candidate ownership on failure: this function's catch runs
 * removeFailedCandidate(): a queued action is withdrawn and a non-persisted
 * candidate is removed with its worktree, `dirname(stagePath)` and plan; on an
 * aborted run only a never-sealed candidate is discarded, and a sealed or
 * queued one stays with the activation path.
 */
async function sealAndQueue(ctx, built) {
    try {
        publishClientGeneration(ctx, built);
        const sealed = sealActivation(ctx, built);
        await queueActivation(ctx, built, sealed);
        await assertLiveSourceUnchanged(ctx, built);
        ctx.run.candidatePersisted = true;
        await advanceRemoteTrackingRef({ git: ctx.git, remote: ctx.remote, branch: ctx.branch, fetchedRef: ctx.run.branchRef, log: ctx.onOutput });
        return {
            success: true, version: built.version, commit: built.releaseCommit,
            restartRequired: true, restartActionQueued: true,
            transactionId: built.transactionId, candidateManifestSha256: sealed.manifestSha256,
            expectedServerBuildId: built.manifest.serverBuildId,
            expectedClientBuildId: built.manifest.clientBuildId,
            activationIdentitySha256: sealed.activationIdentitySha256,
            // B-1603: recorded in the job's receipts so boot can still
            // judge the job if its action file is later lost.
            originalHead: built.originalHead, previousRuntimeOid: sealed.previousRuntimeOid,
        };
    } catch (error) {
        await removeFailedCandidate(ctx);
        throw error;
    }
}

/**
 * Release the waiter of a run that failed before any activation was queued (B-1585).
 *
 * The exclusion list matches `error.code` ONLY, deliberately not
 * `error.code ?? error.message` (T-2024 qa S3 condition 4). The list mirrors
 * the deferrable codes of scripts/lib/local-update-control.mjs; only a refusal
 * that sets `code` keeps the waiter. The gate's raw flock rejection carries `update_lock_contended` only as its
 * MESSAGE, and today that contention fails the waiter and the worker fails the
 * job. Normalizing would silently change that terminal outcome into a kept
 * waiter for every code-less error whose message happens to match, which the
 * characterization goldens pin as it is. Changing it is a separate, reviewed
 * behaviour change, not part of the build/seal split.
 */
async function releaseWaiterOnFailure(ctx, error) {
    const { run, jobIdentity, appRoot } = ctx;
    if (run.publicationWaiter && !run.candidatePersisted && !run.activationEverQueued && !run.restartQueued && !jobIdentity.signal?.aborted
        && !['resource_ceiling', 'insufficient_disk', 'update_lock_contended'].includes(error.code)) {
        await failReleaseUpdateWaiter(appRoot, run.publicationWaiter);
    } else if (run.publicationWaiter && jobIdentity.signal?.aborted && !run.sealHandedOff && !run.candidatePersisted
        && !run.activationEverQueued && !run.restartQueued) {
        await failAbandonedWaiter({ appRoot, waiter: run.publicationWaiter, settleLostLease: jobIdentity.settleLostLease });
    }
}

async function dropTemporaryRefs(ctx) {
    const { run } = ctx;
    if (!ctx.jobIdentity.signal?.aborted && run.fetchedTemporaryRefs) {
        try {
            ctx.assertFence();
            await ctx.git(['update-ref', '-d', run.tagRef]).catch(() => undefined);
            await ctx.git(['update-ref', '-d', run.branchRef]).catch(() => undefined);
        } catch { /* a newer fence owns cleanup */ }
    } else if (run.fetchedTemporaryRefs) {
        // B-1585: the refs carry this call's nonce; nobody else uses them.
        await dropPrivateRefs({ commandRunner: ctx.commandRunner, appRoot: ctx.appRoot, gitEnv: ctx.gitEnv,
            refs: [run.tagRef, run.branchRef] });
    }
}

function updateInProgress() {
    return new SourceUpdateError('update_in_progress', 'Another governed update is already running.');
}

/** The updater's resolved dependencies, shared by every run of one updater. */
function createUpdaterDeps(options) {
    return {
        ...options,
        configuredRemoteUrl: resolveReleaseSource(options.env).repositoryUrl,
        // PM2 runs Nassaj with NODE_ENV=production, which makes a plain `npm ci`
        // omit the toolchain required to build the newly fetched source. HUSKY=0
        // also prevents npm's prepare hook from requiring an interactive checkout
        // during a governed host update.
        releaseBuildEnv: releaseBuildEnvironment(options.env),
    };
}

export function createSourceUpdater({
    appRoot,
    activeSessionCount,
    commandRunner = runFile,
    env = process.env,
    remote = env.NASSAJ_UPDATE_REMOTE || 'origin',
    branch = env.NASSAJ_UPDATE_BRANCH || 'main',
    queueRestartAction,
    removeRestartAction,
    statfs = fs.statfsSync,
    stat = fs.statSync,
    exchangeProbe = supportsAtomicExchange,
    sourcePlanner = planSourceManifest,
    loadedRuntimeCommit = () => null,
    yieldPrestage = null,
    prestageAdoption = null,
    builderBuildId = () => null,
    probeRuntime = probeRuntimeIdentity,
    probeNpm = probeNpmIdentity,
} = {}) {
    if (!appRoot || typeof activeSessionCount !== 'function') throw new TypeError('Updater dependencies are required');
    const deps = createUpdaterDeps({
        appRoot, activeSessionCount, commandRunner, env, remote, branch, queueRestartAction, removeRestartAction,
        statfs, stat, exchangeProbe, sourcePlanner, loadedRuntimeCommit,
        prestageAdoption, builderBuildId, probeRuntime, probeNpm,
    });
    /**
     * ADR-207 §3.4 (qa S3 condition 3): the job always wins. A prestage
     * holding the build mutex is aborted and waited for (its discard included)
     * before the job checks the mutex; it never fails as update_in_progress.
     */
    const prestageHoldsMutex = () => typeof yieldPrestage === 'function'
        && buildMutexHolder(appRoot)?.kind === PRESTAGE_BUILD_MUTEX_KIND;
    /** One governed update: click-time checks, buildCandidate(), then sealAndQueue(), under one in-progress slot. */
    return async function updateSource(expectedVersion, jobIdentity = {}) {
        assertLegacyTransitionAllowed();
        const ctx = createUpdateContext(deps, expectedVersion, jobIdentity);
        if (prestageHoldsMutex()) await yieldPrestage();
        if (buildMutexHolder(appRoot)) throw updateInProgress();
        ctx.maintenance = assertUpdateEntry(ctx);
        // ADR-207 §3.3 (qa A2): the shared in-process build mutex, taken in
        // the same synchronous turn as the check above.
        const mutex = tryAcquireBuildMutex(appRoot, { kind: 'source-update', jobId: jobIdentity.jobId ?? null });
        if (!mutex) throw updateInProgress();
        ctx.run = createRunState();
        try {
            const built = await prepareCandidateAtClick(ctx);
            return await sealAndQueue(ctx, built);
        } catch (error) {
            await releaseWaiterOnFailure(ctx, error);
            throw error;
        } finally {
            await dropTemporaryRefs(ctx);
            ctx.run.writerLease?.release();
            mutex.release();
        }
    };
}

/**
 * ADR-207 §3.5 (M8): the identity key of a candidate built for `releaseCommit`
 * by this updater's dependencies. The prestager records it in the slot; S4
 * recomputes it at click and adopts only on an equal digest.
 * @returns {Promise<{key: object, digest: string}>}
 */
async function collectPrestageIdentity(ctx, { releaseCommit, builderBuildId }) {
    const candidateScript = resolveCandidateScript(ctx.appRoot);
    const publicVite = Object.fromEntries(['VITE_IS_PLATFORM', 'VITE_PUBLIC_SOURCE_URL']
        .flatMap((key) => typeof ctx.env[key] === 'string' ? [[key, ctx.env[key]]] : []));
    const packageLockBlob = await ctx.requireGit(['rev-parse', '--verify', `${releaseCommit}:package-lock.json`],
        'release_manifest_unavailable', 'read the release lockfile');
    return buildPrestageIdentityKey({
        releaseCommit,
        sourcePin: { repositoryUrl: ctx.configuredRemoteUrl, remote: ctx.remote, branch: ctx.branch,
            tag: releaseTagForVersion(ctx.expectedVersion) },
        runtime: await ctx.probeRuntime(),
        npm: await ctx.probeNpm({ env: ctx.releaseBuildEnv }),
        builderBuildId,
        buildInputs: {
            candidateScriptSha256: sha256Hex(fs.readFileSync(candidateScript)),
            publicViteSha256: sha256Hex(canonicalJson(publicVite)),
            buildEnvSha256: sha256Hex(canonicalJson(ctx.releaseBuildEnv)),
            packageLockBlob, strategy: 'git-checkout-v2',
        },
    });
}

/**
 * ADR-207 §3.1, §3.3, §3.8 (T-2024 S3): the prestager's builder. It runs the
 * same entry checks as a job (storage, degraded reopen, ssh policy), the same
 * HEAD-independent release identity and the same buildCandidate(), with three
 * differences: its own `update-pre-*` transaction and `refs/nassaj-prestage/`
 * refs fetched with `--refmap=` (B-1625: `origin/<branch>` never moves), the
 * writer-lease kind `source-update-prestage`, and the candidate build (the one
 * `process.execPath` command) run through the effect launcher with this
 * server's parent identity at low priority, its effect identity recorded by
 * `onBuildEffect` BEFORE the launcher's gate opens. It never reads the live
 * HEAD, sessions or waiter, never seals, publishes or queues. The caller holds
 * the build mutex; the writer lease and the private refs are released here.
 *
 * @returns {(input: {
 *   expectedVersion: string, transactionId: string, refPrefix: string, signal?: AbortSignal,
 *   onOutput?: (text: string) => void, builderBuildId: string,
 *   beforeCandidate: (release: {releaseCommit: string, identity: {key: object, digest: string}}) => Promise<void>,
 *   onBuildEffect: (effect: {pid: number, pgid: number, startTicks: string, bootId: string}) => Promise<void>,
 * }) => Promise<Omit<BuiltCandidate, 'originalHead' | 'releasePaths'>>}
 */
export function createPrestageCandidateBuilder({
    appRoot, controlRoot, commandRunner = runFile, env = process.env,
    remote = env.NASSAJ_UPDATE_REMOTE || 'origin', branch = env.NASSAJ_UPDATE_BRANCH || 'main',
    statfs = fs.statfsSync, stat = fs.statSync, exchangeProbe = supportsAtomicExchange,
    loadedRuntimeCommit = () => null, probeRuntime = probeRuntimeIdentity, probeNpm = probeNpmIdentity,
    assertTransition = assertLegacyTransitionAllowed,
} = {}) {
    if (!appRoot || !controlRoot) throw new TypeError('Prestage builder dependencies are required');
    const effectGateRoot = path.join(controlRoot, 'prestage', 'effects');
    return async function buildPrestageCandidate({
        expectedVersion, transactionId, refPrefix, signal, onOutput, builderBuildId, beforeCandidate, onBuildEffect,
    }) {
        // S4 qa condition (c): the same legacy-transition gate as updateSource(),
        // before anything is fetched or built.
        assertTransition();
        const runner = (command, args, options = {}) => (command === process.execPath
            ? commandRunner(command, args, { ...options, effectGateRoot, lowPriority: true, onSpawn: (effect) => onBuildEffect(effect) })
            : commandRunner(command, args, options));
        const deps = createUpdaterDeps({
            appRoot, activeSessionCount: () => 0, commandRunner: runner, env, remote, branch,
            statfs, stat, exchangeProbe, loadedRuntimeCommit, probeRuntime, probeNpm,
        });
        const ctx = createUpdateContext(deps, expectedVersion, { signal, onOutput });
        ctx.maintenance = assertUpdateEntry(ctx);
        ctx.run = createRunState({ transactionId, refPrefix, leaseKind: 'source-update-prestage', emptyRefmap: true });
        try {
            const release = await resolveReleaseIdentity(ctx, { runtimeRemote: await verifyReleaseRemote(ctx) });
            const identity = await collectPrestageIdentity(ctx, { releaseCommit: release.releaseCommit, builderBuildId });
            await beforeCandidate({ releaseCommit: release.releaseCommit, identity });
            return await buildCandidate(ctx, release);
        } finally {
            await dropTemporaryRefs(ctx);
            ctx.run.writerLease?.release();
        }
    };
}

// ---------------------------------------------------------------------------
// ADR-207 §3.4, §3.5 (T-2024 S4): adoption of a prestaged candidate at click
// ---------------------------------------------------------------------------

const ADOPTION_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TREE_HASHER = fileURLToPath(new URL('./update-prestage-tree-hasher.js', import.meta.url));

function adoptionFailure(code) {
    return Object.assign(new Error(code), { code, adoption: true });
}

/** The prestager's adoption port for this run, or null when adoption cannot apply (no durable job id). */
function prestagePort(ctx) {
    const jobId = ctx.jobIdentity.jobId;
    if (typeof ctx.prestageAdoption !== 'function' || typeof jobId !== 'string' || !ADOPTION_JOB_ID.test(jobId)) return null;
    try { return ctx.prestageAdoption() ?? null; } catch { return null; }
}

/** One `staging/done` receipt with the prestage outcome (ADR-207 §3.5 steps 5, 6), and a log line. */
function recordPrestageOutcome(ctx, facts, line) {
    ctx.onOutput?.(`prestage: ${line}\n`);
    if (typeof ctx.jobIdentity.receipt === 'function') ctx.jobIdentity.receipt('staging', 'done', facts);
}

/**
 * A failure while adopting is a reason to build, never to fail the job,
 * except a lost fence or an aborted run: those propagate as they would from
 * any other step (assertFence throws again for a lost fence).
 */
function adoptionFailureReason(ctx, error) {
    ctx.assertFence();
    if (ctx.jobIdentity.signal?.aborted) throw error;
    if (error?.adoption) return error.code;
    if (error?.code === 'ENOENT') return 'candidate_missing';
    return typeof error?.code === 'string' && /^[a-z0-9_]{1,48}$/.test(error.code) ? error.code : 'verification_failed';
}

/**
 * Discard the slot through the prestager and WAIT for it (qa condition a: the
 * disk is free before buildCandidate()); a discard that cannot finish is
 * logged and the job builds anyway. Always resolves null (= build).
 * `details` are extra receipt facts (e.g. the full identity field list).
 */
async function rejectPrestage(ctx, port, reason, details = {}) {
    recordPrestageOutcome(ctx, { prestage: 'rejected', reason, ...details }, `not adopted (${reason}); building`);
    try {
        const outcome = await port.discard({ jobId: ctx.jobIdentity.jobId, reason });
        if (!outcome?.discarded) ctx.onOutput?.(`prestage: slot kept (${outcome?.reason ?? 'unknown'})\n`);
    } catch (error) {
        ctx.onOutput?.(`prestage: discard deferred (${typeof error?.code === 'string' ? error.code : 'error'})\n`);
    }
    ctx.assertFence();
    return null;
}

/** The candidate's plan file, required to be exactly the plan this transaction was built from. */
function readAdoptedPlan(ctx, { transactionId, releaseCommit, candidateRoot, stagePath, planPath }) {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    if (plan?.schemaVersion !== 1 || plan.txId !== transactionId || plan.releaseCommit !== releaseCommit
        || plan.version !== ctx.expectedVersion || plan.candidateRoot !== candidateRoot || plan.sourceRoot !== stagePath
        || canonicalJson(plan.outputs) !== canonicalJson(candidatePlanOutputs(candidateRoot))) {
        throw adoptionFailure('plan_mismatch');
    }
    return plan;
}

/** ADR-207 §3.5 step 2: the worktree is still the release commit, with nothing changed in it. */
async function verifyAdoptedWorktree(ctx, { stagePath, releaseCommit }) {
    const env = { ...ctx.gitEnv, GIT_OPTIONAL_LOCKS: '0' };
    const head = await ctx.guardedRun('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: stagePath, env });
    if (head.code !== 0 || head.stdout.trim() !== releaseCommit) throw adoptionFailure('worktree_head_mismatch');
    const status = await ctx.guardedRun('git', ['-c', 'core.hooksPath=/dev/null', 'status', '--porcelain=v1', '--untracked-files=all', '-z'],
        { cwd: stagePath, env });
    if (status.code !== 0 || status.stdout !== '') throw adoptionFailure('worktree_dirty');
}

/** ADR-207 §3.5 step 3: the manifest bytes, read ONCE, are the bytes validated, compared and later sealed. */
function readAdoptedManifest(ctx, plan, slot) {
    const metadata = fs.lstatSync(plan.outputs.manifest);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw adoptionFailure('manifest_unsafe');
    const { manifest, manifestRaw } = readCandidateManifest(ctx, plan,
        { transactionId: slot.transactionId, releaseCommit: slot.target.releaseCommit });
    if (sha256Hex(manifestRaw) !== slot.outputs.manifestSha256) throw adoptionFailure('manifest_changed');
    const recorded = TREE_NAMES.every((name) => /^[0-9a-f]{64}$/.test(manifest.trees?.[name]?.sha256 || '')
        && Number.isSafeInteger(manifest.trees[name].files) && manifest.trees[name].sha256 === slot.outputs.trees[name]);
    if (!recorded) throw adoptionFailure('manifest_trees_invalid');
    return { manifest, manifestRaw };
}

/**
 * ADR-207 §3.5 step 4 (M1, qa 2.1): hash the three trees in a child process
 * (update-prestage-tree-hasher.js) through the guarded runner — fenced and,
 * for a durable job, a registered effect — so the ≈1.3 GB synchronous read
 * never runs on the server's event loop. The lease is renewed around it.
 */
async function verifyAdoptedTrees(ctx, plan, manifest) {
    ctx.renewLease();
    const input = Object.fromEntries(TREE_NAMES.map((name) => [name, plan.outputs[name]]));
    const result = await ctx.guardedRun(process.execPath, [TREE_HASHER, JSON.stringify(input)], { cwd: ctx.appRoot, env: {} });
    ctx.renewLease();
    let hashed;
    try { hashed = result.code === 0 ? JSON.parse(result.stdout) : null; } catch { hashed = null; }
    if (!hashed) throw adoptionFailure('tree_hash_failed');
    for (const name of TREE_NAMES) {
        if (hashed[name]?.sha256 !== manifest.trees[name].sha256 || hashed[name]?.files !== manifest.trees[name].files) {
            throw adoptionFailure('tree_hash_mismatch');
        }
    }
}

/**
 * Verify an adopted slot's candidate (§3.5 steps 2–4) and compose the
 * BuiltCandidate sealAndQueue() takes, minus the click-time facts that
 * prepareCandidateAtClick() merges in. The transaction is the SLOT's
 * (`manifest.txId` is bound to it); the job's own nonce names only its refs.
 */
async function verifyAdoptedCandidate(ctx, slot) {
    const { transactionId } = slot;
    const { releaseCommit } = slot.target;
    const candidateRoot = path.join(ctx.maintenance.paths.controlRoot, 'candidates', transactionId);
    const paths = { transactionId, releaseCommit, candidateRoot, stagePath: path.join(candidateRoot, 'source'),
        planPath: path.join(ctx.maintenance.paths.controlRoot, `plan-${transactionId}.json`) };
    const plan = readAdoptedPlan(ctx, paths);
    await verifyAdoptedWorktree(ctx, paths);
    ctx.renewLease();
    const { manifest, manifestRaw } = readAdoptedManifest(ctx, plan, slot);
    await verifyAdoptedTrees(ctx, plan, manifest);
    return { ...paths, plan, manifest, manifestRaw };
}

/**
 * ADR-207 §3.4, §3.5 (T-2024 S4): adopt the prestaged candidate at the
 * adopt-or-build point, or return null so the job builds as today.
 *
 * Only a `ready` slot for exactly this release is a candidate. Its identity
 * key is recomputed now (child runtime probe from `process.execPath`, npm,
 * running builder build id, build inputs, release commit and pin) and the CAS
 * `ready → adopted:<jobId>` under the slot flock accepts only an equal digest.
 * The adopted candidate is then verified (worktree, plan, manifest bytes read
 * once, tree hashes off the event loop) outside the flock: the `adopted`
 * marker already keeps every other actor off it. Any mismatch or failure
 * discards the slot through the prestager, waits for it, and returns null.
 *
 * Ownership after a successful adoption (M7): the run takes the slot's
 * transaction, worktree and plan, so sealAndQueue()'s removeFailedCandidate()
 * owns the candidate exactly as if this job had built it. The slot keeps
 * `adopted:<jobId>` until the job row carries the transaction or the job ends;
 * the prestager's per-cycle recovery then removes the marker (never the
 * candidate). A crash between the CAS and the seal leaves the marker on a job
 * with no transaction: kept until that job is terminal, then released, and
 * the unnamed candidate goes in the next orphan sweep.
 * @returns {Promise<Omit<BuiltCandidate, 'originalHead' | 'releasePaths'> | null>}
 */
async function adoptPrestagedCandidate(ctx, { releaseCommit }) {
    const port = prestagePort(ctx);
    const snapshot = port?.slot.read();
    if (!snapshot || snapshot.corrupt || snapshot.state !== 'ready') return null;
    if (snapshot.target.version !== ctx.expectedVersion) return rejectPrestage(ctx, port, 'other_version');
    if (snapshot.target.releaseCommit !== releaseCommit) return rejectPrestage(ctx, port, 'tag_moved');
    if (!port.adoptable()) return rejectPrestage(ctx, port, 'adoption_disabled');
    // qa S4 improvement 1: the three rejections above run BEFORE the writer
    // lease (admitCandidateHost) on purpose. Their discard touches only the
    // prestage slot and its own `update-pre-*` candidate, never the live tree:
    // it runs under the slot flock and this job's build mutex (discardForJob
    // takes {jobId}), which is the exclusion the slot needs. Taking the lease
    // first would only delay the fallback build that takes it anyway.
    const jobId = ctx.jobIdentity.jobId;
    // The lease and host gates refuse exactly as before a build; the slot stays for a retry.
    await admitCandidateHost(ctx);
    let adopted;
    try {
        const identity = await collectPrestageIdentity(ctx, { releaseCommit, builderBuildId: ctx.builderBuildId() });
        if (identity.digest !== snapshot.keyDigest) {
            // qa S4 improvements 2, 3: the reason stays a bounded code; the
            // full field list goes to the receipt and the job log, untruncated.
            const fields = diffPrestageIdentity(snapshot.identity, identity.key);
            ctx.onOutput?.(`prestage: identity mismatch in ${fields.join(', ') || 'unknown fields'}\n`);
            return rejectPrestage(ctx, port, `identity_mismatch:${fields.join(',')}`.slice(0, 64), { fields });
        }
        adopted = await port.slot.adopt(snapshot, { jobId, keyDigest: identity.digest });
    } catch (error) {
        const reason = adoptionFailureReason(ctx, error);
        // A slot changed under us is no longer the one judged here: leave it to recovery.
        if (reason === 'prestage_slot_conflict') {
            recordPrestageOutcome(ctx, { prestage: 'rejected', reason }, 'slot changed; building');
            return null;
        }
        return rejectPrestage(ctx, port, reason);
    }
    try {
        const built = await verifyAdoptedCandidate(ctx, adopted);
        Object.assign(ctx.run, { transactionId: built.transactionId, stagePath: built.stagePath, planPath: built.planPath });
        recordPrestageOutcome(ctx, { prestage: 'adopted', slotId: adopted.slotId, keyDigest: adopted.keyDigest,
            builtAt: adopted.readyAt }, `adopted the candidate prepared at ${adopted.readyAt}`);
        try { port.onAdopted?.({ jobId, version: ctx.expectedVersion }); } catch { /* status only */ }
        const { transactionId, candidateRoot, plan, manifest, manifestRaw } = built;
        return { transactionId, candidateRoot, releaseCommit, version: ctx.expectedVersion, plan, manifest, manifestRaw };
    } catch (error) {
        return rejectPrestage(ctx, port, adoptionFailureReason(ctx, error));
    }
}

export function sourceUpdateErrorPayload(error) {
    if (error instanceof SourceUpdateError) {
        return { status: error.status, body: { success: false, code: error.code, error: error.message, ...error.details } };
    }
    return { status: 500, body: { success: false, code: 'update_failed', error: 'The governed update failed.' } };
}

/** Test seams (ADR-207 §6 parity and HEAD-independence tests); not a public API. */
export const __test__ = Object.freeze({
    createUpdaterDeps, createUpdateContext, createRunState, assertUpdateEntry, buildCandidate, collectPrestageIdentity,
    TREE_HASHER,
});
