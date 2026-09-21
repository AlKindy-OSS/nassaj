/** Private, measured offline-build inputs; this configuration never grants activation authority. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitControlPath } from '../git-control-root.mjs';
import { readPublicationControlJson } from './client-publication-policy.mjs';
import { CLIENT_PUBLICATION_RESERVE_BYTES } from './client-publication-archive.mjs';
import { canonicalTripleJson } from './oid-triple-target.mjs';

export const LOCAL_BUILD_PROFILE = 'nassaj-local-build-profile-v1.json';
export const LOCAL_BUILD_RESERVE_BYTES = CLIENT_PUBLICATION_RESERVE_BYTES;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const HASH = /^[a-f0-9]{64}$/;

/** Version-only bumps do not change the measured dependency/install inputs. */
export function localBuildDependencyInputDigest(pkg, lock) {
    const rootFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
        'overrides', 'engines', 'packageManager', 'allowScripts', 'scripts'];
    const packageInputs = Object.fromEntries(rootFields.filter(key => Object.hasOwn(pkg, key)).map(key => [key, pkg[key]]));
    const packages = { ...lock.packages }; delete packages[''];
    return hash(canonicalTripleJson({ packageInputs, lockfileVersion: lock.lockfileVersion, packages }));
}

/** Measure immutable source size and bind build tooling independently of package versions. */
export function localBuildSourceInputs(root, oid) {
    if (!/^[a-f0-9]{40}$/.test(oid)) fail('local_update_build_inputs_unqualified');
    const entries = execFileSync('git', ['ls-tree', '-rlz', oid], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 })
        .split('\0').filter(Boolean);
    let sourceBytes = 0;
    const configuration = [];
    for (const entry of entries) {
        const match = /^(\d+) (\w+) ([a-f0-9]{40})\s+(\d+|-)\t(.+)$/.exec(entry);
        if (!match || match[2] !== 'blob') fail('local_update_build_inputs_unqualified');
        sourceBytes += Number(match[4]);
        const file = match[5];
        if (file.startsWith('scripts/') || /(^|\/)(?:\.npmrc|[^/]*config\.[^/]+)$/.test(file)) configuration.push(entry);
    }
    if (!Number.isSafeInteger(sourceBytes)) fail('local_update_build_inputs_unqualified');
    return { sourceBytes, buildConfigurationSha256: hash(canonicalTripleJson(configuration)) };
}

function regularHash(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.mode & 0o022) fail('local_update_build_profile_unsafe');
        return hash(fs.readFileSync(fd));
    } finally { fs.closeSync(fd); }
}

function projectDirectory(root, value) {
    if (typeof value !== 'string' || !value.startsWith(`${root}/`) || fs.realpathSync(value) !== value) fail('local_update_build_profile_unsafe');
    const stat = fs.lstatSync(value);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o022) fail('local_update_build_profile_unsafe');
    return value;
}

