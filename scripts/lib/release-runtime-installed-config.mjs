/** Read the completed root installation as one stable observation before granting runtime authority. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const INSTALLED_HOST_CONFIG_PATH = '/etc/nassaj/release-runtime-host.json';
const PUBLIC = '/etc/nassaj/startup-admission-client.json';
const ATTESTATION = '/etc/nassaj/release-host-support-attestation.json';
const OPERATOR = '/usr/local/lib/nassaj-release-operator';
const ROOTS = ['scripts/nassaj-maintenance-responder.mjs', 'scripts/release-runtime-host-dispatcher.mjs'];
const LIMIT = 256 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys;
const same = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
function requireValue(ok, reason) { if (!ok) throw Error(`installed_config_${reason}`); }
function trustedPath(file) {
    requireValue(path.isAbsolute(file) && fs.realpathSync(file) === file, 'path');
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
        const info = fs.lstatSync(parent);
        requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022), 'ancestor');
        if (parent === '/') break;
    }
}
function measured(file, mode, maximum = LIMIT, minimum = 1) {
    trustedPath(file);
    const before = fs.lstatSync(file);
    requireValue(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.nlink === 1
        && (before.mode & 0o777) === mode && before.size >= minimum && before.size <= maximum, 'metadata');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        requireValue(same(before, fs.fstatSync(fd)), 'changed');
        const chunks = []; let total = 0;
        while (total <= before.size) {
            const chunk = Buffer.alloc(Math.min(65536, before.size + 1 - total));
            const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
            chunks.push(chunk.subarray(0, count)); total += count;
        }
        requireValue(total === before.size && same(before, fs.fstatSync(fd)) && same(before, fs.lstatSync(file)), 'changed');
        trustedPath(file);
        const bytes = Buffer.concat(chunks, total);
        return { file, info: before, bytes, sha256: sha(bytes) };
    } finally { fs.closeSync(fd); }
}
function optionalAttestation() {
    try { return measured(ATTESTATION, 0o600); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { fs.lstatSync(ATTESTATION); } catch (absent) { if (absent.code === 'ENOENT') return null; throw absent; }
        throw Error('installed_config_changed');
    }
}
function pin(value) {
    return exact(value, 'sha256,size') && /^[a-f0-9]{64}$/.test(value.sha256)
        && Number.isSafeInteger(value.size) && value.size > 0;
}
function assertLegacy(value) {
    requireValue(value?.schema === 'nassaj-release-runtime-host-config/v1', 'schema');
    const pending = [value];
    const forwardKeys = new Set(['forwardActivation', 'forwardMigration', 'bootstrapClaim', 'managedRestart',
        'localBuild', 'localArtifact', 'artifactPolicy', 'forwardExecutableClosureSha256', 'startupClosureSha256']);
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === 'string') {
            requireValue(!/(?:^|[/.-])forward(?:[/.-]|$)|compatible-forward|local-forward|startup-admission|STARTUP_CLOSURE|release-runtime-managed|managed-safe-restart-client/.test(item), 'attestation_required');
        } else if (item && typeof item === 'object') {
            requireValue(Object.keys(item).every(key => !forwardKeys.has(key)), 'attestation_required');
            pending.push(...Object.values(item));
        }
    }
    try { fs.lstatSync(PUBLIC); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw Error('installed_config_attestation_required');
}
function installedTarget(relative) {
    requireValue(typeof relative === 'string' && relative.length <= 512
        && !relative.includes('\\') && !/[\x00-\x1f]/.test(relative)
        && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'support_path');
    if (relative === 'ops/nassaj-maintenance.service') return '/etc/systemd/system/nassaj-maintenance.service';
    requireValue(/^scripts\/.+\.(?:mjs|js)$/.test(relative) || relative.startsWith('node_modules/semver/')
        || relative === 'server/modules/database/canonical-schema-digest.js' || relative === 'package.json', 'support_path');
    return `${OPERATOR}/${relative}`;
}
function verifySupport(record) {
    requireValue(Array.isArray(record.files) && record.files.length >= ROOTS.length && record.files.length <= 512, 'support_files');
    let previous = '', text = '';
    const observations = [], included = new Map();
    for (const file of record.files) {
        requireValue(exact(file, 'mode,path,relative,sha256,size') && file.relative > previous
            && file.path === installedTarget(file.relative) && file.mode === (ROOTS.includes(file.relative) ? 0o555 : 0o444)
            && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.size)
            && file.size >= 0 && file.size <= 16 * 1024 * 1024, 'support_record');
        const observed = measured(file.path, file.mode, 16 * 1024 * 1024, 0);
        requireValue(observed.sha256 === file.sha256 && observed.bytes.length === file.size, 'support_drift');
        observations.push(observed); included.set(file.relative, file);
        text += `${file.relative}\0${file.mode}\0${file.size}\0${file.sha256}\n`; previous = file.relative;
    }
    requireValue(ROOTS.every(root => included.has(root)) && sha(text) === record.sourceSetSha256, 'source_set');
    return { observations, dispatcher: included.get(ROOTS[1]) };
}
function verifyHandoff(record, config, descriptor) {
    requireValue(exact(record.configHandoff, 'files,ready') && record.configHandoff.ready === true
        && Array.isArray(record.configHandoff.files) && record.configHandoff.files.length === 2, 'handoff');
    const observations = [config, descriptor].sort((a, b) => a.file < b.file ? -1 : 1);
    for (const [index, observed] of observations.entries()) {
        const file = record.configHandoff.files[index];
        requireValue(exact(file, 'mode,path,sha256,size') && file.path === observed.file
            && file.mode === (observed.info.mode & 0o777) && file.size === observed.bytes.length
            && file.sha256 === observed.sha256, 'handoff_drift');
    }
}
function verifyBindings(record, value, descriptor, dispatcher) {
    requireValue(value?.schema === 'nassaj-release-runtime-host-config/v1'
        && value.bootstrapClaim?.releaseManifestSha256 === record.runtimeManifest.sha256
        && typeof value.bootstrapClaim.releaseManifestFile === 'string', 'runtime_binding');
    const manifest = measured(value.bootstrapClaim.releaseManifestFile, 0o600, 32 * 1024 * 1024);
    requireValue(manifest.sha256 === record.runtimeManifest.sha256 && manifest.bytes.length === record.runtimeManifest.size, 'runtime_binding');
    if (value.expected?.localArtifact !== undefined) {
        requireValue(value.expected.localArtifact?.manifestSha256 === record.runtimeManifest.sha256
            && value.expected.localArtifact.manifestSize === record.runtimeManifest.size, 'runtime_binding');
    }
    const publicValue = JSON.parse(descriptor.bytes);
    for (const [file, hash] of [[value.forwardActivation?.dispatcher?.path, value.forwardActivation?.dispatcher?.sha256],
        [value.bootstrapClaim.dispatcherExecutable, value.bootstrapClaim.dispatcherSha256],
        [publicValue.dispatcher?.path, publicValue.dispatcher?.sha256]]) {
        requireValue(file === dispatcher.path && hash === dispatcher.sha256, 'dispatcher_binding');
    }
    return manifest;
}
function assertStable(observations, before) {
    for (const observation of observations) {
        const current = measured(observation.file, observation.info.mode & 0o777, Math.max(LIMIT, observation.bytes.length), 0);
        requireValue(same(observation.info, current.info) && current.sha256 === observation.sha256, 'changed');
    }
    const after = optionalAttestation();
    requireValue(before ? after && same(before.info, after.info) && before.sha256 === after.sha256 : !after, 'changed');
}

/** Return the exact checked host bytes; no request, environment, path or dependency override is accepted. */
export function readInstalledHostConfiguration() {
    requireValue(process.geteuid?.() === 0, 'root_required');
    const before = optionalAttestation(), record = before ? JSON.parse(before.bytes) : null;
    requireValue(before === null || (record && typeof record === 'object' && !Array.isArray(record)
        && ['nassaj-release-host-support-attestation/v1', 'nassaj-release-host-support-attestation/v2'].includes(record.schema)), 'attestation_schema');
    requireValue(before === null || record.phase === undefined || record.phase === 'configuration_attested', 'not_configured');
    const config = measured(INSTALLED_HOST_CONFIG_PATH, 0o600), value = JSON.parse(config.bytes);
    if (before === null || record.schema === 'nassaj-release-host-support-attestation/v1') {
        assertLegacy(value); assertStable([config], before); return { ...config, value, attestation: record };
    }
    requireValue(exact(record, 'configHandoff,effectiveUnitSha256,effectiveUnitSize,files,installerArchive,installerManifest,phase,profile,runtimeManifest,schema,sourceSetSha256')
        && record.profile === 'forward' && record.phase === 'configuration_attested'
        && [record.installerArchive, record.installerManifest, record.runtimeManifest].every(pin)
        && /^[a-f0-9]{64}$/.test(record.sourceSetSha256) && /^[a-f0-9]{64}$/.test(record.effectiveUnitSha256)
        && Number.isSafeInteger(record.effectiveUnitSize) && record.effectiveUnitSize > 0, 'attestation_shape');
    const descriptor = measured(PUBLIC, 0o644);
    verifyHandoff(record, config, descriptor);
    const support = verifySupport(record);
    const manifest = verifyBindings(record, value, descriptor, support.dispatcher);
    assertStable([config, descriptor, manifest, ...support.observations], before);
    return { ...config, value, descriptorBytes: descriptor.bytes, attestation: record };
}
