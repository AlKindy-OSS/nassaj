/** T-2024 S2 (ADR-207 §3.3, C3): verified kill of a prestage build group, with real processes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
    currentProcessIdentity, isCurrentProcess, isProcessIdentityAlive, isValidEffectIdentity, killVerifiedBuildGroup, linuxProc,
} from './update-prestage-process-group.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function members(pgid) {
    return linuxProc.listPids().filter((pid) => {
        const stat = linuxProc.stat(pid);
        return stat && stat.pgid === pgid && stat.state !== 'Z';
    });
}

/** A detached group like the effect launcher's: a leader and two background children. */
async function liveGroup(t) {
    const child = spawn('bash', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
    for (let attempt = 0; attempt < 200 && members(child.pid).length < 3; attempt += 1) await sleep(5);
    assert.equal(members(child.pid).length, 3);
    const effect = { pid: child.pid, pgid: child.pid, startTicks: linuxProc.stat(child.pid).startTicks, bootId: linuxProc.bootId() };
    return { child, effect };
}

test('a live build group is killed, every member, and verified gone', async (t) => {
    const { effect } = await liveGroup(t);
    const result = await killVerifiedBuildGroup(effect);
    assert.deepEqual(result, { verified: true, killed: 3, reason: 'killed' });
    assert.deepEqual(members(effect.pgid), []);
});

test('pid reuse: a leader pid with other startTicks kills nothing and still verifies', async (t) => {
    const { child, effect } = await liveGroup(t);
    const kills = [];
    const reused = { ...effect, startTicks: String(BigInt(effect.startTicks) + 1n) };
    const result = await killVerifiedBuildGroup(reused, { kill: (pid) => kills.push(pid) });
    assert.deepEqual(result, { verified: true, killed: 0, reason: 'pid_reused' });
    assert.deepEqual(kills, []);
    assert.equal(members(child.pid).length, 3, 'the unrelated group is untouched');
});

test('another boot id kills nothing: that boot is over', async (t) => {
    const { child, effect } = await liveGroup(t);
    const result = await killVerifiedBuildGroup({ ...effect, bootId: 'another-boot' });
    assert.deepEqual(result, { verified: true, killed: 0, reason: 'other_boot' });
    assert.equal(members(child.pid).length, 3);
});

test('a group whose leader is gone has its surviving members killed', async (t) => {
    const child = spawn('bash', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' });
    const startTicks = linuxProc.stat(child.pid)?.startTicks;
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
    await new Promise((resolve) => child.once('exit', resolve));
    for (let attempt = 0; attempt < 200 && linuxProc.stat(child.pid); attempt += 1) await sleep(5);
    assert.equal(members(child.pid).length, 1, 'the orphaned sleep keeps the group');
    const result = await killVerifiedBuildGroup({ pid: child.pid, pgid: child.pid, startTicks, bootId: linuxProc.bootId() });
    assert.deepEqual(result, { verified: true, killed: 1, reason: 'killed' });
});

test('a member that survives SIGKILL leaves the group unverified', async (t) => {
    const { effect } = await liveGroup(t);
    const result = await killVerifiedBuildGroup(effect, { kill: () => {}, waitMs: 30 });
    assert.deepEqual(result, { verified: false, killed: 3, reason: 'group_survived' });
});

test('own group, invalid and absent effects', async () => {
    const own = { pid: 999_999, pgid: linuxProc.stat(process.pid).pgid, startTicks: '1', bootId: linuxProc.bootId() };
    assert.deepEqual(await killVerifiedBuildGroup(own), { verified: false, killed: 0, reason: 'own_group' });
    assert.deepEqual(await killVerifiedBuildGroup({ pid: 1, pgid: 1, startTicks: 'x', bootId: '' }),
        { verified: false, killed: 0, reason: 'effect_invalid' });
    assert.deepEqual(await killVerifiedBuildGroup(null), { verified: true, killed: 0, reason: 'no_effect' });
    assert.equal(isValidEffectIdentity({ pid: 10, pgid: 10, startTicks: '42', bootId: 'b' }), true);
});

test('process identity: self, alive and dead identities', async (t) => {
    const self = currentProcessIdentity();
    assert.equal(isCurrentProcess(self), true);
    assert.equal(isProcessIdentityAlive(self), true);
    assert.equal(isProcessIdentityAlive({ ...self, startTicks: '1' }), false);
    assert.equal(isProcessIdentityAlive({ ...self, bootId: 'other' }), false);
    const { child, effect } = await liveGroup(t);
    assert.equal(isCurrentProcess({ pid: child.pid, startTicks: effect.startTicks, bootId: effect.bootId }), false);
    assert.equal(isProcessIdentityAlive({ pid: child.pid, startTicks: effect.startTicks, bootId: effect.bootId }), true);
});
