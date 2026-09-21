/** Side-effect-free SQLite policy for one operation-bound MANUAL local-source rollback. */
import crypto from 'node:crypto';
import path from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(`local_recovery_registration_${reason}`); };

export const MANUAL_ROLLBACK_ACTIVE_STATES = Object.freeze([
    'awaiting_sessions', 'accepted', 'resolving', 'resolved', 'downloading', 'archive_verified',
    'extracting', 'staging', 'candidate_sealed', 'restart_queued', 'activating', 'runtime_verifying', 'rollback_pending',
]);

function validateBinding(input) {
    const b = input.operationBinding, runtime = b?.previousRuntime, mode = b?.modeTransition;
    if (!b || b.schema !== 'nassaj-local-source-recovery-operation/v1' || b.jobId !== input.jobId
        || b.actionId !== input.actionId || b.ownerId !== input.ownerId || b.transactionId !== input.transactionId
        || !path.isAbsolute(b.root) || path.resolve(b.root) !== b.root || !OID.test(b.previousSourceOid || '')
        || ['nodeIdentity', 'approvalReference', 'reservationReference'].some(key => typeof b[key] !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/.test(b[key]))) fail('operation_binding_invalid');
    if (!runtime || !OID.test(runtime.oid) || !Number.isSafeInteger(runtime.pid) || runtime.pid < 2
        || !/^[1-9][0-9]*$/.test(runtime.startTicks) || ![runtime.serverBuildId, runtime.clientBuildId, runtime.controlManifestSha256]
            .every(value => SHA.test(value))) fail('previous_runtime_invalid');
    for (const key of ['client', 'server', 'nodeModules']) {
        const tree = runtime.actualTrees?.[key];
        if (!tree || !SHA.test(tree.sha256) || !Number.isSafeInteger(tree.files) || tree.files < 1) fail('previous_trees_invalid');
    }
    if (!mode || mode.from !== 'release' || mode.to !== 'local-main' || !ID.test(mode.configReceiptId)
        || ![mode.configBindingSha256, mode.originalEnvSha256, mode.proposalEnvSha256].every(value => SHA.test(value))) fail('config_binding_invalid');
}

/** Validate and derive the immutable registration receipt identity. */
export function manualRecoveryRegistrationIdentity(input) {
    if (![input.jobId, input.actionId, input.transactionId].every(value => ID.test(value))
        || !Number.isSafeInteger(input.ownerId) || input.ownerId < 1 || !/^\d+\.\d+\.\d+\.\d+$/.test(input.version)
        || !OID.test(input.sourceOid) || ![input.sourceTreeSha256, input.manifestSha256, input.activationIdentitySha256,
            input.operationPacketSha256, input.expectedServerBuildId, input.expectedClientBuildId].every(value => SHA.test(value))) fail('identity_invalid');
    validateBinding(input);
    const expectedManifest = path.join(input.operationBinding.root, '.git/nassaj-source-update/candidates', input.transactionId, 'candidate-manifest.json');
    if (input.manifestPath !== expectedManifest) fail('manifest_path_invalid');
    const facts = { code: 'prepared_local_source_recovery', ...input };
    const factsJson = JSON.stringify(facts), factsSha256 = sha(factsJson);
    const idempotencyKeyHash = sha(`local-source-recovery:${input.operationBinding.root}:${input.transactionId}`);
    return { facts, factsJson, factsSha256, idempotencyKeyHash, requestFingerprint: sha(`local-source-recovery:${factsSha256}`) };
}

function action(db, id) {
    return db.prepare('SELECT * FROM pending_server_actions WHERE id=?').get(id);
}

