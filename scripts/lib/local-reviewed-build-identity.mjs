/** Strict, domain-separated identity for an explicitly reviewed local forward build. */
import { createHash } from 'node:crypto';
export const LOCAL_BUILD_KIND = 'owner-reviewed-local-build/v1';
export const LOCAL_MANIFEST_SCHEMA = 'nassaj-local-build-manifest/v1';
const HEX = /^[a-f0-9]{64}$/;
const CORE_KEYS = 'kind,projectId,commit,sourceTreeSha256,inputManifestSha256,profileId,version,serverBuildId,clientBuildId,bundleBuildId';
const ARTIFACT_KEYS = 'kind,buildIdentitySha256,archiveName,archiveSha256,archiveSize,manifestName,manifestSha256,manifestSize,startupClosureSha256,databaseContractSha256';
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
/** Canonical encoding shared by local identity producers and verifiers. */
export function canonicalLocalIdentity(value) {
    return Array.isArray(value) ? `[${value.map(canonicalLocalIdentity).join(',')}]`
        : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalLocalIdentity(value[key])}`).join(',')}}` : JSON.stringify(value);
}
/** Reject mixed identity fields; project authorization is a separate expected-core comparison. */
export function validateLocalBuildCore(build) {
    if (!exact(build, CORE_KEYS) || build.kind !== LOCAL_BUILD_KIND
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(build.projectId || '')
        || !/^[a-f0-9]{40}$/.test(build.commit || '') || !/^\d+\.\d+\.\d+\.\d+$/.test(build.version || '')
        || !['local-forward-349/v1', 'local-forward-349/v2'].includes(build.profileId)
        || ['sourceTreeSha256','inputManifestSha256','serverBuildId','clientBuildId','bundleBuildId'].some(key => !HEX.test(build[key] || ''))) {
        throw Error('Local build core identity mismatch.');
    }
    return build;
}
/** Hash the validated local core including its explicit kind. */
export function localBuildIdentitySha256(build) {
    return createHash('sha256').update(canonicalLocalIdentity(validateLocalBuildCore(build))).digest('hex');
}
/** Verify external archive pins without introducing a cyclic hash into the build core. */
export function validateLocalPreparedArtifact(artifact, build) {
    validateLocalBuildCore(build);
    if (!exact(artifact, ARTIFACT_KEYS) || artifact.kind !== LOCAL_BUILD_KIND
        || artifact.buildIdentitySha256 !== localBuildIdentitySha256(build)
        || artifact.archiveName !== `nassaj-local-forward-${build.commit}.tar.gz`
        || artifact.manifestName !== 'LOCAL_BUILD_MANIFEST.json'
        || ['archiveSha256','manifestSha256','startupClosureSha256','databaseContractSha256'].some(key => !HEX.test(artifact[key] || ''))
        || ['archiveSize','manifestSize'].some(key => !Number.isSafeInteger(artifact[key]) || artifact[key] <= 0)) {
        throw Error('Local prepared artifact identity mismatch.');
    }
    return artifact;
}
/** Select only an explicitly trusted local header; no schema probing or GitHub fallback. */
export function validateLocalManifestHeader(manifest, expected) {
    const common = 'schema,build,bundleManifestSha256,permissionProfile,permissionContractVersion,permissionProfileDigest,permissionCapabilityDigest,permissionProtocolGeneration,minimumPermissionBuild,databaseContract,runtimeCompatibility,targetRuntime,runtimeClosure,npmBinLinksExcluded,files';
    if (expected?.kind !== LOCAL_BUILD_KIND || !exact(manifest, common) || manifest.schema !== LOCAL_MANIFEST_SCHEMA
        || canonicalLocalIdentity(validateLocalBuildCore(manifest.build)) !== canonicalLocalIdentity(validateLocalBuildCore(expected.build))) {
        throw Error('Local manifest header identity mismatch.');
    }
    return manifest.build;
}
