import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SpdxParseError, electAllowedLicense, formatSpdxTree, parseSpdxExpression, spdxLicenseIds,
} from './spdx-expression.mjs';

const elect = (expression, allowed) => {
    const tree = electAllowedLicense(parseSpdxExpression(expression), allowed);
    return tree && formatSpdxTree(tree);
};

test('parses identifiers, operators, precedence and parentheses', () => {
    assert.deepEqual(parseSpdxExpression('MIT'), { type: 'license', id: 'MIT' });
    assert.equal(formatSpdxTree(parseSpdxExpression('MIT OR Apache-2.0 AND ISC')), 'MIT OR (Apache-2.0 AND ISC)');
    assert.equal(formatSpdxTree(parseSpdxExpression('(MIT OR Apache-2.0) AND ISC')), '(MIT OR Apache-2.0) AND ISC');
    assert.equal(formatSpdxTree(parseSpdxExpression('((MIT))')), 'MIT');
    assert.deepEqual(parseSpdxExpression('GPL-2.0-or-later WITH Classpath-exception-2.0'),
        { type: 'with', id: 'GPL-2.0-or-later', exception: 'Classpath-exception-2.0' });
    assert.equal(formatSpdxTree(parseSpdxExpression('GPL-2.0+ OR LicenseRef-x')), 'GPL-2.0+ OR LicenseRef-x');
    assert.equal(formatSpdxTree(parseSpdxExpression('DocumentRef-a:LicenseRef-b')), 'DocumentRef-a:LicenseRef-b');
});

test('refuses malformed expressions instead of guessing', () => {
    const bad = ['', 'MIT or Apache-2.0', '(MIT', 'MIT)', 'MIT Apache-2.0', 'AND', 'MIT AND', 'MIT WITH',
        '(MIT OR ISC) WITH X', 'MIT WITH AND', 'MIT WITH (', 'M!T', 'x'.repeat(600), '()'];
    for (const expression of bad) assert.throws(() => parseSpdxExpression(expression), SpdxParseError, expression);
    assert.throws(() => parseSpdxExpression(null), SpdxParseError);
});

test('elects by preference order for OR and requires every AND term', () => {
    const order = ['MIT', 'Apache-2.0', 'MPL-2.0'];
    assert.equal(elect('MPL-2.0 OR Apache-2.0', order), 'Apache-2.0');
    assert.equal(elect('(MIT OR GPL-3.0-or-later)', order), 'MIT');
    assert.equal(elect('GPL-3.0-only OR WTFPL', order), null);
    assert.equal(elect('MIT AND Zlib', order), null);
    assert.equal(elect('MIT AND (Zlib OR Apache-2.0)', order), 'MIT AND Apache-2.0');
    assert.equal(elect('MPL-2.0 AND MIT OR Apache-2.0', order), 'Apache-2.0');
    assert.equal(elect('MIT OR MIT', new Set(['MIT'])), 'MIT');
});

test('WITH exceptions need the exact allowlisted pair', () => {
    assert.equal(elect('Apache-2.0 WITH LLVM-exception', ['Apache-2.0']), null);
    assert.equal(elect('Apache-2.0 WITH LLVM-exception', ['Apache-2.0 WITH LLVM-exception']), 'Apache-2.0 WITH LLVM-exception');
});

test('lists every named identifier', () => {
    assert.deepEqual(spdxLicenseIds(parseSpdxExpression('(MIT OR GPL-3.0-only) AND X WITH Y')),
        ['MIT', 'GPL-3.0-only', 'X WITH Y']);
});
