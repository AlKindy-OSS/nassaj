#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { installReleaseRuntimeRecovery } from './lib/release-runtime-recovery-installer.mjs';

const CONFIG = '/etc/nassaj/release-runtime-host.json';
try {
    if (process.argv.length !== 2 || process.geteuid?.() !== 0 || realpathSync(CONFIG) !== CONFIG) throw new Error('recovery_install_authority_invalid');
    const metadata = lstatSync(CONFIG);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o600) {
        throw new Error('recovery_install_config_unsafe');
    }
    process.stdout.write(`${JSON.stringify(installReleaseRuntimeRecovery(JSON.parse(readFileSync(CONFIG, 'utf8'))))}\n`);
} catch (error) { process.stderr.write(`Nassaj recovery install blocked (${error?.message || 'failed'}).\n`); process.exitCode = 78; }
