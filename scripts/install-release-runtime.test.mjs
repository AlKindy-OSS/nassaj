import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { installLatestReleaseRuntime } from './install-release-runtime.mjs';
import { buildReleaseInstaller } from './build-release-installer.mjs';
import { RELEASE_RUNTIME_COMPATIBILITY } from './lib/release-runtime-compatibility.mjs';
import { RELEASE_ASSET_LIMITS, computeReleaseFileTreeSha256, currentReleaseRuntimeTarget, extractTarGzExact } from './lib/update-release-asset.mjs';

const temporary = () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'release-installer-'));
    chmodSync(root, 0o700);
    return root;
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const legacyUpdateTokenKey = ['NASSAJ', 'UPDATE', 'GITHUB', 'TOKEN'].join('_');
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function fixtureDatabaseContract(manifest) {
    const H = (character) => character.repeat(64);
    const releaseIdentitySha256 = sha(Buffer.from(canonical({ repo: manifest.repo, releaseId: manifest.releaseId,
        tag: manifest.tag, version: manifest.version, commit: manifest.commit, serverBuildId: manifest.serverBuildId,
        clientBuildId: manifest.clientBuildId, bundleBuildId: manifest.bundleBuildId })));
    return { schema: 'nassaj-database-release-contract/v1', releaseIdentitySha256, migrationEntrySha256: H('1'),
        migrationClosureSha256: H('2'), migrationClosure: { schema: 'nassaj-database-migration-closure/v2',
            assetManifestBound: true, sha256: H('2') }, targetSchemaDigest: H('3'), targetCompatibilityShapeDigest: H('4'),
        targetMigrationStateDigests: [H('5')], preservationPolicySha256: H('6'), acceptedPredecessors: [{ schemaDigest: H('7'),
            compatibilityShapeDigest: H('8'), allowedMigrationStateDigests: [H('9')] }], schemaVersion: 1,
        minimumReadableSchemaVersion: 1, previousReleasePolicy: 'restore_required', rehearsalRequired: true };
}

/**
 * Real releases ship a manifest that enumerates every file, so it is megabytes wide
 * (3.58 MiB at v1.46.0.6). Every fixture here published `files: []`, which is why the
 * installer shipped a 512 KiB cap on that download and rejected all of them.
 */
function paddedFiles(count) {
    return Array.from({ length: count }, (_, index) => ({
        path: `dist/assets/chunk-${String(index).padStart(6, '0')}.js`,
        size: 4096 + index, sha256: createHash('sha256').update(String(index)).digest('hex'), mode: 0o644,
    }));
}
function fixture(overrides = {}, { filePadding = 0, repository = 'AlKindy-OSS/nassaj' } = {}) {
    const runtimeBytes = Buffer.from('verified-runtime-archive');
    const runtimePackage = { path: 'node_modules/runtime-fixture', name: 'runtime-fixture', resolvedName: 'runtime-fixture',
        version: '1.0.0', integrity: 'sha512-YQ==', enginesNode: null, os: null, cpu: null, libc: null,
        native: false, packageJsonSha256: '9'.repeat(64) };
    const closureHash = createHash('sha256').update(runtimePackage.path).update('\0').update(runtimePackage.name).update('\0')
        .update(runtimePackage.resolvedName).update('\0').update(runtimePackage.version).update('\0').update(runtimePackage.integrity).update('\0')
        .update(JSON.stringify([null, null, null, null, false])).update('\0').update(runtimePackage.packageJsonSha256).update('\0').digest('hex');
    const manifest = {
        schemaVersion: 2, updaterProtocol: 2, repo: repository, releaseId: overrides.id ?? 91,
        tag: 'v1.46.0.0', version: '1.46.0.0', commit: 'b'.repeat(40),
        bundleBuildId: 'c'.repeat(64), bundleManifestSha256: 'd'.repeat(64),
        runtimeCompatibility: RELEASE_RUNTIME_COMPATIBILITY, sourceTreeSha256: computeReleaseFileTreeSha256(paddedFiles(filePadding)),
        targetRuntime: currentReleaseRuntimeTarget(),
        runtimeClosure: { schemaVersion: 1, packages: [runtimePackage], sha256: closureHash },
        serverBuildId: 'e'.repeat(64), clientBuildId: 'f'.repeat(64), files: paddedFiles(filePadding),
    };
    manifest.databaseContract = fixtureDatabaseContract(manifest);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const assets = [
        { id: 11, name: 'nassaj-runtime-v1.46.0.0.tar.gz', state: 'uploaded', size: runtimeBytes.length, digest: `sha256:${sha(runtimeBytes)}` },
        { id: 12, name: 'RELEASE_ASSET_MANIFEST.json', state: 'uploaded', size: manifestBytes.length, digest: `sha256:${sha(manifestBytes)}` },
    ];
    const release = { id: 91, draft: false, prerelease: false, tag_name: 'v1.46.0.0', assets, ...overrides };
    return { runtimeBytes, manifestBytes, release };
}

