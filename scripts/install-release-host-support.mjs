#!/usr/bin/env node
/** Idempotently install and attest the fixed root-side release support files. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
    readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectTarGz, verifyExtractedReleaseAsset, verifyForwardExecutableManifest, RELEASE_ASSET_LIMITS } from './lib/update-release-asset.mjs';
import { generateStartupPublicDescriptor } from './lib/release-runtime-public-descriptor.mjs';
import { validateFirstForwardPlans } from './lib/release-runtime-forward-plan-validation.mjs';
import { assertForwardServicePolicy } from './lib/release-runtime-forward-child-protocol.mjs';
import { collectUpdateRuntimeClosure } from './lib/update-runtime-bundle.mjs';
import { canonicalLocalIdentity, validateLocalBuildCore, validateLocalPreparedArtifact, LOCAL_BUILD_KIND } from './lib/local-reviewed-build-identity.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATTESTATION_SCHEMA = 'nassaj-release-host-support-attestation/v1';
const DEFAULT_ATTESTATION = '/etc/nassaj/release-host-support-attestation.json';
const OPERATOR_ROOT = '/usr/local/lib/nassaj-release-operator';
const FILES = Object.freeze([
    ['scripts/nassaj-maintenance-responder.mjs', '/usr/local/lib/nassaj-release-operator/scripts/nassaj-maintenance-responder.mjs', 0o555],
    ['scripts/prepare-legacy-release-runtime.mjs', `${OPERATOR_ROOT}/scripts/prepare-legacy-release-runtime.mjs`, 0o555],
    ['scripts/release-runtime-cutover.mjs', `${OPERATOR_ROOT}/scripts/release-runtime-cutover.mjs`, 0o555],
    ['scripts/release-runtime-cutover-recovery.mjs', `${OPERATOR_ROOT}/scripts/release-runtime-cutover-recovery.mjs`, 0o555],
    ['scripts/release-runtime-host-dispatcher.mjs', `${OPERATOR_ROOT}/scripts/release-runtime-host-dispatcher.mjs`, 0o555],
    ['scripts/install-release-runtime-recovery.mjs', `${OPERATOR_ROOT}/scripts/install-release-runtime-recovery.mjs`, 0o555],
    ['scripts/release-runtime-gate-restore.mjs', `${OPERATOR_ROOT}/scripts/release-runtime-gate-restore.mjs`, 0o555],
    ['scripts/lib/release-database-backup.mjs', `${OPERATOR_ROOT}/scripts/lib/release-database-backup.mjs`, 0o444],
    ['scripts/lib/release-database-preservation.mjs', `${OPERATOR_ROOT}/scripts/lib/release-database-preservation.mjs`, 0o444],
    ['scripts/lib/release-runtime-cutover.mjs', `${OPERATOR_ROOT}/scripts/lib/release-runtime-cutover.mjs`, 0o444],
    ['scripts/lib/release-runtime-host-operations.mjs', `${OPERATOR_ROOT}/scripts/lib/release-runtime-host-operations.mjs`, 0o444],
    ['scripts/lib/release-runtime-owner-adapter.mjs', `${OPERATOR_ROOT}/scripts/lib/release-runtime-owner-adapter.mjs`, 0o444],
    ['scripts/lib/release-runtime-recovery-installer.mjs', `${OPERATOR_ROOT}/scripts/lib/release-runtime-recovery-installer.mjs`, 0o444],
    ['server/modules/database/canonical-schema-digest.js', `${OPERATOR_ROOT}/server/modules/database/canonical-schema-digest.js`, 0o444],
    ['ops/nassaj-maintenance.service', '/etc/systemd/system/nassaj-maintenance.service', 0o444],
]);
const VIRTUAL_FILES = Object.freeze([
    ['operator-package-json', `${OPERATOR_ROOT}/package.json`, 0o444, Buffer.from('{"type":"module","private":true}\n')],
]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function syncDirectory(directory) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
function ensureSafeDirectory(directory, ownerUid = 0) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o755 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== ownerUid || (metadata.mode & 0o022) !== 0) {
        throw new Error(`release_host_support_directory_unsafe:${directory}`);
    }
}
function atomicInstall(file, bytes, mode, ownerUid = 0, forward = null) {
    if (forward) forwardDestination(file, mode, ownerUid, forward.stop);
    ensureSafeDirectory(path.dirname(file), ownerUid);
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`release_host_support_symlink:${file}`);
    const temporary = `${file}.partial-${process.pid}`;
    writeFileSync(temporary, bytes, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (forward) forwardDestination(file, mode, ownerUid, forward.stop);
    renameSync(temporary, file); syncDirectory(path.dirname(file));
}
function measuredRegularFile(file, expectedMode, ownerUid = 0) {
    if (realpathSync(file) !== file) throw new Error(`release_host_support_path_unsafe:${file}`);
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid || (before.mode & 0o777) !== expectedMode) {
        throw new Error(`release_host_support_file_unsafe:${file}`);
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd); const bytes = readFileSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`release_host_support_file_changed:${file}`);
        return Object.freeze({ path: file, mode: expectedMode, size: bytes.length, sha256: sha(bytes) });
    } finally { closeSync(fd); }
}
function run(file, args, injected) {
    if (injected.exec) return injected.exec(file, args);
    return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
        env: { PATH: '/usr/bin:/bin', HOME: '/root', LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '' } });
}
function expectedSources(sourceRoot, injected, ownerUid) {
    ensureSafeDirectory(sourceRoot, ownerUid);
    const files = FILES.map(([relative, target, mode]) => {
        const source = path.join(sourceRoot, relative); const metadata = lstatSync(source);
        if (realpathSync(source) !== source || !metadata.isFile() || metadata.isSymbolicLink()
            || metadata.uid !== ownerUid || (metadata.mode & 0o022) !== 0) {
            throw new Error(`release_host_support_source_unsafe:${relative}`);
        }
        for (let directory = path.dirname(source); directory !== sourceRoot; directory = path.dirname(directory)) {
            const parent = lstatSync(directory);
            if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== ownerUid || (parent.mode & 0o022) !== 0) {
                throw new Error(`release_host_support_source_parent_unsafe:${relative}`);
            }
        }
        const bytes = readFileSync(source);
        const installedTarget = injected.mapTarget ? injected.mapTarget(target) : target;
        return Object.freeze({ relative, target: installedTarget, mode, bytes, size: bytes.length, sha256: sha(bytes) });
    });
    for (const [relative, target, mode, bytes] of VIRTUAL_FILES) {
        files.push(Object.freeze({ relative, target: injected.mapTarget ? injected.mapTarget(target) : target,
            mode, bytes, size: bytes.length, sha256: sha(bytes) }));
    }
    return files;
}
function sourceSetSha256(files) {
    return sha(files.map(({ relative, mode, size, sha256 }) => `${relative}\0${mode}\0${size}\0${sha256}\n`).join(''));
}
function configHandoff(expected, injected, ownerUid) {
    const configTargets = ['/etc/nassaj/release-runtime-host.json', '/etc/nassaj/release-runtime-first-cutover.json']
        .map((file) => injected.mapTarget ? injected.mapTarget(file) : file);
    const missing = configTargets.filter((file) => !existsSync(file));
    if (missing.length > 0) return Object.freeze({ ready: false, missing: Object.freeze(missing) });
    const evidence = configTargets.map((file) => measuredRegularFile(file, 0o600, ownerUid));
    const [hostConfig, cutoverConfig] = configTargets.map((file) => JSON.parse(readFileSync(file, 'utf8')));
    if (hostConfig?.schema !== 'nassaj-release-runtime-host-config/v1'
        || cutoverConfig?.schema !== 'nassaj-release-runtime-first-cutover-config/v1') {
        throw new Error('release_host_support_config_schema_invalid');
    }
    const dispatcher = expected.find((entry) => entry.relative === 'scripts/release-runtime-host-dispatcher.mjs');
    if (cutoverConfig.dispatcher !== dispatcher.target || cutoverConfig.dispatcherSha256 !== dispatcher.sha256) {
        throw new Error('release_host_support_dispatcher_handoff_invalid');
    }
    return Object.freeze({ ready: true, files: Object.freeze(evidence) });
}

/** Measure installed bytes and the complete effective systemd unit. */
export function attestReleaseHostSupport(expected, options = {}, injected = {}) {
    const ownerUid = injected.allowUnprivileged ? process.geteuid() : 0;
    const files = expected.map(({ target, mode, sha256, size }) => {
        const measured = measuredRegularFile(target, mode, ownerUid);
        if (measured.sha256 !== sha256 || measured.size !== size) throw new Error(`release_host_support_digest_mismatch:${target}`);
        return measured;
    });
    run('/usr/bin/systemd-analyze', ['verify', '/etc/systemd/system/nassaj-maintenance.service'], injected);
    const effectiveUnit = run('/usr/bin/systemctl', ['cat', 'nassaj-maintenance.service'], injected);
    const unit = expected.find((entry) => entry.relative === 'ops/nassaj-maintenance.service');
    const canonicalEffective = `# /etc/systemd/system/nassaj-maintenance.service\n${unit.bytes.toString('utf8')}`;
    if (effectiveUnit !== canonicalEffective) throw new Error('release_host_support_effective_unit_invalid');
    return Object.freeze({ schema: ATTESTATION_SCHEMA, sourceSetSha256: sourceSetSha256(expected), files,
        effectiveUnitSha256: sha(effectiveUnit), effectiveUnitSize: Buffer.byteLength(effectiveUnit),
        configHandoff: configHandoff(expected, injected, ownerUid) });
}

