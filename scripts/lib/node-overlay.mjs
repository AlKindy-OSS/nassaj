/**
 * ADR-156 / T-1730 W1 — node overlay schema, mount validation and seal digest.
 *
 * The founding rule (contract §3.1): the overlay NEVER writes to a tracked path
 * or a generation (`dist`, `dist-server`, `node_modules`). Its files live under
 * `config/overlay/` and are consumed by owner-defined extension points. This
 * module is the ONE shared validator between the server (E1, W3) and the
 * pre-flight (W4/W5): `parseNodeOverlay`, `validateMount`, `RESERVED_PREFIXES`
 * and the seal helpers `sealDigest` / `verifySealedFile`.
 *
 * Every validator here is pure and depends only on `node:` builtins, so it runs
 * both inside the booting server and inside `doctor` on a node whose server
 * cannot boot. The validators perform NO filesystem I/O: `realpath` containment
 * of `dir` and reading the sealed bytes are the caller's job (the service opens
 * files from a pinned dirfd — contract §3.1 C1.2).
 *
 * The single writer is `writeSealManifest` (W10): it lives here, not in
 * `doctor.mjs`, so `doctor` holds no writer primitive at all and its READ-ONLY
 * contract stays structural. The server never calls it — only the sealer does.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Current schema version of `config/node-overlay.json` (contract §3.1). */
export const NODE_OVERLAY_SCHEMA_VERSION = 1;

/** Pre-flight / server code emitted when the config or seal manifest is bad. */
export const NODE_OVERLAY_INVALID_CODE = 'node_overlay_invalid';

/** A single mount segment: one lowercase path segment, no `..`, no encoding, no dot. */
export const MOUNT_PATTERN = /^\/[a-z0-9][a-z0-9-]{0,31}$/;

/** Maximum number of mounts (contract §3.1 point 7). */
export const MAX_MOUNTS = 8;

/**
 * Reserved mount prefixes (contract §3.1 point 7, M10). An exported constant
 * that the W1 parity guard test compares against the real Express router, the
 * client route table and the current `public/` top-level directories. Adding a
 * new top-level route, client route or public directory must be reflected here
 * or the parity guard fails — that is the whole point of the guard.
 *
 * Three origins, all of which E1 (mounted right before `express.static(dist)`)
 * would otherwise shadow:
 *   1. Server routes registered before `express.static(dist)` in server/index.js.
 *   2. SPA client routes served by the dist catch-all (src/App.tsx).
 *   3. `public/` top-level directories copied into `dist/` by Vite.
 */
export const RESERVED_PREFIXES = new Set([
    // 1. Server routes registered before express.static(dist) (server/index.js).
    '/api', '/assets', '/ws', '/shell', '/health', '/auth',
    '/manifest.json', '/sw.js', '/favicon', '/icons',
    '/branding', '/project-logos', '/connectors', '/avatars',
    // 2. SPA client routes served by the dist catch-all (src/App.tsx).
    '/session', '/join', '/scheduled', '/wiki', '/share', '/login',
    // 3. public/ top-level directories shipped into dist/ (current release).
    '/design', '/screenshots', '/connector-logos', '/avatars-gallery', '/ui-lab',
]);

/**
 * Error thrown for any malformed overlay config or seal manifest. Carries the
 * offending field name so the pre-flight can name it to the operator, and the
 * `node_overlay_invalid` code. A caller catches this and disables the whole
 * overlay while the server still boots (contract §3.1 point 8).
 */
export class OverlayConfigError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'OverlayConfigError';
        this.code = NODE_OVERLAY_INVALID_CODE;
        this.field = field;
    }
}

/**
 * True when `mount` collides with a reserved prefix. Exact-segment match, plus
 * the documented `/favicon*` wildcard (contract lists `/favicon*`). Reserved
 * entries with a dot (e.g. `/manifest.json`) can never be produced by a valid
 * mount, but are kept for documentation and defence.
 */
export function isReservedPrefix(mount) {
    if (typeof mount !== 'string') return false;
    if (RESERVED_PREFIXES.has(mount)) return true;
    if (mount === '/favicon' || mount.startsWith('/favicon.') || mount.startsWith('/favicon-')) return true;
    return false;
}

/**
 * Validate a mount string. Shared by the server and the pre-flight so the two
 * never diverge. Returns `{ valid, reason? }` rather than throwing so callers
 * can filter a list of mounts and report each.
 *
 * @param {unknown} mount
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateMount(mount) {
    if (typeof mount !== 'string' || mount.length === 0) {
        return { valid: false, reason: 'mount must be a non-empty string' };
    }
    // Reject anything percent-encoded or containing traversal before the regex,
    // so the reason is specific rather than a generic pattern miss.
    if (mount.includes('%')) {
        return { valid: false, reason: 'mount must not be percent-encoded' };
    }
    if (mount.includes('..')) {
        return { valid: false, reason: 'mount must not contain ".."' };
    }
    if (!MOUNT_PATTERN.test(mount)) {
        return { valid: false, reason: 'mount must match a single lowercase segment /^\\/[a-z0-9][a-z0-9-]{0,31}$/' };
    }
    if (isReservedPrefix(mount)) {
        return { valid: false, reason: `mount "${mount}" is a reserved prefix` };
    }
    return { valid: true };
}

/**
 * Validate the relative `dir` of a mount: a non-empty relative path inside
 * `config/overlay/`. Structural only — `realpath` containment is enforced by
 * the service against the real filesystem (contract §3.1 point 7).
 *
 * @param {unknown} dir
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateOverlayDir(dir) {
    if (typeof dir !== 'string' || dir.length === 0) {
        return { valid: false, reason: 'dir must be a non-empty string' };
    }
    if (dir.includes('\0')) {
        return { valid: false, reason: 'dir must not contain a NUL byte' };
    }
    if (dir.startsWith('/')) {
        return { valid: false, reason: 'dir must be relative to config/overlay/, not absolute' };
    }
    // Reject any traversal that would escape config/overlay/. Normalise with
    // POSIX semantics and check the result stays inside.
    const segments = dir.split('/').filter((s) => s.length > 0 && s !== '.');
    if (segments.length === 0) {
        return { valid: false, reason: 'dir must name a directory inside config/overlay/' };
    }
    let depth = 0;
    for (const seg of segments) {
        if (seg === '..') {
            depth -= 1;
            if (depth < 0) return { valid: false, reason: 'dir must not escape config/overlay/' };
        } else {
            depth += 1;
        }
    }
    return { valid: true };
}

/**
 * Parse and validate `config/node-overlay.json` (schema 1). Throws
 * `OverlayConfigError` on any violation so the service disables the overlay and
 * still boots. Returns a normalised, frozen config on success.
 *
 * @param {string} jsonText raw file contents
 * @returns {{ schema: number, static: Array<{ mount: string, dir: string }> }}
 */
