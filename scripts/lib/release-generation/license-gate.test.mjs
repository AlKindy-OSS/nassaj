import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    LicenseTextError, MAX_LICENSE_TEXT_BYTES, evaluateClosureLicenses, evaluatePackage, formatAuthor, loadLicensePolicy,
    normalizeText,
} from './license-gate.mjs';
import { ReleaseManifestError } from './release-manifest-codes.mjs';
import { MIT_TEXT, buildProject, mitPackage, policyDoc, scratchDir } from './release-license-gate.test.fixture.mjs';

const code = expected => error => error instanceof ReleaseManifestError && error.code === expected;
const REVIEWED = '2026-09-28 test reviewer';

function project(t, packages, policyExtra = {}) {
    const root = scratchDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    buildProject(root, { packages, policy: policyDoc(policyExtra) });
    const policy = loadLicensePolicy(policyDoc(policyExtra), path.join(root, 'scripts'));
    return { root, policy };
}

function evaluate(t, lockPath, spec, policyExtra) {
    const { root, policy } = project(t, { [lockPath]: spec }, policyExtra);
    const name = spec.manifest?.name ?? lockPath.replace(/^.*node_modules\//, '');
    const pkg = { path: lockPath, name, version: spec.lock.version, license: spec.lock.license, resolved: spec.lock.resolved };
    return evaluatePackage(pkg, { treeRoot: root, policy });
}

const findingCode = outcome => outcome.findings.map(item => item.code);
const withLicense = (license, lockLicense = license) => {
    const spec = mitPackage('p');
    spec.manifest.license = license;
    spec.lock.license = lockLicense;
    return spec;
};

test('policy: valid loads; contradictions, tampering and empty overrides are refused', t => {
    const { root } = project(t, {});
    const dir = path.join(root, 'scripts');
    const policy = loadLicensePolicy(policyDoc(), dir);
    assert.equal(policy.texts.get('MIT').text, MIT_TEXT);
    assert.deepEqual(policy.allowedOrder, ['MIT', 'ISC', 'Apache-2.0', 'MPL-2.0']);
    const refuse = (document, expected = 'license_policy_invalid') => assert.throws(() => loadLicensePolicy(document, dir), code(expected));
    refuse(policyDoc({ denied: ['MIT'] }));
    refuse(policyDoc({ texts: [{ ...policyDoc().texts[0], sha256: '0'.repeat(64) }] }), 'license_supplied_text_tampered');
    refuse(policyDoc({ overrides: [{ package: 'a@1.0.0', evidence: 'x', reviewed: REVIEWED }] }));
    refuse(policyDoc({ overrides: [{ package: 'a@1.0.0', suppliedText: 'ISC', evidence: 'x', reviewed: REVIEWED }] }));
    refuse(policyDoc({ overrides: [{
        package: 'a@1.0.0', excerpt: { file: 'README.md', fromLine: 5, toLine: 2 }, evidence: 'x', reviewed: REVIEWED,
    }] }));
    refuse(policyDoc({ overrides: [{ package: 'a@1.0.0', license: 'MIT', evidence: 'x', reviewed: 'yesterday' }] }));
    refuse(policyDoc({ overrides: [{ package: 'no-version', license: 'MIT', evidence: 'x', reviewed: REVIEWED }] }));
    refuse({ ...policyDoc(), allowed: [] });
});

test('a normal package passes with its license and notice files', t => {
    const spec = mitPackage('ok', '1.2.3', {}, { author: { name: 'Ann', email: 'a@x', url: 'https://x' } });
    spec.files['NOTICE.md'] = 'Notice text\r\n';
    spec.files['LICENSE-APACHE'] = 'Apache text\n';
    spec.files['license.txt'] = '﻿MIT copy   \n\n\n';
    const outcome = evaluate(t, 'node_modules/ok', spec);
    assert.deepEqual(outcome.findings, []);
    assert.equal(outcome.record.license, 'MIT');
    assert.equal(outcome.record.author, 'Ann <a@x> (https://x)');
    assert.deepEqual(outcome.record.texts.map(item => item.title), ['LICENSE', 'LICENSE-APACHE', 'license.txt', 'NOTICE.md']);
    assert.equal(outcome.record.texts[2].text, 'MIT copy\n');
    assert.equal(outcome.record.texts[3].text, 'Notice text\n');
});

test('refused declarations: SEE LICENSE, UNLICENSED, missing, legacy, unparseable, denied, not allowlisted', t => {
    const cases = [
        [withLicense('SEE LICENSE IN LICENSE.md'), 'license_see_file'],
        [withLicense('UNLICENSED'), 'license_unlicensed'],
        [withLicense(undefined, undefined), 'license_missing'],
        [withLicense({ type: 'MIT' }, undefined), 'license_missing'],
        [withLicense('MIT or ISC'), 'license_unparseable'],
        [withLicense('GPL-3.0-only'), 'license_denied'],
        [withLicense('MIT AND GPL-3.0-only'), 'license_denied'],
        [withLicense('WTFPL'), 'license_not_allowlisted'],
        [withLicense('MIT', 'ISC'), 'license_mismatch'],
    ];
    for (const [spec, expected] of cases) assert.deepEqual(findingCode(evaluate(t, 'node_modules/p', spec)), [expected]);
    const legacy = evaluate(t, 'node_modules/p', withLicense({ type: 'MIT' }, undefined));
    assert.match(legacy.findings[0].detail, /legacy form/);
});

test('an OR expression elects the preferred allowlisted branch', t => {
    const outcome = evaluate(t, 'node_modules/p', withLicense('(MPL-2.0 OR Apache-2.0)'));
    assert.equal(outcome.record.license, 'Apache-2.0');
    assert.equal(outcome.record.declared, '(MPL-2.0 OR Apache-2.0)');
});

test('install problems: missing package and identity mismatch', t => {
    const missing = mitPackage('gone');
    delete missing.manifest;
    assert.deepEqual(findingCode(evaluate(t, 'node_modules/gone', missing)), ['package_not_installed']);
    const wrong = mitPackage('p');
    wrong.manifest.version = '9.9.9';
    const { root, policy } = project(t, { 'node_modules/p': wrong });
    const outcome = evaluatePackage({ path: 'node_modules/p', name: 'p', version: '1.0.0' }, { treeRoot: root, policy });
    assert.deepEqual(findingCode(outcome), ['package_identity_mismatch']);
});

test('override supplies a license for a legacy package and must not contradict a declared one', t => {
    const legacy = withLicense(undefined, undefined);
    legacy.manifest.licenses = [{ type: 'MIT' }];
    const override = { package: 'p@1.0.0', license: 'MIT', evidence: 'LICENSE file is MIT', reviewed: REVIEWED };
    const ok = evaluate(t, 'node_modules/p', legacy, { overrides: [override] });
    assert.deepEqual(ok.findings, []);
    assert.deepEqual(ok.record.override, { evidence: 'LICENSE file is MIT', reviewed: REVIEWED });
    const conflict = evaluate(t, 'node_modules/p', withLicense('ISC'), { overrides: [override] });
    assert.deepEqual(findingCode(conflict), ['license_override_conflict']);
    const notAllowed = evaluate(t, 'node_modules/p', legacy, { overrides: [{ ...override, license: 'UNLICENSED' }] });
    assert.deepEqual(findingCode(notAllowed), ['license_unlicensed']);
});

test('no license file: fails unless a pinned canonical text is supplied', t => {
    const bare = mitPackage('p');
    bare.files = { 'README.md': 'Title\n\n## License\n\nMIT (c) Someone\n\nmore\n' };
    assert.deepEqual(findingCode(evaluate(t, 'node_modules/p', bare)), ['license_file_missing']);
    const supplied = { package: 'p@1.0.0', suppliedText: 'MIT', evidence: 'declares MIT', reviewed: REVIEWED };
    const ok = evaluate(t, 'node_modules/p', bare, { overrides: [supplied] });
    assert.deepEqual(ok.findings, []);
    assert.match(ok.record.texts[0].title, /canonical text supplied by Nassaj/);
    assert.equal(ok.record.texts[0].text, MIT_TEXT);
    const excerpt = { ...supplied, excerpt: { file: 'README.md', fromLine: 3, toLine: 5 } };
    const withExcerpt = evaluate(t, 'node_modules/p', bare, { overrides: [excerpt] });
    assert.equal(withExcerpt.record.texts[1].text, '## License\n\nMIT (c) Someone\n');
    assert.equal(withExcerpt.record.texts[1].title, 'README.md lines 3-5 (license statement)');
});

test('supplied-text and excerpt overrides are checked against the package', t => {
    const supplied = { package: 'p@1.0.0', suppliedText: 'MIT', evidence: 'x', reviewed: REVIEWED };
    const withFile = evaluate(t, 'node_modules/p', mitPackage('p'), { overrides: [supplied] });
    assert.deepEqual(findingCode(withFile), ['license_override_invalid']);
    const isc = withLicense('ISC');
    isc.files = {};
    assert.deepEqual(findingCode(evaluate(t, 'node_modules/p', isc, { overrides: [supplied] })), ['license_override_invalid']);
    const bare = mitPackage('p');
    bare.files = { 'README.md': 'one\ntwo\n' };
    const outOfRange = { ...supplied, excerpt: { file: 'README.md', fromLine: 1, toLine: 9 } };
    const missingFile = { ...supplied, excerpt: { file: 'NOPE.md', fromLine: 1, toLine: 1 } };
    for (const override of [outOfRange, missingFile]) {
        assert.deepEqual(findingCode(evaluate(t, 'node_modules/p', bare, { overrides: [override] })), ['license_override_invalid']);
    }
});

test('license texts must be non-empty UTF-8 within the size cap', t => {
    const cases = [Buffer.from([0xc3, 0x28]), '  \n\n', Buffer.alloc(MAX_LICENSE_TEXT_BYTES + 1, 0x61)];
    for (const content of cases) {
        const spec = mitPackage('p');
        spec.files = { LICENSE: content };
        assert.deepEqual(findingCode(evaluate(t, 'node_modules/p', spec)), ['license_text_invalid']);
    }
    assert.throws(() => normalizeText(Buffer.from(''), 'x'), LicenseTextError);
    assert.equal(normalizeText(Buffer.from('a\r\nb\rc  \n'), 'x'), 'a\nb\nc\n');
});

test('closure evaluation collects records and warns about unused overrides', t => {
    const unused = { package: 'ghost@1.0.0', license: 'MIT', evidence: 'x', reviewed: REVIEWED };
    const { root, policy } = project(t, { 'node_modules/a': mitPackage('a'), 'node_modules/b': withLicense('WTFPL') },
        { overrides: [unused] });
    const shipped = [
        { path: 'node_modules/a', name: 'a', version: '1.0.0', license: 'MIT' },
        { path: 'node_modules/b', name: 'p', version: '1.0.0', license: 'WTFPL' },
    ];
    const result = evaluateClosureLicenses(shipped, { treeRoot: root, policy });
    assert.equal(result.records.length, 1);
    assert.deepEqual(findingCode(result), ['license_not_allowlisted']);
    assert.deepEqual(result.warnings.map(item => `${item.code} ${item.subject}`), ['license_override_unused ghost@1.0.0']);
});

test('author formatting', () => {
    assert.equal(formatAuthor(' A '), 'A');
    assert.equal(formatAuthor(''), null);
    assert.equal(formatAuthor({ name: 'B' }), 'B');
    assert.equal(formatAuthor({ email: 'x' }), null);
    assert.equal(formatAuthor(undefined), null);
});
