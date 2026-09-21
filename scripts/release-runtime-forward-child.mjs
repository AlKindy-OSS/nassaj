#!/usr/bin/env node
/** Fixed direct child: root verifies immutable inputs, drops privilege, then awaits a one-use parent permit. */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledHostConfiguration } from './lib/release-runtime-installed-config.mjs';
import { assertForwardFrameKeys, assertForwardServiceIdentity, canonicalForwardValue, dropForwardChildPrivileges,
    forwardValueSha256, inspectForwardChildIdentity, readForwardPermitFrame } from './lib/release-runtime-forward-child-protocol.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
function requireValue(ok, reason) { if (!ok) throw Error(`forward_child_${reason}`); }
function rootBytes(file, privateFile = false) {
    requireValue(path.isAbsolute(file || '') && fs.realpathSync(file) === file, 'path_unsafe');
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
        const info = fs.lstatSync(directory);
        requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022), 'ancestor_unsafe');
        if (directory === path.dirname(directory)) break;
    }
    const before = fs.lstatSync(file);
    requireValue(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && !(before.mode & 0o022)
        && (!privateFile || (before.mode & 0o777) === 0o600) && before.size > 0 && before.size <= 256 * 1024 * 1024, 'file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const opened = fs.fstatSync(fd); requireValue(['dev', 'ino', 'mode', 'uid', 'size'].every(key => before[key] === opened[key]), 'file_changed');
        return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
function pinned(record, privateFile = false) {
    assertForwardFrameKeys(record, 'path,sha256'); requireValue(HEX.test(record.sha256), 'pin_invalid');
    const bytes = rootBytes(record.path, privateFile); requireValue(sha(bytes) === record.sha256, 'pin_mismatch'); return bytes;
}
/** Verify private inputs before dropping; returned material contains no root key or full configuration. */
/** Verify bytes in the root-pinned executable closure without importing them. */
export function readPinnedForwardBytes(record) { return pinned(record); }

/** Read a root-private JSON input from the independently pinned operator configuration. */
export function readPinnedForwardRecord(record) { return JSON.parse(pinned(record, true)); }

export function readForwardChildMaterial(purpose = 'migration') {
    requireValue(['migration', 'observe-target'].includes(purpose), 'purpose_invalid');
    requireValue(process.geteuid?.() === 0, 'root_invocation_required');
    const config = readInstalledHostConfiguration().value;
    const settings = config.forwardMigration;
    requireValue(config.schema === 'nassaj-release-runtime-host-config/v1' && settings, 'configuration_missing');
    pinned(settings.node); pinned(settings.wrapper);
    requireValue(settings.node.path === fs.realpathSync(process.execPath) && settings.wrapper.path === fs.realpathSync(fileURLToPath(import.meta.url)), 'executable_mismatch');
    const closure = JSON.parse(pinned(settings.closure));
    assertForwardFrameKeys(closure, 'schema,files'); requireValue(closure.schema === 'nassaj-forward-child-closure/v1' && Array.isArray(closure.files), 'closure_invalid');
    let previous = ''; const files = new Set();
    for (const item of closure.files) { requireValue(typeof item.path === 'string' && item.path > previous, 'closure_order_invalid'); pinned(item); previous = item.path; files.add(item.path); }
    requireValue(files.has(settings.entry.path) && files.has(settings.wrapper.path)
        && files.has(fileURLToPath(new URL('./lib/release-runtime-forward-child-protocol.mjs', import.meta.url))), 'closure_incomplete');
    const fixedEntry = fileURLToPath(new URL('../dist-server/server/scripts/release-database-migration.js', import.meta.url));
    requireValue(path.basename(path.dirname(fileURLToPath(import.meta.url))) === 'scripts'
        && path.basename(path.dirname(path.dirname(fileURLToPath(import.meta.url)))) !== 'dist-server'
        && settings.entry.path === fixedEntry && fs.realpathSync(fixedEntry) === fixedEntry, 'entry_placement_invalid');
    pinned(settings.entry);
    const request = JSON.parse(pinned(settings.request, true)); const contract = JSON.parse(pinned(settings.contract, true));
    const journal = JSON.parse(rootBytes(path.join(config.controlRoot, 'first-cutover.json'), true));
    const intent = journal.forwardMigrationIntent;
    requireValue(journal.state === 'running' && journal.phase === (purpose === 'migration' ? 'migration_intent' : 'migration_observed') && intent?.schema === 'nassaj-forward-migration-intent/v1'
        && intent.transactionId === journal.transactionId && request.transactionId === journal.transactionId
        && intent.requestSha256 === forwardValueSha256(request) && intent.databaseContractSha256 === forwardValueSha256(contract)
        && intent.rootExecutableClosureSha256 === sha(rootBytes(settings.closure.path))
        && intent.migrationClosureSha256 === contract.migrationClosureSha256
        && request.databaseContractSha256 === intent.databaseContractSha256 && request.releaseIdentitySha256 === config.expected.releaseIdentitySha256
        && contract.releaseIdentitySha256 === request.releaseIdentitySha256 && HEX.test(intent.attemptNonce)
        && HEX.test(intent.retirementReceiptSha256), 'intent_mismatch');
    const lease = journal.forwardObservationReconciliation;
    const reconcile = purpose === 'observe-target' && lease && ['prepared', 'child_authorized'].includes(lease.state);
    const observation = reconcile ? { ...lease, attemptNonce: lease.nonce, transactionId: lease.operationId } : journal.forwardObservationIntent;
    if (purpose === 'observe-target') requireValue(observation?.schema === (reconcile ? 'nassaj-forward-observation-reconciliation/v1' : 'nassaj-forward-target-observation-intent/v1')
        && observation.transactionId === journal.transactionId && HEX.test(observation.attemptNonce)
        && observation.migrationResultSha256 === forwardValueSha256(journal.forwardMigrationResult)
        && observation.originalIntentSha256 === forwardValueSha256(intent), 'observation_intent_mismatch');
    // All reads above close their own FDs; only fixed pipe descriptors 3/4 are the execution authority channel.
    const observationAuthority = reconcile ? { purpose: 'observe-target', authority: 'reconcile-observation', nonce: lease.nonce,
        owner: lease.owner, abandonedLockSha256: lease.abandonedLockSha256, originalIntentSha256: lease.originalIntentSha256,
        migrationResultSha256: lease.migrationResultSha256, expectedTargetSha256: lease.expectedTargetSha256,
        expiresAtBootMs: lease.expiresAtBootMs } : null;
    return { purpose, observationAuthority, configurationSha256: forwardValueSha256(config), controlRoot: config.controlRoot, node: settings.node.path, wrapper: settings.wrapper.path,
        request, contract, entry: settings.entry.path, serviceIdentity: settings.serviceIdentity,
        transactionId: journal.transactionId, attemptNonce: purpose === 'migration' ? intent.attemptNonce : observation.attemptNonce, originalIntentSha256: forwardValueSha256(intent),
        requestSha256: intent.requestSha256, migrationClosureSha256: intent.migrationClosureSha256,
        databaseContractSha256: intent.databaseContractSha256 };
}
function assertObservationWindow(material, parentPid) {
    const authority = material.observationAuthority; if (!authority) return;
    const parent = inspectForwardChildIdentity(parentPid);
    const now = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000);
    requireValue(material.purpose === 'observe-target' && authority.purpose === material.purpose
        && authority.authority === 'reconcile-observation' && authority.nonce === material.attemptNonce
        && parent.pid === authority.owner.pid && parent.startTicks === authority.owner.startTicks
        && parent.bootId === authority.owner.bootId && parent.uids.every(uid => uid === 0)
        && Number.isSafeInteger(authority.expiresAtBootMs) && now < authority.expiresAtBootMs, 'observation_authority_expired');
}
/** Execute one permit only. Production has no caller-supplied path, FD number or verifier. */
export async function runForwardChild() {
    const purpose = process.argv.length === 3 && process.argv[2] === '--observe-target' ? 'observe-target' : 'migration';
    requireValue(process.argv.length === (purpose === 'migration' ? 2 : 3), 'invocation_invalid');
    const material = readForwardChildMaterial(purpose); const parentPid = process.ppid;
    const identity = dropForwardChildPrivileges(material.serviceIdentity);
    const ready = { schema: purpose === 'migration' ? 'nassaj-forward-child-ready/v1' : 'nassaj-forward-observation-ready/v1', transactionId: material.transactionId, attemptNonce: material.attemptNonce,
        challenge: randomBytes(32).toString('hex'), pid: identity.pid, startTicks: identity.startTicks, bootId: identity.bootId,
        uid: material.serviceIdentity.uid, gid: material.serviceIdentity.gid, supplementaryGids: material.serviceIdentity.supplementaryGids,
        requestSha256: material.requestSha256, migrationClosureSha256: material.migrationClosureSha256,
        ...(purpose === 'observe-target' ? { observationAuthority: material.observationAuthority } : {}) };
    const reply = fs.createWriteStream(null, { fd: 4, autoClose: true });
    const input = fs.createReadStream(null, { fd: 3, autoClose: true });
    try {
        reply.write(`${JSON.stringify(ready)}\n`);
        const permit = await readForwardPermitFrame(input);
        assertForwardFrameKeys(permit, 'schema,decision,transactionId,attemptNonce,revision,challenge,pid,startTicks,bootId,uid,gid,supplementaryGids,requestSha256,migrationClosureSha256,databaseContractSha256,originalIntentSha256,resumeOriginalIntent' + (purpose === 'observe-target' ? ',observationAuthority' : ''));
        requireValue(permit.schema === (purpose === 'migration' ? 'nassaj-forward-child-permit/v1' : 'nassaj-forward-observation-permit/v1') && permit.decision === 'authorized'
            && Object.keys(ready).filter(key => key !== 'schema').every(key => canonicalForwardValue(ready[key]) === canonicalForwardValue(permit[key]))
            && permit.databaseContractSha256 === material.databaseContractSha256 && permit.originalIntentSha256 === material.originalIntentSha256
            && Number.isSafeInteger(permit.revision) && permit.revision > 0 && typeof permit.resumeOriginalIntent === 'boolean'
            && process.ppid === parentPid && parentPid > 1, 'permit_mismatch');
        assertForwardServiceIdentity(inspectForwardChildIdentity(process.pid), material.serviceIdentity);
        assertObservationWindow(material, parentPid);
        const { runCompatibleForwardMigration, readCompatibleForwardTarget } = await import('../dist-server/server/scripts/release-database-migration.js');
        assertObservationWindow(material, parentPid);
        const result = (purpose === 'migration' ? runCompatibleForwardMigration : readCompatibleForwardTarget)(material.request, () => ({ contract: material.contract, requestSha256: material.requestSha256,
            ...(permit.resumeOriginalIntent ? { priorAcceptedIntent: { requestSha256: material.requestSha256,
                transactionId: material.transactionId, databaseContractSha256: material.databaseContractSha256 } } : {}) }));
        const output = { schema: purpose === 'migration' ? 'nassaj-forward-child-result/v1' : 'nassaj-forward-observation-result/v1', transactionId: material.transactionId, attemptNonce: material.attemptNonce,
            challenge: ready.challenge, pid: ready.pid, startTicks: ready.startTicks, bootId: ready.bootId, requestSha256: material.requestSha256,
            ...(purpose === 'observe-target' ? { observationAuthority: material.observationAuthority } : {}), result };
        const bytes = `${JSON.stringify(output)}\n`; requireValue(Buffer.byteLength(bytes) <= 16_384, 'result_large');
        await new Promise((resolve, reject) => { reply.once('error', reject); reply.end(bytes, resolve); });
    } finally { input.destroy(); reply.destroy(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runForwardChild().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 78; });
}
