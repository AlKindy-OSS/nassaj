#!/usr/bin/env node
/**
 * Tests for scripts/build-provenance.mjs.
 *
 * The load-bearing property is NOT the JSON shape — it is that the stamp never
 * costs a build. So the cases below cover: a real record describes this repo, a
 * DIRTY tree is declared rather than blocked (exit 0), and the CLI survives a
 * malformed --artifact argument.
 *
 * The CLI cases run inside a throwaway git repo, never against this checkout:
 * the script writes into dist/, and a test must not touch the artefact
 * directory a live server may be serving from.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectProvenance } from './build-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-provenance.mjs');

/**
 * Build a disposable git repo holding a copy of the script.
 * /var/tmp, never /tmp: /tmp on this host is tmpfs and every byte lands in RAM.
 */
function makeRepo() {
    const repo = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'provenance-'));
    const run = (...args) => execFileSync(args[0], args.slice(1), { cwd: repo, stdio: 'ignore' });
    run('git', 'init', '-q');
    run('git', 'config', 'user.email', 'test@example.com');
    run('git', 'config', 'user.name', 'test');
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    mkdirSync(path.join(repo, 'scripts'));
    copyFileSync(SCRIPT, path.join(repo, 'scripts', 'build-provenance.mjs'));
    // Commit the copy too, so the baseline repo is genuinely CLEAN and a test
    // that expects dirty:false is not measuring the test harness itself.
    run('git', 'add', 'package.json', 'scripts/build-provenance.mjs');
    run('git', 'commit', '-qm', 'init');
    // dist/ and dist-server/ are the script's own output; ignoring them keeps a
    // second run in the same repo from reading as a dirty tree.
    writeFileSync(path.join(repo, '.gitignore'), 'dist/\ndist-server/\n');
    run('git', 'add', '.gitignore');
    run('git', 'commit', '-qm', 'ignore build output');
    return repo;
}

/** Run the copied CLI in `repo`; returns its exit status (0 on success). */
function runCli(repo, args) {
    try {
        execFileSync(process.execPath, [path.join(repo, 'scripts', 'build-provenance.mjs'), ...args], {
            cwd: repo,
            stdio: 'ignore',
        });
        return 0;
    } catch (error) {
        return error.status;
    }
}

test('collectProvenance describes this repo', () => {
    const record = collectProvenance({ artifact: 'client', buildId: 'a'.repeat(64) });
    assert.equal(record.artifact, 'client');
    assert.match(record.commit, /^[0-9a-f]{40}$/);
    assert.equal(record.commitShort, record.commit.slice(0, 8));
    assert.equal(typeof record.dirty, 'boolean');
    assert.equal(typeof record.dirtyFiles, 'number');
    assert.equal(record.dirty, record.dirtyFiles > 0);
    assert.ok(!Number.isNaN(Date.parse(record.builtAt)));
    assert.equal(record.buildId, 'a'.repeat(64));
});

test('a dirty tree is declared, never blocked', () => {
    const repo = makeRepo();
    try {
        // An UNTRACKED file changes what a build produces, so it must count.
        writeFileSync(path.join(repo, 'untracked.txt'), 'x');
        assert.equal(runCli(repo, ['--artifact', 'client']), 0, 'a dirty tree must not fail the build');

        const record = JSON.parse(readFileSync(path.join(repo, 'dist', 'BUILD_PROVENANCE.json'), 'utf8'));
        assert.equal(record.dirty, true);
        assert.equal(record.dirtyFiles, 1);
        assert.equal(record.version, '9.9.9');
        assert.equal(record.commitShort, record.commit.slice(0, 8));
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test('a clean tree stamps dirty:false', () => {
    const repo = makeRepo();
    try {
        assert.equal(runCli(repo, ['--artifact', 'server']), 0);
        const record = JSON.parse(readFileSync(path.join(repo, 'dist-server', 'BUILD_PROVENANCE.json'), 'utf8'));
        assert.equal(record.artifact, 'server');
        assert.equal(record.dirty, false);
        assert.equal(record.dirtyFiles, 0);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test('the output override applies to server artefacts', () => {
    const repo = makeRepo();
    const output = path.join(repo, 'server-staging');
    try {
        execFileSync(process.execPath, [path.join(repo, 'scripts', 'build-provenance.mjs'), '--artifact', 'server'], {
            cwd: repo,
            env: { ...process.env, NASSAJ_PROVENANCE_OUT_DIR: output },
            stdio: 'ignore',
        });
        const record = JSON.parse(readFileSync(path.join(output, 'BUILD_PROVENANCE.json'), 'utf8'));
        assert.equal(record.artifact, 'server');
        assert.equal(record.version, '9.9.9');
        assert.equal(existsSync(path.join(repo, 'dist-server', 'BUILD_PROVENANCE.json')), false);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test('a malformed --artifact falls back to client instead of throwing', () => {
    const repo = makeRepo();
    try {
        assert.equal(runCli(repo, ['--artifact']), 0);
        const record = JSON.parse(readFileSync(path.join(repo, 'dist', 'BUILD_PROVENANCE.json'), 'utf8'));
        assert.equal(record.artifact, 'client');
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
