// release-upgrade-path-gate.test.mjs — B-1584 upgrade-path gate: verdict policy,
// known-incompatible acknowledgement, sandbox transport and leg wiring.
//
// The full gate needs two installed release trees (npm ci each) and is proven by
// running scripts/release-upgrade-path-gate.mjs (docs/RELEASING.md). These tests
// cover everything that decides the verdict, plus the real git transport of the
// sandbox against a tiny neutral fixture repository.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    GATE_REMOTE, LEGS, assertDiskBacked, cloneNode, createSandbox, decideUpgradePath, formatUpgradePathReport,
    git, loadKnownIncompatible, nextVersion, prepareReleaseRemote, probeEnvironment, runUpgradePathLegs,
    sshShimScript,
} from './lib/upgrade-path-gate.mjs';
import { assertPrivateDirectory, TREE_MARKER, verifyTreeRoot } from './lib/upgrade-path-trees.mjs';
import { initJournal, readJournal, recordUpgradePathAcknowledgement } from './lib/release-orchestrator-journal.mjs';
import { defaultWorkParent, parseArgs } from './release-upgrade-path-gate.mjs';

const TMPBASE = process.env.TMPDIR || '/var/tmp';
const PREV = 'a'.repeat(40);
const CAND = 'c'.repeat(40);

/** A report whose legs all pass unless overridden. */
function report(overrides = {}, previousTag = 'v1.0.0.1', previousCommit = PREV) {
    const legs = Object.fromEntries(LEGS.map(({ id }) => [id, { ok: true, actionKeys: ['k'] }]));
    return { previousTag, previousCommit, candidateCommit: CAND, candidateVersion: '1.0.0.2', legs: { ...legs, ...overrides } };
}

const ENTRY = Object.freeze({ baseline: 'v1.0.0.1', baselineCommit: PREV, leg: 'previous-reader-before-restart',
    code: 'source_update_action_invalid', bug: 'B-0000', reason: 'fixture' });
const BROKEN_READER = { 'previous-reader-before-restart': { ok: false, code: 'source_update_action_invalid' } };

test('every blocking leg passing is a pass', () => {
    assert.equal(decideUpgradePath(report()).verdict, 'pass');
});

test('a blocking failure with no recorded entry fails the gate', () => {
    const decision = decideUpgradePath(report(BROKEN_READER), { knownIncompatible: [], acknowledged: ['v1.0.0.1'] });
    assert.equal(decision.verdict, 'fail');
    assert.deepEqual(decision.failures.map((item) => item.leg), ['previous-reader-before-restart']);
});

test('a recorded known-incompatible baseline still fails without the owner acknowledgement', () => {
    const decision = decideUpgradePath(report(BROKEN_READER), { knownIncompatible: [ENTRY], acknowledged: [] });
    assert.equal(decision.verdict, 'fail');
    assert.equal(decision.unacknowledged.length, 1);
    assert.match(formatUpgradePathReport(report(BROKEN_READER), decision).join('\n'),
        /requires --acknowledge-upgrade-incompatible v1\.0\.0\.1/);
});

test('an acknowledged recorded baseline is reported explicitly, never as a plain pass', () => {
    const decision = decideUpgradePath(report(BROKEN_READER), { knownIncompatible: [ENTRY], acknowledged: ['v1.0.0.1'] });
    assert.equal(decision.verdict, 'known-incompatible-acknowledged');
    assert.match(formatUpgradePathReport(report(BROKEN_READER), decision).join('\n'), /KNOWN-INCOMPATIBLE \(owner acknowledged\)/);
});

test('the acknowledgement excuses only the exact baseline commit, leg and code', () => {
    const cases = [
        report(BROKEN_READER, 'v1.0.0.1', 'b'.repeat(40)),
        report({ 'previous-reader-before-restart': { ok: false, code: 'source_update_action_unsafe' } }),
        report({ 'candidate-reader-after-restart': { ok: false, code: 'source_update_action_invalid' } }),
        report(BROKEN_READER, 'v1.0.0.9'),
    ];
    for (const input of cases) {
        const decision = decideUpgradePath(input, { knownIncompatible: [ENTRY], acknowledged: [input.previousTag] });
        assert.equal(decision.verdict, 'fail', JSON.stringify(input.legs));
    }
});

