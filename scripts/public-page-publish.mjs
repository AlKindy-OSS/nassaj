#!/usr/bin/env node
/**
 * public-page-publish — the missing WRITER for the public publication contract
 * (T-1799).
 *
 * `server/services/public-page-manifest.mjs` has always described an atomic,
 * immutable publication layout, but nothing in the repo produced one, so
 * operators planted files into `dist/` by hand — which breaks node updates
 * (`client_asset_manifest_changed`) and is erased by the next generation swap.
 * This CLI writes exactly that existing layout and nothing else:
 *
 *   <root>/bundles/<id>/<revision>/manifest.json + files…   (immutable)
 *   <root>/pointers/<id>.json                               (swapped by rename)
 *   <root>/tombstones/<id>                                  (withdrawal)
 *   <root>/locks/<id>.lock                                  (kernel flock)
 *
 * Publishing never mutates a live revision: a new revision directory is staged
 * and renamed into place, and only the single-file pointer rename makes it
 * visible. Rollback is the same rename pointed at an older revision, so it is
 * as atomic as a publish and needs no rebuild.
 *
 * USAGE
 *   node scripts/public-page-publish.mjs publish  --site <id> --dir <path>
 *   node scripts/public-page-publish.mjs list     [--site <id>]
 *   node scripts/public-page-publish.mjs rollback --site <id> --to <revision>
 *   node scripts/public-page-publish.mjs withdraw --site <id>
 *   node scripts/public-page-publish.mjs restore  --site <id>
 *
 * `--root <path>` overrides the resolved content root for every command.
 */