/** Load private configuration and tie its measurements to this immutable target and toolchain. */
export function readLocalBuildProfile(root, oid) {
    let profile;
    try { profile = readPublicationControlJson(gitControlPath(root, LOCAL_BUILD_PROFILE)); }
    catch (error) { if (error.code === 'ENOENT') fail('local_update_build_profile_required'); throw error; }
    if (profile.schema !== 'nassaj-local-build-profile/v1' || profile.root !== fs.realpathSync(root)
        || !HASH.test(profile.dependencyInputSha256 || '') || !HASH.test(profile.measurementSha256 || '')) fail('local_update_build_profile_invalid');
    const read = name => JSON.parse(execFileSync('git', ['show', `${oid}:${name}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 }));
    if (!/^[a-f0-9]{40}$/.test(oid) || localBuildDependencyInputDigest(read('package.json'), read('package-lock.json')) !== profile.dependencyInputSha256) {
        fail('local_update_build_inputs_unqualified');
    }
    const runtime = profile.runtime;
    if (runtime?.nodeVersion !== process.version || runtime.nodeModuleAbi !== process.versions.modules
        || runtime.nodeBinarySha256 !== regularHash(fs.realpathSync(process.execPath))
        || !path.isAbsolute(runtime.npmCliPath || '') || fs.realpathSync(runtime.npmCliPath) !== runtime.npmCliPath
        || runtime.npmCliSha256 !== regularHash(runtime.npmCliPath)) fail('local_update_build_runtime_changed');
    const measurementPath = profile.measurementPath;
    if (typeof measurementPath !== 'string' || !measurementPath.startsWith(`${root}/`) || fs.realpathSync(measurementPath) !== measurementPath
        || regularHash(measurementPath) !== profile.measurementSha256) fail('local_update_build_measurement_changed');
    const measured = readPublicationControlJson(measurementPath);
    if (measured.schema !== 'nassaj-local-build-working-set/v1' || measured.dependencyInputSha256 !== profile.dependencyInputSha256
        || canonicalTripleJson(measured.runtime) !== canonicalTripleJson(runtime)
        || canonicalTripleJson(measured.phaseAdditionalBytes) !== canonicalTripleJson(profile.phaseAdditionalBytes)) fail('local_update_build_measurement_changed');
    const source = localBuildSourceInputs(root, oid);
    if (!Number.isSafeInteger(profile.sourceInventoryBytesMax) || profile.sourceInventoryBytesMax < 1
        || profile.sourceInventoryBytesMax !== measured.sourceInventoryBytesMax
        || profile.buildConfigurationSha256 !== measured.buildConfigurationSha256
        || source.buildConfigurationSha256 !== profile.buildConfigurationSha256
        || source.sourceBytes > profile.sourceInventoryBytesMax) fail('local_update_build_inputs_unqualified');
    for (const phase of ['prepare', 'install', 'build', 'store']) {
        if (!Number.isSafeInteger(profile.phaseAdditionalBytes?.[phase]) || profile.phaseAdditionalBytes[phase] < 1) fail('local_update_build_capacity_unknown');
    }
    projectDirectory(root, profile.cachePath); projectDirectory(root, profile.headersPath);
    assertRequiredOfflineCache(read('package-lock.json'), profile.cachePath);
    if (!fs.existsSync(path.join(profile.headersPath, 'include/node/node.h'))) fail('local_update_build_headers_missing');
    return profile;
}

/** Required packages must be cached before admission; optional platform inputs are decided by npm. */
export function assertRequiredOfflineCache(lock, cachePath) {
    for (const [name, item] of Object.entries(lock.packages || {})) {
        if (!name || item.optional === true) continue;
        const matched = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(item.integrity || '');
        if (!matched) fail('local_update_build_cache_missing');
        const hex = Buffer.from(matched[2], 'base64').toString('hex');
        if (hex.length !== (matched[1] === 'sha512' ? 128 : 64)) fail('local_update_build_cache_missing');
        const file = path.join(cachePath, '_cacache/content-v2', matched[1], hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.isSymbolicLink()) fail('local_update_build_cache_missing');
    }
}

/** Compare remaining additional allocation with available disk bytes; reserve is counted once. */
export function assertLocalBuildCapacity(root, profile, phase, inspect = fs.statfsSync) {
    const additionalBytes = profile.phaseAdditionalBytes?.[phase], disk = inspect(root);
    const availableBytes = disk.bavail * disk.bsize;
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 1 || disk.type === 0x01021994
        || !Number.isSafeInteger(availableBytes) || availableBytes < 0) fail('local_update_build_capacity_unknown');
    if (availableBytes < LOCAL_BUILD_RESERVE_BYTES + additionalBytes) fail('local_update_build_capacity_wait');
    return { phase, additionalBytes, availableBytes, reserveBytes: LOCAL_BUILD_RESERVE_BYTES };
}

/** Create attempt-local npm configuration without inheriting real HOME, proxy or npmrc credentials. */
export function createOfflineBuildEnvironment(profile, scratch, original = process.env) {
    const home = path.join(scratch.candidateRoot, 'home'); fs.mkdirSync(home, { mode: 0o700 });
    const userconfig = path.join(home, 'npmrc'), globalconfig = path.join(home, 'global-npmrc');
    fs.writeFileSync(globalconfig, '', { mode: 0o600, flag: 'wx' });
    const settings = { offline: 'true', cache: profile.cachePath, nodedir: profile.headersPath,
        registry: 'https://registry.npmjs.org/', 'replace-registry-host': 'never',
        'ignore-scripts': 'false', 'dangerously-allow-all-scripts': 'false', 'strict-allow-scripts': 'false' };
    for (const value of Object.values(settings)) if (/[\r\n]/.test(value)) fail('local_update_build_profile_unsafe');
    fs.writeFileSync(userconfig, Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
    return { PATH: original.PATH, HOME: home, TMPDIR: path.join(scratch.candidateRoot, 'tmp'), HUSKY: '0', NODE_ENV: 'production',
        npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
        npm_config_cache: profile.cachePath, npm_config_offline: 'true', npm_config_nodedir: profile.headersPath,
        npm_config_registry: settings.registry, npm_config_replace_registry_host: 'never' };
}
