import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { localPairActivationAvailable, publicLocalUpdate, setLocalUpdateRuntimeIdentity } from '../server/services/local-preview-server-control.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TEMP_ROOT || '/var/tmp', 'local-capability-'));
    t.after(() => { setLocalUpdateRuntimeIdentity({}); fs.rmSync(root, { recursive: true, force: true }); });
    const loaded = { serverBuildId: 'a'.repeat(64), runtimeDependenciesSha256: '1'.repeat(64), capabilities: { oidPairAdmissionV1: true, oidTripleAdmissionV2: true } };
    const target = { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
        installRuntime: { nodeBinarySha256: 'b'.repeat(64), nodeVersion: 'v24.18.1', nodeModuleAbi: '137', napi: '10',
            platform: 'linux', arch: 'x64', npmVersion: '11.16.0', npmCliSha256: 'c'.repeat(64) } };
    for (const field of ['clientBuildId', 'serverBuildId', 'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256',
        'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256']) target[field] = 'b'.repeat(64);
    const dependency = { schema: 'nassaj-oid-dependency-generation/v2' };
    for (const field of ['nodeModulesTreeSha256', 'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'installRuntime']) dependency[field] = target[field];
    const candidate = { oid: 'f'.repeat(40), serverBuildId: target.serverBuildId, runtimeDependenciesSha256: '2'.repeat(64),
        capabilities: { oidPairAdmissionV1: true, oidTripleAdmissionV2: true }, dependencyGenerationV2: dependency };
    const file = path.join(root, '.nassaj-local-preview/server-candidates', target.serverBuildId, 'OID_CONTROL_MANIFEST.json');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(path.join(root, 'dist-server'));
    function write() {
        fs.writeFileSync(file, JSON.stringify(candidate));
        fs.writeFileSync(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), JSON.stringify(loaded));
        target.controlManifestSha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
    write(); setLocalUpdateRuntimeIdentity({ serverLoadedBuildId: loaded.serverBuildId });
    return { root, loaded, target, candidate, write, state: { oid: candidate.oid, target } };
}

test('v2 advertises distinct dependencies only with both capabilities and the sealed dependency contract', t => {
    const v = fixture(t);
    assert.equal(localPairActivationAvailable(v.root, v.state), true);
    delete v.loaded.capabilities.oidTripleAdmissionV2; v.write();
    assert.equal(localPairActivationAvailable(v.root, v.state), false);
    v.loaded.capabilities.oidTripleAdmissionV2 = true; delete v.candidate.capabilities.oidTripleAdmissionV2; v.write();
    assert.equal(localPairActivationAvailable(v.root, v.state), false);
});

test('unknown target schema, mismatched policy and changed manifest cannot use the pair fallback', t => {
    const v = fixture(t), schema = v.target.schema;
    v.target.schema = 'unknown'; assert.equal(localPairActivationAvailable(v.root, v.state), false); v.target.schema = schema;
    v.candidate.dependencyGenerationV2.installPolicySha256 = 'e'.repeat(64); v.write();
    assert.equal(localPairActivationAvailable(v.root, v.state), false);
    v.candidate.dependencyGenerationV2.installPolicySha256 = v.target.installPolicySha256; v.write();
    v.target.controlManifestSha256 = '0'.repeat(64); assert.equal(localPairActivationAvailable(v.root, v.state), false);
});

test('v1 remains limited to an unchanged dependency baseline and loaded process identity', t => {
    const v = fixture(t); delete v.target.schema;
    assert.equal(localPairActivationAvailable(v.root, v.state), false);
    v.candidate.runtimeDependenciesSha256 = v.loaded.runtimeDependenciesSha256; v.write();
    assert.equal(localPairActivationAvailable(v.root, v.state), true);
    setLocalUpdateRuntimeIdentity({ serverLoadedBuildId: 'e'.repeat(64) });
    assert.equal(localPairActivationAvailable(v.root, v.state), false);
});

test('public status includes the typed target scope but omits dependency paths and runtime control', t => {
    const v = fixture(t), visible = publicLocalUpdate({ ...v.state, sequence: 1, revision: 1, phase: 'prepared' });
    assert.equal(visible.target.schema, 'nassaj-oid-triple-target/v2');
    assert.deepEqual(visible.target.generationNames, ['nodeModules', 'server', 'client']);
    assert.equal('installRuntime' in visible.target, false);
});