function dependencies(value, preparedIds) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url: String(url), headers: options.headers });
        if (String(url).endsWith('/releases/latest')) return Response.json(value.release);
        if (String(url).includes('/commits/')) return Response.json({ sha: 'b'.repeat(40) });
        if (String(url).includes('/releases/assets/11')) return new Response(null, { status: 302, headers: { location: 'https://objects.example/runtime' } });
        if (String(url).includes('/releases/assets/12')) return new Response(null, { status: 302, headers: { location: 'https://objects.example/manifest' } });
        if (String(url) === 'https://objects.example/runtime') return new Response(value.runtimeBytes);
        if (String(url) === 'https://objects.example/manifest') return new Response(value.manifestBytes);
        throw new Error(`unexpected URL ${url}`);
    };
    const prepare = (options) => {
        preparedIds.push(options.nodeInstanceId);
        assert.equal(readFileSync(options.assetFile, 'utf8'), value.runtimeBytes.toString());
        assert.equal(options.expected.assetId, 11); assert.equal(options.expected.commit, 'b'.repeat(40));
        return { state: 'prepared_not_activated', healthVerified: false, serviceActivated: false,
            launcher: '/deploy/launcher/nassaj-release-launcher.mjs', configFile: '/deploy/config/nassaj.env', dataRoot: '/deploy/data' };
    };
    return { fetchImpl, prepare, calls };
}

