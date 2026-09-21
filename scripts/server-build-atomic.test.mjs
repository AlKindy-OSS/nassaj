#!/usr/bin/env node
import assert from 'node:assert/strict';
import { installCodexImageOnlyTestFixture } from './lib/codex-image-only-test-fixture.mjs';
import fs from 'node:fs';
import { builtinModules, syncBuiltinESMExports } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import {
    existsSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
    assertPublishPreconditions,
    buildAndPublishServer,
    buildServerReleaseCandidate,
    computeServerBuildFingerprint,
    computeServerInputEpoch,
    createServerInputManifest,
    installServerUpdateRuntime,
    installOidControlRuntime,
    installReleaseBootstrapEntry,
    isIgnoredServerInput,
    materializeUpdateRuntimeImports,
    runWithFlock,
    serverAliasOutDir,
    SERVER_BUILD_INPUTS,
    verifyServerArtefact,
    verifyOidCapsuleModuleClosure,
} from './server-build-atomic.mjs';
import {
    collectUpdateRuntimeClosure,
    createUpdateRuntimeManifest,
    installUpdateRuntimeBundle,
} from './lib/update-runtime-bundle.mjs';
import { bundleOidControlCapsule } from './lib/oid-control-bundle.mjs';
import ts from 'typescript';
import {
    previewControlPaths,
    readPreviewLedger,
    recordPreviewLedgerEvent,
    reconcileServerPreviewLedger,
} from './local-preview-ledger.mjs';
import { createTerminalOidControlReconciler } from './oid-terminal-control-reconcile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_COMMIT = 'a'.repeat(40);
const jsonSha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('OID capsule closure accepts only static node built-ins', () => {
    assert.equal(verifyOidCapsuleModuleClosure(Buffer.from("import fs from 'node:fs';\n")), true);
    assert.equal(verifyOidCapsuleModuleClosure(Buffer.from("import { DatabaseSync } from 'node:sqlite';\n")), true);
    assert.equal(verifyOidCapsuleModuleClosure(Buffer.from(
        "import { getBuiltinModule } from 'node:process';\nconst { DatabaseSync } = getBuiltinModule('node:sqlite');\n",
    )), true);
    assert.throws(() => verifyOidCapsuleModuleClosure(Buffer.from("import value from './mutable.mjs';\n")), /closure/);
    assert.throws(() => verifyOidCapsuleModuleClosure(Buffer.from("await import('node:fs');\n")), /closure/);
    assert.throws(() => verifyOidCapsuleModuleClosure(Buffer.from("getBuiltinModule(name);\n")), /closure/);
    assert.throws(() => verifyOidCapsuleModuleClosure(Buffer.from("getBuiltinModule('node:fs');\n")), /closure/);
});

test('bundled OID capsule remains admissible to the v1.47.0.18 predecessor verifier', () => {
    const bytes = bundleOidControlCapsule(ROOT, () => true).bytes;
    const source = bytes.toString('utf8');
    const ast = ts.createSourceFile('OID_CONTROL_CAPSULE.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = ast.statements
        .filter((node) => ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier))
        .map((node) => node.moduleSpecifier.text);
    assert.ok(imports.includes('node:process'));
    assert.ok(!imports.includes('node:sqlite'));
    assert.ok(imports.every((specifier) => specifier.startsWith('node:')
        && builtinModules.includes(specifier.slice(5))));
    assert.equal(verifyOidCapsuleModuleClosure(bytes), true);
});

test('server build identity covers every authored OID control source', () => {
    const bundle = bundleOidControlCapsule(ROOT, () => true);
    assert.ok(bundle.sources?.length);
    for (const source of bundle.sources) {
        assert.ok(SERVER_BUILD_INPUTS.includes(source.path), `missing server build input: ${source.path}`);
    }
});

test('every scripts/ server build input ships in the update runtime bundle', () => {
    // installServerUpdateRuntime refuses to build unless every scripts/-prefixed
    // SERVER_BUILD_INPUT is carried by the update runtime bundle. Guard both ends
    // of that contract here so a capsule-closure addition (e.g. the PM2 codec
    // vendor files reached only through esbuild aliases) cannot be recorded in the
    // input manifest without also being shipped for an installed node to reverify.
    const covered = new Set(collectUpdateRuntimeClosure(ROOT));
    for (const entry of SERVER_BUILD_INPUTS) {
        if (!entry.startsWith('scripts/')) continue;
        assert.ok(covered.has(entry), `server build input not covered by update runtime bundle: ${entry}`);
    }
});

test('update runtime identity covers standalone manual rollback policy bytes', t => {
    const relative = 'scripts/lib/source-update-manual-rollback-db.mjs';
    const before = createUpdateRuntimeManifest(ROOT);
    assert.ok(before.entries.includes(relative));
    assert.ok(before.files.some(file => file.path === relative));

    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'manual-rollback-build-id-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const source of before.files) {
        const destination = path.join(root, source.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(ROOT, source.path), destination);
    }
    const copied = createUpdateRuntimeManifest(root);
    const policy = path.join(root, relative);
    const bytes = readFileSync(policy);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(policy, bytes);
    const drifted = createUpdateRuntimeManifest(root);
    assert.notEqual(drifted.buildId, copied.buildId);
    assert.notEqual(
        drifted.files.find(file => file.path === relative)?.sha256,
        copied.files.find(file => file.path === relative)?.sha256,
    );
});

function fixture() {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'server-atomic-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    mkdirSync(path.join(root, 'dist-server'));
    writeFileSync(path.join(root, 'dist-server', 'generation.txt'), 'old');
    mkdirSync(path.join(root, 'server'));
    mkdirSync(path.join(root, 'shared'));
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(root, 'server', 'tsconfig.json'), '{}');
    writeFileSync(path.join(root, 'server', 'source.js'), 'export const source = 1;\n');
    writeFileSync(path.join(root, 'scripts', 'build-provenance.mjs'), 'export {};\n');
    writeFileSync(path.join(root, 'scripts', 'local-preview-ledger.mjs'), 'export {};\n');
    writeFileSync(path.join(root, 'scripts', 'local-preview-server-activation.mjs'), 'export {};\n');
    writeFileSync(path.join(root, 'scripts', 'safe-restart.sh'), '#!/usr/bin/env bash\nexit 0\n');
    for (const relative of collectUpdateRuntimeClosure(ROOT)) {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(ROOT, relative), target);
    }
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(path.join(root, 'package-lock.json'), '{}');
    installCodexImageOnlyTestFixture(root);
    return root;
}

function paths(root) {
    return {
        root,
        liveDir: path.join(root, 'dist-server'),
        stagingDir: path.join(root, 'dist-server.bak-staging'),
        previousDir: path.join(root, 'dist-server.bak-previous'),
    };
}

