#!/usr/bin/env node
/** Early-boot gate restore: fixed config and fixed offline operation only. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';

import { restoreReleaseRuntimeMaintenanceGateOffline } from './lib/release-runtime-host-operations.mjs';

const CONFIG = '/etc/nassaj/release-runtime-host.json';
function readRootConfig() {
    if (process.geteuid?.() !== 0 || process.argv.length !== 2 || realpathSync(CONFIG) !== CONFIG) {
        throw new Error('gate_restore_authority_invalid');
    }
    const before = lstatSync(CONFIG);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || (before.mode & 0o777) !== 0o600
        || before.size < 2 || before.size > 256 * 1024) throw new Error('gate_restore_config_unsafe');
    const fd = openSync(CONFIG, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('gate_restore_config_changed');
        return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
}

try {
    const config = readRootConfig();
    const result = await restoreReleaseRuntimeMaintenanceGateOffline(config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
    process.stderr.write(`Nassaj early gate restore blocked (${error?.message || 'failed'}).\n`); process.exitCode = 78;
}
