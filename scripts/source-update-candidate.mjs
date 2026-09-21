#!/usr/bin/env node
/** Build one governed source-update candidate; never mutate live artefacts. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
    renameSync, statSync, writeFileSync, openSync, closeSync, fsyncSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashTree } from './lib/source-update-tree-identity.mjs';
export { hashTree } from './lib/source-update-tree-identity.mjs';

import { installAndBuildCandidate, buildInstalledCandidateArtifact, dependencyEnvironment } from './lib/candidate-build-steps.mjs';
import { readOidSourceInventory, verifyOidSourceInventory, verifyOidLinkedWorktree } from './lib/oid-candidate-source.mjs';

import { buildClientReleaseCandidate } from './client-build-atomic.mjs';
import { buildServerReleaseCandidate } from './server-build-atomic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function command(executable, args, options = {}) {
    const result = spawnSync(executable, args, {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options,
    });
    if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status ?? result.signal}).`);
    return result;
}

function realDirectory(directory, label) {
    const resolved = realpathSync(directory);
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
    return resolved;
}

function gitCommonDirectory(root = ROOT, run = command) {
    const result = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
    return realDirectory(result.stdout.trim(), 'Git common directory');
}

function assertNoSecrets(value, key = '') {
    if (/(?:token|secret|password|credential|authorization|cookie)/i.test(key)) {
        throw new Error(`Candidate plan contains a forbidden secret-like field: ${key}`);
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value)) assertNoSecrets(child, childKey);
}

/** Read and validate the owner-created mode-0600 candidate plan. */
export function readCandidatePlan(planFile, options = {}) {
    const run = options.run || command;
    const commonDir = options.commonDir
        ? realDirectory(options.commonDir, 'Git common directory')
        : gitCommonDirectory(options.root || ROOT, run);
    const controlRoot = path.join(commonDir, 'nassaj-source-update');
    const planPath = realpathSync(planFile);
    if (planPath !== path.resolve(planFile) || !planPath.startsWith(`${controlRoot}${path.sep}`)) {
        throw new Error('Candidate plan is outside the governed update control directory.');
    }
    const metadata = lstatSync(planPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error('Candidate plan must be a regular mode-0600 file.');
    }
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assertNoSecrets(plan);
    if (plan.schemaVersion !== 1 || !SAFE_ID.test(plan.txId || '')
        || !/^[a-f0-9]{40}$/.test(plan.releaseCommit || '')
        || typeof plan.version !== 'string') throw new Error('Candidate plan identity is invalid.');
    if (plan.localSource !== undefined) validateLocalSource(plan.localSource, plan.releaseCommit);
    const candidateRoot = realDirectory(plan.candidateRoot, 'Candidate root');
    const expectedCandidate = path.join(controlRoot, 'candidates', plan.txId);
    if (candidateRoot !== expectedCandidate) throw new Error('Candidate root does not match its transaction identity.');
    const sourceRoot = realDirectory(plan.sourceRoot, 'Candidate source root');
    if (sourceRoot !== path.join(candidateRoot, 'source')) throw new Error('Candidate source root is not the fixed source child.');
    const outputs = plan.outputs || {};
    const expectedOutputs = {
        client: path.join(candidateRoot, 'client'),
        server: path.join(candidateRoot, 'server'),
        nodeModules: path.join(candidateRoot, 'node_modules'),
        manifest: path.join(candidateRoot, 'candidate-manifest.json'),
    };
    for (const [name, expected] of Object.entries(expectedOutputs)) {
        if (path.resolve(outputs[name] || '') !== expected) throw new Error(`Candidate ${name} output is not canonical.`);
    }
    const packageVersion = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
    if (packageVersion !== plan.version) throw new Error('Candidate source version does not match the release plan.');
    if (statSync(sourceRoot).dev !== statSync(candidateRoot).dev) throw new Error('Candidate source is on another filesystem.');
    const resolved = { ...plan, planPath, commonDir, controlRoot, candidateRoot, sourceRoot, outputs: expectedOutputs };
    if (plan.localSource) verifyLocalRecoveryIntent(resolved);
    return resolved;
}

/** Bind every preparation/replay to the original local operation before running lifecycle code. */
export function verifyLocalRecoveryIntent(plan) {
    const file = path.join(plan.candidateRoot, 'local-source-intent.json');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid()
        || (metadata.mode & 0o777) !== 0o600 || realpathSync(file) !== file) throw new Error('local_recovery_intent_unsafe');
    const intent = JSON.parse(readFileSync(file, 'utf8'));
    const expected = { schema: 'nassaj-local-source-recovery-intent/v1', root: path.dirname(plan.commonDir),
        txId: plan.txId, localSource: plan.localSource, operationBindingSha256: sha256(JSON.stringify(plan.operationBinding ?? null)) };
    if (canonicalJson(intent) !== canonicalJson(expected)) throw new Error('local_recovery_intent_changed');
}

function validateLocalSource(source, oid) {
    if (!source || Object.keys(source).sort().join(',') !== 'inventorySha256,oid,ref,schema'
        || source.schema !== 'nassaj-local-source-recovery/v1' || source.ref !== 'refs/heads/main'
        || source.oid !== oid || !/^[a-f0-9]{64}$/.test(source.inventorySha256 || '')) {
        throw new Error('Local recovery source identity is invalid.');
    }
}

