// Offline tests for the release-generation workflow helpers (ADR-174 §9.2):
// plan, published-generation discovery, trusted-root fetch/recheck (M4),
// self-check and fleet simulation (H2). Network, git, TUF and child processes
// are injected fakes; no test touches GitHub, nodejs.org or Sigstore.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateTrustPolicy } from '../lib/release-generation/attestation-verifier.mjs';
import { bundleVerifier } from '../lib/release-generation/generation-build-steps.mjs';
import { serializeReleaseManifest } from '../lib/release-generation/release-manifest.mjs';
import { canonicalJson } from '../lib/release-generation/strict-shape.mjs';
import { digest, manifestFixture } from '../lib/release-generation/release-manifest.test.fixture.mjs';
import {
    assertNewerThanPublished, assertTagShape, outputLines, parsePlanArguments, planFromPackage, runPlan,
} from './plan-release.mjs';
import {
    assetUrl, fetchBytes, highestSequence, latestPerChannel, listPublishedGenerations, loadIdentity,
} from './published-generations.mjs';
import {
    canonicalRootText, compareRoots, keyIdDiff, loadSigstore, parseRootArguments, runTrustedRoot,
} from './trusted-root.mjs';
import {
    checkPreviousAssets, classifyFleetResult, findBundle, fleetDecisionArguments, fleetSimulation, parseDigests,
    parseVerifyArguments, policyFor, selfCheck,
} from './verify-generation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const IDENTITY = loadIdentity();
const REPO = IDENTITY.repository;

function tempDir() {
    return mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-release-workflow-'));
}

/** Minimal fetch fake: a map from URL to body (string/Buffer/object) or status number. */
function fakeFetch(routes, seen = []) {
    return async (url, init) => {
        seen.push({ url, init });
        const body = routes[url];
        if (body === undefined || typeof body === 'number') {
            return { ok: false, status: body ?? 404, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength) };
    };
}

const listUrl = page => `https://api.github.com/repos/${REPO}/releases?per_page=30&page=${page}`;
const release = (tag, names, draft = false) => ({ tag_name: tag, draft,
    assets: names.map(name => ({ name, browser_download_url: `x/${name}` })) });

// ---------------------------------------------------------------- discovery

