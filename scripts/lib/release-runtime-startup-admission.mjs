/** Root-side one-use startup admission. No host effects or SQLite handles are opened here. */
import { LOCAL_BUILD_KIND, validateLocalManifestHeader, validateLocalPreparedArtifact, localBuildIdentitySha256 } from './local-reviewed-build-identity.mjs';
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readVerifiedManagedRestart, readVerifiedManagedTerminal } from './release-runtime-managed-admission.mjs';
import { inspectForwardChildIdentity, assertForwardServiceIdentity } from './release-runtime-forward-child-protocol.mjs';
import { withCutoverStateLock } from './release-runtime-cutover.mjs';
import { isCutoverStateAcquisitionBusy } from './release-runtime-state-mutex.mjs';
import { RELEASE_ASSET_LIMITS, validateCompatibleForwardDatabaseContract } from './update-release-asset.mjs';

const HEX = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,23})$/;
const POLICY = 'same-generation-auto-restart/v1';
const STARTUP = 'existing-security-state/v1';
const OFFER_REQUEST = 'nassaj-bootstrap-admission-offer-request/v1';
const CONSUME_REQUEST = 'nassaj-bootstrap-admission-consume-request/v1';
const SECURITY_REQUEST = 'nassaj-startup-security-admission-request/v1';
const SERVING_REQUEST = 'nassaj-startup-serving-confirmation-request/v1';
const BASE_KEYS = ['schema', 'challenge', 'pid', 'startTicks', 'bootId', 'releaseIdentitySha256', 'startupClosureSha256'];
const IDENTITY_KEYS = ['nodeInstanceId', 'generationId', 'releaseIdentitySha256', 'startupClosureSha256',
    'databaseContractSha256', 'databaseDev', 'databaseIno', 'startupPolicyId', 'startupAdmissionPolicy'];
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => canonical(left) === canonical(right);
function deny(reason = 'invalid') { throw new Error(`startup_admission_${reason}`); }
function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) deny('fields_invalid');
}
function rootFile(file, ownerUid, maximum = 256 * 1024) {
    if (!path.isAbsolute(file) || realpathSync(file) !== file) deny('path_unsafe');
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        const info = lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink() || ![0, ownerUid].includes(info.uid) || (info.mode & 0o022)) deny('ancestor_unsafe');
    }
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid || (before.mode & 0o077)
        || (maximum === RELEASE_ASSET_LIMITS.manifestBytes && (before.mode & 0o777) !== 0o600)
        || before.size < 1 || before.size > maximum) deny('file_unsafe');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        const same = info => ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => info[key] === before[key]);
        if (!same(opened)) deny('file_changed');
        const chunks = []; let total = 0;
        while (total <= maximum) {
            const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - total));
            const count = readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
            chunks.push(chunk.subarray(0, count)); total += count;
        }
        if (total > maximum || total !== before.size || !same(fstatSync(fd))) deny('file_changed');
        return Buffer.concat(chunks, total);
    } finally { closeSync(fd); }
}
function readRecord(file, uid, read = rootFile) { return JSON.parse(read(file, uid)); }
function writeRecord(file, record) {
    const temporary = `${file}.partial-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const directory = openSync(path.dirname(file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
function syncRecord(file) {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(path.dirname(file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
function increment(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) deny('revision_invalid');
    return value + 1;
}
function requestKind(request) {
    if ([SECURITY_REQUEST, SERVING_REQUEST].includes(request?.schema)) {
        exactKeys(request, [...BASE_KEYS, 'claimId', 'generationEpoch', 'databaseContractSha256']);
        const { claimId, generationEpoch, databaseContractSha256, ...base } = request;
        requestKind({ ...base, schema: OFFER_REQUEST });
        if (!/^[a-f0-9-]{36}$/.test(claimId || '') || !Number.isSafeInteger(generationEpoch) || generationEpoch < 0
            || !HEX.test(databaseContractSha256)) deny('request_invalid');
        return request.schema === SECURITY_REQUEST ? 'security' : 'serving';
    }
    const consume = request?.schema === CONSUME_REQUEST;
    if (!consume && request?.schema !== OFFER_REQUEST) deny('schema_invalid');
    exactKeys(request, consume ? [...BASE_KEYS, 'offerId', 'offerNonce', 'expectedRevision', 'generationEpoch'] : BASE_KEYS);
    if (!HEX.test(request.challenge) || !HEX.test(request.releaseIdentitySha256) || !HEX.test(request.startupClosureSha256)
        || !Number.isSafeInteger(request.pid) || request.pid <= 0 || !DECIMAL.test(request.startTicks)
        || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.bootId)
        || (consume && (!HEX.test(request.offerNonce) || !Number.isSafeInteger(request.expectedRevision)
            || !Number.isSafeInteger(request.generationEpoch) || typeof request.offerId !== 'string' || request.offerId.length > 64))) deny('request_invalid');
    return consume ? 'consume' : 'offer';
}
function identityFrom(config) {
    if (config.schema !== 'nassaj-release-runtime-host-config/v1'
        || ['hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256', 'pm2SnapshotSha256',
            'databaseContractSha256', 'assetSha256', 'ownerApprovalKeySha256', 'targetSchemaDigest', 'serverBuildId', 'clientBuildId']
            .some(key => !HEX.test(config.expected?.[key]))) deny('host_identity_invalid');
    const value = config.bootstrapClaim.identity;
    exactKeys(value, IDENTITY_KEYS);
    if (value.startupPolicyId !== STARTUP || value.startupAdmissionPolicy !== POLICY
        || !DECIMAL.test(value.databaseDev) || !DECIMAL.test(value.databaseIno) || value.databaseIno === '0'
        || ['releaseIdentitySha256', 'startupClosureSha256', 'databaseContractSha256'].some((key) => !HEX.test(value[key]))) deny('identity_invalid');
    for (const key of ['nodeInstanceId', 'generationId', 'releaseIdentitySha256', 'databaseContractSha256']) {
        if (value[key] !== config.expected[key]) deny('configured_identity_mismatch');
    }
    return value;
}
function ownerAuthority(config, identity, journal, uid, now, read) {
    const settings = config.bootstrapClaim;
    const approval = readRecord(settings.approvalFile, uid, read);
    const { signature, ...payload } = approval;
    const key = createPublicKey(read(settings.ownerApprovalPublicKeyFile, uid));
    const keyDigest = digest(key.export({ type: 'spki', format: 'der' }));
    if (key.asymmetricKeyType !== 'ed25519' || keyDigest !== config.expected.ownerApprovalKeySha256
        || payload.schema !== 'nassaj-owner-cutover-approval/v1' || payload.action !== 'release-runtime-first-cutover'
        || payload.expectedSha256 !== digest(canonical(config.expected)) || !equal(payload.startupAdmission, identity)
        || typeof signature !== 'string' || signature.length > 128
        || !verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64url'))
        || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
        || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 300_000
        || !Number.isSafeInteger(journal.approvalAcceptedAt) || journal.approvalAcceptedAt < payload.issuedAt
        || journal.approvalAcceptedAt >= payload.expiresAt || journal.approvalAcceptedAt > now) deny('owner_authority_invalid');
    const approvalSha256 = digest(canonical(approval));
    if (journal.approvalSha256 !== approvalSha256) deny('owner_authority_mismatch');
    const manifestBytes = read(settings.releaseManifestFile, uid, RELEASE_ASSET_LIMITS.manifestBytes);
    if (digest(manifestBytes) !== settings.releaseManifestSha256) deny('manifest_changed');
    const manifest = JSON.parse(manifestBytes);
    if (config.expected.artifactPolicy === LOCAL_BUILD_KIND) {
        const build=validateLocalManifestHeader(manifest,{kind:LOCAL_BUILD_KIND,build:config.expected.localBuild});
        const artifact=validateLocalPreparedArtifact(config.expected.localArtifact,build);
        if (localBuildIdentitySha256(build)!==identity.releaseIdentitySha256
            || artifact.archiveSha256!==config.expected.assetSha256 || artifact.manifestSha256!==digest(manifestBytes)
            || artifact.manifestSize!==manifestBytes.length || artifact.databaseContractSha256!==identity.databaseContractSha256
            || artifact.startupClosureSha256!==identity.startupClosureSha256
            || identity.generationId!==`local-forward-${artifact.archiveSha256}`) deny('local_owner_identity_mismatch');
    } else if (manifest.schema !== undefined || manifest.build !== undefined
        || config.expected.artifactPolicy !== undefined || config.expected.localBuild !== undefined || config.expected.localArtifact !== undefined) deny('owner_identity_kind_mismatch');
    if (manifest.databaseContract?.schema !== 'nassaj-database-release-contract/v2'
        || manifest.databaseContract.releaseIdentitySha256 !== identity.releaseIdentitySha256
        || digest(canonical(manifest.databaseContract)) !== identity.databaseContractSha256) deny('manifest_contract_mismatch');
    validateCompatibleForwardDatabaseContract(manifest.databaseContract, identity.releaseIdentitySha256, identity.startupClosureSha256);
    return approvalSha256;
}
function defaultProcessGone(claim, currentBoot) {
    if (claim.bootId !== currentBoot) return true;
    try {
        const stat = readFileSync(`/proc/${claim.pid}/stat`, 'utf8');
        const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19];
        return startTicks !== claim.startTicks;
    } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function sameCaller(claim, caller) {
    return ['uid', 'pid', 'startTicks', 'bootId'].every((key) => claim[key] === caller[key]);
}
function validateStoredBindings(state) {
    for (const binding of [state.offer, state.lastClaim]) {
        if (binding == null) continue;
        if(binding.mode==='cutover' && (!HEX.test(binding.initialTargetProcessSha256) || !HEX.test(binding.startIntentSha256))) deny('stored_initial_binding_invalid');
        if (!Number.isSafeInteger(binding.pid) || binding.pid <= 0 || !Number.isSafeInteger(binding.uid) || binding.uid <= 0
            || !DECIMAL.test(binding.startTicks) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.bootId)
            || !HEX.test(binding.challenge) || !Number.isSafeInteger(binding.revision) || binding.revision > state.revision
            || IDENTITY_KEYS.some((key) => binding[key] !== state.identity[key])) deny('stored_binding_invalid');
    }
    if (state.offer && (state.offer.schema !== 'nassaj-bootstrap-admission-offer/v1' || state.offer.decision !== 'offered'
        || state.offer.revision !== state.revision || !Number.isSafeInteger(state.offer.expiresAtBootMs))) deny('stored_offer_invalid');
    if (state.lastClaim && (state.lastClaim.schema !== 'nassaj-bootstrap-admission-claim/v1'
        || state.lastClaim.decision !== 'claimed')) deny('stored_claim_invalid');
}
function assertCommittedClaim(state, journal) {
    const initial = journal.startupClaim;
    if (!initial || initial.state !== 'consumed' || initial.schema !== 'nassaj-bootstrap-admission-claim/v1'
        || initial.decision !== 'claimed' || initial.mode !== 'cutover' || initial.authorityId !== journal.transactionId
        || typeof initial.claimId !== 'string' || !/^[a-f0-9-]{36}$/.test(initial.claimId)
        || IDENTITY_KEYS.some(key => initial[key] !== state.identity[key])
        || state.activationClaimSha256 !== digest(canonical(initial)) || !state.lastClaim
        || state.lastClaim.authorityId !== journal.transactionId || state.lastClaim.revision < initial.revision) deny('committed_claim_missing');
    const { state: _state, ...initialResponse } = initial;
    if (state.lastClaim.mode === 'cutover' && !equal(state.lastClaim, initialResponse)) deny('committed_claim_mismatch');
    if (!['cutover', 'steady'].includes(state.lastClaim.mode)) deny('committed_claim_mismatch');
}
function cutoverSeal(expected) {
    const keys = ['nodeInstanceId', 'hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256',
        'pm2SnapshotSha256', 'databaseContractSha256', 'assetSha256'];
    return digest(JSON.stringify(keys.map(key => [key, expected[key]])));
}
function assertForwardHostState(host, journal) {
    const legacy = ['migrationIntent', 'oldDeleteIntent', 'oldKilledForRollback', 'oldRestartedFresh'];
    if (legacy.some(key => Object.hasOwn(host, key))
        || (Object.hasOwn(host, 'supervisorSwitched') && host.supervisorSwitched !== false)
        || (Object.hasOwn(host, 'frozen') && host.frozen !== false)) deny('legacy_intent_unsupported');
    const allowed = ['schema', 'operations', 'ingress', 'frozen', 'supervisorSwitched', 'gateInstallIntent',
        'gateActive', 'gateRestoredAt', 'firstForwardGateClosedAt', 'publicBoundaryReady', 'publicBoundaryOpened', 'managedIngress'];
    if (Object.keys(host).some(key => !allowed.includes(key))
        || (Object.hasOwn(host, 'operations') && (!host.operations || Array.isArray(host.operations) || Object.keys(host.operations).length))
        || (Object.hasOwn(host, 'ingress') && host.ingress !== null)) deny('unknown_host_state');
    if (Object.hasOwn(host, 'firstForwardGateClosedAt')) {
        const closedAt = host.firstForwardGateClosedAt; const intent = host.gateInstallIntent;
        const receipt = journal.forwardGateReceipt;
        if (!Number.isSafeInteger(closedAt) || closedAt <= 0 || !Number.isSafeInteger(intent?.at)
            || intent.at <= 0 || intent.at > closedAt || intent.transactionId !== journal.transactionId
            || receipt?.schema !== 'nassaj-first-forward-ingress-receipt/v1' || receipt.phase !== 'closed'
            || receipt.closedAt !== closedAt || receipt.operationId !== journal.transactionId
            || receipt.generationEpoch !== journal.forwardAdmission?.generationEpoch
            || !Number.isSafeInteger(receipt.generationEpoch) || receipt.generationEpoch < 1
            || receipt.hostProofSha256 !== digest(canonical(intent))) deny('first_forward_gate_receipt');
    }
}
function assertTerminalReceipts(config, state, journal, host) {
    assertForwardHostState(host, journal);
    const initial = journal.startupClaim;
    if (!initial || initial.state !== 'consumed' || initial.mode !== 'cutover' || initial.decision !== 'claimed'
        || initial.schema !== 'nassaj-bootstrap-admission-claim/v1' || initial.authorityId !== journal.transactionId) deny('committed_claim_missing');
    const { state: _state, ...response } = initial;
    validateStoredBindings({ ...state, offer: null, lastClaim: response });
    const gate = host.gateInstallIntent; const ready = host.publicBoundaryReady; const opened = host.publicBoundaryOpened;
    if (!gate || !ready || !opened || host.gateActive !== false
        || gate.transactionId !== journal.transactionId || gate.identitySeal !== cutoverSeal(config.expected)
        || gate.nonce !== config.maintenance?.nonce || ready.nonce !== gate.nonce || opened.nonce !== gate.nonce
        || gate.responderUnit !== config.maintenance.responderUnit || gate.publicUrl !== config.health?.publicUrl
        || !Number.isSafeInteger(gate.at) || !Number.isSafeInteger(ready.at) || !Number.isSafeInteger(opened.at)
        || gate.at > ready.at || ready.at > opened.at) deny('gate_intent_unresolved');
    for (const visibility of ['private', 'public']) {
        const receipt = journal.forwardReceipts?.[visibility];
        if (!receipt || receipt.schema !== 'nassaj-compatible-forward-health/v1' || receipt.visibility !== visibility
            || receipt.httpStatus !== 200 || receipt.health !== 'ok' || receipt.transactionId !== journal.transactionId
            || receipt.claimId !== initial.claimId || !sameCaller(receipt.process || {}, initial)
            || IDENTITY_KEYS.some(key => receipt[key] !== state.identity[key])
            || receipt.serverBuildId !== config.expected.serverBuildId || receipt.clientBuildId !== config.expected.clientBuildId
            || !Number.isSafeInteger(receipt.observedAt)
            || (visibility === 'private' && (receipt.observedAt < gate.at || receipt.observedAt > ready.at))
            || (visibility === 'public' && receipt.observedAt < opened.at)) deny('terminal_receipt_invalid');
    }
}
function currentAuthority(config, request, state, journal, host, uid, now, read) {
    const identity = identityFrom(config);
    if (request.releaseIdentitySha256 !== identity.releaseIdentitySha256
        || request.startupClosureSha256 !== identity.startupClosureSha256 || !equal(state.identity, identity)
        || state.schema !== 'nassaj-startup-admission/v1' || !equal(journal.expected, config.expected)
        || journal.schema !== 'nassaj-release-runtime-cutover/v1') deny('target_mismatch');
    if (host.managedIngress) {
        const managed = readVerifiedManagedTerminal(config, state.managedCommittedOperationId, { readRootFile: read, ownerUid: uid, now: () => now });
        if (managed.phase !== 'committed' || host.managedIngress.phase !== 'opened'
            || state.managedCommitSha256 !== digest(canonical(managed))) deny('managed_transition_unresolved');
    }
    const approvalSha256 = ownerAuthority(config, identity, journal, uid, now, read);
    if (state.approvalSha256 !== approvalSha256 || host.schema !== 'nassaj-host-dispatch-state/v1') deny('authority_mismatch');
    assertForwardHostState(host, journal);
    if (journal.state === 'running' && ['startup_claim_pending','target_start_intent'].includes(journal.phase) && state.state === 'switching'
        && state.authorityId === journal.transactionId && ['pending','awaiting_process'].includes(journal.startupClaim?.state)
        && host.gateActive === true) return { identity, mode: 'cutover', authorityId: journal.transactionId };
    if (state.state !== 'active' || journal.state !== 'committed' || journal.phase !== 'committed'
        || state.authorityId !== journal.transactionId || state.commitReceiptSha256 !== digest(canonical(journal))
        || host.gateActive !== false || !host.publicBoundaryOpened) deny('transition_unresolved');
    assertCommittedClaim(state, journal);
    assertTerminalReceipts(config, state, journal, host);
    return { identity, mode: 'steady', authorityId: state.authorityId };
}
const INITIAL_WINDOW_KEYS = ['transactionId','attemptId','attemptNonce','startRequestId','startIntentSha256',
    'targetSlotBindingSha256','generationEpoch','bootId','issuedAtBootMs','expiresAtBootMs'];
function initialWindow(config, state, journal, host, caller, uid, read, deps) {
    const window = journal.initialStartWindow; exactKeys(window, INITIAL_WINDOW_KEYS);
    const intent = journal.forwardSupervisorIntent;
    const attempt = journal.forwardSupervisorAttempts?.at(-1);
    const step = attempt?.steps?.find(value => value.step === 'start-target');
    const slot = journal.targetSlotBinding;
    const bootMs = deps.bootMs?.() ?? monotonicBootMs();
    if (state.state !== 'switching' || journal.state !== 'running' || state.authorityId !== journal.transactionId
        || ['transitionReason','potentiallyRunningClaim','revocation'].some(key => Object.hasOwn(state,key))
        || host.gateActive !== true || host.gateInstallIntent?.transactionId !== journal.transactionId
        || host.gateInstallIntent.identitySeal !== cutoverSeal(config.expected)
        || !Number.isSafeInteger(bootMs) || !Number.isSafeInteger(window.issuedAtBootMs)
        || !Number.isSafeInteger(window.expiresAtBootMs) || window.expiresAtBootMs-window.issuedAtBootMs !== 30_000
        || bootMs < window.issuedAtBootMs || bootMs >= window.expiresAtBootMs || window.bootId !== caller.bootId
        || window.transactionId !== journal.transactionId || window.generationEpoch !== state.generationEpoch
        || !intent || intent.phase !== 'start' || intent.transactionId !== window.transactionId
        || attempt?.attemptId !== window.attemptId || attempt.attemptNonce !== window.attemptNonce
        || intent.attemptId !== window.attemptId || intent.attemptNonce !== window.attemptNonce
        || !['possibly_sent','observed'].includes(step?.state) || step.intent?.requestId !== window.startRequestId
        || step.intent.operationId !== window.transactionId || step.intent.attemptId !== window.attemptId
        || step.intent.attemptNonce !== window.attemptNonce || step.intent.step !== 'start-target'
        || digest(canonical(step.intent)) !== window.startIntentSha256
        || digest(canonical(slot)) !== window.targetSlotBindingSha256
        || slot?.operationId !== window.transactionId || slot.attemptId !== window.attemptId) deny('initial_window_invalid');
    const inspect = deps.inspectProcess || inspectForwardChildIdentity;
    const lock = readRecord(path.join(config.controlRoot,'first-cutover.lock'),uid,read);
    const operator = inspect(intent.operator.pid);
    if (lock.schema !== 'nassaj-cutover-lock/v1' || lock.pid !== operator.pid || lock.startTime !== operator.startTicks
        || ['pid','startTicks','bootId'].some(key=>operator[key] !== intent.operator[key])
        || operator.bootId !== window.bootId || operator.uids.length !== 4 || operator.uids.some(value=>value!==0)) deny('initial_operator_changed');
    const actual = inspect(caller.pid); assertForwardServiceIdentity(actual,config.forwardMigration.serviceIdentity);
    if (!sameCaller({...actual,uid:actual.uids[0]},caller)) deny('initial_caller_changed');
    return {window,bootMs,actual};
}
function initialReceipt(state,journal,caller,actual) {
    const receipt=journal.initialTargetProcess; const window=journal.initialStartWindow;
    exactKeys(receipt,['schema','transactionId','attemptId','attemptNonce','startRequestId','startIntentSha256',
        'targetSlotBindingSha256','daemonIdentitySha256','namespaceSha256','allocatedPmId','targetDescriptorSha256',
        'observationSha256','process','generationEpoch','expiresAtBootMs']);
    exactKeys(receipt.process,['pid','startTicks','bootId','uid','gid']);
    const hash=digest(canonical(receipt)); const slot=journal.targetSlotBinding;
    if (receipt.schema !== 'nassaj-forward-initial-process/v1'
        || ['transactionId','attemptId','attemptNonce','startRequestId','startIntentSha256','targetSlotBindingSha256',
            'generationEpoch','expiresAtBootMs'].some(key=>receipt[key] !== window[key])
        || ['daemonIdentitySha256','namespaceSha256','allocatedPmId','targetDescriptorSha256'].some(key=>receipt[key] !== slot[key])
        || ['observationSha256','daemonIdentitySha256','namespaceSha256','targetDescriptorSha256','startIntentSha256','targetSlotBindingSha256'].some(key=>!HEX.test(receipt[key]))
        || !Number.isSafeInteger(receipt.allocatedPmId) || receipt.allocatedPmId<0 || !sameCaller(receipt.process,caller)
        || actual.gids.some(gid=>gid!==receipt.process.gid)
        || state.initialTargetProcessSha256 !== hash || journal.startupClaim.initialTargetProcessSha256 !== hash
        || journal.startupClaim.startIntentSha256 !== window.startIntentSha256
        || (state.lastClaim?.mode==='cutover' && (state.lastClaim.initialTargetProcessSha256!==hash
            || state.lastClaim.startIntentSha256!==window.startIntentSha256))) deny('initial_process_mismatch');
    return {initialTargetProcessSha256:hash,startIntentSha256:window.startIntentSha256};
}
function initialPending(request,state,journal,caller,window,bootMs) {
    if (state.offer || state.lastClaim || state.initialTargetProcessSha256 || journal.initialTargetProcess
        || journal.startupClaim?.state !== 'awaiting_process') deny('initial_pending_partial');
    return {schema:'nassaj-bootstrap-admission-pending/v1',decision:'pending',reason:'initial_process_not_armed',
        authorityId:journal.transactionId,transactionId:journal.transactionId,generationEpoch:state.generationEpoch,
        issuedAtBootMs:window.issuedAtBootMs,expiresAtBootMs:window.expiresAtBootMs,retryAfterMs:100,
        remainingMs:window.expiresAtBootMs-bootMs,challenge:request.challenge,...caller,
        releaseIdentitySha256:request.releaseIdentitySha256,startupClosureSha256:request.startupClosureSha256};
}
function monotonicBootMs() {
    const value = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.floor(value))) deny('clock_invalid');
    return Math.floor(value);
}
function offerClaim(state, caller, request, authority, bootMs, processGone) {
    if (state.lastClaim && !processGone(state.lastClaim, caller.bootId)) deny('previous_process_present');
    const pending = state.offer;
    if (pending) {
        if (sameCaller(pending, caller)) deny('offer_already_issued');
        if (pending.bootId === caller.bootId && pending.expiresAtBootMs > bootMs
            && !processGone(pending, caller.bootId)) deny('offer_owner_present');
    }
    const revision = increment(state.revision);
    const offer = { schema: 'nassaj-bootstrap-admission-offer/v1', decision: 'offered', ...authority.identity,
        mode: authority.mode, authorityId: authority.authorityId, offerId: randomUUID(), offerNonce: randomBytes(32).toString('hex'),
        revision, generationEpoch: state.generationEpoch, challenge: request.challenge, ...caller, ...authority.initialBinding, expiresAtBootMs: Math.min(bootMs + 30_000,authority.expiresAtBootMs ?? Infinity) };
    return { response: offer, state: { ...state, revision, offer } };
}
function consumeClaim(state, caller, request, authority, bootMs) {
    const offer = state.offer;
    if (!offer || !sameCaller(offer, caller) || offer.mode !== authority.mode || offer.authorityId !== authority.authorityId
        || offer.expiresAtBootMs <= bootMs || offer.bootId !== caller.bootId || request.challenge !== offer.challenge
        || request.offerId !== offer.offerId || request.offerNonce !== offer.offerNonce
        || request.expectedRevision !== state.revision || request.expectedRevision !== offer.revision
        || request.generationEpoch !== state.generationEpoch || request.generationEpoch !== offer.generationEpoch) deny('offer_stale');
    if (authority.initialBinding && Object.entries(authority.initialBinding).some(([key,value])=>offer[key] !== value)) deny('initial_offer_changed');
    const revision = increment(state.revision);
    const response = { schema: 'nassaj-bootstrap-admission-claim/v1', decision: 'claimed', ...authority.identity,
        mode: authority.mode, authorityId: authority.authorityId, claimId: randomUUID(), revision,
        generationEpoch: state.generationEpoch, challenge: request.challenge, ...caller, ...authority.initialBinding };
    return { response, state: { ...state, revision, offer: null, lastClaim: response, securityStartup: null } };
}

function claimedAuthority(config, request, state, journal, host, caller, uid, now, read) {
    const identity = identityFrom(config); const claim = state.lastClaim;
    if (!claim || claim.claimId !== request.claimId || !sameCaller(claim, caller)
        || claim.generationEpoch !== request.generationEpoch || state.generationEpoch !== claim.generationEpoch
        || !equal(state.identity, identity) || !equal(journal.expected, config.expected)
        || request.databaseContractSha256 !== identity.databaseContractSha256
        || request.releaseIdentitySha256 !== identity.releaseIdentitySha256 || request.startupClosureSha256 !== identity.startupClosureSha256
        || Object.hasOwn(state, 'transitionReason') || Object.hasOwn(state, 'potentiallyRunningClaim') || Object.hasOwn(state, 'revocation')
        || state.approvalSha256 !== ownerAuthority(config, identity, journal, uid, now, read)) deny('claim_not_current');
    assertForwardHostState(host, journal);
    if (state.state === 'active') {
        currentAuthority(config, request, state, journal, host, uid, now, read);
        return { identity, mode: claim.mode, authorityId: claim.authorityId, committed: true };
    }
    if (state.state !== 'switching' || claim.mode !== 'cutover' || journal.state !== 'running'
        || journal.transactionId !== claim.authorityId || journal.startupClaim?.claimId !== claim.claimId
        || journal.startupClaim?.state !== 'consumed'
        || !['startup_claimed', 'startup_security_authorized', 'target_verified', 'ingress_opening', 'ingress_opened', 'public_verified'].includes(journal.phase)) deny('claim_not_current');
    return { identity, mode: claim.mode, authorityId: claim.authorityId, committed: false };
}
function validateTargetSchemaReceipt(config, state, journal, host) {
    const receipt = journal.forwardReceipts?.schema;
    const gate = host.gateInstallIntent;
    if (!receipt || receipt.schema !== 'nassaj-compatible-forward-schema/v1' || receipt.transactionId !== journal.transactionId
        || receipt.targetSchemaDigest !== config.expected.targetSchemaDigest
        || ['releaseIdentitySha256', 'databaseContractSha256', 'databaseDev', 'databaseIno'].some(key => receipt[key] !== state.identity[key])
        || !Number.isSafeInteger(receipt.observedAt) || !gate || host.gateActive !== true
        || gate.transactionId !== journal.transactionId || gate.identitySeal !== cutoverSeal(config.expected)
        || gate.nonce !== config.maintenance?.nonce || journal.phase !== 'startup_claimed') deny('security_startup_preconditions_missing');
}
function securityBindingMatches(security, claim) {
    return security?.schema === 'nassaj-startup-security-authorization/v1' && security.claimId === claim.claimId
        && security.decision === 'security_startup_authorized' && security.revision === claim.revision + 1
        && security.generationEpoch === claim.generationEpoch && sameCaller(security, claim)
        && IDENTITY_KEYS.every(key => security[key] === claim[key]);
}
function phaseResponse(kind, state, request, caller, authority, revision) {
    return { schema: kind === 'security' ? 'nassaj-startup-security-admission-response/v1' : 'nassaj-startup-serving-confirmation-response/v1',
        decision: kind === 'security' ? 'security_startup_authorized' : authority.committed ? 'serving' : 'pending',
        ...authority.identity, mode: authority.mode, authorityId: authority.authorityId, claimId: state.lastClaim.claimId,
        revision, generationEpoch: state.generationEpoch, challenge: request.challenge, ...caller,
        ...(state.lastClaim.mode==='cutover' ? {initialTargetProcessSha256:state.lastClaim.initialTargetProcessSha256,
            startIntentSha256:state.lastClaim.startIntentSha256} : {}) };
}
function processStartupPhase(kind, config, request, state, journal, host, caller, uid, now, read) {
    const authority = claimedAuthority(config, request, state, journal, host, caller, uid, now, read);
    if (kind === 'serving') {
        if (!securityBindingMatches(state.securityStartup, state.lastClaim)) deny('security_startup_not_authorized');
        return { response: phaseResponse(kind, state, request, caller, authority, state.revision) };
    }
    if (state.securityStartup != null) deny('security_startup_already_authorized');
    if (request.challenge === state.lastClaim.challenge) deny('security_startup_challenge_reused');
    if (!authority.committed) validateTargetSchemaReceipt(config, state, journal, host);
    const revision = increment(state.revision);
    const response = phaseResponse(kind, state, request, caller, authority, revision);
    const securityStartup = { ...response, schema: 'nassaj-startup-security-authorization/v1' };
    return { response, state: { ...state, revision, securityStartup },
        journal: !authority.committed ? { ...journal, startupSecurity: securityStartup,
            phase: 'startup_security_authorized', revision: increment(journal.revision) } : null };
}

/** Fixed wire handler; authority is read and cryptographically verified under the current state lock. */
export function handleBootstrapStartupAdmission(config, request, observeCaller, deps = {}) {
    const kind = requestKind(request);
    const read = deps.readRootFile || rootFile;
    const uid = deps.ownerUid ?? 0;
    if ((deps.effectiveUid?.() ?? process.geteuid?.()) !== uid) deny('root_required');
    let entered = false;
    try { return withCutoverStateLock(config.controlRoot, () => {
        entered = true;
        const file = path.join(config.controlRoot, 'startup-admission.json');
        const state = readRecord(file, uid, read);
        increment(state.revision); validateStoredBindings(state);
        const journalFile = path.join(config.controlRoot, 'first-cutover.json');
        const journal = readRecord(journalFile, uid, read);
        const host = readRecord(path.join(config.controlRoot, 'host-dispatch-state.json'), uid, read);
        const caller = observeCaller();
        if (!Number.isSafeInteger(caller.uid) || caller.uid <= 0 || !sameCaller({ ...request, uid: caller.uid }, caller)) deny('caller_mismatch');
        increment(state.generationEpoch);
        if (state.managedOperationId) return managedBootstrapPhase(kind, config, request, state, caller, observeCaller, deps);
        if (kind === 'security' || kind === 'serving') {
            if(state.lastClaim?.mode==='cutover') {
                const actual=(deps.inspectProcess||inspectForwardChildIdentity)(caller.pid);
                assertForwardServiceIdentity(actual,config.forwardMigration.serviceIdentity);
                if(!sameCaller({...actual,uid:actual.uids[0]},caller)) deny('initial_caller_changed');
                initialReceipt(state,journal,caller,actual);
            }
            const phase = processStartupPhase(kind, config, request, state, journal, host, caller, uid, deps.now?.() ?? Date.now(), read);
            if (!equal(observeCaller(), caller)) deny('caller_changed');
            if (phase.journal) writeRecord(journalFile, phase.journal);
            if (phase.state) writeRecord(file, phase.state);
            return Object.freeze(phase.response);
        }
        const authority = currentAuthority(config, request, state, journal, host, uid, deps.now?.() ?? Date.now(), read);
        const bootMs = deps.bootMs?.() ?? monotonicBootMs();
        if(authority.mode==='cutover') {
            const initial=initialWindow(config,state,journal,host,caller,uid,read,deps);
            if(journal.phase==='target_start_intent') {
                if(kind!=='offer') deny('initial_not_armed');
                if(!equal(observeCaller(),caller)) deny('caller_changed');
                const fresh=initialWindow(config,state,journal,host,caller,uid,read,deps);
                return Object.freeze(initialPending(request,state,journal,caller,fresh.window,fresh.bootMs));
            }
            authority.initialBinding=initialReceipt(state,journal,caller,initial.actual);
            authority.expiresAtBootMs=initial.window.expiresAtBootMs;
        }
        const result = kind === 'offer' ? offerClaim(state, caller, request, authority, bootMs, deps.processGone || defaultProcessGone)
            : consumeClaim(state, caller, request, authority, bootMs);
        if (!equal(observeCaller(), caller)) deny('caller_changed');
        if(authority.mode==='cutover') {
            const fresh=initialWindow(config,state,journal,host,caller,uid,read,deps);
            initialReceipt(state,journal,caller,fresh.actual);
        }
        if (kind === 'consume' && authority.mode === 'cutover') {
            writeRecord(journalFile, { ...journal, revision: increment(journal.revision), phase: 'startup_claimed',
                startupClaim: { ...result.response, state: 'consumed' } });
        }
        writeRecord(file, result.state);
        if(authority.mode==='cutover') {
            const actual=(deps.inspectProcess||inspectForwardChildIdentity)(caller.pid);
            assertForwardServiceIdentity(actual,config.forwardMigration.serviceIdentity);
            if(!sameCaller({...actual,uid:actual.uids[0]},caller) || !equal(observeCaller(),caller)) deny('initial_caller_changed');
        }
        return Object.freeze(result.response);
    }); } catch (error) {
        if (kind !== 'serving' || entered || !isCutoverStateAcquisitionBusy(error)) throw error;
        const caller = observeCaller();
        if (!Number.isSafeInteger(caller.uid) || caller.uid <= 0 || !sameCaller({ ...request, uid: caller.uid }, caller)) deny('caller_mismatch');
        if (!equal(observeCaller(), caller)) deny('caller_changed');
        return Object.freeze({ ...request, schema: 'nassaj-startup-serving-busy/v1', decision: 'busy',
            reason: 'state_lock_contended', retryAfterMs: 100 });
    }
}

/** Finalize root-durable typed proofs; never manufacture a grant from caller-supplied success flags. */
export function finalizeCommittedStartupAdmission(config, deps = {}) {
    const uid = deps.ownerUid ?? 0; const read = deps.readRootFile || rootFile;
    if ((deps.effectiveUid?.() ?? process.geteuid?.()) !== uid) deny('root_required');
    return withCutoverStateLock(config.controlRoot, () => {
        const file = path.join(config.controlRoot, 'startup-admission.json');
        const journalFile = path.join(config.controlRoot, 'first-cutover.json');
        const state = readRecord(file, uid, read); const journal = readRecord(journalFile, uid, read);
        const host = readRecord(path.join(config.controlRoot, 'host-dispatch-state.json'), uid, read);
        const now = deps.now?.() ?? Date.now(); const identity = identityFrom(config);
        if (journal.schema !== 'nassaj-release-runtime-cutover/v1' || state.schema !== 'nassaj-startup-admission/v1'
            || host.schema !== 'nassaj-host-dispatch-state/v1' || !equal(journal.expected, config.expected)
            || !equal(state.identity, identity) || state.authorityId !== journal.transactionId || state.offer != null
            || state.approvalSha256 !== ownerAuthority(config, identity, journal, uid, now, read)) deny('finalization_authority_invalid');
        assertTerminalReceipts(config, state, journal, host);
        if (journal.forwardReceipts.public.observedAt > now) deny('terminal_receipt_invalid');
        const anchor = digest(canonical(journal.startupClaim));
        assertCommittedClaim({ ...state, activationClaimSha256: anchor }, journal);
        const claim = journal.startupClaim;
        if (!securityBindingMatches(journal.startupSecurity, claim)) deny('security_startup_not_authorized');
        if (!Number.isSafeInteger(state.generationEpoch) || state.generationEpoch < 0
            || state.generationEpoch !== claim.generationEpoch
            || Object.hasOwn(state, 'transitionReason') || Object.hasOwn(state, 'potentiallyRunningClaim')
            || Object.hasOwn(state, 'revocation')) deny('finalization_invalidated');
        const finalization = { schema: 'nassaj-startup-finalization/v1', generationEpoch: state.generationEpoch,
            claimId: claim.claimId, stateRevision: journal.startupSecurity.revision };
        if (journal.state === 'committed' && !equal(journal.startupFinalization, finalization)) deny('finalization_mismatch');
        if (state.state === 'active') {
            if (journal.state !== 'committed' || journal.phase !== 'committed'
                || state.commitReceiptSha256 !== digest(canonical(journal)) || state.activationClaimSha256 !== anchor) deny('finalization_mismatch');
            syncRecord(journalFile); syncRecord(file);
            return Object.freeze(state);
        }
        if (state.state !== 'switching' || state.lastClaim.mode !== 'cutover' || state.revision !== journal.startupSecurity.revision
            || !equal(state.securityStartup, journal.startupSecurity)
            || !((journal.state === 'running' && journal.phase === 'public_verified')
                || (journal.state === 'committed' && journal.phase === 'committed'))) deny('finalization_phase_invalid');
        const terminal = journal.state === 'committed' ? journal : { ...journal, state: 'committed', phase: 'committed',
            revision: increment(journal.revision), committedAt: now, startupFinalization: finalization };
        if (terminal.committedAt < journal.forwardReceipts.public.observedAt || !Number.isSafeInteger(terminal.committedAt)) deny('terminal_receipt_invalid');
        if (terminal !== journal) writeRecord(journalFile, terminal);
        else syncRecord(journalFile);
        const active = { ...state, state: 'active', revision: increment(state.revision),
            activationClaimSha256: anchor, commitReceiptSha256: digest(canonical(terminal)) };
        writeRecord(file, active);
        return Object.freeze(active);
    });
}


function managedRecord(config, operationId, deps) { return readVerifiedManagedRestart(config, operationId, deps); }
function managedState(config, deps) { return readRecord(path.join(config.controlRoot, 'startup-admission.json'), deps.ownerUid ?? 0, deps.readRootFile || rootFile); }
function managedWrite(config, record) { writeRecord(path.join(config.controlRoot, 'managed-restart.json'), record); }
function managedRoot(deps) { if ((deps.effectiveUid?.() ?? process.geteuid?.()) !== (deps.ownerUid ?? 0)) deny('root_required'); }
function managedClosed(config, journal, state, deps) {
    const host = readRecord(path.join(config.controlRoot, 'host-dispatch-state.json'), deps.ownerUid ?? 0, deps.readRootFile || rootFile);
    const gate = host.managedIngress;
    if (!gate || gate.operationId !== journal.operationId || gate.generationEpoch !== state.generationEpoch
        || gate.phase !== 'closed' || !Number.isSafeInteger(gate.closedAt)) deny('managed_gate_not_closed');
}
/** Fence general steady admission while retaining the original activation anchor and authority. */
export function beginManagedRestartAdmission(config, operationId, deps = {}) {
    managedRoot(deps);
    return withCutoverStateLock(config.controlRoot, () => {
        const journal = managedRecord(config, operationId, deps); const state = managedState(config, deps);
        if (state.managedOperationId === operationId && state.state === 'switching') return state;
        if (journal.phase !== 'prepared' || !equal(state, journal.originalGrant) || state.offer != null
            || state.state !== 'active' || state.revocation) deny('managed_begin_invalid');
        const next = { ...state, state: 'switching', managedOperationId: operationId, offer: null,
            revision: increment(state.revision), generationEpoch: increment(state.generationEpoch) };
        writeRecord(path.join(config.controlRoot, 'startup-admission.json'), next); return next;
    });
}
/** Arm only the kernel-observed replacement from the durable launch after the original process has exited. */
export function armManagedReplacementAdmission(config, operationId, deps = {}) {
    managedRoot(deps);
    return withCutoverStateLock(config.controlRoot, () => {
        const journal = managedRecord(config, operationId, deps); const state = managedState(config, deps);
        if (journal.phase !== 'restart_execution_intent' || state.managedOperationId !== operationId || !journal.executionIntent
            || !journal.replacementProcess || journal.replacementProcess.launchAttemptNonce !== journal.executionIntent.launchAttemptNonce
            || journal.replacementProcess.pm2Id !== config.managedRestart.pm2Id
            || journal.replacementProcess.pm2Namespace !== config.managedRestart.pm2Namespace) deny('managed_arm_invalid');
        managedClosed(config, journal, state, deps);
        const observed = (deps.inspectProcess || inspectForwardChildIdentity)(journal.replacementProcess.pid);
        assertForwardServiceIdentity(observed, config.managedRestart.serviceIdentity);
        if (!sameCaller({ ...observed, uid: config.bootstrapClaim.applicationUid }, journal.replacementProcess)
            || !(deps.processGone || defaultProcessGone)(journal.oldProcess, observed.bootId)) deny('managed_replacement_unproved');
        const next = { ...journal, phase: 'replacement_claim_pending', revision: increment(journal.revision) };
        managedWrite(config, next); return next;
    });
}
function managedBootstrapPhase(kind, config, request, state, caller, observeCaller, deps) {
    const journal = managedRecord(config, state.managedOperationId, deps);
    const identity = identityFrom(config);
    if (!equal(identity, state.identity) || request.releaseIdentitySha256 !== identity.releaseIdentitySha256
        || request.startupClosureSha256 !== identity.startupClosureSha256) deny('managed_target_mismatch');
    if (kind === 'offer' && ['ingress_closed','restart_execution_intent'].includes(journal.phase)) {
        if (!equal(observeCaller(), caller)) deny('caller_changed');
        return { schema: 'nassaj-bootstrap-admission-pending/v1', decision: 'pending', operationId: journal.operationId,
            generationEpoch: state.generationEpoch, challenge: request.challenge, ...caller,
            releaseIdentitySha256: identity.releaseIdentitySha256, startupClosureSha256: identity.startupClosureSha256 };
    }
    if (!sameCaller(journal.replacementProcess || {}, caller)) deny('managed_replacement_mismatch');
    const authority = { identity, mode: 'steady', authorityId: state.authorityId, committed: false };
    if (kind === 'offer' || kind === 'consume') {
        if (journal.phase !== 'replacement_claim_pending') deny('managed_offer_unavailable');
        managedClosed(config, journal, state, deps);
        const bootMs = deps.bootMs?.() ?? monotonicBootMs();
        const result = kind === 'offer' ? offerClaim(state, caller, request, authority, bootMs, deps.processGone || defaultProcessGone)
            : consumeClaim(state, caller, request, authority, bootMs);
        if (!equal(observeCaller(), caller)) deny('caller_changed');
        if (kind === 'consume') managedWrite(config, { ...journal, revision: increment(journal.revision), phase: 'replacement_claimed',
            replacementClaim: result.response, replacementClaimSha256: digest(canonical(result.response)) });
        writeRecord(path.join(config.controlRoot, 'startup-admission.json'), result.state); return result.response;
    }
    const claim = journal.replacementClaim;
    if (!claim || journal.replacementClaimSha256 !== digest(canonical(claim)) || !equal(state.lastClaim, claim)
        || request.claimId !== claim.claimId || request.generationEpoch !== state.generationEpoch
        || request.databaseContractSha256 !== identity.databaseContractSha256) deny('managed_claim_mismatch');
    if (kind === 'serving') {
        if (!securityBindingMatches(state.securityStartup, claim)) deny('security_startup_not_authorized');
        return phaseResponse(kind, state, request, caller, authority, state.revision);
    }
    if (journal.phase !== 'replacement_claimed' || state.securityStartup || request.challenge === claim.challenge) deny('managed_security_invalid');
    managedClosed(config, journal, state, deps);
    const revision = increment(state.revision); const response = phaseResponse(kind, state, request, caller, authority, revision);
    const securityStartup = { ...response, schema: 'nassaj-startup-security-authorization/v1' };
    if (!equal(observeCaller(), caller)) deny('caller_changed');
    managedWrite(config, { ...journal, phase: 'security_startup_authorized', revision: increment(journal.revision), securityStartup });
    writeRecord(path.join(config.controlRoot, 'startup-admission.json'), { ...state, revision, securityStartup }); return response;
}
/** Persist the managed terminal receipt before restoring active admission; do not rewrite first-cutover. */
export function completeManagedRestartAdmission(config, operationId, deps = {}) {
    managedRoot(deps);
    return withCutoverStateLock(config.controlRoot, () => {
        const journal = managedRecord(config, operationId, deps); const state = managedState(config, deps);
        const alreadyActive = journal.phase === 'committed' && state.state === 'active' && !state.managedOperationId
            && state.managedCommitSha256 === digest(canonical(journal));
        if (!['public_verified','committed'].includes(journal.phase) || (state.managedOperationId !== operationId && !alreadyActive)
            || !equal(state.lastClaim,journal.replacementClaim) || !securityBindingMatches(state.securityStartup,state.lastClaim)
            || !equal(state.securityStartup,journal.securityStartup)) deny('managed_finalize_invalid');
        const host = readRecord(path.join(config.controlRoot,'host-dispatch-state.json'),deps.ownerUid??0,deps.readRootFile||rootFile);
        if (host.managedIngress?.phase !== 'opened' || host.managedIngress.operationId !== operationId
            || host.managedIngress.generationEpoch !== state.generationEpoch) deny('managed_gate_not_open');
        for (const visibility of ['private','public']) {
            const receipt = journal[`${visibility}Receipt`];
            if (!receipt || receipt.schema !== 'nassaj-managed-health-receipt/v1' || !HEX.test(receipt.bodySha256 || '')
                || receipt.clientBuildId !== config.expected.clientBuildId || receipt.databaseContractSha256 !== config.expected.databaseContractSha256
                || receipt.claimId !== state.lastClaim.claimId || receipt.generationEpoch !== state.generationEpoch
                || receipt.operationId !== operationId || receipt.visibility !== visibility
                || !sameCaller(receipt.process || {},state.lastClaim) || receipt.securityStartupSha256 !== digest(canonical(state.securityStartup))
                || receipt.releaseIdentitySha256 !== state.identity.releaseIdentitySha256
                || receipt.serverBuildId !== config.expected.serverBuildId || !Number.isSafeInteger(receipt.observedAt)) deny('managed_receipt_invalid');
        }
        if (alreadyActive) {
            for (const name of [`managed-restart-terminal-${operationId}.json`, 'managed-restart.json', 'startup-admission.json']) syncRecord(path.join(config.controlRoot,name));
            return state;
        }
        const terminal = journal.phase === 'committed' ? journal : { ...journal, phase:'committed', revision:increment(journal.revision), committedAt:deps.now?.()??Date.now() };
        const durable = persistManagedTerminal(config,terminal,journal,deps);
        managedWrite(config,durable);
        const next = { ...state,state:'active',revision:increment(state.revision),managedCommitSha256:digest(canonical(durable)),managedCommittedOperationId:operationId };
        delete next.managedOperationId; writeRecord(path.join(config.controlRoot,'startup-admission.json'),next);return next;
    });
}

function persistManagedTerminal(config, terminal, current, deps) {
    const file = path.join(config.controlRoot, `managed-restart-terminal-${terminal.operationId}.json`);
    let existing;
    try { existing = readRecord(file, deps.ownerUid ?? 0, deps.readRootFile || rootFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
        const intended = current.phase === 'committed' ? current : { ...current, phase:'committed',revision:increment(current.revision),committedAt:existing.committedAt };
        if (!Number.isSafeInteger(existing.committedAt) || existing.committedAt < current.publicReceipt.observedAt
            || existing.committedAt > (deps.now?.() ?? Date.now()) || !equal(existing,intended)) deny('managed_terminal_collision');
        syncRecord(file); return existing;
    }
    const fd=openSync(file,'wx',0o600);
    try { writeFileSync(fd,`${canonical(terminal)}\n`);fsyncSync(fd); } finally { closeSync(fd); }
    const dir=openSync(config.controlRoot,'r');try{fsyncSync(dir);}finally{closeSync(dir);}return terminal;
}
