#!/usr/bin/env node
/** Build a deterministic, dependency-closed installer archive requiring no checkout or npm. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateLocalBuildCore, validateLocalPreparedArtifact, LOCAL_BUILD_KIND } from './lib/local-reviewed-build-identity.mjs';
import { collectUpdateRuntimeClosure } from './lib/update-runtime-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+\.\d+\.\d+\.\d+$/; const SHA40 = /^[a-f0-9]{40}$/;
const ENTRIES = Object.freeze(['scripts/install-release-runtime.mjs', 'scripts/bootstrap-release-runtime.mjs',
    'scripts/nassaj-release-launcher.mjs', 'scripts/prepare-legacy-release-runtime.mjs', 'scripts/release-runtime-cutover.mjs',
    'scripts/release-runtime-host-dispatcher.mjs', 'scripts/lib/release-runtime-cutover.mjs',
    'scripts/lib/release-runtime-owner-adapter.mjs', 'scripts/lib/release-runtime-host-operations.mjs',
    'scripts/lib/release-database-preservation.mjs',
    'scripts/install-release-runtime-recovery.mjs', 'scripts/lib/release-runtime-recovery-installer.mjs',
    'scripts/release-runtime-cutover-recovery.mjs',
    'scripts/release-runtime-gate-restore.mjs',
    'scripts/nassaj-maintenance-responder.mjs', 'scripts/install-release-host-support.mjs',
    'ops/nassaj-first-cutover-recovery.service', 'ops/nassaj-maintenance.service',
    'ops/nassaj-cutover-gate-restore.service',
    'ops/systemd/cloudflared.service.d/20-nassaj-maintenance-order.conf',
    'ops/systemd/pm2-nassaj.service.d/20-nassaj-maintenance-order.conf',
    'ops/systemd/pm2-nassaj-dev.service.d/20-nassaj-maintenance-order.conf',
    'ops/systemd/nassaj-first-cutover-recovery.service.d/20-nassaj-maintenance-order.conf']);
const FORWARD_ENTRIES = Object.freeze(['scripts/bootstrap-release-runtime.mjs', 'scripts/nassaj-release-launcher.mjs',
    'scripts/generate-first-cutover-config.mjs', 'scripts/mint-cutover-approval.mjs', 'scripts/install-release-host-support.mjs',
    'scripts/nassaj-maintenance-responder.mjs', 'scripts/release-runtime-host-dispatcher.mjs', 'ops/nassaj-maintenance.service']);
const HOST_ROOTS = Object.freeze(['scripts/nassaj-maintenance-responder.mjs', 'scripts/release-runtime-host-dispatcher.mjs']);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);

function collectRegularFiles(directory, root, output) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name); const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink()) throw new Error(`Installer vendor source is unsafe: ${absolute}`);
        if (entry.isDirectory()) collectRegularFiles(absolute, root, output);
        else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
        else throw new Error(`Installer vendor source is not regular: ${absolute}`);
    }
}

function validateForwardIdentity(options) {
    const runtime = options.runtime;
    if (!runtime || Object.keys(runtime).sort().join(',') !== 'artifact,build,kind' || runtime.kind !== LOCAL_BUILD_KIND) {
        throw new Error('Forward installer runtime identity invalid.');
    }
    validateLocalBuildCore(runtime.build); validateLocalPreparedArtifact(runtime.artifact, runtime.build);
    if (runtime.build.commit !== options.commit || runtime.build.version !== options.version) throw new Error('Forward installer runtime release mismatch.');
    return runtime;
}
function copyInstallerSource(sourceRoot, staging, relative, targetRelative = relative) {
    const source = path.join(sourceRoot, relative), metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Installer closure source unsafe: ${relative}`);
    const target = path.join(staging, targetRelative); mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target); chmodSync(target, metadata.mode & 0o111 ? 0o755 : 0o644);
}
function forwardNativeDependencies(sourceRoot, staging) {
    const semverRoot = path.join(sourceRoot, 'node_modules/semver');
    const semverFiles = []; collectRegularFiles(semverRoot, sourceRoot, semverFiles);
    const lock = JSON.parse(readFileSync(path.join(sourceRoot, 'package-lock.json')));
    const semver = JSON.parse(readFileSync(path.join(semverRoot, 'package.json')));
    if (lock.packages?.['node_modules/semver']?.version !== semver.version) throw new Error('Forward installer semver lock mismatch.');
    for (const relative of semverFiles) copyInstallerSource(sourceRoot, staging, relative);
    const vendorRoot = path.join(sourceRoot, 'scripts/vendor/pm2-codec');
    const vendor = JSON.parse(readFileSync(path.join(vendorRoot, 'SOURCE_MANIFEST.json')));
    const expectedPaths = ['amp-message/Readme.md', 'amp-message/index.js', 'amp-message/package.json', 'amp/Readme.md',
        'amp/index.js', 'amp/lib/decode.js', 'amp/lib/encode.js', 'amp/lib/stream.js', 'amp/package.json'];
    if (vendor.schema !== 'nassaj-pm2-codec-source/v1' || JSON.stringify(vendor.files.map(f => f.path)) !== JSON.stringify(expectedPaths)) {
        throw new Error('Forward installer codec inventory mismatch.');
    }
    for (const file of vendor.files) {
        const relative = `node_modules/${file.path}`, bytes = readFileSync(path.join(vendorRoot, file.path));
        if (bytes.length !== file.size || sha(bytes) !== file.sha256) throw new Error('Forward installer codec pin mismatch.');
        copyInstallerSource(vendorRoot, staging, file.path, relative);
    }
    return [...semverFiles, ...vendor.files.map(f => `node_modules/${f.path}`)];
}
function installerFileRecord(staging, relative) {
    const file = path.join(staging, relative), bytes = readFileSync(file);
    return { path: relative, mode: lstatSync(file).mode & 0o777, size: bytes.length, sha256: sha(bytes) };
}
function buildForwardInstaller(options, injected) {
    const runtime = validateForwardIdentity(options), sourceRoot = path.resolve(options.sourceRoot || ROOT);
    const output = path.resolve(options.outputDirectory); mkdirSync(output, { recursive: true });
    const scratch = mkdtempSync(path.join(options.temporaryRoot || '/var/tmp', 'nassaj-forward-installer-'));
    const staging = path.join(scratch, 'bundle'); mkdirSync(staging, { mode: 0o700 });
    try {
        const files = collectUpdateRuntimeClosure(sourceRoot, FORWARD_ENTRIES);
        for (const relative of files) copyInstallerSource(sourceRoot, staging, relative);
        const dependencies = forwardNativeDependencies(sourceRoot, staging); files.push(...dependencies);
        writeFileSync(path.join(staging, 'package.json'), '{"type":"module","private":true}\n', { mode: 0o644 });
        chmodSync(path.join(staging, 'package.json'), 0o644); files.push('package.json');
        const hostModules = collectUpdateRuntimeClosure(sourceRoot, HOST_ROOTS);
        const hostFiles = [...hostModules, ...dependencies.filter(f => f.startsWith('node_modules/semver/')),
            'package.json', 'ops/nassaj-maintenance.service'].sort().map(relative => {
            const record = installerFileRecord(staging, relative);
            const targetClass = relative === 'package.json' ? 'operator-package' : relative.startsWith('node_modules/')
                ? 'operator-dependency' : relative.startsWith('ops/') ? 'maintenance-unit' : 'operator-module';
            return { path: relative, targetClass, sourceMode: record.mode, installedMode: HOST_ROOTS.includes(relative) ? 0o555 : 0o444,
                size: record.size, sha256: record.sha256 };
        });
        writeFileSync(path.join(staging, 'HOST_SUPPORT_MANIFEST.json'), JSON.stringify({
            schema: 'nassaj-release-host-support-files/v1', roots: HOST_ROOTS, files: hostFiles }) + '\n', { mode: 0o644 });
        files.push('HOST_SUPPORT_MANIFEST.json'); chmodSync(path.join(staging, 'HOST_SUPPORT_MANIFEST.json'), 0o644);
        for (const relative of files) {
            for (let directory = path.dirname(path.join(staging, relative)); directory !== staging; directory = path.dirname(directory)) chmodSync(directory, 0o755);
        }
        const manifest = { schema: 'nassaj-installer-bundle/v2', profile: 'forward', version: options.version,
            commit: options.commit, runtime, files: [...new Set(files)].sort().map(f => installerFileRecord(staging, f)) };
        writeFileSync(path.join(staging, 'INSTALLER_BUNDLE_MANIFEST.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
        chmodSync(path.join(staging, 'INSTALLER_BUNDLE_MANIFEST.json'), 0o644);
        const assetName = `nassaj-installer-forward-v${options.version}.tar.gz`, asset = path.join(output, assetName);
        const top = [...new Set([...files.map(f => f.split('/')[0]), 'INSTALLER_BUNDLE_MANIFEST.json'])].sort();
        const result = (injected.run || spawnSync)('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
            '--format=ustar', '-czf', asset, '-C', staging, ...top], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error('Forward installer archive creation failed.');
        const bytes = readFileSync(asset), assetSha256 = sha(bytes), checksum = `${asset}.sha256`;
        writeFileSync(checksum, `${assetSha256}  ${assetName}\n`, { mode: 0o644 });
        return Object.freeze({ asset, assetName, assetSha256, size: bytes.length, checksum, manifest });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Build the selected explicit installer profile; legacy remains the default. */
