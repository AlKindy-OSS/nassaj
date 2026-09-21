/**
 * ADR-156 / T-1730 W1 tests — overlay schema, mount rules, seal digest, and the
 * parity guard (test plan §7): RESERVED_PREFIXES is compared against the real
 * Express router (any order), the client route table (/session, /join,
 * /scheduled, /wiki) and the current public/ top-level directories (M10).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
    MAX_MOUNTS,
    NODE_OVERLAY_INVALID_CODE,
    NODE_OVERLAY_SCHEMA_VERSION,
    OverlayConfigError,
    RESERVED_PREFIXES,
    isReservedPrefix,
    parseNodeOverlay,
    sealDigest,
    validateMount,
    validateOverlayDir,
    verifySealedFile,
    writeSealManifest,
} from './node-overlay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Collidable mount pattern: a single lowercase segment (what a valid mount looks like). */
const COLLIDABLE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,31}$/;

// --- validateMount --------------------------------------------------------

test('validateMount accepts a single lowercase segment', () => {
    assert.equal(validateMount('/hub').valid, true);
    assert.equal(validateMount('/a').valid, true);
    assert.equal(validateMount('/x0-9').valid, true);
});

test('validateMount rejects a two-segment mount', () => {
    const r = validateMount('/hub/extra');
    assert.equal(r.valid, false);
});

test('validateMount rejects traversal and encoding', () => {
    assert.equal(validateMount('/..').valid, false);
    assert.equal(validateMount('/hub/..').valid, false);
    assert.equal(validateMount('/%2e%2e').valid, false);
    assert.equal(validateMount('/%2e').valid, false);
});

test('validateMount rejects uppercase, dots, empty, and non-strings', () => {
    assert.equal(validateMount('/Hub').valid, false);
    assert.equal(validateMount('/manifest.json').valid, false);
    assert.equal(validateMount('').valid, false);
    assert.equal(validateMount('/').valid, false);
    assert.equal(validateMount(42).valid, false);
    assert.equal(validateMount(null).valid, false);
});

test('validateMount rejects an over-long mount', () => {
    assert.equal(validateMount('/' + 'a'.repeat(33)).valid, false);
    assert.equal(validateMount('/' + 'a'.repeat(32)).valid, true);
});

test('validateMount rejects every reserved prefix', () => {
    for (const reserved of RESERVED_PREFIXES) {
        // Only test the ones a mount could actually spell (single lowercase segment).
        const seg = reserved.slice(1);
        if (!COLLIDABLE_SEGMENT.test(seg)) continue;
        const r = validateMount(reserved);
        assert.equal(r.valid, false, `expected reserved ${reserved} to be rejected`);
    }
    assert.equal(validateMount('/branding').valid, false);
    assert.equal(validateMount('/project-logos').valid, false);
    assert.equal(validateMount('/connectors').valid, false);
    assert.equal(validateMount('/favicon').valid, false);
});

// --- validateOverlayDir ---------------------------------------------------

test('validateOverlayDir accepts a relative directory', () => {
    assert.equal(validateOverlayDir('static/hub').valid, true);
    assert.equal(validateOverlayDir('hub').valid, true);
});

test('validateOverlayDir rejects absolute, traversal and empty', () => {
    assert.equal(validateOverlayDir('/etc').valid, false);
    assert.equal(validateOverlayDir('../secrets').valid, false);
    assert.equal(validateOverlayDir('static/../../secrets').valid, false);
    assert.equal(validateOverlayDir('').valid, false);
    assert.equal(validateOverlayDir('.').valid, false);
    assert.equal(validateOverlayDir('a/../b').valid, true); // stays inside
});

// --- parseNodeOverlay -----------------------------------------------------

test('parseNodeOverlay accepts the schema-1 example', () => {
    const cfg = parseNodeOverlay('{ "schema": 1, "static": [ { "mount": "/hub", "dir": "static/hub" } ] }');
    assert.equal(cfg.schema, 1);
    assert.equal(cfg.static.length, 1);
    assert.deepEqual({ ...cfg.static[0] }, { mount: '/hub', dir: 'static/hub' });
});

