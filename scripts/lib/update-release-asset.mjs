/** Exact GitHub release asset transport and deliberately small hardened tar reader. */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
    constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { satisfies as versionSatisfies } from 'semver';
import {
    validateReleaseRuntimeCompatibility, verifyReleaseRuntimeHost,
} from './release-runtime-compatibility.mjs';
import { LOCAL_BUILD_KIND, localBuildIdentitySha256, validateLocalManifestHeader } from './local-reviewed-build-identity.mjs';
import { validatePermissionReleaseContract } from './permission-release-contract.mjs';
import { FORWARD_EXECUTABLE_ENTRIES } from './update-runtime-bundle.mjs';

export const FORWARD_EXECUTABLE_MANIFEST_PATH = 'FORWARD_EXECUTABLE_MANIFEST.json';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
export const RELEASE_ASSET_LIMITS = Object.freeze({
    archiveBytes: 384 * 1024 * 1024,
    expandedBytes: 1024 * 1024 * 1024,
    files: 20_000,
    /**
     * Ceiling for the detached RELEASE_ASSET_MANIFEST.json asset. It enumerates every
     * shipped file with its digest, so it scales with `files`, not with a fixed API
     * payload: v1.46.0.6 publishes 3.58 MiB. Sizing it against `files` keeps the bound
     * meaningful — 20_000 entries at ~600 bytes each fits inside this cap with room to
     * spare, while still refusing an unbounded download.
     */
    manifestBytes: 32 * 1024 * 1024,
    pathBytes: 512,
});
const DEFAULT_LIMITS = RELEASE_ASSET_LIMITS;
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const RELEASE_NODE_MAJOR = 24;

function currentLibc() {
    if (process.platform !== 'linux') return { family: 'none', glibcVersion: null };
    const glibcVersion = process.report?.getReport()?.header?.glibcVersionRuntime || null;
    return glibcVersion ? { family: 'glibc', glibcVersion } : { family: 'musl', glibcVersion: null };
}

function validNumericVersion(value) { return /^\d+\.\d+(?:\.\d+)?$/.test(value || ''); }
function numericVersionAtLeast(value, minimum) {
    if (!validNumericVersion(value) || !validNumericVersion(minimum)) return false;
    const left = value.split('.').map(Number); const right = minimum.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
    }
    return true;
}

export function currentReleaseRuntimeTarget() {
    const libc = currentLibc();
    return Object.freeze({ platform: process.platform, arch: process.arch, nodeModulesAbi: process.versions.modules,
        nodeVersion: process.version, nodeMajor: Number(process.versions.node.split('.')[0]),
        libcFamily: libc.family, glibcMinimum: libc.glibcVersion });
}
function nativePackageAllowed(name) {
    return ['argon2', 'bcrypt', 'better-sqlite3', 'esbuild', 'node-pty', '@openai/codex', '@vscode/ripgrep'].includes(name)
        || /^@(?:anthropic-ai\/claude-agent-sdk|openai\/codex)-/.test(name)
        || /^@vscode\/ripgrep(?:-|$)/.test(name)
        || /^@(?:esbuild|rollup)\//.test(name)
        // sharp (chat image downscaling, T-1667) ships its libvips binding as platform packages.
        || name === 'sharp' || /^@img\/sharp-/.test(name);
}

function fileLooksNative(root, file) {
    if (file.path.endsWith('.node') || /\/(?:claude|codex|rg)$/.test(file.path)) return true;
    if (!(file.mode & 0o111)) return false;
    const bytes = readFileSync(path.join(root, file.path)).subarray(0, 4);
    return (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)
        || (bytes[0] === 0x4d && bytes[1] === 0x5a)
        || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(bytes.toString('hex'));
}
export function compareReleasePaths(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function computeReleaseFileTreeSha256(files) {
    const hash = createHash('sha256');
    for (const file of files) {
        hash.update(file.path).update('\0').update(String(file.mode)).update('\0')
            .update(String(file.size)).update('\0').update(file.sha256).update('\0');
    }
    return hash.digest('hex');
}

export function selectExactReleaseAsset(release, expected) {
    if (!Number.isSafeInteger(release?.id) || release.id !== expected.releaseId || release.tag_name !== expected.tag
        || !SAFE_TAG.test(expected.tag || '') || typeof expected.name !== 'string') throw new Error('Release identity mismatch.');
    const matches = (release.assets || []).filter((asset) => asset?.name === expected.name);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].state !== 'uploaded') {
        throw new Error('Exact release asset is absent, duplicate, or not uploaded.');
    }
    if (!Number.isSafeInteger(expected.assetId) || matches[0].id !== expected.assetId) throw new Error('Exact release asset id mismatch.');
    return Object.freeze({ releaseId: release.id, assetId: matches[0].id, name: expected.name, size: matches[0].size });
}

