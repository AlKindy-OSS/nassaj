#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { materializePreviewSnapshot, requestPreview } from './preview-oid-pipeline.mjs';
import { assertOidSourceSnapshot, buildServerPreviewFromOid } from './server-preview-from-oid.mjs';
import { enqueuePreviewEvent } from './preview-oid-consumer.mjs';
import { readPreviewLedger } from './local-preview-ledger.mjs';
import { inspectServerCandidate } from '../server/services/local-preview-server-control.js';
import { installReleaseBootstrapEntry } from './server-build-atomic.mjs';

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture() {
    const root = mkdtempSync('/var/tmp/server-preview-oid-');
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'OID Test');
    git(root, 'config', 'user.email', 'oid@example.invalid');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3.4' }));
    mkdirSync(path.join(root, 'server'));
    writeFileSync(path.join(root, 'server', 'index.js'), 'export default true;\n');
    git(root, 'add', 'package.json', 'server/index.js');
    git(root, 'commit', '-qm', 'fixture');
    const oid = git(root, 'rev-parse', 'HEAD');
    const sourceRoot = await materializePreviewSnapshot(root, oid);
    requestPreview(root, { group: 'fixture', oid, domains: ['server'] });
    return { root, oid, sourceRoot };
}

function cleanup(root) {
    execFileSync('chmod', ['-R', 'u+w', root]);
    rmSync(root, { recursive: true, force: true });
}

function installControl(_source, artefact) {
    writeFileSync(path.join(artefact, 'OID_CONTROL_MANIFEST.json'), '{}');
}

test('snapshot guard accepts only exact fixed read-only OID source', async () => {
    const { root, oid, sourceRoot } = await fixture();
    try {
        assert.equal(assertOidSourceSnapshot(root, sourceRoot, oid), oid);
        assert.throws(() => assertOidSourceSnapshot(root, root, oid), /fixed snapshot path/);
        assert.throws(() => assertOidSourceSnapshot(root, sourceRoot, oid.slice(0, 12)), /full exact/);
        chmodSync(path.join(sourceRoot, 'package.json'), 0o644);
        assert.throws(() => assertOidSourceSnapshot(root, sourceRoot, oid), /writable entry/);
    } finally { cleanup(root); }
});

test('build refuses before invoking tools when desired OID differs', async () => {
    const { root, oid, sourceRoot } = await fixture();
    try {
        requestPreview(root, { group: 'another', oid, domains: ['client'] });
        let invoked = false;
        await assert.rejects(() => buildServerPreviewFromOid({ root, sourceRoot, expectedOid: oid, group: 'another' }, {
            run: () => { invoked = true; }, resourcesSafe: () => true,
        }), /coherent desired/);
        assert.equal(invoked, false);
    } finally { cleanup(root); }
});

test('build accepts a scripts directory already emitted by TypeScript', async () => {
    const { root, oid, sourceRoot } = await fixture();
    try {
        const buildId = 'a'.repeat(64);
        const contract = {
            SERVER_BUILD_INPUTS: [],
            computeServerBuildFingerprint: () => buildId,
            createServerInputManifest: () => ({ schemaVersion: 1, buildId, inputs: [] }),
            installServerUpdateRuntime: () => {},
            installOidControlRuntime: (source, staging, identity) => {
                assert.equal(source, sourceRoot);
                assert.equal(identity.dependenciesRoot, root);
                assert.notEqual(identity.dependenciesRoot, sourceRoot);
                return installControl(source, staging, identity);
            },
            verifyServerArtefact: () => {},
        };
        await buildServerPreviewFromOid({ root, sourceRoot, expectedOid: oid, group: 'fixture' }, {
            contract,
            resourcesSafe: () => true,
            run: (executable, args) => {
                const outDirIndex = args.indexOf('--outDir');
                if (executable.endsWith('/tsc') && outDirIndex !== -1) {
                    assert.equal(executable, path.join(root, 'node_modules/.bin/tsc'));
                    mkdirSync(path.join(args[outDirIndex + 1], 'scripts'), { recursive: true });
                }
            },
        });
    } finally { cleanup(root); }
});

