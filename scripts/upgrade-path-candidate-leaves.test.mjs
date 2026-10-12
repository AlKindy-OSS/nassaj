// upgrade-path-candidate-leaves.test.mjs — ADR-204 S0 "candidate leaves" gate leg.
//
// Fast tests cover the job classification (including a detector that never
// reports idle), the post-activation checks, the PATH shims, the sandbox
// environment, port choice, process reaping and the verdict policy. The opt-in
// slow tests (NASSAJ_UPGRADE_PATH_GATE_SLOW=1) run the real leg: v2.3.1.0 and
// v2.3.1.1 must fail (B-1583) and HEAD must leave itself. About 3-6 min each.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { LEAVES_LEG, assertLeavesDiskSpace, followUpdateJob, verifyLeft } from './lib/upgrade-path-candidate-leaves.mjs';
import { LEGS, decideUpgradePath, formatUpgradePathReport, loadKnownIncompatible } from './lib/upgrade-path-gate.mjs';
import {
    assertRestartLogSandboxed, assertSandboxRestartEnvironment, leavesEnvironment, leavesLayout, npmShimScript, pm2ShimScript, recoveryCommand, sandboxPort, sandboxPortEnvironment,
    sandboxProcesses, stopLeavesHost,
} from './lib/upgrade-path-leaves-node.mjs';
import { parseArgs } from './release-upgrade-path-gate.mjs';

const TMPBASE = process.env.TMPDIR || '/var/tmp';
const LIMITS = Object.freeze({ bootMs: 60_000, totalMs: 600_000, idleWaitMs: 30_000, activationMs: 45_000, pollMs: 1000 });

/** Follow a scripted sequence of snapshots on a fake clock (one poll = one second). */
function follow(snapshots, limits = LIMITS) {
    let tick = 0;
    let time = 0;
    return followUpdateJob({
        limits, now: () => time, sleep: async (ms) => { time += ms; },
        observe: async () => snapshots(tick++),
    });
}

const job = (state, extra = {}) => ({ job: { state, ...extra } });

test('an activated job is a pass and its path is recorded', async () => {
    const steps = [job('accepted'), job('staging'), job('restart_queued'), { unreachable: true }, job('activated')];
    const result = await follow((tick) => steps[Math.min(tick, steps.length - 1)]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.timeline.map((step) => step.state),
        ['accepted', 'staging', 'restart_queued', 'unreachable', 'activated']);
});

test('a detector that never reports idle fails as node_busy, never as a pass or a stall', async () => {
    const busy = job('restart_queued', { autoActivation: { state: 'waiting_sessions', code: 'live_sessions' } });
    const result = await follow(() => busy);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'candidate_leaves_node_busy');
    assert.match(result.detail, /waiting_sessions:live_sessions/);
});

test('a job parked by the ADR-190 deferral (awaiting_sessions) also fails as node_busy', async () => {
    const result = await follow(() => job('awaiting_sessions'));
    assert.equal(result.code, 'candidate_leaves_node_busy');
});

test('a busy spell that clears before the bound does not fail the leg', async () => {
    const busy = job('restart_queued', { autoActivation: { state: 'waiting_terminals', code: 'open_terminals' } });
    const result = await follow((tick) => (tick < 20 ? busy : tick < 25 ? job('restart_queued') : job('activated')));
    assert.equal(result.ok, true);
});

test('an activation stuck behind an unresolved row is a stall (the B-1583 field state)', async () => {
    const stuck = job('restart_queued', { autoActivation: { state: 'waiting_row', code: null } });
    const result = await follow(() => stuck);
    assert.equal(result.code, 'candidate_leaves_activation_stalled');
    assert.match(result.detail, /restart_queued:waiting_row/);
});

test('a failed or rolled-back job fails with its own error code', async () => {
    const failed = await follow(() => job('failed', { errorCode: 'release_fetch_failed', failedPhase: 'staging' }));
    assert.equal(failed.code, 'release_fetch_failed');
    const rolledBack = await follow(() => job('rolled_back'));
    assert.equal(rolledBack.code, 'candidate_leaves_job_rolled_back');
});

