#!/usr/bin/env node
// release-upgrade-path-gate.mjs — prove the previous release can update to the
// candidate through its real update path (B-1584). See scripts/lib/upgrade-path-gate.mjs
// for what each leg runs and docs/RELEASING.md for the release-gate contract.
//
// Usage (standalone; materialises and installs both trees by commit):
//   node scripts/release-upgrade-path-gate.mjs \
//     --previous-tag v2.3.1.2 --candidate-ref main [--work-parent DIR] [--keep]
//   (trees and sandboxes default to ~/.nassaj-upgrade-path-gate, a private 0700 dir)
// Usage (release gate; trees already installed by the orchestrator):
//   node scripts/release-upgrade-path-gate.mjs --previous-tag <tag> --previous-root <dir> \
//     --candidate-root <dir> --candidate-commit <sha> --candidate-version <v> --source-repo <dir>
// One installed candidate alone, through the candidate-leaves leg only (ADR-204 S0):
//   node scripts/release-upgrade-path-gate.mjs --only candidate-leaves --candidate-ref v2.3.1.0
// Owner escape for a RECORDED known-incompatible baseline only (never candidate-leaves):
//   --acknowledge-upgrade-incompatible <tag>   (repeatable; see the policy file)
//
// Exit: 0 pass (or an acknowledged known-incompatible baseline), 1 the gate failed,
// 2 the gate could not run (usage, missing tree, sandbox error): fail closed.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEAVES_LEG } from './lib/upgrade-path-candidate-leaves.mjs';
import {
    assertDiskBacked, decideUpgradePath, formatUpgradePathReport, git, loadKnownIncompatible, runCandidateLeavesOnly,
    runUpgradePathLegs,
} from './lib/upgrade-path-gate.mjs';
import { ensurePrivateDirectory, installedTree } from './lib/upgrade-path-trees.mjs';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALUE_FLAGS = Object.freeze({
    '--previous-tag': 'previousTag', '--previous-root': 'previousRoot', '--candidate-root': 'candidateRoot',
    '--candidate-ref': 'candidateRef', '--candidate-commit': 'candidateCommit',
    '--candidate-version': 'candidateVersion', '--source-repo': 'sourceRepo', '--work-parent': 'workParent',
    '--only': 'only',
});

/** Parse argv; every value flag takes exactly one value. */
export function parseArgs(argv) {
    const options = { acknowledged: [], keep: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--keep') { options.keep = true; continue; }
        const key = token === '--acknowledge-upgrade-incompatible' ? 'acknowledged' : VALUE_FLAGS[token];
        const value = argv[index + 1];
        if (!key) throw new Error(`unknown argument: ${token}`);
        if (value == null || value.startsWith('--')) throw new Error(`${token} requires a value`);
        index += 1;
        if (key === 'acknowledged') options.acknowledged.push(value);
        else options[key] = value;
    }
    if (options.only !== undefined && options.only !== LEAVES_LEG) throw new Error(`--only accepts ${LEAVES_LEG}`);
    if (!options.only && !/^v\d+\.\d+\.\d+\.\d+$/.test(options.previousTag || '')) {
        throw new Error('--previous-tag vN.N.N.N is required');
    }
    if (!options.candidateRoot && !options.candidateRef) throw new Error('--candidate-root or --candidate-ref is required');
    return options;
}

/** The default cache and sandbox parent: private, under the operator's HOME, never TMPDIR. */
export function defaultWorkParent(home = os.homedir()) {
    return path.join(home, '.nassaj-upgrade-path-gate');
}

/** Fill in trees and commits the standalone mode has to produce itself. */
function resolveTrees(options) {
    const sourceRepo = path.resolve(options.sourceRepo || SOURCE_ROOT);
    const workParent = path.resolve(options.workParent || defaultWorkParent());
    ensurePrivateDirectory(workParent);
    assertDiskBacked(workParent);
    const treesRoot = path.join(workParent, 'trees');
    const candidateCommit = options.candidateCommit
        || git(sourceRepo, ['rev-parse', '--verify', `${options.candidateRef || 'HEAD'}^{commit}`]);
    const resolved = {
        ...options, sourceRepo, workParent, candidateCommit,
        candidateRoot: path.resolve(options.candidateRoot || installedTree({ sourceRepo, commit: candidateCommit, treesRoot })),
    };
    if (options.only) return resolved;
    const previousCommit = git(sourceRepo, ['rev-parse', '--verify', `${options.previousTag}^{commit}`]);
    return {
        ...resolved,
        previousRoot: path.resolve(options.previousRoot || installedTree({ sourceRepo, commit: previousCommit, treesRoot })),
    };
}

async function main() {
    let options;
    try {
        options = resolveTrees(parseArgs(process.argv.slice(2)));
    } catch (error) {
        process.stderr.write(`upgrade-path gate: ${error.message}\n`);
        return 2;
    }
    const started = Date.now();
    const report = options.only ? await runCandidateLeavesOnly(options) : await runUpgradePathLegs(options);
    const decision = decideUpgradePath(report, {
        knownIncompatible: loadKnownIncompatible(), acknowledged: options.acknowledged,
    });
    for (const line of formatUpgradePathReport(report, decision)) process.stdout.write(`${line}\n`);
    process.stdout.write(`  elapsed: ${Math.round((Date.now() - started) / 1000)}s\n`);
    return decision.verdict === 'fail' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then((code) => { process.exitCode = code; }, (error) => {
        process.stderr.write(`upgrade-path gate: ${error.message}\n`);
        process.exitCode = 2;
    });
}
