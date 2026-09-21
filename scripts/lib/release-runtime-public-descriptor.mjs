/** Derive public startup pins from private root installation inputs; never installs or grants admission. */
import { resolveForwardBashPath } from './release-runtime-forward-child-protocol.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_BUILD_KIND, localBuildIdentitySha256, validateLocalPreparedArtifact, validateLocalManifestHeader } from './local-reviewed-build-identity.mjs';
import { RELEASE_ASSET_LIMITS, validateCompatibleForwardDatabaseContract } from './update-release-asset.mjs';
import { readInstalledHostConfiguration } from './release-runtime-installed-config.mjs';

const CONFIG = '/etc/nassaj/release-runtime-host.json';
const HEX = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function requireValue(condition, reason) { if (!condition) throw Error(`public_descriptor_${reason}`); }
function rootBytes(file, privateFile = false, maximum = 16 * 1024 * 1024) {
    requireValue(path.isAbsolute(file || '') && fs.realpathSync(file) === file, 'path_unsafe');
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        const info = fs.lstatSync(parent);
        requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022), 'ancestor_unsafe');
        if (parent === path.dirname(parent)) break;
    }
    const before = fs.lstatSync(file);
    requireValue(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && !(before.mode & 0o022)
        && (!privateFile || (before.mode & 0o777) === 0o600) && (maximum !== 256 * 1024 * 1024 || !!(before.mode & 0o111)) && before.size > 0 && before.size <= maximum, 'file_unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd);
        const same = info => ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeMs', 'ctimeMs'].every(key => info[key] === before[key]);
        requireValue(same(opened), 'file_changed');
        const chunks = []; let total = 0;
        while (total <= maximum) {
            const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - total));
            const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
            chunks.push(chunk.subarray(0, count)); total += count;
        }
        requireValue(total <= maximum && total === before.size && same(fs.fstatSync(fd)), 'file_changed');
        return Buffer.concat(chunks, total);
    } finally { fs.closeSync(fd); }
}
function pinned(file, hash, read, privateFile = false, maximum) {
    requireValue(HEX.test(hash || ''), 'pin_missing');
    const bytes = read(file, privateFile, maximum);
    requireValue(sha(bytes) === hash, 'pin_mismatch'); return bytes;
}
function executable(file, hash, read) {
    pinned(file, hash, read, false, 256 * 1024 * 1024);
    requireValue(path.isAbsolute(file || ''), 'executable_invalid');
    return { path: file, sha256: hash };
}
function releasePins(config, read) {
    const settings = config.bootstrapClaim; const binding = settings?.identity; const expected = config.expected;
    requireValue(config.schema === 'nassaj-release-runtime-host-config/v1' && !!binding && !!expected, 'config_invalid');
    const bytes = pinned(settings.releaseManifestFile, settings.releaseManifestSha256, read, true, RELEASE_ASSET_LIMITS.manifestBytes);
    const manifest = JSON.parse(bytes);
    const record = JSON.parse(pinned(settings.generationRecordFile, settings.generationRecordSha256, read));
    const identity = record.identity;
    if (expected.artifactPolicy === LOCAL_BUILD_KIND) return localReleasePins(config, manifest, bytes, record);
    requireValue(manifest.schema === undefined && manifest.build === undefined && identity?.kind === undefined
        && expected.artifactPolicy === undefined && expected.localBuild === undefined && expected.localArtifact === undefined, 'identity_kind_mismatch');
    const releaseSha = sha(canonical(Object.fromEntries(['repo', 'releaseId', 'tag', 'version', 'commit', 'serverBuildId', 'clientBuildId', 'bundleBuildId'].map(key => [key, manifest[key]]))));
    requireValue(record.schemaVersion === 2 && record.state === 'sealed' && identity?.profile === 'forward', 'generation_invalid');
    requireValue(['releaseId', 'tag', 'version', 'commit', 'serverBuildId', 'clientBuildId', 'bundleBuildId'].every(key => identity[key] === manifest[key])
        && identity.repository === manifest.repo && releaseSha === binding.releaseIdentitySha256
        && releaseSha === expected.releaseIdentitySha256
        && expected.serverBuildId === manifest.serverBuildId && expected.clientBuildId === manifest.clientBuildId
        && expected.targetSchemaDigest === manifest.databaseContract?.target?.schemaDigest, 'release_mismatch');
    requireValue(validateCompatibleForwardDatabaseContract(manifest.databaseContract, releaseSha, binding.startupClosureSha256), 'contract_invalid');
    requireValue(sha(canonical(manifest.databaseContract)) === binding.databaseContractSha256
        && identity.databaseContractSha256 === binding.databaseContractSha256 && expected.databaseContractSha256 === binding.databaseContractSha256
        && identity.expectedStartupClosureSha256 === binding.startupClosureSha256
        && identity.detachedManifestSha256 === sha(bytes) && identity.detachedManifestSize === bytes.length, 'manifest_mismatch');
    requireValue(typeof manifest.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repo) && manifest.repo.length <= 200
        && /^[a-f0-9]{40}$/.test(manifest.commit) && /^\d+(\.\d+){1,3}$/.test(manifest.version) && manifest.tag === `v${manifest.version}`
        && [identity.assetId, identity.detachedManifestId, manifest.releaseId].every(value => Number.isSafeInteger(value) && value > 0)
        && identity.assetId !== identity.detachedManifestId && HEX.test(identity.assetSha256 || '')
        && identity.archiveSha256 === identity.assetSha256 && expected.assetSha256 === identity.assetSha256, 'release_fields_invalid');
    const generationId = `${manifest.version}-${manifest.commit.slice(0, 12)}-forward-${identity.assetSha256}`;
    requireValue(generationId.length <= 96 && identity.generationId === generationId && expected.generationId === generationId && binding.generationId === generationId
        && identity.assetName === `nassaj-runtime-forward-v${manifest.version}.tar.gz`
        && identity.detachedManifestName === 'RELEASE_ASSET_MANIFEST.forward.json', 'variant_mismatch');
    return { repo: manifest.repo, releaseId: manifest.releaseId, assetId: identity.assetId, assetName: identity.assetName,
        assetSha256: identity.assetSha256, manifestAssetId: identity.detachedManifestId, manifestAssetName: identity.detachedManifestName,
        manifestSha256: identity.detachedManifestSha256, tag: manifest.tag, commit: manifest.commit, generationId };
}
function localReleasePins(config, manifest, bytes, record) {
    const expected=config.expected, binding=config.bootstrapClaim.identity, identity=record.identity;
    const build=validateLocalManifestHeader(manifest,{kind:LOCAL_BUILD_KIND,build:expected.localBuild});
    const artifact=validateLocalPreparedArtifact(expected.localArtifact,build);
    const keys='strategy,updaterProtocol,generationId,kind,profile,build,artifact,bundleManifestSha256,permissionProfile,permissionContractVersion,permissionProfileDigest,permissionCapabilityDigest,permissionProtocolGeneration,minimumPermissionBuild';
    requireValue(identity && Object.keys(identity).sort().join(',')===keys.split(',').sort().join(',')
        && identity.strategy==='release-layout-v2' && identity.updaterProtocol===2
        && !['repo','repository','releaseId','tag','assetId','detachedManifestId'].some(key=>Object.hasOwn(expected,key)), 'local_identity_fields_invalid');
    const releaseSha=localBuildIdentitySha256(build), generationId=`local-forward-${artifact.archiveSha256}`;
    requireValue(record.schemaVersion===2 && record.state==='sealed' && identity?.kind===LOCAL_BUILD_KIND
        && identity.profile==='forward' && canonical(identity.build)===canonical(build)
        && canonical(identity.artifact)===canonical(artifact), 'local_generation_mismatch');
    requireValue(expected.releaseIdentitySha256===releaseSha && binding.releaseIdentitySha256===releaseSha
        && expected.assetSha256===artifact.archiveSha256 && expected.serverBuildId===build.serverBuildId
        && expected.clientBuildId===build.clientBuildId && expected.targetSchemaDigest===manifest.databaseContract?.target?.schemaDigest
        && [identity.generationId,expected.generationId,binding.generationId].every(value=>value===generationId), 'local_release_mismatch');
    requireValue(artifact.manifestSha256===sha(bytes) && artifact.manifestSize===bytes.length
        && artifact.databaseContractSha256===sha(canonical(manifest.databaseContract))
        && artifact.databaseContractSha256===binding.databaseContractSha256 && artifact.databaseContractSha256===expected.databaseContractSha256
        && artifact.startupClosureSha256===binding.startupClosureSha256, 'local_manifest_mismatch');
    validateCompatibleForwardDatabaseContract(manifest.databaseContract,releaseSha,artifact.startupClosureSha256);
    return {...artifact,build};
}
/** Read verified root input files and return only public bytes. Test dependencies never enter the installed CLI. */
export function generateStartupPublicDescriptor(deps = {}) {
    requireValue((deps.effectiveUid || (() => process.geteuid?.()))() === 0, 'root_required');
    const read = deps.readRootBytes || rootBytes;
    const config = deps.readRootBytes ? JSON.parse(read(CONFIG, true, 256 * 1024)) : readInstalledHostConfiguration().value;
    return descriptorFromConfig(config, read, deps.inspectDatabase);
}
function descriptorFromConfig(config, read, inspectDatabase) {
    const release = releasePins(config, read); const settings = config.bootstrapClaim; const binding = settings.identity;
    requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(binding.nodeInstanceId || '') && binding.nodeInstanceId === config.expected.nodeInstanceId
        && binding.startupPolicyId === 'existing-security-state/v1' && binding.startupAdmissionPolicy === 'same-generation-auto-restart/v1', 'identity_invalid');
    const databasePath = config.databaseFile;
    const inspect = inspectDatabase || (file => ({ path: fs.realpathSync(file), info: fs.lstatSync(file, { bigint: true }) }));
    const database = inspect(databasePath);
    requireValue(path.isAbsolute(databasePath || '') && database.path === databasePath && database.info.isFile() && !database.info.isSymbolicLink()
        && String(database.info.dev) === binding.databaseDev && String(database.info.ino) === binding.databaseIno
        && /^(0|[1-9][0-9]{0,23})$/.test(binding.databaseDev) && /^[1-9][0-9]{0,23}$/.test(binding.databaseIno), 'database_mismatch');
    const local = release.kind === LOCAL_BUILD_KIND;
    const descriptor = { schema: local ? 'nassaj-startup-admission-client/v2' : 'nassaj-startup-admission-client/v1', nodeInstanceId: binding.nodeInstanceId, profileId: local ? release.build.profileId : 'local-forward-349/v2',
        dispatcher: executable(settings.dispatcherExecutable, settings.dispatcherSha256, read),
        sudo: executable(settings.sudoExecutable, settings.sudoSha256, read), node: executable(settings.nodeExecutable, settings.nodeSha256, read),
        ...(local ? {artifact:release} : {release}), startupClosureSha256: binding.startupClosureSha256, databaseContractSha256: binding.databaseContractSha256,
        databasePath, databaseDev: binding.databaseDev, databaseIno: binding.databaseIno };
    return `${canonical(descriptor)}\n`;
}