test('a terminal auto-activation refusal fails at once with the refusal code', async () => {
    const refused = job('restart_queued', { autoActivation: { state: 'refused', code: 'source_update_action_invalid',
        terminal: true } });
    const result = await follow(() => refused);
    assert.equal(result.code, 'source_update_action_invalid');
    assert.equal(result.timeline.length, 1);
});

test('a node that never comes back after the restart fails as boot_failed', async () => {
    const result = await follow((tick) => (tick < 3 ? job('restart_queued') : { unreachable: true }));
    assert.equal(result.code, 'candidate_leaves_boot_failed');
});

test('a job that never settles is bounded by the total deadline', async () => {
    const result = await follow(() => job('staging'), { ...LIMITS, totalMs: 20_000 });
    assert.equal(result.code, 'candidate_leaves_timeout');
});

test('activation counts only when the next release serves from a new process pm2 restarted', () => {
    const next = { version: '1.0.0.3', commit: 'n'.repeat(40) };
    const health = { status: 'ok', sourceVersion: '1.0.0.3', runtimeVersion: '1.0.0.3', serverLoadedOid: next.commit, pid: 20 };
    const app = { status: 'online', pid: 20, restarts: 1 };
    assert.deepEqual(verifyLeft({ health, app, next, fromPid: 10 }), []);
    assert.match(verifyLeft({ health, app, next, fromPid: 20 }).join(), /pid unchanged/);
    assert.match(verifyLeft({ health: { ...health, sourceVersion: '1.0.0.2' }, app, next, fromPid: 10 }).join(), /sourceVersion/);
    assert.match(verifyLeft({ health, app: { ...app, restarts: 0 }, next, fromPid: 10 }).join(), /pm2=/);
    assert.match(verifyLeft({ health: { ...health, serverLoadedOid: 'x' }, app, next, fromPid: 10 }).join(), /serverLoadedOid/);
});

/** A private scratch directory removed after the test. */
function scratch(t, prefix) {
    const dir = mkdtempSync(path.join(TMPBASE, prefix));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('the npm shim copies the installed modules only for an identical lockfile and refuses the rest', (t) => {
    const dir = scratch(t, 'leaves-npm-');
    const candidate = path.join(dir, 'candidate');
    mkdirSync(path.join(candidate, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(candidate, 'node_modules', 'dep', 'index.js'), 'export {};\n');
    writeFileSync(path.join(candidate, 'package-lock.json'), '{"lock":1}\n');
    const shim = path.join(dir, 'npm');
    writeFileSync(shim, npmShimScript({ candidateRoot: candidate, npmPath: '/bin/echo' }), { mode: 0o700 });
    const staging = path.join(dir, 'staging');
    mkdirSync(staging);
    writeFileSync(path.join(staging, 'package-lock.json'), '{"lock":2}\n');
    assert.equal(spawnSync(shim, ['ci'], { cwd: staging }).status, 1, 'a different lockfile is refused');
    writeFileSync(path.join(staging, 'package-lock.json'), '{"lock":1}\n');
    assert.equal(spawnSync(shim, ['ci', '--include=dev'], { cwd: staging }).status, 0);
    assert.equal(existsSync(path.join(staging, 'node_modules', 'dep', 'index.js')), true);
    assert.equal(spawnSync(shim, ['ls', '--all'], { cwd: staging, encoding: 'utf8' }).stdout.trim(), 'ls --all');
    const install = spawnSync(shim, ['install', 'left-pad'], { cwd: staging, encoding: 'utf8' });
    assert.equal(install.status, 1);
    assert.match(install.stderr, /refused/);
});

test('the pm2 shim refuses any daemon but the sandbox one', (t) => {
    const dir = scratch(t, 'leaves-pm2-');
    const shim = path.join(dir, 'pm2');
    writeFileSync(shim, pm2ShimScript({ pm2Home: path.join(dir, 'pm2home'), pm2Path: '/bin/echo' }), { mode: 0o700 });
    const live = spawnSync(shim, ['restart', 'nassaj-dev'], { env: { PATH: '/usr/bin:/bin', PM2_HOME: '/home/x/.pm2' } });
    assert.equal(live.status, 97);
    const unset = spawnSync(shim, ['jlist'], { env: { PATH: '/usr/bin:/bin' } });
    assert.equal(unset.status, 97, 'an absent PM2_HOME would reach the default daemon');
    const own = spawnSync(shim, ['jlist'], { env: { PATH: '/usr/bin:/bin', PM2_HOME: path.join(dir, 'pm2home') }, encoding: 'utf8' });
    assert.equal(own.stdout.trim(), 'jlist');
});

test('the sandbox environment is built from nothing and confined to the sandbox', (t) => {
    const dir = scratch(t, 'leaves-env-');
    const layout = leavesLayout(dir);
    process.env.UPGRADE_GATE_LEAK_PROBE = 'leak';
    t.after(() => { delete process.env.UPGRADE_GATE_LEAK_PROBE; });
    const env = leavesEnvironment(layout, { owner: { username: 'u', password: 'p'.repeat(16) }, port: 40000 });
    assert.equal(env.UPGRADE_GATE_LEAK_PROBE, undefined);
    for (const key of ['HOME', 'TMPDIR', 'DATABASE_PATH', 'PM2_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR']) {
        assert.ok(env[key].startsWith(dir) || (key === 'PM2_HOME' && layout.pm2HomeOutside), key);
    }
    assert.equal(env.HOST, '127.0.0.1');
    assert.ok(env.PATH.startsWith(`${layout.bin}:`), 'the shims come first on PATH');
    assert.match(env.JWT_SECRET, /^[0-9a-f]{96}$/);
});

/** Every file under `root` with one of `extensions` (no node_modules, no dot directories). */
function sourceFiles(root, extensions) {
    const found = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) found.push(...sourceFiles(full, extensions));
        else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
    }
    return found;
}

