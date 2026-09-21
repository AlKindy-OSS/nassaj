import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// eslint-disable-next-line boundaries/no-unknown -- root-verified bootstrap context is a builtins-only authority leaf outside feature modules.
import { assertLegacyTransitionAllowed, requireStartupAdmission } from '../bootstrap-startup-context.js';
// eslint-disable-next-line boundaries/dependencies -- pure configuration leaf; the database barrel would import persistence before the bootstrap gate.
import { resolveDatabaseFilePath } from '../modules/database/database-path.js';
import { inspectSealedRelease, readReceipt } from '../../scripts/nassaj-release-launcher.mjs';
import { requireReleaseLayout } from '../../scripts/lib/update-release-layout-adapter.mjs';
import { readReleaseActivationAction, validateReleaseActivationAction } from '../../scripts/lib/update-release-layout-activation.mjs';
import { hashTree } from '../../scripts/lib/source-update-tree-identity.mjs';
import { readDatabaseSnapshot, captureDatabaseSnapshot } from '../../scripts/lib/source-update-database-snapshot.mjs';
import { isNassajReleaseVersion } from '../../shared/release-version-policy.js';
import { validateOidPairMaintenance, recoverOidPairAdmission, inspectOidBootstrapAdmission as inspectPairBootstrap } from '../../scripts/oid-control-capsule.mjs';

const JOURNAL_SCHEMA = 'nassaj-source-update-maintenance/v1';
const STATES = new Set(['RECOVERING', 'OPEN', 'DRAINING', 'UPDATING', 'MANUAL']);
const PHASES = new Set([
    'OID_DRAINING', 'OID_QUIESCENT', 'OID_EXCHANGING', 'OID_BOOTSTRAP_VERIFYING', 'OID_PAIR_VERIFIED', 'OID_RECOVERING',
    'ARTIFACT_ACTIVATING', 'ARTIFACT_SWITCHED', 'PREPARED', 'SOURCE_APPLYING', 'SOURCE_APPLIED', 'INSTALLING', 'CLIENT_BUILT',
    'SERVER_BUILT', 'VERIFIED', 'ACTIVATION_QUEUED', 'RESTARTING_HANDOFF',
    'BOOTSTRAP_CLAIMED', 'ACTIVE_VERIFIED', 'ROLLBACK_PREPARED',
    'ROLLBACK_SOURCE_APPLYING', 'ROLLBACK_SOURCE_APPLIED', 'ROLLBACK_INSTALLING',
    'ROLLBACK_CLIENT_BUILT', 'ROLLBACK_SERVER_BUILT', 'ROLLBACK_VERIFIED',
]);
const RECOVERY_PHASES = new Set([
    'SOURCE_APPLYING', 'SOURCE_APPLIED', 'INSTALLING', 'CLIENT_BUILT',
    'SERVER_BUILT', 'VERIFIED', 'ACTIVATION_QUEUED', 'RESTARTING_HANDOFF',
    'BOOTSTRAP_CLAIMED', 'ROLLBACK_PREPARED', 'ROLLBACK_SOURCE_APPLYING',
    'ROLLBACK_SOURCE_APPLIED', 'ROLLBACK_INSTALLING', 'ROLLBACK_CLIENT_BUILT',
    'ROLLBACK_SERVER_BUILT', 'ROLLBACK_VERIFIED',
]);
const SHA = /^[0-9a-f]{40}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const OWNED_LEASE = Symbol('nassajUpdateMaintenanceLease');