import {
    closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
    realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, constants, chmodSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import {
    PUBLIC_SITE_ASSET_MAX_BYTES, PUBLIC_SITE_MAX_FILES,
    isPublicationId, isReservedPublicSiteId, publicSiteComponents, publicSiteType,
} from '../server/services/public-page-manifest.mjs';
import { acquirePublicPageLock } from '../server/services/public-page-publisher-lock.mjs';
import { resolvePublicContentRoot } from '../server/services/public-content-root.mjs';

const POINTER_SCHEMA = 'nassaj-public-page-pointer/v1';
const SITE_MANIFEST_SCHEMA = 'nassaj-public-site-manifest/v1';
const TOMBSTONE_SCHEMA = 'nassaj-public-page-tombstone/v1';
const TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

class PublishError extends Error {}
const fail = (message) => { throw new PublishError(message); };

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Key-sorted JSON, so an identical tree always yields an identical revision. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function syncDirectory(directory) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Write `bytes` durably, then rename it onto `target` — the only visible step. */
function writeAtomic(target, bytes) {
    const temporary = path.join(path.dirname(target), `.swap-${randomBytes(8).toString('hex')}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
    syncDirectory(path.dirname(target));
}

function ensureDirectory(directory) {
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
    chmodSync(directory, DIRECTORY_MODE);
    return directory;
}

function layout(root) {
    ensureDirectory(root);
    return {
        root,
        bundles: ensureDirectory(path.join(root, 'bundles')),
        pointers: ensureDirectory(path.join(root, 'pointers')),
        tombstones: ensureDirectory(path.join(root, 'tombstones')),
        locks: ensureDirectory(path.join(root, 'locks')),
    };
}

/** Current pointer epoch, or 0 when there is no readable pointer yet. */
function currentPointer(places, siteId) {
    try {
        const value = JSON.parse(readFileSync(path.join(places.pointers, `${siteId}.json`), 'utf8'));
        return (value?.schema === POINTER_SCHEMA && Number.isSafeInteger(value.epoch)) ? value : null;
    } catch { return null; }
}

function nextEpoch(places, siteId) {
    const pointer = currentPointer(places, siteId);
    const tombstone = (() => {
        try { return JSON.parse(readFileSync(path.join(places.tombstones, siteId), 'utf8')); } catch { return null; }
    })();
    return Math.max(pointer?.epoch ?? 0, tombstone?.epoch ?? 0) + 1;
}

/** Collect a source tree into validated, digested publication entries. */
function collect(sourceDirectory) {
    const files = new Map();
    let total = 0;
    const walk = (absolute, prefix) => {
        for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const child = path.join(absolute, entry.name);
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const stat = lstatSync(child);
            if (stat.isSymbolicLink()) fail(`refusing symlink: ${relative}`);
            if (stat.isDirectory()) { walk(child, relative); continue; }
            if (!stat.isFile()) fail(`refusing non-regular file: ${relative}`);
            if (!publicSiteComponents(relative)) {
                fail(`refusing unpublishable path or type: ${relative}`);
            }
            if (stat.size < 1 || stat.size > PUBLIC_SITE_ASSET_MAX_BYTES) fail(`file size out of bounds: ${relative}`);
            total += stat.size;
            if (total > TOTAL_MAX_BYTES) fail('bundle exceeds the total size ceiling');
            if (files.size >= PUBLIC_SITE_MAX_FILES) fail('bundle exceeds the file-count ceiling');
            const bytes = readFileSync(child);
            if (bytes.length !== stat.size) fail(`file changed while reading: ${relative}`);
            files.set(relative, { bytes, entry: { mime: publicSiteType(entry.name), bytes: bytes.length, sha256: sha256(bytes) } });
        }
    };
    const stat = lstatSync(sourceDirectory);
    if (!stat.isDirectory()) fail('--dir must be a directory');
    walk(sourceDirectory, '');
    if (files.size === 0) fail('source directory has no publishable files');
    if (!files.has('index.html')) {
        const roots = [...files.keys()].filter((name) => name.endsWith('/index.html'));
        if (roots.length === 0) fail('source directory has no index.html at any level');
    }
    return files;
}

/** Materialize one immutable revision directory, or reuse an identical one. */
function stage(places, siteId, files, revision) {
    const publication = ensureDirectory(path.join(places.bundles, siteId));
    const target = path.join(publication, revision);
    try { if (statSync(target).isDirectory()) return { target, reused: true }; } catch { /* not published yet */ }
    const staging = ensureDirectory(path.join(publication, `staging-${randomBytes(8).toString('hex')}`));
    try {
        for (const [relative, file] of files) {
            const destination = path.join(staging, relative);
            ensureDirectory(path.dirname(destination));
            const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
            try { writeFileSync(fd, file.bytes); fsyncSync(fd); } finally { closeSync(fd); }
        }
        const manifest = Buffer.from(canonical({
            schema: SITE_MANIFEST_SCHEMA,
            publicationId: siteId,
            revision,
            files: Object.fromEntries([...files].map(([relative, file]) => [relative, file.entry])),
        }), 'utf8');
        const fd = openSync(path.join(staging, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
        try { writeFileSync(fd, manifest); fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(staging);
        renameSync(staging, target);
        syncDirectory(publication);
        return { target, reused: false };
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}

function pointAt(places, siteId, revision, manifestSha256) {
    const pointer = {
        schema: POINTER_SCHEMA, publicationId: siteId, revision, manifestSha256, epoch: nextEpoch(places, siteId),
    };
    writeAtomic(path.join(places.pointers, `${siteId}.json`), Buffer.from(canonical(pointer), 'utf8'));
    return pointer;
}

async function withLock(places, siteId, action) {
    const lock = await acquirePublicPageLock(places.locks, siteId, { waitMs: 5_000 });
    try { return action(); } finally { lock.release(); }
}

/**
 * Refuse a source directory that lives inside the content root itself.
 *
 * A blind agent run (T-1804) wrote its page into `<root>/<site>/` and published
 * from there. Nothing broke — reads go through the pointers — but the root then
 * holds a stray tree beside `bundles/`, `pointers/`, `tombstones/` and `locks/`,
 * which no cleanup owns and which the next reader has to explain. Real paths are
 * compared, so a symlink into the root is caught too.
 */
function refuseSourceInsideRoot(root, sourceDirectory) {
    let resolvedRoot, resolvedSource;
    try { resolvedRoot = realpathSync(root); } catch { return; }
    try { resolvedSource = realpathSync(sourceDirectory); } catch { return; }
    if (resolvedSource === resolvedRoot || resolvedSource.startsWith(`${resolvedRoot}${path.sep}`)) {
        fail('--dir must be outside the public content root; keep the page sources in your own project directory');
    }
}

async function publish(places, siteId, sourceDirectory) {
    refuseSourceInsideRoot(places.root, sourceDirectory);
    const files = collect(sourceDirectory);
    const digestible = Object.fromEntries([...files].map(([relative, file]) => [relative, file.entry]));
    const revision = sha256(canonical({ publicationId: siteId, files: digestible }));
    return withLock(places, siteId, () => {
        const { target, reused } = stage(places, siteId, files, revision);
        const manifestSha256 = sha256(readFileSync(path.join(target, 'manifest.json')));
        const pointer = pointAt(places, siteId, revision, manifestSha256);
        try { unlinkSync(path.join(places.tombstones, siteId)); } catch { /* not withdrawn */ }
        return { action: reused ? 'republished' : 'published', ...pointer, files: files.size };
    });
}

async function rollback(places, siteId, revision) {
    const manifestPath = path.join(places.bundles, siteId, revision, 'manifest.json');
    let manifest;
    try { manifest = readFileSync(manifestPath); } catch { fail(`revision not found for ${siteId}: ${revision}`); }
    const parsed = JSON.parse(manifest.toString('utf8'));
    if (parsed.publicationId !== siteId || parsed.revision !== revision) fail('revision manifest does not match its location');
    return withLock(places, siteId, () => ({ action: 'rolled-back', ...pointAt(places, siteId, revision, sha256(manifest)) }));
}

async function withdraw(places, siteId) {
    return withLock(places, siteId, () => {
        const tombstone = { schema: TOMBSTONE_SCHEMA, publicationId: siteId, epoch: nextEpoch(places, siteId) };
        writeAtomic(path.join(places.tombstones, siteId), Buffer.from(canonical(tombstone), 'utf8'));
        return { action: 'withdrawn', ...tombstone };
    });
}

async function restore(places, siteId) {
    return withLock(places, siteId, () => {
        try { unlinkSync(path.join(places.tombstones, siteId)); } catch { fail(`${siteId} is not withdrawn`); }
        syncDirectory(places.tombstones);
        return { action: 'restored', publicationId: siteId };
    });
}

function list(places, siteId) {
    const ids = siteId ? [siteId] : readdirSync(places.pointers).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
    return ids.map((id) => {
        const pointer = currentPointer(places, id);
        let revisions = [];
        try { revisions = readdirSync(path.join(places.bundles, id)).filter((name) => /^[a-f0-9]{64}$/.test(name)); } catch { /* none */ }
        let withdrawn = false;
        try { withdrawn = statSync(path.join(places.tombstones, id)).isFile(); } catch { /* live */ }
        return { publicationId: id, current: pointer?.revision ?? null, epoch: pointer?.epoch ?? null, withdrawn, revisions };
    });
}

function parseArguments(argv) {
    const options = { command: argv[0] };
    for (let index = 1; index < argv.length; index += 1) {
        const flag = argv[index];
        if (!flag.startsWith('--')) fail(`unexpected argument: ${flag}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) fail(`missing value for ${flag}`);
        options[flag.slice(2)] = value;
        index += 1;
    }
    return options;
}