async function responseBytes(response, limit) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) throw new Error('Release asset exceeds the archive size limit.');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > limit) throw new Error('Release asset exceeds the archive size limit.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

/** Download an identity-pinned public release asset, stripping headers on redirects. */
export async function downloadExactGithubAsset({ repo, assetId, expectedSha256, expectedSize, fetchImpl = fetch, maxBytes = DEFAULT_LIMITS.archiveBytes }) {
    if (!SAFE_REPO.test(repo || '') || !Number.isSafeInteger(assetId) || assetId <= 0
        || !SHA256.test(expectedSha256 || '') || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes) {
        throw new Error('GitHub asset download identity is invalid.');
    }
    let url = new URL(`https://api.github.com/repos/${repo}/releases/assets/${assetId}`);
    let headers = { Accept: 'application/octet-stream', 'User-Agent': 'nassaj-updater-v2' };
    for (let hop = 0; hop <= 3; hop += 1) {
        const response = await fetchImpl(url, { redirect: 'manual', headers });
        if (response.status >= 300 && response.status < 400) {
            if (hop === 3) throw new Error('GitHub asset redirect limit exceeded.');
            const location = response.headers.get('location');
            if (!location) throw new Error('GitHub asset redirect is missing Location.');
            const next = new URL(location, url);
            if (next.protocol !== 'https:' || next.username || next.password) throw new Error('GitHub asset redirect target is unsafe.');
            url = next;
            headers = { Accept: 'application/octet-stream', 'User-Agent': 'nassaj-updater-v2' };
            continue;
        }
        if (!response.ok) throw new Error(`GitHub asset download failed (${response.status}).`);
        const bytes = await responseBytes(response, maxBytes);
        if (bytes.length !== expectedSize || sha(bytes) !== expectedSha256) throw new Error('GitHub asset bytes do not match the exact release manifest.');
        return bytes;
    }
    throw new Error('GitHub asset download failed.');
}

function tarString(buffer) { return buffer.subarray(0, buffer.indexOf(0) < 0 ? buffer.length : buffer.indexOf(0)).toString('utf8'); }
function tarNumber(buffer) {
    const value = tarString(buffer).trim();
    if (!/^[0-7]*$/.test(value)) throw new Error('Archive numeric field is invalid.');
    return value ? Number.parseInt(value, 8) : 0;
}
function safeArchivePath(name, limits) {
    if (!name || Buffer.byteLength(name) > limits.pathBytes || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)) {
        throw new Error('Archive path is invalid.');
    }
    const normalized = path.posix.normalize(name).replace(/^\.\//, '');
    if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized !== name.replace(/\/$/, '')) {
        throw new Error('Archive path escapes or is non-canonical.');
    }
    return normalized;
}

export function inspectTarGz(bytes, overrides = {}) {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    if (!Buffer.isBuffer(bytes) || bytes.length > limits.archiveBytes) throw new Error('Archive bytes are invalid or oversized.');
    let tar;
    try { tar = gunzipSync(bytes, { maxOutputLength: limits.expandedBytes + 1024 }); }
    catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Archive expands beyond its byte limit.');
        throw error;
    }
    if (tar.length > limits.expandedBytes) throw new Error('Archive expands beyond its byte limit.');
    const entries = [];
    const names = new Set();
    let offset = 0;
    let total = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const storedChecksum = tarNumber(header.subarray(148, 156));
        let checksum = 0;
        for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
        if (checksum !== storedChecksum) throw new Error('Archive header checksum mismatch.');
        const prefix = tarString(header.subarray(345, 500));
        const rawName = `${prefix ? `${prefix}/` : ''}${tarString(header.subarray(0, 100))}`;
        const name = safeArchivePath(rawName.replace(/\/$/, ''), limits);
        if (names.has(name)) throw new Error(`Archive contains a duplicate path: ${name}`);
        names.add(name);
        const size = tarNumber(header.subarray(124, 136));
        const mode = tarNumber(header.subarray(100, 108)) & 0o777;
        const type = String.fromCharCode(header[156] || 48);
        if (!['0', '5'].includes(type)) throw new Error(`Archive entry type is forbidden: ${name}`);
        if (type === '5' && size !== 0) throw new Error('Archive directory has content bytes.');
        if (entries.length >= limits.files || total + size > limits.expandedBytes) throw new Error('Archive entry limits exceeded.');
        const contentOffset = offset + 512;
        if (contentOffset + size > tar.length) throw new Error('Archive entry is truncated.');
        entries.push({ name, type: type === '5' ? 'directory' : 'file', mode, size, sha256: type === '0' ? sha(tar.subarray(contentOffset, contentOffset + size)) : null, contentOffset });
        total += size;
        offset = contentOffset + Math.ceil(size / 512) * 512;
    }
    if (!tar.subarray(offset).every((byte) => byte === 0)) throw new Error('Archive has unparsed trailing bytes.');
    return Object.freeze({ tar, entries, totalBytes: total });
}

