/**
 * Immutable OID control capsule. This source is copied byte-for-byte to the
 * server artefact as OID_CONTROL_CAPSULE.mjs and executed from captured stdin.
 * Built-ins only; capsule mode never derives roots from its own location.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
    closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, readdirSync,
    realpathSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { getBuiltinModule } from 'node:process';
import { inspectLocalUpdatePolicyGrant } from './lib/local-update-policy.mjs';
import { hashDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';
import { captureServiceOwnerObserver, observeServiceOwnerPm2, executeServiceOwnerPm2Step, serviceOwnerSlotControls, assertServiceOwnerEnvironmentCopies } from './lib/pm2-service-owner.mjs';
import { validateOidTripleTargetDescriptor, computeOidTripleTargetDigest } from './lib/oid-triple-target.mjs';
import { UPDATE_GENERATION_NAMES, reconcileUpdateGenerations } from './lib/update-generation-reconciliation.mjs';
import { verifyOidDependencyCandidate, computeDependencyContractV2 } from './lib/oid-dependency-candidate.mjs';
import {
    bootstrapClock, bootstrapJournalBinding, consumeBootstrapTicket, inspectBootstrapQualification,
    readBootstrapPinnedFile, readBootstrapPrivateFile, validateBootstrapApprovalChain, verifyBootstrapJournalBinding, verifyBootstrapTicket,
} from './lib/local-source-bootstrap-ticket.mjs';
export { inspectBootstrapQualification };

import { validateClientPublicationJournal, CLIENT_PUBLICATION_JOURNAL_SCHEMA } from './lib/client-publication-journal.mjs';
import { advanceClientServingLineageRecord } from './lib/client-publication-lineage.mjs';
import { prepareClientPublicationAssets } from './lib/client-publication-archive.mjs';
import { recordFullClientPublicationBaseline, captureClientPublicationBaseline, recordClientPublicationRollbackBaseline } from './lib/client-publication-baseline.mjs';

// v1.47.0.18 validates built-ins with `builtinModules.includes(specifier.slice(5))`.
// Node 24 lists SQLite only as `node:sqlite`, so that predecessor rejects a
// direct static import before it can activate the release. `node:process` is
// accepted by both generations; the capsule verifier permits this one exact,
// literal built-in lookup and rejects every other getBuiltinModule call.
const { DatabaseSync } = getBuiltinModule('node:sqlite');

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
// `loaded` remains readable for journals emitted by the previous capsule.
// A new transaction is terminal only once its exact runtime proof has been
// durably handed off as `served`.
const TERMINAL = new Set(['pair_rolled_back', 'pair_served', 'loaded', 'served', 'rolled_back', 'restart_deferred_restored', 'reconciled_adopted_live', 'aborted_pre_effect']);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readFd(fd, max = 4 * 1024 * 1024) {
    const bytes = readFileSync(fd);
    if (!bytes.length || bytes.length > max) throw new Error(`capsule_fd_${fd}_size_invalid`);
    return bytes;
}

function canonicalRoot(value, label) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label}_not_absolute`);
    const metadata = lstatSync(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}_unsafe`);
    const resolved = path.resolve(value);
    if (resolved !== value) throw new Error(`${label}_not_canonical`);
    return resolved;
}

function durable(file, value) {
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const directory = openSync(path.dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
}

function durableCreate(file, value) {
    const temp = `${file}.create-${process.pid}-${Date.now()}`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, file); } finally { unlinkSync(temp); }
    fsyncDir(path.dirname(file));
}

function bootstrapAbortReceipt(claimSha256, transactionNonce, recordedAt = Date.now()) {
    return { schema: 'nassaj-local-main-bootstrap-abort/v1', state: 'aborted_pre_effect', claimSha256,
        transactionNonce, recordedAt, reason: 'claim_without_transaction_journal' };
}

function validateBootstrapAbortReceipt(file, claimSha256, transactionNonce) {
    const bytes = readBootstrapPrivateFile(file), receipt = JSON.parse(bytes);
    const expected = bootstrapAbortReceipt(claimSha256, transactionNonce, receipt.recordedAt);
    if (!Number.isSafeInteger(receipt.recordedAt) || receipt.recordedAt <= 0
        || pairCanonical(receipt) !== pairCanonical(expected)
        || !bytes.equals(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`))) {
        throw new Error('oid_bootstrap_abort_receipt_invalid');
    }
    return receipt;
}

/** Test-only crash seam.  It is intentionally unavailable to a real capsule. */
function injectFailure(point) {
    if (process.env.NODE_ENV === 'test' && process.env.NASSAJ_OID_CAPSULE_CRASH_AT === point) process.kill(process.pid, 'SIGKILL');
    if (process.env.NODE_ENV === 'test' && process.env.NASSAJ_OID_CAPSULE_FAIL_AT === point) {
        throw new Error(`injected_failure:${point}`);
    }
}

function pinnedFile(file, label, expected = {}) {
    const requested = lstatSync(file);
    if (!requested.isFile() || requested.isSymbolicLink()) throw new Error(`${label}_unsafe`);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size > (expected.maxSize || 16 * 1024 * 1024)) throw new Error(`${label}_size_invalid`);
        const bytes = readFileSync(fd);
        const after = fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.ctimeMs !== after.ctimeMs || (expected.sha256 && sha(bytes) !== expected.sha256)
            || (expected.mode && (before.mode & 0o777) !== expected.mode)) throw new Error(`${label}_changed`);
        return { bytes, identity: { dev: String(before.dev), ino: String(before.ino) } };
    } finally { closeSync(fd); }
}

function pinnedJson(file, label, expected = {}) {
    return JSON.parse(pinnedFile(file, label, expected).bytes.toString('utf8'));
}

const DISPOSITION_SCHEMA = 'nassaj-oid-control-disposition/v1';
const SUCCESSOR_FIELDS = ['sequence', 'group', 'oid', 'buildId', 'controlManifestSha256', 'transactionNonce', 'actionId'];

/** Hash every regular artifact byte and mode; symlinks and special files refuse. */
export function dispositionArtifactHash(root) {
    canonicalRoot(root, 'disposition_artifact');
    const rows = [];
    function visit(directory) {
        for (const name of readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
            const file = path.join(directory, name);
            const metadata = lstatSync(file);
            if (metadata.isSymbolicLink()) throw new Error('disposition_artifact_symlink');
            if (metadata.isDirectory()) visit(file);
            else {
                const bytes = pinnedFile(file, 'disposition_artifact').bytes;
                rows.push([path.relative(root, file), `file:${metadata.mode & 0o777}:${bytes.length}`, sha(bytes)]);
            }
        }
    }
    visit(root);
    const hash = createHash('sha256');
    for (const row of rows) for (const value of row) hash.update(String(value)).update('\0');
    return hash.digest('hex');
}

function assertDispositionLock(root) {
    const file = path.join(gitControlRoot(root), 'nassaj-preview-event-mutation.lock');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('disposition_lock_unsafe');
    const locks = readFileSync('/proc/locks', 'utf8').split('\n');
    const held = locks.some((line) => {
        const fields = line.trim().split(/\s+/);
        if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE' || fields[5]?.split(':').at(-1) !== String(metadata.ino)) return false;
        let pid = Number(fields[4]);
        for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
            if (pid === process.pid) return true;
            try { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); pid = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1]); } catch { return false; }
        }
        return false;
    });
    if (!held) throw new Error('disposition_event_lock_required');
}

function sameSuccessor(left, right) {
    return SUCCESSOR_FIELDS.every((key) => left?.[key] === right?.[key]);
}

function validateSuccessor(value) {
    if (!Number.isSafeInteger(value?.sequence) || value.sequence < 1
        || value.group !== `event-${String(value.sequence).padStart(16, '0')}`
        || !HEX40.test(value.oid || '') || !HEX64.test(value.buildId || '')
        || !HEX64.test(value.controlManifestSha256 || '') || !HEX64.test(value.transactionNonce || '')
        || !(value.actionId === null || /^[a-f0-9-]{36}$/.test(value.actionId || ''))) {
        throw new Error('disposition_successor_invalid');
    }
}

/** Read an independently reviewed operator packet by exact byte hash. */
export function readDispositionPacket(root, context) {
    if (!context || !HEX64.test(context.packetSha256 || '')) throw new Error('disposition_context_required');
    const packet = pinnedJson(context.packetPath, 'disposition_packet', { sha256: context.packetSha256, maxSize: 128 * 1024 });
    if (packet.schema !== 'nassaj-oid-control-operator/v1' || packet.repoRoot !== canonicalRoot(root, 'repo_root')
        || !packet.ownerOperation || !HEX64.test(packet.original?.sha256 || '')
        || !HEX64.test(packet.original?.transactionNonce || '')) throw new Error('disposition_packet_invalid');
    validateSuccessor(packet.successor);
    if (packet.successor.transactionNonce === packet.original.transactionNonce) throw new Error('disposition_cycle');
    return packet;
}

function assertIntendedSuccessor(packet, context) {
    const intended = context.intended;
    if (!intended || intended.sequence !== packet.successor.sequence || intended.group !== packet.successor.group
        || intended.oid !== packet.successor.oid) throw new Error('disposition_intent_mismatch');
    for (const key of SUCCESSOR_FIELDS) {
        if (Object.hasOwn(intended, key) && intended[key] !== packet.successor[key]) throw new Error('disposition_intent_mismatch');
    }
}

function originalDispositionJournal(root, packet) {
    const file = path.join(gitControlRoot(root), `nassaj-oid-control-transaction-${packet.original.sequence}-${packet.original.transactionNonce}.json`);
    const bytes = pinnedFile(file, 'disposition_original', { sha256: packet.original.sha256, mode: 0o600, maxSize: 128 * 1024 }).bytes;
    const value = JSON.parse(bytes);
    if (value.schema !== 'nassaj-oid-control-transaction/v1' || value.state !== 'manual_recovery_required'
        || value.reason !== 'previous_attestation_failed' || value.transactionNonce !== packet.original.transactionNonce
        || value.sequence !== packet.original.sequence || value.group !== packet.original.group
        || value.actionId !== packet.original.actionId || value.previousOid !== packet.previous.oid
        || value.previousBuildId !== packet.previous.buildId || value.livePath !== path.join(root, 'dist-server')
        || packet.successor.sequence <= value.sequence) throw new Error('disposition_original_invalid');
    return { file, value };
}

function dispositionProcess(previous) {
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 2) throw new Error('disposition_pid_invalid');
    const stat = readFileSync(`/proc/${previous.pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const cmd = readFileSync(`/proc/${previous.pid}/cmdline`, 'utf8').split('\0');
    const environment = readFileSync(`/proc/${previous.pid}/environ`, 'utf8').split('\0');
    if (ticks !== previous.startTicks || bootId !== previous.bootId
        || (!cmd.includes(previous.entry) && !environment.includes(`pm_exec_path=${previous.entry}`))) {
        throw new Error('disposition_process_changed');
    }
    return { pid: previous.pid, startTicks: ticks, bootId, entry: previous.entry };
}

const HEALTH_OBSERVER = `
const urls = JSON.parse(process.argv[1]);
for (const url of urls) {
 const response = await fetch(url, {signal:AbortSignal.timeout(4000),redirect:'error'});
 if (!response.ok) throw Error('health_status');
 let size=0; const chunks=[];
 for await (const chunk of response.body) {size+=chunk.length;if(size>65536)throw Error('health_size');chunks.push(chunk);}
 process.stdout.write(JSON.stringify(JSON.parse(Buffer.concat(chunks)))+'\\n');
}`;

function observeDispositionHealth(packet) {
    const urls = [packet.previous.privateHealthUrl, packet.previous.publicHealthUrl];
    const privateUrl = new URL(urls[0]);
    const publicUrl = new URL(urls[1]);
    if (!['127.0.0.1', '[::1]'].includes(privateUrl.hostname) || privateUrl.protocol !== 'http:'
        || publicUrl.protocol !== 'https:' || urls.some((url) => { const parsed = new URL(url); return parsed.username || parsed.password; })) {
        throw new Error('disposition_health_url_invalid');
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', HEALTH_OBSERVER, JSON.stringify(urls)], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 140000, env: { PATH: '/usr/bin:/bin' },
    });
    if (result.status !== 0 || result.error) throw new Error('disposition_health_unavailable');
    const observations = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    if (observations.length !== 2 || observations.some((value) => value.status !== 'ok'
        || value.pid !== packet.previous.pid || value.serverLoadedBuildId !== packet.previous.buildId
        || value.serverBuildIdOnDisk !== packet.previous.buildId || value.clientBuildIdServed !== packet.previous.clientBuildId)) {
        throw new Error('disposition_health_identity_mismatch');
    }
    return observations.map((value) => ({ pid: value.pid, serverLoadedBuildId: value.serverLoadedBuildId, clientBuildIdServed: value.clientBuildIdServed }));
}

function verifyDispositionRestoration(root, packet) {
    const original = originalDispositionJournal(root, packet);
    const previous = packet.previous;
    if (previous.entry !== path.join(root, 'dist-server', previous.entryRelative || 'server/index.js')) throw new Error('disposition_entry_invalid');
    const before = dispositionProcess(previous);
    if (dispositionArtifactHash(path.join(root, 'dist-server')) !== previous.serverTreeSha256
        || dispositionArtifactHash(path.join(root, 'dist')) !== previous.clientTreeSha256) throw new Error('disposition_artifact_changed');
    const restored = provenance(path.join(root, 'dist-server'));
    if (restored.commit !== previous.oid || restored.buildId !== previous.buildId) throw new Error('disposition_provenance_changed');
    const healthProof = observeDispositionHealth(packet);
    dispositionProcess(previous);
    const candidateRoot = path.join(root, '.nassaj-local-preview/server-candidates', packet.successor.buildId);
    const manifest = pinnedJson(path.join(candidateRoot, 'OID_CONTROL_MANIFEST.json'), 'disposition_candidate', { sha256: packet.successor.controlManifestSha256 });
    const candidate = provenance(candidateRoot);
    if (candidate.commit !== packet.successor.oid || candidate.buildId !== packet.successor.buildId
        || manifest.oid !== packet.successor.oid || manifest.serverBuildId !== packet.successor.buildId) throw new Error('disposition_candidate_changed');
    return { original, process: before, health: healthProof };
}

/** Produce immutable evidence. Caller must hold the real event-mutation lock. */
export function createOidManualDisposition(root, context) {
    assertDispositionLock(root);
    const packet = readDispositionPacket(root, context);
    assertIntendedSuccessor(packet, context);
    const proof = verifyDispositionRestoration(root, packet);
    const file = path.join(gitControlRoot(root), `nassaj-oid-control-disposition-${packet.original.transactionNonce}.json`);
    const value = { schema: DISPOSITION_SCHEMA, packetSha256: context.packetSha256, original: packet.original,
        successor: packet.successor, ownerOperation: packet.ownerOperation, previous: packet.previous,
        process: proof.process, health: proof.health };
    try { durableCreate(file, value); } catch (error) {
        if (error.code !== 'EEXIST' || JSON.stringify(pinnedJson(file, 'disposition_receipt', { mode: 0o600 })) !== JSON.stringify(value)) throw error;
    }
    return { file, sha256: sha(pinnedFile(file, 'disposition_receipt', { mode: 0o600 }).bytes) };
}

/** Shared single-successor fence; an exact linked child replaces fresh old-PID checks. */
export function validateOidManualDisposition(root, transaction, context, journals) {
    if (transaction.value.state !== 'manual_recovery_required') return null;
    if (!context) return validateCompletedDisposition(root, transaction, journals);
    assertDispositionLock(root);
    const packet = readDispositionPacket(root, context);
    assertIntendedSuccessor(packet, context);
    const original = originalDispositionJournal(root, packet);
    if (original.file !== transaction.file) return null;
    const receiptFile = path.join(gitControlRoot(root), `nassaj-oid-control-disposition-${packet.original.transactionNonce}.json`);
    const bytes = pinnedFile(receiptFile, 'disposition_receipt', { mode: 0o600, maxSize: 128 * 1024 }).bytes;
    const receipt = JSON.parse(bytes);
    if (receipt.schema !== DISPOSITION_SCHEMA || receipt.packetSha256 !== context.packetSha256
        || JSON.stringify(receipt.original) !== JSON.stringify(packet.original)
        || !sameSuccessor(receipt.successor, packet.successor)
        || JSON.stringify(receipt.previous) !== JSON.stringify(packet.previous)) throw new Error('disposition_receipt_mismatch');
    const link = { originalJournalSha256: packet.original.sha256, dispositionSha256: sha(bytes), originalTransactionNonce: packet.original.transactionNonce };
    const children = journals.filter(({ value }) => value.disposition?.originalTransactionNonce === packet.original.transactionNonce);
    if (children.length > 1) throw new Error('disposition_multiple_children');
    if (children.length === 1) {
        const child = children[0].value;
        if (!sameSuccessor(child, packet.successor) || JSON.stringify(child.disposition) !== JSON.stringify(link)) throw new Error('disposition_child_mismatch');
    } else verifyDispositionRestoration(root, packet);
    return link;
}

function validateCompletedDisposition(root, transaction, journals) {
    const old = transaction.value;
    if (old.reason !== 'previous_attestation_failed' || !HEX64.test(old.transactionNonce || '')) return null;
    const children = journals.filter(({ value }) => value.disposition?.originalTransactionNonce === old.transactionNonce);
    if (children.length !== 1 || !TERMINAL.has(children[0].value.state)) return null;
    const bytes = pinnedFile(path.join(gitControlRoot(root), `nassaj-oid-control-disposition-${old.transactionNonce}.json`), 'disposition_receipt', { mode: 0o600, maxSize: 128 * 1024 }).bytes;
    const receipt = JSON.parse(bytes);
    const child = children[0].value;
    const oldSha = sha(pinnedFile(transaction.file, 'disposition_original', { mode: 0o600 }).bytes);
    if (receipt.schema !== DISPOSITION_SCHEMA || receipt.original?.sha256 !== oldSha
        || receipt.original.transactionNonce !== old.transactionNonce || receipt.original.sequence !== old.sequence
        || receipt.original.group !== old.group || receipt.original.actionId !== old.actionId
        || child.disposition.originalJournalSha256 !== oldSha || child.disposition.dispositionSha256 !== sha(bytes)
        || !sameSuccessor(child, receipt.successor) || child.sequence <= old.sequence) throw new Error('disposition_completed_chain_invalid');
    validateSuccessor(receipt.successor);
    return child.disposition;
}

/**
 * Bind a disposition successor to its pinned plan before any effect.
 *
 * The launcher record carries the exact reviewed-operator context.  We reread
 * the packet and its immutable receipt by hash, prove the *actual* control
 * request equals the pinned successor plan, and return the one-to-one link the
 * successor journal must carry from `launch_prepared` onward.  No event-lock
 * assertion is made here: `main` already runs under the launcher's flock and
 * pins the lock identity, and the flock holder is this process's ancestor, not
 * this process, so `/proc/locks` self-attribution does not apply in capsule mode.
 */
function resolveDispositionLink(root, context, request) {
    const packet = readDispositionPacket(root, context);
    assertIntendedSuccessor(packet, context);
    if (request.sequence !== packet.successor.sequence || request.group !== packet.successor.group
        || request.oid !== packet.successor.oid || request.buildId !== packet.successor.buildId
        || request.controlManifestSha256 !== packet.successor.controlManifestSha256) {
        throw new Error('disposition_request_plan_mismatch');
    }
    originalDispositionJournal(root, packet);
    const receiptFile = path.join(gitControlRoot(root), `nassaj-oid-control-disposition-${packet.original.transactionNonce}.json`);
    const bytes = pinnedFile(receiptFile, 'disposition_receipt', { mode: 0o600, maxSize: 128 * 1024 }).bytes;
    const receipt = JSON.parse(bytes);
    if (receipt.schema !== DISPOSITION_SCHEMA || receipt.packetSha256 !== context.packetSha256
        || JSON.stringify(receipt.original) !== JSON.stringify(packet.original)
        || !sameSuccessor(receipt.successor, packet.successor)) throw new Error('disposition_receipt_mismatch');
    return {
        originalJournalSha256: packet.original.sha256,
        dispositionSha256: sha(bytes),
        originalTransactionNonce: packet.original.transactionNonce,
    };
}

function git(repoRoot, args) {
    const result = spawnSync('/usr/bin/git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git_${args[0]}_failed`);
    return String(result.stdout || '').trim();
}

/** Worktree-safe control directory; capsule code must remain self-contained. */
function gitControlRoot(repoRoot) {
    const entry = lstatSync(path.join(repoRoot, '.git'));
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('git_control_entry_unsafe');
    const result = spawnSync('/usr/bin/git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: repoRoot, encoding: 'utf8',
    });
    if (result.status !== 0 || !path.isAbsolute(String(result.stdout || '').trim())) throw new Error('git_control_common_dir_unresolved');
    const reported = String(result.stdout).trim();
    const metadata = lstatSync(reported);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('git_control_common_dir_unsafe');
    const resolved = realpathSync(reported);
    if (resolved !== path.resolve(reported)) throw new Error('git_control_common_dir_redirected');
    return resolved;
}

function directDirectory(parent, requested, label) {
    const parentBefore = statSync(parent);
    const requestedMetadata = lstatSync(requested);
    if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()
        || path.dirname(requested) !== parent) throw new Error(`${label}_unsafe`);
    const resolved = realpathSync(requested);
    const after = lstatSync(requested);
    const parentAfter = statSync(parent);
    if (resolved !== requested || requestedMetadata.dev !== after.dev || requestedMetadata.ino !== after.ino
        || parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
        throw new Error(`${label}_changed`);
    }
    return resolved;
}

