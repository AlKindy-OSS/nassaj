#!/usr/bin/env node
/** Owner-clicked exact OID promotion, safe restart, attestation and rollback. */
import {
    lstatSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    confirmServerLoaded, withPreviewEventMutationLock,
} from './preview-oid-consumer.mjs';
import { inspectOwnerControlRequest, readRegularJson, controlPath } from './local-preview-ledger.mjs';
export { inspectOwnerControlRequest };


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OID = /^[a-f0-9]{40}$/;
const BUILD_ID = /^[a-f0-9]{64}$/;

function readLiveProvenance(root) {
    const value = readRegularJson(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), 'Live server provenance');
    if (value.artifact !== 'server' || !OID.test(value.commit || '') || !BUILD_ID.test(value.buildId || '')) {
        throw new Error('Live server provenance is invalid.');
    }
    return { oid: value.commit, buildId: value.buildId };
}

function runSafeRestart(root, mode) {
    const args = [path.join(root, 'scripts', 'safe-restart.sh')];
    if (mode === 'gate') {
        args.push('--json');
    } else {
        // force-restart (T-1677): explicit flags on the exec path; the gate stays
        // read-only. safe-restart.sh also honours NASSAJ_RESTART_KILL_SESSIONS on
        // its own, so this is belt-and-suspenders + legible argv.
        if (KILL_SESSIONS) args.push('--kill-sessions', '--force');
        args.push('--exec');
    }
    return spawnSync('bash', args, { cwd: root, encoding: 'utf8' });
}

