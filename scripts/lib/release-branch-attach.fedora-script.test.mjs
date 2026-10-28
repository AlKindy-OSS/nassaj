/**
 * ADR-216 §6 test 14 — the §4.3 option-1 one-time script, read verbatim from
 * the ADR and run with `bash -c` against a Fedora-shaped repository. Only the
 * `EXPECTED_REMOTE` literal is rewritten to the `file://` remote (the script
 * pins the remote literally, so it fetches from `origin` directly).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TAG, cloneFedora, createRemote, git, scratch, tryGit } from './release-branch-attach.test-fixture.mjs';

const ADR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs',
    'ADR-216-release-branch-checkout-and-reattach.md');
const SPEC = '+refs/heads/main:refs/remotes/origin/main';

/** The two bash blocks of §4.3: the attach script and the undo block. */
function adrScripts() {
    const text = fs.readFileSync(ADR, 'utf8');
    const section = text.slice(text.indexOf('#### 4.3'), text.indexOf('#### 4.4'));
    const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
    assert.equal(blocks.length, 2, 'the ADR keeps exactly the attach script and the undo block in §4.3');
    return { attach: blocks[0], undo: blocks[1] };
}

function scriptFor(remoteUrl, { inject = null } = {}) {
    let script = adrScripts().attach.replace(/^EXPECTED_REMOTE=.*$/m, `EXPECTED_REMOTE=${remoteUrl}`);
    if (inject) {
        const anchor = '[ -n "$OLD_MAIN" ] || $G update-ref refs/heads/main "$H" "$Z"';
        assert.ok(script.includes(anchor));
        script = script.replace(anchor, `${anchor}\n${inject}`);
    }
    return script;
}

/** The undo block exactly as written, with only its two placeholder values replaced. */
function undoFor(head, trackCreated) {
    const block = adrScripts().undo;
    assert.match(block, /^H=REPLACE_WITH_PRINTED_COMMIT$/m);
    assert.match(block, /^TRACK_CREATED=no$/m);
    return block.replace(/^H=REPLACE_WITH_PRINTED_COMMIT$/m, `H=${head}`)
        .replace(/^TRACK_CREATED=no$/m, `TRACK_CREATED=${trackCreated ? 'yes' : 'no'}`);
}

function runBash(cwd, script) {
    const env = { ...process.env };
    delete env.GIT_DIR;
    const result = spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** for-each-ref plus .git/config: what the script may change. */
function snapshot(node) {
    return { refs: git(node, ['for-each-ref', '--format=%(refname) %(objectname)']),
        config: fs.readFileSync(path.join(node, '.git', 'config'), 'utf8') };
}

function fedoraOverFile(t, prefix, remoteOptions = {}) {
    const root = scratch(t, prefix);
    const remote = createRemote(root, remoteOptions);
    const node = cloneFedora(root, remote.bare);
    const url = `file://${remote.bare}`;
    git(node, ['remote', 'set-url', 'origin', url]);
    return { root, remote, node, url };
}

const privateRefs = (node) => git(node, ['for-each-ref', 'refs/nassaj-attach']);
const refspecCount = (node) => git(node, ['config', '--get-all', 'remote.origin.fetch']).split('\n').filter((line) => line === SPEC).length;

test('14 the option-1 script reaches test 1\'s end state, survives an injected failure, and is idempotent', async (t) => {
    const ctx = fedoraOverFile(t, 'script');
    const shallow = fs.readFileSync(path.join(ctx.node, '.git', 'shallow'), 'utf8');

    const failed = runBash(ctx.node, scriptFor(ctx.url, { inject: 'fail "injected after the branch write"' }));
    assert.notEqual(failed.status, 0, failed.output);
    assert.equal(tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false, 'HEAD still detached');
    assert.equal(privateRefs(ctx.node), '');

    const rerun = runBash(ctx.node, scriptFor(ctx.url));
    assert.equal(rerun.status, 0, rerun.output);
    assert.match(rerun.output, /attached main at/);
    assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    assert.equal(git(ctx.node, ['rev-parse', 'HEAD']), ctx.remote.tagCommit);
    assert.equal(git(ctx.node, ['config', 'branch.main.merge']), 'refs/heads/main');
    assert.equal(git(ctx.node, ['rev-parse', 'refs/remotes/origin/main']), ctx.remote.mainTip);
    assert.equal(git(ctx.node, ['status', '--porcelain', '--untracked-files=no']), '');
    assert.equal(fs.readFileSync(path.join(ctx.node, '.git', 'shallow'), 'utf8'), shallow);
    assert.equal(privateRefs(ctx.node), '');
    git(ctx.node, ['fsck', '--no-progress']);

    const third = runBash(ctx.node, scriptFor(ctx.url));
    assert.equal(third.status, 0, third.output);
    assert.match(third.output, /already attached to main/);
    assert.equal(refspecCount(ctx.node), 1, 'the refspec appears once');
});

test('14 the undo block restores the pre-run refs and .git/config exactly', async (t) => {
    const ctx = fedoraOverFile(t, 'undo');
    const before = snapshot(ctx.node);
    const head = git(ctx.node, ['rev-parse', 'HEAD']);
    const run = runBash(ctx.node, scriptFor(ctx.url));
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /tracking ref created by this script/);
    const undo = runBash(ctx.node, undoFor(head, true));
    assert.equal(undo.status, 0, undo.output);
    assert.deepEqual(snapshot(ctx.node), before);
    assert.equal(tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false);
});

