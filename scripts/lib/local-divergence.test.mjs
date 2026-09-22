/**
 * ADR-156 / T-1730 W2 tests — divergence classification and `-z` parsing
 * (test plan §7): the three categories and their precedence, a version bump
 * (fleet-node codex-sdk), an allowScripts addition (a downstream node), a rename, a path
 * with spaces/newlines through the `-z` stream, a file directly under public/,
 * and a deleted .gitignore line.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyDivergence,
    diffDependencyVersions,
    parseNameStatusZ,
} from './local-divergence.mjs';

// --- parseNameStatusZ -----------------------------------------------------

test('parseNameStatusZ parses added/modified/deleted entries', () => {
    const z = 'A\0public/hub/index.html\0M\0server/index.js\0D\0old.txt\0';
    assert.deepEqual(parseNameStatusZ(z), [
        { status: 'A', path: 'public/hub/index.html' },
        { status: 'M', path: 'server/index.js' },
        { status: 'D', path: 'old.txt' },
    ]);
});

test('parseNameStatusZ parses a rename with old and new path', () => {
    const z = 'R100\0public/hub/old.html\0public/hub/new.html\0';
    assert.deepEqual(parseNameStatusZ(z), [
        { status: 'R100', oldPath: 'public/hub/old.html', path: 'public/hub/new.html' },
    ]);
});

test('parseNameStatusZ preserves paths with spaces and newlines (-z, no quoting)', () => {
    const weird = 'public/hub/a b\nc.html';
    const z = `A\0${weird}\0`;
    const entries = parseNameStatusZ(z);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, weird);
});

test('parseNameStatusZ returns [] for empty input', () => {
    assert.deepEqual(parseNameStatusZ(''), []);
    assert.deepEqual(parseNameStatusZ(undefined), []);
});

// --- diffDependencyVersions ----------------------------------------------

test('diffDependencyVersions names a version bump (fleet-node codex-sdk)', () => {
    const base = { dependencies: { '@openai/codex-sdk': '0.153.2' } };
    const head = { dependencies: { '@openai/codex-sdk': '0.153.4' } };
    assert.deepEqual(diffDependencyVersions(base, head), [
        { name: '@openai/codex-sdk', from: '0.153.2', to: '0.153.4' },
    ]);
});

test('diffDependencyVersions reports added and removed packages', () => {
    const base = { dependencies: { a: '1.0.0' } };
    const head = { devDependencies: { b: '2.0.0' } };
    const changed = diffDependencyVersions(base, head);
    assert.deepEqual(changed, [
        { name: 'a', from: '1.0.0', to: null },
        { name: 'b', from: null, to: '2.0.0' },
    ]);
});

// --- classifyDivergence: categories --------------------------------------

test('classifyDivergence: added public/hub file is overlayable (E1)', () => {
    const r = classifyDivergence({
        nameStatusZ: 'A\0public/hub/index.html\0A\0public/hub/app.mjs\0',
        targetTrackedPaths: ['server/index.js', 'public/manifest.json'],
    });
    assert.equal(r.category, 'overlayable');
    assert.equal(r.overlayable.length, 2);
    assert.equal(r.overlayable[0].target, 'E1');
    assert.equal(r.overlayable[0].mount, '/hub');
    assert.equal(r.code.length, 0);
});

test('classifyDivergence: added public/hub file is code when target tracks under it', () => {
    const r = classifyDivergence({
        nameStatusZ: 'A\0public/hub/index.html\0',
        targetTrackedPaths: ['public/hub/existing.html'],
    });
    assert.equal(r.category, 'code');
    assert.equal(r.code.length, 1);
    assert.equal(r.overlayable.length, 0);
});

test('classifyDivergence: modification of an existing public/hub file is code', () => {
    const r = classifyDivergence({ nameStatusZ: 'M\0public/hub/index.html\0' });
    assert.equal(r.category, 'code');
});

test('classifyDivergence: a rename under public/hub is code (not a pure addition)', () => {
    const r = classifyDivergence({
        nameStatusZ: 'R100\0public/hub/old.html\0public/hub/new.html\0',
    });
    assert.equal(r.category, 'code');
    assert.equal(r.code.length, 1);
});

test('classifyDivergence: a file directly under public/ is code', () => {
    const r = classifyDivergence({ nameStatusZ: 'A\0public/sw.js\0' });
    assert.equal(r.category, 'code');
    assert.equal(r.code[0].path, 'public/sw.js');
});

test('classifyDivergence: dependency manifests are dependency (hub allowScripts)', () => {
    const r = classifyDivergence({
        nameStatusZ: 'M\0package.json\0M\0package-lock.json\0',
        packages: [], // allowScripts is a config block, not a version change
    });
    assert.equal(r.category, 'dependency');
    assert.deepEqual(r.dependency, ['package.json', 'package-lock.json']);
});

test('classifyDivergence: dependency carries named package versions', () => {
    const packages = diffDependencyVersions(
        { dependencies: { '@openai/codex-sdk': '0.153.2' } },
        { dependencies: { '@openai/codex-sdk': '0.153.4' } },
    );
    const r = classifyDivergence({ nameStatusZ: 'M\0package.json\0M\0package-lock.json\0', packages });
    assert.equal(r.category, 'dependency');
    assert.deepEqual(r.packages, [{ name: '@openai/codex-sdk', from: '0.153.2', to: '0.153.4' }]);
});

test('classifyDivergence: added .gitignore lines are overlayable (E2), deletions are code', () => {
    const added = classifyDivergence({ nameStatusZ: 'M\0.gitignore\0', gitignoreAddedOnly: true });
    assert.equal(added.category, 'overlayable');
    assert.equal(added.overlayable[0].target, 'E2');

    const deleted = classifyDivergence({ nameStatusZ: 'M\0.gitignore\0', gitignoreAddedOnly: false });
    assert.equal(deleted.category, 'code');
    assert.equal(deleted.code[0].reason, 'gitignore-deletion-or-modification');
});

test('classifyDivergence: freshly added .gitignore counts as overlayable', () => {
    const r = classifyDivergence({ nameStatusZ: 'A\0.gitignore\0' });
    assert.equal(r.category, 'overlayable');
});

// --- classifyDivergence: precedence --------------------------------------

test('classifyDivergence: precedence code > dependency > overlayable', () => {
    // A hub-shaped mix: overlayable hub, added .gitignore, dependency bump,
    // and one modified tracked file -> the dominant category is code.
    const r = classifyDivergence({
        nameStatusZ: [
            'A', 'public/hub/index.html',
            'M', '.gitignore',
            'M', 'package.json',
            'M', 'server/index.js',
        ].join('\0') + '\0',
        gitignoreAddedOnly: true,
    });
    assert.equal(r.category, 'code');
    assert.equal(r.overlayable.length, 2); // hub file + added .gitignore
    assert.equal(r.dependency.length, 1);
    assert.equal(r.code.length, 1);

    // Remove the code path: dependency dominates overlayable.
    const r2 = classifyDivergence({
        nameStatusZ: ['A', 'public/hub/index.html', 'M', 'package.json'].join('\0') + '\0',
    });
    assert.equal(r2.category, 'dependency');

    // Only overlayable remains.
    const r3 = classifyDivergence({ nameStatusZ: 'A\0public/hub/index.html\0' });
    assert.equal(r3.category, 'overlayable');

    // Nothing changed.
    assert.equal(classifyDivergence({ nameStatusZ: '' }).category, 'none');
});

test('classifyDivergence: an arbitrary source path is code', () => {
    const r = classifyDivergence({ nameStatusZ: 'M\0src/App.tsx\0' });
    assert.equal(r.category, 'code');
    assert.equal(r.code[0].reason, 'code');
});