/** Run one CLI command and return its JSON-serializable result. */
export async function run(argv) {
    const options = parseArguments(argv);
    const root = options.root ?? resolvePublicContentRoot();
    if (!root) fail('no usable public content root; set NASSAJ_PUBLIC_CONTENT_ROOT to an absolute path outside the app');
    const places = layout(root);
    const siteId = options.site;
    if (options.command !== 'list') {
        if (!isPublicationId(siteId ?? '')) fail('--site must be a lowercase slug (a-z 0-9 -) or a 32-hex id');
    }
    switch (options.command) {
        case 'publish':
            // T-1804: a shell-owned slug is refused at WRITE time. Refusing only
            // at read time publishes a site that then 404s forever, and the
            // operator reads that as a broken page rather than a taken name.
            if (isReservedPublicSiteId(siteId)) fail(`--site "${siteId}" is a name Nassaj itself serves; choose another`);
            return publish(places, siteId, options.dir ?? fail('--dir is required'));
        case 'rollback': return rollback(places, siteId, options.to ?? fail('--to <revision> is required'));
        case 'withdraw': return withdraw(places, siteId);
        case 'restore': return restore(places, siteId);
        case 'list': return list(places, siteId);
        default: return fail('usage: public-page-publish.mjs <publish|list|rollback|withdraw|restore> …');
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
    run(process.argv.slice(2))
        .then((result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); })
        .catch((error) => {
            process.stderr.write(`public-page-publish: ${error instanceof PublishError ? error.message : error?.code || 'failed'}\n`);
            process.exitCode = 1;
        });
}
