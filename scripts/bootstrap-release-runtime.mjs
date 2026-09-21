#!/usr/bin/env node
/** Prepare the first immutable release-layout generation without starting a service. */
import { createHash, randomUUID } from 'node:crypto';
import {
    chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, linkSync, mkdirSync,
    openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    extractTarGzExact, validateReleaseAssetManifest, verifyExtractedReleaseAsset,
    verifyReleaseAssetRuntimeCompatibility,
} from './lib/update-release-asset.mjs';
import { readReceipt } from './nassaj-release-launcher.mjs';
import { LOCAL_BUILD_KIND, validateLocalBuildCore, validateLocalPreparedArtifact } from './lib/local-reviewed-build-identity.mjs';
import { createHostCapability, validateHostCapability, writeHostCapability } from './lib/update-runtime-capability.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_SOURCE = path.join(ROOT, 'scripts', 'nassaj-release-launcher.mjs');
const SAFE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function syncDirectory(directory) { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function ensureRealDirectory(directory, mode = 0o700, requirePrivate = true) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: false, mode });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || (requirePrivate && (metadata.mode & 0o077) !== 0)
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error(`Bootstrap directory is unsafe: ${directory}`);
    }
    return realpathSync(directory);
}
function atomicJson(file, value) {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file); syncDirectory(path.dirname(file));
}
function installExactFile(source, target, mode) {
    const sourceMetadata = lstatSync(source);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) throw new Error('Launcher source is unsafe.');
    const bytes = readFileSync(source);
    if (existsSync(target)) {
        const metadata = lstatSync(target);
        if (!metadata.isFile() || metadata.isSymbolicLink() || !readFileSync(target).equals(bytes)) {
            throw new Error('Existing stable launcher conflicts with the reviewed launcher.');
        }
        chmodSync(target, mode); return sha(bytes);
    }
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    copyFileSync(source, temporary); chmodSync(temporary, mode);
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, target); } finally { unlinkSync(temporary); }
    syncDirectory(path.dirname(target)); return sha(bytes);
}
function checkpoint(options, journalFile, journal, phase, facts = {}) {
    options.testHooks?.beforeCheckpoint?.(phase);
    const next = { ...journal, phase, updatedAt: new Date().toISOString(), facts: { ...journal.facts, ...facts } };
    atomicJson(journalFile, next);
    options.testHooks?.afterCheckpoint?.(phase);
    return next;
}
/** Validate independently pinned operator selection before creating deployment state. */
function forwardSelection(options, manifest, detachedBytes, assetFile, detachedFile) {
    if (options.kind === LOCAL_BUILD_KIND) {
        const {build, artifact} = options.expected;
        validateLocalPreparedArtifact(artifact, build);
        if (options.profile !== 'forward' || path.basename(assetFile) !== artifact.archiveName
            || path.basename(detachedFile) !== artifact.manifestName || detachedBytes.length !== artifact.manifestSize
            || sha(detachedBytes) !== artifact.manifestSha256
            || sha(canonical(manifest.databaseContract)) !== artifact.databaseContractSha256) throw Error('Local bootstrap selection mismatch.');
        return {expectedStartupClosureSha256:artifact.startupClosureSha256};
    }
    const profile = options.profile ?? 'default';
    if (!['default', 'forward'].includes(profile)
        || (options.expected.profile !== undefined && options.expected.profile !== profile)) {
        throw new Error('Unsupported bootstrap profile.');
    }
    if (profile === 'default') {
        if (manifest.databaseContract?.schema !== 'nassaj-database-release-contract/v1') {
            throw new Error('Default bootstrap requires the v1 database contract.');
        }
        return {};
    }
    const expected = options.expected;
    const assetName = `nassaj-runtime-forward-v${expected.version}.tar.gz`;
    const detachedManifestName = 'RELEASE_ASSET_MANIFEST.forward.json';
    if (expected.profile !== profile || expected.assetName !== assetName
        || expected.detachedManifestName !== detachedManifestName
        || path.basename(assetFile) !== assetName || path.basename(detachedFile) !== detachedManifestName
        || !Number.isSafeInteger(expected.detachedManifestId) || expected.detachedManifestId <= 0
        || expected.detachedManifestId === expected.assetId
        || expected.detachedManifestSize !== detachedBytes.length
        || expected.detachedManifestSha256 !== sha(detachedBytes)
        || !HEX64.test(expected.databaseContractSha256 || '')
        || expected.databaseContractSha256 !== sha(canonical(manifest.databaseContract))
        || !HEX64.test(expected.expectedStartupClosureSha256 || '')
        || manifest.databaseContract?.schema !== 'nassaj-database-release-contract/v2') {
        throw new Error('Forward bootstrap requires exact independent profile, asset and database identities.');
    }
    return { expectedStartupClosureSha256: expected.expectedStartupClosureSha256 };
}

