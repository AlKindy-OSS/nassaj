import assert from 'node:assert/strict';
import test from 'node:test';

import {
    gitlinkChangePaths, gitlinkPaths, parseRawDiffEntries, parseTreeEntries, sameEntry,
} from './source-update-gitlinks.mjs';

const LINK = '4895cd3fd33362471e739b786493aba048487bcc';
const OTHER = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const ABSENT = '0'.repeat(40);

test('tree listings parse modes, paths with spaces, and refuse malformed records', () => {
    const entries = parseTreeEntries(
        `100644 blob ${BLOB}\tsrc/a file.ts\u0000160000 commit ${LINK}\tplugins/starter\u0000`);
    assert.deepEqual(entries.get('src/a file.ts'), { mode: '100644', oid: BLOB });
    assert.deepEqual(entries.get('plugins/starter'), { mode: '160000', oid: LINK });
    // A gitlink mode carrying a blob type (or the reverse) is a corrupt listing,
    // and a dropped record is a silently skipped gitlink.
    assert.throws(() => parseTreeEntries(`160000 blob ${LINK}\tplugins/starter\u0000`), /listing is invalid/);
    assert.throws(() => parseTreeEntries('040000 tree abc\tsub\u0000'), /listing is invalid/);
});

test('raw diffs yield both sides of every changed path, including renames', () => {
    const { from, to } = parseRawDiffEntries(
        `:100644 100644 ${BLOB} ${OTHER} M\u0000package.json\u0000`
        + `:000000 100644 ${ABSENT} ${BLOB} A\u0000added.md\u0000`
        + `:160000 000000 ${LINK} ${ABSENT} D\u0000plugins/starter\u0000`
        + `:100644 100644 ${BLOB} ${BLOB} R100\u0000old name.md\u0000new name.md\u0000`);
    assert.equal(from.has('added.md'), false);
    assert.deepEqual(to.get('added.md'), { mode: '100644', oid: BLOB });
    assert.deepEqual(from.get('plugins/starter'), { mode: '160000', oid: LINK });
    assert.equal(to.has('plugins/starter'), false);
    assert.equal(from.has('old name.md'), true);
    assert.deepEqual(to.get('new name.md'), { mode: '100644', oid: BLOB });
    assert.throws(() => parseRawDiffEntries(':100644 100644 x y M\u0000f\u0000'), /listing is invalid/);
});

test('the policy answer is "every gitlink this transition would have to touch"', () => {
    const unchanged = new Map([['plugins/starter', { mode: '160000', oid: LINK }]]);
    const retargeted = new Map([['plugins/starter', { mode: '160000', oid: OTHER }]]);
    const asFile = new Map([['plugins/starter', { mode: '100644', oid: BLOB }]]);
    assert.deepEqual(gitlinkChangePaths(unchanged, unchanged), []);
    assert.deepEqual(gitlinkChangePaths(unchanged, retargeted), ['plugins/starter']);
    assert.deepEqual(gitlinkChangePaths(unchanged, new Map()), ['plugins/starter']);
    assert.deepEqual(gitlinkChangePaths(new Map(), unchanged), ['plugins/starter']);
    assert.deepEqual(gitlinkChangePaths(asFile, unchanged), ['plugins/starter']);
    assert.deepEqual(gitlinkChangePaths(unchanged, asFile), ['plugins/starter']);
    // A file change beside an untouched gitlink is not a gitlink question.
    const withFile = new Map([...unchanged, ['package.json', { mode: '100644', oid: BLOB }]]);
    const withOtherFile = new Map([...unchanged, ['package.json', { mode: '100644', oid: OTHER }]]);
    assert.deepEqual(gitlinkChangePaths(withFile, withOtherFile), []);
    assert.deepEqual([...gitlinkPaths(withFile, withOtherFile)], ['plugins/starter']);
    assert.equal(sameEntry({ mode: '160000', oid: LINK }, { mode: '160000', oid: LINK }), true);
    assert.equal(sameEntry(null, undefined), true);
    assert.equal(sameEntry({ mode: '160000', oid: LINK }, undefined), false);
});
