import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
    SERVED_CLIENT_GENERATIONS, assertRipgrepPin, buildEnvironment, copyNativeArtifacts, gitEnvironment, prepareBuildTree,
    removeExcludedPackages, seedServedClientGeneration,
} from './generation-build-steps.mjs';
import { createClientAssetManifest, verifyAssetClosure } from '../client-publication-artifacts.mjs';
import { readArchivedClientAsset } from '../../../server/services/client-publication-static.js';
import { loadExclusionPolicy } from './production-closure.mjs';

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-steps-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

const EXCLUSIONS = loadExclusionPolicy({
    schema: 'nassaj-release-exclusions/v1',
    packages: [{ name: '@anthropic-ai/claude-agent-sdk', reason: 'proprietary' },
        { name: '@openai/codex-linux-x64', reason: 'binary' }],
    familyPatterns: [{ pattern: '^@anthropic-ai/claude-agent-sdk(-[a-z0-9-]+)?$', reason: 'family' },
        { pattern: '^@openai/codex-(?!sdk$)[a-z0-9-]+$', reason: 'family' }],
});

const ENV_INPUT = { nodeDir: '/opt/node', tmpDir: '/var/tmp/w', npmUserConfig: '/var/tmp/w/npmrc', sourceDateEpoch: 1700000000 };

test('the build environment drops update/npm/node/git overrides and puts the bundled Node first', () => {
    const env = buildEnvironment({ PATH: '/usr/bin', HOME: '/h', NASSAJ_UPDATE_MODE: 'local-main', NODE_ENV: 'production',
        npm_config_registry: 'https://evil.example', NODE_OPTIONS: '--require x', DATABASE_PATH: '/live.db',
        NPM_CONFIG_USERCONFIG: '/operator/.npmrc', GIT_DIR: '/live/.git', GIT_WORK_TREE: '/live', GIT_INDEX_FILE: '/i',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/x', GIT_CONFIG_PARAMETERS: "'a'",
        GIT_AUTHOR_NAME: 'kept', SOURCE_DATE_EPOCH: '1' }, ENV_INPUT);
    assert.deepEqual(env, { HOME: '/h', GIT_AUTHOR_NAME: 'kept', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        PATH: '/opt/node/bin:/usr/bin', TMPDIR: '/var/tmp/w', HUSKY: '0', NPM_CONFIG_USERCONFIG: '/var/tmp/w/npmrc',
        SOURCE_DATE_EPOCH: '1700000000' });
    assert.throws(() => buildEnvironment({}, { ...ENV_INPUT, npmUserConfig: '' }), /npmUserConfig/);
    assert.throws(() => buildEnvironment({}, { ...ENV_INPUT, sourceDateEpoch: -1 }), /sourceDateEpoch/);
});

test('a caller GIT_DIR/GIT_WORK_TREE never redirects the build tree git', t => {
    const dir = scratch(t);
    write(path.join(dir, 'export', 'package.json'), '{"version":"2.4.0.1"}');
    fs.mkdirSync(path.join(dir, 'decoy'));
    const decoy = path.join(dir, 'decoy', '.git');
    const base = { ...process.env, GIT_DIR: decoy, GIT_WORK_TREE: path.join(dir, 'decoy'), GIT_INDEX_FILE: decoy };
    assert.equal(gitEnvironment(base).GIT_DIR, undefined);
    const tree = prepareBuildTree(path.join(dir, 'export'), path.join(dir, 'one'), base);
    assert.match(tree.commit, /^[0-9a-f]{40}$/);
    assert.equal(fs.existsSync(decoy), false, 'git wrote nothing to the decoy repository');
    assert.equal(fs.existsSync(path.join(dir, 'one', '.git')), true);
});

test('an export without git gets the same synthesized commit every time', t => {
    const dir = scratch(t);
    write(path.join(dir, 'export', 'package.json'), '{"version":"2.4.0.1"}');
    write(path.join(dir, 'export', 'src', 'a.js'), 'a');
    const one = prepareBuildTree(path.join(dir, 'export'), path.join(dir, 'one'));
    const two = prepareBuildTree(path.join(dir, 'export'), path.join(dir, 'two'));
    assert.equal(one.synthesized, true);
    assert.match(one.commit, /^[0-9a-f]{40}$/);
    assert.equal(one.commit, two.commit);
    assert.equal(one.commitTime, 0, 'the synthesized commit date is the epoch (SOURCE_DATE_EPOCH)');
    assert.equal(fs.existsSync(path.join(dir, 'export', '.git')), false, 'the export tree itself is never modified');
});

