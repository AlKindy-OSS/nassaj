#!/usr/bin/env node
/** Bridge a successful session-commit-arbiter result into the OID preview queue. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializePreviewSnapshot, readPreviewState } from './preview-oid-pipeline.mjs';
import { enqueuePreviewEvent } from './local-preview-ledger.mjs';

const CLIENT_PREFIXES = [
    'src/', 'public/', 'docs/team-wiki/', 'index.html', 'vite.config.js',
    'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', 'tsconfig.preview.json',
];
const SERVER_PREFIXES = ['server/', 'scripts/', 'server.js'];
const BOTH = new Set(['package.json', 'package-lock.json']);

function matches(pathname, prefixes) {
    return prefixes.some((prefix) => prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix);
}

/** Map canonical committed paths to independently buildable preview domains. */
export function previewDomainsForPaths(changedPaths) {
    if (!Array.isArray(changedPaths)) throw new Error('Arbiter changedPaths must be an array.');
    const domains = new Set();
    for (const pathname of changedPaths) {
        if (typeof pathname !== 'string' || pathname.startsWith('/') || pathname.includes('..')
            || pathname.includes('\\') || pathname === '') {
            throw new Error('Arbiter returned a non-canonical changed path.');
        }
        if (BOTH.has(pathname) || pathname.startsWith('shared/')) {
            domains.add('client');
            domains.add('server');
        } else {
            if (matches(pathname, CLIENT_PREFIXES)) domains.add('client');
            if (matches(pathname, SERVER_PREFIXES)) domains.add('server');
        }
    }
    return [...domains].sort();
}

/** Register and materialize one arbiter result without consulting the working tree. */
export async function dispatchCommittedPreview(root, group, result) {
    if (!result || !/^[0-9a-f]{40}$/.test(result.commit || '')) {
        throw new Error('Arbiter result does not contain an exact commit OID.');
    }
    const domains = previewDomainsForPaths(result.changedPaths);
    if (!domains.length) return { commit: result.commit, group, domains, sourceRoot: null, state: null };
    if (!Number.isSafeInteger(result.sequence) || result.sequence < 1) {
        throw new Error('Arbiter result does not contain a global monotonic sequence.');
    }
    const event = enqueuePreviewEvent(root, { sequence: result.sequence, oid: result.commit, domains });
    const state = readPreviewState(root, event.group);
    const sourceRoot = await materializePreviewSnapshot(root, result.commit);
    return { commit: result.commit, sequence: result.sequence, group: event.group, domains, sourceRoot, state };
}

function parseArguments(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        if (!argv[index]?.startsWith('--') || argv[index + 1] == null) throw new Error('Invalid dispatch argument.');
        values[argv[index].slice(2)] = argv[index + 1];
    }
    return values;
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const root = path.resolve(args.repo || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    if (!args.group) throw new Error('--group is required.');
    const input = readFileSync(0, 'utf8');
    const result = await dispatchCommittedPreview(root, args.group, JSON.parse(input));
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
