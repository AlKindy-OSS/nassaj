#!/usr/bin/env node
import { installCodexImageOnlyTestFixture } from './lib/codex-image-only-test-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildReleaseAsset,
    installManagedClaudeRuntimeAsset,
    clientToolchainPackageRoots,
    parseReleaseAssetArguments,
    REQUIRED_RELEASE_RUNTIME_PACKAGES,
    resolveRuntimeDependencyClosure,
    serverRuntimePackageRoots,
    smokeExtractedReleaseRuntime,
} from './build-release-asset.mjs';
import { installUpdateRuntimeBundle, UPDATE_RUNTIME_BUNDLE_ENTRIES } from './lib/update-runtime-bundle.mjs';
import { currentReleaseRuntimeTarget } from './lib/update-release-asset.mjs';

const temporaryRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'release-closure-test-'));
test.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

test('release CLI defaults permission generation to one and parses an explicit positive generation', () => {
    assert.equal(parseReleaseAssetArguments([], {}).permissionProtocolGeneration, 1);
    assert.equal(parseReleaseAssetArguments(['--permission-protocol-generation', '2'], {})
        .permissionProtocolGeneration, 2);
    assert.equal(Number.isNaN(parseReleaseAssetArguments(['--permission-protocol-generation', 'invalid'], {})
        .permissionProtocolGeneration), true);
});

function packageFixture(nodeModules, name, manifest = {}) {
    const directory = path.join(nodeModules, ...name.split('/'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', ...manifest })}\n`);
    fs.writeFileSync(path.join(directory, 'index.js'), `export default ${JSON.stringify(name)};\n`);
    return directory;
}

function writeFixtureLock(root, names) {
    const packages = { '': { name: 'fixture', version: '1.0.0' } };
    for (const name of names) packages[`node_modules/${name}`] = {
        name, version: '1.0.0', integrity: `sha512-${Buffer.from(name).toString('base64')}`,
    };
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages }));
    return path.join(root, 'package-lock.json');
}

test('compiled imports produce canonical external package roots only', () => {
    const artifact = path.join(temporaryRoot, 'artifact');
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, 'index.js'), `
      import '@scope/runtime/feature';
      import local from './local.js';
      export { value } from 'plain-runtime/subpath';
      let value;
      const lazy = import('lazy-runtime');
      const builtin = require('node:fs');
    `);
    assert.deepEqual(serverRuntimePackageRoots(artifact), [
        '@scope/runtime', 'lazy-runtime', 'plain-runtime',
    ]);
});

test('runtime closure includes transitive, optional, peer and native packages but excludes client-only packages', () => {
    const root = path.join(temporaryRoot, 'closure');
    const nodeModules = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true });
    packageFixture(nodeModules, 'runtime-root', {
        dependencies: { transitive: '1.0.0' },
        optionalDependencies: { native: '1.0.0', 'missing-platform-optional': '1.0.0' },
        peerDependencies: { peer: '1.0.0', 'optional-peer': '1.0.0' },
        peerDependenciesMeta: { 'optional-peer': { optional: true } },
    });
    packageFixture(nodeModules, 'transitive');
    packageFixture(nodeModules, 'native');
    packageFixture(nodeModules, 'peer');
    packageFixture(nodeModules, 'client-only');

    const lock = writeFixtureLock(root, ['runtime-root', 'transitive', 'native', 'peer', 'client-only']);
    const closure = resolveRuntimeDependencyClosure(nodeModules, ['runtime-root'], lock);
    assert.deepEqual(closure.packages.map((entry) => entry.name), [
        'native', 'peer', 'runtime-root', 'transitive',
    ]);
    assert.match(closure.sha256, /^[a-f0-9]{64}$/);
    assert.equal(closure.packages.some((entry) => entry.name === 'client-only'), false);
});

test('runtime closure fails closed when a required dependency is absent', () => {
    const root = path.join(temporaryRoot, 'missing');
    const nodeModules = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true });
    packageFixture(nodeModules, 'runtime-root', { dependencies: { absent: '1.0.0' } });
    const lock = writeFixtureLock(root, ['runtime-root']);
    assert.throws(
        () => resolveRuntimeDependencyClosure(nodeModules, ['runtime-root'], lock),
        /not installed: absent/,
    );
});

