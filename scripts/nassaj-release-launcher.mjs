#!/usr/bin/env node
/** Stable, generation-independent launcher for sealed Nassaj releases. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    constants, closeSync, fsyncSync, fstatSync, ftruncateSync, openSync, renameSync, writeFileSync,
    lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CAPABILITY_SCHEMA = 'nassaj-update-capability/v1';
const RUNTIME_SCHEMA = 'nassaj-release-runtime/v1';
const PERMISSION_CAPABILITY_DIGEST = 'sha256:e4f42ebffc340adb7beb51a389206fc8cac11a20df81839bdd3914dfa50bf230';
const PERMISSION_RELEASE_FIELDS = Object.freeze([
    'permissionProfile', 'permissionContractVersion', 'permissionProfileDigest',
    'permissionCapabilityDigest', 'permissionProtocolGeneration', 'minimumPermissionBuild',
]);
const PERMISSION_ENVIRONMENT_KEYS = Object.freeze([
    'NASSAJ_PERMISSION_PROFILE', 'NASSAJ_PERMISSION_CONTRACT_VERSION',
    'NASSAJ_PERMISSION_PROFILE_DIGEST', 'NASSAJ_PERMISSION_CAPABILITY_DIGEST',
    'NASSAJ_PERMISSION_PROTOCOL_GENERATION', 'NASSAJ_PERMISSION_MINIMUM_BUILD',
    'NASSAJ_PERMISSION_MANIFEST_SHA256',
]);
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function permissionDigest(value) { return `sha256:${sha(JSON.stringify(value))}`; }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function versionAtLeast(actual, minimum) {
    const valid = (value) => typeof value === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value);
    if (!valid(actual) || !valid(minimum)) return false;
    const left = actual.split('.').map(Number); const right = minimum.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
    }
    return true;
}
function expectedPermissionContract(serverBuildId, protocolGeneration) {
    const permissionProfileDigest = permissionDigest({
        schema: 'nassaj-permission-profile/v1', profileId: 'full_delegation',
        contractVersion: 'permission-parity/v1', rolloutMode: 'local_enforce_eligible', enforceEligible: true,
    });
    return Object.freeze({
        permissionProfile: 'full_delegation', permissionContractVersion: 'permission-parity/v1',
        permissionProfileDigest,
        permissionCapabilityDigest: permissionDigest({
            schema: 'nassaj-permission-capability/v1', profileId: 'full_delegation',
            contractVersion: 'permission-parity/v1', profileDigest: permissionProfileDigest,
            protocolGeneration, buildId: serverBuildId, evidenceStatus: 'measured',
            artifactDigest: PERMISSION_CAPABILITY_DIGEST, verdict: 'eligible_bodies_only',
        }),
        permissionProtocolGeneration: protocolGeneration, minimumPermissionBuild: serverBuildId,
    });
}
function validatePermissionContract(manifest) {
    const present = PERMISSION_RELEASE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(manifest || {}, field));
    if (present.length === 0) return null;
    if (present.length !== PERMISSION_RELEASE_FIELDS.length || !HEX64.test(manifest.serverBuildId || '')
        || !Number.isSafeInteger(manifest.permissionProtocolGeneration)
        || manifest.permissionProtocolGeneration <= 0) {
        throw new Error('Permission release contract identity mismatch.');
    }
    const expected = expectedPermissionContract(manifest.serverBuildId, manifest.permissionProtocolGeneration);
    if (PERMISSION_RELEASE_FIELDS.some((field) => manifest[field] !== expected[field])) {
        throw new Error('Permission release contract identity mismatch.');
    }
    return expected;
}
function readRegularJson(file, label) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is unsafe.`);
    return JSON.parse(readFileSync(file, 'utf8'));
}
function directPrivateDirectory(deploy, name) {
    const candidate = path.join(deploy, name); const metadata = lstatSync(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error(`Launcher ${name} directory is unsafe.`);
    }
    const resolved = realpathSync(candidate);
    if (path.dirname(resolved) !== deploy) throw new Error(`Launcher ${name} directory escapes deploy root.`);
    return resolved;
}
function readExternalEnvironment(file) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new Error('External release configuration is unsafe.');
    }
    const values = {};
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed.slice(0, separator))) {
            throw new Error('External release configuration contains an invalid assignment.');
        }
        values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
    }
    return values;
}
function assertRuntimeCompatibility(contract, host = {}) {
    const report = host.report || process.report?.getReport?.();
    const facts = {
        platform: host.platform || process.platform, arch: host.arch || process.arch,
        libc: host.libc || report?.header?.glibcVersionRuntime,
        nodeMajor: host.nodeMajor || Number.parseInt(process.versions.node, 10),
        nodeModules: host.nodeModules || Number.parseInt(process.versions.modules, 10),
    };
    if (contract?.schema !== RUNTIME_SCHEMA || contract.platform !== 'linux' || contract.arch !== 'x64'
        || contract.libc?.family !== 'glibc' || contract.libc?.minimum !== '2.39'
        || contract.node?.major !== 24 || contract.node?.modules !== 137
        || facts.platform !== contract.platform || facts.arch !== contract.arch
        || !versionAtLeast(facts.libc, contract.libc.minimum)
        || facts.nodeMajor !== contract.node.major || facts.nodeModules !== contract.node.modules) {
        throw new Error('The current host does not satisfy the sealed release runtime contract.');
    }
}
function collectReleaseFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(directory, entry.name); const metadata = lstatSync(absolute);
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            if (metadata.isSymbolicLink()) throw new Error(`Sealed release contains a symlink: ${relative}`);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile() && !['RELEASE_ASSET_MANIFEST.json', 'runtime-generation.json'].includes(relative)) {
                const bytes = readFileSync(absolute);
                files.push({ path: relative, mode: metadata.mode & 0o777, size: bytes.length, sha256: sha(bytes) });
            } else if (!entry.isFile()) throw new Error(`Sealed release contains a special file: ${relative}`);
        }
    };
    visit(root);
    return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function treeHash(files) {
    const hash = createHash('sha256');
    for (const file of files) hash.update(file.path).update('\0').update(String(file.mode)).update('\0')
        .update(String(file.size)).update('\0').update(file.sha256).update('\0');
    return hash.digest('hex');
}

/** Resolve the executable only after layout, seal, release bytes and host capability verify. */
// Intentional standalone trust-boundary duplicate: the stable launcher ships as one file.
// Keep this strict local header/core/artifact contract paired with the shared helper tests.
function localManifestView(manifest, generation, bytes) {
    const identity=generation.identity, build=manifest?.build, artifact=identity?.artifact;
    const exact=(value,keys)=>value && Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
    const coreKeys='kind,projectId,commit,sourceTreeSha256,inputManifestSha256,profileId,version,serverBuildId,clientBuildId,bundleBuildId';
    const artifactKeys='kind,buildIdentitySha256,archiveName,archiveSha256,archiveSize,manifestName,manifestSha256,manifestSize,startupClosureSha256,databaseContractSha256';
    const manifestKeys='schema,build,bundleManifestSha256,permissionProfile,permissionContractVersion,permissionProfileDigest,permissionCapabilityDigest,permissionProtocolGeneration,minimumPermissionBuild,databaseContract,runtimeCompatibility,targetRuntime,runtimeClosure,npmBinLinksExcluded,files';
    const identityKeys='strategy,updaterProtocol,generationId,kind,profile,build,artifact,bundleManifestSha256,permissionProfile,permissionContractVersion,permissionProfileDigest,permissionCapabilityDigest,permissionProtocolGeneration,minimumPermissionBuild';
    if (!exact(manifest,manifestKeys) || manifest.schema!=='nassaj-local-build-manifest/v1'
        || !exact(build,coreKeys) || build.kind!=='owner-reviewed-local-build/v1'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(build.projectId || '') || !HEX40.test(build.commit || '')
        || !/^\d+\.\d+\.\d+\.\d+$/.test(build.version || '') || !['local-forward-349/v1','local-forward-349/v2'].includes(build.profileId)
        || ['sourceTreeSha256','inputManifestSha256','serverBuildId','clientBuildId','bundleBuildId'].some(key=>!HEX64.test(build[key] || ''))
        || !exact(identity,identityKeys) || identity.kind!==build.kind || identity.strategy!=='release-layout-v2'
        || identity.updaterProtocol!==2 || identity.profile!=='forward' || canonical(identity.build)!==canonical(build)
        || !exact(artifact,artifactKeys) || artifact.kind!==build.kind || artifact.buildIdentitySha256!==sha(canonical(build))
        || artifact.archiveName!==`nassaj-local-forward-${build.commit}.tar.gz` || artifact.manifestName!=='LOCAL_BUILD_MANIFEST.json'
        || ['archiveSha256','manifestSha256','startupClosureSha256','databaseContractSha256'].some(key=>!HEX64.test(artifact[key] || ''))
        || ['archiveSize','manifestSize'].some(key=>!Number.isSafeInteger(artifact[key]) || artifact[key]<=0)
        || artifact.manifestSha256!==sha(bytes) || artifact.manifestSize!==bytes.length
        || artifact.databaseContractSha256!==sha(canonical(manifest.databaseContract))
        || manifest.databaseContract?.schema!=='nassaj-database-release-contract/v2'
        || manifest.databaseContract.releaseIdentitySha256!==artifact.buildIdentitySha256
        || manifest.databaseContract.startup?.closureSha256!==artifact.startupClosureSha256
        || identity.generationId!==`local-forward-${artifact.archiveSha256}` || generation.sealKind!=='initial-bootstrap-v1') {
        throw Error('Local launcher identity mismatch.');
    }
    return {...manifest,...build};
}
export function inspectSealedRelease({ deployRoot, nodeInstanceId = process.env.NASSAJ_NODE_INSTANCE_ID, host } = {}) {
    if (!deployRoot || !path.isAbsolute(deployRoot) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeInstanceId || '')) {
        throw new Error('Launcher deploy root or node instance id is invalid.');
    }
    const deploy = realpathSync(deployRoot); const releases = directPrivateDirectory(deploy, 'releases');
    const currentLink = path.join(deploy, 'current'); const rawCurrent = readlinkSync(currentLink);
    const currentMetadata = lstatSync(currentLink); const current = realpathSync(currentLink);
    if (!currentMetadata.isSymbolicLink() || path.isAbsolute(rawCurrent)
        || rawCurrent !== path.posix.join('releases', path.basename(current))
        || path.dirname(current) !== releases || !SAFE_GENERATION.test(path.basename(current))) {
        throw new Error('Launcher current reference escapes the release store.');
    }
    const manifestFile = path.join(current, 'RELEASE_ASSET_MANIFEST.json');
    const manifestBytes = readFileSync(manifestFile); const rawManifest = readRegularJson(manifestFile, 'Release manifest');
    const generation = readRegularJson(path.join(current, 'runtime-generation.json'), 'Generation seal');
    const local=generation.identity?.kind==='owner-reviewed-local-build/v1';
    if (!local && (generation.identity?.kind!==undefined || rawManifest.schema!==undefined || rawManifest.build!==undefined)) throw Error('Launcher identity kind mismatch.');
    const manifest=local ? localManifestView(rawManifest,generation,manifestBytes) : rawManifest;
    if ((!local && (manifest?.schemaVersion !== 2 || manifest.updaterProtocol !== 2)) || !HEX40.test(manifest.commit || '')
        || !HEX64.test(manifest.sourceTreeSha256 || '') || !HEX64.test(manifest.bundleBuildId || '')
        || !HEX64.test(manifest.bundleManifestSha256 || '') || !HEX64.test(manifest.serverBuildId || '')
        || !HEX64.test(manifest.clientBuildId || '') || !Array.isArray(manifest.files)) {
        throw new Error('Release manifest identity is invalid.');
    }
    const permissionContract = validatePermissionContract(manifest);
    assertRuntimeCompatibility(manifest.runtimeCompatibility, host);
    const files = collectReleaseFiles(current);
    if (JSON.stringify(files) !== JSON.stringify(manifest.files) || treeHash(files) !== manifest.sourceTreeSha256) {
        throw new Error('Sealed release file tree was modified.');
    }
    if (local && files.find(file=>file.path==='dist-server/SERVER_INPUT_MANIFEST.json')?.sha256!==manifest.inputManifestSha256) throw Error('Local launcher input manifest mismatch.');
    const permissionIdentityMatches = permissionContract === null
        ? PERMISSION_RELEASE_FIELDS.every((field) => !Object.prototype.hasOwnProperty.call(generation?.identity || {}, field))
        : PERMISSION_RELEASE_FIELDS.every((field) => generation.identity?.[field] === manifest[field]);
    const buildIdentity=local ? generation.identity.build : generation.identity;
    if (generation?.schemaVersion !== 2 || generation.state !== 'sealed'
        || !HEX64.test(generation.activationIdentitySha256 || '')
        || generation.identity?.generationId !== path.basename(current)
        || buildIdentity?.version !== manifest.version || buildIdentity?.commit !== manifest.commit
        || buildIdentity?.sourceTreeSha256 !== manifest.sourceTreeSha256
        || buildIdentity?.bundleBuildId !== manifest.bundleBuildId
        || generation.identity?.bundleManifestSha256 !== manifest.bundleManifestSha256
        || buildIdentity?.serverBuildId !== manifest.serverBuildId
        || buildIdentity?.clientBuildId !== manifest.clientBuildId || !permissionIdentityMatches) {
        throw new Error('Generation seal does not match the exact release identity.');
    }
    const control = directPrivateDirectory(deploy, 'control');
    if (generation.sealKind === 'initial-bootstrap-v1') {
        if (sha(canonical(generation.identity)) !== generation.activationIdentitySha256) {
            throw new Error('Initial generation seal digest is invalid.');
        }
    } else {
        const jobId = generation.identity?.jobId;
        if (!SAFE_GENERATION.test(jobId || '')) throw new Error('Updated generation seal job id is invalid.');
        const action = readRegularJson(path.join(control, 'actions', `${jobId}.json`), 'Generation action');
        const { activationIdentitySha256, ...actionBase } = action;
        if (activationIdentitySha256 !== generation.activationIdentitySha256
            || sha(canonical(actionBase)) !== activationIdentitySha256
            || action.generationId !== generation.identity.generationId || action.commit !== generation.identity.commit
            || action.sourceTreeSha256 !== generation.identity.sourceTreeSha256
            || action.bundleBuildId !== generation.identity.bundleBuildId) {
            throw new Error('Updated generation action seal is invalid.');
        }
    }
    const configFile = path.join(directPrivateDirectory(deploy, 'config'), 'nassaj.env');
    const externalEnvironment = readExternalEnvironment(configFile);
    const capabilityFile = path.join(control, 'UPDATE_RUNTIME_CAPABILITY.json');
    const capability = readRegularJson(capabilityFile, 'Host update capability');
    const runtimeManifest = readFileSync(path.join(current, 'dist-server', 'UPDATE_RUNTIME_MANIFEST.json'));
    if (capability?.schema !== CAPABILITY_SCHEMA || capability.protocol !== 2
        || capability.strategy !== 'artifact-runtime-v2' || capability.nodeInstanceId !== nodeInstanceId
        || capability.projectRootRealpathHash !== sha(current)
        || capability.controlDevice !== statSync(control).dev
        || capability.bootstrapBuildId !== manifest.bundleBuildId
        || capability.bundleManifestSha256 !== sha(runtimeManifest)
        || capability.createdByReleaseIdentitySha256 !== generation.activationIdentitySha256) {
        throw new Error('Host update capability does not match the current sealed generation.');
    }
    const entry = path.join(current, 'dist-server', 'server', 'bootstrap.js');
    const entryMetadata = lstatSync(entry);
    if (!entryMetadata.isFile() || entryMetadata.isSymbolicLink()) throw new Error('Release bootstrap entry is unsafe.');
    return Object.freeze({ deployRoot: deploy, current, generationId: path.basename(current), manifest:rawManifest,
        manifestSha256: sha(manifestBytes), controlRoot: control, capabilityFile, configFile,
        dataRoot: directPrivateDirectory(deploy, 'data'), externalEnvironment, permissionContract, entry });
}

