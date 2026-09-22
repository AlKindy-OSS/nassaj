/**
 * ADR-156 / T-1730 W3 — E1: the owner-sealed static overlay service.
 *
 * Serves a node operator's static files (e.g. its `/hub` links page)
 * WITHOUT ever writing a byte to a tracked path or a generation. It is mounted
 * right before `express.static(dist)` and after every `/api` route (contract
 * §3.1 C1), so it runs before `authenticateToken`, under the same service
 * account as the session agents. Its whole security model is therefore "serve
 * only owner-sealed bytes, proven at read time":
 *
 *   1. Files are served only if listed in an owner-sealed manifest
 *      (`config/node-overlay.lock.json`) that is owned by root / not writable by
 *      the service account. A service-owned manifest disables the overlay.
 *   2. Each file is opened relative to a directory descriptor pinned at boot,
 *      walking every path segment with `O_NOFOLLOW` (Node has no `openat2`
 *      binding; this is the contract's documented per-segment `openat +
 *      O_NOFOLLOW` fallback, and it rejects a symlink swapped into an
 *      INTERMEDIATE directory, not only the final component — TOCTOU, qa 2).
 *   3. The sha256 is computed over the bytes read from that SAME descriptor and
 *      matched against the manifest — never a re-opened path. Any mismatch,
 *      unsealed file, or symlink is a 404 (not 403 — do not leak existence).
 *   4. An enforced strict CSP (`sandbox … ; connect-src 'none'`) plus
 *      `Access-Control-Allow-Origin: *` (so the opaque-origin page's fonts and
 *      module scripts load) and `X-Content-Type-Options: nosniff`.
 *   5. A corrupt config or manifest disables the overlay and logs
 *      `node_overlay_invalid`; the server still boots. The overlay is decoration,
 *      not a boot requirement (contract §3.1 point 8).
 */
import fs from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { parseNodeOverlay, verifySealedFile } from '../../scripts/lib/node-overlay.mjs';

/** Enforced strict CSP for E1 responses (contract §3.1 C1.4). Not Report-Only. */
export const OVERLAY_CSP = [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    "default-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
].join('; ');

/** Allowed file extensions and their content types (contract §3.1 C1.3). */
const CONTENT_TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.ico', 'image/x-icon'],
    ['.txt', 'text/plain; charset=utf-8'],
]);

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per file (contract §3.1 C1.3).
const NODE_OVERLAY_INVALID = 'node_overlay_invalid';

/** Descriptor-relative child path — Linux's openat-equivalent for Node (see legacy-mcp-cleanup). */
function descriptorChild(fd, name) {
    return `/proc/self/fd/${fd}/${name}`;
}

/** Secure default: the service account must NOT be able to rewrite the manifest. */
function defaultManifestOwnershipOk(stat, euid) {
    // Owner is not the service account, and no group/other write bit (contract §3.1 C1.1,
    // root:root 0644). This is exactly the "not writable by the service account" invariant.
    return stat.uid !== euid && (stat.mode & 0o022) === 0;
}

/**
 * The same invariant applied to a DIRECTORY the service must not be able to
 * rewrite (E1, qa-critic). Sealing the manifest file alone is not enough: if the
 * service account can write in the containing directory (`config/`) it can
 * `rename` the root-owned manifest aside and drop its own in its place, and the
 * file-only ownership check passes over a fully forgeable seal. The same holds
 * for `config/overlay/` and every mounted dir — a writable parent lets the
 * service swap a sealed file's directory for one it controls. Fails closed: an
 * unreadable or non-directory path is "not ok".
 */
function directoryOwnershipOk(dirPath, euid, verify) {
    let stat;
    try { stat = fs.statSync(dirPath); } catch { return false; }
    return stat.isDirectory() && verify(stat, euid);
}

/** Parse and validate the seal manifest: `{ files: { "<relpath>": { sha256, size } } }`. */
function parseSealManifest(text) {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('seal manifest must be a JSON object');
    }
    const files = parsed.files;
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
        throw new Error('seal manifest "files" must be an object');
    }
    for (const [key, entry] of Object.entries(files)) {
        if (entry === null || typeof entry !== 'object'
            || typeof entry.sha256 !== 'string' || !Number.isInteger(entry.size)) {
            throw new Error(`seal manifest entry "${key}" is malformed`);
        }
    }
    return files;
}

