#!/usr/bin/env node
// upgrade-path-candidate-build.mjs — the candidate build of the upgrade-path gate (B-1584).
//
// The updater under test spawns its candidate builder as
//   node <builder> --plan <plan>
// (the exact `source-update-candidate.mjs` it resolved). The gate's command runner
// re-points that spawn at this file, inserting the builder path:
//   node upgrade-path-candidate-build.mjs <builder> --plan <plan>
// so the spawn still goes through the updater's real runner (durable effect
// registration, effect gate, output capture). Here the RESOLVED builder's own
// buildSourceUpdateCandidate runs: plan validation, source provenance checks,
// node_modules staging, tree hashing and the manifest writer are all its code.
// Only the expensive steps are replaced through its documented injection seams:
// `npm ci` creates an empty staged node_modules, `npm ls` returns an empty list,
// and the client/server builders write a BUILD_PROVENANCE stamp instead of a build.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** A deterministic 64-hex build id for one domain of one transaction. */
function buildId(domain, options) {
    return createHash('sha256').update(`${domain}:${options.candidateRoot}:${options.releaseCommit}`).digest('hex');
}

/** Stand-in builder: stamps the output root exactly as the real builders' provenance reads. */
function fakeBuilder(domain) {
    return async (options) => {
        mkdirSync(options.outputRoot, { recursive: true, mode: 0o700 });
        const stamp = { commit: options.releaseCommit, version: options.version, buildId: buildId(domain, options) };
        writeFileSync(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), `${JSON.stringify(stamp)}\n`);
        return stamp;
    };
}

/** Replace only npm; every other command (git provenance checks) runs for real. */
function fakeNpmRun(realCommand) {
    return (executable, args, options = {}) => {
        if (executable !== 'npm') return realCommand(executable, args, options);
        if (args[0] === 'ci') {
            const modules = path.join(options.cwd, 'node_modules');
            mkdirSync(modules, { recursive: true, mode: 0o700 });
            writeFileSync(path.join(modules, '.upgrade-path-gate'), 'staged by the upgrade-path gate\n');
            return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'ls') return { status: 0, stdout: '{"dependencies":{}}', stderr: '' };
        throw new Error(`upgrade-path candidate build: unexpected npm ${args[0]}`);
    };
}

async function main() {
    const [builder, flag, planFile] = process.argv.slice(2);
    if (!builder || flag !== '--plan' || !planFile) {
        throw new Error('Usage: upgrade-path-candidate-build.mjs <builder> --plan <plan>');
    }
    const module = await import(pathToFileURL(path.resolve(builder)).href);
    const manifest = await module.buildSourceUpdateCandidate(planFile, {
        run: fakeNpmRun(module.command), buildClient: fakeBuilder('client'), buildServer: fakeBuilder('server'),
    });
    process.stdout.write(`${JSON.stringify({ txId: manifest.txId, releaseCommit: manifest.releaseCommit })}\n`);
}

main().catch((error) => {
    process.stderr.write(`[upgrade-path-candidate-build] ${error?.message || error}\n`);
    process.exitCode = 1;
});
