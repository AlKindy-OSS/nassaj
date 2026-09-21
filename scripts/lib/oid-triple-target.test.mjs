import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOidTripleTargetDescriptor, computeOidTripleTargetDigest } from './oid-triple-target.mjs';

const hash = 'a'.repeat(64);
export const targetFixture = () => ({ schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
    ...Object.fromEntries(['clientBuildId', 'serverBuildId', 'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256',
        'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'controlManifestSha256'].map(key => [key, hash])),
    installRuntime: { nodeBinarySha256: hash, nodeVersion: 'v24.17.0', nodeModuleAbi: '137', napi: '10',
        platform: 'linux', arch: 'x64', npmVersion: '12.0.2', npmCliSha256: hash } });

test('v2 consent binds every dependency, interpreter, policy and event field', () => {
    const target = targetFixture(), identity = { sequence: 1, group: 'event-0000000000000001', sourceOid: 'c'.repeat(40), target };
    const original = computeOidTripleTargetDigest(identity);
    for (const key of Object.keys(target).filter(key => key.endsWith('Sha256') || key.endsWith('BuildId'))) {
        assert.notEqual(computeOidTripleTargetDigest({ ...identity, target: { ...target, [key]: 'b'.repeat(64) } }), original);
    }
    assert.notEqual(computeOidTripleTargetDigest({ ...identity, target: { ...target,
        installRuntime: { ...target.installRuntime, npmVersion: '12.0.3' } } }), original);
    assert.equal(computeOidTripleTargetDigest({ ...identity, target: Object.fromEntries(Object.entries(target).reverse()) }), original);
    assert.throws(() => computeOidTripleTargetDigest({ ...identity, group: 'other' }), /invalid/);
});

test('v2 refuses missing fields, extra authority, invalid runtime, reordered generations and schema downgrade', () => {
    for (const key of Object.keys(targetFixture())) {
        const target = targetFixture(); delete target[key];
        assert.throws(() => validateOidTripleTargetDescriptor(target), /invalid/);
    }
    for (const changes of [{ schema: 'nassaj-oid-pair/v1' }, { command: 'arbitrary' },
        { generationNames: ['server', 'client', 'nodeModules'] }, { installRuntime: { ...targetFixture().installRuntime, nodeModuleAbi: 137 } }]) {
        assert.throws(() => validateOidTripleTargetDescriptor({ ...targetFixture(), ...changes }), /invalid/);
    }
});
