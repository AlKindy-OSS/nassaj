/**
 * ADR-156 ب.6 / WI-14 (T-1729) — `doctor.mjs --reopen-gate`.
 *
 * The 2026-09-11 outage was cleared by hand-editing `journal.json` through a
 * throwaway script. These tests pin the replacement's two hard properties: it
 * writes only under an explicit `--yes`, and it never writes at all from a run
 * context that would make the verdict a false green.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createUpdateMaintenanceGate } from '../server/services/update-maintenance-gate.js';
import { hashTree } from './lib/source-update-tree-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.mjs');
const GENERATIONS = { client: 'dist', server: 'dist-server', nodeModules: 'node_modules' };
const TRANSACTION = 'update-transaction-1234';

/** Stub `pm2` and `git` on PATH, exactly as the preflight test does. */
function stubBin(t, { pm2Account, pm2Unavailable = false }) {
    const bin = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-reopen-bin-'));
    t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
    const jlist = JSON.stringify(pm2Unavailable ? [] : [{ name: 'nassaj-dev', pm2_env: { pm_cwd: ROOT, USER: pm2Account } }]);
    fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\n[ "$1" = jlist ] && echo '${jlist}'\n`, { mode: 0o755 });
    // The gate reads the node's own git; the stub must forward, not lie, or the
    // source state it reports would be fabricated.
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nexec ${execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()} "$@"\n`, { mode: 0o755 });
    return bin;
}

