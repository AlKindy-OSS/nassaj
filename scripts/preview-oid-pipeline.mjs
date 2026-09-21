#!/usr/bin/env node
/**
 * Commit-addressed local preview control plane.
 *
 * Git refs are the crash-safe source of truth.  The working tree is never used
 * as a build input: callers materialize a read-only source snapshot for one
 * exact commit and write build artefacts outside that snapshot.
 */
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
} from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REF_ROOT = 'refs/nassaj/previews/v1';
const SNAPSHOT_DIRECTORY = '.nassaj-local-preview/oid-snapshots';
const DOMAINS = new Set(['client', 'server']);
const DOMAIN_STATES = {
    client: ['desired', 'candidate', 'promoted', 'served'],
    server: ['desired', 'candidate', 'promoted', 'loaded'],
};

function git(root, args, options = {}) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
    if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || '').trim();
        throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
    }
    return String(result.stdout || '').trim();
}

function validateGroup(group) {
    if (typeof group !== 'string' || group.length > 96
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(group)
        || group.includes('..') || group.endsWith('.lock')) {
        throw new Error('Preview coherence group is invalid.');
    }
    return group;
}

function validateDomain(domain) {
    if (!DOMAINS.has(domain)) throw new Error('Preview domain must be client or server.');
    return domain;
}

function groupRef(group) {
    return `${REF_ROOT}/groups/${validateGroup(group)}/desired`;
}

function stateRef(group, domain, state) {
    validateGroup(group);
    validateDomain(domain);
    if (!DOMAIN_STATES[domain].includes(state)) {
        throw new Error(`Invalid ${domain} preview state: ${state}.`);
    }
    return `${REF_ROOT}/groups/${group}/${domain}/${state}`;
}

function readRef(root, ref) {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
        cwd: root, encoding: 'utf8',
    });
    if (result.status === 1) return null;
    if (result.status !== 0) throw new Error(`Cannot read preview ref ${ref}.`);
    const oid = result.stdout.trim();
    return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

/** Resolve an input revision to one exact commit object. */
export function resolvePreviewOid(root, revision) {
    const oid = git(root, ['rev-parse', '--verify', `${revision}^{commit}`]);
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error('Preview revision did not resolve to a SHA-1 commit.');
    return oid;
}

function updateRef(root, ref, oid, expected = null) {
    const args = ['update-ref', '-m', `nassaj preview: ${ref}`, ref, oid];
    if (expected !== null) args.push(expected);
    git(root, args);
}

/**
 * Bind both build domains to one immutable commit.  Retrying after a crash is
 * idempotent; a different OID for the same group is rejected.
 */
export function requestPreview(root, { group, oid: revision, domains = ['client', 'server'] }, hooks = {}) {
    validateGroup(group);
    const selectedDomains = [...new Set(domains.map(validateDomain))];
    if (!selectedDomains.length) throw new Error('At least one preview domain is required.');
    const oid = resolvePreviewOid(root, revision);
    const commonRef = groupRef(group);
    const existing = readRef(root, commonRef);
    if (existing && existing !== oid) {
        throw new Error(`Preview group ${group} is already bound to ${existing}.`);
    }
    if (!existing) updateRef(root, commonRef, oid, '0'.repeat(40));
    hooks.afterGroupRef?.();
    for (const domain of selectedDomains) {
        const desiredRef = stateRef(group, domain, 'desired');
        const current = readRef(root, desiredRef);
        if (current && current !== oid) throw new Error(`${domain} desired preview does not match its coherence group.`);
        if (!current) updateRef(root, desiredRef, oid, '0'.repeat(40));
    }
    return readPreviewState(root, group);
}

/** Move one domain through desired -> candidate -> promoted -> served/loaded. */
export function advancePreview(root, { group, domain, state, oid: revision }) {
    validateGroup(group);
    validateDomain(domain);
    const states = DOMAIN_STATES[domain];
    const index = states.indexOf(state);
    if (index < 1) throw new Error('Use requestPreview to establish desired state.');
    const oid = resolvePreviewOid(root, revision);
    const desired = readRef(root, groupRef(group));
    if (desired !== oid || readRef(root, stateRef(group, domain, 'desired')) !== oid) {
        throw new Error('Preview state OID does not match the coherence group desired OID.');
    }
    const predecessor = stateRef(group, domain, states[index - 1]);
    if (readRef(root, predecessor) !== oid) {
        throw new Error(`Cannot mark ${domain} ${state} before ${states[index - 1]}.`);
    }
    const ref = stateRef(group, domain, state);
    const current = readRef(root, ref);
    if (current && current !== oid) throw new Error(`${domain} ${state} is already bound to another commit.`);
    if (!current) updateRef(root, ref, oid, '0'.repeat(40));
    return readPreviewState(root, group);
}

/** Read the durable desired/candidate/promoted/runtime ledger from Git refs. */
export function readPreviewState(root, group) {
    validateGroup(group);
    const state = { schemaVersion: 1, group, desired: readRef(root, groupRef(group)), client: {}, server: {} };
    for (const domain of DOMAINS) {
        for (const item of DOMAIN_STATES[domain]) {
            state[domain][item] = readRef(root, stateRef(group, domain, item));
        }
    }
    state.coherent = [...DOMAINS].every((domain) => Object.values(state[domain])
        .filter(Boolean).every((oid) => oid === state.desired));
    return state;
}

