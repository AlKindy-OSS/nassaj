import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
    BUILD_SCRIPT_PATH, buildReleaseGeneration, composeReleaseManifest, digestsText, externalPackagesFromLock,
    isMemoryBacked, parseArguments, placeholderInstallerText, resolveIdentity, sourceText,
} from './build-release-generation.mjs';
import { loadExclusionPolicy } from './lib/release-generation/production-closure.mjs';
import { parseReleaseManifest, serializeReleaseManifest } from './lib/release-generation/release-manifest.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXCLUSIONS = loadExclusionPolicy(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/release-excluded-packages.json'))));
const SRI = `sha512-${'A'.repeat(86)}==`;
const hex = character => character.repeat(64);

function lockFixture(overrides = {}) {
    return { packages: {
        '': { dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.283', '@openai/codex-sdk': '0.157.1', zod: '^3' } },
        'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.283', integrity: SRI,
            resolved: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.283.tgz' },
        'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64': { version: '0.3.283', integrity: SRI, optional: true,
            resolved: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/x-0.3.283.tgz' },
        'node_modules/@openai/codex-linux-x64': { version: '0.157.1', integrity: SRI,
            resolved: 'https://registry.npmjs.org/@openai/codex/-/codex-0.157.1-linux-x64.tgz' },
        ...overrides,
    } };
}

test('parseArguments applies defaults, refuses unknown flags and never defaults scratch into tmpfs', () => {
    const options = parseArguments(['--export-dir', 'e', '--output', 'o', '--local-gate', '--boot-smoke'], { TMPDIR: '/tmp' });
    assert.equal(options.target, 'linux-x64-glibc');
    assert.equal(options.scratchParent, '/var/tmp');
    assert.equal(options.nodeCache, '/var/tmp/nassaj-node-dist-cache');
    assert.equal(options.localGate && options.bootSmoke, true);
    assert.equal(parseArguments(['--export-dir', 'e', '--output', 'o'], { TMPDIR: '/srv/scratch' }).scratchParent, '/srv/scratch');
    assert.throws(() => parseArguments(['--export-dir', 'e']), /--output DIR are required/);
    assert.throws(() => parseArguments(['--export-dir', 'e', '--output', 'o', '--skip-gate']), /unknown or incomplete option/);
    assert.throws(() => parseArguments(['--export-dir']), /unknown or incomplete option/);
});

test('isMemoryBacked flags /tmp, /dev/shm and /run trees only', () => {
    assert.equal(isMemoryBacked('/tmp/x'), true);
    assert.equal(isMemoryBacked('/dev/shm'), true);
    assert.equal(isMemoryBacked('/run/user/1000'), true);
    assert.equal(isMemoryBacked('/var/tmp/x'), false);
    assert.equal(isMemoryBacked('/tmpfoo'), false);
});

test('a publishable build must name its identity; the local gate fills placeholders', () => {
    assert.throws(() => resolveIdentity({ channel: 'stable', workflowPath: 'w' }, '2.4.0.1'),
        /needs repository, repositoryId, releaseSequence, minUpgradeFrom, migrationClass/);
    const local = resolveIdentity({ localGate: true, channel: 'stable', workflowPath: 'w' }, '2.4.0.1');
    assert.deepEqual(local, { repository: 'local-gate/nassaj', repositoryId: '1', releaseSequence: 1,
        minUpgradeFrom: '2.4.0.1', migrationClass: 'none', channel: 'stable', workflowPath: 'w' });
    const explicit = resolveIdentity({ localGate: true, repository: 'o/r', repositoryId: '9', releaseSequence: '12',
        minUpgradeFrom: '2.4.0.0', migrationClass: 'compatible', channel: 'canary', workflowPath: 'w' }, '2.4.0.1');
    assert.equal(explicit.releaseSequence, 12);
    assert.equal(explicit.repository, 'o/r');
});

test('externalPackagesFromLock lists only direct excluded dependencies with registry pins', () => {
    assert.deepEqual(externalPackagesFromLock(lockFixture(), EXCLUSIONS), [{
        name: '@anthropic-ai/claude-agent-sdk', version: '0.3.283', integrity: SRI,
        tarballUrl: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.283.tgz',
        installPath: 'node_modules/@anthropic-ai/claude-agent-sdk',
    }]);
    const offRegistry = lockFixture({ 'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.283', integrity: SRI,
        resolved: 'https://mirror.example/sdk.tgz' } });
    assert.throws(() => externalPackagesFromLock(offRegistry, EXCLUSIONS), /external_package_unpinned/);
    const noIntegrity = lockFixture({ 'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.283',
        resolved: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.283.tgz' } });
    assert.throws(() => externalPackagesFromLock(noIntegrity, EXCLUSIONS), /external_package_unpinned/);
});

test('the composed manifest serializes canonically and parses back unchanged', () => {
    const manifest = composeReleaseManifest({
        version: '2.4.0.1', commit: 'a'.repeat(40), target: 'linux-x64-glibc', glibcFloor: '2.34',
        identity: resolveIdentity({ localGate: true, channel: 'stable', workflowPath: '.github/workflows/release-generation.yml' },
            '2.4.0.1'),
        node: { version: '24.18.1', sha256: hex('c') },
        archive: { name: 'nassaj-2.4.0.1-linux-x64-glibc.tar.gz', size: 1000, sha256: hex('d') },
        fileManifestSha256: hex('e'), installer: { name: 'nassaj-install.mjs', size: 10, sha256: hex('f') },
        externalPackages: externalPackagesFromLock(lockFixture(), EXCLUSIONS), trustedRootSha256: hex('1'),
        buildScriptSha256: hex('2'),
    });
    const bytes = serializeReleaseManifest(manifest);
    const parsed = parseReleaseManifest(new Uint8Array(bytes)).manifest;
    assert.equal(parsed.source.buildScript.path, BUILD_SCRIPT_PATH);
    assert.equal(parsed.source.ref, 'refs/tags/v2.4.0.1');
    assert.deepEqual(parsed.revokedVersions, []);
    assert.deepEqual(JSON.parse(bytes), manifest);
});

test('digests.txt is sha256sum-compatible and sorted by name', () => {
    assert.equal(digestsText([{ name: 'b', sha256: hex('b') }, { name: 'a', sha256: hex('a') }]),
        `${hex('a')}  a\n${hex('b')}  b\n`);
});

test('SOURCE names the public repository and exact commit', () => {
    const text = sourceText({ repository: 'o/r', commit: 'a'.repeat(40), version: '2.4.0.1' });
    assert.match(text, /AGPL-3\.0-only, section 6\(d\)/);
    assert.match(text, new RegExp(`https://github\\.com/o/r/tree/${'a'.repeat(40)}`));
});

test('the placeholder installer refuses to run', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'install.mjs'), placeholderInstallerText());
    const result = spawnSync(process.execPath, [path.join(dir, 'install.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installer_not_built/);
});

test('buildReleaseGeneration refuses a non-empty output and tmpfs work roots before doing any work', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-build-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, 'out', 'keep'), 'x');
    await assert.rejects(buildReleaseGeneration(parseArguments(['--export-dir', dir, '--output', path.join(dir, 'out')],
        { TMPDIR: '/var/tmp' })), /output_not_empty/);
    await assert.rejects(buildReleaseGeneration(parseArguments(['--export-dir', dir, '--output', path.join(dir, 'o2'),
        '--work-root', '/dev/shm/nassaj-x'], { TMPDIR: '/var/tmp' })), /memory_backed_path_refused/);
});
