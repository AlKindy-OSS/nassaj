/**
 * ADR-216 §6 test 9 — two real processes, real flock(2).
 *
 * Every holder here is a separate Node process (release-branch-attach.test-child.mjs)
 * or the doctor CLI itself, so the exclusion is proven across processes, not by
 * an in-process mutex.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createUpdateMaintenanceGate } from '../../server/services/update-maintenance-gate.js';

import { createAttachGit, runReleaseAttachment } from './release-branch-attach.mjs';
import {
    GITHUB_REMOTE, cloneFedora, createRemote, git, idleQuiescence, remoteEnv, scratch, tryGit,
} from './release-branch-attach.test-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CHILD = path.join(HERE, 'release-branch-attach.test-child.mjs');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.mjs');

const controlRootOf = (node) => path.join(node, '.git', 'nassaj-source-update');
const gateOf = (node) => createUpdateMaintenanceGate({ projectPath: node });

function fedora(t, prefix, { delaySeconds = 0 } = {}) {
    const root = scratch(t, prefix);
    const remote = createRemote(root);
    const node = cloneFedora(root, remote.bare);
    const env = { ...remoteEnv(root, remote.bare, { delaySeconds }), DATABASE_PATH: path.join(root, 'absent.db') };
    gateOf(node); // the gate's control files exist before any child takes a lock
    return { root, remote, node, env, run: createAttachGit({ appRoot: node, env }) };
}

/** Start a lock-holding child and resolve once it prints `ready`. */
function startChild(t, mode, node, env = process.env) {
    const child = spawn(process.execPath, [CHILD, mode, node], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stopped = false;
    const stop = () => new Promise((resolve) => {
        if (stopped || child.exitCode !== null) { resolve(); return; }
        stopped = true;
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
    });
    t.after(stop);
    return new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
            output += chunk;
            if (output.includes('ready')) resolve({ stop, child });
        });
        child.once('exit', (code) => reject(new Error(`child ${mode} exited ${code}`)));
    });
}

/** A PATH whose pm2 reports this repository as run by the current account (doctor's run-context check). */
function stubPm2(t) {
    const bin = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-attach-bin-'));
    t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
    const jlist = JSON.stringify([{ name: 'nassaj-dev', pm2_env: { pm_cwd: ROOT, USER: os.userInfo().username } }]);
    fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\n[ "$1" = jlist ] && echo '${jlist}'\n`, { mode: 0o755 });
    return bin;
}

function runDoctor(t, args, env) {
    const bin = stubPm2(t);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [DOCTOR, ...args], {
            env: { ...env, PATH: `${bin}:${env.PATH || process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stdout += chunk; });
        child.once('exit', (status) => resolve({ status, stdout }));
    });
}

function attach(ctx, overrides = {}) {
    return runReleaseAttachment({
        appRoot: ctx.node, controlRoot: controlRootOf(ctx.node), remote: 'origin', branch: 'main',
        configuredRemoteUrl: GITHUB_REMOTE, git: ctx.run,
        acquireLease: (options) => gateOf(ctx.node).acquireExclusiveSourceRefLease(options),
        readQuiescence: idleQuiescence(), ...overrides,
    });
}

test('9a a shared writer in another process refuses the attach lease within ~1 s, with no write', async (t) => {
    const ctx = fedora(t, 'writer');
    await startChild(t, 'writer-lease', ctx.node);
    const started = Date.now();
    await assert.rejects(gateOf(ctx.node).acquireExclusiveSourceRefLease(), { message: 'source_attach_writers_active' });
    assert.ok(Date.now() - started < 2500, `refused after ${Date.now() - started} ms`);
    const result = await attach(ctx);
    assert.equal(result.code, 'source_attach_writers_active');
    assert.equal(tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false);
    assert.equal(tryGit(ctx.node, ['rev-parse', '--verify', '-q', 'refs/heads/main']).ok, false);
});