test('OID build enters bootstrap through the unchanged PM2 index path before the application', async () => {
    const { root, oid, sourceRoot } = await fixture();
    try {
        const buildId = 'd'.repeat(64);
        const result = await buildServerPreviewFromOid({ root, sourceRoot, expectedOid: oid, group: 'fixture' }, {
            resourcesSafe: () => true,
            contract: { SERVER_BUILD_INPUTS: [], computeServerBuildFingerprint: () => buildId,
                installReleaseBootstrapEntry, installServerUpdateRuntime: () => {},
                installOidControlRuntime: installControl, verifyServerArtefact: () => {} },
            run: (executable, args) => {
                if (!executable.endsWith('/tsc')) return;
                const output = path.join(args[args.indexOf('--outDir') + 1], 'server');
                mkdirSync(output, { recursive: true });
                writeFileSync(path.join(output, 'index.js'), 'if (!globalThis.admitted) throw new Error("admission_missing"); console.log("application_admitted");');
                writeFileSync(path.join(output, 'bootstrap.js'), 'globalThis.admitted = true; await import("./application.js");');
            },
        });
        const entry = path.join(result.candidatePath, 'server', 'index.js');
        assert.equal(readFileSync(entry, 'utf8'), readFileSync(path.join(result.candidatePath, 'server', 'bootstrap.js'), 'utf8'));
        assert.match(execFileSync(process.execPath, [entry], { encoding: 'utf8' }), /application_admitted/);
    } finally { cleanup(root); }
});

async function assertUnsafeEmittedScriptsRejected(kind) {
    const { root, oid, sourceRoot } = await fixture();
    try {
        const buildId = kind === 'file' ? 'b'.repeat(64) : 'c'.repeat(64);
        const contract = {
            SERVER_BUILD_INPUTS: [],
            computeServerBuildFingerprint: () => buildId,
            createServerInputManifest: () => ({ schemaVersion: 1, buildId, inputs: [] }),
            installServerUpdateRuntime: () => {},
            installOidControlRuntime: installControl,
            verifyServerArtefact: () => {},
        };
        await assert.rejects(() => buildServerPreviewFromOid({
            root, sourceRoot, expectedOid: oid, group: 'fixture',
        }, {
            contract,
            resourcesSafe: () => true,
            run: (executable, args) => {
                const outDirIndex = args.indexOf('--outDir');
                if (!executable.endsWith('/tsc') || outDirIndex === -1) return;
                const scripts = path.join(args[outDirIndex + 1], 'scripts');
                if (kind === 'file') writeFileSync(scripts, 'unsafe\n');
                else {
                    mkdirSync(path.join(args[outDirIndex + 1], 'emitted-scripts-target'));
                    symlinkSync('emitted-scripts-target', scripts, 'dir');
                }
            },
        }), /staging scripts path is unsafe/);
    } finally { cleanup(root); }
}

test('build rejects a scripts path emitted as a file', () => assertUnsafeEmittedScriptsRejected('file'));

test('build rejects a scripts path emitted as a symlink', () => assertUnsafeEmittedScriptsRejected('symlink'));

test('build fails closed when the snapshot contract lacks the runtime installer', async () => {
    const { root, oid, sourceRoot } = await fixture();
    try {
        let compiled = false;
        await assert.rejects(() => buildServerPreviewFromOid({
            root, sourceRoot, expectedOid: oid, group: 'fixture',
        }, {
            contract: {
                SERVER_BUILD_INPUTS: [],
                computeServerBuildFingerprint: () => 'd'.repeat(64),
                verifyServerArtefact: () => {},
            },
            resourcesSafe: () => true,
            run: () => { compiled = true; },
        }), /build contract is incomplete/);
        assert.equal(compiled, false);
    } finally { cleanup(root); }
});

