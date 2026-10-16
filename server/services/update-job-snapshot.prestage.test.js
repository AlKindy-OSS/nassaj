import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveUpdateJobPrestage } from './update-job-snapshot.js';

const db = (rows) => ({ listReceipts: () => rows });
const receipt = (phase, kind, facts) => ({ phase, kind, facts_json: JSON.stringify(facts) });

test('S5: a job that never met a prestaged slot is not prestaged', () => {
    assert.deepEqual(deriveUpdateJobPrestage({ id: 'j' }, db([receipt('staging', 'done', { stage: 'x' })])),
        { prestaged: false, prestageRejectedReason: null });
    assert.deepEqual(deriveUpdateJobPrestage({ id: 'j' }, { listReceipts: () => { throw new Error('db'); } }),
        { prestaged: false, prestageRejectedReason: null });
});

test('S5: an adopted receipt marks the job prestaged', () => {
    const rows = [receipt('staging', 'done', { prestage: 'adopted', slotId: 's', keyDigest: 'k', builtAt: 't' })];
    assert.deepEqual(deriveUpdateJobPrestage({ id: 'j' }, db(rows)), { prestaged: true, prestageRejectedReason: null });
});

test('S5: a rejected adoption exposes only the reason head', () => {
    const rows = [receipt('staging', 'done', { prestage: 'rejected', reason: 'identity_mismatch:npm,runtime', fields: ['npm', 'runtime'] })];
    assert.deepEqual(deriveUpdateJobPrestage({ id: 'j' }, db(rows)), { prestaged: false, prestageRejectedReason: 'identity_mismatch' });
    const odd = [receipt('staging', 'done', { prestage: 'rejected', reason: '/etc/passwd' })];
    assert.equal(deriveUpdateJobPrestage({ id: 'j' }, db(odd)).prestageRejectedReason, 'unknown');
});

test('S5: the last prestage receipt wins (a retried run adopts)', () => {
    const rows = [
        receipt('staging', 'done', { prestage: 'rejected', reason: 'tag_moved' }),
        receipt('staging', 'done', { prestage: 'adopted', slotId: 's' }),
    ];
    assert.deepEqual(deriveUpdateJobPrestage({ id: 'j' }, db(rows)), { prestaged: true, prestageRejectedReason: null });
});
