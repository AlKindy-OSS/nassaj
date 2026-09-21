import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildOidTripleCandidate } from './oid-update-candidate.mjs';
import { prepareLocalUpdate, confirmLocalUpdate, cancelLocalUpdate, readLocalUpdate, authorizeLocalUpdateByPolicy } from './lib/local-update-control.mjs';
import { consumeNewestPreview, invokeCandidateExecutable } from './preview-oid-consumer.mjs';
import { verifyOidDependencyCandidate } from './lib/oid-dependency-candidate.mjs';
import { writeLocalUpdatePolicy } from './lib/local-update-policy-write.mjs';
import { DEV_FULL_CAPABILITY } from './lib/local-update-policy.mjs';
import { canonicalTripleJson } from './lib/oid-triple-target.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function writable(file) {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) { fs.chmodSync(file, 0o700); for (const name of fs.readdirSync(file)) writable(path.join(file, name)); }
}
async function fixture(t, automatic = false) {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.artifacts', 'oid-triple-preparation-'));
    t.after(() => { writable(root); fs.rmSync(root, { recursive: true, force: true }); });
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.47.0.19', allowScripts: {} }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
    fs.writeFileSync(path.join(root, 'source.js'), 'export const immutable = true;');
    git(root, 'add', 'package.json', 'package-lock.json', 'source.js'); git(root, 'commit', '-qm', 'fixture');
    const oid = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, '.env'), 'NASSAJ_UPDATE_MODE=local-main\n');
    const event = automatic ? null : await prepareLocalUpdate(root, { mode: 'local-main', ownerId: 1, expectedOid: oid, idempotencyKey: 'fixture' });
    const policy = { source: 'package.json#allowScripts', policy: {}, applicable: [], excluded: [] };
    const runtime = { nodeVersion: process.version, nodeModuleAbi: process.versions.modules, napi: process.versions.napi,
        nodeBinarySha256: 'd'.repeat(64), npmCliSha256: 'e'.repeat(64), npmVersion: '12.0.2', platform: process.platform, arch: process.arch };
    const build = domain => options => {
        fs.mkdirSync(options.outputRoot);
        const buildId = (domain === 'client' ? 'a' : 'b').repeat(64);
        fs.writeFileSync(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: domain,
            commit: options.releaseCommit, baseCommit: options.releaseCommit, buildId, dirty: false }));
        if (domain === 'server') fs.writeFileSync(path.join(options.outputRoot, 'OID_CONTROL_MANIFEST.json'), '{}');
        return { buildId };
    };
    const operations = {
        readBuildProfile: () => null, // Injected mechanics fixture; production CLI has no profile bypass.
        run(executable, args, options) {
            assert.equal(executable, 'npm');
            if (args[0] === 'ci') {
                assert.notEqual(options.cwd, root);
                assert.equal(options.env.DATABASE_PATH, undefined);
                fs.mkdirSync(path.join(options.cwd, 'node_modules', 'package'), { recursive: true });
                fs.writeFileSync(path.join(options.cwd, 'node_modules/package/index.js'), 'module.exports=1;');
                return { stdout: '' };
            }
            assert.equal(args[0], 'ls'); return { stdout: '{}' };
        },
        inspectInstall: () => ({ installRuntime: runtime, installPolicy: policy, installPolicySha256: hash(canonicalTripleJson(policy)) }),
        buildClient: build('client'), buildServer: build('server'), sealServer() {},
        nativeProbe: (_root, _dependencies, expected) => ({ schema: 'nassaj-oid-native-probe/v2', processExited: true,
            nodeModulesTreeSha256: expected.nodeModulesTreeSha256, nodeVersion: runtime.nodeVersion, nodeModuleAbi: runtime.nodeModuleAbi }),
    };
    let health;
    if (automatic) {
        fs.mkdirSync(path.join(root, 'dist-server'));
        const capsule = '// policy executor fixture';
        const capability = { protocol: DEV_FULL_CAPABILITY, serverLoadedBuildId: 'c'.repeat(64), retainedExecutorSha256: hash(capsule) };
        fs.writeFileSync(path.join(root, 'dist-server/OID_CONTROL_CAPSULE.mjs'), capsule);
        fs.writeFileSync(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), JSON.stringify({ serverBuildId: capability.serverLoadedBuildId,
            capsuleSha256: capability.retainedExecutorSha256, capabilities: { oidDevFullPolicyV1: DEV_FULL_CAPABILITY } }));
        fs.chmodSync(path.join(root, '.git'), 0o700);
        await writeLocalUpdatePolicy(root, { mode: 'dev-full-auto', ownerId: 1, expectedRevision: 0,
            idempotencyKey: 'automatic-fixture-policy', capability });
        health = { status: 'ok', updateMode: 'local-main', normalAdmissionReady: true,
            serverLoadedOid: 'd'.repeat(40), serverBuildIdLoadedAtStartup: capability.serverLoadedBuildId,
            localUpdatePolicyCapability: capability };
    }
    return { root, event, operations, health, oid };
}

