import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    collectLifecycleScriptSources, compareTreeToClosure, computeShippedClosure, excludedFileFindings,
    excludedScriptReferenceFindings, listInstalledPackagePaths, loadExclusionPolicy, packageNameFromPath,
    platformMatches, targetPlatform,
} from './production-closure.mjs';
import { ReleaseManifestError } from './release-manifest-codes.mjs';
import { exclusionsDoc, put, scratchDir } from './release-license-gate.test.fixture.mjs';

const code = expected => error => error instanceof ReleaseManifestError && error.code === expected;
const exclusions = loadExclusionPolicy(exclusionsDoc());
const SRI = `sha512-${'A'.repeat(86)}==`;
/** Registry-pinned by default; a key present with `undefined` stays missing. */
const pinned = (lockPath, entry) => ({ integrity: SRI,
    resolved: `https://registry.npmjs.org/${packageNameFromPath(lockPath)}/-/x-${entry.version}.tgz`, ...entry });
const lockOf = packages => ({ lockfileVersion: 3, packages: { '': { name: 'app' },
    ...Object.fromEntries(Object.entries(packages).map(([key, entry]) => [key, pinned(key, entry)])) } });
const codes = list => list.map(item => `${item.code} ${item.subject}`);
const closureOf = packages => computeShippedClosure(lockOf(packages), { target: 'linux-x64-glibc', exclusions });

test('exclusion policy: valid document compiles, malformed ones are refused', () => {
    assert.equal(exclusions.isExcluded('@anthropic-ai/claude-agent-sdk-win32-x64'), true);
    assert.equal(exclusions.isListed('@anthropic-ai/claude-agent-sdk-win32-x64'), false);
    assert.equal(exclusions.isExcluded('@openai/codex-sdk'), false);
    assert.equal(exclusions.isExcluded('@anthropic-ai/sdk'), false);
    const bad = [
        { ...exclusionsDoc(), schema: 'other/v1' },
        { ...exclusionsDoc(), packages: [] },
        { ...exclusionsDoc(), extra: 1 },
        exclusionsDoc({ familyPatterns: [{ pattern: 'unanchored', reason: 'x' }] }),
        exclusionsDoc({ familyPatterns: [{ pattern: '^([a$', reason: 'x' }] }),
        exclusionsDoc({ packages: [{ name: 'left-pad', reason: 'no family covers it' }] }),
        exclusionsDoc({ packages: [{ name: 'Bad Name', reason: 'x' }] }),
    ];
    for (const document of bad) assert.throws(() => loadExclusionPolicy(document), code('license_policy_invalid'));
    const noFamilies = loadExclusionPolicy(exclusionsDoc({ familyPatterns: [], packages: [{ name: 'left-pad', reason: 'x' }] }));
    assert.equal(noFamilies.isExcluded('left-pad'), true);
});

test('targets and npm platform matching', () => {
    assert.deepEqual(targetPlatform('linux-arm64-glibc'), { os: 'linux', cpu: 'arm64', libc: 'glibc' });
    assert.throws(() => targetPlatform('darwin-x64'), code('lockfile_unsupported'));
    const x64 = targetPlatform('linux-x64-glibc');
    assert.equal(platformMatches({}, x64), true);
    assert.equal(platformMatches({ os: [] }, x64), true);
    assert.equal(platformMatches({ os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, x64), true);
    assert.equal(platformMatches({ libc: ['musl'] }, x64), false);
    assert.equal(platformMatches({ os: ['!win32'] }, x64), true);
    assert.equal(platformMatches({ cpu: ['!x64'] }, x64), false);
    assert.equal(platformMatches({ os: ['darwin', 'win32'] }, x64), false);
    assert.equal(packageNameFromPath('node_modules/a/node_modules/@s/b'), '@s/b');
    assert.equal(packageNameFromPath('packages/x'), 'packages/x');
});

test('closure = non-dev entries matching the target, minus exclusions', () => {
    const closure = closureOf({
        'node_modules/a': { version: '1.0.0', dependencies: { b: '1' } },
        'node_modules/b': { version: '1.0.0', peer: true },
        'node_modules/devonly': { version: '1.0.0', dev: true },
        'node_modules/dev-or-opt': { version: '1.0.0', devOptional: true },
        'node_modules/fsevents': { version: '2.0.0', optional: true, os: ['darwin'] },
        'node_modules/@esbuild/linux-x64': { version: '0.1.0', optional: true, os: ['linux'], cpu: ['x64'] },
        'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.0', license: 'SEE LICENSE IN README.md' },
        'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64': { version: '0.3.0', optional: true, os: ['linux'] },
        'node_modules/@openai/codex-linux-x64': { name: '@openai/codex', version: '0.1.0-linux-x64', optional: true },
        'node_modules/a/node_modules/c': { version: '2.0.0' },
    });
    assert.deepEqual(closure.shipped.map(pkg => pkg.path), [
        'node_modules/@esbuild/linux-x64', 'node_modules/a', 'node_modules/a/node_modules/c', 'node_modules/b',
        'node_modules/dev-or-opt',
    ]);
    assert.deepEqual(closure.excluded.map(pkg => pkg.installName), [
        '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-linux-x64', '@openai/codex-linux-x64',
    ]);
    assert.equal(closure.excluded[2].name, '@openai/codex', 'npm alias keeps its real name');
    assert.deepEqual(closure.skipped.map(pkg => pkg.path), ['node_modules/fsevents']);
    assert.deepEqual(closure.findings, []);
    assert.deepEqual(closure.warnings, []);
});