function emitValidArtefact(directory, { manifest = true, controlScripts = true, runtimeBundle = true } = {}) {
    mkdirSync(path.join(directory, 'server'), { recursive: true });
    mkdirSync(path.join(directory, 'shared'), { recursive: true });
    writeFileSync(path.join(directory, 'server', 'index.js'), 'export const generation = "new";\n');
    writeFileSync(path.join(directory, 'server', 'bootstrap.js'), 'export const bootstrapGeneration = "new";\n');
    writeFileSync(path.join(directory, 'server', 'cli.js'), 'export const cli = true;\n');
    writeFileSync(path.join(directory, 'shared', 'value.js'), 'export const value = 1;\n');
    if (controlScripts) {
        mkdirSync(path.join(directory, 'scripts'));
        for (const scriptName of ['local-preview-ledger.mjs', 'local-preview-server-activation.mjs', 'safe-restart.sh', 'preview-oid-capsule-launcher.mjs']) {
            writeFileSync(
                path.join(directory, 'scripts', scriptName),
                readFileSync(path.join(path.dirname(directory), 'scripts', scriptName)),
            );
        }
    }
    writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), `${JSON.stringify({
        artifact: 'server',
        version: '1.2.3',
        commit: EXPECTED_COMMIT,
        builtAt: new Date().toISOString(),
        buildId: computeServerBuildFingerprint(path.dirname(directory)),
    })}\n`);
    if (manifest) {
        writeFileSync(
            path.join(directory, 'SERVER_INPUT_MANIFEST.json'),
            `${JSON.stringify(createServerInputManifest(path.dirname(directory)))}\n`,
        );
    }
    if (runtimeBundle) installReleaseBootstrapEntry(directory);
    if (runtimeBundle) installUpdateRuntimeBundle(path.dirname(directory), directory);
    if (runtimeBundle) installOidControlRuntime(path.dirname(directory), directory, {
        oid: EXPECTED_COMMIT,
        buildId: computeServerBuildFingerprint(path.dirname(directory)),
    });
}

function fakeRun(command, args, options = {}) {
    if (command.endsWith('/tsc')) emitValidArtefact(
        args[args.indexOf('--outDir') + 1],
        { manifest: false, controlScripts: false, runtimeBundle: false },
    );
    if (command.endsWith('/tsc-alias')) {
        assert.equal(args[args.indexOf('--outDir') + 1], path.join('..', 'dist-server.bak-staging'));
        assert.equal(options.cwd, path.join(path.dirname(options.cwd), 'server'));
    }
    if (command === process.execPath && args[0]?.endsWith('build-provenance.mjs')) {
        // The tsc fixture already emitted the same record the real provenance
        // command would place in the injected output directory.
        assert.equal(options.env.NASSAJ_PROVENANCE_OUT_DIR.endsWith('dist-server.bak-staging'), true);
        assert.match(options.env.NASSAJ_BUILD_ID, /^[0-9a-f]{64}$/);
    }
    return { status: 0 };
}

function exchangeForFixture(left, right) {
    const temporary = `${left}.exchange`;
    renameSyncForTest(left, temporary);
    renameSyncForTest(right, left);
    renameSyncForTest(temporary, right);
}

function renameSyncForTest(from, to) {
    renameSync(from, to);
}