/** Build child environment from sealed facts; inherited values cannot fabricate permission authority. */
export function releaseChildEnvironment(inspected, inherited = process.env) {
    const environment = { ...inspected.externalEnvironment, ...inherited };
    for (const key of PERMISSION_ENVIRONMENT_KEYS) delete environment[key];
    if (inspected.permissionContract) Object.assign(environment, {
        NASSAJ_PERMISSION_PROFILE: inspected.permissionContract.permissionProfile,
        NASSAJ_PERMISSION_CONTRACT_VERSION: inspected.permissionContract.permissionContractVersion,
        NASSAJ_PERMISSION_PROFILE_DIGEST: inspected.permissionContract.permissionProfileDigest,
        NASSAJ_PERMISSION_CAPABILITY_DIGEST: inspected.permissionContract.permissionCapabilityDigest,
        NASSAJ_PERMISSION_PROTOCOL_GENERATION: String(inspected.permissionContract.permissionProtocolGeneration),
        NASSAJ_PERMISSION_MINIMUM_BUILD: inspected.permissionContract.minimumPermissionBuild,
        NASSAJ_PERMISSION_MANIFEST_SHA256: inspected.manifestSha256,
    });
    return environment;
}

/** Read a bounded owned receipt without importing application or database modules. */
export function readReceipt(file) {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const metadata = fstatSync(fd);
        if (!metadata.isFile() || metadata.size > 65536 || (metadata.mode & 0o077)
            || metadata.uid !== process.getuid()) throw new Error('Unsafe runtime receipt.');
        return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
}
function processIdentity(pid = process.pid) {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, startTicks: fields[19], bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
function processAlive(identity) {
    if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0) return false;
    try { const now = processIdentity(identity.pid); return now.startTicks === identity.startTicks && now.bootId === identity.bootId; }
    catch { return false; }
}
function runControl(deployRoot) {
    if (!path.isAbsolute(deployRoot || '')) throw new Error('An absolute deploy root is required.');
    const deploy = realpathSync(deployRoot), metadata = lstatSync(deployRoot);
    if (deploy !== path.resolve(deployRoot) || !metadata.isDirectory() || metadata.isSymbolicLink()
        || metadata.uid !== process.getuid() || (metadata.mode & 0o022)) throw new Error('Unsafe deployment root.');
    return directPrivateDirectory(deploy, 'control');
}
function writeRunReceipt(control, value) {
    const temporary = path.join(control, `.run-status-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path.join(control, 'run-status.json'));
    const directory = openSync(control, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
/** Return observed receipt state; historical verification never establishes current readiness. */
export function readReleaseRunStatus({ deployRoot } = {}) {
    const control = runControl(deployRoot);
    let record;
    try { record = readReceipt(path.join(control, 'run-status.json')); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const prepared = readReceipt(path.join(control, 'initial-bootstrap.json'));
        return { state: prepared.state === 'prepared' ? 'prepared_not_activated' : 'preparing',
            phase: prepared.phase, generationId: prepared.generationId, observedAt: new Date().toISOString(), healthVerified: false };
    }
    if (record.schema !== 'nassaj-release-run/v1') throw new Error('Unsupported run status.');
    const alive = processAlive(record.child);
    return { state: alive ? record.state : (['starting', 'verified_running'].includes(record.state) ? 'interrupted' : record.state),
        attemptId: record.attemptId, generationId: record.generationId, version: record.version, commit: record.commit,
        serverBuildId: record.serverBuildId, clientBuildId: record.clientBuildId, updatedAt: record.updatedAt,
        ownerAlive: processAlive(record.owner), childAlive: alive, lockEvidence: 'kernel_flock_required_for_run', healthVerified: false, lastVerifiedAt: record.verifiedAt || null,
        failureCode: record.failureCode || null, exitCode: record.exitCode ?? null, signal: record.signal || null };
}
/** Read a checksummed Git maintenance journal from an explicitly selected owned control root. */
export function readGitMaintenanceStatus({ controlRoot } = {}) {
    if (!path.isAbsolute(controlRoot || '')) throw new Error('Invalid Git control root.');
    const root = realpathSync(controlRoot), metadata = lstatSync(controlRoot);
    if (root !== path.resolve(controlRoot) || !metadata.isDirectory() || metadata.isSymbolicLink()
        || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) throw new Error('Unsafe Git control root.');
    const journal = readReceipt(path.join(root, 'journal.json'));
    const { checksum, ...payload } = journal;
    if (journal.schema !== 'nassaj-source-update-maintenance/v1'
        || !['RECOVERING','OPEN','DRAINING','UPDATING','MANUAL'].includes(journal.state)
        || !Number.isSafeInteger(journal.sequence) || journal.sequence < 0
        || checksum !== sha(canonical(payload))) throw new Error('Invalid Git maintenance journal.');
    const phase = journal.phase;
    const phases = ['ARTIFACT_ACTIVATING','ARTIFACT_SWITCHED','PREPARED','SOURCE_APPLYING','SOURCE_APPLIED','INSTALLING','CLIENT_BUILT','SERVER_BUILT','VERIFIED',
        'ACTIVATION_QUEUED','RESTARTING_HANDOFF','BOOTSTRAP_CLAIMED','ACTIVE_VERIFIED','ROLLBACK_PREPARED',
        'ROLLBACK_SOURCE_APPLYING','ROLLBACK_SOURCE_APPLIED','ROLLBACK_INSTALLING','ROLLBACK_CLIENT_BUILT','ROLLBACK_SERVER_BUILT','ROLLBACK_VERIFIED'];
    if ((phase !== null && !phases.includes(phase)) || typeof journal.gateClosed !== 'boolean'
        || (journal.transactionId !== null && !/^[A-Za-z0-9_-]{16,128}$/.test(journal.transactionId || ''))) throw new Error('Invalid Git maintenance journal.');
    return { state: journal.state, phase, sequence: journal.sequence, transactionId: journal.transactionId,
        gateClosed: journal.gateClosed, observedAt: new Date().toISOString(),
        updatedAt: typeof journal.updatedAt === 'string' && Number.isFinite(Date.parse(journal.updatedAt)) ? journal.updatedAt : null,
        healthVerified: false, recoveryRequired: journal.state === 'MANUAL', automaticRetryAllowed: false };
}
function checkedPort(value) {
    const string = String(value ?? 3001);
    if (!/^[0-9]{1,5}$/.test(string) || Number(string) < 1 || Number(string) > 65535) throw new Error('Invalid server port.');
    return Number(string);
}
function runEnvironment(inspected, options) {
    const env = releaseChildEnvironment(inspected);
    // Fresh foreground mode cannot inherit another deployment's database or startup authority.
    if (options.mode === 'run') {
        for (const key of Object.keys(env)) if (key.startsWith('NASSAJ_') || ['DATABASE_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'PORT', 'SERVER_PORT'].includes(key)) delete env[key];
        Object.assign(env, releaseChildEnvironment({ ...inspected, externalEnvironment: {} }, {}));
        env.SERVER_PORT = String(checkedPort(options.port ?? inspected.externalEnvironment.SERVER_PORT));
        env.NASSAJ_NODE_INSTANCE_ID = options.nodeInstanceId;
    }
    return { ...env, DATABASE_PATH: options.mode === 'run' ? path.join(inspected.dataRoot, 'nassaj.db')
        : process.env.DATABASE_PATH || inspected.externalEnvironment.DATABASE_PATH || path.join(inspected.dataRoot, 'nassaj.db'),
        NASSAJ_DEPLOY_ROOT: inspected.deployRoot, NASSAJ_UPDATE_CONTROL_ROOT: inspected.controlRoot,
        NASSAJ_UPDATE_CAPABILITY_FILE: inspected.capabilityFile };
}
async function verifyChild(inspected, child, port, stillRunning, timeoutMs) {
    const identity = processIdentity(child.pid), deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stillRunning()) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(750) });
            const length = Number(response.headers.get('content-length'));
            if (length > 65536) throw new Error('Health response exceeds limit.');
            const reader = response.body.getReader(); let size = 0, text = '';
            try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length;
                if (size > 65536) throw new Error('Health response exceeds limit.'); text += Buffer.from(next.value).toString(); } }
            finally { await reader.cancel(); }
            const health = JSON.parse(text), manifest = inspected.manifest;
            if (response.ok && health.status === 'ok' && health.service === 'nassaj-server'
                && health.normalAdmissionReady === true && health.pid === child.pid && processAlive(identity)
                && health.serverLoadedBuildId === manifest.serverBuildId && health.clientBuildIdServed === manifest.clientBuildId
                && health.sourceVersion === manifest.version && health.serverLoadedOid === manifest.commit && stillRunning()) return identity;
        } catch { /* Transient bootstrap/port failures remain unverified until the deadline. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('runtime_health_not_verified');
}
/** Keep foreground ownership until child exit, forwarding signals and cleaning every handler. */
export async function launchSealedRelease(options = {}) {
    const fresh = options.mode === 'run';
    if (fresh) {
        const control = runControl(options.deployRoot);
        const selection = readReceipt(path.join(control, 'installer-selection.json'));
        if (!HEX40.test(selection.commit || '')) throw new Error('Fresh installer selection is missing.');
        const nodeFile = path.join(control, 'node-instance-id'), stat = lstatSync(nodeFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Unsafe node identity.');
        options = { ...options, nodeInstanceId: readFileSync(nodeFile, 'utf8').trim() };
    }
    const inspected = inspectSealedRelease(options), env = runEnvironment(inspected, options);
    if (fresh) {
        const selection = readReceipt(path.join(inspected.controlRoot, 'installer-selection.json'));
        const prepared = readReceipt(path.join(inspected.controlRoot, 'initial-bootstrap.json'));
        const generation = readReceipt(path.join(inspected.current,'runtime-generation.json'));
        const initial = generation.sealKind === 'initial-bootstrap-v1';
        if (initial) {
            if (prepared.state !== 'prepared' || prepared.generationId !== inspected.generationId
                || prepared.manifestSha256 !== inspected.manifestSha256 || prepared.expected?.commit !== selection.commit
                || prepared.expected?.assetSha256 !== selection.assetSha256 || inspected.manifest.commit !== selection.commit) throw new Error('Prepared installation identity mismatch.');
        } else {
            const journal = readReceipt(path.join(inspected.controlRoot,'maintenance','journal.json'));
            const {checksum,...payload} = journal;
            if (checksum !== sha(canonical(payload)) || journal.identity?.artifact?.nodeInstanceId !== options.nodeInstanceId
                || journal.transactionId !== inspected.generationId || journal.identity?.targetCommit !== inspected.manifest.commit
                || journal.identity?.artifact?.activationIdentitySha256 !== generation.activationIdentitySha256) throw new Error('Artifact runtime journal identity mismatch.');
            const handoff = journal.state==='UPDATING' && journal.phase==='RESTARTING_HANDOFF' && journal.gateClosed===true;
            const completed = journal.state==='OPEN' && journal.gateClosed===false
                && journal.artifactCompletion?.generationId===inspected.generationId
                && journal.artifactCompletion?.activationIdentitySha256===generation.activationIdentitySha256;
            if (!handoff && !completed) throw new Error('Artifact runtime admission is unavailable.');
        }
    }
    let lock, record, child, completion, exited = false;
    const handlers = new Map(), lockFile = path.join(inspected.controlRoot, 'run.lock');
    if (fresh) {
        record = { schema: 'nassaj-release-run/v1', attemptId: randomUUID(), state: 'starting',
            generationId: inspected.generationId, version: inspected.manifest.version, commit: inspected.manifest.commit,
            serverBuildId: inspected.manifest.serverBuildId, clientBuildId: inspected.manifest.clientBuildId,
            owner: processIdentity(), child: null, updatedAt: new Date().toISOString() };
        lock = openSync(lockFile, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        const metadata = fstatSync(lock);
        if (!metadata.isFile() || (metadata.mode & 0o077) || metadata.uid !== process.getuid()) { closeSync(lock); throw new Error('runtime_lock_unsafe'); }
        const acquired = spawnSync('/usr/bin/flock', ['-x', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock] });
        if (acquired.status !== 0) { closeSync(lock); throw new Error(acquired.error ? 'runtime_lock_unavailable' : 'runtime_lock_contended'); }
    }
    const persist = (patch) => { if (fresh) {
        record = { ...record, ...patch, updatedAt: new Date().toISOString() };
        writeRunReceipt(inspected.controlRoot, record);
    } };
    try {
        if (fresh) { ftruncateSync(lock, 0); writeFileSync(lock, JSON.stringify(record)); fsyncSync(lock); }
        persist({});
        child = spawn(process.execPath, [inspected.entry, ...(options.args ?? (fresh ? [] : process.argv.slice(2)))], { cwd: inspected.current, stdio: fresh ? ['inherit', 'inherit', 'inherit', lock] : 'inherit', env });
        completion = new Promise((resolve) => {
            child.once('error', () => { exited = true; resolve({ code: 1, failureCode: 'runtime_spawn_failed' }); });
            child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
        });
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            const handler = () => { if (!exited) child.kill(signal); };
            handlers.set(signal, handler); process.on(signal, handler);
        }
        if (fresh && child.pid) {
            persist({ child: processIdentity(child.pid) });
            try {
                await verifyChild(inspected, child, env.SERVER_PORT, () => !exited, options.healthTimeoutMs || 30000);
                persist({ state: 'verified_running', verifiedAt: new Date().toISOString() });
                options.onVerified?.({ ...record });
                if (!options.onVerified) process.stdout.write(`${JSON.stringify({ state: 'verified_running', generationId: record.generationId, version: record.version })}\n`);
            } catch {
                persist({ state: 'failed', failureCode: 'runtime_health_not_verified' });
                if (!exited) child.kill('SIGTERM');
            }
        }
        const result = await completion;
        persist({ state: record?.failureCode ? 'failed' : 'stopped', exitCode: result.code, signal: result.signal,
            ...(result.failureCode ? { state: 'failed', failureCode: result.failureCode } : {}) });
        process.exitCode = record?.failureCode ? 1 : result.code ?? (result.signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[result.signal] || 1) : 1);
        if (result.signal && !record?.failureCode) {
            for (const [signal, handler] of handlers) process.removeListener(signal, handler);
            setImmediate(() => process.kill(process.pid, result.signal));
        }
        return process.exitCode;
    } catch (error) {
        if (child && !exited) { child.kill('SIGTERM'); await completion; }
        throw error;
    } finally {
        // An unexpected callback/write failure must not release ownership of a still-live child.
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        if (lock !== undefined) closeSync(lock); // Stable inode: flock is released only after parent AND inherited child FDs close.
    }
}

/** Map failures to bounded public codes without exposing paths, environment or payloads. */
export function releaseFailureCode(error) {
    const message = String(error?.message || '');
    if (/runtime_lock_contended/.test(message)) return 'runtime_lock_contended';
    if (/runtime_health_not_verified/.test(message)) return 'runtime_health_not_verified';
    if (/root|directory|path|ENOENT/.test(message)) return 'runtime_root_invalid';
    if (/identity|seal|selection|manifest|capability|generation/i.test(message)) return 'runtime_identity_mismatch';
    if (/port/i.test(message)) return 'runtime_port_invalid';
    if (/receipt|journal/i.test(message)) return 'runtime_status_invalid';
    return 'runtime_operation_failed';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2), arg = name => argv[argv.indexOf(name) + 1];
    const mode = argv.includes('--mode') ? arg('--mode') : null;
    const deployRoot = argv.includes('--deploy-root') ? arg('--deploy-root') : process.env.NASSAJ_DEPLOY_ROOT;
    const operation = mode === 'status' ? Promise.resolve().then(() => argv.includes('--control-root') ? readGitMaintenanceStatus({ controlRoot: arg('--control-root') }) : readReleaseRunStatus({ deployRoot }))
        : mode === null || mode === 'run' ? launchSealedRelease({ deployRoot, mode, args: mode === null ? argv : [], port: argv.includes('--port') ? arg('--port') : undefined })
            : Promise.reject(new Error('Unknown launcher mode.'));
    operation.then(result => { if (mode === 'status') process.stdout.write(`${JSON.stringify(result)}\n`); }).catch((error) => {
        process.stderr.write(`${JSON.stringify({ failureCode: releaseFailureCode(error) })}\n`); process.exitCode = 1;
    });
}