test('build installs the snapshot runtime before artefact verification', async () => {
    const { root, oid, sourceRoot } = await fixture();
    try {
        const buildId = 'e'.repeat(64);
        const calls = [];
        await buildServerPreviewFromOid({ root, sourceRoot, expectedOid: oid, group: 'fixture' }, {
            contract: {
                SERVER_BUILD_INPUTS: [],
                computeServerBuildFingerprint: () => buildId,
                createServerInputManifest: () => ({ schemaVersion: 1, buildId, inputs: [] }),
                installServerUpdateRuntime: (source, artefact) => {
                    assert.equal(source, sourceRoot);
                    assert.equal(path.basename(path.dirname(artefact)), 'server-staging');
                    const canonical = path.join(artefact, 'scripts', 'local-preview-ledger.mjs');
                    writeFileSync(canonical, 'canonical runtime\n');
                    chmodSync(canonical, 0o444);
                    calls.push('install');
                },
                installOidControlRuntime: installControl,
                verifyServerArtefact: (artefact) => {
                    assert.equal(readFileSync(path.join(artefact, 'scripts', 'local-preview-ledger.mjs'), 'utf8'),
                        'canonical runtime\n');
                    calls.push('verify');
                },
            },
            resourcesSafe: () => true,
            run: () => {},
        });
        assert.deepEqual(calls, ['install', 'verify']);
    } finally { cleanup(root); }
});

test('runtime installation conflicts fail closed and clean preview staging', async () => {
    const { root, oid, sourceRoot } = await fixture();
    try {
        const buildId = 'f'.repeat(64);
        const staging = path.join(root, '.nassaj-local-preview', 'server-staging', `${buildId}-${process.pid}`);
        await assert.rejects(() => buildServerPreviewFromOid({
            root, sourceRoot, expectedOid: oid, group: 'fixture',
        }, {
            contract: {
                SERVER_BUILD_INPUTS: [],
                computeServerBuildFingerprint: () => buildId,
                createServerInputManifest: () => ({ schemaVersion: 1, buildId, inputs: [] }),
                installServerUpdateRuntime: () => { throw new Error('runtime bundle conflict'); },
                installOidControlRuntime: installControl,
                verifyServerArtefact: () => { throw new Error('verification must not run'); },
            },
            resourcesSafe: () => true,
            run: () => {},
        }), /runtime bundle conflict/);
        assert.equal(existsSync(staging), false);
        assert.equal(existsSync(path.join(root, '.nassaj-local-preview', 'server-candidates', buildId)), false);
    } finally { cleanup(root); }
});

test('OID build writes the real ledger contract accepted by inspectServerCandidate', async () => {
    const root = mkdtempSync('/var/tmp/server-preview-control-');
    try {
        git(root, 'init', '-q');
        git(root, 'config', 'user.name', 'OID Control Test');
        git(root, 'config', 'user.email', 'oid-control@example.invalid');
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3.4' }));
        const controls = new Map([
            ['scripts/local-preview-server-activation.mjs', 'activation-control'],
            ['scripts/local-preview-ledger.mjs', 'ledger-control'],
            ['scripts/safe-restart.sh', 'restart-control'],
        ]);
        for (const [file, contents] of controls) {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            writeFileSync(path.join(root, file), contents);
        }
        const ordinary = 'server/modules/projects/services/base.ts';
        mkdirSync(path.dirname(path.join(root, ordinary)), { recursive: true });
        writeFileSync(path.join(root, ordinary), 'export const value = 2;\n');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'candidate');
        const oid = git(root, 'rev-parse', 'HEAD');
        const sourceRoot = await materializePreviewSnapshot(root, oid);
        enqueuePreviewEvent(root, { sequence: 19, oid, domains: ['server'] });

        const sha = (contents) => crypto.createHash('sha256').update(contents).digest('hex');
        const candidateInputs = [
            { path: ordinary, sha256: sha('export const value = 2;\n') },
            ...[...controls].map(([file, contents]) => ({ path: file, sha256: sha(contents) })),
        ].sort((a, b) => a.path.localeCompare(b.path));
        const loadedInputs = candidateInputs.map((entry) => entry.path === ordinary
            ? { ...entry, sha256: sha('export const value = 1;\n') } : entry);
        const identity = (inputs) => {
            const digest = crypto.createHash('sha256');
            for (const entry of inputs) digest.update(entry.path).update('\0').update(entry.sha256).update('\0');
            return digest.digest('hex');
        };
        const candidateId = identity(candidateInputs);
        const loadedId = identity(loadedInputs);
        const live = path.join(root, 'dist-server');
        mkdirSync(live);
        writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId: loadedId }));
        writeFileSync(path.join(live, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify({
            schemaVersion: 1, buildId: loadedId, inputs: loadedInputs,
        }));
        for (const [file, contents] of controls) {
            mkdirSync(path.dirname(path.join(live, file)), { recursive: true });
            writeFileSync(path.join(live, file), contents);
        }
        const contract = {
            SERVER_BUILD_INPUTS: [ordinary, ...controls.keys()],
            computeServerBuildFingerprint: () => candidateId,
            createServerInputManifest: () => ({ schemaVersion: 1, buildId: candidateId, inputs: candidateInputs }),
            installServerUpdateRuntime: (_source, artefact) => {
                for (const [file, contents] of controls) {
                    const target = path.join(artefact, file);
                    mkdirSync(path.dirname(target), { recursive: true });
                    writeFileSync(target, contents);
                }
            },
            installOidControlRuntime: installControl,
            verifyServerArtefact: () => {},
        };
        await buildServerPreviewFromOid({
            root, sourceRoot, expectedOid: oid, group: 'event-0000000000000019',
        }, { contract, resourcesSafe: () => true, run: () => {} });

        const ledger = readPreviewLedger(root);
        assert.equal(ledger.serverSourceGeneration, 19);
        assert.equal(ledger.serverSourceBuildId, candidateId);
        assert.equal(ledger.serverCandidateBuildId, candidateId);
        assert.equal(ledger.serverState, 'built');
        assert.equal(ledger.serverLoadedBuildId, loadedId);
        const inspected = inspectServerCandidate(candidateId, root);
        assert.equal(inspected.allowed, true);
        assert.equal(inspected.generation, 19);
        assert.equal(readFileSync(path.join(root, '.nassaj-local-preview', 'server-candidates', candidateId,
            'BUILD_PROVENANCE.json'), 'utf8').includes(oid), true);
    } finally { cleanup(root); }
});