test('parseNodeOverlay defaults static to empty', () => {
    const cfg = parseNodeOverlay(JSON.stringify({ schema: NODE_OVERLAY_SCHEMA_VERSION }));
    assert.deepEqual(cfg.static, []);
});

test('parseNodeOverlay throws OverlayConfigError on malformed JSON', () => {
    assert.throws(() => parseNodeOverlay('{ not json'), (err) => {
        assert.ok(err instanceof OverlayConfigError);
        assert.equal(err.code, NODE_OVERLAY_INVALID_CODE);
        assert.equal(err.field, 'config');
        return true;
    });
});

test('parseNodeOverlay throws when schema is missing or wrong', () => {
    assert.throws(() => parseNodeOverlay('{ "static": [] }'), (e) => e.field === 'schema');
    assert.throws(() => parseNodeOverlay('{ "schema": 2 }'), (e) => e.field === 'schema');
});

test('parseNodeOverlay rejects a reserved mount', () => {
    assert.throws(
        () => parseNodeOverlay('{ "schema": 1, "static": [ { "mount": "/api", "dir": "x" } ] }'),
        (e) => e.field === 'static[0].mount',
    );
});

test('parseNodeOverlay rejects an absolute dir', () => {
    assert.throws(
        () => parseNodeOverlay('{ "schema": 1, "static": [ { "mount": "/hub", "dir": "/etc" } ] }'),
        (e) => e.field === 'static[0].dir',
    );
});

test('parseNodeOverlay rejects a duplicate mount', () => {
    const json = '{ "schema": 1, "static": [ { "mount": "/hub", "dir": "a" }, { "mount": "/hub", "dir": "b" } ] }';
    assert.throws(() => parseNodeOverlay(json), (e) => e.field === 'static[1].mount');
});

test('parseNodeOverlay rejects more than the max mounts', () => {
    const many = Array.from({ length: MAX_MOUNTS + 1 }, (_, i) => ({ mount: `/m${i}`, dir: `d${i}` }));
    assert.throws(
        () => parseNodeOverlay(JSON.stringify({ schema: 1, static: many })),
        (e) => e.field === 'static',
    );
});

test('parseNodeOverlay rejects a non-array static', () => {
    assert.throws(() => parseNodeOverlay('{ "schema": 1, "static": {} }'), (e) => e.field === 'static');
});

// --- seal digest / verifySealedFile --------------------------------------

test('sealDigest matches a reference sha256', () => {
    const buf = Buffer.from('hello world');
    assert.equal(sealDigest(buf), createHash('sha256').update(buf).digest('hex'));
});

test('verifySealedFile accepts matching bytes and rejects mismatches', () => {
    const buf = Buffer.from('<html>/hub</html>');
    const entry = { sha256: sealDigest(buf), size: buf.length };
    assert.equal(verifySealedFile(buf, entry), true);
    // Wrong digest.
    assert.equal(verifySealedFile(buf, { sha256: sealDigest(Buffer.from('x')), size: buf.length }), false);
    // Wrong size (even if a digest field is present).
    assert.equal(verifySealedFile(buf, { sha256: sealDigest(buf), size: buf.length + 1 }), false);
    // Tampered bytes, same claimed size.
    const tampered = Buffer.from('<html>/HUB</html>');
    assert.equal(verifySealedFile(tampered, entry), false);
    // Malformed entries.
    assert.equal(verifySealedFile(buf, null), false);
    assert.equal(verifySealedFile(buf, {}), false);
    assert.equal(verifySealedFile('not a buffer', entry), false);
});

// --- writeSealManifest (W10) ----------------------------------------------