function exactControlState(repoRoot, options = {}) {
    const gitRoot = gitControlRoot(repoRoot);
    const request = pinnedJson(path.join(gitRoot, 'nassaj-preview-oid-control-request-v1.json'), 'control_request');
    if (request.schemaVersion !== 1 || request.action !== 'promote-and-safe-restart'
        || !Number.isSafeInteger(request.sequence) || request.sequence < 1
        || !HEX40.test(request.oid || '') || !HEX64.test(request.buildId || '')
        || !HEX64.test(request.controlManifestSha256 || '') || request.snapshotOid !== request.oid
        || request.group !== `event-${String(request.sequence).padStart(16, '0')}`) {
        throw new Error('control_request_identity_invalid');
    }
    const sequence = String(request.sequence).padStart(16, '0');
    const event = pinnedJson(path.join(gitRoot, `nassaj-preview-oid-event-control-${sequence}.json`), 'event_control');
    const consumer = pinnedJson(path.join(gitRoot, 'nassaj-preview-oid-consumer-v1.json'), 'consumer_state');
    if (event.schema !== 'nassaj-oid-control-event/v1' || event.sequence !== request.sequence
        || event.oid !== request.oid || event.snapshotOid !== request.oid || event.buildId !== request.buildId
        || event.controlManifestSha256 !== request.controlManifestSha256
        || consumer.server?.sequence !== request.sequence || consumer.server?.oid !== request.oid
        || consumer.server?.buildId !== request.buildId || consumer.server?.phase !== 'awaiting_owner'
        || consumer.server?.controlManifestSha256 !== request.controlManifestSha256) {
        throw new Error('control_state_mismatch');
    }
    const refs = git(repoRoot, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/nassaj/previews/v1/events/'])
        .split('\n').filter(Boolean);
    const serverEvents = refs.map((line) => line.match(/^refs\/nassaj\/previews\/v1\/events\/(\d{16})\/server ([a-f0-9]{40})$/))
        .filter(Boolean);
    const newest = serverEvents.at(-1);
    const general = refs.map((line) => line.match(/^refs\/nassaj\/previews\/v1\/events\/(\d{16})\/event ([a-f0-9]{40})$/))
        .filter(Boolean).find((match) => Number(match[1]) === request.sequence);
    if (!newest || Number(newest[1]) !== request.sequence || newest[2] !== request.oid
        || !general || general[2] !== request.oid
        || git(repoRoot, ['rev-parse', `refs/nassaj/previews/v1/groups/${request.group}/desired`]) !== request.oid
        || git(repoRoot, ['rev-parse', `refs/nassaj/previews/v1/groups/${request.group}/server/desired`]) !== request.oid
        || git(repoRoot, ['rev-parse', `refs/nassaj/previews/v1/groups/${request.group}/server/candidate`]) !== request.oid) {
        throw new Error('control_refs_superseded');
    }
    const snapshotParent = path.join(repoRoot, '.nassaj-local-preview', 'oid-snapshots');
    const snapshot = directDirectory(snapshotParent, path.join(snapshotParent, request.oid), 'snapshot');
    const candidateParent = path.join(repoRoot, '.nassaj-local-preview', 'server-candidates');
    const requestedArtifact = options.artifactRoot || path.join(candidateParent, request.buildId);
    const artifactRoot = requestedArtifact === path.join(repoRoot, 'dist-server')
        ? canonicalRoot(requestedArtifact, 'promoted_candidate')
        : directDirectory(candidateParent, requestedArtifact, 'candidate');
    const manifest = pinnedJson(path.join(artifactRoot, 'OID_CONTROL_MANIFEST.json'), 'candidate_manifest', {
        sha256: request.controlManifestSha256, mode: 0o444,
    });
    if (manifest.schema !== 'nassaj-oid-control-runtime/v1' || manifest.protocol !== 1
        || manifest.oid !== request.oid || manifest.serverBuildId !== request.buildId) {
        throw new Error('candidate_manifest_identity_mismatch');
    }
    const candidate = provenance(artifactRoot);
    if (candidate.commit !== request.oid || candidate.baseCommit !== request.oid
        || candidate.buildId !== request.buildId || candidate.dirty !== false) {
        throw new Error('candidate_identity_mismatch');
    }
    const inputs = pinnedJson(path.join(artifactRoot, 'SERVER_INPUT_MANIFEST.json'), 'server_input_manifest');
    if (inputs.schemaVersion !== 2 || inputs.buildId !== request.buildId || !Array.isArray(inputs.inputs)) {
        throw new Error('server_input_manifest_identity_mismatch');
    }
    for (const input of inputs.inputs) {
        if (typeof input.path !== 'string' || path.isAbsolute(input.path) || input.path.includes('..')
            || !HEX64.test(input.sha256 || '') || !Number.isInteger(input.mode)) {
            throw new Error('server_input_manifest_entry_invalid');
        }
        pinnedFile(path.join(snapshot, input.path), 'snapshot_input', {
            sha256: input.sha256, mode: input.mode & 0o777,
        });
    }
    return { request, artifactRoot, manifest };
}

function fsyncDir(directory) {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

function provenance(directory) {
    const file = path.join(directory, 'BUILD_PROVENANCE.json');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('provenance_unsafe');
    return JSON.parse(readFileSync(file, 'utf8'));
}

function exchange(left, right) {
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/mv', ['--exchange', '--no-copy', '-T', left, right], { stdio: ['ignore', 'pipe', 'pipe'] });
        let error = '';
        child.stderr.on('data', (chunk) => { error += chunk; });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exchange_failed:${error.trim()}`)));
    });
}

const SAFE_STOP_DIAGNOSTIC_CODES = new Set([
    'oid_triple_safe_context_invalid', 'oid_triple_safe_file_unsafe', 'oid_triple_safe_journal_invalid',
    'oid_triple_safe_executor_unsafe', 'oid_triple_safe_executor_changed', 'oid_triple_safe_executor_mismatch',
    'oid_triple_safe_closure_invalid', 'oid_triple_safe_closure_changed', 'oid_triple_safe_phase_not_owned',
    'oid_triple_safe_ancestry_unknown', 'oid_triple_safe_phase_foreign_process', 'oid_triple_safe_phase_invalid',
    'oid_triple_supervisor_missing', 'oid_triple_stop_not_intended', 'oid_triple_pm2_slot_ambiguous',
    'oid_triple_pm2_slot_changed', 'oid_triple_pm2_environment_changed', 'oid_triple_writer_descendant_present',
    'oid_triple_process_inventory_unknown', 'oid_triple_pm2_operation_unverified', 'oid_triple_old_process_still_alive',
    'oid_triple_pm2_authority_changed', 'oid_triple_pm2_daemon_changed', 'oid_triple_pm2_unavailable',
    'oid_triple_child_mode_changed', 'EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC', 'EMFILE',
    'oid_triple_safe_control_unavailable',
    'oid_pair_maintenance_invalid',
    'oid_pair_link_invalid',
    'oid_pair_counterpart_mismatch',
    'oid_pair_receipt_invalid',
    'oid_pair_open_unverified',
    'oid_pair_live_generation_mismatch',
    'oid_triple_live_dependencies_mismatch',
    'git_control_entry_unsafe',
    'git_control_common_dir_unresolved',
    'git_control_common_dir_unsafe',
    'oid_triple_pm2_response_invalid',
    'oid_triple_pm2_authority_invalid',
    'oid_triple_pm2_authority_exposed_write',
    'oid_triple_pm2_home_owner_invalid',
    'pair_maintenance_journal_unsafe',
    'pair_maintenance_journal_size_invalid',
    'pair_maintenance_journal_changed',
    'pair_journal_unsafe',
    'pair_journal_size_invalid',
    'pair_journal_changed',
    'triple_pm2_dump_unsafe',
    'triple_pm2_dump_size_invalid',
    'triple_pm2_dump_changed',
    'triple_pm2_dump_after_sync_unsafe',
    'triple_pm2_dump_after_sync_size_invalid',
    'triple_pm2_dump_after_sync_changed',
    'provenance_unsafe',
    'provenance_size_invalid',
    'provenance_changed',
    'oid_pair_artifact_entry_unsafe',
    'pair_maintenance_root_not_absolute',
    'pair_maintenance_root_unsafe',
    'pair_maintenance_root_not_canonical',
    'ELOOP',
    'ENOTDIR',
    'ESRCH',
    'triple_node_unsafe',
    'triple_node_size_invalid',
    'triple_node_changed',
    'triple_pm2_unsafe',
    'triple_pm2_size_invalid',
    'triple_pm2_changed',
    'triple_mode_file_unsafe',
    'triple_mode_file_size_invalid',
    'triple_mode_file_changed',
    'oid_triple_pm2_dump_invalid',
    'oid_triple_pm2_dump_slot_ambiguous',
    'oid_triple_pm2_dump_slot_changed',
    'oid_triple_pm2_dump_environment_changed',
    'oid_triple_persistence_child_changed',
    'oid_triple_persistence_stop_changed',
    'oid_triple_pm2_dump_unsafe',
    'oid_triple_pm2_persistence_changed',
    'oid_triple_pm2_dump_changed',
    'oid_triple_pm2_home_invalid',
    'oid_triple_pm2_authority_not_canonical',
    'oid_triple_supervisor_changed',
    'dependency_tree_privileged_mode',
    'dependency_tree_root_owner_mode',
    'dependency_tree_writable',
    'dependency_tree_changed',
    'dependency_tree_shared_hardlink',
    'dependency_tree_absolute_link',
    'dependency_tree_link_escape',
    'dependency_tree_unresolved_link',
    'dependency_tree_invalid_root',
    'dependency_tree_special_file',
    'oid_triple_start_not_intended',
    'oid_triple_start_generations_unverified',
    'oid_triple_stopped_slot_changed',
    'oid_triple_saved_environment_drift',
    'oid_triple_boot_environment_not_applied',
    'EPIPE',
    'ERR_STREAM_DESTROYED',
]);

const SAFE_STOP_DIAGNOSTIC_STAGES = new Set([
    'options_invalid', 'validate_stop_failed', 'native_runtime_invalid',
    'native_interpreter_mismatch', 'native_open_failed',
]);

/** Only exact closed-list error fields can cross the safe child diagnostic boundary. */
export function oidTripleSafeDiagnosticReason(error) {
    for (const value of [error?.code, error?.message]) if (SAFE_STOP_DIAGNOSTIC_CODES.has(value)) return value;
    return 'unknown';
}

/** Drain-safe bounded prefixes produce only literal diagnostic codes, never process output. */
export function createOidTripleSafeDiagnostic() {
    const prefixes = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, truncated = { stdout: false, stderr: false };
    return {
        capture(channel, chunk) {
            if (!Object.hasOwn(prefixes, channel)) throw new Error('oid_triple_diagnostic_channel_invalid');
            const remaining = 8192 - prefixes[channel].length;
            if (Buffer.byteLength(chunk) > remaining) truncated[channel] = true;
            if (remaining > 0) prefixes[channel] = Buffer.concat([prefixes[channel], Buffer.from(chunk).subarray(0, remaining)]);
        },
        summarize(status, signal) {
            let reason = 'unknown', stage = null;
            for (const channel of ['stderr','stdout']) {
                let text = prefixes[channel].toString('utf8');
                if (truncated[channel]) text = text.slice(0, text.lastIndexOf('\n') + 1);
                for (const line of text.split(/\r?\n/)) {
                    const code = line.startsWith('Error: ') ? line.slice(7) : line;
                    if (reason === 'unknown' && SAFE_STOP_DIAGNOSTIC_CODES.has(code)) reason = code;
                    if (line.startsWith('OID_TRIPLE_STOP_STAGE:') && SAFE_STOP_DIAGNOSTIC_STAGES.has(line.slice(22))) stage = line.slice(22);
                }
            }
            return { schema: 'nassaj-oid-safe-stop-diagnostic/v1',
                exitCode: Number.isInteger(status) && status >= 0 && status <= 255 ? status : null,
                signal: ['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGBUS','SIGINT','SIGPIPE'].includes(signal) ? signal : null, reason, ...(stage ? { stage } : {}) };
        },
    };
}

function runSafe(bytes, args, record) {
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/bash', ['-c', [
            'set -o pipefail',
            'script="$(/usr/bin/cat <&3)" || exit 97',
            // V2's writer guard must not see a sibling printf still feeding an unread script tail.
            args[0] === '--oid-triple-phase' && record.pair
                ? 'exec /usr/bin/bash -s -- "$@" <<< "$script"'
                : '/usr/bin/printf "%s\\n" "$script" | /usr/bin/bash -s -- "$@"',
        ].join('; '), 'capsule-safe-restart', ...args], {
            cwd: record.repoRoot,
            env: {
                ...process.env,
                NASSAJ_CAPSULE_MODE_ABI: record.capsuleModeAbi,
                ...(record.pair ? { NASSAJ_OID_PAIR_SEQUENCE: String(record.pair.sequence), NASSAJ_OID_PAIR_TARGET_DIGEST: record.pair.targetDigest,
                    NASSAJ_OID_PAIR_OWNER_ID: String(record.pair.ownerId), NASSAJ_OID_ACTION_ID: record.actionId, NASSAJ_OID_ATTEMPT_NONCE: record.transactionNonce } : {}),
                NASSAJ_CAPSULE_REPO_ROOT: record.repoRoot,
                NASSAJ_CAPSULE_ARTIFACT_ROOT: record.artifactRoot,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        });
        const diagnostic = args[0] === '--oid-triple-phase' && ['stop','start-target','start-previous'].includes(args[1]) ? createOidTripleSafeDiagnostic() : null;
        let stdout = '';
        let stderr = '';
        let pipeError = null;
        child.stdout.on('data', (chunk) => { if (diagnostic) diagnostic.capture('stdout', chunk); else stdout += chunk; });
        child.stderr.on('data', (chunk) => { if (diagnostic) diagnostic.capture('stderr', chunk); else stderr += chunk; });
        child.stdio[3].on('error', (error) => { pipeError = error; });
        child.stdio[3].end(bytes);
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ status: code, signal, stdout, stderr, pipeError, ...(diagnostic ? { diagnostic: diagnostic.summarize(code, signal) } : {}) }));
    });
}

function parseProcessStartTicks(raw) {
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

async function health(expected, attempts = 90) {
    attempts = Number(process.env.NASSAJ_OID_HEALTH_ATTEMPTS || attempts);
    const interval = Number(process.env.NASSAJ_OID_HEALTH_INTERVAL_MS || 500);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await fetch(process.env.NASSAJ_PREVIEW_HEALTH_URL || 'http://127.0.0.1:3004/health', {
                signal: AbortSignal.timeout(3_000),
            });
            const body = response.ok ? await response.json() : null;
            if (body?.status === 'ok' && body.serverLoadedOid === expected.oid
                && body.serverLoadedBuildId === expected.buildId
                && body.serverTransactionNonce === expected.transactionNonce
                && body.serverBootNonce === expected.bootNonce
                && String(body.serverProcessStartTicks || '') !== String(expected.oldStartTicks || '')) return body;
        } catch { /* restart window */ }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return null;
}

function activeTransactions(repoRoot) {
    const gitRoot = gitControlRoot(repoRoot);
    return readdirSync(gitRoot)
        .filter((name) => name.startsWith('nassaj-oid-control-transaction-') && name.endsWith('.json'))
        .map((name) => ({
            file: path.join(gitRoot, name),
            value: pinnedJson(path.join(gitRoot, name), 'transaction_journal'),
        }))
        .filter(entry => {
            if (entry.value.kind === 'client-publication' || entry.value.schema === CLIENT_PUBLICATION_JOURNAL_SCHEMA) return !validateClientPublicationJournal(repoRoot, entry).terminal;
            return ['pair_served','pair_rolled_back'].includes(entry.value.state) ? !validateOidPairTerminal(repoRoot, entry) : !TERMINAL.has(entry.value.state);
        });
}

async function rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes, alreadyRestored = false }) {
    durable(journalFile, { ...base, state: 'rollback_prepared', rollbackPreparedAt: new Date().toISOString() });
    if (!alreadyRestored) {
        await exchange(artifactRoot, liveRoot);
        fsyncDir(path.dirname(liveRoot));
    }
    const restored = provenance(liveRoot);
    if (restored.commit !== base.previousOid || restored.buildId !== base.previousBuildId) {
        durable(journalFile, { ...base, state: 'manual_recovery_required', reason: 'rollback_layout_ambiguous' });
        return false;
    }
    const rollbackBootNonce = randomBytes(32).toString('hex');
    durable(journalFile, { ...base, state: 'rollback_prepared', rollbackBootNonce, layoutRestored: true });
    const restart = await runSafe(safeBytes, [
        '--set', 'TMPDIR=/var/tmp',
        '--set', `NASSAJ_PREVIEW_TRANSACTION_NONCE=${base.transactionNonce}`,
        '--set', `NASSAJ_PREVIEW_BOOT_NONCE=${rollbackBootNonce}`,
        '--exec',
    ], { ...record, artifactRoot: liveRoot });
    if (restart.pipeError) {
        durable(journalFile, { ...base, state: 'manual_recovery_required', reason: 'rollback_fd3_incomplete' });
        return false;
    }
    if ([3, 6].includes(restart.status)) {
        durable(journalFile, { ...base, state: 'rollback_prepared', rollbackBootNonce, restartDeferred: restart.status });
        return false;
    }
    const attested = await health({
        oid: base.previousOid, buildId: base.previousBuildId,
        transactionNonce: base.transactionNonce, bootNonce: rollbackBootNonce,
        oldStartTicks: base.oldStartTicks,
    });
    if (!attested) {
        durable(journalFile, { ...base, state: 'manual_recovery_required', reason: 'previous_attestation_failed' });
        return false;
    }
    durable(journalFile, {
        ...base, state: 'rolled_back', rollbackBootNonce,
        newPid: attested.pid, newStartTicks: attested.serverProcessStartTicks,
    });
    return true;
}

async function resumeActiveTransaction(repoRoot, liveRoot, record, safeBytes, active) {
    const { file: journalFile, value: base } = active;
    const artifactRoot = directDirectory(
        path.join(repoRoot, '.nassaj-local-preview', 'server-candidates'),
        base.candidatePath, 'resume_candidate',
    );
    if (base.livePath !== liveRoot || !HEX40.test(base.oid || '') || !HEX64.test(base.buildId || '')
        || !HEX40.test(base.previousOid || '') || !HEX64.test(base.previousBuildId || '')
        || !HEX64.test(base.transactionNonce || '')) throw new Error('resume_transaction_identity_invalid');
    const live = provenance(liveRoot);
    let state = null;
    if (['launch_prepared', 'executor_ready', 'prepared'].includes(base.state)
        && live.commit === base.previousOid && live.buildId === base.previousBuildId) {
        state = 'restart_deferred_restored';
        durable(journalFile, { ...base, state, resumedAt: new Date().toISOString() });
    } else if (['prepared', 'exchanged', 'smoke_passed'].includes(base.state)
        && live.commit === base.oid && live.buildId === base.buildId) {
        // Crash seam: exchange completed after durable prepared but before the
        // promoted journal. The retained directory is the previous generation,
        // so rollback is deterministic and must not be mislabeled manual.
        await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
        state = pinnedJson(journalFile, 'resumed_journal').state;
    } else if (['recovery_prepared', 'recovered'].includes(base.state)
        && live.commit === base.oid && live.buildId === base.buildId) {
        const attested = base.bootNonce ? await health({
            oid: base.oid, buildId: base.buildId, transactionNonce: base.transactionNonce,
            bootNonce: base.bootNonce, oldStartTicks: base.oldStartTicks,
        }) : null;
        if (attested) {
            // A crash after health proof but before the journal hand-off must
            // never force a rollback.  The nonce pins this resume to exactly
            // the same transaction and makes the finalisation idempotent.
            if (base.state === 'recovery_prepared') {
                durable(journalFile, { ...base, state: 'recovered', bootNonce: base.bootNonce,
                    newPid: attested.pid, newStartTicks: attested.serverProcessStartTicks, resumedAt: new Date().toISOString() });
            }
            state = 'served';
            durable(journalFile, { ...base, state, bootNonce: base.bootNonce,
                newPid: attested.pid, newStartTicks: attested.serverProcessStartTicks, resumedAt: new Date().toISOString() });
        } else {
            await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
            state = pinnedJson(journalFile, 'resumed_journal').state;
        }
    } else if (base.state === 'rollback_prepared'
        && live.commit === base.previousOid && live.buildId === base.previousBuildId) {
        await rollbackAndAttest({
            artifactRoot, liveRoot, journalFile, base, record, safeBytes, alreadyRestored: true,
        });
        state = pinnedJson(journalFile, 'resumed_journal').state;
    } else if (base.state === 'rollback_prepared'
        && live.commit === base.oid && live.buildId === base.buildId) {
        // Rollback intent was fsynced but the exchange-back did not happen.
        await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
        state = pinnedJson(journalFile, 'resumed_journal').state;
    } else {
        state = 'manual_recovery_required';
        durable(journalFile, { ...base, state, reason: 'resume_layout_ambiguous' });
    }
    durable(record.handshakePath, {
        schema: 1, state: 'executor_ready', launcherNonce: record.transactionNonce,
        transactionNonce: base.transactionNonce, sequence: base.sequence,
        oid: base.oid, buildId: base.buildId, journalFile,
    });
    return state;
}

async function main() {
    const record = JSON.parse(readFd(4, 64 * 1024).toString('utf8'));
    const safeBytes = readFd(3);
    const repoRoot = canonicalRoot(record.repoRoot, 'repo_root');
    const liveRoot = canonicalRoot(record.liveRoot, 'live_root');
    if (liveRoot !== path.join(repoRoot, 'dist-server') || !HEX64.test(record.transactionNonce || '')
        || !HEX64.test(record.safeRestartSha256 || '') || sha(safeBytes) !== record.safeRestartSha256
        || record.capsuleModeAbi !== 'nassaj-capsule-roots/v1') {
        throw new Error('capsule_record_identity_invalid');
    }
    if (record.actionId && !HEX64.test(record.expectedBuildId || '')) {
        throw new Error('action_expected_build_required');
    }
    if (record.pair) {
        await runOidPairTransaction(record, safeBytes);
        return;
    }
    const gitRoot = gitControlRoot(repoRoot);
    const lock = lstatSync(path.join(gitRoot, 'nassaj-preview-event-mutation.lock'));
    if (!lock.isFile() || lock.isSymbolicLink() || String(lock.dev) !== record.lockIdentity?.dev
        || String(lock.ino) !== record.lockIdentity?.ino) throw new Error('event_lock_identity_mismatch');
    const active = activeTransactions(repoRoot);
    if (active.length > 1) throw new Error('multiple_oid_control_transactions_in_progress');
    if (active.length === 1) {
        if (record.actionId && record.expectedBuildId !== active[0].value.buildId) {
            throw new Error('action_candidate_superseded');
        }
        const activeLive = provenance(liveRoot);
        const control = exactControlState(repoRoot, {
            artifactRoot: activeLive.commit === active[0].value.oid
                && activeLive.buildId === active[0].value.buildId
                ? liveRoot : active[0].value.candidatePath,
        });
        if (control.request.sequence !== active[0].value.sequence
            || control.request.oid !== active[0].value.oid
            || control.request.buildId !== active[0].value.buildId
            || control.request.controlManifestSha256 !== active[0].value.controlManifestSha256) {
            throw new Error('resume_control_identity_mismatch');
        }
        await resumeActiveTransaction(repoRoot, liveRoot, record, safeBytes, active[0]);
        return;
    }
    const control = exactControlState(repoRoot);
    const { request, artifactRoot } = control;
    if (record.actionId && record.expectedBuildId !== request.buildId) {
        throw new Error('action_candidate_superseded');
    }
    if (statSync(artifactRoot).dev !== statSync(liveRoot).dev) throw new Error('candidate_cross_device');
    const candidate = provenance(artifactRoot);
    const previous = provenance(liveRoot);
    const nonce = record.transactionNonce;
    // A disposition successor pins its immutable link to the exact legacy MANUAL
    // journal *before* the first effect.  The link is fixed against the actual
    // control request, so a drifted request or a forged receipt fails closed
    // here, and only this one-to-one child can later recognise the old journal.
    const disposition = record.disposition
        ? resolveDispositionLink(repoRoot, record.disposition, request) : null;
    const journalFile = path.join(gitRoot, `nassaj-oid-control-transaction-${request.sequence}-${nonce}.json`);
    const base = {
        schema: 'nassaj-oid-control-transaction/v1', sequence: request.sequence, group: request.group,
        eventGroup: request.group,
        oid: request.oid, buildId: request.buildId, previousOid: previous.commit, previousBuildId: previous.buildId,
        candidatePath: artifactRoot, livePath: liveRoot,
        transactionNonce: nonce, controlManifestSha256: request.controlManifestSha256,
        lockIdentity: record.lockIdentity, oldPid: record.oldPid, oldStartTicks: record.oldStartTicks,
        actionId: /^[a-f0-9-]{36}$/.test(record.actionId || '') ? record.actionId : null,
        ...(disposition ? { disposition } : {}),
    };
    durableCreate(journalFile, { ...base, state: 'launch_prepared', at: new Date().toISOString() });
    durable(journalFile, { ...base, state: 'executor_ready', at: new Date().toISOString() });
    durable(record.handshakePath, {
        schema: 1, state: 'executor_ready', launcherNonce: nonce, transactionNonce: nonce,
        sequence: request.sequence, oid: request.oid, buildId: request.buildId, journalFile,
    });
    const gate1 = await runSafe(safeBytes, ['--json'], { ...record, artifactRoot });
    if (gate1.pipeError) throw new Error('pre_exchange_fd3_incomplete');
    if ([3, 6].includes(gate1.status)) {
        durable(journalFile, { ...base, state: 'restart_deferred_restored', gate: gate1.status });
        return;
    }
    if (gate1.status !== 0) throw new Error(`pre_exchange_gate_failed:${gate1.status}`);
    const rechecked = exactControlState(repoRoot);
    if (rechecked.request.sequence !== request.sequence || rechecked.request.oid !== request.oid
        || rechecked.request.buildId !== request.buildId
        || rechecked.request.controlManifestSha256 !== request.controlManifestSha256
        || rechecked.artifactRoot !== artifactRoot) throw new Error('control_changed_before_exchange');
    durable(journalFile, { ...base, state: 'prepared' });
    await exchange(artifactRoot, liveRoot);
    fsyncDir(path.dirname(liveRoot));
    const promoted = provenance(liveRoot);
    if (promoted.commit !== request.oid || promoted.buildId !== request.buildId) throw new Error('post_exchange_identity_mismatch');
    durable(journalFile, { ...base, state: 'exchanged' });
    injectFailure('after_exchange');
    const gate2 = await runSafe(safeBytes, ['--json'], { ...record, artifactRoot: liveRoot });
    if (gate2.pipeError) {
        await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
        throw new Error('post_exchange_fd3_incomplete');
    }
    if ([3, 6].includes(gate2.status)) {
        durable(journalFile, { ...base, state: 'rollback_prepared', gate: gate2.status });
        await exchange(artifactRoot, liveRoot);
        fsyncDir(path.dirname(liveRoot));
        durable(journalFile, { ...base, state: 'restart_deferred_restored', gate: gate2.status });
        return;
    }
    if (gate2.status !== 0) {
        await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
        throw new Error(`post_exchange_gate_failed:${gate2.status}`);
    }
    durable(journalFile, { ...base, state: 'smoke_passed' });
    injectFailure('after_smoke');
    const bootNonce = randomBytes(32).toString('hex');
    durable(journalFile, { ...base, state: 'recovery_prepared', bootNonce });
    const restart = await runSafe(safeBytes, [
        '--set', 'TMPDIR=/var/tmp',
        '--set', `NASSAJ_PREVIEW_TRANSACTION_NONCE=${nonce}`,
        '--set', `NASSAJ_PREVIEW_BOOT_NONCE=${bootNonce}`,
        '--exec',
    ], { ...record, artifactRoot: liveRoot });
    if (restart.pipeError) {
        await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
        return;
    }
    if ([3, 6].includes(restart.status)) {
        durable(journalFile, { ...base, state: 'rollback_prepared', gate: restart.status, bootNonce });
        await exchange(artifactRoot, liveRoot);
        fsyncDir(path.dirname(liveRoot));
        durable(journalFile, { ...base, state: 'restart_deferred_restored', gate: restart.status, bootNonce });
        return;
    }
    const attested = await health({
        oid: request.oid, buildId: request.buildId,
        transactionNonce: nonce, bootNonce, oldStartTicks: record.oldStartTicks,
    });
    if (attested) {
        durable(journalFile, {
            ...base, state: 'recovered', bootNonce,
            newPid: attested.pid, newStartTicks: attested.serverProcessStartTicks,
        });
        injectFailure('after_recovered');
        // This is deliberately last.  No caller may describe the candidate as
        // served until the new process has attested the exact OID/build/nonce.
        durable(journalFile, {
            ...base, state: 'served', bootNonce,
            newPid: attested.pid, newStartTicks: attested.serverProcessStartTicks,
        });
        injectFailure('after_served');
        return;
    }
    await rollbackAndAttest({ artifactRoot, liveRoot, journalFile, base, record, safeBytes });
}

// Explicit main-entry guard.  The capsule is only ever executed as captured raw
// bytes through `node --input-type=module -`, where `process.argv[1] === '-'`.
// Importing this module for its exported disposition validator (see
// `oid-control-journal.mjs`) therefore runs no side effects, and the guard never
// derives a root from the module's own location — the capsule stays
// self-locating-free and builtins-only.


// ADR-160 pair admission primitives live in the capsule's sealed builtins-only
// closure. Maintenance and bootstrap import these exact validators for parity.
const PAIR_PHASES = new Set(['OID_DRAINING', 'OID_QUIESCENT', 'OID_EXCHANGING',
    'OID_BOOTSTRAP_VERIFYING', 'OID_PAIR_VERIFIED', 'OID_RECOVERING']);

function pairCanonical(value) {
    if (Array.isArray(value)) return `[${value.map(pairCanonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${pairCanonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function pairChecksum(value) {
    const { checksum: ignored, ...fields } = value;
    return sha(pairCanonical(fields));
}

function pairPaths(root) {
    const gitRoot = gitControlRoot(root);
    const controlRoot = path.join(gitRoot, 'nassaj-source-update');
    canonicalRoot(controlRoot, 'pair_maintenance_root');
    return { root, gitRoot, controlRoot, journal: path.join(controlRoot, 'journal.json'),
        admission: path.join(controlRoot, 'admission.lock'), activity: path.join(controlRoot, 'activity.lock') };
}

function pairReadMaintenance(paths) {
    const value = pinnedJson(paths.journal, 'pair_maintenance_journal', { mode: 0o600 });
    if (value.schema !== 'nassaj-source-update-maintenance/v1' || value.checksum !== pairChecksum(value)
        || !Number.isSafeInteger(value.sequence)) throw new Error('oid_pair_maintenance_invalid');
    return value;
}

function pairWriteMaintenance(paths, before, patch) {
    const current = pairReadMaintenance(paths);
    if (current.sequence !== before.sequence || current.checksum !== before.checksum) throw new Error('oid_pair_maintenance_cas');
    const next = { ...current, ...patch, sequence: current.sequence + 1, updatedAt: new Date().toISOString() };
    next.checksum = pairChecksum(next);
    durable(paths.journal, next);
    return next;
}

function pairProcessIdentity(pid = process.pid) {
    return { pid, startTime: processStartTicks(pid),
        bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}

function pairOwnerAlive(owner) {
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.startTime !== 'string' || !/^\d+$/.test(owner.startTime)) return false;
    try { return owner?.bootId === readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        && owner.startTime === processStartTicks(owner.pid); } catch { return false; }
}

function pairJournal(paths, identity) {
    if (!Number.isSafeInteger(identity?.sequence) || identity.sequence < 1 || !HEX64.test(identity.transactionNonce || '')
        || identity.journalBasename !== `nassaj-oid-control-transaction-${identity.sequence}-${identity.transactionNonce}.json`) {
        throw new Error('oid_pair_link_invalid');
    }
    const file = path.join(paths.gitRoot, identity.journalBasename);
    const bytes = pinnedFile(file, 'pair_journal').bytes;
    const value = JSON.parse(bytes);
    const triple = value.pair?.target?.schema === 'nassaj-oid-triple-target/v2';
    if (value.schema !== (triple ? 'nassaj-oid-control-transaction/v2' : 'nassaj-oid-control-transaction/v1')
        || (triple && JSON.stringify(value.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES)) || value.sequence !== identity.sequence
        || value.transactionNonce !== identity.transactionNonce || value.pair?.targetDigest !== identity.targetDigest
        || value.oid !== identity.oid || value.pair?.target?.clientBuildId !== identity.targetClientBuildId
        || value.pair?.target?.serverBuildId !== identity.targetServerBuildId) throw new Error('oid_pair_counterpart_mismatch');
    return { file, bytes, value };
}

/** The sole checksum/receipt validator used by capsule, maintenance readers and bootstrap. */
export function validateOidPairMaintenance(root, maintenance) {
    if (maintenance.identity?.kind !== 'oid-pair') return null;
    const paths = pairPaths(root), identity = maintenance.identity.oid;
    if (maintenance.checksum !== pairChecksum(maintenance) || !PAIR_PHASES.has(maintenance.phase)) throw new Error('oid_pair_maintenance_invalid');
    const journal = pairJournal(paths, identity);
    if (['pair_served','pair_rolled_back'].includes(journal.value.state) && !validateOidPairTerminal(root, journal)) throw new Error('oid_pair_receipt_invalid');
    if (!maintenance.gateClosed || maintenance.state === 'OPEN') {
        const completion = maintenance.oidCompletion, receipt = journal.value.pair?.receipt;
        const rollback = journal.value.state === 'pair_rolled_back';
        const verified = rollback ? journal.value.pair.previous : journal.value.pair.target;
        if (maintenance.gateClosed || maintenance.state !== 'OPEN' || !['pair_served','pair_rolled_back'].includes(journal.value.state)
            || !completion || !receipt || completion.terminalJournalSha256 !== sha(journal.bytes)
            || completion.receiptSha256 !== sha(pairCanonical(receipt)) || receipt.targetDigest !== identity.targetDigest
            || receipt.transactionNonce !== identity.transactionNonce || completion.transactionNonce !== identity.transactionNonce
            || receipt.clientBuildId !== verified.clientBuildId || receipt.serverBuildId !== verified.serverBuildId
            || receipt.outcome !== (rollback ? 'rolled_back' : 'activated')
            || maintenance.databaseState !== (rollback ? 'PRE_CANDIDATE' : 'TARGET_VERIFIED')) throw new Error('oid_pair_open_unverified');
    }
    return journal.value;
}

async function pairLock(file, waitMs = 30000) {
    const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022)) { closeSync(fd); throw new Error('oid_pair_lock_unsafe'); }
    const child = spawn('/usr/bin/flock', ['-x', '-w', String(waitMs / 1000), '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    try {
        await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve() : reject(new Error('oid_pair_lock_contended')));
        });
    } catch (error) { closeSync(fd); throw error; }
    let released = false;
    return { release() { if (released) return; released = true; closeSync(fd); } };
}

/** Acquire admission before activity; retain ownership in the capsule, never hand EX to the child. */
export async function beginOidPairAdmission(root, identity, { waitMs = 30000, intent = null } = {}) {
    const paths = pairPaths(root);
    if (process.env.NASSAJ_UPDATE_MODE !== 'local-main' || !HEX40.test(identity?.oid || '')
        || !HEX64.test(identity?.targetDigest || '') || !HEX64.test(identity?.transactionNonce || '')
        || !Number.isSafeInteger(identity.sequence) || identity.sequence < 1
        || identity.group !== `event-${String(identity.sequence).padStart(16, '0')}`
        || !HEX64.test(identity.targetClientBuildId || '') || !HEX64.test(identity.targetServerBuildId || '')
        || identity.journalBasename !== `nassaj-oid-control-transaction-${identity.sequence}-${identity.transactionNonce}.json`) throw new Error('oid_pair_identity_invalid');
    if (process.env.NASSAJ_STARTUP_ADMISSION_FD || process.env.NASSAJ_UPDATE_CAPABILITY_FILE) throw new Error('oid_pair_root_runtime_refused');
    const admission = await pairLock(paths.admission, waitMs);
    const held = [admission];
    let current;
    let original;
    try {
        current = pairReadMaintenance(paths);
        original = current;
        if (current.state !== 'OPEN' || current.gateClosed || current.degraded) throw new Error('oid_pair_maintenance_busy');
        validateOidPairMaintenance(root, current);
        if (current.oidAdmissionIntent) throw new Error('oid_pair_admission_intent_pending');
        if (intent) {
            current = pairWriteMaintenance(paths, current, { oidAdmissionIntent: { schema: 'nassaj-oid-admission-intent/v1',
                identity, owner: pairProcessIdentity(), previousMaintenance: original, transaction: intent } });
            injectFailure('pair_after_admission_intent');
        }
        current = pairWriteMaintenance(paths, current, { state: 'DRAINING', gateClosed: true, phase: 'OID_DRAINING',
            transactionId: identity.transactionNonce, identity: { kind: 'oid-pair', oid: identity },
            owner: { ...pairProcessIdentity(), epoch: identity.transactionNonce, tokenDigest: current.tokenDigest },
            databaseState: 'PRE_CANDIDATE', oidCompletion: null });
        injectFailure('pair_after_draining');
        held.push(await pairLock(paths.activity, waitMs));
        current = pairWriteMaintenance(paths, current, { state: 'UPDATING', phase: 'OID_QUIESCENT' });
        injectFailure('pair_after_quiescent');
        let released = false;
        return { paths, original, get journal() { return current; },
            transition(patch) { if (released) throw new Error('oid_pair_ownership_released'); current = pairWriteMaintenance(paths, current, patch); return current; },
            async lockPublishers() {
                for (const name of ['nassaj-local-preview-build.lock', 'nassaj-client-build.lock', 'nassaj-preview-event-mutation.lock']) held.push(await pairLock(path.join(paths.gitRoot, name), waitMs));
            },
            release() { if (released) return; released = true; for (const lock of held.reverse()) lock.release(); },
        };
    } catch (error) {
        // No artifact effect exists here. A counterpart is not required to
        // restore the exact pre-drain state before ownership was returned.
        if (!intent && current?.phase === 'OID_DRAINING' && current.transactionId === identity.transactionNonce) {
            try {
                const { checksum: oldChecksum, sequence: oldSequence, ...previous } = original;
                pairWriteMaintenance(paths, current, previous);
            } catch {}
        }
        for (const lock of held.reverse()) lock.release();
        throw error;
    }
}

/** Bootstrap-only lock composition: all fences and the one-shot claim precede the first maintenance write. */
async function beginBootstrapOidAdmission(root, identity, intent, claimOperation, waitMs = 30000) {
    if (process.env.NASSAJ_UPDATE_MODE !== 'release' || typeof claimOperation !== 'function') throw new Error('oid_bootstrap_admission_context_invalid');
    const paths = pairPaths(root), held = [], publisherNames = ['nassaj-local-preview-build.lock','nassaj-client-build.lock','nassaj-preview-event-mutation.lock'];
    let current, original, consumed, claimedTransaction, maintenanceWritten = false, released = false;
    try {
        held.push(await pairLock(paths.admission, waitMs));
        held.push(await pairLock(paths.activity, waitMs));
        for (const name of publisherNames) held.push(await pairLock(path.join(paths.gitRoot, name), waitMs));
        current = pairReadMaintenance(paths); original = current;
        if (current.state !== 'OPEN' || current.gateClosed || current.degraded || current.oidAdmissionIntent) throw new Error('oid_pair_maintenance_busy');
        validateOidPairMaintenance(root, current);
        consumed = await claimOperation();
        if (!consumed?.claim || !consumed.ticket || !HEX64.test(consumed.sha256 || '')) throw new Error('oid_bootstrap_claim_invalid');
        claimedTransaction = { ...intent, bootstrapPending: false, bootstrap: bootstrapJournalBinding(consumed.ticket, consumed) };
        durableCreate(path.join(paths.gitRoot, identity.journalBasename), claimedTransaction);
        current = pairWriteMaintenance(paths, current, { oidAdmissionIntent: { schema: 'nassaj-oid-admission-intent/v1',
            identity, owner: pairProcessIdentity(), previousMaintenance: original, transaction: claimedTransaction } }); maintenanceWritten = true;
        injectFailure('bootstrap_after_admission_intent');
        current = pairWriteMaintenance(paths, current, { state: 'DRAINING', gateClosed: true, phase: 'OID_DRAINING',
            transactionId: identity.transactionNonce, identity: { kind: 'oid-pair', oid: identity },
            owner: { ...pairProcessIdentity(), epoch: identity.transactionNonce, tokenDigest: current.tokenDigest },
            databaseState: 'PRE_CANDIDATE', oidCompletion: null });
        injectFailure('bootstrap_after_draining');
        current = pairWriteMaintenance(paths, current, { state: 'UPDATING', phase: 'OID_QUIESCENT' });
        return { paths, original, consumed, claimedTransaction, get journal() { return current; },
            transition(patch) { if (released) throw new Error('oid_pair_ownership_released'); current = pairWriteMaintenance(paths, current, patch); return current; },
            async lockPublishers() {},
            release() { if (released) return; released = true; for (const lock of held.reverse()) lock.release(); } };
    } catch (error) {
        if (consumed && !maintenanceWritten) {
            const file = path.join(path.dirname(consumed.file), 'bootstrap-aborted-pre-effect.json');
            durableCreate(file, bootstrapAbortReceipt(consumed.sha256, identity.transactionNonce));
            const journal = path.join(paths.gitRoot, identity.journalBasename);
            if (fs.existsSync(journal)) durable(journal, { ...claimedTransaction, state: 'aborted_pre_effect' });
        }
        for (const lock of held.reverse()) lock.release();
        throw error;
    }
}

/** Publish OPEN only after a durable terminal pair receipt; repeated completion is idempotent. */
export function completeOidPairAdmission(root, handle) {
    const current = pairReadMaintenance(handle.paths);
    if (current.identity?.oid?.transactionNonce !== handle.journal.identity?.oid?.transactionNonce) throw new Error('oid_pair_completion_superseded');
    if (current.state === 'OPEN') { validateOidPairMaintenance(root, current); return current; }
    const identity = current.identity?.oid;
    if (!identity || !pairOwnerAlive(current.owner) || current.owner.pid !== process.pid) throw new Error('oid_pair_owner_mismatch');
    const terminal = pairJournal(handle.paths, identity), receipt = terminal.value.pair?.receipt;
    const rollback = terminal.value.state === 'pair_rolled_back';
    const verified = rollback ? terminal.value.pair.previous : terminal.value.pair.target;
    pairVerifyLive(root, { ...identity, targetClientBuildId: verified.clientBuildId, targetServerBuildId: verified.serverBuildId }, verified);
    if (!['pair_served','pair_rolled_back'].includes(terminal.value.state) || receipt?.outcome !== (rollback ? 'rolled_back' : 'activated')) throw new Error('oid_pair_terminal_required');
    const patch = { state: 'OPEN', gateClosed: false, phase: 'OID_PAIR_VERIFIED', databaseState: rollback ? 'PRE_CANDIDATE' : 'TARGET_VERIFIED', owner: null,
        oidAdmissionIntent: null, oidCompletion: { transactionNonce: identity.transactionNonce, targetDigest: identity.targetDigest,
            terminalJournalSha256: sha(terminal.bytes), receiptSha256: sha(pairCanonical(receipt)) } };
    const proposed = { ...current, ...patch }; proposed.checksum = pairChecksum(proposed);
    validateOidPairMaintenance(root, proposed);
    const result = handle.transition(patch);
    handle.release();
    return result;
}

/** Grant the exact candidate child health-only startup without acquiring the parent's exclusive locks. */
export function inspectOidBootstrapAdmission(root, applicationPath, runtimeNonce = process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE, { databasePath } = {}) {
    const paths = pairPaths(root), maintenance = pairReadMaintenance(paths);
    if (maintenance.identity?.kind !== 'oid-pair') return null;
    const journal = validateOidPairMaintenance(root, maintenance), identity = maintenance.identity.oid;
    if (maintenance.state === 'OPEN') return null;
    const rollback = journal.schema === 'nassaj-oid-control-transaction/v2' && journal.bootDirection === 'previous' && journal.pair.databaseState === 'PRE_CANDIDATE';
    const databaseState = rollback ? 'PRE_CANDIDATE' : 'UNKNOWN';
    if (maintenance.phase !== 'OID_BOOTSTRAP_VERIFYING' || maintenance.databaseState !== databaseState
        || identity.transactionNonce !== runtimeNonce || !pairOwnerAlive(maintenance.owner)
        || maintenance.owner.pid === process.pid || journal.pair?.databaseState !== databaseState) throw new Error('oid_pair_bootstrap_not_granted');
    if (applicationPath !== path.join(root, 'dist-server/server/application.js')
        || realpathSync(applicationPath) !== applicationPath) throw new Error('oid_pair_bootstrap_application_invalid');
    const snapshot = journal.pair.snapshot;
    if (!databasePath || snapshot?.databasePath !== path.resolve(databasePath) || snapshot.transactionId !== runtimeNonce
        || snapshot.targetCommit !== identity.oid || snapshot.phase !== 'CAPTURED'
        || sha(pinnedFile(snapshot.snapshotFile, 'pair_bootstrap_snapshot', { mode: 0o600, maxSize: Number.MAX_SAFE_INTEGER }).bytes) !== snapshot.snapshotFingerprint?.sha256) throw new Error('oid_pair_bootstrap_database_unverified');
    const database = lstatSync(databasePath);
    if (!database.isFile() || database.isSymbolicLink() || String(database.dev) !== snapshot.sourceIdentity?.dev
        || String(database.ino) !== snapshot.sourceIdentity?.ino) throw new Error('oid_pair_bootstrap_database_changed');
    const selected = rollback ? journal.pair.previous : journal.pair.target;
    pairVerifyLive(root, { ...identity, targetServerBuildId: selected.serverBuildId, targetClientBuildId: selected.clientBuildId }, selected);
    const manifest = pinnedJson(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), 'pair_bootstrap_manifest', { sha256: selected.controlManifestSha256 });
    const triple = journal.pair.target.schema === 'nassaj-oid-triple-target/v2';
    if (triple) {
        if (rollback) {
            if (manifest.capabilities?.oidTripleAdmissionV2 !== true) throw new Error('oid_triple_previous_bootstrap_unavailable');
        } else verifyOidTripleManifest(manifest, selected);
        assertOidTripleRuntime(selected.installRuntime);
    } else if (manifest.capabilities?.oidPairAdmissionV1 !== true) throw new Error('oid_pair_bootstrap_capability_missing');
    if (!triple && (!HEX64.test(manifest.runtimeDependenciesSha256 || '')
        || hashOidPairDependencyTree(path.join(root, 'node_modules')) !== manifest.runtimeDependenciesSha256)) throw new Error('oid_pair_dependency_baseline_unverified');
    const loaded = provenance(path.join(root, 'dist-server'));
    const client = provenance(path.join(root, 'dist'));
    if (loaded.commit !== (rollback ? selected.runtime.oid : identity.oid) || loaded.buildId !== selected.serverBuildId
        || client.commit !== (rollback ? selected.clientOid : identity.oid) || client.buildId !== selected.clientBuildId) throw new Error('oid_pair_bootstrap_generation_mismatch');
    const tripleFields = triple ? { rollback, generationNames: UPDATE_GENERATION_NAMES, nodeModulesTreeSha256: selected.nodeModulesTreeSha256 } : {};
    const grant = { schema: triple ? 'nassaj-oid-triple-bootstrap/v2' : 'nassaj-oid-pair-bootstrap/v1', ...tripleFields, ...pairProcessIdentity(), transactionNonce: runtimeNonce,
        targetDigest: identity.targetDigest, serverBuildId: loaded.buildId, clientBuildId: client.buildId };
    const grantFile = path.join(paths.controlRoot, `oid-child-${runtimeNonce}.json`);
    try { durableCreate(grantFile, grant); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (pairCanonical(pinnedJson(grantFile, 'pair_child_grant')) !== pairCanonical(grant)) throw new Error('oid_pair_child_already_claimed');
    }
    const isOpen = () => {
        const next = pairReadMaintenance(paths);
        validateOidPairMaintenance(root, next);
        return next.state === 'OPEN' && next.identity?.oid?.transactionNonce === runtimeNonce;
    };
    return Object.freeze({ kind: 'oid-pair', schema: grant.schema, ...tripleFields, sequence: identity.sequence, targetDigest: identity.targetDigest,
        transactionNonce: runtimeNonce, serverBuildId: loaded.buildId, clientBuildId: client.buildId,
        normalAdmissionReady: false, isOpen,
        async waitForOpen({ signal, timeoutMs = 120000 } = {}) {
            const deadline = Date.now() + timeoutMs;
            while (!signal?.aborted && Date.now() < deadline) {
                if (isOpen()) return pairReadMaintenance(paths).oidCompletion;
                const current = pairReadMaintenance(paths);
                if (pairOwnerProvablyDead(current.owner)) await recoverOidPairAdmission(root);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('oid_pair_open_wait_expired');
        },
    });
}

/** Hash a pinned regular-file generation; shared with pair bootstrap and completion checks. */
export function hashOidPairTree(directory) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const entries = [];
    function walk(parent, prefix = '') {
        for (const name of readdirSync(parent).sort()) {
            const file = path.join(parent, name), relative = `${prefix}${name}`;
            const child = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const st = fstatSync(child);
                if (st.isDirectory()) walk(`/proc/self/fd/${child}`, `${relative}/`);
                else if (st.isFile()) entries.push([relative, sha(readFileSync(child))]);
                else throw new Error('oid_pair_artifact_entry_unsafe');
            } finally { closeSync(child); }
        }
    }
    try { walk(`/proc/self/fd/${fd}`); } finally { closeSync(fd); }
    return sha(JSON.stringify(entries));
}

function pairVerifyLive(root, identity, target) {
    const server = path.join(root, 'dist-server'), client = path.join(root, 'dist');
    if (hashOidPairTree(client) !== target.clientTreeSha256 || hashOidPairTree(server) !== target.serverTreeSha256
        || provenance(server).buildId !== identity.targetServerBuildId || provenance(client).buildId !== identity.targetClientBuildId) {
        throw new Error('oid_pair_live_generation_mismatch');
    }
    if (['nassaj-oid-triple-target/v2','nassaj-oid-triple-previous/v2'].includes(target.schema)
        && hashDependencyTreeV2(path.join(root, 'node_modules'), { requireSealed: target.schema === 'nassaj-oid-triple-target/v2' }).sha256 !== target.nodeModulesTreeSha256) throw new Error('oid_triple_live_dependencies_mismatch');
}

function verifyOidTripleManifest(manifest, target) {
    validateOidTripleTargetDescriptor(target);
    const dependency = manifest.dependencyGenerationV2;
    if (manifest.capabilities?.oidTripleAdmissionV2 !== true || dependency?.schema !== 'nassaj-oid-dependency-generation/v2') throw new Error('triple_activation_unavailable');
    for (const key of ['nodeModulesTreeSha256','dependencyContractSha256','packageJsonSha256','packageLockSha256','installPolicySha256','installRuntime']) {
        if (pairCanonical(dependency[key]) !== pairCanonical(target[key])) throw new Error('oid_triple_manifest_dependencies_mismatch');
    }
    if (computeDependencyContractV2(dependency) !== target.dependencyContractSha256) throw new Error('oid_triple_dependency_contract_invalid');
}

/** Bind a triple candidate to the actual stable interpreter before any application import. */
export function assertOidTripleRuntime(runtime) {
    if (!runtime || runtime.nodeVersion !== process.version || runtime.nodeModuleAbi !== process.versions.modules
        || runtime.napi !== process.versions.napi || runtime.platform !== process.platform || runtime.arch !== process.arch
        || sha(pinnedFile(realpathSync(process.execPath), 'triple_node_binary', { maxSize: Number.MAX_SAFE_INTEGER }).bytes) !== runtime.nodeBinarySha256) {
        throw new Error('oid_triple_runtime_mismatch');
    }
    return true;
}

const OID_NATIVE_PROBE_PROGRAM = `
const assert = require('node:assert/strict');
const loaded = [];
for (const name of ['bcrypt','argon2','better-sqlite3','esbuild','sharp','@vscode/ripgrep','node-pty','unrs-resolver']) {
  const module = require('/deps/node_modules/' + name);
  if (name === 'better-sqlite3') { const db = new module(':memory:'); try { assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1); } finally { db.close(); } }
  if (name === 'bcrypt') { const digest = module.hashSync('isolated-native-probe', 4); assert.equal(module.compareSync('isolated-native-probe', digest), true); }
  loaded.push(name);
}
process.stdout.write(JSON.stringify({schema:'nassaj-oid-native-probe/v2',loaded,nodeVersion:process.version,nodeModuleAbi:process.versions.modules}));
`;

const OID_NATIVE_PROBE_NAMESPACE = `
set -euo pipefail
probe_root="$1"; dependencies="$2"; native_program="$3"; original_home="$4"; node_binary="$5"
mount --make-rprivate /
mount --bind "$probe_root" "$probe_root"
mount --rbind -o ro=recursive /usr "$probe_root/usr"
mount --rbind -o ro=recursive "$dependencies" "$probe_root/deps/node_modules"
LIBMOUNT_FORCE_MOUNT2=always mount -t proc -o ro,nosuid,nodev,noexec proc "$probe_root/proc"
for device in null zero random urandom; do
  mount --bind "/dev/$device" "$probe_root/dev/$device"
  mount -o remount,bind,ro "$probe_root/dev/$device"
done
mount --bind "$probe_root/tmp" "$probe_root/tmp"
mount --bind "$probe_root$original_home" "$probe_root$original_home"
mount -o remount,bind,ro "$probe_root"
exec /usr/sbin/chroot "$probe_root" /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$node_binary" --input-type=commonjs -e "$native_program"
`;

function prepareOidNativeProbeRoot(root, nonce) {
    if (!HEX64.test(nonce || '') || !path.isAbsolute(process.env.HOME || '') || process.env.HOME === '/') throw new Error('oid_native_probe_context_invalid');
    const parent = path.join(gitControlRoot(root), 'nassaj-oid-native-probes');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (realpathSync(parent) !== parent || lstatSync(parent).uid !== process.getuid()
        || (lstatSync(parent).mode & 0o777) !== 0o700 || Number(fs.statfsSync(parent).type) === 0x01021994) throw new Error('oid_native_probe_storage_unsafe');
    const directory = fs.mkdtempSync(path.join(parent, `${nonce}-`));
    for (const name of ['usr','deps/node_modules','proc','dev','tmp',process.env.HOME.slice(1)]) fs.mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
    for (const name of ['lib','lib64','bin','sbin']) {
        const host = path.join('/', name);
        if (lstatSync(host).isSymbolicLink() && !path.isAbsolute(readlinkSync(host))) fs.symlinkSync(readlinkSync(host), path.join(directory, name));
        else throw new Error('oid_native_probe_platform_unsupported');
    }
    for (const name of ['null','zero','random','urandom']) writeFileSync(path.join(directory, 'dev', name), '', { mode: 0o600 });
    return directory;
}

/** Run fixed native probes in a separate root with no application/database mounts or host network. */
export function runOidTripleNativeProbe(root, dependencies, expected, { timeoutMs = 30000 } = {}) {
    assertOidTripleRuntime(expected.installRuntime);
    const nodeBinary = realpathSync(process.execPath);
    if (!nodeBinary.startsWith('/usr/') || realpathSync(dependencies) !== dependencies
        || hashDependencyTreeV2(dependencies, { requireSealed: true }).sha256 !== expected.nodeModulesTreeSha256) throw new Error('oid_native_probe_identity_invalid');
    const directory = prepareOidNativeProbeRoot(root, expected.transactionNonce);
    try {
        const result = spawnSync('/usr/bin/setpriv', ['--pdeathsig=SIGKILL', '/usr/bin/bash', '-c',
            '[ "$PPID" -eq "$1" ] || exit 97; shift; exec /usr/bin/unshare "$@"', 'oid-native-parent', String(process.pid),
            '--user','--map-root-user','--mount','--net','--pid','--fork','--kill-child=SIGKILL',
            '/usr/bin/bash','-c',OID_NATIVE_PROBE_NAMESPACE,'oid-native-probe',directory,dependencies,OID_NATIVE_PROBE_PROGRAM,process.env.HOME,nodeBinary], {
            cwd: directory, env: { PATH: '/usr/bin:/usr/sbin', HOME: process.env.HOME, TMPDIR: '/tmp', LANG: 'C.UTF-8' },
            encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
        });
        if (result.status !== 0 || result.error || result.signal) throw new Error('oid_native_probe_isolation_or_abi_failed');
        if (hashDependencyTreeV2(dependencies, { requireSealed: true }).sha256 !== expected.nodeModulesTreeSha256) throw new Error('oid_native_probe_dependencies_changed');
        const proof = JSON.parse(result.stdout);
        if (proof.schema !== 'nassaj-oid-native-probe/v2' || proof.nodeVersion !== process.version
            || proof.nodeModuleAbi !== process.versions.modules || proof.loaded?.length !== 8) throw new Error('oid_native_probe_proof_invalid');
        return { ...proof, nodeModulesTreeSha256: expected.nodeModulesTreeSha256, processExited: true };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

/** Inspect all three path pairs before producing any exchange action, including missing done receipts. */
export function inspectOidTripleGenerationPlan(root, transaction, direction) {
    const target = validateOidTripleTargetDescriptor(transaction.pair?.target);
    const previous = transaction.pair?.previous, generations = {};
    if (transaction.schema !== 'nassaj-oid-control-transaction/v2'
        || JSON.stringify(transaction.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES)) throw new Error('oid_triple_transaction_invalid');
    for (const name of UPDATE_GENERATION_NAMES) {
        const hash = name === 'nodeModules' ? directory => hashDependencyTreeV2(directory).sha256 : hashOidPairTree;
        const { live, candidate } = tripleLocation(root, transaction, name);
        try { generations[name] = { previous: previous?.[`${name}TreeSha256`], target: target[`${name}TreeSha256`], live: hash(live), candidate: hash(candidate) }; }
        catch { generations[name] = {}; }
    }
    return reconcileUpdateGenerations({ generationNames: transaction.generationNames, generations,
        direction, databaseState: transaction.pair.databaseState });
}

/** Select one exact PM2 slot; absence or duplicate identity never becomes a create operation. */
export function validateOidTriplePm2Slot(rows, expected, status = 'online') {
    if (!Array.isArray(rows) || !['online','stopped'].includes(status)) throw new Error('oid_triple_pm2_response_invalid');
    const matches = rows.filter(row => row?.name === expected.name || row?.pm_id === expected.pmId);
    if (matches.length !== 1) throw new Error('oid_triple_pm2_slot_ambiguous');
    const slot = matches[0], env = slot.pm2_env;
    if (!env || slot.name !== expected.name || !Number.isSafeInteger(slot.pm_id) || slot.pm_id < 0
        || (expected.pmId !== undefined && slot.pm_id !== expected.pmId)
        || env.pm_exec_path !== path.join(expected.root, 'dist-server/server/index.js') || env.pm_cwd !== expected.root
        || env.status !== status || env.treekill !== false || (env.kill_timeout !== 86400000 && env.kill_timeout !== '86400000')
        || (status === 'online' && slot.pid !== expected.pid)
        || (status === 'stopped' && slot.pid !== 0)) throw new Error('oid_triple_pm2_slot_changed');
    return slot;
}

function tripleStableEnvironment(environment, { allowMode = false } = {}) {
    const result = { ...environment };
    if (allowMode) delete result.NASSAJ_UPDATE_MODE;
    delete result.NASSAJ_PREVIEW_TRANSACTION_NONCE; delete result.NASSAJ_PREVIEW_BOOT_NONCE;
    return sha(pairCanonical(result));
}

/** The bootstrap is allowed to alter exactly one dotenv assignment. */
export function validateBootstrapModeProposal(original, proposal) {
    if (!Buffer.isBuffer(original) || !Buffer.isBuffer(proposal) || original.length > 4 * 1024 * 1024
        || proposal.length > 4 * 1024 * 1024) throw new Error('oid_bootstrap_mode_bytes_invalid');
    const line = /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=.*$/gm;
    const before = original.toString('utf8'), after = proposal.toString('utf8');
    const oldLines = before.match(line) || [], newLines = after.match(line) || [];
    if (oldLines.length > 1 || (oldLines.length === 1
        && !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=\s*(?:release|"release"|'release')\s*$/.test(oldLines[0]))
        || newLines.length !== 1 || newLines[0] !== 'NASSAJ_UPDATE_MODE=local-main'
        || before.replace(line, '').trimEnd() !== after.replace(line, '').trimEnd()) {
        throw new Error('oid_bootstrap_mode_scope_invalid');
    }
    return { originalSha256: sha(original), proposalSha256: sha(proposal) };
}

function bootstrapProposalBytes(record) {
    const encoded = record.bootstrap?.proposalEnvBase64;
    if (typeof encoded !== 'string' || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('oid_bootstrap_mode_proposal_invalid');
    return Buffer.from(encoded, 'base64');
}

function bootstrapModeBackupFile(root, transaction) {
    return path.join(gitControlRoot(root), 'nassaj-oid-recovery', transaction.transactionNonce, 'bootstrap-mode-original.env');
}

function exchangeBootstrapModeFile(envFile, bytes, beforeSha256, afterSha256, staged) {
    const read = (file, label) => pinnedFile(file, label, { mode: 0o600 }).bytes;
    const current = read(envFile, 'bootstrap_mode_exchange_current');
    if (sha(current) === afterSha256) return;
    if (sha(current) !== beforeSha256) throw new Error('oid_bootstrap_mode_cas_changed');
    if (!fs.existsSync(staged)) {
        const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        fsyncDir(path.dirname(staged));
    }
    if (sha(read(staged, 'bootstrap_mode_exchange_proposal')) !== afterSha256) throw new Error('oid_bootstrap_mode_cas_changed');
    const result = spawnSync('/usr/bin/mv', ['--exchange','--no-copy','-T',staged,envFile],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 5000 });
    fsyncDir(path.dirname(envFile));
    if (result.status !== 0 || result.error || sha(read(envFile, 'bootstrap_mode_exchange_after')) !== afterSha256
        || sha(read(staged, 'bootstrap_mode_exchange_previous')) !== beforeSha256) throw new Error('oid_bootstrap_mode_cas_unknown');
}

/** Journal, apply and verify the release -> local-main configuration CAS after proven stop. */
export function applyBootstrapModeCAS(root, file, transaction, record) {
    if (!transaction.bootstrap || !['triple_old_stopped','bootstrap_mode_intent','bootstrap_mode_verified'].includes(transaction.state) || !transaction.oldStoppedAt
        || transaction.pair.databaseState !== 'PRE_CANDIDATE') throw new Error('oid_bootstrap_mode_boundary_invalid');
    const mode = record.bootstrap.ticket.material.mode, envFile = path.join(root, '.env'), proposal = bootstrapProposalBytes(record);
    const current = pinnedFile(envFile, 'bootstrap_mode_current', { mode: 0o600 }).bytes;
    const identities = validateBootstrapModeProposal(
        transaction.bootstrapMode?.originalBytesBase64 ? Buffer.from(transaction.bootstrapMode.originalBytesBase64, 'base64') : current,
        proposal);
    if (identities.originalSha256 !== mode.originalEnvSha256 || identities.proposalSha256 !== mode.proposalEnvSha256
        || ![mode.originalEnvSha256, mode.proposalEnvSha256].includes(sha(current))) throw new Error('oid_bootstrap_mode_binding_changed');
    const backupFile = bootstrapModeBackupFile(root, transaction);
    let next = transaction;
    if (!next.bootstrapMode) {
        const intent = { state: 'intent', originalSha256: mode.originalEnvSha256, proposalSha256: mode.proposalEnvSha256,
            originalBytesBase64: current.toString('base64'), backupBasename: path.basename(backupFile),
            proposalStageBasename: `bootstrap-mode-proposal-${transaction.transactionNonce}.env` };
        next = { ...next, state: 'bootstrap_mode_intent', bootstrapMode: intent }; durable(file, next);
    }
    if (!fs.existsSync(backupFile)) {
        const original = Buffer.from(next.bootstrapMode.originalBytesBase64, 'base64');
        if (sha(original) !== mode.originalEnvSha256) throw new Error('oid_bootstrap_mode_original_changed');
        const fd = openSync(backupFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, original); fsyncSync(fd); } finally { closeSync(fd); }
        fsyncDir(path.dirname(backupFile));
    }
    const backup = pinnedFile(backupFile, 'bootstrap_mode_backup', { sha256: mode.originalEnvSha256, mode: 0o600 }).bytes;
    validateBootstrapModeProposal(backup, proposal);
    const proposalStage = path.join(path.dirname(backupFile), next.bootstrapMode.proposalStageBasename);
    exchangeBootstrapModeFile(envFile, proposal, mode.originalEnvSha256, mode.proposalEnvSha256, proposalStage);
    if (sha(pinnedFile(envFile, 'bootstrap_mode_after_apply', { mode: 0o600 }).bytes) !== mode.proposalEnvSha256) throw new Error('oid_bootstrap_mode_cas_unknown');
    next = { ...next, state: 'bootstrap_mode_verified', bootstrapMode: { ...next.bootstrapMode, state: 'verified', verifiedAt: Date.now() } };
    durable(file, next); return next;
}

/** Restore release configuration only while target start is still provably impossible. */
export function restoreBootstrapModeCAS(root, file, transaction, record) {
    if (!transaction.bootstrap || transaction.pair.databaseState !== 'PRE_CANDIDATE' || transaction.bootDirection
        || transaction.pm2Operations && Object.keys(transaction.pm2Operations).some(key => key.startsWith('start-'))) {
        throw new Error('oid_bootstrap_mode_restore_forbidden');
    }
    const mode = record.bootstrap.ticket.material.mode, envFile = path.join(root, '.env');
    const backupFile = bootstrapModeBackupFile(root, transaction), proposal = bootstrapProposalBytes(record);
    let backup;
    try { backup = pinnedFile(backupFile, 'bootstrap_mode_restore_backup', { sha256: mode.originalEnvSha256, mode: 0o600 }).bytes; }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const encoded = transaction.bootstrapMode?.originalBytesBase64;
        if (typeof encoded !== 'string' || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('oid_bootstrap_mode_original_changed');
        const original = Buffer.from(encoded, 'base64'), current = pinnedFile(envFile, 'bootstrap_mode_restore_current', { mode: 0o600 }).bytes;
        const identities = validateBootstrapModeProposal(original, proposal);
        if (identities.originalSha256 !== mode.originalEnvSha256 || identities.proposalSha256 !== mode.proposalEnvSha256
            || ![mode.originalEnvSha256, mode.proposalEnvSha256].includes(sha(current))) throw new Error('oid_bootstrap_mode_cas_unknown');
        const fd = openSync(backupFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, original); fsyncSync(fd); } finally { closeSync(fd); }
        fsyncDir(path.dirname(backupFile));
        backup = pinnedFile(backupFile, 'bootstrap_mode_recreated_backup', { sha256: mode.originalEnvSha256, mode: 0o600 }).bytes;
    }
    validateBootstrapModeProposal(backup, proposal);
    const proposalStage = path.join(path.dirname(bootstrapModeBackupFile(root, transaction)), transaction.bootstrapMode.proposalStageBasename);
    const current = pinnedFile(envFile, 'bootstrap_mode_restore_current', { mode: 0o600 }).bytes;
    const currentSha256 = sha(current);
    let proposalStagePresent;
    try { lstatSync(proposalStage); proposalStagePresent = true; }
    catch (error) { if (error.code === 'ENOENT') proposalStagePresent = false; else throw error; }
    if (proposalStagePresent) {
        const stagedSha256 = sha(pinnedFile(proposalStage, 'bootstrap_mode_restore_stage', { mode: 0o600 }).bytes);
        if (currentSha256 === mode.originalEnvSha256 && stagedSha256 === mode.proposalEnvSha256) {
            unlinkSync(proposalStage); fsyncDir(path.dirname(proposalStage));
            try { lstatSync(proposalStage); throw new Error('oid_bootstrap_mode_cas_unknown'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else if (currentSha256 === mode.proposalEnvSha256 && stagedSha256 === mode.originalEnvSha256) {
            exchangeBootstrapModeFile(envFile, backup, mode.proposalEnvSha256, mode.originalEnvSha256, proposalStage);
            if (sha(pinnedFile(proposalStage, 'bootstrap_mode_restore_proposal', { mode: 0o600 }).bytes) !== mode.proposalEnvSha256) {
                throw new Error('oid_bootstrap_mode_cas_unknown');
            }
            unlinkSync(proposalStage); fsyncDir(path.dirname(proposalStage));
            try { lstatSync(proposalStage); throw new Error('oid_bootstrap_mode_cas_unknown'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else throw new Error('oid_bootstrap_mode_cas_unknown');
    } else if (currentSha256 !== mode.originalEnvSha256) throw new Error('oid_bootstrap_mode_cas_unknown');
    if (sha(pinnedFile(envFile, 'bootstrap_mode_restored', { mode: 0o600 }).bytes) !== mode.originalEnvSha256) throw new Error('oid_bootstrap_mode_restore_unknown');
    const next = { ...transaction, bootstrapMode: { ...transaction.bootstrapMode, state: 'restored', restoredAt: Date.now() } };
    durable(file, next); return next;
}

/** PM2 removes pm_id from dump; bind its unique saved definition to the separately attested live slot. */
export function validateOidTriplePm2Dump(rows, slot) {
    if (!Array.isArray(rows)) throw new Error('oid_triple_pm2_dump_invalid');
    const matches = rows.filter(row => row?.name === slot.name);
    if (matches.length !== 1) throw new Error('oid_triple_pm2_dump_slot_ambiguous');
    const saved = matches[0], current = slot.pm2_env;
    assertServiceOwnerEnvironmentCopies(slot);
    assertServiceOwnerEnvironmentCopies({ pm2_env: saved });
    for (const key of ['name','pm_cwd','pm_exec_path','status','treekill','kill_timeout']) {
        if (pairCanonical(saved[key]) !== pairCanonical(key === 'name' ? slot.name : current[key])) throw new Error('oid_triple_pm2_dump_slot_changed');
    }
    if (saved.pm_id !== undefined || pairCanonical(saved.env || {}) !== pairCanonical(current.env || {})) throw new Error('oid_triple_pm2_dump_environment_changed');
    return true;
}

function tripleDumpEnvironment(row, slot, status) {
    const environment = assertServiceOwnerEnvironmentCopies(slot), next = { ...row, status, env: environment };
    for (const key of ['NASSAJ_UPDATE_MODE','NASSAJ_PREVIEW_TRANSACTION_NONCE','NASSAJ_PREVIEW_BOOT_NONCE']) {
        if (Object.hasOwn(environment,key)) next[key]=environment[key];
        else if (Object.hasOwn(row,key)) throw new Error('oid_triple_dump_environment_shadow');
    }
    return next;
}
function prepareTripleDumpCAS(transaction, slot, status) {
    const supervisor = transaction.supervisor, file = path.join(supervisor.pm2Home, 'dump.pm2');
    const bytes = pinnedFile(file, 'triple_dump_cas_before', { maxSize: 16 * 1024 * 1024 }).bytes, stat = lstatSync(file);
    if (stat.uid !== process.getuid() || stat.nlink !== 1 || stat.mode & 0o022) throw new Error('oid_triple_pm2_dump_unsafe');
    const priorIntent = transaction.persistence?.[status]?.dumpCAS;
    if (priorIntent) {
        if (![priorIntent.beforeSha256, priorIntent.afterSha256].includes(sha(bytes))) throw new Error('oid_triple_dump_cas_changed');
        return priorIntent;
    }
    const expected = status === 'online' ? transaction.persistence?.stopped?.dumpSha256
        : transaction.persistence?.online?.dumpSha256 || supervisor.dumpSha256;
    if (sha(bytes) !== expected) throw new Error('oid_triple_dump_cas_changed');
    const rows = JSON.parse(bytes), matches = rows.filter(row => row.name === supervisor.name);
    if (matches.length !== 1 || matches[0].pm_id !== undefined) throw new Error('oid_triple_dump_cas_slot');
    const saved = matches[0];
    if (sha(pairCanonical(serviceOwnerSlotControls({ pm_id: supervisor.pmId, pm2_env: saved }))) !== supervisor.controlsSha256) throw new Error('oid_triple_dump_cas_controls');
    const after = rows.map(row => row === saved ? tripleDumpEnvironment(row, slot, status) : row);
    const next = Buffer.from(JSON.stringify(after, null, 2));
    return { beforeSha256: sha(bytes), afterSha256: sha(next), status, state: 'intent',
        stagedBasename: `dump.pm2.nassaj-${transaction.transactionNonce}-${sha(next)}` };
}
function applyTripleDumpCAS(supervisor, slot, intent) {
    if (!/^dump\.pm2\.nassaj-[a-f0-9]{64}-[a-f0-9]{64}$/.test(intent.stagedBasename || '')
        || !intent.stagedBasename.endsWith(intent.afterSha256)) throw new Error('oid_triple_dump_cas_paths');
    const file = path.join(supervisor.pm2Home, 'dump.pm2'), staged = path.join(supervisor.pm2Home, intent.stagedBasename);
    const read = name => pinnedFile(name, 'triple_dump_cas', { maxSize: 16 * 1024 * 1024 }).bytes;
    const before = read(file), currentHash = sha(before);
    if (currentHash === intent.afterSha256 && fs.existsSync(staged) && sha(read(staged)) === intent.beforeSha256) return;
    if (currentHash !== intent.beforeSha256) throw new Error('oid_triple_dump_cas_changed');
    const rows = JSON.parse(before), matches = rows.filter(row => row.name === supervisor.name);
    if (matches.length !== 1) throw new Error('oid_triple_dump_cas_slot');
    const next = Buffer.from(JSON.stringify(rows.map(row => row === matches[0] ? tripleDumpEnvironment(row, slot, intent.status) : row), null, 2));
    if (sha(next) !== intent.afterSha256) throw new Error('oid_triple_dump_cas_proposal_changed');
    if (!fs.existsSync(staged)) {
        const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, next); fsyncSync(fd); } finally { closeSync(fd); }
        fsyncDir(supervisor.pm2Home);
    }
    if (sha(pinnedFile(staged, 'triple_dump_proposal', { mode: 0o600, maxSize: 16 * 1024 * 1024 }).bytes) !== intent.afterSha256
        || sha(read(file)) !== intent.beforeSha256) throw new Error('oid_triple_dump_cas_changed');
    assertOidTriplePm2Authority(supervisor);
    injectFailure('triple_before_dump_cas');
    if (process.env.NODE_ENV === 'test' && process.env.NASSAJ_OID_CAPSULE_FAIL_AT === 'triple_dump_competing_writer') {
        writeFileSync(file, read(path.join(supervisor.pm2Home, 'competing-dump-fixture.json')));
    }
    const result = spawnSync('/usr/bin/mv', ['--exchange','--no-copy','-T',staged,file],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 5000 });
    fsyncDir(supervisor.pm2Home);
    injectFailure('triple_after_dump_cas');
    if (result.status !== 0 || result.error || sha(read(file)) !== intent.afterSha256 || sha(read(staged)) !== intent.beforeSha256) {
        throw new Error('oid_triple_dump_cas_unknown');
    }
}

/** Persist the existing slot only; restart/exchange is never part of persistence reconciliation. */
export async function persistOidTriplePm2Slot(root, file, transaction, status, child = null) {
    transaction = assertOidTripleFailureBinding(pinnedJson(file, 'triple_persistence_latest'), transaction);
    const supervisor = transaction.supervisor;
    const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), { ...supervisor, pid: child?.pid ?? supervisor.pid }, status);
    const environment = slot.pm2_env.env || {};
    if (status === 'online') {
        if (!child || !pairOwnerAlive(child) || processStartTicks(slot.pid) !== child.startTime
            || environment.NASSAJ_PREVIEW_TRANSACTION_NONCE !== transaction.transactionNonce
            || environment.NASSAJ_PREVIEW_BOOT_NONCE !== transaction.bootNonce
            || tripleStableEnvironment(environment, { allowMode: Boolean(transaction.bootstrap) })
                !== (transaction.bootstrap ? supervisor.bootstrapStableEnvironmentSha256 : supervisor.stableEnvironmentSha256)) throw new Error('oid_triple_persistence_child_changed');
    } else if (sha(pairCanonical(environment)) !== supervisor.environmentSha256 || !pairOwnerProvablyDead(transaction.pair.previous.runtime)) throw new Error('oid_triple_persistence_stop_changed');
    const expectedMode = transaction.bootstrap && (status === 'stopped' || transaction.bootDirection === 'previous') ? 'release' : 'local-main';
    assertOidTripleEffectiveMode(root, environment, expectedMode);
    const intent = { state: 'intent', status, pmId: supervisor.pmId, name: supervisor.name,
        environmentSha256: sha(pairCanonical(environment)), dumpCAS: prepareTripleDumpCAS(transaction, slot, status), ...(child ? { pid: child.pid, startTime: child.startTime, bootNonce: transaction.bootNonce } : {}) };
    let current = { ...transaction, persistence: { ...transaction.persistence, [status]: intent } }; durable(file, current);
    const dumpFile = path.join(supervisor.pm2Home, 'dump.pm2');
    const verify = async () => {
        assertOidTriplePm2Authority(supervisor);
        const pinned = pinnedFile(dumpFile, 'triple_pm2_dump', { maxSize: 16 * 1024 * 1024 });
        const metadata = lstatSync(dumpFile);
        if (metadata.uid !== process.getuid() || metadata.nlink !== 1 || metadata.mode & 0o022) throw new Error('oid_triple_pm2_dump_unsafe');
        validateOidTriplePm2Dump(JSON.parse(pinned.bytes), slot);
        const live = validateOidTriplePm2Slot(await triplePm2Read(supervisor), { ...supervisor, pid: child?.pid ?? supervisor.pid }, status);
        if (sha(pairCanonical(live.pm2_env.env || {})) !== intent.environmentSha256 || (child && !pairOwnerAlive(child))) throw new Error('oid_triple_pm2_persistence_changed');
        const fd = openSync(dumpFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const held = fstatSync(fd);
            if (held.dev !== metadata.dev || held.ino !== metadata.ino || held.nlink !== 1 || sha(readFileSync(fd)) !== sha(pinned.bytes)) throw new Error('oid_triple_pm2_dump_changed');
            fsyncSync(fd);
        } finally { closeSync(fd); }
        fsyncDir(supervisor.pm2Home);
        if (sha(pinnedFile(dumpFile, 'triple_pm2_dump_after_sync').bytes) !== sha(pinned.bytes)) throw new Error('oid_triple_pm2_dump_changed');
        assertOidTriplePm2Authority(supervisor);
        return sha(pinned.bytes);
    };
    try { applyTripleDumpCAS(supervisor, slot, intent.dumpCAS); }
    catch (error) {
        durable(file, { ...current, persistence: { ...current.persistence, [status]: { ...intent, state: 'unknown' } } });
        throw error;
    }
    const digest = await verify();
    injectFailure('triple_after_pm2_save_before_receipt');
    current = { ...current, persistence: { ...current.persistence, [status]: { ...intent, state: 'verified', dumpSha256: digest, verifiedAt: Date.now() } } };
    durable(file, current); return current;
}

function tripleStableExecutable(file, root, label) {
    const resolved = realpathSync(file);
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) throw new Error(`oid_triple_${label}_not_external`);
    const metadata = lstatSync(resolved), bytes = pinnedFile(resolved, `triple_${label}`, { maxSize: Number.MAX_SAFE_INTEGER }).bytes;
    if (metadata.mode & 0o022 || metadata.nlink !== 1) throw new Error(`oid_triple_${label}_unsafe`);
    return { path: resolved, sha256: sha(bytes), size: bytes.length, mode: metadata.mode & 0o777 };
}

/** Evaluate effective directory authority, including a private service-owned boundary. */
export function validateOidTriplePm2AuthorityChain(chain, serviceUid = process.getuid()) {
    if (!Array.isArray(chain) || !chain.length || chain[0].path !== '/') throw new Error('oid_triple_pm2_authority_invalid');
    let privateBoundary = false;
    for (const [index, entry] of chain.entries()) {
        if (!Number.isSafeInteger(entry.uid) || !Number.isSafeInteger(entry.gid) || !Number.isSafeInteger(entry.mode)
            || ![0, serviceUid].includes(entry.uid) || typeof entry.dev !== 'string' || typeof entry.ino !== 'string'
            || (index && path.dirname(entry.path) !== chain[index - 1].path)) throw new Error('oid_triple_pm2_authority_invalid');
        if (!privateBoundary && (entry.mode & 0o022)) throw new Error('oid_triple_pm2_authority_exposed_write');
        if (entry.uid === serviceUid && entry.mode === 0o700) privateBoundary = true;
    }
    if (chain.at(-1).uid !== serviceUid) throw new Error('oid_triple_pm2_home_owner_invalid');
    return true;
}

/** Pin every real ancestor; later checks reject drift even if the new modes would otherwise be allowed. */
export function captureOidTriplePm2Authority(pm2Home) {
    if (!path.isAbsolute(pm2Home || '') || path.resolve(pm2Home) !== pm2Home || realpathSync(pm2Home) !== pm2Home) throw new Error('oid_triple_pm2_home_invalid');
    const names = ['/']; let current = '/';
    for (const name of pm2Home.split('/').filter(Boolean)) { current = path.join(current, name); names.push(current); }
    const chain = names.map(directory => {
        const metadata = lstatSync(directory);
        if (!metadata.isDirectory() || realpathSync(directory) !== directory) throw new Error('oid_triple_pm2_authority_not_canonical');
        return { path: directory, dev: String(metadata.dev), ino: String(metadata.ino), uid: metadata.uid, gid: metadata.gid, mode: metadata.mode & 0o7777 };
    });
    validateOidTriplePm2AuthorityChain(chain);
    return chain;
}

/** Recheck the captured authority before and after each supervisor or dump operation. */
export function assertOidTriplePm2Authority(supervisor) {
    if (!supervisor.authority || pairCanonical(captureOidTriplePm2Authority(supervisor.pm2Home)) !== pairCanonical(supervisor.authority)) throw new Error('oid_triple_pm2_authority_changed');
    return true;
}

async function triplePm2Read(supervisor) {
    assertOidTriplePm2Authority(supervisor);
    for (const [label, identity] of [['node',supervisor.node],['pm2',supervisor.pm2]]) {
        if (sha(pinnedFile(identity.path, `triple_${label}`, { maxSize: Number.MAX_SAFE_INTEGER, mode: identity.mode }).bytes) !== identity.sha256) throw new Error('oid_triple_supervisor_changed');
    }
    if (!pairOwnerAlive(supervisor.daemon)
        || sha(readFileSync(`/proc/${supervisor.daemon.pid}/exe`)) !== supervisor.daemonExecutableSha256
        || hashDependencyTreeV2(supervisor.pm2PackageRoot).sha256 !== supervisor.pm2TreeSha256) throw new Error('oid_triple_pm2_daemon_changed');
    if (!supervisor.observer) throw new Error('oid_triple_pm2_observer_missing');
    const rows = await observeServiceOwnerPm2(supervisor.observer);
    assertOidTriplePm2Authority(supervisor);
    return rows;
}

/** Check the child's trusted service/.env mode; a running parent's dotenv cache is not sufficient. */
export function assertOidTripleEffectiveMode(root, environment, expected = 'local-main') {
    if (!['release','local-main'].includes(expected)) throw new Error('oid_triple_child_mode_changed');
    let mode = environment?.NASSAJ_UPDATE_MODE;
    if (mode === undefined) {
        const text = pinnedFile(path.join(root, '.env'), 'triple_mode_file').bytes.toString('utf8');
        const lines = text.split('\n').filter(line => /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE(?:\s|=|$)/.test(line));
        if (lines.length !== 1 || !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=/.test(lines[0])) throw new Error('oid_triple_child_mode_changed');
        mode = lines[0].slice(lines[0].indexOf('=') + 1).trim();
        if (mode && ['"', "'"].includes(mode[0]) && mode.at(-1) === mode[0]) mode = mode.slice(1,-1);
    }
    if (mode !== expected) throw new Error('oid_triple_child_mode_changed');
    return true;
}

/** Capture external supervisor/process identities while the previous application is still online. */
export async function captureOidTripleSupervisor(root, record) {
    const pm2Home = process.env.PM2_HOME || (process.env.HOME && path.join(process.env.HOME, '.pm2'));
    const authority = captureOidTriplePm2Authority(pm2Home);
    const found = spawnSync('/usr/bin/which', ['pm2'], { encoding: 'utf8', timeout: 5000 });
    if (found.status !== 0) throw new Error('oid_triple_pm2_executable_missing');
    const daemonPid = Number(pinnedFile(path.join(pm2Home, 'pm2.pid'), 'triple_pm2_pid').bytes.toString().trim());
    if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) throw new Error('oid_triple_pm2_daemon_invalid');
    const supervisor = { node: tripleStableExecutable(process.execPath, root, 'node'),
        pm2: tripleStableExecutable(found.stdout.trim(), root, 'pm2'), pm2Home, authority, daemon: pairProcessIdentity(daemonPid) };
    supervisor.pm2PackageRoot = path.dirname(path.dirname(supervisor.pm2.path));
    const pm2Package = pinnedJson(path.join(supervisor.pm2PackageRoot, 'package.json'), 'triple_pm2_package');
    const daemonCommand = readFileSync(`/proc/${daemonPid}/cmdline`).toString().replace(/\0/g, ' ').trim();
    if (pm2Package.name !== 'pm2' || !daemonCommand.startsWith(`PM2 v${pm2Package.version}: God Daemon (`)
        || !daemonCommand.endsWith(`(${pm2Home})`)) throw new Error('oid_triple_pm2_daemon_identity_invalid');
    supervisor.pm2TreeSha256 = hashDependencyTreeV2(supervisor.pm2PackageRoot).sha256;
    supervisor.daemonExecutableSha256 = sha(readFileSync(`/proc/${daemonPid}/exe`));
    supervisor.observer = captureServiceOwnerObserver(pm2Home, { pid: record.oldPid, startTicks: record.oldStartTicks });
    const name = process.env.PROC_NAME || process.env.NASSAJ_PROCESS_NAME;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error('oid_triple_pm2_name_invalid');
    const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), { root, name, pid: record.oldPid });
    if (processStartTicks(slot.pid) !== record.oldStartTicks) throw new Error('oid_triple_previous_process_changed');
    return { ...supervisor, name, pmId: slot.pm_id, root, pid: slot.pid,
        startTime: record.oldStartTicks, controlsSha256: sha(pairCanonical(serviceOwnerSlotControls(slot))),
        dumpSha256: sha(pinnedFile(path.join(pm2Home, 'dump.pm2'), 'triple_initial_dump').bytes), environmentSha256: sha(pairCanonical(slot.pm2_env.env || {})),
        stableEnvironmentSha256: tripleStableEnvironment(slot.pm2_env.env || {}),
        bootstrapStableEnvironmentSha256: tripleStableEnvironment(slot.pm2_env.env || {}, { allowMode: true }) };
}

