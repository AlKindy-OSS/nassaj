import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { localBuildDependencyInputDigest, localBuildSourceInputs, assertLocalBuildCapacity, assertRequiredOfflineCache,
    createOfflineBuildEnvironment, readLocalBuildProfile, LOCAL_BUILD_PROFILE, LOCAL_BUILD_RESERVE_BYTES } from './local-build-profile.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.artifacts/build-profile-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
    fs.chmodSync(path.join(root, '.git'), 0o700);
    const pkg = { version: '1.0.0.0', dependencies: {}, allowScripts: {} }, lock = { lockfileVersion: 3, packages: { '': pkg } };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg)); fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    git(root, 'add', 'package.json', 'package-lock.json'); git(root, 'commit', '-qm', 'fixture');
    const cachePath = path.join(root, 'cache'), headersPath = path.join(root, 'headers');
    fs.mkdirSync(cachePath, { mode: 0o700 }); fs.mkdirSync(path.join(headersPath, 'include/node'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(headersPath, 'include/node/node.h'), '// test fixture');
    const npmCliPath = path.join(root, 'npm-cli.js'); fs.writeFileSync(npmCliPath, '// pinned test npm', { mode: 0o600 });
    const runtime = { nodeVersion: process.version, nodeModuleAbi: process.versions.modules,
        nodeBinarySha256: hash(fs.readFileSync(process.execPath)), npmCliPath, npmCliSha256: hash(fs.readFileSync(npmCliPath)) };
    const dependencyInputSha256 = localBuildDependencyInputDigest(pkg, lock), phaseAdditionalBytes = { prepare: 1024, install: 1024, build: 512, store: 256 };
    const sourceInputs = { sourceInventoryBytesMax: 4096, buildConfigurationSha256: localBuildSourceInputs(root, git(root, 'rev-parse', 'HEAD')).buildConfigurationSha256 };
    const measurementPath = path.join(root, 'measurement.json');
    const measured = JSON.stringify({ schema: 'nassaj-local-build-working-set/v1', dependencyInputSha256, runtime, phaseAdditionalBytes, ...sourceInputs });
    fs.writeFileSync(measurementPath, measured, { mode: 0o600 });
    const profile = { schema: 'nassaj-local-build-profile/v1', root, runtime, dependencyInputSha256, phaseAdditionalBytes, ...sourceInputs,
        measurementPath, measurementSha256: hash(measured), cachePath, headersPath };
    const file = path.join(root, '.git', LOCAL_BUILD_PROFILE);
    fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
    return { root, file, profile, pkg, lock, oid: git(root, 'rev-parse', 'HEAD') };
}

test('profile binds measured dependency inputs and toolchain while allowing version-only changes', t => {
    const v = fixture(t); assert.deepEqual(readLocalBuildProfile(v.root, v.oid), v.profile);
    assert.equal(localBuildDependencyInputDigest({ ...v.pkg, version: '2.0.0.0' }, { ...v.lock, packages: { '': { version: '2.0.0.0' } } }), v.profile.dependencyInputSha256);
    assert.notEqual(localBuildDependencyInputDigest({ ...v.pkg, dependencies: { new: '1' } }, v.lock), v.profile.dependencyInputSha256);
    assert.notEqual(localBuildDependencyInputDigest({ ...v.pkg, scripts: { prepare: 'new-builder' } }, v.lock), v.profile.dependencyInputSha256);
    fs.appendFileSync(v.profile.runtime.npmCliPath, 'changed');
    assert.throws(() => readLocalBuildProfile(v.root, v.oid), /runtime_changed/);
});