test('runtime closure never satisfies a missing dependency from a parent node_modules', () => {
    const outer = path.join(temporaryRoot, 'parent-fallback');
    const root = path.join(outer, 'snapshot'); const nodeModules = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true });
    packageFixture(nodeModules, 'runtime-root', { dependencies: { 'parent-only': '1.0.0' } });
    packageFixture(path.join(outer, 'node_modules'), 'parent-only');
    const lock = writeFixtureLock(root, ['runtime-root']);
    assert.throws(() => resolveRuntimeDependencyClosure(nodeModules, ['runtime-root'], lock), /escapes node_modules/);
});

test('shell-quote runtime import is a direct production lock-bound dependency', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
    const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url)));
    const installed = lock.packages['node_modules/shell-quote'];
    assert.equal(manifest.dependencies['shell-quote'], '^1.9.0');
    assert.equal(lock.packages[''].dependencies['shell-quote'], manifest.dependencies['shell-quote']);
    assert.equal(installed.version, '1.10.0');
    assert.equal(installed.integrity,
        'sha512-w1aiOKwKuRgtwAReIIj89puqg+I7GvX4IbLrvmhXbzQsj1+Zwi4VO3+fa6ZF91TWSjIxoEkKnMeHcLEODK5ZXA==');
    assert.equal(installed.dev, undefined);
});

test('UPDATE_RUNTIME_BUNDLE client builder keeps its Vite root in the production lock closure', () => {
    const root = path.resolve(new URL('..', import.meta.url).pathname);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
    const clientBuilder = fs.readFileSync(path.join(root, 'scripts', 'client-build-atomic.mjs'), 'utf8');
    assert.equal(UPDATE_RUNTIME_BUNDLE_ENTRIES.includes('scripts/client-build-atomic.mjs'), true);
    assert.match(clientBuilder, /from ['"]vite['"]/);
    assert.equal(manifest.dependencies.vite, '^7.0.4');
    assert.equal(manifest.devDependencies.vite, undefined);
    assert.equal(lock.packages[''].dependencies.vite, manifest.dependencies.vite);
    assert.equal(lock.packages[''].devDependencies.vite, undefined);
    assert.equal(lock.packages['node_modules/vite'].version, '7.3.6');

    const closure = resolveRuntimeDependencyClosure(
        path.join(root, 'node_modules'), ['vite'], path.join(root, 'package-lock.json'),
    );
    assert.equal(closure.packages.some((entry) => entry.name === 'vite'), true);
    assert.equal(closure.packages.some((entry) => entry.name === 'esbuild'), true);
    assert.equal(closure.packages.some((entry) => entry.name === 'rollup'), true);
    for (const entry of closure.packages) assert.notEqual(lock.packages[entry.path].dev, true);
});

test('shipped client configs bind every literal toolchain root to the production closure', () => {
    const root = path.resolve(new URL('..', import.meta.url).pathname);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
    const roots = clientToolchainPackageRoots(root);
    assert.deepEqual(roots, [
        '@tailwindcss/typography', '@vitejs/plugin-react', 'autoprefixer', 'postcss',
        'tailwindcss', 'tailwindcss-rtl', 'vite',
    ]);
    for (const name of roots) {
        assert.equal(typeof manifest.dependencies[name], 'string', name);
        assert.equal(manifest.devDependencies[name], undefined, name);
        assert.equal(lock.packages[''].dependencies[name], manifest.dependencies[name], name);
    }
    const closure = resolveRuntimeDependencyClosure(
        path.join(root, 'node_modules'), roots, path.join(root, 'package-lock.json'),
    );
    for (const name of roots) assert.equal(closure.packages.some((entry) => entry.name === name), true, name);
    for (const entry of closure.packages) assert.notEqual(lock.packages[entry.path].dev, true, entry.path);
});

test('client toolchain config extraction fails closed on dynamic or undeclared roots', () => {
    const root = path.join(temporaryRoot, 'client-toolchain-config');
    fs.mkdirSync(root);
    const dependencies = Object.fromEntries([
        '@tailwindcss/typography', '@vitejs/plugin-react', 'autoprefixer', 'postcss',
        'tailwindcss', 'tailwindcss-rtl', 'vite',
    ].map((name) => [name, '1.0.0']));
    const write = (relative, source) => fs.writeFileSync(path.join(root, relative), source);
    write('package.json', JSON.stringify({ dependencies }));
    write('vite.config.js', "import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react'; export default defineConfig({ plugins: [react()] });");
    write('postcss.config.js', 'export default { plugins: { tailwindcss: {}, autoprefixer: {} } };');
    write('tailwind.config.js', "export default { plugins: [require('@tailwindcss/typography'), require('tailwindcss-rtl')] };");
    assert.deepEqual(clientToolchainPackageRoots(root), Object.keys(dependencies).sort());

    write('tailwind.config.js', "export default { plugins: [require(process.env.PLUGIN)] };");
    assert.throws(() => clientToolchainPackageRoots(root), /computed import/);
    write('tailwind.config.js', "export default { plugins: [require('@tailwindcss/typography'), require('tailwindcss-rtl')] };");
    write('postcss.config.js', 'const plugins = {}; export default { plugins: { ...plugins } };');
    assert.throws(() => clientToolchainPackageRoots(root), /literal package root/);
    write('postcss.config.js', 'export default { plugins: { tailwindcss: {}, autoprefixer: {} } };');
    delete dependencies.autoprefixer; write('package.json', JSON.stringify({ dependencies }));
    assert.throws(() => clientToolchainPackageRoots(root), /direct production dependency: autoprefixer/);
});

test('runtime closure rejects lock identity and integrity drift', () => {
    const root = path.join(temporaryRoot, 'lock-drift'); const nodeModules = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true }); packageFixture(nodeModules, 'runtime-root');
    const lock = writeFixtureLock(root, ['runtime-root']);
    const value = JSON.parse(fs.readFileSync(lock)); value.packages['node_modules/runtime-root'].version = '2.0.0';
    fs.writeFileSync(lock, JSON.stringify(value));
    assert.throws(() => resolveRuntimeDependencyClosure(nodeModules, ['runtime-root'], lock), /lock mismatch/);
});