/** Read-only exact preflight; this is also rerun under the IMMEDIATE transaction. */
export function inspectManualRecoveryRollbackState(db, registration, activeStates = MANUAL_ROLLBACK_ACTIVE_STATES) {
    const identity = manualRecoveryRegistrationIdentity(registration), r = registration;
    if (!Array.isArray(activeStates) || !activeStates.length) fail('manual_rollback_active_states');
    const owner = db.prepare("SELECT 1 FROM users WHERE id=? AND role='owner' AND is_active=1").get(r.ownerId);
    const job = db.prepare('SELECT * FROM source_update_jobs WHERE id=?').get(r.jobId);
    const first = db.prepare('SELECT facts_json,facts_sha256,worker_fence FROM source_update_receipts WHERE job_id=? AND sequence=1').get(r.jobId);
    if (!owner || !job || !first || job.request_fingerprint !== identity.requestFingerprint
        || first.facts_sha256 !== identity.factsSha256 || first.facts_json !== identity.factsJson
        || job.owner_id !== r.ownerId || job.transaction_id !== r.transactionId
        || job.activation_identity_sha256 !== r.activationIdentitySha256 || job.release_commit !== r.sourceOid
        || job.source_tree_sha256 !== r.sourceTreeSha256 || job.expected_server_build_id !== r.expectedServerBuildId
        || job.expected_client_build_id !== r.expectedClientBuildId || job.strategy !== 'git-checkout-v2'
        || job.auto_activate !== 1 || job.worker_fence !== first.worker_fence) fail('manual_rollback_job_changed');
    const receipts = db.prepare("SELECT phase,kind,facts_json,facts_sha256 FROM source_update_receipts WHERE job_id=? ORDER BY sequence").all(r.jobId);
    if (receipts.some(value => sha(value.facts_json) !== value.facts_sha256)) fail('manual_rollback_receipt_changed');
    const consent = receipts.filter(value => {
        try { const facts = JSON.parse(value.facts_json); return value.phase === 'restart_queued' && value.kind === 'recovery'
            && facts.code === 'owner_activation_consent' && facts.ownerId === r.ownerId
            && facts.expectedVersion === r.version && facts.targetDigest === r.activationIdentitySha256; } catch { return false; }
    });
    const failure = receipts.filter(value => value.phase === 'runtime_verifying' && value.kind === 'recovery'
        && value.facts_json === JSON.stringify({ code: 'update_database_state_unknown', failedPhase: 'runtime_verifying', intervention: 'human' }));
    const settled = receipts.filter(value => value.phase === 'rolled_back' && value.kind === 'recovery');
    const pending = action(db, r.actionId);
    if (!pending || pending.source_update_job_id !== r.jobId || pending.source_update_transaction_id !== r.transactionId
        || pending.activation_identity_sha256 !== r.activationIdentitySha256 || pending.release_commit !== r.sourceOid
        || pending.expected_server_build_id !== r.expectedServerBuildId) fail('manual_rollback_action_changed');
    if (db.prepare(`SELECT 1 FROM source_update_jobs WHERE id<>? AND (state IN (${activeStates.map(() => '?').join(',')}) OR state='manual_recovery_required') LIMIT 1`)
        .get(r.jobId, ...activeStates)) fail('active_job_conflict');
    const control = db.prepare('SELECT * FROM source_update_control WHERE singleton=1').get();
    if (!control || control.active_job_id || control.worker_id || control.pid || control.start_ticks || control.boot_id || control.pgid
        || control.lease_expires_at || db.prepare("SELECT 1 FROM source_update_effects WHERE state='running' LIMIT 1").get()) fail('worker_conflict');
    if (db.prepare(`SELECT 1 FROM pending_server_actions WHERE id<>? AND status IN ('pending','executing')
        AND (action_type='safe-restart' OR source_update_job_id=? OR source_update_transaction_id=?) LIMIT 1`)
        .get(r.actionId, r.jobId, r.transactionId)) fail('action_conflict');
    if (job.state === 'rolled_back' && pending.status === 'superseded' && pending.error === 'local_source_manual_rollback'
        && settled.length === 1) return { state: 'settled', job, action: pending, receipts, settled };
    if (job.state !== 'manual_recovery_required' || consent.length !== 1 || failure.length !== 1 || settled.length
        || pending.status !== 'failed' || pending.error !== 'source_update_manual_recovery_required') fail('manual_rollback_state_changed');
    return { state: 'ready', job, action: pending, receipts, settled };
}

/** Atomically settle metadata only after the caller proves physical rollback. */
export function reconcileManualRecoveryRollback(db, input, activeStates = MANUAL_ROLLBACK_ACTIVE_STATES, assertStillCurrent = () => {}) {
    const identity = manualRecoveryRegistrationIdentity(input.registration), r = input.registration;
    const expectedAck = `rollback:${r.transactionId}:${input.operationPacketSha256}:${input.runtimePacketSha256}`;
    if (![input.operationPacketSha256, input.runtimePacketSha256, input.evidenceSha256].every(value => SHA.test(value))
        || input.operationPacketSha256 !== r.operationPacketSha256 || input.ownerAck !== expectedAck
        || typeof assertStillCurrent !== 'function') fail('manual_rollback_identity');
    const factsJson = JSON.stringify({ code: 'local_source_manual_rollback', jobId: r.jobId, actionId: r.actionId,
        transactionId: r.transactionId, operationPacketSha256: input.operationPacketSha256,
        runtimePacketSha256: input.runtimePacketSha256, evidenceSha256: input.evidenceSha256, ownerAck: input.ownerAck });
    const factsSha256 = sha(factsJson);
    return db.transaction(() => {
        assertStillCurrent();
        const state = inspectManualRecoveryRollbackState(db, r, activeStates);
        if (state.state === 'settled') {
            if (state.settled[0].facts_json !== factsJson || state.settled[0].facts_sha256 !== factsSha256) fail('manual_rollback_replay_changed');
            return { reused: true, jobId: r.jobId, factsSha256 };
        }
        assertStillCurrent();
        const sequence = Number(db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM source_update_receipts WHERE job_id=?').get(r.jobId).n);
        db.prepare("INSERT INTO source_update_receipts(job_id,sequence,worker_fence,phase,kind,facts_json,facts_sha256) VALUES (?,?,?,'rolled_back','recovery',?,?)")
            .run(r.jobId, sequence, state.job.worker_fence, factsJson, factsSha256);
        const changed = db.prepare("UPDATE source_update_jobs SET state='rolled_back',progress_seq=progress_seq+1,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=? AND state='manual_recovery_required' AND auto_activate=1 AND transaction_id=? AND activation_identity_sha256=?")
            .run(r.jobId, r.transactionId, r.activationIdentitySha256).changes;
        if (changed !== 1) fail('manual_rollback_cas_failed');
        const actionChanged = db.prepare("UPDATE pending_server_actions SET status='superseded',error='local_source_manual_rollback',settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='failed' AND error='source_update_manual_recovery_required'")
            .run(r.actionId).changes;
        if (actionChanged !== 1) fail('manual_rollback_action_cas_failed');
        return { reused: false, jobId: r.jobId, factsSha256 };
    }).immediate();
}
