/** Capability marker and 1.44 -> v2 strategy negotiation. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    UPDATE_RUNTIME_CAPABILITY, UPDATE_RUNTIME_CAPABILITY_SCHEMA, verifyUpdateRuntimeBundle,
} from './update-runtime-bundle.mjs';
import { validateReleaseActivationAction } from './update-release-layout-activation.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function sha(value) { return createHash('sha256').update(value).digest('hex'); }

/** Create the host-bound marker after an artefact bundle has been verified. */
export function createHostCapability({ artifactRoot, projectRoot, controlRoot, nodeInstanceId, createdByReleaseIdentitySha256 }) {
    const { manifest } = verifyUpdateRuntimeBundle(artifactRoot);
    const project = realpathSync(projectRoot);
    const control = realpathSync(controlRoot);
    const metadata = statSync(control);
    if (!INSTANCE.test(nodeInstanceId || '') || !HEX64.test(createdByReleaseIdentitySha256 || '')) {
        throw new Error('Update capability host identity is invalid.');
    }
    return Object.freeze({
        schema: UPDATE_RUNTIME_CAPABILITY_SCHEMA,
        nodeInstanceId,
        strategy: 'artifact-runtime-v2',
        protocol: 2,
        projectRootRealpathHash: sha(project),
        controlDevice: metadata.dev,
        bootstrapBuildId: manifest.buildId,
        bundleManifestSha256: sha(readFileSync(path.join(artifactRoot, 'UPDATE_RUNTIME_MANIFEST.json'))),
        createdByReleaseIdentitySha256,
    });
}

