import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseBuiltAt } from './source-date.mjs';

test('builtAt follows SOURCE_DATE_EPOCH and falls back to the clock', () => {
    assert.equal(releaseBuiltAt({ SOURCE_DATE_EPOCH: '0' }), '1970-01-01T00:00:00.000Z');
    assert.equal(releaseBuiltAt({ SOURCE_DATE_EPOCH: '1700000000' }), '2023-11-14T22:13:20.000Z');
    assert.equal(releaseBuiltAt({}, () => new Date(5000)), '1970-01-01T00:00:05.000Z');
    assert.equal(releaseBuiltAt({ SOURCE_DATE_EPOCH: '' }, () => new Date(0)), '1970-01-01T00:00:00.000Z');
    for (const bad of ['-1', '1.5', 'yesterday', '1e9']) {
        assert.throws(() => releaseBuiltAt({ SOURCE_DATE_EPOCH: bad }), /SOURCE_DATE_EPOCH/);
    }
});