function verifyLocalSource(plan, stage, run) {
    verifyLocalRecoveryIntent(plan);
    if (path.basename(plan.commonDir) !== '.git') throw new Error('Local recovery requires the integration checkout.');
    const inventory = readOidSourceInventory(path.dirname(plan.commonDir), plan.releaseCommit);
    if (sha256(JSON.stringify(inventory)) !== plan.localSource.inventorySha256) throw new Error('Local recovery inventory changed.');
    verifyOidLinkedWorktree(plan.sourceRoot, plan.commonDir, plan.releaseCommit);
    verifyOidSourceInventory(plan.sourceRoot, plan.releaseCommit, inventory, { allowNodeModules: stage !== 'before-install', allowGitMetadata: true });
    return { ...assertGitSourceProvenance(plan, run), treeSha256: plan.localSource.inventorySha256 };
}

function assertGitSourceProvenance(plan, run) {
    const topLevel = run('git', ['rev-parse', '--show-toplevel'], { cwd: plan.sourceRoot }).stdout.trim();
    let resolvedTopLevel;
    try { resolvedTopLevel = realpathSync(topLevel); } catch { throw new Error('Candidate source is not a Git worktree.'); }
    if (resolvedTopLevel !== plan.sourceRoot) throw new Error('Candidate source is not the Git worktree root.');
    const head = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: plan.sourceRoot }).stdout.trim();
    if (head !== plan.releaseCommit) throw new Error('Candidate source HEAD does not match the release commit.');
    const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: plan.sourceRoot }).stdout;
    if (status.trim()) throw new Error('Candidate source changed during the dependency/build lifecycle.');
    return { kind: 'git-worktree', commit: head, clean: true };
}

/** Install dependencies and build a fully verified candidate from one plan. */
export async function buildSourceUpdateCandidate(planFile, injected = {}) {
    const plan = readCandidatePlan(planFile, injected);
    const run = injected.run || command;
    for (const target of Object.values(plan.outputs)) {
        if (existsSync(target)) throw new Error(`Candidate output already exists: ${path.basename(target)}`);
    }
    const env = dependencyEnvironment(injected.env || process.env);
    const targetBuilder = domain => options => buildInstalledCandidateArtifact(domain, options, run, env);
    const { client, server, sourceProvenance, npmList, stagedModules } = await installAndBuildCandidate({
        ...plan, sourceOid: plan.releaseCommit,
    }, {
        run, env, verifySource: stage => plan.localSource ? verifyLocalSource(plan, stage, run) : assertGitSourceProvenance(plan, run),
        buildClient: injected.buildClient || (plan.localSource ? targetBuilder('client') : buildClientReleaseCandidate),
        buildServer: injected.buildServer || (plan.localSource ? targetBuilder('server') : buildServerReleaseCandidate),
    });
    realDirectory(stagedModules, 'Staged node_modules');
    renameSync(stagedModules, plan.outputs.nodeModules);
    const trees = {
        client: hashTree(plan.outputs.client),
        server: hashTree(plan.outputs.server),
        nodeModules: hashTree(plan.outputs.nodeModules),
    };
    const manifest = {
        schemaVersion: 1, txId: plan.txId, releaseCommit: plan.releaseCommit, version: plan.version,
        createdAt: new Date().toISOString(),
        clientBuildId: client.buildId, serverBuildId: server.buildId,
        sourceProvenance,
        ...(plan.localSource ? { localSource: plan.localSource } : {}),
        ...(plan.localSource && plan.operationBinding ? { operationBinding: plan.operationBinding } : {}),
        artifacts: {
            client: { commit: plan.releaseCommit, buildId: client.buildId },
            server: { commit: plan.releaseCommit, buildId: server.buildId },
            nodeModules: { commit: plan.releaseCommit },
        },
        packageJsonSha256: sha256(readFileSync(path.join(plan.sourceRoot, 'package.json'))),
        packageLockSha256: sha256(readFileSync(path.join(plan.sourceRoot, 'package-lock.json'))),
        npmLsSha256: sha256(canonicalJson(JSON.parse(npmList.stdout))), trees,
        sourceIdentity: (() => {
            const value = statSync(plan.sourceRoot);
            return { dev: value.dev, ino: value.ino, ctimeMs: value.ctimeMs };
        })(),
    };
    writeFileSync(plan.outputs.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const manifestFd = openSync(plan.outputs.manifest, 'r');
    try { fsyncSync(manifestFd); } finally { closeSync(manifestFd); }
    const directoryFd = openSync(path.dirname(plan.outputs.manifest), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return manifest;
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== '--plan') throw new Error('Usage: source-update-candidate.mjs --plan <candidate-plan.json>');
    const manifest = await buildSourceUpdateCandidate(argv[1]);
    process.stdout.write(`${JSON.stringify({ txId: manifest.txId, releaseCommit: manifest.releaseCommit })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[source-update-candidate] ${error.message}`);
        process.exitCode = 1;
    });
}
