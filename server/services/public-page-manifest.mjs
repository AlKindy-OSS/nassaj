import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PUBLIC_PAGE_ID = /^[a-f0-9]{32}$/;
const REVISION = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const POINTER_MAX_BYTES = 16 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
export const PUBLIC_PAGE_HTML_MAX_BYTES = 8 * 1024 * 1024;
const POINTER_SCHEMA = 'nassaj-public-page-pointer/v1';
const MANIFEST_SCHEMA = 'nassaj-public-page-manifest/v1';
const TOMBSTONE_SCHEMA = 'nassaj-public-page-tombstone/v1';

/** A deliberately path-free failure for the public data plane. */
export class PublicPageUnavailable extends Error {
  constructor() { super('PUBLIC_PAGE_UNAVAILABLE'); this.code = 'PUBLIC_PAGE_UNAVAILABLE'; }
}

function unavailable() { throw new PublicPageUnavailable(); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertPrivateDirectory(stat) {
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) unavailable();
}

function assertPrivateFile(stat, maximum) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || stat.size < 1 || stat.size > maximum) unavailable();
}

/** Open an absolute private app-data directory without following any path component symlink. */
export function openPrivateRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root === '/' || root.includes('\0')
    || root.split('/').some((part) => part === '.' || part === '..')) unavailable();
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const name of root.split('/').filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    assertPrivateDirectory(fstatSync(fd));
    return fd;
  } catch (error) { try { closeSync(fd); } catch {} if (error instanceof PublicPageUnavailable) throw error; unavailable(); }
}

function openChildDirectory(parent, name) {
  if (!/^[a-z0-9-]+$/.test(name) && !PUBLIC_PAGE_ID.test(name) && !REVISION.test(name)) unavailable();
  let fd;
  try {
    fd = openSync(`/proc/self/fd/${parent}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertPrivateDirectory(fstatSync(fd));
    return { fd, parent, name, stat: fstatSync(fd) };
  } catch (error) { try { if (fd !== undefined) closeSync(fd); } catch {} if (error instanceof PublicPageUnavailable) throw error; unavailable(); }
}

function verifyDirectories(entries) {
  for (const entry of entries) {
    let current;
    try { current = lstatSync(`/proc/self/fd/${entry.parent}/${entry.name}`); } catch { unavailable(); }
    if (current.isSymbolicLink() || !sameStat(current, entry.stat)) unavailable();
  }
}

/** Read a bounded regular file by descriptor and verify its parent chain before returning bytes. */
function readStableFile(parent, name, maximum, entries, optional = false) {
  if (!/^[a-z0-9._-]+$/.test(name)) unavailable();
  let fd;
  try {
    fd = openSync(`/proc/self/fd/${parent}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    unavailable();
  }
  try {
    const before = fstatSync(fd); assertPrivateFile(before, maximum);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!count) unavailable();
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameStat(before, after)) unavailable();
    verifyDirectories(entries);
    return bytes;
  } catch (error) { if (error instanceof PublicPageUnavailable) throw error; unavailable(); }
  finally { try { if (fd !== undefined) closeSync(fd); } catch {} }
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { unavailable(); }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parsePointer(bytes, publicationId) {
  const value = parseJson(bytes);
  if (!exactKeys(value, ['schema', 'publicationId', 'revision', 'manifestSha256', 'epoch'])
    || value.schema !== POINTER_SCHEMA || value.publicationId !== publicationId || !REVISION.test(value.revision)
    || !SHA256.test(value.manifestSha256) || !Number.isSafeInteger(value.epoch) || value.epoch < 1) unavailable();
  return value;
}

function parseManifest(bytes, pointer) {
  const value = parseJson(bytes);
  if (!exactKeys(value, ['schema', 'publicationId', 'revision', 'sanitizer', 'html'])
    || value.schema !== MANIFEST_SCHEMA || value.publicationId !== pointer.publicationId
    || value.revision !== pointer.revision || value.sanitizer !== 'document-share-preview/v1'
    || !exactKeys(value.html, ['file', 'mime', 'bytes', 'sha256']) || value.html.file !== 'index.html'
    || value.html.mime !== 'text/html; charset=utf-8' || !Number.isSafeInteger(value.html.bytes)
    || value.html.bytes < 1 || value.html.bytes > PUBLIC_PAGE_HTML_MAX_BYTES || !SHA256.test(value.html.sha256)) unavailable();
  return value;
}

