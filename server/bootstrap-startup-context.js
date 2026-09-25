/** Pre-import startup authority. This module imports only Node builtins and exposes no context setter. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { LOCAL_BUILD_KIND, validateLocalPreparedArtifact, validateLocalManifestHeader, localBuildIdentitySha256 } from '../scripts/lib/local-reviewed-build-identity.mjs';

import { ROOT_ADMISSION_REQUIRED, PROFILE_ID } from './bootstrap-release-profile.js';

// The forward build selects true before provenance/closure sealing. Never selected by environment.
const PUBLIC_DESCRIPTOR = '/etc/nassaj/startup-admission-client.json';
// Keep equal to RELEASE_ASSET_LIMITS.manifestBytes without importing the release tooling into the pure app closure.
const TARGET_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
let verifiedContext = null;
let admissionAttempted = false;
let claimedState = null;
let predecessorAbsenceProved = false;
let startupRecoveryClaimMinted = false;
const startupRecoveryClaims = new WeakMap();
let selectedManifest;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
function releaseRoot() {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    return path.basename(path.dirname(directory)) === 'dist-server' ? path.dirname(path.dirname(directory)) : path.dirname(directory);
}
function targetManifest() {
    if (selectedManifest !== undefined) return selectedManifest;
    const file = path.join(releaseRoot(), 'RELEASE_ASSET_MANIFEST.json');
    if (!fs.existsSync(file)) {
        if (ROOT_ADMISSION_REQUIRED) throw Error('root_startup_manifest_required');
        selectedManifest = null; return null;
    }
    const bytes = readTargetManifestBytes(file); const manifest = JSON.parse(bytes);
    if (manifest.databaseContract?.schema !== 'nassaj-database-release-contract/v2') {
        if (ROOT_ADMISSION_REQUIRED) throw Error('root_startup_contract_required');
        selectedManifest = null; return null;
    }
    if (!ROOT_ADMISSION_REQUIRED || !['local-forward-349/v1', 'local-forward-349/v2'].includes(PROFILE_ID)) throw Error('root_startup_profile_required');
    selectedManifest = { manifest, bytes };
    return selectedManifest;
}
function readTargetManifestBytes(file) {
    const before = fs.lstatSync(file);
    if (fs.realpathSync(file) !== file || !before.isFile() || before.isSymbolicLink() || before.mode & 0o022
        || before.size < 1 || before.size > TARGET_MANIFEST_MAX_BYTES) throw Error('root_startup_manifest_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const same = info => ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => info[key] === before[key]);
    try {
        if (!same(fs.fstatSync(fd))) throw Error('root_startup_manifest_changed');
        const chunks = []; let total = 0;
        while (total <= TARGET_MANIFEST_MAX_BYTES) {
            const chunk = Buffer.alloc(Math.min(65536, TARGET_MANIFEST_MAX_BYTES + 1 - total));
            const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
            chunks.push(chunk.subarray(0, count)); total += count;
        }
        if (total > TARGET_MANIFEST_MAX_BYTES || total !== before.size || !same(fs.fstatSync(fd))) throw Error('root_startup_manifest_changed');
        return Buffer.concat(chunks, total);
    } finally { fs.closeSync(fd); }
}
function readRootFile(file, executable = false) {
    if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw Error('root_startup_path_unsafe');
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        const metadata = fs.lstatSync(parent);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw Error('root_startup_ancestor_unsafe');
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || (before.mode & 0o022)
        || before.size < 1 || before.size > (executable ? 256 * 1024 * 1024 : 256 * 1024)
        || (executable && !(before.mode & 0o111))) throw Error('root_startup_file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd);
        if (before.dev !== opened.dev || before.ino !== opened.ino || before.mode !== opened.mode) throw Error('root_startup_file_changed');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}
function processBinding() {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    return { uid: process.getuid(), pid: process.pid,
        startTicks: stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19],
        bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
function requireKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) throw Error('root_startup_descriptor_fields_invalid');
}
function pinnedDescriptor(target) {
    const descriptorBytes = readRootFile(PUBLIC_DESCRIPTOR);
    if ((fs.lstatSync(PUBLIC_DESCRIPTOR).mode & 0o777) !== 0o644) throw Error('root_startup_descriptor_mode_invalid');
    const descriptor = JSON.parse(descriptorBytes);
    const local=descriptor.schema==='nassaj-startup-admission-client/v2';
    let releaseIdentitySha256;
    if (local) releaseIdentitySha256=verifyLocalDescriptor(descriptor,target);
    else {
    requireKeys(descriptor, 'schema,nodeInstanceId,profileId,dispatcher,sudo,node,release,startupClosureSha256,databaseContractSha256,databasePath,databaseDev,databaseIno');
    requireKeys(descriptor.release, 'repo,releaseId,assetId,assetName,assetSha256,manifestAssetId,manifestAssetName,manifestSha256,tag,commit,generationId');
    const release = descriptor.release; const manifest = target.manifest;
    releaseIdentitySha256 = sha(canonical(Object.fromEntries(['repo', 'releaseId', 'tag', 'version', 'commit',
        'serverBuildId', 'clientBuildId', 'bundleBuildId'].map(key => [key, manifest[key]]))));
    if (manifest.schema !== undefined || manifest.build !== undefined || descriptor.schema !== 'nassaj-startup-admission-client/v1' || descriptor.profileId !== PROFILE_ID
        || !['local-forward-349/v1', 'local-forward-349/v2'].includes(PROFILE_ID) || !ROOT_ADMISSION_REQUIRED
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(descriptor.nodeInstanceId || '')
        || release.manifestSha256 !== sha(target.bytes)
        || descriptor.databaseContractSha256 !== sha(canonical(manifest.databaseContract))
        || descriptor.startupClosureSha256 !== manifest.databaseContract.startup?.closureSha256
        || releaseIdentitySha256 !== manifest.databaseContract.releaseIdentitySha256
        || !HEX.test(release.assetSha256) || !HEX.test(descriptor.startupClosureSha256)
        || !path.isAbsolute(descriptor.databasePath || '') || fs.realpathSync(descriptor.databasePath) !== descriptor.databasePath
        || !/^(0|[1-9][0-9]{0,23})$/.test(descriptor.databaseDev) || !/^[1-9][0-9]{0,23}$/.test(descriptor.databaseIno)
        || ['releaseId', 'assetId', 'manifestAssetId'].some(key => !Number.isSafeInteger(release[key]) || release[key] <= 0)
        || release.assetId === release.manifestAssetId || ['repo', 'releaseId', 'tag', 'commit'].some(key => release[key] !== manifest[key])
        || release.assetName !== `nassaj-runtime-forward-v${manifest.version}.tar.gz`
        || release.manifestAssetName !== 'RELEASE_ASSET_MANIFEST.forward.json'
        || release.generationId !== `${manifest.version}-${manifest.commit.slice(0, 12)}-forward-${release.assetSha256}`
        || release.generationId.length > 96) throw Error('root_startup_descriptor_mismatch');
    }
    for (const key of ['sudo', 'dispatcher', 'node']) {
        const executable = descriptor[key]; requireKeys(executable, 'path,sha256');
        if (!HEX.test(executable.sha256) || sha(readRootFile(executable.path, true)) !== executable.sha256) throw Error('root_startup_executable_mismatch');
    }
    if (fs.realpathSync(process.execPath) !== descriptor.node.path) throw Error('root_startup_interpreter_mismatch');
    return { ...descriptor, ...(local ? {release:{generationId:`local-forward-${descriptor.artifact.archiveSha256}`}} : {}), releaseIdentitySha256, descriptorSha256: sha(descriptorBytes) };
}
function verifyLocalDescriptor(descriptor,target) {
    requireKeys(descriptor,'schema,nodeInstanceId,profileId,dispatcher,sudo,node,artifact,startupClosureSha256,databaseContractSha256,databasePath,databaseDev,databaseIno');
    const {build,...artifact}=descriptor.artifact || {};
    validateLocalPreparedArtifact(artifact,build);
    validateLocalManifestHeader(target.manifest,{kind:LOCAL_BUILD_KIND,build});
    const identity=localBuildIdentitySha256(build);
    if (build.profileId!==PROFILE_ID || descriptor.profileId!==PROFILE_ID || !['local-forward-349/v1','local-forward-349/v2'].includes(PROFILE_ID) || !ROOT_ADMISSION_REQUIRED
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(descriptor.nodeInstanceId || '')
        || artifact.manifestSha256!==sha(target.bytes) || artifact.manifestSize!==target.bytes.length
        || descriptor.databaseContractSha256!==artifact.databaseContractSha256
        || artifact.databaseContractSha256!==sha(canonical(target.manifest.databaseContract))
        || descriptor.startupClosureSha256!==artifact.startupClosureSha256
        || artifact.startupClosureSha256!==target.manifest.databaseContract.startup?.closureSha256
        || identity!==target.manifest.databaseContract.releaseIdentitySha256
        || !path.isAbsolute(descriptor.databasePath || '') || fs.realpathSync(descriptor.databasePath)!==descriptor.databasePath
        || !/^(0|[1-9][0-9]{0,23})$/.test(descriptor.databaseDev) || !/^[1-9][0-9]{0,23}$/.test(descriptor.databaseIno)) throw Error('root_startup_local_descriptor_mismatch');
    return identity;
}
function verifyStartupMaterial(descriptor, manifest) {
    const material = JSON.parse(fs.readFileSync(path.join(releaseRoot(), 'dist-server/STARTUP_CLOSURE.json'), 'utf8'));
    requireKeys(material, 'schema,profileId,modePolicy,roots,files');
    if (material.schema !== 'nassaj-startup-closure/v1' || material.profileId !== PROFILE_ID
        || material.modePolicy !== 'release-file-mode-normalization/v1'
        || sha(canonical(material)) !== descriptor.startupClosureSha256
        || !Array.isArray(material.roots) || !Array.isArray(material.files)
        || material.roots.length === 0 || material.files.length === 0) throw Error('root_startup_material_mismatch');
    const records = new Map(manifest.files.map(record => [record.path, record]));
    let previous = '';
    for (const record of material.files) {
        requireKeys(record, 'path,size,mode,sha256');
        if (typeof record.path !== 'string' || record.path <= previous || canonical(records.get(record.path)) !== canonical(record)) throw Error('root_startup_material_file_mismatch');
        previous = record.path;
    }
    const files = new Set(material.files.map(record => record.path));
    previous = '';
    for (const root of material.roots) {
        if (typeof root !== 'string' || root <= previous || !files.has(root)) throw Error('root_startup_material_root_mismatch'); previous = root;
    }
    for (const file of ['dist-server/server/bootstrap.js', 'dist-server/server/bootstrap-release-profile.js', 'dist-server/server/bootstrap-startup-context.js']) {
        if (!files.has(file)) throw Error('root_startup_material_root_missing');
    }
}
function verifyInstalledFiles(manifest) {
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw Error('root_startup_closure_missing');
    const root = fs.realpathSync(releaseRoot()); const seen = new Set();
    for (const entry of manifest.files) {
        if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.split('/').some(part => !part || part === '..' || part === '.')
            || seen.has(entry.path) || !HEX.test(entry.sha256)) throw Error('root_startup_closure_invalid');
        seen.add(entry.path);
        const file = path.join(root, entry.path); const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(file) !== file || info.size !== entry.size
            || (info.mode & 0o777) !== entry.mode || sha(fs.readFileSync(file)) !== entry.sha256) throw Error('root_startup_closure_changed');
    }
}
function exchange(descriptor, request, deadline, deadlineReason = 'root_startup_pending_changed') {
    const timeout=deadline===undefined ? 10_000 : Math.min(10_000,Number((deadline-process.hrtime.bigint())/1_000_000n));
    if(timeout<=0) throw Error(deadlineReason);
    return new Promise((resolve, reject) => {
        const child = spawn(descriptor.sudo.path, ['-n', '--', descriptor.dispatcher.path, 'claimBootstrapStartup'], {
            stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        });
        let output = ''; let size = 0; let failed = false;
        const stop = (reason) => { if (failed) return; failed = true; child.kill('SIGKILL'); reject(Error(reason)); };
        const timer = setTimeout(() => stop('root_startup_claim_timeout'), timeout);
        child.stdout.on('data', chunk => { size += chunk.length; if (size > 65_536) stop('root_startup_claim_oversized'); else output += chunk; });
        child.stderr.on('data', chunk => { size += chunk.length; if (size > 65_536) stop('root_startup_claim_oversized'); });
        child.once('error', () => { clearTimeout(timer); stop('root_startup_claim_spawn_failed'); });
        child.stdin.on('error', () => stop('root_startup_claim_pipe_failed'));
        child.once('close', code => {
            clearTimeout(timer); if (failed) return;
            if (code !== 0) return reject(Error('root_startup_claim_denied'));
            try { resolve(JSON.parse(output)); } catch { reject(Error('root_startup_claim_invalid_response')); }
        });
        child.stdin.end(`${JSON.stringify(request)}\n`);
    });
}
function checkResponse(value, expected, kind) {
    const base = ['schema', 'decision', 'mode', 'authorityId', 'revision', 'generationEpoch', 'challenge', 'uid', 'pid', 'startTicks', 'bootId',
        'nodeInstanceId', 'generationId', 'releaseIdentitySha256', 'startupClosureSha256', 'databaseContractSha256',
        'databaseDev', 'databaseIno', 'startupPolicyId', 'startupAdmissionPolicy'];
    if(value?.mode==='cutover') base.push('initialTargetProcessSha256','startIntentSha256');
    const fields = kind === 'offer' ? [...base, 'offerId', 'offerNonce', 'expiresAtBootMs'] : [...base, 'claimId'];
    if (!value || Object.keys(value).sort().join(',') !== fields.sort().join(',')
        || value.schema !== (kind === 'security' ? 'nassaj-startup-security-admission-response/v1'
            : kind === 'serving' ? 'nassaj-startup-serving-confirmation-response/v1'
                : `nassaj-bootstrap-admission-${kind === 'offer' ? 'offer' : 'claim'}/v1`)
        || !(kind === 'offer' ? ['offered'] : kind === 'security' ? ['security_startup_authorized']
            : kind === 'serving' ? ['serving', 'pending'] : ['claimed']).includes(value.decision) || !['cutover', 'steady'].includes(value.mode)
        || (value.mode==='cutover' && (!HEX.test(value.initialTargetProcessSha256) || !HEX.test(value.startIntentSha256)))
        || value.startupPolicyId !== 'existing-security-state/v1' || value.startupAdmissionPolicy !== 'same-generation-auto-restart/v1'
        || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.generationEpoch)
        || ['uid', 'pid', 'startTicks', 'bootId', 'challenge', 'releaseIdentitySha256', 'startupClosureSha256'].some(key => value[key] !== expected[key])) {
        throw Error('root_startup_claim_binding_mismatch');
    }
}
/** @typedef {{database:{realpath:string,device:string,inode:string},databaseTarget:{schemaDigest:string,compatibilityShapeDigest:string,migrationStateDigest:string},startup:{policyId:string,closureSha256:string},releaseIdentitySha256:string,databaseContractSha256:string,transactionId:string,revision:number,phase:string,mode:string,serverBuildId:string,claimId:string,generationEpoch:number,nodeInstanceId:string,generationId:string,process:{uid:number,pid:number,startTicks:string,bootId:string}} StartupContext */
/** Return only the process-local context issued after the live, verified consume response. @returns {Readonly<StartupContext>|null} */
export function readVerifiedStartupContext() { return verifiedContext; }
function currentRecoveryClaimRecord(claim, requireAttempt = false) {
    const record = claim && typeof claim === 'object' ? startupRecoveryClaims.get(claim) : null;
    if (!record || record.released || (requireAttempt && !record.attempted)
        || verifiedContext !== record.context || verifiedContext?.phase !== 'security_startup_authorized'
        || !predecessorAbsenceProved || record.claimId !== verifiedContext.claimId
        || record.generationEpoch !== verifiedContext.generationEpoch
        || record.releaseIdentitySha256 !== verifiedContext.releaseIdentitySha256
        || record.databaseContractSha256 !== verifiedContext.databaseContractSha256
        || record.startupPolicyId !== verifiedContext.startup.policyId
        || record.startupClosureSha256 !== verifiedContext.startup.closureSha256
        || record.databaseRealpath !== verifiedContext.database.realpath
        || record.databaseDevice !== verifiedContext.database.device
        || record.databaseInode !== verifiedContext.database.inode
        || canonical(processBinding()) !== canonical(record.process)) return null;
    return record;
}
/** Mint the one boot-local E5 claim after governed security admission and before serving. */
export function mintEngineRestampStartupRecoveryClaim() {
    if (startupRecoveryClaimMinted || !predecessorAbsenceProved
        || verifiedContext?.phase !== 'security_startup_authorized') throw Error('engine_restamp_recovery_claim_unavailable');
    const currentProcess = processBinding();
    if (canonical(currentProcess) !== canonical(verifiedContext.process)) throw Error('engine_restamp_recovery_claim_stale');
    const claim = Object.freeze(Object.create(null));
    startupRecoveryClaims.set(claim, { context: verifiedContext, claimId: verifiedContext.claimId,
        generationEpoch: verifiedContext.generationEpoch, releaseIdentitySha256: verifiedContext.releaseIdentitySha256,
        databaseContractSha256: verifiedContext.databaseContractSha256,
        startupPolicyId: verifiedContext.startup.policyId,
        startupClosureSha256: verifiedContext.startup.closureSha256,
        databaseRealpath: verifiedContext.database.realpath,
        databaseDevice: verifiedContext.database.device, databaseInode: verifiedContext.database.inode,
        process: Object.freeze({ ...currentProcess }), attempted: false, released: false });
    startupRecoveryClaimMinted = true;
    return claim;
}
/** Start the sole recovery attempt; a failed attempt cannot be replayed in this process generation. */
export function beginEngineRestampStartupRecoveryAttempt(claim) {
    const record = currentRecoveryClaimRecord(claim);
    if (!record || record.attempted) throw Error('engine_restamp_recovery_attempt_unavailable');
    record.attempted = true;
}
/** Exact live-attempt predicate consumed by the recovery reservation registry. */
export function isEngineRestampStartupRecoveryAttemptCurrent(claim) {
    return currentRecoveryClaimRecord(claim, true) !== null;
}
/** Reject recovery of an intent created by this admitted process itself. */
export function isEngineRestampStartupRecoveryPredecessorIntent(claim, ownerProcess) {
    const record = currentRecoveryClaimRecord(claim, true);
    if (!record || !ownerProcess || typeof ownerProcess !== 'object') return false;
    return canonical(ownerProcess) !== canonical(record.process);
}
/** Permanently revoke the claim after attempt completion or mandatory cleanup. */
export function releaseEngineRestampStartupRecoveryClaim(claim) {
    const record = claim && typeof claim === 'object' ? startupRecoveryClaims.get(claim) : null;
    if (!record || record.released) return false;
    record.released = true;
    return true;
}
/** Require the mandatory forward admission; ordinary v1 retains its existing bootstrap. @returns {Readonly<StartupContext>|null} */
export function requireStartupAdmission() {
    if (!ROOT_ADMISSION_REQUIRED && !targetManifest()) return null;
    if (!verifiedContext) throw Error('root_startup_admission_required');
    return verifiedContext;
}
/** Prevent legacy transition effects in a forward target, including before a claim exists. */
export function assertLegacyTransitionAllowed() {
    if (ROOT_ADMISSION_REQUIRED || targetManifest()) throw Error('root_governed_activation_required');
}
/** Validate initial wait metadata only; this pure check never issues startup authority. */
export function validateInitialStartupPendingResponse(offer, expected, previous=null) {
    const keys=['schema','decision','reason','authorityId','transactionId','generationEpoch','issuedAtBootMs',
        'expiresAtBootMs','retryAfterMs','remainingMs',...Object.keys(expected)];
    if(!offer || Object.keys(offer).sort().join(',')!==keys.sort().join(',') || offer.decision!=='pending'
        || offer.schema!=='nassaj-bootstrap-admission-pending/v1' || offer.reason!=='initial_process_not_armed'
        || typeof offer.transactionId!=='string' || offer.transactionId.length<1 || offer.transactionId.length>128
        || offer.authorityId!==offer.transactionId || !Number.isSafeInteger(offer.generationEpoch) || offer.generationEpoch<1
        || !Number.isSafeInteger(offer.issuedAtBootMs) || offer.issuedAtBootMs<0 || !Number.isSafeInteger(offer.expiresAtBootMs)
        || offer.expiresAtBootMs-offer.issuedAtBootMs!==30_000 || offer.retryAfterMs!==100
        || !Number.isSafeInteger(offer.remainingMs) || offer.remainingMs<=0 || offer.remainingMs>30_000
        || Object.entries(expected).some(([key,value])=>offer[key]!==value)) throw Error('root_startup_pending_invalid');
    const fixed={transactionId:offer.transactionId,generationEpoch:offer.generationEpoch,
        issuedAtBootMs:offer.issuedAtBootMs,expiresAtBootMs:offer.expiresAtBootMs};
    if(previous && canonical(fixed)!==canonical(previous)) throw Error('root_startup_pending_changed');
    return Object.freeze(fixed);
}
/** Establish authority through the fixed root endpoint; no caller can supply or mint a trusted context. */
export async function establishStartupAdmission() {
    const target = targetManifest(); if (!target) return null;
    if (admissionAttempted) throw Error('root_startup_admission_already_attempted'); admissionAttempted = true;
    const descriptor = pinnedDescriptor(target); verifyInstalledFiles(target.manifest); verifyStartupMaterial(descriptor, target.manifest);
    const caller = processBinding(); const challenge = randomBytes(32).toString('hex');
    let expected = { ...caller, challenge, releaseIdentitySha256: descriptor.releaseIdentitySha256, startupClosureSha256: descriptor.startupClosureSha256 };
    let { uid: _uid, ...wire } = expected;
    let deadline = process.hrtime.bigint() + 30_000_000_000n; let pendingIdentity; let initialPendingBinding; let offer;
    while (true) {
        offer = await exchange(descriptor, { schema: 'nassaj-bootstrap-admission-offer-request/v1', ...wire },deadline);
        if (offer?.schema !== 'nassaj-bootstrap-admission-pending/v1') break;
        let identity;
        if(offer.reason==='initial_process_not_armed') {
            const fixed=validateInitialStartupPendingResponse(offer,expected,initialPendingBinding);
            const bootMs=Math.floor(Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0])*1000);
            const remaining=Math.min(offer.remainingMs,offer.expiresAtBootMs-bootMs);
            if(!Number.isSafeInteger(bootMs) || remaining<=0) throw Error('root_startup_pending_changed');
            if(!initialPendingBinding) deadline=[deadline,process.hrtime.bigint()+BigInt(remaining)*1_000_000n].reduce((a,b)=>a<b?a:b);
            initialPendingBinding=fixed;
            identity=`initial:${offer.transactionId}:${offer.generationEpoch}`;
        } else {
        const keys = ['schema','decision','operationId','generationEpoch',...Object.keys(expected)];
        if (Object.keys(offer).sort().join(',') !== keys.sort().join(',') || offer.decision !== 'pending'
            || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(offer.operationId || '')
            || !Number.isSafeInteger(offer.generationEpoch) || offer.generationEpoch < 1
            || Object.entries(expected).some(([key,value])=>offer[key]!==value)) throw Error('root_startup_pending_invalid');
        identity = `${offer.operationId}:${offer.generationEpoch}`;
        }
        if ((pendingIdentity && identity !== pendingIdentity) || process.hrtime.bigint() >= deadline
            || canonical(processBinding()) !== canonical(caller)
            || sha(readRootFile(PUBLIC_DESCRIPTOR)) !== descriptor.descriptorSha256) throw Error('root_startup_pending_changed');
        pendingIdentity = identity; await delay(Math.max(1,Math.min(100,Number((deadline-process.hrtime.bigint())/1_000_000n))));
        expected = { ...expected, challenge: randomBytes(32).toString('hex') }; ({ uid: _uid, ...wire } = expected);
    }
    checkResponse(offer, expected, 'offer');
    if (pendingIdentity && (offer.generationEpoch !== Number(pendingIdentity.split(':').at(-1))
        || process.hrtime.bigint() >= deadline)) throw Error('root_startup_pending_changed');
    if(pendingIdentity && !initialPendingBinding && offer.mode!=='steady') throw Error('root_startup_pending_changed');
    if(initialPendingBinding && (offer.mode!=='cutover' || offer.authorityId!==initialPendingBinding.transactionId
        || offer.expiresAtBootMs>initialPendingBinding.expiresAtBootMs)) throw Error('root_startup_pending_changed');
    if (sha(readRootFile(PUBLIC_DESCRIPTOR)) !== descriptor.descriptorSha256) throw Error('root_startup_descriptor_rotated');
    const claim = await exchange(descriptor, { schema: 'nassaj-bootstrap-admission-consume-request/v1', ...wire,
        offerId: offer.offerId, offerNonce: offer.offerNonce, expectedRevision: offer.revision, generationEpoch: offer.generationEpoch },deadline);
    checkResponse(claim, expected, 'claim');
    if(initialPendingBinding && process.hrtime.bigint()>=deadline) throw Error('root_startup_pending_changed');
    if(claim.mode==='cutover' && ['initialTargetProcessSha256','startIntentSha256'].some(key=>claim[key]!==offer[key])) throw Error('root_startup_claim_changed');
    if (claim.mode !== offer.mode || claim.authorityId !== offer.authorityId || claim.revision !== offer.revision + 1
        || claim.generationEpoch !== offer.generationEpoch || claim.nodeInstanceId !== descriptor.nodeInstanceId
        || claim.generationId !== descriptor.release.generationId || claim.databaseDev !== descriptor.databaseDev || claim.databaseIno !== descriptor.databaseIno
        || claim.databaseContractSha256 !== descriptor.databaseContractSha256
        || canonical(processBinding()) !== canonical(caller)) throw Error('root_startup_claim_changed');
    const database = fs.realpathSync(descriptor.databasePath); const info = fs.lstatSync(database, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || String(info.dev) !== claim.databaseDev || String(info.ino) !== claim.databaseIno) throw Error('root_startup_database_mismatch');
    claimedState = { descriptor, claim, caller };
    verifiedContext = Object.freeze({ database: Object.freeze({ realpath: database, device: claim.databaseDev, inode: claim.databaseIno }),
        databaseTarget: Object.freeze({ ...target.manifest.databaseContract.target }),
        startup: Object.freeze({ policyId: claim.startupPolicyId, closureSha256: claim.startupClosureSha256 }),
        releaseIdentitySha256: claim.releaseIdentitySha256, databaseContractSha256: claim.databaseContractSha256,
        transactionId: claim.authorityId, revision: claim.revision, phase: 'claimed', mode: claim.mode, serverBuildId: target.manifest.build?.serverBuildId ?? target.manifest.serverBuildId, claimId: claim.claimId,
        generationEpoch: claim.generationEpoch, nodeInstanceId: claim.nodeInstanceId, generationId: claim.generationId, process: Object.freeze({ ...caller }) });
    predecessorAbsenceProved = true;
    return verifiedContext;
}