function tripleOwnedTransaction(root, expected) {
    const paths = pairPaths(root), maintenance = pairReadMaintenance(paths);
    const transaction = validateOidPairMaintenance(root, maintenance);
    if (transaction?.schema !== 'nassaj-oid-control-transaction/v2' || !pairOwnerAlive(maintenance.owner)
        || transaction.sequence !== expected.sequence || transaction.transactionNonce !== expected.transactionNonce
        || transaction.actionId !== expected.actionId || transaction.pair.targetDigest !== expected.targetDigest) throw new Error('oid_triple_safe_phase_not_owned');
    const ancestry = new Set(); let pid = process.pid;
    while (pid > 1 && !ancestry.has(pid)) {
        ancestry.add(pid);
        const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m);
        if (!match) throw new Error('oid_triple_safe_ancestry_unknown'); pid = Number(match[1]);
    }
    if (!ancestry.has(maintenance.owner.pid) || maintenance.owner.pid === process.pid) throw new Error('oid_triple_safe_phase_foreign_process');
    return { paths, maintenance, transaction, ancestry, file: path.join(paths.gitRoot, maintenance.identity.oid.journalBasename) };
}

function tripleRefuseWriterDescendants(oldPid, allowed) {
    const parents = new Map();
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const status = readFileSync(`/proc/${entry}/status`, 'utf8');
            const parent = status.match(/^PPid:\s+(\d+)/m);
            if (parent) parents.set(Number(entry), Number(parent[1]));
        } catch (error) { if (!['ENOENT','ESRCH'].includes(error.code)) throw new Error('oid_triple_process_inventory_unknown'); }
    }
    for (const pid of parents.keys()) {
        if (pid === oldPid || allowed.has(pid)) continue;
        const seen = new Set(); let ancestor = parents.get(pid);
        while (ancestor && !seen.has(ancestor)) {
            if (ancestor === oldPid) throw new Error('oid_triple_writer_descendant_present');
            seen.add(ancestor); ancestor = parents.get(ancestor);
        }
    }
}