test('excluded packages are removed by install path (aliases included) with every .bin farm', t => {
    const dir = scratch(t);
    const modules = path.join(dir, 'node_modules');
    write(path.join(modules, '@anthropic-ai/claude-agent-sdk/package.json'), '{"name":"@anthropic-ai/claude-agent-sdk"}');
    write(path.join(modules, '@anthropic-ai/claude-agent-sdk-linux-x64/package.json'), '{"name":"x"}');
    write(path.join(modules, '@openai/codex-linux-x64/package.json'), '{"name":"@openai/codex"}');
    write(path.join(modules, '@openai/codex-sdk/package.json'), '{"name":"@openai/codex-sdk"}');
    write(path.join(modules, '.bin/tool'), '');
    write(path.join(modules, 'a/node_modules/.bin/tool'), '');
    write(path.join(modules, 'a/package.json'), '{"name":"a"}');
    const removed = removeExcludedPackages(dir, EXCLUSIONS);
    assert.deepEqual(removed.sort(), ['node_modules/@anthropic-ai/claude-agent-sdk',
        'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', 'node_modules/@openai/codex-linux-x64']);
    assert.equal(fs.existsSync(path.join(modules, '@openai/codex-sdk/package.json')), true);
    assert.equal(fs.existsSync(path.join(modules, '.bin')), false);
    assert.equal(fs.existsSync(path.join(modules, 'a/node_modules/.bin')), false);
});

function nativeTree(root, version, rg = 'rg-binary') {
    write(path.join(root, 'node_modules/better-sqlite3/package.json'), JSON.stringify({ version }));
    write(path.join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'addon');
    write(path.join(root, 'node_modules/@vscode/ripgrep/package.json'), JSON.stringify({ version: '1.17.1' }));
    write(path.join(root, 'node_modules/@vscode/ripgrep/bin/rg'), rg);
}

test('native artifacts copy only between equal package versions and keep the ripgrep pin', t => {
    const dir = scratch(t);
    const pin = { file: 'bin/rg', sha256: createHash('sha256').update('rg-binary').digest('hex') };
    nativeTree(path.join(dir, 'build'), '12.6.2');
    write(path.join(dir, 'prod/node_modules/better-sqlite3/package.json'), JSON.stringify({ version: '12.6.2' }));
    write(path.join(dir, 'prod/node_modules/@vscode/ripgrep/package.json'), JSON.stringify({ version: '1.17.1' }));
    copyNativeArtifacts(path.join(dir, 'build'), path.join(dir, 'prod'), pin);
    const rg = path.join(dir, 'prod/node_modules/@vscode/ripgrep/bin/rg');
    assert.equal(fs.statSync(rg).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(path.join(dir, 'prod/node_modules/better-sqlite3/build/Release/better_sqlite3.node'), 'utf8'),
        'addon');
    write(path.join(dir, 'other/node_modules/better-sqlite3/package.json'), JSON.stringify({ version: '11.0.0' }));
    write(path.join(dir, 'other/node_modules/@vscode/ripgrep/package.json'), JSON.stringify({ version: '1.17.1' }));
    assert.throws(() => copyNativeArtifacts(path.join(dir, 'build'), path.join(dir, 'other'), pin),
        /native_artifact_version_mismatch: better-sqlite3/);
});

test('a ripgrep binary that differs from the committed sha256 fails the build', t => {
    const dir = scratch(t);
    nativeTree(dir, '12.6.2', 'tampered');
    assert.throws(() => assertRipgrepPin(dir, { file: 'bin/rg', sha256: '0'.repeat(64) }), /ripgrep_digest_mismatch/);
});

test('the served client archive is seeded from the sealed dist and readable by the server', t => {
    const root = fs.realpathSync(scratch(t));
    const dist = path.join(root, 'dist');
    const identity = { generationId: '7'.repeat(64), buildId: 'b'.repeat(64), sourceOid: 'c'.repeat(40) };
    write(path.join(dist, 'index.html'),
        `<script type="module" src="/assets/generations/${identity.generationId}/assets/app.js"></script>`);
    write(path.join(dist, 'assets', 'app.js'), 'console.log(1);\n');
    write(path.join(dist, 'BUILD_PROVENANCE.json'), JSON.stringify({ generationId: identity.generationId }));
    createClientAssetManifest(dist, identity, verifyAssetClosure);
    const seeded = seedServedClientGeneration(root, { sourceOid: identity.sourceOid, buildId: identity.buildId });
    assert.equal(seeded.generationId, identity.generationId);
    assert.equal(seeded.destination, path.join(root, SERVED_CLIENT_GENERATIONS, identity.generationId));
    const asset = readArchivedClientAsset(root, identity.generationId, 'assets/app.js');
    assert.equal(asset.bytes.toString(), 'console.log(1);\n');
    assert.equal(fs.statSync(path.join(seeded.destination, 'assets', 'app.js')).nlink, 1);
    assert.deepEqual(seedServedClientGeneration(root, identity), seeded, 'idempotent');
    assert.throws(() => seedServedClientGeneration(root, { ...identity, buildId: 'd'.repeat(64) }),
        /client_asset_manifest_identity_mismatch/);
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'tampered');
    fs.rmSync(path.join(root, SERVED_CLIENT_GENERATIONS), { recursive: true });
    assert.throws(() => seedServedClientGeneration(root, identity));
});