test('identity pin: the committed file is valid and a tampered one is refused', () => {
    assert.equal(IDENTITY.repositoryId, '1373279714');
    assert.equal(IDENTITY.workflowPath, '.github/workflows/release-generation.yml');
    const dir = tempDir();
    try {
        const file = path.join(dir, 'identity.json');
        writeFileSync(file, JSON.stringify({ ...IDENTITY, repositoryId: 'abc' }));
        assert.throws(() => loadIdentity(file), /identity_invalid/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assetUrl derives the GitHub download URL and encodes names', () => {
    assert.equal(assetUrl('o/r', 'v1.2.3.4', 'a b.json'), 'https://github.com/o/r/releases/download/v1.2.3.4/a%20b.json');
});

test('fetchBytes sends the token and refuses a non-2xx answer', async () => {
    const seen = [];
    const fetchImpl = fakeFetch({ 'u://ok': 'body' }, seen);
    assert.equal((await fetchBytes(fetchImpl, 'u://ok', { token: 't' })).toString(), 'body');
    assert.equal(seen[0].init.headers.authorization, 'Bearer t');
    await assert.rejects(() => fetchBytes(fetchImpl, 'u://missing'), /download_failed: 404/);
});

function publishedRoutes() {
    const stable = serializeReleaseManifest(manifestFixture({ version: '2.4.0.1', releaseSequence: 10 }));
    const olderStable = serializeReleaseManifest(manifestFixture({ version: '2.4.0.0', releaseSequence: 9,
        minUpgradeFrom: '2.4.0.0' }));
    const canary = serializeReleaseManifest(manifestFixture({ version: '2.4.0.2', releaseSequence: 12,
        channel: 'canary' }));
    return {
        [listUrl(1)]: [release('v2.4.0.2', ['release-manifest.json']), release('v2.4.0.9', ['release-manifest.json'], true),
            release('v2.3.0.9', ['nassaj.tar.gz']), release('v2.4.0.1', ['release-manifest.json']),
            release('v2.4.0.0', ['release-manifest.json'])],
        [assetUrl(REPO, 'v2.4.0.2', 'release-manifest.json')]: canary,
        [assetUrl(REPO, 'v2.4.0.1', 'release-manifest.json')]: stable,
        [assetUrl(REPO, 'v2.4.0.0', 'release-manifest.json')]: olderStable,
    };
}

test('listPublishedGenerations skips drafts and manifest-less releases; latest per channel by sequence', async () => {
    const generations = await listPublishedGenerations({ repository: REPO, fetchImpl: fakeFetch(publishedRoutes()),
        pages: 2 });
    assert.deepEqual(generations.map(g => g.tag), ['v2.4.0.2', 'v2.4.0.1', 'v2.4.0.0']);
    const latest = latestPerChannel(generations, 'v9.9.9.9');
    assert.equal(latest.get('stable').tag, 'v2.4.0.1');
    assert.equal(latest.get('canary').tag, 'v2.4.0.2');
    assert.equal(latestPerChannel(generations, 'v2.4.0.2').has('canary'), false);
    assert.equal(highestSequence(generations), 12);
    assert.equal(highestSequence([]), 0);
});

test('listPublishedGenerations refuses an invalid manifest and a non-list answer', async () => {
    const routes = { [listUrl(1)]: [release('v1.0.0.0', ['release-manifest.json'])],
        [assetUrl(REPO, 'v1.0.0.0', 'release-manifest.json')]: '{"schema":"x"}\n' };
    await assert.rejects(() => listPublishedGenerations({ repository: REPO, fetchImpl: fakeFetch(routes) }));
    await assert.rejects(() => listPublishedGenerations({ repository: REPO,
        fetchImpl: fakeFetch({ [listUrl(1)]: { message: 'x' } }) }), /release_list_invalid/);
});

// --------------------------------------------------------------------- plan

const PKG = { version: '2.4.0.3', releaseGeneration: { channel: 'stable', releaseSequence: 13,
    minUpgradeFrom: '2.4.0.0', migrationClass: 'none' } };

test('plan arguments: required flags and unknown flags', () => {
    const options = parsePlanArguments(['--tag', 'v1', '--commit', 'c', '--repository', 'o/r', '--github-output', 'f']);
    assert.equal(options.githubOutput, 'f');
    assert.throws(() => parsePlanArguments(['--tag', 'v1']), /--commit is required/);
    assert.throws(() => parsePlanArguments(['--nope', 'x']), /unknown or incomplete/);
});

test('planFromPackage accepts the committed fields and refuses each malformed one', () => {
    assert.deepEqual(planFromPackage(PKG, 'v2.4.0.3'), { version: '2.4.0.3', ...PKG.releaseGeneration });
    const bad = (pkg, tag, code) => assert.throws(() => planFromPackage(pkg, tag), new RegExp(code));
    bad({ ...PKG, version: '2.4' }, 'v2.4', 'release_version_invalid');
    bad(PKG, 'v2.4.0.4', 'release_tag_mismatch');
    bad({ version: '2.4.0.3' }, 'v2.4.0.3', 'release_fields_missing');
    const field = (key, value) => ({ ...PKG, releaseGeneration: { ...PKG.releaseGeneration, [key]: value } });
    bad(field('channel', 'beta'), 'v2.4.0.3', 'channel');
    bad(field('releaseSequence', 0), 'v2.4.0.3', 'releaseSequence');
    bad(field('releaseSequence', '13'), 'v2.4.0.3', 'releaseSequence');
    bad(field('minUpgradeFrom', '2.4.0.4'), 'v2.4.0.3', 'minUpgradeFrom');
    bad(field('migrationClass', 'maybe'), 'v2.4.0.3', 'migrationClass');
});

test('assertNewerThanPublished: sequence above all channels, version above the same channel', () => {
    const generations = [{ tag: 'v2.4.0.1', manifest: { channel: 'stable', version: '2.4.0.1', releaseSequence: 10 } },
        { tag: 'v2.4.0.2', manifest: { channel: 'canary', version: '2.4.0.2', releaseSequence: 12 } }];
    const plan = planFromPackage(PKG, 'v2.4.0.3');
    assert.doesNotThrow(() => assertNewerThanPublished(plan, generations, 'v2.4.0.3'));
    assert.throws(() => assertNewerThanPublished({ ...plan, releaseSequence: 12 }, generations, 'v2.4.0.3'),
        /release_sequence_not_greater: 12 <= published 12/);
    assert.throws(() => assertNewerThanPublished({ ...plan, version: '2.4.0.0' }, generations, 'v2.4.0.0'),
        /release_version_not_newer/);
    const rerun = [...generations, { tag: 'v2.4.0.3', manifest: { channel: 'stable', version: '2.4.0.3',
        releaseSequence: 13 } }];
    assert.doesNotThrow(() => assertNewerThanPublished(plan, rerun, 'v2.4.0.3'));
});

test('assertTagShape: annotated, peels to the run commit, on main', () => {
    const git = answers => (root, args) => {
        const key = args[0];
        if (answers[key] instanceof Error) throw answers[key];
        return answers[key];
    };
    const good = { 'cat-file': 'tag', 'rev-parse': 'c'.repeat(40), 'merge-base': '' };
    assert.doesNotThrow(() => assertTagShape('.', 'v1', 'c'.repeat(40), git(good)));
    assert.throws(() => assertTagShape('.', 'v1', 'c'.repeat(40), git({ ...good, 'cat-file': 'commit' })),
        /release_tag_not_annotated/);
    assert.throws(() => assertTagShape('.', 'v1', 'd'.repeat(40), git(good)), /release_tag_commit_mismatch/);
    assert.throws(() => assertTagShape('.', 'v1', 'c'.repeat(40), git({ ...good, 'merge-base': new Error('git_failed') })),
        /git_failed/);
});

test('runPlan writes validated job outputs', async () => {
    const dir = tempDir();
    try {
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify(PKG));
        const output = path.join(dir, 'out');
        const plan = await runPlan({ root: dir, tag: 'v2.4.0.3', commit: 'c'.repeat(40), repository: REPO,
            githubOutput: output }, { fetchImpl: fakeFetch(publishedRoutes()), token: 't',
            runGit: (root, args) => ({ 'cat-file': 'tag', 'rev-parse': 'c'.repeat(40) }[args[0]] ?? '') });
        assert.equal(plan.releaseSequence, 13);
        assert.equal(readFileSync(output, 'utf8'), outputLines(plan));
        assert.match(outputLines(plan), /^version=2\.4\.0\.3\nchannel=stable\nrelease-sequence=13\n/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------- trusted root

const codec = { toJSON: message => message };
const ROOT_A = { tlogs: [{ baseUrl: 'https://rekor.sigstore.dev', logId: { keyId: 'k1' } }],
    ctlogs: [{ baseUrl: 'ct', logId: { keyId: 'c1' } }],
    certificateAuthorities: [{ uri: 'fulcio', validFor: { start: 's1' } }], timestampAuthorities: [] };
const ROOT_B = { ...ROOT_A, tlogs: [...ROOT_A.tlogs, { baseUrl: 'https://log2025-1', logId: { keyId: 'k2' } }],
    timestampAuthorities: [{ uri: 'tsa', validFor: { start: 't1' } }], ctlogs: [] };

test('loadSigstore: injected exports load; missing or unexpected packages fail closed', async () => {
    const tools = await loadSigstore(async name => (name === '@sigstore/tuf' ? { getTrustedRoot: () => ROOT_A }
        : { default: { TrustedRoot: codec } }));
    assert.equal(typeof tools.getTrustedRoot, 'function');
    await assert.rejects(() => loadSigstore(async () => { throw Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }); }),
        /sigstore_tuf_unavailable: ERR_MODULE_NOT_FOUND/);
    await assert.rejects(() => loadSigstore(async () => ({})), /unexpected exports/);
});

test('loadSigstore without injection: resolves only when @sigstore/tuf is installed (TODO §7.9)', async () => {
    try {
        await loadSigstore();
    } catch (error) {
        assert.match(error.message, /^sigstore_tuf_unavailable/);
    }
});

test('canonical text, key-id diff and the M4 three-way comparison', () => {
    assert.equal(canonicalRootText(ROOT_A, codec), JSON.stringify(ROOT_A, null, 1));
    const diff = keyIdDiff(ROOT_A, ROOT_B);
    assert.match(diff[0], /^tlogs: 2 \(added 1 \+https:\/\/log2025-1 k2; removed 0\)/);
    assert.match(diff[1], /^ctlogs: 0 \(added 0; removed 1 -ct c1\)/);
    assert.match(diff[3], /^tsas: 1 \(added 1/);
    assert.deepEqual(keyIdDiff({}, {}).length, 4);
    const text = JSON.stringify(ROOT_A, null, 1);
    const good = sha256(Buffer.from(text));
    assert.deepEqual(compareRoots({ freshText: text, shippedBytes: Buffer.from(text), manifestSha256: good }), []);
    assert.equal(compareRoots({ freshText: `${text} `, shippedBytes: Buffer.from(text), manifestSha256: good }).length, 1);
    assert.equal(compareRoots({ freshText: text, shippedBytes: Buffer.from('x'), manifestSha256: good }).length, 1);
    assert.equal(compareRoots({ freshText: text, shippedBytes: Buffer.from(text), manifestSha256: undefined }).length, 3);
});

test('trusted-root arguments', () => {
    assert.deepEqual(parseRootArguments(['fetch', '--out', 'o', '--cache', 'c']), { command: 'fetch', out: 'o', cache: 'c' });
    assert.throws(() => parseRootArguments(['pull']), /usage/);
    assert.throws(() => parseRootArguments(['fetch', '--out', 'o']), /fetch needs --cache/);
    assert.throws(() => parseRootArguments(['recheck', '--bogus', 'x']), /unknown or incomplete/);
});

test('runTrustedRoot: fetch writes the canonical root; recheck compares and logs diffs', async () => {
    const dir = tempDir();
    try {
        const sigstore = { getTrustedRoot: async () => ROOT_B, TrustedRoot: codec };
        const log = [];
        const out = path.join(dir, 'trusted_root.json');
        await runTrustedRoot({ command: 'fetch', out, cache: dir }, { sigstore, log: line => log.push(line) });
        const text = readFileSync(out, 'utf8');
        assert.equal(text, JSON.stringify(ROOT_B, null, 1));
        const manifest = path.join(dir, 'manifest.json');
        writeFileSync(manifest, JSON.stringify({ sigstoreTrustedRootSha256: sha256(Buffer.from(text)) }));
        await runTrustedRoot({ command: 'recheck', manifest, shipped: out, cache: dir }, { sigstore,
            log: line => log.push(line) });
        assert.match(log.join('\n'), /matches\nkey-id diff: no previous generation root/);
        mkdirSync(path.join(dir, 'prev', 'stable'), { recursive: true });
        writeFileSync(path.join(dir, 'prev', 'stable', 'trusted_root.json'), JSON.stringify(ROOT_A));
        log.length = 0;
        await runTrustedRoot({ command: 'recheck', manifest, shipped: out, cache: dir, previousDir: path.join(dir, 'prev') },
            { sigstore, log: line => log.push(line) });
        assert.match(log.join('\n'), /key-id diff vs previous stable generation root:\n {2}tlogs: 2 \(added 1/);
        const drifted = { getTrustedRoot: async () => ROOT_A, TrustedRoot: codec };
        await assert.rejects(() => runTrustedRoot({ command: 'recheck', manifest, shipped: out, cache: dir },
            { sigstore: drifted, log: () => {} }), /trusted_root_mismatch: fresh root/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ verify: self

test('policyFor builds a policy the verifier accepts', () => {
    const policy = validateTrustPolicy(policyFor(IDENTITY, 'canary'));
    assert.equal(policy.repositoryId, IDENTITY.repositoryId);
    assert.equal(policy.channel, 'canary');
});

test('parseDigests: sha256sum lines only', () => {
    assert.deepEqual(parseDigests(`${digest('a')}  x.json\n`), [{ sha256: digest('a'), name: 'x.json' }]);
    assert.throws(() => parseDigests(''), /empty/);
    assert.throws(() => parseDigests(`${digest('a')} x.json\n`), /digests_invalid/);
    assert.throws(() => parseDigests(`${digest('a')}  ../x\n`), /digests_invalid/);
});

/** A generation directory whose manifest digests match its files. */
function generationDir(dir, { repositoryId = IDENTITY.repositoryId } = {}) {
    const gen = path.join(dir, 'gen');
    const bundles = path.join(dir, 'bundle');
    mkdirSync(gen);
    mkdirSync(bundles);
    const archive = Buffer.from('archive');
    const installer = Buffer.from('installer');
    writeFileSync(path.join(gen, 'nassaj-2.4.0.1-linux-x64-glibc.tar.zst'), archive);
    writeFileSync(path.join(gen, 'nassaj-install.mjs'), installer);
    writeFileSync(path.join(gen, 'trusted_root.json'), '{}');
    writeFileSync(path.join(gen, 'attestation-verifier.mjs'), '// fake');
    const base = manifestFixture();
    const manifest = manifestFixture({
        source: { ...base.source, repositoryId },
        targets: [{ ...base.targets[0], archive: { ...base.targets[0].archive, sha256: sha256(archive) } }],
        installer: { ...base.installer, sha256: sha256(installer) },
    });
    const manifestBytes = serializeReleaseManifest(manifest);
    writeFileSync(path.join(gen, 'release-manifest.json'), manifestBytes);
    const names = ['nassaj-2.4.0.1-linux-x64-glibc.tar.zst', 'nassaj-install.mjs', 'release-manifest.json'];
    const lines = names.map(name => `${sha256(readFileSync(path.join(gen, name)))}  ${name}\n`).join('');
    writeFileSync(path.join(gen, 'digests.txt'), lines);
    writeFileSync(path.join(bundles, 'attestation.json'), '{}');
    return { gen, bundles, subjects: new Set(names.map(name => sha256(readFileSync(path.join(gen, name))))) };
}

/** The artifact verifier's verifyAndDecide, faked over a fixed subject set. */
function fakeVerifier(subjects, calls, verdict = 'accept') {
    return async () => ({
        verifyAndDecide: input => {
            calls.push(input);
            const manifest = JSON.parse(input.manifestBytes.toString('utf8'));
            const verified = { subjects: new Map([...subjects].map(s => [s, 'n'])) };
            const assets = new Map([...manifest.targets.map(t => t.archive), manifest.installer].map(e => [e.name, e.sha256]));
            const artifacts = input.artifacts(manifest);
            for (const a of artifacts) {
                if (a.actualSha256 !== assets.get(a.name) || !verified.subjects.has(a.actualSha256)) throw new Error('mismatch');
            }
            return { verified, manifest, artifacts: artifacts.length, decision: { verdict, code: null, warnings: [] } };
        },
    });
}

test('selfCheck: the artifact verifier accepts the release and every digest line', async () => {
    const dir = tempDir();
    try {
        const { gen, bundles, subjects } = generationDir(dir);
        const calls = [];
        const result = await selfCheck({ dir: gen, bundleDir: bundles }, { importVerifier: fakeVerifier(subjects, calls) });
        assert.deepEqual(result, { subjects: 3, artifacts: 2 });
        assert.equal(calls[0].policy.repositoryId, IDENTITY.repositoryId);
        assert.equal(calls[0].policy.channel, 'stable');
        assert.equal(calls[0].completeArtifacts, true);
        await assert.rejects(() => selfCheck({ dir: gen, bundleDir: bundles },
            { importVerifier: fakeVerifier(subjects, [], 'reject') }), /self_check_failed: decision reject/);
        const fewer = new Set([...subjects].slice(0, 2));
        await assert.rejects(() => selfCheck({ dir: gen, bundleDir: bundles }, { importVerifier: fakeVerifier(fewer, []) }),
            /release-manifest\.json is not a subject/);
        writeFileSync(path.join(gen, 'nassaj-install.mjs'), 'tampered');
        await assert.rejects(() => selfCheck({ dir: gen, bundleDir: bundles },
            { importVerifier: fakeVerifier(subjects, []) }), /mismatch/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selfCheck refuses a manifest built for another repository id and a digests.txt drift', async () => {
    const dir = tempDir();
    try {
        const { gen, bundles, subjects } = generationDir(dir, { repositoryId: '42' });
        await assert.rejects(() => selfCheck({ dir: gen, bundleDir: bundles },
            { importVerifier: fakeVerifier(subjects, []) }), /repositoryId 42 is not the pin/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const again = tempDir();
    try {
        const { gen, bundles, subjects } = generationDir(again);
        const text = readFileSync(path.join(gen, 'digests.txt'), 'utf8');
        writeFileSync(path.join(gen, 'digests.txt'), text.replace(/^[0-9a-f]{64}/, digest('0')));
        await assert.rejects(() => selfCheck({ dir: gen, bundleDir: bundles },
            { importVerifier: fakeVerifier(subjects, []) }), /!= digests\.txt/);
    } finally { rmSync(again, { recursive: true, force: true }); }
});

test('findBundle requires exactly one bundle file', () => {
    const dir = tempDir();
    try {
        assert.throws(() => findBundle(dir), /expected 1, found 0/);
        writeFileSync(path.join(dir, 'a.json'), '{}');
        assert.equal(findBundle(dir), path.join(dir, 'a.json'));
        writeFileSync(path.join(dir, 'b.json'), '{}');
        assert.throws(() => findBundle(dir), /found 2/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------- verify: fleet

function previousGeneration(tag, overrides = {}) {
    const root = Buffer.from('{"root":1}');
    const verifier = Buffer.from('// previous verifier');
    const files = Buffer.from(JSON.stringify({ files: [{ path: 'verifier/attestation-verifier.mjs',
        sha256: sha256(verifier) }] }));
    const base = manifestFixture({ version: tag.slice(1), minUpgradeFrom: '2.4.0.0', ...overrides });
    const manifest = manifestFixture({ ...base, sigstoreTrustedRootSha256: sha256(root),
        targets: [{ ...base.targets[0], fileManifestSha256: sha256(files) }] });
    const assets = { 'release-manifest.json': serializeReleaseManifest(manifest),
        'release-attestation.sigstore.json': Buffer.from('{}'), 'attestation-verifier.mjs': verifier,
        'trusted_root.json': root, 'GENERATION_FILES.json': files };
    return { tag, manifest, assets };
}

function fleetRoutes(generations) {
    const routes = { [listUrl(1)]: generations.map(g => release(g.tag, Object.keys(g.assets))) };
    for (const g of generations) {
        for (const [name, bytes] of Object.entries(g.assets)) routes[assetUrl(REPO, g.tag, name)] = bytes;
    }
    return routes;
}

/** N+1 generation dir; `manifestBytes` defaults to a valid v1 manifest for v2.4.0.3. */
function fleetFixture(dir, manifestBytes) {
    const gen = path.join(dir, 'gen');
    const bundles = path.join(dir, 'bundle');
    mkdirSync(gen);
    mkdirSync(bundles);
    writeFileSync(path.join(gen, 'release-manifest.json'), manifestBytes
        ?? serializeReleaseManifest(manifestFixture({ version: '2.4.0.3', releaseSequence: 13, minShimVersion: 2 })));
    writeFileSync(path.join(bundles, 'attestation.json'), '{}');
    return { dir: gen, bundleDir: bundles, tag: 'v2.4.0.3', work: path.join(dir, 'work') };
}

test('checkPreviousAssets ties the previous verifier and root to its manifest', () => {
    const { manifest, assets } = previousGeneration('v2.4.0.1');
    const input = { root: assets['trusted_root.json'], files: assets['GENERATION_FILES.json'],
        verifier: assets['attestation-verifier.mjs'] };
    assert.deepEqual(checkPreviousAssets(manifest, input), []);
    assert.deepEqual(checkPreviousAssets(manifest, { ...input, root: Buffer.from('x') }), ['trusted_root.json sha256']);
    assert.deepEqual(checkPreviousAssets(manifest, { ...input, files: Buffer.from('{}') }), ['GENERATION_FILES.json sha256']);
    assert.deepEqual(checkPreviousAssets(manifest, { ...input, verifier: Buffer.from('x') }),
        ['attestation-verifier.mjs sha256']);
});

test('classifyFleetResult maps old-verifier outcomes', () => {
    assert.equal(classifyFleetResult({ status: 0 }), 'ok');
    assert.equal(classifyFleetResult({ status: 2, stdout: 'REJECTED attestation_trust_root_stale: x\n' }),
        'attestation_trust_root_stale');
    assert.equal(classifyFleetResult({ status: 2, stdout: 'REJECTED manifest_invalid: x\n' }), 'verifier_incompatible');
    assert.equal(classifyFleetResult({ status: null, stdout: '' }), 'verifier_incompatible');
});

async function runFleet(generations, nextResult) {
    const dir = tempDir();
    const calls = [];
    try {
        const options = fleetFixture(dir);
        const verdicts = await fleetSimulation(options, {
            fetchImpl: fakeFetch(fleetRoutes(generations)), token: undefined, log: () => {},
            installNode: (version, sha, dest) => { calls.push({ version, sha }); return `${dest}/bin/node`; },
            runProcess: (command, args) => {
                calls.push({ command, args });
                const next = args[4] === path.join(options.dir, 'release-manifest.json');
                return next ? nextResult : { status: 0, stdout: '{"ok":true}' };
            },
        });
        return { verdicts, calls };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('fleet simulation: first release skips every channel with a note', async () => {
    const { verdicts } = await runFleet([], { status: 0 });
    assert.deepEqual(Object.fromEntries(verdicts), { stable: 'skipped', canary: 'skipped' });
});

test('fleet simulation: the previous stable verifier decides N+1 as a node on N, with its own Node', async () => {
    const previous = previousGeneration('v2.4.0.1');
    const { verdicts, calls } = await runFleet([previous], { status: 0, stdout: '{"ok":true}' });
    assert.deepEqual(Object.fromEntries(verdicts), { stable: 'ok', canary: 'skipped' });
    assert.deepEqual(calls[0], { version: previous.manifest.targets[0].node.version,
        sha: previous.manifest.targets[0].node.sha256 });
    const runs = calls.filter(call => call.command);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].args.length, 5, 'its own release: fresh-node decision, no extra flags');
    assert.deepEqual(runs[1].args.slice(5), ['--artifacts', runs[1].args[6], '--installed', '2.4.0.1@10',
        '--shim-version', '2']);
    assert.match(runs[1].args[6], /\/gen$/, 'N+1 assets are read from the generation dir');
});

test('fleetDecisionArguments needs the N+1 minimum shim version', () => {
    assert.deepEqual(fleetDecisionArguments({ version: '2.4.0.1', releaseSequence: 10 }, { minShimVersion: 1 }, '/g'),
        ['--artifacts', '/g', '--installed', '2.4.0.1@10', '--shim-version', '1']);
    assert.throws(() => fleetDecisionArguments({ version: '2.4.0.1', releaseSequence: 10 }, {}, '/g'),
        /no minShimVersion/);
});

test('fleet simulation: a stale old root blocks publish', async () => {
    const previous = previousGeneration('v2.4.0.1');
    await assert.rejects(() => runFleet([previous], { status: 2, stdout: 'REJECTED attestation_trust_root_stale: x' }),
        /fleet_simulation_failed: stable=attestation_trust_root_stale/);
});

/**
 * Real incompatibility: the REAL bundled standalone verifier (esbuild, as the
 * build ships it) plays generation N and runs the real CLI on N+1. N's own
 * self-verification is the only canned step (no Sigstore signing offline).
 */
async function runRealFleet(t, nextManifestBytes) {
    const dir = tempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bundled = path.join(dir, 'attestation-verifier.mjs');
    bundleVerifier(path.resolve(here, '..', '..'), bundled, { env: process.env });
    const previous = previousGeneration('v2.4.0.1');
    const verifier = readFileSync(bundled);
    const files = Buffer.from(JSON.stringify({ files: [{ path: 'verifier/attestation-verifier.mjs', sha256: sha256(verifier) }] }));
    const manifest = manifestFixture({ ...previous.manifest,
        targets: [{ ...previous.manifest.targets[0], fileManifestSha256: sha256(files) }] });
    const generation = { tag: previous.tag, manifest, assets: { ...previous.assets, 'attestation-verifier.mjs': verifier,
        'GENERATION_FILES.json': files, 'release-manifest.json': serializeReleaseManifest(manifest) } };
    const options = fleetFixture(dir, nextManifestBytes);
    const logs = [];
    const run = (command, args) => {
        if (args[4] !== path.join(options.dir, 'release-manifest.json')) return { status: 0, stdout: '{"ok":true}' };
        const result = spawnSync(command, args, { encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const outcome = fleetSimulation(options, { fetchImpl: fakeFetch(fleetRoutes([generation])), log: line => logs.push(line),
        installNode: () => process.execPath, runProcess: run });
    return { outcome, logs };
}

test('fleet simulation (real bundled CLI): the old verifier refuses a newer manifest schema', async t => {
    const next = Buffer.from(`${canonicalJson({ ...manifestFixture({ version: '2.4.0.3', releaseSequence: 13 }),
        schema: 'nassaj-release-manifest/v2', newField: true })}\n`);
    const { outcome, logs } = await runRealFleet(t, next);
    await assert.rejects(outcome, /fleet_simulation_failed: stable=verifier_incompatible/);
    assert.match(logs.join('\n'), /v2\.4\.0\.1 verifier -> REJECTED verifier_too_old: manifest schema is newer/);
});

test('fleet simulation (real bundled CLI): the old verifier refuses a higher minVerifierVersion', async t => {
    const next = serializeReleaseManifest(manifestFixture({ version: '2.4.0.3', releaseSequence: 13,
        minVerifierVersion: 2 }));
    const { outcome, logs } = await runRealFleet(t, next);
    await assert.rejects(outcome, /fleet_simulation_failed: stable=verifier_incompatible/);
    assert.match(logs.join('\n'), /REJECTED verifier_too_old: manifest needs verifier 2, this is 1/);
});

test('fleet simulation (real bundled CLI): a compatible v1 manifest passes the schema and reaches crypto', async t => {
    const next = serializeReleaseManifest(manifestFixture({ version: '2.4.0.3', releaseSequence: 13 }));
    const { outcome, logs } = await runRealFleet(t, next);
    await assert.rejects(outcome, /fleet_simulation_failed: stable=verifier_incompatible/);
    assert.match(logs.join('\n'), /REJECTED attestation_invalid: bundle parse/, 'only the unsigned bundle is refused');
});

test('fleet simulation: tampered previous assets or an unverifiable previous release fail', async () => {
    const previous = previousGeneration('v2.4.0.1');
    previous.assets['trusted_root.json'] = Buffer.from('{"swapped":1}');
    await assert.rejects(() => runFleet([previous], { status: 0 }), /previous_generation_assets_mismatch/);
    const dir = tempDir();
    try {
        await assert.rejects(() => fleetSimulation(fleetFixture(dir), {
            fetchImpl: fakeFetch(fleetRoutes([previousGeneration('v2.4.0.1')])), log: () => {},
            installNode: () => 'node', runProcess: () => ({ status: 2, stdout: 'REJECTED attestation_invalid: x' }),
        }), /previous_generation_unverified: v2\.4\.0\.1/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify arguments', () => {
    assert.deepEqual(parseVerifyArguments(['self-check', '--dir', 'd', '--bundle-dir', 'b']),
        { command: 'self-check', dir: 'd', bundleDir: 'b' });
    assert.throws(() => parseVerifyArguments(['fleet', '--dir', 'd', '--bundle-dir', 'b']), /fleet needs --tag/);
    assert.throws(() => parseVerifyArguments(['other']), /usage/);
    assert.throws(() => parseVerifyArguments(['self-check', '--x']), /unknown or incomplete/);
});

// ------------------------------------------------------ install-official-node

test('install-official-node.sh validates its pin before any download', () => {
    const script = path.join(here, 'install-official-node.sh');
    const run = args => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
    assert.match(run(['--version', '24', '--sha256', digest('a'), '/nonexistent/x']).stderr, /node_pin_invalid: version/);
    assert.match(run(['--version', '24.18.1', '--sha256', 'zz', '/nonexistent/x']).stderr, /node_pin_invalid: sha256/);
    const dir = tempDir();
    try {
        const pins = path.join(here, '..', 'release-generation-pins.json');
        const exists = run(['--pins', pins, dir]);
        // Without jq on this host the pins mode stops earlier, with the same usage status.
        assert.equal(exists.status, 2);
        assert.match(exists.stderr, /must not exist|needs jq/);
        assert.equal(run(['--bogus']).status, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