export function parseNodeOverlay(jsonText) {
    if (typeof jsonText !== 'string') {
        throw new OverlayConfigError('overlay config must be text', 'config');
    }
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        throw new OverlayConfigError(`overlay config is not valid JSON: ${err.message}`, 'config');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new OverlayConfigError('overlay config must be a JSON object', 'config');
    }
    if (parsed.schema !== NODE_OVERLAY_SCHEMA_VERSION) {
        throw new OverlayConfigError(
            `overlay config schema must be ${NODE_OVERLAY_SCHEMA_VERSION}`,
            'schema',
        );
    }
    const rawStatic = parsed.static === undefined ? [] : parsed.static;
    if (!Array.isArray(rawStatic)) {
        throw new OverlayConfigError('overlay config "static" must be an array', 'static');
    }
    if (rawStatic.length > MAX_MOUNTS) {
        throw new OverlayConfigError(`overlay config allows at most ${MAX_MOUNTS} mounts`, 'static');
    }
    const seenMounts = new Set();
    const normalized = rawStatic.map((entry, index) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new OverlayConfigError(`static[${index}] must be an object`, `static[${index}]`);
        }
        const mountResult = validateMount(entry.mount);
        if (!mountResult.valid) {
            throw new OverlayConfigError(`static[${index}].mount invalid: ${mountResult.reason}`, `static[${index}].mount`);
        }
        if (seenMounts.has(entry.mount)) {
            throw new OverlayConfigError(`static[${index}].mount "${entry.mount}" is duplicated`, `static[${index}].mount`);
        }
        seenMounts.add(entry.mount);
        const dirResult = validateOverlayDir(entry.dir);
        if (!dirResult.valid) {
            throw new OverlayConfigError(`static[${index}].dir invalid: ${dirResult.reason}`, `static[${index}].dir`);
        }
        return Object.freeze({ mount: entry.mount, dir: entry.dir });
    });
    return Object.freeze({ schema: NODE_OVERLAY_SCHEMA_VERSION, static: Object.freeze(normalized) });
}

/** SHA-256 hex digest of a buffer — the one hashing function E1 and the sealer share. */
export function sealDigest(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify sealed bytes against a manifest entry `{ sha256, size }`. The service
 * (W3) computes `buffer` from the SAME file descriptor it streams the content
 * from — never a re-opened path — so a match here proves the bytes served are
 * the bytes sealed (contract §3.1 C1.2, TOCTOU). Comparison is length-guarded
 * and constant-time.
 *
 * @param {Buffer} buffer bytes read from the served descriptor
 * @param {{ sha256: string, size: number }} entry manifest entry
 * @returns {boolean}
 */
export function verifySealedFile(buffer, entry) {
    if (!Buffer.isBuffer(buffer)) return false;
    if (entry === null || typeof entry !== 'object') return false;
    if (typeof entry.sha256 !== 'string' || !Number.isInteger(entry.size)) return false;
    if (buffer.length !== entry.size) return false;
    const actual = Buffer.from(sealDigest(buffer), 'utf8');
    const expected = Buffer.from(entry.sha256.toLowerCase(), 'utf8');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
}

/**
 * Atomically write the seal manifest to `lockPath` at mode 0644 (W10). The JSON
 * is serialized to a temp file in the SAME directory — so `rename` is atomic on
 * the same filesystem and a concurrent reader never sees a half-written file —
 * then renamed over the destination. The mode is set explicitly with `chmod`
 * before the rename so it is exact regardless of the process umask. On any
 * failure the temp file is removed on a best-effort basis and the error rethrown.
 *
 * This is the ONE writer primitive of the overlay module; keeping it here (not
 * in `doctor.mjs`) is what lets the pre-flight doctor stay structurally
 * READ-ONLY (contract §3.1).
 *
 * @param {string} lockPath absolute path of the manifest (config/node-overlay.lock.json)
 * @param {object} manifest the seal manifest object to serialize
 * @returns {string} the path written (`lockPath`)
 */
export function writeSealManifest(lockPath, manifest) {
    const dir = path.dirname(lockPath);
    const tmpPath = path.join(dir, `.${path.basename(lockPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    try {
        writeFileSync(tmpPath, serialized);
        chmodSync(tmpPath, 0o644);
        renameSync(tmpPath, lockPath);
    } catch (err) {
        try { rmSync(tmpPath, { force: true }); } catch { /* best effort: the temp file may not exist */ }
        throw err;
    }
    return lockPath;
}
