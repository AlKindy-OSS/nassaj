import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { installReleaseBootstrapEntry } from '../scripts/server-build-atomic.mjs';

const CONTAINER = '/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js';

/** Build only an entry fixture; startup admission and application are explicitly lightweight doubles. */
function fixture() {
    const root = mkdtempSync(path.resolve('.artifacts/pm2-bootstrap-entry-'));
    const staging = path.join(root, 'dist-server');
    const server = path.join(staging, 'server');
    mkdirSync(path.join(server, 'services'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    copyFileSync('server/bootstrap.js', path.join(server, 'bootstrap.js'));
    writeFileSync(path.join(server, 'bootstrap-startup-context.js'),
        'export async function establishStartupAdmission(){return null;} export async function admitSecurityStartup(){}');
    writeFileSync(path.join(server, 'services/update-maintenance-gate.js'),
        'export function createUpdateMaintenanceGate(){return {readPublicStatus(){return {gateClosed:false}}}}');
    const record = path.join(root, 'started');
    writeFileSync(path.join(server, 'index.js'),
        `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(record)}, ${JSON.stringify('started\n')});`);
    installReleaseBootstrapEntry(staging);
    return { root, record, entry: path.join(server, 'index.js') };
}

function execute(args, env = {}) {
    const child = spawnSync(process.execPath, args, {
        env: { PATH: process.env.PATH, pmx: 'false', disable_source_map_support: 'true', ...env },
        encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
}

test('real PM2 fork container and direct CLI each start the produced bootstrap exactly once', () => {
    assert.ok(existsSync(CONTAINER), 'Test requires the installed PM2 fork container; no daemon is started.');
    for (const mode of ['pm2', 'direct']) {
        const value = fixture();
        try {
            execute(mode === 'pm2' ? [CONTAINER] : [value.entry], { pm_exec_path: value.entry });
            assert.equal(readFileSync(value.record, 'utf8'), 'started\n');
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('ordinary import with forged PM2 environment and wrong PM2 target remains inert', () => {
    for (const mode of ['ordinary-import', 'wrong-target']) {
        const value = fixture();
        try {
            const importer = path.join(value.root, 'importer.mjs');
            writeFileSync(importer, `await import(${JSON.stringify(value.entry)});`);
            execute(mode === 'wrong-target' ? [CONTAINER] : [importer],
                { pm_exec_path: mode === 'wrong-target' ? importer : value.entry });
            assert.equal(existsSync(value.record), false);
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('lookalike container without actual PM2 package identity cannot trigger bootstrap', () => {
    const value = fixture();
    try {
        const lib = path.join(value.root, 'lookalike', 'lib'); mkdirSync(lib, { recursive: true });
        writeFileSync(path.join(value.root, 'lookalike', 'package.json'), '{"name":"not-pm2","type":"commonjs"}');
        const lookalike = path.join(lib, 'ProcessContainerFork.js');
        writeFileSync(lookalike, `import(${JSON.stringify(value.entry)});`);
        execute([lookalike], { pm_exec_path: value.entry });
        assert.equal(existsSync(value.record), false);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

/** A port nothing listens on, so the maintenance server can bind it deterministically. */
async function freePort() {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

test('real PM2 container keeps the MANUAL pre-import refusal but serves 503 instead of crash-looping', async () => {
    const value = fixture();
    let child = null;
    try {
        writeFileSync(path.join(value.root, 'dist-server/server/services/update-maintenance-gate.js'),
            'export function createUpdateMaintenanceGate(){return {readPublicStatus(){return {state:"MANUAL",gateClosed:true,phase:"BOOTSTRAP_CLAIMED"}}, async recoverOrDeclareManual(){return {state:"MANUAL"}}}}');
        copyFileSync('server/services/health-degraded.js', path.join(value.root, 'dist-server/server/services/health-degraded.js'));
        const port = await freePort();
        child = spawn(process.execPath, [CONTAINER], {
            env: { PATH: process.env.PATH, pmx: 'false', pm_exec_path: value.entry, SERVER_PORT: String(port), HOST: '127.0.0.1' },
            stdio: 'ignore',
        });
        let exitCode = null;
        child.once('exit', (code) => { exitCode = code; });
        let health = null;
        for (let attempt = 0; attempt < 100 && !health && exitCode === null; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        }
        assert.equal(exitCode, null, 'a MANUAL gate must not exit the process (pm2 would crash-loop it)');
        assert.equal(health?.status, 503);
        assert.equal((await health.json()).degradedReason, 'manual_recovery_required');
        assert.equal(existsSync(value.record), false, 'the application is never imported behind a closed gate');
    } finally {
        child?.kill('SIGKILL');
        rmSync(value.root, { recursive: true, force: true });
    }
});