test('9b an attach lease in another process blocks writer leases, beginUpdate and the prestager until released', async (t) => {
    const ctx = fedora(t, 'holder');
    const holder = await startChild(t, 'attach-lease', ctx.node);
    const gate = gateOf(ctx.node);
    await assert.rejects(gate.acquireWriterLease({ kind: 'source-update-stage', waitMs: 300 }), { message: 'update_lock_contended' });
    await assert.rejects(gate.acquireWriterLease({ kind: 'source-update-prestage', waitMs: 300 }), { message: 'update_lock_contended' });
    const head = git(ctx.node, ['rev-parse', 'HEAD']);
    await assert.rejects(gate.beginUpdate({ transactionId: 'update-transaction-1234', originalHead: head, targetCommit: head,
        expectedVersion: '9.1.0.2' }, { waitMs: 300 }), { message: 'update_lock_contended' });
    await assert.rejects(gate.acquireExclusiveSourceRefLease({ waitMs: 300 }), { message: 'update_maintenance_active' });
    assert.equal(gate.readPublicStatus().state, 'OPEN', 'the journal was never touched');
    await holder.stop();
    const lease = await gate.acquireWriterLease({ kind: 'source-update-stage', waitMs: 2000 });
    lease.release();
});

test('9c doctor --revert-release-attach while an activation holds the exclusive locks: refused, HEAD untouched', async (t) => {
    const ctx = fedora(t, 'revert-busy');
    const attached = await attach(ctx);
    assert.equal(attached.ok, true, attached.code);
    await startChild(t, 'exclusive', ctx.node);
    const outcome = await runDoctor(t, ['--revert-release-attach', attached.receiptPath, '--yes', '--project', ctx.node], ctx.env);
    assert.equal(outcome.status, 1, outcome.stdout);
    assert.match(outcome.stdout, /update_maintenance_active/);
    assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
});

test('9d two concurrent attach CLIs: one wins, the other is refused source_attach_in_progress', async (t) => {
    const ctx = fedora(t, 'two-cli', { delaySeconds: 2 });
    const args = ['--attach-release-branch', '--yes', '--project', ctx.node];
    const [first, second] = await Promise.all([runDoctor(t, args, ctx.env), runDoctor(t, args, ctx.env)]);
    const outcomes = [first, second].sort((a, b) => a.status - b.status);
    assert.equal(outcomes[0].status, 0, outcomes[0].stdout);
    assert.equal(outcomes[1].status, 1, outcomes[1].stdout);
    assert.match(outcomes[1].stdout, /source_attach_in_progress/);
    assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
});

test('9d+ doctor without --yes inspects only; with --yes it attaches and the revert restores', async (t) => {
    const ctx = fedora(t, 'cli');
    const dry = await runDoctor(t, ['--attach-release-branch', '--project', ctx.node], ctx.env);
    assert.equal(dry.status, 0, dry.stdout);
    assert.match(dry.stdout, /Nothing was fetched or written/);
    assert.equal(tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false);
    const applied = await runDoctor(t, ['--attach-release-branch', '--yes', '--project', ctx.node], ctx.env);
    assert.equal(applied.status, 0, applied.stdout);
    // eslint-disable-next-line no-control-regex -- strip the doctor's ANSI colours
    const receipt = /receipt: (\S+)/.exec(applied.stdout.replace(/\u001b\[[0-9;]*m/g, ''))?.[1];
    assert.ok(receipt, applied.stdout);
    const reverted = await runDoctor(t, ['--revert-release-attach', receipt, '--yes', '--project', ctx.node], ctx.env);
    assert.equal(reverted.status, 0, reverted.stdout);
    assert.equal(tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false, 'detached again');
});

test('9f a shared holder started during a slow fetch is never blocked; the exclusive hold stays under 1 s', async (t) => {
    const ctx = fedora(t, 'slow', { delaySeconds: 3 });
    const running = attach(ctx);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const started = Date.now();
    const writer = await startChild(t, 'writer-lease', ctx.node);
    assert.ok(Date.now() - started < 1500, `the shared holder waited ${Date.now() - started} ms`);
    await writer.stop();
    const result = await running;
    assert.equal(result.ok, true, result.code);
    assert.ok(result.exclusiveHoldMs < 1000, `exclusive hold ${result.exclusiveHoldMs} ms`);
    execFileSync('git', ['-C', ctx.node, 'fsck', '--no-progress']);
});
