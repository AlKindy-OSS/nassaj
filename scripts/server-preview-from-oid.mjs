#!/usr/bin/env node
/** Build a server candidate from one immutable commit snapshot, never from the shared working tree. */
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { advancePreview, readPreviewState, resolvePreviewOid } from './preview-oid-pipeline.mjs';
import { readPreviewLedger, recordPreviewLedgerEvent } from './local-preview-ledger.mjs';
import { gitControlPath } from './git-control-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceGeneration(group) {
    const match = String(group || '').match(/^event-(\d{16})$/);
    return match ? Number(match[1]) : 0;
}

function loadedServerBuildId(root) {
    try {
        const value = JSON.parse(readFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), 'utf8')).buildId;
        return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
    } catch { return null; }
}

function command(executable, args, options = {}) {
    const result = spawnSync(executable, args, { encoding: 'utf8', stdio: 'inherit', ...options });
    if (result.status !== 0) {
        throw new Error(`${path.basename(executable)} failed (${result.status ?? result.signal}).`);
    }
    return result;
}

function resourcesSafe() {
    let available = os.freemem();
    try {
        const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
        if (match) available = Number(match[1]) * 1024;
    } catch { /* portable fallback */ }
    return 1 - available / os.totalmem() < 0.8
        && os.loadavg()[0] / Math.max(1, os.cpus().length) < 0.8;
}

function walkImmutable(entry) {
    const metadata = lstatSync(entry);
    if (metadata.isSymbolicLink()) throw new Error(`OID source snapshot contains a symbolic link: ${entry}`);
    if ((metadata.mode & 0o222) !== 0) throw new Error(`OID source snapshot contains a writable entry: ${entry}`);
    if (metadata.isDirectory()) {
        for (const child of readdirSync(entry)) walkImmutable(path.join(entry, child));
    } else if (!metadata.isFile()) {
        throw new Error(`OID source snapshot contains a special file: ${entry}`);
    }
}

/** Require the fixed materializer path, an exact commit, and a wholly read-only tree. */
export function assertOidSourceSnapshot(root, sourceRoot, expectedOid) {
    const oid = resolvePreviewOid(root, expectedOid);
    if (oid !== expectedOid) throw new Error('--expected-oid must be the full exact commit OID.');
    const expected = path.join(root, '.nassaj-local-preview', 'oid-snapshots', oid);
    if (path.resolve(sourceRoot) !== expected) throw new Error('--source-root is not the fixed snapshot path for --expected-oid.');
    const rootMetadata = lstatSync(sourceRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('OID source snapshot root is invalid.');
    walkImmutable(sourceRoot);
    return oid;
}

function writeManifest(directory, manifest) {
    writeFileSync(path.join(directory, 'SERVER_INPUT_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o644, flag: 'wx',
    });
}

function readCandidateBuildId(directory) {
    try {
        const value = JSON.parse(readFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), 'utf8')).buildId;
        return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
    } catch { return null; }
}

function ensureRealDirectory(directory) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('Server staging scripts path is unsafe.');
    }
}

function readVersion(sourceRoot) {
    const version = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Snapshot package version is invalid.');
    return version;
}

function writeProvenance(directory, sourceRoot, oid, buildId) {
    const version = readVersion(sourceRoot);
    const record = {
        artifact: 'server', version, commit: oid, baseCommit: oid,
        commitShort: oid.slice(0, 8), branch: null, describe: oid.slice(0, 12),
        dirty: false, dirtyFiles: 0, builtAt: new Date().toISOString(), buildId,
    };
    writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o644, flag: 'wx',
    });
    return version;
}