/** A node stopped exactly where automatic rollback throws (B-1054's shape). */
async function crashedNode(t, { sourceAt = 'target' } = {}) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-reopen-node-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(root, 'shipped.txt'), 'original\n');
    git('add', 'shipped.txt');
    git('commit', '-q', '-m', 'original');
    const originalHead = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'shipped.txt'), 'target\n');
    git('add', 'shipped.txt');
    git('commit', '-q', '-m', 'target');
    const targetCommit = git('rev-parse', 'HEAD');
    if (sourceAt === 'mixed') fs.writeFileSync(path.join(root, 'shipped.txt'), 'original\n');
    for (const directory of Object.values(GENERATIONS)) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
        fs.writeFileSync(path.join(root, directory, 'marker'), `live-${directory}\n`);
    }

    const gate = createUpdateMaintenanceGate({
        projectPath: root,
        ownerAlive: () => false,
        recoveryRunner: async () => { throw new Error('Activation manifest digest mismatch.'); },
    });
    const candidateRoot = path.join(gate.paths.controlRoot, 'candidates', TRANSACTION);
    fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
    const manifest = `${JSON.stringify({
        schemaVersion: 1, txId: TRANSACTION, releaseCommit: targetCommit,
        trees: Object.fromEntries(Object.keys(GENERATIONS).map((name) => [name, { sha256: `${name}-target`, files: 1 }])),
    }, null, 2)}\n`;
    fs.writeFileSync(path.join(candidateRoot, 'candidate-manifest.json'), manifest, { mode: 0o600 });
    fs.chmodSync(path.join(candidateRoot, 'candidate-manifest.json'), 0o600);
    const steps = Object.fromEntries(Object.keys(GENERATIONS).map((name) => [
        name, { state: 'exchanged', previous: hashTree(path.join(root, GENERATIONS[name])) },
    ]));
    const receipt = path.join(candidateRoot, 'activation-receipt.json');
    fs.writeFileSync(receipt, `${JSON.stringify({ schemaVersion: 1, txId: TRANSACTION, state: 'activating', steps }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(receipt, 0o600);

    const update = await gate.beginUpdate({
        transactionId: TRANSACTION, expectedVersion: '1.47.0.11', originalHead, targetCommit,
        manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'),
    }, { waitMs: 100 });
    update.transition(['PREPARED'], 'SOURCE_APPLIED');
    update.release();
    // Leave the node in MANUAL, which is where 2026-09-11 left it: a receipt the
    // gate refuses to trust blocks the automatic exit path, so recovery gives
    // up. Restoring the mode afterwards is the operator's half of the fix, and
    // is exactly the state `--reopen-gate` exists to finish.
    fs.chmodSync(receipt, 0o644);
    assert.equal((await gate.recoverOrDeclareManual({ waitMs: 100 })).state, 'MANUAL');
    fs.chmodSync(receipt, 0o600);
    return { root, journal: gate.paths.journal, originalHead };
}

const runDoctor = (bin, node, extra = []) => spawnSync(process.execPath, [DOCTOR, '--reopen-gate', '--project', node.root, ...extra], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
});

const sequenceOf = (node) => JSON.parse(fs.readFileSync(node.journal, 'utf8')).sequence;

test('without --yes the plan is printed and nothing at all is written', async (t) => {
    const node = await crashedNode(t);
    const before = sequenceOf(node);
    const result = runDoctor(stubBin(t, { pm2Account: os.userInfo().username }), node);
    assert.match(result.stdout, /state=MANUAL gateClosed=true/);
    assert.match(result.stdout, /after: state=OPEN gateClosed=false degraded=source_tree_at_target/);
    assert.match(result.stdout, /exit path: complete_source_rollback_or_pin_release_ref/);
    assert.match(result.stdout, /re-run with --yes/);
    assert.equal(sequenceOf(node), before, 'a plan run must not move the journal');
    assert.equal(fs.existsSync(path.join(node.root, '.artifacts')), false);
    assert.equal(result.status, 0);
});

test('--yes copies the journal into .artifacts before it touches the gate', async (t) => {
    const node = await crashedNode(t);
    const before = fs.readFileSync(node.journal, 'utf8');
    const result = runDoctor(stubBin(t, { pm2Account: os.userInfo().username }), node, ['--yes']);
    assert.match(result.stdout, /gate reopened/);
    assert.equal(result.status, 0);
    const copies = fs.readdirSync(path.join(node.root, '.artifacts'));
    assert.equal(copies.length, 1);
    const copy = path.join(node.root, '.artifacts', copies[0]);
    assert.equal(fs.readFileSync(copy, 'utf8'), before, 'the copy must be the PRE-touch journal');
    assert.equal(fs.lstatSync(copy).mode & 0o777, 0o600);
    const after = JSON.parse(fs.readFileSync(node.journal, 'utf8'));
    assert.equal(after.state, 'OPEN');
    assert.equal(after.degraded, 'source_tree_at_target');
});

test('a run by the wrong pm2 account writes nothing, even with --yes', async (t) => {
    const node = await crashedNode(t);
    const before = sequenceOf(node);
    const result = runDoctor(stubBin(t, { pm2Account: 'someone-else' }), node, ['--yes']);
    assert.match(result.stdout, /FALSE GREEN/);
    assert.match(result.stdout, /UNTRUSTED/);
    assert.equal(result.status, 1);
    assert.equal(sequenceOf(node), before);
    assert.equal(fs.existsSync(path.join(node.root, '.artifacts')), false);
});

test('an unverifiable pm2 service account is refused the write as well', async (t) => {
    const node = await crashedNode(t);
    const before = sequenceOf(node);
    const result = runDoctor(stubBin(t, { pm2Account: 'nobody', pm2Unavailable: true }), node, ['--yes']);
    assert.match(result.stdout, /cannot be verified/);
    assert.equal(result.status, 1);
    assert.equal(sequenceOf(node), before);
});

test('a half-applied source tree has no exit path, so --yes still writes nothing', async (t) => {
    const node = await crashedNode(t, { sourceAt: 'mixed' });
    const before = sequenceOf(node);
    const result = runDoctor(stubBin(t, { pm2Account: os.userInfo().username }), node, ['--yes']);
    assert.match(result.stdout, /no defined exit path/);
    assert.match(result.stdout, /update_reopen_source_tree_mixed/);
    assert.equal(sequenceOf(node), before);
    assert.equal(fs.existsSync(path.join(node.root, '.artifacts')), false);
});

test('--complete-source-rollback plans without --yes, then returns the tree and clears degraded (H3)', async (t) => {
    const node = await crashedNode(t);
    const bin = stubBin(t, { pm2Account: os.userInfo().username });
    assert.equal(runDoctor(bin, node, ['--yes']).status, 0, 'the degraded reopen comes first');
    const degraded = JSON.parse(fs.readFileSync(node.journal, 'utf8'));
    assert.equal(degraded.degraded, 'source_tree_at_target');
    const shipped = () => fs.readFileSync(path.join(node.root, 'shipped.txt'), 'utf8');

    const planned = runDoctor(bin, node, ['--complete-source-rollback']);
    assert.equal(planned.status, 0, planned.stdout);
    assert.match(planned.stdout, /after: state=OPEN gateClosed=false degraded=none/);
    assert.match(planned.stdout, /source paths to restore: 1/);
    assert.match(planned.stdout, /--complete-source-rollback --yes/);
    assert.equal(sequenceOf(node), degraded.sequence, 'a plan run must not move the journal');
    assert.equal(shipped(), 'target\n', 'nor the source tree');

    const applied = runDoctor(bin, node, ['--complete-source-rollback', '--yes']);
    assert.equal(applied.status, 0, applied.stdout);
    assert.match(applied.stdout, /source rolled back, gate fully reopened/);
    assert.equal(shipped(), 'original\n');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: node.root, encoding: 'utf8' }).trim(), node.originalHead);
    const after = JSON.parse(fs.readFileSync(node.journal, 'utf8'));
    assert.equal(after.state, 'OPEN');
    assert.equal(after.gateClosed, false);
    assert.equal(after.degraded, null);
    assert.equal(after.transactionId, null);
    assert.equal(fs.readdirSync(path.join(node.root, '.artifacts')).length, 2, 'one pre-touch journal copy per write');
});

test('--complete-source-rollback on a gate that is not degraded has no exit path and writes nothing (H3)', async (t) => {
    const node = await crashedNode(t, { sourceAt: 'mixed' });
    const before = sequenceOf(node);
    const result = runDoctor(stubBin(t, { pm2Account: os.userInfo().username }), node, ['--complete-source-rollback', '--yes']);
    assert.match(result.stdout, /no defined exit path/);
    assert.match(result.stdout, /source_rollback_not_degraded/);
    assert.equal(sequenceOf(node), before);
    assert.equal(fs.existsSync(path.join(node.root, '.artifacts')), false);
});

test('--complete-source-rollback from the wrong pm2 account writes nothing, even with --yes (H3)', async (t) => {
    const node = await crashedNode(t);
    const own = stubBin(t, { pm2Account: os.userInfo().username });
    assert.equal(runDoctor(own, node, ['--yes']).status, 0);
    const before = sequenceOf(node);
    const result = runDoctor(stubBin(t, { pm2Account: 'someone-else' }), node, ['--complete-source-rollback', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /UNTRUSTED/);
    assert.equal(sequenceOf(node), before);
    assert.equal(fs.readFileSync(path.join(node.root, 'shipped.txt'), 'utf8'), 'target\n');
});

test('the writer primitives live in the lib, never in doctor.mjs itself', () => {
    const lib = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'doctor-reopen-gate.mjs'), 'utf8');
    assert.match(lib, /openSync\(file, 'wx', 0o600\)/, 'the journal copy is the only file this lib creates');
    assert.match(fs.readFileSync(DOCTOR, 'utf8'), /Contract: READ-ONLY/);
});