test('runtime closure rejects OS, engine and unallowlisted native ABI drift', () => {
    for (const [name, manifest, message] of [
        ['wrong-os', { os: ['definitely-not-this-os'] }, /ABI mismatch/],
        ['wrong-engine', { engines: { node: '<1' } }, /engine mismatch/],
    ]) {
        const root = path.join(temporaryRoot, name); const nodeModules = path.join(root, 'node_modules');
        fs.mkdirSync(nodeModules, { recursive: true }); packageFixture(nodeModules, name, manifest);
        const lock = writeFixtureLock(root, [name]);
        assert.throws(() => resolveRuntimeDependencyClosure(nodeModules, [name], lock), message);
    }
    const root = path.join(temporaryRoot, 'unknown-native'); const nodeModules = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true }); const directory = packageFixture(nodeModules, 'unknown-native');
    fs.writeFileSync(path.join(directory, 'addon.node'), 'native'); const lock = writeFixtureLock(root, ['unknown-native']);
    assert.throws(() => resolveRuntimeDependencyClosure(nodeModules, ['unknown-native'], lock), /not allowlisted/);
});

test('native attestation checks aliases and resolved names and detects executable providers', () => {
    const cases = [
        ['allowed-alias', '@vscode/ripgrep', 'unknown-native'],
        ['unknown-alias', 'unknown-native-alias', '@vscode/ripgrep'],
        ['unknown-executable', 'unknown-executable', 'unknown-executable'],
    ];
    for (const [fixture, requestName, resolvedName] of cases) {
        const root = path.join(temporaryRoot, fixture); const nodeModules = path.join(root, 'node_modules');
        fs.mkdirSync(nodeModules, { recursive: true });
        const directory = packageFixture(nodeModules, requestName, { name: resolvedName });
        const binary = path.join(directory, fixture === 'allowed-alias' ? 'rg' : 'tool');
        fs.writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0])); fs.chmodSync(binary, 0o755);
        const lock = writeFixtureLock(root, [requestName]);
        const value = JSON.parse(fs.readFileSync(lock)); value.packages[`node_modules/${requestName}`].name = resolvedName;
        fs.writeFileSync(lock, JSON.stringify(value));
        assert.throws(() => resolveRuntimeDependencyClosure(nodeModules, [requestName], lock), /not allowlisted/);
    }
    const root = path.join(temporaryRoot, 'ripgrep-native'); const nodeModules = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true }); const directory = packageFixture(nodeModules, '@vscode/ripgrep');
    fs.mkdirSync(path.join(directory, 'bin')); fs.writeFileSync(path.join(directory, 'bin', 'rg'), '#!/bin/sh\n');
    fs.chmodSync(path.join(directory, 'bin', 'rg'), 0o755);
    const closure = resolveRuntimeDependencyClosure(nodeModules, ['@vscode/ripgrep'], writeFixtureLock(root, ['@vscode/ripgrep']));
    assert.equal(closure.packages[0].native, true);
});