test('an excused leg does not excuse another blocking failure in the same run', () => {
    const legs = { ...BROKEN_READER, 'candidate-writer': { ok: false, code: 'candidate_build_failed' } };
    const decision = decideUpgradePath(report(legs), { knownIncompatible: [ENTRY], acknowledged: ['v1.0.0.1'] });
    assert.equal(decision.verdict, 'fail');
});

test('the advisory leg is reported but never blocks', () => {
    const decision = decideUpgradePath(report({ 'previous-reader-of-candidate-action': { ok: false, code: 'x_y' } }));
    assert.equal(decision.verdict, 'pass');
    assert.equal(decision.advisories.length, 1);
});

test('a failed writer fails the gate even though its readers are only skipped', () => {
    const skippedLeg = { ok: false, skipped: true, code: 'skipped' };
    const decision = decideUpgradePath(report({ 'previous-writer': { ok: false, code: 'release_fetch_failed' },
        'previous-reader-before-restart': skippedLeg, 'candidate-reader-after-restart': skippedLeg }));
    assert.equal(decision.verdict, 'fail');
    assert.deepEqual(decision.failures.map((item) => item.leg), ['previous-writer']);
});

test('a missing leg result fails closed', () => {
    const input = report();
    delete input.legs['candidate-reader-after-restart'];
    assert.equal(decideUpgradePath(input).verdict, 'fail');
});

test('an entry whose leg now passes is flagged as stale', () => {
    const decision = decideUpgradePath(report(), { knownIncompatible: [ENTRY] });
    assert.equal(decision.verdict, 'pass');
    assert.equal(decision.staleEntries.length, 1);
});

test('the shipped known-incompatible policy loads and records only B-1583 baselines', () => {
    const entries = loadKnownIncompatible();
    assert.deepEqual(entries.map((entry) => entry.baseline), ['v2.3.1.0', 'v2.3.1.1']);
    assert.ok(entries.every((entry) => entry.bug === 'B-1583' && entry.leg === 'previous-reader-before-restart'));
});

test('a malformed policy file is rejected', (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-policy-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'policy.json');
    for (const policy of [{}, { schema: 'nassaj-upgrade-path-known-incompatible/v1', entries: [{ ...ENTRY, leg: 'any' }] },
        { schema: 'nassaj-upgrade-path-known-incompatible/v1', entries: [{ ...ENTRY, baselineCommit: 'short' }] },
        { schema: 'nassaj-upgrade-path-known-incompatible/v1', entries: [{ ...ENTRY, leg: 'previous-writer' }] },
        { schema: 'nassaj-upgrade-path-known-incompatible/v1', entries: [{ ...ENTRY, leg: 'candidate-writer' }] },
        { schema: 'nassaj-upgrade-path-known-incompatible/v1',
            entries: [{ ...ENTRY, leg: 'previous-reader-of-candidate-action' }] }]) {
        writeFileSync(file, JSON.stringify(policy));
        assert.throws(() => loadKnownIncompatible(file), /invalid known-incompatible/);
    }
});

test('nextVersion bumps the last segment and rejects other shapes', () => {
    assert.equal(nextVersion('2.3.1.9'), '2.3.1.10');
    assert.throws(() => nextVersion('2.3.1'), /four-part/);
});

test('parseArgs requires a previous tag and a candidate, and collects acknowledgements', () => {
    const parsed = parseArgs(['--previous-tag', 'v2.3.1.2', '--candidate-ref', 'main',
        '--acknowledge-upgrade-incompatible', 'v2.3.1.0', '--keep']);
    assert.deepEqual([parsed.previousTag, parsed.candidateRef, parsed.acknowledged, parsed.keep],
        ['v2.3.1.2', 'main', ['v2.3.1.0'], true]);
    assert.throws(() => parseArgs(['--candidate-ref', 'main']), /--previous-tag/);
    assert.throws(() => parseArgs(['--previous-tag', 'v1.0.0.1']), /--candidate-root or --candidate-ref/);
    assert.throws(() => parseArgs(['--previous-tag', '--keep']), /requires a value/);
    assert.throws(() => parseArgs(['--previous-tag', 'v1.0.0.1', '--bogus', 'x']), /unknown argument/);
});

