/** T-2024 S2 (ADR-207 §3.5, M8): identity key of a prestaged candidate. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    buildPrestageIdentityKey, canonicalJson, diffPrestageIdentity, probeNpmIdentity, probeRuntimeIdentity, resolveOnPath,
} from './update-prestage-identity.js';

const H = (c) => c.repeat(64);

function fields() {
    return {
        releaseCommit: 'b'.repeat(40),
        sourcePin: { repositoryUrl: 'https://github.com/AlKindy-OSS/nassaj.git', remote: 'origin', branch: 'main', tag: 'v1.42.0.1' },
        runtime: { version: 'v24.0.0', modules: '137', napi: '10', platform: 'linux', arch: 'x64',
            binary: { realpath: '/usr/bin/node', dev: 1, ino: 2, size: 3, mtimeMs: 4 } },
        npm: { realpath: '/usr/lib/node_modules/npm/bin/npm-cli.js', version: '11.0.0' },
        builderBuildId: H('e'),
        buildInputs: { candidateScriptSha256: H('1'), publicViteSha256: H('2'), buildEnvSha256: H('3'),
            packageLockBlob: 'f'.repeat(40), strategy: 'git-checkout-v2' },
    };
}

test('the child probe reports the interpreter on disk, with its binary identity', async () => {
    const runtime = await probeRuntimeIdentity();
    assert.equal(runtime.version, process.version);
    assert.equal(runtime.modules, process.versions.modules);
    assert.equal(runtime.platform, process.platform);
    assert.equal(runtime.binary.realpath, fs.realpathSync(process.execPath));
    assert.equal(runtime.binary.ino, fs.statSync(fs.realpathSync(process.execPath)).ino);
});

test('the child probe is a child: a different interpreter answer is what the key records', async () => {
    const run = async (file, args) => {
        assert.equal(file, process.execPath);
        assert.equal(args[0], '-e');
        return JSON.stringify({ version: 'v99.0.0', modules: '999', napi: '99', platform: 'linux', arch: 'x64' });
    };
    assert.equal((await probeRuntimeIdentity({ run })).version, 'v99.0.0');
    await assert.rejects(probeRuntimeIdentity({ run: async () => 'not json' }), { code: 'prestage_runtime_probe_failed' });
    await assert.rejects(probeRuntimeIdentity({ run: async () => '{"version":"v1"}' }), { code: 'prestage_runtime_probe_invalid' });
});

test('npm is resolved on the build PATH, by realpath and version', async (t) => {
    const directory = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestage-npm-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const npm = path.join(directory, 'npm');
    fs.writeFileSync(npm, '#!/bin/sh\necho 10.9.8\n', { mode: 0o755 });
    assert.equal(resolveOnPath('npm', `relative:${directory}`), npm);
    assert.deepEqual(await probeNpmIdentity({ env: { PATH: directory } }), { realpath: npm, version: '10.9.8' });
    await assert.rejects(probeNpmIdentity({ env: { PATH: '/nonexistent' } }), { code: 'prestage_npm_unavailable' });
});

test('the digest is order-independent and changes with every identity field', () => {
    const base = buildPrestageIdentityKey(fields());
    const reordered = fields();
    reordered.sourcePin = { tag: reordered.sourcePin.tag, branch: 'main', remote: 'origin', repositoryUrl: reordered.sourcePin.repositoryUrl };
    assert.equal(buildPrestageIdentityKey(reordered).digest, base.digest);
    const mutations = {
        releaseCommit: (f) => { f.releaseCommit = 'c'.repeat(40); },
        sourcePin: (f) => { f.sourcePin.tag = 'v1.42.0.2'; },
        runtime: (f) => { f.runtime.binary.ino = 99; },
        npm: (f) => { f.npm.version = '11.0.1'; },
        builderBuildId: (f) => { f.builderBuildId = H('d'); },
        buildInputs: (f) => { f.buildInputs.packageLockBlob = 'a'.repeat(40); },
    };
    for (const [field, mutate] of Object.entries(mutations)) {
        const changed = fields();
        mutate(changed);
        const next = buildPrestageIdentityKey(changed);
        assert.notEqual(next.digest, base.digest, field);
        assert.deepEqual(diffPrestageIdentity(base.key, next.key), [field]);
    }
});

test('invalid identity fields are refused, by name', () => {
    const cases = {
        releaseCommit: (f) => { f.releaseCommit = 'short'; },
        sourcePin: (f) => { delete f.sourcePin.tag; },
        runtime: (f) => { f.runtime.binary = null; },
        npm: (f) => { f.npm = {}; },
        builderBuildId: (f) => { f.builderBuildId = ''; },
        buildInputs: (f) => { f.buildInputs.buildEnvSha256 = 'x'; },
    };
    for (const [field, mutate] of Object.entries(cases)) {
        const broken = fields();
        mutate(broken);
        assert.throws(() => buildPrestageIdentityKey(broken), (error) => error.code === 'prestage_identity_invalid' && error.field === field);
    }
    assert.equal(canonicalJson({ b: [2, { d: 1, c: 0 }], a: null }), '{"a":null,"b":[2,{"c":0,"d":1}]}');
});