test('AST scanner ignores comments and text while refusing an unapproved computed package import', () => {
    const artifact = path.join(temporaryRoot, 'ast-negative'); fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, 'text.js'), `// import 'failed'\nconst text = "require('written')"; import(name);\n`);
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
});

test('computed import exceptions are bound to the exact approved expression', () => {
    const artifact = path.join(temporaryRoot, 'ast-approved-expression');
    fs.mkdirSync(path.join(artifact, 'server'), { recursive: true });
    const bootstrap = path.join(artifact, 'server', 'bootstrap.js');
    const legacyEntry = path.join(artifact, 'server', 'index.js');
    fs.writeFileSync(bootstrap, 'export const load = () => import(applicationModule);\n');
    fs.writeFileSync(legacyEntry, 'export const loadLegacy = () => import(applicationModule);\n');
    assert.deepEqual(serverRuntimePackageRoots(artifact), []);
    fs.appendFileSync(legacyEntry, 'export const unsafe = () => import(attackerControlled);\n');
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
    fs.writeFileSync(legacyEntry, 'export const loadLegacy = () => import(applicationModule);\n');
    fs.writeFileSync(path.join(artifact, 'server', 'application.js'),
        'export const misplaced = () => import(applicationModule);\n');
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
});

test('OID closure exceptions stay bound to the reviewed capsule expression and file', () => {
    const artifact = path.join(temporaryRoot, 'oid-approved-expression');
    const directory = path.join(artifact, 'UPDATE_RUNTIME_BUNDLE', 'scripts');
    fs.mkdirSync(directory, { recursive: true });
    const launcher = path.join(directory, 'preview-oid-capsule-launcher.mjs');
    const source = "export const load = capsule => import(`data:text/javascript;base64,${capsule.toString('base64')}`);\n";
    fs.writeFileSync(launcher, source);
    assert.deepEqual(serverRuntimePackageRoots(artifact), []);
    fs.writeFileSync(launcher, source.replace('capsule.toString', 'untrusted.toString'));
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
    fs.writeFileSync(launcher, source);
    fs.writeFileSync(path.join(directory, 'unreviewed.mjs'), source);
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
});

test('OID build contract exception rejects a different module path and an indirect variable', () => {
    const artifact = path.join(temporaryRoot, 'oid-contract-expression');
    fs.mkdirSync(path.join(artifact, 'scripts'), { recursive: true });
    const file = path.join(artifact, 'scripts', 'server-preview-from-oid.mjs');
    const expression = "`${pathToFileURL(path.join(sourceRoot, 'scripts', 'server-build-atomic.mjs')).href}?oid=${oid}`";
    fs.writeFileSync(file, `export const load = () => import(${expression});`);
    assert.deepEqual(serverRuntimePackageRoots(artifact), []);
    fs.writeFileSync(file, `export const load = () => import(${expression.replace('server-build-atomic.mjs', 'other.mjs')});`);
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
    fs.writeFileSync(file, `const contractUrl = ${expression}; export const load = () => import(contractUrl);`);
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
});