function generationIdentity(manifest, generationId, expected) {
    const permissionIdentity = Object.prototype.hasOwnProperty.call(manifest, 'permissionProfile') ? {
        permissionProfile: manifest.permissionProfile,
        permissionContractVersion: manifest.permissionContractVersion,
        permissionProfileDigest: manifest.permissionProfileDigest,
        permissionCapabilityDigest: manifest.permissionCapabilityDigest,
        permissionProtocolGeneration: manifest.permissionProtocolGeneration,
        minimumPermissionBuild: manifest.minimumPermissionBuild,
    } : {};
    if (expected.kind === LOCAL_BUILD_KIND) return Object.freeze({
        strategy:'release-layout-v2', updaterProtocol:2, generationId, kind:LOCAL_BUILD_KIND,
        profile:'forward', build:expected.build, artifact:expected.artifact,
        bundleManifestSha256:manifest.bundleManifestSha256, ...permissionIdentity });
    return Object.freeze({
        strategy: 'release-layout-v2', updaterProtocol: 2, generationId,
        repository: manifest.repo, releaseId: manifest.releaseId, tag: manifest.tag, version: manifest.version,
        commit: manifest.commit, assetId: expected.assetId, assetSize: expected.assetSize,
        assetSha256: expected.assetSha256, archiveSha256: expected.assetSha256, sourceTreeSha256: manifest.sourceTreeSha256,
        bundleBuildId: manifest.bundleBuildId, bundleManifestSha256: manifest.bundleManifestSha256,
        serverBuildId: manifest.serverBuildId, clientBuildId: manifest.clientBuildId,
        ...permissionIdentity,
        ...(expected.profile === 'forward' ? {
            profile: 'forward', assetName: expected.assetName,
            detachedManifestName: expected.detachedManifestName, detachedManifestId: expected.detachedManifestId,
            detachedManifestSize: expected.detachedManifestSize, detachedManifestSha256: expected.detachedManifestSha256,
            databaseContractSha256: expected.databaseContractSha256,
            expectedStartupClosureSha256: expected.expectedStartupClosureSha256,
        } : {}),
    });
}

/**
 * Idempotently prepare a first install. It never runs npm/git, starts PM2,
 * restarts a service, migrates a database, or claims an application health result.
 */
