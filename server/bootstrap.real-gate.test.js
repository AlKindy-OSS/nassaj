/**
 * ADR-156 WI-13 (T-1728) — bootstrap against the REAL maintenance gate.
 *
 * `bootstrap.test.js` pins the control flow with a fake gate. Here the gate,
 * its recovery runner and `ownerIsAlive` are all production code, the owner is
 * a real process that was SIGKILLed mid-update, and bootstrap runs as its own
 * process with a real listening socket: a non-OPEN gate must answer 503 on
 * /health and never import the application, and must not exit (pm2 would turn
 * an exit into a crash-loop with nothing listening — qa-critic C1).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { createActivationFixture, killedOwnerAt, readJournal } from './services/tests/source-activation-fixture.js';
import { createUpdateMaintenanceGate } from './services/update-maintenance-gate.js';

const BOOTSTRAP_URL = new URL('./bootstrap.js', import.meta.url).href;

async function freePort() {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

/** Boot the real bootstrap in its own process; `loadServer` only records that it ran. */
function boot(fixture, port) {
    const marker = path.join(fixture.base, `application-loaded-${port}`);
    const code = `import fs from 'node:fs';
        import { bootstrapServer } from ${JSON.stringify(BOOTSTRAP_URL)};
        await bootstrapServer({ projectPath: ${JSON.stringify(fixture.root)}, maintenancePollMs: 50,
            loadServer: async () => { fs.writeFileSync(${JSON.stringify(marker)}, 'loaded'); return {}; } });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, SERVER_PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: fixture.databasePath },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    return {
        marker, exited, child,
        stderr: () => stderr,
        running: () => child.exitCode === null && child.signalCode === null,
        async kill() { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } },
    };
}

/** Poll /health until something answers or the process is gone. */
async function health(port, booted) {
    for (let attempt = 0; attempt < 200 && booted.running(); attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
}

async function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

test('a real crash whose rollback cannot run boots to 503 on /health, then opens only through the doctor path', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    await killedOwnerAt(fixture, 'SOURCE_APPLIED');
    // A weakened manifest: validateCandidate throws `Unsafe activation file`
    // for real, and the ب.5 reopen refuses the same file, so MANUAL is the
    // only sound outcome.
    fs.chmodSync(fixture.manifestPath, 0o644);
    const port = await freePort();
    const booted = boot(fixture, port);
    t.after(() => booted.kill());

    const response = await health(port, booted);
    assert.equal(booted.running(), true, `bootstrap must not exit on a closed gate: ${booted.stderr()}`);
    assert.equal(response?.status, 503);
    assert.deepEqual(await response.json(), {
        status: 'maintenance', degraded: true, degradedReason: 'manual_recovery_required', degradedPhase: 'SOURCE_APPLIED',
    });
    const page = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(page.status, 503);
    assert.equal(fs.existsSync(booted.marker), false, 'the application is never imported behind a closed gate');
    const journal = readJournal(fixture);
    assert.deepEqual({ state: journal.state, owner: journal.owner, recoveryError: journal.recoveryError },
        { state: 'MANUAL', owner: null, recoveryError: 'Unsafe activation file: candidate-manifest.json' });

    // The operator restores the file mode and takes the declared exit path.
    fs.chmodSync(fixture.manifestPath, 0o600);
    const reopened = await createUpdateMaintenanceGate({ projectPath: fixture.root })
        .reopenOnPreviousGeneration({ waitMs: 2_000, dryRun: false });
    assert.equal(reopened.applied, true);
    assert.equal(reopened.to.degraded, 'source_tree_at_target');
    assert.equal(await withTimeout(booted.exited, 10_000, 'bootstrap release'), 0);
    assert.equal(fs.readFileSync(booted.marker, 'utf8'), 'loaded', 'the same process imports the application once the gate opens');
});

test('a handoff the replacement refuses is MANUAL after one exit, and the next boot serves 503', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    await killedOwnerAt(fixture, 'HANDOFF');
    const firstPort = await freePort();
    const first = boot(fixture, firstPort);
    t.after(() => first.kill());
    // This process's application is not the candidate the handoff attests, so
    // the claim is refused — by the production attestation, not by a stub.
    assert.equal(await withTimeout(first.exited, 10_000, 'first boot'), 1);
    assert.match(first.stderr(), /update_bootstrap_application_path_mismatch/);
    assert.deepEqual((({ state, gateClosed, recoveryError }) => ({ state, gateClosed, recoveryError }))(readJournal(fixture)),
        { state: 'MANUAL', gateClosed: true, recoveryError: 'database_snapshot_unverified' });

    const port = await freePort();
    const second = boot(fixture, port);
    t.after(() => second.kill());
    const response = await health(port, second);
    assert.equal(second.running(), true, `a refused handoff must not crash-loop: ${second.stderr()}`);
    assert.equal(response?.status, 503);
    assert.equal((await response.json()).degradedPhase, 'RESTARTING_HANDOFF');
    assert.equal(fs.existsSync(second.marker), false);
});

/*
 * B-1125 (found by this test, T-1728). `prepareBootstrapHandoff` moves the
 * journal to RESTARTING_HANDOFF before its descriptor is durable, so a crash
 * or write error in between leaves a handoff journal with no descriptor.
 * Bootstrap used to read it outside any recovery and exit with ENOENT on every
 * pm2 restart; an unreadable descriptor now takes the recovery path (MANUAL).
 */
test('a handoff journal whose descriptor never landed serves 503, not exit', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    await killedOwnerAt(fixture, 'HANDOFF_TORN');
    assert.equal(readJournal(fixture).phase, 'RESTARTING_HANDOFF');
    assert.equal(fs.existsSync(path.join(fixture.gate.paths.controlRoot, 'bootstrap-handoff.json')), false);
    const port = await freePort();
    const booted = boot(fixture, port);
    t.after(() => booted.kill());
    const response = await health(port, booted);
    assert.equal(booted.running(), true, `bootstrap exited on a torn handoff (pm2 crash-loop): ${booted.stderr().trim()}`);
    assert.equal(response?.status, 503);
});