test('source edits within measured margin are allowed; tooling changes or source growth require qualification', t => {
    const v = fixture(t);
    fs.writeFileSync(path.join(v.root, 'component.tsx'), 'export const small = 1;');
    git(v.root, 'add', 'component.tsx'); git(v.root, 'commit', '-qm', 'small source edit');
    readLocalBuildProfile(v.root, git(v.root, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(v.root, 'vite.config.ts'), 'export default {};');
    git(v.root, 'add', 'vite.config.ts'); git(v.root, 'commit', '-qm', 'build configuration');
    assert.throws(() => readLocalBuildProfile(v.root, git(v.root, 'rev-parse', 'HEAD')), /inputs_unqualified/);
    fs.unlinkSync(path.join(v.root, 'vite.config.ts'));
    fs.writeFileSync(path.join(v.root, 'component.tsx'), 'x'.repeat(4097));
    git(v.root, 'add', 'component.tsx', 'vite.config.ts'); git(v.root, 'commit', '-qm', 'source beyond measured margin');
    assert.throws(() => readLocalBuildProfile(v.root, git(v.root, 'rev-parse', 'HEAD')), /inputs_unqualified/);
});

test('missing or altered profile/measurement fail before install or a build claim', t => {
    const v = fixture(t); fs.appendFileSync(v.profile.measurementPath, ' ');
    assert.throws(() => readLocalBuildProfile(v.root, v.oid), /measurement_changed/);
    fs.unlinkSync(v.file); assert.throws(() => readLocalBuildProfile(v.root, v.oid), /profile_required/);
});

test('capacity uses additional allocation plus one reserve and rejects unknown/tmpfs/insufficient space', () => {
    const profile = { phaseAdditionalBytes: { prepare: 512 } };
    const inspect = bytes => () => ({ type: 0xef53, bavail: bytes, bsize: 1 });
    assert.equal(assertLocalBuildCapacity('/unused', profile, 'prepare', inspect(LOCAL_BUILD_RESERVE_BYTES + 512)).additionalBytes, 512);
    assert.throws(() => assertLocalBuildCapacity('/unused', profile, 'prepare', inspect(LOCAL_BUILD_RESERVE_BYTES + 511)), /capacity_wait/);
    assert.throws(() => assertLocalBuildCapacity('/unused', profile, 'unknown', inspect(1e12)), /capacity_unknown/);
    assert.throws(() => assertLocalBuildCapacity('/unused', profile, 'prepare', () => ({ type: 0x01021994, bavail: 1e12, bsize: 1 })), /capacity_unknown/);
});

test('required cache miss defers but optional WASM input is decided by actual npm installation', t => {
    const v = fixture(t), bytes = Buffer.from('test tarball'), hex = createHash('sha512').update(bytes).digest('hex');
    const integrity = `sha512-${Buffer.from(hex, 'hex').toString('base64')}`;
    const lock = { packages: { '': {}, 'node_modules/required': { integrity }, 'node_modules/optional-wasm': { optional: true } } };
    assert.throws(() => assertRequiredOfflineCache(lock, v.profile.cachePath), /cache_missing/);
    const file = path.join(v.profile.cachePath, '_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    assertRequiredOfflineCache(lock, v.profile.cachePath);
    fs.unlinkSync(file); fs.symlinkSync(v.file, file);
    assert.throws(() => assertRequiredOfflineCache(lock, v.profile.cachePath), /cache_missing/);
});

test('offline environment uses attempt-local configuration and excludes host secrets/proxies', t => {
    const v = fixture(t), scratch = { candidateRoot: path.join(v.root, 'attempt') }; fs.mkdirSync(scratch.candidateRoot);
    const env = createOfflineBuildEnvironment(v.profile, scratch, { PATH: '/usr/bin', HOME: '/secret-home', HTTPS_PROXY: 'http://secret', NPM_TOKEN: 'secret' });
    assert.equal(env.HOME, path.join(scratch.candidateRoot, 'home')); assert.equal(env.HTTPS_PROXY, undefined); assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.npm_config_offline, 'true'); assert.match(fs.readFileSync(env.npm_config_userconfig, 'utf8'), /offline=true/);
    assert.equal(fs.readFileSync(env.npm_config_globalconfig, 'utf8'), '');
});
