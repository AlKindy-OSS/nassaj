import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
    chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
    realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import viteConfig, { resolveAtomicClientOutDir, resolveClientCacheDir } from '../vite.config.js';

import {
    assertExchangeSupport,
    assertLivePublishBaseCurrent,
    assertReviewedClientInput,
    assertGenerationCurrent,
    acquireBuildLock,
    buildClientReleaseCandidate,
    checkAtomicPublisherCapability,
    gateAtomicPublisherStartup,
    computeClientBuildId,
    computeClientInputEpoch,
    isIgnoredClientInput,
    mergeLegacyAssets,
    inspectRestorationWitness,
    promoteWithExchange,
    promoteWithSmokeRollback,
    runWithFlock,
    reconcileRuntimeState,
    retainPrevious,
    isLiveClientCurrent,
    supportsAtomicExchange,
    verifyBuildIdentity,
    verifyAssetClosure,
    viteBuildInvocation,
} from './client-build-atomic.mjs';
import {
    applyPreviewLedgerEvent,
    previewControlPaths,
    readPreviewLedger,
    readPublishBaseGuardLog,
    reconcileClientPreviewLedger,
} from './local-preview-ledger.mjs';
import { commonGitDir } from './git-control-root.mjs';

const EXCHANGE_SUPPORTED = supportsAtomicExchange();

function scratch() {
    return mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'client-atomic-'));
}

function assertFixtureControlRoot(root) {
    const expected = realpathSync(path.join(root, '.git'));
    assert.equal(commonGitDir(root), expected, 'fixture must own its canonical Git common directory');
    const paths = previewControlPaths(root);
    assert.equal(paths.gitDirectory, expected);
    for (const key of ['ledger', 'ledgerLock', 'buildLock']) assert.equal(path.dirname(paths[key]), expected);
    return paths;
}

function initializeFixtureRepository(root) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const initialized = spawnSync('git', ['init', '--quiet', '--initial-branch=main', root], { env, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    return assertFixtureControlRoot(root);
}

function directoryContents(root, relative = '') {
    const output = [];
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) output.push(...directoryContents(root, child));
        else if (entry.isSymbolicLink()) output.push([child.split(path.sep).join('/'), `link:${readlinkSync(path.join(root, child))}`]);
        else output.push([child.split(path.sep).join('/'), readFileSync(path.join(root, child), 'hex')]);
    }
    return output.sort(([left], [right]) => left.localeCompare(right));
}