test('installed publication executor exception stays bound to its verified bundle path', () => {
    const artifact = path.join(temporaryRoot, 'publication-executor-expression');
    const expression = "pathToFileURL(path.join(PUBLICATION_BOOT.bundleRoot, 'scripts/lib/client-publication-executor.mjs')).href";
    for (const prefix of ['scripts', 'UPDATE_RUNTIME_BUNDLE/scripts']) {
        const directory = path.join(artifact, prefix); fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, 'preview-oid-consumer.mjs');
        fs.writeFileSync(file, `export const load = () => import(${expression});`);
    }
    assert.deepEqual(serverRuntimePackageRoots(artifact), []);
    const installed = path.join(artifact, 'UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs');
    fs.writeFileSync(installed, `export const load = () => import(${expression.replace('client-publication-executor.mjs', 'other.mjs')});`);
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
    fs.writeFileSync(installed, `const executorUrl = ${expression}; export const load = () => import(executorUrl);`);
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
});

test('native and provider launchers are explicit fail-closed runtime roots', () => {
    for (const required of [
        '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@vscode/ripgrep',
        'argon2', 'bcrypt', 'better-sqlite3', 'node-pty',
    ]) assert.ok(REQUIRED_RELEASE_RUNTIME_PACKAGES.includes(required), required);
});

test('isolated runtime smoke fails closed before falling back to the build tree', () => {
    const root = path.join(temporaryRoot, 'smoke-missing'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    assert.throws(() => smokeExtractedReleaseRuntime(root), /isolated smoke failed/);
});

test('runtime smoke uses one isolated child with scrubbed resolution and real module and CLI probes', () => {
    const root = path.join(temporaryRoot, 'smoke-isolated'); fs.mkdirSync(root);
    let invocation;
    assert.equal(smokeExtractedReleaseRuntime(root, (...args) => {
        invocation = args; return { status: 0, stdout: 'ok', stderr: '' };
    }), true);
    const [executable, argv, options] = invocation;
    assert.equal(executable, process.execPath);
    assert.deepEqual(argv.slice(0, 2), ['--input-type=module', '--eval']);
    assert.match(argv[2], /SELECT 1 AS ok/);
    for (const probe of ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', "require('argon2')",
        "require('bcrypt')", "require('node-pty')", "'--version'", "'rg'", '@vitejs/plugin-react',
        'tailwindcss', 'autoprefixer', '@tailwindcss/typography', 'tailwindcss-rtl',
        "node_modules', 'vite', 'bin', 'vite.js", "css.includes('.flex')", "css.includes('-ms-flexbox')",
    ]) assert.ok(argv[2].includes(probe), probe);
    assert.equal(options.env.NODE_PATH, ''); assert.equal(options.env.PATH, '/usr/bin:/bin');
    assert.notEqual(options.env.HOME, process.env.HOME);
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'NODE_PATH', 'NO_COLOR', 'PATH']);
});

test('real bootstrap bytes pass the scanner at both release entry paths', () => {
    const artifact = path.join(temporaryRoot, 'real-bootstrap');
    fs.mkdirSync(path.join(artifact, 'server'), { recursive: true });
    const bootstrap = fs.readFileSync(new URL('../server/bootstrap.js', import.meta.url), 'utf8');
    fs.writeFileSync(path.join(artifact, 'server', 'bootstrap.js'), bootstrap);
    fs.writeFileSync(path.join(artifact, 'server', 'index.js'), bootstrap);
    assert.deepEqual(serverRuntimePackageRoots(artifact), []);
    fs.appendFileSync(path.join(artifact, 'server', 'index.js'), '\nconst untrusted = () => import(pathToFileURL(applicationPath).href);');
    assert.throws(() => serverRuntimePackageRoots(artifact), /unapproved computed import/);
});


