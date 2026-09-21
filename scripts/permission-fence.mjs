#!/usr/bin/env node
/**
 * Operator CLI for audited ADR-134 fence recovery (B-953). The snapshot, audit and
 * delete logic lives in server/modules/execution-permissions/permission-fence.js,
 * shared with the owner-only settings screen (T-1770); this file only parses argv,
 * opens the database and reports. --force acknowledges open leases/claims;
 * --force-external acknowledges possible external effects. Neither constitutes proof.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

import Database from 'better-sqlite3';

import { resolveDatabaseFilePath } from '../server/modules/database/database-path.js';
import {
    discoverScopedFences,
    findOrphanCandidates,
    liftFence,
    listFences,
    printable,
    validateSelector,
} from '../server/modules/execution-permissions/permission-fence.js';

export { discoverScopedFences, findOrphanCandidates, liftFence, listFences };

/** Parse argv into a validated command; throws on any malformed input. */
export function parseArguments(argv) {
    const [command, ...rest] = argv;
    if (!['list', 'lift'].includes(command)) throw new Error('usage: permission-fence.mjs <list|lift> [--generation N | --scope-kind KIND --scope-key KEY]');
    if (command === 'list' && rest.length === 0) return { command };
    const options = { command, generation: null, reason: null, force: false, forceExternal: false };
    const seen = new Set();
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (seen.has(token)) throw new Error(`duplicate option ${token}`);
        seen.add(token);
        if (token === '--force') options.force = true;
        else if (token === '--force-external') options.forceExternal = true;
        else if (['--generation', '--reason', '--scope-kind', '--scope-key'].includes(token)) {
            const value = rest[++index];
            if (token === '--generation') options.generation = Number(value);
            else if (token === '--reason') options.reason = value;
            else if (token === '--scope-kind') options.scopeKind = value;
            else options.scopeKey = value;
        } else throw new Error(`unknown option ${token}`);
    }
    validateSelector(options);
    if (command === 'list' && (seen.has('--reason') || options.force || options.forceExternal)) throw new Error('list accepts only a fence selector');
    if (command === 'lift' && !printable(options.reason, 512)) throw new Error('lift requires a printable --reason');
    return options;
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    const databasePath = resolveDatabaseFilePath(process.env);
    if (!fs.existsSync(databasePath)) throw new Error(`database not found: ${databasePath}`);
    const database = new Database(databasePath, { readonly: options.command === 'list' });
    try {
        if (options.command === 'list') {
            console.log(JSON.stringify({ databasePath, fences: listFences(database, options), ...discoverScopedFences(database) }, null, 2));
            return;
        }
        const ps = spawnSync('ps', ['-eo', 'pid,ppid,etime,args'], { encoding: 'utf8' });
        const orphans = ps.status === 0 ? findOrphanCandidates(ps.stdout) : [];
        if (orphans.length > 0) {
            console.warn('[permission-fence] launcher processes without a live parent — verify they are not the fenced effect:');
            for (const orphan of orphans) console.warn(`  pid=${orphan.pid} up=${orphan.etime} ${orphan.args.slice(0, 120)}`);
        }
        const audit = liftFence(database, options);
        console.log(JSON.stringify({ databasePath, lifted: audit }, null, 2));
        if (!audit.completionAuditRecorded) process.exitCode = 1;
    } finally {
        database.close();
    }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
    try {
        main();
    } catch (error) {
        console.error(`[permission-fence] ${error.message}`);
        process.exitCode = 1;
    }
}
