/**
 * ADR-156 WI-13 (T-1728) — what the write-free plan (qa-critic H1) must refuse.
 *
 * `planDirection` promises that "every reason the write could stop half way is
 * decided here, before its first byte". These tests hold it to that promise
 * with obstacles on the real filesystem, and check that the refusal really
 * comes before any write.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { applySourceManifest, planSourceManifest } from './source-update-activation.mjs';

function scratchParent() {
    const candidate = process.env.TMPDIR || '/var/tmp';
    try { if (Number(statfsSync(candidate).type) !== 0x01021994) return candidate; } catch { /* default below */ }
    return '/var/tmp';
}

/** original: a.txt; target: a.txt modified and added.txt added. */
function repository(t) {
    const root = mkdtempSync(path.join(scratchParent(), 'nassaj-plan-gaps-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    writeFileSync(path.join(root, 'a.txt'), 'a-original\n');
    git('add', '-A'); git('commit', '-q', '-m', 'original');
    const originalHead = git('rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'a.txt'), 'a-target\n');
    writeFileSync(path.join(root, 'added.txt'), 'added\n');
    git('add', '-A'); git('commit', '-q', '-m', 'target');
    const targetCommit = git('rev-parse', 'HEAD');
    git('reset', '-q', '--hard', originalHead);
    return { root, originalHead, targetCommit };
}

test('a directory holding a foreign file where the release installs a file is refused by the plan', (t) => {
    const repo = repository(t);
    mkdirSync(path.join(repo.root, 'added.txt'));
    writeFileSync(path.join(repo.root, 'added.txt', 'foreign'), 'x');
    assert.throws(() => planSourceManifest({ projectRoot: repo.root, ...repo }), /path is occupied: added\.txt/);
});

/*
 * B-1128 (found by this test, T-1728). An EMPTY directory at a path the release
 * adds as a file used to pass the plan: nothing schedules an empty directory
 * for removal, so the apply wrote a.txt, then `renameSync` onto 'added.txt'
 * failed with EISDIR and leaked its temporary. `firstOccupant` now counts an
 * empty directory as an occupant, so the plan refuses before any write.
 */
test('an empty directory where the release installs a file is refused before any write', (t) => {
    const repo = repository(t);
    mkdirSync(path.join(repo.root, 'added.txt'));
    let planned = null;
    try { planned = planSourceManifest({ projectRoot: repo.root, ...repo }); } catch (error) { planned = error; }
    if (!(planned instanceof Error)) {
        let applied = null;
        try { applySourceManifest({ projectRoot: repo.root, ...repo }); } catch (error) { applied = error; }
        const written = readFileSync(path.join(repo.root, 'a.txt'), 'utf8') === 'a-target\n';
        const leaked = existsSync(path.join(repo.root, `added.txt.nassaj-update-${process.pid}`));
        assert.fail(`the plan accepted it; apply then failed (${applied?.code || applied?.message}) `
            + `after writing a.txt=${written}, leaking its temporary=${leaked}`);
    }
    assert.equal(readFileSync(path.join(repo.root, 'a.txt'), 'utf8'), 'a-original\n');
});
