/**
 * ADR-207 §3.5 step 4 (T-2024 S4): hash the three trees of a prestaged
 * candidate in a CHILD process. `hashTree` is fully synchronous and reads the
 * whole candidate (≈1.3 GB with node_modules); run in the server it would stop
 * the event loop for the whole read. updateSource() spawns this file through
 * its guarded runner (`process.execPath <this file> <json>`), so the hash runs
 * as a fenced, registered effect of the job and the server keeps serving.
 *
 * Input (argv[2]): `{"client": dir, "server": dir, "nodeModules": dir}`, all
 * absolute. Output (stdout): `{"client": {sha256, files}, ...}`. Any error is
 * one line on stderr and exit code 1; the caller then builds normally.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashTree } from '../../scripts/lib/source-update-tree-identity.mjs';

export const TREE_NAMES = Object.freeze(['client', 'server', 'nodeModules']);

/**
 * Hash each named tree; the keys must be exactly TREE_NAMES with absolute paths.
 * @param {Record<string, string>} trees
 * @returns {Record<string, {sha256: string, files: number}>}
 */
export function hashCandidateTrees(trees) {
    const names = Object.keys(trees ?? {}).sort();
    if (names.join(',') !== [...TREE_NAMES].sort().join(',')
        || !TREE_NAMES.every((name) => typeof trees[name] === 'string' && path.isAbsolute(trees[name]))) {
        throw new Error('prestage_tree_input_invalid');
    }
    return Object.fromEntries(TREE_NAMES.map((name) => [name, hashTree(trees[name])]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(`${JSON.stringify(hashCandidateTrees(JSON.parse(process.argv[2] ?? 'null')))}\n`);
    } catch (error) {
        process.stderr.write(`${String(error?.message || 'prestage_tree_hash_failed').slice(0, 200)}\n`);
        process.exitCode = 1;
    }
}
