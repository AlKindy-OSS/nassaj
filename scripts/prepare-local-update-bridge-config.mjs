#!/usr/bin/env node
/** One-time local bridge configuration. Never starts a process or grants update authority. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const BINDING_KEYS = 'schema,id,nodeIdentity,approvalReference,reservationReference,oldLoadedBuildId,oldCapsuleSha256,oldSafeRestartSha256,serverBuildId,clientBuildId,controlManifestSha256,rehearsalReportSha256,sourceOid,actionId,expectedServerBuildId'.split(',').sort().join(',');
const META = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`bridge_config_${code}`); };
const pin = stat => Object.fromEntries(META.map(key => [key, stat[key]]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function directory(root) {
    if (!path.isAbsolute(root) || fs.realpathSync(root) !== root) fail('directory_path');
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022) fail('directory_unsafe');
    return pin(stat);
}

function readPinned(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid()
            || before.mode & 0o022 || before.size > 1024 * 1024) fail('file_unsafe');
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        if (!equal(pin(before), pin(after)) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || !equal(pin(after), pin(fs.lstatSync(file)))) fail('file_changed');
        return { bytes, identity: { ...pin(after), sha256: sha(bytes) } };
    } finally { fs.closeSync(fd); }
}

function syncDirectory(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeExclusive(file, bytes, mode = 0o600, gid = process.getgid()) {
    const fd = fs.openSync(file, 'wx', mode);
    try { fs.fchownSync(fd, process.getuid(), gid); fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(file));
}

function saveReceipt(ctx, value) {
    const next = path.join(ctx.work, `receipt-${randomUUID()}.tmp`);
    writeExclusive(next, `${JSON.stringify(value)}\n`);
    fs.renameSync(next, ctx.receipt);
    syncDirectory(ctx.work);
    return value;
}

function context(root, id, create = false) {
    directory(root);
    if (!ID.test(id || '')) fail('id_invalid');
    const base = path.join(root, '.nassaj-local-preview');
    const control = path.join(base, 'bridge-config');
    for (const folder of [base, control]) {
        if (create && !fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 });
        directory(folder);
    }
    const work = path.join(control, id);
    if (create) { fs.mkdirSync(work, { mode: 0o700 }); syncDirectory(control); }
    directory(work);
    return { root, control, work, env: path.join(root, '.env'), receipt: path.join(work, 'receipt.json'),
        backup: path.join(work, 'original.env'), swap: path.join(work, 'exchange.env') };
}

function withConfigLock(ctx, effect, create = false) {
    const file = path.join(ctx.control, 'config.lock');
    const fd = fs.openSync(file, (create ? fs.constants.O_CREAT : 0) | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) fail('lock_unsafe');
        const held = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
        if (held.status !== 0) fail('lock_busy');
        return effect(); // The parent retains the same open file description and therefore its flock.
    } finally { fs.closeSync(fd); }
}

function proposedBytes(bytes) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || text.includes('\0')) fail('env_encoding');
    for (const line of text.split(/\r?\n/)) {
        if (!/^\s*(?:#|$)/.test(line) && /\bNASSAJ_UPDATE_MODE\b/.test(line)) fail('mode_already_present_or_malformed');
    }
    return Buffer.concat([bytes, Buffer.from(`${text.endsWith('\n') || !text ? '' : '\n'}NASSAJ_UPDATE_MODE=local-main\n`)]);
}

function validateBinding(input) {
    if (!input || Object.keys(input).sort().join(',') !== BINDING_KEYS
        || input.schema !== 'nassaj-local-bridge-config-request/v1' || !ID.test(input.id || '')
        || !ID.test(input.nodeIdentity || '') || !REFERENCE.test(input.approvalReference || '')
        || !REFERENCE.test(input.reservationReference || '')) fail('request_invalid');
    for (const key of ['oldLoadedBuildId', 'oldCapsuleSha256', 'oldSafeRestartSha256', 'serverBuildId',
        'clientBuildId', 'controlManifestSha256', 'rehearsalReportSha256']) if (!HASH.test(input[key] || '')) fail('binding_invalid');
    if (!/^[a-f0-9]{40}$/.test(input.sourceOid || '') || !ID.test(input.actionId || '')
        || input.expectedServerBuildId !== input.serverBuildId) fail('target_invalid');
}

function receipt(ctx) {
    const parsed = JSON.parse(readPinned(ctx.receipt).bytes);
    validateBinding(parsed.binding);
    if (parsed.schema !== 'nassaj-local-bridge-config/v1' || parsed.binding.id !== path.basename(ctx.work)
        || parsed.root !== ctx.root || !equal(parsed.parent, directory(ctx.root))) fail('receipt_identity');
    if (readPinned(ctx.backup).identity.sha256 !== parsed.original.sha256) fail('backup_changed');
    return parsed;
}

function placement(ctx, record) {
    const live = readPinned(ctx.env).identity, swap = readPinned(ctx.swap).identity;
    if (equal(live, record.original) && equal(swap, record.proposal)) return 'original';
    if (equal(live, record.proposal) && equal(swap, record.original)) return 'configured';
    return 'conflict';
}

function validateObservation(record, observation, operation) {
    const now = Date.now();
    const keys = ['schema', 'root', 'id', 'bindingSha256', 'observedAt', 'reservationReference',
        'configWritersReserved', 'publishersQuiescent', 'noCompetingActivation',
        ...(operation === 'apply' ? ['oldEffectiveModeAbsent', 'pm2SavedModeAbsent'] : ['noPendingRuntimeStart'])];
    if (!observation || Object.keys(observation).sort().join(',') !== keys.sort().join(',') || observation.schema !== 'nassaj-local-bridge-config-observation/v1'
        || observation.root !== record.root || observation.id !== record.binding.id
        || observation.bindingSha256 !== sha(Buffer.from(JSON.stringify(record.binding)))
        || !Number.isSafeInteger(observation.observedAt) || observation.observedAt > now || now - observation.observedAt > 30000
        || observation.reservationReference !== record.binding.reservationReference
        || observation.configWritersReserved !== true || observation.publishersQuiescent !== true
        || observation.noCompetingActivation !== true) fail('fresh_operational_observation_required');
    if (operation === 'apply' && (observation.oldEffectiveModeAbsent !== true || observation.pm2SavedModeAbsent !== true)) fail('effective_mode_conflict');
    if (operation === 'restore' && observation.noPendingRuntimeStart !== true) fail('restore_runtime_state_unproven');
}

function publicReport(record, physicalState) {
    return { schema: record.schema, id: record.binding.id, state: record.state, physicalState,
        binding: record.binding, bindingSha256: sha(Buffer.from(JSON.stringify(record.binding))),
        originalSha256: record.original.sha256, proposalSha256: record.proposal.sha256 };
}

/** Prepare private bytes and a pinned receipt; this operation never writes .env. */
export function prepareBridgeConfig(root, input) {
    validateBinding(input);
    const ctx = context(root, input.id, true);
    return withConfigLock(ctx, () => {
        const parent = directory(root), original = readPinned(ctx.env), proposal = proposedBytes(original.bytes);
        writeExclusive(ctx.backup, original.bytes);
        writeExclusive(ctx.swap, proposal, original.identity.mode & 0o777, original.identity.gid);
        if (!equal(original.identity, readPinned(ctx.env).identity) || !equal(parent, directory(root))) fail('preparation_drift');
        const record = saveReceipt(ctx, { schema: 'nassaj-local-bridge-config/v1', root, parent, binding: input,
            original: original.identity, proposal: readPinned(ctx.swap).identity, state: 'prepared', createdAt: Date.now() });
        return publicReport(record, 'original');
    }, true);
}