/** Prepare v2 private startup fields from independently pinned reviewed inputs, without writing or signing anything. */
export function prepareForwardStartupAuthority(options, deps = {}) {
    requireValue((deps.effectiveUid || (() => process.geteuid?.()))() === 0, 'root_required');
    const read = deps.readRootBytes || rootBytes;
    const config = JSON.parse(pinned(options.reviewedHostConfigFile, options.reviewedHostConfigSha256, read, true, 256 * 1024));
    const lock = config.stateLock;
    requireValue(lock && Object.keys(lock).sort().join(',') === 'flock,schema'
        && lock.schema === 'nassaj-cutover-state-lock/v2' && lock.flock
        && Object.keys(lock.flock).sort().join(',') === 'path,sha256'
        && lock.flock.path === '/usr/bin/flock', 'state_lock_invalid');
    executable(lock.flock.path, lock.flock.sha256, read);
    if (config.forwardActivation) {
        const bash = config.forwardActivation.bash;
        requireValue(bash?.path === resolveForwardBashPath(), 'forward_bash_path_invalid');
        executable(bash.path, bash.sha256, read);
    }
    const manifest = JSON.parse(pinned(options.releaseManifestFile, options.releaseManifestSha256, read, true, RELEASE_ASSET_LIMITS.manifestBytes));
    const record = JSON.parse(pinned(options.generationRecordFile, options.generationRecordSha256, read));
    requireValue(HEX.test(options.startupClosureSha256 || '') && Number.isSafeInteger(options.applicationUid) && options.applicationUid > 0, 'startup_inputs_invalid');
    const inspect = deps.inspectDatabase || (file => ({ path: fs.realpathSync(file), info: fs.lstatSync(file, { bigint: true }) }));
    const database = inspect(config.databaseFile);
    const identity = { nodeInstanceId: config.expected?.nodeInstanceId, generationId: record.identity?.generationId,
        releaseIdentitySha256: manifest.databaseContract?.releaseIdentitySha256, startupClosureSha256: options.startupClosureSha256,
        databaseContractSha256: sha(canonical(manifest.databaseContract)), databaseDev: String(database.info.dev), databaseIno: String(database.info.ino),
        startupPolicyId: 'existing-security-state/v1', startupAdmissionPolicy: 'same-generation-auto-restart/v1' };
    for (const file of [options.approvalFile, options.ownerApprovalPublicKeyFile]) requireValue(path.isAbsolute(file || ''), 'approval_paths_invalid');
    config.bootstrapClaim = { identity, applicationUid: options.applicationUid,
        releaseManifestFile: options.releaseManifestFile, releaseManifestSha256: options.releaseManifestSha256,
        generationRecordFile: options.generationRecordFile, generationRecordSha256: options.generationRecordSha256,
        dispatcherExecutable: options.dispatcherExecutable, dispatcherSha256: options.dispatcherSha256,
        sudoExecutable: options.sudoExecutable, sudoSha256: options.sudoSha256, nodeExecutable: options.nodeExecutable, nodeSha256: options.nodeSha256,
        approvalFile: options.approvalFile, ownerApprovalPublicKeyFile: options.ownerApprovalPublicKeyFile };
    const publicDescriptor = descriptorFromConfig(config, read, inspect);
    return { privateConfig: `${canonical(config)}\n`, publicDescriptor };
}

/** Read the root-owned preparation request; CLI callers cannot inject filesystem dependencies. */
export function prepareForwardStartupAuthorityFromFile(file) {
    requireValue(process.geteuid?.() === 0, 'root_required');
    return prepareForwardStartupAuthority(JSON.parse(rootBytes(file, true, 256 * 1024)));
}
