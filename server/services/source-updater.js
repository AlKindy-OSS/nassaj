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
import { supportsAtomicExchange } from '../../scripts/lib/atomic-exchange-capability.mjs';
import { prepareClientPublicationAssets } from '../../scripts/lib/client-publication-archive.mjs';
import { verifyAssetClosure } from '../../scripts/lib/client-publication-artifacts.mjs';
import { reserveFullUpdateWaiter, failReleaseUpdateWaiter } from '../../scripts/lib/client-publication-control.mjs';
import { UPDATE_RUNTIME_CAPABILITY } from '../../scripts/lib/update-runtime-bundle.mjs';

import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';
import { normalizeGitHubRepositoryIdentity, resolveReleaseSource } from './release-source-config.js';

const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_BRANCH = /^(?![-.])(?!.*(?:\.\.|\/\.|\.\/|\/\/))[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
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

/**
 * Evaluate the pre-flight storage state without throwing (ADR-141, T-1553).
 * Returns `{ ok: true }` or `{ ok: false, code, message, status }` so both the
 * update job and /health can surface the same actionable blocker.
 */
export function evaluateUpdateStorage({ appRoot, env, statfs = fs.statfsSync, stat = fs.statSync }) {
    const blocked = (code) => ({ ok: false, code, ...STORAGE_BLOCKERS[code] });
    const minFreeBytes = positiveIntegerEnv(env.NASSAJ_UPDATE_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES);
    const controlRoot = env.NASSAJ_UPDATE_CONTROL_ROOT
        ? path.resolve(env.NASSAJ_UPDATE_CONTROL_ROOT)
        : path.join(appRoot, '.git', 'nassaj-source-update');
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
        if ([...devices.values()].some(device => device.available < device.required)) return blocked('insufficient_disk');
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
    const controlRoot = path.resolve(env.NASSAJ_UPDATE_CONTROL_ROOT || path.join(appRoot, '.git', 'nassaj-source-update'));
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
        child.once('spawn', () => {
            if (typeof options.onSpawn !== 'function') return;
            try {
                const identity = childProcessIdentity(child.pid);
                if (!identity) {
                    throw new Error('source_update_effect_identity_unavailable');
                }
                options.onSpawn(identity);
                const fd = fs.openSync(gatePath, 'wx', 0o600);
                try { fs.writeFileSync(fd, 'go\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                const dirFd = fs.openSync(options.effectGateRoot, 'r');
                try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
            } catch (error) {
                registrationFailed = true;
                abort();
                reject(error);
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
} = {}) {
    if (!appRoot || typeof activeSessionCount !== 'function') throw new TypeError('Updater dependencies are required');
    let updateRunning = false;
    const configuredRemoteUrl = resolveReleaseSource(env).repositoryUrl;

    // PM2 runs Nassaj with NODE_ENV=production, which makes a plain `npm ci`
    // omit the toolchain required to build the newly fetched source. HUSKY=0
    // also prevents npm's prepare hook from requiring an interactive checkout
    // during a governed host update.
    const releaseBuildEnv = releaseBuildEnvironment(env);
    const requireNoActiveSessions = () => {
        let sessions;
        try { sessions = activeSessionCount(); } catch { throw new SourceUpdateError('session_state_unavailable', 'Active session state is unavailable.'); }
        if (!Number.isSafeInteger(sessions) || sessions < 0) throw new SourceUpdateError('session_state_unavailable', 'Active session state is unavailable.');
        if (sessions > 0) throw new SourceUpdateError('active_sessions', 'Finish all active agent sessions before updating.');
    };
    return async function updateSource(expectedVersion, jobIdentity = {}) {
        assertLegacyTransitionAllowed();
        // Resolved per update: core.sshCommand may change between two updates.
        const ssh = resolveGovernedSshCommand({ env, appRoot });
        const gitEnv = { ...releaseGitEnvironment(env), GIT_SSH_COMMAND: ssh.command };
        const assertFence = typeof jobIdentity.assertFence === 'function' ? jobIdentity.assertFence : () => true;
        // T-1768: each command and its output go to the job's live log.
        const onOutput = typeof jobIdentity.onOutput === 'function' ? jobIdentity.onOutput : undefined;
        const guardedRun = async (command, args, options = {}) => {
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
        const git = (args, commandEnv = gitEnv) => guardedRun('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: appRoot, env: commandEnv });
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
        if (updateRunning) throw new SourceUpdateError('update_in_progress', 'Another governed update is already running.');
        if (!isNassajReleaseVersion(expectedVersion)) {
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

        updateRunning = true;
        const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const tagRef = `refs/nassaj-update/${nonce}/tag`;
        const branchRef = `refs/nassaj-update/${nonce}/branch`;
        let fetchedTemporaryRefs = false;
        let writerLease = null;
        let publicationWaiter = null;
        let stagePath = null;
        let planPath = null;
        let candidatePersisted = false;
        let restartQueued = false;
        let activationEverQueued = false;
        let queuedBuildId = null;
        try {
            requireNoActiveSessions();

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

            const remoteUrls = (await requireGit(['remote', 'get-url', '--all', remote], 'remote_unavailable', 'verify the configured remote')).split('\n').filter(Boolean);
            if (remoteUrls.length !== 1) throw new SourceUpdateError('ambiguous_remote', 'The update remote must have exactly one URL.');
            const runtimeRemote = normalizeGitHubRemote(remoteUrls[0]);
            if (!runtimeRemote) throw new SourceUpdateError('unsafe_remote', 'The update remote must be a credential-free GitHub HTTPS or SSH URL.');
            if (normalizeGitHubRemote(configuredRemoteUrl) !== runtimeRemote) {
                throw new SourceUpdateError('remote_mismatch', 'The runtime Git remote does not match the configured release source.');
            }
            let fetchEnv = gitEnv;

            const tag = releaseTagForVersion(expectedVersion);
            await requireGit(['fetch', '--no-tags', remote, `refs/tags/${tag}:${tagRef}`, `refs/heads/${branch}:${branchRef}`], 'release_fetch_failed', 'fetch the exact release', fetchEnv);
            fetchedTemporaryRefs = true;
            const remoteAfterFetch = normalizeGitHubRemote(await requireGit(['remote', 'get-url', remote], 'remote_unavailable', 're-verify the configured remote'));
            if (remoteAfterFetch !== runtimeRemote) throw new SourceUpdateError('remote_changed', 'The update remote changed during the update.');

            const releaseCommit = await requireGit(['rev-parse', '--verify', `${tagRef}^{commit}`], 'tag_mismatch', 'resolve the release tag');
            const onReleaseBranch = await git(['merge-base', '--is-ancestor', releaseCommit, branchRef]);
            if (onReleaseBranch.code !== 0) throw new SourceUpdateError('tag_mismatch', 'The release tag is not part of the configured release branch.');
            const fastForward = await git(['merge-base', '--is-ancestor', originalHead, releaseCommit]);
            if (fastForward.code !== 0) {
                let divergence = null;
                try { divergence = await computeLocalDivergence({ git, originalHead, releaseCommit }); } catch { divergence = null; }
                throw new SourceUpdateError('non_fast_forward', 'The requested release is not a fast-forward update.',
                    409, divergence ? { divergence } : {});
            }

            const packageText = await requireGit(['show', `${releaseCommit}:package.json`], 'release_manifest_unavailable', 'read the release manifest');
            let releaseManifest;
            try { releaseManifest = JSON.parse(packageText); } catch { throw new SourceUpdateError('release_manifest_invalid', 'The release package manifest is invalid.'); }
            if (releaseManifest.version !== expectedVersion) throw new SourceUpdateError('tag_version_mismatch', 'The release tag and package version do not match.');

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

            requireNoActiveSessions();
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
            try {
                sourcePlanner({ projectRoot: appRoot, originalHead, targetCommit: releaseCommit });
            } catch (error) {
                const detail = String(error?.message || 'unknown').replace(/^Source activation /, '').slice(0, 300);
                throw new SourceUpdateError('source_plan_conflict',
                    `The source tree cannot take this release without overwriting local files (${detail}). Move that path aside, then retry.`, 409);
            }

            assertFence();
            publicationWaiter = await reserveFullUpdateWaiter(appRoot, { requestId: `release-update:${jobIdentity.jobId || nonce}`,
                ownerId: jobIdentity.ownerId ?? 'release-button', sourceOid: releaseCommit });
            writerLease = await maintenance.acquireWriterLease({ kind: 'source-update-stage' });
            assertFence();
            const transactionId = `update-${nonce}`;
            const candidatesRoot = path.join(maintenance.paths.controlRoot, 'candidates');
            assertFence();
            fs.mkdirSync(candidatesRoot, { recursive: true, mode: 0o700 });
            const candidateRoot = path.join(candidatesRoot, transactionId);
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
            if (exchangeProbe() !== true) {
                throw new SourceUpdateError('exchange_capability',
                    'This host lacks mv --exchange --no-copy, which activation requires with no fallback. Install GNU coreutils 9 or newer.', 409);
            }
            assertFence();
            fs.mkdirSync(candidateRoot, { mode: 0o700 });
            assertFence();

            stagePath = path.join(candidateRoot, 'source');
            try {
                await requireGit(['worktree', 'add', '--detach', stagePath, releaseCommit], 'candidate_checkout_failed', 'stage the exact release');
                planPath = path.join(maintenance.paths.controlRoot, `plan-${transactionId}.json`);
                const plan = {
                    schemaVersion: 1, txId: transactionId, sourceRoot: stagePath, candidateRoot,
                    releaseCommit, version: expectedVersion,
                    publicVite: Object.fromEntries(
                        ['VITE_IS_PLATFORM', 'VITE_PUBLIC_SOURCE_URL']
                            .flatMap((key) => typeof env[key] === 'string' ? [[key, env[key]]] : []),
                    ),
                    outputs: {
                        client: path.join(candidateRoot, 'client'), server: path.join(candidateRoot, 'server'),
                        nodeModules: path.join(candidateRoot, 'node_modules'),
                        manifest: path.join(candidateRoot, 'candidate-manifest.json'),
                    },
                };
                assertFence();
                fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { flag: 'wx', mode: 0o600 });
                assertFence();
                const staged = await guardedRun(process.execPath, [
                    resolveCandidateScript(appRoot), '--plan', planPath,
                ], { cwd: appRoot, env: releaseBuildEnv });
                if (staged.code !== 0) throw commandFailure('candidate_build_failed', 'build the release candidate');
                const stageHead = await guardedRun('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: stagePath, env: gitEnv });
                if (stageHead.code !== 0 || stageHead.stdout.trim() !== releaseCommit) {
                    throw new SourceUpdateError('candidate_identity_mismatch', 'The staged candidate does not match the requested release.');
                }
                const manifestRaw = fs.readFileSync(plan.outputs.manifest);
                const manifest = JSON.parse(manifestRaw);
                if (manifest?.schemaVersion !== 1 || manifest.txId !== transactionId
                    || manifest.releaseCommit !== releaseCommit || manifest.version !== expectedVersion
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
                if (fs.existsSync(path.join(plan.outputs.client, 'CLIENT_ASSET_MANIFEST.json'))) {
                    if (fs.existsSync(path.join(appRoot, 'dist/CLIENT_ASSET_MANIFEST.json'))) prepareClientPublicationAssets(appRoot, path.join(appRoot, 'dist'), {}, verifyAssetClosure, { reserveBytes: DEFAULT_MIN_FREE_BYTES });
                    prepareClientPublicationAssets(appRoot, plan.outputs.client, { sourceOid: releaseCommit, buildId: manifest.clientBuildId }, verifyAssetClosure, { reserveBytes: DEFAULT_MIN_FREE_BYTES });
                }
                const manifestSha256 = crypto.createHash('sha256').update(manifestRaw).digest('hex');
                if (typeof queueRestartAction !== 'function') {
                    throw new SourceUpdateError('restart_queue_unavailable', 'The governed restart queue is unavailable.', 503);
                }
                const actionFile = path.join(candidateRoot, 'activation-action.json');
                const action = {
                    schema: 'nassaj-source-update-activation/v1', transactionId,
                    originalHead, targetCommit: releaseCommit, version: expectedVersion,
                    manifestPath: plan.outputs.manifest, manifestSha256,
                    expectedServerBuildId: manifest.serverBuildId,
                };
                assertFence();
                const actionFd = fs.openSync(actionFile, 'wx', 0o600);
                try { fs.writeFileSync(actionFd, `${JSON.stringify(action)}\n`); fs.fsyncSync(actionFd); } finally { fs.closeSync(actionFd); }
                const activationIdentitySha256 = crypto.createHash('sha256')
                    .update(JSON.stringify(action)).digest('hex');
                const candidateFd = fs.openSync(candidateRoot, 'r');
                try { fs.fsyncSync(candidateFd); } finally { fs.closeSync(candidateFd); }
                assertFence();
                if (typeof jobIdentity.beforeQueue === 'function') {
                    jobIdentity.beforeQueue({
                        transaction_id: transactionId,
                        release_commit: releaseCommit,
                        expected_server_build_id: manifest.serverBuildId,
                        expected_client_build_id: manifest.clientBuildId,
                        activation_identity_sha256: activationIdentitySha256,
                        source_tree_sha256: manifest.sourceProvenance?.treeSha256 || null,
                    });
                    assertFence();
                }
                assertFence();
                const queued = await queueRestartAction({
                    transactionId, expectedServerBuildId: manifest.serverBuildId,
                    sourceUpdateJobId: jobIdentity.jobId || null,
                    activationIdentitySha256,
                    releaseCommit,
                    reason: `Activate governed Nassaj release ${expectedVersion}`,
                });
                assertFence();
                if (queued !== true) throw new SourceUpdateError('restart_queue_failed', 'The governed restart action could not be persisted.', 500);
                restartQueued = true;
                activationEverQueued = true;
                queuedBuildId = manifest.serverBuildId;
                const liveHead = await requireGit(['rev-parse', '--verify', 'HEAD^{commit}'], 'head_unavailable', 'verify the live source commit');
                const liveStatus = await requireGitRaw(['status', '--porcelain=v1', '--untracked-files=all', '-z'], 'git_status_failed', 'verify the live source tree');
                // The post-build race guard, scoped to the same release paths so a
                // file written beside the build does not undo a finished candidate.
                const liveCollisions = conflictingPaths({ ...parsePorcelainStatus(liveStatus), changed: releasePaths });
                if (liveHead !== originalHead || liveCollisions.length) throw new SourceUpdateError('source_changed', 'The live source changed while staging the update.');
                candidatePersisted = true;
                return {
                    success: true, version: expectedVersion, commit: releaseCommit,
                    restartRequired: true, restartActionQueued: true,
                    transactionId, candidateManifestSha256: manifestSha256,
                    expectedServerBuildId: manifest.serverBuildId,
                    expectedClientBuildId: manifest.clientBuildId,
                    activationIdentitySha256,
                };
            } catch (error) {
                if (!jobIdentity.signal?.aborted && restartQueued && typeof removeRestartAction === 'function') {
                    assertFence();
                    await removeRestartAction({ expectedServerBuildId: queuedBuildId, transactionId }).catch(() => undefined);
                    restartQueued = false;
                }
                if (!jobIdentity.signal?.aborted && !candidatePersisted && stagePath) {
                    assertFence();
                    await git(['worktree', 'remove', '--force', stagePath]).catch(() => undefined);
                    fs.rmSync(path.dirname(stagePath), { recursive: true, force: true });
                    if (planPath) fs.rmSync(planPath, { force: true });
                }
                throw error;
            }
        } catch (error) {
            if (publicationWaiter && !candidatePersisted && !activationEverQueued && !restartQueued && !jobIdentity.signal?.aborted
                && !['resource_ceiling', 'insufficient_disk', 'update_lock_contended'].includes(error.code)) {
                await failReleaseUpdateWaiter(appRoot, publicationWaiter);
            }
            throw error;
        } finally {
            if (!jobIdentity.signal?.aborted && fetchedTemporaryRefs) {
                try {
                    assertFence();
                    await git(['update-ref', '-d', tagRef]).catch(() => undefined);
                    await git(['update-ref', '-d', branchRef]).catch(() => undefined);
                } catch { /* a newer fence owns cleanup */ }
            }
            writerLease?.release();
            updateRunning = false;
        }
    };
}

export function sourceUpdateErrorPayload(error) {
    if (error instanceof SourceUpdateError) {
        return { status: error.status, body: { success: false, code: error.code, error: error.message, ...error.details } };
    }
    return { status: 500, body: { success: false, code: 'update_failed', error: 'The governed update failed.' } };
}