/** Extract without invoking tar: links, devices, traversal and overwrite are impossible. */
export function extractTarGzExact(bytes, destination, limits = {}) {
    const rootStat = lstatSync(destination);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) || readdirSync(destination).length !== 0) {
        throw new Error('Archive destination must be a new empty owner-only directory.');
    }
    const root = path.resolve(destination);
    const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedRoot = fstatSync(rootFd);
    if (openedRoot.dev !== rootStat.dev || openedRoot.ino !== rootStat.ino) {
        closeSync(rootFd);
        throw new Error('Archive destination identity changed before extraction.');
    }
    const { testHooks, ...archiveLimits } = limits;
    const inspected = inspectTarGz(bytes, archiveLimits);
    const openDirectoryChain = (relative, create, invokeHooks = false) => {
        const descriptors = [];
        const identities = [];
        let parentFd = rootFd;
        try {
            for (const segment of relative.split('/').filter(Boolean)) {
                const candidate = path.join('/proc/self/fd', String(parentFd), segment);
                if (create) {
                    try { mkdirSync(candidate, { recursive: false, mode: 0o755 }); }
                    catch (error) { if (error?.code !== 'EEXIST') throw error; }
                }
                if (invokeHooks) testHooks?.beforeDirectoryOpen?.({ relative, segment, parentFd, candidate });
                const fd = openSync(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                const metadata = fstatSync(fd);
                if (!metadata.isDirectory() || metadata.dev !== openedRoot.dev
                    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
                    closeSync(fd);
                    throw new Error('Archive parent directory descriptor is unsafe.');
                }
                descriptors.push(fd); identities.push({ dev: metadata.dev, ino: metadata.ino, uid: metadata.uid });
                parentFd = fd;
            }
            return { descriptors, identities, parentFd };
        } catch (error) {
            for (const fd of descriptors.reverse()) closeSync(fd);
            throw error;
        }
    };
    const closeChain = (chain) => { for (const fd of [...chain.descriptors].reverse()) closeSync(fd); };
    const assertChainStillReachable = (relative, expected) => {
        const observed = openDirectoryChain(relative, false, false);
        try {
            if (JSON.stringify(observed.identities) !== JSON.stringify(expected.identities)) {
                throw new Error('Archive parent chain changed during extraction.');
            }
        } finally { closeChain(observed); }
    };
    try {
        for (const entry of inspected.entries.filter((item) => item.type === 'directory')) {
            const chain = openDirectoryChain(entry.name, true, true);
            closeChain(chain);
        }
        for (const entry of inspected.entries.filter((item) => item.type === 'file')) {
            const parent = path.posix.dirname(entry.name) === '.' ? '' : path.posix.dirname(entry.name);
            const chain = openDirectoryChain(parent, true, true);
            const target = path.join('/proc/self/fd', String(chain.parentFd), path.posix.basename(entry.name));
            const mode = entry.mode & 0o111 ? 0o755 : 0o644;
            try {
                testHooks?.beforeLeafOpen?.({ entry: entry.name, parentFd: chain.parentFd, target });
                const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
                let identity;
                try {
                    identity = fstatSync(fd);
                    if (!identity.isFile() || identity.dev !== openedRoot.dev) throw new Error('Archive leaf descriptor is unsafe.');
                    writeFileSync(fd, inspected.tar.subarray(entry.contentOffset, entry.contentOffset + entry.size));
                    fchmodSync(fd, mode);
                } finally { closeSync(fd); }
                assertChainStillReachable(parent, chain);
                const observedFd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const observed = fstatSync(observedFd);
                    if (observed.dev !== identity.dev || observed.ino !== identity.ino) throw new Error('Archive leaf changed during extraction.');
                } finally { closeSync(observedFd); }
            } finally { closeChain(chain); }
        }
        const finalRoot = lstatSync(root);
        if (finalRoot.isSymbolicLink() || finalRoot.dev !== openedRoot.dev || finalRoot.ino !== openedRoot.ino) {
            throw new Error('Archive destination identity changed during extraction.');
        }
    } finally { closeSync(rootFd); }
    return inspected.entries.map(({ contentOffset: _, ...entry }) => entry);
}