/** A private temp directory scoped to one test, removed when it finishes. */
function tmpDir(t) {
    const dir = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-seal-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('writeSealManifest writes the serialized manifest at mode 0644 and returns the path', (t) => {
    const dir = tmpDir(t);
    const lockPath = path.join(dir, 'node-overlay.lock.json');
    const manifest = { schema: 1, sealedAt: '2026-01-01T00:00:00.000Z', files: { '/hub/index.html': { sha256: 'a'.repeat(64), size: 3 } } };

    const returned = writeSealManifest(lockPath, manifest);
    assert.equal(returned, lockPath);

    // Byte-exact: pretty-printed JSON with a trailing newline.
    assert.equal(readFileSync(lockPath, 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`);
    // Exact permission bits regardless of the process umask.
    assert.equal(statSync(lockPath).mode & 0o777, 0o644);
    // Round-trips back to the same object.
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), manifest);
});

test('writeSealManifest leaves no temp file behind on success', (t) => {
    const dir = tmpDir(t);
    const lockPath = path.join(dir, 'node-overlay.lock.json');
    writeSealManifest(lockPath, { schema: 1, files: {} });
    assert.deepEqual(readdirSync(dir), ['node-overlay.lock.json']);
});

test('writeSealManifest overwrites an existing manifest atomically', (t) => {
    const dir = tmpDir(t);
    const lockPath = path.join(dir, 'node-overlay.lock.json');
    writeSealManifest(lockPath, { schema: 1, files: { a: 1 } });
    writeSealManifest(lockPath, { schema: 1, files: { b: 2 } });
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), { schema: 1, files: { b: 2 } });
    assert.deepEqual(readdirSync(dir), ['node-overlay.lock.json']);
});

test('writeSealManifest throws and leaves no temp file when the directory is missing', (t) => {
    const dir = tmpDir(t);
    const lockPath = path.join(dir, 'no-such-subdir', 'node-overlay.lock.json');
    assert.throws(() => writeSealManifest(lockPath, { schema: 1, files: {} }));
    // The parent temp dir exists and holds no orphaned `.tmp` residue.
    assert.deepEqual(readdirSync(dir), []);
});

// --- parity guard (test plan §7 / M10) ------------------------------------

/** Extract the first path segment of an Express/route path, or null if not collidable. */
function firstSegment(routePath) {
    const seg = routePath.replace(/^\//, '').split('/')[0];
    return COLLIDABLE_SEGMENT.test(seg) ? seg : null;
}

test('parity guard: every Express top-level route segment is reserved', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'server', 'index.js'), 'utf8');
    const routeRe = /app\.(?:use|get|post|put|delete|all|options|patch)\(\s*['"](\/[^'"]*)['"]/g;
    const missing = new Set();
    for (const m of source.matchAll(routeRe)) {
        const seg = firstSegment(m[1]);
        if (seg === null) continue;
        if (!RESERVED_PREFIXES.has(`/${seg}`)) missing.add(`/${seg}`);
    }
    assert.deepEqual([...missing], [], `Express route segments not in RESERVED_PREFIXES: ${[...missing]}`);
});

test('parity guard: every client SPA route segment is reserved', () => {
    const app = readFileSync(path.join(REPO_ROOT, 'src', 'App.tsx'), 'utf8');
    const routeRe = /path=["'](\/[^"'*]*)["']/g;
    const missing = new Set();
    for (const m of app.matchAll(routeRe)) {
        const seg = firstSegment(m[1]);
        if (seg === null) continue;
        if (!RESERVED_PREFIXES.has(`/${seg}`)) missing.add(`/${seg}`);
    }
    // The documented SPA routes must at minimum be present and reserved.
    for (const known of ['session', 'join', 'scheduled', 'wiki', 'share', 'login']) {
        assert.ok(RESERVED_PREFIXES.has(`/${known}`), `/${known} must be reserved`);
    }
    assert.deepEqual([...missing], [], `client route segments not in RESERVED_PREFIXES: ${[...missing]}`);
});

test('parity guard: every public/ top-level directory is reserved', () => {
    const publicDir = path.join(REPO_ROOT, 'public');
    const missing = new Set();
    for (const entry of readdirSync(publicDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue; // files carry dots and cannot be spelled as a mount
        if (!COLLIDABLE_SEGMENT.test(entry.name)) continue;
        if (!RESERVED_PREFIXES.has(`/${entry.name}`)) missing.add(`/${entry.name}`);
    }
    assert.deepEqual([...missing], [], `public/ directories not in RESERVED_PREFIXES: ${[...missing]}`);
});

test('isReservedPrefix honours the /favicon* wildcard', () => {
    assert.equal(isReservedPrefix('/favicon'), true);
    assert.equal(isReservedPrefix('/favicon-32x32'), true);
    assert.equal(isReservedPrefix('/hub'), false);
});
