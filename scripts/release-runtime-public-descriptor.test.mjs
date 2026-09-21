import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBootstrapContextHarness } from './fixtures/bootstrap-context-harness.mjs';
import { generateStartupPublicDescriptor, prepareForwardStartupAuthority } from './lib/release-runtime-public-descriptor.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const f = createBootstrapContextHarness(t); const d = f.descriptor; const m = f.manifest;
    const record = { schemaVersion: 2, state: 'sealed', identity: { profile: 'forward', repository: m.repo,
        releaseId: m.releaseId, tag: m.tag, version: m.version, commit: m.commit, serverBuildId: m.serverBuildId,
        clientBuildId: m.clientBuildId, bundleBuildId: m.bundleBuildId, assetId: d.release.assetId,
        assetSha256: d.release.assetSha256, archiveSha256: d.release.assetSha256, assetName: d.release.assetName,
        detachedManifestId: d.release.manifestAssetId, detachedManifestName: d.release.manifestAssetName,
        detachedManifestSha256: d.release.manifestSha256, detachedManifestSize: fs.statSync(f.config.bootstrapClaim.releaseManifestFile).size,
        databaseContractSha256: d.databaseContractSha256, expectedStartupClosureSha256: d.startupClosureSha256, generationId: d.release.generationId } };
    const generationRecordFile = path.join(f.root, 'generation.json'); fs.writeFileSync(generationRecordFile, JSON.stringify(record));
    f.config.databaseFile = d.databasePath; f.config.expected.assetSha256 = d.release.assetSha256;
    Object.assign(f.config.expected, { serverBuildId: m.serverBuildId, clientBuildId: m.clientBuildId, targetSchemaDigest: m.databaseContract.target.schemaDigest });
    f.config.stateLock = { schema: 'nassaj-cutover-state-lock/v2', flock: { path: '/usr/bin/flock', sha256: sha(fs.readFileSync('/usr/bin/flock')) } };
    const reviewedHostConfigFile = path.join(f.root, 'reviewed.json'); fs.writeFileSync(reviewedHostConfigFile, JSON.stringify(f.config));
    const options = { reviewedHostConfigFile, reviewedHostConfigSha256: sha(fs.readFileSync(reviewedHostConfigFile)),
        releaseManifestFile: f.config.bootstrapClaim.releaseManifestFile, releaseManifestSha256: d.release.manifestSha256,
        generationRecordFile, generationRecordSha256: sha(fs.readFileSync(generationRecordFile)), startupClosureSha256: d.startupClosureSha256,
        applicationUid: 1000, approvalFile: f.config.bootstrapClaim.approvalFile, ownerApprovalPublicKeyFile: f.config.bootstrapClaim.ownerApprovalPublicKeyFile,
        dispatcherExecutable: d.dispatcher.path, dispatcherSha256: d.dispatcher.sha256,
        sudoExecutable: d.sudo.path, sudoSha256: d.sudo.sha256, nodeExecutable: d.node.path, nodeSha256: d.node.sha256 };
    // Only root ownership is simulated. Actual private/release pins and database identity are verified.
    const deps = { effectiveUid: () => 0, readRootBytes: file => fs.readFileSync(file) };
    return { ...f, options, deps, record };
}
test('preparation derives exact public allowlist from independent root input pins without installing', t => {
    const f = fixture(t); const output = prepareForwardStartupAuthority(f.options, f.deps);
    assert.deepEqual(JSON.parse(output.publicDescriptor), f.descriptor);
    const config = JSON.parse(output.privateConfig);
    const publicAgain = generateStartupPublicDescriptor({ ...f.deps, readRootBytes: file => file === '/etc/nassaj/release-runtime-host.json' ? Buffer.from(output.privateConfig) : fs.readFileSync(file) });
    assert.equal(publicAgain, output.publicDescriptor);
    assert.equal(config.bootstrapClaim.identity.databaseDev, String(fs.statSync(f.descriptor.databasePath, { bigint: true }).dev));
    for (const name of ['approvalFile', 'ownerApprovalPublicKeyFile', 'applicationUid', 'generationRecordFile', 'phase', 'nonce']) assert.ok(!output.publicDescriptor.includes(`"${name}"`));
});
test('unprivileged production invocation rejects before reading private configuration', () => {
    if (process.geteuid() === 0) return;
    assert.throws(() => generateStartupPublicDescriptor(), /root_required/);
});
test('missing or mismatched independent pins and contract closure reject preparation', async t => {
    for (const field of ['generationRecordSha256', 'reviewedHostConfigSha256', 'releaseManifestSha256', 'startupClosureSha256', 'dispatcherSha256']) {
        await t.test(field, t => { const f = fixture(t); f.options[field] = 'f'.repeat(64);
            assert.throws(() => prepareForwardStartupAuthority(f.options, f.deps)); });
    }
});
test('re-pinned record cannot change real release IDs, variant or DB contract', async t => {
    for (const [key, value] of [['releaseId', 0], ['assetId', -1], ['profile', 'default'], ['generationId', 'fake'], ['databaseContractSha256', 'f'.repeat(64)]]) {
        await t.test(key, t => { const f = fixture(t); f.record.identity[key] = value;
            fs.writeFileSync(f.options.generationRecordFile, JSON.stringify(f.record)); f.options.generationRecordSha256 = sha(fs.readFileSync(f.options.generationRecordFile));
            assert.throws(() => prepareForwardStartupAuthority(f.options, f.deps)); });
    }
});

