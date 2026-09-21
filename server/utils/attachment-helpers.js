/**
 * Pure helpers for the attachment upload feature.
 *
 * Extracted from POST /api/projects/:projectId/upload-attachments in index.js
 * so they can be unit-tested without importing the full server (express/DB/etc).
 *
 * No side effects. No I/O. No imports beyond node:path.
 */

import path from 'node:path';

/**
 * Sanitise an uploaded filename for attachment storage.
 *
 * Steps:
 *  1. Strip any directory component via path.basename (neutralises traversal).
 *  2. Replace every character outside [a-zA-Z0-9._-] with an underscore.
 *
 * Returns the sanitised string. The caller must still check /^\.+$/ on the
 * result and reject all-dots outcomes (handled by the route handler).
 *
 * @param {string|undefined} originalname - Raw filename from the browser / multer object.
 * @returns {string}
 */
export function sanitizeAttachmentName(originalname) {
    return path.basename(originalname || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Decide the collision-free destination filename inside an inbox directory.
 *
 * Pure: receives an existsFn predicate so it never touches the filesystem itself.
 * Production code passes `(p) => { try { fs.accessSync(p); return true; } catch { return false; } }`.
 * Tests pass a controlled stub.
 *
 * @param {string}   dir    - Absolute inbox directory path.
 * @param {string}   name   - Already-sanitised filename (output of sanitizeAttachmentName).
 * @param {(p: string) => boolean} existsFn - Synchronous existence predicate.
 * @param {string}  [_randomSuffixOverride] - For testing: fixed hex suffix (skips Math.random).
 * @returns {{ destPath: string, collision: boolean }}
 */
export function resolveCollisionFreeDest(dir, name, existsFn, _randomSuffixOverride) {
    const firstTry = path.join(dir, name);
    if (!existsFn(firstTry)) {
        return { destPath: firstTry, collision: false };
    }
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    const suffix = _randomSuffixOverride !== undefined
        ? _randomSuffixOverride
        : Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
    return { destPath: path.join(dir, `${base}-${suffix}${ext}`), collision: true };
}
