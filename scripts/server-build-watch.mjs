#!/usr/bin/env node
/** Debounced server preview builder. It stores verified candidates but never promotes or restarts. */
import { resolveNodeUpdateMode } from './lib/node-update-mode.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { createUpdateMaintenanceGate } from '../server/services/update-maintenance-gate.js';

import {
    SERVER_BUILD_INPUTS,
    computeServerBuildFingerprint,
    isIgnoredServerInput,
    previewServerCandidatePath,
    readServerBuildIdOnDisk,
} from './server-build-atomic.mjs';
import {
    readPreviewLedger,
    reconcileServerPreviewLedger,
    recordPreviewLedgerEvent,
} from './local-preview-ledger.mjs';
import { gitControlPath } from './git-control-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATION_FILE = gitControlPath(ROOT, 'nassaj-server-source-generation');
const DEBOUNCE_MS = Number.parseInt(process.env.NASSAJ_SERVER_BUILD_DEBOUNCE_MS || '2000', 10);
const BACKOFF_MS = Number.parseInt(process.env.NASSAJ_SERVER_BUILD_BACKOFF_MS || '15000', 10);
const maintenanceGate = createUpdateMaintenanceGate({ projectPath: ROOT });

let generation = readPreviewLedger(ROOT).serverSourceGeneration ?? 0;
let timer = null;
let child = null;
let rerun = false;

function resourcesSafe() {
    let available = os.freemem();
    try {
        const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
        if (match) available = Number(match[1]) * 1024;
    } catch { /* non-Linux fallback */ }
    return 1 - available / os.totalmem() < 0.8
        && os.loadavg()[0] / Math.max(1, os.cpus().length) < 0.8;
}

function persistGeneration() {
    writeFileSync(GENERATION_FILE, `${generation}\n`, { mode: 0o600 });
}

function schedule(delay = DEBOUNCE_MS) {
    clearTimeout(timer);
    timer = setTimeout(start, delay);
}

function recordState(state, fields = {}) {
    recordPreviewLedgerEvent(ROOT, {
        target: 'server', sourceGeneration: generation, state,
        runtimeBuildId: readPreviewLedger(ROOT).serverLoadedBuildId ?? null,
        ...fields,
    });
}

async function start() {
    if (resolveNodeUpdateMode(ROOT) === 'local-main') return;
    timer = null;
    if (child) { rerun = true; return; }
    if (!resourcesSafe()) {
        console.warn('[server-watch] build deferred by the 80% resource ceiling.');
        schedule(BACKOFF_MS);
        return;
    }
    const selectedGeneration = generation;
    let writerLease;
    try {
        writerLease = await maintenanceGate.acquireWriterLease({ kind: 'server-watcher-build', waitMs: 100 });
    } catch {
        console.warn('[server-watch] build deferred by source-update maintenance.');
        schedule(BACKOFF_MS);
        return;
    }
    child = spawn(process.execPath, [
        path.join(ROOT, 'scripts/server-build-atomic.mjs'),
        '--generation-file', GENERATION_FILE,
        '--generation', String(selectedGeneration),
        '--local-preview',
    ], {
        cwd: ROOT,
        stdio: 'inherit',
        env: Object.fromEntries(
            ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NASSAJ_UPDATE_MODE', 'NODE_ENV']
                .flatMap((key) => process.env[key] !== undefined ? [[key, process.env[key]]] : []),
        ),
    });
    child.once('exit', (code) => {
        writerLease.release();
        child = null;
        if (code !== 0) {
            console.warn(`[server-watch] generation ${selectedGeneration} was not stored.`);
            if (code !== 75) {
                const current = readPreviewLedger(ROOT);
                if (current.serverSourceGeneration !== selectedGeneration
                    || !['failed', 'superseded'].includes(current.serverState)) {
                    recordPreviewLedgerEvent(ROOT, {
                        target: 'server', sourceGeneration: selectedGeneration, state: 'failed',
                        error: { code: 'server_builder_exit', message: `Server builder exited with ${code}.` },
                    });
                }
            }
        }
        if (code === 75) { schedule(BACKOFF_MS); return; }
        if (rerun || generation !== selectedGeneration) {
            rerun = false;
            schedule(code === 0 ? DEBOUNCE_MS : BACKOFF_MS);
        }
    });
}

persistGeneration();
const watcher = chokidar.watch(SERVER_BUILD_INPUTS.map((entry) => path.join(ROOT, entry)), {
    ignoreInitial: true,
    ignored: (candidate) => isIgnoredServerInput(path.relative(ROOT, candidate)),
});

watcher.on('all', () => {
    generation += 1;
    persistGeneration();
    try {
        recordState('observed');
        recordState('queued');
    } catch (error) {
        console.error(`[server-watch] lifecycle ledger failed closed: ${error.message}`);
        process.exit(1);
    }
    rerun = Boolean(child);
    schedule();
});

watcher.on('ready', () => {
    const sourceBuildId = computeServerBuildFingerprint(ROOT);
    const onDiskBuildId = readServerBuildIdOnDisk(ROOT);
    const candidateBuildId = readServerBuildIdOnDisk(
        ROOT,
        previewServerCandidatePath(ROOT, sourceBuildId),
    );
    reconcileServerPreviewLedger(ROOT, generation, sourceBuildId, candidateBuildId, onDiskBuildId);
    if (sourceBuildId !== candidateBuildId && sourceBuildId !== readPreviewLedger(ROOT).serverLoadedBuildId) schedule(0);
    console.log('[server-watch] ready; server preview builds require an explicit safe restart to load.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        clearTimeout(timer);
        await watcher.close();
        if (child) child.kill(signal);
        process.exit(0);
    });
}
