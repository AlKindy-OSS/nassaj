import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { hashTree } from '../source-update-candidate.mjs';
import { gitlinkChangePaths, parseRawDiffEntries, parseTreeEntries } from './source-update-gitlinks.mjs';
import {
  applySourceManifest,
    exchangeGenerations, planSourceManifest, planSourceRollback, prepareBootstrapDescriptor, rollbackGenerations,
    validateCandidate, verifyRuntimeIdentities, inspectGitRuntimeRecovery,
  rollbackSourceManifest,
} from './source-update-activation.mjs';

function generation(directory, name, content, provenance = null) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${name}.txt`), content);
    if (provenance) writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), `${JSON.stringify(provenance)}\n`);
}

test('source manifest activation and rollback are CAS-safe and idempotent', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nassaj-source-cas-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
        writeFileSync(path.join(root, 'kept.txt'), 'old');
        writeFileSync(path.join(root, 'deleted.txt'), 'delete');
        writeFileSync(path.join(root, 'file-to-dir'), 'file');
        mkdirSync(path.join(root, 'dir-to-file')); writeFileSync(path.join(root, 'dir-to-file', 'child'), 'child');
        execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'old'], { cwd: root });
        const originalHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        writeFileSync(path.join(root, 'kept.txt'), 'new'); rmSync(path.join(root, 'deleted.txt')); writeFileSync(path.join(root, 'added.txt'), 'add');
        rmSync(path.join(root, 'file-to-dir')); mkdirSync(path.join(root, 'file-to-dir')); writeFileSync(path.join(root, 'file-to-dir', 'child'), 'child');
        rmSync(path.join(root, 'dir-to-file'), { recursive: true }); writeFileSync(path.join(root, 'dir-to-file'), 'file');
        symlinkSync('missing-target', path.join(root, 'dangling-link'));
        execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'new'], { cwd: root });
        const targetCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        execFileSync('git', ['checkout', '-q', originalHead], { cwd: root });
        execFileSync('git', ['switch', '-q', '-C', 'main', originalHead], { cwd: root });
        writeFileSync(path.join(root, 'unrelated.txt'), 'staged-intent');
        execFileSync('git', ['add', 'unrelated.txt'], { cwd: root });
        assert.throws(() => applySourceManifest({
            projectRoot: root, originalHead, targetCommit,
            progress: (_name, phase) => { if (phase === 'index-applied') throw new Error('fault-after-index'); },
        }), /fault-after-index/);
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), originalHead);
        rollbackSourceManifest({ projectRoot: root, originalHead, targetCommit });
        assert.match(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }), /unrelated\.txt/);
        applySourceManifest({ projectRoot: root, originalHead, targetCommit });
        assert.equal(readFileSync(path.join(root, 'kept.txt'), 'utf8'), 'new');
        assert.equal(lstatSync(path.join(root, 'dangling-link')).isSymbolicLink(), true);
        assert.equal(applySourceManifest({ projectRoot: root, originalHead, targetCommit }).paths > 3, true);
        rollbackSourceManifest({ projectRoot: root, originalHead, targetCommit });
        assert.equal(readFileSync(path.join(root, 'kept.txt'), 'utf8'), 'old');
        writeFileSync(path.join(root, 'kept.txt'), 'external');
        assert.throws(() => applySourceManifest({ projectRoot: root, originalHead, targetCommit }), /CAS mismatch/);
        execFileSync('git', ['checkout', '--', 'kept.txt'], { cwd: root });
        writeFileSync(path.join(root, 'kept.txt'), 'staged-related'); execFileSync('git', ['add', 'kept.txt'], { cwd: root });
        writeFileSync(path.join(root, 'kept.txt'), execFileSync('git', ['show', 'HEAD:kept.txt'], { cwd: root }));
        assert.throws(() => applySourceManifest({ projectRoot: root, originalHead, targetCommit }), /index CAS mismatch/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

/** original: kept.txt, dir-to-file/child; target adds ignored added.txt, dir-to-file as a file, newdir/inner.txt. */
function planRepository() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nassaj-source-plan-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(root, '.gitignore'), 'added.txt\n');
    writeFileSync(path.join(root, 'kept.txt'), 'old');
    mkdirSync(path.join(root, 'dir-to-file')); writeFileSync(path.join(root, 'dir-to-file', 'child'), 'child');
    git('add', '.'); git('commit', '-qm', 'original');
    const originalHead = git('rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'kept.txt'), 'new');
    writeFileSync(path.join(root, 'added.txt'), 'release'); git('add', '-f', 'added.txt');
    rmSync(path.join(root, 'dir-to-file'), { recursive: true }); writeFileSync(path.join(root, 'dir-to-file'), 'file');
    mkdirSync(path.join(root, 'newdir')); writeFileSync(path.join(root, 'newdir', 'inner.txt'), 'inner');
    git('add', '-A'); git('commit', '-qm', 'target');
    const targetCommit = git('rev-parse', 'HEAD');
    git('reset', '-q', '--hard', originalHead);
    return { root, originalHead, targetCommit, git };
}

test('the write-free plan refuses what the cleanliness gate cannot see, before any write (H1)', () => {
    const repo = planRepository();
    try {
        const options = { projectRoot: repo.root, originalHead: repo.originalHead, targetCommit: repo.targetCommit };
        assert.equal(planSourceManifest(options).paths, 5);
        const cases = [
            ['an IGNORED file where the release adds one', 'added.txt', /CAS mismatch: added\.txt/],
            ['a local file inside a directory the release turns into a file', 'dir-to-file/local.txt', /path is occupied: dir-to-file/],
            ['a file where the release needs a directory', 'newdir', /parent is unsafe: newdir\/inner\.txt/],
        ];
        for (const [label, local, expected] of cases) {
            writeFileSync(path.join(repo.root, local), 'operator');
            assert.throws(() => planSourceManifest(options), expected, label);
            let wrote = false;
            assert.throws(() => applySourceManifest({ ...options, beforeWrite: () => { wrote = true; } }), expected, label);
            assert.equal(wrote, false, `${label}: the refusal comes before the first write`);
            assert.equal(readFileSync(path.join(repo.root, 'kept.txt'), 'utf8'), 'old', label);
            assert.equal(repo.git('rev-parse', 'HEAD'), repo.originalHead, label);
            rmSync(path.join(repo.root, local));
        }
        let writes = 0;
        applySourceManifest({ ...options, beforeWrite: () => { writes += 1; } });
        assert.equal(writes, 1);
        assert.equal(readFileSync(path.join(repo.root, 'dir-to-file'), 'utf8'), 'file');
        assert.equal(readFileSync(path.join(repo.root, 'newdir', 'inner.txt'), 'utf8'), 'inner');
        assert.equal(planSourceRollback(options).paths, 5, 'the rollback direction plans cleanly from target');
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

function swap(left, right) {
    const temporary = `${left}.swap`;
    renameSync(left, temporary); renameSync(right, left); renameSync(temporary, right);
}

function fixture() {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'nassaj-update-activation-'));
    const transactionId = 'update-abcdefghijklmnop';
    const releaseCommit = 'a'.repeat(40);
    const version = '1.44.0.2';
    const candidateRoot = path.join(projectRoot, '.git', 'nassaj-source-update', 'candidates', transactionId);
    mkdirSync(candidateRoot, { recursive: true });
    const clientBuildId = 'b'.repeat(64);
    const serverBuildId = 'c'.repeat(64);
    generation(path.join(candidateRoot, 'client'), 'client', 'new', { artifact: 'client', commit: releaseCommit, version, buildId: clientBuildId });
    generation(path.join(candidateRoot, 'server'), 'server', 'new', { artifact: 'server', commit: releaseCommit, version, buildId: serverBuildId });
    generation(path.join(candidateRoot, 'node_modules'), 'dependency', 'new');
    generation(path.join(projectRoot, 'dist'), 'client', 'old', { artifact: 'client', commit: 'd'.repeat(40), version: '1.44.0.1', buildId: 'e'.repeat(64) });
    generation(path.join(projectRoot, 'dist-server'), 'server', 'old', { artifact: 'server', commit: 'd'.repeat(40), version: '1.44.0.1', buildId: 'f'.repeat(64) });
    generation(path.join(projectRoot, 'node_modules'), 'dependency', 'old');
    const manifest = {
        schemaVersion: 1, txId: transactionId, releaseCommit, version,
        clientBuildId, serverBuildId,
        sourceProvenance: { kind: 'git-worktree', commit: releaseCommit, clean: true },
        artifacts: {
            client: { commit: releaseCommit, buildId: clientBuildId },
            server: { commit: releaseCommit, buildId: serverBuildId },
            nodeModules: { commit: releaseCommit },
        },
        trees: Object.fromEntries([
            ['client', 'client'], ['server', 'server'], ['nodeModules', 'node_modules'],
        ].map(([name, directory]) => [name, hashTree(path.join(candidateRoot, directory))])),
    };
    const manifestPath = path.join(candidateRoot, 'candidate-manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const validation = validateCandidate({ projectRoot, candidateRoot, manifestPath, transactionId, releaseCommit, version });
    return { projectRoot, candidateRoot, transactionId, validation };
}

/** A real exchanged fixture plus the exact durable proof left before the terminal database CAS. */
function recoveredFixture(withRealSource = false) {
    const value = fixture();
    const { validation } = value;
    let originalHead = 'd'.repeat(40);
    if (withRealSource) {
        const git = (...args) => execFileSync('git', args, { cwd: value.projectRoot, encoding: 'utf8' }).trim();
        git('init', '-q', '-b', 'main');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'previous');
        originalHead = git('rev-parse', 'HEAD');
        for (const name of ['client', 'server']) {
            const file = path.join(validation.live[name], 'BUILD_PROVENANCE.json');
            writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), commit: originalHead }));
        }
    }
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    const action = { schema: 'nassaj-source-update-activation/v1', transactionId: value.transactionId,
        originalHead, targetCommit: validation.manifest.releaseCommit,
        version: validation.manifest.version, manifestPath: validation.manifestPath,
        manifestSha256: sha(readFileSync(validation.manifestPath)), expectedServerBuildId: validation.manifest.serverBuildId };
    writeFileSync(path.join(value.candidateRoot, 'activation-action.json'), `${JSON.stringify(action)}\n`, { mode: 0o600 });
    exchangeGenerations(validation, { exchange: swap });
    const identities = verifyRuntimeIdentities(validation);
    const facts = JSON.stringify({ runtimeIdentities: identities });
    const job = { id: 'recovered-job', strategy: 'git-checkout-v2', state: 'runtime_verifying',
        transaction_id: value.transactionId, activation_identity_sha256: sha(JSON.stringify(action)),
        release_commit: action.targetCommit, expected_version: action.version,
        expected_server_build_id: validation.manifest.serverBuildId, expected_client_build_id: validation.manifest.clientBuildId };
    return { ...value, action, job, controlRoot: path.dirname(path.dirname(value.candidateRoot)),
        journal: { state: 'OPEN', gateClosed: false, phase: 'ACTIVE_VERIFIED', transactionId: value.transactionId,
            identity: { originalHead: action.originalHead, targetCommit: action.targetCommit, expectedVersion: action.version },
            runtimeIdentities: identities },
        runtime: { commit: action.targetCommit, serverBuildId: job.expected_server_build_id, clientBuildId: job.expected_client_build_id },
        receipts: [{ job_id: job.id, phase: 'runtime_verifying', kind: 'done', facts_json: facts, facts_sha256: sha(facts) }] };
}

test('B-1147: a completed Git activation is recovered only from matching job, process, journal and durable completion', () => {
    const value = recoveredFixture();
    try {
        const before = hashTree(value.projectRoot);
        assert.equal(inspectGitRuntimeRecovery(value).next, 'activated');
        assert.deepEqual(hashTree(value.projectRoot), before, 'verification must not exchange or rewrite any file');
        assert.equal(inspectGitRuntimeRecovery(value).next, 'activated', 'read-only proof is idempotent');
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});

test('B-1147: a proven rollback releases the job, but an unknown database keeps it fenced', () => {
    const value = recoveredFixture(true);
    try {
        rollbackGenerations(value.validation, { exchange: swap });
        value.journal = { state: 'OPEN', gateClosed: false, phase: null, transactionId: null, databaseState: 'PRE_CANDIDATE' };
        value.runtime = { commit: value.action.originalHead, serverBuildId: 'f'.repeat(64), clientBuildId: 'e'.repeat(64) };
        assert.equal(inspectGitRuntimeRecovery(value).next, 'rolled_back');
        value.journal.databaseState = 'UNKNOWN';
        assert.equal(inspectGitRuntimeRecovery(value).next, null);
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});

for (const [label, change] of [
    ['open without a completion phase', (v) => { v.journal.phase = null; }],
    ['a different transaction', (v) => { v.journal.transactionId = 'update-other'; }],
    ['manual gate', (v) => { v.journal.state = 'MANUAL'; v.journal.gateClosed = true; }],
    ['loaded process differs from disk', (v) => { v.runtime.serverBuildId = '0'.repeat(64); }],
    ['client identity differs', (v) => { v.runtime.clientBuildId = '0'.repeat(64); }],
    ['missing receipt', (v) => { v.receipts = []; }],
    ['receipt belongs to another job', (v) => { v.receipts[0].job_id = 'other'; }],
    ['tampered receipt', (v) => { v.receipts[0].facts_sha256 = '0'.repeat(64); }],
    ['activation action differs', (v) => { v.job.activation_identity_sha256 = '0'.repeat(64); }],
    ['live files differ', (v) => { writeFileSync(path.join(v.projectRoot, 'dist', 'client.txt'), 'changed'); }],
    ['unproved previous generations', (v) => { v.journal.phase = null; v.journal.recovery = 'ROLLED_BACK'; v.journal.databaseState = 'PRE_CANDIDATE'; }],
]) {
    test(`B-1147: ${label} remains unresolved`, () => {
        const value = recoveredFixture();
        try { change(value); assert.equal(inspectGitRuntimeRecovery(value).next, null); }
        finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
    });
}

test('activation resumes after a crash boundary and rollback is symmetric and idempotent', () => {
    const value = fixture();
    try {
        assert.throws(() => exchangeGenerations(value.validation, {
            exchange: swap,
            afterStep(name) { if (name === 'nodeModules') throw new Error('crash'); },
        }), /crash/);
        // A new process revalidates the partially exchanged trees before resume.
        const resumedValidation = validateCandidate({
            projectRoot: value.projectRoot, candidateRoot: value.candidateRoot,
            manifestPath: path.join(value.candidateRoot, 'candidate-manifest.json'),
            transactionId: value.transactionId, releaseCommit: 'a'.repeat(40), version: '1.44.0.2',
        });
        const activated = exchangeGenerations(resumedValidation, { exchange: swap });
        assert.equal(activated.state, 'exchanged');
        assert.doesNotThrow(() => verifyRuntimeIdentities(resumedValidation));
        assert.equal(exchangeGenerations(resumedValidation, { exchange: swap }).state, 'exchanged');
        assert.equal(rollbackGenerations(resumedValidation, { exchange: swap }).state, 'rolled_back');
        assert.equal(rollbackGenerations(resumedValidation, { exchange: swap }).state, 'rolled_back');
        assert.equal(readFileSync(path.join(value.projectRoot, 'dist', 'client.txt'), 'utf8'), 'old');
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});

test('promoting the client generation reaches exchanged and passes runtime identity (T-1551)', () => {
    const value = fixture();
    try {
        const activated = exchangeGenerations(value.validation, {
            exchange: swap, names: ['nodeModules', 'server', 'client'],
        });
        assert.equal(activated.state, 'exchanged');
        // The served client bundle is now the candidate build, not the old one.
        assert.equal(readFileSync(path.join(value.projectRoot, 'dist', 'client.txt'), 'utf8'), 'new');
        assert.doesNotThrow(() => verifyRuntimeIdentities(value.validation));
        // Rollback restores the client generation exactly.
        assert.equal(rollbackGenerations(value.validation, { exchange: swap }).state, 'rolled_back');
        assert.equal(readFileSync(path.join(value.projectRoot, 'dist', 'client.txt'), 'utf8'), 'old');
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});

test('omitting the client generation leaves it stale and fails runtime identity (T-1551 regression guard)', () => {
    const value = fixture();
    try {
        const activated = exchangeGenerations(value.validation, {
            exchange: swap, names: ['nodeModules', 'server'],
        });
        assert.equal(activated.state, 'server_exchanged');
        // The client bundle stayed on the old build — exactly the defect T-1551 fixes.
        assert.equal(readFileSync(path.join(value.projectRoot, 'dist', 'client.txt'), 'utf8'), 'old');
        assert.throws(() => verifyRuntimeIdentities(value.validation), /Runtime client identity mismatch/);
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});

test('bootstrap descriptor is fixed, non-secret and collision-safe', () => {
    const value = fixture();
    try {
        const controlRoot = path.join(value.projectRoot, '.git', 'nassaj-source-update');
        const tokenFilePath = path.join(controlRoot, 'token');
        writeFileSync(tokenFilePath, 'not-embedded', { mode: 0o600 });
        const file = prepareBootstrapDescriptor({
            controlRoot, transactionId: value.transactionId, epoch: 'z'.repeat(24), tokenFilePath,
        });
        const text = readFileSync(file, 'utf8');
        assert.doesNotMatch(text, /not-embedded/);
        assert.equal(prepareBootstrapDescriptor({
            controlRoot, transactionId: value.transactionId, epoch: 'z'.repeat(24), tokenFilePath,
        }), file);
        assert.throws(() => prepareBootstrapDescriptor({
            controlRoot, transactionId: value.transactionId, epoch: 'y'.repeat(24), tokenFilePath,
        }), /collision/);
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});

const GITLINK_OID = '4895cd3fd33362471e739b786493aba048487bcc';
const OTHER_GITLINK_OID = 'b'.repeat(40);

function gitlinkFixture(kind = 'unchanged') {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nassaj-gitlink-cas-'));
    const git = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input }).trim();
    git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(root, 'change.txt'), 'old'); git(['add', 'change.txt']);
    const fileOid = git(['hash-object', '-w', '--stdin'], 'file');
    if (kind === 'file-to-gitlink') git(['update-index', '--add', '--cacheinfo', `100644,${fileOid},plugins/starter`]);
    else if (kind !== 'added') git(['update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},plugins/starter`]);
    git(['commit', '-qm', 'original']); const originalHead = git(['rev-parse', 'HEAD']);
    const changed = git(['hash-object', '-w', '--stdin'], 'new');
    git(['update-index', '--cacheinfo', `100644,${changed},change.txt`]);
    if (kind === 'removed') git(['update-index', '--force-remove', 'plugins/starter']);
    if (kind === 'changed') git(['update-index', '--cacheinfo', `160000,${OTHER_GITLINK_OID},plugins/starter`]);
    if (kind === 'added' || kind === 'file-to-gitlink') git(['update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},plugins/starter`]);
    if (kind === 'gitlink-to-file') git(['update-index', '--cacheinfo', `100644,${fileOid},plugins/starter`]);
    const targetCommit = git(['commit-tree', git(['write-tree']), '-p', originalHead, '-m', 'target']);
    git(['read-tree', originalHead]);
    return { root, git, originalHead, targetCommit };
}

function assertGitlinkRejectionUnchanged(value, action, error) {
    const index = readFileSync(path.join(value.root, '.git/index'));
    const head = value.git(['rev-parse', 'HEAD']);
    const source = readFileSync(path.join(value.root, 'change.txt'));
    let progress = 0;
    assert.throws(() => action({ projectRoot: value.root, originalHead: value.originalHead,
        targetCommit: value.targetCommit, progress: () => { progress += 1; } }), error);
    assert.deepEqual(readFileSync(path.join(value.root, '.git/index')), index);
    assert.deepEqual(readFileSync(path.join(value.root, 'change.txt')), source);
    assert.equal(value.git(['rev-parse', 'HEAD']), head);
    assert.equal(progress, 0);
}

test('unchanged gitlink preserves populated and linked working directories across apply and rollback', () => {
    for (const linked of [false, true]) {
        const value = gitlinkFixture();
        try {
            const directory = path.join(value.root, linked ? 'outside' : 'plugins/starter');
            mkdirSync(path.join(directory, 'nested'), { recursive: true });
            writeFileSync(path.join(directory, 'nested/local.txt'), 'local customization');
            if (linked) { mkdirSync(path.join(value.root, 'plugins')); symlinkSync('../outside', path.join(value.root, 'plugins/starter')); }
            const before = lstatSync(path.join(directory, 'nested/local.txt'));
            const linkEntry = value.git(['ls-files', '-s', '--', 'plugins/starter']);
            for (const action of [applySourceManifest, applySourceManifest, rollbackSourceManifest, rollbackSourceManifest]) {
                action({ projectRoot: value.root, originalHead: value.originalHead, targetCommit: value.targetCommit });
                assert.equal(readFileSync(path.join(directory, 'nested/local.txt'), 'utf8'), 'local customization');
                assert.equal(lstatSync(path.join(directory, 'nested/local.txt')).ino, before.ino);
                assert.equal(value.git(['ls-files', '-s', '--', 'plugins/starter']), linkEntry);
            }
            assert.equal(readFileSync(path.join(value.root, 'change.txt'), 'utf8'), 'old');
            assert.equal(value.git(['rev-parse', 'HEAD']), value.originalHead);
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('changed added removed or type-changing gitlinks are refused by the pre-check, not by activation (WI-11)', () => {
    for (const kind of ['changed', 'added', 'removed', 'file-to-gitlink', 'gitlink-to-file']) {
        const value = gitlinkFixture(kind);
        try {
            // The policy answer is available before any write, from either the
            // release trees or the bounded raw diff, and it names the path.
            const trees = (commit) => parseTreeEntries(
                value.git(['ls-tree', '-rz', '--full-tree', commit]));
            assert.deepEqual(
                gitlinkChangePaths(trees(value.originalHead), trees(value.targetCommit)),
                ['plugins/starter'], kind);
            const raw = parseRawDiffEntries(execFileSync('git',
                ['diff', '--raw', '-z', '--abbrev=40', `${value.originalHead}..${value.targetCommit}`],
                { cwd: value.root, encoding: 'utf8' }));
            assert.deepEqual(gitlinkChangePaths(raw.from, raw.to), ['plugins/starter'], kind);
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('rollback onto a tree whose gitlink differs is no longer failed by the policy check (WI-11, B-1054)', () => {
    const value = gitlinkFixture('changed');
    try {
        // The index carries this direction's `from` — the target commit, as it
        // would after an activation — so only the identity check has a say.
        value.git(['update-index', '--cacheinfo', `160000,${OTHER_GITLINK_OID},plugins/starter`]);
        assert.doesNotThrow(() => rollbackSourceManifest({
            projectRoot: value.root, originalHead: value.originalHead, targetCommit: value.targetCommit,
        }));
        assert.equal(readFileSync(path.join(value.root, 'change.txt'), 'utf8'), 'old');
        // The gitlink itself is never rewritten by the updater (G1).
        assert.match(value.git(['ls-files', '-s', '--', 'plugins/starter']), new RegExp(`160000 ${OTHER_GITLINK_OID}`));
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('unchanged gitlinks require matching stage-zero index identity before apply and rollback', () => {
    for (const kind of ['missing', 'oid', 'mode', 'unmerged', 'stage-one-only']) {
        const value = gitlinkFixture();
        try {
            if (kind === 'missing') value.git(['update-index', '--force-remove', 'plugins/starter']);
            if (kind === 'oid') value.git(['update-index', '--cacheinfo', `160000,${OTHER_GITLINK_OID},plugins/starter`]);
            if (kind === 'mode') {
                const blob = value.git(['hash-object', '-w', '--stdin'], 'ordinary file');
                value.git(['update-index', '--cacheinfo', `100644,${blob},plugins/starter`]);
            }
            if (kind === 'unmerged' || kind === 'stage-one-only') {
                const input = `0 ${'0'.repeat(40)}\tplugins/starter\n160000 ${GITLINK_OID} 1\tplugins/starter\n`
                    + (kind === 'unmerged' ? `160000 ${OTHER_GITLINK_OID} 2\tplugins/starter\n` : '');
                value.git(['update-index', '--index-info'], input);
            }
            for (const action of [applySourceManifest, rollbackSourceManifest]) {
                assertGitlinkRejectionUnchanged(value, action, /gitlink index mismatch|index is (?:unmerged|invalid)/);
            }
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('unmaterialized unchanged gitlink is never created during apply or rollback', () => {
    const value = gitlinkFixture();
    try {
        const submodule = path.join(value.root, 'plugins/starter');
        for (const action of [applySourceManifest, rollbackSourceManifest]) {
            action({ projectRoot: value.root, originalHead: value.originalHead, targetCommit: value.targetCommit });
            assert.throws(() => lstatSync(submodule), { code: 'ENOENT' });
        }
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

for (const boundary of ['nodeModules', 'server', 'client']) {
    test(`a lost completion receipt after ${boundary} exchange still restores every previous generation`, () => {
        const value = fixture();
        try {
            const previous = Object.fromEntries(Object.entries(value.validation.live).map(([name, directory]) => [name, hashTree(directory)]));
            assert.throws(() => exchangeGenerations(value.validation, { exchange: swap,
                afterExchange(name) { if (name === boundary) throw new Error('lost-completion-receipt'); },
            }), /lost-completion-receipt/);
            const receipt = JSON.parse(readFileSync(path.join(value.candidateRoot, 'activation-receipt.json')));
            assert.equal(receipt.steps[boundary].state, 'forward_intent');
            assert.equal(rollbackGenerations(value.validation, { exchange: swap }).state, 'rolled_back');
            for (const [name, directory] of Object.entries(value.validation.live)) assert.deepEqual(hashTree(directory), previous[name]);
            assert.equal(rollbackGenerations(value.validation, { exchange: swap }).state, 'rolled_back');
        } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
    });
}

test('unrecognized physical bytes block recovery without a compensating exchange', () => {
    const value = fixture();
    try {
        assert.throws(() => exchangeGenerations(value.validation, { exchange: swap,
            afterExchange(name) { if (name === 'client') throw new Error('crash'); },
        }), /crash/);
        writeFileSync(path.join(value.projectRoot, 'node_modules', 'tampered'), 'outside writer');
        let exchanges = 0;
        assert.throws(() => rollbackGenerations(value.validation, { exchange() { exchanges++; } }), /identity mismatch/);
        assert.equal(exchanges, 0);
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});

function removeV2ReceiptEvidence(value, lostStep = null) {
    const file = path.join(value.candidateRoot, 'activation-receipt.json');
    const receipt = JSON.parse(readFileSync(file));
    delete receipt.previous;
    if (lostStep) delete receipt.steps[lostStep];
    writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
}

for (const legacyState of ['partial', 'complete', 'rolled_back']) {
    test(`legacy ${legacyState} receipt is upgraded only from its proved previous identities`, () => {
        const value = fixture();
        try {
            if (legacyState === 'partial') assert.throws(() => exchangeGenerations(value.validation, {
                exchange: swap, afterStep(name) { if (name === 'nodeModules') throw new Error('old-crash'); },
            }), /old-crash/);
            else exchangeGenerations(value.validation, { exchange: swap });
            if (legacyState === 'rolled_back') rollbackGenerations(value.validation, { exchange: swap });
            removeV2ReceiptEvidence(value);
            const result = legacyState === 'rolled_back' ? rollbackGenerations(value.validation, { exchange: swap })
                : exchangeGenerations(value.validation, { exchange: swap });
            assert.equal(result.state, legacyState === 'rolled_back' ? 'rolled_back' : 'exchanged');
            assert.deepEqual(Object.keys(result.previous).sort(), ['client', 'nodeModules', 'server']);
            rollbackGenerations(value.validation, { exchange: swap });
            assert.equal(readFileSync(path.join(value.projectRoot, 'dist', 'client.txt'), 'utf8'), 'old');
        } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
    });
}

test('legacy lost-done receipt cannot invent the old identity or exchange any generation', () => {
    const value = fixture();
    try {
        assert.throws(() => exchangeGenerations(value.validation, { exchange: swap,
            afterExchange(name) { if (name === 'server') throw new Error('old-crash'); },
        }), /old-crash/);
        removeV2ReceiptEvidence(value, 'server');
        let exchanges = 0;
        for (const operation of [exchangeGenerations, rollbackGenerations]) {
            assert.throws(() => operation(value.validation, { exchange() { exchanges++; } }), /previous generation identity is unproven/);
        }
        assert.equal(exchanges, 0);
    } finally { rmSync(value.projectRoot, { recursive: true, force: true }); }
});
