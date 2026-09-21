import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeReleaseViteEnvironment } from './client-build-atomic.mjs';
import { installReleaseBootstrapEntry } from './server-build-atomic.mjs';
import { buildSourceUpdateCandidate, readCandidatePlan } from './source-update-candidate.mjs';

function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nassaj-update-candidate-'));
    const commonDir = path.join(root, 'common');
    const control = path.join(commonDir, 'nassaj-source-update');
    const candidateRoot = path.join(control, 'candidates', 'tx-one');
    const sourceRoot = path.join(candidateRoot, 'source');
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(sourceRoot, 'package.json'), '{"version":"1.44.0.2"}\n');
    writeFileSync(path.join(sourceRoot, 'package-lock.json'), '{}\n');
    const outputs = Object.fromEntries(['client', 'server', 'nodeModules'].map((name) => [
        name, path.join(candidateRoot, name === 'nodeModules' ? 'node_modules' : name),
    ]));
    outputs.manifest = path.join(candidateRoot, 'candidate-manifest.json');
    const plan = {
        schemaVersion: 1, txId: 'tx-one', sourceRoot, candidateRoot,
        releaseCommit: 'a'.repeat(40), version: '1.44.0.2',
        publicVite: { VITE_IS_PLATFORM: 'false', VITE_PUBLIC_SOURCE_URL: 'https://github.com/AlKindy-OSS/nassaj' },
        outputs,
    };
    const planFile = path.join(control, 'candidate-plan.json');
    writeFileSync(planFile, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    return { root, commonDir, candidateRoot, sourceRoot, outputs, planFile };
}

test('release Vite environment accepts only the two reviewed public keys', () => {
    assert.deepEqual(normalizeReleaseViteEnvironment({ VITE_IS_PLATFORM: 'false' }), [['VITE_IS_PLATFORM', 'false']]);
    assert.throws(() => normalizeReleaseViteEnvironment({ VITE_SECRET: 'no' }), /unapproved key/);
});

test('release server preserves the application behind a bootstrap-compatible legacy entry', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nassaj-update-entry-'));
    try {
        const server = path.join(root, 'server');
        mkdirSync(server);
        writeFileSync(path.join(server, 'index.js'), 'application');
        writeFileSync(path.join(server, 'bootstrap.js'), 'bootstrap');
        installReleaseBootstrapEntry(root);
        assert.equal(readFileSync(path.join(server, 'index.js'), 'utf8'), 'bootstrap');
        assert.equal(readFileSync(path.join(server, 'application.js'), 'utf8'), 'application');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package and PM2 contracts cannot bypass the governed release entry', () => {
    const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.scripts.server, 'node dist-server/server/bootstrap.js');
    // Evaluate the example as `pm2 start` does, under each layout, rather than
    // pattern-matching its text: the release layout starts the shipped entry
    // (pointing PM2 at the launcher itself leaves its argv guard false and the
    // process dead, ADR-156 WI-9), and a git checkout starts its own built server
    // by absolute path with cwd = the app root (qa-critic C3).
    const file = path.join(projectRoot, 'ecosystem.config.example.cjs');
    const load = (env) => {
        const saved = { layout: process.env.NASSAJ_INSTALL_LAYOUT, deployRoot: process.env.NASSAJ_DEPLOY_ROOT };
        const req = createRequire(file);
        try {
            for (const [key, value] of Object.entries(env)) process.env[key] = value;
            for (const key of Object.keys(req.cache)) delete req.cache[key];
            return req(file).apps[0];
        } finally {
            for (const [key, value] of [['NASSAJ_INSTALL_LAYOUT', saved.layout], ['NASSAJ_DEPLOY_ROOT', saved.deployRoot]]) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
        }
    };
    const release = load({ NASSAJ_INSTALL_LAYOUT: 'artifact-runtime-v2', NASSAJ_DEPLOY_ROOT: '/opt/nassaj' });
    assert.equal(release.script, '/opt/nassaj/launcher/pm2-entry.mjs');
    assert.equal(release.env.NASSAJ_DEPLOY_ROOT, '/opt/nassaj');
    const checkout = load({ NASSAJ_INSTALL_LAYOUT: 'git-checkout-v2', NASSAJ_DEPLOY_ROOT: '/opt/nassaj' });
    assert.equal(checkout.script, path.join(projectRoot, 'dist-server', 'server', 'index.js'));
    assert.equal(checkout.cwd, projectRoot);
    assert.equal(checkout.env.NASSAJ_DEPLOY_ROOT, undefined);
    for (const app of [release, checkout]) assert.doesNotMatch(app.script, /nassaj-release-launcher\.mjs$/);
});