export function buildReleaseInstaller(options, injected = {}) {
    if (!VERSION.test(options?.version || '') || !SHA40.test(options?.commit || '')) throw new Error('Installer release identity is invalid.');
    if (options.profile === 'forward') return buildForwardInstaller(options, injected);
    if (options.profile !== undefined && options.profile !== 'legacy') throw new Error('Installer profile invalid.');
    const sourceRoot = path.resolve(options.sourceRoot || ROOT); const output = path.resolve(options.outputDirectory);
    mkdirSync(output, { recursive: true });
    const scratch = mkdtempSync(path.join(options.temporaryRoot || os.tmpdir(), 'nassaj-installer-'));
    const staging = path.join(scratch, 'bundle'); mkdirSync(staging, { mode: 0o700 });
    try {
        const files = collectUpdateRuntimeClosure(sourceRoot, ENTRIES);
        for (const relative of files) {
            const source = path.join(sourceRoot, relative); const metadata = lstatSync(source);
            if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Installer closure source is unsafe: ${relative}`);
            const target = path.join(staging, relative); mkdirSync(path.dirname(target), { recursive: true });
            copyFileSync(source, target); chmodSync(target, metadata.mode & 0o111 ? 0o755 : 0o644);
        }
        const verifier = path.join(staging, 'scripts/lib/update-release-asset.mjs');
        const verifierSource = readFileSync(verifier, 'utf8');
        const rewritten = verifierSource.replace("import { satisfies as versionSatisfies } from 'semver';",
            "import semver from '../../vendor/semver/index.js';\nconst { satisfies: versionSatisfies } = semver;");
        if (rewritten === verifierSource) throw new Error('Installer semver import rewrite did not match the reviewed source.');
        writeFileSync(verifier, rewritten); chmodSync(verifier, 0o644);
        const semverPackage = path.dirname(require.resolve('semver/package.json'));
        const vendoredSemver = path.join(staging, 'vendor', 'semver');
        cpSync(semverPackage, vendoredSemver, { recursive: true, dereference: false, errorOnExist: true });
        const vendorFiles = []; collectRegularFiles(vendoredSemver, staging, vendorFiles);
        files.push(...vendorFiles); files.sort();
        const packageBytes = Buffer.from('{"type":"module","private":true}\n');
        writeFileSync(path.join(staging, 'package.json'), packageBytes, { mode: 0o644 });
        const records = [...files.map((relative) => {
            const target = path.join(staging, relative); const bytes = readFileSync(target); const metadata = lstatSync(target);
            return { path: relative, mode: metadata.mode & 0o777, size: bytes.length, sha256: sha(bytes) };
        }), { path: 'package.json', mode: 0o644, size: packageBytes.length, sha256: sha(packageBytes) }]
            .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        const manifest = { schema: 'nassaj-installer-bundle/v1', version: options.version, commit: options.commit, files: records };
        writeFileSync(path.join(staging, 'INSTALLER_BUNDLE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
        const assetName = `nassaj-installer-v${options.version}.tar.gz`; const asset = path.join(output, assetName);
        const topLevels = [...new Set([...records.map((file) => file.path.split('/')[0]), 'INSTALLER_BUNDLE_MANIFEST.json'])].sort();
        const run = injected.run || spawnSync;
        const result = run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=ustar',
            '-czf', asset, '-C', staging, ...topLevels], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`Installer archive creation failed: ${(result.stderr || '').trim()}`);
        const bytes = readFileSync(asset); const assetSha256 = sha(bytes);
        const checksum = `${asset}.sha256`; writeFileSync(checksum, `${assetSha256}  ${assetName}\n`, { mode: 0o644 });
        return Object.freeze({ asset, assetName, assetSha256, size: bytes.length, checksum, manifest });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function argument(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }
function main() {
    const argv = process.argv.slice(2); const result = buildReleaseInstaller({ version: argument(argv, '--version'),
        commit: argument(argv, '--commit'), profile: argument(argv, '--profile') || undefined,
        runtime: argument(argv, '--runtime-identity') ? JSON.parse(readFileSync(argument(argv, '--runtime-identity'))) : undefined, outputDirectory: argument(argv, '--output'),
        temporaryRoot: process.env.RUNNER_TEMP || '/var/tmp' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (error) { console.error(`[release-installer-build] ${error.message}`); process.exitCode = 1; }
}
