import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareNassajReleaseVersions,
    isNassajReleaseVersion,
    releaseTagForVersion,
} from './release-version-policy.js';

test('accepts only canonical four-part Nassaj release versions', () => {
    assert.equal(isNassajReleaseVersion('1.42.0.1'), true);
    for (const value of ['1.42.0', '1.42.0.1-beta', '01.42.0.1', '-1.42.0.1', '1.42.0.1;id']) {
        assert.equal(isNassajReleaseVersion(value), false, value);
    }
});

test('compares all four release segments and derives the exact tag', () => {
    assert.equal(compareNassajReleaseVersions('1.42.0.1', '1.42.0.0'), 1);
    assert.equal(compareNassajReleaseVersions('1.42.0.0', '1.42.0.1'), -1);
    assert.equal(releaseTagForVersion('1.42.0.1'), 'v1.42.0.1');
});