export function writeHostCapability(file, capability) {
    const parent = realpathSync(path.dirname(file));
    const target = path.resolve(file);
    if (path.dirname(target) !== parent || existsSync(target)) throw new Error('Capability marker target is unsafe or already exists.');
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(capability, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, target); } finally { unlinkSync(temporary); }
    const directoryFd = openSync(parent, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

function replaceHostCapability(file, capability) {
    const parent = realpathSync(path.dirname(file));
    const target = path.resolve(file);
    if (path.dirname(target) !== parent) throw new Error('Capability marker target is unsafe.');
    const temporary = `${target}.renew-${process.pid}-${Date.now()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(capability, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, target); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    const directoryFd = openSync(parent, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

/**
 * One-shot 1.44 bridge and later renewal. It may run only after the exact
 * generation is the release-layout current target and its sealed action is verified.
 */
export function reconcileActivatedHostCapability({ deployRoot, artifactRoot, projectRoot, controlRoot,
    capabilityFile, nodeInstanceId, action: rawAction }) {
    const { identity, action } = validateReleaseActivationAction(rawAction);
    const project = realpathSync(projectRoot);
    const current = realpathSync(path.join(realpathSync(deployRoot), 'current'));
    if (project !== current || path.basename(project) !== identity.generationId) {
        throw new Error('Capability bridge requires the activated current generation.');
    }
    const generation = JSON.parse(readFileSync(path.join(project, 'runtime-generation.json'), 'utf8'));
    if (generation?.schemaVersion !== 2 || generation.activationIdentitySha256 !== action.activationIdentitySha256
        || generation.identity?.generationId !== identity.generationId || generation.identity?.commit !== identity.commit
        || generation.identity?.bundleBuildId !== identity.bundleBuildId) {
        throw new Error('Capability bridge generation attestation mismatch.');
    }
    const capability = createHostCapability({ artifactRoot, projectRoot: project, controlRoot, nodeInstanceId,
        createdByReleaseIdentitySha256: action.activationIdentitySha256 });
    if (!existsSync(capabilityFile)) {
        writeHostCapability(capabilityFile, capability);
        return Object.freeze({ state: 'created', capability,
            rollbackSnapshot: Object.freeze({ state: 'absent', installedSha256: sha(`${JSON.stringify(capability, null, 2)}\n`) }) });
    }
    const metadata = lstatSync(capabilityFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
        throw new Error('Existing capability marker is unsafe.');
    }
    const existingBytes = readFileSync(capabilityFile, 'utf8');
    const existing = JSON.parse(existingBytes);
    if (!validateHostCapability(existing, { nodeInstanceId, controlRoot })) {
        throw new Error('Existing capability marker cannot be safely renewed.');
    }
    if (JSON.stringify(existing) === JSON.stringify(capability)) return Object.freeze({ state: 'unchanged', capability, rollbackSnapshot: null });
    const installedBytes = `${JSON.stringify(capability, null, 2)}\n`;
    replaceHostCapability(capabilityFile, capability);
    return Object.freeze({ state: 'renewed', capability, rollbackSnapshot: Object.freeze({ state: 'present',
        bytes: existingBytes, previousSha256: sha(existingBytes), installedSha256: sha(installedBytes) }) });
}

/** Restore the exact pre-activation marker only while the action-bound marker is still current. */
export function restoreHostCapability({ capabilityFile, rollbackSnapshot, action: rawAction }) {
    if (!rollbackSnapshot) return Object.freeze({ state: 'unchanged' });
    const { action } = validateReleaseActivationAction(rawAction);
    const currentBytes = readFileSync(capabilityFile, 'utf8');
    const current = JSON.parse(currentBytes);
    if (current.createdByReleaseIdentitySha256 !== action.activationIdentitySha256
        || sha(currentBytes) !== rollbackSnapshot.installedSha256) {
        throw new Error('Capability rollback marker no longer matches the activated action.');
    }
    if (rollbackSnapshot.state === 'absent') {
        unlinkSync(capabilityFile);
        const directoryFd = openSync(realpathSync(path.dirname(capabilityFile)), 'r');
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        return Object.freeze({ state: 'removed' });
    }
    if (rollbackSnapshot.state !== 'present' || sha(rollbackSnapshot.bytes || '') !== rollbackSnapshot.previousSha256) {
        throw new Error('Capability rollback snapshot is invalid.');
    }
    const previous = JSON.parse(rollbackSnapshot.bytes);
    if (!validateHostCapability(previous, {})) throw new Error('Capability rollback snapshot contract is invalid.');
    replaceHostCapability(capabilityFile, previous);
    return Object.freeze({ state: 'restored' });
}

/**
 * Explicit one-shot bootstrap for an already activated 1.44 release-layout host.
 * The caller must opt in; normal readiness probing must never call this function.
 */
export function bootstrapLegacy144HostCapability({ authorization, deployRoot, artifactRoot, projectRoot,
    controlRoot, capabilityFile, nodeInstanceId }) {
    if (authorization !== 'legacy-1.44-to-artifact-runtime-v2') throw new Error('Legacy capability bridge is not authorized.');
    if (existsSync(capabilityFile)) throw new Error('Legacy capability bridge is one-shot and the marker already exists.');
    const project = realpathSync(projectRoot);
    if (realpathSync(path.join(realpathSync(deployRoot), 'current')) !== project) {
        throw new Error('Legacy capability bridge requires the activated current generation.');
    }
    if (detectUpdateStrategy({ artifactRoot, capabilityFile }) !== 'legacy-1.44-unattested') {
        throw new Error('Legacy capability bridge source state is not eligible.');
    }
    const provenance = JSON.parse(readFileSync(path.join(artifactRoot, 'BUILD_PROVENANCE.json'), 'utf8'));
    if (!HEX40.test(provenance?.commit || '') || !HEX64.test(provenance?.buildId || '')
        || !/^1\.44(?:\.\d+){2}$/.test(provenance?.version || '')) {
        throw new Error('Legacy capability bridge provenance is invalid or not 1.44.');
    }
    const { manifest } = verifyUpdateRuntimeBundle(artifactRoot);
    const attestation = sha(JSON.stringify({ kind: 'legacy-1.44-current-bootstrap', project,
        commit: provenance.commit, serverBuildId: provenance.buildId, bundleBuildId: manifest.buildId }));
    const capability = createHostCapability({ artifactRoot, projectRoot: project, controlRoot, nodeInstanceId,
        createdByReleaseIdentitySha256: attestation });
    writeHostCapability(capabilityFile, capability);
    return Object.freeze({ state: 'created', capability, attestation });
}

export function validateHostCapability(value, context) {
    if (!value || value.schema !== UPDATE_RUNTIME_CAPABILITY_SCHEMA || value.protocol !== 2
        || value.strategy !== 'artifact-runtime-v2' || !INSTANCE.test(value.nodeInstanceId || '')
        || !HEX64.test(value.projectRootRealpathHash || '') || !Number.isSafeInteger(value.controlDevice)
        || !HEX64.test(value.bootstrapBuildId || '') || !HEX64.test(value.bundleManifestSha256 || '')
        || !HEX64.test(value.createdByReleaseIdentitySha256 || '')) return false;
    if (context?.nodeInstanceId && value.nodeInstanceId !== context.nodeInstanceId) return false;
    if (context?.projectRoot && value.projectRootRealpathHash !== sha(realpathSync(context.projectRoot))) return false;
    if (context?.controlRoot && value.controlDevice !== statSync(realpathSync(context.controlRoot)).dev) return false;
    return true;
}

/** Fail-closed strategy detection. Legacy 1.44 is bridgeable but never called v2. */
export function detectUpdateStrategy({ artifactRoot, capabilityFile, context = {} }) {
    try {
        const markerStat = lstatSync(capabilityFile);
        if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o777) !== 0o600) return 'unsupported';
        const marker = JSON.parse(readFileSync(capabilityFile, 'utf8'));
        if (validateHostCapability(marker, context)) {
            const { manifest } = verifyUpdateRuntimeBundle(artifactRoot);
            if (marker.bootstrapBuildId === manifest.buildId
                && marker.bundleManifestSha256 === sha(readFileSync(path.join(artifactRoot, 'UPDATE_RUNTIME_MANIFEST.json')))) return 'artifact-runtime-v2';
        }
    } catch { /* legacy or invalid marker */ }
    const legacy = path.join(artifactRoot, 'scripts', 'source-update-candidate.mjs');
    try {
        const metadata = lstatSync(legacy);
        if (metadata.isFile() && !metadata.isSymbolicLink()) return 'legacy-1.44-unattested';
    } catch {}
    return 'unsupported';
}

export function planBridgeTransition(currentStrategy, nextStrategy = 'artifact-runtime-v2') {
    if (currentStrategy === nextStrategy) return Object.freeze({ mode: 'native', requiresBootstrapRestart: false });
    if (currentStrategy === 'legacy-1.44-unattested' && nextStrategy === 'artifact-runtime-v2') {
        return Object.freeze({ mode: 'legacy-stages-v2', requiresBootstrapRestart: true, activationProtocol: 2 });
    }
    throw new Error(`Unsupported update runtime transition: ${currentStrategy} -> ${nextStrategy}`);
}

/** Resolve an executable only after the complete immutable bundle verifies. */
export function resolveUpdateRuntimeEntry(artifactRoot, relativeEntry) {
    if (typeof relativeEntry !== 'string' || relativeEntry.includes('\\') || path.posix.normalize(relativeEntry) !== relativeEntry
        || relativeEntry.startsWith('/') || relativeEntry.startsWith('../')) throw new Error('Update runtime entry path is invalid.');
    const { manifest, bundleRoot } = verifyUpdateRuntimeBundle(artifactRoot);
    if (!manifest.entries.includes(relativeEntry) || !manifest.files.some((file) => file.path === relativeEntry)) {
        throw new Error('Update runtime entry is not declared by the bundle.');
    }
    return path.join(bundleRoot, relativeEntry);
}