test('installer ignores legacy channel settings, pins OSS discovery, and reuses one node id', async () => {
    const root = temporary(); const ids = []; const value = fixture(); const deps = dependencies(value, ids);
    try {
        const env = { NASSAJ_RELEASE_CHANNEL: 'legacy', [legacyUpdateTokenKey]: 'stale-token', NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release' };
        const first = await installLatestReleaseRuntime({ deployRoot: path.join(root, 'deploy'), env }, deps);
        const second = await installLatestReleaseRuntime({ deployRoot: path.join(root, 'deploy'), env }, deps);
        assert.equal(first.state, 'prepared_not_activated'); assert.equal(first.activationRequired, true);
        assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
        assert.equal(readFileSync(first.nodeInstanceIdFile, 'utf8').trim(), ids[0]);
        assert.equal(readdirSync(path.join(root, 'deploy/control/staging')).length, 0);
        for (const call of deps.calls.filter((entry) => entry.url.startsWith('https://objects.example/'))) {
            assert.equal(call.headers.Authorization, undefined);
        }
        assert.equal(deps.calls.filter((entry) => entry.url.endsWith('/releases/latest')).length, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public installer needs no token, never sends Authorization, and preserves the OSS repository pin', async () => {
    const root = temporary(); const ids = []; const value = fixture({}, { repository: 'AlKindy-OSS/nassaj' }); const deps = dependencies(value, ids);
    try {
        const result = await installLatestReleaseRuntime({ deployRoot: path.join(root, 'deploy'), env: {
            [legacyUpdateTokenKey]: 'legacy-token-must-not-leak',
        } }, deps);
        assert.equal(result.state, 'prepared_not_activated');
        for (const call of deps.calls) assert.equal(call.headers.Authorization, undefined, call.url);
        assert.ok(deps.calls.some((call) => call.url.startsWith('https://api.github.com/repos/AlKindy-OSS/nassaj/')));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installer rejects a manifest bound to the legacy repository', async () => {
    const root = temporary(); const ids = []; const value = fixture({}, { repository: 'example/legacy-release' }); const deps = dependencies(value, ids);
    try {
        await assert.rejects(installLatestReleaseRuntime({ deployRoot: path.join(root, 'deploy'), env: {
            NASSAJ_RELEASE_CHANNEL: 'legacy', NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release',
        } }, deps), /repository|manifest/i);
        assert.equal(ids.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installer rejects draft, duplicate/swapped assets and missing digests before bootstrap', async () => {
    for (const releaseOverride of [
        { draft: true },
        { assets: [...fixture().release.assets, { ...fixture().release.assets[0], id: 99 }] },
        { assets: fixture().release.assets.map((asset, index) => index ? { ...asset, digest: null } : asset) },
    ]) {
        const root = temporary(); const value = fixture(releaseOverride); const ids = []; const deps = dependencies(value, ids);
        try {
            await assert.rejects(installLatestReleaseRuntime({ deployRoot: path.join(root, 'deploy'), env: {
                NASSAJ_RELEASE_CHANNEL: 'legacy', [legacyUpdateTokenKey]: 'stale-token', NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release',
            } }, deps), /stable release|absent or duplicated|identity is incomplete/);
            assert.equal(ids.length, 0);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});

test('installer implementation has no git, npm, service or process-manager execution path', () => {
    const source = readFileSync(new URL('./install-release-runtime.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)\b/);
    assert.doesNotMatch(source, /pm2|npm ci|git (?:pull|merge|reset)|safe-restart\.sh/);
});

test('OSS release export gate excludes legacy repository and update-token markers', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const exported = [
        'ops/nassaj-maintenance.service', 'scripts/install-release-runtime.mjs',
        'scripts/lib/update-release-asset.mjs', 'server/services/release-source-config.js',
        'server/services/release-discovery.js', 'server/services/source-updater.js',
    ];
    const forbidden = ['your-org', ['NASSAJ', 'UPDATE', 'GITHUB', 'TOKEN'].join('_')];
    for (const relative of exported) {
        const source = readFileSync(path.join(root, relative), 'utf8');
        for (const marker of forbidden) assert.equal(source.includes(marker), false, `${relative}: ${marker}`);
    }
    assert.match(readFileSync(path.join(root, 'ops/nassaj-maintenance.service'), 'utf8'), /Documentation=https:\/\/github\.com\/AlKindy-OSS\/nassaj/);
});

test('published installer bundle closes dependencies and runs a no-git fixture without node_modules', async () => {
    const root = temporary(); const output = path.join(root, 'output'); const extracted = path.join(root, 'extracted');
    try {
        const built = buildReleaseInstaller({ version: '1.46.0.0', commit: 'b'.repeat(40),
            outputDirectory: output, temporaryRoot: root });
        mkdirSync(extracted, { mode: 0o700 }); extractTarGzExact(readFileSync(built.asset), extracted);
        const manifest = JSON.parse(readFileSync(path.join(extracted, 'INSTALLER_BUNDLE_MANIFEST.json'), 'utf8'));
        assert.equal(manifest.schema, 'nassaj-installer-bundle/v1');
        for (const required of ['scripts/install-release-runtime.mjs', 'scripts/bootstrap-release-runtime.mjs',
            'scripts/nassaj-release-launcher.mjs', 'server/services/release-source-config.js',
            'scripts/nassaj-maintenance-responder.mjs', 'scripts/install-release-host-support.mjs',
            'scripts/release-runtime-gate-restore.mjs', 'ops/nassaj-maintenance.service',
            'ops/nassaj-cutover-gate-restore.service',
            'ops/systemd/cloudflared.service.d/20-nassaj-maintenance-order.conf',
            'ops/systemd/pm2-nassaj.service.d/20-nassaj-maintenance-order.conf']) {
            assert.ok(manifest.files.some((file) => file.path === required), required);
        }
        assert.equal(existsSync(path.join(extracted, 'node_modules')), false);
        assert.match(execFileSync(process.execPath, [path.join(extracted, 'scripts/install-release-runtime.mjs'), '--help'],
            { encoding: 'utf8' }), /--deploy-root/);
        const bundled = await import(`${pathToFileURL(path.join(extracted, 'scripts/install-release-runtime.mjs')).href}?test=${Date.now()}`);
        const value = fixture(); const ids = []; const deps = dependencies(value, ids);
        const result = await bundled.installLatestReleaseRuntime({ deployRoot: path.join(root, 'standalone-deploy'), env: {
            NASSAJ_RELEASE_CHANNEL: 'legacy', [legacyUpdateTokenKey]: 'stale-token', NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release',
        } }, deps);
        assert.equal(result.state, 'prepared_not_activated'); assert.equal(ids.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installer admits a real-sized detached manifest instead of capping it at the API payload limit', async () => {
    const root = temporary(); const ids = [];
    // 6000 entries pushes the manifest past the old 512 KiB ceiling while staying under
    // RELEASE_ASSET_LIMITS.files, so this exercises the published shape, not a stub.
    const value = fixture({}, { filePadding: 6000 });
    assert.ok(value.manifestBytes.length > 512 * 1024,
        `fixture manifest must exceed the old cap, got ${value.manifestBytes.length} bytes`);
    assert.ok(value.manifestBytes.length <= RELEASE_ASSET_LIMITS.manifestBytes);
    const deps = dependencies(value, ids);
    try {
        const env = { NASSAJ_RELEASE_CHANNEL: 'legacy', [legacyUpdateTokenKey]: 'stale-token', NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release' };
        const result = await installLatestReleaseRuntime({ deployRoot: path.join(root, 'deploy'), env }, deps);
        assert.equal(result.state, 'prepared_not_activated');
        assert.equal(result.serviceActivated, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the manifest ceiling still bounds the download rather than removing the limit', () => {
    assert.ok(RELEASE_ASSET_LIMITS.manifestBytes < RELEASE_ASSET_LIMITS.archiveBytes);
    // 20_000 files at a generous ~600 bytes per entry must still fit under the cap.
    assert.ok(RELEASE_ASSET_LIMITS.files * 600 < RELEASE_ASSET_LIMITS.manifestBytes);
});

test('fresh installer refuses an operator forward profile before discovery or filesystem writes', async () => {
    await assert.rejects(installLatestReleaseRuntime({ profile: 'forward' }, {
        fetch: () => { throw new Error('must not discover'); },
    }), /independently approved operator bootstrap/);
});

test('fresh installer rejects foreign populated roots and conflicting pinned resumes without changing files', async () => {
    const root = temporary(), deploy = path.join(root, 'deploy'); mkdirSync(deploy, { mode: 0o755 }); chmodSync(deploy, 0o755);
    const value = fixture(), deps = dependencies(value, []);
    try {
        mkdirSync(path.join(deploy, 'foreign-data'));
        await assert.rejects(installLatestReleaseRuntime({ deployRoot: deploy }, deps), /installer-owned fresh root/);
        assert.deepEqual(readdirSync(deploy), ['foreign-data']);
        rmSync(path.join(deploy, 'foreign-data'), { recursive: true });
        await installLatestReleaseRuntime({ deployRoot: deploy, env: {} }, deps);
        const modified = fixture({ id: 92 });
        await assert.rejects(installLatestReleaseRuntime({ deployRoot: deploy, env: {} }, dependencies(modified, [])), /resume identity conflicts/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prepare resumes exact identity after interruption before or after control creation', async () => {
    for (const hook of ['beforeControlCreation','afterControlCreation']) {
        const root=temporary(), deploy=path.join(root,'deploy'), value=fixture(), deps=dependencies(value,[]);
        try {
            await assert.rejects(installLatestReleaseRuntime({deployRoot:deploy,env:{}},{...deps,testHooks:{[hook](){throw new Error('simulated-crash');}}}),/simulated-crash/);
            assert.ok(existsSync(path.join(deploy,'initial-selection.json')));
            assert.equal((await installLatestReleaseRuntime({deployRoot:deploy,env:{}},deps)).state,'prepared_not_activated');
        } finally {rmSync(root,{recursive:true,force:true});}
    }
});

test('installer rejects FIFO, symlink and oversized control selection without reading', async () => {
    const root=temporary(),deploy=path.join(root,'deploy'),deps=dependencies(fixture(),[]);
    try {
        await installLatestReleaseRuntime({deployRoot:deploy,env:{}},deps);
        const file=path.join(deploy,'control','installer-selection.json'),original=readFileSync(file);
        for(const kind of ['fifo','symlink','oversized']) {
            unlinkSync(file);
            if(kind==='fifo') execFileSync('mkfifo',['-m','600',file]);
            if(kind==='symlink') symlinkSync('../initial-selection.json',file);
            if(kind==='oversized') writeFileSync(file,' '.repeat(65537),{mode:0o600});
            await assert.rejects(installLatestReleaseRuntime({deployRoot:deploy,env:{}},deps));
            unlinkSync(file);writeFileSync(file,original,{mode:0o600});
        }
    } finally {rmSync(root,{recursive:true,force:true});}
});
