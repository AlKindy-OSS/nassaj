/**
 * Reconcile a stuck `manual_recovery_required` OID control transaction against a
 * healthy, independently-promoted third-generation live build by minting a
 * write-once reconciliation receipt (`nassaj-oid-control-reconcile/v1`) and
 * flipping the journal to the terminal state `reconciled_adopted_live` (B-1032).
 *
 * Design: docs/decisions/b1032-reconciled-adopted-live.md.
 *
 * The full live proof (process + health + on-disk provenance) is captured ONCE
 * here, under the event lock, and frozen into the immutable receipt.  The fence
 * (`assertNoNonterminalOidTransaction`) later re-checks only the journal↔receipt
 * hash linkage — never a live process — so a later clean restart cannot reopen
 * the block.  This mirrors `validateCompletedDisposition` and does not touch the
 * disposition path in any way.
 */
import {
    closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
    openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { dispositionArtifactHash } from './oid-control-capsule.mjs';
import {
    listOidControlTransactions, OID_TERMINAL_STATES, OID_RECONCILE_SCHEMA,
    validateOidReconcileAdoptedLive, assertNoNonterminalOidTransaction,
} from './oid-control-journal.mjs';
import { commonGitDir, gitControlPath } from './git-control-root.mjs';

const OID = /^[a-f0-9]{40}$/;
const BUILD = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const OWNER_ACK_MAX = 4096;

const EXIT = Object.freeze({ OK: 0, UNEXPECTED: 1, EVIDENCE: 2, LOCK: 3, OWNER_ACK: 4, CHANGED: 5 });

const DEFAULT_PRIVATE_HEALTH_URL = process.env.NASSAJ_ADOPTED_LIVE_PRIVATE_HEALTH_URL || 'http://127.0.0.1:3004/health';
const DEFAULT_PUBLIC_HEALTH_URL = process.env.NASSAJ_ADOPTED_LIVE_PUBLIC_HEALTH_URL || 'https://nassaj.example.com/health';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const realFs = Object.freeze({ closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync });

// ---------------------------------------------------------------------------
// Pinned / durable primitives (mirror the sealed capsule; capsule does not
// export them, so equivalents live here rather than duplicating capsule bytes).
// ---------------------------------------------------------------------------

function pinnedBytes(file, { maxSize = 16 * 1024 * 1024, sha256: expectedSha, mode } = {}, fs = realFs) {
    const requested = fs.lstatSync(file);
    if (!requested.isFile() || requested.isSymbolicLink()) throw new Error('reconcile_file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.size > maxSize) throw new Error('reconcile_file_size_invalid');
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.ctimeMs !== after.ctimeMs || (expectedSha && sha256(bytes) !== expectedSha)
            || (mode && (before.mode & 0o777) !== mode)) throw new Error('reconcile_file_changed');
        return bytes;
    } finally { fs.closeSync(fd); }
}

function pinnedJson(file, options, fs = realFs) {
    return JSON.parse(pinnedBytes(file, options, fs).toString('utf8'));
}

function durable(file, value, fs = realFs) {
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    fsyncDir(path.dirname(file), fs);
}

