import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { main, parseArgs } from './release-license-gate.mjs';
import { runReleaseLicenseGate } from './lib/release-generation/license-gate-run.mjs';
import { renderThirdPartyNotices } from './lib/release-generation/third-party-notices.mjs';
import {
    FIXTURE_SRI, buildProject, mitPackage, scratchDir,
} from './lib/release-generation/release-license-gate.test.fixture.mjs';

const SDK = '@anthropic-ai/claude-agent-sdk';

function passingPackages() {
    return {
        'node_modules/b': mitPackage('b', '2.0.0'),
        'node_modules/a': mitPackage('a', '1.0.0', { dependencies: { b: '2' } }),
        'node_modules/x/node_modules/b': mitPackage('b', '2.0.0'),
        [`node_modules/${SDK}`]: {
            lock: { version: '0.3.0', license: 'SEE LICENSE IN README.md', resolved: 'https://registry.npmjs.org/sdk.tgz',
                integrity: FIXTURE_SRI },
        },
        'node_modules/x': mitPackage('x', '1.0.0'),
        'node_modules/devtool': { lock: { version: '1.0.0', dev: true, license: 'GPL-3.0-only' } },
    };
}

function fixture(t, packages = passingPackages(), options = {}) {
    const root = scratchDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return buildProject(root, { packages, ...options });
}

function capture() {
    const out = { stdout: '', stderr: '' };
    return { out, io: { stdout: text => { out.stdout += text; }, stderr: text => { out.stderr += text; } } };
}

test('end to end: a clean closure passes and renders deterministic notices', t => {
    const root = fixture(t);
    const first = runReleaseLicenseGate({ root });
    assert.equal(first.ok, true, JSON.stringify(first.findings));
    assert.deepEqual(first.counts, { shipped: 4, excluded: 1, skipped: 0 });
    assert.equal(first.notices, runReleaseLicenseGate({ root }).notices);
    const notices = first.notices;
    assert.match(notices, /^THIRD-PARTY SOFTWARE NOTICES\n/);
    assert.match(notices, /Packages: 3\n/, 'b@2.0.0 installed twice appears once');
    assert.match(notices, /Licenses:\n {2}MIT: 3\n/);
    assert.match(notices, new RegExp(`\n {2}${SDK}@0\\.3\\.0\n`));
    assert.ok(notices.indexOf('Package: a@1.0.0') < notices.indexOf('Package: b@2.0.0'));
    assert.ok(notices.indexOf('Package: b@2.0.0') < notices.indexOf('Package: x@1.0.0'));
    assert.ok(notices.endsWith(`${'='.repeat(80)}\n`));
    assert.doesNotMatch(notices, /devtool|\r/);
});

test('any failure withholds the notices; tree and script checks feed the same report', t => {
    const packages = passingPackages();
    packages['node_modules/a'].manifest.license = 'UNLICENSED';
    packages['node_modules/a'].lock.license = 'UNLICENSED';
    const root = fixture(t, packages, {
        rootManifest: { name: 'app', scripts: { postinstall: `node -e "require('${SDK}')"` } },
    });
    fs.mkdirSync(path.join(root, 'node_modules', ...SDK.split('/')), { recursive: true });
    const report = runReleaseLicenseGate({ root, checkTree: true });
    assert.equal(report.ok, false);
    assert.equal(report.notices, null);
    assert.deepEqual(report.findings.map(item => item.code).sort(), [
        'excluded_package_shipped', 'excluded_reference_in_script', 'license_unlicensed',
    ]);
});

test('notices renderer: declared-vs-elected line, review line, no excluded section when empty', () => {
    const record = {
        name: 'p', version: '1.0.0', path: 'node_modules/p', resolved: null, declared: 'MPL-2.0 OR MIT', license: 'MIT',
        author: null, override: { evidence: 'ev', reviewed: 'rv' }, texts: [{ title: 'LICENSE', text: 'T\n' }],
    };
    const text = renderThirdPartyNotices({ target: 'linux-x64-glibc', lockfileSha256: 'f'.repeat(64), records: [record] });
    assert.match(text, /License: MIT\nDeclared: MPL-2\.0 OR MIT\nLicense review: ev \(rv\)\n/);
    assert.doesNotMatch(text, /Not included in this archive/);
    assert.doesNotMatch(text, /Source:|Author:/);
});

test('CLI: pass writes notices, fail exits 1 without writing, bad input exits 2', t => {
    const root = fixture(t);
    const out = path.join(root, 'THIRD_PARTY_NOTICES');
    const pass = capture();
    assert.equal(main(['--root', root, '--notices-out', out], pass.io), 0);
    assert.match(pass.out.stdout, /license gate: PASS/);
    assert.equal(fs.readFileSync(out, 'utf8'), runReleaseLicenseGate({ root }).notices);

    const json = capture();
    assert.equal(main(['--root', root, '--json', '--target', 'linux-arm64-glibc'], json.io), 0);
    const summary = JSON.parse(json.out.stdout);
    assert.equal(summary.target, 'linux-arm64-glibc');
    assert.equal('notices' in summary || 'closure' in summary, false);

    const failing = capture();
    const failOut = path.join(root, 'fail-notices');
    assert.equal(main(['--root', root, '--check-tree', '--tree', path.join(root, 'empty'), '--notices-out', failOut], failing.io), 1);
    assert.match(failing.out.stdout, /FAIL package_not_installed node_modules\/a/);
    assert.equal(fs.existsSync(failOut), false);

    for (const argv of [['--bogus'], ['--root'], ['--root', root, '--target', 'darwin-x64'], ['--root', path.join(root, 'nope')]]) {
        const bad = capture();
        assert.equal(main(argv, bad.io), 2, argv.join(' '));
        assert.match(bad.out.stderr, /^license gate error: /);
    }
});

test('CLI warnings are printed but do not fail', t => {
    const root = fixture(t);
    const policyFile = path.join(root, 'scripts/release-license-allowlist.json');
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    policy.overrides = [{ package: 'ghost@1.0.0', license: 'MIT', evidence: 'x', reviewed: '2026-09-28 t' }];
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    const run = capture();
    assert.equal(main(['--root', root, '--policy', policyFile], run.io), 0);
    assert.match(run.out.stdout, /WARN license_override_unused ghost@1\.0\.0/);
    assert.deepEqual(parseArgs(['--check-tree']).checkTree, true);
});