function tombstoned(root, publicationId) {
  let tombstones;
  try { tombstones = openChildDirectory(root, 'tombstones'); }
  catch (error) { if (error instanceof PublicPageUnavailable) throw error; unavailable(); }
  try {
    const bytes = readStableFile(tombstones.fd, publicationId, POINTER_MAX_BYTES, [tombstones], true);
    if (bytes === null) return false;
    const value = parseJson(bytes);
    if (!exactKeys(value, ['schema', 'publicationId', 'epoch']) || value.schema !== TOMBSTONE_SCHEMA
      || value.publicationId !== publicationId || !Number.isSafeInteger(value.epoch) || value.epoch < 1) unavailable();
    return true;
  } finally { closeSync(tombstones.fd); }
}

/**
 * Resolve exactly one immutable self-contained public page from private app-data.
 * Any inconsistent, missing, or unsafe input fails closed without exposing its cause.
 */
export function readPublicPage(dataRoot, publicationId) {
  if (!PUBLIC_PAGE_ID.test(publicationId)) unavailable();
  let root;
  const opened = [];
  try {
    root = openPrivateRoot(dataRoot);
    if (tombstoned(root, publicationId)) unavailable();
    const pointers = openChildDirectory(root, 'pointers'); opened.push(pointers);
    const pointerBytes = readStableFile(pointers.fd, `${publicationId}.json`, POINTER_MAX_BYTES, [pointers]);
    const pointer = parsePointer(pointerBytes, publicationId);
    const bundles = openChildDirectory(root, 'bundles'); opened.push(bundles);
    const publication = openChildDirectory(bundles.fd, publicationId); opened.push(publication);
    const revision = openChildDirectory(publication.fd, pointer.revision); opened.push(revision);
    const manifestBytes = readStableFile(revision.fd, 'manifest.json', MANIFEST_MAX_BYTES, [bundles, publication, revision]);
    if (digest(manifestBytes) !== pointer.manifestSha256) unavailable();
    const manifest = parseManifest(manifestBytes, pointer);
    const html = readStableFile(revision.fd, manifest.html.file, PUBLIC_PAGE_HTML_MAX_BYTES, [bundles, publication, revision]);
    if (html.length !== manifest.html.bytes || digest(html) !== manifest.html.sha256) unavailable();
    return { bytes: html, mime: manifest.html.mime, revision: pointer.revision, epoch: pointer.epoch };
  } catch (error) { if (error instanceof PublicPageUnavailable) throw error; unavailable(); }
  finally {
    for (const entry of opened.reverse()) { try { closeSync(entry.fd); } catch {} }
    try { if (root !== undefined) closeSync(root); } catch {}
  }
}

/*
 * ── Multi-asset public sites (T-1798/T-1799/T-1800) ─────────────────────────
 *
 * The publication contract above (immutable `bundles/<id>/<revision>/`, a
 * single `pointers/<id>.json` swapped by rename, `tombstones/<id>`) is reused
 * VERBATIM for operator-published static pages that need more than one file.
 * Only the manifest payload differs: `nassaj-public-site-manifest/v1` lists a
 * bounded set of relative files instead of one `index.html`. The pointer
 * schema, the tombstone schema, the private-mode invariants, the per-segment
 * `O_NOFOLLOW` walk and the stat re-verification are the same code paths, so a
 * site cannot be read through a laxer door than a document-share preview.
 */

/** A publication id that is an operator-chosen slug rather than an opaque hash. */
export const PUBLIC_SITE_ID = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SITE_MANIFEST_SCHEMA = 'nassaj-public-site-manifest/v1';
export const PUBLIC_SITE_ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const PUBLIC_SITE_MAX_FILES = 200;

/** The only extensions a site may publish, and the exact type each is served as. */
export const PUBLIC_SITE_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const SITE_DIRECTORY_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const SITE_FILE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const SITE_MAX_DEPTH = 8;

/**
 * Root path segments the Nassaj shell owns, so no site may take them (T-1804).
 *
 * Two consumers, ONE list: the reader refuses to serve them, and the publisher
 * refuses to WRITE them. A reserved slug that only the reader rejects still
 * publishes successfully and then 404s forever — a failure reported as a bug in
 * the page, not as the naming collision it is. Refuse at write time instead.
 *
 * Contents: the API/asset/transport prefixes, plus every root route the client
 * router owns (`src/App.tsx`); `public-page-reserved-ids.test.mjs` reads that
 * file and fails when a new root route is not listed here.
 */
export const PUBLIC_SITE_RESERVED_IDS = Object.freeze(new Set([
  'api', 'assets', 'ws', 'shell', 'static', 'public', 'icons', 'preview', 'health',
  'login', 'logout', 'auth', 'admin', 'manifest', 'sw', 'uploads', 'files', 'docs',
  // Client router root routes (src/App.tsx).
  'session', 'scheduled', 'wiki', 'join', 'share',
]));

