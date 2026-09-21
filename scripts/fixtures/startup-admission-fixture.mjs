/** Isolated signed-root fixture; typed observations here are test data, never live host evidence. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { handleBootstrapStartupAdmission, finalizeCommittedStartupAdmission } from '../lib/release-runtime-startup-admission.mjs';
import { installFixedStateMutexAuthority } from './fixed-state-mutex-authority.mjs';
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hash = 'a'.repeat(64);
const bootId = '12345678-1234-1234-1234-123456789012';
export function fixture(t, mode = 'steady', contractOverrides = {}, options = {}) {
    if (options.phase !== undefined && options.phase !== 'pre-migration') throw Error('fixture_phase_invalid');
    const preMigration = options.phase === 'pre-migration';
    if (preMigration && mode !== 'cutover') throw Error('fixture_pre_migration_requires_cutover');
    const base = path.resolve('.artifacts'); mkdirSync(base, { recursive: true });
    const root = mkdtempSync(path.join(base, 't1579-admission-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    const read = name => JSON.parse(readFileSync(path.join(root, name)));
    const keys = generateKeyPairSync('ed25519');
    const contract = { schema: 'nassaj-database-release-contract/v2', releaseIdentitySha256: hash,
        migrationEntrySha256: hash, migrationClosureSha256: hash,
        migrationClosure: { schema: 'nassaj-database-migration-closure/v2', assetManifestBound: true, sha256: hash },
        activationPolicy: 'compatible-forward', failurePolicy: 'maintenance-preserve-current-db',
        databasePolicy: 'existing-inode-no-restore', migrationId: 'permission-receipt-forward/v1',
        observationPolicy: 'permission-receipt-metadata/v1',
        source: { schemaDigest: hash, compatibilityShapeDigest: hash, migrationStateDigest: hash },
        target: { schemaDigest: 'b'.repeat(64), compatibilityShapeDigest: hash, migrationStateDigest: hash },
        startup: { policyId: 'existing-security-state/v1', closureSha256: hash } };
    Object.assign(contract, contractOverrides);
    const manifest = { databaseContract: contract };
    const identity = { nodeInstanceId: 'node-one', generationId: 'generation-one', releaseIdentitySha256: hash,
        startupClosureSha256: hash, databaseContractSha256: sha(canonical(contract)), databaseDev: '1', databaseIno: '9007199254740993',
        startupPolicyId: 'existing-security-state/v1', startupAdmissionPolicy: 'same-generation-auto-restart/v1' };
    const expected = { nodeInstanceId: identity.nodeInstanceId, generationId: identity.generationId,
        releaseIdentitySha256: hash, databaseContractSha256: identity.databaseContractSha256,
        ownerApprovalKeySha256: sha(keys.publicKey.export({ type: 'spki', format: 'der' })) };
    for (const key of ['hostIdentitySha256', 'migrationIdentitySha256', 'pm2SnapshotSha256', 'assetSha256', 'targetSchemaDigest', 'serverBuildId', 'clientBuildId']) expected[key] = hash;
    const now = Date.now();
    const payload = { schema: 'nassaj-owner-cutover-approval/v1', action: 'release-runtime-first-cutover',
        expectedSha256: sha(canonical(expected)), issuedAt: now - 10_000, expiresAt: now + 10_000, startupAdmission: identity };
    const approval = { ...payload, signature: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('base64url') };
    const approvalSha256 = sha(canonical(approval));
    const journal = { schema: 'nassaj-release-runtime-cutover/v1', expected, transactionId: preMigration ? 'transaction-forward-one' : 'transaction-one',
        state: 'running', phase: 'startup_claim_pending',
        approvalAcceptedAt: now - 5_000, approvalSha256, revision: 1, startupClaim: { state: 'pending' }, forwardReceipts: { schema: { schema: 'nassaj-compatible-forward-schema/v1',
            transactionId: 'transaction-one', targetSchemaDigest: expected.targetSchemaDigest, releaseIdentitySha256: identity.releaseIdentitySha256,
            databaseContractSha256: identity.databaseContractSha256, databaseDev: identity.databaseDev, databaseIno: identity.databaseIno, observedAt: now - 4_200 } } };
    if (preMigration) { journal.phase = 'retirement_verified'; delete journal.startupClaim; delete journal.forwardReceipts; }
    write('first-cutover.json', journal);
    write('startup-admission.json', { schema: 'nassaj-startup-admission/v1', state: 'switching',
        identity, revision: 1, generationEpoch: 1, authorityId: journal.transactionId, approvalSha256,
        commitReceiptSha256: null, lastClaim: null, offer: null });
    const sealKeys = ['nodeInstanceId', 'hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256',
        'pm2SnapshotSha256', 'databaseContractSha256', 'assetSha256'];
    const gate = { transactionId: journal.transactionId, identitySeal: sha(JSON.stringify(sealKeys.map(key => [key, expected[key]]))),
        nonce: 'maintenance-one', responderUnit: 'maintenance.service', publicUrl: 'https://fixture.invalid/health', at: now - 4_500 };
    write('host-dispatch-state.json', { schema: 'nassaj-host-dispatch-state/v1', gateActive: true, gateInstallIntent: gate });
    write('approval.json', approval); write('key.pem', keys.publicKey.export({ type: 'spki', format: 'pem' }));
    write('manifest.json', manifest);
    const config = { schema: 'nassaj-release-runtime-host-config/v1', controlRoot: root, expected, maintenance: { nonce: gate.nonce, responderUnit: gate.responderUnit },
        health: { publicUrl: gate.publicUrl }, bootstrapClaim: { identity, approvalFile: path.join(root, 'approval.json'),
        ownerApprovalPublicKeyFile: path.join(root, 'key.pem'), releaseManifestFile: path.join(root, 'manifest.json'),
        releaseManifestSha256: sha(JSON.stringify(manifest)) } };
    const caller = { uid: process.getuid(), pid: 42, startTicks: '100', bootId };
    // The admission guard compares the effective uid against this fixture's unprivileged owner.
    // Pin it explicitly so the ambient root seam the state mutex needs cannot answer for it.
    const deps = { readRootFile: file => readFileSync(file), ownerUid: process.getuid(), effectiveUid: () => deps.ownerUid,
        now: () => now, bootMs: () => 10_000, processGone: () => false };
    const request = () => ({ schema: 'nassaj-bootstrap-admission-offer-request/v1', challenge: hash,
        pid: caller.pid, startTicks: caller.startTicks, bootId: caller.bootId, releaseIdentitySha256: hash, startupClosureSha256: hash });
    const call = req => handleBootstrapStartupAdmission(config, req, () => ({ ...caller }), deps);
    const consume = offer => ({ ...request(), schema: 'nassaj-bootstrap-admission-consume-request/v1',
        offerId: offer.offerId, offerNonce: offer.offerNonce, expectedRevision: offer.revision, generationEpoch: offer.generationEpoch });
    const phase = kind => {
        const claim = read('startup-admission.json').lastClaim;
        return call({ ...request(), schema: kind === 'security' ? 'nassaj-startup-security-admission-request/v1' : 'nassaj-startup-serving-confirmation-request/v1',
            claimId: claim.claimId, generationEpoch: claim.generationEpoch, databaseContractSha256: identity.databaseContractSha256,
            challenge: (kind === 'security' ? 'b' : 'c').repeat(64) });
    };
    // Typed observations are fixture data, not a claim of running the actual host cutover producer.
    // The consume and terminal/active transitions themselves execute production functions.
    const prepareCommit = () => {
        if (!read('startup-admission.json').securityStartup) phase('security');
        const current = read('first-cutover.json'); const consumed = current.startupClaim;
        const proof = visibility => ({ schema: 'nassaj-compatible-forward-health/v1', visibility, httpStatus: 200, health: 'ok',
            transactionId: current.transactionId, claimId: consumed.claimId, process: { uid: consumed.uid, pid: consumed.pid,
                startTicks: consumed.startTicks, bootId: consumed.bootId }, ...identity,
            serverBuildId: expected.serverBuildId, clientBuildId: expected.clientBuildId,
            observedAt: now - (visibility === 'private' ? 4_000 : 1_000) });
        write('first-cutover.json', { ...current, phase: 'public_verified', forwardReceipts: { ...current.forwardReceipts, private: proof('private'), public: proof('public') } });
        write('host-dispatch-state.json', { ...read('host-dispatch-state.json'), gateActive: false,
            publicBoundaryReady: { nonce: gate.nonce, at: now - 3_000 }, publicBoundaryOpened: { nonce: gate.nonce, at: now - 2_000 } });
    };
    const commit = () => { prepareCommit(); return finalizeCommittedStartupAdmission(config, deps); };
    // Explicit root-derived initial arm fixture. Kernel/PM2 observations are unit seams,
    // not production arm evidence; the real admission handler still checks every binding.
    const serviceIdentity={uid:process.getuid(),gid:process.getgid(),supplementaryGids:process.getgroups().sort((a,b)=>a-b)};
    config.forwardMigration={serviceIdentity};
    const operator={pid:43,startTicks:'99',bootId};
    const startIntent={operationId:'transaction-one',attemptId:'attempt-one',attemptNonce:hash,requestId:'c'.repeat(32),step:'start-target'};
    const targetSlotBinding={schema:'nassaj-prepared-pm2-slot/v1',operationId:'transaction-one',attemptId:'attempt-one',
        daemonIdentitySha256:hash,namespaceSha256:hash,targetDescriptorSha256:hash,allocatedPmId:3};
    // The arm window is bound to the caller's boot identity, so a test that repoints `caller` at a
    // real process must re-derive it here rather than leave a window signed for the synthetic one.
    let initialTargetProcess;
    const bindInitialCaller=()=>{
        const initialStartWindow={transactionId:'transaction-one',attemptId:'attempt-one',attemptNonce:hash,
            startRequestId:startIntent.requestId,startIntentSha256:sha(canonical(startIntent)),
            targetSlotBindingSha256:sha(canonical(targetSlotBinding)),generationEpoch:1,bootId:caller.bootId,issuedAtBootMs:9000,expiresAtBootMs:39000};
        initialTargetProcess={schema:'nassaj-forward-initial-process/v1',transactionId:'transaction-one',
            attemptId:'attempt-one',attemptNonce:hash,startRequestId:startIntent.requestId,startIntentSha256:initialStartWindow.startIntentSha256,
            targetSlotBindingSha256:initialStartWindow.targetSlotBindingSha256,daemonIdentitySha256:hash,namespaceSha256:hash,
            allocatedPmId:3,targetDescriptorSha256:hash,observationSha256:hash,
            process:{...caller,gid:serviceIdentity.gid},generationEpoch:1,expiresAtBootMs:39000};
        const initialTargetProcessSha256=sha(canonical(initialTargetProcess));
        write('first-cutover.lock',{schema:'nassaj-cutover-lock/v1',pid:operator.pid,startTime:operator.startTicks});
        write('first-cutover.json',{...read('first-cutover.json'),initialStartWindow,initialTargetProcess,targetSlotBinding,
            forwardSupervisorIntent:{transactionId:'transaction-one',phase:'start',attemptId:'attempt-one',attemptNonce:hash,operator:{...operator,bootId:caller.bootId}},
            forwardSupervisorAttempts:[{attemptId:'attempt-one',attemptNonce:hash,steps:[{step:'start-target',state:'possibly_sent',intent:startIntent}]}],
            startupClaim:{state:'pending',initialTargetProcessSha256,startIntentSha256:initialStartWindow.startIntentSha256}});
        write('startup-admission.json',{...read('startup-admission.json'),initialTargetProcessSha256});
    };
    if (!preMigration) bindInitialCaller();
    deps.inspectProcess=pid=>pid===operator.pid ? {...operator,bootId:caller.bootId,uids:[0,0,0,0]} : {
        ...initialTargetProcess.process,uids:Array(4).fill(serviceIdentity.uid),gids:Array(4).fill(serviceIdentity.gid),
        supplementaryGids:serviceIdentity.supplementaryGids,capabilities:['0','0','0']};
    // The fixed root state mutex is unconditional production code, so the authority must exist
    // before the fixture itself takes the lock in `steady` mode, not only in the calling test.
    // Only the measured authority material is projected as root-owned: this fixture's own records
    // stay service-owned for the callers that assert on their real ownership.
    const authority = installFixedStateMutexAuthority(t, root, config, { measuredOnly: true });
    if (mode === 'steady') {
        call(consume(call(request()))); commit();
        caller.pid += 1; caller.startTicks = '101'; deps.processGone = () => true;
    }
    return { root, read, write, config, caller, deps, request, call, consume, keys, commit, prepareCommit, phase, identity, manifest, authority, bindInitialCaller };
}