async function triplePm2Command(supervisor, step, owned, environment = null) {
    const { file, transaction, paths } = owned;
    const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor, step === 'stop-old' ? 'online' : 'stopped');
    const operationKey = step === 'stop-old' ? 'stop-old' : `start-${transaction.bootNonce}`;
    const authority = { schema: 'nassaj-pm2-service-owner/v1', observer: supervisor.observer,
        pmId: supervisor.pmId, name: supervisor.name, namespace: slot.pm2_env.namespace,
        controlsSha256: supervisor.controlsSha256, environmentSha256: sha(pairCanonical(slot.pm2_env.env || {})),
        previous: { pid: supervisor.pid, startTicks: supervisor.startTime }, nextEnvironment: environment };
    const bound = () => {
        const latest = pinnedJson(file, 'triple_pm2_authority');
        assertOidTripleFailureBinding(latest, transaction);
        const maintenance = pairReadMaintenance(paths);
        if (!maintenance.gateClosed || maintenance.transactionId !== transaction.transactionNonce || !pairOwnerAlive(maintenance.owner)
            || !owned.ancestry.has(maintenance.owner.pid)) throw new Error('oid_triple_pm2_lease_changed');
        if (latest.pm2Operations?.[operationKey]) throw new Error('oid_triple_pm2_operation_already_intended');
        if (step === 'stop-old' ? latest.state !== 'triple_old_stop_intent' || latest.pair.databaseState !== 'PRE_CANDIDATE'
            : !['triple_candidate_start_intent', 'triple_previous_start_intent'].includes(latest.state)) throw new Error('oid_triple_pm2_phase_changed');
        return latest;
    };
    await executeServiceOwnerPm2Step(authority, step, {
        authorize(intent) {
            const latest = bound();
            durable(file, { ...latest, pm2Operations: { ...latest.pm2Operations, [operationKey]: { ...intent, state: 'intent' } } });
        },
        unknown() {
            const latest = pinnedJson(file, 'triple_pm2_unknown'); assertOidTripleFailureBinding(latest, transaction);
            durable(file, { ...latest, pm2Operations: { ...latest.pm2Operations,
                [operationKey]: { ...latest.pm2Operations?.[operationKey], state: 'unknown' } } });
        },
    });
    const latest = pinnedJson(file, 'triple_pm2_reply'); assertOidTripleFailureBinding(latest, transaction);
    durable(file, { ...latest, pm2Operations: { ...latest.pm2Operations,
        [operationKey]: { ...latest.pm2Operations?.[operationKey], state: 'reply_observed' } } });
}

/** Only the sealed safe-restart branch calls this after its ordinary drain/native preflight. */
export async function runOidTripleSafePhase(root, expected, phase) {
    if (!['inspect-stop','validate-stop','stop','start-target','start-previous'].includes(phase)) throw new Error('oid_triple_safe_phase_invalid');
    const owned = tripleOwnedTransaction(root, expected), transaction = owned.transaction, supervisor = transaction.supervisor;
    if (!supervisor || supervisor.root !== root) throw new Error('oid_triple_supervisor_missing');
    if (phase === 'inspect-stop') {
        if (transaction.state !== 'triple_old_stop_intent' || transaction.pair.databaseState !== 'PRE_CANDIDATE') throw new Error('oid_triple_stop_not_intended');
        const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor);
        assertServiceOwnerEnvironmentCopies(slot);
        if (processStartTicks(slot.pid) !== supervisor.startTime
            || sha(pairCanonical(serviceOwnerSlotControls(slot))) !== supervisor.controlsSha256
            || sha(pairCanonical(slot.pm2_env.env || {})) !== supervisor.environmentSha256) throw new Error('oid_triple_pm2_environment_changed');
        return [slot];
    }
    if (phase === 'stop' || phase === 'validate-stop') {
        if (transaction.state !== 'triple_old_stop_intent' || transaction.pair.databaseState !== 'PRE_CANDIDATE') throw new Error('oid_triple_stop_not_intended');
        pairVerifyLive(root, { targetClientBuildId: transaction.pair.previous.clientBuildId, targetServerBuildId: transaction.pair.previous.serverBuildId }, transaction.pair.previous);
        const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor);
        assertOidTripleEffectiveMode(root, slot.pm2_env.env || {}, transaction.bootstrap ? 'release' : 'local-main');
        if (processStartTicks(slot.pid) !== supervisor.startTime || sha(pairCanonical(slot.pm2_env.env || {})) !== supervisor.environmentSha256) throw new Error('oid_triple_pm2_environment_changed');
        tripleRefuseWriterDescendants(supervisor.pid, owned.ancestry);
        if (phase === 'validate-stop') return { state: 'stop_ready', transactionNonce: transaction.transactionNonce };
        await triplePm2Command(supervisor, 'stop-old', owned);
        validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor, 'stopped');
        if (!pairOwnerProvablyDead(transaction.pair.previous.runtime)) throw new Error('oid_triple_old_process_still_alive');
        const persisted = await persistOidTriplePm2Slot(root, owned.file, transaction, 'stopped');
        durable(owned.file, { ...persisted, state: 'triple_old_stopped', oldStoppedAt: Date.now() });
        return { state: 'old_stopped', transactionNonce: transaction.transactionNonce };
    }
    return startOidTripleStoppedSlot(root, owned, phase);
}

async function startOidTripleStoppedSlot(root, owned, phase) {
    const transaction = owned.transaction, supervisor = transaction.supervisor;
    const rollback = phase === 'start-previous';
    if (transaction.state !== (rollback ? 'triple_previous_start_intent' : 'triple_candidate_start_intent')
        || transaction.pair.databaseState !== (rollback ? 'PRE_CANDIDATE' : 'UNKNOWN')
        || !transaction.oldStoppedAt || !HEX64.test(transaction.bootNonce || '')) throw new Error('oid_triple_start_not_intended');
    const plan = inspectOidTripleGenerationPlan(root, transaction, rollback ? 'rollback' : 'forward');
    if (plan.state !== 'verified' || plan.steps.some(step => step.operation !== 'attest')) throw new Error('oid_triple_start_generations_unverified');
    const slot = validateOidTriplePm2Slot(await triplePm2Read(supervisor), supervisor, 'stopped');
    const stoppedEnvironment = slot.pm2_env.env || {};
    const stoppedMode = transaction.bootstrap && (rollback || Object.hasOwn(stoppedEnvironment, 'NASSAJ_UPDATE_MODE')) ? 'release' : 'local-main';
    assertOidTripleEffectiveMode(root, stoppedEnvironment, stoppedMode);
    if (!pairOwnerProvablyDead(transaction.pair.previous.runtime)
        || sha(pairCanonical(slot.pm2_env.env || {})) !== supervisor.environmentSha256) throw new Error('oid_triple_stopped_slot_changed');
    const saved = slot.pm2_env.env || {};
    const environment = buildOidTripleStartEnvironment(saved, transaction, rollback);
    await triplePm2Command(supervisor, 'start-stopped', owned, environment);
    const rows = await triplePm2Read(supervisor), candidate = rows.find(row => row.pm_id === supervisor.pmId);
    const started = validateOidTriplePm2Slot(rows, { ...supervisor, pid: candidate?.pid });
    const actual = started.pm2_env.env || {};
    for (const key of new Set([...Object.keys(saved), ...Object.keys(actual)])) {
        if (['NASSAJ_UPDATE_MODE','NASSAJ_PREVIEW_TRANSACTION_NONCE','NASSAJ_PREVIEW_BOOT_NONCE'].includes(key)) continue;
        if (pairCanonical(saved[key]) !== pairCanonical(actual[key])) throw new Error('oid_triple_saved_environment_drift');
    }
    if (actual.NASSAJ_PREVIEW_TRANSACTION_NONCE !== transaction.transactionNonce || actual.NASSAJ_PREVIEW_BOOT_NONCE !== transaction.bootNonce) throw new Error('oid_triple_boot_environment_not_applied');
    return { state: rollback ? 'previous_start_requested' : 'candidate_start_requested', transactionNonce: transaction.transactionNonce };
}