/** Read and reconcile placement without changing files or authorizing the action. */
export function checkBridgeConfig(root, id) {
    const ctx = context(root, id);
    return withConfigLock(ctx, () => { const record = receipt(ctx); return publicReport(record, placement(ctx, record)); });
}

function exchangeFiles(ctx) {
    const result = spawnSync('/usr/bin/mv', ['--exchange', '--no-copy', '-T', ctx.env, ctx.swap], { stdio: 'ignore' });
    if (result.status !== 0) fail('atomic_exchange_failed');
    syncDirectory(ctx.root); syncDirectory(ctx.work);
}

function changeConfig(root, id, observation, direction, injected) {
    const ctx = context(root, id);
    return withConfigLock(ctx, () => {
        let record = receipt(ctx);
        validateObservation(record, observation, direction);
        const desired = direction === 'apply' ? 'configured' : 'original';
        const current = placement(ctx, record);
        if (current === 'conflict') fail('manual_recovery_conflict');
        if (current !== desired) {
            record = saveReceipt(ctx, { ...record, state: `${direction}_intent`, observation });
            exchangeFiles(ctx); injected?.afterExchange?.();
            if (placement(ctx, record) !== desired) fail('manual_recovery_conflict');
        }
        record = saveReceipt(ctx, { ...record, state: direction === 'apply' ? 'configured' : 'restored', updatedAt: Date.now() });
        return publicReport(record, desired);
    });
}

/** Apply only the pinned MODE addition under cooperative config ownership; never restarts. */
export function applyBridgeConfig(root, id, observation, injected) {
    return changeConfig(root, id, observation, 'apply', injected);
}

/** Restore the original inode/bytes only while the pinned proposed inode is still current. */
export function restoreBridgeConfig(root, id, observation, injected) {
    return changeConfig(root, id, observation, 'restore', injected);
}

function main() {
    const [operation, root, idOrRequest, observationFile] = process.argv.slice(2);
    let result;
    if (operation === 'prepare') result = prepareBridgeConfig(root, JSON.parse(readPinned(idOrRequest).bytes));
    else if (operation === 'check') result = checkBridgeConfig(root, idOrRequest);
    else if (['apply', 'restore'].includes(operation)) {
        const observation = JSON.parse(readPinned(observationFile).bytes);
        result = (operation === 'apply' ? applyBridgeConfig : restoreBridgeConfig)(root, idOrRequest, observation);
    } else fail('operation_invalid');
    console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) { console.error(error.message.startsWith('bridge_config_') ? error.message : 'bridge_config_operation_failed'); process.exitCode = 1; }
}