/** Reject a request subpath with traversal, NUL, dotfiles, or an empty segment. */
function safeRequestComponents(subpath) {
    // Express has already URL-decoded req.path.
    if (subpath.includes('\0')) return null;
    let rel = subpath.replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html'; // directory index (no listing)
    const components = rel.split('/');
    for (const c of components) {
        if (c === '' || c === '.' || c === '..') return null;
        if (c.startsWith('.')) return null; // dotfiles: deny
    }
    return components;
}

/**
 * Open a file beneath the pinned overlay-root descriptor, walking every segment
 * with O_NOFOLLOW so an intermediate-directory symlink swap is rejected. Reads
 * and digests the bytes from the returned descriptor. Returns null (=> 404) on
 * any symlink, missing file, non-regular file, over-size file, or error.
 */
async function readSealedBeneath(rootFd, relComponents, maxBytes) {
    const dirComponents = relComponents.slice(0, -1);
    const finalName = relComponents[relComponents.length - 1];
    const opened = [];
    try {
        let parentFd = rootFd;
        for (const component of dirComponents) {
            let handle;
            try {
                handle = await open(
                    descriptorChild(parentFd, component),
                    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
                );
            } catch {
                return null; // ENOENT, ELOOP (symlinked intermediate dir), ENOTDIR, …
            }
            opened.push(handle);
            parentFd = handle.fd;
        }
        let fileHandle;
        try {
            fileHandle = await open(
                descriptorChild(parentFd, finalName),
                fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
            );
        } catch {
            return null; // final symlink (ELOOP) or missing
        }
        opened.push(fileHandle);
        const stat = await fileHandle.stat();
        if (!stat.isFile()) return null;
        if (stat.size > maxBytes) return null;
        const buffer = await fileHandle.readFile();
        return { buffer };
    } finally {
        await Promise.allSettled(opened.map((h) => h.close()));
    }
}

/**
 * Mount the sealed static overlay onto an Express app. Synchronous: reads and
 * validates the config and manifest and pins the root descriptor at boot.
 *
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} options.configDir directory holding node-overlay.json, the lock, and overlay/
 * @param {{ warn: Function, info?: Function }} [options.logger]
 * @param {number} [options.maxFileBytes]
 * @param {(stat: fs.Stats, euid: number) => boolean} [options.verifyManifestOwnership] applied to the manifest AND to config/, config/overlay/ and every mount dir (E1)
 * @param {number} [options.euid] effective uid (injectable for tests)
 * @param {(reason: string, detail: object) => void} [options.onInvalid]
 * @returns {{ enabled: boolean, reason: string, mounts: string[], close: () => void }}
 */