/** Install fixed files atomically; repeated runs first detect tampering of the same source generation. */
export function installReleaseHostSupport(options = {}, injected = {}) {
    if (!injected.allowUnprivileged && process.geteuid?.() !== 0) throw new Error('release_host_support_root_required');
    assertLegacyEntryProfile(injected);
    return forwardLock(null, injected, (ownerUid, stop, lock) => {
        const file = options.attestationFile || DEFAULT_ATTESTATION;
        const metadata = forwardLstat(file);
        if (!metadata) forwardAssert(lock.created, 'legacy_forward_installation_or_unknown');
        else {
            const previous = JSON.parse(forwardRead(file, ownerUid, { stop, mode: 0o600 }).bytes);
            forwardAssert(previous && previous.schema === ATTESTATION_SCHEMA && previous.profile === undefined
                && previous.phase === undefined, 'legacy_forward_installation_or_unknown');
        }
        return installLegacyReleaseHostSupport(options, injected);
    }, 'legacy-host-trust');
}

function assertLegacyEntryProfile(injected) {
    const file = path.join(SOURCE_ROOT, 'INSTALLER_BUNDLE_MANIFEST.json');
    if (!forwardLstat(file)) return;
    const ownerUid = injected.allowUnprivileged ? process.geteuid() : 0;
    const manifest = JSON.parse(forwardRead(file, ownerUid, { stop: injected.allowUnprivileged ? SOURCE_ROOT : '/' }).bytes);
    forwardAssert(manifest && manifest.schema === 'nassaj-installer-bundle/v1' && manifest.profile === undefined,
        'legacy_forward_installation_or_unknown');
}