function hasOwnerControl(root) {
    try { lstatSync(controlPath(root)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/**
 * A control request normally owns restart: it names a candidate that must be
 * promoted and attested atomically.  A request that already names the exact
 * live generation is different: its promotion is terminal, so treating it as
 * pending makes every ordinary safe restart fail with candidate_identity_mismatch.
 *
 * Malformed or changing control data remains blocking.  Only two independently
 * validated records agreeing on both OID and build unlock the ordinary path.
 */
export function hasBlockingOwnerControl(root, dependencies = {}) {
    const ownerControlExists = dependencies.hasOwnerControl || hasOwnerControl;
    const readRequest = dependencies.inspectOwnerControlRequest || inspectOwnerControlRequest;
    const readLive = dependencies.readLiveProvenance || readLiveProvenance;
    if (!ownerControlExists(root)) return false;
    try {
        const request = readRequest(root);
        const live = readLive(root);
        return request.oid !== live.oid || request.buildId !== live.buildId;
    } catch {
        return true;
    }
}

/**
 * force-restart (ADR-066/T-1677): the owner-confirmed kill-sessions restart.
 * NASSAJ_RESTART_KILL_SESSIONS is set by system.js on the detached spawn and
 * propagates here through the inherited environment. safe-restart.sh already
 * honours the env var on its own; we ALSO append the explicit flags so the
 * intent is legible in the process argv and directly testable. The gate stays
 * read-only (never kills), so the flags are added on the --exec path only.
 */
const KILL_SESSIONS = (() => {
    const v = String(process.env.NASSAJ_RESTART_KILL_SESSIONS || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();

/** ADR-147: ordinary restart gets fixed disk TMPDIR only under the OID creation lock. */
export async function tryOrdinarySafeRestart(root, { gate = false } = {}, injected = {}) {
    const ownerControlBlocks = injected.ownerControlBlocks || hasBlockingOwnerControl;
    if (ownerControlBlocks(root)) return null;
    const run = injected.run || spawnSync;
    const script = path.join(root, 'scripts', 'safe-restart.sh');
    if (gate) return run('bash', [script, '--json'], { cwd: root, encoding: 'utf8' });
    const killArgs = (injected.killSessions ?? KILL_SESSIONS) ? ['--kill-sessions', '--force'] : [];
    const lock = injected.lock || withPreviewEventMutationLock;
    return lock(root, () => {
        if (ownerControlBlocks(root)) return null;
        return run('bash', [script, '--set', 'TMPDIR=/var/tmp', ...killArgs, '--exec'], { cwd: root, encoding: 'utf8' });
    });
}

function runActivator(root, action, request) {
    const result = spawnSync(process.execPath, [
        path.join(root, 'scripts', 'preview-oid-activate.mjs'), action,
        '--repo', root, '--group', request.group,
        '--expected-oid', request.oid, '--build-id', request.buildId,
    ], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`OID ${action} control failed: ${String(result.stderr || result.stdout || '').trim()}`);
    }
    const line = String(result.stdout || '').trim().split('\n').filter(Boolean).at(-1);
    return line ? JSON.parse(line) : null;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function pollExactRuntime(expected, options = {}) {
    const fetchHealth = options.fetchHealth || (async () => {
        const port = process.env.HEALTH_PORT || '3004';
        const url = process.env.NASSAJ_PREVIEW_HEALTH_URL || process.env.HEALTH_URL
            || `http://127.0.0.1:${port}/health`;
        const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        return response.ok ? response.json() : null;
    });
    const attempts = options.attempts || 90;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const health = await fetchHealth();
            if (health?.status === 'ok' && health.serverLoadedOid === expected.oid
                && health.serverLoadedBuildId === expected.buildId) return health;
        } catch { /* process may be between generations */ }
        await (options.wait || wait)(options.intervalMs ?? 500);
    }
    throw new Error('Runtime did not attest the exact expected OID/build generation.');
}

/** Execute only after the owner clicked the allowlisted action. */
export async function executeOwnerPreviewAction(root, injected = {}) {
    const request = inspectOwnerControlRequest(root);
    const previous = readLiveProvenance(root);
    const activate = injected.activate || ((options) => runActivator(root, 'activate', {
        ...request, oid: options.expectedOid, buildId: options.buildId, group: options.group,
    }));
    const rollback = injected.rollback || (() => runActivator(root, 'rollback', request));
    const restart = injected.restart || ((mode) => runSafeRestart(root, mode));
    await activate({ root, group: request.group, expectedOid: request.oid, buildId: request.buildId });
    const first = restart('execute');
    if (first.status !== 0) {
        rollback({ root, group: request.group });
        throw new Error(`Safe restart declined after promotion (${first.status ?? first.signal}).`);
    }
    try {
        const health = await pollExactRuntime(request, injected.runtime || {});
        await (injected.confirm || confirmServerLoaded)(root, health);
        return { status: 'loaded', oid: request.oid, buildId: request.buildId };
    } catch (error) {
        rollback({ root, group: request.group });
        const recovery = restart('execute');
        if (recovery.status !== 0) {
            throw new Error(`Exact runtime attestation failed and rollback restart was refused: ${error.message}`);
        }
        await pollExactRuntime(previous, injected.recoveryRuntime || injected.runtime || {});
        throw new Error(`Exact runtime attestation failed; previous generation restored: ${error.message}`);
    }
}

function parseArguments(argv) {
    const values = { gate: argv.includes('--gate') || argv.includes('--json'), locked: argv.includes('--locked') };
    for (let index = 0; index < argv.length; index += 1) {
        if (['--gate', '--json', '--exec', '--locked'].includes(argv[index])) continue;
        if (argv[index] === '--repo' && argv[index + 1]) { values.root = argv[++index]; continue; }
        throw new Error('Invalid owner preview action argument.');
    }
    return values;
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const root = path.resolve(args.root || ROOT);
    const delegated = await tryOrdinarySafeRestart(root, { gate: args.gate });
    if (delegated) {
        if (delegated.stdout) process.stdout.write(delegated.stdout);
        if (delegated.stderr) process.stderr.write(delegated.stderr);
        process.exitCode = delegated.status ?? 1;
        return;
    }
    if (args.gate) {
        inspectOwnerControlRequest(root);
        const gate = runSafeRestart(root, 'gate');
        if (gate.stdout) process.stdout.write(gate.stdout);
        if (gate.stderr) process.stderr.write(gate.stderr);
        process.exitCode = gate.status ?? 1;
        return;
    }
    if (!args.locked) {
        const result = spawnSync('flock', [
            '-x', '-w', '10', '-F', gitControlPath(root, 'nassaj-preview-owner-action.lock'),
            process.execPath, fileURLToPath(import.meta.url), '--exec', '--repo', root, '--locked',
        ], { cwd: root, stdio: 'inherit' });
        process.exitCode = result.status ?? 1;
        return;
    }
    const result = await executeOwnerPreviewAction(root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