function durableCreate(file, value, fs = realFs) {
    const temp = `${file}.create-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, file); } finally { fs.unlinkSync(temp); }
    fsyncDir(path.dirname(file), fs);
}

function unlinkDurable(file, fs = realFs) {
    if (!fs.existsSync(file)) return;
    fs.unlinkSync(file);
    fsyncDir(path.dirname(file), fs);
}

function fsyncDir(directory, fs = realFs) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------------------
// Live process / health observation (sibling of the capsule's disposition
// probes, with the same strictness: exactly two observations, no relaxation).
// ---------------------------------------------------------------------------

function readBootId() {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function readProcessStartTicks(pid) {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

/** Cross-check that pid still names the same live process (mirrors `dispositionProcess`). */
export function adoptedLiveProcess(previous) {
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 2) throw new Error('reconcile_pid_invalid');
    let ticks; let bootId; let cmd; let environment;
    try {
        ticks = readProcessStartTicks(previous.pid);
        bootId = readBootId();
        cmd = readFileSync(`/proc/${previous.pid}/cmdline`, 'utf8').split('\0');
        environment = readFileSync(`/proc/${previous.pid}/environ`, 'utf8').split('\0');
    } catch { throw new Error('reconcile_process_changed'); }
    if (ticks !== previous.startTicks || bootId !== previous.bootId
        || (!cmd.includes(previous.entry) && !environment.includes(`pm_exec_path=${previous.entry}`))) {
        throw new Error('reconcile_process_changed');
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

/** Probe the private health endpoint once to discover the live pid (discovery only). */
export function probeAdoptedLiveIdentity(privateUrl = DEFAULT_PRIVATE_HEALTH_URL) {
    const parsed = new URL(privateUrl);
    if (!['127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:' || parsed.username || parsed.password) {
        throw new Error('reconcile_health_url_invalid');
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', HEALTH_OBSERVER, JSON.stringify([privateUrl])], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 140000, env: { PATH: '/usr/bin:/bin' },
    });
    if (result.status !== 0 || result.error) throw new Error('reconcile_health_unavailable');
    const observation = JSON.parse(result.stdout.trim().split('\n')[0]);
    if (!Number.isSafeInteger(observation.pid) || typeof observation.serverProcessStartTicks !== 'string') {
        throw new Error('reconcile_health_identity_missing');
    }
    return { pid: observation.pid, startTicks: observation.serverProcessStartTicks };
}

/** Exactly two authoritative observations (private http + public https), no relaxation. */
export function observeAdoptedLiveHealth(expected, urls = [DEFAULT_PRIVATE_HEALTH_URL, DEFAULT_PUBLIC_HEALTH_URL]) {
    const privateUrl = new URL(urls[0]);
    const publicUrl = new URL(urls[1]);
    if (!['127.0.0.1', '[::1]'].includes(privateUrl.hostname) || privateUrl.protocol !== 'http:'
        || publicUrl.protocol !== 'https:'
        || urls.some((url) => { const parsed = new URL(url); return parsed.username || parsed.password; })) {
        throw new Error('reconcile_health_url_invalid');
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', HEALTH_OBSERVER, JSON.stringify(urls)], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 140000, env: { PATH: '/usr/bin:/bin' },
    });
    if (result.status !== 0 || result.error) throw new Error('reconcile_health_unavailable');
    const observations = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    if (observations.length !== 2 || observations.some((value) => value.status !== 'ok'
        || value.pid !== expected.pid || String(value.serverProcessStartTicks) !== String(expected.startTicks)
        || value.serverLoadedBuildId !== expected.buildId || value.serverBuildIdOnDisk !== expected.buildId
        || value.serverLoadedOid !== expected.commit || value.clientBuildIdServed !== expected.clientBuildId)) {
        throw new Error('reconcile_health_identity_mismatch');
    }
    return observations.map((value) => ({
        pid: value.pid, serverLoadedOid: value.serverLoadedOid, serverLoadedBuildId: value.serverLoadedBuildId,
        serverBuildIdOnDisk: value.serverBuildIdOnDisk, clientBuildIdServed: value.clientBuildIdServed,
        serverProcessStartTicks: String(value.serverProcessStartTicks), serverTransactionNonce: value.serverTransactionNonce ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function provenanceOf(directory) {
    return pinnedJson(path.join(directory, 'BUILD_PROVENANCE.json'), { maxSize: 64 * 1024 });
}

/** Find the single non-terminal `manual_recovery_required` target journal. */
function locateTarget(root) {
    const transactions = listOidControlTransactions(root);
    const nonTerminal = transactions.filter(({ value }) => !OID_TERMINAL_STATES.has(value?.state));
    return { transactions, nonTerminal };
}

/**
 * Build and structurally verify the adopted-live evidence bundle.  Throws with
 * a stable `reconcile_*` code on any failure so every mode is fail-closed.
 *
 * `hooks` (test only): { identity, observeHealth, observeProcess, healthUrls }.
 */
export function verifyAdoptedLiveEvidence(root, target, hooks = {}) {
    const value = target.value;
    if (value.schema !== 'nassaj-oid-control-transaction/v1' || value.state !== 'manual_recovery_required'
        || value.reason !== 'previous_attestation_failed') throw new Error('reconcile_target_state_invalid');
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1
        || value.group !== `event-${String(value.sequence).padStart(16, '0')}`
        || !BUILD.test(value.transactionNonce || '') || !(value.actionId === null || UUID.test(value.actionId || ''))
        || !OID.test(value.oid || '') || !OID.test(value.previousOid || '')
        || !BUILD.test(value.buildId || '') || !BUILD.test(value.previousBuildId || '')) {
        throw new Error('reconcile_target_journal_invalid');
    }

    const candidate = { oid: value.oid, buildId: value.buildId };
    const previous = { oid: value.previousOid, buildId: value.previousBuildId };
    const originalJournalSha256 = sha256(pinnedBytes(target.file, { mode: 0o600, maxSize: 128 * 1024 }));

    // (2) Server provenance: clean, self-consistent, and a genuine third generation.
    const serverRoot = path.join(root, 'dist-server');
    const clientRoot = path.join(root, 'dist');
    const serverProv = provenanceOf(serverRoot);
    if (serverProv.dirty !== false || serverProv.commit !== serverProv.baseCommit
        || !OID.test(serverProv.commit || '') || !BUILD.test(serverProv.buildId || '')) throw new Error('reconcile_server_provenance_invalid');
    if (serverProv.commit === candidate.oid || serverProv.commit === previous.oid
        || serverProv.buildId === candidate.buildId || serverProv.buildId === previous.buildId) throw new Error('reconcile_not_third_generation');

    // (3) Runtime manifest matches the on-disk build, and the sealed capsule matches the manifest.
    const manifest = pinnedJson(path.join(serverRoot, 'OID_CONTROL_MANIFEST.json'), { maxSize: 64 * 1024 });
    if (manifest.serverBuildId !== serverProv.buildId || manifest.oid !== serverProv.commit
        || !BUILD.test(manifest.capsuleSha256 || '')) throw new Error('reconcile_manifest_mismatch');
    const sealedCapsuleSha256 = sha256(pinnedBytes(path.join(serverRoot, 'OID_CONTROL_CAPSULE.mjs'), { maxSize: 4 * 1024 * 1024 }));
    if (sealedCapsuleSha256 !== manifest.capsuleSha256) throw new Error('reconcile_sealed_capsule_mismatch');

    // (4) Whole-tree artifact hashes (server governed by dirty=false; client is evidence only).
    const hashArtifact = hooks.artifactHashOf || dispositionArtifactHash;
    const serverTreeSha256 = hashArtifact(serverRoot);
    const clientTreeSha256 = hashArtifact(clientRoot);
    const clientProv = provenanceOf(clientRoot);

    // (5)+(6) Process before -> exactly two health observations -> process after (sandwich).
    const entry = path.join(serverRoot, 'server', 'index.js');
    const identity = hooks.identity || probeAdoptedLiveIdentity(hooks.healthUrls ? hooks.healthUrls[0] : undefined);
    const expected = { pid: identity.pid, startTicks: String(identity.startTicks), bootId: hooks.identity?.bootId || readBootId(), entry };
    const processProbe = hooks.observeProcess || adoptedLiveProcess;
    const before = processProbe(expected);
    const observe = hooks.observeHealth || observeAdoptedLiveHealth;
    const health = observe({ pid: expected.pid, startTicks: expected.startTicks, buildId: serverProv.buildId, commit: serverProv.commit, clientBuildId: clientProv.buildId }, hooks.healthUrls);
    if (!Array.isArray(health) || health.length !== 2) throw new Error('reconcile_health_observation_count');
    processProbe(expected);

    return {
        sequence: value.sequence, group: value.group, transactionNonce: value.transactionNonce, actionId: value.actionId,
        originalJournalSha256, journalFile: target.file, candidate, previous,
        adoptedLive: {
            server: {
                commit: serverProv.commit, baseCommit: serverProv.baseCommit, dirty: serverProv.dirty, buildId: serverProv.buildId,
                entryRelative: 'server/index.js', serverTreeSha256, controlManifestBuildId: manifest.serverBuildId,
                controlManifestOid: manifest.oid, sealedCapsuleSha256,
            },
            client: { buildId: clientProv.buildId, dirty: clientProv.dirty ?? null, clientTreeSha256 },
        },
        process: before,
        health,
        runtimeNonceObserved: health[0].serverTransactionNonce,
    };
}

function buildReceipt(bundle, ownerAck) {
    return {
        schema: OID_RECONCILE_SCHEMA, version: 1,
        sequence: bundle.sequence, group: bundle.group, transactionNonce: bundle.transactionNonce,
        actionId: bundle.actionId, originalJournalSha256: bundle.originalJournalSha256,
        adoptedLive: bundle.adoptedLive, process: bundle.process, health: bundle.health,
        runtimeNonceObserved: bundle.runtimeNonceObserved,
        abandoned: { candidate: bundle.candidate, previous: bundle.previous },
        ownerOperation: ownerAck,
        controlsClearedBeforeReceipt: true,
        createdAt: new Date().toISOString(),
    };
}

function reconcilePaths(root, sequence, nonce, fs = realFs) {
    const git = commonGitDir(root);
    const pad = String(sequence).padStart(16, '0');
    return {
        git,
        request: gitControlPath(root, 'nassaj-preview-oid-control-request-v1.json'),
        event: gitControlPath(root, `nassaj-preview-oid-event-control-${pad}.json`),
        receipt: gitControlPath(root, `nassaj-oid-control-reconcile-${nonce}.json`),
        lock: gitControlPath(root, 'nassaj-preview-event-mutation.lock'),
    };
}

// ---------------------------------------------------------------------------
// Stability snapshot (TOCTOU guard between the pre-lock read and the locked act)
// ---------------------------------------------------------------------------

function stableSnapshot(fs, file) {
    if (!fs.existsSync(file)) return { present: false };
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('legacy_control_changed');
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs) throw new Error('legacy_control_changed');
    return { present: true, dev: String(before.dev), ino: String(before.ino), size: before.size,
        mode: before.mode, mtimeMs: before.mtimeMs, sha256: sha256(bytes) };
}

function snapshotControls(root, sequence, nonce, fs = realFs) {
    const files = reconcilePaths(root, sequence, nonce, fs);
    return {
        request: stableSnapshot(fs, files.request),
        event: stableSnapshot(fs, files.event),
        receipt: stableSnapshot(fs, files.receipt),
    };
}

function sameSnapshot(left, right) {
    return ['request', 'event', 'receipt'].every((key) => {
        const a = left?.[key]; const b = right?.[key];
        return a?.present === b?.present && (!a?.present || (a.dev === b.dev && a.ino === b.ino
            && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256));
    });
}

// ---------------------------------------------------------------------------
// Settle (durable steps 2-4 of the design; runs under the held event lock)
// ---------------------------------------------------------------------------

export function settleReconcileAdoptedLiveLocked(root, ownerAck, initialSnapshot = null, hooks = {}, fs = realFs) {
    if (typeof ownerAck !== 'string' || !ownerAck.trim() || ownerAck.length > OWNER_ACK_MAX) {
        return { settled: false, code: 'reconcile_owner_ack_invalid' };
    }
    const { transactions, nonTerminal } = locateTarget(root);

    // Idempotent completion: our reconciliation already landed.
    if (nonTerminal.length === 0) {
        const done = transactions.find(({ value }) => value?.state === 'reconciled_adopted_live'
            && validateOidReconcileAdoptedLive(root, { value }));
        if (done) return { settled: true, code: 'oid_reconciled_adopted_live', idempotent: true, journalFile: done.file };
        return { settled: false, code: 'reconcile_no_target' };
    }
    if (nonTerminal.length !== 1) return { settled: false, code: 'reconcile_multiple_nonterminal' };
    const target = nonTerminal[0];
    if (target.value?.state !== 'manual_recovery_required' || target.value?.reason !== 'previous_attestation_failed') {
        return { settled: false, code: 'reconcile_target_state_invalid' };
    }

    let freshSnapshot;
    try { freshSnapshot = snapshotControls(root, target.value.sequence, target.value.transactionNonce, fs); }
    catch (error) { return { settled: false, code: error.message === 'legacy_control_changed' ? 'legacy_control_changed' : 'reconcile_snapshot_invalid' }; }
    if (initialSnapshot && !sameSnapshot(initialSnapshot, freshSnapshot)) return { settled: false, code: 'legacy_control_changed' };

    let bundle;
    try { bundle = verifyAdoptedLiveEvidence(root, target, hooks); }
    catch (error) { return { settled: false, code: error.message }; }

    const files = reconcilePaths(root, target.value.sequence, target.value.transactionNonce, fs);

    // (2) FIRST durable transition: delete request + event control before any
    //     receipt or journal flip, idempotent, so a later launcher run drops to
    //     the fail-closed owner-action path (no request -> no click -> no resume).
    unlinkDurable(files.request, fs);
    unlinkDurable(files.event, fs);

    // (3) Write-once receipt.  Assert controls are already gone.
    if (fs.existsSync(files.request) || fs.existsSync(files.event)) return { settled: false, code: 'reconcile_controls_not_cleared' };
    const receipt = buildReceipt(bundle, ownerAck);
    let receiptBytes;
    try {
        durableCreate(files.receipt, receipt, fs);
        receiptBytes = pinnedBytes(files.receipt, { mode: 0o600, maxSize: 128 * 1024 }, fs);
    } catch (error) {
        if (error.code !== 'EEXIST') return { settled: false, code: 'reconcile_receipt_write_failed' };
        receiptBytes = pinnedBytes(files.receipt, { mode: 0o600, maxSize: 128 * 1024 }, fs);
        const existing = JSON.parse(receiptBytes.toString('utf8'));
        // Ignore createdAt drift on resume: everything load-bearing must match.
        const comparable = (value) => ({ ...value, createdAt: undefined });
        if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(receipt))) return { settled: false, code: 'reconcile_receipt_conflict' };
    }
    const receiptSha256 = sha256(receiptBytes);

    // (4) LAST durable step: flip journal 174 -> reconciled_adopted_live.
    const currentJournal = pinnedJson(target.file, { mode: 0o600, maxSize: 128 * 1024 }, fs);
    if (currentJournal.state === 'reconciled_adopted_live') {
        if (currentJournal.reconcile?.receiptSha256 !== receiptSha256) return { settled: false, code: 'reconcile_journal_conflict' };
    } else if (currentJournal.state === 'manual_recovery_required') {
        const flipped = { ...currentJournal, state: 'reconciled_adopted_live',
            reconcile: { receiptSha256, originalJournalSha256: bundle.originalJournalSha256,
                adoptedOid: bundle.adoptedLive.server.commit, adoptedBuildId: bundle.adoptedLive.server.buildId } };
        durable(target.file, flipped, fs);
    } else return { settled: false, code: 'reconcile_journal_unexpected_state' };

    // Final proof: the durable outcome validates and the fence now passes.
    if (!validateOidReconcileAdoptedLive(root, { value: pinnedJson(target.file, { mode: 0o600, maxSize: 128 * 1024 }, fs) })) {
        return { settled: false, code: 'reconcile_post_flip_unverified' };
    }
    try { assertNoNonterminalOidTransaction(root); } catch (error) { return { settled: false, code: `reconcile_fence_still_blocked:${error.message}` }; }
    return { settled: true, code: 'oid_reconciled_adopted_live', receiptFile: files.receipt, journalFile: target.file, receiptSha256 };
}

// ---------------------------------------------------------------------------
// Event-lock wrappers
// ---------------------------------------------------------------------------

async function withEventLock(root, operation) {
    const lock = reconcilePaths(root, 1, '0'.repeat(64)).lock;
    const holder = spawn('flock', ['-x', '-w', '10', lock, process.execPath, '-e',
        "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    holder.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
        let stdout = '';
        const ready = (chunk) => { stdout += chunk; if (stdout.includes('locked\n')) { holder.stdout.off('data', ready); resolve(); } };
        holder.stdout.on('data', ready);
        holder.once('error', reject);
        holder.once('exit', (code) => reject(new Error(`reconcile event lock exited before acquisition (${code}): ${stderr}`)));
    });
    try { return await operation(); } finally {
        holder.stdin.end();
        await new Promise((resolve, reject) => {
            holder.once('error', reject);
            holder.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`reconcile event lock release failed (${code}): ${stderr}`)));
        });
    }
}

/** Production wrapper: capture the pre-lock snapshot, then settle inside a child that owns the flock. */
export function reconcileAdoptedLive(root, ownerAck) {
    const { nonTerminal } = locateTarget(root);
    let initialSnapshot = null;
    if (nonTerminal.length === 1 && nonTerminal[0].value?.transactionNonce) {
        try { initialSnapshot = snapshotControls(root, nonTerminal[0].value.sequence, nonTerminal[0].value.transactionNonce); }
        catch { return { settled: false, code: 'legacy_control_changed' }; }
    }
    const files = reconcilePaths(root, 1, '0'.repeat(64));
    const payload = Buffer.from(JSON.stringify({ ownerAck, initialSnapshot })).toString('base64url');
    const result = spawnSync('flock', ['-x', '-w', '10', '-F', files.lock,
        process.execPath, fileURLToPath(import.meta.url), '--apply', root, payload], { encoding: 'utf8' });
    if (result.status !== 0 && !result.stdout) return { settled: false, code: 'reconcile_lock_failed' };
    try { return JSON.parse(String(result.stdout).trim()); } catch { return { settled: false, code: 'reconcile_invalid_result' }; }
}

/** Test-only factory (mirrors `createTerminalOidControlReconciler`). */
export function createReconcileAdoptedLiveSettler({ fs = realFs, testHooks = undefined } = {}) {
    return async function reconcileForTest(root, ownerAck, hooks = {}) {
        const { nonTerminal } = locateTarget(root);
        let initialSnapshot = null;
        if (nonTerminal.length === 1 && nonTerminal[0].value?.transactionNonce) {
            try { initialSnapshot = snapshotControls(root, nonTerminal[0].value.sequence, nonTerminal[0].value.transactionNonce, fs); }
            catch { return { settled: false, code: 'legacy_control_changed' }; }
        }
        if (testHooks?.afterInitialSnapshot) await testHooks.afterInitialSnapshot({ root, ownerAck });
        return withEventLock(root, () => settleReconcileAdoptedLiveLocked(root, ownerAck, initialSnapshot, hooks, fs));
    };
}

// ---------------------------------------------------------------------------
// --plan (read-only)
// ---------------------------------------------------------------------------

export function planReconcileAdoptedLive(root, hooks = {}) {
    const { transactions, nonTerminal } = locateTarget(root);
    if (nonTerminal.length === 0) {
        const done = transactions.find(({ value }) => value?.state === 'reconciled_adopted_live' && validateOidReconcileAdoptedLive(root, { value }));
        if (done) return { ok: true, alreadyReconciled: true, code: 'oid_reconciled_adopted_live', fenceWouldPass: true };
        return { ok: false, code: 'reconcile_no_target' };
    }
    if (nonTerminal.length !== 1) return { ok: false, code: 'reconcile_multiple_nonterminal' };
    const target = nonTerminal[0];
    let bundle;
    try { bundle = verifyAdoptedLiveEvidence(root, target, hooks); }
    catch (error) { return { ok: false, code: error.message }; }
    const receiptPreview = buildReceipt(bundle, '<owner-ack pending --exec>');
    return {
        ok: true, code: 'reconcile_plan_valid',
        sequence: bundle.sequence, group: bundle.group, transactionNonce: bundle.transactionNonce, actionId: bundle.actionId,
        adoptedLive: bundle.adoptedLive, abandoned: { candidate: bundle.candidate, previous: bundle.previous },
        process: bundle.process, health: bundle.health, runtimeNonceObserved: bundle.runtimeNonceObserved,
        originalJournalSha256: bundle.originalJournalSha256,
        receiptPreview,
        // After the flip, the only non-terminal transaction becomes terminal, so
        // the fence will pass provided nothing else is in progress.
        fenceWouldPass: nonTerminal.length === 1,
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = { mode: null, ownerAck: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--plan') args.mode = 'plan';
        else if (argv[i] === '--exec') args.mode = 'exec';
        else if (argv[i] === '--owner-ack') { args.ownerAck = argv[i + 1] ?? null; i += 1; }
    }
    return args;
}

function planExit(result) { return result.ok ? EXIT.OK : EXIT.EVIDENCE; }

function execExit(result) {
    if (result.settled) return EXIT.OK;
    if (result.code === 'legacy_control_changed') return EXIT.CHANGED;
    if (result.code === 'reconcile_lock_failed') return EXIT.LOCK;
    if (result.code === 'reconcile_owner_ack_invalid') return EXIT.OWNER_ACK;
    return EXIT.EVIDENCE;
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === '--apply') {
        const root = path.resolve(argv[1]);
        const payload = JSON.parse(Buffer.from(argv[2], 'base64url').toString('utf8'));
        const result = settleReconcileAdoptedLiveLocked(root, payload.ownerAck, payload.initialSnapshot);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    const args = parseArgs(argv);
    const root = process.cwd();
    if (args.mode === 'plan') {
        let result;
        try { result = planReconcileAdoptedLive(root); } catch (error) { result = { ok: false, code: `reconcile_unexpected:${error.message}` }; }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exit(planExit(result));
    }
    if (args.mode === 'exec') {
        if (typeof args.ownerAck !== 'string' || !args.ownerAck.trim() || args.ownerAck.length > OWNER_ACK_MAX) {
            process.stdout.write(`${JSON.stringify({ settled: false, code: 'reconcile_owner_ack_invalid' })}\n`);
            process.exit(EXIT.OWNER_ACK);
        }
        let result;
        try { result = reconcileAdoptedLive(root, args.ownerAck); } catch (error) { result = { settled: false, code: `reconcile_unexpected:${error.message}` }; }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exit(execExit(result));
    }
    process.stderr.write('usage: oid-control-reconcile-adopted-live.mjs --plan | --exec --owner-ack "<text>"\n');
    process.exit(EXIT.UNEXPECTED);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exit(EXIT.UNEXPECTED); });
}
