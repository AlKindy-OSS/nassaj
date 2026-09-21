#!/usr/bin/env node
/** Debounced, single-flight client publisher for the self-hosted local source tree. */
import { assertStandaloneNodePublication } from './lib/node-update-mode.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { createUpdateMaintenanceGate } from '../server/services/update-maintenance-gate.js';
import {
    CLIENT_ENV_FILES,
    CLIENT_SOURCE_ENTRIES,
    computeClientBuildId,
    gateAtomicPublisherStartup,
    isIgnoredClientInput,
    isLiveClientCurrent,
    readLiveClientBuildId,
    reconcileRuntimeState,
} from './client-build-atomic.mjs';
import {
    readPreviewLedger,
    reconcileClientPreviewLedger,
    recordPreviewLedgerEvent,
} from './local-preview-ledger.mjs';
import { readMutableWatcherInhibit } from './client-isolated-publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assertStandaloneNodePublication(ROOT);
const GENERATION_FILE = path.join(ROOT, '.git', 'nassaj-client-source-generation');
const WATCHED = [...CLIENT_SOURCE_ENTRIES, ...CLIENT_ENV_FILES];
const DEBOUNCE_MS = Number.parseInt(process.env.NASSAJ_CLIENT_BUILD_DEBOUNCE_MS || '1500', 10);
const BACKOFF_MS = Number.parseInt(process.env.NASSAJ_CLIENT_BUILD_BACKOFF_MS || '15000', 10);
const SMOKE_URL = process.env.NASSAJ_CLIENT_BUILD_SMOKE_URL
    || `http://127.0.0.1:${process.env.SERVER_PORT || process.env.PORT || '3004'}`;
const EX_CONFIG = 78;
const maintenanceGate = createUpdateMaintenanceGate({ projectPath: ROOT });

let generation = readPreviewLedger(ROOT).clientSourceGeneration ?? 0;
let timer = null;
let child = null;
let rerun = false;

function persistGeneration() {
    writeFileSync(GENERATION_FILE, `${generation}\n`, { mode: 0o600 });
}

function resourcesSafe() {
    let available = os.freemem();
    try {
        const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
        if (match) available = Number(match[1]) * 1024;
    } catch { /* non-Linux fallback */ }
    return 1 - available / os.totalmem() < 0.8 && os.loadavg()[0] / Math.max(1, os.cpus().length) < 0.8;
}

function schedule(delay = DEBOUNCE_MS) {
    clearTimeout(timer);
    timer = setTimeout(start, delay);
}

async function start() {
    assertStandaloneNodePublication(ROOT);
    timer = null;
    if (child) {
        rerun = true;
        return;
    }
    if (!resourcesSafe()) {
        console.warn('[client-watch] build deferred by the 80% resource ceiling.');
        schedule(BACKOFF_MS);
        return;
    }
    if (readMutableWatcherInhibit(ROOT)) {
        console.warn('[client-watch] mutable-tree publication is inhibited by an exact isolated commit publish.');
        return;
    }
    const selectedGeneration = generation;
    let writerLease;
    try {
        writerLease = await maintenanceGate.acquireWriterLease({ kind: 'client-watcher-build', waitMs: 100 });
    } catch {
        console.warn('[client-watch] build deferred by source-update maintenance.');
        schedule(BACKOFF_MS);
        return;
    }
    const childEnv = Object.fromEntries(
        ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NASSAJ_UPDATE_MODE', 'SERVER_PORT', 'PORT']
            .flatMap((key) => process.env[key] !== undefined ? [[key, process.env[key]]] : [])
    );
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('VITE_')) childEnv[key] = value;
    }
    child = spawn(process.execPath, [
        path.join(ROOT, 'scripts/client-build-atomic.mjs'),
        '--generation-file', GENERATION_FILE,
        '--generation', String(selectedGeneration),
        '--smoke-url', SMOKE_URL,
        '--local-preview',
    ], { cwd: ROOT, stdio: 'inherit', env: { ...childEnv, NODE_ENV: 'production' } });
    child.once('exit', (code) => {
        writerLease.release();
        child = null;
        if (code !== 0) {
            console.warn(`[client-watch] generation ${selectedGeneration} was not promoted.`);
            if (code !== 75) {
                const current = readPreviewLedger(ROOT);
                if (current.clientSourceGeneration !== selectedGeneration
                    || !['failed', 'superseded'].includes(current.clientState)) {
                    recordPreviewLedgerEvent(ROOT, {
                        target: 'client', sourceGeneration: selectedGeneration, state: 'failed',
                        runtimeBuildId: readLiveClientBuildId(ROOT),
                        error: { code: 'client_builder_exit', message: `Client builder exited with ${code}.` },
                    });
                }
            }
        }
        if (code === 75) {
            schedule(BACKOFF_MS);
            return;
        }
        if (rerun || generation !== selectedGeneration) {
            rerun = false;
            schedule(code === 0 ? DEBOUNCE_MS : BACKOFF_MS);
        }
    });
}

persistGeneration();
const watcher = chokidar.watch(WATCHED.map((entry) => path.join(ROOT, entry)), {
    ignoreInitial: true,
    ignored: (candidate) => isIgnoredClientInput(path.relative(ROOT, candidate)),
});
watcher.on('all', () => {
    if (readMutableWatcherInhibit(ROOT)) {
        console.warn('[client-watch] ignored mutable-tree change: isolated client publication is active.');
        return;
    }
    generation += 1;
    persistGeneration();
    try {
        const base = {
            target: 'client', sourceGeneration: generation,
            runtimeBuildId: readLiveClientBuildId(ROOT),
        };
        recordPreviewLedgerEvent(ROOT, { ...base, state: 'observed' });
        recordPreviewLedgerEvent(ROOT, { ...base, state: 'queued' });
    } catch (error) {
        console.error(`[client-watch] lifecycle ledger failed closed: ${error.message}`);
        process.exit(1);
    }
    rerun = Boolean(child);
    schedule();
});
watcher.on('ready', async () => {
    const startup = await gateAtomicPublisherStartup(SMOKE_URL, { reconcile: () => reconcileRuntimeState(ROOT) });
    if (!startup.ready) {
        console.error('[client-watch] live server lacks clientAtomicPublisherReady; refusing to reconcile or build.');
        await watcher.close();
        process.exitCode = EX_CONFIG;
        return;
    }
    const removed = startup.removed;
    if (removed.length) console.warn(`[client-watch] reconciled ${removed.length} interrupted staging generation(s).`);
    reconcileClientPreviewLedger(ROOT, generation, computeClientBuildId(ROOT), readLiveClientBuildId(ROOT));
    if (!isLiveClientCurrent(ROOT)) schedule(0);
    console.log('[client-watch] ready; local/source drift reconciliation is active.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        clearTimeout(timer);
        await watcher.close();
        if (child) child.kill(signal);
        process.exit(0);
    });
}