async function exchangeStartupPhase(kind, deadline) {
    const current = claimedState;
    if (!current || !verifiedContext || canonical(processBinding()) !== canonical(current.caller)) throw Error('root_startup_admission_required');
    const { descriptor, claim, caller } = current;
    if (sha(readRootFile(PUBLIC_DESCRIPTOR)) !== descriptor.descriptorSha256) throw Error('root_startup_descriptor_rotated');
    const challenge = randomBytes(32).toString('hex');
    const { uid: _uid, ...binding } = caller;
    const request = { schema: kind === 'security' ? 'nassaj-startup-security-admission-request/v1' : 'nassaj-startup-serving-confirmation-request/v1',
        ...binding, challenge, claimId: claim.claimId, generationEpoch: claim.generationEpoch,
        releaseIdentitySha256: claim.releaseIdentitySha256, startupClosureSha256: claim.startupClosureSha256,
        databaseContractSha256: claim.databaseContractSha256 };
    const result = await exchange(descriptor, request, deadline,
        kind === 'serving' ? 'root_startup_serving_timeout' : 'root_startup_pending_changed');
    if (kind === 'serving' && result?.schema === 'nassaj-startup-serving-busy/v1') {
        const expected = { ...request, schema: 'nassaj-startup-serving-busy/v1', decision: 'busy',
            reason: 'state_lock_contended', retryAfterMs: 100 };
        if (canonical(result) !== canonical(expected) || canonical(processBinding()) !== canonical(caller))
            throw Error('root_startup_serving_busy_binding_mismatch');
        return result;
    }
    checkResponse(result, { ...request, uid: caller.uid }, kind);
    if(claim.mode==='cutover' && ['initialTargetProcessSha256','startIntentSha256'].some(key=>result[key]!==claim[key])) throw Error('root_startup_phase_binding_mismatch');
    if (result.claimId !== claim.claimId || result.authorityId !== claim.authorityId || result.mode !== claim.mode
        || result.generationEpoch !== claim.generationEpoch || result.revision < verifiedContext.revision
        || result.nodeInstanceId !== descriptor.nodeInstanceId || result.generationId !== descriptor.release.generationId
        || result.databaseContractSha256 !== descriptor.databaseContractSha256
        || result.databaseDev !== descriptor.databaseDev || result.databaseIno !== descriptor.databaseIno
        || canonical(processBinding()) !== canonical(caller)) throw Error('root_startup_phase_binding_mismatch');
    return result;
}
/** Admit only the reviewed security startup phase after the pre-import existing-state inspectors. */
export async function admitSecurityStartup() {
    if (!targetManifest()) return null;
    if (verifiedContext?.phase !== 'claimed') throw Error('root_startup_security_phase_invalid');
    const response = await exchangeStartupPhase('security');
    verifiedContext = Object.freeze({ ...verifiedContext, revision: response.revision, phase: 'security_startup_authorized' });
    return verifiedContext;
}
/** Wait outside root locks for terminal serving authority; failure leaves all general admission closed. */
export async function confirmStartupServing() {
    if (!targetManifest()) return null;
    if (verifiedContext?.phase !== 'security_startup_authorized') throw Error('root_startup_serving_phase_invalid');
    const deadline = process.hrtime.bigint() + 90_000_000_000n; let wait = 100;
    while (process.hrtime.bigint() < deadline) {
        const response = await exchangeStartupPhase('serving', deadline);
        if (process.hrtime.bigint() >= deadline) break;
        if (response.decision === 'serving') {
            verifiedContext = Object.freeze({ ...verifiedContext, revision: response.revision, phase: 'serving' });
            return verifiedContext;
        }
        const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
        if (remaining <= 0) break;
        await delay(Math.min(wait, remaining));
        wait = Math.min(wait * 2, 1_000);
    }
    throw Error('root_startup_serving_timeout');
}