/**
 * The variables whose default, in the server and its scripts, is a live port:
 * `env.X || ...3004`, `env.X ?? ...3001`, `${X:-...3004}` in shell.
 */
function liveDefaultKeys() {
    const keys = new Set();
    const files = [...sourceFiles('server', ['.js', '.ts', '.mjs']), ...sourceFiles('scripts', ['.mjs', '.sh'])]
        .filter((file) => !/\.test\.|__tests__/.test(file));
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/env\.([A-Z_][A-Z0-9_]*)\s*(?:\|\||\?\?)[^;\n]{0,80}?300[14]/g)) keys.add(match[1]);
        for (const match of text.matchAll(/\$\{([A-Z_][A-Z0-9_]*):-[^}]*?300[14]/g)) keys.add(match[1]);
    }
    return keys;
}

test('every variable whose default is the live port points at the sandbox port (qa CRITICAL 1)', (t) => {
    const dir = scratch(t, 'leaves-ports-');
    const port = 41234;
    const env = leavesEnvironment(leavesLayout(dir), { owner: { username: 'u', password: 'p'.repeat(16) }, port });
    const keys = liveDefaultKeys();
    for (const key of ['HEALTH_URL', 'HEALTH_PORT', 'PORT', 'WARM_PUBLIC_ORIGIN', 'NASSAJ_PREVIEW_HEALTH_URL']) {
        assert.ok(keys.has(key), `the scan finds ${key} (safe-restart.sh / update scripts)`);
    }
    for (const key of keys) {
        assert.ok(key in env, `${key} defaults to a live port and must be set for the sandbox`);
        assert.match(env[key], new RegExp(`(^|:)${port}(/|$)`), `${key}=${env[key]}`);
    }
    for (const [key, value] of Object.entries(env)) {
        if (['JWT_SECRET', 'BOOTSTRAP_OWNER_PASSWORD'].includes(key)) continue;
        assert.doesNotMatch(value, /300[14]/, `${key} must not name a live port`);
    }
    assert.throws(() => sandboxPortEnvironment(3004), /candidate_leaves_port_reserved/);
    assert.throws(() => sandboxPortEnvironment(3001), /candidate_leaves_port_reserved/);
});

