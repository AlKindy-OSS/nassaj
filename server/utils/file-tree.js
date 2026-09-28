/**
 * Project file-tree builder for GET /api/projects/:projectId/files (T-1896).
 *
 * Extracted from server/index.js so the traversal safeguards are unit-testable:
 * - an optional entry budget shared across every branch of one traversal, so a
 *   huge tree fails fast with FILE_TREE_TOO_LARGE instead of exhausting memory;
 * - streamed directory reads (opendir + early break) so an oversized directory
 *   is never read in full once the budget is spent;
 * - no descent into absolute system-critical directories (e.g. `/proc`).
 */

import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { AppError, FORBIDDEN_WORKSPACE_PATHS, normalizeProjectPath } from '@/shared/utils.js';

/** Maximum entries one project file-tree response may contain. */
export const MAX_FILE_TREE_ENTRIES = 10_000;

/** Error code the files route maps to HTTP 413 (frontend contract). */
export const FILE_TREE_TOO_LARGE = 'FILE_TREE_TOO_LARGE';

// Directories that are almost never interesting for a project tree but can
// contain tens of thousands of files. Skipping them before recursion keeps
// traversal time bounded on large monorepos and high-latency filesystems
// (NFS / SMB). Skipped entries do not count against the entry budget.
const IGNORED_DIRS = new Set([
    // JS / TS toolchains
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
    // VCS
    '.git', '.svn', '.hg',
    // Python
    '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
    // Rust / Go / Java / Ruby
    'target', 'vendor',
    // Build output / IDE
    '.gradle', '.idea', 'coverage', '.nyc_output'
]);

const FORBIDDEN_DESCENT_PATHS = new Set(FORBIDDEN_WORKSPACE_PATHS.map((entry) => normalizeProjectPath(entry)));

const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
    ? parsedFsConcurrency
    : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations = [];

async function acquire() {
    if (activeFsOperations < FS_CONCURRENCY) {
        activeFsOperations += 1;
        return;
    }

    await new Promise((resolve) => {
        pendingFsOperations.push(resolve);
    });
}

function release() {
    const next = pendingFsOperations.shift();
    if (next) {
        next();
        return;
    }

    activeFsOperations = Math.max(0, activeFsOperations - 1);
}

function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

/**
 * Creates an entry budget shared by every branch of one traversal.
 *
 * @param {number} [limit=MAX_FILE_TREE_ENTRIES]
 * @returns {{ value: number, limit: number, exhausted: boolean }}
 */
export function createFileTreeBudget(limit = MAX_FILE_TREE_ENTRIES) {
    return { value: 0, limit, exhausted: false };
}

function fileTreeTooLargeError(limit) {
    return new AppError(`File tree exceeds ${limit} entries`, {
        code: FILE_TREE_TOO_LARGE,
        statusCode: 413,
        details: { limit },
    });
}

/** Counts one entry; marks the shared budget exhausted and throws past the limit. */
function consumeBudget(budget) {
    if (!budget) return;
    budget.value += 1;
    if (budget.value > budget.limit) {
        budget.exhausted = true;
        throw fileTreeTooLargeError(budget.limit);
    }
}

/** Streams the non-ignored entries of one directory, charging each to the budget. */
async function readDirectoryEntries(dirPath, budget) {
    if (budget?.exhausted) throw fileTreeTooLargeError(budget.limit);
    const entries = [];
    await acquire();
    try {
        const dir = await fsPromises.opendir(dirPath);
        for await (const entry of dir) {
            if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
            consumeBudget(budget);
            entries.push(entry);
        }
    } finally {
        release();
    }
    return entries;
}

/** Adds lstat-derived metadata (size, mtime, symlink flag, permissions) to an item. */
async function describeItem(item) {
    try {
        await acquire();
        try {
            const stats = await fsPromises.lstat(item.path);
            const mode = stats.mode;
            item.size = stats.size;
            item.modified = stats.mtime.toISOString();
            if (stats.isSymbolicLink()) item.isSymlink = true;
            item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
            item.permissionsRwx = permToRwx((mode >> 6) & 7) + permToRwx((mode >> 3) & 7) + permToRwx(mode & 7);
        } finally {
            release();
        }
    } catch {
        item.size = 0;
        item.modified = null;
        item.permissions = '000';
        item.permissionsRwx = '---------';
    }
}

/**
 * Builds a sorted file tree (directories first) rooted at `dirPath`.
 *
 * Unreadable directories yield `[]`. When `budget` is given, the traversal
 * throws an AppError with code FILE_TREE_TOO_LARGE (statusCode 413,
 * details.limit) as soon as the shared entry count exceeds `budget.limit`.
 * Children whose absolute path is a system-critical directory are listed but
 * never descended into; the root itself is not checked.
 *
 * @param {string} dirPath
 * @param {number} [maxDepth=3]
 * @param {number} [currentDepth=0]
 * @param {boolean} [showHidden=true] Kept for call-site compatibility (unused).
 * @param {{ value: number, limit: number, exhausted: boolean } | null} [budget=null]
 * @returns {Promise<Array<object>>}
 */
export async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true, budget = null) {
    let entries;
    try {
        entries = await readDirectoryEntries(dirPath, budget);
    } catch (error) {
        if (error?.code === FILE_TREE_TOO_LARGE) throw error;
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
        return [];
    }

    // Parallel per-entry work lets high-latency filesystems pipeline round-trips.
    const items = await Promise.all(entries.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item = { name: entry.name, path: itemPath, type: entry.isDirectory() ? 'directory' : 'file' };
        await describeItem(item);

        const descend = entry.isDirectory()
            && currentDepth < maxDepth
            && !FORBIDDEN_DESCENT_PATHS.has(normalizeProjectPath(itemPath));
        if (descend) {
            // The recursive call takes its own bounded permit; holding one for the
            // whole subtree could deadlock sibling directories.
            item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden, budget);
        }
        return item;
    }));

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

/** Depth the project files route walks (unchanged from the pre-T-1896 route). */
const PROJECT_FILE_TREE_DEPTH = 10;

/**
 * Builds the HTTP response for GET /api/projects/:projectId/files.
 *
 * Returns `200` with the tree, or `413 { error, code: 'FILE_TREE_TOO_LARGE',
 * limit }` when the project exceeds the entry budget (fixed frontend contract).
 * Any other error propagates to the route's generic handler.
 *
 * @param {string} projectPath Existing project root.
 * @param {number} [limit=MAX_FILE_TREE_ENTRIES]
 * @returns {Promise<{ status: number, body: unknown }>}
 */
export async function buildProjectFileTreeResponse(projectPath, limit = MAX_FILE_TREE_ENTRIES) {
    try {
        const files = await getFileTree(projectPath, PROJECT_FILE_TREE_DEPTH, 0, true, createFileTreeBudget(limit));
        return { status: 200, body: files };
    } catch (error) {
        if (error?.code !== FILE_TREE_TOO_LARGE) throw error;
        return {
            status: 413,
            body: { error: 'Project file tree is too large to display', code: FILE_TREE_TOO_LARGE, limit },
        };
    }
}
