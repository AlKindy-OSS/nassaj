import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareLocalSourceRecoveryCandidate, buildLocalSourceRecoveryCandidate, readPreparedLocalRecoveryCandidate } from './local-source-recovery-candidate.mjs';
import { readCandidatePlan, hashTree } from './source-update-candidate.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function removeFixture(root) {
    const writable = directory => {
        fs.chmodSync(directory, 0o700);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) writable(path.join(directory, entry.name));
        }
    };
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(project, '.artifacts/local-source-recovery-test-'));
    fs.chmodSync(root, 0o700);
    t.after(() => removeFixture(root));
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.2.0.1' }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\ndist\ndist-server\n.nassaj-local-preview\n');
    git(['add', 'package.json', 'package-lock.json', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    for (const dir of ['node_modules', 'dist', 'dist-server']) {
        fs.mkdirSync(path.join(root, dir));
        fs.writeFileSync(path.join(root, dir, 'sentinel'), 'unchanged live generation');
    }
    return { root, git, expectedOid: git(['rev-parse', 'HEAD']), txId: 'local-recovery-fixture' };
}

function builds(value, { failAfterInstall = false, afterInstall = () => {} } = {}) {
    let installs = 0;
    return {
        root: value.root,
        get installs() { return installs; },
        run(executable, args, options) {
            if (executable === 'git') return { status: 0, stdout: execFileSync(executable, args, { ...options, encoding: 'utf8' }) };
            assert.equal(executable, 'npm');
            if (args[0] === 'ci') {
                installs += 1;
                fs.mkdirSync(path.join(options.cwd, 'node_modules'));
                fs.writeFileSync(path.join(options.cwd, 'node_modules', 'private-dependency'), 'candidate only');
                afterInstall(options.cwd);
                if (failAfterInstall) throw new Error('fixture_install_failed');
            }
            return { status: 0, stdout: '{}' };
        },
        buildClient(options) {
            fs.mkdirSync(options.outputRoot);
            fs.writeFileSync(path.join(options.outputRoot, 'index.html'), 'candidate client');
            fs.writeFileSync(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: options.releaseCommit, version: options.version, buildId: 'b'.repeat(64) }));
            return { buildId: 'b'.repeat(64) };
        },
        buildServer(options) {
            fs.mkdirSync(options.outputRoot);
            fs.writeFileSync(path.join(options.outputRoot, 'index.js'), 'candidate server');
            fs.writeFileSync(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: options.releaseCommit, version: options.version, buildId: 'c'.repeat(64) }));
            return { buildId: 'c'.repeat(64) };
        },
    };
}

test('local snapshot preserves dirty source/index and resumes one sealed candidate without reinstalling', async t => {
    const value = fixture(t);
    fs.writeFileSync(path.join(value.root, 'package.json'), '{"version":"9.9.9.9"}');
    const indexBefore = fs.readFileSync(path.join(value.root, '.git/index'));
    const modulesBefore = hashTree(path.join(value.root, 'node_modules'));
    const prepared = await prepareLocalSourceRecoveryCandidate(value);
    const plan = readCandidatePlan(prepared.planFile, { root: value.root });
    assert.equal(plan.version, '2.2.0.1');
    assert.equal(plan.localSource.ref, 'refs/heads/main');
    assert.equal((await prepareLocalSourceRecoveryCandidate(value)).reused, true);
    const operations = builds(value);
    const first = await buildLocalSourceRecoveryCandidate(prepared.planFile, operations);
    const replay = await buildLocalSourceRecoveryCandidate(prepared.planFile, operations);
    assert.deepEqual(replay, first);
    assert.equal(operations.installs, 1);
    assert.equal(first.localSource.oid, value.expectedOid);
    assert.equal(first.expectedServerBuildId, 'c'.repeat(64));
    assert.deepEqual(hashTree(path.join(value.root, 'node_modules')), modulesBefore);
    assert.deepEqual(fs.readFileSync(path.join(value.root, '.git/index')), indexBefore);
    assert.equal(JSON.parse(fs.readFileSync(path.join(value.root, 'package.json'))).version, '9.9.9.9');
    assert.equal(value.git(['rev-parse', 'HEAD']), value.expectedOid);
});

const loadedValidator = path.join(project, 'dist-server/scripts/lib/source-update-activation.mjs');
test('intent binds operation before installation and on every sealed replay', async t => {
    for (const mode of ['before-build', 'after-build', 'manifest', 'missing-intent', 'changed-intent']) {
        const value = { ...fixture(t), operationBinding: { approvalReference: 'fixture-approved' } };
        const prepared = await prepareLocalSourceRecoveryCandidate(value), operations = builds(value);
        const plan = readCandidatePlan(prepared.planFile, { root: value.root });
        if (mode === 'after-build' || mode === 'manifest') await buildLocalSourceRecoveryCandidate(prepared.planFile, operations);
        if (mode === 'missing-intent') fs.unlinkSync(path.join(plan.candidateRoot, 'local-source-intent.json'));
        else if (mode === 'changed-intent') fs.writeFileSync(path.join(plan.candidateRoot, 'local-source-intent.json'), '{}');
        else {
            const file = mode === 'manifest' ? plan.outputs.manifest : prepared.planFile;
            const record = JSON.parse(fs.readFileSync(file));
            record.operationBinding.approvalReference = 'changed'; fs.writeFileSync(file, JSON.stringify(record));
        }
        await assert.rejects(buildLocalSourceRecoveryCandidate(prepared.planFile, operations), /intent_changed|ENOENT|manifest_identity_changed/);
        assert.equal(operations.installs, mode === 'after-build' || mode === 'manifest' ? 1 : 0);
    }
});