test('the leg refuses a server whose environment would send safe-restart.sh to a live port', (t) => {
    const dir = scratch(t, 'leaves-environ-');
    const proc = path.join(dir, 'proc');
    const write = (env) => {
        mkdirSync(path.join(proc, '77'), { recursive: true });
        writeFileSync(path.join(proc, '77', 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0'));
    };
    write({ ...sandboxPortEnvironment(41234), JWT_SECRET: 'x' });
    assert.doesNotThrow(() => assertSandboxRestartEnvironment(77, 41234, proc));
    const { HEALTH_URL: _dropped, ...withoutHealth } = sandboxPortEnvironment(41234);
    write(withoutHealth);
    assert.throws(() => assertSandboxRestartEnvironment(77, 41234, proc), /candidate_leaves_live_port_leak/);
    mkdirSync(path.join(dir, 's'));
    const layout = leavesLayout(path.join(dir, 's'));
    writeFileSync(path.join(layout.data, 'last-restart.log'), 'B-790 ok\n');
    assert.doesNotThrow(() => assertRestartLogSandboxed(layout));
    writeFileSync(path.join(layout.data, 'last-restart.log'), 'GET http://127.0.0.1:3004/assets/x\n');
    assert.throws(() => assertRestartLogSandboxed(layout), /candidate_leaves_live_port_named/);
});

test('teardown also reaps detached children living in leaves/tmp, home or install', async (t) => {
    const dir = scratch(t, 'leaves-reap2-');
    const layout = leavesLayout(dir);
    const children = ['tmp', 'home', 'install'].map((name) => spawn('sleep', ['300'],
        { cwd: layout[name], stdio: 'ignore', detached: true }));
    t.after(() => { for (const child of children) child.kill('SIGKILL'); });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(sandboxProcesses(layout).sort(), children.map((child) => child.pid).sort());
    assert.deepEqual(stopLeavesHost(layout, null).survivors, []);
});

test('SIGTERM to the gate tears the sandbox down synchronously and exits 143', async (t) => {
    const dir = scratch(t, 'leaves-signal-');
    const program = `
import { spawn } from 'node:child_process';
import { installLeavesSignalGuard, leavesLayout } from ${JSON.stringify(path.resolve('scripts/lib/upgrade-path-leaves-node.mjs'))};
const layout = leavesLayout(${JSON.stringify(dir)});
const child = spawn('sleep', ['300'], { cwd: layout.tmp, stdio: 'ignore', detached: true });
child.unref();
installLeavesSignalGuard(layout, () => null);
process.stdout.write(child.pid + '\\n');
setInterval(() => {}, 1000);
`;
    const gate = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'inherit'] });
    const childPid = Number(await new Promise((resolve) => gate.stdout.once('data', (data) => resolve(String(data).trim()))));
    t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } });
    gate.kill('SIGTERM');
    const code = await new Promise((resolve) => gate.once('exit', (exitCode) => resolve(exitCode)));
    assert.equal(code, 143);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'the sandbox child was reaped');
});

test('the printed recovery command goes through the sandbox pm2 wrapper with its own PM2_HOME', (t) => {
    const dir = scratch(t, 'leaves-recover-');
    const layout = leavesLayout(dir);
    const command = recoveryCommand(layout);
    assert.ok(command.startsWith(`PM2_HOME='${layout.pm2Home}' '${path.join(layout.bin, 'pm2')}' kill;`), command);
    assert.match(command, new RegExp(`pgrep -af '${dir}'`));
});

test('a sandbox without 5 GiB free fails the leg instead of filling the disk', () => {
    const statfs = (free) => () => ({ bavail: free / 4096, bsize: 4096 });
    assert.throws(() => assertLeavesDiskSpace('/x', undefined, statfs(1024 ** 3)), /candidate_leaves_insufficient_disk/);
    assert.doesNotThrow(() => assertLeavesDiskSpace('/x', undefined, statfs(8 * 1024 ** 3)));
});

test('a skipped candidate-leaves result is a failure, never ignored like a skipped reader', () => {
    const legs = Object.fromEntries(LEGS.map(({ id }) => [id, { ok: true }]));
    const report = { previousTag: 'v1.0.0.1', previousCommit: 'a'.repeat(40), candidateCommit: 'c'.repeat(40),
        candidateVersion: '1.0.0.2', legs: { ...legs, [LEAVES_LEG]: { ok: false, skipped: true, code: 'skipped' } } };
    const decision = decideUpgradePath(report);
    assert.equal(decision.verdict, 'fail');
    assert.deepEqual(decision.failures.map((item) => item.leg), [LEAVES_LEG]);
});

