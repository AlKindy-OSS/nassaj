import assert from 'node:assert/strict';
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { buildProjectFileTreeResponse, FILE_TREE_TOO_LARGE } from './file-tree.js';
import { buildPartialProjectFileTreeResponse } from './file-tree-partial.js';

// B-1669: the @-mention list and the palette ask for ?partial=1, which is always
// 200, deterministic, lean and favours real project files. Fixtures live under
// /var/tmp (never tmpfs).
const fixtureRoot = fs.mkdtempSync(path.join('/var/tmp', 'b1669-partial-tree-'));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function makeFiles(dir, count, prefix = 'f') {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) fs.writeFileSync(path.join(dir, `${prefix}${i}`), '');
}

function countItems(items) {
    return items.reduce((sum, item) => sum + 1 + (item.children ? countItems(item.children) : 0), 0);
}

function relativeFiles(items, base = '') {
    return items.flatMap((item) => {
        const rel = base ? `${base}/${item.name}` : item.name;
        return item.type === 'file' ? [rel] : relativeFiles(item.children ?? [], rel);
    });
}

function fixture(name, build) {
    const dir = path.join(fixtureRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    build(dir);
    return dir;
}

const nested = fixture('nested', (dir) => {
    makeFiles(path.join(dir, 'a'), 5);
    makeFiles(path.join(dir, 'b', 'c'), 5);
    makeFiles(path.join(dir, 'd'), 10);
});

test('partial mode over the limit: 200, at most `limit` nodes in total, truncated', async () => {
    const response = await buildPartialProjectFileTreeResponse(nested, 5);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body));
    assert.ok(countItems(response.body) <= 5, `nodes: ${countItems(response.body)}`);
    assert.equal(response.truncated, true);
});

test('partial mode under the limit: the full tree, not truncated, lean nodes', async () => {
    const response = await buildPartialProjectFileTreeResponse(nested, 100);
    assert.equal(response.truncated, false);
    assert.equal(countItems(response.body), 4 + 20);
    assert.equal(relativeFiles(response.body).length, 20);
    const file = response.body.find((item) => item.name === 'a').children[0];
    assert.deepEqual(Object.keys(file).sort(), ['name', 'path', 'type']);
    assert.equal(file.path, path.join(nested, 'a', file.name));
});

test('the non-partial contract still answers 413 past the limit', async () => {
    const response = await buildProjectFileTreeResponse(nested, 5);
    assert.equal(response.status, 413);
    assert.equal(response.body.code, FILE_TREE_TOO_LARGE);
    assert.equal(response.body.limit, 5);
});

test('the same tree gives the same truncated answer every time', async () => {
    const first = await buildPartialProjectFileTreeResponse(nested, 7);
    for (let i = 0; i < 5; i += 1) {
        assert.deepEqual((await buildPartialProjectFileTreeResponse(nested, 7)).body, first.body);
    }
});

test('shallow files win over a deep large subtree', async () => {
    const dir = fixture('shallow', (root) => {
        makeFiles(path.join(root, 'aaa', 'deep', 'deeper'), 40);
        fs.writeFileSync(path.join(root, 'zz-top.txt'), '');
    });
    const files = relativeFiles((await buildPartialProjectFileTreeResponse(dir, 6)).body);
    assert.ok(files.includes('zz-top.txt'), JSON.stringify(files));
});

test('a hidden directory does not push out src/', async () => {
    const dir = fixture('hidden', (root) => {
        makeFiles(path.join(root, '.artifacts', 'run'), 50);
        makeFiles(path.join(root, 'src', 'lib'), 3);
        fs.writeFileSync(path.join(root, '.env'), '');
    });
    const { body } = await buildPartialProjectFileTreeResponse(dir, 12);
    const files = relativeFiles(body);
    for (const name of ['src/lib/f0', 'src/lib/f1', 'src/lib/f2', '.env']) assert.ok(files.includes(name), name);
    assert.equal(body.find((item) => item.name === '.env').secretFile, true);
});

test('ignored directories are skipped', async () => {
    const dir = fixture('ignored', (root) => {
        makeFiles(path.join(root, 'node_modules', 'pkg'), 5);
        fs.writeFileSync(path.join(root, 'index.js'), '');
    });
    assert.deepEqual(relativeFiles((await buildPartialProjectFileTreeResponse(dir, 50)).body), ['index.js']);
});

test('the walk stops reading directories once the budget is spent', async (t) => {
    const dir = fixture('budget', (root) => {
        for (let i = 0; i < 30; i += 1) makeFiles(path.join(root, `d${String(i).padStart(2, '0')}`), 3);
    });
    const opendir = t.mock.method(fsPromises, 'opendir');
    await buildPartialProjectFileTreeResponse(dir, 4);
    assert.ok(opendir.mock.callCount() <= 2, `opendir calls: ${opendir.mock.callCount()}`);
    mock.restoreAll();
});