test('14 the undo block refuses before any write when run unedited or with a wrong commit', async (t) => {
    const ctx = fedoraOverFile(t, 'undo-guard');
    const run = runBash(ctx.node, scriptFor(ctx.url));
    assert.equal(run.status, 0, run.output);
    const attached = snapshot(ctx.node);
    for (const [label, script] of [
        ['unedited placeholder', adrScripts().undo],
        ['H not the current HEAD', undoFor(ctx.remote.mainTip, true)],
        ['H not a commit id', undoFor('zz', true)],
    ]) {
        const result = runBash(ctx.node, script);
        assert.notEqual(result.status, 0, `${label}: ${result.output}`);
        assert.match(result.output, /refused/, label);
        assert.deepEqual(snapshot(ctx.node), attached, `${label}: nothing changed`);
    }
});

test('14 every failing check leaves no residue', async (t) => {
    const commitBeside = (node) => git(node, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'beside']);
    const cases = [
        ['cwd is not the toplevel', /cwd is not the checkout root/, {}, (ctx) => { fs.mkdirSync(path.join(ctx.node, 'sub')); return { cwd: path.join(ctx.node, 'sub') }; }],
        ['remote is not the literal', /origin is not exactly/, {}, () => ({ url: 'file:///nonexistent/other.git' })],
        ['two remote URLs', /origin is not exactly/, {}, (ctx) => { git(ctx.node, ['config', '--add', 'remote.origin.url', 'file:///second.git']); }],
        ['HEAD on another branch', /HEAD is on refs\/heads\/other/, {}, (ctx) => { git(ctx.node, ['checkout', '-q', '-b', 'other']); }],
        ['dirty tree', /dirty tree/, {}, (ctx) => { fs.appendFileSync(path.join(ctx.node, 'README.md'), 'dirty\n'); }],
        ['lightweight tag', /is not annotated/, { lightweight: true }, null],
        ['HEAD is not the tag', /HEAD is not v/, {}, (ctx) => {
            git(ctx.node, ['update-ref', '--no-deref', 'HEAD', commitBeside(ctx.node)]);
        }],
        ['tag off main', /is not on main/, { topology: 'side' }, null],
        ['local main at another commit', /local main exists at/, {}, (ctx) => { git(ctx.node, ['update-ref', 'refs/heads/main', commitBeside(ctx.node)]); }],
        ['origin/main would rewind', /origin\/main would rewind/, {}, (ctx) => { git(ctx.node, ['update-ref', 'refs/remotes/origin/main', commitBeside(ctx.node)]); }],
        ['local lightweight tag, refused after the fetch', /local main exists at/, {}, (ctx) => {
            const head = git(ctx.node, ['rev-parse', 'HEAD']);
            git(ctx.node, ['tag', '-d', TAG]);
            git(ctx.node, ['tag', TAG, head]);
            git(ctx.node, ['update-ref', 'refs/heads/main', commitBeside(ctx.node)]);
        }],
        ['rerun with the branch refspec configured and origin/main would rewind', /origin\/main would rewind/, {}, (ctx) => {
            git(ctx.node, ['config', '--add', 'remote.origin.fetch', SPEC]);
            git(ctx.node, ['update-ref', 'refs/remotes/origin/main', commitBeside(ctx.node)]);
        }],
        ['fetch failure', /./, {}, (ctx) => {
            git(ctx.node, ['remote', 'set-url', 'origin', 'file:///nonexistent/remote.git']);
            return { url: 'file:///nonexistent/remote.git' };
        }],
    ];
    for (const [label, expected, remoteOptions, setup] of cases) {
        const ctx = fedoraOverFile(t, 'residue', remoteOptions);
        const options = setup?.(ctx) || {};
        const before = snapshot(ctx.node);
        const result = runBash(options.cwd || ctx.node, scriptFor(options.url || ctx.url));
        assert.notEqual(result.status, 0, `${label}: ${result.output}`);
        assert.match(result.output, expected, label);
        assert.deepEqual(snapshot(ctx.node), before, `${label}: residue`);
        assert.equal(privateRefs(ctx.node), '', `${label}: private ref left`);
    }
});