/** Construct the sole permitted start-time environment delta. */
export function buildOidTripleStartEnvironment(saved, transaction, rollback = false) {
    if (!saved || Object.getPrototypeOf(saved) !== Object.prototype || !HEX64.test(transaction?.transactionNonce || '')
        || !HEX64.test(transaction?.bootNonce || '')) throw new Error('oid_triple_start_environment_invalid');
    return { ...saved, ...(transaction.bootstrap ? { NASSAJ_UPDATE_MODE: rollback ? 'release' : 'local-main' } : {}),
        NASSAJ_PREVIEW_TRANSACTION_NONCE: transaction.transactionNonce, NASSAJ_PREVIEW_BOOT_NONCE: transaction.bootNonce };
}

function verifyTripleRetainedRecord(root, record) {
    const reference = record.recoveryReference;
    if (reference?.transactionNonce !== record.transactionNonce || !HEX64.test(reference.executorManifestSha256 || '')) throw new Error('oid_triple_retained_executor_missing');
    const storage = path.join(gitControlRoot(root), 'nassaj-oid-recovery');
    const directory = path.join(storage, record.transactionNonce, 'executor');
    for (const file of [storage, path.dirname(directory), directory]) {
        const stat = lstatSync(file);
        if (!stat.isDirectory() || realpathSync(file) !== file || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('oid_triple_retained_directory_unsafe');
    }
    const descriptor = pinnedJson(path.join(directory, 'executor-manifest.json'), 'triple_executor_manifest', { sha256: reference.executorManifestSha256, mode: 0o600 });
    if (descriptor.schema !== 'nassaj-oid-retained-executor/v2' || descriptor.repoRoot !== root
        || descriptor.transactionNonce !== record.transactionNonce || descriptor.actionId !== record.actionId
        || descriptor.targetDigest !== record.pair.targetDigest
        || JSON.stringify(descriptor.files?.map(file => file.name)) !== '["launcher.mjs","capsule.mjs","safe-restart.sh","control-manifest.json","record.json"]') throw new Error('oid_triple_retained_binding_invalid');
    const contents = {};
    for (const expected of descriptor.files) {
        const file = path.join(directory, expected.name), metadata = lstatSync(file);
        if (metadata.nlink !== 1 || metadata.uid !== process.getuid() || metadata.size !== expected.size) throw new Error('oid_triple_retained_file_unsafe');
        contents[expected.name] = pinnedFile(file, 'triple_retained_file', { sha256: expected.sha256, mode: 0o600 }).bytes;
    }
    const { recoveryReference: ignored, resume: ignoredResume, ...original } = record;
    if (pairCanonical(JSON.parse(contents['record.json'])) !== pairCanonical(original)) throw new Error('oid_triple_retained_record_changed');
    return contents;
}

function prepareFullClientPublicationArchives(root, target, previous) {
    const candidate = path.join(root, '.nassaj-local-preview/client-candidates', target.clientBuildId);
    if (!fs.existsSync(path.join(candidate, 'CLIENT_ASSET_MANIFEST.json'))) return;
    const verifier = expected => directory => {
        if (hashOidPairTree(directory) !== expected) throw new Error('full_client_archive_tree_changed');
    };
    const live = path.join(root, 'dist');
    if (fs.existsSync(path.join(live, 'CLIENT_ASSET_MANIFEST.json'))) prepareClientPublicationAssets(root, live, {}, verifier(previous.clientTreeSha256));
    prepareClientPublicationAssets(root, candidate, {}, verifier(target.clientTreeSha256));
}

function tripleCurrentRuntime() {
    return { nodeBinarySha256: sha(pinnedFile(realpathSync(process.execPath), 'triple_node', { maxSize: Number.MAX_SAFE_INTEGER }).bytes),
        nodeVersion: process.version, nodeModuleAbi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch };
}

/** Capture the actual independently served client and loaded server before full-update preparation. */
export async function captureOidTriplePreviousGeneration(root, liveManifest, { allowQualifiedMismatch = false } = {}) {
    if (!allowQualifiedMismatch && hashOidPairDependencyTree(path.join(root, 'node_modules')) !== liveManifest.runtimeDependenciesSha256) throw new Error('oid_triple_previous_dependencies_unverified');
    const server = provenance(path.join(root, 'dist-server')), client = provenance(path.join(root, 'dist'));
    const previous = { schema: 'nassaj-oid-triple-previous/v2', clientBuildId: client.buildId, serverBuildId: server.buildId, clientOid: client.commit,
        clientTreeSha256: hashOidPairTree(path.join(root, 'dist')), serverTreeSha256: hashOidPairTree(path.join(root, 'dist-server')),
        nodeModulesTreeSha256: hashDependencyTreeV2(path.join(root, 'node_modules')).sha256,
        controlManifestSha256: sha(pinnedFile(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), 'triple_previous_manifest').bytes), installRuntime: tripleCurrentRuntime() };
    previous.runtime = await probeOidPairPreviousRuntime(root, previous);
    if (!previous.runtime || sha(readFileSync(`/proc/${previous.runtime.pid}/exe`)) !== previous.installRuntime.nodeBinarySha256) throw new Error('oid_triple_previous_interpreter_unverified');
    previous.clientPublication = captureClientPublicationBaseline(root, previous);
    return previous;
}

function bootstrapReferenceJson(reference, label) {
    if (!reference || Object.keys(reference).sort().join(',') !== 'file,sha256' || !path.isAbsolute(reference.file)
        || !HEX64.test(reference.sha256 || '')) throw new Error(`oid_bootstrap_${label}_reference_invalid`);
    return JSON.parse(readBootstrapPinnedFile(reference.file, reference.sha256));
}

function bootstrapRetainedCodeClosure(root, record) {
    verifyTripleRetainedRecord(root, record);
    const file = path.join(gitControlRoot(root), 'nassaj-oid-recovery', record.transactionNonce, 'executor', 'executor-manifest.json');
    const descriptor = pinnedJson(file, 'bootstrap_executor_manifest', { sha256: record.recoveryReference.executorManifestSha256, mode: 0o600 });
    if (descriptor.codeClosure?.descriptor?.schema !== 'nassaj-bootstrap-executable-closure/v1'
        || !HEX64.test(descriptor.codeClosure.sha256 || '')) throw new Error('oid_bootstrap_executor_closure_invalid');
    return descriptor.codeClosure.sha256;
}

function verifyBootstrapPreviousMaterialLive(root, previousMaterial, previous, supervisor, controlManifest) {
    const digest = relative => sha(pinnedFile(path.join(root, relative), `bootstrap_previous_${relative.replaceAll('/','_')}`, { maxSize: Number.MAX_SAFE_INTEGER }).bytes);
    const expected = {
        oid: previous.runtime.oid, clientOid: previous.clientOid, serverBuildId: previous.serverBuildId, clientBuildId: previous.clientBuildId,
        controlManifestSha256: previous.controlManifestSha256,
        serverInputManifestSha256: digest('dist-server/SERVER_INPUT_MANIFEST.json'),
        serverProvenanceSha256: digest('dist-server/BUILD_PROVENANCE.json'), clientProvenanceSha256: digest('dist/BUILD_PROVENANCE.json'),
        clientTreeSha256: previous.clientTreeSha256, serverTreeSha256: previous.serverTreeSha256,
        nodeModulesTreeSha256: previous.nodeModulesTreeSha256, dependencyLegacyActualSha256: hashOidPairDependencyTree(path.join(root, 'node_modules')),
        nodeBinarySha256: sha(pinnedFile(realpathSync(process.execPath), 'bootstrap_previous_node', { maxSize: Number.MAX_SAFE_INTEGER }).bytes),
        nodeVersion: process.version, nodeModuleAbi: process.versions.modules, pm2PackageTreeSha256: supervisor.pm2TreeSha256,
        safeRestartSha256: digest('dist-server/scripts/safe-restart.sh'),
        admissionImplementationSha256: digest('dist-server/OID_CONTROL_CAPSULE.mjs'), mode: 'release',
    };
    if (controlManifest.safeRestartSha256 !== expected.safeRestartSha256
        || controlManifest.capsuleSha256 !== expected.admissionImplementationSha256) throw new Error('oid_bootstrap_previous_control_changed');
    for (const [key, value] of Object.entries(expected)) {
        if (previousMaterial[key] !== value) throw new Error(`oid_bootstrap_previous_${key}_changed`);
    }
    return expected;
}

/** Recompute every available live binding before consuming the one-shot ticket. */
async function verifyBootstrapExecutionBindings(root, record, state, previous, supervisor, { clock = bootstrapClock() } = {}) {
    const bootstrap = record.bootstrap, ticket = bootstrap?.ticket, material = ticket?.material;
    if (!ticket || bootstrap.proposalEnvBase64 === undefined || !bootstrap.previousMaterial
        || typeof bootstrap.previousControlManifestBase64 !== 'string' || !bootstrap.qualificationReference) {
        throw new Error('oid_bootstrap_record_invalid');
    }
    const codeClosureSha256 = bootstrapRetainedCodeClosure(root, record);
    if (material.installation.root !== root || material.installation.commonGit !== gitControlRoot(root)
        || material.installation.hostname !== hostname() || material.installation.serviceUid !== process.getuid()
        || material.event.sequence !== state.sequence || material.event.group !== state.group || material.event.oid !== state.oid
        || material.event.targetDigest !== state.targetDigest || material.approval.ownerId !== String(record.pair.ownerId)
        || material.executor.transactionNonce !== record.transactionNonce || material.executor.codeClosureSha256 !== codeClosureSha256) {
        throw new Error('oid_bootstrap_live_binding_changed');
    }
    const candidateManifest = bootstrapReferenceJson(bootstrap.candidateManifestReference, 'candidate_manifest');
    if (bootstrap.candidateManifestReference.sha256 !== material.event.manifestSha256
        || candidateManifest.releaseCommit !== material.event.oid
        || candidateManifest.serverBuildId !== state.target.serverBuildId
        || candidateManifest.clientBuildId !== state.target.clientBuildId) throw new Error('oid_bootstrap_candidate_manifest_changed');
    for (const key of ['clientBuildId','serverBuildId','controlManifestSha256','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256']) {
        if (material.previous[key] !== previous[key] || bootstrap.previousMaterial[key] !== previous[key]) throw new Error('oid_bootstrap_previous_changed');
    }
    const previousStatus = readFileSync(`/proc/${previous.runtime.pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m);
    if (material.previous.pid !== previous.runtime.pid || !previousStatus || material.previous.ppid !== Number(previousStatus[1])
        || material.previous.startTicks !== previous.runtime.startTime || material.supervisor.pid !== supervisor.daemon.pid
        || material.supervisor.startTicks !== supervisor.daemon.startTime
        || material.supervisor.observerSha256 !== sha(pairCanonical(supervisor.observer))
        || material.supervisor.slotSha256 !== supervisor.controlsSha256
        || material.supervisor.environmentSha256 !== supervisor.environmentSha256
        || material.supervisor.dumpSha256 !== supervisor.dumpSha256) throw new Error('oid_bootstrap_runtime_changed');
    const database = lstatSync(material.database.path);
    if (!database.isFile() || database.isSymbolicLink() || String(database.dev) !== material.database.dev
        || String(database.ino) !== material.database.ino || (database.mode & 0o777) !== 0o600) throw new Error('oid_bootstrap_database_changed');
    const currentEnv = pinnedFile(path.join(root, '.env'), 'bootstrap_original_mode', { mode: 0o600 }).bytes;
    const proposal = bootstrapProposalBytes(record), mode = validateBootstrapModeProposal(currentEnv, proposal);
    if (mode.originalSha256 !== material.mode.originalEnvSha256 || mode.proposalSha256 !== material.mode.proposalEnvSha256) throw new Error('oid_bootstrap_mode_changed');
    const previousManifest = Buffer.from(bootstrap.previousControlManifestBase64, 'base64');
    if (previousManifest.toString('base64') !== bootstrap.previousControlManifestBase64
        || sha(previousManifest) !== bootstrap.previousMaterial.controlManifestSha256) throw new Error('oid_bootstrap_previous_manifest_changed');
    const liveManifest = JSON.parse(previousManifest);
    verifyBootstrapPreviousMaterialLive(root, bootstrap.previousMaterial, previous, supervisor, liveManifest);
    const qualified = inspectBootstrapQualification({ installation: material.installation, actualPrevious: bootstrap.previousMaterial,
        liveManifest, executorCodeClosureSha256: codeClosureSha256,
        verifierClosureSha256: sha(verifyTripleRetainedRecord(root, record)['capsule.mjs']), qualificationReference: bootstrap.qualificationReference });
    if (qualified.qualificationSha256 !== material.baseline.attestationSha256
        || qualified.reportSha256 !== material.baseline.rehearsalSha256 || qualified.databasePath !== material.database.path) {
        throw new Error('oid_bootstrap_qualification_changed');
    }
    const review = bootstrapReferenceJson(bootstrap.reviewReference, 'review');
    const receipt = bootstrapReferenceJson(bootstrap.approvalReference, 'approval');
    if (bootstrap.approvalReference.sha256 !== material.approval.receiptSha256) throw new Error('oid_bootstrap_approval_changed');
    validateBootstrapApprovalChain(ticket, review, receipt, bootstrap.ownerPrincipal, clock);
    verifyBootstrapTicket(ticket, material, clock);
    return { material, codeClosureSha256, qualified };
}

function tripleReadClaim(root, transaction, record, { requireFresh = true } = {}) {
    const state = pinnedJson(path.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(transaction.sequence).padStart(16, '0')}.json`), 'triple_event').localUpdate;
    if (state.targetDigest !== transaction.pair.targetDigest || state.activation?.actionId !== transaction.actionId
        || state.activation?.transactionNonce !== transaction.transactionNonce
        || (transaction.pair.authority || state.consent)?.ownerId !== String(record.pair.ownerId)
        || (transaction.pair.authoritySourceSha256 && transaction.pair.authoritySourceSha256 !== sha(pairCanonical(state.policyAuthorization || state.consent)))
        || computeOidTripleTargetDigest({ sequence: state.sequence, group: state.group, sourceOid: state.oid, target: state.target }) !== transaction.pair.targetDigest
        || (requireFresh && git(root, ['rev-parse','--verify','refs/heads/main^{commit}']) !== state.oid)) throw new Error('oid_triple_claim_changed');
    if (!requireFresh) return state;
    inspectOidPairAuthority(root, state, record.pair.ownerId);
    const database = new DatabaseSync(record.pair.databasePath, { readOnly: true });
    try {
        if (!database.prepare("SELECT id FROM users WHERE id=? AND role='owner' AND is_active=1 AND status='active'").get(record.pair.ownerId)) throw new Error('oid_triple_owner_not_authorized');
    } finally { database.close(); }
    return state;
}

function tripleLocation(root, transaction, name) {
    const target = transaction.pair.target;
    return { live: path.join(root, name === 'nodeModules' ? 'node_modules' : name === 'server' ? 'dist-server' : 'dist'),
        candidate: name === 'nodeModules' ? oidTripleDependencySlot(root, transaction)
            : path.join(root, '.nassaj-local-preview', `${name}-candidates`, target[`${name}BuildId`]) };
}

function tripleCloneParents(root, nonce, { create = false } = {}) {
    if (!HEX64.test(nonce || '') || realpathSync(root) !== root) throw new Error('oid_triple_clone_context_invalid');
    const directories = [root, path.join(root, '.nassaj-local-preview'), path.join(root, '.nassaj-local-preview', 'dependency-exchanges')];
    directories.push(path.join(directories[2], nonce));
    const device = lstatSync(path.join(root, 'node_modules')).dev, identities = [];
    for (const [index, directory] of directories.entries()) {
        if (create && index >= 2 && !fs.existsSync(directory)) { fs.mkdirSync(directory, { mode: 0o700 }); fsyncDir(path.dirname(directory)); }
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || realpathSync(directory) !== directory || stat.uid !== process.getuid()
            || stat.mode & 0o022 || stat.dev !== device || (index >= 2 && (stat.mode & 0o777) !== 0o700)
            || Number(fs.statfsSync(directory).type) === 0x01021994) throw new Error('oid_triple_clone_parent_unsafe');
        identities.push({ path: directory, dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: stat.mode & 0o777 });
    }
    return identities;
}

/** Derive the sole permitted exchange slot from the original journal; canonical is never a fallback. */
export function oidTripleDependencySlot(root, transaction) {
    const descriptor = transaction.dependencyExchange;
    if (descriptor?.layout !== 'transaction-copy/v1' || descriptor.phase !== 'ready'
        || descriptor.transactionNonce !== transaction.transactionNonce || descriptor.targetDigest !== transaction.pair.targetDigest
        || descriptor.treeSha256 !== transaction.pair.target.nodeModulesTreeSha256
        || descriptor.contractSha256 !== transaction.pair.target.dependencyContractSha256
        || pairCanonical(tripleCloneParents(root, transaction.transactionNonce)) !== pairCanonical(descriptor.parents)) throw new Error('oid_triple_dependency_slot_unverified');
    return path.join(root, '.nassaj-local-preview', 'dependency-exchanges', transaction.transactionNonce, 'node_modules');
}

/** Calculate conservative full-copy storage and inode requirements without reflink assumptions. */
export function oidTripleCloneBudget(source, storage, remainingBudget = 0) {
    if (!Number.isSafeInteger(remainingBudget) || remainingBudget < 0) throw new Error('oid_triple_clone_budget_unknown');
    const block = Number(storage.bsize); let entries = 0, bytes = 0;
    if (!Number.isSafeInteger(block) || block <= 0) throw new Error('oid_triple_clone_budget_unknown');
    function walk(file) {
        const stat = lstatSync(file); entries++;
        if (stat.isDirectory()) for (const name of readdirSync(file)) walk(path.join(file, name));
        else if (stat.isFile()) bytes += Math.ceil(stat.size / block) * block;
        else if (!stat.isSymbolicLink()) throw new Error('oid_triple_clone_special_file');
    }
    walk(source);
    const copyBytes = bytes + 4 * block * entries, reserveBytes = Math.max(64 * 1024 * 1024, Math.ceil(copyBytes / 10));
    const required = copyBytes + reserveBytes + remainingBudget;
    if (![entries, required, Number(storage.bavail) * block, Number(storage.ffree), Number(storage.favail ?? storage.ffree)].every(Number.isSafeInteger)) throw new Error('oid_triple_clone_budget_unknown');
    if (Number(storage.bavail) * block < required || Number(storage.favail ?? storage.ffree) < entries + 128) throw new Error('oid_triple_clone_storage_unavailable');
    return { copyBytes, reserveBytes, remainingBudget, entries, block };
}

function tripleCopyRegularFile(source, destination, expected) {
    const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output;
    try {
        const before = fstatSync(input);
        if (!before.isFile() || before.nlink !== expected.nlink || before.dev !== expected.dev || before.ino !== expected.ino) throw new Error('oid_triple_clone_source_raced');
        output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const buffer = Buffer.allocUnsafe(1024 * 1024); let count;
        while ((count = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
            let offset = 0;
            while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
        }
        const after = fstatSync(input);
        if (before.ctimeMs !== after.ctimeMs || before.size !== after.size || after.nlink !== before.nlink) throw new Error('oid_triple_clone_source_raced');
        fs.fchmodSync(output, before.mode & 0o777); fsyncSync(output);
    } finally { if (output !== undefined) closeSync(output); closeSync(input); }
}

function tripleCopySealedTree(source, destination) {
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { mode: 0o700 });
        for (const name of readdirSync(source).sort()) tripleCopySealedTree(path.join(source, name), path.join(destination, name));
        fs.chmodSync(destination, stat.mode & 0o777); fsyncDir(destination);
    } else if (stat.isSymbolicLink()) fs.symlinkSync(readlinkSync(source), destination);
    else if (stat.isFile()) {
        tripleCopyRegularFile(source, destination, stat);
    } else throw new Error('oid_triple_clone_special_or_shared_file');
}

/** Caller holds all update leases; persist clone intent and verify a private copy before any stop. */
export function prepareOidTripleDependencyExchange(root, file, transaction, { remainingBudget = 0 } = {}) {
    if (transaction.oldStopIntentAt || transaction.oldStoppedAt || transaction.pair.databaseState !== 'PRE_CANDIDATE') throw new Error('oid_triple_clone_after_stop_forbidden');
    const target = validateOidTripleTargetDescriptor(transaction.pair.target);
    const source = path.join(root, '.nassaj-local-preview', 'dependency-candidates', target.nodeModulesTreeSha256);
    for (const directory of [root, path.join(root, '.nassaj-local-preview'), path.dirname(source)]) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || realpathSync(directory) !== directory || stat.uid !== process.getuid() || stat.mode & 0o022) throw new Error('oid_triple_clone_source_parent_unsafe');
    }
    const before = hashDependencyTreeV2(source, { requireSealed: true });
    if (before.sha256 !== target.nodeModulesTreeSha256) throw new Error('oid_triple_clone_source_changed');
    let current = transaction;
    if (!current.dependencyExchange) {
        current = { ...current, dependencyExchange: { layout: 'transaction-copy/v1', phase: 'intent', transactionNonce: current.transactionNonce,
            targetDigest: current.pair.targetDigest, treeSha256: target.nodeModulesTreeSha256, contractSha256: target.dependencyContractSha256 } };
        durable(file, current); injectFailure('triple_clone_after_intent');
    }
    const descriptor = current.dependencyExchange;
    if (descriptor.layout !== 'transaction-copy/v1' || descriptor.transactionNonce !== current.transactionNonce
        || descriptor.targetDigest !== current.pair.targetDigest || descriptor.treeSha256 !== before.sha256
        || descriptor.contractSha256 !== target.dependencyContractSha256 || !['intent','copying','ready'].includes(descriptor.phase)) throw new Error('oid_triple_clone_intent_invalid');
    const parents = tripleCloneParents(root, current.transactionNonce, { create: descriptor.phase === 'intent' });
    if (descriptor.parents && pairCanonical(descriptor.parents) !== pairCanonical(parents)) throw new Error('oid_triple_clone_parent_changed');
    const directory = parents.at(-1).path, candidate = path.join(directory, 'node_modules'), temporary = path.join(directory, 'preparing');
    if (!fs.existsSync(candidate)) {
        if (descriptor.phase === 'ready' || fs.existsSync(temporary)) throw new Error('oid_triple_clone_partial_requires_review');
        const budget = oidTripleCloneBudget(source, fs.statfsSync(directory), remainingBudget);
        current = { ...current, dependencyExchange: { ...descriptor, phase: 'copying', parents, budget } }; durable(file, current);
        tripleCopySealedTree(source, temporary); injectFailure('triple_clone_after_copy');
        if (pairCanonical(hashDependencyTreeV2(temporary, { requireSealed: true })) !== pairCanonical(before)
            || pairCanonical(hashDependencyTreeV2(source, { requireSealed: true })) !== pairCanonical(before)) throw new Error('oid_triple_clone_changed');
        if (fs.existsSync(candidate)) throw new Error('oid_triple_clone_destination_exists');
        renameSync(temporary, candidate); fsyncDir(directory); injectFailure('triple_clone_after_publish');
    }
    if (pairCanonical(hashDependencyTreeV2(candidate, { requireSealed: true })) !== pairCanonical(before)
        || pairCanonical(hashDependencyTreeV2(source, { requireSealed: true })) !== pairCanonical(before)) throw new Error('oid_triple_clone_changed');
    if (pairCanonical(tripleCloneParents(root, current.transactionNonce)) !== pairCanonical(parents)) throw new Error('oid_triple_clone_parent_changed');
    const budget = current.dependencyExchange.budget;
    const storage = fs.statfsSync(directory);
    if (!budget || Number(storage.bavail) * Number(storage.bsize) < budget.reserveBytes + remainingBudget
        || Number(storage.favail ?? storage.ffree) < 128) throw new Error('oid_triple_clone_reserve_unavailable');
    current = { ...current, dependencyExchange: { ...current.dependencyExchange, phase: 'ready', parents, readyAt: Date.now() } };
    durable(file, current); return current;
}

async function exchangeOidTripleGenerations(root, file, transaction, direction, record) {
    let current = transaction;
    for (const name of direction === 'forward' ? UPDATE_GENERATION_NAMES : [...UPDATE_GENERATION_NAMES].reverse()) {
        verifyTripleRetainedRecord(root, record);
        tripleReadClaim(root, current, record, { requireFresh: false });
        if (current.persistence?.stopped?.state !== 'verified') throw new Error('oid_triple_stopped_persistence_missing');
        const stoppedSlot = validateOidTriplePm2Slot(await triplePm2Read(current.supervisor), current.supervisor, 'stopped');
        validateOidTriplePm2Dump(pinnedJson(path.join(current.supervisor.pm2Home, 'dump.pm2'), 'triple_stopped_dump'), stoppedSlot);
        if (!pairOwnerProvablyDead(current.pair.previous.runtime)) throw new Error('oid_triple_old_process_not_dead');
        const plan = inspectOidTripleGenerationPlan(root, current, direction);
        if (plan.state !== 'verified') throw new Error(plan.reason);
        const step = plan.steps.find(item => item.name === name), locations = tripleLocation(root, current, name);
        const intent = { ...locations, previous: current.pair.previous[`${name}TreeSha256`], target: current.pair.target[`${name}TreeSha256`], direction, operation: step.operation, state: 'intent' };
        current = { ...current, state: `triple_${direction}_${name}_intent`, exchanges: { ...current.exchanges, [name]: intent } }; durable(file, current);
        injectFailure(`triple_${direction}_${name}_before_exchange`);
        if (step.operation === 'exchange') await exchange(locations.candidate, locations.live);
        fsyncDir(path.dirname(locations.live)); fsyncDir(path.dirname(locations.candidate));
        injectFailure(`triple_${direction}_${name}_after_exchange`);
        const verified = inspectOidTripleGenerationPlan(root, current, direction);
        if (verified.state !== 'verified' || verified.steps.find(item => item.name === name).operation !== 'attest') throw new Error('oid_triple_exchange_unverified');
        current = { ...current, state: `triple_${direction}_${name}_done`, exchanges: { ...current.exchanges, [name]: { ...intent, state: 'done' } } }; durable(file, current);
    }
    return current;
}

const OID_TRIPLE_ORIGIN_FAILURE_CODES = new Set([
    'oid_triple_start_unverified', 'oid_triple_health_unverified', 'oid_triple_child_unverified',
    'oid_triple_stop_unverified', 'oid_triple_exchange_unverified', 'oid_triple_previous_runtime_unverified',
    'oid_native_probe_isolation_or_abi_failed', 'oid_native_probe_identity_invalid',
    'oid_native_probe_dependencies_changed', 'oid_native_probe_proof_invalid',
]);

/** Preserve the first bounded cause on an existing bound transaction; never create admission evidence. */
export function recordOidTripleOriginFailure(file, expected, error) {
    let latest;
    try { latest = pinnedJson(file, 'triple_origin_journal'); }
    catch (readError) { if (readError.code === 'ENOENT') return null; throw readError; }
    if (latest.schema !== 'nassaj-oid-control-transaction/v2' || latest.sequence !== expected.sequence
        || latest.transactionNonce !== expected.transactionNonce || latest.actionId !== expected.actionId
        || latest.pair?.targetDigest !== expected.pair?.targetDigest) throw new Error('oid_triple_origin_binding_changed');
    if (latest.originFailureCode !== undefined) return latest;
    const reason = [error?.code, error?.message].find(value => OID_TRIPLE_ORIGIN_FAILURE_CODES.has(value)) || 'unknown';
    const updated = { ...latest, originFailureCode: reason };
    durable(file, updated);
    return updated;
}

/** Persist bounded start failure against the latest exact transaction without downgrading child evidence. */
export function recordOidTripleSafeStartFailure(file, expected, phase, result) {
    if (!['start-target','start-previous'].includes(phase)) throw new Error('oid_triple_start_diagnostic_phase_invalid');
    const latest = pinnedJson(file, 'triple_start_diagnostic_journal');
    if (latest.schema !== 'nassaj-oid-control-transaction/v2' || latest.sequence !== expected.sequence
        || latest.transactionNonce !== expected.transactionNonce || latest.actionId !== expected.actionId
        || latest.pair?.targetDigest !== expected.pair?.targetDigest || latest.bootNonce !== expected.bootNonce
        || latest.bootDirection !== expected.bootDirection || latest.bootDirection !== (phase === 'start-target' ? 'target' : 'previous')) {
        throw new Error('oid_triple_start_diagnostic_binding_changed');
    }
    const diagnostic = createOidTripleSafeDiagnostic().summarize(result.diagnostic?.exitCode, result.diagnostic?.signal);
    diagnostic.reason = SAFE_STOP_DIAGNOSTIC_CODES.has(result.diagnostic?.reason) ? result.diagnostic.reason : 'unknown';
    if (diagnostic.reason === 'unknown' && result.pipeError) diagnostic.reason = oidTripleSafeDiagnosticReason(result.pipeError);
    const updated = { ...latest, safeStartFailure: { phase, ...diagnostic, pipeError: Boolean(result.pipeError) } };
    durable(file, updated);
    return updated;
}

