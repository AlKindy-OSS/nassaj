import assert from 'node:assert/strict';
import test from 'node:test';
import {
    RELEASE_MANIFEST_MAX_BYTES, parseReleaseManifest, serializeReleaseManifest, validateReleaseManifest,
} from './release-manifest.mjs';
import { ReleaseManifestError } from './release-manifest-codes.mjs';
import { assertShape, canonicalJson, deepFreeze, isPlainObject, shape } from './strict-shape.mjs';
import { SRI, digest, manifestFixture } from './release-manifest.test.fixture.mjs';

const code = expected => error => error instanceof ReleaseManifestError && error.code === expected;
const bytesOf = text => Buffer.from(text, 'utf8');
const mutate = edit => { const value = structuredClone(manifestFixture()); edit(value); return value; };
const rejects = (value, expected) => assert.throws(() => validateReleaseManifest(value), code(expected));

test('a valid manifest round-trips through canonical bytes', () => {
    const bytes = serializeReleaseManifest(manifestFixture());
    const parsed = parseReleaseManifest(bytes);
    assert.deepEqual(parsed.manifest, manifestFixture());
    assert.equal(parsed.size, bytes.byteLength);
    assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(parsed.manifest.targets[0].archive));
    assert.equal(bytes.at(-1), 0x0a);
});

test('oversized manifest is refused before any parse (rule 0)', () => {
    const huge = Buffer.alloc(RELEASE_MANIFEST_MAX_BYTES + 1, 0x7b);
    assert.throws(() => parseReleaseManifest(huge), code('metadata_oversize'));
    const exact = serializeReleaseManifest(manifestFixture());
    assert.throws(() => parseReleaseManifest(exact, { maxBytes: exact.byteLength - 1 }), code('metadata_oversize'));
    assert.doesNotThrow(() => parseReleaseManifest(exact, { maxBytes: exact.byteLength }));
});

test('parse guard maps every malformed byte string to manifest_invalid', () => {
    const canonical = serializeReleaseManifest(manifestFixture()).toString('utf8');
    const cases = [
        Buffer.from([0xff, 0xfe, 0x7b]),
        bytesOf('{"schema":'),
        bytesOf(`${JSON.stringify(manifestFixture(), null, 2)}\n`),
        bytesOf(canonical.trimEnd()),
        bytesOf(`﻿${canonical}`),
        bytesOf(canonical.replace('{"channel":"stable"', '{"channel":"canary","channel":"stable"')),
        bytesOf(canonical.replace('"minShimVersion":1', '"minShimVersion":1.0')),
        bytesOf('[]\n'),
        bytesOf('null\n'),
        bytesOf('{"schema":"something-else/v1"}\n'),
    ];
    for (const bytes of cases) assert.throws(() => parseReleaseManifest(bytes), code('manifest_invalid'));
    assert.throws(() => parseReleaseManifest('not bytes'), TypeError);
});

test('a newer manifest schema is verifier_too_old, not a misparse (§5.2 b)', () => {
    const bytes = bytesOf(`${canonicalJson({ ...manifestFixture(), schema: 'nassaj-release-manifest/v2' })}\n`);
    assert.throws(() => parseReleaseManifest(bytes), code('verifier_too_old'));
});

test('unknown, missing and mistyped fields are refused', () => {
    rejects({ ...manifestFixture(), extra: true }, 'manifest_invalid');
    rejects(mutate(value => { delete value.installer; }), 'manifest_invalid');
    rejects(mutate(value => { value.source.extra = 'x'; }), 'manifest_invalid');
    rejects(mutate(value => { value.releaseSequence = '10'; }), 'manifest_invalid');
    rejects(mutate(value => { value.releaseSequence = 0; }), 'manifest_invalid');
    rejects(mutate(value => { value.releaseSequence = 1.5; }), 'manifest_invalid');
    rejects(mutate(value => { value.releaseSequence = Number.MAX_SAFE_INTEGER + 1; }), 'manifest_invalid');
    rejects(mutate(value => { value.minVerifierVersion = 1_000_001; }), 'manifest_invalid');
    rejects(mutate(value => { value.channel = 'beta'; }), 'manifest_invalid');
    rejects(mutate(value => { value.targets = {}; }), 'manifest_invalid');
    rejects(mutate(value => { value.source = []; }), 'manifest_invalid');
    rejects(mutate(value => { value.installer.name = ''; }), 'manifest_invalid');
    rejects(mutate(value => { value.source.repositoryId = 123456789; }), 'manifest_invalid');
    rejects('manifest', 'manifest_invalid');
});