test('content build id is stable and changes with client content', () => {
    const root = scratch();
    try {
        mkdirSync(path.join(root, 'src'));
        writeFileSync(path.join(root, 'src', 'app.tsx'), 'one');
        const first = computeClientBuildId(root);
        assert.match(first, /^[a-f0-9]{64}$/);
        assert.equal(computeClientBuildId(root), first);
        writeFileSync(path.join(root, 'src', 'app.tsx'), 'two');
        assert.notEqual(computeClientBuildId(root), first);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('digest covers production client code and exposed VITE env, but ignores every test-only input and server-only env', () => {
    const root = scratch();
    const previous = process.env.VITE_ATOMIC_TEST;
    try {
        mkdirSync(path.join(root, 'src'));
        mkdirSync(path.join(root, 'shared'));
        writeFileSync(path.join(root, 'src', 'app.tsx'), 'app');
        writeFileSync(path.join(root, 'src', 'app.test.tsx'), 'src-test-one');
        mkdirSync(path.join(root, 'src', '__tests__'));
        writeFileSync(path.join(root, 'src', '__tests__', 'fixture.ts'), 'fixture-one');
        writeFileSync(path.join(root, 'shared', 'client.js'), 'shared-one');
        writeFileSync(path.join(root, 'shared', 'client.test.js'), 'test-one');
        writeFileSync(path.join(root, '.env.production'), 'SERVER_SECRET=one\nVITE_PUBLIC_NAME=one\n');
        process.env.VITE_ATOMIC_TEST = 'one';
        const baseline = computeClientBuildId(root);
        const epoch = computeClientInputEpoch(root);
        writeFileSync(path.join(root, 'src', 'app.test.tsx'), 'src-test-two');
        writeFileSync(path.join(root, 'src', '__tests__', 'fixture.ts'), 'fixture-two');
        writeFileSync(path.join(root, 'shared', 'client.test.js'), 'test-two');
        assert.equal(computeClientBuildId(root), baseline);
        assert.equal(computeClientInputEpoch(root), epoch);
        writeFileSync(path.join(root, 'shared', 'client.js'), 'shared-two');
        assert.notEqual(computeClientBuildId(root), baseline);
        const sharedDigest = computeClientBuildId(root);
        writeFileSync(path.join(root, '.env.production'), 'SERVER_SECRET=two\nVITE_PUBLIC_NAME=one\n');
        assert.equal(computeClientBuildId(root), sharedDigest);
        writeFileSync(path.join(root, '.env.production'), 'SERVER_SECRET=two\nVITE_PUBLIC_NAME=two\n');
        assert.notEqual(computeClientBuildId(root), sharedDigest);
    } finally {
        if (previous === undefined) delete process.env.VITE_ATOMIC_TEST;
        else process.env.VITE_ATOMIC_TEST = previous;
        rmSync(root, { recursive: true, force: true });
    }
});

test('watch/fingerprint test-only classifier covers src, shared and nested test directories', () => {
    for (const file of [
        'src/app.test.tsx', 'src/app.spec.ts', 'src/__tests__/fixture.ts',
        'shared/value.test.js', 'shared/nested/__tests__/value.ts',
    ]) assert.equal(isIgnoredClientInput(file), true, file);
    for (const file of ['src/app.tsx', 'shared/value.ts', 'vite.config.js']) {
        assert.equal(isIgnoredClientInput(file), false, file);
    }
});

test('legacy hashed assets merge, while a same-name different-content conflict fails', () => {
    const root = scratch();
    try {
        const live = path.join(root, 'live');
        const staged = path.join(root, 'staged');
        mkdirSync(path.join(live, 'assets'), { recursive: true });
        mkdirSync(path.join(staged, 'assets'), { recursive: true });
        writeFileSync(path.join(live, 'assets', 'old-abc.js'), 'old');
        mergeLegacyAssets(live, staged);
        assert.equal(readFileSync(path.join(staged, 'assets', 'old-abc.js'), 'utf8'), 'old');
        writeFileSync(path.join(staged, 'assets', 'old-abc.js'), 'different');
        assert.throws(() => mergeLegacyAssets(live, staged), /Hashed asset conflict/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function assetFixture() {
    const root = scratch();
    const live = path.join(root, 'live');
    const staged = path.join(root, 'staged');
    mkdirSync(path.join(live, 'assets'), { recursive: true });
    mkdirSync(path.join(staged, 'assets'), { recursive: true });
    return { root, live, staged };
}

function generationMetadata(directory) {
    return JSON.parse(readFileSync(path.join(directory, 'ATOMIC_GENERATION.json'), 'utf8'));
}

test('legacy preservation keeps assets older than 24 hours without renewing their age', () => {
    const { root, live, staged } = assetFixture();
    try {
        writeFileSync(path.join(live, 'assets', 'expired.js'), 'old');
        writeFileSync(path.join(staged, 'assets', 'fresh.js'), 'fresh');
        writeFileSync(path.join(live, 'ATOMIC_GENERATION.json'), JSON.stringify({ assets: [
            { path: 'assets/expired.js', lastFreshAt: 1, size: 3 },
        ] }));
        const before = directoryContents(live);
        mergeLegacyAssets(live, staged, { now: 2 * 24 * 60 * 60 * 1000, maxAgeMs: 1, maxBytes: 8 });
        assert.equal(readFileSync(path.join(staged, 'assets', 'expired.js'), 'utf8'), 'old');
        assert.equal(generationMetadata(staged).assets.find((asset) => asset.path.endsWith('expired.js')).lastFreshAt, 1);
        assert.deepEqual(directoryContents(live), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy preservation refuses the entire union before any mutation when capacity is insufficient', () => {
    const { root, live, staged } = assetFixture();
    try {
        writeFileSync(path.join(live, 'assets', 'old.js'), 'old');
        writeFileSync(path.join(staged, 'assets', 'fresh.js'), 'fresh');
        const liveBefore = directoryContents(live);
        const stagedBefore = directoryContents(staged);
        assert.throws(() => mergeLegacyAssets(live, staged, { maxBytes: 7 }), /capacity exceeded: 8 bytes required/);
        assert.deepEqual(directoryContents(live), liveBefore);
        assert.deepEqual(directoryContents(staged), stagedBefore);
        for (const maxBytes of [-1, NaN, Infinity, 1.5]) {
            assert.throws(() => mergeLegacyAssets(live, staged, { maxBytes }), /Invalid asset preservation limits/);
        }
        assert.deepEqual(directoryContents(staged), stagedBefore);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy preservation enumerates omitted assets and preserves unknown ages across generations', () => {
    const { root, live, staged } = assetFixture();
    try {
        writeFileSync(path.join(live, 'assets', 'unlisted.js'), 'unlisted');
        writeFileSync(path.join(live, 'ATOMIC_GENERATION.json'), JSON.stringify({ assets: [], emittedAssets: [] }));
        writeFileSync(path.join(staged, 'ATOMIC_GENERATION.json'), JSON.stringify({ buildId: 'candidate', sourceOid: 'unchanged' }));
        mergeLegacyAssets(live, staged, { now: 100 });
        assert.deepEqual(generationMetadata(staged), {
            buildId: 'candidate', sourceOid: 'unchanged', emittedAssets: ['assets/unlisted.js'],
            assets: [{ path: 'assets/unlisted.js', size: 8, lastFreshAt: null }],
        });
        const next = path.join(root, 'next');
        mkdirSync(path.join(next, 'assets'), { recursive: true });
        mergeLegacyAssets(staged, next, { now: 200 });
        assert.equal(generationMetadata(next).assets[0].lastFreshAt, null);
        assert.equal(readFileSync(path.join(next, 'assets', 'unlisted.js'), 'utf8'), 'unlisted');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy preservation retry of the same candidate retains inherited and fresh timestamps', () => {
    const { root, live, staged } = assetFixture();
    try {
        writeFileSync(path.join(live, 'assets', 'unknown.js'), 'unknown');
        writeFileSync(path.join(live, 'assets', 'old.js'), 'old');
        writeFileSync(path.join(live, 'ATOMIC_GENERATION.json'), JSON.stringify({ assets: [
            { path: 'assets/old.js', size: 3, lastFreshAt: 1 },
        ] }));
        writeFileSync(path.join(staged, 'assets', 'new.js'), 'new');
        mergeLegacyAssets(live, staged, { now: 100 });
        const original = directoryContents(staged);
        mergeLegacyAssets(live, staged, { now: 200 });
        assert.deepEqual(directoryContents(staged), original);
        assert.deepEqual(generationMetadata(staged).assets.map(({ lastFreshAt }) => lastFreshAt), [100, 1, null]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy preservation retries a partial copy failure without renewing known or unknown age', (t) => {
    for (const firstAge of [1, null]) {
        const { root, live, staged } = assetFixture();
        const originalCopy = fs.copyFileSync;
        let copies = 0;
        try {
            writeFileSync(path.join(live, 'assets', 'a-first.js'), 'first');
            writeFileSync(path.join(live, 'assets', 'z-second.js'), 'second');
            const ages = [firstAge, firstAge === null ? 1 : null];
            writeFileSync(path.join(live, 'ATOMIC_GENERATION.json'), JSON.stringify({ assets: [
                { path: 'assets/a-first.js', size: 5, lastFreshAt: ages[0] },
                { path: 'assets/z-second.js', size: 6, lastFreshAt: ages[1] },
            ] }));
            const liveBefore = directoryContents(live);
            const copyMock = t.mock.method(fs, 'copyFileSync', (...args) => {
                if (++copies === 2) throw Object.assign(new Error('Injected second-copy I/O failure'), { code: 'EIO' });
                return originalCopy(...args);
            });
            syncBuiltinESMExports();
            assert.throws(() => mergeLegacyAssets(live, staged, { now: 100 }), /second-copy I\/O failure/);
            assert.equal(copies, 2);
            assert.equal(readFileSync(path.join(staged, 'assets', 'a-first.js'), 'utf8'), 'first');
            assert.equal(existsSync(path.join(staged, 'ATOMIC_GENERATION.json')), false);
            copyMock.mock.restore();
            syncBuiltinESMExports();
            mergeLegacyAssets(live, staged, { now: 200 });
            assert.deepEqual(generationMetadata(staged).assets.map(({ lastFreshAt }) => lastFreshAt), ages);
            assert.deepEqual(directoryContents(live), liveBefore);
            assert.deepEqual(directoryContents(path.join(staged, 'assets')), directoryContents(path.join(live, 'assets')));
        } finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
            rmSync(root, { recursive: true, force: true });
        }
    }
});

test('legacy preservation rejects unlisted same-name content conflicts without mutation', () => {
    const { root, live, staged } = assetFixture();
    try {
        writeFileSync(path.join(live, 'assets', 'same.js'), 'old');
        writeFileSync(path.join(staged, 'assets', 'same.js'), 'new');
        writeFileSync(path.join(live, 'ATOMIC_GENERATION.json'), '{"assets":[]}');
        const before = directoryContents(staged);
        assert.throws(() => mergeLegacyAssets(live, staged), /Hashed asset conflict/);
        assert.deepEqual(directoryContents(staged), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy preservation validates metadata paths, duplicate entries, size and age against actual files', () => {
    const { root, live, staged } = assetFixture();
    try {
        writeFileSync(path.join(live, 'assets', 'old.js'), 'old');
        const valid = { path: 'assets/old.js', size: 3, lastFreshAt: 1 };
        const invalid = [
            { assets: [{ ...valid, path: 'assets/../outside.js' }] },
            { assets: [{ ...valid, path: 'assets//old.js' }] },
            { assets: [{ ...valid, path: 'assets/missing.js' }] },
            { assets: [valid, valid] }, { assets: [{ ...valid, size: 2 }] },
            { assets: [{ ...valid, lastFreshAt: '1' }] }, { assets: {} },
            { emittedAssets: ['assets/missing.js'] }, { emittedAssets: {} },
            { emittedAssets: ['assets/old.js', 'assets/old.js'] },
        ];
        for (const metadata of invalid) {
            writeFileSync(path.join(live, 'ATOMIC_GENERATION.json'), JSON.stringify(metadata));
            const before = directoryContents(staged);
            assert.throws(() => mergeLegacyAssets(live, staged), /Invalid|missing|Duplicate/);
            assert.deepEqual(directoryContents(staged), before);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy preservation rejects symlink assets, dangling ancestors and metadata links', () => {
    const { root, live, staged } = assetFixture();
    try {
        const link = path.join(live, 'assets', 'link');
        symlinkSync(path.join(root, 'absent'), link);
        assert.throws(() => mergeLegacyAssets(live, staged), /reject symlink/);
        rmSync(link);
        rmSync(path.join(staged, 'assets'), { recursive: true });
        symlinkSync(path.join(live, 'assets'), path.join(staged, 'assets'));
        assert.throws(() => mergeLegacyAssets(live, staged), /unsafe directory/);
        rmSync(path.join(staged, 'assets'));
        mkdirSync(path.join(staged, 'assets'));
        symlinkSync(path.join(root, 'absent'), path.join(live, 'ATOMIC_GENERATION.json'));
        assert.throws(() => mergeLegacyAssets(live, staged), /Invalid asset metadata file/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy preservation keeps the byte-identical union over successive publications', () => {
    const { root, live, staged } = assetFixture();
    try {
        mkdirSync(path.join(live, 'assets', 'nested'));
        writeFileSync(path.join(live, 'assets', 'nested', 'old.js'), 'old');
        writeFileSync(path.join(live, 'assets', 'shared.js'), 'shared');
        writeFileSync(path.join(staged, 'assets', 'shared.js'), 'shared');
        writeFileSync(path.join(staged, 'assets', 'new.js'), 'new');
        const before = directoryContents(live);
        mergeLegacyAssets(live, staged, { now: 100, maxBytes: 12 });
        const next = path.join(root, 'next');
        mkdirSync(path.join(next, 'assets'), { recursive: true });
        mergeLegacyAssets(staged, next, { now: 100_000_000, maxBytes: 12 });
        assert.deepEqual(directoryContents(path.join(next, 'assets')), directoryContents(path.join(staged, 'assets')));
        assert.deepEqual(directoryContents(live), before);
        assert.deepEqual(generationMetadata(next).emittedAssets, ['assets/nested/old.js', 'assets/new.js', 'assets/shared.js']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('asset closure rejects a missing emitted asset reference', () => {
    const root = scratch();
    try {
        mkdirSync(path.join(root, 'assets'));
        writeFileSync(path.join(root, 'index.html'), '<script src="/assets/app-1.js"></script>');
        assert.throws(() => verifyAssetClosure(root), /Asset closure failed/);
        writeFileSync(path.join(root, 'assets', 'app-1.js'), 'console.log(1)');
        assert.doesNotThrow(() => verifyAssetClosure(root));
        writeFileSync(path.join(root, 'assets', 'app-1.js'), 'import "./chunk-2.js"');
        assert.throws(() => verifyAssetClosure(root), /chunk-2/);
        writeFileSync(path.join(root, 'assets', 'chunk-2.js'), 'export default 2');
        assert.doesNotThrow(() => verifyAssetClosure(root));
        writeFileSync(path.join(root, 'assets', 'style.css'), 'src: url(./font.woff2)');
        assert.throws(() => verifyAssetClosure(root), /font\.woff2/);
        writeFileSync(path.join(root, 'assets', 'font.woff2'), 'font');
        assert.doesNotThrow(() => verifyAssetClosure(root));
        writeFileSync(path.join(root, 'index.html'), '<link rel="manifest" href="/manifest.webmanifest">');
        assert.throws(() => verifyAssetClosure(root), /manifest\.webmanifest/);
        writeFileSync(path.join(root, 'manifest.webmanifest'), '{}');
        assert.doesNotThrow(() => verifyAssetClosure(root));
        symlinkSync('/etc/hosts', path.join(root, 'assets', 'escape.js'));
        assert.throws(() => verifyAssetClosure(root), /rejects symlink/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('asset closure ignores only esbuild wrapper keys and checks broad JS asset references', () => {
    const root = scratch();
    try {
        mkdirSync(path.join(root, 'assets'));
        const app = path.join(root, 'assets', 'app.js');
        writeFileSync(app, [
            'const modules={"../../node_modules/cynefin/dist/index.js"(){return 1}};',
            'const loadChunk = () => import("./chunk.js");',
        ].join('\n'));
        assert.throws(() => verifyAssetClosure(root), /chunk\.js/);
        writeFileSync(path.join(root, 'assets', 'chunk.js'), 'export default 1');
        assert.doesNotThrow(() => verifyAssetClosure(root));

        writeFileSync(app, 'const modules={"../../node_modules/cynefin/dist/index.js"(t,e){return t(e)}};');
        assert.doesNotThrow(() => verifyAssetClosure(root));
        writeFileSync(app, 'const modules={"../../node_modules/cynefin/dist/index.js"(t=1){return t}};');
        assert.throws(() => verifyAssetClosure(root), /unsafe/);
        writeFileSync(app, 'const modules={"../../node_modules/cynefin/dist/index.js"(...args){return args}};');
        assert.throws(() => verifyAssetClosure(root), /unsafe/);

        writeFileSync(app, 'const sourceMetadata = "../../node_modules/cynefin/dist/index.js";');
        assert.throws(() => verifyAssetClosure(root), /unsafe \.\.\/\.\.\/node_modules\/cynefin\/dist\/index\.js/);

        writeFileSync(app, [
            'const modules={"../../node_modules/cynefin/dist/index.js"(t){return t}};',
            'const icon = new URL("./icon.svg", import.meta.url);',
        ].join('\n'));
        assert.throws(() => verifyAssetClosure(root), /icon\.svg/);
        writeFileSync(path.join(root, 'assets', 'icon.svg'), '<svg/>');
        assert.doesNotThrow(() => verifyAssetClosure(root));

        writeFileSync(app, 'const image = "/assets/missing.png";');
        assert.throws(() => verifyAssetClosure(root), /assets\/missing\.png/);
        writeFileSync(path.join(root, 'assets', 'missing.png'), 'png');
        assert.doesNotThrow(() => verifyAssetClosure(root));

        writeFileSync(app, [
            'fetch("./response.json");',
            'navigator.serviceWorker.register("/service-worker.js");',
            'image.src="./photo.png";',
        ].join(''));
        assert.throws(() => verifyAssetClosure(root), (error) => {
            assert.match(error.message, /response\.json/);
            assert.match(error.message, /service-worker\.js/);
            assert.match(error.message, /photo\.png/);
            return true;
        });
        writeFileSync(path.join(root, 'assets', 'response.json'), '{}');
        writeFileSync(path.join(root, 'service-worker.js'), 'self.addEventListener("fetch", () => {})');
        writeFileSync(path.join(root, 'assets', 'photo.png'), 'png');
        assert.doesNotThrow(() => verifyAssetClosure(root));

        writeFileSync(app, [
            'import"./side-effect.js";',
            'import{value}from"./named.js";',
            'export{value as default}from"./exported.js";',
        ].join(''));
        assert.throws(() => verifyAssetClosure(root), (error) => {
            assert.match(error.message, /side-effect\.js/);
            assert.match(error.message, /named\.js/);
            assert.match(error.message, /exported\.js/);
            return true;
        });
        writeFileSync(path.join(root, 'assets', 'side-effect.js'), 'export default 1');
        writeFileSync(path.join(root, 'assets', 'named.js'), 'export const value = 1');
        writeFileSync(path.join(root, 'assets', 'exported.js'), 'export const value = 1');
        assert.doesNotThrow(() => verifyAssetClosure(root));

        writeFileSync(app, 'const escaped = import("../../outside.js")');
        assert.throws(() => verifyAssetClosure(root), /unsafe \.\.\/\.\.\/outside\.js/);
        writeFileSync(app, 'export default 1');
        writeFileSync(path.join(root, 'metadata.json'), '{"schema":"../outside.json"}');
        assert.throws(() => verifyAssetClosure(root), /unsafe \.\.\/outside\.json/);
        writeFileSync(path.join(root, 'metadata.json'), '{}');
        writeFileSync(path.join(root, 'style.css'), 'background: url(../outside.svg)');
        assert.throws(() => verifyAssetClosure(root), /unsafe \.\.\/outside\.svg/);
        writeFileSync(path.join(root, 'style.css'), 'body {}');
        writeFileSync(path.join(root, 'index.html'), '<script src="../outside.js"></script>');
        assert.throws(() => verifyAssetClosure(root), /unsafe \.\.\/outside\.js/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('Vite marker cannot authorize a direct write to live dist', () => {
    const previousMarker = process.env.NASSAJ_ATOMIC_CLIENT_BUILD;
    const previousOutDir = process.env.NASSAJ_CLIENT_OUT_DIR;
    const previousBuildId = process.env.NASSAJ_BUILD_ID;
    try {
        process.env.NASSAJ_ATOMIC_CLIENT_BUILD = '1';
        process.env.NASSAJ_CLIENT_OUT_DIR = path.resolve('dist');
        process.env.NASSAJ_BUILD_ID = 'd'.repeat(64);
        assert.throws(() => viteConfig({ command: 'build', mode: 'production' }), /live dist is forbidden/);
    } finally {
        if (previousMarker === undefined) delete process.env.NASSAJ_ATOMIC_CLIENT_BUILD;
        else process.env.NASSAJ_ATOMIC_CLIENT_BUILD = previousMarker;
        if (previousOutDir === undefined) delete process.env.NASSAJ_CLIENT_OUT_DIR;
        else process.env.NASSAJ_CLIENT_OUT_DIR = previousOutDir;
        if (previousBuildId === undefined) delete process.env.NASSAJ_BUILD_ID;
        else process.env.NASSAJ_BUILD_ID = previousBuildId;
    }
});

test('client caches remain outside dependencies and reject path aliases or ungoverned overrides', () => {
    const root = scratch();
    try {
        const staging = path.join(root, 'staging');
        mkdirSync(staging);
        assert.equal(resolveClientCacheDir(root, null, {}), path.join(root, '.artifacts', 'vite-cache', String(process.pid)));
        const environment = { NASSAJ_ATOMIC_CLIENT_BUILD: '1', NASSAJ_CLIENT_CACHE_ROOT: root };
        assert.equal(resolveClientCacheDir(root, staging, environment), path.join(root, 'build-cache', 'vite'));
        assert.throws(() => resolveClientCacheDir(root, null, environment), /canonical atomic candidate/);
        assert.throws(() => resolveClientCacheDir(root, staging, { ...environment, NASSAJ_CLIENT_CACHE_ROOT: `${root}/../outside` }), /canonical atomic candidate/);
        const dependencies = path.join(root, 'node_modules');
        mkdirSync(dependencies);
        assert.throws(() => resolveClientCacheDir(root, staging, { ...environment, NASSAJ_CLIENT_CACHE_ROOT: dependencies }), /cannot write into dependencies/);
        symlinkSync(dependencies, path.join(root, 'build-cache'), 'dir');
        assert.throws(() => resolveClientCacheDir(root, staging, environment), /real directory/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Vite accepts only the fixed local-preview staging parent when preview is explicit', () => {
    const previousMarker = process.env.NASSAJ_ATOMIC_CLIENT_BUILD;
    const previousPreview = process.env.NASSAJ_LOCAL_PREVIEW;
    const previousOutDir = process.env.NASSAJ_CLIENT_OUT_DIR;
    const previousBuildId = process.env.NASSAJ_BUILD_ID;
    try {
        const staging = path.resolve('.nassaj-local-preview/client/dist.atomic.predeploy-staging-aaaaaaaaaaaa-123');
        mkdirSync(staging, { recursive: true });
        process.env.NASSAJ_ATOMIC_CLIENT_BUILD = '1';
        process.env.NASSAJ_LOCAL_PREVIEW = '1';
        process.env.NASSAJ_CLIENT_OUT_DIR = staging;
        process.env.NASSAJ_BUILD_ID = 'a'.repeat(64);
        const config = viteConfig({ command: 'build', mode: 'production' });
        assert.equal(config.build.outDir, staging);

        process.env.NASSAJ_CLIENT_OUT_DIR = path.resolve('.nassaj-local-preview/other/dist.atomic.predeploy-staging-aaaaaaaaaaaa-123');
        assert.throws(() => viteConfig({ command: 'build', mode: 'production' }), /approved project-disk staging parent/);
    } finally {
        rmSync(path.resolve('.nassaj-local-preview/client/dist.atomic.predeploy-staging-aaaaaaaaaaaa-123'), { recursive: true, force: true });
        for (const [key, value] of [
            ['NASSAJ_ATOMIC_CLIENT_BUILD', previousMarker], ['NASSAJ_LOCAL_PREVIEW', previousPreview],
            ['NASSAJ_CLIENT_OUT_DIR', previousOutDir], ['NASSAJ_BUILD_ID', previousBuildId],
        ]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('OID Vite output is bound to the real canonical preview root and rejects path substitution', () => {
    const root = scratch();
    const oid = 'a'.repeat(40);
    const control = path.join(root, '.nassaj-local-preview');
    const snapshots = path.join(control, 'oid-snapshots');
    const snapshot = path.join(snapshots, oid);
    const client = path.join(control, 'client');
    const staging = path.join(client, 'dist.atomic.predeploy-staging-bbbbbbbbbbbb-321');
    const environment = {
        NASSAJ_LOCAL_PREVIEW: '1', NASSAJ_CLIENT_PREVIEW_ROOT: root,
        NASSAJ_CLIENT_OUT_DIR: staging,
    };
    try {
        mkdirSync(snapshot, { recursive: true });
        mkdirSync(staging, { recursive: true });
        assert.equal(resolveAtomicClientOutDir(snapshot, environment), staging);

        for (const rejected of [
            path.join(root, 'dist'),
            path.join(client, 'dist.atomic.predeploy-staging-bbbbbbbbbbb-321'),
            path.join(control, 'client-near', 'dist.atomic.predeploy-staging-bbbbbbbbbbbb-321'),
            path.join(snapshot, '.nassaj-local-preview/client/dist.atomic.predeploy-staging-bbbbbbbbbbbb-321'),
        ]) {
            assert.throws(() => resolveAtomicClientOutDir(snapshot, {
                ...environment, NASSAJ_CLIENT_OUT_DIR: rejected,
            }));
        }
        assert.throws(() => resolveAtomicClientOutDir(snapshot, {
            ...environment, NASSAJ_CLIENT_OUT_DIR: `${client}/../client/${path.basename(staging)}`,
        }), /parent traversal/);

        const arbitrary = path.join(root, 'arbitrary');
        mkdirSync(arbitrary);
        assert.throws(() => resolveAtomicClientOutDir(snapshot, {
            ...environment, NASSAJ_CLIENT_PREVIEW_ROOT: arbitrary,
        }), /does not match/);

        const invalidSnapshot = path.join(snapshots, 'not-an-oid');
        mkdirSync(invalidSnapshot);
        assert.throws(() => resolveAtomicClientOutDir(invalidSnapshot, environment), /exact OID snapshot/);

        const rootAlias = `${root}-alias`;
        symlinkSync(root, rootAlias, 'dir');
        assert.throws(() => resolveAtomicClientOutDir(snapshot, {
            ...environment, NASSAJ_CLIENT_PREVIEW_ROOT: rootAlias,
        }), /preview root/);
        rmSync(rootAlias);

        const snapshotsReal = `${snapshots}-real`;
        renameSync(snapshots, snapshotsReal);
        symlinkSync(snapshotsReal, snapshots, 'dir');
        assert.throws(() => resolveAtomicClientOutDir(snapshot, environment), /source root/);
        rmSync(snapshots);
        renameSync(snapshotsReal, snapshots);

        const controlReal = `${control}-real`;
        renameSync(control, controlReal);
        symlinkSync(controlReal, control, 'dir');
        assert.throws(() => resolveAtomicClientOutDir(snapshot, environment), /source root/);
        rmSync(control);
        renameSync(controlReal, control);

        const stagingReal = `${staging}-real`;
        renameSync(staging, stagingReal);
        symlinkSync(stagingReal, staging, 'dir');
        assert.throws(() => resolveAtomicClientOutDir(snapshot, environment), /staging directory/);
        rmSync(staging);
        renameSync(stagingReal, staging);

        const clientReal = `${client}-real`;
        renameSync(client, clientReal);
        symlinkSync(clientReal, client, 'dir');
        assert.throws(() => resolveAtomicClientOutDir(snapshot, environment), /staging parent/);
        rmSync(client);
        renameSync(clientReal, client);

        const snapshotReal = `${snapshot}-real`;
        renameSync(snapshot, snapshotReal);
        symlinkSync(snapshotReal, snapshot, 'dir');
        assert.throws(() => resolveAtomicClientOutDir(snapshot, environment), /source root/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('server gives the promoted generation precedence over mutable public source', () => {
    const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
    assert.match(
        serverSource,
        /createClientManifestHandler\(APP_ROOT, getBrandingTitle\)/,
        'the branded manifest must use the atomically promoted copy as its base',
    );
    assert.doesNotMatch(
        serverSource,
        /express\.static\(path\.join\(APP_ROOT, ['"]public['"]\)\)/,
        'mounting public before dist would bypass the atomic generation',
    );
});

test('watcher capability gate fails closed for an old live process', async () => {
    const response = (body, ok = true) => async () => ({ ok, json: async () => body });
    assert.equal(await checkAtomicPublisherCapability('http://127.0.0.1:3004', response({})), false);
    assert.equal(await checkAtomicPublisherCapability('http://127.0.0.1:3004', response({ clientAtomicPublisherReady: false })), false);
    assert.equal(await checkAtomicPublisherCapability('http://127.0.0.1:3004', response({ clientAtomicPublisherReady: true })), true);
    assert.equal(await checkAtomicPublisherCapability('http://127.0.0.1:3004', response({}, false)), false);
    assert.equal(await checkAtomicPublisherCapability('http://127.0.0.1:3004', async () => { throw new Error('offline'); }), false);
    let reconciles = 0;
    const blocked = await gateAtomicPublisherStartup('http://127.0.0.1:3004', {
        fetchImpl: response({}),
        reconcile: () => { reconciles += 1; return ['unsafe']; },
    });
    assert.deepEqual(blocked, { ready: false, removed: [] });
    assert.equal(reconciles, 0, 'old process must not permit reconciliation or build preparation');
    const admitted = await gateAtomicPublisherStartup('http://127.0.0.1:3004', {
        fetchImpl: response({ clientAtomicPublisherReady: true }),
        reconcile: () => { reconciles += 1; return ['stale']; },
    });
    assert.deepEqual(admitted, { ready: true, removed: ['stale'] });

    const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
    assert.match(serverSource, /clientAtomicPublisherReady:\s*true/);
    const watcherSource = readFileSync(new URL('./client-build-watch.mjs', import.meta.url), 'utf8');
    assert.match(watcherSource, /gateAtomicPublisherStartup\(SMOKE_URL/);
    assert.match(watcherSource, /process\.exitCode = EX_CONFIG/);
});

test('generation guard cancels stale promotion', () => {
    const root = scratch();
    try {
        const file = path.join(root, 'generation');
        writeFileSync(file, '8\n');
        assert.doesNotThrow(() => assertGenerationCurrent(file, 8));
        assert.throws(() => assertGenerationCurrent(file, 7), /promotion cancelled/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('generation guard catches change-then-revert even when the content digest returns', () => {
    const root = scratch();
    try {
        const source = path.join(root, 'src');
        const generationFile = path.join(root, 'generation');
        mkdirSync(source);
        writeFileSync(path.join(source, 'app.tsx'), 'original');
        writeFileSync(generationFile, '20\n');
        const selectedDigest = computeClientBuildId(root);

        writeFileSync(path.join(source, 'app.tsx'), 'transient edit');
        writeFileSync(generationFile, '21\n');
        writeFileSync(path.join(source, 'app.tsx'), 'original');
        writeFileSync(generationFile, '22\n');

        assert.equal(computeClientBuildId(root), selectedDigest, 'content alone cannot reveal the reverted edit');
        assert.throws(() => assertGenerationCurrent(generationFile, 20), /promotion cancelled/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('manual-build metadata epoch catches change then revert without a watcher generation file', async () => {
    const root = scratch();
    try {
        mkdirSync(path.join(root, 'src'));
        const file = path.join(root, 'src', 'app.tsx');
        writeFileSync(file, 'same-size');
        const epoch = computeClientInputEpoch(root);
        await new Promise((resolve) => setTimeout(resolve, 5));
        writeFileSync(file, 'different');
        writeFileSync(file, 'same-size');
        assert.notEqual(computeClientInputEpoch(root), epoch);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('GNU exchange swaps directories without copying', { skip: !EXCHANGE_SUPPORTED }, () => {
    const root = scratch();
    try {
        const live = path.join(root, 'dist');
        const staged = path.join(root, 'staged');
        const generations = path.join(root, 'generations');
        mkdirSync(live);
        mkdirSync(staged);
        writeFileSync(path.join(live, 'value'), 'old');
        writeFileSync(path.join(staged, 'value'), 'new');
        assert.doesNotThrow(() => assertExchangeSupport(live, generations));
        promoteWithExchange(staged, live);
        assert.equal(readFileSync(path.join(live, 'value'), 'utf8'), 'new');
        assert.equal(readFileSync(path.join(staged, 'value'), 'utf8'), 'old');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('atomic publisher fails closed when GNU exchange is unavailable', { skip: EXCHANGE_SUPPORTED }, () => {
    const root = scratch();
    try {
        const live = path.join(root, 'dist');
        mkdirSync(live);
        assert.throws(() => assertExchangeSupport(live, root), /GNU mv with --exchange and --no-copy is required/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('kernel flock admits one publisher and releases after its owner exits', async () => {
    const root = scratch();
    const lock = path.join(root, 'build.lock');
    const holder = spawn('flock', ['-F', lock, process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (let index = 0; index < 8; index += 1) {
            assert.equal(runWithFlock(lock, process.execPath, ['-e', 'process.exit(0)']).status, 75);
        }
        assert.throws(
            () => acquireBuildLock(lock, process.execPath, ['-e', 'process.exit(0)']),
            (error) => error.exitCode === 75,
        );
        holder.kill('SIGKILL');
        await once(holder, 'exit');
        let released = false;
        for (let attempt = 0; attempt < 20 && !released; attempt += 1) {
            released = runWithFlock(lock, process.execPath, ['-e', 'process.exit(0)']).status === 0;
            if (!released) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(released, true, 'kernel lock must become acquirable after its owner exits');
        assert.throws(
            () => acquireBuildLock(lock, process.execPath, ['-e', 'process.exit(1)']),
            (error) => error.exitCode === 1,
            'a build failure must not be mislabeled as lock contention',
        );
    } finally {
        if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
    }
});

test('startup reconciliation removes a staging tree left by a killed builder', async () => {
    const root = scratch();
    const liveSentinel = path.join(root, 'dist', 'sentinel');
    mkdirSync(path.dirname(liveSentinel));
    writeFileSync(liveSentinel, 'live');
    const child = spawn(process.execPath, ['-e', `
      const fs=require('node:fs'); const path=require('node:path');
      fs.mkdirSync(path.join(process.argv[1], 'dist.atomic.predeploy-staging-deadbeefdead-'+process.pid));
      setInterval(()=>{},1000);
    `, root], { stdio: 'ignore' });
    try {
        const candidate = path.join(root, `dist.atomic.predeploy-staging-deadbeefdead-${child.pid}`);
        for (let attempt = 0; attempt < 50 && !existsSync(candidate); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(existsSync(candidate), true);
        assert.deepEqual(reconcileRuntimeState(root), [], 'an active builder staging tree must survive reconciliation');
        assert.equal(readFileSync(liveSentinel, 'utf8'), 'live');
        child.kill('SIGKILL');
        await once(child, 'exit');
        assert.deepEqual(reconcileRuntimeState(root), [path.basename(candidate)]);
        assert.equal(existsSync(candidate), false);
        assert.equal(readFileSync(liveSentinel, 'utf8'), 'live', 'kill cleanup must never touch the live generation');
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
    }
});

test('startup reconciliation detects source newer than the live generation', () => {
    const root = scratch();
    try {
        mkdirSync(path.join(root, 'src'));
        mkdirSync(path.join(root, 'dist'));
        writeFileSync(path.join(root, 'src', 'app.tsx'), 'one');
        writeFileSync(path.join(root, 'dist', 'version.json'), JSON.stringify({ buildId: computeClientBuildId(root) }));
        assert.equal(isLiveClientCurrent(root), true);
        writeFileSync(path.join(root, 'src', 'app.tsx'), 'two');
        assert.equal(isLiveClientCurrent(root), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('preview ledger fixture rejects parent discovery and isolates an initialized nested repository', () => {
    const parent = scratch();
    try {
        const parentPaths = initializeFixtureRepository(parent);
        applyPreviewLedgerEvent(parent, { target: 'client', sourceGeneration: 99, state: 'queued' });
        const parentBefore = readFileSync(parentPaths.ledger);
        const child = path.join(parent, 'nested');
        mkdirSync(path.join(child, '.git'), { recursive: true });
        assert.equal(commonGitDir(child), parentPaths.gitDirectory, 'empty .git reproduces parent discovery');
        assert.throws(() => assertFixtureControlRoot(child), /fixture must own/);
        const childPaths = initializeFixtureRepository(child);
        assert.notEqual(childPaths.gitDirectory, parentPaths.gitDirectory);
        applyPreviewLedgerEvent(child, { target: 'client', sourceGeneration: 1, state: 'queued' });
        assert.equal(readPreviewLedger(child).clientSourceGeneration, 1);
        assert.deepEqual(readFileSync(parentPaths.ledger), parentBefore);
        assert.equal(readPreviewLedger(parent).clientSourceGeneration, 99);
    } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('preview ledger uses the shared arbiter and preserves server state plus the last served client', () => {
    const root = scratch();
    const clientBuild = 'a'.repeat(64);
    const serverBuild = 'b'.repeat(64);
    try {
        initializeFixtureRepository(root);
        assert.equal(previewControlPaths(root).buildLock.endsWith('nassaj-local-preview-build.lock'), true);
        applyPreviewLedgerEvent(root, {
            target: 'server', sourceGeneration: 4, state: 'loaded',
            sourceBuildId: serverBuild, candidateBuildId: serverBuild,
            promotedBuildId: serverBuild, runtimeBuildId: serverBuild,
        }, '2026-08-19T00:00:00.000Z');
        applyPreviewLedgerEvent(root, {
            target: 'client', sourceGeneration: 7, state: 'served',
            sourceBuildId: clientBuild, candidateBuildId: clientBuild,
            promotedBuildId: clientBuild, runtimeBuildId: clientBuild,
        }, '2026-08-19T00:00:01.000Z');
        applyPreviewLedgerEvent(root, {
            target: 'client', sourceGeneration: 8, state: 'failed',
            sourceBuildId: 'c'.repeat(64), error: { code: 'synthetic', message: 'no promotion' },
        }, '2026-08-19T00:00:02.000Z');
        const ledger = readPreviewLedger(root);
        assert.equal(ledger.schemaVersion, 1);
        assert.equal(ledger.serverLoadedBuildId, serverBuild, 'a client write must preserve server truth');
        assert.equal(ledger.clientState, 'failed');
        assert.equal(ledger.lastSuccessfulClient.clientServedBuildId, clientBuild);
        assert.equal(ledger.clientServedBuildId, clientBuild, 'a failure must preserve the actually served build');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('preview ledger reconciliation repairs an interrupted promoted client only when live identity matches', () => {
    const root = scratch();
    const candidate = 'd'.repeat(64);
    try {
        initializeFixtureRepository(root);
        applyPreviewLedgerEvent(root, {
            target: 'client', sourceGeneration: 3, state: 'promoted',
            sourceBuildId: candidate, candidateBuildId: candidate, promotedBuildId: candidate,
        });
        reconcileClientPreviewLedger(root, 3, candidate, candidate);
        let ledger = readPreviewLedger(root);
        assert.equal(ledger.clientState, 'served');
        assert.equal(ledger.clientServedBuildId, candidate);

        applyPreviewLedgerEvent(root, {
            target: 'client', sourceGeneration: 4, state: 'building',
            sourceBuildId: 'e'.repeat(64), candidateBuildId: 'e'.repeat(64),
        });
        reconcileClientPreviewLedger(root, 4, 'e'.repeat(64), candidate);
        ledger = readPreviewLedger(root);
        assert.equal(ledger.clientState, 'observed');
        assert.equal(ledger.lastSuccessfulClient.clientServedBuildId, candidate);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('preview ledger fencing ignores a stale builder after a newer source generation is queued', () => {
    const root = scratch();
    try {
        initializeFixtureRepository(root);
        applyPreviewLedgerEvent(root, { target: 'client', sourceGeneration: 12, state: 'queued' });
        applyPreviewLedgerEvent(root, {
            target: 'client', sourceGeneration: 11, state: 'failed',
            sourceBuildId: 'f'.repeat(64), error: { code: 'late', message: 'stale child exited' },
        });
        const ledger = readPreviewLedger(root);
        assert.equal(ledger.clientSourceGeneration, 12);
        assert.equal(ledger.clientState, 'queued');
        assert.equal(ledger.clientError, null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('retention bookkeeping failure never invalidates the promoted live tree', () => {
    const root = scratch();
    try {
        const missingOld = path.join(root, 'missing-old');
        assert.doesNotThrow(() => retainPrevious(missingOld, 'a'.repeat(64), root));
        assert.equal(retainPrevious(missingOld, 'a'.repeat(64), root), missingOld);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('systemd watcher template kills the whole build cgroup and exposes no server secrets', () => {
    const unit = readFileSync(new URL('./systemd/nassaj-client-build-watch.service', import.meta.url), 'utf8');
    assert.match(unit, /^KillMode=control-group$/m);
    assert.match(unit, /^Environment=TMPDIR=\/var\/tmp$/m);
    assert.match(unit, /^Environment=SERVER_PORT=3004$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^RestartPreventExitStatus=78$/m);
    assert.match(unit, /^CPUQuota=150%$/m);
    assert.match(unit, /^MemoryHigh=2G$/m);
    assert.match(unit, /^MemoryMax=3G$/m);
    assert.match(unit, /^TasksMax=256$/m);
    assert.match(unit, /^Nice=10$/m);
    assert.match(unit, /^IOSchedulingClass=best-effort$/m);
    assert.match(unit, /^IOSchedulingPriority=6$/m);
    assert.match(unit, /^SystemCallFilter=~@mount @obsolete @privileged @raw-io @reboot @swap$/m);
    assert.match(unit, /^SystemCallErrorNumber=EPERM$/m);
    assert.match(unit, /^ReadWritePaths=%h\/Project\/nassaj-dev$/m);
    for (const protectedInput of [
        'src', 'public', 'docs', 'shared', 'server', 'scripts', 'node_modules',
        'index.html', 'package.json', 'package-lock.json', 'vite.config.js',
        'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', 'tsconfig.preview.json',
    ]) {
        assert.match(unit, new RegExp(`^ReadOnlyPaths=-%h/Project/nassaj-dev/${protectedInput.replaceAll('.', '\\.')}$`, 'm'));
    }
    assert.doesNotMatch(unit, /JWT|DATABASE|TOKEN|SECRET/);
    const watcher = readFileSync(new URL('./client-build-watch.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(watcher, /NODE_OPTIONS/);
    const builder = readFileSync(new URL('./client-build-atomic.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(builder, /server\/tsconfig\.json/);
    assert.match(builder, /options\.localPreview \? 'tsconfig\.preview\.json' : 'tsconfig\.json'/);
    const previewConfig = readFileSync(new URL('../tsconfig.preview.json', import.meta.url), 'utf8');
    assert.match(previewConfig, /src\/\*\*\/\*\.test\.\*/);
    assert.match(previewConfig, /shared\/\*\*\/__tests__/);
});

test('Vite build runs through Node with bounded old-space before the script argv', () => {
    const root = path.join(path.sep, 'srv', 'nassaj');
    assert.deepEqual(viteBuildInvocation(root), {
        command: process.execPath,
        args: [
            '--max-old-space-size=1536',
            path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
            'build',
            '--configLoader',
            'runner',
        ],
    });
});

test('Vite runner config loader builds deterministically without writing to read-only source or node_modules', () => {
    const scratchRoot = scratch();
    const root = path.join(scratchRoot, 'source');
    const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const nodeModules = path.join(root, 'node_modules');
    const bundleOutput = path.join(scratchRoot, 'bundle-output');
    const runnerOutputOne = path.join(scratchRoot, 'runner-output-one');
    const runnerOutputTwo = path.join(scratchRoot, 'runner-output-two');
    try {
        mkdirSync(nodeModules, { recursive: true });
        symlinkSync(path.join(projectRoot, 'node_modules', 'vite'), path.join(nodeModules, 'vite'), 'dir');
        writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
        writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/main.js"></script>\n');
        writeFileSync(path.join(root, 'main.js'), 'document.body.textContent = "readonly";\n');
        writeFileSync(path.join(root, 'vite.config.js'), [
            "import { defineConfig } from 'vite';",
            "export default defineConfig({ build: { outDir: process.env.TEST_OUT_DIR, emptyOutDir: true } });",
            '',
        ].join('\n'));

        const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
        const bundle = spawnSync(process.execPath, [viteCli, 'build', '--configLoader', 'bundle'], {
            cwd: root, encoding: 'utf8', env: { ...process.env, TEST_OUT_DIR: bundleOutput },
        });
        assert.equal(bundle.status, 0, bundle.stderr || bundle.stdout);
        rmSync(path.join(nodeModules, '.vite-temp'), { recursive: true, force: true });

        for (const file of ['package.json', 'index.html', 'main.js', 'vite.config.js']) chmodSync(path.join(root, file), 0o444);
        chmodSync(nodeModules, 0o555);
        chmodSync(root, 0o555);
        const sourceBefore = directoryContents(root);
        const invocation = viteBuildInvocation(projectRoot);
        for (const output of [runnerOutputOne, runnerOutputTwo]) {
            const result = spawnSync(invocation.command, invocation.args, {
                cwd: root, encoding: 'utf8', env: { ...process.env, TEST_OUT_DIR: output },
            });
            assert.equal(result.status, 0, result.stderr || result.stdout);
            assert.equal(existsSync(path.join(nodeModules, '.vite-temp')), false);
            assert.deepEqual(directoryContents(root), sourceBefore);
        }
        assert.deepEqual(directoryContents(runnerOutputOne), directoryContents(bundleOutput));
        assert.deepEqual(directoryContents(runnerOutputTwo), directoryContents(runnerOutputOne));
    } finally {
        if (existsSync(root)) chmodSync(root, 0o700);
        if (existsSync(nodeModules)) chmodSync(nodeModules, 0o700);
        for (const file of ['package.json', 'index.html', 'main.js', 'vite.config.js']) {
            if (existsSync(path.join(root, file))) chmodSync(path.join(root, file), 0o600);
        }
        rmSync(scratchRoot, { recursive: true, force: true });
    }
});

test('release candidate uses the central runner invocation and passes closure, identity and smoke gates', async () => {
    const root = scratch();
    const source = path.join(root, 'source');
    const candidate = path.join(root, 'candidate');
    const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const releaseCommit = 'd'.repeat(40);
    const calls = [];
    try {
        mkdirSync(path.join(source, 'src'), { recursive: true });
        mkdirSync(path.join(source, 'node_modules'));
        mkdirSync(candidate);
        symlinkSync(path.join(projectRoot, 'node_modules', 'vite'), path.join(source, 'node_modules', 'vite'), 'dir');
        writeFileSync(path.join(source, 'package.json'), '{"type":"module"}\n');
        writeFileSync(path.join(source, 'package-lock.json'), '{}\n');
        writeFileSync(path.join(source, 'index.html'), '<script type="module" src="/src/main.js"></script>\n');
        writeFileSync(path.join(source, 'src', 'main.js'), 'document.body.textContent = __BUILD_ID__; import("./lazy.js");\n');
        writeFileSync(path.join(source, 'src', 'lazy.js'), 'export const lazy = true;\n');
        writeFileSync(path.join(source, 'vite.config.js'), [
            "import { writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "import { defineConfig } from 'vite';",
            'const outDir = process.env.NASSAJ_CLIENT_OUT_DIR;',
            'export default defineConfig({',
            '  cacheDir: join(process.env.NASSAJ_CLIENT_CACHE_ROOT, "build-cache", "vite"),',
            '  define: { __BUILD_ID__: JSON.stringify(process.env.NASSAJ_BUILD_ID) },',
            '  build: { outDir, emptyOutDir: true },',
            '  plugins: [{ name: "version", closeBundle() {',
            '    writeFileSync(join(outDir, "version.json"), JSON.stringify({ buildId: process.env.NASSAJ_BUILD_ID }));',
            '  } }],',
            '});',
            '',
        ].join('\n'));

        const result = await buildClientReleaseCandidate({
            sourceRoot: source,
            candidateRoot: candidate,
            outputRoot: path.join(candidate, 'client'),
            releaseCommit,
            version: '1.45.0.4',
            publicVite: {},
        }, {
            run(command, args, options) {
                calls.push({ command, args: [...args] });
                if (command.endsWith(path.join('node_modules', '.bin', 'tsc'))) return;
                assert.equal(options.env.NASSAJ_CLIENT_CACHE_ROOT, candidate);
                const child = spawnSync(command, args, { ...options, encoding: 'utf8', stdio: 'pipe' });
                assert.equal(child.status, 0, child.stderr || child.stdout);
            },
        });

        assert.deepEqual(calls[1], viteBuildInvocation(source));
        assert.equal(result.releaseCommit, releaseCommit);
        assert.doesNotThrow(() => verifyAssetClosure(result.outputRoot));
        assert.doesNotThrow(() => verifyBuildIdentity(result.outputRoot, result.buildId));
        assert.equal(existsSync(path.join(source, 'node_modules', '.vite-temp')), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a failed post-exchange smoke restores the previous live directory', { skip: !EXCHANGE_SUPPORTED }, async () => {
    const f = baseGuardFixture();
    try {
        const live = stampedDir(f.root, 'dist', { commit: f.a });
        const staged = stampedDir(f.root, 'staged', { commit: f.b });
        writeFileSync(path.join(live, 'value'), 'old');
        writeFileSync(path.join(staged, 'value'), 'new');
        await assert.rejects(() => promoteWithSmokeRollback(staged, live, async () => { throw new Error('bad smoke'); }, { root: f.root }), /bad smoke/);
        assert.equal(readFileSync(path.join(live, 'value'), 'utf8'), 'old');
        assert.equal(readFileSync(path.join(staged, 'value'), 'utf8'), 'new');
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('promoteWithSmokeRollback enforces the base guard by default when no options are passed', async () => {
    const root = scratch();
    try {
        const live = path.join(root, 'dist'); const staged = path.join(root, 'staged');
        mkdirSync(live); mkdirSync(staged);
        writeFileSync(path.join(live, 'value'), 'old'); writeFileSync(path.join(staged, 'value'), 'new');
        // No guardOptions and no candidate provenance: the default-on guard must
        // refuse before any exchange rather than silently promoting.
        await assert.rejects(() => promoteWithSmokeRollback(staged, live, async () => {}),
            /candidate provenance records no source commit/);
        assert.equal(readFileSync(path.join(live, 'value'), 'utf8'), 'old', 'the default guard must refuse before the exchange');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('bundle, version and provenance must share the content build id', () => {
    const root = scratch();
    const buildId = 'b'.repeat(64);
    try {
        mkdirSync(path.join(root, 'assets'));
        writeFileSync(path.join(root, 'version.json'), JSON.stringify({ buildId }));
        writeFileSync(path.join(root, 'BUILD_PROVENANCE.json'), JSON.stringify({ buildId }));
        writeFileSync(path.join(root, 'assets', 'app.js'), `const id = "${buildId}"`);
        assert.doesNotThrow(() => verifyBuildIdentity(root, buildId));
        writeFileSync(path.join(root, 'version.json'), JSON.stringify({ buildId: 'c'.repeat(64) }));
        assert.throws(() => verifyBuildIdentity(root, buildId), /mismatch/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function restoredAssetFixture(t) {
    const f = assetFixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const survivor = path.join(f.root, 'survivor'); mkdirSync(path.join(survivor, 'assets'), { recursive: true });
    writeFileSync(path.join(survivor, 'assets/lost.js'), 'lost');
    writeFileSync(path.join(survivor, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'client',
        buildId: 'a'.repeat(64), commit: 'b'.repeat(40), dirty: false, builtAt: '2026-01-01T00:00:00Z' }));
    writeFileSync(path.join(survivor, 'version.json'), JSON.stringify({ buildId: 'a'.repeat(64) }));
    writeFileSync(path.join(survivor, 'ATOMIC_GENERATION.json'), JSON.stringify({ assets: [
        { path: 'assets/lost.js', size: 4, lastFreshAt: 123 },
    ] }));
    // The test environment's shared umask creates fixture paths group-writable.
    // A real restoration witness must reject that, so make this deliberately
    // reviewed fixture private before pinning its witness.
    chmodSync(path.join(survivor, 'assets'), 0o755);
    chmodSync(path.join(survivor, 'assets/lost.js'), 0o644);
    for (const name of ['BUILD_PROVENANCE.json', 'version.json', 'ATOMIC_GENERATION.json']) {
        chmodSync(path.join(survivor, name), 0o644);
    }
    chmodSync(survivor, 0o755);
    writeFileSync(path.join(f.live, 'assets/live.js'), 'live');
    writeFileSync(path.join(f.staged, 'assets/new.js'), 'new');
    const witness = inspectRestorationWitness(survivor);
    const restoration = { schema: 'nassaj-client-asset-restoration/v1', survivors: [witness], assets: [{
        path: 'assets/lost.js', size: 4, sha256: '76f75e6129fe30135bd44d80ab7cc46fdba81907758dc808f3e2517beef2b1e9',
        lastFreshAt: 123, survivorDirectory: survivor,
    }] };
    return { ...f, survivor, restoration };
}

test('reviewed restoration preflights whole union and preserves historical age without live writes', t => {
    const f = restoredAssetFixture(t), before = directoryContents(f.live);
    mergeLegacyAssets(f.live, f.staged, { restoration: f.restoration, maxBytes: 11, now: 999 });
    assert.equal(readFileSync(path.join(f.staged, 'assets/lost.js'), 'utf8'), 'lost');
    assert.equal(generationMetadata(f.staged).assets.find(x => x.path === 'assets/lost.js').lastFreshAt, 123);
    assert.deepEqual(directoryContents(f.live), before);
});

for (const kind of ['capacity', 'witness', 'asset-digest', 'age', 'candidate-conflict', 'duplicate']) {
    test(`reviewed restoration rejects ${kind} before any copying`, t => {
        const f = restoredAssetFixture(t);
        if (kind === 'witness') writeFileSync(path.join(f.survivor, 'version.json'), '{}');
        if (kind === 'asset-digest') f.restoration.assets[0].sha256 = '0'.repeat(64);
        if (kind === 'age') f.restoration.assets[0].lastFreshAt = 999;
        if (kind === 'candidate-conflict') writeFileSync(path.join(f.staged, 'assets/lost.js'), 'conflict');
        if (kind === 'duplicate') f.restoration.assets.push({ ...f.restoration.assets[0] });
        const before = directoryContents(f.staged), live = directoryContents(f.live);
        assert.throws(() => mergeLegacyAssets(f.live, f.staged, { restoration: f.restoration,
            maxBytes: kind === 'capacity' ? 10 : 100 }), /restoration|Restoration|capacity/);
        assert.deepEqual(directoryContents(f.staged), before);
        assert.deepEqual(directoryContents(f.live), live);
    });
}

// Model byte sizes without allocating a GiB; real asset hashing and mutation guards still run.
for (const reportedSize of [768 * 1024 * 1024 + 1, 1024 * 1024 * 1024, 1024 * 1024 * 1024 + 1]) {
    test('default asset ceiling keeps complete union bounded at 1 GiB: ' + reportedSize, () => {
        const { root, live, staged } = assetFixture();
        const asset = path.join(staged, 'assets', 'sized.js');
        writeFileSync(asset, 'content');
        const before = directoryContents(staged), liveBefore = directoryContents(live);
        const original = fs.lstatSync, priorLimit = process.env.NASSAJ_CLIENT_ASSET_MAX_BYTES;
        try {
            delete process.env.NASSAJ_CLIENT_ASSET_MAX_BYTES;
            fs.lstatSync = function (file, ...args) {
                const stat = original(file, ...args);
                return file === asset ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: reportedSize }) : stat;
            };
            syncBuiltinESMExports();
            if (reportedSize > 1024 * 1024 * 1024) {
                assert.throws(() => mergeLegacyAssets(live, staged), /capacity exceeded: 1073741825 bytes required; limit 1073741824/);
                assert.deepEqual(directoryContents(staged), before);
            } else {
                mergeLegacyAssets(live, staged);
                assert.equal(generationMetadata(staged).assets[0].size, reportedSize);
                assert.equal(readFileSync(asset, 'utf8'), 'content');
            }
            assert.deepEqual(directoryContents(live), liveBefore);
        } finally {
            fs.lstatSync = original;
            syncBuiltinESMExports();
            if (priorLimit === undefined) delete process.env.NASSAJ_CLIENT_ASSET_MAX_BYTES;
            else process.env.NASSAJ_CLIENT_ASSET_MAX_BYTES = priorLimit;
            rmSync(root, { recursive: true, force: true });
        }
    });
}

// B-1009: parent approval must survive the child-process baseline window.
test('reviewed source rejects a changed child baseline and pre-exchange epoch', () => {
    const approved = { expectedBuildId: 'a'.repeat(64), expectedInputEpoch: 'b'.repeat(64) };
    assert.doesNotThrow(() => assertReviewedClientInput(approved, approved.expectedBuildId, approved.expectedInputEpoch));
    assert.throws(() => assertReviewedClientInput(approved, 'c'.repeat(64), 'd'.repeat(64)), /source changed/);
    assert.throws(() => assertReviewedClientInput(approved, approved.expectedBuildId, 'd'.repeat(64)), /source changed/);
    assert.throws(() => assertReviewedClientInput({ expectedBuildId: approved.expectedBuildId }, approved.expectedBuildId, approved.expectedInputEpoch), /supplied together/);
});

test('explicit keep-previous operation preserves all existing rollback generations', () => {
    const root = mkdtempSync(path.join(process.cwd(), '.artifacts/b1009-retention-'));
    try {
        for (const n of ['1', '2', '3', '4']) mkdirSync(path.join(root, `dist.atomic.predeploy-previous-${n}`));
        const old = path.join(root, 'old-live'); mkdirSync(old);
        const kept = retainPrevious(old, 'a'.repeat(64), root, true);
        assert.equal(readdirSync(root).filter(n => n.startsWith('dist.atomic.predeploy-previous-')).length, 5);
        assert.equal(existsSync(kept), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

// T-1741 (B-1059): the shared publish base-regression guard at the promote chokepoint.
function guardGit(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function baseGuardFixture() {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'client-base-guard-'));
    guardGit(root, 'init', '-q', '-b', 'main');
    guardGit(root, 'config', 'user.name', 'Guard'); guardGit(root, 'config', 'user.email', 'guard@example.invalid');
    writeFileSync(path.join(root, 'f'), 'a'); guardGit(root, 'add', 'f'); guardGit(root, 'commit', '-qm', 'a');
    const a = guardGit(root, 'rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'f'), 'b'); guardGit(root, 'add', 'f'); guardGit(root, 'commit', '-qm', 'b');
    const b = guardGit(root, 'rev-parse', 'HEAD');
    guardGit(root, 'checkout', '-q', '-b', 'side', a);
    writeFileSync(path.join(root, 's'), 'c'); guardGit(root, 'add', 's'); guardGit(root, 'commit', '-qm', 'c');
    const c = guardGit(root, 'rev-parse', 'HEAD');
    guardGit(root, 'checkout', '-q', 'main');
    return { root, a, b, c };
}
function stampedDir(root, name, provenance) {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    if (provenance) writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'),
        JSON.stringify({ artifact: 'client', buildId: '0'.repeat(64), dirty: false, ...provenance }));
    return directory;
}

test('base guard allows a fast-forward live base and audits the decision', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.b });
        const live = stampedDir(f.root, 'dist', { commit: f.a });
        assert.doesNotThrow(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }));
        const entry = readPublishBaseGuardLog(f.root).at(-1);
        assert.deepEqual({ result: entry.result, liveCommit: entry.liveCommit, sourceOid: entry.sourceOid, dirty: entry.dirty, dropped: entry.dropped },
            { result: 'allowed', liveCommit: f.a, sourceOid: f.b, dirty: false, dropped: [] });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('base guard treats an equal live base (watcher near no-op) as allowed', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.b });
        const live = stampedDir(f.root, 'dist', { commit: f.b });
        assert.doesNotThrow(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }));
        assert.equal(readPublishBaseGuardLog(f.root).at(-1).result, 'allowed');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('base guard refuses a divergent candidate, naming both OIDs and the dropped commits', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.c });
        const live = stampedDir(f.root, 'dist', { commit: f.b });
        assert.throws(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }),
            (error) => error.message.includes(f.b) && error.message.includes(f.c) && /not an ancestor/.test(error.message));
        const entry = readPublishBaseGuardLog(f.root).at(-1);
        assert.equal(entry.result, 'blocked');
        assert.deepEqual(entry.dropped, [f.b]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('base guard allows an empty/legacy dist with no provenance', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.b });
        const live = stampedDir(f.root, 'dist', null);
        assert.doesNotThrow(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }));
        const entry = readPublishBaseGuardLog(f.root).at(-1);
        assert.equal(entry.result, 'allowed'); assert.equal(entry.liveCommit, null);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('base guard fails closed on unparseable live provenance and audits it blocked', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.b });
        const live = stampedDir(f.root, 'dist', { commit: f.a });
        writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), '{not json');
        assert.throws(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }), /unparseable/);
        assert.equal(readPublishBaseGuardLog(f.root).at(-1).result, 'blocked');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('base guard fails closed when the live commit is absent from the repository', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.b });
        const live = stampedDir(f.root, 'dist', { commit: 'f'.repeat(40) });
        assert.throws(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }), /not present in the repository/);
        assert.equal(readPublishBaseGuardLog(f.root).at(-1).result, 'blocked');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('base guard allows a divergent candidate under --allow-non-main and records the override', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.c });
        const live = stampedDir(f.root, 'dist', { commit: f.b });
        assert.doesNotThrow(() => assertLivePublishBaseCurrent(staged, live, { root: f.root, allowNonMain: true }));
        const entry = readPublishBaseGuardLog(f.root).at(-1);
        assert.equal(entry.result, 'overridden'); assert.deepEqual(entry.dropped, [f.b]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('base guard allows a dirty live base without blocking and records dirty', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.c });
        const live = stampedDir(f.root, 'dist', { commit: f.b, dirty: true });
        assert.doesNotThrow(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }));
        const entry = readPublishBaseGuardLog(f.root).at(-1);
        assert.equal(entry.result, 'allowed'); assert.equal(entry.dirty, true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a failed audit of an allowed exchange warns and still permits it, never re-recording blocked', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.b });
        const live = stampedDir(f.root, 'dist', { commit: f.a }); // ancestor → allowed
        // Corrupt the ledger so the audit subprocess fails on every write.
        writeFileSync(previewControlPaths(f.root).ledger, JSON.stringify({ schemaVersion: 2 }));
        const decision = assertLivePublishBaseCurrent(staged, live, { root: f.root });
        assert.equal(decision.result, 'allowed');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a failed audit of a blocked exchange stays fail-closed', () => {
    const f = baseGuardFixture();
    try {
        const staged = stampedDir(f.root, 'staged', { commit: f.c });
        const live = stampedDir(f.root, 'dist', { commit: f.b }); // divergent → blocked
        writeFileSync(previewControlPaths(f.root).ledger, JSON.stringify({ schemaVersion: 2 }));
        assert.throws(() => assertLivePublishBaseCurrent(staged, live, { root: f.root }), /audit write failed|not an ancestor/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('promoteWithSmokeRollback enforces the base guard at the exchange chokepoint', { skip: !EXCHANGE_SUPPORTED }, async () => {
    const f = baseGuardFixture();
    try {
        const live = stampedDir(f.root, 'dist', { commit: f.b });
        writeFileSync(path.join(live, 'marker'), 'live-b');
        const divergent = stampedDir(f.root, 'staged-divergent', { commit: f.c });
        writeFileSync(path.join(divergent, 'marker'), 'candidate-c');
        await assert.rejects(() => promoteWithSmokeRollback(divergent, live, async () => {}, { root: f.root }), /not an ancestor/);
        assert.equal(readFileSync(path.join(live, 'marker'), 'utf8'), 'live-b', 'a blocked guard must not exchange');

        const ff = stampedDir(f.root, 'staged-ff', { commit: f.b });
        const liveA = stampedDir(f.root, 'dist-a', { commit: f.a });
        writeFileSync(path.join(ff, 'marker'), 'candidate-b');
        writeFileSync(path.join(liveA, 'marker'), 'live-a');
        await promoteWithSmokeRollback(ff, liveA, async () => {}, { root: f.root });
        assert.equal(readFileSync(path.join(liveA, 'marker'), 'utf8'), 'candidate-b', 'a fast-forward must exchange');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});