// ADR-156 ب.5 (WI-12/T-1727). The three live generations, named as the
// activation receipt and the candidate manifest name them.
const GENERATION_PATHS = Object.freeze({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' });
// The one degraded reason this path may publish, and the one exit path that
// clears it. Decision 7 of ADR-156 forbids a silent reopen, so a reopen that
// leaves the source tree at the target commit MUST carry both.
const SOURCE_TREE_AT_TARGET = 'source_tree_at_target';
const SOURCE_REOPEN_EXIT_PATH = 'complete_source_rollback_or_pin_release_ref';

/** Attest the selected executable against the transaction-pinned candidate manifest. */
export function attestBootstrapApplication(paths, journal, applicationPath) {
    const serverRoot = path.join(paths.root, 'dist-server');
    const expectedEntry = path.join(serverRoot, 'server', 'application.js');
    if (applicationPath !== expectedEntry || fs.realpathSync(applicationPath) !== expectedEntry
        || !fs.lstatSync(applicationPath).isFile()) throw new Error('update_bootstrap_application_path_mismatch');
    const manifestPath = path.join(paths.controlRoot, 'candidates', journal.transactionId, 'candidate-manifest.json');
    const metadata = fs.lstatSync(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077)
        || (process.getuid && metadata.uid !== process.getuid()) || fs.realpathSync(manifestPath) !== manifestPath) {
        throw new Error('update_bootstrap_manifest_unsafe');
    }
    const bytes = fs.readFileSync(manifestPath);
    if (!/^[a-f0-9]{64}$/.test(journal.identity?.manifestSha256 || '')
        || crypto.createHash('sha256').update(bytes).digest('hex') !== journal.identity.manifestSha256) {
        throw new Error('update_bootstrap_manifest_mismatch');
    }
    const manifest = JSON.parse(bytes);
    const provenance = JSON.parse(fs.readFileSync(path.join(serverRoot, 'BUILD_PROVENANCE.json'), 'utf8'));
    const actual = hashTree(serverRoot);
    if (manifest.txId !== journal.transactionId || manifest.releaseCommit !== journal.identity.targetCommit
        || manifest.version !== journal.identity.expectedVersion || provenance.commit !== manifest.releaseCommit
        || provenance.version !== manifest.version || provenance.buildId !== manifest.serverBuildId
        || actual.sha256 !== manifest.trees?.server?.sha256 || actual.files !== manifest.trees?.server?.files) {
        throw new Error('update_bootstrap_application_identity_mismatch');
    }
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function checksum(value) {
    const { checksum: _ignored, ...payload } = value;
    return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}

function readBootId() {
    try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
}

/**
 * `/proc/<pid>/stat` field 22 (start time in ticks since boot), or WHY it could
 * not be read: `missing` = no process holds this pid now, `unreadable` = /proc
 * itself did not answer. The two must never be conflated (qa-critic C1).
 */
function readProcessStart(pid) {
    try {
        const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const start = text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
        return start ? { start } : { unreadable: true };
    } catch (error) {
        return error?.code === 'ENOENT' || error?.code === 'ESRCH' ? { missing: true } : { unreadable: true };
    }
}

/**
 * Liveness of the journal's update owner. `true`: that exact process still runs.
 * `false`: provably dead — recorded in another boot, its pid is gone in this
 * boot, or the pid now belongs to a process with another start time. `null`:
 * /proc could not answer, the ONE case ADR-156 ب.3 keeps MANUAL for. Treating
 * a dead owner as unknown turned every killed updater into MANUAL and the next
 * bootstrap into a pm2 crash-loop.
 */
function ownerIsAlive(owner) {
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.startTime !== 'string' || !owner.startTime) {
        return null;
    }
    const bootId = readBootId();
    if (!bootId) return null;
    if (typeof owner.bootId === 'string' && owner.bootId && owner.bootId !== bootId) return false;
    const observed = readProcessStart(owner.pid);
    if (observed.unreadable) return null;
    // A readable boot_id proves /proc is mounted, so a missing entry is proof of
    // death even for an owner recorded before boot ids were: no process of this
    // boot holds the pid, and a process of an earlier boot is dead by definition.
    if (observed.missing) return false;
    return observed.start === owner.startTime;
}

/** The identity an owner record carries so a later reader can prove it dead. */
function currentOwnerIdentity() {
    const observed = readProcessStart(process.pid);
    if (!observed.start) throw new Error('update_owner_start_time_unavailable');
    const bootId = readBootId();
    if (!bootId) throw new Error('update_owner_boot_id_unavailable');
    return { pid: process.pid, startTime: observed.start, bootId };
}

/**
 * Read one activation control file under the same integrity rules `readJsonFile`
 * applies inside the activation library: a real regular file, not a symlink,
 * mode 0600, owned by this process. WI-12 may NOT reach that reader through
 * `validateCandidate`, so the rules are restated here rather than relaxed.
 */
function readGuardedActivationJson(file, label) {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        || fs.realpathSync(file) !== file) {
        throw new Error(`update_reopen_${label}_unsafe`);
    }
    const bytes = fs.readFileSync(file);
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

/** Record the observed source state in the receipt, at the receipt's own 0600. */
function writeReceiptSourceState(file, receipt, source) {
    const payload = { ...receipt, source, updatedAt: new Date().toISOString() };
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return payload;
}

/**
 * Where the SOURCE tree sits, independently of the artifact generations (ب.5).
 * Checking the generations alone is half the state: generations at `previous`
 * with a source tree still at the target commit is the shape that makes the
 * NEXT update fail with a CAS mismatch, so it is a distinct, declared outcome.
 */
function readSourceTreeState(root, journal, commandRunner) {
    const { originalHead, targetCommit } = journal.identity || {};
    const git = (args) => commandRunner('git', args, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const revision = git(['rev-parse', '--verify', 'HEAD']);
    const head = revision?.status === 0 && typeof revision.stdout === 'string' ? revision.stdout.trim() : null;
    if (!SHA.test(head || '')) return { head: null, treeApplied: 'mixed' };
    const listed = git(['diff', '--name-only', '-z', originalHead, targetCommit]);
    if (listed?.status !== 0 || typeof listed.stdout !== 'string') return { head, treeApplied: 'mixed' };
    const changed = listed.stdout.split('\0').filter(Boolean);
    // Restricted to the paths the release itself changes: an unrelated dirty
    // file is not evidence about which direction the source tree is in. The
    // pathspec is chunked because `git diff` takes it only as arguments.
    const matches = (commit) => {
        for (let index = 0; index < changed.length; index += 256) {
            const result = git(['diff', '--quiet', commit, '--', ...changed.slice(index, index + 256)]);
            if (result?.status !== 0) return false;
        }
        return true;
    };
    const atOriginal = head === originalHead && matches(originalHead);
    const atTarget = head === targetCommit && matches(targetCommit);
    if (atOriginal && !atTarget) return { head, treeApplied: 'original' };
    if (atTarget && !atOriginal) return { head, treeApplied: 'target' };
    return { head, treeApplied: 'mixed' };
}

/** Whether the receipt path holds anything at all; a dangling symlink counts as present. */
function receiptPresent(file) {
    try { fs.lstatSync(file); return true; } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

/**
 * Prove from the durable receipt that every live generation is the PREVIOUS
 * one. A name with no recorded step was never exchanged — unless the live tree
 * already equals the manifest target, which means the exchange outran its
 * receipt and `previous` is no longer provable here.
 *
 * With NO receipt at all (plan ب.2, qa-critic H2) the first exchange never
 * started, so the live trees ARE the previous generation — provided none of
 * them already equals its manifest target. Then only the source state decides.
 */
function proveGenerationsAtPrevious(root, candidateRoot, journal) {
    const manifest = readGuardedActivationJson(path.join(candidateRoot, 'candidate-manifest.json'), 'manifest');
    if (journal.identity?.manifestSha256
        && crypto.createHash('sha256').update(manifest.bytes).digest('hex') !== journal.identity.manifestSha256) {
        throw new Error('update_reopen_manifest_digest_mismatch');
    }
    if (manifest.value?.txId !== journal.transactionId) throw new Error('update_reopen_manifest_identity_mismatch');
    const receiptPath = path.join(candidateRoot, 'activation-receipt.json');
    if (!receiptPresent(receiptPath)) {
        for (const [name, directory] of Object.entries(GENERATION_PATHS)) {
            const live = hashTree(path.join(root, directory));
            const target = manifest.value.trees?.[name];
            if (target && live.sha256 === target.sha256 && live.files === target.files) {
                throw new Error(`update_reopen_generation_unrecorded_${name}`);
            }
        }
        return { receiptPath: null, receipt: null };
    }
    const receipt = readGuardedActivationJson(receiptPath, 'receipt');
    if (receipt.value?.schemaVersion !== 1 || receipt.value.txId !== journal.transactionId) {
        throw new Error('update_reopen_receipt_identity_mismatch');
    }
    for (const [name, directory] of Object.entries(GENERATION_PATHS)) {
        const live = hashTree(path.join(root, directory));
        const step = receipt.value.steps?.[name];
        const target = manifest.value.trees?.[name];
        if (step?.previous) {
            if (live.sha256 !== step.previous.sha256 || live.files !== step.previous.files) {
                throw new Error(`update_reopen_generation_mismatch_${name}`);
            }
        } else if (target && live.sha256 === target.sha256 && live.files === target.files) {
            throw new Error(`update_reopen_generation_unrecorded_${name}`);
        }
    }
    return { receiptPath, receipt: receipt.value };
}

/**
 * The ب.5 exit-path table, evaluated without `validateCandidate` (م-2): its
 * `readReceipt` needs the very validation object whose throw brought us here.
 *
 *   generations previous + source original -> OPEN
 *   generations previous + source target   -> OPEN, degraded, exit path named
 *   anything else                          -> not eligible, MANUAL stands
 */
function decidePreviousGenerationReopen(paths, journal, commandRunner) {
    if (paths.artifact) return { eligible: false, reason: 'update_reopen_artifact_layout_unsupported' };
    if (!TOKEN.test(journal.transactionId || '') || !SHA.test(journal.identity?.originalHead || '')
        || !SHA.test(journal.identity?.targetCommit || '')) {
        return { eligible: false, reason: 'update_reopen_identity_unavailable' };
    }
    const candidateRoot = path.join(paths.controlRoot, 'candidates', journal.transactionId);
    let proof;
    try {
        proof = proveGenerationsAtPrevious(paths.root, candidateRoot, journal);
    } catch (error) {
        return { eligible: false, reason: String(error?.message || 'update_reopen_unavailable').slice(0, 200) };
    }
    const source = readSourceTreeState(paths.root, journal, commandRunner);
    if (source.treeApplied === 'original') return { eligible: true, degraded: null, exitPath: null, source, ...proof };
    if (source.treeApplied === 'target') {
        return { eligible: true, degraded: SOURCE_TREE_AT_TARGET, exitPath: SOURCE_REOPEN_EXIT_PATH, source, ...proof };
    }
    return { eligible: false, reason: 'update_reopen_source_tree_mixed', source };
}

/**
 * ADR-156 ت-3. Downtime is measured where it happens — from the transition that
 * closes the gate to the one that opens it — because the 2026-09-11 outage was
 * never measured at all. Interventions and MANUAL are counted in the same place.
 *
 * qa-critic M3: interventions used to be inferred from `recoveryError`, which
 * the AUTOMATIC reopen sets and the human doctor reopen does not — the metric
 * was inverted. Each transition now states who acted (`intervention`), and the
 * two counts are kept apart: `interventionsRequired` (human) and
 * `automaticRepairs`. MANUAL alone already means a person must act.
 */
function measureRecovery(current, patch, intervention, now) {
    const before = current.metrics && typeof current.metrics === 'object' ? current.metrics : {};
    const closing = patch.gateClosed === true && current.gateClosed !== true;
    const opening = patch.gateClosed === false && current.gateClosed === true;
    if (closing && patch.transactionId) {
        return { metrics: {
            closedAtMs: now, downtimeMs: null, interventionsRequired: 0, automaticRepairs: 0,
            intervention: null, reachedManual: false,
        } };
    }
    const count = (key) => (Number.isSafeInteger(before[key]) ? before[key] : 0);
    const interventionsRequired = count('interventionsRequired') + (intervention === 'human' ? 1 : 0);
    const automaticRepairs = count('automaticRepairs') + (intervention === 'automatic' ? 1 : 0);
    const reachedManual = before.reachedManual === true || patch.state === 'MANUAL';
    return {
        metrics: {
            closedAtMs: closing ? now : (Number.isSafeInteger(before.closedAtMs) ? before.closedAtMs : null),
            downtimeMs: opening
                ? (Number.isSafeInteger(before.closedAtMs) ? Math.max(0, now - before.closedAtMs) : null)
                : (Number.isSafeInteger(before.downtimeMs) ? before.downtimeMs : null),
            interventionsRequired,
            automaticRepairs,
            intervention: interventionsRequired > 0 || reachedManual ? 'human' : (automaticRepairs > 0 ? 'automatic' : null),
            reachedManual,
        },
    };
}

async function rollbackStaleSourceUpdate(paths, journal) {
    if (journal.databaseState === 'UNKNOWN' || ['RESTARTING_HANDOFF', 'BOOTSTRAP_CLAIMED'].includes(journal.phase)) {
        throw new Error('update_database_state_unknown');
    }
    const candidateRoot = path.join(paths.controlRoot, 'candidates', journal.transactionId);
    const actionFile = path.join(candidateRoot, 'activation-action.json');
    const metadata = fs.lstatSync(actionFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('update_recovery_action_unsafe');
    const action = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
    if (action?.schema !== 'nassaj-source-update-activation/v1'
        || action.transactionId !== journal.transactionId
        || action.originalHead !== journal.identity?.originalHead
        || action.targetCommit !== journal.identity?.targetCommit
        || action.version !== journal.identity?.expectedVersion) throw new Error('update_recovery_action_mismatch');
    if (!['SOURCE_APPLYING', 'SOURCE_APPLIED'].includes(journal.phase)) {
        const databasePath = resolveDatabaseFilePath();
        readDatabaseSnapshot({ databasePath, snapshotRoot: path.join(path.dirname(databasePath), 'nassaj-update-db-snapshots'),
            transactionId: journal.transactionId, targetCommit: journal.identity.targetCommit });
    }
    const activation = await import('../../scripts/lib/source-update-activation.mjs');
    const validation = activation.validateCandidate({
        projectRoot: paths.root, candidateRoot, transactionId: action.transactionId,
        releaseCommit: action.targetCommit, version: action.version,
        manifestPath: action.manifestPath, manifestSha256: action.manifestSha256,
    });
    // Receipt-driven artifact rollback is idempotent; an absent receipt means
    // the crash preceded the first exchange and needs no artifact mutation.
    if (fs.existsSync(path.join(candidateRoot, 'activation-receipt.json'))) activation.rollbackGenerations(validation);
    activation.rollbackSourceManifest({
        projectRoot: paths.root, originalHead: action.originalHead, targetCommit: action.targetCommit,
    });
}

/** Bind the current artifact to the exact pre-import handoff and durable activation effect. */
function attestArtifactBootstrap(paths, journal, applicationPath) {
    if (!paths.artifact || applicationPath !== path.join(paths.root,'dist-server','server','application.js')) throw new Error('artifact_bootstrap_path_mismatch');
    const application = fs.lstatSync(applicationPath);
    if (!application.isFile() || application.isSymbolicLink()) throw new Error('artifact_bootstrap_application_unsafe');
    const binding = journal.identity.artifact;
    const action = readReleaseActivationAction({layout:paths.artifact.layout,jobId:binding.jobId});
    const sealed = paths.artifact.sealed;
    const actionIdentityHash = crypto.createHash('sha256').update(canonical(validateReleaseActivationAction(action).identity)).digest('hex');
    if (action.activationIdentitySha256 !== binding.activationIdentitySha256 || action.generationId !== journal.transactionId
        || action.commit !== journal.identity.targetCommit || action.nodeInstanceId && action.nodeInstanceId !== binding.nodeInstanceId
        || binding.nodeInstanceId !== process.env.NASSAJ_NODE_INSTANCE_ID || sealed.generationId !== action.generationId
        || sealed.manifest.serverBuildId !== action.serverBuildId || sealed.manifest.clientBuildId !== action.clientBuildId) throw new Error('artifact_bootstrap_identity_mismatch');
    const directory = path.join(paths.artifact.layout.controlRoot,'receipts',binding.jobId);
    const receipts = fs.readdirSync(directory).filter(name=>/^[0-9]{8}-activate-(done|recovery)\.json$/.test(name));
    if (!receipts.some(name=> {const receipt=readReceipt(path.join(directory,name)); return receipt.schemaVersion===2 && receipt.phase==='activate' && ['done','recovery'].includes(receipt.kind)
        && receipt.identitySha256===actionIdentityHash && receipt.jobId===binding.jobId
        && receipt.generationId===action.generationId && receipt.facts.current===action.generationId
        && receipt.facts.previous===action.expectedCurrentGenerationId;})) throw new Error('artifact_activation_receipt_missing');
    return action;
}
function validateArtifactCompletion(paths, journal, patch) {
    const action = attestArtifactBootstrap(paths,journal,path.join(paths.root,'dist-server','server','application.js'));
    const proof = patch.artifactCompletion;
    if (!proof || proof.jobId!==action.jobId || proof.generationId!==action.generationId
        || proof.activationIdentitySha256!==action.activationIdentitySha256 || proof.serverBuildId!==action.serverBuildId
        || proof.clientBuildId!==action.clientBuildId || proof.commit!==action.commit || !Number.isSafeInteger(proof.receiptSequence)) throw new Error('artifact_completion_mismatch');
    const receipt = readReceipt(path.join(paths.artifact.layout.controlRoot,'job-receipts',`${proof.jobId}.${String(proof.receiptSequence).padStart(8,'0')}.json`));
    const facts = JSON.parse(receipt.factsJson);
    if (receipt.jobId!==proof.jobId || receipt.sequence!==proof.receiptSequence || receipt.phase!=='runtime_verifying'
        || !['done','recovery'].includes(receipt.kind) || crypto.createHash('sha256').update(receipt.factsJson).digest('hex')!==receipt.factsSha256
        || facts.generationId!==proof.generationId || facts.activationIdentitySha256!==proof.activationIdentitySha256
        || facts.serverBuildId!==proof.serverBuildId || facts.clientBuildId!==proof.clientBuildId) throw new Error('artifact_completion_receipt_mismatch');
}

function resolvePaths(projectPath, commandRunner = spawnSync) {
    const root = fs.realpathSync(path.resolve(projectPath));
    if ((process.env.NASSAJ_UPDATE_CAPABILITY_FILE || process.env.NASSAJ_UPDATE_CONTROL_ROOT
        || fs.existsSync(path.join(root,'runtime-generation.json'))) && !requireStartupAdmission()) {
        const layout = requireReleaseLayout({ deployRoot: process.env.NASSAJ_DEPLOY_ROOT, projectRoot: root,
            artifactRoot: path.join(root, 'dist-server'), controlRoot: process.env.NASSAJ_UPDATE_CONTROL_ROOT,
            capabilityFile: process.env.NASSAJ_UPDATE_CAPABILITY_FILE, nodeInstanceId: process.env.NASSAJ_NODE_INSTANCE_ID });
        const sealed = inspectSealedRelease({ deployRoot: layout.deployRoot, nodeInstanceId: process.env.NASSAJ_NODE_INSTANCE_ID });
        if (sealed.current !== root) throw new Error('artifact_maintenance_current_mismatch');
        const controlRoot = path.join(layout.controlRoot, 'maintenance');
        return { root, artifact: { layout, sealed }, commonGitDir: null, controlRoot,
            admissionLock: path.join(controlRoot,'admission.lock'), activityLock: path.join(controlRoot,'activity.lock'),
            journal: path.join(controlRoot,'journal.json'), token: path.join(controlRoot,'token') };
    }
    const result = commandRunner('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) {
        throw new Error('update_common_dir_unavailable');
    }
    const commonGitDir = fs.realpathSync(path.resolve(root, result.stdout.trim()));
    const controlRoot = path.join(commonGitDir, 'nassaj-source-update');
    return {
        root, commonGitDir, controlRoot,
        admissionLock: path.join(controlRoot, 'admission.lock'),
        activityLock: path.join(controlRoot, 'activity.lock'),
        journal: path.join(controlRoot, 'journal.json'),
        token: path.join(controlRoot, 'token'),
    };
}

function flockAsync(lockPath, mode, { signal, waitMs = 30_000 } = {}) {
    const restricted = requireStartupAdmission();
    if (!restricted) fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const fd = restricted ? fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)
        : fs.openSync(lockPath, 'a', 0o600);
    if (restricted) {
        const metadata = fs.fstatSync(fd);
        if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid()) {
            fs.closeSync(fd); throw new Error('update_existing_lock_unsafe');
        }
    }
    return new Promise((resolve, reject) => {
        const seconds = Math.max(0, waitMs / 1000);
        const args = [mode === 'exclusive' ? '-x' : '-s', '-w', String(seconds), '3'];
        const child = spawn('flock', args, { stdio: ['ignore', 'ignore', 'ignore', fd] });
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            if (error) {
                try { fs.closeSync(fd); } catch {}
                reject(error);
                return;
            }
            let released = false;
            resolve({
                release() {
                    if (released) return;
                    released = true;
                    try { fs.closeSync(fd); } catch {}
                },
            });
        };
        const abort = () => {
            try { child.kill('SIGKILL'); } catch {}
            finish(new Error('update_lock_aborted'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', () => finish(new Error('update_lock_unavailable')));
        child.once('close', (code) => finish(code === 0 ? null : new Error('update_lock_contended')));
        if (signal?.aborted) abort();
    });
}

function durableWrite(file, value) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const payload = { ...value, checksum: checksum(value) };
    const temporary = path.join(directory, `.journal.${process.pid}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return payload;
}

function readJournal(file) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('update_journal_unavailable'); }
    if (value?.schema !== JOURNAL_SCHEMA || !STATES.has(value.state)
        || !Number.isSafeInteger(value.sequence) || value.sequence < 0
        || value.checksum !== checksum(value)) throw new Error('update_journal_invalid');
    if (value.phase !== null && !PHASES.has(value.phase)) throw new Error('update_journal_invalid');
    return value;
}

function ensureControl(paths) {
    const restricted = requireStartupAdmission();
    if (restricted) {
        const metadata = fs.lstatSync(paths.controlRoot);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700
            || metadata.uid !== process.getuid()) throw new Error('update_existing_control_unsafe');
    } else {
        fs.mkdirSync(paths.controlRoot, { recursive: true, mode: 0o700 });
        fs.chmodSync(paths.controlRoot, 0o700);
    }
    const tokenExisted = fs.existsSync(paths.token);
    const journalExisted = fs.existsSync(paths.journal);
    if (restricted && (!tokenExisted || !journalExisted)) throw new Error('update_existing_control_missing');
    if (tokenExisted !== journalExisted) throw new Error('update_control_state_incomplete');
    if (!tokenExisted) {
        fs.writeFileSync(paths.token, crypto.randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    }
    const tokenMetadata = fs.lstatSync(paths.token);
    if (!tokenMetadata.isFile() || tokenMetadata.isSymbolicLink() || (tokenMetadata.mode & 0o777) !== 0o600
        || (typeof process.getuid === 'function' && tokenMetadata.uid !== process.getuid())) {
        throw new Error('update_ownership_token_unsafe');
    }
    const rawToken = fs.readFileSync(paths.token, 'utf8').trim();
    if (!TOKEN.test(rawToken)) throw new Error('update_ownership_token_invalid');
    const tokenDigest = crypto.createHash('sha256').update(rawToken).digest('hex');
    if (!journalExisted) {
        durableWrite(paths.journal, {
            schema: JOURNAL_SCHEMA, sequence: 0, state: 'OPEN', phase: null,
            gateClosed: false, transactionId: null, owner: null, identity: null,
            tokenDigest, updatedAt: new Date().toISOString(),
        });
    }
    const journal = readJournal(paths.journal);
    if (journal.tokenDigest !== tokenDigest) throw new Error('update_ownership_token_mismatch');
    return { rawToken, tokenDigest, journal };
}

function equalDigest(left, right) {
    if (!/^[0-9a-f]{64}$/.test(left || '') || !/^[0-9a-f]{64}$/.test(right || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Read existing evidence without mutation; observation grants neither admission nor execution authority. */
export function readUpdateMaintenanceRecoveryEvidence({ projectPath, commandRunner = spawnSync } = {}) {
    const paths = resolvePaths(projectPath, commandRunner);
    const metadata = fs.lstatSync(paths.controlRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700
        || metadata.uid !== process.getuid() || fs.realpathSync(paths.controlRoot) !== paths.controlRoot) {
        throw new Error('update_existing_control_unsafe');
    }
    const rawToken = readExistingMaintenanceFile(paths.token, fd => fs.readFileSync(fd, 'utf8').trim());
    if (!TOKEN.test(rawToken)) throw new Error('update_ownership_token_invalid');
    const journal = readExistingMaintenanceFile(paths.journal, readJournal);
    if (journal.tokenDigest !== crypto.createHash('sha256').update(rawToken).digest('hex')) {
        throw new Error('update_ownership_token_mismatch');
    }
    return { ...maintenanceRecoveryEvidence(journal), controlRoot: paths.controlRoot };
}

function readExistingMaintenanceFile(file, read) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const metadata = fs.fstatSync(fd);
        if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
            || metadata.uid !== process.getuid() || fs.realpathSync(file) !== file) throw new Error('update_existing_control_file_unsafe');
        return read(fd);
    } finally { fs.closeSync(fd); }
}

function maintenanceRecoveryEvidence(current) {
    return { state: current.state, phase: current.phase, gateClosed: current.gateClosed,
        transactionId: current.transactionId, degraded: current.degraded ?? null,
        identity: current.identity, runtimeIdentities: current.runtimeIdentities,
        databaseState: current.databaseState, recovery: current.recovery, oidAdmissionIntentPending: Boolean(current.oidAdmissionIntent) };
}

/**
 * Every literal `update_*` reason code this gate raises.
 *
 * SINGLE DECLARATION SITE: callers that surface a denial to a client or a log
 * (websocket refusals, the /api/terminals 409, the writer-lease middleware)
 * MUST classify against this list instead of keeping their own copy — a private
 * copy is exactly how `update_lock_contended` (the code a real concurrent
 * update raises) came to be reported as "maintenance active".
 *
 * These codes are bounded literals: they carry no paths, arguments or secrets,
 * so they are safe on the wire. The rule for membership is STATIC ENUMERABILITY,
 * not which path raises the code — reopen-path codes such as
 * `update_reopen_manifest_digest_mismatch` ARE listed. The three TEMPLATED
 * throws (`update_reopen_${label}_unsafe` and the two generation families) are
 * absent from THIS list solely because they are composed at runtime; they are
 * declared instead as anchored patterns in
 * `UPDATE_GATE_COMPOSED_REASON_CODE_PATTERNS` below, and classification covers
 * both declarations. Their earlier absence was NOT free: the comment here used
 * to claim an unlisted code "degrades safely to `update_maintenance_active`, so
 * their absence costs only precision", which was false on the path that
 * matters. `isGateDenial` answers "did the gate refuse at all?" by membership,
 * so an undeclared composed code was classified as NOT a gate denial — a real
 * refusal became a generic 500 with nothing in the log naming the gate. A
 * classifier's blind spot is a wrong answer, not a rounded one.
 *
 * "THROWN" IS NOT "PUBLISHABLE". This list answers "what can this gate raise?",
 * and every current member is safe to show a client — but that is a property
 * each code has, not one membership confers. The drift guard compares this list
 * to the throws with `deepEqual`, which makes any NEW literal publishable by
 * default: whoever adds an internal code will meet a failing test that pushes
 * them to list it. Before doing so, judge whether the code belongs on the wire;
 * if it does not, split this into "raised" and "publishable" rather than
 * widening the published vocabulary to silence a test.
 * (update-maintenance-gate.reason-codes.test.js)
 * @type {readonly string[]}
 */
export const UPDATE_GATE_REASON_CODES = Object.freeze([
    'update_bootstrap_application_identity_mismatch',
    'update_bootstrap_application_path_mismatch',
    'update_bootstrap_claim_rejected',
    'update_bootstrap_manifest_mismatch',
    'update_bootstrap_manifest_unsafe',
    'update_common_dir_unavailable',
    'update_control_state_incomplete',
    'update_database_state_unknown',
    'update_existing_control_file_unsafe',
    'update_existing_control_missing',
    'update_existing_control_unsafe',
    'update_existing_lock_unsafe',
    'update_identity_invalid',
    'update_journal_cas_mismatch',
    'update_journal_invalid',
    'update_journal_unavailable',
    'update_lock_aborted',
    'update_lock_contended',
    'update_lock_unavailable',
    'update_maintenance_active',
    'update_owner_boot_id_unavailable',
    'update_owner_start_time_unavailable',
    'update_ownership_context_invalid',
    'update_ownership_released',
    'update_ownership_token_invalid',
    'update_ownership_token_mismatch',
    'update_ownership_token_unsafe',
    'update_phase_invalid',
    'update_recovery_action_mismatch',
    'update_recovery_action_unsafe',
    'update_reopen_manifest_digest_mismatch',
    'update_reopen_manifest_identity_mismatch',
    'update_reopen_receipt_identity_mismatch',
    'update_source_state_degraded',
    'update_writer_kind_invalid',
]);

/**
 * The `label` values the gate composes `update_reopen_${label}_unsafe` from.
 *
 * Declared rather than inferred: every `readGuardedActivationJson(file, label)`
 * call site passes one of these literals, and the drift guard re-reads those
 * call sites from the source and fails if a new label appears here without
 * being declared (or a declared one disappears).
 * @type {readonly string[]}
 */
export const UPDATE_GATE_REOPEN_GUARDED_LABELS = Object.freeze([
    'manifest',
    'pair_admission_intent',
    'receipt',
]);

/**
 * The RUNTIME-COMPOSED reason codes this gate raises, as anchored patterns.
 *
 * WHY A SECOND DECLARATION: three throws interpolate a value, so they cannot be
 * enumerated as literals the way `UPDATE_GATE_REASON_CODES` is. That is a
 * limitation of the extraction, not of the vocabulary: the interpolated values
 * come from CLOSED sets this module owns (`UPDATE_GATE_REOPEN_GUARDED_LABELS`
 * and the keys of `GENERATION_PATHS`), so the full code set IS finite and IS
 * enumerable — just not by reading a string literal.
 *
 * WHY PATTERNS AND NOT A BARE PREFIX: `update_` is NOT a gate-owned namespace.
 * `server/bootstrap.js` raises `update_bootstrap_handoff_unsafe` /
 * `update_bootstrap_handoff_invalid` and `update-preflight.js` raises
 * `update_preflight_timeout`, none of which this gate ever throws. A
 * `startsWith('update_')` test would attribute those to the gate — the same
 * fabricated-root-cause bug in the opposite direction. Each pattern is
 * therefore anchored at both ends and enumerates its alternatives explicitly.
 *
 * These composed codes carry no path, no argument and no secret: the only
 * variable part is a label or a generation name drawn from the two closed sets
 * above, so they are as safe on the wire as the literals.
 * @type {readonly RegExp[]}
 */
export const UPDATE_GATE_COMPOSED_REASON_CODE_PATTERNS = Object.freeze([
    new RegExp(`^update_reopen_(?:${UPDATE_GATE_REOPEN_GUARDED_LABELS.join('|')})_unsafe$`),
    new RegExp(`^update_reopen_generation_mismatch_(?:${Object.keys(GENERATION_PATHS).join('|')})$`),
    new RegExp(`^update_reopen_generation_unrecorded_(?:${Object.keys(GENERATION_PATHS).join('|')})$`),
]);

/**
 * Does this message belong to the gate's composed reason-code vocabulary?
 *
 * @param {string} message candidate reason code
 * @returns {boolean} true only for a code one declared family can produce
 */
export function isComposedUpdateGateReasonCode(message) {
    return typeof message === 'string'
        && UPDATE_GATE_COMPOSED_REASON_CODE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The STRICT SUBSET of `UPDATE_GATE_REASON_CODES` that means "not now, ask
 * again" — and nothing else.
 *
 * A background tick (`runLocalUpdateBackground`, the usage-ingestion scheduler)
 * answers a denial by returning `null` or by sleeping and retrying. That answer
 * is only honest when the SAME call can succeed later with no human acting in
 * between. Exactly two codes have that property:
 *
 *   update_maintenance_active — an update owns the gate right now; it ends.
 *   update_lock_contended     — `flock` waited out its window while a concurrent
 *                               writer held the lock; the next tick may win it.
 *
 * Every OTHER member of the parent list is a FAULT, and must propagate:
 *   - corruption / tampering (`update_journal_invalid`, `update_journal_unavailable`,
 *     `update_ownership_token_*`, `update_existing_control_*`, `update_existing_lock_unsafe`)
 *     never heals by waiting, and swallowing it turns a broken control plane
 *     into a background job that is silently a no-op forever;
 *   - programmer errors (`update_writer_kind_invalid`, `update_identity_invalid`)
 *     are deterministic: retrying reproduces them;
 *   - `update_lock_unavailable` is "`flock` could not even be spawned" — an
 *     environment fault (missing binary, exhausted processes), not contention;
 *   - `update_lock_aborted` is the CALLER's own cancellation via its
 *     `AbortSignal`. Background ticks pass no signal, so it cannot reach them;
 *     if it ever does, the cause is a bug and must be loud.
 *
 * The COMPOSED families are absent for the same reason, stated once: an unsafe
 * activation control file and a generation tree that does not match its receipt
 * are both tampering/corruption findings. Deferral is a literal-list decision
 * on purpose, so no pattern can ever widen it by accident.
 *
 * Widening this list is therefore a decision about which real failures become
 * invisible. `update-maintenance-gate.reason-codes.test.js` pins both the
 * subset relation and these exclusions so the widening cannot be accidental.
 * @type {readonly string[]}
 */
export const UPDATE_GATE_DEFERRABLE_REASON_CODES = Object.freeze([
    'update_lock_contended',
    'update_maintenance_active',
]);

export function createUpdateMaintenanceGate({
    projectPath,
    commandRunner = spawnSync,
    recoveryRunner = rollbackStaleSourceUpdate,
    ownerAlive = ownerIsAlive,
    afterRecoveryStart = () => {},
    now = Date.now,
} = {}) {
    requireStartupAdmission();
    const paths = resolvePaths(projectPath, commandRunner);
    let initialized;
    if (paths.artifact && fs.existsSync(paths.controlRoot)) {
        const metadata=fs.lstatSync(paths.controlRoot);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid!==process.getuid() || (metadata.mode & 0o077)
            || fs.realpathSync(paths.controlRoot)!==paths.controlRoot) throw new Error('artifact_control_unsafe');
    }
    if (paths.artifact && !fs.existsSync(paths.journal)) {
        fs.mkdirSync(paths.controlRoot, { mode: 0o700, recursive: true });
        const controlMetadata=fs.lstatSync(paths.controlRoot);
        if(!controlMetadata.isDirectory() || controlMetadata.isSymbolicLink() || (controlMetadata.mode & 0o077) || controlMetadata.uid!==process.getuid()) throw new Error('artifact_control_unsafe');
        const fd = fs.openSync(paths.admissionLock, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try {
            if (spawnSync('/usr/bin/flock',['-x','-n','3'],{stdio:['ignore','ignore','ignore',fd]}).status !== 0) throw new Error('artifact_maintenance_initializing');
            if (!fs.existsSync(paths.journal)) {
                const generation = readReceipt(path.join(paths.root,'runtime-generation.json'));
                if (generation.sealKind !== 'initial-bootstrap-v1') throw new Error('artifact_initial_seal_required');
                for (const name of ['actions','receipts','job-receipts']) {
                    const directory = path.join(paths.artifact.layout.controlRoot,name);
                    if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error('artifact_initial_effects_present');
                }
            }
            initialized = ensureControl(paths);
        } finally { fs.closeSync(fd); }
    } else initialized = ensureControl(paths);

    const transition = (expectedSequence, expectedStates, patch) => {
        assertLegacyTransitionAllowed();
        const current = readJournal(paths.journal);
        if (current.sequence !== expectedSequence || !expectedStates.includes(current.state)) {
            throw new Error('update_journal_cas_mismatch');
        }
        const at = now();
        // `intervention` describes THIS transition only: it feeds the metrics and
        // is never persisted, so a later transition cannot count it again.
        const { intervention = null, ...fields } = patch;
        return durableWrite(paths.journal, {
            ...current, ...fields, ...measureRecovery(current, fields, intervention, at),
            sequence: current.sequence + 1, updatedAt: new Date(at).toISOString(),
        });
    };

    const acquireWriterLease = async ({ kind, signal, waitMs } = {}) => {
        if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) throw new Error('update_writer_kind_invalid');
        const admission = await flockAsync(paths.admissionLock, 'shared', { signal, waitMs });
        try {
            const journal = readJournal(paths.journal);
            if (journal.state !== 'OPEN' || journal.gateClosed) throw new Error('update_maintenance_active');
            validateOidPairMaintenance(paths.root, journal);
            const activity = await flockAsync(paths.activityLock, 'shared', { signal, waitMs });
            const afterActivity = readJournal(paths.journal);
            if (afterActivity.sequence !== journal.sequence || afterActivity.state !== 'OPEN' || afterActivity.gateClosed) {
                activity.release();
                throw new Error('update_maintenance_active');
            }
            admission.release();
            let released = false;
            return {
                kind, commonGitDir: paths.commonGitDir,
                release() {
                    if (released) return;
                    released = true;
                    activity.release();
                },
            };
        } catch (error) {
            admission.release();
            throw error;
        }
    };

    const beginUpdate = async (identity, { signal, waitMs } = {}) => {
        assertLegacyTransitionAllowed();
        if (identity?.kind === 'oid-pair') throw new Error('oid_pair_source_path_refused');
        if (!identity || !TOKEN.test(identity.transactionId || '') || !SHA.test(identity.originalHead || '')
            || !SHA.test(identity.targetCommit || '') || !isNassajReleaseVersion(identity.expectedVersion)) {
            throw new Error('update_identity_invalid');
        }
        const ownerIdentity = currentOwnerIdentity();
        const admission = await flockAsync(paths.admissionLock, 'exclusive', { signal, waitMs });
        let activity = null;
        try {
            let current = readJournal(paths.journal);
            const previousJournal = current;
            if (current.state !== 'OPEN' || current.gateClosed) throw new Error('update_maintenance_active');
            // ADR-156 decision 7 (ج): a degraded reopen BLOCKS the next update
            // until the source state is reconciled. Updating on top of an
            // unreconciled tree is what produces the CAS mismatch in ب.5.
            if (typeof current.degraded === 'string' && current.degraded) throw new Error('update_source_state_degraded');
            current = transition(current.sequence, ['OPEN'], {
                state: 'DRAINING', gateClosed: true, phase: 'PREPARED', databaseState: 'PRE_CANDIDATE',
                transactionId: identity.transactionId,
                identity: { expectedVersion: identity.expectedVersion, originalHead: identity.originalHead, targetCommit: identity.targetCommit, manifestSha256: identity.manifestSha256 || null, ...(identity.artifact ? { artifact: identity.artifact } : {}) },
                owner: {
                    ...ownerIdentity, tokenDigest: initialized.tokenDigest,
                    epoch: crypto.randomBytes(18).toString('base64url'),
                },
            });
            activity = await flockAsync(paths.activityLock, 'exclusive', { signal, waitMs });
            current = transition(current.sequence, ['DRAINING'], { state: 'UPDATING' });
            let released = false;
            const ownershipLease = { held: true };
            return {
                ownershipContext: {
                    transactionId: identity.transactionId, pid: process.pid,
                    startTime: ownerIdentity.startTime, epoch: current.owner.epoch, [OWNED_LEASE]: ownershipLease,
                },
                transition(expectedPhases, phase, patch = {}) {
                    if (released) throw new Error('update_ownership_released');
                    if (!PHASES.has(phase) || !expectedPhases.includes(current.phase)) throw new Error('update_phase_invalid');
                    current = transition(current.sequence, ['UPDATING'], { ...patch, phase });
                    return current;
                },
                captureArtifactSnapshot() {
                    if (released || !current.identity?.artifact) throw new Error('artifact_snapshot_ownership_required');
                    const databasePath = resolveDatabaseFilePath();
                    const snapshot = captureDatabaseSnapshot({databasePath,snapshotRoot:path.join(path.dirname(databasePath),'nassaj-update-db-snapshots'),
                        transactionId:current.transactionId,targetCommit:current.identity.targetCommit});
                    current = transition(current.sequence,['UPDATING'],{snapshotIdentitySha256:checksum(snapshot)});
                    return snapshot;
                },
                /** Where the journal really is — also after a call that threw half way (B-1126). */
                get phase() {
                    return current.phase;
                },
                prepareBootstrapHandoff(expectedPhases = ['ACTIVATION_QUEUED']) {
                    if (released) throw new Error('update_ownership_released');
                    if (!expectedPhases.includes(current.phase)) throw new Error('update_phase_invalid');
                    current = transition(current.sequence, ['UPDATING'], { phase: 'RESTARTING_HANDOFF', databaseState: 'UNKNOWN' });
                    const descriptor = {
                        schema: 'nassaj-source-update-bootstrap/v1',
                        transactionId: current.transactionId,
                        epoch: current.owner.epoch,
                        tokenFilePath: paths.token,
                    };
                    const file = path.join(paths.controlRoot, 'bootstrap-handoff.json');
                    const temporary = path.join(paths.controlRoot, `.bootstrap-handoff.${process.pid}.tmp`);
                    const fd = fs.openSync(temporary, 'wx', 0o600);
                    try { fs.writeFileSync(fd, `${JSON.stringify(descriptor)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                    fs.renameSync(temporary, file);
                    const directoryFd = fs.openSync(paths.controlRoot, 'r');
                    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
                    return { file, descriptor };
                },
                complete(patch = {}) {
                    if (released) throw new Error('update_ownership_released');
                    current = transition(current.sequence, ['UPDATING'], {
                        ...patch, state: 'OPEN', gateClosed: false, phase: 'ACTIVE_VERIFIED', owner: null,
                    });
                    this.release();
                    return current;
                },
                declareManual(reason = 'update_database_state_unknown') {
                    // B-1127: MANUAL names no owner. Keeping this living process as
                    // owner made `doctor --reopen-gate` refuse with update_owner_alive
                    // until the process died — the leases are released right below.
                    current = transition(current.sequence, ['UPDATING'], {
                        state: 'MANUAL', gateClosed: true, owner: null, recoveryError: reason,
                    });
                    this.release();
                    return current;
                },
                /**
                 * The in-process ب.5 exit after a failed rollback (qa-critic H1).
                 * Releasing with the journal still UPDATING under this living
                 * owner kept the gate closed — and the site at 503 — until a
                 * restart. Instead: reopen on the previous generation (degraded
                 * when the source stayed at target), or MANUAL with no owner.
                 */
                reopenOrDeclareManual(cause) {
                    if (released) throw new Error('update_ownership_released');
                    const decision = decidePreviousGenerationReopen(paths, current, commandRunner);
                    current = decision.eligible
                        ? applyPreviousGenerationReopen(current, decision, cause, 'automatic')
                        : transition(current.sequence, ['UPDATING'], {
                            state: 'MANUAL', gateClosed: true, owner: null,
                            recoveryError: String(cause?.message || 'rollback_failed').slice(0, 200),
                            reopenRefusedReason: decision.reason || null,
                        });
                    this.release();
                    return {
                        state: current.state, degraded: current.degraded ?? null,
                        reason: decision.eligible ? null : (decision.reason || null),
                    };
                },
                completeRollback(patch = {}) {
                    if (released) throw new Error('update_ownership_released');
                    current = transition(current.sequence, ['UPDATING'], {
                        ...patch, state: 'OPEN', gateClosed: false, phase: null,
                        transactionId: null, identity: null, owner: null,
                        ...(paths.artifact ? { phase:previousJournal.phase, transactionId:previousJournal.transactionId,
                            identity:previousJournal.identity, artifactCompletion:previousJournal.artifactCompletion || null } : {}),
                    });
                    this.release();
                    return current;
                },
                release() {
                    if (released) return;
                    released = true;
                    ownershipLease.held = false;
                    activity?.release();
                    admission.release();
                },
            };
        } catch (error) {
            activity?.release();
            try {
                const current = readJournal(paths.journal);
                if (current.state === 'DRAINING' && current.phase === 'PREPARED'
                    && current.transactionId === identity.transactionId) {
                    transition(current.sequence, ['DRAINING'], {
                        state: 'OPEN', gateClosed: false, phase: null,
                        transactionId: null, identity: null, owner: null,
                    });
                }
            } catch {
                // A failed reopen leaves the durable gate closed; recovery must
                // classify it before any writer can proceed.
            }
            admission.release();
            throw error;
        }
    };

    const claimBootstrapOwnership = async ({ transactionId, epoch, tokenFilePath, applicationPath, signal, waitMs } = {}) => {
        assertLegacyTransitionAllowed();
        if (readJournal(paths.journal).identity?.kind === 'oid-pair') throw new Error('oid_pair_source_path_refused');
        if (!TOKEN.test(transactionId || '') || !TOKEN.test(epoch || '')
            || path.resolve(tokenFilePath || '') !== paths.token) throw new Error('update_ownership_context_invalid');
        const stat = fs.lstatSync(tokenFilePath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
            throw new Error('update_ownership_token_unsafe');
        }
        const ownerIdentity = currentOwnerIdentity();
        const ownerStartTime = ownerIdentity.startTime;
        const tokenDigest = crypto.createHash('sha256').update(fs.readFileSync(tokenFilePath, 'utf8').trim()).digest('hex');
        const admission = await flockAsync(paths.admissionLock, 'exclusive', { signal, waitMs });
        const activity = await flockAsync(paths.activityLock, 'exclusive', { signal, waitMs }).catch((error) => {
            admission.release();
            throw error;
        });
        let current = readJournal(paths.journal);
        if (current.transactionId !== transactionId || current.owner?.epoch !== epoch
            || !equalDigest(tokenDigest, current.owner?.tokenDigest)
            || current.state !== 'UPDATING' || current.phase !== 'RESTARTING_HANDOFF') {
            activity.release(); admission.release();
            throw new Error('update_bootstrap_claim_rejected');
        }
        try {
            if (current.identity?.artifact) attestArtifactBootstrap(paths, current, applicationPath);
            else attestBootstrapApplication(paths, current, applicationPath);
            const databasePath = resolveDatabaseFilePath();
            const snapshot = readDatabaseSnapshot({ databasePath, snapshotRoot: path.join(path.dirname(databasePath), 'nassaj-update-db-snapshots'),
                transactionId, targetCommit: current.identity.targetCommit });
            if (current.identity?.artifact && checksum(snapshot) !== current.snapshotIdentitySha256) throw new Error('artifact_snapshot_identity_mismatch');
        } catch (error) {
            try { transition(current.sequence, ['UPDATING'], { state: 'MANUAL', gateClosed: true, owner: null, recoveryError: 'database_snapshot_unverified' }); }
            finally { activity.release(); admission.release(); }
            throw error;
        }
        current = transition(current.sequence, ['UPDATING'], {
            phase: 'BOOTSTRAP_CLAIMED', databaseState: 'UNKNOWN',
            owner: { ...current.owner, ...ownerIdentity },
        });
        let released = false;
        const ownershipLease = { held: true };
        const ownershipContext = {
            transactionId, epoch, pid: process.pid, startTime: ownerStartTime, [OWNED_LEASE]: ownershipLease,
        };
        return {
            ownershipContext, artifact: current.identity?.artifact || null,
            complete(patch = {}) {
                if (released) throw new Error('update_ownership_released');
                if (current.identity?.artifact) validateArtifactCompletion(paths, current, patch);
                current = transition(current.sequence, ['UPDATING'], {
                    ...patch, state: 'OPEN', gateClosed: false, phase: 'ACTIVE_VERIFIED', owner: null,
                });
                this.release();
                return current;
            },
            release() {
                if (released) return;
                released = true; ownershipLease.held = false; activity.release(); admission.release();
            },
        };
    };

    const recoverOrDeclareManual = async ({ ownershipContext, signal, waitMs } = {}) => {
        assertLegacyTransitionAllowed();
        const initial = readJournal(paths.journal);
        if (initial.oidAdmissionIntent) return recoverOidPairAdmission(paths.root, { waitMs });
        if (initial.identity?.kind === 'oid-pair') {
            if (initial.state === 'OPEN') { validateOidPairMaintenance(paths.root, initial); return { state: 'OPEN', recovered: false }; }
            return recoverOidPairAdmission(paths.root, { waitMs });
        }
        if (ownershipContext?.[OWNED_LEASE]?.held === true) {
            const current = readJournal(paths.journal);
            if (current.transactionId === ownershipContext.transactionId
                && current.owner?.epoch === ownershipContext.epoch
                && current.owner?.pid === ownershipContext.pid
                && current.owner?.startTime === ownershipContext.startTime) {
                return { state: current.state, recovered: true, phase: current.phase };
            }
        }
        const admission = await flockAsync(paths.admissionLock, 'exclusive', { signal, waitMs });
        const activity = await flockAsync(paths.activityLock, 'exclusive', { signal, waitMs }).catch((error) => {
            admission.release();
            throw error;
        });
        try {
            let current = readJournal(paths.journal);
            if (current.state === 'OPEN') return { state: 'OPEN', recovered: false };
            const liveness = ownerAlive(current.owner);
            if (liveness === true) {
                return { state: current.state, recovered: false, ownerAlive: true, phase: current.phase };
            }
            if (liveness === null && current.owner) {
                current = transition(current.sequence, [current.state], { state: 'MANUAL', gateClosed: true, owner: null });
                return { state: 'MANUAL', recovered: false, phase: current.phase };
            }
            if (current.identity?.artifact || current.databaseState === 'UNKNOWN' || ['RESTARTING_HANDOFF', 'BOOTSTRAP_CLAIMED'].includes(current.phase)) {
                current = transition(current.sequence, [current.state], { state: 'MANUAL', gateClosed: true, owner: null, recoveryError: 'update_database_state_unknown' });
                return { state: 'MANUAL', recovered: false, phase: current.phase };
            }
            const safelyUnstarted = ['DRAINING', 'UPDATING'].includes(current.state)
                && current.phase === 'PREPARED';
            const recoverable = ['UPDATING', 'RECOVERING'].includes(current.state)
                && RECOVERY_PHASES.has(current.phase);
            if (recoverable) {
                if (current.state === 'UPDATING') {
                    current = transition(current.sequence, ['UPDATING'], { state: 'RECOVERING', gateClosed: true, owner: null });
                    afterRecoveryStart(current);
                }
                try {
                    await recoveryRunner(paths, current);
                    current = transition(current.sequence, ['RECOVERING'], {
                        state: 'OPEN', gateClosed: false, phase: null, owner: null,
                        transactionId: null, identity: null, recovery: 'ROLLED_BACK', intervention: 'automatic',
                    });
                    return { state: 'OPEN', recovered: true, phase: 'ROLLED_BACK' };
                } catch (error) {
                    // ADR-156 ب.5 (WI-12). Before declaring MANUAL, take the one
                    // declared exit path: if the receipt proves every live
                    // generation is still the PREVIOUS one, the service is sound
                    // and the gate may reopen — degraded and named when the
                    // source tree is still at the target commit, never silently.
                    const decision = decidePreviousGenerationReopen(paths, current, commandRunner);
                    if (decision.eligible) {
                        current = applyPreviousGenerationReopen(current, decision, error, 'automatic');
                        return {
                            state: 'OPEN', recovered: true,
                            phase: decision.degraded ? 'REOPENED_PREVIOUS_DEGRADED' : 'REOPENED_PREVIOUS',
                            degraded: decision.degraded, exitPath: decision.exitPath,
                        };
                    }
                    current = transition(current.sequence, ['RECOVERING'], {
                        state: 'MANUAL', gateClosed: true, owner: null,
                        recoveryError: String(error?.message || 'rollback_failed').slice(0, 200),
                        reopenRefusedReason: decision.reason || null,
                    });
                    return { state: 'MANUAL', recovered: false, phase: current.phase };
                }
            }
            current = transition(current.sequence, [current.state], safelyUnstarted
                ? { state: 'OPEN', gateClosed: false, phase: null, transactionId: null, identity: null, owner: null, intervention: 'automatic' }
                : { state: 'MANUAL', gateClosed: true, owner: null });
            return { state: current.state, recovered: false, phase: current.phase };
        } finally {
            activity.release();
            admission.release();
        }
    };

    /**
     * Apply one ب.5 row. A full rollback clears the transaction; a degraded
     * reopen KEEPS `transactionId`/`identity`, because the exit path — finishing
     * the source rollback — needs the very commits the identity holds.
     */
    const applyPreviousGenerationReopen = (current, decision, cause = null, intervention = 'human') => {
        // No receipt means no exchange ever started; the journal alone then
        // carries the observed source state, and no receipt is invented.
        if (decision.receiptPath) writeReceiptSourceState(decision.receiptPath, decision.receipt, decision.source);
        return transition(current.sequence, [current.state], {
            state: 'OPEN', gateClosed: false, phase: null, owner: null, sourceState: decision.source,
            degraded: decision.degraded, exitPath: decision.exitPath,
            recovery: decision.degraded ? 'REOPENED_PREVIOUS_DEGRADED' : 'REOPENED_PREVIOUS', intervention,
            recoveryError: cause ? String(cause?.message || 'rollback_failed').slice(0, 200) : null,
            ...(decision.degraded ? {} : { transactionId: null, identity: null }),
        });
    };

    /**
     * The ب.6 recovery operation, also reachable from `doctor.mjs --reopen-gate`.
     * `dryRun` defaults to true so that merely calling it prints a plan and
     * changes nothing; only an explicit `dryRun: false` writes.
     */
    const reopenOnPreviousGeneration = async ({ signal, waitMs, dryRun = true } = {}) => {
        if (readJournal(paths.journal).identity?.kind === 'oid-pair') throw new Error('oid_pair_source_path_refused');
        const admission = await flockAsync(paths.admissionLock, 'exclusive', { signal, waitMs });
        const activity = await flockAsync(paths.activityLock, 'exclusive', { signal, waitMs }).catch((error) => {
            admission.release();
            throw error;
        });
        try {
            const current = readJournal(paths.journal);
            const from = {
                state: current.state, gateClosed: current.gateClosed, phase: current.phase,
                degraded: current.degraded ?? null, exitPath: current.exitPath ?? null,
                transactionId: current.transactionId, recoveryError: current.recoveryError ?? null,
            };
            if (current.state === 'OPEN' && !current.degraded) {
                return { changed: false, applied: false, reason: 'gate_already_open', from, to: null };
            }
            if (ownerAlive(current.owner) === true) {
                return { changed: false, applied: false, reason: 'update_owner_alive', from, to: null };
            }
            const decision = decidePreviousGenerationReopen(paths, current, commandRunner);
            if (!decision.eligible) {
                return { changed: false, applied: false, reason: decision.reason, source: decision.source ?? null, from, to: null };
            }
            const to = {
                state: 'OPEN', gateClosed: false, phase: null,
                degraded: decision.degraded, exitPath: decision.exitPath,
            };
            if (dryRun) return { changed: false, applied: false, reason: 'dry_run', source: decision.source, from, to };
            const next = applyPreviousGenerationReopen(current, decision);
            return {
                changed: true, applied: true, reason: null, source: decision.source, from,
                to: { state: next.state, gateClosed: next.gateClosed, phase: next.phase, degraded: next.degraded, exitPath: next.exitPath },
            };
        } finally {
            activity.release();
            admission.release();
        }
    };

    /**
     * The exit path a degraded reopen names (qa-critic H3), reachable only from
     * `doctor --reopen-gate --complete-source-rollback`. The source rollback
     * runs under the same write contract as an update — both leases held
     * exclusive, so no writer is admitted — after a write-free plan. The gate
     * stays OPEN-degraded throughout: the service runs from its generations,
     * not from the source tree, so a crash mid-write costs no outage, and a
     * re-run resumes because every path is still on one side of the CAS.
     */
    const completeSourceRollback = async ({ signal, waitMs, dryRun = true } = {}) => {
        if (readJournal(paths.journal).identity?.kind === 'oid-pair') throw new Error('oid_pair_source_path_refused');
        const admission = await flockAsync(paths.admissionLock, 'exclusive', { signal, waitMs });
        const activity = await flockAsync(paths.activityLock, 'exclusive', { signal, waitMs }).catch((error) => {
            admission.release();
            throw error;
        });
        try {
            const current = readJournal(paths.journal);
            const from = {
                state: current.state, gateClosed: current.gateClosed, phase: current.phase,
                degraded: current.degraded ?? null, exitPath: current.exitPath ?? null,
                transactionId: current.transactionId, recoveryError: current.recoveryError ?? null,
            };
            const refuse = (reason, extra = {}) => ({ changed: false, applied: false, reason, from, to: null, ...extra });
            if (current.degraded !== SOURCE_TREE_AT_TARGET || current.state !== 'OPEN' || current.gateClosed) {
                return refuse('source_rollback_not_degraded');
            }
            const { originalHead, targetCommit } = current.identity || {};
            if (!SHA.test(originalHead || '') || !SHA.test(targetCommit || '')) return refuse('update_reopen_identity_unavailable');
            if (ownerAlive(current.owner) === true) return refuse('update_owner_alive');
            const activation = await import('../../scripts/lib/source-update-activation.mjs');
            const options = { projectRoot: paths.root, originalHead, targetCommit };
            let plan;
            try { plan = activation.planSourceRollback(options); } catch (error) {
                return refuse(String(error?.message || 'source_rollback_plan_failed').slice(0, 200),
                    { source: readSourceTreeState(paths.root, current, commandRunner) });
            }
            const to = { state: 'OPEN', gateClosed: false, phase: null, degraded: null, exitPath: null };
            if (dryRun) {
                return { changed: false, applied: false, reason: 'dry_run', paths: plan.paths,
                    source: readSourceTreeState(paths.root, current, commandRunner), from, to };
            }
            let failure = null;
            try { activation.rollbackSourceManifest(options); } catch (error) { failure = error; }
            const source = readSourceTreeState(paths.root, current, commandRunner);
            if (!failure && source.treeApplied === 'original') {
                const next = transition(current.sequence, ['OPEN'], {
                    ...to, owner: null, transactionId: null, identity: null, sourceState: source,
                    recovery: 'SOURCE_ROLLBACK_COMPLETED', recoveryError: null, intervention: 'human',
                });
                return { changed: true, applied: true, reason: null, paths: plan.paths, source, from,
                    to: { state: next.state, gateClosed: next.gateClosed, phase: next.phase, degraded: next.degraded, exitPath: next.exitPath } };
            }
            const reason = String(failure?.message || 'source_rollback_incomplete').slice(0, 200);
            transition(current.sequence, ['OPEN'], { sourceState: source, recoveryError: reason });
            return { changed: true, applied: false, reason, source, from, to: null };
        } finally {
            activity.release();
            admission.release();
        }
    };

    const assertArtifactStartup = () => {
        if (!paths.artifact) return;
        const journal = readJournal(paths.journal);
        if (journal.gateClosed) return;
        const generation = readReceipt(path.join(paths.root,'runtime-generation.json'));
        if (generation.sealKind === 'initial-bootstrap-v1' && !journal.identity?.artifact) return;
        if (!journal.artifactCompletion) throw new Error('artifact_completed_identity_missing');
        validateArtifactCompletion(paths,journal,{artifactCompletion:journal.artifactCompletion});
    };
    const readPublicStatus = () => {
        const current = readJournal(paths.journal);
        if (current.state === 'OPEN') validateOidPairMaintenance(paths.root, current);
        return {
            state: current.state, phase: current.phase, gateClosed: current.gateClosed, kind: current.identity?.kind || 'source-update',
            transactionId: current.transactionId, updatedAt: current.updatedAt,
            // ADR-156 ب.5/decision 7: a degraded reopen must be visible OUTSIDE
            // the box, with its exit path, or it is a silent reopen.
            degraded: typeof current.degraded === 'string' ? current.degraded : null,
            exitPath: typeof current.exitPath === 'string' ? current.exitPath : null,
            metrics: current.metrics && typeof current.metrics === 'object' ? current.metrics : null,
        };
    };

    return Object.freeze({
        acquireWriterLease, beginUpdate, claimBootstrapOwnership, recoverOrDeclareManual,
        /** Detect a durable pre-drain OID intent even while the previous OPEN identity remains. */
        hasPendingOidAdmissionIntent() {
            const current = readJournal(paths.journal), intent = current.oidAdmissionIntent;
            if (!intent || current.state !== 'OPEN' && !['OID_DRAINING','OID_QUIESCENT'].includes(current.phase)) return false;
            const link = intent.identity;
            if (!Number.isSafeInteger(link?.sequence) || !/^[a-f0-9]{64}$/.test(link.transactionNonce || '')
                || link.journalBasename !== `nassaj-oid-control-transaction-${link.sequence}-${link.transactionNonce}.json`) throw new Error('oid_pair_admission_intent_invalid');
            try {
                const record = readGuardedActivationJson(path.join(paths.commonGitDir,link.journalBasename),'pair_admission_intent').value;
                return record.pair?.activationNotClaimed === true;
            } catch(error) { if(error.code === 'ENOENT') return true; throw error; }
        },
        /** Inspect health-only OID startup without claiming exclusive source-update ownership. */
        inspectOidBootstrapAdmission(applicationPath, runtimeNonce) {
            assertLegacyTransitionAllowed();
            return inspectPairBootstrap(paths.root, applicationPath, runtimeNonce, { databasePath: resolveDatabaseFilePath() });
        },
        reopenOnPreviousGeneration, completeSourceRollback, assertArtifactStartup, readPublicStatus, paths,
        /** Internal, checksum-validated recovery evidence; never expose ownership secrets over HTTP. */
        readRecoveryEvidence() {
            return maintenanceRecoveryEvidence(readJournal(paths.journal));
        },
    });
}

export const acquireWriterLease = (options) => createUpdateMaintenanceGate(options).acquireWriterLease(options);
export const beginUpdate = (identity, options) => createUpdateMaintenanceGate(options).beginUpdate(identity, options);
export const claimBootstrapOwnership = (options) => createUpdateMaintenanceGate(options).claimBootstrapOwnership(options);
export const recoverOrDeclareManual = (options) => createUpdateMaintenanceGate(options).recoverOrDeclareManual(options);
export const reopenOnPreviousGeneration = (options) => createUpdateMaintenanceGate(options).reopenOnPreviousGeneration(options);
export const completeSourceRollback = (options) => createUpdateMaintenanceGate(options).completeSourceRollback(options);
export const readPublicStatus = (options) => createUpdateMaintenanceGate(options).readPublicStatus();
