import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { bootstrapServer, readBootstrapHandoff, serveMaintenance } from './bootstrap.js';

const OWNERSHIP_SYMBOL = Symbol.for('nassaj.sourceUpdate.bootstrapOwnership.v1');
const FIXTURE_ROOT = path.resolve('.artifacts');
mkdirSync(FIXTURE_ROOT, { recursive: true });

test('bootstrap claims the fixed durable handoff before importing server index', async () => {
    const root = mkdtempSync(path.join(FIXTURE_ROOT, 'nassaj-bootstrap-'));
    try {
        const controlRoot = path.join(root, 'control');
        mkdirSync(controlRoot);
        const token = path.join(controlRoot, 'token');
        writeFileSync(token, 'token', { mode: 0o600 });
        const transactionId = `update-${'a'.repeat(24)}`;
        const epoch = 'b'.repeat(24);
        writeFileSync(path.join(controlRoot, 'bootstrap-handoff.json'), `${JSON.stringify({
            schema: 'nassaj-source-update-bootstrap/v1', transactionId, epoch, tokenFilePath: token,
        })}\n`, { mode: 0o600 });
        const calls = [];
        const gate = {
            paths: { controlRoot, token },
            readPublicStatus: () => ({ gateClosed: true, phase: 'RESTARTING_HANDOFF' }),
            async claimBootstrapOwnership(value) {
                calls.push(['claim', value]);
                return { ownershipContext: { transactionId }, release() { calls.push(['release']); } };
            },
        };
        await bootstrapServer({
            projectPath: root,
            gateModule: { createUpdateMaintenanceGate: () => gate },
            loadServer: async () => { calls.push(['load']); return { loaded: true }; },
        });
        assert.equal(calls[0][0], 'claim');
        assert.equal(calls[1][0], 'load');
        assert.equal(globalThis[OWNERSHIP_SYMBOL].transactionId, transactionId);
        globalThis[OWNERSHIP_SYMBOL].release();
        delete globalThis[OWNERSHIP_SYMBOL];
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('handoff rejects group-readable descriptors', () => {
    const root = mkdtempSync(path.join(FIXTURE_ROOT, 'nassaj-bootstrap-'));
    try {
        const token = path.join(root, 'token');
        writeFileSync(token, 'token', { mode: 0o600 });
        writeFileSync(path.join(root, 'bootstrap-handoff.json'), '{}', { mode: 0o640 });
        assert.throws(() => readBootstrapHandoff({ paths: { controlRoot: root, token } }), /unsafe/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a non-OPEN gate serves maintenance instead of exiting, and imports nothing until it opens', async () => {
    const events = [];
    let status = { state: 'MANUAL', gateClosed: true, phase: 'BOOTSTRAP_CLAIMED' };
    let recoveries = 0;
    const gate = {
        readPublicStatus: () => status,
        recoverOrDeclareManual: async () => { recoveries += 1; return { state: 'MANUAL' }; },
    };
    const booted = bootstrapServer({ projectPath: process.cwd(), maintenancePollMs: 5,
        gateModule: { createUpdateMaintenanceGate: () => gate },
        serveMaintenance: async () => { events.push('serve'); return { close: async () => { events.push('close'); } }; },
        loadServer: async () => { events.push('load'); return { loaded: true }; },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(events, ['serve'], 'no application import while the gate is closed');
    assert.equal(recoveries, 1, 'MANUAL is not re-recovered on every poll');
    status = { state: 'OPEN', gateClosed: false, phase: null };
    assert.equal((await booted).loaded, true);
    assert.deepEqual(events, ['serve', 'close', 'load']);
});

test('a throwing recovery is a closed gate, not a process exit', async () => {
    const events = [];
    let status = { state: 'UPDATING', gateClosed: true, phase: 'SOURCE_APPLIED' };
    const gate = {
        readPublicStatus: () => status,
        recoverOrDeclareManual: async () => { throw new Error('update_lock_contended'); },
    };
    const booted = bootstrapServer({ projectPath: process.cwd(), maintenancePollMs: 5,
        gateModule: { createUpdateMaintenanceGate: () => gate },
        serveMaintenance: async () => { events.push('serve'); return { close: async () => {} }; },
        loadServer: async () => { events.push('load'); },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = { state: 'OPEN', gateClosed: false, phase: null };
    await booted;
    assert.deepEqual(events, ['serve', 'load']);
});

test('a refused (MANUAL) handoff is not claimed again on the next pm2 restart', async () => {
    const events = [];
    let status = { state: 'MANUAL', gateClosed: true, phase: 'RESTARTING_HANDOFF' };
    const gate = {
        readPublicStatus: () => status,
        claimBootstrapOwnership: async () => { events.push('claim'); throw new Error('update_bootstrap_claim_rejected'); },
        recoverOrDeclareManual: async () => ({ state: 'MANUAL' }),
    };
    const booted = bootstrapServer({ projectPath: process.cwd(), maintenancePollMs: 5,
        gateModule: { createUpdateMaintenanceGate: () => gate },
        serveMaintenance: async () => { events.push('serve'); return { close: async () => {} }; },
        loadServer: async () => { events.push('load'); },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = { state: 'OPEN', gateClosed: false, phase: null };
    await booted;
    assert.deepEqual(events, ['serve', 'load']);
});

test('the maintenance server answers 503 everywhere and names the reason on /health', async () => {
    const handle = await serveMaintenance({
        port: 0, host: '127.0.0.1',
        readPublicStatus: () => ({ state: 'MANUAL', gateClosed: true, phase: 'SOURCE_APPLIED', exitPath: 'secret-path' }),
    });
    try {
        const { port } = handle.address();
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(health.status, 503);
        assert.deepEqual(await health.json(), {
            status: 'maintenance', degraded: true,
            degradedReason: 'manual_recovery_required', degradedPhase: 'SOURCE_APPLIED',
        });
        const page = await fetch(`http://127.0.0.1:${port}/api/projects`);
        assert.equal(page.status, 503);
        assert.equal(page.headers.get('retry-after'), '30');
        assert.equal((await page.text()).includes('secret-path'), false);
    } finally { await handle.close(); }
});

test('fresh process loads .env DATABASE_PATH before constructing maintenance gate', () => {
    const root = mkdtempSync(path.join(FIXTURE_ROOT, 'bootstrap-env-'));
    try {
        const databasePath = path.join(root, 'configured.sqlite');
        writeFileSync(path.join(root, '.env'), `DATABASE_PATH=${databasePath}\n`);
        const code = `import {bootstrapServer} from ${JSON.stringify(new URL('./bootstrap.js', import.meta.url).href)};
            await bootstrapServer({ projectPath: ${JSON.stringify(root)},
                gateModule: { createUpdateMaintenanceGate() {
                    if (process.env.DATABASE_PATH !== ${JSON.stringify(databasePath)}) throw Error('configuration_not_loaded');
                    return {readPublicStatus: () => ({gateClosed:false})};
                }}, loadServer: async () => {} });`;
        const env = { ...process.env }; delete env.DATABASE_PATH;
        execFileSync(process.execPath, ['--input-type=module', '-e', code], { env });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Exercise the default literal loader in the source and packaged entry layouts. */
async function literalLoaderFixture({ release = false, reject = false, fail = false } = {}) {
    const root = mkdtempSync(path.join(FIXTURE_ROOT, 'bootstrap-literal-'));
    const calls = [];
    try {
        writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
        // Mirror the real tree: the startup context imports `../scripts/lib/...`, so the copies must
        // keep their own directory depth instead of resolving outside this fixture root.
        const serverDirectory = path.join(root, 'server'); mkdirSync(serverDirectory);
        const libraryDirectory = path.join(root, 'scripts/lib'); mkdirSync(libraryDirectory, { recursive: true });
        copyFileSync(new URL('../scripts/lib/local-reviewed-build-identity.mjs', import.meta.url),
            path.join(libraryDirectory, 'local-reviewed-build-identity.mjs'));
        const entry = path.join(serverDirectory, release ? 'index.js' : 'bootstrap.js');
        copyFileSync(new URL('./bootstrap.js', import.meta.url), entry);
        for (const dependency of ['bootstrap-startup-context.js', 'bootstrap-release-profile.js']) {
            copyFileSync(new URL(`./${dependency}`, import.meta.url), path.join(serverDirectory, dependency));
        }
        const application = path.join(serverDirectory, release ? 'application.js' : 'index.js');
        writeFileSync(application, fail ? "throw new Error('application_failed');" : 'export const loaded = true;');
        const controlRoot = path.join(root, 'control'); mkdirSync(controlRoot);
        const token = path.join(controlRoot, 'token');
        writeFileSync(path.join(controlRoot, 'bootstrap-handoff.json'), JSON.stringify({
            schema: 'nassaj-source-update-bootstrap/v1', transactionId: 'a'.repeat(24),
            epoch: 'b'.repeat(24), tokenFilePath: token,
        }), { mode: 0o600 });
        const gate = {
            paths: { controlRoot, token },
            readPublicStatus: () => ({ gateClosed: true, phase: 'RESTARTING_HANDOFF' }),
            claimBootstrapOwnership: async ({ applicationPath }) => {
                calls.push('claim'); assert.equal(applicationPath, application);
                if (reject) throw new Error('claim_rejected');
                // Presence is evaluated once: a later appearance must not switch
                // the source import away from the file covered by this claim.
                if (!release) writeFileSync(path.join(serverDirectory, 'application.js'), "throw Error('wrong_target');");
                return { ownershipContext: {}, release() { calls.push('release'); } };
            },
        };
        const { bootstrapServer: run } = await import(pathToFileURL(entry).href);
        const promise = run({ projectPath: root, gateModule: { createUpdateMaintenanceGate: () => gate } });
        if (reject || fail) await assert.rejects(promise, reject ? /claim_rejected/ : /application_failed/);
        else assert.equal((await promise).loaded, true);
        assert.deepEqual(calls, fail && !reject ? ['claim', 'release'] : ['claim']);
    } finally {
        delete globalThis[OWNERSHIP_SYMBOL];
        rmSync(root, { recursive: true, force: true });
    }
}

test('source default loader imports index covered by the claim even if application appears later', () => literalLoaderFixture());
test('copied index wrapper default loader imports application covered by the claim', () => literalLoaderFixture({ release: true }));
test('rejected claim prevents a throwing application from being imported', () => literalLoaderFixture({ release: true, reject: true, fail: true }));
test('application failure releases ownership and never falls back to copied index', () => literalLoaderFixture({ release: true, fail: true }));
