import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePrestageReason, toOwnerPrestageStatus } from './update-prestage-status.js';

const NONE = { state: 'none', version: null, quarantineUntil: null, notPrestagedReason: null, readySince: null };

test('S5: missing or initial status is none with no reason', () => {
    assert.deepEqual(toOwnerPrestageStatus(null), NONE);
    assert.deepEqual(toOwnerPrestageStatus({ state: 'idle', reasonCode: 'not_started', version: null }), NONE);
    assert.deepEqual(toOwnerPrestageStatus({ state: 'idle', reasonCode: 'up_to_date', version: null }), NONE);
});

test('S5: ready carries readySince; building and adopted carry the version only', () => {
    assert.deepEqual(toOwnerPrestageStatus({ state: 'ready', version: '2.4.0.1', readyAt: '2026-10-15T08:00:00.000Z', reasonCode: null }),
        { ...NONE, state: 'ready', version: '2.4.0.1', readySince: '2026-10-15T08:00:00.000Z' });
    assert.deepEqual(toOwnerPrestageStatus({ state: 'building', version: '2.4.0.1', readyAt: null }), { ...NONE, state: 'building', version: '2.4.0.1' });
    assert.deepEqual(toOwnerPrestageStatus({ state: 'adopted', version: '2.4.0.1' }), { ...NONE, state: 'adopted', version: '2.4.0.1' });
});

test('S5: quarantine exposes its end time', () => {
    const out = toOwnerPrestageStatus({ state: 'blocked', reasonCode: 'quarantine', version: '2.4.0.1', quarantineUntil: '2026-10-15T20:00:00.000Z' });
    assert.deepEqual(out, { ...NONE, state: 'quarantine', version: '2.4.0.1', notPrestagedReason: 'quarantine', quarantineUntil: '2026-10-15T20:00:00.000Z' });
});

test('S5: off states are none with a closed reason', () => {
    assert.equal(toOwnerPrestageStatus({ state: 'off', reasonCode: 'killed' }).notPrestagedReason, 'kill_switch');
    assert.equal(toOwnerPrestageStatus({ state: 'off', reasonCode: 'policy_off' }).notPrestagedReason, 'policy_off');
    assert.deepEqual(toOwnerPrestageStatus({ state: 'off', reasonCode: 'platform_mode', version: null }), { ...NONE, notPrestagedReason: 'unsupported_mode' });
});

test('S5: a known release that is not prepared is waiting with a reason', () => {
    for (const [code, reason] of [
        ['low_memory', 'low_memory'], ['low_disk', 'low_disk'], ['settling', 'settling'], ['job_active', 'job_active'],
        ['failed_backoff', 'backoff'], ['failed_gave_up', 'failed'], ['failed:npm_ci', 'failed'],
        ['blocked:dirty_tree', 'blocked'], ['journal_manual', 'maintenance'], ['resource_ceiling_cpu', 'resource_busy'],
        ['rejected:tag_moved', 'rejected'], ['superseded', 'interrupted'], ['something_new', 'other'],
    ]) {
        assert.deepEqual(toOwnerPrestageStatus({ state: 'blocked', reasonCode: code, version: '2.4.0.1' }),
            { ...NONE, state: 'waiting', version: '2.4.0.1', notPrestagedReason: reason }, code);
    }
    assert.equal(toOwnerPrestageStatus({ state: 'settling', reasonCode: 'settling', version: '2.4.0.1' }).state, 'waiting');
});

test('S5: raw suffixes never reach the owner view', () => {
    const out = toOwnerPrestageStatus({ state: 'idle', reasonCode: 'cycle_failed:/home/x/secret', version: '2.4.0.1' });
    assert.equal(out.notPrestagedReason, 'failed');
    assert.equal(JSON.stringify(out).includes('/home'), false);
    assert.equal(normalizePrestageReason(undefined), null);
});
