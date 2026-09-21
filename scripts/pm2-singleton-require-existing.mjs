#!/usr/bin/env node
/** Preflight one already-running PM2 supervisor without opening either PM2 socket. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decidePm2SingletonGuard } from './lib/pm2-singleton-guard.mjs';
import { observeStableExistingPm2, withPm2SingletonLease } from './lib/pm2-singleton-observer.mjs';

const SELF = fileURLToPath(import.meta.url);
const fail = code => { throw Error(`pm2_singleton_preflight_${code}`); };

function parseArguments(argv) {
    const names = ['--home', '--expected-executable', '--owner-uid', '--owner-gid', '--lock'];
    if (argv.length !== names.length * 2) fail('arguments_invalid');
    const parsed = {};
    for (let index = 0; index < argv.length; index += 2) {
        if (!names.includes(argv[index]) || Object.hasOwn(parsed, argv[index])) fail('arguments_invalid');
        parsed[argv[index]] = argv[index + 1];
    }
    const ownerUid = Number(parsed['--owner-uid']); const ownerGid = Number(parsed['--owner-gid']);
    if (!Number.isSafeInteger(ownerUid) || ownerUid < 0 || !Number.isSafeInteger(ownerGid) || ownerGid < 0) {
        fail('arguments_invalid');
    }
    return { homePath: parsed['--home'], expectedExecutable: parsed['--expected-executable'], ownerUid, ownerGid,
        lockPath: parsed['--lock'] };
}

function displayResult(decision) {
    const supervisor = Object.freeze({ pid: decision.supervisor.pid, startTicks: decision.supervisor.startTicks,
        uid: decision.supervisor.uid, exe: decision.supervisor.exe, bootId: decision.supervisor.bootId });
    return Object.freeze({ schema: 'nassaj-pm2-singleton-preflight-result/v1', mode: decision.mode,
        action: decision.action, supervisor });
}

/** Return a display-only DTO; the guard decision capability never escapes its callback lease. */
export async function requireExistingPm2(settings, deps = {}) {
    return withPm2SingletonLease(settings, lease => {
        const observed = observeStableExistingPm2(settings, deps);
        const request = { schema: 'nassaj-pm2-singleton-guard-request/v1', mode: 'require-existing',
            homePath: settings.homePath, ownerUid: settings.ownerUid, ownerGid: settings.ownerGid,
            bootId: observed.initial.bootId, expectedExecutable: settings.expectedExecutable };
        return displayResult(decidePm2SingletonGuard(request, observed.initial, observed.rescan, lease));
    }, deps);
}

async function main() {
    process.stdout.write(`${JSON.stringify(await requireExistingPm2(parseArguments(process.argv.slice(2))))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
    main().catch(error => {
        const message = /^(?:pm2_singleton_(?:observer|guard|preflight))_[a-z_]+$/.test(error?.message || '')
            ? error.message : 'pm2_singleton_preflight_failed';
        process.stderr.write(`${message}\n`); process.exitCode = 1;
    });
}
