import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { hashTree } from './lib/source-update-tree-identity.mjs';
import { hashTree as candidateHashTree } from './source-update-candidate.mjs';
import { computeServerBuildFingerprint, installReleaseBootstrapEntry, installServerUpdateRuntime,
    SERVER_BUILD_INPUTS } from './server-build-atomic.mjs';
import { collectForwardStartupMaterial, materializeForwardProfile, STARTUP_ROOTS } from './lib/compatible-forward-release-profile.mjs';
import { collectMigrationClosure } from './lib/release-database-migration-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEAF = 'scripts/lib/source-update-tree-identity.mjs';
function temporary(t) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'source-tree-identity-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}
function write(root, name, bytes, mode = 0o644) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes); chmodSync(file, mode);
    return file;
}
function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
}

test('tree identity retains the independent golden records and candidate API', t => {
    const root = temporary(t);
    write(root, 'alpha', 'ABC', 0o640);
    write(root, 'dir/B', 'xyz2', 0o755);
    mkdirSync(path.join(root, 'empty-directory'));
    symlinkSync('dir/B', path.join(root, 'z-link'));
    // Golden is SHA256 of the explicit ordered, NUL-terminated triples:
    // alpha/file:416:3/SHA256(ABC), dir/B/file:493:4/SHA256(xyz2), z-link/link:511:5/dir/B.
    const expected = { files: 3, sha256: '9edfb8f4e407b42bb13cba7e13c2903a7d95627c9951086dabc05e5114594c7a' };
    assert.deepEqual(hashTree(root), expected);
    assert.deepEqual(candidateHashTree(root), expected);
    chmodSync(path.join(root, 'alpha'), 0o600);
    assert.notDeepEqual(hashTree(root), expected);
    chmodSync(path.join(root, 'alpha'), 0o640);
    rmSync(path.join(root, 'z-link')); symlinkSync('./dir/B', path.join(root, 'z-link'));
    assert.notDeepEqual(hashTree(root), expected);
});