/** Validate v2 against independently supplied release and startup-closure expectations. */
export function validateCompatibleForwardDatabaseContract(contract, expectedReleaseIdentity, expectedStartupClosureSha256) {
    const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === expected.split(',').sort().join(',');
    const state = (value) => keys(value, 'schemaDigest,compatibilityShapeDigest,migrationStateDigest')
        && Object.values(value).every(digest => typeof digest === 'string' && SHA256.test(digest));
    if (!keys(contract, 'schema,releaseIdentitySha256,migrationEntrySha256,migrationClosureSha256,migrationClosure,activationPolicy,failurePolicy,databasePolicy,migrationId,observationPolicy,source,target,startup')
        || contract.schema !== 'nassaj-database-release-contract/v2'
        || !SHA256.test(expectedReleaseIdentity || '') || contract.releaseIdentitySha256 !== expectedReleaseIdentity
        || !SHA256.test(contract.migrationEntrySha256 || '') || !SHA256.test(contract.migrationClosureSha256 || '')
        || !keys(contract.migrationClosure, 'schema,assetManifestBound,sha256')
        || contract.migrationClosure?.schema !== 'nassaj-database-migration-closure/v2'
        || contract.migrationClosure?.assetManifestBound !== true
        || contract.migrationClosure?.sha256 !== contract.migrationClosureSha256
        || contract.activationPolicy !== 'compatible-forward'
        || contract.failurePolicy !== 'maintenance-preserve-current-db'
        || contract.databasePolicy !== 'existing-inode-no-restore'
        || contract.migrationId !== 'permission-receipt-forward/v1'
        || contract.observationPolicy !== 'permission-receipt-metadata/v1'
        || !state(contract.source) || !state(contract.target)
        || contract.source.schemaDigest === contract.target.schemaDigest
        || !keys(contract.startup, 'policyId,closureSha256')
        || contract.startup.policyId !== 'existing-security-state/v1'
        || !SHA256.test(expectedStartupClosureSha256 || '')
        || contract.startup.closureSha256 !== expectedStartupClosureSha256) {
        throw new Error('database_release_contract_invalid');
    }
    return Object.freeze({ ...contract, source: Object.freeze({ ...contract.source }),
        target: Object.freeze({ ...contract.target }), startup: Object.freeze({ ...contract.startup }),
        migrationClosure: Object.freeze({ ...contract.migrationClosure }) });
}

