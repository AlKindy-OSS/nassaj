import assert from 'node:assert/strict';
import test from 'node:test';
import { runConsumerExclusionProbe } from '../fixtures/local-consumer-exclusion-runner.mjs';

test('isolated user unit masks DB/sidecars and proc/symlink aliases while allowing build/cache writes',
    { skip: process.env.NASSAJ_CONSUMER_OS_PROBE !== '1' }, () => {
        const result = runConsumerExclusionProbe();
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.setupError, null);
        assert.equal(result.fixtureUnchanged, true);
        const outside = result.outsideUnit, inside = result.observations;
        for (const [name, attempts] of Object.entries({ ...outside.direct, ...outside.aliases })) {
            assert.deepEqual(attempts, { read: 'ACCESSIBLE', write: 'ACCESSIBLE' }, `positive control ${name}`);
        }
        for (const [name, attempts] of Object.entries({ ...inside.direct, ...inside.aliases })) {
            assert.deepEqual(attempts, { read: 'EACCES', write: 'EACCES' }, `protected route ${name}`);
        }
        assert.equal(outside.futureCreate, 'ACCESSIBLE'); assert.equal(inside.futureCreate, 'EACCES');
        assert.deepEqual(inside.writable, { cache: true, build: true });
        assert.equal(inside.effectiveUnit.status, 0);
        assert.match(inside.process.invocationId, /^[a-f0-9]{32}$/);
        assert.ok(inside.effectiveUnit.properties.includes(`InvocationID=${inside.process.invocationId}`));
        assert.ok(inside.process.cgroup.endsWith(`/${result.unitName}.service`));
        assert.notEqual(inside.process.mountNamespace, outside.process.mountNamespace);
        assert.match(result.proofScope, /No retained builder/);
        assert.match(result.inheritedFdBoundary, /not qualified/);
    });

test('client timeout stops only its owned transient unit before deleting fixture',
    { skip: process.env.NASSAJ_CONSUMER_OS_PROBE !== '1' }, () => {
        const result = runConsumerExclusionProbe({ delayMs: 5000, clientTimeoutMs: 250, runtimeMaxSec: 2 });
        assert.equal(result.setupError, 'ETIMEDOUT');
        assert.equal(result.cleanup.unitName, result.unitName);
        assert.equal(result.cleanup.stopRequested, true);
        assert.equal(result.cleanup.verifiedQuiescent, true);
        assert.equal(result.cleanup.observation.MainPID, '0');
        assert.equal(result.cleanup.observation.pendingJobs, 0);
        assert.equal(result.cleanup.fixtureRemoved, true);
        assert.ok(result.properties.includes('RuntimeMaxSec=2s'));
    });

test('service RuntimeMaxSec bounds a delayed fixture independently of the client timeout',
    { skip: process.env.NASSAJ_CONSUMER_OS_PROBE !== '1' }, () => {
        const result = runConsumerExclusionProbe({ delayMs: 5000, clientTimeoutMs: 10000, runtimeMaxSec: 1 });
        assert.notEqual(result.exitCode, 0); assert.equal(result.setupError, null);
        assert.equal(result.cleanup.verifiedQuiescent, true);
        assert.equal(result.cleanup.fixtureRemoved, true);
    });

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '../..');
for (const failure of ['unknown', 'owner_mismatch']) {
    test(`cleanup ${failure} preserves fixture and refuses any stop command`, async t => {
        const container = fs.mkdtempSync(path.join(root, '.artifacts/consumer-cleanup-boundary-'));
        t.after(() => fs.rmSync(container, { recursive: true, force: true }));
        let source = fs.readFileSync(path.join(root, 'scripts/fixtures/local-consumer-exclusion-runner.mjs'), 'utf8');
        source = source.replace("import { spawnSync } from 'node:child_process';", 'let spawnSync; export function setSpawn(value) { spawnSync = value; }')
            .replace("const project = path.resolve(import.meta.dirname, '../..');", `const project = ${JSON.stringify(root)};`);
        const file = path.join(container, 'runner.mjs'); fs.writeFileSync(file, source);
        const runner = await import(pathToFileURL(file));
        const calls = []; let ownedDirectory;
        runner.setSpawn((command, args) => {
            calls.push([command, ...args]);
            if (command === process.execPath) return { status: 0, stdout: '{}', stderr: '' };
            if (command === 'systemd-run') {
                ownedDirectory = args.find(value => value.startsWith('WorkingDirectory=')).slice('WorkingDirectory='.length);
                return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } };
            }
            if (args.includes('list-jobs')) return { status: 0, stdout: '', stderr: '' };
            return failure === 'unknown' ? { status: 1, stdout: '', stderr: 'unavailable' }
                : { status: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=123\nTransient=yes\nWorkingDirectory=${ownedDirectory}\nDescription=foreign unit\nControlGroup=\n`, stderr: '' };
        });
        // The subprocess boundary is fully replaced here, so no real unit exists to clean up.
        t.after(() => { if (ownedDirectory) fs.rmSync(ownedDirectory, { recursive: true, force: true }); });
        assert.throws(() => runner.runConsumerExclusionProbe(), new RegExp(`cleanup_${failure}`));
        assert.ok(fs.existsSync(path.join(ownedDirectory, 'unit-owner.json')));
        assert.ok(fs.existsSync(path.join(ownedDirectory, 'appdata/app.db')));
        assert.equal(calls.some(call => call.includes('stop')), false);
    });
}