test('tree identity preserves empty, lexical link escape, and special-file behavior', t => {
    const root = temporary(t);
    assert.deepEqual(hashTree(root), { files: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    symlinkSync('../outside', path.join(root, 'link'));
    assert.throws(() => hashTree(root), { message: 'Candidate symlink escapes its tree: link' });
    rmSync(path.join(root, 'link'));
    symlinkSync('missing-inside', path.join(root, 'link'));
    assert.equal(hashTree(root).files, 1); // Existing contract is lexical, including dangling internal links.
    rmSync(path.join(root, 'link'));
    const fifo = spawnSync('mkfifo', [path.join(root, 'fifo')], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    assert.throws(() => hashTree(root), { message: 'Candidate tree contains a special file: fifo' });
});

test('tree identity keeps root realpath behavior and underlying filesystem errors', t => {
    const root = temporary(t), tree = path.join(root, 'tree'), alias = path.join(root, 'alias');
    mkdirSync(tree); symlinkSync('tree', alias);
    assert.deepEqual(hashTree(alias), hashTree(tree));
    assert.throws(() => hashTree(path.join(root, 'absent')), { code: 'ENOENT' });
    const file = write(root, 'regular', 'bytes');
    assert.throws(() => hashTree(file), { message: 'Candidate tree must be a real directory.' });
});

test('tree identity preserves localeCompare ordering rather than code-point ordering', t => {
    const root = temporary(t);
    write(root, 'Z', 'Z'); write(root, 'a', 'a');
    assert.deepEqual(hashTree(root), { files: 2,
        sha256: '2fce7b846f3ebf6c80e09fb1331b7f9351b64574f85a525aa5066c9ee8ebee38' });
});

test('the shared leaf is an explicit server fingerprint input', t => {
    const root = temporary(t);
    assert.ok(SERVER_BUILD_INPUTS.includes(LEAF));
    write(root, LEAF, readFileSync(path.join(ROOT, LEAF)));
    const before = computeServerBuildFingerprint(root);
    write(root, LEAF, `${readFileSync(path.join(ROOT, LEAF), 'utf8')}\n// identity mutation\n`);
    assert.notEqual(computeServerBuildFingerprint(root), before);
});

test('actual compiled startup closes over the leaf without importing candidate builders', { timeout: 180_000 }, t => {
    const root = temporary(t), runtime = path.join(root, 'dist-server');
    run([path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(ROOT, 'server/tsconfig.json'), '--outDir', runtime]);
    run([path.join(ROOT, 'node_modules/tsc-alias/dist/bin/index.js'), '-p', path.join(ROOT, 'server/tsconfig.json'), '--outDir', runtime]);
    installReleaseBootstrapEntry(runtime);
    materializeForwardProfile(runtime);
    const installed = installServerUpdateRuntime(ROOT, runtime);
    const record = installed.manifest.files.find(file => file.path === LEAF);
    assert.ok(record);
    const source = readFileSync(path.join(ROOT, LEAF));
    assert.deepEqual(readFileSync(path.join(installed.bundleRoot, LEAF)), source);
    assert.deepEqual(readFileSync(path.join(runtime, LEAF)), source);
    const lockFile = write(root, 'package-lock.json', readFileSync(path.join(ROOT, 'package-lock.json')));
    let lastPackage = null;
    const read = fs.readFileSync;
    const observe = t.mock.method(fs, 'readFileSync', (file, ...args) => {
        const bytes = read(file, ...args);
        if (typeof file === 'string' && file.endsWith('/package.json')) lastPackage = file;
        return bytes;
    });
    syncBuiltinESMExports();
    let material;
    try {
        ({ material } = collectForwardStartupMaterial(runtime, {
            nodeModulesRoot: path.join(ROOT, 'node_modules'), packageLockFile: lockFile,
        }));
    } catch (error) {
        error.message += ` (last package manifest: ${lastPackage})`;
        throw error;
    } finally { observe.mock.restore(); syncBuiltinESMExports(); }
    for (const packageName of ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) {
        const nativeFiles = material.files.filter(file => file.path.startsWith(`node_modules/${packageName}/`)
            && /\.(?:node|so(?:\.[0-9]+)*)$/.test(file.path));
        assert.ok(nativeFiles.length > 0, `${packageName} native bytes must be in the startup closure`);
        for (const file of nativeFiles) {
            const bytes = readFileSync(path.join(ROOT, file.path));
            assert.equal(file.size, bytes.length);
            assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
        }
    }
    assert.ok(material.files.some(file => file.path === `dist-server/${LEAF}`));
    assert.ok(material.files.some(file => file.path === 'dist-server/scripts/lib/client-publication-artifacts.mjs'));
    for (const file of material.files) assert.doesNotMatch(file.path,
        /scripts\/(?:source-update-candidate|client-build-atomic|client-isolated-publish|server-build-atomic|preview-oid-consumer)\.mjs$/);
});

test('the migration scanner still rejects computed import and require loaders', t => {
    const root = temporary(t), runtime = path.join(root, 'dist-server');
    write(root, 'package-lock.json', '{}');
    for (const body of ["export const load = target => import(target);", "import {createRequire} from 'node:module'; const read = createRequire(import.meta.url); export const load = target => read(target);"]) {
        write(runtime, 'entry.mjs', body);
        assert.throws(() => collectMigrationClosure(runtime, 'entry.mjs'), /migration_closure_computed_import:entry\.mjs/);
    }
});

// Check the local source graph independently of native package admission.
test('every startup root excludes publication executors while retaining read-only asset validation', { timeout: 180_000 }, t => {
    const root = temporary(t), runtime = path.join(root, 'dist-server');
    run([path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(ROOT, 'server/tsconfig.json'), '--outDir', runtime]);
    run([path.join(ROOT, 'node_modules/tsc-alias/dist/bin/index.js'), '-p', path.join(ROOT, 'server/tsconfig.json'), '--outDir', runtime]);
    installReleaseBootstrapEntry(runtime);
    materializeForwardProfile(runtime);
    installServerUpdateRuntime(ROOT, runtime);
    const entries = STARTUP_ROOTS.map(file => path.join(runtime, file));
    const result = buildSync({ absWorkingDir: ROOT, entryPoints: entries, outdir: 'unused-output',
        bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, metafile: true,
        tsconfig: path.join(ROOT, 'server/tsconfig.json'), logLevel: 'silent' });
    const files = Object.keys(result.metafile.inputs);
    assert.ok(files.some(file => file.endsWith('/scripts/lib/client-publication-artifacts.mjs')));
    for (const file of files) assert.doesNotMatch(file,
        /scripts\/(?:client-build-atomic|client-isolated-publish|server-build-atomic|preview-oid-consumer)\.mjs$/);
});