test('OID preparation installs privately, binds all three generations and leaves source/index/HEAD untouched', async t => {
    const v = await fixture(t);
    fs.writeFileSync(path.join(v.root, 'source.js'), 'owner dirty edit');
    const indexBefore = fs.readFileSync(path.join(v.root, '.git/index'));
    const target = await buildOidTripleCandidate(v, v.operations);
    assert.equal(target.schema, 'nassaj-oid-triple-target/v2');
    assert.equal(git(v.root, 'rev-parse', 'HEAD'), v.event.oid);
    assert.deepEqual(fs.readFileSync(path.join(v.root, '.git/index')), indexBefore);
    assert.equal(fs.readFileSync(path.join(v.root, 'source.js'), 'utf8'), 'owner dirty edit');
    assert.equal(fs.existsSync(path.join(v.root, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(v.root, 'dist-server')), false);
    verifyOidDependencyCandidate(v.root, target);
    const result = await consumeNewestPreview(v.root, { buildTriple: async () => target,
        buildClient: () => assert.fail('v2 must not fall back to pair preparation'),
        promoteClient: () => assert.fail('preparation must never publish') }, { mode: 'local-main', domains: ['client', 'server'] });
    const prepared = result.localUpdate;
    assert.equal(result.status, 'consumed');
    const confirmed = await confirmLocalUpdate(v.root, { mode: 'local-main', ownerId: 1, sequence: prepared.sequence,
        expectedRevision: prepared.revision, targetDigest: prepared.targetDigest });
    assert.equal(confirmed.consent.targetDigest, prepared.targetDigest);
    const file = path.join(v.root, '.nassaj-local-preview', 'dependency-candidates', target.nodeModulesTreeSha256, 'package/index.js');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'tamper');
    assert.throws(() => verifyOidDependencyCandidate(v.root, target), /writable/);
});

test('a lifecycle script changing tracked source cannot publish dependency evidence or candidates', async t => {
    const v = await fixture(t), original = v.operations.run;
    v.operations.run = (executable, args, options) => {
        const result = original(executable, args, options);
        if (args[0] === 'ci') fs.writeFileSync(path.join(options.cwd, 'source.js'), 'changed by lifecycle');
        return result;
    };
    await assert.rejects(buildOidTripleCandidate(v, v.operations), /source_changed/);
    assert.equal(fs.existsSync(path.join(v.root, '.nassaj-local-preview/dependency-candidates')), false);
});

test('missing build profile and insufficient measured space do not claim a heavy build', async t => {
    const v = await fixture(t), claim = path.join(v.root, '.git/nassaj-local-update-build-attempt-v1.json');
    await assert.rejects(buildOidTripleCandidate(v, { ...v.operations, readBuildProfile: undefined }), /profile_required/);
    assert.equal(fs.existsSync(claim), false);
    assert.throws(() => invokeCandidateExecutable(v.root, path.resolve('scripts/oid-update-candidate.mjs'),
        ['--oid', v.oid, '--sequence', String(v.event.sequence)]), error => error.code === 'local_update_build_profile_required');
    await assert.rejects(buildOidTripleCandidate(v, { ...v.operations,
        readBuildProfile: () => ({ phaseAdditionalBytes: { prepare: Number.MAX_SAFE_INTEGER } }),
    }), /capacity_wait/);
    assert.equal(fs.existsSync(claim), false);
});