test('the probe environment is an allowlist confined to the sandbox', () => {
    const env = probeEnvironment({ sandbox: '/var/tmp/sb', tree: '/var/tmp/tree', database: '/var/tmp/sb/db/db.sqlite' });
    for (const key of ['PM2_HOME', 'NASSAJ_UPDATE_MODE', 'GH_TOKEN', 'NODE_ENV', 'SERVER_PORT']) {
        assert.equal(Object.hasOwn(env, key), false, key);
    }
    for (const key of ['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'DATABASE_PATH', 'NASSAJ_HARNESS_DATA_HOME']) {
        assert.ok(env[key].startsWith('/var/tmp/sb'), key);
    }
    assert.equal(env.TSX_TSCONFIG_PATH, '/var/tmp/tree/server/tsconfig.json');
    assert.ok(env.PATH.startsWith('/var/tmp/sb/bin:'), 'the refusing ssh comes first on PATH');
    assert.match(env.NASSAJ_RELEASE_SOURCE, /^https:\/\/github\.com\/nassaj-upgrade-gate\/nassaj$/);
});

test('the sandbox puts an ssh and an npm first on PATH that refuse everything', (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-ssh-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sandbox = createSandbox(dir);
    const run = spawnSync('ssh', ['git@github.com', 'true'], { encoding: 'utf8',
        env: probeEnvironment({ sandbox, tree: dir, database: path.join(sandbox, 'db') }) });
    assert.equal(run.status, 255);
    assert.match(run.stderr, /network ssh refused/);
    const npm = spawnSync('npm', ['ci'], { encoding: 'utf8',
        env: probeEnvironment({ sandbox, tree: dir, database: path.join(sandbox, 'db') }) });
    assert.equal(npm.status, 1);
    assert.match(npm.stderr, /npm refused/);
});

test('the default work parent lives under HOME, never TMPDIR', () => {
    assert.equal(defaultWorkParent('/home/operator'), '/home/operator/.nassaj-upgrade-path-gate');
});

test('a cache directory must be private: 0700, owned, not a symlink', (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-private-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const open = path.join(dir, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    assert.throws(() => assertPrivateDirectory(open), /mode 0700/);
    const link = path.join(dir, 'link');
    chmodSync(open, 0o700);
    symlinkSync(open, link);
    assert.throws(() => assertPrivateDirectory(link), /mode 0700/);
    assert.doesNotThrow(() => assertPrivateDirectory(open));
});

test('a tmpfs parent is refused', { skip: !existsSync('/dev/shm') }, () => {
    assert.throws(() => assertDiskBacked('/dev/shm'), /tmpfs/);
});

test('the transport shim refuses any other repository path', (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-shim-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const shim = path.join(dir, 'shim.sh');
    writeFileSync(shim, sshShimScript(path.join(dir, 'missing.git')), { mode: 0o700 });
    const refused = spawnSync(shim, ['-o', 'BatchMode=yes', 'git@github.com', "git-upload-pack 'other/repo.git'"],
        { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused/);
});

/** A tiny neutral source repo: previous commit, candidate commit (version bumped). */
function fixtureSource(dir) {
    const source = path.join(dir, 'source');
    git(dir, ['init', '-q', '-b', 'main', source]);
    // As in the product repository, the served generations are git-ignored.
    writeFileSync(path.join(source, '.gitignore'), 'dist/\ndist-server/\nnode_modules/\n');
    git(source, ['add', '.gitignore']);
    const commitVersion = (version) => {
        writeFileSync(path.join(source, 'package.json'), `${JSON.stringify({ name: 'fixture', version }, null, 2)}\n`);
        git(source, ['add', 'package.json']);
        git(source, ['commit', '-q', '-m', `release ${version}`]);
        return git(source, ['rev-parse', 'HEAD']);
    };
    const previous = commitVersion('1.0.0.1');
    git(source, ['tag', '-a', 'v1.0.0.1', '-m', 'v1.0.0.1']);
    return { source, previous, candidate: commitVersion('1.0.0.2') };
}

test('a sandbox node fetches the candidate tag over the shim with a GitHub remote URL', (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-remote-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { source, previous, candidate } = fixtureSource(dir);
    const sandbox = createSandbox(path.join(dir, 'work'));
    const bare = prepareReleaseRemote({ sandbox, sourceRepo: source, candidateCommit: candidate, candidateVersion: '1.0.0.2' });
    const node = cloneNode({ sandbox, bare, name: 'node', commit: previous });
    assert.equal(git(node, ['remote', 'get-url', 'origin']), `git@${GATE_REMOTE.host}:${GATE_REMOTE.path}`);
    assert.equal(git(node, ['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(git(node, ['status', '--porcelain']), '', 'seeded live generations stay out of git status');
    const sshCommand = `${git(node, ['config', 'core.sshCommand'])} -o BatchMode=yes -o StrictHostKeyChecking=yes`;
    git(node, ['fetch', '--no-tags', 'origin', 'refs/tags/v1.0.0.2:refs/gate/tag'], { env: { GIT_SSH_COMMAND: sshCommand } });
    assert.equal(git(node, ['rev-parse', 'refs/gate/tag^{commit}']), candidate);
    assert.equal(readFileSync(path.join(source, 'package.json'), 'utf8').includes('1.0.0.2'), true, 'source untouched');
});

/** A clean checkout of `commit` with a stand-in installed tsx (node_modules is git-ignored). */
function installedCheckout(dir, source, name, commit) {
    const root = path.join(dir, name);
    git(dir, ['clone', '-q', source, root]);
    git(root, ['checkout', '-q', '--detach', commit]);
    mkdirSync(path.join(root, 'node_modules', 'tsx'), { recursive: true });
    return root;
}

test('a tree is trusted only at its declared commit and clean, or as a verified marked archive', (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-trees-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { source, previous, candidate } = fixtureSource(dir);
    const checkout = installedCheckout(dir, source, 'checkout', previous);
    assert.equal(verifyTreeRoot({ root: checkout, sourceRepo: source, commit: previous }), 'git-checkout');
    assert.throws(() => verifyTreeRoot({ root: checkout, sourceRepo: source, commit: candidate }), /is at/);
    writeFileSync(path.join(checkout, 'stray.mjs'), 'export {};\n');
    assert.throws(() => verifyTreeRoot({ root: checkout, sourceRepo: source, commit: previous }), /local changes/);
    const archive = path.join(dir, 'archive');
    mkdirSync(archive);
    spawnSync('bash', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'x', source, candidate, archive]);
    assert.throws(() => verifyTreeRoot({ root: archive, sourceRepo: source, commit: candidate }), /marked tree/);
    const marker = { schema: 'nassaj-upgrade-path-tree/v1', commit: candidate,
        tree: git(source, ['rev-parse', `${candidate}^{tree}`]) };
    writeFileSync(path.join(archive, TREE_MARKER), JSON.stringify(marker));
    assert.equal(verifyTreeRoot({ root: archive, sourceRepo: source, commit: candidate }), 'archive');
    writeFileSync(path.join(archive, 'package.json'), '{"tampered":true}\n');
    assert.throws(() => verifyTreeRoot({ root: archive, sourceRepo: source, commit: candidate }), /differs from/);
});

test('runUpgradePathLegs runs every leg in order, skips readers of a failed writer and keeps the sandbox', async (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-legs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { source, previous, candidate } = fixtureSource(dir);
    const previousRoot = installedCheckout(dir, source, 'prev', previous);
    const candidateRoot = installedCheckout(dir, source, 'cand', candidate);
    const seen = [];
    const spawn = (_node, args) => {
        const spec = JSON.parse(readFileSync(args.at(-1), 'utf8'));
        seen.push(path.basename(spec.resultFile, '.result.json'));
        const ok = !(spec.role === 'write' && spec.targetVersion === '1.0.0.2');
        writeFileSync(spec.resultFile, JSON.stringify(ok ? { ok, rowId: 'r', transactionId: 'tx' }
            : { ok, code: 'release_fetch_failed' }));
        return { status: 0, stdout: '', stderr: '' };
    };
    const leaves = [];
    const candidateLeaves = async (ctx) => {
        leaves.push(ctx);
        seen.push('candidate-leaves');
        return { ok: true };
    };
    const result = await runUpgradePathLegs({ sourceRepo: source, previousTag: 'v1.0.0.1', previousRoot, candidateRoot,
        candidateCommit: candidate, candidateVersion: '1.0.0.2', workParent: path.join(dir, 'work'), spawn,
        candidateLeaves });
    assert.deepEqual(seen, ['previous-writer', 'candidate-writer', 'candidate-reader-next-update',
        'candidate-bootstrap-next-update', 'previous-reader-of-candidate-action', 'candidate-leaves']);
    // The leaves leg drives the SAME synthetic next release the in-process legs staged.
    assert.equal(leaves[0].next.version, '1.0.0.3');
    assert.equal(git(leaves[0].bare, ['rev-parse', 'refs/tags/v1.0.0.3^{commit}']), leaves[0].next.commit);
    assert.equal(leaves[0].candidateRoot, candidateRoot);
    assert.equal(result.legs['previous-reader-before-restart'].skipped, true);
    assert.equal(result.legs['candidate-bootstrap-after-restart'].skipped, true);
    assert.equal(result.kept, true);
    assert.equal(decideUpgradePath(result).verdict, 'fail');
});

test('an acknowledgement is bound into the hash-chained release journal with a timestamp', (t) => {
    const dir = mkdtempSync(path.join(TMPBASE, 'upgrade-journal-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'journal.json');
    const journal = initJournal({ version: '1.0.0.2', tag: 'v1.0.0.2', frozenSha: CAND, previousTag: 'v1.0.0.1', dryRun: true });
    recordUpgradePathAcknowledgement(file, journal, { previousTag: 'v1.0.0.1', acknowledged: ['v1.0.0.1'],
        verdict: 'known-incompatible-acknowledged' });
    const [entry] = readJournal(file).upgradePathAcknowledgements;
    assert.equal(entry.verdict, 'known-incompatible-acknowledged');
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.throws(() => recordUpgradePathAcknowledgement(file, journal, { previousTag: 'v1.0.0.1',
        acknowledged: ['latest'], verdict: 'pass' }), /invalid upgrade-path acknowledgement/);
});

// The real gate against real release trees (two npm ci, ~1 min). Opt-in only;
// NASSAJ_UPGRADE_PATH_GATE_WORK overrides the private work parent.
const SLOW = process.env.NASSAJ_UPGRADE_PATH_GATE_SLOW === '1';

/** Run the standalone gate CLI against HEAD of this checkout. */
function runRealGate(previousTag) {
    const work = process.env.NASSAJ_UPGRADE_PATH_GATE_WORK;
    return spawnSync(process.execPath, ['scripts/release-upgrade-path-gate.mjs', '--previous-tag', previousTag,
        '--candidate-ref', 'HEAD', ...(work ? ['--work-parent', work] : [])],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
}

test('slow: v2.3.1.1 -> HEAD fails at the old reader with source_update_action_invalid (B-1583)', { skip: !SLOW }, () => {
    const run = runRealGate('v2.3.1.1');
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /previous-reader-before-restart: FAIL source_update_action_invalid/);
    assert.match(run.stdout, /verdict: fail/);
});

test('slow: v2.3.1.2 -> HEAD passes every blocking leg', { skip: !SLOW }, () => {
    const run = runRealGate('v2.3.1.2');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /verdict: pass/);
});
