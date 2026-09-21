/** Crash-auditable release-layout seal, activation and rollback primitives. */
import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
    readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PERMISSION_RELEASE_FIELDS, validatePermissionReleaseContract } from './permission-release-contract.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTION_SCHEMA = 'nassaj-release-layout-activation/v2';
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

function durableExclusiveJson(file, value) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, file); } finally { unlinkSync(temporary); }
    syncDirectory(path.dirname(file));
}

function requireFence(context) {
    if (typeof context?.assertFence !== 'function' || typeof context?.checkpoint !== 'function') {
        throw new Error('Release activation requires worker fencing and durable checkpoints.');
    }
}

function normalizeIdentity(value) {
    if (!value || value.strategy !== 'release-layout-v2' || value.updaterProtocol !== 2
        || !SAFE_ID.test(value.jobId || '') || !SAFE_ID.test(value.generationId || '')
        || !SAFE_ID.test(value.tag || '') || !SHA40.test(value.commit || '')
        || !SHA256.test(value.assetSha256 || '') || !SHA256.test(value.archiveSha256 || '')
        || !SHA256.test(value.sourceTreeSha256 || '') || !SHA256.test(value.bundleBuildId || '')
        || !SHA256.test(value.bundleManifestSha256 || '') || !SHA256.test(value.serverBuildId || '')
        || !SHA256.test(value.clientBuildId || '') || !Number.isSafeInteger(value.releaseId)
        || !Number.isSafeInteger(value.assetId) || !Number.isSafeInteger(value.assetSize)
        || typeof value.repository !== 'string' || typeof value.version !== 'string' || typeof value.assetName !== 'string') {
        throw new Error('Release activation identity is invalid.');
    }
    const permissionContract = validatePermissionReleaseContract(value);
    return Object.freeze({
        repository: value.repository, releaseId: value.releaseId, tag: value.tag, version: value.version,
        commit: value.commit, assetId: value.assetId, assetName: value.assetName, assetSize: value.assetSize,
        assetSha256: value.assetSha256, archiveSha256: value.archiveSha256, sourceTreeSha256: value.sourceTreeSha256,
        updaterProtocol: 2, bundleBuildId: value.bundleBuildId, bundleManifestSha256: value.bundleManifestSha256,
        serverBuildId: value.serverBuildId, clientBuildId: value.clientBuildId,
        ...(permissionContract ? Object.fromEntries(PERMISSION_RELEASE_FIELDS.map((field) => [field, value[field]])) : {}),
        strategy: 'release-layout-v2', jobId: value.jobId, generationId: value.generationId,
    });
}

