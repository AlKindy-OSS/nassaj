#!/usr/bin/env node
/** Verify immutable OID control bytes, then launch the detached supervisor. */
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
    closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
    readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assertContainedParents(root, file, label) {
    const canonicalRoot = realpathSync(root);
    const target = path.resolve(file);
    if (target === canonicalRoot || !target.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error(`${label}_escapes_root`);
    }
    let cursor = canonicalRoot;
    for (const segment of path.relative(canonicalRoot, path.dirname(target)).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const metadata = lstatSync(cursor);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}_parent_unsafe`);
    }
}

export function pinnedBytes(root, file, expected, label) {
    assertContainedParents(root, file, label);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size !== expected.size || (before.mode & 0o777) !== expected.mode) {
            throw new Error(`${label}_metadata_mismatch`);
        }
        const bytes = readFileSync(fd);
        const after = fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.ctimeMs !== after.ctimeMs || sha(bytes) !== expected.sha256) {
            throw new Error(`${label}_content_mismatch`);
        }
        return bytes;
    } finally { closeSync(fd); }
}

function readLoadedManifest(liveRoot) {
    const file = path.join(liveRoot, 'OID_CONTROL_MANIFEST.json');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('control_manifest_unsafe');
    const bytes = pinnedBytes(liveRoot, file, {
        size: metadata.size, mode: 0o444, sha256: sha(readFileSync(file)),
    }, 'control_manifest');
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.schema !== 'nassaj-oid-control-runtime/v1' || manifest.protocol !== 1
        || manifest.launcherAbi !== 'nassaj-oid-launcher/v1'
        || manifest.capsuleModeAbi !== 'nassaj-capsule-roots/v1') throw new Error('control_manifest_identity_mismatch');
    return manifest;
}

export function parseProcessStartTicks(raw) {
    if (typeof raw !== 'string') return null;
    const commandEnd = raw.lastIndexOf(')');
    if (commandEnd < 2) return null;
    const fields = raw.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    return /^\d+$/.test(startTicks || '') ? startTicks : null;
}

function processStartTicks(pid) {
    try { return parseProcessStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; }
}

/** Immutable capsule launcher cannot import mutable source; resolve common dir in-place. */
function commonGitDir(root) {
    const entry = lstatSync(path.join(root, '.git'));
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('oid_git_control_entry_unsafe');
    const result = spawnSync('/usr/bin/git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('oid_event_lock_git_common_dir_failed');
    const reported = String(result.stdout || '').trim();
    if (!path.isAbsolute(reported)) throw new Error('oid_event_lock_git_common_dir_relative');
    const metadata = lstatSync(reported);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('oid_event_lock_git_common_dir_unsafe');
    const resolved = realpathSync(reported);
    if (resolved !== path.resolve(reported)) throw new Error('oid_event_lock_git_common_dir_redirected');
    return resolved;
}

function controlPath(root, name) {
    if (!/^nassaj-[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(name) || name.includes('..')) {
        throw new Error('oid_control_filename_unsafe');
    }
    return path.join(commonGitDir(root), name);
}

function recoveryDirectory(directory, create = false) {
    if (create) { try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(directory) !== directory
        || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700) throw new Error('oid_recovery_directory_unsafe');
}

function recoverySync(directory) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

function recoveryWrite(directory, name, bytes) {
    const fd = openSync(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    return { name, sha256: sha(bytes), size: bytes.length, mode: 0o600 };
}

/** Hash executable bytes independently of transaction records and later authority documents. */
export function oidExecutorCodeClosure({ manifestBytes, capsule, safeRestart, launcher, externalRuntimeClosures = [] }) {
    if (!Array.isArray(externalRuntimeClosures)) throw new Error('oid_code_closure_runtime_invalid');
    const external = externalRuntimeClosures.map(value => {
        if (!value || Object.keys(value).sort().join(',') !== 'kind,sha256'
            || !['node', 'python-peer-reader', 'pm2-package'].includes(value.kind)
            || !/^[a-f0-9]{64}$/.test(value.sha256 || '')) throw new Error('oid_code_closure_runtime_invalid');
        return { kind: value.kind, sha256: value.sha256 };
    }).sort((a, b) => a.kind.localeCompare(b.kind));
    if (new Set(external.map(value => value.kind)).size !== external.length) throw new Error('oid_code_closure_runtime_duplicate');
    const files = [['launcher.mjs', launcher], ['capsule.mjs', capsule], ['safe-restart.sh', safeRestart],
        ['control-manifest.json', manifestBytes]].map(([name, bytes]) => {
        if (!Buffer.isBuffer(bytes)) throw new Error('oid_code_closure_bytes_invalid');
        return { name, sha256: sha(bytes), size: bytes.length };
    });
    const descriptor = { schema: 'nassaj-oid-executor-code-closure/v1', files, externalRuntimeClosures: external };
    return { descriptor, sha256: sha(Buffer.from(JSON.stringify(descriptor))) };
}

/** Hash bootstrap executable bytes before transaction data; runtime inventory still needs independent verification. */
export function bootstrapExecutableClosure(input) {
    if (!input || Object.keys(input).sort().join(',') !== 'capsule,externalRuntimeClosures,launcher,manifestBytes,safeRestart') {
        throw new Error('bootstrap_code_closure_inputs_invalid');
    }
    const ordinary = oidExecutorCodeClosure(input);
    const externalRuntimeClosures = ordinary.descriptor.externalRuntimeClosures;
    if (externalRuntimeClosures.map(value => value.kind).join(',') !== 'node,pm2-package,python-peer-reader') {
        throw new Error('bootstrap_code_closure_runtime_incomplete');
    }
    const descriptor = { schema: 'nassaj-bootstrap-executable-closure/v1',
        files: ordinary.descriptor.files.map(file => ({ ...file, mode: 0o600 }))
            .sort((left, right) => left.name.localeCompare(right.name)), externalRuntimeClosures };
    return { descriptor, sha256: sha(Buffer.from(bootstrapCanonical(descriptor))) };
}

function bootstrapCanonical(value) {
    if (Array.isArray(value)) return `[${value.map(bootstrapCanonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${bootstrapCanonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

/** Persist the complete already-verified executor before a transaction may stop its old process. */
export function retainOidTripleExecutor(root, { record, manifestBytes, capsule, safeRestart, launcher, externalRuntimeClosures = [] }) {
    const nonce = resolveAttemptNonce(record.actionId, record.transactionNonce);
    if (!record.actionId || nonce !== record.transactionNonce || record.repoRoot !== realpathSync(root)
        || !/^[a-f0-9]{64}$/.test(record.pair?.targetDigest || '')) throw new Error('oid_recovery_record_invalid');
    const manifest = JSON.parse(manifestBytes);
    for (const [key, bytes] of [['capsule', capsule], ['safeRestart', safeRestart], ['launcher', launcher]]) {
        if (!Buffer.isBuffer(bytes) || sha(bytes) !== manifest[`${key}Sha256`]
            || bytes.length !== manifest[`${key}Size`]) throw new Error('oid_recovery_executor_unverified');
    }
    if (manifest.capabilities?.oidTripleAdmissionV2 !== true) throw new Error('oid_recovery_capability_missing');
    const closureInput = { manifestBytes, capsule, safeRestart, launcher, externalRuntimeClosures };
    const codeClosure = record.bootstrap ? bootstrapExecutableClosure(closureInput) : oidExecutorCodeClosure(closureInput);
    if (record.bootstrap && (record.bootstrap.ticket?.material?.executor?.codeClosureSha256 !== codeClosure.sha256
        || record.bootstrap.ticket.material.executor.transactionNonce !== nonce
        || record.bootstrap.ticket.material.installation.root !== record.repoRoot
        || record.bootstrap.ticket.material.event.targetDigest !== record.pair.targetDigest)) {
        throw new Error('bootstrap_code_closure_ticket_mismatch');
    }
    const gitRoot = commonGitDir(root), storage = path.join(gitRoot, 'nassaj-oid-recovery');
    recoveryDirectory(storage, true); recoverySync(gitRoot);
    const transaction = path.join(storage, nonce);
    mkdirSync(transaction, { mode: 0o700 }); recoverySync(storage);
    const executor = path.join(transaction, 'executor');
    mkdirSync(executor, { mode: 0o700 }); recoverySync(transaction);
    const files = [['launcher.mjs', launcher], ['capsule.mjs', capsule], ['safe-restart.sh', safeRestart],
        ['control-manifest.json', manifestBytes], ['record.json', Buffer.from(JSON.stringify(record))]]
        .map(([name, bytes]) => recoveryWrite(executor, name, bytes));
    const descriptor = { schema: 'nassaj-oid-retained-executor/v2', transactionNonce: nonce,
        actionId: record.actionId, targetDigest: record.pair.targetDigest, repoRoot: record.repoRoot, files, codeClosure };
    const bytes = Buffer.from(JSON.stringify(descriptor));
    recoveryWrite(executor, 'executor-manifest.json', bytes); recoverySync(executor);
    return Object.freeze({ schema: descriptor.schema, transactionNonce: nonce, executorManifestSha256: sha(bytes) });
}

/** Validate a retained closure against its durable journal hash, never against a mutable live generation. */
export function readOidTripleRetainedExecutor(root, expected) {
    if (!/^[a-f0-9]{64}$/.test(expected?.transactionNonce || '')
        || !/^[a-f0-9]{64}$/.test(expected.executorManifestSha256 || '')) throw new Error('oid_recovery_reference_invalid');
    const storage = path.join(commonGitDir(root), 'nassaj-oid-recovery');
    const transaction = path.join(storage, expected.transactionNonce), executor = path.join(transaction, 'executor');
    for (const directory of [storage, transaction, executor]) recoveryDirectory(directory);
    const read = (name, fingerprint) => {
        const file = path.join(executor, name), metadata = lstatSync(file);
        if (metadata.nlink !== 1 || metadata.uid !== process.getuid()) throw new Error('oid_recovery_file_unsafe');
        return pinnedBytes(executor, file, { size: metadata.size, mode: 0o600, ...fingerprint }, 'oid_recovery');
    };
    const descriptor = JSON.parse(read('executor-manifest.json', { sha256: expected.executorManifestSha256 }));
    if (descriptor.schema !== 'nassaj-oid-retained-executor/v2' || descriptor.transactionNonce !== expected.transactionNonce
        || descriptor.repoRoot !== realpathSync(root) || descriptor.actionId !== expected.actionId
        || descriptor.targetDigest !== expected.targetDigest
        || JSON.stringify(descriptor.files?.map(file => file.name)) !== '["launcher.mjs","capsule.mjs","safe-restart.sh","control-manifest.json","record.json"]') {
        throw new Error('oid_recovery_manifest_mismatch');
    }
    const bytes = Object.fromEntries(descriptor.files.map(file => [file.name, read(file.name, file)]));
    if (descriptor.codeClosure !== undefined) {
        const calculate = descriptor.codeClosure.descriptor?.schema === 'nassaj-bootstrap-executable-closure/v1'
            ? bootstrapExecutableClosure : oidExecutorCodeClosure;
        const closure = calculate({ manifestBytes: bytes['control-manifest.json'], capsule: bytes['capsule.mjs'],
            safeRestart: bytes['safe-restart.sh'], launcher: bytes['launcher.mjs'],
            externalRuntimeClosures: descriptor.codeClosure?.descriptor?.externalRuntimeClosures });
        if (JSON.stringify(closure) !== JSON.stringify(descriptor.codeClosure)) throw new Error('oid_code_closure_mismatch');
    }
    return { descriptor, bytes, executor };
}

function prepareEventLock(root) {
    const file = controlPath(root, 'nassaj-preview-event-mutation.lock');
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        const metadata = fstatSync(fd);
        if (!metadata.isFile()) throw new Error('oid_event_lock_unsafe');
        return { file, identity: { dev: String(metadata.dev), ino: String(metadata.ino) } };
    } finally { closeSync(fd); }
}

const SUPERVISOR_STARTUP_CODES = new Set([
    'capsule_record_identity_invalid','action_expected_build_required','oid_pair_action_required',
    'oid_pair_lock_unsafe','oid_pair_lock_contended','client_publication_capacity_exceeded',
    'oid_triple_retained_executor_missing','oid_triple_retained_directory_unsafe','oid_triple_retained_binding_invalid',
    'oid_triple_retained_file_unsafe','oid_triple_retained_record_changed','oid_triple_recovery_required',
    'triple_activation_unavailable','pair_activation_unavailable','oid_triple_manifest_dependencies_mismatch',
    'oid_triple_dependency_contract_invalid','oid_triple_runtime_mismatch','oid_triple_previous_dependencies_unverified',
    'oid_triple_previous_interpreter_unverified','oid_pair_previous_runtime_unverified','oid_triple_pm2_executable_missing',
    'oid_triple_pm2_daemon_invalid','oid_triple_pm2_daemon_identity_invalid','oid_triple_pm2_name_invalid',
    'oid_triple_pm2_slot_ambiguous','oid_triple_pm2_slot_changed','oid_triple_previous_process_changed',
    'oid_triple_pm2_authority_invalid','oid_triple_pm2_authority_exposed_write','oid_triple_pm2_home_owner_invalid',
    'oid_triple_pm2_home_invalid','oid_triple_pm2_authority_not_canonical','oid_triple_pm2_authority_changed',
    'oid_triple_pm2_unavailable','oid_triple_node_not_external','oid_triple_node_unsafe','oid_triple_pm2_not_external',
    'oid_triple_pm2_unsafe','git_control_common_dir_unresolved','EAGAIN','EACCES','EPERM','ENOENT','EIO','EMFILE','ENOSPC',
]);

/** Drain bounded diagnostic bytes; expose only explicit codes, never stderr or environment text. */
export function observeOidSupervisorStartup(child) {
    const stream=child.stderr||child.stdio?.[2];let bytes=Buffer.alloc(0),outcome=null,closed=false;
    const data=chunk=>{const remaining=8192-bytes.length;if(remaining>0)bytes=Buffer.concat([bytes,Buffer.from(chunk).subarray(0,remaining)]);};
    const exited=(code,signal)=>{outcome={code,signal};};
    const errored=error=>{outcome={code:null,signal:null,errorCode:SUPERVISOR_STARTUP_CODES.has(error.code)?error.code:'unknown'};};
    stream?.on('data',data);child.on('exit',exited);child.on('error',errored);
    return {
        failure() {
            if(!outcome)return null;
            const lines=bytes.toString('utf8').split(/\r?\n/);
            const reason=lines.find(line=>SUPERVISOR_STARTUP_CODES.has(line))||outcome.errorCode||'unknown';
            const signal=['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGBUS','SIGINT'].includes(outcome.signal)?outcome.signal:'none';
            const code=Number.isInteger(outcome.code)?outcome.code:'none';
            return new Error(`oid_supervisor_exit_before_handshake:exit=${code}:signal=${signal}:reason=${reason}`);
        },
        close() {
            if(closed)return;closed=true;
            stream?.off('data',data);stream?.resume();stream?.unref?.();child.off('exit',exited);child.off('error',errored);bytes=Buffer.alloc(0);
        },
    };
}

/** Observe the existing durable handshake and fail early only when its child has already exited. */
export async function waitOidSupervisorHandshake(file, nonce, maxAttempts = 100, failure = () => null) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            const value = JSON.parse(readFileSync(file, 'utf8'));
            if (value.state === 'executor_ready'
                && (value.launcherNonce === nonce || value.transactionNonce === nonce)) return value;
        } catch { /* supervisor has not fsynced it yet */ }
        const rejected=failure();if(rejected)throw rejected;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('oid_supervisor_handshake_timeout');
}

/** Observe durable completion only; timeout never alters the transaction or its owner. */
export async function waitOidSupervisorOutcome(root, sequence, nonce, { triple = false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const file = controlPath(root, `nassaj-oid-control-transaction-${sequence}-${nonce}.json`);
    for (let attempt = 0; attempt < (triple ? 3600 : 480); attempt += 1) {
        try {
            const value = JSON.parse(readFileSync(file, 'utf8'));
            if (value.transactionNonce !== nonce) throw new Error('oid_supervisor_transaction_replaced');
            if (['pair_rolled_back', 'pair_served', 'served', 'loaded', 'rolled_back', 'restart_deferred_restored', 'manual_recovery_required'].includes(value.state)) {
                return value;
            }
        } catch (error) {
            if (error?.message === 'oid_supervisor_transaction_replaced') throw error;
        }
        await sleep(250);
    }
    throw new Error('oid_supervisor_outcome_timeout');
}

function writeComplete(stream, bytes, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        stream.once('error', (error) => {
            if (!settled) { settled = true; reject(new Error(`${label}_pipe_incomplete:${error.code || error.message}`)); }
        });
        stream.end(bytes, () => {
            if (!settled) { settled = true; resolve(); }
        });
    });
}

/** Preserve the server claim identity; standalone operator launches have their own nonce. */
export function resolveAttemptNonce(actionId, attemptNonce) {
    if (actionId && (!/^[a-f0-9-]{36}$/.test(actionId) || !/^[a-f0-9]{64}$/.test(attemptNonce || ''))) {
        throw new Error('oid_action_attempt_identity_invalid');
    }
    return actionId ? attemptNonce : randomBytes(32).toString('hex');
}

/**
 * Bounded operator-mode selection of a separately pinned corrected executor.
 *
 * Default behaviour reads the capsule/safe-restart bytes from the current live
 * `dist-server` manifest.  Operator mode instead loads them from an immutable,
 * separately pinned executor package whose manifest is bound by hash to the
 * reviewed owner packet (`operatorPacketSha256 === disposition.packetSha256`)
 * and to the exact authorised successor.  The candidate manifest can never
 * grant this authority to itself, there is no arbitrary executable path, and
 * the live root stays the exchange target.  Returns the exact bytes plus the
 * disposition context threaded into the capsule record.
 */
function resolveOperatorExecutor(operator, liveManifest) {
    if (!operator || typeof operator.packageRoot !== 'string' || !path.isAbsolute(operator.packageRoot)
        || !/^[a-f0-9]{64}$/.test(operator.executorManifestSha256 || '')
        || !operator.disposition || !/^[a-f0-9]{64}$/.test(operator.disposition.packetSha256 || '')
        || !operator.disposition.intended) {
        throw new Error('oid_operator_executor_context_invalid');
    }
    const packageRoot = realpathSync(operator.packageRoot);
    const manifestPath = path.join(packageRoot, 'OID_EXECUTOR_MANIFEST.json');
    const metadata = lstatSync(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('oid_operator_executor_manifest_unsafe');
    const manifest = JSON.parse(pinnedBytes(packageRoot, manifestPath, {
        size: metadata.size, mode: 0o444, sha256: operator.executorManifestSha256,
    }, 'operator_executor_manifest').toString('utf8'));
    if (manifest.schema !== 'nassaj-oid-executor/v1'
        || manifest.launcherAbi !== liveManifest.launcherAbi
        || manifest.capsuleModeAbi !== liveManifest.capsuleModeAbi
        || manifest.operatorPacketSha256 !== operator.disposition.packetSha256
        || !/^[a-f0-9]{64}$/.test(manifest.capsuleSha256 || '')
        || !/^[a-f0-9]{64}$/.test(manifest.safeRestartSha256 || '')) {
        throw new Error('oid_operator_executor_manifest_identity_mismatch');
    }
    const intended = operator.disposition.intended;
    if (manifest.successor?.oid !== intended.oid || manifest.successor?.sequence !== intended.sequence
        || manifest.successor?.group !== intended.group || manifest.successor?.buildId !== intended.buildId
        || !/^[a-f0-9]{64}$/.test(intended.buildId || '')) {
        throw new Error('oid_operator_executor_successor_mismatch');
    }
    const capsule = pinnedBytes(packageRoot, path.join(packageRoot, 'OID_CONTROL_CAPSULE.mjs'), {
        sha256: manifest.capsuleSha256, size: manifest.capsuleSize, mode: manifest.capsuleMode,
    }, 'operator_capsule');
    const safeRestart = pinnedBytes(packageRoot, path.join(packageRoot, 'safe-restart.sh'), {
        sha256: manifest.safeRestartSha256, size: manifest.safeRestartSize, mode: manifest.safeRestartMode,
    }, 'operator_safe_restart');
    return {
        capsule, safeRestart, safeRestartSha256: manifest.safeRestartSha256,
        capsuleModeAbi: manifest.capsuleModeAbi, disposition: operator.disposition,
        expectedBuildId: manifest.successor.buildId,
    };
}

export async function launchOidCapsule(root = null, injected = {}) {
    const liveRoot = MODULE_ROOT;
    if (path.basename(liveRoot) !== 'dist-server') throw new Error('oid_launcher_not_loaded_runtime');
    const repoRoot = realpathSync(root || path.dirname(liveRoot));
    if (liveRoot !== path.join(repoRoot, 'dist-server')) throw new Error('oid_launcher_live_root_mismatch');
    const manifest = readLoadedManifest(liveRoot);
    const pair = process.env.NASSAJ_UPDATE_MODE === 'local-main' ? {
        sequence: Number(process.env.NASSAJ_OID_PAIR_SEQUENCE), targetDigest: process.env.NASSAJ_OID_PAIR_TARGET_DIGEST,
        ownerId: process.env.NASSAJ_OID_PAIR_OWNER_ID, databasePath: process.env.NASSAJ_OID_PAIR_DATABASE_PATH,
    } : null;
    if (pair && (manifest.capabilities?.oidPairAdmissionV1 !== true || !Number.isSafeInteger(pair.sequence)
        || pair.sequence < 1 || !/^[a-f0-9]{64}$/.test(pair.targetDigest || '') || !pair.ownerId
        || !path.isAbsolute(pair.databasePath || ''))) throw new Error('pair_activation_unavailable');
    const selection = injected.operator ? resolveOperatorExecutor(injected.operator, manifest) : {
        capsule: pinnedBytes(liveRoot, path.join(liveRoot, 'OID_CONTROL_CAPSULE.mjs'), {
            sha256: manifest.capsuleSha256, size: manifest.capsuleSize, mode: manifest.capsuleMode,
        }, 'capsule'),
        safeRestart: pinnedBytes(liveRoot, path.join(liveRoot, 'scripts', 'safe-restart.sh'), {
            sha256: manifest.safeRestartSha256, size: manifest.safeRestartSize, mode: manifest.safeRestartMode,
        }, 'safe_restart'),
        safeRestartSha256: manifest.safeRestartSha256, capsuleModeAbi: manifest.capsuleModeAbi,
        disposition: null, expectedBuildId: process.env.NASSAJ_OID_EXPECTED_BUILD_ID ?? null,
    };
    const capsule = selection.capsule;
    const safeRestart = selection.safeRestart;
    const transactionNonce = resolveAttemptNonce(
        process.env.NASSAJ_OID_ACTION_ID, process.env.NASSAJ_OID_ATTEMPT_NONCE,
    );
    const handshakePath = controlPath(repoRoot, `nassaj-oid-control-handshake-${transactionNonce}.json`);
    const eventLock = prepareEventLock(repoRoot);
    const internalRecord = {
        repoRoot, liveRoot, pair,
        safeRestartSha256: selection.safeRestartSha256,
        capsuleModeAbi: selection.capsuleModeAbi,
        transactionNonce, handshakePath,
        expectedBuildId: selection.expectedBuildId,
        lockIdentity: eventLock.identity, oldPid: process.ppid, oldStartTicks: processStartTicks(process.ppid),
        loadedControlBuildId: manifest.serverBuildId,
        disposition: selection.disposition,
        actionId: /^[a-f0-9-]{36}$/.test(process.env.NASSAJ_OID_ACTION_ID || '')
            ? process.env.NASSAJ_OID_ACTION_ID : null,
    };
    let triple = false;
    if (pair) {
        const sealed = await import(`data:text/javascript;base64,${capsule.toString('base64')}`);
        const state = sealed.inspectConfirmedOidPair(repoRoot, { ...pair, actionId: internalRecord.actionId, transactionNonce });
        if (state.target?.schema === 'nassaj-oid-triple-target/v2') {
            triple = true;
            const launcher = pinnedBytes(liveRoot, path.join(liveRoot, 'scripts/preview-oid-capsule-launcher.mjs'), {
                sha256: manifest.launcherSha256, size: manifest.launcherSize, mode: manifest.launcherMode,
            }, 'triple_launcher');
            internalRecord.recoveryReference = retainOidTripleExecutor(repoRoot, { record: internalRecord,
                manifestBytes: readFileSync(path.join(liveRoot, 'OID_CONTROL_MANIFEST.json')), capsule, safeRestart, launcher });
        }
    }
    const internal = Buffer.from(JSON.stringify(internalRecord));
    const spawnSupervisor = injected.spawn || spawn;
    const command = pair ? process.execPath : '/usr/bin/flock';
    const args = pair ? ['--input-type=module', '-'] : ['-x', '-w', '10', '-F', eventLock.file, process.execPath, '--input-type=module', '-'];
    const child = spawnSupervisor(command, args, { cwd: repoRoot, detached: true, stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const startup=observeOidSupervisorStartup(child);let handshake;
    try {
        await Promise.all([
            writeComplete(child.stdin, capsule, 'capsule'),
            writeComplete(child.stdio[3], safeRestart, 'safe_restart'),
            writeComplete(child.stdio[4], internal, 'capsule_record'),
        ]);
        child.unref();
        handshake = await (injected.waitHandshake || waitOidSupervisorHandshake)(handshakePath, transactionNonce, pair ? 4800 : 100,startup.failure);
    } catch(error) {throw startup.failure()||error;}
    finally {startup.close();}
    if (injected.handshakeOnly === true) return { status: 'executor_ready', ...handshake };
    const outcome = await (injected.waitOutcome || waitOidSupervisorOutcome)(
        repoRoot, handshake.sequence, handshake.transactionNonce, { triple },
    );
    if (pair && outcome.state === 'pair_served') {
        const proof = await waitPairServing(outcome);
        const sealed = await import(`data:text/javascript;base64,${capsule.toString('base64')}`);
        await sealed.writeOidPairServingReceipt(repoRoot, outcome, proof);
    }
    return { status: outcome.state === 'pair_served' ? 'served' : outcome.state === 'pair_rolled_back' ? 'rolled_back' : outcome.state, sequence: handshake.sequence, oid: handshake.oid, buildId: handshake.buildId };
}

/** Resume only the canonical retained launcher for a recorded transaction; never take a target path from argv. */
export async function resumeOidTripleExecutor(transactionNonce) {
    if (!/^[a-f0-9]{64}$/.test(transactionNonce || '')
        || !/^[A-Za-z0-9:_-]{1,120}$/.test(process.env.NASSAJ_OID_RESUME_PERMISSION_REF || '')) throw new Error('oid_resume_permission_reference_required');
    const executor = path.dirname(fileURLToPath(import.meta.url));
    const descriptor = JSON.parse(readFileSync(path.join(executor, 'executor-manifest.json')));
    const root = descriptor.repoRoot;
    const expectedPath = path.join(commonGitDir(root), 'nassaj-oid-recovery', transactionNonce, 'executor', 'launcher.mjs');
    if (fileURLToPath(import.meta.url) !== expectedPath) throw new Error('oid_resume_entry_not_retained');
    const original = JSON.parse(readFileSync(path.join(executor, 'record.json')));
    if (!Number.isSafeInteger(original.pair?.sequence) || original.pair.sequence < 1) throw new Error('oid_resume_sequence_invalid');
    const journalFile = controlPath(root, `nassaj-oid-control-transaction-${original.pair.sequence}-${transactionNonce}.json`);
    const metadata = lstatSync(journalFile);
    const transaction = JSON.parse(pinnedBytes(commonGitDir(root), journalFile, { mode: 0o600, size: metadata.size, sha256: sha(readFileSync(journalFile)) }, 'resume_journal'));
    if (transaction.schema !== 'nassaj-oid-control-transaction/v2' || transaction.transactionNonce !== transactionNonce
        || transaction.actionId !== original.actionId || transaction.pair?.targetDigest !== original.pair.targetDigest) throw new Error('oid_resume_transaction_mismatch');
    const retained = readOidTripleRetainedExecutor(root, { ...transaction.recoveryReference,
        transactionNonce, actionId: transaction.actionId, targetDigest: transaction.pair.targetDigest });
    const node = transaction.supervisor?.node;
    if (!node || sha(readFileSync(realpathSync(process.execPath))) !== node.sha256 || realpathSync(process.execPath) !== node.path) throw new Error('oid_resume_interpreter_changed');
    const record = { ...JSON.parse(retained.bytes['record.json']), recoveryReference: transaction.recoveryReference,
        resume: { permissionRef: process.env.NASSAJ_OID_RESUME_PERMISSION_REF, operatorUid: process.getuid(), requestedAt: Date.now() } };
    const child = spawn(node.path, ['--input-type=module', '-'], { cwd: root, detached: true, stdio: ['pipe','ignore','pipe','pipe','pipe'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-2048); });
    const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    await Promise.all([writeComplete(child.stdin, retained.bytes['capsule.mjs'], 'resume_capsule'),
        writeComplete(child.stdio[3], retained.bytes['safe-restart.sh'], 'resume_safe'),
        writeComplete(child.stdio[4], Buffer.from(JSON.stringify(record)), 'resume_record')]);
    const code = await completed;
    if (code !== 0) throw new Error(`oid_resume_failed:${diagnostic.trim()}`);
    return { status: 'resume_completed', transactionNonce };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const operation = process.argv[2] === '--resume-transaction' && process.argv.length === 4
        ? resumeOidTripleExecutor(process.argv[3]) : process.argv.length === 2 ? launchOidCapsule() : Promise.reject(new Error('oid_launcher_arguments_invalid'));
    operation.then((value) => {
        process.stdout.write(`${JSON.stringify(value)}\n`);
        if (value.status === 'restart_deferred_restored') process.exitCode = 6;
        else if (!['executor_ready', 'served', 'loaded', 'rolled_back', 'resume_completed'].includes(value.status)) process.exitCode = 1;
    }).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

/** Pair verification is not application readiness; wait for the exact child's normal admission. */
async function waitPairServing(outcome) {
    for (let attempt = 0; attempt < 480; attempt++) {
        try {
            const response = await fetch(process.env.NASSAJ_PREVIEW_HEALTH_URL || 'http://127.0.0.1:3004/health', { signal: AbortSignal.timeout(3000) });
            const health = response.ok ? await response.json() : null;
            if (health?.normalAdmissionReady === true && health.serverLoadedBuildId === outcome.pair.target.serverBuildId
                && health.clientBuildIdServed === outcome.pair.target.clientBuildId
                && health.serverTransactionNonce === outcome.transactionNonce) return health;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('oid_pair_application_not_ready');
}