async function startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction, rollback = false) {
    const slot = validateOidTriplePm2Slot(await triplePm2Read(transaction.supervisor), transaction.supervisor, 'stopped');
    const stoppedEnvironment = slot.pm2_env.env || {};
    const stoppedMode = transaction.bootstrap && (rollback || Object.hasOwn(stoppedEnvironment, 'NASSAJ_UPDATE_MODE')) ? 'release' : 'local-main';
    assertOidTripleEffectiveMode(root, stoppedEnvironment, stoppedMode);
    let current = { ...transaction, state: rollback ? 'triple_previous_start_intent' : 'triple_candidate_start_intent',
        bootDirection: rollback ? 'previous' : 'target', bootNonce: randomBytes(32).toString('hex'),
        pair: { ...transaction.pair, databaseState: rollback ? 'PRE_CANDIDATE' : 'UNKNOWN' } };
    durable(file, current);
    handle.transition({ phase: 'OID_BOOTSTRAP_VERIFYING', databaseState: current.pair.databaseState });
    injectFailure(rollback ? 'triple_before_previous_start' : 'triple_before_candidate_start');
    const result = await runSafe(safeBytes, ['--oid-triple-phase', rollback ? 'start-previous' : 'start-target'], { ...record, artifactRoot: path.join(root, 'dist-server') });
    if (result.status !== 0 || result.pipeError) {
        recordOidTripleSafeStartFailure(file, current, rollback ? 'start-previous' : 'start-target', result);
        throw new Error('oid_triple_start_unverified');
    }
    const selected = rollback ? current.pair.previous : current.pair.target;
    const proof = await health({ oid: rollback ? selected.runtime.oid : current.oid, buildId: selected.serverBuildId,
        transactionNonce: current.transactionNonce, bootNonce: current.bootNonce, oldStartTicks: record.oldStartTicks });
    if (!proof || proof.clientBuildIdServed !== selected.clientBuildId || proof.oidNodeModulesTreeSha256 !== selected.nodeModulesTreeSha256
        || proof.oidPairTargetDigest !== current.pair.targetDigest) throw new Error('oid_triple_health_unverified');
    const child = pinnedJson(path.join(handle.paths.controlRoot, `oid-child-${current.transactionNonce}.json`), 'triple_child');
    if (child.schema !== 'nassaj-oid-triple-bootstrap/v2' || child.pid !== proof.pid || child.startTime !== proof.serverProcessStartTicks
        || child.nodeModulesTreeSha256 !== selected.nodeModulesTreeSha256 || !pairOwnerAlive(child)) throw new Error('oid_triple_child_unverified');
    current = await persistOidTriplePm2Slot(root, file, current, 'online', child);
    current = pairTerminalReceipt(root, { ...current, pair: { ...current.pair, databaseState: rollback ? 'PRE_CANDIDATE' : 'TARGET_VERIFIED' } }, file,
        rollback ? 'rolled_back' : 'activated', { pid: proof.pid, startTime: proof.serverProcessStartTicks, serverOid: rollback ? selected.runtime.oid : current.oid,
            clientBuildIdServed: proof.clientBuildIdServed, oidNodeModulesTreeSha256: proof.oidNodeModulesTreeSha256, oidPairTargetDigest: proof.oidPairTargetDigest,
            ...(rollback && selected.clientPublication ? { http: await probeOidRollbackClientHttp(root) } : {}) });
    injectFailure('triple_after_terminal');
    const state = tripleReadClaim(root, current, record, { requireFresh: false });
    pairRecordEvent(root, state, { phase: rollback ? 'failed' : 'awaiting_serving', receipt: current.pair.receipt, ...(rollback ? { consent: null } : {}) });
    completeOidPairAdmission(root, handle);
    return current.pair.receipt;
}

/** A durable claimed executor may acknowledge ownership before its bounded, non-activating clone work. */
export function prepareOidTripleClaimedDependencyExchange(root, file, transaction, record) {
    const held = pinnedJson(file, 'triple_executor_claim');
    if (held.schema !== 'nassaj-oid-control-transaction/v2' || held.state !== 'triple_prepared'
        || held.transactionNonce !== record.transactionNonce || held.actionId !== record.actionId
        || held.pair?.targetDigest !== record.pair?.targetDigest || pairCanonical(held) !== pairCanonical(JSON.parse(JSON.stringify(transaction)))
        || record.repoRoot !== root || record.handshakePath !== path.join(path.dirname(file), `nassaj-oid-control-handshake-${record.transactionNonce}.json`)
        || held.oldStopIntentAt || held.pair.databaseState !== 'PRE_CANDIDATE') throw new Error('oid_triple_executor_claim_invalid');
    durable(record.handshakePath, { schema: 1, state: 'executor_ready', launcherNonce: record.transactionNonce, transactionNonce: record.transactionNonce,
        sequence: held.sequence, oid: held.oid, buildId: held.pair.target.serverBuildId, journalFile: file });
    return prepareOidTripleDependencyExchange(root, file, held);
}

/** Three-generation extension of the same capsule; no application survives a dependency exchange. */
async function runOidTripleTransaction(record, safeBytes, initial) {
    const root = record.repoRoot, expected = { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce };
    verifyTripleRetainedRecord(root, record);
    if (activeTransactions(root).length) throw new Error('oid_triple_recovery_required');
    const manifests = pairRequireCapabilities(root, initial), previous = await captureOidTriplePreviousGeneration(root, manifests.live);
    const supervisor = await captureOidTripleSupervisor(root, record);
    const identity = { sequence: initial.sequence, group: initial.group, oid: initial.oid, targetDigest: initial.targetDigest,
        transactionNonce: record.transactionNonce, journalBasename: `nassaj-oid-control-transaction-${initial.sequence}-${record.transactionNonce}.json`,
        previousClientBuildId: previous.clientBuildId, previousServerBuildId: previous.serverBuildId,
        targetClientBuildId: initial.target.clientBuildId, targetServerBuildId: initial.target.serverBuildId };
    let transaction = { schema: 'nassaj-oid-control-transaction/v2', generationNames: UPDATE_GENERATION_NAMES, ...identity,
        buildId: initial.target.serverBuildId, actionId: record.actionId, owner: pairProcessIdentity(), supervisor,
        recoveryReference: record.recoveryReference, state: 'pair_admission_intent',
        pair: { targetDigest: initial.targetDigest, target: initial.target, previous, databaseState: 'PRE_CANDIDATE', activationNotClaimed: true } };
    transaction.fullUpdateWaiter = await claimFullClientPublicationWaiter(root, initial.sequence, record.transactionNonce);
    const handle = await beginOidPairAdmission(root, identity, { intent: transaction }), file = path.join(handle.paths.gitRoot, identity.journalBasename);
    try {
        await handle.lockPublishers();
        let state = inspectConfirmedOidPair(root, expected); pairRequireCapabilities(root, state);
        pairVerifyLive(root, { targetClientBuildId: previous.clientBuildId, targetServerBuildId: previous.serverBuildId }, previous);
        await assertOidPairPreviousRuntime(root, previous);
        const snapshot = await prepareOidTriplePublicationSnapshot(root, state.target, previous, record.pair.databasePath, { ...identity, ownerId: record.pair.ownerId, actionId: record.actionId });
        state = inspectConfirmedOidPair(root, expected);
        state = pairRecordEvent(root, state, { phase: 'activation_claimed', activation: { actionId: record.actionId, transactionNonce: record.transactionNonce, claimedAt: Date.now() } });
        transaction = { ...transaction, state: 'triple_prepared', pair: { ...transaction.pair, snapshot, previousMaintenance: handle.original,
            activationNotClaimed: false, consent: state.consent, authority: inspectOidPairAuthority(root, state, record.pair.ownerId),
                authoritySourceSha256: sha(pairCanonical(state.policyAuthorization || state.consent)) } }; durableCreate(file, transaction);
        transaction = prepareOidTripleClaimedDependencyExchange(root, file, transaction, record);
        tripleReadClaim(root, transaction, record);
        transaction = { ...transaction, state: 'triple_old_stop_intent', oldStopIntentAt: Date.now() }; durable(file, transaction);
        handle.transition({ phase: 'OID_EXCHANGING' });
        injectFailure('triple_before_old_stop');
        const stopped = await runSafe(safeBytes, ['--oid-triple-phase','stop','--exec'], { ...record, artifactRoot: path.join(root, 'dist-server') });
        transaction = pinnedJson(file, 'triple_stopped_journal');
        if (stopped.status !== 0 || transaction.state !== 'triple_old_stopped') {
            transaction = { ...transaction, safeStopFailure: stopped.diagnostic }; durable(file, transaction);
            throw new Error('oid_triple_stop_unverified');
        }
        injectFailure('triple_after_old_stop');
        transaction = await exchangeOidTripleGenerations(root, file, transaction, 'forward', record);
        const nativeProbe = runOidTripleNativeProbe(root, path.join(root, 'node_modules'), { ...transaction.pair.target, transactionNonce: record.transactionNonce });
        transaction = { ...transaction, nativeProbe }; durable(file, transaction);
        tripleReadClaim(root, transaction, record, { requireFresh: false });
        return await startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction);
    } catch (error) {
        try { recordOidTripleOriginFailure(file, transaction, error); }
        finally { await recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, transaction, error); }
        throw error;
    } finally { handle.release(); }
}

/** Refuse recovery evidence belonging to a different retained transaction. */
export function assertOidTripleFailureBinding(actual, expected) {
    if (actual?.schema !== 'nassaj-oid-control-transaction/v2' || actual.schema !== expected?.schema
        || actual.sequence !== expected.sequence || actual.actionId !== expected.actionId
        || actual.transactionNonce !== expected.transactionNonce || actual.targetDigest !== expected.targetDigest
        || !actual.pair?.targetDigest || actual.pair.targetDigest !== expected.pair?.targetDigest) {
        throw new Error('oid_triple_recovery_binding_changed');
    }
    return actual;
}