test('candidate plan rejects an alias, permissive mode, and an outside path', () => {
    const value = fixture();
    try {
        const alias = path.join(path.dirname(value.planFile), 'alias.json');
        symlinkSync(value.planFile, alias);
        assert.throws(() => readCandidatePlan(alias, { commonDir: value.commonDir }), /outside/);
        const outside = path.join(value.root, 'outside.json');
        writeFileSync(outside, '{}', { mode: 0o600 });
        assert.throws(() => readCandidatePlan(outside, { commonDir: value.commonDir }), /outside/);
        chmodSync(value.planFile, 0o644);
        assert.throws(() => readCandidatePlan(value.planFile, { commonDir: value.commonDir }), /mode-0600/);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('orchestrator installs staged dependencies and emits a verified immutable manifest', async () => {
    const value = fixture();
    try {
        const result = await buildSourceUpdateCandidate(value.planFile, {
            commonDir: value.commonDir,
            env: { PATH: process.env.PATH },
            run(executable, args) {
                if (executable === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: `${value.sourceRoot}\n` };
                if (executable === 'git' && args.includes('HEAD^{commit}')) return { status: 0, stdout: `${'a'.repeat(40)}\n` };
                if (executable === 'git' && args[0] === 'status') return { status: 0, stdout: '' };
                if (executable === 'npm' && args[0] === 'ci') {
                    mkdirSync(path.join(value.sourceRoot, 'node_modules', 'dep'), { recursive: true });
                    writeFileSync(path.join(value.sourceRoot, 'node_modules', 'dep', 'index.js'), 'export default 1;\n');
                    return { status: 0, stdout: '' };
                }
                if (executable === 'npm' && args[0] === 'ls') return { status: 0, stdout: '{"dependencies":{"dep":{"version":"1.0.0"}}}' };
                throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
            },
            buildClient(options) {
                mkdirSync(options.outputRoot);
                writeFileSync(path.join(options.outputRoot, 'index.html'), 'client');
                return { buildId: 'b'.repeat(64) };
            },
            buildServer(options) {
                mkdirSync(options.outputRoot);
                writeFileSync(path.join(options.outputRoot, 'index.js'), 'server');
                return { buildId: 'c'.repeat(64) };
            },
        });
        assert.equal(result.releaseCommit, 'a'.repeat(40));
        assert.equal(result.clientBuildId, 'b'.repeat(64));
        assert.equal(result.serverBuildId, 'c'.repeat(64));
        assert.deepEqual(result.sourceProvenance, { kind: 'git-worktree', commit: 'a'.repeat(40), clean: true });
        assert.equal(result.artifacts.nodeModules.commit, 'a'.repeat(40));
        assert.match(result.trees.nodeModules.sha256, /^[a-f0-9]{64}$/);
        assert.equal(result.trees.nodeModules.files, 1);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('orchestrator rejects a mismatched HEAD and lifecycle source mutations', async () => {
    for (const mode of ['head', 'dirty']) {
        const value = fixture();
        try {
            let statusCalls = 0;
            await assert.rejects(buildSourceUpdateCandidate(value.planFile, {
                commonDir: value.commonDir,
                run(executable, args) {
                    if (executable === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: `${value.sourceRoot}\n` };
                    if (executable === 'git' && args.includes('HEAD^{commit}')) {
                        return { status: 0, stdout: `${mode === 'head' ? 'd'.repeat(40) : 'a'.repeat(40)}\n` };
                    }
                    if (executable === 'git' && args[0] === 'status') {
                        statusCalls += 1;
                        return { status: 0, stdout: mode === 'dirty' && statusCalls > 1 ? ' M package.json\n' : '' };
                    }
                    if (executable === 'npm' && args[0] === 'ci') {
                        mkdirSync(path.join(value.sourceRoot, 'node_modules'));
                        return { status: 0, stdout: '' };
                    }
                    if (executable === 'npm' && args[0] === 'ls') return { status: 0, stdout: '{}' };
                    throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
                },
                buildClient(options) { mkdirSync(options.outputRoot); return { buildId: 'b'.repeat(64) }; },
                buildServer(options) { mkdirSync(options.outputRoot); return { buildId: 'c'.repeat(64) }; },
            }), mode === 'head' ? /HEAD does not match/ : /changed during/);
        } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});