test('the actually loaded source-activation validator accepts truthful local worktree provenance', { skip: !fs.existsSync(loadedValidator) }, async t => {
    const value = fixture(t), prepared = await prepareLocalSourceRecoveryCandidate(value);
    const receipt = await buildLocalSourceRecoveryCandidate(prepared.planFile, builds(value));
    const { validateCandidate } = await import(loadedValidator);
    const validation = validateCandidate({ projectRoot: value.root, candidateRoot: path.dirname(prepared.planFile),
        transactionId: value.txId, releaseCommit: value.expectedOid, version: receipt.version,
        manifestPath: receipt.manifestPath, manifestSha256: receipt.manifestSha256 });
    assert.equal(validation.manifest.sourceProvenance.kind, 'git-worktree');
    assert.equal(validation.manifest.localSource.oid, value.expectedOid);
});

test('the Git metadata exception admits only its regular .git file, not extra files or aliases', async t => {
    for (const mode of ['extra', 'symlink']) {
        const value = fixture(t), prepared = await prepareLocalSourceRecoveryCandidate(value);
        const plan = readCandidatePlan(prepared.planFile, { root: value.root });
        if (mode === 'extra') fs.writeFileSync(path.join(plan.sourceRoot, 'foreign-input'), 'not a Git blob');
        else {
            fs.renameSync(path.join(plan.sourceRoot, '.git'), path.join(plan.candidateRoot, 'git-pointer'));
            fs.symlinkSync(path.join(plan.candidateRoot, 'git-pointer'), path.join(plan.sourceRoot, '.git'));
        }
        await assert.rejects(buildLocalSourceRecoveryCandidate(prepared.planFile, builds(value)), /unexpected_source_entry|unsafe_git_metadata/);
    }
});

test('worktree backpointer, common repository and detached HEAD are mandatory before npm', async t => {
    for (const mode of ['backpointer', 'commondir', 'branch', 'foreign-gitdir']) {
        const value = fixture(t), prepared = await prepareLocalSourceRecoveryCandidate(value);
        const plan = readCandidatePlan(prepared.planFile, { root: value.root });
        const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: plan.sourceRoot, encoding: 'utf8' }).trim();
        if (mode === 'backpointer') fs.writeFileSync(path.join(gitDir, 'gitdir'), `${value.root}/.git\n`);
        if (mode === 'commondir') fs.writeFileSync(path.join(gitDir, 'commondir'), `${gitDir}\n`);
        if (mode === 'branch') fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
        if (mode === 'foreign-gitdir') fs.writeFileSync(path.join(plan.sourceRoot, '.git'), `gitdir: ${value.root}/.git\n`);
        const operations = builds(value);
        await assert.rejects(buildLocalSourceRecoveryCandidate(prepared.planFile, operations));
        assert.equal(operations.installs, 0);
    }
});

test('failed installation leaves live trees untouched and refuses to rebuild interrupted candidate outputs', async t => {
    const value = fixture(t), prepared = await prepareLocalSourceRecoveryCandidate(value);
    const before = hashTree(path.join(value.root, 'node_modules'));
    await assert.rejects(buildLocalSourceRecoveryCandidate(prepared.planFile, builds(value, { failAfterInstall: true })), /fixture_install_failed/);
    assert.deepEqual(hashTree(path.join(value.root, 'node_modules')), before);
    await assert.rejects(buildLocalSourceRecoveryCandidate(prepared.planFile, builds(value)), /unexpected_source_entry/);
});

test('local candidate refuses source mutations and advancement of main during installation', async t => {
    for (const mode of ['source', 'main']) {
        const value = fixture(t), prepared = await prepareLocalSourceRecoveryCandidate(value);
        const operations = builds(value, { afterInstall(source) {
            if (mode === 'source') fs.writeFileSync(path.join(source, 'package-lock.json'), '{"changed":true}');
            else value.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'advanced']);
        } });
        await assert.rejects(buildLocalSourceRecoveryCandidate(prepared.planFile, operations), /source_changed|target_changed/);
    }
});

test('sealed candidate replay refuses altered trees or immutable registration receipt', async t => {
    const value = fixture(t), prepared = await prepareLocalSourceRecoveryCandidate(value);
    await buildLocalSourceRecoveryCandidate(prepared.planFile, builds(value));
    const plan = readCandidatePlan(prepared.planFile, { root: value.root });
    const file = path.join(plan.outputs.client, 'index.html');
    fs.writeFileSync(file, 'tampered');
    assert.throws(() => readPreparedLocalRecoveryCandidate(prepared.planFile, { root: value.root }), /candidate_tree_changed/);
    fs.writeFileSync(file, 'candidate client');
    fs.writeFileSync(path.join(plan.candidateRoot, 'local-source-recovery-receipt.json'), '{}');
    assert.throws(() => readPreparedLocalRecoveryCandidate(prepared.planFile, { root: value.root }), /durable_record_conflict/);
});

test('invalid authority markers, resource pressure and target changes fail before installation', async t => {
    const value = fixture(t);
    await assert.rejects(prepareLocalSourceRecoveryCandidate({ ...value, expectedOid: 'a'.repeat(40) }), /target_changed/);
    await assert.rejects(prepareLocalSourceRecoveryCandidate(value, { resourcesSafe: () => false }), /resources_busy/);
    const prepared = await prepareLocalSourceRecoveryCandidate(value);
    const raw = JSON.parse(fs.readFileSync(prepared.planFile));
    raw.localSource.ref = 'refs/heads/unmerged';
    fs.writeFileSync(prepared.planFile, JSON.stringify(raw));
    assert.throws(() => readCandidatePlan(prepared.planFile, { root: value.root }), /Local recovery source identity/);
});