test('closure findings: unsupported, unlisted family, required exclusion, platform', () => {
    const closure = closureOf({
        'node_modules/linked': { version: '1.0.0', link: true },
        'packages/ws': { version: '1.0.0' },
        'node_modules/@anthropic-ai/claude-agent-sdk-sunos-x64': { version: '0.3.0', optional: true },
        'node_modules/hidden': { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.0' },
        'node_modules/needs-sdk': { version: '1.0.0', dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3' } },
        'node_modules/peer-sdk': { version: '1.0.0', peerDependencies: { '@anthropic-ai/claude-agent-sdk': '*' } },
        'node_modules/optional-peer': {
            version: '1.0.0',
            peerDependencies: { '@anthropic-ai/claude-agent-sdk': '*' },
            peerDependenciesMeta: { '@anthropic-ai/claude-agent-sdk': { optional: true } },
        },
        'node_modules/codex': { version: '1.0.0', optionalDependencies: { '@openai/codex-linux-x64': '1' } },
        'node_modules/win-only': { version: '1.0.0', os: ['win32'] },
    });
    assert.deepEqual(codes(closure.findings), [
        'excluded_family_unlisted node_modules/@anthropic-ai/claude-agent-sdk-sunos-x64',
        'excluded_family_unlisted node_modules/hidden',
        'lockfile_unsupported node_modules/linked',
        'platform_required_mismatch node_modules/win-only',
        'lockfile_unsupported packages/ws',
        'excluded_package_required node_modules/needs-sdk',
        'excluded_package_required node_modules/peer-sdk',
    ]);
    assert.deepEqual(codes(closure.warnings), [
        'exclusion_absent_from_lockfile @anthropic-ai/claude-agent-sdk',
        'exclusion_absent_from_lockfile @anthropic-ai/claude-agent-sdk-linux-x64',
        'exclusion_absent_from_lockfile @openai/codex-linux-x64',
    ]);
});

test('lockfile exit 11: every non-dev, non-link entry needs SRI integrity and a registry URL', () => {
    const closure = closureOf({
        'node_modules/no-integrity': { version: '1.0.0', integrity: undefined },
        'node_modules/bad-integrity': { version: '1.0.0', integrity: 'md5-abc' },
        'node_modules/git-dep': { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/r.git#abc' },
        'node_modules/mirror': { version: '1.0.0', resolved: 'https://registry.npmmirror.com/mirror/-/m.tgz' },
        'node_modules/lookalike': { version: '1.0.0', resolved: 'https://registry.npmjs.org.evil.test/x/-/x.tgz' },
        'node_modules/creds': { version: '1.0.0', resolved: 'https://u:p@registry.npmjs.org/creds/-/c.tgz' },
        'node_modules/http': { version: '1.0.0', resolved: 'http://registry.npmjs.org/http/-/h.tgz' },
        'node_modules/no-resolved': { version: '1.0.0', resolved: undefined },
        'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.0', integrity: undefined },
        'node_modules/opt-other-os': { version: '1.0.0', optional: true, os: ['darwin'], resolved: 'file:../x' },
        'node_modules/devonly': { version: '1.0.0', dev: true, integrity: undefined, resolved: 'file:../d' },
        'node_modules/linked': { version: '1.0.0', link: true, integrity: undefined, resolved: '../l' },
        'node_modules/multi': { version: '1.0.0', integrity: `sha1-AAAA ${SRI}` },
    });
    assert.deepEqual(codes(closure.findings), [
        'lockfile_integrity_missing node_modules/@anthropic-ai/claude-agent-sdk',
        'lockfile_integrity_missing node_modules/bad-integrity',
        'lockfile_resolved_off_registry node_modules/creds',
        'lockfile_resolved_off_registry node_modules/git-dep',
        'lockfile_resolved_off_registry node_modules/http',
        'lockfile_unsupported node_modules/linked',
        'lockfile_resolved_off_registry node_modules/lookalike',
        'lockfile_resolved_off_registry node_modules/mirror',
        'lockfile_integrity_missing node_modules/no-integrity',
        'lockfile_resolved_off_registry node_modules/no-resolved',
        'lockfile_resolved_off_registry node_modules/opt-other-os',
    ]);
});

test('the real package-lock.json passes the lockfile registry checks for every target', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'package-lock.json'), 'utf8'));
    for (const target of ['linux-x64-glibc', 'linux-arm64-glibc']) {
        const closure = computeShippedClosure(lock, { target, exclusions });
        const registry = closure.findings.filter(item => item.code.startsWith('lockfile_'));
        assert.deepEqual(registry, [], target);
        assert.ok(closure.shipped.length > 100, `${target} closure is the real one`);
    }
});

