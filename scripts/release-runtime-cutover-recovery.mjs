#!/usr/bin/env node
/** Boot gate: resume only an existing first-cutover journal; normal boots are a no-op. */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = '/etc/nassaj/release-runtime-first-cutover.json';
try {
    if (process.geteuid?.() !== 0 || process.argv.length !== 2 || realpathSync(CONFIG) !== CONFIG) throw new Error('recovery_authority_invalid');
    const configMetadata = lstatSync(CONFIG);
    if (!configMetadata.isFile() || configMetadata.isSymbolicLink() || configMetadata.uid !== 0
        || (configMetadata.mode & 0o777) !== 0o600) throw new Error('recovery_config_unsafe');
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')); const journal = path.join(config.controlRoot, 'first-cutover.json');
    if (!existsSync(journal)) { process.stdout.write('{"state":"not_required"}\n'); }
    else {
        const metadata = lstatSync(journal); const value = JSON.parse(readFileSync(journal, 'utf8'));
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('recovery_journal_unsafe');
        if (['committed', 'rolled_back'].includes(value.state)) process.stdout.write(`{"state":"${value.state}"}\n`);
        else if (value.state === 'manual_recovery') throw new Error('recovery_manual_intervention_required');
        else {
            const operator = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-runtime-cutover.mjs');
            const output = execFileSync('/usr/bin/node', [operator, 'execute'], { encoding: 'utf8', timeout: 900_000,
                maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin', HOME: '/root', LC_ALL: 'C' } });
            process.stdout.write(output);
        }
    }
} catch (error) { process.stderr.write(`Nassaj cutover recovery blocked (${error?.message || 'failed'}).\n`); process.exitCode = 78; }
