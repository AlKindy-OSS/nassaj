#!/usr/bin/env node
/** Fixed-config operator entry for the one-time legacy-to-release-runtime cutover. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { prepareLegacyMigration } from './prepare-legacy-release-runtime.mjs';
import { executeReleaseRuntimeCutover, planReleaseRuntimeCutover } from './lib/release-runtime-cutover.mjs';
import { createStaticHostOperations } from './lib/release-runtime-owner-adapter.mjs';

const CONFIG = '/etc/nassaj/release-runtime-first-cutover.json';
const CONFIG_KEYS = ['approvalFile', 'controlRoot', 'dispatcher', 'dispatcherSha256', 'expected', 'ownerApprovalPublicKeyFile',
    'prepare', 'schema'];

function readRootFile(file, mode, maximumBytes = 256 * 1024) {
    const canonical = realpathSync(file); const before = lstatSync(canonical);
    if (canonical !== file || !before.isFile() || before.isSymbolicLink() || before.uid !== 0
        || (before.mode & 0o777) !== mode || before.size < 1 || before.size > maximumBytes) {
        throw new Error('operator_file_unsafe');
    }
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) {
            throw new Error('operator_file_changed');
        }
        return readFileSync(fd);
    } finally { closeSync(fd); }
}

function loadConfig() {
    if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) throw new Error('operator_root_required');
    const value = JSON.parse(readRootFile(CONFIG, 0o600));
    if (value?.schema !== 'nassaj-release-runtime-first-cutover-config/v1'
        || Object.keys(value).sort().join(',') !== CONFIG_KEYS.join(',')) throw new Error('operator_config_invalid');
    return value;
}

async function main() {
    const action = process.argv[2];
    if (!['prepare', 'plan', 'execute'].includes(action) || process.argv.length !== 3) {
        throw new Error('operator_action_invalid');
    }
    const config = loadConfig();
    if (action === 'prepare') return prepareLegacyMigration(config.prepare);
    const operations = createStaticHostOperations({ dispatcher: config.dispatcher,
        dispatcherSha256: config.dispatcherSha256 });
    if (action === 'plan') return planReleaseRuntimeCutover({ expected: config.expected, operations });
    const ownerApprovalPublicKeyPem = readRootFile(config.ownerApprovalPublicKeyFile, 0o400, 16_384);
    return executeReleaseRuntimeCutover({ expected: config.expected, operations, controlRoot: config.controlRoot,
        approvalFile: config.approvalFile, ownerApprovalPublicKeyPem });
}

try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
catch (error) {
    process.stderr.write(`Nassaj first-cutover operator blocked (${error?.message || 'failed'}).\n`);
    process.exitCode = 78;
}