/** `true` when the slug belongs to the Nassaj shell and can never be a site. */
export function isReservedPublicSiteId(value) {
  return typeof value === 'string' && PUBLIC_SITE_RESERVED_IDS.has(value);
}

/** Any id this contract will lock, publish, or serve. Filename-safe by construction. */
export function isPublicationId(value) {
  return typeof value === 'string' && (PUBLIC_PAGE_ID.test(value) || PUBLIC_SITE_ID.test(value));
}

/** The extension's allowed type, or null when the name is not publishable at all. */
export function publicSiteType(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 1) return null;
  return PUBLIC_SITE_TYPES.get(name.slice(dot).toLowerCase()) ?? null;
}

/**
 * Split a bundle-relative path into validated components.
 * Rejects traversal, empty and dot segments, deep nesting, and unknown types.
 */
export function publicSiteComponents(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) return null;
  const parts = relativePath.split('/');
  if (parts.length < 1 || parts.length > SITE_MAX_DEPTH) return null;
  const file = parts[parts.length - 1];
  if (!SITE_FILE_SEGMENT.test(file) || !publicSiteType(file)) return null;
  for (const directory of parts.slice(0, -1)) {
    if (!SITE_DIRECTORY_SEGMENT.test(directory)) return null;
  }
  return parts;
}

function parseSiteManifest(bytes, pointer) {
  const value = parseJson(bytes);
  if (!exactKeys(value, ['schema', 'publicationId', 'revision', 'files'])
    || value.schema !== SITE_MANIFEST_SCHEMA || value.publicationId !== pointer.publicationId
    || value.revision !== pointer.revision || value.files === null || typeof value.files !== 'object'
    || Array.isArray(value.files)) unavailable();
  const entries = Object.entries(value.files);
  if (entries.length < 1 || entries.length > PUBLIC_SITE_MAX_FILES) unavailable();
  for (const [key, entry] of entries) {
    const components = publicSiteComponents(key);
    if (!components || components.join('/') !== key) unavailable();
    if (!exactKeys(entry, ['mime', 'bytes', 'sha256']) || entry.mime !== publicSiteType(key)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > PUBLIC_SITE_ASSET_MAX_BYTES
      || !SHA256.test(entry.sha256)) unavailable();
  }
  return value;
}

/**
 * Resolve one file of one immutable site revision from private app-data.
 * Fails closed with `PublicPageUnavailable` — never leaking which check failed.
 *
 * @param {string} dataRoot absolute private content root (0700, owned by us)
 * @param {string} siteId publication id (slug or hash form)
 * @param {string} relativePath bundle-relative file path, e.g. `lifetrip/index.html`
 * @returns {{ bytes: Buffer, mime: string, revision: string, epoch: number }}
 */
export function readPublicSiteAsset(dataRoot, siteId, relativePath) {
  if (!isPublicationId(siteId)) unavailable();
  const components = publicSiteComponents(relativePath);
  if (!components) unavailable();
  let root;
  const opened = [];
  try {
    root = openPrivateRoot(dataRoot);
    if (tombstoned(root, siteId)) unavailable();
    const pointers = openChildDirectory(root, 'pointers'); opened.push(pointers);
    const pointerBytes = readStableFile(pointers.fd, `${siteId}.json`, POINTER_MAX_BYTES, [pointers]);
    const pointer = parsePointer(pointerBytes, siteId);
    const bundles = openChildDirectory(root, 'bundles'); opened.push(bundles);
    const publication = openChildDirectory(bundles.fd, siteId); opened.push(publication);
    const revision = openChildDirectory(publication.fd, pointer.revision); opened.push(revision);
    const chain = [bundles, publication, revision];
    const manifestBytes = readStableFile(revision.fd, 'manifest.json', MANIFEST_MAX_BYTES, chain);
    if (digest(manifestBytes) !== pointer.manifestSha256) unavailable();
    const manifest = parseSiteManifest(manifestBytes, pointer);
    const declared = manifest.files[components.join('/')];
    if (!declared) unavailable();
    let parent = revision;
    for (const directory of components.slice(0, -1)) {
      parent = openChildDirectory(parent.fd, directory); opened.push(parent); chain.push(parent);
    }
    const bytes = readStableFile(parent.fd, components[components.length - 1], PUBLIC_SITE_ASSET_MAX_BYTES, chain);
    if (bytes.length !== declared.bytes || digest(bytes) !== declared.sha256) unavailable();
    return { bytes, mime: declared.mime, revision: pointer.revision, epoch: pointer.epoch };
  } catch (error) { if (error instanceof PublicPageUnavailable) throw error; unavailable(); }
  finally {
    for (const entry of opened.reverse()) { try { closeSync(entry.fd); } catch {} }
    try { if (root !== undefined) closeSync(root); } catch {}
  }
}