test('a sandbox too deep for a unix socket gets a short private PM2_HOME', (t) => {
    const dir = scratch(t, 'leaves-deep-');
    const deep = path.join(dir, 'd'.repeat(60), 'e'.repeat(40));
    mkdirSync(deep, { recursive: true });
    const layout = leavesLayout(deep);
    t.after(() => rmSync(layout.pm2Home, { recursive: true, force: true }));
    assert.equal(layout.pm2HomeOutside, true);
    assert.ok(path.join(layout.pm2Home, 'pub.sock').length <= 100);
});

test('the leg never binds a live port', async () => {
    const ports = [3004, 3001, 3004, 41234];
    assert.equal(await sandboxPort(async () => ports.shift()), 41234);
});

test('teardown reaps every process left in the sandbox node, and only those', async (t) => {
    const dir = scratch(t, 'leaves-reap-');
    const layout = { node: path.join(dir, 'leaves-node'), pm2Home: path.join(dir, 'pm2'), bin: dir, pm2HomeOutside: false };
    mkdirSync(layout.node);
    const inside = spawn('sleep', ['300'], { cwd: layout.node, stdio: 'ignore' });
    const outside = spawn('sleep', ['300'], { cwd: dir, stdio: 'ignore' });
    t.after(() => { outside.kill('SIGKILL'); inside.kill('SIGKILL'); });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(sandboxProcesses(layout), [inside.pid]);
    const { survivors } = await stopLeavesHost(layout, null);
    assert.deepEqual(survivors, []);
    assert.equal(outside.exitCode, null, 'a process outside the sandbox node is left alone');
});

test('candidate-leaves is blocking and can never be excused by a known-incompatible entry', (t) => {
    assert.deepEqual(LEGS.find((leg) => leg.id === LEAVES_LEG), { id: LEAVES_LEG, blocking: true });
    const dir = scratch(t, 'leaves-policy-');
    const file = path.join(dir, 'policy.json');
    writeFileSync(file, JSON.stringify({ schema: 'nassaj-upgrade-path-known-incompatible/v1', entries: [{
        baseline: 'v1.0.0.1', baselineCommit: 'a'.repeat(40), leg: LEAVES_LEG, code: 'candidate_leaves_node_busy',
        bug: 'B-0', reason: 'fixture' }] }));
    assert.throws(() => loadKnownIncompatible(file), /invalid known-incompatible entry/);
    const legs = Object.fromEntries(LEGS.map(({ id }) => [id, { ok: true }]));
    const report = { previousTag: 'v1.0.0.1', previousCommit: 'a'.repeat(40), candidateCommit: 'c'.repeat(40),
        candidateVersion: '1.0.0.2', legs: { ...legs, [LEAVES_LEG]: { ok: false, code: 'candidate_leaves_node_busy' } } };
    const entry = { baseline: 'v1.0.0.1', baselineCommit: 'a'.repeat(40), leg: LEAVES_LEG, code: 'candidate_leaves_node_busy', bug: 'B-0' };
    const decision = decideUpgradePath(report, { knownIncompatible: [entry], acknowledged: ['v1.0.0.1'] });
    assert.equal(decision.verdict, 'fail');
    assert.deepEqual(decision.failures.map((item) => item.leg), [LEAVES_LEG]);
});

test('a candidate-leaves-only report is decided and printed on that leg alone', () => {
    const report = { only: [LEAVES_LEG], previousTag: null, previousCommit: null, candidateCommit: 'c'.repeat(40),
        candidateVersion: '2.3.1.0', legs: { [LEAVES_LEG]: { ok: false, code: 'candidate_leaves_activation_stalled',
            detail: 'restart_queued:waiting_row', from: '2.3.1.0', to: '2.3.1.1', timings: { updateMs: 1000, totalMs: 2000 },
            timeline: [{ at: 0, state: 'accepted' }] } } };
    const decision = decideUpgradePath(report);
    assert.equal(decision.verdict, 'fail');
    const lines = formatUpgradePathReport(report, decision).join('\n');
    assert.match(lines, /candidate-leaves only/);
    assert.match(lines, /candidate-leaves: FAIL candidate_leaves_activation_stalled 2\.3\.1\.0->2\.3\.1\.1/);
    assert.match(lines, /detail: restart_queued:waiting_row/);
    assert.doesNotMatch(lines, /previous-writer/);
    assert.equal(decideUpgradePath({ ...report, legs: { [LEAVES_LEG]: { ok: true } } }).verdict, 'pass');
});

