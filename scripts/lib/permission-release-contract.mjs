import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export const PERMISSION_RELEASE_FIELDS = Object.freeze([
    'permissionProfile', 'permissionContractVersion', 'permissionProfileDigest',
    'permissionCapabilityDigest', 'permissionProtocolGeneration', 'minimumPermissionBuild',
]);

const PROFILE_ID = 'full_delegation';
const CONTRACT_VERSION = 'permission-parity/v1';
const CAPABILITY_ARTIFACT_DIGEST = 'sha256:e4f42ebffc340adb7beb51a389206fc8cac11a20df81839bdd3914dfa50bf230';

function digest(value) {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function profileStatement() {
    return Object.freeze({
        schema: 'nassaj-permission-profile/v1', profileId: PROFILE_ID,
        contractVersion: CONTRACT_VERSION, rolloutMode: 'local_enforce_eligible', enforceEligible: true,
    });
}

function capabilityStatement(serverBuildId, profileDigest, protocolGeneration) {
    return Object.freeze({
        schema: 'nassaj-permission-capability/v1', profileId: PROFILE_ID,
        contractVersion: CONTRACT_VERSION, profileDigest, protocolGeneration,
        buildId: serverBuildId, evidenceStatus: 'measured',
        artifactDigest: CAPABILITY_ARTIFACT_DIGEST, verdict: 'eligible_bodies_only',
    });
}

/** Create the additive contract sealed to the reviewed, measured capability artifact. */
export function createMeasuredPermissionReleaseContract(serverBuildId, protocolGeneration = 1) {
    if (!SHA256.test(serverBuildId || '') || !Number.isSafeInteger(protocolGeneration) || protocolGeneration <= 0) {
        throw new Error('Permission release contract requires a server build identity and positive protocol generation.');
    }
    const permissionProfileDigest = digest(profileStatement());
    return Object.freeze({
        permissionProfile: PROFILE_ID,
        permissionContractVersion: CONTRACT_VERSION,
        permissionProfileDigest,
        permissionCapabilityDigest: digest(capabilityStatement(
            serverBuildId, permissionProfileDigest, protocolGeneration,
        )),
        permissionProtocolGeneration: protocolGeneration,
        minimumPermissionBuild: serverBuildId,
    });
}

/** Accept old schema-v2 manifests only when the whole additive contract is absent. */
export function validatePermissionReleaseContract(manifest) {
    const present = PERMISSION_RELEASE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(manifest || {}, field));
    if (present.length === 0) return null;
    if (present.length !== PERMISSION_RELEASE_FIELDS.length
        || manifest.permissionProfile !== PROFILE_ID
        || manifest.permissionContractVersion !== CONTRACT_VERSION
        || !DIGEST.test(manifest.permissionProfileDigest || '')
        || !DIGEST.test(manifest.permissionCapabilityDigest || '')
        || !Number.isSafeInteger(manifest.permissionProtocolGeneration)
        || manifest.permissionProtocolGeneration <= 0
        || !SHA256.test(manifest.minimumPermissionBuild || '')
        || manifest.minimumPermissionBuild !== manifest.serverBuildId) {
        throw new Error('Permission release contract identity mismatch.');
    }
    const expected = createMeasuredPermissionReleaseContract(
        manifest.serverBuildId, manifest.permissionProtocolGeneration,
    );
    for (const field of PERMISSION_RELEASE_FIELDS) {
        if (manifest[field] !== expected[field]) throw new Error('Permission release contract digest mismatch.');
    }
    return expected;
}

/** Produce a reviewed source-pin update; callers must validate evidence before supplying its digest. */
export function preparePermissionArtifactPinUpdate(source, expectedOldPin, validatedArtifactDigest) {
    if (!DIGEST.test(expectedOldPin || '') || !DIGEST.test(validatedArtifactDigest || '')) {
        throw new Error('Permission artifact pin digest invalid.');
    }
    const pattern = /const CAPABILITY_ARTIFACT_DIGEST = 'sha256:[a-f0-9]{64}';/g;
    const matches = source.match(pattern);
    const expected = `const CAPABILITY_ARTIFACT_DIGEST = '${expectedOldPin}';`;
    if (matches?.length !== 1 || matches[0] !== expected) {
        throw new Error('Permission artifact pin compare-and-swap failed.');
    }
    return source.replace(expected, `const CAPABILITY_ARTIFACT_DIGEST = '${validatedArtifactDigest}';`);
}