test('format rules: versions, digests, commit, names, paths', () => {
    rejects(mutate(value => { value.version = '2.4.0'; value.source.ref = 'refs/tags/v2.4.0'; }), 'manifest_invalid');
    rejects(mutate(value => { value.version = '02.4.0.1'; value.source.ref = 'refs/tags/v02.4.0.1'; }), 'manifest_invalid');
    rejects(mutate(value => { value.installer.sha256 = 'F'.repeat(64); }), 'manifest_invalid');
    rejects(mutate(value => { value.source.commit = 'a'.repeat(39); }), 'manifest_invalid');
    rejects(mutate(value => { value.installer.name = '../nassaj-install.mjs'; }), 'manifest_invalid');
    rejects(mutate(value => { value.source.buildScript.path = 'scripts/../x.mjs'; }), 'manifest_invalid');
    rejects(mutate(value => { value.source.buildScript.path = '/abs/x.mjs'; }), 'manifest_invalid');
    rejects(mutate(value => { value.source.workflowPath = '.github/workflows/../x.yml'; }), 'manifest_invalid');
    rejects(mutate(value => { value.targets[0].target = 'linux-x64-musl'; }), 'manifest_invalid');
    rejects(mutate(value => { value.targets[0].glibcFloor = '2.x'; }), 'manifest_invalid');
    rejects(mutate(value => { value.externalPackages[0].integrity = 'sha256-abc'; }), 'manifest_invalid');
    rejects(mutate(value => { value.database.migrationClass = 'maybe'; }), 'manifest_invalid');
});

test('cross-field rules', () => {
    rejects(mutate(value => { value.source.ref = 'refs/tags/v9.9.9.9'; }), 'manifest_invalid');
    rejects(mutate(value => { value.source.ref = 'refs/heads/main'; }), 'manifest_invalid');
    rejects(mutate(value => { value.minUpgradeFrom = '2.4.0.2'; }), 'manifest_invalid');
    rejects(mutate(value => { value.revokedVersions = ['2.4.0.1']; }), 'manifest_invalid');
    rejects(mutate(value => { value.revokedVersions = ['2.3.0.1', '2.3.0.1']; }), 'manifest_invalid');
    rejects(mutate(value => { value.database.readableBy = ['2.4.0.0', '2.4.0.0']; }), 'manifest_invalid');
    rejects(mutate(value => { value.targets = []; }), 'manifest_invalid');
    rejects(mutate(value => { value.targets.push(structuredClone(value.targets[0])); }), 'manifest_invalid');
    rejects(mutate(value => { value.installer.name = value.targets[0].archive.name; }), 'manifest_invalid');
    rejects(mutate(value => { value.installer.name = 'release-manifest.json'; }), 'manifest_invalid');
    rejects(mutate(value => { value.installer.name = 'release-attestation.sigstore.json'; }), 'manifest_invalid');
    assert.doesNotThrow(() => validateReleaseManifest(mutate(value => { value.minUpgradeFrom = value.version; })));
});

test('external packages: npm registry only, by the package path (§6.2)', () => {
    const withUrl = url => mutate(value => { value.externalPackages[0].tarballUrl = url; });
    const good = 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.283.tgz';
    for (const url of [
        good.replace('https:', 'http:'),
        good.replace('registry.npmjs.org', 'registry.example.org'),
        good.replace('registry.npmjs.org', 'registry.npmjs.org:444'),
        good.replace('https://', 'https://user:pw@'),
        good.replace('registry.npmjs.org', 'REGISTRY.npmjs.org'),
        `${good}?x=1`,
        `${good}#frag`,
    ]) rejects(withUrl(url), 'external_package_host_refused');
    rejects(withUrl('https://registry.npmjs.org/other-pkg/-/other-pkg-1.0.0.tgz'), 'manifest_invalid');
    rejects(withUrl(good.replace('.tgz', '.zip')), 'manifest_invalid');
    rejects(mutate(value => { value.externalPackages[0].target = 'linux-arm64-glibc'; }), 'manifest_invalid');
    rejects(mutate(value => { value.externalPackages[0].installPath = 'lib/x'; }), 'manifest_invalid');
    rejects(mutate(value => { value.externalPackages.push(structuredClone(value.externalPackages[0])); }), 'manifest_invalid');
    const targeted = mutate(value => { value.externalPackages[0].target = 'linux-x64-glibc'; });
    assert.doesNotThrow(() => validateReleaseManifest(targeted));
    const both = mutate(value => { value.externalPackages.push({ ...value.externalPackages[0], target: 'linux-x64-glibc' }); });
    assert.doesNotThrow(() => validateReleaseManifest(both));
    assert.equal(SRI.length, 95);
});

test('strict-shape helpers', () => {
    assert.throws(() => assertShape({ kind: 'nope' }, 1, 'x', 'c'), TypeError);
    assert.doesNotThrow(() => assertShape(shape.nullable(shape.integer(0)), null, 'x', 'c'));
    assert.throws(() => assertShape(shape.nullable(shape.integer(0)), -1, 'x', 'c'), code('c'));
    assert.throws(() => assertShape(shape.string(/^a$/), 'b', 'x', 'c'), code('c'));
    assert.throws(() => assertShape(shape.array(shape.integer(0), { max: 1 }), [1, 2], 'x', 'c'), code('c'));
    assert.equal(isPlainObject(Object.create(null)), true);
    assert.equal(isPlainObject(new Date()), false);
    assert.equal(canonicalJson({ b: [1, { d: 1, c: 'x' }], a: null }), '{"a":null,"b":[1,{"c":"x","d":1}]}');
    assert.throws(() => canonicalJson({ a: undefined }), TypeError);
    assert.throws(() => canonicalJson(1n), TypeError);
    assert.equal(deepFreeze(1), 1);
    assert.equal(digest('a').length, 64);
});