export function mountNodeOverlay(app, options = {}) {
    const {
        configDir,
        logger = console,
        maxFileBytes = DEFAULT_MAX_FILE_BYTES,
        verifyManifestOwnership = defaultManifestOwnershipOk,
        euid = typeof process.geteuid === 'function' ? process.geteuid() : -1,
        onInvalid,
    } = options;

    const configPath = path.join(configDir, 'node-overlay.json');
    const lockPath = path.join(configDir, 'node-overlay.lock.json');
    const overlayRoot = path.join(configDir, 'overlay');

    const disabled = (reason, detail) => {
        if (reason === NODE_OVERLAY_INVALID) {
            logger.warn?.(`[node-overlay] ${NODE_OVERLAY_INVALID}`, detail);
            onInvalid?.(NODE_OVERLAY_INVALID, detail || {});
        }
        return { enabled: false, reason, mounts: [], close: () => {} };
    };

    // Absent config => overlay simply off, no error (it is optional).
    if (!fs.existsSync(configPath)) return { enabled: false, reason: 'absent', mounts: [], close: () => {} };

    let config;
    try {
        config = parseNodeOverlay(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        return disabled(NODE_OVERLAY_INVALID, { field: err.field || 'config', message: err.message });
    }
    if (config.static.length === 0) return { enabled: false, reason: 'empty', mounts: [], close: () => {} };

    // The manifest's containing directory (config/) must itself be un-writable by
    // the service account, or the file-only ownership check below is defeated by a
    // rename in a writable config/ (E1, qa-critic).
    if (!directoryOwnershipOk(configDir, euid, verifyManifestOwnership)) {
        return disabled(NODE_OVERLAY_INVALID, { field: 'configDir', message: 'config directory is writable by the service account' });
    }

    // Manifest: must exist, parse, and be un-writable by the service account.
    let manifest;
    try {
        const lockStat = fs.statSync(lockPath);
        if (!verifyManifestOwnership(lockStat, euid)) {
            return disabled(NODE_OVERLAY_INVALID, { field: 'lock', message: 'seal manifest is writable by the service account' });
        }
        manifest = parseSealManifest(fs.readFileSync(lockPath, 'utf8'));
    } catch (err) {
        return disabled(NODE_OVERLAY_INVALID, { field: 'lock', message: err.message });
    }

    // Resolve every mount dir with realpath and keep it inside overlayRoot.
    const realOverlayRoot = fs.realpathSync(overlayRoot);
    // config/overlay/ must be un-writable by the service account too, for the same
    // reason as config/ above (E1, qa-critic).
    if (!directoryOwnershipOk(realOverlayRoot, euid, verifyManifestOwnership)) {
        return disabled(NODE_OVERLAY_INVALID, { field: 'overlay', message: 'config/overlay is writable by the service account' });
    }
    const mountDirs = new Map();
    for (const { mount, dir } of config.static) {
        let realDir;
        try {
            realDir = fs.realpathSync(path.join(overlayRoot, dir));
        } catch (err) {
            return disabled(NODE_OVERLAY_INVALID, { field: `static.${mount}.dir`, message: `dir not found: ${err.message}` });
        }
        if (realDir !== realOverlayRoot && !realDir.startsWith(`${realOverlayRoot}${path.sep}`)) {
            return disabled(NODE_OVERLAY_INVALID, { field: `static.${mount}.dir`, message: 'dir escapes config/overlay/' });
        }
        // Every mounted directory must be un-writable by the service account as well
        // (E1, qa-critic): a writable mount dir lets the service swap a sealed file.
        if (!directoryOwnershipOk(realDir, euid, verifyManifestOwnership)) {
            return disabled(NODE_OVERLAY_INVALID, { field: `static.${mount}.dir`, message: 'mount directory is writable by the service account' });
        }
        mountDirs.set(mount, dir);
    }

    // Pin the overlay-root directory descriptor at boot (contract §3.1 C1.2).
    let rootFd;
    try {
        rootFd = fs.openSync(overlayRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    } catch (err) {
        return disabled(NODE_OVERLAY_INVALID, { field: 'overlay', message: `cannot pin overlay root: ${err.message}` });
    }

    const handler = (mount, dir) => async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).end();

        const components = safeRequestComponents(req.path || '/');
        if (components === null) return res.status(404).end();

        const ext = path.extname(components[components.length - 1]).toLowerCase();
        const contentType = CONTENT_TYPES.get(ext);
        if (!contentType) return res.status(404).end();

        // relative-to-overlay-root path is `<dir>/<components…>`; also the manifest key.
        const relComponents = [...dir.split('/').filter(Boolean), ...components];
        const manifestKey = relComponents.join('/');
        const entry = manifest[manifestKey];
        if (!entry) return res.status(404).end();

        let result;
        try {
            result = await readSealedBeneath(rootFd, relComponents, maxFileBytes);
        } catch {
            return res.status(404).end();
        }
        if (!result) return res.status(404).end();

        // Digest the SAME bytes we will send; match the seal. No re-open by path.
        if (!verifySealedFile(result.buffer, entry)) return res.status(404).end();

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Security-Policy', OVERLAY_CSP);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Length', String(result.buffer.length));
        if (req.method === 'HEAD') return res.status(200).end();
        return res.status(200).end(result.buffer);
    };

    for (const [mount, dir] of mountDirs) {
        app.use(mount, handler(mount, dir));
    }

    logger.info?.(`[node-overlay] enabled`, { mounts: [...mountDirs.keys()] });
    return {
        enabled: true,
        reason: 'ok',
        mounts: [...mountDirs.keys()],
        close: () => { try { fs.closeSync(rootFd); } catch { /* already closed */ } },
    };
}