export function validateReleaseAssetManifest(value, expected, injected = {}) {
    const local = expected?.kind === LOCAL_BUILD_KIND;
    if (local) {
        const build = validateLocalManifestHeader(value, expected);
        value = { ...value, ...build };
    } else if (value?.schema !== undefined || value?.build !== undefined || expected?.kind !== undefined) {
        throw new Error('Release asset manifest identity kind mismatch.');
    }
    const githubIdentityValid = local || (value?.schemaVersion === 2 && value.updaterProtocol === 2
        && value.repo === expected.repo && value.releaseId === expected.releaseId && value.tag === expected.tag
        && value.version === expected.version && value.commit === expected.commit && SAFE_REPO.test(value.repo || '')
        && SHA40.test(value.commit || '') && RELEASE_VERSION.test(value.version || '')
        && value.tag === `v${value.version}` && SAFE_TAG.test(value.tag || ''));
    const hasBinAttestation = Object.prototype.hasOwnProperty.call(value || {}, 'npmBinLinksExcluded');
    const npmBinLinksExcluded = hasBinAttestation ? value.npmBinLinksExcluded
        : { count: 0, sha256: sha(Buffer.alloc(0)), records: [] };
    const runtime = injected.runtimeTarget || currentReleaseRuntimeTarget();
    const target = value?.targetRuntime;
    const closureSchema = value?.runtimeClosure?.schemaVersion;
    const closureRoots = value?.runtimeClosure?.roots;
    const clientToolchainRoots = value?.runtimeClosure?.clientToolchainRoots;
    const validRoots = (roots, allowEmpty) => Array.isArray(roots) && (allowEmpty || roots.length > 0)
        && roots.length <= DEFAULT_LIMITS.files
        && roots.every((root, index) => SAFE_PACKAGE.test(root)
            && (index === 0 || compareReleasePaths(root, roots[index - 1]) > 0));
    const rootsCompatible = closureSchema === 1
        || (closureSchema === 2 && validRoots(closureRoots, false) && validRoots(clientToolchainRoots, true));
    const runtimeCompatible = target?.platform === runtime.platform && target?.arch === runtime.arch
        && target?.nodeModulesAbi === runtime.nodeModulesAbi && target?.nodeMajor === RELEASE_NODE_MAJOR
        && runtime.nodeMajor === target.nodeMajor && /^v24\.\d+\.\d+(?:-.+)?$/.test(target?.nodeVersion || '')
        && target?.libcFamily === runtime.libcFamily
        && (target.libcFamily !== 'glibc' || (validNumericVersion(target.glibcMinimum)
            && numericVersionAtLeast(runtime.glibcMinimum, target.glibcMinimum)))
        && (target.libcFamily === 'glibc' || target.glibcMinimum === null);
    if (!githubIdentityValid
        || !SHA256.test(value.bundleBuildId || '')
        || !SHA256.test(value.bundleManifestSha256 || '')
        || !SHA256.test(value.sourceTreeSha256 || '') || !SHA256.test(value.serverBuildId || '')
        || !SHA256.test(value.clientBuildId || '')
        || !runtimeCompatible
        || ![1, 2].includes(closureSchema) || !rootsCompatible || !Array.isArray(value.runtimeClosure?.packages)
        || value.runtimeClosure.packages.length === 0 || !SHA256.test(value.runtimeClosure?.sha256 || '')
        || !Array.isArray(value.files) || value.files.length > DEFAULT_LIMITS.files
        || !Number.isSafeInteger(npmBinLinksExcluded?.count) || npmBinLinksExcluded.count < 0
        || npmBinLinksExcluded.count > DEFAULT_LIMITS.files || !SHA256.test(npmBinLinksExcluded?.sha256 || '')
        || !Array.isArray(npmBinLinksExcluded?.records) || npmBinLinksExcluded.records.length > DEFAULT_LIMITS.files
        || npmBinLinksExcluded.records.length !== npmBinLinksExcluded.count) throw new Error('Release asset manifest identity mismatch.');
    validatePermissionReleaseContract(value);
    const databaseIdentity = local ? localBuildIdentitySha256(value.build) : sha(Buffer.from(canonical({ repo: value.repo, releaseId: value.releaseId, tag: value.tag,
        version: value.version, commit: value.commit, serverBuildId: value.serverBuildId,
        clientBuildId: value.clientBuildId, bundleBuildId: value.bundleBuildId })));
    const database = value.databaseContract;
    if (local && database?.schema !== 'nassaj-database-release-contract/v2') throw Error('Local manifest requires forward contract.');
    if (database?.schema === 'nassaj-database-release-contract/v2') {
        validateCompatibleForwardDatabaseContract(database, databaseIdentity, injected.expectedStartupClosureSha256);
    } else if (database?.schema !== 'nassaj-database-release-contract/v1'
        || ['activationPolicy', 'failurePolicy', 'databasePolicy', 'migrationId', 'observationPolicy', 'source', 'target', 'startup'].some(key => Object.hasOwn(database, key)) || database.releaseIdentitySha256 !== databaseIdentity
        || !SHA256.test(database.migrationEntrySha256 || '') || !SHA256.test(database.migrationClosureSha256 || '')
        || database.migrationClosure?.schema !== 'nassaj-database-migration-closure/v2'
        || database.migrationClosure?.assetManifestBound !== true
        || database.migrationClosure?.sha256 !== database.migrationClosureSha256
        || !SHA256.test(database.targetSchemaDigest || '') || !SHA256.test(database.targetCompatibilityShapeDigest || '')
        || !SHA256.test(database.preservationPolicySha256 || '')
        || !Array.isArray(database.targetMigrationStateDigests) || database.targetMigrationStateDigests.length < 1
        || database.targetMigrationStateDigests.some((state, index, states) => !SHA256.test(state)
            || (index > 0 && states[index - 1] >= state))
        || !Array.isArray(database.acceptedPredecessors)
        || database.acceptedPredecessors.length < 1 || database.acceptedPredecessors.length > 8
        || database.acceptedPredecessors.some((entry, index, entries) => Object.keys(entry || {}).sort().join(',') !== 'allowedMigrationStateDigests,compatibilityShapeDigest,schemaDigest'
            || !SHA256.test(entry.schemaDigest || '') || !SHA256.test(entry.compatibilityShapeDigest || '')
            || !Array.isArray(entry.allowedMigrationStateDigests) || entry.allowedMigrationStateDigests.length < 1
            || entry.allowedMigrationStateDigests.length > 64
            || entry.allowedMigrationStateDigests.some((state, stateIndex, states) => !SHA256.test(state)
                || (stateIndex > 0 && states[stateIndex - 1] >= state))
            || (index > 0 && `${entries[index - 1].schemaDigest}:${entries[index - 1].compatibilityShapeDigest}`
                >= `${entry.schemaDigest}:${entry.compatibilityShapeDigest}`))
        || !Number.isSafeInteger(database.schemaVersion) || database.schemaVersion < 1
        || !Number.isSafeInteger(database.minimumReadableSchemaVersion) || database.minimumReadableSchemaVersion < 1
        || database.minimumReadableSchemaVersion > database.schemaVersion || database.previousReleasePolicy !== 'restore_required'
        || database.rehearsalRequired !== true) throw new Error('Release database contract identity mismatch.');
    let priorBin = '';
    const binHash = createHash('sha256');
    for (const record of npmBinLinksExcluded.records) {
        const link = typeof record?.link === 'string' ? safeArchivePath(record.link, DEFAULT_LIMITS) : '';
        const target = typeof record?.target === 'string' ? safeArchivePath(record.target, DEFAULT_LIMITS) : '';
        const segments = [...link.split('/'), ...target.split('/')];
        const farmMarker = link.lastIndexOf('/.bin/');
        const base = farmMarker > 0 ? link.slice(0, farmMarker) : '';
        const packageRoot = typeof record?.package === 'string' && SAFE_PACKAGE.test(record.package)
            ? `${base}/${record.package}` : '';
        if (!/^node_modules\/(?:.+\/node_modules\/)?\.bin\/[^/]+$/.test(link)
            || (priorBin && compareReleasePaths(record.link, priorBin) <= 0)
            || segments.some((segment) => !segment || segment === '.' || segment === '..' || Buffer.byteLength(segment) > 128)
            || path.posix.basename(base) !== 'node_modules' || !packageRoot
            || !target.startsWith(`${packageRoot}/`) || target.split('/').includes('.bin')) {
            throw new Error('Release asset npm bin-link attestation is invalid.');
        }
        priorBin = record.link;
        binHash.update(record.link).update('\0').update(record.package).update('\0').update(record.target).update('\0');
    }
    if (binHash.digest('hex') !== npmBinLinksExcluded.sha256) throw new Error('Release asset npm bin-link attestation mismatch.');
    validateReleaseRuntimeCompatibility(value.runtimeCompatibility);
    let prior = '';
    for (const file of value.files) {
        const name = safeArchivePath(file?.path, DEFAULT_LIMITS);
        if (name <= prior || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777
            || !Number.isSafeInteger(file.size) || file.size < 0 || !SHA256.test(file.sha256 || '')) {
            throw new Error('Release asset manifest file tree is invalid.');
        }
        prior = name;
    }
    if (computeReleaseFileTreeSha256(value.files) !== value.sourceTreeSha256) throw new Error('Release asset source tree fingerprint mismatch.');
    const closureHash = createHash('sha256');
    let priorPackage = '';
    for (const entry of value.runtimeClosure.packages) {
        const packagePath = safeArchivePath(entry?.path, DEFAULT_LIMITS);
        if (!packagePath.startsWith('node_modules/') || packagePath <= priorPackage
            || !SAFE_PACKAGE.test(entry?.name || '') || !SAFE_PACKAGE.test(entry?.resolvedName || '')
            || typeof entry.version !== 'string' || !entry.version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || '')
            || (entry.enginesNode !== null && typeof entry.enginesNode !== 'string')
            || (entry.os !== null && !Array.isArray(entry.os)) || (entry.cpu !== null && !Array.isArray(entry.cpu))
            || (entry.libc !== null && !Array.isArray(entry.libc)) || typeof entry.native !== 'boolean'
            || (entry.native && (!nativePackageAllowed(entry.name) || !nativePackageAllowed(entry.resolvedName)))
            || !SHA256.test(entry?.packageJsonSha256 || '')) {
            throw new Error('Release runtime dependency closure is invalid.');
        }
        if (entry.enginesNode && !versionSatisfies(runtime.nodeVersion, entry.enginesNode, { includePrerelease: true })) {
            throw new Error('Release runtime Node engine mismatch.');
        }
        priorPackage = packagePath;
        closureHash.update(packagePath).update('\0').update(entry.name).update('\0').update(entry.resolvedName).update('\0')
            .update(entry.version).update('\0').update(entry.integrity).update('\0')
            .update(JSON.stringify([entry.enginesNode, entry.os, entry.cpu, entry.libc, entry.native])).update('\0')
            .update(entry.packageJsonSha256).update('\0');
    }
    if (closureHash.digest('hex') !== value.runtimeClosure.sha256) {
        throw new Error('Release runtime dependency closure digest mismatch.');
    }
    if (closureSchema === 2) {
        const names = new Set(value.runtimeClosure.packages.map((entry) => entry.name));
        if (closureRoots.some((root) => !names.has(root))
            || clientToolchainRoots.some((root) => !closureRoots.includes(root))) {
            throw new Error('Release runtime dependency roots are not bound to the closure.');
        }
    }
    return true;
}

