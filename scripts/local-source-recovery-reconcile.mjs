/** B-1264: settle recovery metadata only after the old generation has verifiably returned. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hashTree } from './lib/source-update-tree-identity.mjs';
import { pinnedFile, readPacket, assertProcess, assertDatabase, assertDatabaseFiles, assertConfig, assertHealth,
    deriveLocalRecoveryRegistration, openVerifiedRecoveryDatabase, recoveryDatabaseSchemaSha256 } from './local-source-recovery-operator.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw new Error(`local_recovery_reconcile_${reason}`); };

function context(options) {
    const root = path.resolve(options.root), packetPath = path.resolve(options.packetPath);
    if (!packetPath.startsWith(`${root}/.git/nassaj-source-update/`)) fail('packet_path');
    const packet = JSON.parse(pinnedFile(packetPath, options.packetSha256));
    if (packet.schema !== 'nassaj-local-source-recovery-reconciliation/v1' || packet.root !== root
        || packet.operation !== 'reconcile-pre-candidate-rollback' || packet.nodeIdentity !== os.hostname()
        || packet.serviceUid !== process.getuid() || !packet.restoredProcess
        || Object.keys(packet.restoredProcess).sort().join(',') !== 'pid,startTicks'
        || !Number.isSafeInteger(packet.restoredProcess.pid) || packet.restoredProcess.pid < 2
        || !/^[1-9][0-9]*$/.test(packet.restoredProcess.startTicks)) fail('packet_identity');
    const original = readPacket({ root, packetPath: packet.registrationPacketPath, packetSha256: packet.registrationPacketSha256 });
    const observed = { ...original.packet, operationBinding: { ...original.packet.operationBinding,
        previousRuntime: { ...original.packet.operationBinding.previousRuntime,
            pid: packet.restoredProcess.pid, startTicks: packet.restoredProcess.startTicks } } };
    return { root, packet, original, observed, packetSha256: options.packetSha256 };
}

function previousTrees(context) {
    const { root, original } = context, expected = original.packet.operationBinding.previousRuntime;
    const result = {};
    for (const [key, name] of Object.entries({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' })) {
        result[key] = hashTree(path.join(root, name));
        if (!same(result[key], expected.actualTrees[key])) fail('previous_tree_changed');
    }
    pinnedFile(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), expected.controlManifestSha256, false);
    return result;
}

function rollbackEvidence(context, readGate) {
    const { root, packet, original } = context, binding = original.packet.operationBinding;
    const control = path.join(root, '.git/nassaj-source-update'), candidate = path.join(control, 'candidates', binding.transactionId);
    pinnedFile(path.join(control, 'journal.json'), packet.journalSha256);
    const gate = readGate({ projectPath: root });
    if (gate.state !== 'OPEN' || gate.gateClosed !== false || gate.degraded || gate.databaseState !== 'PRE_CANDIDATE'
        || gate.recovery !== 'ROLLED_BACK' || gate.phase !== null || gate.oidAdmissionIntentPending
        || (gate.transactionId && gate.transactionId !== binding.transactionId)) fail('rollback_gate_unproven');
    if (fs.existsSync(path.join(control, 'bootstrap-handoff.json'))) fail('handoff_unresolved');
    const receipt = JSON.parse(pinnedFile(path.join(candidate, 'activation-receipt.json'), packet.rollbackReceiptSha256));
    if (receipt.schemaVersion !== 1 || receipt.txId !== binding.transactionId || receipt.state !== 'rolled_back') fail('rollback_receipt_invalid');
    for (const name of ['client','server','nodeModules']) {
        if (receipt.steps?.[name]?.state !== 'rolled_back'
            || !same(receipt.steps[name].previous, binding.previousRuntime.actualTrees[name])
            || !same(receipt.previous?.[name], binding.previousRuntime.actualTrees[name])) fail('rollback_receipt_changed');
    }
    return { gate, previousTrees: previousTrees(context), journalSha256: packet.journalSha256, rollbackReceiptSha256: packet.rollbackReceiptSha256 };
}

function assertControl(context, db) {
    const control = db.prepare('SELECT * FROM source_update_control WHERE singleton=1').get();
    if (sha(JSON.stringify(control)) !== context.packet.controlSnapshotSha256) fail('control_changed');
    if (control.active_job_id && control.active_job_id !== context.original.packet.operationBinding.jobId) fail('other_activation');
    if (control.pid && control.start_ticks) {
        try {
            const stat = fs.readFileSync(`/proc/${control.pid}/stat`, 'utf8');
            if (stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === control.start_ticks) fail('worker_alive');
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    } else if (control.worker_id) fail('worker_identity_unproven');
}

/** Verify current restored PID/builds and pre-handoff rollback evidence before metadata-only CAS. */
export async function reconcileLocalRecoveryRollback(options) {
    if (options.operation !== 'reconcile-pre-candidate-rollback') fail('explicit_reconciliation_required');
    const initial = context(options), { root, original, observed } = initial;
    assertProcess(root, observed.operationBinding.previousRuntime); assertConfig(root, original.packet); assertDatabase(observed);
    previousTrees(initial);
    const { registration, action } = deriveLocalRecoveryRegistration(original, { existingOnly: true });
    pinnedFile(path.join(path.dirname(registration.manifestPath), 'activation-action.json'), sha(`${JSON.stringify(action)}\n`));
    const { readUpdateMaintenanceRecoveryEvidence } = await import(pathToFileURL(path.join(root, 'dist-server/server/services/update-maintenance-gate.js')).href);
    const evidence = rollbackEvidence(initial, readUpdateMaintenanceRecoveryEvidence);
    await assertHealth(observed);
    const repositories = path.join(path.dirname(registration.manifestPath), 'server/server/modules/database/repositories');
    const { reconcilePreparedRecoveryRollback } = await import(pathToFileURL(path.join(repositories, 'source-update-recovery.db.js')).href);
    const { SOURCE_UPDATE_ACTIVE_STATES } = await import(pathToFileURL(path.join(repositories, 'source-update-jobs.db.js')).href);
    const db = openVerifiedRecoveryDatabase(original.packet.database);
    try {
        return reconcilePreparedRecoveryRollback(db, { registration, reconciliationPacketSha256: initial.packetSha256,
            evidenceSha256: sha(JSON.stringify(evidence)), approvalReference: initial.packet.approvalReference,
            restoredProcess: initial.packet.restoredProcess }, SOURCE_UPDATE_ACTIVE_STATES, () => {
            const current = context(options);
            assertProcess(root, current.observed.operationBinding.previousRuntime); assertDatabase(current.observed); assertConfig(root, original.packet);
            assertDatabaseFiles(original.packet.database);
            if (recoveryDatabaseSchemaSha256(db) !== original.packet.database.schemaSha256) fail('database_schema_changed');
            deriveLocalRecoveryRegistration(current.original, { existingOnly: true });
            if (!same(rollbackEvidence(current, readUpdateMaintenanceRecoveryEvidence), evidence)) fail('evidence_changed');
            const job = db.prepare('SELECT state FROM source_update_jobs WHERE id=?').get(registration.jobId);
            if (job?.state !== 'rolled_back') assertControl(current, db);
        });
    } finally { db.close(); }
}