function makeTreeReadOnly(directory) {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink()) {
        throw new Error(`Preview snapshot contains a symbolic link: ${path.basename(directory)}.`);
    }
    if (metadata.isDirectory()) {
        for (const child of readdirSync(directory)) makeTreeReadOnly(path.join(directory, child));
        chmodSync(directory, 0o555);
    } else if (metadata.isFile()) {
        chmodSync(directory, metadata.mode & 0o111 ? 0o555 : 0o444);
    }
}

function makeTreeRemovable(directory) {
    if (!existsSync(directory)) return;
    const metadata = lstatSync(directory);
    if (!metadata.isSymbolicLink() && metadata.isDirectory()) {
        chmodSync(directory, 0o700);
        for (const child of readdirSync(directory)) makeTreeRemovable(path.join(directory, child));
    }
}

function extractArchive(root, oid, destination) {
    return new Promise((resolve, reject) => {
        const archive = spawn('git', ['archive', '--format=tar', oid], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        const extractor = spawn('tar', ['-x', '-f', '-', '-C', destination, '--no-same-owner', '--no-same-permissions'], {
            cwd: root, stdio: ['pipe', 'ignore', 'pipe'],
        });
        let archiveError = '';
        let extractError = '';
        archive.stderr.on('data', (chunk) => { archiveError += chunk; });
        extractor.stderr.on('data', (chunk) => { extractError += chunk; });
        archive.stdout.pipe(extractor.stdin);
        let archiveCode = null;
        let extractCode = null;
        const finish = () => {
            if (archiveCode === null || extractCode === null) return;
            if (archiveCode === 0 && extractCode === 0) resolve();
            else reject(new Error(`Preview snapshot extraction failed: ${archiveError || extractError}`));
        };
        archive.on('error', reject);
        extractor.on('error', reject);
        archive.on('close', (code) => { archiveCode = code; finish(); });
        extractor.on('close', (code) => { extractCode = code; finish(); });
    });
}

/**
 * Materialize a commit, never the mutable working tree.  Atomic rename makes a
 * completed snapshot distinguishable from a process killed during extraction.
 */
export async function materializePreviewSnapshot(root, revision, options = {}) {
    const oid = resolvePreviewOid(root, revision);
    const parent = path.resolve(root, options.parent || SNAPSHOT_DIRECTORY);
    const allowedParent = path.resolve(root, SNAPSHOT_DIRECTORY);
    if (parent !== allowedParent) throw new Error('Preview snapshots must use the fixed on-disk directory.');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const destination = path.join(parent, oid);
    if (existsSync(destination)) return destination;
    const temporary = path.join(parent, `.extracting-${oid}-${process.pid}`);
    if (existsSync(temporary)) {
        makeTreeRemovable(temporary);
        rmSync(temporary, { recursive: true, force: true });
    }
    mkdirSync(temporary, { mode: 0o700 });
    try {
        await extractArchive(root, oid, temporary);
        makeTreeReadOnly(temporary);
        try {
            renameSync(temporary, destination);
        } catch (error) {
            if (!existsSync(destination)) throw error;
        }
        return destination;
    } finally {
        if (existsSync(temporary)) {
            makeTreeRemovable(temporary);
            rmSync(temporary, { recursive: true, force: true });
        }
    }
}

/** Remove only interrupted extraction directories; committed snapshots remain. */
export function reconcilePreviewSnapshots(root) {
    const parent = path.join(root, SNAPSHOT_DIRECTORY);
    if (!existsSync(parent)) return [];
    const removed = [];
    for (const name of readdirSync(parent)) {
        if (!/^\.extracting-[0-9a-f]{40}-\d+$/.test(name)) continue;
        const target = path.join(parent, name);
        makeTreeRemovable(target);
        rmSync(target, { recursive: true, force: true });
        removed.push(name);
    }
    return removed;
}

function parseArguments(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        if (!key?.startsWith('--') || argv[index + 1] == null) throw new Error(`Invalid argument: ${key || ''}`);
        values[key.slice(2)] = argv[index + 1];
    }
    return values;
}

async function main() {
    const [command, ...argv] = process.argv.slice(2);
    const args = parseArguments(argv);
    const root = path.resolve(args.root || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    if (command === 'request') {
        const result = requestPreview(root, { group: args.group, oid: args.oid, domains: (args.domains || 'client,server').split(',') });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === 'advance') {
        const result = advancePreview(root, { group: args.group, domain: args.domain, state: args.state, oid: args.oid });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === 'status') {
        process.stdout.write(`${JSON.stringify(readPreviewState(root, args.group), null, 2)}\n`);
    } else if (command === 'materialize') {
        process.stdout.write(`${await materializePreviewSnapshot(root, args.oid)}\n`);
    } else if (command === 'reconcile') {
        process.stdout.write(`${JSON.stringify(reconcilePreviewSnapshots(root))}\n`);
    } else {
        throw new Error('Usage: preview-oid-pipeline.mjs request|advance|status|materialize|reconcile ...');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