function archivePeakFixture(overrides = {}) {
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'peak-')); const source = path.join(root, 'source');
    const output = path.join(root, 'output'); fs.mkdirSync(source); fs.mkdirSync(output);
    fs.mkdirSync(path.join(source, 'dist')); fs.mkdirSync(path.join(source, 'dist-server')); fs.mkdirSync(path.join(source, 'node_modules'));
    fs.mkdirSync(path.join(source, 'dist-server', 'server'));
    fs.mkdirSync(path.join(source, 'dist-server', 'server', 'scripts'));
    fs.mkdirSync(path.join(source, 'server/bin'), { recursive: true });
    fs.copyFileSync(path.resolve(import.meta.dirname, '../server/bin/claude'), path.join(source, 'server/bin/claude'));
    fs.mkdirSync(path.join(source, 'dist-server/server/services/isolation'), { recursive: true });
    fs.writeFileSync(path.join(source, 'dist-server/server/services/isolation/managed-claude-launcher.js'), 'process.exitCode=0;\n');
    fs.writeFileSync(path.join(source, 'dist-server', 'server', 'bootstrap.js'), 'process.exitCode = 0;\n');
    fs.writeFileSync(path.join(source, 'dist-server', 'server', 'scripts', 'release-database-migration.js'),
        'process.exitCode = 0;\n');
    fs.chmodSync(path.join(source, 'dist-server', 'server', 'scripts', 'release-database-migration.js'), 0o664);
    fs.writeFileSync(path.join(source, 'dist', 'index.html'), '<!doctype html>\n');
    installCodexImageOnlyTestFixture(source);
    fs.mkdirSync(path.join(source, 'node_modules', 'runtime-fixture'));
    fs.writeFileSync(path.join(source, 'node_modules', 'runtime-fixture', 'package.json'),
        JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(source, 'node_modules', 'runtime-fixture', 'index.js'), 'module.exports = {};\n');
    installUpdateRuntimeBundle(path.resolve('.'), path.join(source, 'dist-server'));
    const provenance = { version: '1.46.0.0', commit: 'b'.repeat(40), buildId: 'd'.repeat(64) };
    fs.writeFileSync(path.join(source, 'dist', 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
    fs.writeFileSync(path.join(source, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
    fs.writeFileSync(path.join(source, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': {}, 'node_modules/@openai/codex-sdk': { version: '0.153.2', integrity: 'sha512-YQ==' }, 'node_modules/runtime-fixture': { version: '1.0.0', integrity: 'sha512-YQ==' },
    } }));
    const runtimeTarget = currentReleaseRuntimeTarget();
    const options = { sourceRoot: source, outputDirectory: output, temporaryRoot: root,
        version: provenance.version, commit: provenance.commit, repo: 'AlKindy-OSS/nassaj', releaseId: 41,
        permissionProtocolGeneration: 2 };
    const injected = {
        runtimeHost: { platform: 'linux', arch: 'x64', libc: '2.41', nodeMajor: 24, nodeModules: 137 }, runtimeRoots: () => ['runtime-fixture', '@openai/codex-sdk'], clientToolchainRoots: [], runtimeSmoke: () => true,
        buildTarget: runtimeTarget, runtimeTarget, predecessorMatrix: { targetSchemaDigest: 'e'.repeat(64),
            acceptedPredecessors: [{ scenario: 'clean', schemaDigest: 'f'.repeat(64),
                compatibilityShapeDigest: 'a'.repeat(64), targetCompatibilityShapeDigest: 'b'.repeat(64),
                migrationStateDigest: 'c'.repeat(64), targetMigrationStateDigest: 'd'.repeat(64),
                targetMigrationState: 'clean', preservation: { before: {}, after: {} } }] },
    };
    return { source, output, root, build: () => buildReleaseAsset(options, { ...injected, ...overrides }) };
}

test('staging is gone before roundtrip extraction, without weakening archive or smoke failures', () => {
    for (const failure of [null, 'archive', 'smoke']) {
        let observed = false;
        const mkdir = fs.mkdirSync;
        const fixture = archivePeakFixture({
            run: (command, args, options) => {
                const result = spawnSync(command, args, options);
                if (failure === 'archive') fs.writeFileSync(args[args.indexOf('-czf') + 1], 'not a gzip archive');
                return result;
            },
            runtimeSmoke: (directory) => {
                assert.equal(fs.existsSync(path.join(directory, 'RELEASE_ASSET_MANIFEST.json')), true);
                const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'RELEASE_ASSET_MANIFEST.json'), 'utf8'));
                assert.equal(manifest.files.find(file => file.path === 'server/bin/claude')?.mode, 0o755);
                assert.equal(manifest.files.find(file => file.path === 'server/bin/claude')?.sha256, createHash('sha256').update(fs.readFileSync(path.join(directory, 'server/bin/claude'))).digest('hex'));
                assert.deepEqual(fs.readFileSync(path.join(directory, 'server/bin/claude')), fs.readFileSync(path.resolve(import.meta.dirname, '../server/bin/claude')));
                if (failure === 'smoke') throw new Error('fixture_smoke_rejected');
            },
        });
        try {
            fs.mkdirSync = (directory, ...args) => {
                if (path.basename(String(directory)) === 'consumer-roundtrip') {
                    observed = true;
                    assert.equal(fs.existsSync(path.join(path.dirname(directory), 'runtime')), false);
                    assert.equal(fs.existsSync(path.join(fixture.source, 'dist')), true);
                }
                return mkdir(directory, ...args);
            };
            syncBuiltinESMExports();
            if (failure) assert.throws(fixture.build, failure === 'smoke' ? /fixture_smoke_rejected/ : /gzip|header|archive|tar|magic/i);
            else assert.ok(fs.existsSync(fixture.build().asset));
            assert.equal(observed, true);
            assert.equal(fs.readdirSync(fixture.root).some(name => name.startsWith('nassaj-release-asset-')), false);
            assert.equal(fs.existsSync(path.join(fixture.source, 'node_modules', 'runtime-fixture', 'index.js')), true);
        } finally {
            fs.mkdirSync = mkdir;
            syncBuiltinESMExports();
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    }
});