function readJson(file) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Unsafe release control file: ${path.basename(file)}`);
    return JSON.parse(readFileSync(file, 'utf8'));
}

export function validateReleaseActivationAction(action) {
    const identity = normalizeIdentity(action);
    const { activationIdentitySha256, ...base } = action;
    if (action.schema !== ACTION_SCHEMA || activationIdentitySha256 !== sha(canonical(base))) {
        throw new Error('Release activation action identity mismatch.');
    }
    return { identity, action };
}

export function readReleaseActivationAction({ layout, jobId }) {
    if (!SAFE_ID.test(jobId || '')) throw new Error('Release activation job id is invalid.');
    const result = validateReleaseActivationAction(readJson(path.join(layout.controlRoot, 'actions', `${jobId}.json`)));
    if (result.identity.jobId !== jobId) throw new Error('Release activation action job mismatch.');
    return Object.freeze(result.action);
}

function readGenerationLink(layout, name, required = false) {
    const file = path.join(layout.deployRoot, name);
    if (!existsSync(file)) { if (required) throw new Error(`Release ${name} reference is absent.`); return null; }
    const metadata = lstatSync(file);
    if (!metadata.isSymbolicLink()) throw new Error(`Release ${name} reference is unsafe.`);
    const target = realpathSync(file);
    if (path.dirname(target) !== layout.releasesRoot || !SAFE_ID.test(path.basename(target))) throw new Error(`Release ${name} reference escapes.`);
    return path.basename(target);
}

function replaceGenerationLink(layout, name, generationId) {
    if (!SAFE_ID.test(generationId || '')) throw new Error('Release link generation id is invalid.');
    const target = path.join(layout.releasesRoot, generationId);
    const metadata = lstatSync(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== statSync(layout.deployRoot).dev) {
        throw new Error('Release link target is unsafe.');
    }
    const temporary = path.join(layout.deployRoot, `.${name}.${process.pid}.${randomUUID()}`);
    symlinkSync(path.posix.join('releases', generationId), temporary);
    renameSync(temporary, path.join(layout.deployRoot, name));
    syncDirectory(layout.deployRoot);
}

function appendReceipt(layout, identity, phase, kind, facts = {}) {
    const directory = path.join(layout.controlRoot, 'receipts', identity.jobId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let existing = '0';
    try { existing = readFileSync(path.join(directory, '.sequence'), 'utf8').trim(); } catch {}
    const sequence = Number.parseInt(existing || '0', 10) + 1;
    const receipt = { schemaVersion: 2, sequence, phase, kind, jobId: identity.jobId,
        generationId: identity.generationId, identitySha256: sha(canonical(identity)), facts };
    durableExclusiveJson(path.join(directory, `${String(sequence).padStart(8, '0')}-${phase}-${kind}.json`), receipt);
    const sequenceFile = path.join(directory, '.sequence');
    const temporary = `${sequenceFile}.tmp-${randomUUID()}`;
    writeFileSync(temporary, `${sequence}\n`, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, sequenceFile); syncDirectory(directory);
    return receipt;
}

/** Seal verified staging into its immutable generation slot and persist action v2 first. */
export async function sealReleaseGeneration({ layout, staging, identity: rawIdentity, context }) {
    requireFence(context);
    const identity = normalizeIdentity(rawIdentity);
    const target = path.join(layout.releasesRoot, identity.generationId);
    if (path.dirname(path.resolve(target)) !== layout.releasesRoot) throw new Error('Release generation slot is unsafe.');
    const actionFile = path.join(layout.controlRoot, 'actions', `${identity.jobId}.json`);
    if (existsSync(target)) {
        const stored = validateReleaseActivationAction(readJson(actionFile));
        const generation = readJson(path.join(target, 'runtime-generation.json'));
        if (canonical(stored.identity) !== canonical(identity) || canonical(generation.identity) !== canonical(identity)
            || generation.activationIdentitySha256 !== stored.action.activationIdentitySha256) throw new Error('Existing release generation conflicts with sealed identity.');
        await context.assertFence();
        appendReceipt(layout, identity, 'seal', 'recovery', { generationPath: target });
        await context.checkpoint('candidate_sealed', 'recovery', { generationId: identity.generationId,
            activationIdentitySha256: stored.action.activationIdentitySha256 });
        return Object.freeze({ identity, action: stored.action, generationPath: target, recovered: true });
    }
    const stagingReal = realpathSync(staging);
    const stagingMetadata = lstatSync(stagingReal);
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink() || stagingMetadata.dev !== statSync(layout.releasesRoot).dev) {
        throw new Error('Release staging directory is unsafe.');
    }
    const currentGenerationId = readGenerationLink(layout, 'current', true);
    let action;
    if (existsSync(actionFile)) {
        const stored = validateReleaseActivationAction(readJson(actionFile));
        if (canonical(stored.identity) !== canonical(identity) || stored.action.expectedCurrentGenerationId !== currentGenerationId) {
            throw new Error('Existing release action conflicts with seal request.');
        }
        action = Object.freeze(stored.action);
    } else {
        const actionBase = { schema: ACTION_SCHEMA, ...identity, expectedCurrentGenerationId: currentGenerationId,
            createdAt: new Date().toISOString() };
        action = Object.freeze({ ...actionBase, activationIdentitySha256: sha(canonical(actionBase)) });
    }
    await context.assertFence();
    appendReceipt(layout, identity, 'seal', 'intent', { actionIdentity: action.activationIdentitySha256 });
    if (!existsSync(actionFile)) durableExclusiveJson(actionFile, action);
    const generationRecord = path.join(stagingReal, 'runtime-generation.json');
    if (!existsSync(generationRecord)) durableExclusiveJson(generationRecord, {
        schemaVersion: 2, state: 'sealed', createdAt: new Date().toISOString(), identity, activationIdentitySha256: action.activationIdentitySha256,
    });
    await context.checkpoint('candidate_sealed', 'intent', { generationId: identity.generationId, activationIdentitySha256: action.activationIdentitySha256 });
    await context.assertFence();
    renameSync(stagingReal, target); syncDirectory(layout.releasesRoot);
    await context.assertFence();
    appendReceipt(layout, identity, 'seal', 'done', { generationPath: target });
    await context.checkpoint('candidate_sealed', 'done', { generationId: identity.generationId, activationIdentitySha256: action.activationIdentitySha256 });
    return Object.freeze({ identity, action, generationPath: target });
}

export async function activateReleaseGeneration({ layout, action, context }) {
    requireFence(context);
    const { identity } = validateReleaseActivationAction(action);
    await context.assertFence();
    const current = readGenerationLink(layout, 'current', true);
    const observedPrevious = readGenerationLink(layout, 'previous');
    if (current === identity.generationId && observedPrevious === action.expectedCurrentGenerationId) {
        appendReceipt(layout, identity, 'activate', 'recovery', { current, previous: observedPrevious });
        await context.checkpoint('activating', 'recovery', { current, previous: observedPrevious });
        return Object.freeze({ current, previous: observedPrevious, activationIdentitySha256: action.activationIdentitySha256, recovered: true });
    }
    if (current !== action.expectedCurrentGenerationId) throw new Error('Release current generation changed before activation.');
    appendReceipt(layout, identity, 'activate', 'intent', { from: current, to: identity.generationId });
    await context.checkpoint('activating', 'intent', { from: current, to: identity.generationId });
    replaceGenerationLink(layout, 'previous', current);
    replaceGenerationLink(layout, 'last-good', current);
    await context.assertFence();
    replaceGenerationLink(layout, 'current', identity.generationId);
    await context.assertFence();
    appendReceipt(layout, identity, 'activate', 'done', { current: identity.generationId, previous: current });
    await context.checkpoint('activating', 'done', { current: identity.generationId, previous: current });
    return Object.freeze({ current: identity.generationId, previous: current, activationIdentitySha256: action.activationIdentitySha256 });
}

export async function rollbackReleaseGeneration({ layout, action, context }) {
    requireFence(context);
    const { identity } = validateReleaseActivationAction(action);
    await context.assertFence();
    const current = readGenerationLink(layout, 'current', true);
    const previous = readGenerationLink(layout, 'previous');
    if (current === action.expectedCurrentGenerationId) {
        if (previous === action.expectedCurrentGenerationId) replaceGenerationLink(layout, 'previous', identity.generationId);
        else if (previous !== null && previous !== identity.generationId) throw new Error('Release rollback previous reference is ambiguous.');
        const restoredPrevious = readGenerationLink(layout, 'previous');
        appendReceipt(layout, identity, 'rollback', 'recovery', { current, previous: restoredPrevious });
        await context.checkpoint('rolled_back', 'recovery', { current, previous: restoredPrevious });
        return Object.freeze({ current, previous: restoredPrevious, state: 'already_rolled_back' });
    }
    if (current !== identity.generationId || previous !== action.expectedCurrentGenerationId) throw new Error('Release rollback references are ambiguous.');
    appendReceipt(layout, identity, 'rollback', 'intent', { from: current, to: previous });
    await context.checkpoint('rollback_pending', 'intent', { from: current, to: previous });
    replaceGenerationLink(layout, 'current', previous);
    replaceGenerationLink(layout, 'previous', current);
    await context.assertFence();
    appendReceipt(layout, identity, 'rollback', 'done', { current: previous, previous: current });
    await context.checkpoint('rolled_back', 'done', { current: previous, previous: current });
    return Object.freeze({ current: previous, previous: current, state: 'rolled_back' });
}

export { ACTION_SCHEMA as RELEASE_LAYOUT_ACTION_SCHEMA };
