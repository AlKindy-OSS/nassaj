/**
 * ADR-207 §3.3 (C3, T-2024 S2): process identity and the verified kill of a
 * prestage build group.
 *
 * A build runs inside the effect launcher, which is spawned detached, so its
 * pid is also its process-group id. The slot records `{pid, pgid, startTicks,
 * bootId}` of that leader. Before anything of a slot is deleted, every live
 * member of that group is killed with SIGKILL and waited for. Identity guards:
 *
 * - a different `bootId`: the recorded boot is over, nothing of it can run;
 * - pid reuse: when the recorded leader pid equals the pgid and a process with
 *   that pid exists with different `startTicks`, it is somebody else, and
 *   Linux keeps a pid allocated while any group still uses it as its pgid, so
 *   no member of the original group can exist either: nothing is killed;
 * - members started before the recorded leader are never ours;
 * - this process's own group is never killed.
 */
import fs from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TICKS = /^\d{1,20}$/;

/** `/proc/<pid>/stat` facts, or null when the process is gone or unreadable. */
function procStat(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
        return { pgid: Number(fields[2]), startTicks: fields[19], state: fields[0] };
    } catch {
        return null;
    }
}

function bootId() {
    try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; }
}

function listPids() {
    return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number);
}

/** The Linux `/proc` reader; tests inject a fake with the same shape. */
export const linuxProc = Object.freeze({ stat: procStat, bootId, listPids });

/** `{pid, startTicks, bootId}` of this process, the owner identity a slot records. */
export function currentProcessIdentity(proc = linuxProc) {
    return { pid: process.pid, startTicks: proc.stat(process.pid)?.startTicks ?? null, bootId: proc.bootId() };
}

/** True when `identity` names a process that is alive now (same boot, same start time). */
export function isProcessIdentityAlive(identity, proc = linuxProc) {
    if (!identity || identity.bootId !== proc.bootId()) return false;
    const observed = proc.stat(identity.pid);
    return Boolean(observed) && observed.state !== 'Z' && observed.startTicks === identity.startTicks;
}

/** True when `identity` is this very process. */
export function isCurrentProcess(identity, proc = linuxProc) {
    const self = currentProcessIdentity(proc);
    return Boolean(identity) && identity.pid === self.pid && identity.startTicks === self.startTicks
        && identity.bootId === self.bootId;
}

/** Shape check of a recorded build effect identity. */
export function isValidEffectIdentity(effect) {
    return Boolean(effect) && Number.isSafeInteger(effect.pid) && effect.pid > 1
        && Number.isSafeInteger(effect.pgid) && effect.pgid > 1
        && typeof effect.startTicks === 'string' && TICKS.test(effect.startTicks)
        && typeof effect.bootId === 'string' && effect.bootId.length > 0;
}

/** Live members of the recorded group that can belong to it (never this process). */
function groupMembers(effect, proc) {
    const floor = BigInt(effect.startTicks);
    const members = [];
    for (const pid of proc.listPids()) {
        if (pid === process.pid) continue;
        const observed = proc.stat(pid);
        if (!observed || observed.pgid !== effect.pgid || observed.state === 'Z') continue;
        if (TICKS.test(observed.startTicks) && BigInt(observed.startTicks) >= floor) members.push(pid);
    }
    return members;
}

/**
 * Kill every live member of a recorded build group and wait until none is left.
 * `verified: true` means no member of that identity can still run, so the
 * slot's files may be deleted; `false` means keep them and retry next cycle.
 * @param {{pid: number, pgid: number, startTicks: string, bootId: string} | null} effect
 * @param {{proc?: typeof linuxProc, kill?: (pid: number, signal: string) => void, waitMs?: number}} [options]
 * @returns {Promise<{verified: boolean, killed: number, reason: string}>}
 */
export async function killVerifiedBuildGroup(effect, { proc = linuxProc, kill = process.kill.bind(process), waitMs = 5_000 } = {}) {
    if (effect === null || effect === undefined) return { verified: true, killed: 0, reason: 'no_effect' };
    if (!isValidEffectIdentity(effect)) return { verified: false, killed: 0, reason: 'effect_invalid' };
    if (effect.bootId !== proc.bootId()) return { verified: true, killed: 0, reason: 'other_boot' };
    if (effect.pgid === proc.stat(process.pid)?.pgid) return { verified: false, killed: 0, reason: 'own_group' };
    const leader = proc.stat(effect.pgid);
    if (leader && effect.pid === effect.pgid && leader.startTicks !== effect.startTicks) {
        return { verified: true, killed: 0, reason: 'pid_reused' };
    }
    const members = groupMembers(effect, proc);
    for (const pid of members) {
        try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    const deadline = Date.now() + waitMs;
    while (groupMembers(effect, proc).length) {
        if (Date.now() >= deadline) return { verified: false, killed: members.length, reason: 'group_survived' };
        await sleep(10);
    }
    return { verified: true, killed: members.length, reason: members.length ? 'killed' : 'group_gone' };
}