function storeCandidate(root, staging, buildId, oid) {
    const parent = path.join(root, '.nassaj-local-preview', 'server-candidates');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const candidate = path.join(parent, buildId);
    if (existsSync(candidate)) {
        const metadata = lstatSync(candidate);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || readCandidateBuildId(candidate) !== buildId) {
            throw new Error('Existing OID server candidate has a conflicting identity.');
        }
        const existingProvenance = JSON.parse(readFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), 'utf8'));
        if (existingProvenance.commit === oid && existingProvenance.baseCommit === oid) {
            rmSync(staging, { recursive: true, force: false });
            return candidate;
        }
        if (!/^[a-f0-9]{40}$/.test(existingProvenance.commit || '')
            || existingProvenance.commit !== existingProvenance.baseCommit) {
            throw new Error('Existing OID server candidate provenance is invalid.');
        }
        // The content fingerprint may legitimately be equal for two commits
        // (for example, a docs-only commit). Control-plane identity still binds
        // the artefact to one exact OID, so replace the stale provenance-bearing
        // generation instead of attributing it to the newer commit.
        const displaced = path.join(parent, `.superseded-${buildId}-${existingProvenance.commit}-${process.pid}`);
        renameSync(candidate, displaced);
        try {
            renameSync(staging, candidate);
            if (readCandidateBuildId(candidate) !== buildId) throw new Error('Rebuilt OID candidate identity verification failed.');
            const replacement = JSON.parse(readFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), 'utf8'));
            if (replacement.commit !== oid || replacement.baseCommit !== oid) {
                throw new Error('Rebuilt OID candidate provenance does not match the expected commit.');
            }
            rmSync(displaced, { recursive: true, force: true });
            return candidate;
        } catch (error) {
            rmSync(candidate, { recursive: true, force: true });
            renameSync(displaced, candidate);
            throw error;
        }
    }
    renameSync(staging, candidate);
    if (readCandidateBuildId(candidate) !== buildId) {
        throw new Error('Stored OID server candidate failed identity verification.');
    }
    return candidate;
}

function aliasOutDir(sourceRoot, staging) {
    return path.relative(path.join(sourceRoot, 'server'), staging);
}