for (const checkpoint of ['install', 'build', 'store']) {
    test(`capacity refusal at ${checkpoint} permits a later retry, without clearing crash claims`, async t => {
        const v = await fixture(t);
        v.operations.readBuildProfile = () => ({ cachePath: path.join(v.root, 'cache'), headersPath: path.join(v.root, 'headers'),
            phaseAdditionalBytes: { prepare: 1, install: 1, build: 1, store: 1 }, runtime: v.operations.inspectInstall().installRuntime });
        v.operations.assertCapacity = (_root, _profile, phase) => {
            if (phase === checkpoint) throw Object.assign(new Error('local_update_build_capacity_wait'), { code: 'local_update_build_capacity_wait' });
        };
        await assert.rejects(buildOidTripleCandidate(v, v.operations), /capacity_wait/);
        const claim = JSON.parse(fs.readFileSync(path.join(v.root, '.git/nassaj-local-update-build-attempt-v1.json')));
        assert.equal(claim.phase, 'completed'); assert.equal(claim.outcome, 'capacity_deferred');
        v.operations.assertCapacity = () => {};
        const target = await buildOidTripleCandidate(v, v.operations);
        assert.equal(target.schema, 'nassaj-oid-triple-target/v2');
    });
}

test('measured offline builder passes private configuration and offline flags to npm', async t => {
    const v = await fixture(t), original = v.operations.run;
    const profile = { cachePath: path.join(v.root, 'cache'), headersPath: path.join(v.root, 'headers'),
        phaseAdditionalBytes: { prepare: 1, install: 1, build: 1, store: 1 },
        runtime: v.operations.inspectInstall().installRuntime };
    let installs = 0;
    v.operations.readBuildProfile = () => profile;
    v.operations.env = { PATH: process.env.PATH, HOME: '/host-private-home', NPM_TOKEN: 'private-token' };
    v.operations.run = (executable, args, options) => {
        assert.notEqual(options.env.HOME, '/host-private-home');
        assert.equal(options.env.NPM_TOKEN, undefined);
        assert.equal(options.env.npm_config_offline, 'true');
        assert.equal(options.env.npm_config_registry, 'https://registry.npmjs.org/');
        assert.equal(fs.existsSync(options.env.npm_config_userconfig), true);
        if (args[0] === 'ci') {
            installs++;
            assert.ok(args.includes('--offline'));
            assert.equal(args[args.indexOf('--cache') + 1], profile.cachePath);
        }
        return original(executable, args, options);
    };
    await buildOidTripleCandidate(v, v.operations);
    assert.equal(installs, 1);
});

test('failed or mismatched native probe never emits a prepared generation', async t => {
    const v = await fixture(t);
    v.operations.nativeProbe = () => ({ schema: 'nassaj-oid-native-probe/v2', processExited: false });
    await assert.rejects(buildOidTripleCandidate(v, v.operations), /native_probe_unverified/);
    assert.equal(fs.existsSync(path.join(v.root, '.nassaj-local-preview/dependency-candidates')), false);
});

test('writable project parents refuse preparation before creating any preview directory', async t => {
    const v = await fixture(t);
    for (const mode of [0o775, 0o777]) {
        fs.chmodSync(v.root, mode);
        await assert.rejects(buildOidTripleCandidate(v, v.operations), /unsafe_candidate_directory/);
        assert.equal(fs.existsSync(path.join(v.root, '.nassaj-local-preview')), false);
    }
    fs.chmodSync(v.root, 0o700);
    const target = await buildOidTripleCandidate(v, v.operations);
    for (const mode of [0o775, 0o777]) {
        fs.chmodSync(v.root, mode);
        assert.throws(() => verifyOidDependencyCandidate(v.root, target), /unsafe_dependency_store/);
    }
    fs.chmodSync(v.root, 0o700);
});

for (const phase of ['install', 'build']) {
    test(`new source files added during ${phase} cannot enter a prepared candidate`, async t => {
        const v = await fixture(t);
        if (phase === 'install') {
            const execute = v.operations.run;
            v.operations.run = (executable, args, options) => {
                const result = execute(executable, args, options);
                if (args[0] === 'ci') fs.writeFileSync(path.join(options.cwd, 'injected.js'), 'unexpected source');
                return result;
            };
            v.operations.buildClient = () => assert.fail('post-install source inspection must precede any build');
        } else {
            const build = v.operations.buildServer;
            v.operations.buildServer = options => {
                const result = build(options);
                fs.writeFileSync(path.join(options.sourceRoot, 'injected.js'), 'unexpected source');
                return result;
            };
        }
        await assert.rejects(buildOidTripleCandidate(v, v.operations), /unexpected_source_entry/);
        assert.equal(fs.existsSync(path.join(v.root, '.nassaj-local-preview/dependency-evidence')), false);
    });
}