test('real output writer defeats umask077, preserves exact modes and refuses overwrite', t => {
    const f = fixture(t); const out = path.join(f.root, 'output'); fs.mkdirSync(out, { mode: 0o700 });
    const script = `import {writeForwardStartupOutputs} from './scripts/generate-first-cutover-config.mjs';
        process.umask(0o077);writeForwardStartupOutputs(${JSON.stringify(out)},{privateConfig:'private\\n',publicDescriptor:'public\\n'});`;
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.statSync(path.join(out, 'startup-admission-client.json')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(out, 'release-runtime-host.forward.json')).mode & 0o777, 0o600);
    const before = fs.readFileSync(path.join(out, 'startup-admission-client.json'));
    const second = run(); assert.notEqual(second.status, 0); assert.match(second.stderr, /EEXIST/);
    assert.deepEqual(fs.readFileSync(path.join(out, 'startup-admission-client.json')), before);
});

test('forward preparation preserves a verified canonical Bash pin and rejects alias or wrong bytes', t => {
    const f = fixture(t); const canonical = fs.realpathSync('/bin/bash');
    const good = { path: canonical, sha256: sha(fs.readFileSync(canonical)) };
    const write = bash => { f.config.forwardActivation = { bash }; fs.writeFileSync(f.options.reviewedHostConfigFile, JSON.stringify(f.config));
        f.options.reviewedHostConfigSha256 = sha(fs.readFileSync(f.options.reviewedHostConfigFile)); };
    write(good);
    assert.deepEqual(JSON.parse(prepareForwardStartupAuthority(f.options, f.deps).privateConfig).forwardActivation.bash, good);
    write({ ...good, path: canonical === '/bin/bash' ? '/usr/bin/bash' : '/bin/bash' });
    assert.throws(() => prepareForwardStartupAuthority(f.options, f.deps), /forward_bash_path_invalid/);
    write({ ...good, sha256: '0'.repeat(64) });
    assert.throws(() => prepareForwardStartupAuthority(f.options, f.deps), /pin_mismatch/);
});

test('startup preparation preserves reviewed state lock pins and rejects missing, extra or altered fields', t => {
    const f=fixture(t); const expected=structuredClone(f.config.stateLock);
    const result=prepareForwardStartupAuthority(f.options,f.deps);
    assert.deepEqual(JSON.parse(result.privateConfig).stateLock,expected);
    assert.ok(!result.publicDescriptor.includes('stateLock'));
    for(const lock of [undefined,{...expected,extra:true},{...expected,flock:{...expected.flock,path:'/bin/flock'}},{...expected,flock:{...expected.flock,sha256:'f'.repeat(64)}}]){
        f.config.stateLock=lock;fs.writeFileSync(f.options.reviewedHostConfigFile,JSON.stringify(f.config));
        f.options.reviewedHostConfigSha256=sha(fs.readFileSync(f.options.reviewedHostConfigFile));
        assert.throws(()=>prepareForwardStartupAuthority(f.options,f.deps),/state_lock_invalid|pin_mismatch/);
    }
});