/** Bind an already validated release manifest to the host before extraction or launch. */
export function verifyReleaseAssetRuntimeCompatibility(manifest, host) {
    validateReleaseRuntimeCompatibility(manifest?.runtimeCompatibility);
    return verifyReleaseRuntimeHost(manifest.runtimeCompatibility, host);
}

/** Reconcile a crash-complete extraction without deleting or overwriting any byte. */
/** Verify startup material against an independent pin and an already measured extracted file tree. */
export function validateExtractedStartupMaterial(material, expectedSha256, actualFiles) {
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === keys;
    if (!exact(material, 'files,modePolicy,profileId,roots,schema')
        || material.schema !== 'nassaj-startup-closure/v1' || material.profileId !== 'local-forward-349/v2'
        || material.modePolicy !== 'release-file-mode-normalization/v1'
        || !SHA256.test(expectedSha256 || '') || sha(Buffer.from(canonical(material))) !== expectedSha256
        || !Array.isArray(material.roots) || !material.roots.length || material.roots.length > DEFAULT_LIMITS.files
        || !Array.isArray(material.files) || !material.files.length || material.files.length > DEFAULT_LIMITS.files) {
        throw new Error('Forward startup material identity mismatch.');
    }
    const measured = new Map(actualFiles.map(file => [file.path, file])); const included = new Set();
    let previous = '';
    for (const record of material.files) {
        if (!exact(record, 'mode,path,sha256,size') || typeof record.path !== 'string'
            || !/^(dist-server|node_modules)\//.test(record.path) || safeArchivePath(record.path, DEFAULT_LIMITS) !== record.path
            || record.path <= previous || ![0o644, 0o755].includes(record.mode)
            || !Number.isSafeInteger(record.size) || record.size < 0 || !SHA256.test(record.sha256 || '')
            || /(?:^|\/)(?:STARTUP_CLOSURE|BUILD_PROVENANCE|RELEASE_ASSET_MANIFEST)\.json$/.test(record.path)) {
            throw new Error('Forward startup material records are invalid.');
        }
        const actual = measured.get(record.path);
        if (!actual || actual.mode !== record.mode || actual.size !== record.size || actual.sha256 !== record.sha256) {
            throw new Error('Forward startup extracted bytes or modes mismatch.');
        }
        included.add(record.path); previous = record.path;
    }
    previous = '';
    for (const root of material.roots) {
        if (typeof root !== 'string' || root <= previous || !included.has(root)) throw new Error('Forward startup roots are invalid.');
        previous = root;
    }
    for (const mandatory of ['dist-server/server/bootstrap.js', 'dist-server/server/bootstrap-release-profile.js',
        'dist-server/server/bootstrap-startup-context.js']) {
        if (!material.roots.includes(mandatory)) throw new Error('Forward startup mandatory root is absent.');
    }
    return material;
}