test('one unchanged tree supports distinct immutable package contracts without overwriting prior evidence', async t => {
    const v = await fixture(t), first = await buildOidTripleCandidate(v, v.operations);
    const parent = path.join(v.root, '.nassaj-local-preview/dependency-evidence');
    const firstFile = path.join(parent, `${first.dependencyContractSha256}.json`), firstBytes = fs.readFileSync(firstFile);
    await cancelLocalUpdate(v.root, { mode: 'local-main', ownerId: 1, sequence: v.event.sequence, expectedRevision: v.event.revision });
    const packageFile = path.join(v.root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile)); pkg.scripts = { reviewed: 'true' };
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    git(v.root, 'add', 'package.json'); git(v.root, 'commit', '-qm', 'second reviewed contract');
    const oid = git(v.root, 'rev-parse', 'HEAD');
    v.event = await prepareLocalUpdate(v.root, { mode: 'local-main', ownerId: 1, expectedOid: oid, idempotencyKey: 'second-fixture' });
    const second = await buildOidTripleCandidate(v, v.operations);
    assert.equal(second.nodeModulesTreeSha256, first.nodeModulesTreeSha256);
    assert.notEqual(second.dependencyContractSha256, first.dependencyContractSha256);
    assert.notEqual(second.packageJsonSha256, first.packageJsonSha256);
    verifyOidDependencyCandidate(v.root, first); verifyOidDependencyCandidate(v.root, second);
    assert.deepEqual(fs.readFileSync(firstFile), firstBytes);
});

const autoOptions = { mode: 'local-main', domains: ['client', 'server'] };
function autoOperations(v, beforeBuild = async () => {}) {
    return { fetchPolicyHealth: async () => v.health, buildTriple: async args => {
        await beforeBuild(args); return buildOidTripleCandidate(args, v.operations);
    } };
}

test('automatic policy coalesces preparations and grants without a fabricated button receipt', async t => {
    const v = await fixture(t, true); let builds = 0;
    const ops = autoOperations(v, async () => { builds++; await new Promise(resolve => setTimeout(resolve, 50)); });
    await Promise.all([consumeNewestPreview(v.root, ops, autoOptions), consumeNewestPreview(v.root, ops, autoOptions)]);
    const state = readLocalUpdate(v.root);
    assert.equal(builds, 1); assert.equal(state.phase, 'awaiting_sessions'); assert.equal(state.consent, null);
    assert.equal(state.policyGrantReceipts.length, 1); assert.equal(state.policyGrantReceipts[0].kind, 'issued');
    await assert.rejects(confirmLocalUpdate(v.root, { mode: 'local-main', ownerId: 1, sequence: state.sequence,
        expectedRevision: state.revision, targetDigest: state.targetDigest }), /policy/);
    const renewed = await authorizeLocalUpdateByPolicy(v.root, { sequence: state.sequence, expectedRevision: state.revision,
        capability: v.health.localUpdatePolicyCapability, now: state.policyAuthorization.expiresAt + 1 });
    assert.equal(renewed.policyGrantReceipts.length, 2);
    assert.equal(renewed.policyGrantReceipts[1].previousGrantDigest, state.policyAuthorization.grantDigest);
});

test('manual preparation remains independent of automatic health failures', async t => {
    const v = await fixture(t, true);
    const request = await prepareLocalUpdate(v.root, { mode: 'local-main', ownerId: 1, expectedOid: v.oid, idempotencyKey: 'manual-request' });
    const ops = { ...autoOperations(v), fetchPolicyHealth: () => assert.fail('manual path must not read policy health') };
    const result = await consumeNewestPreview(v.root, ops, autoOptions);
    assert.equal(result.localUpdate.sequence, request.sequence); assert.equal(result.localUpdate.phase, 'prepared');
    assert.equal(result.localUpdate.preparationFailure, undefined); assert.equal(result.localUpdate.policyAuthorization, undefined);
});

