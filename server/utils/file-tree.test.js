import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import {
    FILE_TREE_TOO_LARGE,
    MAX_FILE_TREE_ENTRIES,
    buildProjectFileTreeResponse,
    createFileTreeBudget,
    getFileTree,
} from './file-tree.js';

// T-1896: entry cap shared across branches, streamed reads, no descent into
// absolute system directories. Fixtures live under /var/tmp (never tmpfs).
const fixtureRoot = fs.mkdtempSync(path.join('/var/tmp', 't1896-tree-'));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function makeFiles(dir, count, prefix = 'f') {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) fs.writeFileSync(path.join(dir, `${prefix}${i}`), '');
}

function countItems(items) {
    return items.reduce((sum, item) => sum + 1 + (item.children ? countItems(item.children) : 0), 0);
}

const exactDir = path.join(fixtureRoot, 'exact');
const overDir = path.join(fixtureRoot, 'over');
makeFiles(exactDir, MAX_FILE_TREE_ENTRIES);
makeFiles(overDir, MAX_FILE_TREE_ENTRIES + 1);

test('exactly MAX_FILE_TREE_ENTRIES entries returns 200 with the full tree', async () => {
    const { status, body } = await buildProjectFileTreeResponse(exactDir);
    assert.equal(status, 200);
    assert.equal(body.length, MAX_FILE_TREE_ENTRIES);
});

test('MAX_FILE_TREE_ENTRIES + 1 entries returns the fixed 413 contract', async () => {
    const { status, body } = await buildProjectFileTreeResponse(overDir);
    assert.equal(status, 413);
    assert.deepEqual(body, {
        error: 'Project file tree is too large to display',
        code: FILE_TREE_TOO_LARGE,
        limit: MAX_FILE_TREE_ENTRIES,
    });
});

test('the budget is shared across sibling branches', async () => {
    const dir = path.join(fixtureRoot, 'branches');
    makeFiles(path.join(dir, 'a'), 3);
    makeFiles(path.join(dir, 'b'), 3);
    // 2 directories + 6 files = 8 entries.
    const ok = await buildProjectFileTreeResponse(dir, 8);
    assert.equal(ok.status, 200);
    assert.equal(countItems(ok.body), 8);
    const tooLarge = await buildProjectFileTreeResponse(dir, 7);
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.limit, 7);
});

test('ignored directories such as node_modules are not counted', async () => {
    const dir = path.join(fixtureRoot, 'ignored');
    makeFiles(path.join(dir, 'node_modules', 'pkg'), 50);
    makeFiles(dir, 2, 'src');
    const budget = createFileTreeBudget(2);
    const items = await getFileTree(dir, 10, 0, true, budget);
    assert.deepEqual(items.map((item) => item.name).sort(), ['src0', 'src1']);
    assert.equal(budget.value, 2);
});

test('an exhausted budget stops later directory reads', async () => {
    const budget = createFileTreeBudget(1);
    budget.value = 2;
    budget.exhausted = true;
    await assert.rejects(getFileTree(exactDir, 1, 0, true, budget), { code: FILE_TREE_TOO_LARGE });
});

test('absolute system directories are listed but not descended into', async () => {
    const items = await getFileTree('/', 1, 0, false);
    const proc = items.find((item) => item.path === '/proc');
    assert.ok(proc, '/proc should be listed');
    assert.equal(proc.children, undefined);
    const etc = items.find((item) => item.path === '/etc');
    assert.equal(etc?.children, undefined);
});

test('a relative proc directory inside a project is descended normally', async () => {
    const dir = path.join(fixtureRoot, 'project-with-proc');
    makeFiles(path.join(dir, 'proc'), 2);
    const items = await getFileTree(dir, 10, 0, true, createFileTreeBudget());
    const proc = items.find((item) => item.name === 'proc');
    assert.equal(proc?.children?.length, 2);
});

test('folder suggestions (no budget) are not capped', async () => {
    const items = await getFileTree(overDir, 1, 0, false);
    assert.equal(items.length, MAX_FILE_TREE_ENTRIES + 1);
});