function readForwardExecutableRecord(root, record, retainBytes = false) {
    const file = path.join(root, record.path), before = lstatSync(file);
    if (realpathSync(file) !== file || !before.isFile() || before.isSymbolicLink()
        || before.mode & 0o022 || (before.mode & 0o777) !== record.mode || before.size !== record.size) {
        throw Error('Forward executable file metadata mismatch.');
    }
    const same = value => ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs']
        .every(key => value[key] === before[key]);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        if (!same(fstatSync(fd))) throw Error('Forward executable file changed.');
        const hash = createHash('sha256'), chunks = [], chunk = Buffer.alloc(65536);
        let total = 0, count;
        while ((count = readSync(fd, chunk, 0, Math.min(chunk.length, record.size + 1 - total), null))) {
            total += count;
            if (total > record.size) throw Error('Forward executable file grew.');
            hash.update(chunk.subarray(0, count));
            if (retainBytes) chunks.push(Buffer.from(chunk.subarray(0, count)));
        }
        if (total !== record.size || hash.digest('hex') !== record.sha256
            || !same(fstatSync(fd)) || !same(lstatSync(file)) || realpathSync(file) !== file) {
            throw Error('Forward executable file bytes changed.');
        }
        return retainBytes ? Buffer.concat(chunks, total) : undefined;
    } finally { closeSync(fd); }
}

/** Verify the build-time AST inventory against an independently authenticated release manifest and disk. */
export function verifyForwardExecutableManifest(directory, releaseManifest) {
    const root = path.resolve(directory), exact = (value, keys) => value && typeof value === 'object'
        && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()
        || releaseManifest?.databaseContract?.schema !== 'nassaj-database-release-contract/v2'
        || !Array.isArray(releaseManifest.files) || releaseManifest.files.length > DEFAULT_LIMITS.files) {
        throw Error('Forward executable release binding is invalid.');
    }
    const measured = new Map(releaseManifest.files.map(record => [record.path, record]));
    const anchor = measured.get(FORWARD_EXECUTABLE_MANIFEST_PATH);
    if (measured.size !== releaseManifest.files.length || !exact(anchor, 'mode,path,sha256,size')
        || anchor.mode !== 0o644 || !Number.isSafeInteger(anchor.size) || anchor.size < 1
        || anchor.size > DEFAULT_LIMITS.manifestBytes || !SHA256.test(anchor.sha256 || '')) {
        throw Error('Forward executable manifest anchor is absent or invalid.');
    }
    const material = JSON.parse(readForwardExecutableRecord(root, anchor, true));
    const roots = [...FORWARD_EXECUTABLE_ENTRIES].sort(compareReleasePaths);
    if (!exact(material, 'files,roots,schema') || material.schema !== 'nassaj-forward-executable-files/v1'
        || JSON.stringify(material.roots) !== JSON.stringify(roots) || !Array.isArray(material.files)
        || material.files.length < roots.length || material.files.length > DEFAULT_LIMITS.files) {
        throw Error('Forward executable manifest shape or roots mismatch.');
    }
    let previous = '';
    for (const record of material.files) {
        if (!exact(record, 'mode,path,sha256,size') || typeof record.path !== 'string'
            || !record.path.startsWith('scripts/') || safeArchivePath(record.path, DEFAULT_LIMITS) !== record.path
            || record.path <= previous || ![0o644, 0o755].includes(record.mode)
            || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > DEFAULT_LIMITS.expandedBytes
            || !SHA256.test(record.sha256 || '')) throw Error('Forward executable manifest record is invalid.');
        const actual = measured.get(record.path);
        if (!exact(actual, 'mode,path,sha256,size') || ['mode', 'size', 'sha256'].some(key => actual[key] !== record[key])) {
            throw Error('Forward executable manifest release file mismatch.');
        }
        readForwardExecutableRecord(root, record); previous = record.path;
    }
    const included = new Set(material.files.map(record => record.path));
    if (roots.some(entry => !included.has(entry))) throw Error('Forward executable mandatory root is absent.');
    return material;
}

