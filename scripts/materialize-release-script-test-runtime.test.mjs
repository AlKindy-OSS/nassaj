import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { materializeReleaseScriptTestRuntime, moveCandidateNoClobber }
    from './materialize-release-script-test-runtime.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const COMMIT = 'a'.repeat(40); const VERSION = '1.46.0.3';

function fixture(t) {
    const sourceRoot = mkdtempSync(path.join(TEMP, 'release-script-materialize-'));
    t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
    return { sourceRoot, candidateRoot: path.join(sourceRoot, '.release-script-test-candidate'),
        targetRoot: path.join(sourceRoot, 'dist-server'), commit: COMMIT, version: VERSION };
}

function buildCandidate(options) {
    const entry = path.join(options.outputRoot, 'server/scripts/release-database-migration.js');
    mkdirSync(path.dirname(entry), { recursive: true }); writeFileSync(entry, 'export {};\n');
    writeFileSync(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({
        artifact: 'server', commit: options.releaseCommit, baseCommit: options.releaseCommit,
        version: options.version, dirty: false,
    }));
}

test('fresh exact candidate is renamed atomically into the fixed dist-server target', (t) => {
    const options = fixture(t);
    const result = materializeReleaseScriptTestRuntime(options, { build: buildCandidate });
    assert.equal(result.runtimeRoot, options.targetRoot);
    assert.equal(JSON.parse(readFileSync(path.join(options.targetRoot, 'BUILD_PROVENANCE.json'))).commit, COMMIT);
    assert.throws(() => readFileSync(options.candidateRoot), /ENOENT/);
});

test('existing target fails before build and a bad candidate is cleaned without materialization', (t) => {
    const occupied = fixture(t); mkdirSync(occupied.targetRoot); let built = false;
    assert.throws(() => materializeReleaseScriptTestRuntime(occupied, { build() { built = true; } }), /absent candidate and target/);
    assert.equal(built, false);
    const invalid = fixture(t);
    assert.throws(() => materializeReleaseScriptTestRuntime(invalid, { build(options) {
        mkdirSync(options.outputRoot); writeFileSync(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), '{}');
    } }), /missing server\/scripts\/release-database-migration\.js/);
    assert.throws(() => readFileSync(invalid.candidateRoot), /ENOENT/);
    assert.throws(() => readFileSync(invalid.targetRoot), /ENOENT/);
    const raced = fixture(t);
    assert.throws(() => materializeReleaseScriptTestRuntime(raced, { build: buildCandidate,
        move() { mkdirSync(raced.targetRoot); } }), /candidate remained after materialization/);
    assert.throws(() => readFileSync(raced.candidateRoot), /ENOENT/);
    assert.equal(lstatSync(raced.targetRoot).isDirectory(), true);
});

test('materialization requires portable mv no-copy and no-clobber capabilities', () => {
    const calls = [];
    moveCandidateNoClobber('/candidate/server', '/source/dist-server', { run(file, args) {
        calls.push([file, args]);
        return calls.length === 1 ? { status: 0, stdout: '--no-copy --no-clobber' } : { status: 0, stdout: '' };
    } });
    assert.deepEqual(calls[1], ['/usr/bin/mv', ['--no-copy', '--no-clobber', '-T',
        '/candidate/server', '/source/dist-server']]);
    assert.throws(() => moveCandidateNoClobber('/candidate/server', '/source/dist-server', {
        run() { return { status: 0, stdout: '--no-copy only' }; },
    }), /capability is unavailable/);
});
