/**
 * Partial project file listing for GET /api/projects/:projectId/files?partial=1
 * (B-1669).
 *
 * The full tree (file-tree.js) answers 413 past MAX_FILE_TREE_ENTRIES, and the
 * file panel depends on that. The @-mention list and the command palette only
 * need paths, so on a large repository they ask for this listing instead:
 *  - deterministic: the same tree gives the same answer (sorted, sequential, no
 *    parallel race for the budget);
 *  - real project files first: a sorted breadth-first walk lists shallow
 *    entries before deep ones, and every non-hidden directory before any hidden
 *    (dot) directory, where tool output such as .artifacts usually lives. It
 *    launches no process (no git), so it adds no permission-inventory site;
 *  - lean: nodes carry name/path/type only (no lstat metadata). At the default
 *    cap of 10,000 nodes with absolute paths the body stays around 2 MB.
 * The same ignored directories and depth as the full tree apply.
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { isSecretFileKind } from '@/shared/secret-path-guard.js';

import {
    MAX_FILE_TREE_ENTRIES,
    PROJECT_FILE_TREE_DEPTH,
    compareTreeItems,
    isForbiddenDescentPath,
    isIgnoredDirectoryName,
} from './file-tree.js';

/** Path segments an entry may have: the full tree lists PROJECT_FILE_TREE_DEPTH + 1 levels. */
const MAX_SEGMENTS = PROJECT_FILE_TREE_DEPTH + 1;

const isHiddenName = (name) => name.startsWith('.');

/** Up to `cap` non-ignored children of one directory, sorted; [] when unreadable. */
async function readSortedChildren(dirPath, cap) {
    const children = [];
    try {
        const dir = await fsPromises.opendir(dirPath);
        for await (const entry of dir) {
            const isDirectory = entry.isDirectory();
            if (isDirectory && isIgnoredDirectoryName(entry.name)) continue;
            children.push({ name: entry.name, type: isDirectory ? 'directory' : 'file' });
            if (children.length >= cap) break;
        }
    } catch {
        return [];
    }
    return children.sort((a, b) => (isHiddenName(a.name) - isHiddenName(b.name)) || compareTreeItems(a, b));
}

/**
 * Lists one directory into `entries` (up to `cap`) and queues its descendable
 * subdirectories on `queues.next`, or on `queues.deferred` for hidden ones.
 */
async function expandDirectory(projectPath, parent, entries, cap, queues) {
    const children = await readSortedChildren(path.join(projectPath, parent.relativePath), cap - entries.length);
    const depth = parent.depth + 1;
    for (const child of children) {
        const relativePath = parent.relativePath ? `${parent.relativePath}/${child.name}` : child.name;
        entries.push({ relativePath, type: child.type });
        const descend = child.type === 'directory' && depth < MAX_SEGMENTS
            && !isForbiddenDescentPath(path.join(projectPath, relativePath));
        if (!descend) continue;
        const queue = queues.deferred && isHiddenName(child.name) ? queues.deferred : queues.next;
        queue.push({ relativePath, depth });
    }
}

/**
 * Breadth-first walk from `start` appending to `entries` until `cap`. With
 * `deferHidden`, hidden subdirectories are returned unopened so the caller
 * walks them after everything else.
 */
async function walkLevels(projectPath, start, entries, cap, deferHidden) {
    const deferred = deferHidden ? [] : null;
    let level = start;
    while (level.length > 0 && entries.length < cap) {
        const queues = { next: [], deferred };
        for (const parent of level) {
            if (entries.length >= cap) break;
            await expandDirectory(projectPath, parent, entries, cap, queues);
        }
        level = queues.next;
    }
    return deferred ?? [];
}

/** Ordered entries from a deterministic walk: at most `cap`, parents before children. */
async function listWalkEntries(projectPath, cap) {
    const entries = [];
    const hidden = await walkLevels(projectPath, [{ relativePath: '', depth: 0 }], entries, cap, true);
    for (const dir of hidden) {
        if (entries.length >= cap) break;
        await walkLevels(projectPath, [dir], entries, cap, false);
    }
    return entries;
}

/** Returns the children array for `relativePath`, creating missing ancestors (counted in `added`). */
function ensureDirectory(projectPath, nodes, relativePath, added) {
    const existing = nodes.get(relativePath);
    if (existing) return existing;
    const slash = relativePath.lastIndexOf('/');
    const siblings = ensureDirectory(projectPath, nodes, slash === -1 ? '' : relativePath.slice(0, slash), added);
    const children = [];
    siblings.push({ name: relativePath.slice(slash + 1), path: path.join(projectPath, relativePath), type: 'directory', children });
    nodes.set(relativePath, children);
    added.count += 1;
    return children;
}

function sortTree(items) {
    items.sort(compareTreeItems);
    for (const item of items) if (item.children) sortTree(item.children);
    return items;
}

/** Number of nodes adding `relativePath` creates: itself plus its missing ancestors. */
function nodeCost(nodes, relativePath) {
    let cost = nodes.has(relativePath) ? 0 : 1;
    for (let slash = relativePath.lastIndexOf('/'); slash > 0; slash = relativePath.lastIndexOf('/', slash - 1)) {
        if (nodes.has(relativePath.slice(0, slash))) break;
        cost += 1;
    }
    return cost;
}

function fileNode(projectPath, relativePath) {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    const node = { name, path: path.join(projectPath, relativePath), type: 'file' };
    // B-1593 parity with the full tree: opening it asks for confirmation.
    if (isSecretFileKind(name)) node.secretFile = true;
    return node;
}

/** Builds the nested tree from ordered entries, stopping before `limit` nodes are exceeded. */
function buildLimitedTree(projectPath, entries, limit) {
    const root = [];
    const nodes = new Map([['', root]]);
    const added = { count: 0 };
    for (const { relativePath, type } of entries) {
        if (added.count + nodeCost(nodes, relativePath) > limit) return { files: sortTree(root), truncated: true };
        if (type === 'directory') {
            ensureDirectory(projectPath, nodes, relativePath, added);
            continue;
        }
        const slash = relativePath.lastIndexOf('/');
        ensureDirectory(projectPath, nodes, slash === -1 ? '' : relativePath.slice(0, slash), added)
            .push(fileNode(projectPath, relativePath));
        added.count += 1;
    }
    return { files: sortTree(root), truncated: false };
}

/**
 * Builds the partial listing response: always `200` with an array tree of at
 * most `limit` nodes; `truncated` is true when entries were left out.
 *
 * @param {string} projectPath Existing project root.
 * @param {number} [limit=MAX_FILE_TREE_ENTRIES]
 * @returns {Promise<{ status: 200, body: Array<object>, truncated: boolean }>}
 */
export async function buildPartialProjectFileTreeResponse(projectPath, limit = MAX_FILE_TREE_ENTRIES) {
    const entries = await listWalkEntries(projectPath, limit + 1);
    const { files, truncated } = buildLimitedTree(projectPath, entries, limit);
    return { status: 200, body: files, truncated };
}
