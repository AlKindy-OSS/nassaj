#!/usr/bin/env node
/** Build reviewed release candidates without publishing either live artefact. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORWARD_PROFILE_ID } from './lib/compatible-forward-release-profile.mjs';
import { buildClientReleaseCandidate } from './client-build-atomic.mjs';
import { buildServerReleaseCandidate } from './server-build-atomic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function value(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }

export async function buildReleaseCandidate({ sourceRoot = ROOT, candidateRoot, version, commit, publicVite = {}, profile = 'default' }) {
    if (!['default', FORWARD_PROFILE_ID].includes(profile)) throw new Error('Release build profile is invalid.');
    if (!candidateRoot) throw new Error('Release candidate root is required.');
    const candidate = path.resolve(candidateRoot);
    mkdirSync(candidate, { recursive: false, mode: 0o700 });
    const client = await buildClientReleaseCandidate({ sourceRoot, candidateRoot: candidate,
        outputRoot: path.join(candidate, 'client'), releaseCommit: commit, version, publicVite });
    const server = buildServerReleaseCandidate({ sourceRoot, candidateRoot: candidate,
        outputRoot: path.join(candidate, 'server'), releaseCommit: commit, version, profile });
    return Object.freeze({ candidateRoot: candidate, client, server });
}

async function main() {
    const argv = process.argv.slice(2);
    const result = await buildReleaseCandidate({ candidateRoot: value(argv, '--output'),
        version: value(argv, '--version'), commit: value(argv, '--commit'), profile: value(argv, '--profile') || 'default' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { console.error(`[release-candidate] ${error.message}`); process.exitCode = 1; });
}