/** Compile and store a candidate. Live dist-server and the running process are never changed. */
export async function buildServerPreviewFromOid(options, injected = {}) {
    const root = path.resolve(options.root || ROOT);
    const sourceRoot = path.resolve(options.sourceRoot);
    const oid = assertOidSourceSnapshot(root, sourceRoot, options.expectedOid);
    const state = readPreviewState(root, options.group);
    if (state.server.desired !== oid || state.desired !== oid || !state.coherent) {
        throw new Error('Server OID build is not the coherent desired preview.');
    }
    if (!(injected.resourcesSafe?.() ?? resourcesSafe())) {
        throw new Error('Build deferred: CPU or memory utilization is at least 80%.');
    }
    const run = injected.run || command;
    // The snapshot owns its build contract. Importing the mutable working-tree
    // builder here would silently add newer inputs to an older commit.
    const contract = injected.contract || await import(
        `${pathToFileURL(path.join(sourceRoot, 'scripts', 'server-build-atomic.mjs')).href}?oid=${oid}`
    );
    if (!Array.isArray(contract.SERVER_BUILD_INPUTS)
        || typeof contract.computeServerBuildFingerprint !== 'function'
        || typeof contract.verifyServerArtefact !== 'function'
        || typeof contract.installServerUpdateRuntime !== 'function'
        || typeof contract.installOidControlRuntime !== 'function') {
        throw new Error('Snapshot server build contract is incomplete.');
    }
    const buildId = contract.computeServerBuildFingerprint(sourceRoot);
    const manifest = typeof contract.createServerInputManifest === 'function'
        ? contract.createServerInputManifest(sourceRoot, buildId) : null;
    const stagingParent = path.join(root, '.nassaj-local-preview', 'server-staging');
    mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
    const staging = path.join(stagingParent, `${buildId}-${process.pid}`);
    if (existsSync(staging)) throw new Error('OID server staging path already exists.');
    mkdirSync(staging, { mode: 0o700 });
    let stored = false;
    try {
        run(path.join(root, 'node_modules', '.bin', 'tsc'), [
            '-p', path.join(sourceRoot, 'server', 'tsconfig.json'), '--outDir', staging,
        ], { cwd: sourceRoot });
        run(path.join(root, 'node_modules', '.bin', 'tsc-alias'), [
            '-p', path.join(sourceRoot, 'server', 'tsconfig.json'), '--outDir', aliasOutDir(sourceRoot, staging),
        ], { cwd: path.join(sourceRoot, 'server') });
        // TypeScript follows production imports outside server/ (for example
        // ../scripts/lib/*), so a real compile may already have emitted this
        // directory. Accept only the real directory that compilation created.
        ensureRealDirectory(path.join(staging, 'scripts'));
        // PM2 retains its legacy index.js entry; the immutable snapshot owns
        // the pre-import admission wrapper as well as the application bytes.
        contract.installReleaseBootstrapEntry?.(staging);
        contract.installServerUpdateRuntime(sourceRoot, staging);
        const version = writeProvenance(staging, sourceRoot, oid, buildId);
        if (manifest) writeManifest(staging, manifest);
        contract.installOidControlRuntime(sourceRoot, staging, { oid, buildId, dependenciesRoot: root });
        contract.verifyServerArtefact(staging, {
            root: sourceRoot, version, expectedCommit: oid, expectedBuildId: buildId, run,
        });
        // Re-validate immutable source after every tool has exited. A tool that
        // attempted a source write is a hard failure even if compilation passed.
        assertOidSourceSnapshot(root, sourceRoot, oid);
        const candidatePath = storeCandidate(root, staging, buildId, oid);
        const controlManifestSha256 = createHash('sha256')
            .update(readFileSync(path.join(candidatePath, 'OID_CONTROL_MANIFEST.json'))).digest('hex');
        stored = true;
        advancePreview(root, { group: options.group, domain: 'server', state: 'candidate', oid });
        const previous = readPreviewLedger(root);
        const loadedBuildId = previous.serverLoadedBuildId || loadedServerBuildId(root);
        recordPreviewLedgerEvent(root, {
            target: 'server', publisher: 'oid', sourceGeneration: sourceGeneration(options.group), state: 'built',
            sourceBuildId: buildId, candidateBuildId: buildId,
            promotedBuildId: previous.serverPromotedBuildId || loadedBuildId,
            runtimeBuildId: loadedBuildId,
        });
        return { oid, buildId, candidatePath, controlManifestSha256, promoted: false };
    } finally {
        if (!stored && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
}

/** Record promotion only after an external atomic installer confirms this exact OID. */
export function markServerPreviewPromoted(root, group, oid) {
    return advancePreview(root, { group, domain: 'server', state: 'promoted', oid });
}

function parseArguments(argv) {
    const flags = new Set(argv.filter((item) => item === '--locked'));
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        if (flags.has(argv[index])) continue;
        if (!argv[index]?.startsWith('--') || argv[index + 1] == null) throw new Error('Invalid OID server build argument.');
        values[argv[index].slice(2)] = argv[index + 1];
        index += 1;
    }
    return { ...values, locked: flags.has('--locked') };
}

async function main() {
    const [action = 'build', ...argv] = process.argv.slice(2);
    const args = parseArguments(argv);
    const root = path.resolve(args.repo || ROOT);
    if (action === 'mark-promoted') {
        process.stdout.write(`${JSON.stringify(markServerPreviewPromoted(root, args.group, args['expected-oid']))}\n`);
        return;
    }
    if (action !== 'build') throw new Error('Usage: server-preview-from-oid.mjs build|mark-promoted ...');
    if (!args.locked) {
        const lock = gitControlPath(root, 'nassaj-local-preview-build.lock');
        const result = spawnSync('flock', [
            '-x', '-w', '5', '-F', lock, process.execPath, fileURLToPath(import.meta.url),
            'build', ...argv, '--locked',
        ], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
        if (result.status !== 0) throw new Error(`OID server build lock failed (${result.status ?? result.signal}).`);
        return;
    }
    const result = await buildServerPreviewFromOid({
        root, sourceRoot: args['source-root'], expectedOid: args['expected-oid'], group: args.group,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