test('--only accepts candidate-leaves without a previous tag, and nothing else', () => {
    assert.equal(parseArgs(['--only', LEAVES_LEG, '--candidate-ref', 'v2.3.1.0']).only, LEAVES_LEG);
    assert.throws(() => parseArgs(['--only', 'previous-writer', '--candidate-ref', 'HEAD']), /--only accepts/);
    assert.throws(() => parseArgs(['--candidate-ref', 'HEAD']), /--previous-tag/);
});

// The real leg (sandbox pm2, real builds, real boot). Opt-in only; the work
// parent defaults to the gate's private cache (trees are installed once by commit).
const SLOW = process.env.NASSAJ_UPGRADE_PATH_GATE_SLOW === '1';

/** Run the leg alone against one ref and return the CLI result. */
function runLeaves(ref, extra = []) {
    const work = process.env.NASSAJ_UPGRADE_PATH_GATE_WORK;
    return spawnSync(process.execPath, ['scripts/release-upgrade-path-gate.mjs', '--only', LEAVES_LEG,
        '--candidate-ref', ref, ...(work ? ['--work-parent', work] : []), ...extra],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
}

/** A failing run keeps its sandbox: read the server log as evidence, then remove it. */
function keptServerLog(stdout) {
    const sandbox = /sandbox kept: (\S+)/.exec(stdout)?.[1];
    assert.ok(sandbox, 'a failed run names its kept sandbox');
    try {
        return readFileSync(path.join(sandbox, 'leaves', 'logs', 'pm2-tail.log'), 'utf8');
    } finally {
        rmSync(sandbox, { recursive: true, force: true });
    }
}

for (const tag of ['v2.3.1.0', 'v2.3.1.1']) {
    test(`slow: ${tag} cannot leave itself through the button path (B-1583)`, { skip: !SLOW }, () => {
        const run = runLeaves(tag);
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stdout, /candidate-leaves: FAIL candidate_leaves_/);
        assert.match(run.stdout, /verdict: fail/);
        assert.match(keptServerLog(run.stdout), /source_update_action_invalid/);
    });
}

test('slow: HEAD leaves itself to the synthetic next release through the button path', { skip: !SLOW }, () => {
    const run = runLeaves('HEAD', ['--keep']);
    const sandbox = /sandbox kept: (\S+)/.exec(run.stdout)?.[1];
    try {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.match(run.stdout, /candidate-leaves: ok /);
        assert.match(run.stdout, /restart_queued.*activated/);
        assert.match(run.stdout, /verdict: pass/);
        assert.match(run.stderr, /\[candidate-leaves\] if this gate is killed, stop its sandbox with: PM2_HOME=/);
        // qa CRITICAL 1: safe-restart.sh's probes, B-790 health check and warm-up
        // must have targeted the sandbox server, never the live port.
        const log = readFileSync(path.join(sandbox, 'leaves', 'data', 'last-restart.log'), 'utf8');
        const nodeEnv = readFileSync(path.join(sandbox, 'leaves-node', 'config', 'node.env'), 'utf8');
        const port = /^SERVER_PORT=(\d+)$/m.exec(nodeEnv)?.[1];
        assert.ok(port && !['3001', '3004'].includes(port), `sandbox port ${port}`);
        assert.match(nodeEnv, new RegExp(`^HEALTH_URL=http://127\\.0\\.0\\.1:${port}/health$`, 'm'));
        assert.doesNotMatch(log, /:300[14]\b/, 'the sandbox restart never named a live port');
        // The leg already refused unless the server's own environ (inherited by
        // safe-restart.sh) carried the sandbox HEALTH_URL; B-790 then passed.
        assert.match(log, /B-790: [^\n]*HTTP 200/, 'the post-restart health check ran and passed');
        assert.equal(statSync(sandbox).isDirectory(), true);
    } finally {
        if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    }
});