export function prepareInitialReleaseRuntime(options) {
    if (!path.isAbsolute(options?.deployRoot || '') || !SAFE_INSTANCE.test(options?.nodeInstanceId || '')) {
        throw new Error('Bootstrap deploy root or node instance id is invalid.');
    }
    const expected = options.expected;
    const local = options.kind === LOCAL_BUILD_KIND;
    if ((options.kind !== undefined && !local) || (!local && expected?.kind !== undefined)) throw Error('Unknown bootstrap identity kind.');
    if (local) {
        if (Object.keys(expected || {}).sort().join(',') !== 'artifact,build,kind' || expected.kind !== LOCAL_BUILD_KIND) throw Error('Local bootstrap expected identity mismatch.');
        validateLocalBuildCore(expected.build); validateLocalPreparedArtifact(expected.artifact,expected.build);
    }
    if (!local && (!expected || typeof expected.repo !== 'string' || !Number.isSafeInteger(expected.releaseId) || expected.releaseId <= 0
        || !Number.isSafeInteger(expected.assetId) || expected.assetId <= 0 || !Number.isSafeInteger(expected.assetSize) || expected.assetSize <= 0
        || !HEX64.test(expected.assetSha256 || '') || !HEX40.test(expected.commit || '')
        || typeof expected.tag !== 'string' || typeof expected.version !== 'string')) {
        throw new Error('Bootstrap requires a caller-pinned release and asset identity.');
    }
    const assetFile = path.resolve(options.assetFile || ''); const detachedManifestFile = path.resolve(options.manifestFile || '');
    for (const [file, label] of [[assetFile, 'asset'], [detachedManifestFile, 'manifest']]) {
        const metadata = lstatSync(file);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Bootstrap ${label} input is unsafe.`);
    }
    const detachedBytes = readFileSync(detachedManifestFile); const manifest = JSON.parse(detachedBytes);
    const verification = forwardSelection(options, manifest, detachedBytes, assetFile, detachedManifestFile);
    validateReleaseAssetManifest(manifest, expected, verification);
    verifyReleaseAssetRuntimeCompatibility(manifest, options.runtimeHost);
    const archiveBytes = readFileSync(assetFile); const archiveSha256 = sha(archiveBytes);
    if (archiveBytes.length !== (local ? expected.artifact.archiveSize : expected.assetSize) || archiveSha256 !== (local ? expected.artifact.archiveSha256 : expected.assetSha256)) {
        throw new Error('Bootstrap asset bytes do not match the caller-pinned identity.');
    }
    const generationId = local ? `local-forward-${archiveSha256}` : `${manifest.version}-${manifest.commit.slice(0, 12)}${options.profile === 'forward' ? `-forward-${archiveSha256}` : ''}`;
    if (!SAFE_GENERATION.test(generationId)) throw new Error('Bootstrap generation id is invalid.');
    const identity = generationIdentity(manifest, generationId, expected);
    const activationIdentitySha256 = sha(canonical(identity));
    if (realpathSync(path.dirname(options.deployRoot)) !== path.resolve(path.dirname(options.deployRoot))) throw new Error('Bootstrap parent path contains a symbolic link.');
    const deploy = ensureRealDirectory(options.deployRoot, 0o755, false);
    if (deploy !== path.resolve(options.deployRoot) || (lstatSync(deploy).mode & 0o022)) throw new Error('Bootstrap deploy root is unsafe.');
    const selectionFile = path.join(deploy, 'initial-selection.json');
    const initialJournal = path.join(deploy, 'control', 'initial-bootstrap.json');
    const allowed = new Set(['initial-selection.json','control','releases','launcher','config','data','current']);
    if (readdirSync(deploy).some(name => !allowed.has(name))) throw new Error('Bootstrap root contains foreign files.');
    if (existsSync(selectionFile)) {
        const metadata = lstatSync(selectionFile);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536 || (metadata.mode & 0o077)
            || metadata.uid !== process.getuid() || canonical(JSON.parse(readFileSync(selectionFile, 'utf8'))) !== canonical(expected)) {
            throw new Error('Bootstrap initial selection identity mismatch.');
        }
    } else {
        if (readdirSync(deploy).length) throw new Error('Bootstrap refuses an existing populated deployment.');
        atomicJson(selectionFile, expected);
    }
    if (existsSync(initialJournal)) {
        const metadata = lstatSync(initialJournal);
        const prior = readReceipt(initialJournal);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536 || (metadata.mode & 0o077)
            || metadata.uid !== process.getuid() || prior.schema !== 'nassaj-initial-bootstrap/v1'
            || prior.generationId !== generationId || prior.activationIdentitySha256 !== activationIdentitySha256
            || prior.archiveSha256 !== archiveSha256 || prior.manifestSha256 !== sha(detachedBytes)) throw new Error('Bootstrap journal identity mismatch.');
    }
    const releases = ensureRealDirectory(path.join(deploy, 'releases'));
    const control = ensureRealDirectory(path.join(deploy, 'control'));
    const launcherRoot = ensureRealDirectory(path.join(deploy, 'launcher'));
    const configRoot = ensureRealDirectory(path.join(deploy, 'config'));
    const dataRoot = ensureRealDirectory(path.join(deploy, 'data'));
    const device = statSync(deploy).dev;
    if ([releases, control, launcherRoot, configRoot, dataRoot].some((directory) => statSync(directory).dev !== device)) {
        throw new Error('Bootstrap release layout must stay on one filesystem.');
    }
    const externalConfig = path.join(configRoot, 'nassaj.env');
    if (!existsSync(externalConfig)) {
        const fd = openSync(externalConfig, 'wx', 0o600); try { fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(configRoot);
    } else {
        const metadata = lstatSync(externalConfig);
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
            || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
            throw new Error('Existing external release configuration is unsafe.');
        }
    }
    const journalFile = path.join(control, 'initial-bootstrap.json');
    let journal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : {
        schema: 'nassaj-initial-bootstrap/v1', state: 'preparing', phase: 'accepted', generationId,
        activationIdentitySha256, manifestSha256: sha(detachedBytes), archiveSha256,
        expected: { ...expected },
        createdAt: new Date().toISOString(), facts: {},
    };
    if (journal.schema !== 'nassaj-initial-bootstrap/v1' || journal.generationId !== generationId
        || journal.activationIdentitySha256 !== activationIdentitySha256 || journal.manifestSha256 !== sha(detachedBytes)
        || journal.archiveSha256 !== archiveSha256) throw new Error('Existing bootstrap journal belongs to another release identity.');
    if (!existsSync(journalFile)) atomicJson(journalFile, journal);
    const generation = path.join(releases, generationId); let staging = path.join(releases, `.bootstrap-${generationId}`);
    if (!existsSync(generation)) {
        if (existsSync(staging)) {
            try { verifyExtractedReleaseAsset(staging, local ? expected : manifest, verification); }
            catch {
                const quarantined = path.join(releases, `.bootstrap-failed-${generationId}-${Date.now()}`);
                renameSync(staging, quarantined); syncDirectory(releases);
                journal = checkpoint(options, journalFile, journal, 'partial-quarantined', { quarantined });
            }
        }
        if (!existsSync(staging)) {
            mkdirSync(staging, { mode: 0o700 });
            extractTarGzExact(archiveBytes, staging);
        }
        const verified = verifyExtractedReleaseAsset(staging, local ? expected : manifest, verification);
        const embeddedManifest = readFileSync(path.join(staging, 'RELEASE_ASSET_MANIFEST.json'));
        if (!embeddedManifest.equals(detachedBytes)) throw new Error('Detached and embedded release manifests differ.');
        verifyReleaseAssetRuntimeCompatibility(verified.manifest, options.runtimeHost);
        journal = checkpoint(options, journalFile, journal, 'asset-verified');
        const generationRecord = { schemaVersion: 2, state: 'sealed', sealKind: 'initial-bootstrap-v1', createdAt: new Date().toISOString(),
            identity, activationIdentitySha256 };
        atomicJson(path.join(staging, 'runtime-generation.json'), generationRecord);
        renameSync(staging, generation); syncDirectory(releases);
    }
    const verified = verifyExtractedReleaseAsset(generation, local ? expected : manifest, { ...verification, allowGenerationRecord: true });
    verifyReleaseAssetRuntimeCompatibility(verified.manifest, options.runtimeHost);
    const record = JSON.parse(readFileSync(path.join(generation, 'runtime-generation.json'), 'utf8'));
    if (record?.state !== 'sealed' || record.activationIdentitySha256 !== activationIdentitySha256
        || canonical(record.identity) !== canonical(identity)) throw new Error('Existing generation seal conflicts with bootstrap identity.');
    journal = checkpoint(options, journalFile, journal, 'generation-sealed');
    const capabilityFile = path.join(control, 'UPDATE_RUNTIME_CAPABILITY.json');
    const capability = createHostCapability({ artifactRoot: path.join(generation, 'dist-server'), projectRoot: generation,
        controlRoot: control, nodeInstanceId: options.nodeInstanceId, createdByReleaseIdentitySha256: activationIdentitySha256 });
    if (existsSync(capabilityFile)) {
        const metadata = lstatSync(capabilityFile); const existing = JSON.parse(readFileSync(capabilityFile, 'utf8'));
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
            || !validateHostCapability(existing, { projectRoot: generation, controlRoot: control, nodeInstanceId: options.nodeInstanceId })
            || canonical(existing) !== canonical(capability)) throw new Error('Existing host capability conflicts with bootstrap identity.');
    } else writeHostCapability(capabilityFile, capability);
    journal = checkpoint(options, journalFile, journal, 'capability-written');
    const launcher = path.join(launcherRoot, 'nassaj-release-launcher.mjs');
    const launcherSha256 = installExactFile(options.launcherSource || LAUNCHER_SOURCE, launcher, 0o755);
    journal = checkpoint(options, journalFile, journal, 'launcher-installed', { launcherSha256 });
    const current = path.join(deploy, 'current');
    if (existsSync(current)) {
        const metadata = lstatSync(current);
        if (!metadata.isSymbolicLink() || readlinkSync(current) !== path.posix.join('releases', generationId)
            || realpathSync(current) !== generation) throw new Error('Existing current reference conflicts with initial bootstrap.');
    } else {
        const temporary = path.join(deploy, `.current-${process.pid}-${randomUUID()}`);
        symlinkSync(path.posix.join('releases', generationId), temporary); renameSync(temporary, current); syncDirectory(deploy);
    }
    journal = checkpoint(options, journalFile, journal, 'prepared', { current: path.posix.join('releases', generationId) });
    journal = { ...journal, state: 'prepared', updatedAt: new Date().toISOString() }; atomicJson(journalFile, journal);
    return Object.freeze({ state: 'prepared_not_activated', healthVerified: false, serviceActivated: false, requiresServiceActivation: true,
        deployRoot: deploy, generationId, current, launcher, controlRoot: control, capabilityFile,
        configFile: externalConfig, dataRoot, journalFile });
}

function argument(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; }
function main() {
    const argv = process.argv.slice(2);
    const local = argument(argv,'--kind') === LOCAL_BUILD_KIND;
    if (argument(argv,'--kind') !== null && !local) throw Error('Unknown bootstrap identity kind.');
    const localExpected = local ? JSON.parse(readFileSync(argument(argv,'--expected-local-identity'),'utf8')) : null;
    if (local && ['--repo','--release-id','--asset-id','--tag','--detached-manifest-id'].some(flag => argv.includes(flag))) throw Error('Mixed bootstrap identity arguments.');
    const result = prepareInitialReleaseRuntime({ ...(local ? {kind:LOCAL_BUILD_KIND} : {}), deployRoot: argument(argv, '--deploy-root'), assetFile: argument(argv, '--asset'),
        profile: argument(argv, '--profile') || 'default',
        manifestFile: argument(argv, '--manifest'), nodeInstanceId: argument(argv, '--node-instance-id'),
        expected: local ? localExpected : { repo: argument(argv, '--repo'), releaseId: Number(argument(argv, '--release-id')),
            assetId: Number(argument(argv, '--asset-id')), tag: argument(argv, '--tag'), version: argument(argv, '--version'),
            commit: argument(argv, '--commit'), assetSize: Number(argument(argv, '--asset-size')),
            assetSha256: argument(argv, '--asset-sha256'),
            ...(argument(argv, '--profile') === 'forward' ? {
                profile: 'forward', assetName: argument(argv, '--asset-name'),
                detachedManifestName: argument(argv, '--detached-manifest-name'),
                detachedManifestId: Number(argument(argv, '--detached-manifest-id')),
                detachedManifestSize: Number(argument(argv, '--detached-manifest-size')),
                detachedManifestSha256: argument(argv, '--detached-manifest-sha256'),
                databaseContractSha256: argument(argv, '--database-contract-sha256'),
                expectedStartupClosureSha256: argument(argv, '--expected-startup-closure-sha256'),
            } : {}) },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) { console.error(`[release-bootstrap] ${error.message}`); process.exitCode = 1; }
}
