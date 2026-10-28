#!/usr/bin/env node
/**
 * ADR-216 §6 test 9 helper: a SEPARATE process that holds one real lock on a
 * node until it is killed, so the two-process tests exercise real flock(2)
 * semantics across processes. Prints `ready` once the lock is held.
 *
 *   node release-branch-attach.test-child.mjs <mode> <appRoot>
 *   mode: writer-lease | attach-lease | exclusive
 */
import { createUpdateMaintenanceGate, flockAsync } from '../../server/services/update-maintenance-gate.js';

const [mode, appRoot] = process.argv.slice(2);
const gate = () => createUpdateMaintenanceGate({ projectPath: appRoot });

async function hold() {
    if (mode === 'writer-lease') return gate().acquireWriterLease({ kind: 'source-update-stage', waitMs: 5_000 });
    if (mode === 'attach-lease') return gate().acquireExclusiveSourceRefLease({ waitMs: 5_000 });
    if (mode === 'exclusive') {
        // What an activation holds: admission then activity, both exclusive.
        const { paths } = gate();
        const admission = await flockAsync(paths.admissionLock, 'exclusive', { waitMs: 5_000 });
        const activity = await flockAsync(paths.activityLock, 'exclusive', { waitMs: 5_000 });
        return { release() { activity.release(); admission.release(); } };
    }
    throw new Error(`unknown mode ${mode}`);
}

const held = await hold();
process.stdout.write('ready\n');
const stop = () => { held.release(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1_000);
