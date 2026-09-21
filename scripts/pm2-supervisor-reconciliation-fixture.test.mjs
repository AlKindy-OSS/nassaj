import assert from 'node:assert/strict';
import test from 'node:test';
import { runPrivatePm2Fixture, validatePrivateHome } from './fixtures/pm2-supervisor-reconciliation-fixture.mjs';

test('private lab refuses host PM2 path and non-private roots before launch', () => {
    assert.throws(() => validatePrivateHome('/home/operator', '/home/operator/.pm2'));
    assert.throws(() => runPrivatePm2Fixture('host'));
});

test('real PM2 demonstrates split ownership, destructive dump and partial start in private home', () => {
    const result = runPrivatePm2Fixture();
    assert.equal(result.evidence.services.length, 6);
    assert.equal(result.evidence.peerMovedToDuplicate, true);
    assert.equal(result.evidence.originalRemainedHealthy, true);
    assert.deepEqual(result.evidence.duplicateStopDumpNames, ['duplicate-synthetic']);
    assert.equal(result.evidence.partialStart.healthy, 5);
    assert.equal(result.guardian.workerExit, 0);
    assert.equal(result.hostSentinelUnchanged, true);
    assert.equal(result.temporaryDirectoryRemoved, true);
    console.log(JSON.stringify(result));
});

for (const mode of ['after-start-failure', 'timeout']) {
    test(`guardian reaps private daemon after ${mode}`, () => {
        const result = runPrivatePm2Fixture(mode);
        assert.equal(result.guardian.allChildrenReaped, true);
        assert.equal(result.guardian.kernelSocketsAbsent, true);
        assert.equal(result.guardian.socketPathsAbsent, true);
        assert.equal(result.hostSentinelUnchanged, true);
        assert.equal(result.temporaryDirectoryRemoved, true);
        if (mode === 'timeout') assert.equal(result.guardian.timedOut, true);
        else assert.equal(result.guardian.workerExit, 1);
    });
}

test('outer Node timeout cancels guardian and reaps worker, PM2 and six services before removal', () => {
    const result = runPrivatePm2Fixture('external-timeout');
    assert.deepEqual(result.cancellation, { externalTimeout: true, guardianExited: true,
        workerExited: true, daemonExited: true, servicesExited: 6 });
    assert.equal(result.guardian.allChildrenReaped, true);
    assert.equal(result.guardian.kernelSocketsAbsent, true);
    assert.equal(result.guardian.socketPathsAbsent, true);
    assert.equal(result.hostSentinelUnchanged, true);
    assert.equal(result.temporaryDirectoryRemoved, true);
});