export function verifyExtractedReleaseAsset(directory, expected, injected = {}) {
    const root = path.resolve(directory);
    const rootMetadata = lstatSync(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && rootMetadata.uid !== process.getuid())) throw new Error('Extracted release root is unsafe.');
    const manifest = JSON.parse(readFileSync(path.join(root, 'RELEASE_ASSET_MANIFEST.json'), 'utf8'));
    const runtime = injected.runtimeTarget || currentReleaseRuntimeTarget();
    validateReleaseAssetManifest(manifest, expected, { runtimeTarget: runtime,
        expectedStartupClosureSha256: injected.expectedStartupClosureSha256 });
    const files = [];
    const walk = (directoryPath) => {
        for (const entry of readdirSync(directoryPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(directoryPath, entry.name);
            const metadata = lstatSync(absolute);
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            if (metadata.isSymbolicLink()) throw new Error('Extracted release contains a symlink.');
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile() && relative !== 'RELEASE_ASSET_MANIFEST.json'
                && !(injected.allowGenerationRecord && relative === 'runtime-generation.json')) {
                const bytes = readFileSync(absolute);
                files.push({ path: relative, mode: metadata.mode & 0o777, size: bytes.length, sha256: sha(bytes) });
            } else if (!entry.isFile()) throw new Error('Extracted release contains a special file.');
        }
    };
    walk(root);
    if (injected.allowGenerationRecord) {
        const record = lstatSync(path.join(root, 'runtime-generation.json'));
        if (!record.isFile() || record.isSymbolicLink() || (record.mode & 0o077) !== 0) {
            throw new Error('Extracted release generation record is unsafe.');
        }
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('Extracted release tree does not match its manifest.');
    if (computeReleaseFileTreeSha256(files) !== (manifest.build?.sourceTreeSha256 ?? manifest.sourceTreeSha256)) throw new Error('Extracted release source tree fingerprint mismatch.');
    const fileMap = new Map(files.map((entry) => [entry.path, entry]));
    if (expected?.kind === LOCAL_BUILD_KIND) {
        const input = fileMap.get('dist-server/SERVER_INPUT_MANIFEST.json');
        if (!input || input.sha256 !== manifest.build.inputManifestSha256) throw Error('Local server input manifest mismatch.');
        for (const [directory,key] of [['dist-server','serverBuildId'],['dist','clientBuildId']]) {
            const provenance=JSON.parse(readFileSync(path.join(root,directory,'BUILD_PROVENANCE.json'),'utf8'));
            if (provenance.commit!==manifest.build.commit || provenance.version!==manifest.build.version
                || provenance.buildId!==manifest.build[key]) throw Error('Local extracted provenance mismatch.');
        }
    }
    if (manifest.databaseContract?.schema === 'nassaj-database-release-contract/v2') {
        verifyForwardExecutableManifest(root, manifest);
        const startupFile = fileMap.get('dist-server/STARTUP_CLOSURE.json');
        if (!startupFile || startupFile.size > DEFAULT_LIMITS.manifestBytes) throw new Error('Forward startup material is absent or oversized.');
        const material = JSON.parse(readFileSync(path.join(root, startupFile.path), 'utf8'));
        validateExtractedStartupMaterial(material, injected.expectedStartupClosureSha256, files);
    }
    const lockFile = fileMap.get('package-lock.json');
    if (!lockFile) throw new Error('Extracted release package-lock is absent.');
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    for (const entry of manifest.runtimeClosure.packages) {
        const packageJson = fileMap.get(`${entry.path}/package.json`);
        const locked = lock.packages?.[entry.path];
        if (!packageJson || packageJson.sha256 !== entry.packageJsonSha256 || !locked
            || locked.version !== entry.version || (locked.name && locked.name !== entry.resolvedName)
            || locked.integrity !== entry.integrity) {
            throw new Error('Extracted release runtime closure package mismatch.');
        }
        if (entry.enginesNode && !versionSatisfies(runtime.nodeVersion, entry.enginesNode, { includePrerelease: true })) {
            throw new Error('Extracted release runtime Node engine mismatch.');
        }
        const packageManifest = JSON.parse(readFileSync(path.join(root, entry.path, 'package.json'), 'utf8'));
        if (packageManifest.name !== entry.resolvedName || packageManifest.version !== entry.version) {
            throw new Error('Extracted release runtime package identity mismatch.');
        }
        const nativeObserved = files.some((file) => file.path.startsWith(`${entry.path}/`) && fileLooksNative(root, file));
        if (nativeObserved !== entry.native) throw new Error('Extracted release native package attestation mismatch.');
    }
    for (const file of files.filter((entry) => entry.path.startsWith('node_modules/'))) {
        if (!manifest.runtimeClosure.packages.some((entry) => file.path.startsWith(`${entry.path}/`))) {
            throw new Error('Extracted release contains a package outside its runtime closure.');
        }
    }
    const bundleBytes = readFileSync(path.join(root, 'dist-server', 'UPDATE_RUNTIME_MANIFEST.json'));
    if (sha(bundleBytes) !== manifest.bundleManifestSha256 || JSON.parse(bundleBytes).buildId !== (manifest.build?.bundleBuildId ?? manifest.bundleBuildId)) {
        throw new Error('Extracted release runtime bundle identity mismatch.');
    }
    return Object.freeze({ manifest, files });
}