function installLegacyReleaseHostSupport(options = {}, injected = {}) {
    if (!injected.allowUnprivileged && process.geteuid?.() !== 0) throw new Error('release_host_support_root_required');
    const sourceRoot = path.resolve(options.sourceRoot || SOURCE_ROOT);
    const attestationFile = options.attestationFile || DEFAULT_ATTESTATION;
    const ownerUid = injected.allowUnprivileged ? process.geteuid() : 0;
    const expected = expectedSources(sourceRoot, injected, ownerUid); const expectedSet = sourceSetSha256(expected);
    if (existsSync(attestationFile)) {
        const recordMetadata = lstatSync(attestationFile);
        if (!recordMetadata.isFile() || recordMetadata.isSymbolicLink() || recordMetadata.uid !== ownerUid
            || (recordMetadata.mode & 0o777) !== 0o600 || realpathSync(attestationFile) !== attestationFile) {
            throw new Error('release_host_support_attestation_unsafe');
        }
        const previous = JSON.parse(readFileSync(attestationFile, 'utf8'));
        if (previous.schema === ATTESTATION_SCHEMA && previous.sourceSetSha256 === expectedSet) {
            const current = attestReleaseHostSupport(expected, options, injected);
            if (current.effectiveUnitSha256 !== previous.effectiveUnitSha256) {
                throw new Error('release_host_support_effective_unit_tampered');
            }
            if (previous.configHandoff?.ready && JSON.stringify(current.configHandoff) !== JSON.stringify(previous.configHandoff)) {
                throw new Error('release_host_support_config_handoff_tampered');
            }
            if (!previous.configHandoff?.ready && current.configHandoff.ready) {
                atomicInstall(attestationFile, Buffer.from(`${JSON.stringify(current, null, 2)}\n`), 0o600, ownerUid);
                return Object.freeze({ state: 'config_attested', ...current });
            }
            return Object.freeze({ state: 'already_installed', ...current });
        }
    }
    for (const file of expected) atomicInstall(file.target, file.bytes, file.mode, ownerUid);
    run('/usr/bin/systemctl', ['daemon-reload'], injected);
    const attestation = attestReleaseHostSupport(expected, options, injected);
    atomicInstall(attestationFile, Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`), 0o600, ownerUid);
    return Object.freeze({ state: 'installed', ...attestation });
}

const FORWARD_ATTESTATION_SCHEMA = 'nassaj-release-host-support-attestation/v2';
const HOST_ROOTS = ['scripts/nassaj-maintenance-responder.mjs', 'scripts/release-runtime-host-dispatcher.mjs'];
const INSTALL_LOCK = '/etc/nassaj/.release-host-support-install.flock';
const FORWARD_LIMITS = { archiveBytes: 32 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, files: 10000 };
const exactKeys = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
function forwardAssert(condition, code) { if (!condition) throw new Error(`release_host_support_forward_${code}`); }
function forwardAncestors(file, ownerUid, stop = '/') {
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
        const st = lstatSync(directory);
        forwardAssert(st.isDirectory() && !st.isSymbolicLink() && st.uid === ownerUid && !(st.mode & 0o022)
            && realpathSync(directory) === directory, 'ancestor_unsafe');
        if (directory === stop || directory === '/') break;
    }
}
function forwardRead(file, ownerUid, { maxBytes = FORWARD_LIMITS.archiveBytes, mode, stop = '/', retainFd = false } = {}) {
    forwardAncestors(file, ownerUid, stop);
    const before = lstatSync(file);
    forwardAssert(before.isFile() && !before.isSymbolicLink() && before.uid === ownerUid && before.nlink === 1
        && !(before.mode & 0o022) && (mode === undefined || (before.mode & 0o777) === mode)
        && before.size <= maxBytes && realpathSync(file) === file, 'file_unsafe');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let retained = false;
    try {
        const opened = fstatSync(fd), buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, null);
            if (!count) break;
            length += count;
        }
        const bytes = buffer.subarray(0, length), final = fstatSync(fd), after = lstatSync(file);
        forwardAssert(['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
            key => before[key] === opened[key] && before[key] === final[key] && before[key] === after[key])
            && bytes.length === before.size, 'file_drift');
        forwardAncestors(file, ownerUid, stop);
        retained = retainFd;
        return { bytes, size: bytes.length, sha256: sha(bytes), mode: before.mode & 0o777, info: final, ...(retainFd ? { fd } : {}) };
    } finally { if (!retained) closeSync(fd); }
}
function forwardLstat(file) {
    try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function forwardDestination(file, mode, ownerUid, stop) {
    forwardAncestors(file, ownerUid, stop);
    const current = forwardLstat(file);
    if (current) forwardAssert(current.isFile() && !current.isSymbolicLink() && current.uid === ownerUid
        && current.nlink === 1 && (current.mode & 0o777) === mode && realpathSync(file) === file, 'destination_unsafe');
}
function installerRequest(request) {
    forwardAssert(exactKeys(request, 'schema,installerArchive,flockSha256')
        && request.schema === 'nassaj-release-host-support-install-request/v1'
        && exactKeys(request.installerArchive, 'path,size,sha256')
        && path.isAbsolute(request.installerArchive.path || '') && Number.isSafeInteger(request.installerArchive.size)
        && request.installerArchive.size > 0 && request.installerArchive.size <= FORWARD_LIMITS.archiveBytes
        && /^[a-f0-9]{64}$/.test(request.installerArchive.sha256) && /^[a-f0-9]{64}$/.test(request.flockSha256), 'request_invalid');
}
/** Validate a reviewed archive from its external digest, with exact file inventory and unchanged module bytes. */
export function verifyForwardInstallerArchive(bytes, expected) {
    forwardAssert(bytes.length === expected.size && sha(bytes) === expected.sha256, 'archive_digest');
    const inspected = inspectTarGz(bytes, FORWARD_LIMITS), files = inspected.entries.filter(e => e.type === 'file');
    const entries = new Map(files.map(e => [e.name, e]));
    const manifestEntry = entries.get('INSTALLER_BUNDLE_MANIFEST.json');
    forwardAssert(manifestEntry && manifestEntry.mode === 0o644 && manifestEntry.size <= 4 * 1024 * 1024, 'manifest_missing');
    const manifestBytes = inspected.tar.subarray(manifestEntry.contentOffset, manifestEntry.contentOffset + manifestEntry.size);
    const manifest = JSON.parse(manifestBytes);
    forwardAssert(exactKeys(manifest, 'schema,profile,version,commit,runtime,files')
        && manifest.schema === 'nassaj-installer-bundle/v2' && manifest.profile === 'forward'
        && exactKeys(manifest.runtime, 'kind,build,artifact') && manifest.runtime.kind === LOCAL_BUILD_KIND, 'manifest_invalid');
    validateLocalBuildCore(manifest.runtime.build); validateLocalPreparedArtifact(manifest.runtime.artifact, manifest.runtime.build);
    forwardAssert(manifest.commit === manifest.runtime.build.commit && manifest.version === manifest.runtime.build.version, 'runtime_identity');
    forwardAssert(Array.isArray(manifest.files) && manifest.files.length === files.length - 1, 'inventory_count');
    let previous = '';
    for (const file of manifest.files) {
        const entry = entries.get(file.path);
        forwardAssert(exactKeys(file, 'path,mode,size,sha256') && file.path > previous && entry
            && file.path !== 'INSTALLER_BUNDLE_MANIFEST.json' && [0o644, 0o755].includes(file.mode)
            && entry.mode === file.mode && entry.size === file.size && entry.sha256 === file.sha256, 'inventory_mismatch');
        previous = file.path;
    }
    const parents = new Set();
    for (const name of entries.keys()) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) parents.add(parent);
    const directories = inspected.entries.filter(e => e.type === 'directory');
    forwardAssert(directories.length === parents.size && directories.every(e => parents.has(e.name) && e.mode === 0o755), 'directory_inventory');
    return { manifest, manifestBytes, inspected, entries };
}
function forwardTarget(record) {
    forwardAssert(exactKeys(record, 'path,targetClass,sourceMode,installedMode,size,sha256')
        && typeof record.path === 'string' && !record.path.split('/').some(p => !p || p === '.' || p === '..')
        && !/[\\\x00-\x1f]/.test(record.path) && [0o644, 0o755].includes(record.sourceMode)
        && record.installedMode === (HOST_ROOTS.includes(record.path) ? 0o555 : 0o444), 'target_invalid');
    if (record.targetClass === 'operator-module' && (/^scripts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.m?js$/.test(record.path)
        || record.path === 'server/modules/database/canonical-schema-digest.js')) return path.join(OPERATOR_ROOT, record.path);
    if (record.targetClass === 'operator-dependency' && /^node_modules\/semver\/[A-Za-z0-9_./-]+$/.test(record.path)) return path.join(OPERATOR_ROOT, record.path);
    if (record.targetClass === 'operator-package' && record.path === 'package.json') return path.join(OPERATOR_ROOT, record.path);
    if (record.targetClass === 'maintenance-unit' && record.path === 'ops/nassaj-maintenance.service') return '/etc/systemd/system/nassaj-maintenance.service';
    throw new Error('release_host_support_forward_target_class');
}
function forwardSources(sourceRoot, verified, ownerUid, injected) {
    const stop = injected.fixtureRoot || '/', rootInfo = lstatSync(sourceRoot);
    forwardAssert(rootInfo.isDirectory() && rootInfo.uid === ownerUid && !rootInfo.isSymbolicLink()
        && (rootInfo.mode & 0o777) === 0o700 && realpathSync(sourceRoot) === sourceRoot, 'source_root');
    const actual = [];
    function walk(directory) {
        for (const name of readdirSync(directory).sort()) {
            const file = path.join(directory, name), st = lstatSync(file);
            if (st.isDirectory() && !st.isSymbolicLink()) {
                forwardAssert(verified.inspected.entries.some(e => e.type === 'directory'
                    && e.name === path.relative(sourceRoot, file)), 'source_directory_inventory');
                walk(file);
            } else { forwardRead(file, ownerUid, { stop }); actual.push(path.relative(sourceRoot, file)); }
        }
    }
    walk(sourceRoot);
    forwardAssert(JSON.stringify(actual.sort()) === JSON.stringify([...verified.entries.keys()].sort()), 'source_inventory');
    const measuredSources = new Map();
    for (const [relative, entry] of verified.entries) {
        const measured = forwardRead(path.join(sourceRoot, relative), ownerUid, { stop });
        forwardAssert(measured.mode === entry.mode && measured.size === entry.size && measured.sha256 === entry.sha256, 'source_bytes');
        measuredSources.set(relative, measured);
    }
    const host = JSON.parse(measuredSources.get('HOST_SUPPORT_MANIFEST.json')?.bytes);
    forwardAssert(exactKeys(host, 'schema,roots,files') && host.schema === 'nassaj-release-host-support-files/v1'
        && JSON.stringify(host.roots) === JSON.stringify(HOST_ROOTS) && Array.isArray(host.files), 'host_manifest');
    forwardAssert(host.files.filter(f => f.targetClass === 'operator-package').length === 1
        && host.files.filter(f => f.targetClass === 'maintenance-unit').length === 1, 'host_fixed_targets');
    const closure = collectUpdateRuntimeClosure(sourceRoot, HOST_ROOTS);
    const modules = host.files.filter(f => f.targetClass === 'operator-module').map(f => f.path);
    forwardAssert(JSON.stringify(modules) === JSON.stringify(closure), 'host_closure');
    const dependencies = [...verified.entries.keys()].filter(p => p.startsWith('node_modules/semver/')).sort();
    forwardAssert(JSON.stringify(host.files.filter(f => f.targetClass === 'operator-dependency').map(f => f.path)) === JSON.stringify(dependencies), 'host_dependencies');
    let previous = '';
    const expected = host.files.map(record => {
        const target = forwardTarget(record), entry = verified.entries.get(record.path);
        forwardAssert(record.path > previous && entry && entry.sha256 === record.sha256 && entry.size === record.size
            && entry.mode === record.sourceMode, 'host_record'); previous = record.path;
        const bytes = measuredSources.get(record.path).bytes;
        if (record.targetClass === 'operator-package') forwardAssert(bytes.equals(Buffer.from('{"type":"module","private":true}\n')), 'package_bytes');
        return { relative: record.path, target: injected.mapTarget ? injected.mapTarget(target) : target,
            mode: record.installedMode, sourceMode: record.sourceMode, size: record.size, sha256: record.sha256, bytes };
    });
    for (const [relative, measured] of measuredSources) {
        const file = path.join(sourceRoot, relative), current = lstatSync(file);
        forwardAncestors(file, ownerUid, stop);
        forwardAssert(['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
            key => measured.info[key] === current[key]), 'source_changed_after_measurement');
    }
    return expected;
}
function bootstrapForwardNamespace(ownerUid, stop, injected) {
    const directory = injected.mapTarget ? injected.mapTarget('/etc/nassaj') : '/etc/nassaj';
    const parent = path.dirname(directory);
    forwardAncestors(directory, ownerUid, stop);
    const before = lstatSync(parent), parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        const openedParent = fstatSync(parentFd);
        forwardAssert(before.dev === openedParent.dev && before.ino === openedParent.ino, 'namespace_parent_changed');
        const anchored = `/proc/self/fd/${parentFd}/nassaj`;
        let created = false;
        try { mkdirSync(anchored, { mode: 0o755 }); created = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const childFd = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
            const child = fstatSync(childFd), current = lstatSync(directory);
            forwardAssert(child.isDirectory() && child.uid === ownerUid && child.dev === current.dev
                && child.ino === current.ino && child.nlink >= 2 && child.nlink === current.nlink && !current.isSymbolicLink() && realpathSync(directory) === directory, 'namespace_child_changed');
            if (created) { fchmodSync(childFd, 0o755); fsyncSync(childFd); }
            const after = fstatSync(childFd), pathAfter = lstatSync(directory);
            forwardAssert(after.dev === child.dev && after.ino === child.ino && after.uid === ownerUid
                && (after.mode & 0o777) === 0o755 && pathAfter.dev === child.dev && pathAfter.ino === child.ino
                && (pathAfter.mode & 0o777) === 0o755, 'namespace_child_unsafe');
        } finally { closeSync(childFd); }
        const final = lstatSync(parent), fdFinal = fstatSync(parentFd);
        forwardAssert(['dev', 'ino', 'uid', 'mode'].every(key => before[key] === final[key] && before[key] === fdFinal[key])
            && realpathSync(parent) === parent, 'namespace_parent_changed');
        fsyncSync(parentFd);
    } finally { closeSync(parentFd); }
}

function forwardLock(request, injected, operation, policy = 'forward-reviewed-pin') {
    forwardAssert(['forward-reviewed-pin', 'legacy-host-trust'].includes(policy), 'lock_policy');
    const ownerUid = injected.allowUnprivileged ? process.geteuid() : 0, stop = injected.fixtureRoot || '/';
    bootstrapForwardNamespace(ownerUid, stop, injected);
    const lock = injected.mapTarget ? injected.mapTarget(INSTALL_LOCK) : INSTALL_LOCK;
    forwardAncestors(lock, ownerUid, stop);
    forwardAssert((lstatSync(path.dirname(lock)).mode & 0o777) === 0o755, 'lock_parent');
    let fd, created = false;
    try { fd = openSync(lock, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; fd = openSync(lock, constants.O_RDWR | constants.O_NOFOLLOW); }
    try {
        const info = fstatSync(fd);
        forwardAssert(info.isFile() && info.uid === ownerUid && info.nlink === 1 && (info.mode & 0o777) === 0o600, 'lock_unsafe');
        const flock = forwardRead('/usr/bin/flock', 0, { maxBytes: 16 * 1024 * 1024, retainFd: true });
        const expectedFlock = policy === 'forward-reviewed-pin' ? request.flockSha256 : flock.sha256;
        let result;
        try {
            forwardAssert(flock.sha256 === expectedFlock && !!(flock.mode & 0o111), 'flock_pin');
            result = spawnSync('/proc/self/fd/4', ['-x', '-w', '5', '-E', '75', '3'], {
                stdio: ['ignore', 'pipe', 'pipe', fd, flock.fd], encoding: 'utf8', timeout: 6000, killSignal: 'SIGKILL',
                env: { PATH: '/usr/bin:/bin', HOME: '/root', LC_ALL: 'C' } });
            const finalFd = fstatSync(flock.fd), named = lstatSync('/usr/bin/flock');
            forwardAssert(['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
                key => flock.info[key] === finalFd[key] && flock.info[key] === named[key]), 'flock_drift');
        } finally { closeSync(flock.fd); }
        forwardAssert(result.status === 0 && !result.error && !result.stdout && !result.stderr, 'lock_unavailable');
        const after = lstatSync(lock);
        forwardAssert(after.dev === info.dev && after.ino === info.ino && after.nlink === 1 && after.uid === ownerUid
            && (after.mode & 0o777) === 0o600 && forwardRead('/usr/bin/flock', 0).sha256 === expectedFlock, 'lock_changed');
        if (created) {
            const parent = path.dirname(lock), directoryFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try {
                const directory = fstatSync(directoryFd), named = lstatSync(parent);
                forwardAssert(directory.isDirectory() && directory.uid === ownerUid && (directory.mode & 0o777) === 0o755
                    && directory.dev === named.dev && directory.ino === named.ino, 'lock_parent_changed');
                fsyncSync(fd); fsyncSync(directoryFd);
                const finalParent = lstatSync(parent), finalLock = lstatSync(lock);
                forwardAncestors(lock, ownerUid, stop);
                forwardAssert(finalParent.dev === directory.dev && finalParent.ino === directory.ino
                    && finalLock.dev === info.dev && finalLock.ino === info.ino, 'lock_parent_changed');
            } finally { closeSync(directoryFd); }
        }
        return operation(ownerUid, stop, { created });
    } finally { closeSync(fd); }
}
function forwardTargetParent(file, ownerUid, stop, create = false) {
    const parent = path.dirname(file), base = stop === '/' ? '/' : stop;
    forwardAssert(parent === base || parent.startsWith(base === '/' ? '/' : base + '/'), 'target_parent_scope');
    let current = base;
    for (const part of path.relative(base, parent).split('/').filter(Boolean)) {
        current = path.join(current, part);
        let st;
        try { st = lstatSync(current); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (!create) return;
            mkdirSync(current, { mode: 0o755 });
            const directoryFd = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try {
                const opened = fstatSync(directoryFd), named = lstatSync(current);
                forwardAssert(opened.isDirectory() && opened.uid === ownerUid && opened.dev === named.dev
                    && opened.ino === named.ino && opened.nlink >= 2 && opened.nlink === named.nlink
                    && !named.isSymbolicLink(), 'created_parent_changed');
                fchmodSync(directoryFd, 0o755); fsyncSync(directoryFd);
            } finally { closeSync(directoryFd); }
            syncDirectory(path.dirname(current)); st = lstatSync(current);
        }
        forwardAssert(st.isDirectory() && !st.isSymbolicLink() && st.uid === ownerUid && !(st.mode & 0o022)
            && (st.mode & 0o005) === 0o005 && realpathSync(current) === current, 'target_parent_unsafe');
    }
}
function forwardAttestation(expected, pins, ownerUid, injected) {
    const operator = injected.mapTarget ? injected.mapTarget(OPERATOR_ROOT) : OPERATOR_ROOT;
    const observed = [];
    function inventory(directory) {
        for (const name of readdirSync(directory).sort()) {
            const file = path.join(directory, name), st = lstatSync(file);
            forwardAssert(st.uid === ownerUid && !st.isSymbolicLink() && !(st.mode & 0o022), 'installed_tree_unsafe');
            if (st.isDirectory()) inventory(file); else { forwardAssert(st.isFile(), 'installed_tree_unsafe'); observed.push(file); }
        }
    }
    inventory(operator);
    forwardAssert(JSON.stringify(observed.sort()) === JSON.stringify(expected.map(f => f.target).filter(f => f.startsWith(operator + '/')).sort()), 'installed_inventory');
    const files = expected.map(entry => {
        forwardTargetParent(entry.target, ownerUid, injected.fixtureRoot || '/');
        forwardAncestors(entry.target, ownerUid, injected.fixtureRoot || '/');
        const measured = forwardRead(entry.target, ownerUid, { mode: entry.mode, maxBytes: entry.size, stop: injected.fixtureRoot || '/' });
        return { relative: entry.relative, path: entry.target, mode: entry.mode, size: measured.size, sha256: measured.sha256 };
    });
    for (let i = 0; i < files.length; i++) forwardAssert(files[i].size === expected[i].size && files[i].sha256 === expected[i].sha256, 'installed_digest');
    run('/usr/bin/systemd-analyze', ['verify', '/etc/systemd/system/nassaj-maintenance.service'], injected);
    const unit = expected.find(f => f.relative === 'ops/nassaj-maintenance.service');
    const effective = run('/usr/bin/systemctl', ['cat', 'nassaj-maintenance.service'], injected);
    forwardAssert(effective === `# /etc/systemd/system/nassaj-maintenance.service\n${unit.bytes.toString('utf8')}`, 'effective_unit');
    return { schema: FORWARD_ATTESTATION_SCHEMA, profile: 'forward', phase: 'support_installed', ...pins,
        sourceSetSha256: sourceSetSha256(expected), files, effectiveUnitSha256: sha(effective),
        effectiveUnitSize: Buffer.byteLength(effective), configHandoff: { ready: false, files: [] } };
}
/** Install only the externally pinned forward support closure under its permanent first-install mutex. */
export function installForwardReleaseHostSupport(request, injected = {}) {
    installerRequest(request);
    forwardAssert(injected.allowUnprivileged || process.geteuid() === 0, 'root_required');
    const readerUid = injected.allowUnprivileged ? process.geteuid() : 0;
    const initial = forwardRead(request.installerArchive.path, readerUid, { stop: injected.fixtureRoot || '/' });
    const initialVerified = verifyForwardInstallerArchive(initial.bytes, request.installerArchive);
    forwardSources(injected.sourceRoot || SOURCE_ROOT, initialVerified, readerUid, injected);
    return forwardLock(request, injected, (ownerUid, stop, lock) => {
        const archive = forwardRead(request.installerArchive.path, ownerUid, { stop });
        const verified = verifyForwardInstallerArchive(archive.bytes, request.installerArchive);
        const sourceRoot = injected.sourceRoot || SOURCE_ROOT;
        const expected = forwardSources(sourceRoot, verified, ownerUid, injected);
        const artifact = verified.manifest.runtime.artifact;
        const pins = { installerArchive: { sha256: archive.sha256, size: archive.size },
            installerManifest: { sha256: sha(verified.manifestBytes), size: verified.manifestBytes.length },
            runtimeManifest: { sha256: artifact.manifestSha256, size: artifact.manifestSize } };
        const attestationFile = injected.mapTarget ? injected.mapTarget(DEFAULT_ATTESTATION) : DEFAULT_ATTESTATION;
        forwardAssert(!readdirSync(path.dirname(attestationFile)).some(name => name.startsWith(path.basename(attestationFile) + '.partial-')),
            'partial_attestation');
        if (forwardLstat(attestationFile)) {
            const previous = JSON.parse(forwardRead(attestationFile, ownerUid, { stop, mode: 0o600 }).bytes);
            forwardAssert(previous && previous.schema === FORWARD_ATTESTATION_SCHEMA && previous.profile === 'forward'
                && previous.phase === 'support_installed', 'partial_or_other_installation');
            const current = forwardAttestation(expected, pins, ownerUid, injected);
            forwardAssert(JSON.stringify(current) === JSON.stringify(previous), 'attestation_drift');
            return { state: 'already_installed', ...current };
        }
        forwardAssert(lock.created, 'lock_only_unknown');
        const protectedTargets = [injected.mapTarget ? injected.mapTarget(OPERATOR_ROOT) : OPERATOR_ROOT, ...expected.map(f => f.target),
            ...(injected.mapTarget ? ['/etc/nassaj/release-runtime-host.json', '/etc/nassaj/startup-admission-client.json'].map(injected.mapTarget)
                : ['/etc/nassaj/release-runtime-host.json', '/etc/nassaj/startup-admission-client.json'])];
        for (const target of protectedTargets) {
            forwardTargetParent(target, ownerUid, stop);
            try { lstatSync(target); throw new Error('release_host_support_forward_existing_target'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const intent = { schema: FORWARD_ATTESTATION_SCHEMA, profile: 'forward', phase: 'installing', ...pins,
            sourceSetSha256: sourceSetSha256(expected), files: [], effectiveUnitSha256: null, effectiveUnitSize: null,
            configHandoff: { ready: false, files: [] } };
        atomicInstall(attestationFile, Buffer.from(JSON.stringify(intent) + '\n'), 0o600, ownerUid, { stop });
        for (const file of expected) {
            forwardTargetParent(file.target, ownerUid, stop, true);
            atomicInstall(file.target, file.bytes, file.mode, ownerUid, { stop });
        }
        run('/usr/bin/systemctl', ['daemon-reload'], injected);
        const attestation = forwardAttestation(expected, pins, ownerUid, injected);
        atomicInstall(attestationFile, Buffer.from(JSON.stringify(attestation) + '\n'), 0o600, ownerUid, { stop });
        return { state: 'installed', ...attestation };
    });
}
const HOST_CONFIG = '/etc/nassaj/release-runtime-host.json';
const PUBLIC_DESCRIPTOR = '/etc/nassaj/startup-admission-client.json';
function configInstallRequest(request) {
    forwardAssert(exactKeys(request, 'schema,installerArchive,flockSha256,preparedConfig,publicDescriptor')
        && request.schema === 'nassaj-release-host-support-config-request/v1', 'config_request');
    installerRequest({ schema: 'nassaj-release-host-support-install-request/v1',
        installerArchive: request.installerArchive, flockSha256: request.flockSha256 });
    for (const pin of [request.preparedConfig, request.publicDescriptor]) forwardAssert(exactKeys(pin, 'path,size,sha256')
        && path.isAbsolute(pin.path || '') && /^[a-f0-9]{64}$/.test(pin.sha256 || '')
        && Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 256 * 1024, 'config_input_pin');
}
function configReadPin(pin, ownerUid, stop, mode, maximum = 256 * 1024) {
    forwardAssert(pin && path.isAbsolute(pin.path || '') && /^[a-f0-9]{64}$/.test(pin.sha256 || ''), 'config_material_pin');
    const result = forwardRead(pin.path, ownerUid, { stop, mode, maxBytes: maximum });
    forwardAssert(result.sha256 === pin.sha256 && (pin.size === undefined || pin.size === result.size), 'config_material_drift');
    return result;
}
function verifyConfigGeneration(config, runtime, ownerUid, stop) {
    forwardAssert(config?.schema === 'nassaj-release-runtime-host-config/v1'
        && canonicalLocalIdentity(config.expected?.localBuild) === canonicalLocalIdentity(runtime.build)
        && canonicalLocalIdentity(config.expected?.localArtifact) === canonicalLocalIdentity(runtime.artifact), 'config_runtime_identity');
    const claim = config.bootstrapClaim;
    forwardAssert(claim && path.basename(claim.generationRecordFile || '') === 'runtime-generation.json', 'config_generation_locator');
    const generation = path.dirname(claim.generationRecordFile);
    forwardAssert(realpathSync(generation) === generation
        && path.basename(generation) === `local-forward-${runtime.artifact.archiveSha256}`
        && claim.releaseManifestSha256 === runtime.artifact.manifestSha256, 'config_generation_locator');
    const record = JSON.parse(configReadPin({ path: claim.generationRecordFile, sha256: claim.generationRecordSha256 }, ownerUid, stop, 0o600).bytes);
    forwardAssert(record.schemaVersion === 2 && record.state === 'sealed' && record.sealKind === 'initial-bootstrap-v1'
        && record.activationIdentitySha256 === sha(canonicalLocalIdentity(record.identity))
        && record.identity?.kind === runtime.kind && record.identity.profile === 'forward'
        && record.identity.generationId === path.basename(generation)
        && canonicalLocalIdentity(record.identity.build) === canonicalLocalIdentity(runtime.build)
        && canonicalLocalIdentity(record.identity.artifact) === canonicalLocalIdentity(runtime.artifact), 'config_generation_seal');
    const privateManifest = configReadPin({ path: claim.releaseManifestFile, sha256: runtime.artifact.manifestSha256,
        size: runtime.artifact.manifestSize }, ownerUid, stop, 0o600, 32 * 1024 * 1024);
    const archiveManifest = configReadPin({ path: path.join(generation, 'RELEASE_ASSET_MANIFEST.json'), sha256: runtime.artifact.manifestSha256,
        size: runtime.artifact.manifestSize }, ownerUid, stop, 0o644, 32 * 1024 * 1024);
    forwardAssert(privateManifest.bytes.equals(archiveManifest.bytes), 'config_manifest_copies');
    const { manifest } = verifyExtractedReleaseAsset(generation, runtime, { allowGenerationRecord: true,
        expectedStartupClosureSha256: runtime.artifact.startupClosureSha256 });
    verifyForwardExecutableManifest(generation, manifest);
    for (const key of ['bundleManifestSha256', 'permissionProfile', 'permissionContractVersion', 'permissionProfileDigest',
        'permissionCapabilityDigest', 'permissionProtocolGeneration', 'minimumPermissionBuild']) {
        forwardAssert(canonicalLocalIdentity(record.identity[key]) === canonicalLocalIdentity(manifest[key]), 'config_generation_permissions');
    }
    return { generation, manifest };
}
function verifyConfigGenerationPaths(config, generation, manifest, ownerUid, stop) {
    const migration = config.forwardMigration, activation = config.forwardActivation;
    forwardAssert(migration && activation, 'config_forward_fields');
    const target = activation.supervisorPlan?.mutation?.targetDescriptor;
    forwardAssert(target?.pm_cwd === generation && target.pm_exec_path === path.join(generation, 'dist-server/server/bootstrap.js'), 'config_target_generation');
    const files = new Map(manifest.files.map(file => [file.path, file]));
    for (const [pin, relative] of [[migration.parent, 'scripts/release-runtime-forward-parent.mjs'],
        [migration.wrapper, 'scripts/release-runtime-forward-child.mjs'],
        [migration.entry, 'dist-server/server/scripts/release-database-migration.js'],
        [activation.safeRestart, 'scripts/safe-restart.sh']]) {
        const entry = files.get(relative);
        forwardAssert(pin?.path === path.join(generation, relative) && entry && pin.sha256 === entry.sha256, 'config_generation_path');
        configReadPin(pin, ownerUid, stop, entry.mode, entry.size);
    }
    if (config.managedRestart) forwardAssert(config.managedRestart.generationRoot === generation, 'config_managed_generation');
}
function verifySharedSupport(expected, generation, manifest, ownerUid, stop) {
    const files = new Map(manifest.files.map(file => [file.path, file]));
    for (const source of expected) {
        if (source.relative === 'package.json') continue; // Fixed virtual operator package is intentionally not the application package.
        const module = source.relative.startsWith('scripts/') || source.relative === 'server/modules/database/canonical-schema-digest.js';
        const candidates = module ? [source.relative, `dist-server/${source.relative}`, `dist-server/UPDATE_RUNTIME_BUNDLE/${source.relative}`] : [source.relative];
        let found = 0;
        for (const relative of candidates) {
            const file = path.join(generation, relative), present = forwardLstat(file), entry = files.get(relative);
            if (!present) { forwardAssert(!entry, 'config_shared_missing'); continue; }
            forwardAssert(entry && entry.sha256 === source.sha256 && entry.size === source.size
                && entry.mode === source.sourceMode, 'config_shared_source');
            configReadPin({ path: file, sha256: entry.sha256, size: entry.size }, ownerUid, stop, entry.mode, entry.size);
            found++;
        }
        forwardAssert(found > 0 || ['ops/nassaj-maintenance.service', 'scripts/nassaj-maintenance-responder.mjs'].includes(source.relative), 'config_shared_missing');
    }
}
function verifyPrivateForwardMaterial(config, generation, manifest, ownerUid, stop) {
    const settings = config.forwardMigration, identity = config.bootstrapClaim.identity;
    const request = JSON.parse(configReadPin(settings.request, ownerUid, stop, 0o600).bytes);
    const contract = JSON.parse(configReadPin(settings.contract, ownerUid, stop, 0o600).bytes);
    const closure = JSON.parse(configReadPin(settings.closure, ownerUid, stop, 0o600).bytes);
    forwardAssert(exactKeys(request, 'schema,transactionId,expectedPhase,releaseIdentitySha256,databaseContractSha256,database')
        && request.schema === 'nassaj-compatible-forward-request/v1' && request.expectedPhase === 'migration'
        && /^[A-Za-z0-9_-]{16,128}$/.test(request.transactionId || '')
        && request.releaseIdentitySha256 === identity.releaseIdentitySha256
        && request.databaseContractSha256 === identity.databaseContractSha256
        && canonicalLocalIdentity(contract) === canonicalLocalIdentity(manifest.databaseContract)
        && sha(canonicalLocalIdentity(contract)) === identity.databaseContractSha256, 'config_private_contract');
    const database = lstatSync(config.databaseFile, { bigint: true });
    forwardAssert(exactKeys(request.database, 'realpath,device,inode') && request.database.realpath === config.databaseFile
        && realpathSync(config.databaseFile) === config.databaseFile && database.isFile() && !database.isSymbolicLink()
        && String(database.dev) === request.database.device && String(database.ino) === request.database.inode
        && request.database.device === identity.databaseDev && request.database.inode === identity.databaseIno, 'config_private_database');
    const node = settings.node;
    forwardAssert(exactKeys(node, 'path,sha256') && node.path === config.bootstrapClaim.nodeExecutable
        && node.sha256 === config.bootstrapClaim.nodeSha256
        && config.forwardActivation.supervisorPlan.mutation.targetDescriptor.exec_interpreter === node.path, 'config_private_node');
    const systemNode = stop !== '/' && !node.path.startsWith(stop + '/');
    const nodeBytes = configReadPin(node, systemNode ? 0 : ownerUid, systemNode ? '/' : stop, undefined, 256 * 1024 * 1024);
    forwardAssert(!!(nodeBytes.mode & 0o111), 'config_private_node');
    const rootFiles = verifyForwardExecutableManifest(generation, manifest).files.map(file => ({ path: path.join(generation, file.path), sha256: file.sha256 }));
    const intended = { schema: 'nassaj-forward-child-closure/v1', files: [...rootFiles, settings.entry, node].sort((a, b) => a.path.localeCompare(b.path)) };
    forwardAssert(exactKeys(settings.entry, 'path,sha256') && settings.entry.sha256 === contract.migrationEntrySha256
        && exactKeys(closure, 'schema,files') && canonicalLocalIdentity(closure) === canonicalLocalIdentity(intended)
        && settings.closure.sha256 === config.expected.forwardExecutableClosureSha256, 'config_private_closure');
}
function hostIdentityObservation(file, allowedUids, stop, maximum, aggregate, executable = false) {
    forwardAssert(path.isAbsolute(file) && file.length <= RELEASE_ASSET_LIMITS.pathBytes
        && !/[\x00-\x1f]/.test(file) && realpathSync(file) === file, 'host_identity_path');
    const ancestors = [];
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
        const info = lstatSync(directory);
        forwardAssert(info.isDirectory() && !info.isSymbolicLink() && allowedUids.includes(info.uid)
            && !(info.mode & 0o022) && realpathSync(directory) === directory, 'host_identity_ancestor');
        ancestors.push({ path: directory, info }); if (directory === stop || directory === '/') break;
    }
    const before = lstatSync(file), same = info => ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === info[key]);
    forwardAssert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && allowedUids.includes(before.uid)
        && !(before.mode & 0o022) && before.size <= maximum && before.size >= 0
        && (!executable || !!(before.mode & 0o111)), 'host_identity_file');
    aggregate.planned += before.size; forwardAssert(aggregate.planned <= RELEASE_ASSET_LIMITS.expandedBytes, 'host_identity_aggregate');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash('sha256'); let size = 0;
    try {
        forwardAssert(same(fstatSync(fd)), 'host_identity_changed');
        const buffer = Buffer.alloc(65536);
        while (size <= before.size) {
            const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - size), null); if (!count) break;
            size += count; aggregate.actual += count;
            forwardAssert(size <= maximum && aggregate.actual <= RELEASE_ASSET_LIMITS.expandedBytes, 'host_identity_aggregate'); digest.update(buffer.subarray(0, count));
        }
        forwardAssert(size === before.size && same(fstatSync(fd)) && same(lstatSync(file)) && realpathSync(file) === file, 'host_identity_changed');
        for (const parent of ancestors) {
            const current = lstatSync(parent.path);
            forwardAssert(['dev', 'ino', 'uid', 'gid', 'mode'].every(key => parent.info[key] === current[key])
                && realpathSync(parent.path) === parent.path, 'host_identity_ancestor_changed');
        }
        return { path: file, sha256: digest.digest('hex'), size, inode: `${before.dev}:${before.ino}` };
    } finally { closeSync(fd); }
}
function verifyHostIdentity(config, request, expected, ownerUid, stop, injected) {
    const service = config.forwardMigration.serviceIdentity; assertForwardServicePolicy(service);
    if (config.managedRestart) assertForwardServicePolicy(config.managedRestart.serviceIdentity);
    forwardAssert(config.bootstrapClaim.applicationUid === service.uid
        && (!config.managedRestart || canonicalLocalIdentity(config.managedRestart.serviceIdentity) === canonicalLocalIdentity(service)), 'host_identity_service');
    const identity = config.forwardActivation.hostIdentity;
    forwardAssert(exactKeys(identity, 'schema,files') && identity.schema === 'nassaj-forward-host-identity/v1'
        && Array.isArray(identity.files) && identity.files.length > 0 && identity.files.length <= 512, 'host_identity_shape');
    const map = file => injected.mapTarget ? injected.mapTarget(file) : file;
    const forbidden = [map(DEFAULT_ATTESTATION), map(HOST_CONFIG), map(PUBLIC_DESCRIPTOR), request.preparedConfig.path, request.publicDescriptor.path];
    const forbiddenInodes = new Set(forbidden.map(file => forwardLstat(file)).filter(Boolean).map(info => `${info.dev}:${info.ino}`));
    const support = new Map(expected.map(file => [file.target, file]));
    const executables = new Set([config.bootstrapClaim.nodeExecutable, config.bootstrapClaim.sudoExecutable, config.bootstrapClaim.dispatcherExecutable,
        config.stateLock.flock.path, config.forwardActivation.bash?.path, config.forwardActivation.mutatorPlan.systemctl?.path,
        config.zeroWorkProbe?.file, config.maintenance?.nft?.binary, config.maintenance?.conntrack?.binary, config.maintenance?.cloudflared?.executable].filter(Boolean));
    const paths = new Set(), inodes = new Set(), rows = [], aggregate = { planned: 0, actual: 0 };
    for (const row of identity.files) {
        forwardAssert(exactKeys(row, 'path,sha256,size') && typeof row.path === 'string' && /^[a-f0-9]{64}$/.test(row.sha256 || '')
            && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= RELEASE_ASSET_LIMITS.archiveBytes
            && !paths.has(row.path) && !forbidden.includes(row.path), 'host_identity_row');
        const strict = support.has(row.path) || executables.has(row.path) || !!(lstatSync(row.path).mode & 0o111);
        const fixtureLocal = injected.allowUnprivileged && row.path.startsWith(stop + '/');
        const allowed = strict ? [fixtureLocal ? ownerUid : 0] : [0, service.uid];
        const observed = hostIdentityObservation(row.path, allowed, fixtureLocal ? stop : '/', RELEASE_ASSET_LIMITS.archiveBytes, aggregate, executables.has(row.path));
        forwardAssert(observed.sha256 === row.sha256 && observed.size === row.size && !inodes.has(observed.inode)
            && !forbiddenInodes.has(observed.inode), 'host_identity_drift');
        const installed = support.get(row.path);
        forwardAssert(!installed || installed.sha256 === row.sha256 && installed.size === row.size, 'host_identity_support');
        paths.add(row.path); inodes.add(observed.inode); rows.push({ path: row.path, sha256: row.sha256, size: row.size });
    }
    forwardAssert(expected.every(file => paths.has(file.target)) && sha(JSON.stringify(rows)) === config.expected.hostIdentitySha256, 'host_identity_coverage');
}
function preparedConfigMaterial(request, verified, expected, ownerUid, stop, injected) {
    const privateInput = configReadPin(request.preparedConfig, ownerUid, stop, 0o600);
    const publicInput = configReadPin(request.publicDescriptor, ownerUid, stop, 0o644);
    const config = JSON.parse(privateInput.bytes), runtime = verified.manifest.runtime;
    validateFirstForwardPlans(config);
    forwardAssert(exactKeys(config.stateLock, 'schema,flock') && config.stateLock.schema === 'nassaj-cutover-state-lock/v2'
        && exactKeys(config.stateLock.flock, 'path,sha256') && config.stateLock.flock.path === '/usr/bin/flock'
        && config.stateLock.flock.sha256 === request.flockSha256, 'config_state_lock');
    const { generation, manifest } = verifyConfigGeneration(config, runtime, ownerUid, stop);
    verifyConfigGenerationPaths(config, generation, manifest, ownerUid, stop);
    verifyPrivateForwardMaterial(config, generation, manifest, ownerUid, stop);
    verifyHostIdentity(config, request, expected, ownerUid, stop, injected);
    verifySharedSupport(expected, generation, manifest, ownerUid, stop);
    const dispatcher = expected.find(file => file.relative === 'scripts/release-runtime-host-dispatcher.mjs');
    forwardAssert(config.forwardActivation.dispatcher?.path === dispatcher.target
        && config.forwardActivation.dispatcher.sha256 === dispatcher.sha256
        && config.bootstrapClaim.dispatcherExecutable === dispatcher.target
        && config.bootstrapClaim.dispatcherSha256 === dispatcher.sha256, 'config_dispatcher');
    const generated = generateStartupPublicDescriptor({ effectiveUid: () => 0,
        readRootBytes(file, privateFile = false, maximum = 16 * 1024 * 1024) {
            if (file === HOST_CONFIG) return privateInput.bytes;
            const systemFile = injected.allowUnprivileged && !file.startsWith(stop + '/');
            const observed = forwardRead(file, systemFile ? 0 : ownerUid, { stop: systemFile ? '/' : stop,
                mode: privateFile ? 0o600 : undefined, maxBytes: maximum });
            if (maximum === 256 * 1024 * 1024) forwardAssert(!!(observed.mode & 0o111), 'config_executable');
            return observed.bytes;
        }, ...(injected.inspectDatabase ? { inspectDatabase: injected.inspectDatabase } : {}) });
    forwardAssert(Buffer.from(generated).equals(publicInput.bytes), 'config_descriptor');
    return { privateInput, publicInput };
}
/** Install only separately reviewed, release-bound configuration bytes; never initialize or activate runtime state. */
export function installForwardReleaseConfiguration(request, injected = {}) {
    configInstallRequest(request);
    forwardAssert(injected.allowUnprivileged || process.geteuid() === 0, 'root_required');
    const owner = injected.allowUnprivileged ? process.geteuid() : 0, initialStop = injected.fixtureRoot || '/';
    const initial = forwardRead(request.installerArchive.path, owner, { stop: initialStop });
    forwardSources(injected.sourceRoot || SOURCE_ROOT, verifyForwardInstallerArchive(initial.bytes, request.installerArchive), owner, injected);
    return forwardLock(request, injected, (ownerUid, stop) => {
        const archive = forwardRead(request.installerArchive.path, ownerUid, { stop });
        const verified = verifyForwardInstallerArchive(archive.bytes, request.installerArchive);
        const expected = forwardSources(injected.sourceRoot || SOURCE_ROOT, verified, ownerUid, injected);
        const map = file => injected.mapTarget ? injected.mapTarget(file) : file;
        const attestationFile = map(DEFAULT_ATTESTATION);
        const before = JSON.parse(forwardRead(attestationFile, ownerUid, { stop, mode: 0o600 }).bytes);
        forwardAssert(before?.schema === FORWARD_ATTESTATION_SCHEMA && before.profile === 'forward'
            && ['support_installed', 'configuration_attested'].includes(before.phase), 'config_partial');
        const pins = { installerArchive: { sha256: archive.sha256, size: archive.size },
            installerManifest: { sha256: sha(verified.manifestBytes), size: verified.manifestBytes.length },
            runtimeManifest: { sha256: verified.manifest.runtime.artifact.manifestSha256, size: verified.manifest.runtime.artifact.manifestSize } };
        const support = forwardAttestation(expected, pins, ownerUid, injected);
        const previousSupport = { ...before, phase: 'support_installed', configHandoff: { ready: false, files: [] } };
        forwardAssert(canonicalLocalIdentity(support) === canonicalLocalIdentity(previousSupport), 'config_support_drift');
        const material = preparedConfigMaterial(request, verified, expected, ownerUid, stop, injected);
        const targets = [{ path: map(PUBLIC_DESCRIPTOR), ...material.publicInput, mode: 0o644 },
            { path: map(HOST_CONFIG), ...material.privateInput, mode: 0o600 }];
        const handoff = { ready: true, files: targets.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 })).sort((a, b) => a.path < b.path ? -1 : 1) };
        if (before.phase === 'configuration_attested') {
            forwardAssert(canonicalLocalIdentity(before.configHandoff) === canonicalLocalIdentity(handoff), 'config_handoff_drift');
            for (const target of targets) configReadPin(target, ownerUid, stop, target.mode);
            return { state: 'already_configured', ...before };
        }
        forwardAssert(before.configHandoff?.ready === false && Array.isArray(before.configHandoff.files)
            && before.configHandoff.files.length === 0, 'config_handoff_drift');
        for (const target of targets) forwardAssert(forwardLstat(target.path) === null, 'config_existing_target');
        atomicInstall(attestationFile, Buffer.from(JSON.stringify({ ...support, phase: 'configuring' }) + '\n'), 0o600, ownerUid, { stop });
        for (const target of targets) atomicInstall(target.path, target.bytes, target.mode, ownerUid, { stop });
        const finalMaterial = preparedConfigMaterial(request, verified, expected, ownerUid, stop, injected);
        forwardAssert(finalMaterial.privateInput.bytes.equals(material.privateInput.bytes)
            && finalMaterial.publicInput.bytes.equals(material.publicInput.bytes), 'config_input_changed');
        for (const target of targets) configReadPin(target, ownerUid, stop, target.mode);
        const finalSupport = forwardAttestation(expected, pins, ownerUid, injected);
        forwardAssert(canonicalLocalIdentity(finalSupport) === canonicalLocalIdentity(support), 'config_support_drift');
        const complete = { ...support, phase: 'configuration_attested', configHandoff: handoff };
        atomicInstall(attestationFile, Buffer.from(JSON.stringify(complete) + '\n'), 0o600, ownerUid, { stop });
        return { state: 'configured', ...complete };
    });
}
async function readForwardRequest() {
    const parts = []; let size = 0;
    const timer = setTimeout(() => { process.stderr.write('Forward installer request timeout.\n'); process.exit(78); }, 5000);
    try {
        for await (const chunk of process.stdin) { size += chunk.length; forwardAssert(size <= 65536, 'request_size'); parts.push(chunk); }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } finally { clearTimeout(timer); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length === 3 && process.argv[2] === '--forward-config') {
            process.stdout.write(`${JSON.stringify(installForwardReleaseConfiguration(await readForwardRequest()))}\n`);
        } else if (process.argv.length === 3 && process.argv[2] === '--forward') {
            process.stdout.write(`${JSON.stringify(installForwardReleaseHostSupport(await readForwardRequest()))}\n`);
        } else {
        if (process.argv.length !== 2) throw new Error('release_host_support_installer_accepts_no_arguments');
        process.stdout.write(`${JSON.stringify(installReleaseHostSupport())}\n`);
        }
    } catch (error) {
        const forward = process.argv[2] === '--forward' || process.argv[2] === '--forward-config';
        const reason = !forward || /^(release_host_support_forward_|public_descriptor_|installed_config_|forward_initialization_)[a-z0-9_]+$/.test(error.message)
            ? error.message : 'release_host_support_forward_validation_failed';
        process.stderr.write(`Nassaj release host support install blocked (${reason}).\n`); process.exitCode = 78;
    }
}