test('revocation while building retires the prepared work and grants no activation', async t => {
    const v = await fixture(t, true);
    const ops = autoOperations(v, async () => {
        await writeLocalUpdatePolicy(v.root, { mode: 'disabled', ownerId: 1, expectedRevision: 1, idempotencyKey: 'revoke-during-build' });
    });
    const result = await consumeNewestPreview(v.root, ops, autoOptions);
    assert.equal(result.localUpdate.phase, 'superseded'); assert.equal(result.localUpdate.policyAuthorization, null);
});

test('main advances during build: retire stale output and prepare only latest main next', async t => {
    const v = await fixture(t, true); let builds = 0;
    v.operations.sealServer = () => {
        if (++builds !== 1) return;
        for (const text of ['middle', 'latest']) {
            fs.writeFileSync(path.join(v.root, 'source.js'), `export const value = '${text}';`);
            git(v.root, 'add', 'source.js'); git(v.root, 'commit', '-qm', text);
        }
    };
    const first = await consumeNewestPreview(v.root, autoOperations(v), autoOptions);
    assert.equal(first.reason, 'newer_main_pending'); assert.equal(first.localUpdate.phase, 'superseded');
    const latest = git(v.root, 'rev-parse', 'HEAD');
    const second = await consumeNewestPreview(v.root, autoOperations(v), autoOptions);
    assert.equal(second.localUpdate.oid, latest); assert.equal(second.localUpdate.phase, 'awaiting_sessions');
    assert.equal(builds, 2);
});

test('a build interrupted with an orphan child cannot be retried merely because its parent died', async t => {
    const v = await fixture(t);
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const moduleUrl = new URL('./oid-update-candidate.mjs', import.meta.url).href;
    const program = `import { buildOidTripleCandidate } from ${JSON.stringify(moduleUrl)};
import { spawn } from 'node:child_process';
await buildOidTripleCandidate(JSON.parse(process.argv[1]), { readBuildProfile: () => null, materialize: async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    process.stdout.write(String(child.pid)+'\\n'); await new Promise(()=>{});
} });`;
    const builder = spawn(process.execPath, ['--input-type=module', '-e', program, JSON.stringify({ root: v.root, event: v.event })], {
        stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let descendant;
    t.after(async () => {
        if (descendant) try { process.kill(descendant, 'SIGTERM'); } catch {}
        if (builder.exitCode === null && builder.signalCode === null) builder.kill('SIGTERM');
    });
    const [bytes] = await once(builder.stdout, 'data'); descendant = Number(bytes.toString().trim());
    assert.ok(descendant > 1); process.kill(descendant, 0);
    const closed = once(builder, 'close'); builder.kill('SIGTERM'); await closed;
    process.kill(descendant, 0);
    await assert.rejects(buildOidTripleCandidate(v, { readBuildProfile: () => null, materialize: () => assert.fail('must not start a second heavy build') }), /build_recovery_required/);
});

test('main changed before the heavy build does not leave an interrupted build claim', async t => {
    const v = await fixture(t);
    fs.writeFileSync(path.join(v.root, 'source.js'), 'export const later = 1;');
    git(v.root, 'add', 'source.js'); git(v.root, 'commit', '-qm', 'later');
    await assert.rejects(buildOidTripleCandidate(v, v.operations), /target_changed/);
    assert.equal(fs.existsSync(path.join(v.root, '.git/nassaj-local-update-build-attempt-v1.json')), false);
});

test('cancellation during a completed build releases its build claim without granting activation', async t => {
    const v = await fixture(t);
    const build = v.operations.buildServer;
    v.operations.buildServer = async options => {
        const result = build(options);
        await cancelLocalUpdate(v.root, { mode: 'local-main', ownerId: 1, sequence: v.event.sequence, expectedRevision: v.event.revision });
        return result;
    };
    await assert.rejects(buildOidTripleCandidate(v, v.operations), /not_preparing/);
    const claim = JSON.parse(fs.readFileSync(path.join(v.root, '.git/nassaj-local-update-build-attempt-v1.json')));
    assert.equal(claim.phase, 'completed'); assert.equal(readLocalUpdate(v.root).phase, 'cancelled');
});