test('same server fingerprint from a newer OID rebuilds provenance instead of reusing the old commit artifact', async () => {
    const root = mkdtempSync('/var/tmp/server-preview-same-fingerprint-');
    try {
        git(root, 'init', '-q');
        git(root, 'config', 'user.name', 'OID Fingerprint Test');
        git(root, 'config', 'user.email', 'oid-fingerprint@example.invalid');
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3.4' }));
        mkdirSync(path.join(root, 'docs'));
        writeFileSync(path.join(root, 'docs', 'note.md'), 'one\n');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'first');
        const first = git(root, 'rev-parse', 'HEAD');
        writeFileSync(path.join(root, 'docs', 'note.md'), 'two\n');
        git(root, 'commit', '-qam', 'docs only');
        const second = git(root, 'rev-parse', 'HEAD');
        const fingerprint = 'f'.repeat(64);
        const contract = {
            SERVER_BUILD_INPUTS: [],
            computeServerBuildFingerprint: () => fingerprint,
            createServerInputManifest: () => ({ schemaVersion: 1, buildId: fingerprint, inputs: [] }),
            installServerUpdateRuntime: () => {},
            installOidControlRuntime: installControl,
            verifyServerArtefact: () => {},
        };
        const build = async (oid, sequence) => {
            const sourceRoot = await materializePreviewSnapshot(root, oid);
            enqueuePreviewEvent(root, { sequence, oid, domains: ['server'] });
            return buildServerPreviewFromOid({
                root, sourceRoot, expectedOid: oid, group: `event-${String(sequence).padStart(16, '0')}`,
            }, { contract, resourcesSafe: () => true, run: () => {} });
        };
        const firstBuild = await build(first, 1);
        assert.equal(JSON.parse(readFileSync(path.join(firstBuild.candidatePath,
            'BUILD_PROVENANCE.json'), 'utf8')).commit, first);
        const secondBuild = await build(second, 2);
        const replacement = JSON.parse(readFileSync(path.join(secondBuild.candidatePath,
            'BUILD_PROVENANCE.json'), 'utf8'));
        assert.equal(secondBuild.buildId, firstBuild.buildId);
        assert.equal(replacement.commit, second);
        assert.equal(replacement.baseCommit, second);
        assert.equal(readPreviewLedger(root).serverSourceGeneration, 2);
        assert.equal(readPreviewLedger(root).serverSourceBuildId, fingerprint);
    } finally { cleanup(root); }
});