test('lockfile must be v2/v3 with packages', () => {
    for (const lock of [null, { lockfileVersion: 1, dependencies: {} }, { lockfileVersion: 3 }]) {
        assert.throws(() => computeShippedClosure(lock, { target: 'linux-x64-glibc', exclusions }), code('lockfile_unsupported'));
    }
});

test('installed tree is held to the closure', t => {
    const root = scratchDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    put(root, 'node_modules/a/package.json', {});
    put(root, 'node_modules/a/node_modules/@s/nested/package.json', {});
    put(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json', {});
    put(root, 'node_modules/stray/package.json', {});
    put(root, 'node_modules/.bin/tool', '');
    put(root, 'node_modules/.package-lock.json', '{}');
    fs.symlinkSync(path.join(root, 'node_modules/a'), path.join(root, 'node_modules/linked'));
    const paths = listInstalledPackagePaths(root);
    assert.deepEqual(paths, [
        'node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/a', 'node_modules/a/node_modules/@s/nested',
        'node_modules/linked', 'node_modules/stray',
    ]);
    const closure = closureOf({ 'node_modules/a': { version: '1' }, 'node_modules/a/node_modules/@s/nested': { version: '1' } });
    assert.deepEqual(codes(compareTreeToClosure(paths, closure, exclusions)), [
        'excluded_package_shipped node_modules/@anthropic-ai/claude-agent-sdk',
        'tree_package_unexpected node_modules/linked',
        'tree_package_unexpected node_modules/stray',
    ]);
    assert.deepEqual(listInstalledPackagePaths(path.join(root, 'missing')), []);
});

test('archive file lists: any excluded package dir at any depth is reported once', () => {
    const files = [
        'app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
        'app/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
        'app/node_modules/x/node_modules/@openai/codex-linux-x64/vendor/codex',
        'app/node_modules/@openai/codex-sdk/dist/index.js',
        'app/node_modules/@anthropic-ai/sdk/index.js',
        'app/node_modules/@scope',
        'node_modules/plain/index.js',
    ];
    assert.deepEqual(codes(excludedFileFindings(files, exclusions)), [
        'excluded_package_shipped app/node_modules/@anthropic-ai/claude-agent-sdk',
        'excluded_package_shipped app/node_modules/x/node_modules/@openai/codex-linux-x64',
    ]);
});

test('lifecycle scripts and the files they run must not name excluded packages', t => {
    const root = scratchDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    put(root, 'package.json', { scripts: {
        postinstall: 'node scripts/patch.mjs --apply && node scripts/clean.mjs && bash ../outside.sh && node scripts/missing.js',
        prepare: 'husky && node scripts/patch.mjs',
        build: 'node scripts/other.mjs',
    } });
    put(root, 'scripts/patch.mjs', "patch('@openai/codex-sdk'); rm('node_modules/@anthropic-ai/claude-agent-sdk-linux-x64.');\n");
    put(root, 'scripts/clean.mjs', "// touches @anthropic-ai/sdk only\n");
    put(root, 'scripts/other.mjs', "'@anthropic-ai/claude-agent-sdk'\n");
    const sources = collectLifecycleScriptSources(root);
    assert.deepEqual(sources.map(source => source.source), [
        'package.json#scripts.postinstall', 'scripts/patch.mjs', 'scripts/clean.mjs', 'package.json#scripts.prepare',
    ]);
    assert.deepEqual(excludedScriptReferenceFindings(sources, exclusions).map(item => item.detail),
        ['references excluded package @anthropic-ai/claude-agent-sdk-linux-x64']);
    assert.deepEqual(excludedScriptReferenceFindings([{ source: 'x', text: '@OpenAI/Codex-Win32-x64' }], exclusions)
        .map(item => item.code), ['excluded_reference_in_script']);
});