async function recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, fallback, error) {
    let journalObserved = false;
    const readBound = label => {
        let latest;
        try { latest = pinnedJson(file, label); journalObserved = true; }
        catch (readError) {
            if (readError.code !== 'ENOENT' || journalObserved || fallback.state !== 'pair_admission_intent'
                || fallback.pair?.activationNotClaimed !== true || fallback.oldStopIntentAt || fallback.oldStoppedAt
                || fallback.bootDirection || fallback.bootNonce) throw readError;
            latest = fallback;
        }
        return assertOidTripleFailureBinding(latest, fallback);
    };
    let transaction = readBound('triple_failure_journal');
    const refreshPre = () => {
        const latest = readBound('triple_failure_pre_effect');
        if (latest.pair.databaseState !== 'PRE_CANDIDATE' || latest.state !== transaction.state
            || latest.bootDirection !== transaction.bootDirection || latest.oldStoppedAt !== transaction.oldStoppedAt
            || latest.oldStopIntentAt !== transaction.oldStopIntentAt) throw new Error('oid_triple_recovery_binding_changed');
        return latest;
    };
    if (transaction.pair.databaseState === 'PRE_CANDIDATE') {
        let plan = { state: 'manual', steps: [] };
        const beforeStop = !transaction.oldStopIntentAt && !transaction.oldStoppedAt && !transaction.bootDirection;
        if (beforeStop) {
            try {
                const grant = path.join(handle.paths.controlRoot, `oid-child-${transaction.transactionNonce}.json`);
                try { lstatSync(grant); throw new Error('oid_triple_pre_stop_child_observed'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                pairVerifyLive(root, { targetClientBuildId: transaction.pair.previous.clientBuildId, targetServerBuildId: transaction.pair.previous.serverBuildId }, transaction.pair.previous);
                plan = { state: 'verified', steps: [] };
            } catch {}
        } else { try { plan = inspectOidTripleGenerationPlan(root, transaction, 'rollback'); } catch {} }
        if (plan.state === 'verified' && plan.steps.every(step => step.operation === 'attest') && pairOwnerAlive(transaction.pair.previous.runtime)) {
            try {
                await assertOidPairPreviousRuntime(root, transaction.pair.previous);
                transaction = refreshPre();
                const event = pinnedJson(path.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(transaction.sequence).padStart(16,'0')}.json`), 'triple_not_started_event').localUpdate;
                transaction = refreshPre();
                if (event.targetDigest === transaction.pair.targetDigest) pairRecordEvent(root, event, { phase: 'failed', consent: null });
                durable(file, { ...transaction, state: 'restart_deferred_restored', error: 'oid_triple_not_started' });
                injectFailure('full_waiter_after_pre_effect_terminal');
                releaseFullWaiterBeforeEffects(root, transaction, file);
                const { checksum: ignoredChecksum, sequence: ignoredSequence, ...original } = handle.original || transaction.pair.previousMaintenance;
                handle.transition({ ...original, oidAdmissionIntent: null });
                return { restored: true };
            } catch (failure) { if (failure.message === 'oid_triple_recovery_binding_changed') throw failure; /* A stopping process with unavailable health cannot authorize OPEN. */ }
        }
        try {
            if (beforeStop || plan.state !== 'verified' || !pairOwnerProvablyDead(transaction.pair.previous.runtime)) throw new Error('oid_triple_rollback_not_proven');
            transaction = refreshPre();
            validateOidTriplePm2Slot(await triplePm2Read(transaction.supervisor), transaction.supervisor, 'stopped');
            transaction = refreshPre();
            if (!transaction.oldStoppedAt) {
                if (transaction.state !== 'triple_old_stop_intent') throw new Error('oid_triple_stop_intent_missing');
                transaction = await persistOidTriplePm2Slot(root, file, transaction, 'stopped');
                transaction = { ...transaction, oldStoppedAt: Date.now(), stopReconciled: true }; durable(file, transaction);
            }
            transaction = refreshPre();
            transaction = await exchangeOidTripleGenerations(root, file, transaction, 'rollback', record);
            transaction = refreshPre();
            if (transaction.bootstrapMode) transaction = restoreBootstrapModeCAS(root, file, transaction, record);
            return await startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction, true);
        } catch (failure) { if (failure.message === 'oid_triple_recovery_binding_changed') throw failure; /* Preserve PRE_CANDIDATE evidence; a failed proof is never an implicit OPEN. */ }
    }
    // The safe child may have durably advanced start/terminal evidence since our
    // last local value. Never replace that evidence with a stale rollback frame.
    transaction = readBound('triple_failure_latest');
    if (!['pair_served','pair_rolled_back'].includes(transaction.state)) durable(file, { ...transaction, state: 'manual_recovery_required', error: 'oid_triple_recovery_requires_retained_executor' });
    handle.transition({ state: 'MANUAL', gateClosed: true, phase: 'OID_RECOVERING', recoveryError: 'oid_triple_recovery_requires_retained_executor' });
    return { restored: false, error: error.message };
}

async function attestOidTripleExistingChild(root, record, handle, file, transaction) {
    const rollback = transaction.bootDirection === 'previous';
    const plan = inspectOidTripleGenerationPlan(root, transaction, rollback ? 'rollback' : 'forward');
    if (plan.state !== 'verified' || plan.steps.some(step => step.operation !== 'attest')) throw new Error('oid_triple_resume_generations_unknown');
    const selected = rollback ? transaction.pair.previous : transaction.pair.target;
    const child = pinnedJson(path.join(handle.paths.controlRoot, `oid-child-${transaction.transactionNonce}.json`), 'triple_resume_child');
    if (child.schema !== 'nassaj-oid-triple-bootstrap/v2' || child.rollback !== rollback || !pairOwnerAlive(child)
        || child.nodeModulesTreeSha256 !== selected.nodeModulesTreeSha256 || child.targetDigest !== transaction.pair.targetDigest) throw new Error('oid_triple_resume_child_unverified');
    const proof = await health({ oid: rollback ? selected.runtime.oid : transaction.oid, buildId: selected.serverBuildId,
        transactionNonce: transaction.transactionNonce, bootNonce: transaction.bootNonce, oldStartTicks: record.oldStartTicks }, 3);
    if (!proof || proof.pid !== child.pid || proof.serverProcessStartTicks !== child.startTime
        || proof.clientBuildIdServed !== selected.clientBuildId || proof.oidNodeModulesTreeSha256 !== selected.nodeModulesTreeSha256
        || proof.oidPairTargetDigest !== transaction.pair.targetDigest) throw new Error('oid_triple_resume_health_unverified');
    transaction = await persistOidTriplePm2Slot(root, file, transaction, 'online', child);
    const current = ['pair_served','pair_rolled_back'].includes(transaction.state) ? transaction
        : pairTerminalReceipt(root, { ...transaction, pair: { ...transaction.pair, databaseState: rollback ? 'PRE_CANDIDATE' : 'TARGET_VERIFIED' } }, file,
            rollback ? 'rolled_back' : 'activated', { pid: proof.pid, startTime: proof.serverProcessStartTicks, serverOid: rollback ? selected.runtime.oid : transaction.oid,
                clientBuildIdServed: proof.clientBuildIdServed, oidNodeModulesTreeSha256: proof.oidNodeModulesTreeSha256, oidPairTargetDigest: proof.oidPairTargetDigest,
            ...(rollback && selected.clientPublication ? { http: await probeOidRollbackClientHttp(root) } : {}) });
    if (!validateOidPairTerminal(root, current) || current.pair.receipt.pid !== proof.pid || current.pair.receipt.startTime !== child.startTime) throw new Error('oid_triple_resume_terminal_invalid');
    qualifyRestoredClientPublication(root, current);
    pairRecordTerminalEvent(root, current);
    completeOidPairAdmission(root, handle);
    return current.pair.receipt;
}

async function abortBootstrapClaimWithoutJournal(root, record, paths) {
    const ticket = record.bootstrap.ticket, nonce = record.transactionNonce;
    const claimFile = path.join(paths.gitRoot, 'nassaj-oid-recovery', nonce, `bootstrap-claim-${ticket.nonce}.json`);
    const claimBytes = readBootstrapPrivateFile(claimFile), claim = JSON.parse(claimBytes);
    const binding = bootstrapJournalBinding(ticket, { claim, sha256: sha(claimBytes) });
    if (!pairOwnerProvablyDead(claim.owner)) throw new Error('oid_triple_resume_owner_alive_or_unknown');
    const qualified = record.bootstrap.previousMaterial;
    for (const key of ['clientBuildId','serverBuildId','controlManifestSha256','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256']) {
        if (qualified[key] !== ticket.material.previous[key]) throw new Error('oid_bootstrap_previous_changed');
    }
    const previous = { schema: 'nassaj-oid-triple-previous/v2', clientBuildId: qualified.clientBuildId, serverBuildId: qualified.serverBuildId,
        clientOid: qualified.clientOid, clientTreeSha256: qualified.clientTreeSha256, serverTreeSha256: qualified.serverTreeSha256,
        nodeModulesTreeSha256: qualified.nodeModulesTreeSha256, controlManifestSha256: qualified.controlManifestSha256,
        runtime: { pid: ticket.material.previous.pid, startTime: ticket.material.previous.startTicks, bootId: ticket.bootId,
            oid: qualified.oid, serverBuildId: qualified.serverBuildId, clientBuildId: qualified.clientBuildId } };
    pairVerifyLive(root, { targetClientBuildId: previous.clientBuildId, targetServerBuildId: previous.serverBuildId }, previous);
    await assertOidPairPreviousRuntime(root, previous);
    const database = lstatSync(ticket.material.database.path), maintenance = pairReadMaintenance(paths);
    if (maintenance.state !== 'OPEN' || maintenance.gateClosed || maintenance.oidAdmissionIntent
        || git(root, ['rev-parse','--verify','refs/heads/main^{commit}']) !== ticket.material.event.oid
        || sha(pinnedFile(path.join(root, '.env'), 'bootstrap_claim_only_mode', { mode: 0o600 }).bytes) !== ticket.material.mode.originalEnvSha256
        || String(database.dev) !== ticket.material.database.dev || String(database.ino) !== ticket.material.database.ino) {
        throw new Error('oid_bootstrap_pre_effect_state_changed');
    }
    const abortFile = path.join(path.dirname(claimFile), 'bootstrap-aborted-pre-effect.json');
    const receipt = bootstrapAbortReceipt(binding.claimSha256, nonce);
    if (fs.existsSync(abortFile)) {
        validateBootstrapAbortReceipt(abortFile, binding.claimSha256, nonce);
    } else durableCreate(abortFile, receipt);
    return { state: 'aborted_pre_effect', transactionNonce: nonce };
}

/** Explicit re-entry of the retained executor; a stopped app never supplies an automatic recovery daemon. */
async function resumeOidTripleTransaction(record, safeBytes) {
    const root = record.repoRoot;
    if (record.resume.operatorUid !== process.getuid() || !/^[A-Za-z0-9:_-]{1,120}$/.test(record.resume.permissionRef || '')) throw new Error('oid_triple_resume_permission_invalid');
    verifyTripleRetainedRecord(root, record);
    const sequence = record.bootstrap?.ticket?.material?.event?.sequence ?? record.pair.sequence;
    const paths = pairPaths(root), locks = [], file = path.join(paths.gitRoot, `nassaj-oid-control-transaction-${sequence}-${record.transactionNonce}.json`);
    const attempt = randomBytes(16).toString('hex');
    const receiptFile = path.join(paths.gitRoot, 'nassaj-oid-recovery', record.transactionNonce, `resume-${attempt}.json`);
    let current, transaction, handle;
    try {
        for (const lock of [paths.admission, paths.activity, ...['nassaj-local-preview-build.lock','nassaj-client-build.lock','nassaj-preview-event-mutation.lock'].map(name => path.join(paths.gitRoot, name))]) locks.push(await pairLock(lock));
        current = pairReadMaintenance(paths);
        if (record.bootstrap && current.state === 'OPEN' && !current.gateClosed && !current.oidAdmissionIntent) {
            const sequence = record.bootstrap.ticket.material.event.sequence;
            const preEffectFile = path.join(paths.gitRoot, `nassaj-oid-control-transaction-${sequence}-${record.transactionNonce}.json`);
            let preEffect;
            try { preEffect = pinnedJson(preEffectFile, 'bootstrap_pre_effect_recovery'); }
            catch (error) { if (error.code === 'ENOENT') return abortBootstrapClaimWithoutJournal(root, record, paths); throw error; }
            if (preEffect.state === 'pair_admission_intent' && preEffect.bootstrap && !preEffect.oldStopIntentAt && !preEffect.oldStoppedAt
                && !preEffect.bootDirection && preEffect.pair?.activationNotClaimed === true && preEffect.pair.databaseState === 'PRE_CANDIDATE') {
                if (!pairOwnerProvablyDead(preEffect.owner)) throw new Error('oid_triple_resume_owner_alive_or_unknown');
                const codeClosureSha256 = bootstrapRetainedCodeClosure(root, record);
                verifyBootstrapJournalBinding(preEffect, record, bootstrapClaimBytes(root, record, preEffect), codeClosureSha256);
                pairVerifyLive(root, { targetClientBuildId: preEffect.pair.previous.clientBuildId,
                    targetServerBuildId: preEffect.pair.previous.serverBuildId }, preEffect.pair.previous);
                await assertOidPairPreviousRuntime(root, preEffect.pair.previous);
                const ticket = record.bootstrap.ticket, database = lstatSync(ticket.material.database.path);
                if (git(root, ['rev-parse','--verify','refs/heads/main^{commit}']) !== ticket.material.event.oid
                    || sha(pinnedFile(path.join(root, '.env'), 'bootstrap_abort_mode', { mode: 0o600 }).bytes) !== ticket.material.mode.originalEnvSha256
                    || String(database.dev) !== ticket.material.database.dev || String(database.ino) !== ticket.material.database.ino) {
                    throw new Error('oid_bootstrap_pre_effect_state_changed');
                }
                const aborted = { ...preEffect, state: 'aborted_pre_effect', abortedAt: Date.now() }; durable(preEffectFile, aborted);
                const abortFile = path.join(paths.gitRoot, 'nassaj-oid-recovery', record.transactionNonce, 'bootstrap-aborted-pre-effect.json');
                if (fs.existsSync(abortFile)) validateBootstrapAbortReceipt(abortFile,
                    preEffect.bootstrap.claimSha256, record.transactionNonce);
                else durableCreate(abortFile, bootstrapAbortReceipt(preEffect.bootstrap.claimSha256,
                    record.transactionNonce, aborted.abortedAt));
                return { state: 'aborted_pre_effect', transactionNonce: record.transactionNonce };
            }
        }
        transaction = pairJournal(paths, current.identity?.oid).value;
        if (transaction.schema !== 'nassaj-oid-control-transaction/v2' || transaction.transactionNonce !== record.transactionNonce
            || transaction.actionId !== record.actionId || transaction.pair.targetDigest !== record.pair.targetDigest
            || pairCanonical(transaction.recoveryReference) !== pairCanonical(record.recoveryReference)) throw new Error('oid_triple_resume_binding_changed');
        if (record.bootstrap) {
            const codeClosureSha256 = bootstrapRetainedCodeClosure(root, record);
            verifyBootstrapJournalBinding(transaction, record, bootstrapClaimBytes(root, record, transaction), codeClosureSha256);
        } else if (transaction.bootstrap) throw new Error('oid_triple_resume_binding_changed');
        if (current.state === 'OPEN') {
            validateOidPairMaintenance(root, current);
            durableCreate(receiptFile, { ...record.resume, attempt, state: 'already_completed', transactionNonce: record.transactionNonce });
            return transaction.pair.receipt;
        }
        if (!pairOwnerProvablyDead(current.owner) || !pairOwnerProvablyDead(transaction.owner)) throw new Error('oid_triple_resume_owner_alive_or_unknown');
        durableCreate(receiptFile, { ...record.resume, attempt, state: 'intent', transactionNonce: record.transactionNonce });
        const terminal = ['pair_served','pair_rolled_back'].includes(transaction.state);
        if (!terminal) {
            transaction = { ...transaction, owner: pairProcessIdentity(), resume: { ...record.resume, attempt } }; durable(file, transaction);
        }
        current = pairWriteMaintenance(paths, current, { owner: { ...current.owner, ...pairProcessIdentity() }, phase: 'OID_RECOVERING' });
        handle = { paths, original: transaction.pair.previousMaintenance, get journal() { return current; },
            transition(patch) { current = pairWriteMaintenance(paths, current, patch); return current; },
            release() { for (const lock of [...locks].reverse()) lock.release(); } };
        if (transaction.pair.databaseState !== 'PRE_CANDIDATE' || terminal || transaction.bootDirection === 'previous') {
            if (transaction.bootDirection !== 'previous') tripleReadClaim(root, transaction, record, { requireFresh: false });
            else {
                const database = new DatabaseSync(record.pair.databasePath, { readOnly: true });
                try { if (!database.prepare("SELECT id FROM users WHERE id=? AND role='owner' AND is_active=1 AND status='active'").get(record.pair.ownerId)) throw new Error('oid_triple_resume_owner_not_authorized'); }
                finally { database.close(); }
            }
            const result = await attestOidTripleExistingChild(root, record, handle, file, transaction);
            durable(receiptFile, { ...record.resume, attempt, state: 'verified_completed', transactionNonce: record.transactionNonce });
            return result;
        }
        const result = await recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, transaction, new Error('explicit_resume'));
        if (pairReadMaintenance(paths).state !== 'OPEN') throw new Error('oid_triple_resume_manual_required');
        durable(receiptFile, { ...record.resume, attempt, state: 'previous_restored', transactionNonce: record.transactionNonce });
        return result;
    } catch (error) {
        if (handle && current.state !== 'OPEN') handle.transition({ state: 'MANUAL', gateClosed: true, phase: 'OID_RECOVERING', recoveryError: 'oid_triple_resume_unverified' });
        if (fs.existsSync(receiptFile)) durable(receiptFile, { ...record.resume, attempt, state: 'manual_required', transactionNonce: record.transactionNonce });
        throw error;
    } finally { for (const lock of [...locks].reverse()) lock.release(); }
}

/** Archive both sealed clients before database snapshot preparation; failures preserve the actual prior client. */
export async function prepareOidTriplePublicationSnapshot(root, target, previous, databasePath, identity) {
    prepareFullClientPublicationArchives(root, target, previous);
    return captureOidPairSnapshot(databasePath, identity);
}

/** Verify owner and capture the existing snapshot descriptor format using sealed builtins only. */
export async function captureOidPairSnapshot(databasePath, identity) {
    if (!path.isAbsolute(databasePath) || realpathSync(databasePath) !== databasePath) throw new Error('oid_pair_database_path_invalid');
    pinnedFile(databasePath, 'pair_database', { mode: 0o600, maxSize: Number.MAX_SAFE_INTEGER });
    const snapshotRoot = path.join(path.dirname(databasePath), 'nassaj-update-db-snapshots');
    fs.mkdirSync(snapshotRoot, { mode: 0o700, recursive: true });
    if (lstatSync(snapshotRoot).isSymbolicLink() || (statSync(snapshotRoot).mode & 0o077)) throw new Error('oid_pair_snapshot_root_unsafe');
    const snapshotDir = path.join(snapshotRoot, identity.transactionNonce);
    const storage = fs.statfsSync(snapshotRoot);
    if (Number(storage.type) === 0x01021994 || statSync(snapshotRoot).dev !== statSync(databasePath).dev
        || Number(storage.bavail) * Number(storage.bsize) < statSync(databasePath).size * 2 + 16 * 1024 * 1024) throw new Error('oid_pair_snapshot_storage_unavailable');
    fs.mkdirSync(snapshotDir, { mode: 0o700 }); fsyncDir(snapshotRoot);
    const snapshotFile = path.join(snapshotDir, 'pre-update.sqlite');
    const descriptor = { schema: 'nassaj-update-database-snapshot/v1', transactionId: identity.transactionNonce,
        actionId: identity.actionId, targetCommit: identity.oid, databasePath, snapshotDir, snapshotFile,
        basename: 'pre-update.sqlite', phase: 'CAPTURE_INTENT', sourceIdentity: { dev: String(statSync(databasePath).dev), ino: String(statSync(databasePath).ino) } };
    durable(path.join(snapshotDir, 'descriptor.json'), descriptor);
    const source = new DatabaseSync(databasePath, { readOnly: true });
    const schemaSql = "SELECT type,name,tbl_name AS tableName,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name";
    let sourceSchemaDigest;
    try {
        const owner = source.prepare("SELECT id FROM users WHERE id=? AND role='owner' AND is_active=1 AND status='active'").get(identity.ownerId);
        if (!owner) throw new Error('oid_pair_owner_not_authorized');
        sourceSchemaDigest = sha(JSON.stringify(source.prepare(schemaSql).all()));
        source.prepare('VACUUM INTO ?').run(snapshotFile);
    } finally { source.close(); }
    fs.chmodSync(snapshotFile, 0o600);
    const snapshot = new DatabaseSync(snapshotFile, { readOnly: true });
    let snapshotSchemaDigest;
    try {
        if (Object.values(snapshot.prepare('PRAGMA integrity_check').get())[0] !== 'ok'
            || snapshot.prepare('PRAGMA foreign_key_check').all().length) throw new Error('oid_pair_snapshot_integrity_failed');
        snapshotSchemaDigest = sha(JSON.stringify(snapshot.prepare(schemaSql).all()));
    } finally { snapshot.close(); }
    if (sourceSchemaDigest !== snapshotSchemaDigest) throw new Error('oid_pair_snapshot_schema_mismatch');
    const bytes = pinnedFile(snapshotFile, 'pair_snapshot', { mode: 0o600, maxSize: Number.MAX_SAFE_INTEGER }).bytes;
    const fd = openSync(snapshotFile, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    const complete = { ...descriptor, phase: 'CAPTURED', state: 'captured', sourceSchemaDigest, snapshotSchemaDigest,
        snapshotFingerprint: { sha256: sha(bytes), size: bytes.length } };
    durable(path.join(snapshotDir, 'descriptor.json'), complete);
    return complete;
}

/** Resolve owner authority while keeping policy grants distinct from manual consent. */
export function inspectOidPairAuthority(root, state, ownerId, now = Date.now()) {
    if (state.policyAuthorization && state.consent) throw new Error('oid_pair_authority_ambiguous');
    const authority = state.policyAuthorization ? inspectLocalUpdatePolicyGrant(root, state, now)
        : { ...state.consent, kind: 'manual' };
    if (!authority || authority.targetDigest !== state.targetDigest || authority.expiresAt <= now
        || authority.ownerId !== String(ownerId) || !Number.isSafeInteger(authority.expiresAt)) throw new Error('oid_pair_consent_invalid');
    return authority;
}

/** Read-only exact pair consent inspection for the server action classifier and sealed executor. */
export function inspectConfirmedOidPair(root, expected, { now = Date.now() } = {}) {
    if (!Number.isSafeInteger(expected?.sequence) || expected.sequence < 1 || !HEX64.test(expected.targetDigest || '')) throw new Error('oid_pair_request_invalid');
    const sequence = String(expected.sequence).padStart(16, '0');
    const record = pinnedJson(path.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${sequence}.json`), 'pair_event');
    const state = record.localUpdate;
    if (state?.schema !== 'nassaj-local-update/v1' || state.mode !== 'local-main' || state.sequence !== expected.sequence
        || state.targetDigest !== expected.targetDigest || state.group !== `event-${sequence}` || record.oid !== state.oid
        || JSON.stringify(state.domains) !== '["client","server"]' || state.phase !== 'awaiting_sessions'
        ) throw new Error('oid_pair_consent_invalid');
    inspectOidPairAuthority(root, state, expected.ownerId, now);
    const triple = state.target?.schema === 'nassaj-oid-triple-target/v2';
    if (state.policyAuthorization && !triple) throw new Error('oid_policy_requires_triple');
    if (state.target?.schema && !triple) throw new Error('oid_target_schema_unknown');
    const digest = triple ? computeOidTripleTargetDigest({ sequence: state.sequence, group: state.group, sourceOid: state.oid, target: state.target })
        : sha(JSON.stringify({ sequence: state.sequence, group: state.group, oid: state.oid, domains: state.domains, target: state.target }));
    if (digest !== state.targetDigest || git(root, ['rev-parse', '--verify', 'refs/heads/main^{commit}']) !== state.oid) throw new Error('oid_pair_target_changed');
    for (const domain of ['client', 'server']) {
        const buildId = state.target[`${domain}BuildId`];
        if (!HEX64.test(buildId || '')) throw new Error('oid_pair_build_invalid');
        const directory = path.join(root, '.nassaj-local-preview', `${domain}-candidates`, buildId);
        const candidate = provenance(directory);
        if (candidate.commit !== state.oid || candidate.baseCommit !== state.oid || candidate.dirty !== false || candidate.buildId !== buildId
            || hashOidPairTree(directory) !== state.target[`${domain}TreeSha256`]) throw new Error('oid_pair_candidate_changed');
    }
    if (triple) {
        verifyOidDependencyCandidate(root, state.target);
    }
    if (state.activation && (state.activation.actionId !== expected.actionId || state.activation.transactionNonce !== expected.transactionNonce)) throw new Error('oid_pair_activation_conflict');
    return state;
}

/** Claim the already-persisted full waiter before admission locks; no nested event acquisition. */
async function claimFullClientPublicationWaiter(root, sequence, transactionNonce) {
    const lease = await pairLock(path.join(gitControlRoot(root), 'nassaj-preview-event-mutation.lock'));
    try { return claimFullClientPublicationWaiterHeld(root, sequence, transactionNonce); }
    finally { lease.release(); }
}

function claimFullClientPublicationWaiterHeld(root, sequence, transactionNonce) {
    const file = path.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(sequence).padStart(16, '0')}.json`);
    const record = pinnedJson(file, 'full_waiter_event'), waiter = record.fullUpdateWaiter;
    if (!waiter) {
        const loaded = pinnedJson(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), 'full_waiter_manifest');
        if (loaded.capabilities?.clientPublicationV1) throw new Error('full_update_waiter_required');
        return null;
    }
    if (waiter.schema !== 'nassaj-full-update-waiter/v1' || waiter.requestId !== `local-update:${sequence}`
        || waiter.sequence !== sequence || !Number.isSafeInteger(waiter.revision) || waiter.revision < 1
        || waiter.phase !== 'waiting' || waiter.effect !== 'none') throw new Error('full_update_waiter_conflict');
    const next = { ...waiter, revision: waiter.revision + 1, phase: 'effects_started', effect: 'started', transactionNonce };
    durable(file, { ...record, fullUpdateWaiter: next });
    return next;
}

/** Close a full waiter only after the capsule proves no stop/DB effect and the actual previous pair. Caller holds event EX. */
export function releaseFullWaiterBeforeEffects(root, transaction, journalFile, options = {}) {
    if (!transaction.fullUpdateWaiter) return null;
    const terminal = pinnedJson(journalFile, 'full_waiter_pre_effect_terminal');
    if (terminal.state !== 'restart_deferred_restored' || terminal.transactionNonce !== transaction.transactionNonce
        || terminal.pair?.databaseState !== 'PRE_CANDIDATE' || terminal.oldStopIntentAt || terminal.oldStoppedAt || terminal.bootDirection || terminal.bootNonce
        || terminal.pair?.activationNotClaimed !== true || !pairOwnerAlive(terminal.pair.previous.runtime)) throw new Error('full_waiter_pre_effect_unproven');
    const eventFile = path.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(terminal.sequence).padStart(16, '0')}.json`);
    const event = pinnedJson(eventFile, 'full_waiter_pre_effect_event'), waiter = event.fullUpdateWaiter;
    const expected = transaction.fullUpdateWaiter;
    const file = path.join(gitControlRoot(root), `nassaj-full-waiter-disposition-${terminal.transactionNonce}.json`);
    pairVerifyLive(root, { targetClientBuildId: terminal.pair.previous.clientBuildId, targetServerBuildId: terminal.pair.previous.serverBuildId }, terminal.pair.previous);
    if (event.localUpdate?.activation) throw new Error('full_waiter_pre_effect_cas_conflict');
    if (waiter?.phase === 'released' && waiter.requestId === expected.requestId && waiter.revision === expected.revision + 1
        && waiter.transactionNonce === terminal.transactionNonce) {
        const bytes = pinnedFile(file, 'full_waiter_pre_effect_receipt').bytes, prior = JSON.parse(bytes);
        if (sha(bytes) !== waiter.receiptDigest || prior.requestId !== expected.requestId || prior.revision !== expected.revision
            || prior.transactionNonce !== terminal.transactionNonce || prior.journalDigest !== sha(pinnedFile(journalFile, 'full_waiter_pre_effect_journal').bytes)) throw new Error('full_waiter_pre_effect_receipt_changed');
        return waiter;
    }
    if (waiter?.requestId !== expected.requestId || waiter.revision !== expected.revision || waiter.transactionNonce !== terminal.transactionNonce
        || waiter.phase !== 'effects_started' || event.localUpdate?.activation) throw new Error('full_waiter_pre_effect_cas_conflict');
    const receipt = { schema: 'nassaj-full-update-waiter-disposition/v1', outcome: 'failed_before_effects',
        sequence: terminal.sequence, transactionNonce: terminal.transactionNonce, requestId: waiter.requestId, revision: waiter.revision,
        journalDigest: sha(pinnedFile(journalFile, 'full_waiter_pre_effect_journal').bytes), previous: terminal.pair.previous };
    try { durableCreate(file, receipt); } catch (error) {
        if (error.code !== 'EEXIST' || pairCanonical(pinnedJson(file, 'full_waiter_pre_effect_receipt')) !== pairCanonical(receipt)) throw error;
    }
    options.afterWrite?.('receipt');
    injectFailure('full_waiter_after_disposition_receipt');
    const next = { ...waiter, revision: waiter.revision + 1, phase: 'released', effect: 'settled', reason: 'failed_before_effects',
        receiptDigest: sha(pinnedFile(file, 'full_waiter_pre_effect_receipt').bytes) };
    durable(eventFile, { ...event, fullUpdateWaiter: next });
    options.afterWrite?.('event');
    injectFailure('full_waiter_after_disposition_event');
    return next;
}

function settledFullWaiter(root, record, patch) {
    const waiter = record.fullUpdateWaiter, receipt = patch.receipt;
    if (!waiter || !receipt || !['served', 'rolled_back'].includes(receipt.outcome)) return waiter;
    if (waiter.phase === 'released') return waiter;
    if (waiter.transactionNonce !== receipt.transactionNonce || waiter.phase !== 'effects_started') throw new Error('full_update_waiter_terminal_conflict');
    const journal = pinnedJson(path.join(gitControlRoot(root), `nassaj-oid-control-transaction-${waiter.sequence}-${waiter.transactionNonce}.json`), 'full_waiter_terminal');
    if (!validateOidPairTerminal(root, journal)) throw new Error('full_update_waiter_receipt_unverified');
    const receiptFile = path.join(gitControlRoot(root), `nassaj-oid-pair-${receipt.outcome === 'served' ? 'serving-' : 'receipt-'}${receipt.transactionNonce}.json`);
    return { ...waiter, revision: waiter.revision + 1, phase: 'released', effect: 'settled', reason: receipt.outcome,
        receiptDigest: sha(pinnedFile(receiptFile, 'full_waiter_receipt').bytes) };
}

function pairRecordEvent(root, state, patch) {
    const file = path.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(state.sequence).padStart(16, '0')}.json`);
    const record = pinnedJson(file, 'pair_event_write');
    if (record.localUpdate.revision !== state.revision || record.localUpdate.targetDigest !== state.targetDigest) throw new Error('oid_pair_event_cas');
    const next = { ...state, ...patch, revision: state.revision + 1 };
    const fullUpdateWaiter = settledFullWaiter(root, record, patch);
    durable(file, { ...record, localUpdate: next, ...(fullUpdateWaiter ? { fullUpdateWaiter } : {}) });
    return next;
}

function pairRequireCapabilities(root, state) {
    const live = pinnedJson(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), 'pair_loaded_manifest', { mode: 0o444 });
    const target = pinnedJson(path.join(root, '.nassaj-local-preview/server-candidates', state.target.serverBuildId, 'OID_CONTROL_MANIFEST.json'),
        'pair_candidate_manifest', { sha256: state.target.controlManifestSha256, mode: 0o444 });
    if (state.target?.schema === 'nassaj-oid-triple-target/v2') {
        validateOidTripleTargetDescriptor(state.target);
        if (live.capabilities?.oidTripleAdmissionV2 !== true || target.capabilities?.oidTripleAdmissionV2 !== true) throw new Error('triple_activation_unavailable');
        verifyOidTripleManifest(target, state.target);
        assertOidTripleRuntime(state.target.installRuntime);
    } else {
        if (live.capabilities?.oidPairAdmissionV1 !== true || target.capabilities?.oidPairAdmissionV1 !== true) throw new Error('pair_activation_unavailable');
        verifyOidPairDependencies(root, live, target, state.oid);
    }
    return { live, target };
}

function bootstrapClaimBytes(root, record, transaction) {
    const ticket = record.bootstrap.ticket;
    const file = path.join(gitControlRoot(root), 'nassaj-oid-recovery', record.transactionNonce, `bootstrap-claim-${ticket.nonce}.json`);
    if (!HEX64.test(transaction.bootstrap?.claimSha256 || '')) throw new Error('oid_bootstrap_claim_binding_missing');
    return readBootstrapPinnedFile(file, transaction.bootstrap.claimSha256);
}

/** Execute the accepted one-shot release -> local-main bootstrap inside the retained triple chain. */
async function runBootstrapOidTripleTransaction(record, safeBytes, initial) {
    const root = record.repoRoot, ticket = record.bootstrap.ticket;
    if (initial.target?.schema !== 'nassaj-oid-triple-target/v2' || record.resume) throw new Error('oid_bootstrap_record_invalid');
    verifyTripleRetainedRecord(root, record);
    if (activeTransactions(root).length) throw new Error('oid_triple_recovery_required');
    const manifests = pairRequireCapabilities(root, initial);
    const previous = await captureOidTriplePreviousGeneration(root, manifests.live, { allowQualifiedMismatch: true });
    const supervisor = await captureOidTripleSupervisor(root, record);
    const identity = { sequence: initial.sequence, group: initial.group, oid: initial.oid, targetDigest: initial.targetDigest,
        transactionNonce: record.transactionNonce, journalBasename: `nassaj-oid-control-transaction-${initial.sequence}-${record.transactionNonce}.json`,
        previousClientBuildId: previous.clientBuildId, previousServerBuildId: previous.serverBuildId,
        targetClientBuildId: initial.target.clientBuildId, targetServerBuildId: initial.target.serverBuildId };
    let transaction = { schema: 'nassaj-oid-control-transaction/v2', generationNames: UPDATE_GENERATION_NAMES, ...identity,
        buildId: initial.target.serverBuildId, actionId: record.actionId, owner: pairProcessIdentity(), supervisor,
        recoveryReference: record.recoveryReference, state: 'pair_admission_intent', bootstrapPending: true,
        pair: { targetDigest: initial.targetDigest, target: initial.target, previous, databaseState: 'PRE_CANDIDATE', activationNotClaimed: true } };
    let verified = await verifyBootstrapExecutionBindings(root, record, initial, previous, supervisor);
    const handle = await beginBootstrapOidAdmission(root, identity, transaction, async () => {
        const state = inspectConfirmedOidPair(root, { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce });
        pairVerifyLive(root, { targetClientBuildId: previous.clientBuildId, targetServerBuildId: previous.serverBuildId }, previous);
        await assertOidPairPreviousRuntime(root, previous);
        verified = await verifyBootstrapExecutionBindings(root, record, state, previous, supervisor);
        return { ...consumeBootstrapTicket(ticket, verified.material, pairProcessIdentity(), bootstrapClock()), ticket };
    });
    const file = path.join(handle.paths.gitRoot, identity.journalBasename);
    transaction = handle.claimedTransaction;
    try {
        transaction.fullUpdateWaiter = claimFullClientPublicationWaiterHeld(root, initial.sequence, record.transactionNonce);
        const snapshot = await prepareOidTriplePublicationSnapshot(root, initial.target, previous, record.pair.databasePath, { ...identity,
            ownerId: record.pair.ownerId, actionId: record.actionId });
        let state = inspectConfirmedOidPair(root, { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce });
        state = pairRecordEvent(root, state, { phase: 'activation_claimed', activation: {
            actionId: record.actionId, transactionNonce: record.transactionNonce, claimedAt: Date.now() } });
        transaction = { ...transaction, state: 'triple_prepared',
            pair: { ...transaction.pair, snapshot, previousMaintenance: handle.original, activationNotClaimed: false,
                consent: state.consent, authority: inspectOidPairAuthority(root, state, record.pair.ownerId),
                authoritySourceSha256: sha(pairCanonical(state.policyAuthorization || state.consent)) } };
        durable(file, transaction);
        transaction = prepareOidTripleClaimedDependencyExchange(root, file, transaction, record);
        const freshState = tripleReadClaim(root, transaction, record);
        verified = await verifyBootstrapExecutionBindings(root, record, freshState, previous, supervisor);
        verifyBootstrapTicket(ticket, verified.material, bootstrapClock());
        transaction = { ...transaction, state: 'triple_old_stop_intent', oldStopIntentAt: Date.now() }; durable(file, transaction);
        handle.transition({ phase: 'OID_EXCHANGING' });
        injectFailure('bootstrap_before_old_stop');
        const stopped = await runSafe(safeBytes, ['--oid-triple-phase','stop','--exec'], { ...record, artifactRoot: path.join(root, 'dist-server') });
        transaction = pinnedJson(file, 'bootstrap_stopped_journal');
        if (stopped.status !== 0 || transaction.state !== 'triple_old_stopped') throw new Error('oid_triple_stop_unverified');
        injectFailure('bootstrap_after_old_stop');
        transaction = applyBootstrapModeCAS(root, file, transaction, record);
        injectFailure('bootstrap_after_mode');
        transaction = await exchangeOidTripleGenerations(root, file, transaction, 'forward', record);
        transaction = { ...transaction, state: 'triple_exchanged' }; durable(file, transaction);
        injectFailure('bootstrap_after_exchange');
        const nativeProbe = runOidTripleNativeProbe(root, path.join(root, 'node_modules'), { ...transaction.pair.target, transactionNonce: record.transactionNonce });
        transaction = { ...transaction, nativeProbe }; durable(file, transaction);
        verifyBootstrapJournalBinding(transaction, record, bootstrapClaimBytes(root, record, transaction), verified.codeClosureSha256);
        return await startAndAttestOidTriple(root, record, safeBytes, handle, file, transaction);
    } catch (error) {
        try { recordOidTripleOriginFailure(file, transaction, error); }
        finally { await recoverOidTripleOwnedFailure(root, record, safeBytes, handle, file, transaction, error); }
        throw error;
    } finally { handle.release(); }
}

/** Execute the paired extension of the existing capsule; UNKNOWN never rolls binaries or DB back. */
export async function runOidPairTransaction(record, safeBytes) {
    const root = record.repoRoot, expected = { ...record.pair, actionId: record.actionId, transactionNonce: record.transactionNonce };
    if (!/^[a-f0-9-]{36}$/.test(record.actionId || '') || !HEX64.test(record.transactionNonce || '')) throw new Error('oid_pair_action_required');
    if (record.resume) return resumeOidTripleTransaction(record, safeBytes);
    let state = inspectConfirmedOidPair(root, expected);
    if (record.bootstrap !== undefined) {
        return runBootstrapOidTripleTransaction(record, safeBytes, state);
    }
    pairRequireCapabilities(root, state);
    if (state.target?.schema === 'nassaj-oid-triple-target/v2') return runOidTripleTransaction(record, safeBytes, state);
    if (activeTransactions(root).length) throw new Error('oid_pair_recovery_required');
    const previous = { clientBuildId: provenance(path.join(root, 'dist')).buildId, serverBuildId: provenance(path.join(root, 'dist-server')).buildId,
        clientTreeSha256: hashOidPairTree(path.join(root, 'dist')), serverTreeSha256: hashOidPairTree(path.join(root, 'dist-server')) };
    previous.runtime = await probeOidPairPreviousRuntime(root, previous);
    if (!previous.runtime) throw new Error('oid_pair_previous_runtime_unverified');
    const identity = { sequence: state.sequence, group: state.group, oid: state.oid, targetDigest: state.targetDigest,
        transactionNonce: record.transactionNonce, journalBasename: `nassaj-oid-control-transaction-${state.sequence}-${record.transactionNonce}.json`,
        previousClientBuildId: previous.clientBuildId, previousServerBuildId: previous.serverBuildId,
        targetClientBuildId: state.target.clientBuildId, targetServerBuildId: state.target.serverBuildId };
    const intent = { schema: 'nassaj-oid-control-transaction/v1', sequence: state.sequence, group: state.group, oid: state.oid,
        buildId: state.target.serverBuildId, transactionNonce: record.transactionNonce, actionId: record.actionId,
        state: 'pair_admission_intent', owner: pairProcessIdentity(), pair: { targetDigest: state.targetDigest,
            target: state.target, previous, databaseState: 'PRE_CANDIDATE', activationNotClaimed: true } };
    intent.fullUpdateWaiter = await claimFullClientPublicationWaiter(root, state.sequence, record.transactionNonce);
    const handle = await beginOidPairAdmission(root, identity, { intent });
    const file = path.join(handle.paths.gitRoot, identity.journalBasename);
    let transaction = null;
    try {
        await handle.lockPublishers();
        state = inspectConfirmedOidPair(root, expected);
        pairRequireCapabilities(root, state);
        if (hashOidPairTree(path.join(root, 'dist')) !== previous.clientTreeSha256
            || hashOidPairTree(path.join(root, 'dist-server')) !== previous.serverTreeSha256) throw new Error('oid_pair_previous_changed');
        const snapshot = await prepareOidTriplePublicationSnapshot(root, state.target, previous, record.pair.databasePath, { ...identity, ownerId: expected.ownerId, actionId: record.actionId });
        state = inspectConfirmedOidPair(root, expected);
        state = pairRecordEvent(root, state, { phase: 'activation_claimed', activation: {
            actionId: record.actionId, transactionNonce: record.transactionNonce, claimedAt: Date.now() } });
        transaction = { schema: 'nassaj-oid-control-transaction/v1', sequence: state.sequence, group: state.group,
            oid: state.oid, buildId: state.target.serverBuildId, transactionNonce: record.transactionNonce,
            actionId: record.actionId, state: 'pair_prepared', owner: pairProcessIdentity(),
            pair: { targetDigest: state.targetDigest, target: state.target, previous, snapshot, previousMaintenance: handle.original, databaseState: 'PRE_CANDIDATE',
                clientExchanged: false, serverExchanged: false, receipt: null } };
        durableCreate(file, transaction);
        durable(record.handshakePath, { schema: 1, state: 'executor_ready', launcherNonce: record.transactionNonce,
            transactionNonce: record.transactionNonce, sequence: state.sequence, oid: state.oid, buildId: state.target.serverBuildId, journalFile: file });
        const save = (phase, fields = {}) => { transaction = { ...transaction, state: phase, pair: { ...transaction.pair, ...fields } }; durable(file, transaction); };
        handle.transition({ phase: 'OID_EXCHANGING' });
        for (const domain of ['client', 'server']) {
            save(`pair_${domain}_exchange_intent`);
            await exchange(path.join(root, '.nassaj-local-preview', `${domain}-candidates`, state.target[`${domain}BuildId`]), path.join(root, domain === 'client' ? 'dist' : 'dist-server'));
            fsyncDir(root); fsyncDir(path.join(root, '.nassaj-local-preview', `${domain}-candidates`)); save(`pair_${domain}_exchanged`, { [`${domain}Exchanged`]: true });
            injectFailure(`pair_after_${domain}_exchange`);
        }
        pairVerifyLive(root, identity, state.target);
        save('pair_bootstrap_verifying', { databaseState: 'UNKNOWN' });
        handle.transition({ phase: 'OID_BOOTSTRAP_VERIFYING', databaseState: 'UNKNOWN' });
        injectFailure('pair_before_bootstrap');
        const bootNonce = randomBytes(32).toString('hex');
        const result = await runSafe(safeBytes, [
        '--set', 'TMPDIR=/var/tmp',
        '--set', `NASSAJ_PREVIEW_TRANSACTION_NONCE=${record.transactionNonce}`,
            '--set', `NASSAJ_PREVIEW_BOOT_NONCE=${bootNonce}`, '--exec'], { ...record, artifactRoot: path.join(root, 'dist-server') });
        if (result.status !== 0 || result.pipeError) throw new Error('oid_pair_restart_unverified');
        const proof = await health({ oid: state.oid, buildId: state.target.serverBuildId, transactionNonce: record.transactionNonce,
            bootNonce, oldStartTicks: record.oldStartTicks });
        if (!proof || proof.clientBuildIdServed !== state.target.clientBuildId || proof.oidPairTargetDigest !== state.targetDigest) throw new Error('oid_pair_health_unverified');
        const child = pinnedJson(path.join(handle.paths.controlRoot, `oid-child-${record.transactionNonce}.json`), 'pair_child_proof');
        if (child.pid !== proof.pid || child.startTime !== proof.serverProcessStartTicks || !pairOwnerAlive(child)) throw new Error('oid_pair_child_unverified');
        pairVerifyLive(root, identity, state.target);
        const receipt = { outcome: 'activated', transactionNonce: record.transactionNonce, targetDigest: state.targetDigest,
            clientBuildId: state.target.clientBuildId, serverBuildId: state.target.serverBuildId, pid: proof.pid,
            startTime: proof.serverProcessStartTicks, completedAt: Date.now() };
        const receiptFile = path.join(handle.paths.gitRoot, `nassaj-oid-pair-receipt-${record.transactionNonce}.json`);
        durableCreate(receiptFile, receipt);
        save('pair_served', { receipt, receiptSha256: sha(pinnedFile(receiptFile, 'pair_terminal_receipt').bytes), databaseState: 'TARGET_VERIFIED' });
        injectFailure('pair_after_terminal');
        pairRecordEvent(root, state, { phase: 'awaiting_serving', receipt, activation: state.activation });
        completeOidPairAdmission(root, handle);
        return receipt;
    } catch (error) {
        // Even PRE_CANDIDATE failures stay closed until a separately proven
        // recovery establishes both generations. No diagnosis-by-rollback.
        if (transaction?.state === 'pair_served') throw error;
        if (transaction?.pair.databaseState === 'PRE_CANDIDATE' && transaction.state !== 'pair_prepared') {
            try {
                await restoreOidPairBeforeCandidate(root, handle, transaction, file);
                throw Object.assign(error, { pairRestored: true });
            } catch (recoveryError) { if (recoveryError.pairRestored) throw recoveryError; }
        }
        if (!transaction || transaction.state === 'pair_prepared') {
            if (hashOidPairTree(path.join(root, 'dist')) === previous.clientTreeSha256
                && hashOidPairTree(path.join(root, 'dist-server')) === previous.serverTreeSha256) {
                await assertOidPairPreviousRuntime(root, previous);
                if (transaction) {
                    durable(file, { ...transaction, state: 'restart_deferred_restored', error: 'oid_pair_not_started' });
                    pairRecordEvent(root, state, { phase: 'failed', consent: null });
                }
                const { checksum: oldChecksum, sequence: oldSequence, ...original } = handle.original;
                handle.transition({ ...original, oidAdmissionIntent: null });
                throw error;
            }
        }
        if (transaction) {
            durable(file, { ...transaction, state: 'manual_recovery_required', error: 'oid_pair_activation_unverified' });
            try { pairRecordEvent(root, state, { phase: 'manual_recovery_required', receipt: { outcome: 'manual_recovery_required', completedAt: Date.now(), transactionNonce: record.transactionNonce } }); } catch {}
        }
        try { handle.transition({ state: 'MANUAL', gateClosed: true, phase: 'OID_RECOVERING', recoveryError: 'oid_pair_activation_unverified' }); } catch {}
        throw error;
    } finally { handle.release(); }
}



/** Verify a terminal pair by its write-once receipt; no mutable runtime probe is used. */
export function validateOidPairTerminal(root, transaction) {
    try {
        const value = transaction.value || transaction;
        if (!['pair_served','pair_rolled_back'].includes(value.state) || !HEX64.test(value.transactionNonce || '') || !HEX64.test(value.pair?.receiptSha256 || '')) return false;
        const bytes = pinnedFile(path.join(gitControlRoot(root), `nassaj-oid-pair-receipt-${value.transactionNonce}.json`), 'pair_receipt', { sha256: value.pair.receiptSha256 }).bytes;
        const receipt = JSON.parse(bytes);
        const rollback = value.state === 'pair_rolled_back';
        const verified = rollback ? value.pair.previous : value.pair.target;
        if (value.pair.target.schema === 'nassaj-oid-triple-target/v2') {
            validateOidTripleTargetDescriptor(value.pair.target);
            if (!value.pair.activationNotClaimed) {
                const persistence = value.persistence?.online;
                if (persistence?.state !== 'verified' || persistence.status !== 'online' || !HEX64.test(persistence.dumpSha256 || '')
                    || persistence.pid !== receipt.pid || persistence.startTime !== receipt.startTime || persistence.bootNonce !== value.bootNonce) return false;
            }
            if (computeOidTripleTargetDigest({ sequence: value.sequence, group: value.group, sourceOid: value.oid, target: value.pair.target }) !== value.pair.targetDigest) return false;
            if (value.schema !== 'nassaj-oid-control-transaction/v2' || JSON.stringify(value.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES)
                || receipt.schema !== 'nassaj-oid-triple-terminal/v2'
                || JSON.stringify(receipt.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES)
                || !HEX64.test(verified.nodeModulesTreeSha256 || '') || receipt.nodeModulesTreeSha256 !== verified.nodeModulesTreeSha256) return false;
        }
        return receipt.outcome === (rollback ? 'rolled_back' : 'activated') && receipt.transactionNonce === value.transactionNonce
            && receipt.targetDigest === value.pair.targetDigest && receipt.clientBuildId === verified.clientBuildId
            && receipt.serverBuildId === verified.serverBuildId && pairCanonical(receipt) === pairCanonical(value.pair.receipt);
    } catch { return false; }
}


/** Narrow post-exchange restart proof; never used to authorize a fresh activation. */
export function inspectOidPairRestart(root, expected) {
    const paths = pairPaths(root), maintenance = pairReadMaintenance(paths);
    const transaction = validateOidPairMaintenance(root, maintenance), identity = maintenance.identity?.oid;
    if (transaction?.pair?.target?.schema === 'nassaj-oid-triple-target/v2') throw new Error('oid_triple_requires_stop_start_path');
    if (!identity || maintenance.phase !== 'OID_BOOTSTRAP_VERIFYING' || maintenance.databaseState !== 'UNKNOWN'
        || !pairOwnerAlive(maintenance.owner) || identity.sequence !== expected.sequence
        || identity.transactionNonce !== expected.transactionNonce || identity.targetDigest !== expected.targetDigest
        || transaction.actionId !== expected.actionId || transaction.pair.databaseState !== 'UNKNOWN') throw new Error('oid_pair_restart_not_owned');
    pairVerifyLive(root, identity, transaction.pair.target);
    return { allowed: true, activationKind: 'oid-pair', sequence: identity.sequence,
        expectedServerBuildId: identity.targetServerBuildId, targetDigest: identity.targetDigest,
        transactionNonce: identity.transactionNonce };
}


/** Baseline installed dependencies, allowing only links whose targets remain inside the dependency root. */
export function hashOidPairDependencyTree(directory) {
    const root = canonicalRoot(directory, 'oid_pair_dependencies');
    const entries = [];
    const visit = (parent, prefix = '') => {
        for (const name of readdirSync(parent).sort()) {
            const file = path.join(parent, name), relative = `${prefix}${name}`, stat = lstatSync(file);
            if (stat.isSymbolicLink()) {
                const destination = realpathSync(file), link = readlinkSync(file), after = lstatSync(file);
                if (!destination.startsWith(`${root}${path.sep}`) || stat.ino !== after.ino || stat.ctimeMs !== after.ctimeMs) throw new Error('oid_pair_dependency_link_unsafe');
                entries.push([relative, 'link', link]);
                continue;
            }
            const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const opened = fstatSync(fd);
                if (opened.isDirectory()) visit(`/proc/self/fd/${fd}`, `${relative}/`);
                else if (opened.isFile()) entries.push([relative, 'file', sha(readFileSync(fd))]);
                else throw new Error('oid_pair_dependency_entry_unsafe');
            } finally { closeSync(fd); }
        }
    };
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { visit(`/proc/self/fd/${fd}`); } finally { closeSync(fd); }
    return sha(JSON.stringify(entries));
}

function verifyOidPairDependencies(root, live, target, targetOid) {
    if (!HEX40.test(live.oid || '') || !HEX64.test(live.runtimeDependenciesSha256 || '')
        || target.runtimeDependenciesSha256 !== live.runtimeDependenciesSha256) throw new Error('oid_pair_dependency_baseline_unavailable');
    const contractAt = oid => oidPairDependencyContract(git(root, ['show', `${oid}:package.json`]), git(root, ['show', `${oid}:package-lock.json`]));
    if (contractAt(live.oid) !== contractAt(targetOid)) throw new Error('oid_pair_dependency_contract_changed');
    if (hashOidPairDependencyTree(path.join(root, 'node_modules')) !== live.runtimeDependenciesSha256) throw new Error('oid_pair_dependency_baseline_unverified');
}


function pairOwnerProvablyDead(owner) {
    if (!Number.isSafeInteger(owner?.pid) || typeof owner.startTime !== 'string' || typeof owner.bootId !== 'string') return false;
    try {
        const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        if (bootId !== owner.bootId) return true;
        try {
            const observed = parseProcessStartTicks(readFileSync(`/proc/${owner.pid}/stat`, 'utf8'));
            return Boolean(observed && observed !== owner.startTime);
        } catch (error) { return ['ENOENT','ESRCH'].includes(error.code); }
    } catch { return false; }
}

function pairTerminalReceipt(root, transaction, file, outcome, proof = {}) {
    const verified = outcome === 'rolled_back' ? transaction.pair.previous : transaction.pair.target;
    const receipt = { ...(transaction.schema === 'nassaj-oid-control-transaction/v2' ? { schema: 'nassaj-oid-triple-terminal/v2',
        generationNames: UPDATE_GENERATION_NAMES, nodeModulesTreeSha256: verified.nodeModulesTreeSha256 } : {}), outcome, transactionNonce: transaction.transactionNonce, targetDigest: transaction.pair.targetDigest,
        clientBuildId: verified.clientBuildId, serverBuildId: verified.serverBuildId, completedAt: Date.now(), ...proof };
    const receiptFile = path.join(gitControlRoot(root), `nassaj-oid-pair-receipt-${transaction.transactionNonce}.json`);
    let recorded = receipt;
    try { durableCreate(receiptFile, receipt); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        recorded = pinnedJson(receiptFile,'pair_terminal_receipt');
        if (recorded.outcome !== outcome || recorded.transactionNonce !== receipt.transactionNonce
            || recorded.targetDigest !== receipt.targetDigest || recorded.clientBuildId !== receipt.clientBuildId
            || recorded.serverBuildId !== receipt.serverBuildId) throw new Error('oid_pair_receipt_conflict');
    }
    const next = { ...transaction, state: outcome === 'rolled_back' ? 'pair_rolled_back' : 'pair_served',
        pair: { ...transaction.pair, receipt: recorded, receiptSha256: sha(pinnedFile(receiptFile,'pair_terminal_receipt').bytes) } };
    durable(file, next);
    qualifyRestoredClientPublication(root, next);
    return next;
}

/** Prove the restored client bytes over the existing local service before rollback qualification. */
export async function probeOidRollbackClientHttp(root) {
    const origin = new URL(process.env.NASSAJ_PREVIEW_HEALTH_URL || 'http://127.0.0.1:3004/health').origin;
    const files = [];
    for (const name of ['index.html', 'version.json']) {
        const response = await fetch(`${origin}/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        const expected = pinnedFile(path.join(root, 'dist', name), 'rollback_http_asset').bytes;
        if (response.status !== 200 || !bytes.equals(expected)) throw new Error('client_rollback_http_bytes_changed');
        files.push({ path: name, status: 200, sha256: sha(bytes) });
    }
    return { schema: 'nassaj-client-http-serving/v1', files };
}