test('preconditions fail closed for capacity, mv, live and staging hazards', () => {
    const root = fixture();
    try {
        const value = paths(root);
        assert.throws(() => assertPublishPreconditions(value, { resourcesSafe: false, exchangeSupported: true }), /80%/);
        assert.throws(() => assertPublishPreconditions(value, { resourcesSafe: true, exchangeSupported: false }), /--exchange/);
        rmSync(value.liveDir, { recursive: true });
        assert.doesNotThrow(() => assertPublishPreconditions(value, { resourcesSafe: true, exchangeSupported: false }));
        writeFileSync(value.liveDir, 'not a directory');
        assert.throws(() => assertPublishPreconditions(value, { resourcesSafe: true, exchangeSupported: true }), /real directory/);
        rmSync(value.liveDir);
        mkdirSync(value.liveDir);
        mkdirSync(value.stagingDir);
        assert.throws(() => assertPublishPreconditions(value, { resourcesSafe: true, exchangeSupported: true }), /already exists/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preconditions reject a symlink live path', () => {
    const root = fixture();
    try {
        const value = paths(root);
        rmSync(value.liveDir, { recursive: true });
        mkdirSync(path.join(root, 'actual-live'));
        symlinkSync(path.join(root, 'actual-live'), value.liveDir);
        assert.throws(() => assertPublishPreconditions(value, { resourcesSafe: true, exchangeSupported: true }), /real directory/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preconditions reject cross-filesystem and non-fixed generation paths', () => {
    const root = fixture();
    try {
        const value = paths(root);
        assert.throws(() => assertPublishPreconditions(value, {
            resourcesSafe: true,
            exchangeSupported: true,
            stat: (target) => ({ dev: target === value.liveDir ? 1 : 2 }),
        }), /same filesystem/);
        assert.throws(() => assertPublishPreconditions({ ...value, previousDir: path.join(root, 'unsafe') }, {
            resourcesSafe: true, exchangeSupported: true,
        }), /fixed atomic layout/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artefact verification rejects tests, symlinks, special files, aliases and bad provenance', () => {
    const root = fixture();
    const staged = path.join(root, 'candidate');
    try {
        mkdirSync(staged);
        emitValidArtefact(staged);
        const initialManifest = JSON.parse(readFileSync(path.join(staged, 'SERVER_INPUT_MANIFEST.json'), 'utf8'));
        assert.equal(initialManifest.inputs.some((entry) => entry.path === 'server/tsconfig.json'), true);
        for (const controlPath of [
            'scripts/local-preview-ledger.mjs',
            'scripts/local-preview-server-activation.mjs',
            'scripts/safe-restart.sh',
        ]) assert.equal(initialManifest.inputs.some((entry) => entry.path === controlPath), true, controlPath);
        writeFileSync(path.join(staged, 'server', 'leak.test.js'), 'export {};');
        assert.throws(() => verifyServerArtefact(staged, { root }), /contains tests/);
        rmSync(path.join(staged, 'server', 'leak.test.js'));
        symlinkSync(path.join(staged, 'server', 'index.js'), path.join(staged, 'server', 'link.js'));
        assert.throws(() => verifyServerArtefact(staged, { root }), /rejects symlink/);
        rmSync(path.join(staged, 'server', 'link.js'));
        execFileSync('mkfifo', [path.join(staged, 'server', 'pipe')]);
        assert.throws(() => verifyServerArtefact(staged, { root }), /rejects special file/);
        rmSync(path.join(staged, 'server', 'pipe'));
        writeFileSync(path.join(staged, 'server', 'application.js'), '// Documentation may mention the `@/*` alias.\nexport {};\n');
        assert.doesNotThrow(() => verifyServerArtefact(staged, { root }));
        const manifestPath = path.join(staged, 'SERVER_INPUT_MANIFEST.json');
        const validManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const tamperedManifest = structuredClone(validManifest);
        tamperedManifest.inputs[0].sha256 = 'f'.repeat(64);
        writeFileSync(manifestPath, JSON.stringify(tamperedManifest));
        assert.throws(() => verifyServerArtefact(staged, { root }), /reproduce its build id/);
        writeFileSync(manifestPath, JSON.stringify(validManifest));
        writeFileSync(path.join(staged, 'server', 'index.js'), "import x from '@/bad.js';\n");
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), "export { x } from '@/bad.js';\n");
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), 'const x = import(`@/bad.js`);\n');
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), 'const x = import(`@/${name}.js`);\n');
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), "const x = require('@/bad.js');\n");
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), 'const x = require(`@/${name}.js`);\n');
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), "const x = require.resolve('@/bad.js');\n");
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), 'const x = require.resolve(`@/${name}.js`);\n');
        assert.throws(() => verifyServerArtefact(staged, { root }), /Unresolved/);
        writeFileSync(path.join(staged, 'server', 'index.js'), 'const = ;\n');
        assert.throws(() => verifyServerArtefact(staged, { root }), /failed/);
        writeFileSync(path.join(staged, 'server', 'index.js'), 'export {};\n');
        assert.throws(() => verifyServerArtefact(staged, {
            root,
            expectedBuildId: 'b'.repeat(64),
        }), /BUILD_ID/);
        const provenance = JSON.parse(readFileSync(path.join(staged, 'BUILD_PROVENANCE.json')));
        provenance.version = 'wrong';
        writeFileSync(path.join(staged, 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
        assert.throws(() => verifyServerArtefact(staged, { root }), /version mismatch/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pair capability rejects a direct application entry even when all control seals match', () => {
    const root = fixture(), staged = path.join(root, 'candidate');
    try {
        mkdirSync(staged);
        emitValidArtefact(staged);
        assert.doesNotThrow(() => verifyServerArtefact(staged, { root }));
        copyFileSync(path.join(staged, 'server', 'application.js'), path.join(staged, 'server', 'index.js'));
        assert.throws(() => verifyServerArtefact(staged, { root }), /bootstrap at the PM2 index entry/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('server input manifests use the verifier code-point order', () => {
    const root = fixture();
    const staged = path.join(root, 'candidate');
    try {
        for (const relative of [
            'server/modules/providers/README.md',
            'server/modules/providers/provider.routes.ts',
            'server/modules/websocket/README.md',
            'server/modules/websocket/index.ts',
        ]) {
            const target = path.join(root, relative);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, `${relative}\n`);
        }
        mkdirSync(staged);
        emitValidArtefact(staged);
        const manifestPath = path.join(staged, 'SERVER_INPUT_MANIFEST.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        for (let index = 1; index < manifest.inputs.length; index += 1) {
            assert.equal(manifest.inputs[index - 1].path < manifest.inputs[index].path, true);
        }
        assert.ok(manifest.inputs.findIndex((entry) => entry.path === 'server/modules/providers/README.md')
            < manifest.inputs.findIndex((entry) => entry.path === 'server/modules/providers/provider.routes.ts'));
        assert.ok(manifest.inputs.findIndex((entry) => entry.path === 'server/modules/websocket/README.md')
            < manifest.inputs.findIndex((entry) => entry.path === 'server/modules/websocket/index.ts'));
        assert.doesNotThrow(() => verifyServerArtefact(staged, { root }));

        const inverted = structuredClone(manifest);
        const readme = inverted.inputs.findIndex((entry) => entry.path === 'server/modules/providers/README.md');
        [inverted.inputs[readme], inverted.inputs[readme + 1]] = [inverted.inputs[readme + 1], inverted.inputs[readme]];
        writeFileSync(manifestPath, JSON.stringify(inverted));
        assert.throws(() => verifyServerArtefact(staged, { root }), /entries are invalid or unsorted/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real tsc runtime imports are canonicalized without removing unrelated emitted scripts', () => {
    const output = mkdtempSync('/var/tmp/server-runtime-canonical-');
    try {
        // Explicitly include this runtime input: the server no longer imports it.
        const config = path.join(output, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ extends: path.join(ROOT, 'server/tsconfig.json'),
            compilerOptions: { typeRoots: [path.join(ROOT, 'node_modules/@types')] },
            include: [path.join(ROOT, 'server/**/*.js'), path.join(ROOT, 'server/**/*.ts'),
                path.join(ROOT, 'shared/**/*.js'), path.join(ROOT, 'shared/**/*.ts'),
                path.join(ROOT, 'scripts/client-build-atomic.mjs')] }));
        execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'), [
            '-p', config, '--outDir', output,
        ], { env: { ...process.env, TMPDIR: '/var/tmp' } });
        const relative = 'scripts/client-build-atomic.mjs';
        const source = path.join(ROOT, relative);
        const emitted = path.join(output, relative);
        assert.equal(readFileSync(emitted).equals(readFileSync(source)), false);
        const unrelated = path.join(output, 'scripts', 'session-commit-arbiter.mjs');
        const unrelatedBefore = readFileSync(unrelated);
        installServerUpdateRuntime(ROOT, output);
        assert.equal(readFileSync(emitted).equals(readFileSync(source)), true);
        assert.equal(readFileSync(unrelated).equals(unrelatedBefore), true);
        assert.equal(statSync(emitted).mode & 0o777, statSync(source).mode & 0o777);
    } finally { rmSync(output, { recursive: true, force: true }); }
});

test('runtime installation fails before materialization when a server script input is uncovered', () => {
    const root = fixture();
    const artefact = path.join(root, 'candidate');
    const sentinel = path.join(artefact, 'scripts', 'client-build-atomic.mjs');
    const missing = 'scripts/not-covered-by-runtime.mjs';
    try {
        mkdirSync(path.dirname(sentinel), { recursive: true });
        writeFileSync(sentinel, 'compiler sentinel\n');
        SERVER_BUILD_INPUTS.push(missing);
        assert.throws(() => installServerUpdateRuntime(root, artefact), /does not cover server script inputs/);
        assert.equal(readFileSync(sentinel, 'utf8'), 'compiler sentinel\n');
    } finally {
        assert.equal(SERVER_BUILD_INPUTS.pop(), missing);
        rmSync(root, { recursive: true, force: true });
    }
});

function runtimeImportFixture(relative = 'scripts/tool.mjs') {
    const root = mkdtempSync('/var/tmp/server-runtime-import-');
    const artifactRoot = path.join(root, 'artefact');
    const bundleRoot = path.join(root, 'bundle');
    mkdirSync(artifactRoot);
    const source = path.join(bundleRoot, relative);
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, 'export const exact = true;\n');
    return {
        root, artifactRoot, bundleRoot,
        installed: { bundleRoot, manifest: { files: [{ path: relative, mode: 0o640 }] } },
    };
}

test('runtime import canonicalization rejects symlink, special and escaping targets', () => {
    for (const kind of ['target-symlink', 'dangling-target', 'parent-symlink', 'special', 'escape']) {
        const fixture = runtimeImportFixture(kind === 'escape' ? '../escape.mjs' : 'scripts/tool.mjs');
        try {
            let danglingDestination = null;
            if (kind === 'target-symlink') {
                mkdirSync(path.join(fixture.artifactRoot, 'scripts'));
                writeFileSync(path.join(fixture.root, 'outside.mjs'), 'outside\n');
                symlinkSync(path.join(fixture.root, 'outside.mjs'), path.join(fixture.artifactRoot, 'scripts', 'tool.mjs'));
            } else if (kind === 'dangling-target') {
                mkdirSync(path.join(fixture.artifactRoot, 'scripts'));
                danglingDestination = path.join(fixture.root, 'missing-outside.mjs');
                symlinkSync(danglingDestination, path.join(fixture.artifactRoot, 'scripts', 'tool.mjs'));
            } else if (kind === 'parent-symlink') {
                mkdirSync(path.join(fixture.root, 'outside'));
                symlinkSync(path.join(fixture.root, 'outside'), path.join(fixture.artifactRoot, 'scripts'), 'dir');
            } else if (kind === 'special') {
                mkdirSync(path.join(fixture.artifactRoot, 'scripts'));
                execFileSync('mkfifo', [path.join(fixture.artifactRoot, 'scripts', 'tool.mjs')]);
            }
            assert.throws(() => materializeUpdateRuntimeImports(fixture.artifactRoot, fixture.installed),
                /runtime import (?:target|parent) is unsafe|runtime import escapes artefact/, kind);
            if (danglingDestination) assert.equal(existsSync(danglingDestination), false);
        } finally { rmSync(fixture.root, { recursive: true, force: true }); }
    }
});

test('test-only edits are excluded from server content and metadata identities', () => {
    const root = fixture();
    try {
        const contentBefore = computeServerBuildFingerprint(root);
        const epochBefore = computeServerInputEpoch(root);
        mkdirSync(path.join(root, 'server', '__tests__'));
        writeFileSync(path.join(root, 'server', '__tests__', 'ignored.test.ts'), 'changed');
        writeFileSync(path.join(root, 'shared', 'ignored.spec.js'), 'changed');
        assert.equal(computeServerBuildFingerprint(root), contentBefore);
        assert.equal(computeServerInputEpoch(root), epochBefore);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('server watcher classifier ignores tests but observes production inputs', () => {
    for (const file of ['server/a.test.ts', 'server/a.spec.js', 'server/__tests__/a.ts', 'shared/x.test.ts']) {
        assert.equal(isIgnoredServerInput(file), true, file);
    }
    for (const file of ['server/index.js', 'shared/networkHosts.js', 'package.json']) {
        assert.equal(isIgnoredServerInput(file), false, file);
    }
});

test('tsc-alias receives a config-relative staging path and rejects every other layout', () => {
    const root = fixture();
    try {
        assert.equal(
            serverAliasOutDir(root, path.join(root, 'dist-server.bak-staging')),
            path.join('..', 'dist-server.bak-staging'),
        );
        assert.throws(
            () => serverAliasOutDir(root, path.join(root, 'elsewhere')),
            /outside the fixed server build layout/,
        );
        assert.throws(
            () => serverAliasOutDir(root, path.join(root, '..', 'dist-server.bak-staging')),
            /outside the fixed server build layout/,
        );
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real tsc-alias rewrites @/ imports in the config-relative staging directory', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'server-alias-integration-'));
    const configDirectory = path.join(root, 'server');
    const staging = path.join(root, 'dist-server.bak-staging');
    try {
        mkdirSync(configDirectory);
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
        writeFileSync(path.join(configDirectory, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                baseUrl: '..',
                paths: { '@/*': ['server/*'] },
                rootDir: '..',
                outDir: '../unused-output',
            },
            include: ['./**/*.ts'],
        }));
        writeFileSync(path.join(configDirectory, 'dep.ts'), 'export const value = 1;\n');
        writeFileSync(path.join(configDirectory, 'index.ts'), "import { value } from '@/dep.js';\nexport { value };\n");

        execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'), [
            '-p', path.join(configDirectory, 'tsconfig.json'), '--outDir', staging,
        ], { cwd: ROOT, stdio: 'pipe' });
        const emittedIndex = path.join(staging, 'server', 'index.js');
        assert.match(readFileSync(emittedIndex, 'utf8'), /@\/dep\.js/);
        execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc-alias'), [
            '-p', path.join(configDirectory, 'tsconfig.json'), '--outDir', serverAliasOutDir(root, staging),
        ], { cwd: configDirectory, stdio: 'pipe' });
        const rewritten = readFileSync(emittedIndex, 'utf8');
        assert.doesNotMatch(rewritten, /@\//);
        assert.match(rewritten, /\.\/dep\.js/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local preview records base HEAD but content and epoch alone fence promotion', () => {
    const root = fixture();
    try {
        let headReads = 0;
        const result = buildAndPublishServer({ ...paths(root), localPreview: true, generation: 9 }, {
            run: fakeRun,
            exchange: exchangeForFixture,
            rename: renameSyncForTest,
            resourcesSafe: true,
            exchangeSupported: true,
            getHead: () => { headReads += 1; return EXPECTED_COMMIT; },
        });
        assert.equal(headReads, 1, 'local preview must not re-read HEAD as a promotion gate');
        assert.equal(result.baseCommit, EXPECTED_COMMIT);
        assert.match(result.sourceBuildId, /^[a-f0-9]{64}$/);
        const ledger = readPreviewLedger(root);
        assert.equal(ledger.serverState, 'built');
        assert.equal(ledger.serverCandidateBuildId, result.sourceBuildId);
        assert.equal(ledger.serverPromotedBuildId, null);
        assert.equal(ledger.serverLoadedBuildId, null, 'building never claims the process loaded new bytes');
        assert.equal(readFileSync(path.join(root, 'dist-server', 'generation.txt'), 'utf8'), 'old');
        assert.equal(existsSync(path.join(root, 'dist-server.bak-previous')), false);
        assert.equal(existsSync(result.candidatePath), true);
        assert.equal(previewControlPaths(root).buildLock.endsWith('nassaj-local-preview-build.lock'), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two preview builds retain both candidates and never mutate live or rollback trees', () => {
    const root = fixture();
    try {
        const first = buildAndPublishServer({ ...paths(root), localPreview: true, generation: 1 }, {
            run: fakeRun, resourcesSafe: true, exchangeSupported: false,
            getHead: () => EXPECTED_COMMIT,
        });
        writeFileSync(path.join(root, 'server', 'source.js'), 'export const source = 2;\n');
        const second = buildAndPublishServer({ ...paths(root), localPreview: true, generation: 2 }, {
            run: fakeRun, resourcesSafe: true, exchangeSupported: false,
            getHead: () => EXPECTED_COMMIT,
        });
        assert.notEqual(first.sourceBuildId, second.sourceBuildId);
        assert.equal(existsSync(first.candidatePath), true);
        assert.equal(existsSync(second.candidatePath), true);
        assert.equal(readFileSync(path.join(root, 'dist-server', 'generation.txt'), 'utf8'), 'old');
        assert.equal(existsSync(path.join(root, 'dist-server.bak-previous')), false);
        const ledger = readPreviewLedger(root);
        assert.equal(ledger.serverState, 'built');
        assert.equal(ledger.serverCandidateBuildId, second.sourceBuildId);
        assert.equal(ledger.serverPromotedBuildId, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watcher restart reconciles a stored candidate without promoting or discarding it', () => {
    const root = fixture();
    try {
        const result = buildAndPublishServer({ ...paths(root), localPreview: true, generation: 4 }, {
            run: fakeRun, resourcesSafe: true, exchangeSupported: false,
            getHead: () => EXPECTED_COMMIT,
        });
        reconcileServerPreviewLedger(root, 4, result.sourceBuildId, result.sourceBuildId, null);
        const ledger = readPreviewLedger(root);
        assert.equal(ledger.serverState, 'built');
        assert.equal(ledger.serverCandidateBuildId, result.sourceBuildId);
        assert.equal(ledger.serverPromotedBuildId, null);
        assert.equal(existsSync(result.candidatePath), true);
        assert.equal(readFileSync(path.join(root, 'dist-server', 'generation.txt'), 'utf8'), 'old');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watcher reconciliation keeps an old process attestation when a newer artefact is on disk', () => {
    const root = fixture();
    try {
        const staleBuildId = 'b'.repeat(64);
        const onDiskBuildId = 'c'.repeat(64);
        const sourceBuildId = onDiskBuildId;
        recordPreviewLedgerEvent(root, {
            target: 'server', sourceGeneration: 3, state: 'loaded',
            sourceBuildId: staleBuildId, candidateBuildId: staleBuildId,
            promotedBuildId: staleBuildId, runtimeBuildId: staleBuildId,
        });
        reconcileServerPreviewLedger(root, 4, sourceBuildId, null, onDiskBuildId);
        const ledger = readPreviewLedger(root);
        assert.equal(ledger.serverState, 'built');
        assert.equal(ledger.serverSourceBuildId, sourceBuildId);
        assert.equal(ledger.serverCandidateBuildId, onDiskBuildId,
            'a promoted on-disk artefact remains a candidate until the process attests loading it');
        assert.equal(ledger.serverPromotedBuildId, onDiskBuildId);
        assert.equal(ledger.serverLoadedBuildId, staleBuildId,
            'an on-disk promotion is not proof that the old process loaded it');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

function terminalRollbackFixture(root, mutate = () => {}, options = {}) {
    const sequence = options.sequence ?? 41;
    const oid = options.oid ?? 'd'.repeat(40);
    const buildId = options.buildId ?? 'e'.repeat(64);
    const previousBuildId = options.previousBuildId ?? 'f'.repeat(64);
    const nonce = '1'.repeat(64);
    let git;
    try { git = path.resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()); }
    catch { git = path.join(root, '.git'); }
    mkdirSync(git, { recursive: true });
    const request = {
        schemaVersion: 1, action: 'promote-and-safe-restart', sequence, oid, buildId, snapshotOid: oid,
        group: `event-${String(sequence).padStart(16, '0')}`, controlManifestSha256: '2'.repeat(64), ...(options.legacy ? {} : { transactionNonce: nonce }),
    };
    writeFileSync(path.join(git, 'nassaj-preview-oid-control-request-v1.json'), JSON.stringify(request));
    writeFileSync(path.join(git, `nassaj-preview-oid-event-control-${String(sequence).padStart(16, '0')}.json`), JSON.stringify({
        schema: 'nassaj-oid-control-event/v1', sequence, oid, buildId, snapshotOid: oid,
        controlManifestSha256: request.controlManifestSha256, ...(options.legacy ? {} : { transactionNonce: nonce }),
    }));
    writeFileSync(path.join(git, 'nassaj-preview-oid-consumer-v1.json'), JSON.stringify({
        schemaVersion: 1, acceptedSequence: sequence, acceptedOid: oid,
        server: { sequence, oid, phase: 'awaiting_owner', buildId, controlManifestSha256: request.controlManifestSha256, ...(options.legacy ? {} : { transactionNonce: nonce }) },
    }));
    writeFileSync(path.join(git, `nassaj-oid-control-transaction-${sequence}-${nonce}.json`), JSON.stringify({
        schema: 'nassaj-oid-control-transaction/v1', state: 'rolled_back', sequence, oid, buildId,
        previousBuildId, transactionNonce: nonce, livePath: path.join(root, 'dist-server'),
        candidatePath: path.join(root, '.nassaj-local-preview', 'server-candidates', buildId),
    }));
    mutate({ git, sequence, oid, buildId, previousBuildId, nonce, request });
    return { git, sequence, oid, buildId, previousBuildId, nonce, request };
}

test('watcher settles one exact terminal OID rollback and remains idempotent at boot', () => {
    const root = fixture();
    try {
        const value = terminalRollbackFixture(root);
        recordPreviewLedgerEvent(root, {
            target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded',
            sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId,
            promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId,
        });
        reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
        let ledger = readPreviewLedger(root);
        assert.equal(ledger.serverState, 'failed');
        assert.equal(ledger.serverCandidateBuildId, value.buildId, 'candidate remains durable evidence');
        assert.equal(ledger.serverError.code, 'oid_candidate_rolled_back');
        assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), false);
        assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-event-control-0000000000000041.json')), false);
        assert.equal(JSON.parse(readFileSync(path.join(value.git, 'nassaj-preview-oid-consumer-v1.json'))).server.phase, 'rolled_back');
        reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
        ledger = readPreviewLedger(root);
        assert.equal(ledger.serverState, 'failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watcher fails closed for mismatched or nonterminal OID rollback remnants', () => {
    for (const mutate of [
        ({ git, sequence, nonce }) => {
            const file = path.join(git, `nassaj-oid-control-transaction-${sequence}-${nonce}.json`);
            const value = JSON.parse(readFileSync(file)); value.previousBuildId = '0'.repeat(64); writeFileSync(file, JSON.stringify(value));
        },
        ({ git, sequence, nonce }) => {
            const file = path.join(git, `nassaj-oid-control-transaction-${sequence}-${nonce}.json`);
            const value = JSON.parse(readFileSync(file)); value.state = 'promoted'; writeFileSync(file, JSON.stringify(value));
        },
    ]) {
        const root = fixture();
        try {
            const value = terminalRollbackFixture(root, mutate);
            recordPreviewLedgerEvent(root, {
                target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded',
                sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId,
                promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId,
            });
            reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
            assert.equal(readPreviewLedger(root).serverState, 'built');
            assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), true,
                'unproven controls are never cleaned');
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test('watcher resumes a crash after terminal-control receipt creation', () => {
    const root = fixture();
    try {
        const value = terminalRollbackFixture(root);
        const receipt = path.join(value.git, `nassaj-oid-terminal-control-${value.sequence}-${value.nonce}.json`);
        const request = JSON.parse(readFileSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')));
        const event = JSON.parse(readFileSync(path.join(value.git, `nassaj-preview-oid-event-control-${String(value.sequence).padStart(16, '0')}.json`)));
        const consumer = JSON.parse(readFileSync(path.join(value.git, 'nassaj-preview-oid-consumer-v1.json')));
        writeFileSync(receipt, JSON.stringify({
            schema: 'nassaj-oid-terminal-control/v1', version: 1, state: 'receipt_created', sequence: value.sequence,
            oid: value.oid, buildId: value.buildId, previousBuildId: value.previousBuildId,
            transactionNonce: value.nonce, controlManifestSha256: value.request.controlManifestSha256,
            requestSha256: jsonSha256(request), eventSha256: jsonSha256(event), consumerSha256: jsonSha256(consumer),
            reason: 'terminal_reconciliation',
        }));
        recordPreviewLedgerEvent(root, {
            target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded',
            sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId,
            promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId,
        });
        reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
        assert.equal(readPreviewLedger(root).serverState, 'failed');
        assert.equal(JSON.parse(readFileSync(receipt)).state, 'controls_cleared');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terminal settlement rejects a mismatched accepted OID and preserves controls', () => {
    const root = fixture();
    try {
        const value = terminalRollbackFixture(root);
        const consumerFile = path.join(value.git, 'nassaj-preview-oid-consumer-v1.json');
        const consumer = JSON.parse(readFileSync(consumerFile)); consumer.acceptedOid = '0'.repeat(40); writeFileSync(consumerFile, JSON.stringify(consumer));
        recordPreviewLedgerEvent(root, { target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded', sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId, promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId });
        reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
        assert.equal(readPreviewLedger(root).serverState, 'built');
        assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terminal settlement rejects a colliding receipt without replaying controls', () => {
    const root = fixture();
    try {
        const value = terminalRollbackFixture(root);
        writeFileSync(path.join(value.git, `nassaj-oid-terminal-control-${value.sequence}-${value.nonce}.json`), JSON.stringify({ schema: 'nassaj-oid-terminal-control/v1', state: 'controls_cleared', sequence: value.sequence, oid: value.oid, buildId: '0'.repeat(64), previousBuildId: value.previousBuildId, transactionNonce: value.nonce }));
        recordPreviewLedgerEvent(root, { target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded', sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId, promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId });
        reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
        assert.equal(readPreviewLedger(root).serverState, 'built');
        assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy v1 seq29 controls settle only for the pinned rollback identity', () => {
    const root = fixture();
    try {
        const value = terminalRollbackFixture(root, () => {}, { legacy: true, sequence: 29,
            oid: '878b86c2aeb400b82252ca84f132f02a8bbc3fe9',
            buildId: 'cc017f06f0c45c82ed8ff28dd26136f87b8ecaffd54cf7921f32cafe4cba01b0',
            previousBuildId: 'c5da8098aa7bea2aa5f71ec78f569ba19c5d5d0e53296871f4a00147c47cabae' });
        recordPreviewLedgerEvent(root, { target: 'server', publisher: 'oid', sourceGeneration: 29, state: 'loaded', sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId, promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId });
        reconcileServerPreviewLedger(root, 29, value.buildId, value.buildId, value.previousBuildId);
        assert.equal(readPreviewLedger(root).serverState, 'failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terminal settlement rejects ambiguous transactions and receipt hash drift', () => {
    for (const mode of ['ambiguous', 'hash']) {
        const root = fixture();
        try {
            const value = terminalRollbackFixture(root);
            if (mode === 'ambiguous') {
                const source = path.join(value.git, `nassaj-oid-control-transaction-${value.sequence}-${value.nonce}.json`);
                writeFileSync(path.join(value.git, `nassaj-oid-control-transaction-${value.sequence}-${'3'.repeat(64)}.json`), readFileSync(source));
            } else {
                writeFileSync(path.join(value.git, `nassaj-oid-terminal-control-${value.sequence}-${value.nonce}.json`), JSON.stringify({
                    schema: 'nassaj-oid-terminal-control/v1', state: 'receipt_created', sequence: value.sequence, oid: value.oid,
                    buildId: value.buildId, previousBuildId: value.previousBuildId, transactionNonce: value.nonce,
                    controlManifestSha256: value.request.controlManifestSha256, requestSha256: '0'.repeat(64), eventSha256: '0'.repeat(64), consumerSha256: '0'.repeat(64),
                }));
            }
            recordPreviewLedgerEvent(root, { target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded', sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId, promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId });
            reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
            assert.equal(readPreviewLedger(root).serverState, 'built');
            assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), true);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test('terminal receipts require complete integrity fields through every resume state', () => {
    for (const state of ['receipt_created', 'consumer_terminal', 'controls_clear_started', 'controls_cleared']) {
        const root = fixture();
        try {
            const value = terminalRollbackFixture(root);
            const requestFile = path.join(value.git, 'nassaj-preview-oid-control-request-v1.json');
            const eventFile = path.join(value.git, `nassaj-preview-oid-event-control-${String(value.sequence).padStart(16, '0')}.json`);
            const consumerFile = path.join(value.git, 'nassaj-preview-oid-consumer-v1.json');
            const request = JSON.parse(readFileSync(requestFile));
            const event = JSON.parse(readFileSync(eventFile));
            const consumer = JSON.parse(readFileSync(consumerFile));
            if (state !== 'receipt_created') {
                consumer.server.phase = 'rolled_back';
                writeFileSync(consumerFile, JSON.stringify(consumer));
            }
            if (state === 'controls_cleared') { rmSync(requestFile, { force: true }); rmSync(eventFile, { force: true }); }
            const receipt = {
                schema: 'nassaj-oid-terminal-control/v1', version: 1, state, sequence: value.sequence,
                oid: value.oid, buildId: value.buildId, previousBuildId: value.previousBuildId,
                transactionNonce: value.nonce, controlManifestSha256: value.request.controlManifestSha256,
                requestSha256: state === 'receipt_created' ? undefined : jsonSha256(request),
                eventSha256: jsonSha256(event), consumerSha256: jsonSha256(JSON.parse(readFileSync(consumerFile))),
                reason: 'terminal_reconciliation',
                ...(state !== 'receipt_created' ? { consumerTerminalSha256: '0'.repeat(64) } : {}),
            };
            writeFileSync(path.join(value.git, `nassaj-oid-terminal-control-${value.sequence}-${value.nonce}.json`), JSON.stringify(receipt));
            recordPreviewLedgerEvent(root, { target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded', sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId, promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId });
            reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
            assert.equal(readPreviewLedger(root).serverState, 'built');
            if (state !== 'controls_cleared') assert.equal(existsSync(requestFile), true, `${state} must not clear controls`);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test('terminal settlement resumes durable control clearing after either unlink crash seam', () => {
    for (const removed of ['none', 'request', 'event', 'both']) {
        const root = fixture();
        try {
            const value = terminalRollbackFixture(root);
            const requestFile = path.join(value.git, 'nassaj-preview-oid-control-request-v1.json');
            const eventFile = path.join(value.git, `nassaj-preview-oid-event-control-${String(value.sequence).padStart(16, '0')}.json`);
            const consumerFile = path.join(value.git, 'nassaj-preview-oid-consumer-v1.json');
            const request = JSON.parse(readFileSync(requestFile));
            const event = JSON.parse(readFileSync(eventFile));
            const originalConsumer = JSON.parse(readFileSync(consumerFile));
            const terminalConsumer = { ...originalConsumer, server: { ...originalConsumer.server, phase: 'rolled_back' } };
            writeFileSync(consumerFile, JSON.stringify(terminalConsumer));
            if (removed === 'request' || removed === 'both') rmSync(requestFile, { force: true });
            if (removed === 'event' || removed === 'both') rmSync(eventFile, { force: true });
            writeFileSync(path.join(value.git, `nassaj-oid-terminal-control-${value.sequence}-${value.nonce}.json`), JSON.stringify({
                schema: 'nassaj-oid-terminal-control/v1', version: 1, state: 'controls_clear_started', sequence: value.sequence,
                oid: value.oid, buildId: value.buildId, previousBuildId: value.previousBuildId, transactionNonce: value.nonce,
                controlManifestSha256: value.request.controlManifestSha256, requestSha256: jsonSha256(request), eventSha256: jsonSha256(event),
                consumerSha256: jsonSha256(originalConsumer), consumerTerminalSha256: jsonSha256(terminalConsumer), reason: 'terminal_reconciliation',
            }));
            recordPreviewLedgerEvent(root, { target: 'server', publisher: 'oid', sourceGeneration: value.sequence, state: 'loaded', sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId, promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId });
            reconcileServerPreviewLedger(root, value.sequence, value.buildId, value.buildId, value.previousBuildId);
            assert.equal(readPreviewLedger(root).serverState, 'failed', `${removed} resumes to terminal failure`);
            assert.equal(existsSync(requestFile), false);
            assert.equal(existsSync(eventFile), false);
            assert.equal(JSON.parse(readFileSync(path.join(value.git, `nassaj-oid-terminal-control-${value.sequence}-${value.nonce}.json`))).state, 'controls_cleared');
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test('terminal reconciliation rejects a legacy control changed under the real common event lock', async () => {
    const parent = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'terminal-worktree-'));
    const source = path.join(parent, 'source');
    const worktree = path.join(parent, 'worktree');
    mkdirSync(source, { recursive: true });
    try {
        execFileSync('git', ['init', '--quiet'], { cwd: source });
        execFileSync('git', ['config', 'user.email', 'test@nassaj.local'], { cwd: source });
        execFileSync('git', ['config', 'user.name', 'Nassaj Test'], { cwd: source });
        writeFileSync(path.join(source, 'README.md'), 'fixture\n');
        execFileSync('git', ['add', 'README.md'], { cwd: source });
        execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: source });
        execFileSync('git', ['worktree', 'add', '--quiet', worktree], { cwd: source });
        const value = terminalRollbackFixture(worktree, () => {}, { legacy: true, sequence: 29,
            oid: '878b86c2aeb400b82252ca84f132f02a8bbc3fe9',
            buildId: 'cc017f06f0c45c82ed8ff28dd26136f87b8ecaffd54cf7921f32cafe4cba01b0',
            previousBuildId: 'c5da8098aa7bea2aa5f71ec78f569ba19c5d5d0e53296871f4a00147c47cabae' });
        recordPreviewLedgerEvent(worktree, { target: 'server', publisher: 'oid', sourceGeneration: 29, state: 'loaded',
            sourceBuildId: value.previousBuildId, candidateBuildId: value.previousBuildId,
            promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId });
        const lock = path.join(value.git, 'nassaj-preview-event-mutation.lock');
        const changed = path.join(value.git, 'legacy-control-changed');
        const reconcile = createTerminalOidControlReconciler({ testHooks: { afterInitialSnapshot: async () => {
            const child = spawn('flock', ['-x', lock, process.execPath, '-e',
                "const fs=require('node:fs');const [request,ready]=process.argv.slice(1);const v=JSON.parse(fs.readFileSync(request));v.mutatedUnderEventLock=true;fs.writeFileSync(request,JSON.stringify(v));fs.writeFileSync(ready,'ready');setTimeout(()=>process.exit(0),150);",
                path.join(value.git, 'nassaj-preview-oid-control-request-v1.json'), changed], { stdio: 'ignore' });
            await new Promise((resolve, reject) => {
                const timer = setInterval(() => { if (existsSync(changed)) { clearInterval(timer); resolve(); } }, 5);
                child.once('error', (error) => { clearInterval(timer); reject(error); });
                child.once('exit', (code) => { if (!existsSync(changed)) { clearInterval(timer); reject(new Error(`mutator exited ${code}`)); } });
            });
        } } });
        const result = await reconcile(worktree, { sequence: value.sequence, oid: value.oid, buildId: value.buildId,
            previousBuildId: value.previousBuildId, nonce: value.nonce,
            ledgerEvent: { target: 'server', publisher: 'oid', sourceGeneration: 29, state: 'failed', sourceBuildId: value.buildId,
                candidateBuildId: value.buildId, promotedBuildId: value.previousBuildId, runtimeBuildId: value.previousBuildId,
                error: { code: 'oid_candidate_rolled_back', message: 'must not write' } } });
        assert.deepEqual(result, { settled: false, code: 'legacy_control_changed' });
        assert.equal(existsSync(path.join(value.git, `nassaj-oid-terminal-control-${value.sequence}-${value.nonce}.json`)), false);
        assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-control-request-v1.json')), true);
        assert.equal(existsSync(path.join(value.git, 'nassaj-preview-oid-event-control-0000000000000029.json')), true);
        assert.equal(readPreviewLedger(worktree).serverState, 'loaded', 'failed reconciliation must not suppress the banner');
    } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('the non-blocking flock returns 75 while another process owns the lock', async () => {
    const root = fixture();
    const lock = path.join(root, 'build.lock');
    const ready = path.join(root, 'ready');
    const holder = spawn('bash', ['-c', `exec 9>${JSON.stringify(lock)}; flock 9; : >${JSON.stringify(ready)}; sleep 2`], {
        stdio: 'ignore',
    });
    try {
        for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(existsSync(ready), true, 'lock holder did not start');
        const result = runWithFlock(lock, process.execPath, ['-e', 'process.exit(0)'], { stdio: 'pipe' });
        assert.equal(result.status, 75);
    } finally {
        holder.kill('SIGTERM');
        await new Promise((resolve) => holder.once('exit', resolve));
        rmSync(root, { recursive: true, force: true });
    }
});

test('package build contract uses only the atomic server publisher', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['build:server'], 'node scripts/server-build-atomic.mjs');
    assert.equal(pkg.scripts['build:server:watch'], 'node scripts/server-build-watch.mjs');
    assert.equal(Object.hasOwn(pkg.scripts, 'prebuild:server'), false);
    assert.equal(Object.hasOwn(pkg.scripts, 'postbuild:server'), false);
    assert.match(pkg.scripts['test:scripts'], /scripts\/server-build-atomic\.test\.mjs/);

    const watcher = readFileSync(path.join(ROOT, 'scripts/server-build-watch.mjs'), 'utf8');
    assert.doesNotMatch(watcher, /safe-restart|pm2\s+(?:restart|reload|stop|delete)/i);
    assert.match(watcher, /--local-preview/);
    const unit = readFileSync(path.join(ROOT, 'scripts/systemd/nassaj-server-build-watch.service'), 'utf8');
    assert.match(unit, /^SystemCallErrorNumber=EPERM$/m);
    assert.match(unit, /^ReadOnlyPaths=-%h\/Project\/nassaj-dev\/server$/m);
    assert.match(unit, /^ReadOnlyPaths=-%h\/Project\/nassaj-dev\/scripts$/m);
    assert.match(unit, /^ReadOnlyPaths=-%h\/Project\/nassaj-dev\/dist-server$/m);
    assert.match(unit, /^ReadOnlyPaths=-%h\/Project\/nassaj-dev\/dist-server\.bak-previous$/m);

    const server = readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    for (const field of [
        'clientBuildIdServed', 'clientBuildIdAtServerStartup', 'serverBuildIdOnDisk',
        'serverLoadedBuildId', 'serverBuildIdLoadedAtStartup', 'serverSourceBuildId',
        'serverCandidateBuildId', 'serverPromotedBuildId', 'serverPreviewActivationV2',
    ]) assert.match(server, new RegExp(`${field}[,:]`), field);
    assert.doesNotMatch(server, /previewLedger\?\.serverState === 'built'/,
        'a retained candidate must not independently request a restart');
    assert.doesNotMatch(server, /serverCandidateBuildId !== SERVER_BUILD_ID_LOADED_AT_STARTUP/,
        'candidate lineage is audit evidence, not runtime skew');
    assert.match(server, /serverBuildIdOnDisk !== SERVER_BUILD_ID_LOADED_AT_STARTUP/,
        'an old process with a newly promoted dist-server still requires restart');
});

test('actual forward candidate pipeline generates before seals and verifies separated profile identity', () => {
    const root = fixture(); const originalWrite = fs.writeFileSync;
    try {
        writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
        const defaultModule = "export const ROOT_ADMISSION_REQUIRED = false;\nexport const PROFILE_ID = 'default';\n";
        const sourceProfile = path.join(root, 'server/bootstrap-release-profile.js');
        writeFileSync(sourceProfile, defaultModule);
        const fixturePath = 'server/scripts/fixtures/compatible-forward-schema-v1.json';
        mkdirSync(path.dirname(path.join(root, fixturePath)), { recursive: true });
        copyFileSync(path.join(ROOT, fixturePath), path.join(root, fixturePath));
        const roots = [
            'server/bootstrap.js', 'server/bootstrap-release-profile.js', 'server/bootstrap-startup-context.js',
            'server/modules/connectors/connector-substrate-only.production.js',
            'server/modules/database/connection.js', 'server/modules/database/existing-security-state.js',
            'server/modules/database/init-db.js', 'server/modules/execution-permissions/runtime-gateway.js',
            'server/services/server-background-lifecycle.service.js',
        ];
        const sourceBefore = computeServerBuildFingerprint(root); const sourceEpoch = computeServerInputEpoch(root);
        const candidate = path.join(root, 'candidate'); mkdirSync(candidate);
        const staging = path.join(root, 'dist-server.bak-staging'); const output = path.join(candidate, 'server');
        const observedSeals = [];
        fs.writeFileSync = function (file, ...args) {
            if (path.dirname(String(file)) === staging && ['UPDATE_RUNTIME_MANIFEST.json', 'BUILD_PROVENANCE.json',
                'SERVER_INPUT_MANIFEST.json', 'OID_CONTROL_MANIFEST.json'].includes(path.basename(String(file)))) {
                assert.match(readFileSync(path.join(staging, 'server/bootstrap-release-profile.js'), 'utf8'), /ROOT_ADMISSION_REQUIRED = true/);
                if (path.basename(String(file)) !== 'UPDATE_RUNTIME_MANIFEST.json') assert.equal(existsSync(path.join(staging, 'STARTUP_CLOSURE.json')), true);
                observedSeals.push(path.basename(String(file)));
            }
            return originalWrite.call(this, file, ...args);
        };
        syncBuiltinESMExports();
        const run = (command, argv) => {
            if (path.basename(command) === 'tsc') {
                const directory = argv[argv.indexOf('--outDir') + 1];
                mkdirSync(path.join(directory, 'shared'));
                for (const entry of [...roots, 'server/index.js', 'server/cli.js']) {
                    const file = path.join(directory, entry); mkdirSync(path.dirname(file), { recursive: true });
                    writeFileSync(file, entry === 'server/bootstrap-release-profile.js' ? defaultModule : 'export const fixture = true;\n');
                }
                assert.equal(existsSync(path.join(directory, 'BUILD_PROVENANCE.json')), false);
            }
            // Only compilation and node --check are substituted. Assembly, profile factory,
            // scanner, all seals, move and both actual verifiers execute unchanged.
            return { status: 0, stdout: '', stderr: '' };
        };
        const built = buildServerReleaseCandidate({ sourceRoot: root, candidateRoot: candidate, outputRoot: output,
            version: '1.47.0.3', releaseCommit: EXPECTED_COMMIT, profile: 'local-forward-349/v2' }, { run });
        fs.writeFileSync = originalWrite; syncBuiltinESMExports();
        for (const seal of ['UPDATE_RUNTIME_MANIFEST.json', 'BUILD_PROVENANCE.json', 'SERVER_INPUT_MANIFEST.json', 'OID_CONTROL_MANIFEST.json']) assert.ok(observedSeals.includes(seal), seal);
        assert.equal(computeServerBuildFingerprint(root), sourceBefore);
        assert.equal(computeServerInputEpoch(root), sourceEpoch);
        assert.equal(readFileSync(sourceProfile, 'utf8'), defaultModule);
        const defaultCandidate = path.join(root, 'default-candidate'); mkdirSync(defaultCandidate);
        const ordinary = buildServerReleaseCandidate({ sourceRoot: root, candidateRoot: defaultCandidate,
            outputRoot: path.join(defaultCandidate, 'server'), version: '1.47.0.3', releaseCommit: EXPECTED_COMMIT }, { run });
        assert.equal(ordinary.buildId, sourceBefore);
        assert.equal(existsSync(path.join(ordinary.outputRoot, 'STARTUP_CLOSURE.json')), false);
        assert.equal(readFileSync(path.join(ordinary.outputRoot, 'server/bootstrap-release-profile.js'), 'utf8'), defaultModule);
        assert.throws(() => verifyServerArtefact(ordinary.outputRoot, { root, run, version: '1.47.0.3',
            expectedBuildId: built.buildId }), /BUILD_ID does not match/);
        assert.notEqual(built.buildId, sourceBefore);
        const provenance = JSON.parse(readFileSync(path.join(output, 'BUILD_PROVENANCE.json')));
        const manifestFile = path.join(output, 'SERVER_INPUT_MANIFEST.json'); const manifestBytes = readFileSync(manifestFile);
        const manifest = JSON.parse(manifestBytes);
        assert.equal(manifest.buildIdMode, 'forward-profile-sha256');
        assert.equal(manifest.forwardBuildInput.baseSourceFingerprint, sourceBefore);
        assert.equal(manifest.buildId, built.buildId); assert.equal(provenance.buildId, built.buildId);
        const verify = () => verifyServerArtefact(output, { root, run, version: '1.47.0.3', expectedBuildId: built.buildId });
        assert.doesNotThrow(verify);
        const modulePath = path.join(output, 'server/bootstrap-release-profile.js'); const moduleBytes = readFileSync(modulePath);
        writeFileSync(modulePath, defaultModule); assert.throws(verify, /forward profile input mismatch/); writeFileSync(modulePath, moduleBytes);
        const mixed = structuredClone(manifest); mixed.forwardBuildInput.profileId = 'default';
        writeFileSync(manifestFile, JSON.stringify(mixed)); assert.throws(verify, /forward profile input mismatch/);
        writeFileSync(manifestFile, manifestBytes);
        writeFileSync(manifestFile, JSON.stringify({ ...manifest, buildIdMode: 'path-mode-content-sha256' }));
        assert.throws(verify, /reproduce its build id/); writeFileSync(manifestFile, manifestBytes);
        assert.doesNotThrow(verify);
        assert.equal(existsSync(staging), false);
    } finally {
        fs.writeFileSync = originalWrite; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
    }
});



test('source content changes during compilation cancel promotion and preserve live', () => {
    const root = fixture();
    try {
        const value = paths(root);
        let changed = false;
        const run = (...args) => {
            const result = fakeRun(...args);
            if (!changed && args[0].endsWith('/tsc')) {
                changed = true;
                writeFileSync(path.join(root, 'server', 'source.js'), 'export const source = 2;\n');
            }
            return result;
        };
        assert.throws(() => buildAndPublishServer({ ...value, localPreview: true, generation: 1 }, {
            run, resourcesSafe: true, exchangeSupported: true, getHead: () => EXPECTED_COMMIT,
        }), /source content changed/);
        assert.equal(readFileSync(path.join(value.liveDir, 'generation.txt'), 'utf8'), 'old');
        assert.equal(existsSync(value.stagingDir), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});


test('edit-then-revert metadata changes cancel promotion even when bytes match', () => {
    const root = fixture();
    try {
        const value = paths(root);
        const packageFile = path.join(root, 'package.json');
        let changed = false;
        const run = (...args) => {
            const result = fakeRun(...args);
            if (!changed && args[0].endsWith('/tsc')) {
                changed = true;
                const original = readFileSync(packageFile, 'utf8');
                const replacement = path.join(root, 'package.replacement.json');
                writeFileSync(replacement, original);
                renameSync(replacement, packageFile);
            }
            return result;
        };
        assert.throws(() => buildAndPublishServer({ ...value, localPreview: true, generation: 1 }, {
            run, resourcesSafe: true, exchangeSupported: true, getHead: () => EXPECTED_COMMIT,
        }), /source metadata changed/);
        assert.equal(readFileSync(path.join(value.liveDir, 'generation.txt'), 'utf8'), 'old');
        assert.equal(existsSync(value.stagingDir), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});


test('a compiler failure removes only the unpromoted staging generation', () => {
    const root = fixture();
    try {
        const value = paths(root);
        assert.throws(() => buildAndPublishServer({ ...value, localPreview: true, generation: 1 }, {
            run: (...args) => { if (args[0].endsWith('/tsc')) throw new Error('injected compiler failure'); return fakeRun(...args); },
            resourcesSafe: true,
            exchangeSupported: true,
            getHead: () => EXPECTED_COMMIT,
        }), /compiler failure/);
        assert.equal(existsSync(value.stagingDir), false);
        assert.equal(readFileSync(path.join(value.liveDir, 'generation.txt'), 'utf8'), 'old');
    } finally { rmSync(root, { recursive: true, force: true }); }
});


test('unpatched SDK blocks direct server build before compiler or live generation mutation', () => {
    const root = fixture();
    try {
        writeFileSync(path.join(root, 'node_modules/@openai/codex-sdk/dist/index.js'), 'unpatched ignored postinstall');
        let compiled = false;
        assert.throws(() => buildAndPublishServer({ ...paths(root), localPreview: true, generation: 1 }, {
            resourcesSafe: true, exchangeSupported: true,
            run: () => { compiled = true; },
        }), /CODEX_IMAGE_ONLY_PATCH_HASH/);
        assert.equal(compiled, false);
        assert.equal(readFileSync(path.join(root, 'dist-server/generation.txt'), 'utf8'), 'old');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