test('missing release identity fails before creating output or scratch', () => {
    const output = path.join(temporaryRoot, 'invalid-identity-output');
    assert.throws(() => buildReleaseAsset({version:'1.0.0.0',commit:'a'.repeat(40),repo:'AlKindy-OSS/nassaj',outputDirectory:output}), /identity is invalid/);
    assert.equal(fs.existsSync(output),false);
});


test('managed Claude shim is byte-exact, executable, and resolves the packaged compiled launcher', () => {
    const fixture = archivePeakFixture();
    const staged = path.join(fixture.root, 'shim-stage');
    fs.mkdirSync(path.join(staged, 'dist-server/server/services/isolation'), { recursive: true });
    const compiled = path.join(staged, 'dist-server/server/services/isolation/managed-claude-launcher.js');
    fs.writeFileSync(compiled, 'console.log(JSON.stringify(process.argv.slice(2)));');
    installManagedClaudeRuntimeAsset(fixture.source, staged);
    const shim = path.join(staged, 'server/bin/claude');
    assert.deepEqual(fs.readFileSync(shim), fs.readFileSync(path.join(fixture.source, 'server/bin/claude')));
    assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
    const run = spawnSync(shim, ['two words', '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'production' } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ['two words', '--help']);
    fs.rmSync(shim);
    fs.rmSync(compiled);
    assert.throws(() => installManagedClaudeRuntimeAsset(fixture.source, staged), /missing or unsafe/);
    fs.writeFileSync(compiled, '');
    fs.rmSync(path.join(fixture.source, 'server/bin/claude'));
    assert.throws(() => installManagedClaudeRuntimeAsset(fixture.source, staged), /missing or unsafe/);
    fs.symlinkSync(compiled, path.join(fixture.source, 'server/bin/claude'));
    assert.throws(() => installManagedClaudeRuntimeAsset(fixture.source, staged), /missing or unsafe/);
});


test('release checks selected SDK before copy and rejects copied runtime drift', () => {
    const unpatched = archivePeakFixture();
    try {
        fs.writeFileSync(path.join(unpatched.source, 'node_modules/@openai/codex-sdk/dist/index.js'), 'ignored postinstall');
        assert.throws(unpatched.build, /CODEX_IMAGE_ONLY_PATCH_HASH/);
        assert.deepEqual(fs.readdirSync(unpatched.output), []);
    } finally { fs.rmSync(unpatched.root, { recursive: true, force: true }); }
    let changed = false;
    const copied = archivePeakFixture({ copy: (source, destination, options) => {
        fs.cpSync(source, destination, options);
        if (String(destination).endsWith('/node_modules/@openai/codex-sdk')) {
            fs.writeFileSync(path.join(destination, 'dist/index.js'), 'copy drift');
            changed = true;
        }
    } });
    try {
        assert.throws(copied.build, /CODEX_IMAGE_ONLY_PATCH_HASH/);
        assert.equal(changed, true);
        assert.deepEqual(fs.readdirSync(copied.output), []);
    } finally { fs.rmSync(copied.root, { recursive: true, force: true }); }
});