function qualifyRestoredClientPublication(root, transaction) {
    if (transaction.state !== 'pair_rolled_back' || !transaction.pair.previous.clientPublication) return;
    return recordClientPublicationRollbackBaseline(root, transaction, { validateTerminal: validateOidPairTerminal,
        verifyClosure: directory => { hashOidPairTree(directory); } });
}

async function probeOidPairPreviousRuntime(root, previous) {
    try {
        const response = await fetch(process.env.NASSAJ_PREVIEW_HEALTH_URL || 'http://127.0.0.1:3004/health', { signal: AbortSignal.timeout(3000) });
        const body = response.ok ? await response.json() : null;
        const disk = provenance(path.join(root, 'dist-server'));
        if (body?.serverLoadedBuildId !== previous.serverBuildId || body.clientBuildIdServed !== previous.clientBuildId
            || body.serverLoadedOid !== disk.commit || !Number.isSafeInteger(body.pid)) return null;
        const identity = { ...pairProcessIdentity(body.pid), oid: body.serverLoadedOid, serverBuildId: body.serverLoadedBuildId,
            clientBuildId: body.clientBuildIdServed };
        if (String(identity.startTime) !== String(body.serverProcessStartTicks) || !pairOwnerAlive(identity)) return null;
        return identity;
    } catch { return null; }
}

async function assertOidPairPreviousRuntime(root, previous) {
    const runtime = await probeOidPairPreviousRuntime(root, previous);
    if (!runtime || !previous.runtime || pairCanonical(runtime) !== pairCanonical(previous.runtime)) throw new Error('oid_pair_previous_runtime_unverified');
}

async function restoreOidPairBeforeCandidate(root, handle, transaction, file) {
    const current = pairReadMaintenance(handle.paths);
    if (current.databaseState !== 'PRE_CANDIDATE' || transaction.pair.databaseState !== 'PRE_CANDIDATE') throw new Error('oid_pair_unknown_recovery_refused');
    const grant = path.join(handle.paths.controlRoot, `oid-child-${transaction.transactionNonce}.json`);
    try { lstatSync(grant); throw new Error('oid_pair_candidate_bootstrap_observed'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // An intent may have reached disk immediately before a killed process
    // exchanged the directory. Infer orientation only from BOTH complete trees.
    for (const domain of ['server','client']) {
        const live = path.join(root, domain === 'client' ? 'dist' : 'dist-server');
        const candidate = path.join(root, '.nassaj-local-preview', `${domain}-candidates`, transaction.pair.target[`${domain}BuildId`]);
        const liveHash = hashOidPairTree(live), candidateHash = hashOidPairTree(candidate);
        const previousHash = transaction.pair.previous[`${domain}TreeSha256`], targetHash = transaction.pair.target[`${domain}TreeSha256`];
        if (liveHash === previousHash && candidateHash === targetHash) continue;
        if (liveHash !== targetHash || candidateHash !== previousHash) throw new Error('oid_pair_recovery_orientation_unknown');
        durable(file, { ...transaction, state: `pair_${domain}_restore_intent` });
        await exchange(candidate, live); fsyncDir(root); fsyncDir(path.dirname(candidate));
        if (hashOidPairTree(live) !== previousHash) throw new Error('oid_pair_previous_restore_unverified');
    }
    await assertOidPairPreviousRuntime(root, transaction.pair.previous);
    const terminal = pairTerminalReceipt(root, transaction, file, 'rolled_back');
    pairRecordTerminalEvent(root, terminal);
    injectFailure('pair_after_rollback_receipt');
    completeOidPairAdmission(root, handle);
}

function pairRecordTerminalEvent(root, transaction) {
    const file = path.join(gitControlRoot(root), `nassaj-preview-oid-event-control-${String(transaction.sequence).padStart(16, '0')}.json`);
    const state = pinnedJson(file, 'pair_terminal_event').localUpdate;
    if ((!transaction.pair.activationNotClaimed && state.activation?.transactionNonce !== transaction.transactionNonce) || state.targetDigest !== transaction.pair.targetDigest) throw new Error('oid_pair_recovery_event_conflict');
    if (state.phase !== 'activated') pairRecordEvent(root, state, { phase: transaction.state === 'pair_rolled_back' ? 'failed' : 'awaiting_serving', receipt: transaction.pair.receipt });
}

async function recoverOidPairAdmissionIntent(root, observed, waitMs) {
    const paths = pairPaths(root), intent = observed.oidAdmissionIntent;
    if (!pairOwnerProvablyDead(intent.owner)) return { state: 'MANUAL', recovered: false, reason: 'oid_pair_owner_alive_or_unknown' };
    const locks = [];
    try {
        for (const file of [paths.admission, paths.activity, ...['nassaj-local-preview-build.lock','nassaj-client-build.lock','nassaj-preview-event-mutation.lock'].map(name=>path.join(paths.gitRoot,name))]) locks.push(await pairLock(file,waitMs));
        let current = pairReadMaintenance(paths);
        if (pairCanonical(current.oidAdmissionIntent) !== pairCanonical(intent) || !pairOwnerProvablyDead(intent.owner)) throw new Error('oid_pair_admission_intent_changed');
        if (intent.schema !== 'nassaj-oid-admission-intent/v1' || intent.transaction.state !== 'pair_admission_intent'
            || intent.transaction.pair.databaseState !== 'PRE_CANDIDATE' || !['OID_DRAINING','OID_QUIESCENT'].includes(current.phase) && current.state !== 'OPEN') throw new Error('oid_pair_admission_intent_invalid');
        if (current.state === 'OPEN') current = pairWriteMaintenance(paths,current,{state:'DRAINING',gateClosed:true,phase:'OID_DRAINING',
            transactionId:intent.identity.transactionNonce,identity:{kind:'oid-pair',oid:intent.identity},owner:intent.owner,databaseState:'PRE_CANDIDATE'});
        const journalFile = path.join(paths.gitRoot,intent.identity.journalBasename);
        let terminal = null;
        try { terminal = pinnedJson(journalFile,'pair_admission_terminal'); } catch(error) { if(error.code !== 'ENOENT') throw error; }
        const deferred = terminal?.state === 'restart_deferred_restored';
        if (deferred && (terminal.schema !== 'nassaj-oid-control-transaction/v2'
            || terminal.pair?.databaseState !== 'PRE_CANDIDATE' || terminal.oldStopIntentAt || terminal.oldStoppedAt
            || terminal.bootDirection || terminal.bootNonce
            || terminal.transactionNonce !== intent.transaction.transactionNonce || terminal.sequence !== intent.transaction.sequence
            || terminal.pair.targetDigest !== intent.transaction.pair.targetDigest
            || pairCanonical(terminal.fullUpdateWaiter) !== pairCanonical(intent.transaction.fullUpdateWaiter))) throw new Error('oid_pair_admission_effect_possible');
        if (terminal && ((!deferred && terminal.state !== 'pair_rolled_back') || terminal.pair.activationNotClaimed !== true
            || (!deferred && !validateOidPairTerminal(root,terminal)) || terminal.actionId !== intent.transaction.actionId
            || pairCanonical(terminal.pair.previous) !== pairCanonical(intent.transaction.pair.previous)
            || pairCanonical(terminal.pair.target) !== pairCanonical(intent.transaction.pair.target))) throw new Error('oid_pair_admission_effect_possible');
        if (intent.transaction.schema === 'nassaj-oid-control-transaction/v2') {
            if (intent.transaction.oldStopIntentAt || intent.transaction.oldStoppedAt || intent.transaction.bootDirection) throw new Error('oid_triple_admission_effect_possible');
            pairVerifyLive(root, { targetClientBuildId: intent.transaction.pair.previous.clientBuildId, targetServerBuildId: intent.transaction.pair.previous.serverBuildId }, intent.transaction.pair.previous);
        }
        for (const domain of ['client','server']) {
            if (hashOidPairTree(path.join(root,domain==='client'?'dist':'dist-server')) !== intent.transaction.pair.previous[`${domain}TreeSha256`]
                || hashOidPairTree(path.join(root,'.nassaj-local-preview',`${domain}-candidates`,intent.transaction.pair.target[`${domain}BuildId`])) !== intent.transaction.pair.target[`${domain}TreeSha256`]) throw new Error('oid_pair_admission_layout_changed');
        }
        await assertOidPairPreviousRuntime(root,intent.transaction.pair.previous);
        if (deferred) {
            const grant = path.join(paths.controlRoot, `oid-child-${terminal.transactionNonce}.json`);
            try { lstatSync(grant); throw new Error('oid_pair_candidate_bootstrap_observed'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const eventFile = path.join(paths.gitRoot, `nassaj-preview-oid-event-control-${String(terminal.sequence).padStart(16, '0')}.json`);
            const state = pinnedJson(eventFile, 'pair_deferred_event').localUpdate;
            if (state.targetDigest !== terminal.pair.targetDigest || state.activation) throw new Error('full_waiter_pre_effect_cas_conflict');
            releaseFullWaiterBeforeEffects(root, terminal, journalFile);
            pairRecordEvent(root, state, { phase: 'failed', consent: null });
            const { checksum, sequence, ...previous } = intent.previousMaintenance;
            pairWriteMaintenance(paths, current, { ...previous, oidAdmissionIntent: null });
            return { state: 'OPEN', recovered: true, reason: 'oid_pair_admission_aborted_before_effects' };
        }
        const receipt = terminal || pairTerminalReceipt(root,intent.transaction,journalFile,'rolled_back');
        injectFailure('pair_after_admission_rollback_receipt');
        const eventFile = path.join(paths.gitRoot,`nassaj-preview-oid-event-control-${String(receipt.sequence).padStart(16,'0')}.json`);
        const state = pinnedJson(eventFile,'pair_admission_event').localUpdate;
        if (state.targetDigest !== receipt.pair.targetDigest || state.activation && state.activation.transactionNonce !== receipt.transactionNonce) throw new Error('oid_pair_admission_event_changed');
        pairRecordEvent(root,state,{phase:'failed',receipt:receipt.pair.receipt});
        const { checksum, sequence, ...previous } = intent.previousMaintenance;
        pairWriteMaintenance(paths,current,{...previous,oidAdmissionIntent:null});
        return { state:'OPEN',recovered:true,reason:'oid_pair_admission_aborted_before_effects' };
    } finally { for(const lock of locks.reverse()) lock.release(); }
}

/** Recover only a proven dead owner; UNKNOWN stays closed unless a terminal target receipt already exists. */
export async function recoverOidPairAdmission(root, { waitMs = 30000 } = {}) {
    const paths = pairPaths(root), observed = pairReadMaintenance(paths);
    if (observed.oidAdmissionIntent && ['OPEN','OID_DRAINING','OID_QUIESCENT'].includes(observed.state === 'OPEN' ? 'OPEN' : observed.phase)) {
        const link = observed.oidAdmissionIntent.identity;
        if (!Number.isSafeInteger(link?.sequence) || link.sequence < 1 || !HEX64.test(link.transactionNonce || '')
            || link.journalBasename !== `nassaj-oid-control-transaction-${link.sequence}-${link.transactionNonce}.json`) throw new Error('oid_pair_admission_intent_invalid');
        const intentFile = path.join(paths.gitRoot, link.journalBasename);
        let entry = null;
        try { entry = pinnedJson(intentFile, 'pair_admission_counterpart'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!entry || entry.pair?.activationNotClaimed === true) return recoverOidPairAdmissionIntent(root, observed, waitMs);
    }
    if (observed.identity?.kind !== 'oid-pair') return { state: observed.state, recovered: false };
    if (observed.state === 'OPEN') { validateOidPairMaintenance(root, observed); return { state: 'OPEN', recovered: false }; }
    if (!pairOwnerProvablyDead(observed.owner)) return { state: 'MANUAL', recovered: false, reason: 'oid_pair_owner_alive_or_unknown' };
    const locks = [await pairLock(paths.admission, waitMs)];
    let current;
    try {
        locks.push(await pairLock(paths.activity, waitMs));
        current = pairReadMaintenance(paths);
        if (current.identity?.oid?.transactionNonce !== observed.identity.oid.transactionNonce || !pairOwnerProvablyDead(current.owner)) throw new Error('oid_pair_recovery_owner_changed');
        for (const name of ['nassaj-local-preview-build.lock','nassaj-client-build.lock','nassaj-preview-event-mutation.lock']) locks.push(await pairLock(path.join(paths.gitRoot,name),waitMs));
        let transaction;
        try { transaction = pairJournal(paths, current.identity.oid); } catch (error) {
            if (error.code === 'ENOENT' && ['OID_DRAINING','OID_QUIESCENT'].includes(current.phase)) return { state: 'MANUAL', recovered: false, reason: 'oid_pair_preparation_interrupted_without_counterpart' };
            throw error;
        }
        if (transaction.value.schema === 'nassaj-oid-control-transaction/v2') return { state: 'MANUAL', recovered: false, reason: 'oid_triple_retained_executor_resume_required' };
        if (transaction.value.pair.databaseState === 'UNKNOWN' && transaction.value.state !== 'pair_served') return { state: 'MANUAL', recovered: false, reason: 'oid_pair_database_unknown' };
        let released = false;
        const handle = { paths, get journal() { return current; },
            transition(patch) { current = pairWriteMaintenance(paths,current,patch); return current; },
            release() { if (released) return; released=true; for (const lock of [...locks].reverse()) lock.release(); } };
        if (transaction.value.state === 'pair_served') {
            validateOidPairMaintenance(root,current);
            const receipt=transaction.value.pair.receipt;
            const child=pinnedJson(path.join(paths.controlRoot,`oid-child-${current.transactionId}.json`),'pair_recovery_child');
            if (child.pid!==receipt.pid || child.startTime!==receipt.startTime || !pairOwnerAlive(child)) throw new Error('oid_pair_terminal_child_unverified');
            handle.transition({owner:{...current.owner,...pairProcessIdentity()},phase:'OID_RECOVERING'});
            pairRecordTerminalEvent(root, transaction.value);
            completeOidPairAdmission(root,handle);
        } else if (transaction.value.state === 'pair_rolled_back') {
            validateOidPairMaintenance(root,current);
            await assertOidPairPreviousRuntime(root, transaction.value.pair.previous);
            handle.transition({owner:{...current.owner,...pairProcessIdentity()},phase:'OID_RECOVERING'});
            pairRecordTerminalEvent(root, transaction.value);
            completeOidPairAdmission(root,handle);
        } else {
            handle.transition({owner:{...current.owner,...pairProcessIdentity()},phase:'OID_RECOVERING'});
            await restoreOidPairBeforeCandidate(root,handle,transaction.value,transaction.file);
        }
        return {state:'OPEN',recovered:true};
    } finally { for (const lock of [...locks].reverse()) lock.release(); }
}


/** Ignore only application version metadata; preserve dependency versions, install hooks and lock resolution. */
export function oidPairDependencyContract(packageText, lockText) {
    const manifest = JSON.parse(packageText), lock = JSON.parse(lockText);
    if (!manifest || Array.isArray(manifest) || !lock || Array.isArray(lock)) throw new Error('oid_pair_dependency_contract_invalid');
    delete manifest.version;
    delete lock.version;
    if (lock.packages?.['']) delete lock.packages[''].version;
    return sha(pairCanonical({manifest,lock}));
}
/** Read a durable historical serving proof, bound to its immutable terminal transaction. */
export function readOidPairServingReceipt(root, expected) {
    if (!Number.isSafeInteger(expected.sequence) || !HEX64.test(expected.transactionNonce || '') || !HEX64.test(expected.targetDigest || '')) throw new Error('oid_pair_serving_identity_invalid');
    const gitRoot = gitControlRoot(root);
    const transaction = pinnedJson(path.join(gitRoot, `nassaj-oid-control-transaction-${expected.sequence}-${expected.transactionNonce}.json`), 'pair_serving_journal');
    if (transaction.state !== 'pair_served' || !validateOidPairTerminal(root, transaction)) throw new Error('oid_pair_serving_terminal_invalid');
    const receipt = pinnedJson(path.join(gitRoot, `nassaj-oid-pair-serving-${expected.transactionNonce}.json`), 'pair_serving_receipt');
    const terminal = transaction.pair.receipt;
    if (receipt.sequence !== expected.sequence || transaction.sequence !== receipt.sequence
        || receipt.targetDigest !== transaction.pair.targetDigest || receipt.transactionNonce !== expected.transactionNonce
        || receipt.targetDigest !== expected.targetDigest || receipt.actionId !== transaction.actionId
        || (expected.actionId !== undefined && receipt.actionId !== expected.actionId)
        || (expected.buildId !== undefined && receipt.serverBuildId !== expected.buildId)
        || receipt.clientBuildId !== terminal.clientBuildId || receipt.serverBuildId !== terminal.serverBuildId
        || receipt.pid !== terminal.pid || receipt.startTime !== terminal.startTime
        || receipt.outcome !== 'served' || !Number.isSafeInteger(receipt.servedAt)) throw new Error('oid_pair_serving_receipt_invalid');
    if (transaction.schema === 'nassaj-oid-control-transaction/v2'
        && (receipt.schema !== 'nassaj-oid-triple-serving/v2' || receipt.nodeModulesTreeSha256 !== terminal.nodeModulesTreeSha256
            || JSON.stringify(receipt.generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES))) throw new Error('oid_triple_serving_receipt_invalid');
    return receipt;
}

/** Persist exact normal-admission health, then reconcile the mutable event under its lease. */
export async function writeOidPairServingReceipt(root, outcome, healthProof) {
    const terminal = outcome.pair?.receipt;
    const triple = outcome.schema === 'nassaj-oid-control-transaction/v2';
    if (triple && healthProof?.oidNodeModulesTreeSha256 !== terminal?.nodeModulesTreeSha256) throw new Error('oid_triple_serving_dependencies_invalid');
    if (outcome.state !== 'pair_served' || !validateOidPairTerminal(root, outcome)
        || healthProof?.normalAdmissionReady !== true || healthProof.pid !== terminal.pid
        || healthProof.serverProcessStartTicks !== terminal.startTime
        || healthProof.serverTransactionNonce !== outcome.transactionNonce
        || healthProof.oidPairTransactionNonce !== outcome.transactionNonce
        || healthProof.oidPairTargetDigest !== outcome.pair.targetDigest
        || healthProof.serverLoadedBuildId !== terminal.serverBuildId || healthProof.clientBuildIdServed !== terminal.clientBuildId) throw new Error('oid_pair_serving_health_invalid');
    const receipt = { ...(triple ? { schema: 'nassaj-oid-triple-serving/v2', generationNames: UPDATE_GENERATION_NAMES,
        nodeModulesTreeSha256: terminal.nodeModulesTreeSha256 } : {}), outcome: 'served', sequence: outcome.sequence, actionId: outcome.actionId,
        transactionNonce: outcome.transactionNonce, targetDigest: outcome.pair.targetDigest,
        clientBuildId: terminal.clientBuildId, serverBuildId: terminal.serverBuildId,
        pid: terminal.pid, startTime: terminal.startTime, servedAt: Date.now() };
    const file = path.join(gitControlRoot(root), `nassaj-oid-pair-serving-${outcome.transactionNonce}.json`);
    try { durableCreate(file, receipt); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const verified = readOidPairServingReceipt(root, receipt);
    await reconcileOidPairServingReceipt(root, verified);
    return verified;
}

async function recordFullClientBaselineUnderEventLock(root, receipt) {
    const gitRoot = gitControlRoot(root);
    const outcome = pinnedJson(path.join(gitRoot, `nassaj-oid-control-transaction-${receipt.sequence}-${receipt.transactionNonce}.json`), 'full_baseline_transaction');
    const binding = recordFullClientPublicationBaseline(root, receipt, {
        afterWrite: point => injectFailure(`full_baseline_after_${point}`),
        rollbackDirectories: [path.join(root, '.nassaj-local-preview/server-candidates', outcome.pair.target.serverBuildId)],
        verifyClosure: directory => {
            if (hashOidPairTree(directory) !== outcome.pair.target.clientTreeSha256) throw new Error('client_baseline_full_tree_mismatch');
        },
    });
    if (!binding) return;
    const serving = pinnedJson(path.join(gitRoot, 'nassaj-client-publication-serving-v1.json'), 'full_baseline_serving');
    const lease = await pairLock(path.join(gitRoot, 'nassaj-local-preview-ledger.lock'));
    try {
        const file = path.join(gitRoot, 'nassaj-local-preview-ledger-v1.json');
        let ledger = { schemaVersion: 1, updatedAt: null };
        try { ledger = pinnedJson(file, 'full_baseline_ledger'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (ledger.schemaVersion !== 1) throw new Error('full_baseline_ledger_invalid');
        if (ledger.clientPublicationServing?.receiptDigest === serving.receiptDigest) return;
        const next = advanceClientServingLineageRecord(ledger, { ...serving, expectedReceiptDigest: ledger.clientPublicationServing?.receiptDigest ?? null });
        durable(file, next);
        injectFailure('full_baseline_after_ledger');
    } finally { lease.release(); }
}

/** Repair receipt-before-event crashes without relying on the currently loaded generation. */
export async function reconcileOidPairServingReceipt(root, expected) {
    const receipt = readOidPairServingReceipt(root, expected);
    const gitRoot = gitControlRoot(root), lease = await pairLock(path.join(gitRoot, 'nassaj-preview-event-mutation.lock'));
    try {
        const file = path.join(gitRoot, `nassaj-preview-oid-event-control-${String(receipt.sequence).padStart(16, '0')}.json`);
        const state = pinnedJson(file, 'pair_serving_event').localUpdate;
        if (state.targetDigest !== receipt.targetDigest || state.activation?.transactionNonce !== receipt.transactionNonce
            || state.activation?.actionId !== receipt.actionId) throw new Error('oid_pair_serving_event_mismatch');
        await recordFullClientBaselineUnderEventLock(root, receipt);
        if (state.phase !== 'activated') pairRecordEvent(root, state, { phase: 'activated', receipt });
        return receipt;
    } finally { lease.release(); }
}

/** Let the admitted application persist its own serving proof if its launching process has exited. */
export async function recordOidPairApplicationServing(root, expected, healthProof) {
    if (!Number.isSafeInteger(expected.sequence) || !HEX64.test(expected.transactionNonce || '') || !HEX64.test(expected.targetDigest || '')) throw new Error('oid_pair_serving_identity_invalid');
    const outcome = pinnedJson(path.join(gitControlRoot(root), `nassaj-oid-control-transaction-${expected.sequence}-${expected.transactionNonce}.json`), 'pair_application_serving');
    if (outcome.pair?.targetDigest !== expected.targetDigest) throw new Error('oid_pair_serving_identity_invalid');
    return writeOidPairServingReceipt(root, outcome, healthProof);
}

if (process.argv[1] === '-') main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
