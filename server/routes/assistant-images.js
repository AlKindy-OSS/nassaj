/**
 * assistant-images routes — serves an image the ASSISTANT referenced by an
 * absolute on-disk path inside a session's own file surface (ADR-157).
 *
 * WHY IT IS A ROUTER AND NOT AN INLINE `app.get` (mirrors chat-images.js): the
 * handler carries the whole read-access model, and a handler declared inside
 * server/index.js can only be exercised by booting the entire server. As its own
 * router it is mounted in one line and tested over real HTTP.
 *
 * ACCESS MODEL. Unlike chat-images (a capability URL to a stored attachment),
 * this endpoint accepts an arbitrary absolute path, so the boundary is the
 * allow-list of roots derived SERVER-SIDE from the session — never a value the
 * client sends. The allowed roots are exactly the session's project root and the
 * session scratchpad dir; `/home/operator` is deliberately NOT a root (qa-critic
 * ح-1, least privilege). Layered defence, in order: dot-segment rejection,
 * symlink-aware containment (reused path-guard), size cap, and a magic-bytes
 * content sniff so the Content-Type is derived from the file, not its name
 * (qa-critic ح-2) — `nosniff` then binds the browser to that verdict.
 */
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { constants as flags } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';

import express from 'express';

import { createRateLimiter } from '../middleware/rate-limit.js';
import { bindDeviceHttpResponseLifetime } from '../modules/account-wallet/connection-revocation-registry.js';

/** Largest image body served; larger files are refused with 413. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Dir name of the per-session, well-known drop folder agents are told to write
 * assistant screenshots into: `<tmpBase>/nassaj-assistant-images/<sessionId>/`.
 * A stable, announced location that does NOT depend on the scratchpad base or on
 * how the harness encodes the session cwd (B-1082).
 */
export const ASSISTANT_IMAGES_DIRNAME = 'nassaj-assistant-images';

/**
 * Identify an image type from its leading bytes (magic-bytes sniff). Only the
 * four raster formats the assistant surface allows are recognised; SVG and every
 * other type return null so the caller answers 415. The Content-Type ships from
 * THIS verdict, never from the file extension.
 *
 * @param {Buffer} head First bytes of the file (>= 12 needed for WebP).
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
export function detectImageType(head) {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e &&
      head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 &&
      head[3] === 0x38 && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
    return 'image/gif';
  }
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Encode a project root the way the harness names scratchpad dirs on disk: every
 * '/' and '.' becomes '-' (confirmed on disk, e.g. `.../nassaj-dev/.git` ->
 * `-...-nassaj-dev--git`).
 *
 * @param {string} projectRoot Absolute project root.
 * @returns {string}
 */
export function encodeProjectPathForScratchpad(projectRoot) {
  return projectRoot.replace(/[/.]/g, '-');
}

/**
 * Current process uid as a string ('' when getuid is unavailable, e.g. Windows).
 * @returns {string}
 */
function currentUid() {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '';
}

/**
 * The single primary scratchpad base the CLI writes under: `<TMPDIR>/claude-<uid>`,
 * overridable with NASSAJ_SCRATCHPAD_BASE. Kept for back-compat; the router now
 * uses {@link defaultScratchpadBases} so it tolerates a base mismatch between the
 * server process and the CLI (B-1082).
 *
 * @returns {string}
 */
export function defaultScratchpadBase() {
  if (process.env.NASSAJ_SCRATCHPAD_BASE) {
    return process.env.NASSAJ_SCRATCHPAD_BASE;
  }
  const tmp = process.env.TMPDIR || os.tmpdir();
  return path.join(tmp, `claude-${currentUid()}`);
}

/**
 * Tmp roots to search for the well-known assistant-images drop folder. WHY MORE
 * THAN ONE: the server process and the CLI can disagree on TMPDIR — pm2 runs the
 * server with `TMPDIR=/var/tmp` while the CLI's scratchpad lives under
 * `~/.cache/tmp` via NASSAJ_SCRATCHPAD_BASE (T-1737). Each returned base is a
 * DIRECTORY prefix only; the session id is appended later, so widening the base
 * list never widens access beyond a single session's own folder (B-1082).
 *
 * @returns {string[]} Deduped absolute tmp roots.
 */
export function defaultTmpBases() {
  const bases = [];
  const add = (p) => { if (validAbsoluteRoot(p) && !bases.includes(p)) bases.push(p); };
  if (process.env.TMPDIR) add(process.env.TMPDIR);
  add(os.tmpdir());
  add('/tmp');
  add('/var/tmp');
  // The CLI's tmp lives at dirname(NASSAJ_SCRATCHPAD_BASE) (e.g. ~/.cache/tmp).
  if (process.env.NASSAJ_SCRATCHPAD_BASE) add(path.dirname(process.env.NASSAJ_SCRATCHPAD_BASE));
  return bases;
}

/**
 * The `claude-<uid>` scratchpad bases to search: NASSAJ_SCRATCHPAD_BASE (the CLI's
 * own), plus `<tmpBase>/claude-<uid>` for every tmp root. Covers the server-vs-CLI
 * TMPDIR split so a screenshot under either base is reachable (B-1082).
 *
 * @returns {string[]} Deduped absolute scratchpad bases.
 */
export function defaultScratchpadBases() {
  const uid = currentUid();
  const bases = [];
  const add = (p) => { if (validAbsoluteRoot(p) && !bases.includes(p)) bases.push(p); };
  if (process.env.NASSAJ_SCRATCHPAD_BASE) add(process.env.NASSAJ_SCRATCHPAD_BASE);
  for (const tb of defaultTmpBases()) add(path.join(tb, `claude-${uid}`));
  return bases;
}

/**
 * Reconstruct a session's overlay working tree from the encoded cwd the harness
 * stored as the scratchpad/transcript dir name. A session running in a per-session
 * git overlay has cwd
 *   `<projectRoot>/.git/nassaj-session-overlays/instances/<instanceId>/workspace`
 * which the harness encodes (every '/' and '.' -> '-') to
 *   `<enc(projectRoot)>--git-nassaj-session-overlays-instances-<instanceId>-workspace`.
 * The instanceId is a UUID (no '/' or '.'), so this mapping is loss-free and the
 * path is recovered exactly. Returns null when the encoding is not an overlay cwd
 * (e.g. the session runs directly in the project root).
 *
 * @param {string} projectRoot     Absolute project root.
 * @param {string} overlayEncoding Encoded cwd dir name (basename of the jsonl dir).
 * @returns {string|null}
 */
export function deriveOverlayWorkspace(projectRoot, overlayEncoding) {
  if (!validAbsoluteRoot(projectRoot) || typeof overlayEncoding !== 'string' || !overlayEncoding) {
    return null;
  }
  const projEnc = encodeProjectPathForScratchpad(projectRoot);
  const prefix = `${projEnc}--git-nassaj-session-overlays-instances-`;
  const suffix = '-workspace';
  if (!overlayEncoding.startsWith(prefix) || !overlayEncoding.endsWith(suffix)) {
    return null;
  }
  const instanceId = overlayEncoding.slice(prefix.length, overlayEncoding.length - suffix.length);
  // A UUID instance id: letters, digits and hyphens only. Reject anything else so
  // a crafted encoding cannot inject path separators or dot segments.
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(instanceId)) {
    return null;
  }
  return path.join(projectRoot, '.git', 'nassaj-session-overlays', 'instances', instanceId, 'workspace');
}

/**
 * The per-request allow-list, derived SERVER-SIDE from session state (never from
 * the request). Roots, in order:
 *   1. the session's project root;
 *   2. its overlay working tree, when it runs in one;
 *   3. `<base>/<enc>/<sessionId>/scratchpad` for every scratchpad base × every cwd
 *      encoding (project-path encoding is always included; the overlay-cwd
 *      encoding is added when known) — this tolerates the server-vs-CLI TMPDIR
 *      split and the overlay-vs-project encoding split (B-1082);
 *   4. `<tmpBase>/nassaj-assistant-images/<sessionId>` — the announced, stable
 *      drop folder for agents.
 * `/home/<user>` and bare `/tmp` are NEVER roots: every ephemeral root ends with
 * the session id, so cross-session and cross-user isolation is preserved and the
 * downstream dot-segment + symlink-containment + size + type checks still apply.
 *
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   overlayWorkspace?: string|null,
 *   encodings?: string[],
 *   scratchpadBases?: string[],
 *   tmpBases?: string[],
 *   scratchpadBase?: string,
 * }} args
 * @returns {string[]}
 */
/** Accept only normalized absolute configuration roots, never broad OS roots. */
function validAbsoluteRoot(value) {
  return typeof value === 'string' && path.isAbsolute(value) && value !== '/'
    && path.resolve(value) === value && !/[\\\x00-\x1f\x7f]/.test(value);
}

/** Session identifiers are stored single path components, not encoded paths. */
export function validImageSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

/** Build typed server-owned roots; unrecognized transcript encodings grant nothing. */
export function deriveAllowedRoots({ projectRoot, sessionId, overlayWorkspace = null,
  encodings = [], scratchpadBases = null, tmpBases = null, scratchpadBase = null }) {
  if (!validAbsoluteRoot(projectRoot) || !validImageSessionId(sessionId)) return [];
  const roots = [{ kind: 'project', path: projectRoot }];
  const acceptedEncodings = [encodeProjectPathForScratchpad(projectRoot)];
  for (const encoding of encodings) {
    const overlay = deriveOverlayWorkspace(projectRoot, encoding);
    if (overlay && overlay === overlayWorkspace && encodeProjectPathForScratchpad(overlay) === encoding) {
      roots.push({ kind: 'overlay', path: overlay, base: projectRoot });
      acceptedEncodings.push(encoding);
    }
  }
  const bases = scratchpadBases ?? (scratchpadBase ? [scratchpadBase] : defaultScratchpadBases());
  for (const base of bases.filter(validAbsoluteRoot)) {
    for (const encoding of new Set(acceptedEncodings)) {
      roots.push({ kind: 'ephemeral', base, path: path.join(base, encoding, sessionId, 'scratchpad') });
    }
  }
  for (const base of (tmpBases ?? defaultTmpBases()).filter(validAbsoluteRoot)) {
    roots.push({ kind: 'ephemeral', base, path: path.join(base, ASSISTANT_IMAGES_DIRNAME, sessionId) });
  }
  return [...new Map(roots.map(root => [root.path, Object.freeze(root)])).values()];
}

/**
 * True when any path segment BELOW `rootAbs` starts with '.' (`.ssh`, `.env`,
 * `.git` ...). The root prefix itself is exempt — a scratchpad root legitimately
 * lives under `.cache` — so the check is on the portion relative to the root.
 *
 * @param {string} rootAbs Absolute allowed root.
 * @param {string} target  Absolute path already known to be under rootAbs.
 * @returns {boolean}
 */
export function hasDotSegment(rootAbs, target) {
  const rel = path.relative(rootAbs, target);
  if (rel === '') {
    return false;
  }
  return rel.split(path.sep).some((seg) => seg.startsWith('.'));
}

/**
 * Open the file, confirm it is a servable image, and derive its Content-Type
 * from a magic-bytes sniff. Also re-checks dot-segments on the REAL path so a
 * symlink cannot redirect onto a hidden file inside the tree.
 *
 * @param {string} rootAbs      Matched allowed root.
 * @param {string} realResolved Canonical, containment-verified path.
 * @returns {Promise<{ok:true,contentType:string,realResolved:string,size:number}|{ok:false,status:number,error:string}>}
 */
function denied(status = 403, error = 'Path not allowed') {
  return Object.assign(new Error(error), { status });
}

function sameInode(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function trustedOwner(info) { return info.uid === 0 || info.uid === process.getuid?.(); }

/**
 * Directory trust rule for ancestors of ephemeral/overlay roots and their derived
 * suffix dirs. Owner must be root or the server uid. Other-writable is
 * accepted only for a root-owned sticky dir (`/tmp`-style). Group-writable is
 * accepted only when the group is the server's proven private group (umask 002
 * hosts make `775` the norm); gid 0 never qualifies, so a root-owned `1775`
 * group-0 dir is now rejected even when sticky.
 *
 * @internal Exported for unit tests.
 * @param {import('node:fs').Stats} info fstat of the directory.
 * @param {{ sticky?: boolean, privateGid?: number|null }} [options]
 * @returns {boolean}
 */
export function trustedDirectory(info, { sticky = false, privateGid = null } = {}) {
  if (!info.isDirectory() || !trustedOwner(info)) return false;
  if (info.mode & 0o002) return sticky && info.uid === 0 && (info.mode & 0o1000) !== 0;
  if (!(info.mode & 0o020)) return true;
  return privateGid !== null && privateGid !== 0 && info.gid === privateGid;
}

/** Default identity databases; frozen so no caller can repoint the trust source. */
const DEFAULT_IDENTITY_FILES = Object.freeze({
  passwdPath: '/etc/passwd',
  groupPath: '/etc/group',
  nsswitchPath: '/etc/nsswitch.conf',
  ownerUid: 0,
});

const MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;
const NO_GROUP_PASSWORD = new Set(['x', '!', '*', '']);
const DECIMAL_ID = /^\d{1,10}$/;
const TRUSTED_NSS_SOURCES = new Set(['files', 'systemd']);
// Linear-time: every repetition is anchored by a mandatory '=' and whitespace separator.
const NSS_ACTION = /^\[\s*!?[A-Za-z]+=[A-Za-z]+(?:\s+!?[A-Za-z]+=[A-Za-z]+)*\s*\]$/;
// `initgroups` is optional; when present it decides supplementary groups, so it is held to the same rule.
const NSS_REQUIRED_DATABASES = ['passwd', 'group'];
const NSS_CHECKED_DATABASES = new Set([...NSS_REQUIRED_DATABASES, 'initgroups']);

/** Split colon files; null on any NIS compat line or any malformed non-empty line. */
function parseColonRows(text, fieldCount, numericFields) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('+') || line.startsWith('-')) return null;
    const fields = line.split(':');
    if (fields.length !== fieldCount || fields[0] === '') return null;
    if (numericFields.some(index => !DECIMAL_ID.test(fields[index]))) return null;
    rows.push(fields);
  }
  return rows;
}

/**
 * Decide from passwd/group text whether `gid` is a private group of `uid`: no
 * other account can hold it as primary or supplementary group, and it carries no
 * group password. Fails closed on NIS lines, malformed lines, or a missing gid.
 *
 * @internal Exported for unit tests.
 * @param {{ passwdText: string, groupText: string, uid: number, gid: number }} args
 * @returns {boolean}
 */
export function isPrivateGroup({ passwdText, groupText, uid, gid }) {
  if (typeof passwdText !== 'string' || typeof groupText !== 'string'
    || !Number.isInteger(uid) || !Number.isInteger(gid)) return false;
  const users = parseColonRows(passwdText, 7, [2, 3]);
  const groups = parseColonRows(groupText, 4, [2]);
  if (!users || !groups) return false;
  const serverNames = new Set(users.filter(u => Number(u[2]) === uid).map(u => u[0]));
  const matching = groups.filter(g => Number(g[2]) === gid);
  if (serverNames.size === 0 || matching.length === 0) return false;
  if (users.some(u => Number(u[3]) === gid && Number(u[2]) !== uid)) return false;
  return matching.every(([, password, , members]) => NO_GROUP_PASSWORD.has(password)
    && (members === '' || members.split(',').every(name => serverNames.has(name))));
}

/** True when an nsswitch source spec lists only files/systemd (bracket actions allowed). */
function nssSourcesTrusted(spec) {
  const actions = spec.match(/\[[^\]]*\]/g) ?? [];
  if (!actions.every(action => NSS_ACTION.test(action))) return false;
  const sources = spec.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
  return sources.length > 0 && sources.every(source => TRUSTED_NSS_SOURCES.has(source));
}

/**
 * True when nsswitch.conf resolves `passwd` and `group` (and `initgroups`, when
 * present) only from `files` and/or `systemd`. Database names match
 * case-insensitively. Well-formed `[STATUS=action]` tokens are tolerated (they only
 * order the allowed sources); a missing required line or any duplicated checked
 * line (including a case variant) fails closed.
 *
 * @internal Exported for unit tests.
 * @param {string} text nsswitch.conf content.
 * @returns {boolean}
 */
export function nsswitchTrustsLocalSources(text) {
  if (typeof text !== 'string') return false;
  const specs = new Map();
  for (const raw of text.split('\n')) {
    const match = /^([A-Za-z_]+)\s*:(.*)$/.exec(raw.replace(/#.*/, '').trim());
    const database = match?.[1].toLowerCase();
    if (!NSS_CHECKED_DATABASES.has(database)) continue;
    if (specs.has(database)) return false;
    specs.set(database, match[2]);
  }
  return NSS_REQUIRED_DATABASES.every(db => specs.has(db))
    && [...specs.values()].every(nssSourcesTrusted);
}

// Keyed by the identity-file path tuple. Paths come only from construction-time seams
// (frozen defaults in production, a few temp dirs in tests), never from requests, so the
// map stays bounded by construction.
const identityCache = new Map();
function statKey(info) { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.uid}:${info.mode}`; }

/**
 * True when an identity file can only have been written by its expected owner
 * (B-1471): owned by `ownerUid` (root for the real /etc files) and not group- or
 * other-writable. A file another account could rewrite proves nothing about who
 * shares the server's group.
 *
 * @internal Exported for unit tests.
 * @param {{ uid: number, mode: number }} info fstat result of the pinned fd.
 * @param {number} [ownerUid] Expected owner; 0 in production.
 * @returns {boolean}
 */
export function identityFileTrusted(info, ownerUid = 0) {
  return Number.isInteger(info?.uid) && info.uid === ownerUid && (info.mode & 0o022) === 0;
}

/** Read exactly `info.size` bytes from a pinned fd; null on growth, shrink or cap. */
async function readPinnedText(handle, info) {
  if (!info.isFile() || info.size > MAX_IDENTITY_FILE_BYTES) return null;
  const buffer = Buffer.alloc(info.size + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total === info.size ? buffer.toString('utf8', 0, total) : null;
}

/** Open each file once, fstat → read → fstat; cache only a stable snapshot. */
async function loadIdentityVerdict(paths, { uid, gid, ownerUid, openFile }) {
  const handles = [];
  try {
    for (const p of paths) handles.push(await openFile(p, flags.O_RDONLY | flags.O_NONBLOCK));
    const before = await Promise.all(handles.map(handle => handle.stat()));
    if (!before.every(info => identityFileTrusted(info, ownerUid))) return null;
    const key = `${uid}:${gid}:${ownerUid}|${before.map(statKey).join('|')}`;
    const cacheId = paths.join('\0');
    if (identityCache.get(cacheId)?.key === key) return identityCache.get(cacheId).value;
    const [passwdText, groupText, nsswitchText] = await Promise.all(
      handles.map((handle, index) => readPinnedText(handle, before[index])));
    const after = await Promise.all(handles.map(handle => handle.stat()));
    if ([passwdText, groupText, nsswitchText].includes(null)
      || after.some((info, index) => statKey(info) !== statKey(before[index]))) return null;
    const value = nsswitchTrustsLocalSources(nsswitchText)
      && isPrivateGroup({ passwdText, groupText, uid, gid }) ? gid : null;
    identityCache.set(cacheId, { key, value });
    return value;
  } finally {
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
  }
}

/**
 * The server's primary gid when it is provably private (see {@link isPrivateGroup})
 * and name resolution is local-only; otherwise null. Never throws.
 *
 * Each file must pass {@link identityFileTrusted} against `files.ownerUid`
 * (default 0, i.e. root-owned and not group/other-writable).
 *
 * @param {{ passwdPath: string, groupPath: string, nsswitchPath: string, ownerUid?: number }} [files]
 *   `ownerUid` is a construction-time test seam (temp files are not root-owned).
 * @param {{ openFile?: typeof open }} [internal] @internal Test-only fs seam.
 * @returns {Promise<number|null>}
 */
export async function loadPrivateGid(files = DEFAULT_IDENTITY_FILES, { openFile = open } = {}) {
  if (typeof process.getgid !== 'function' || typeof process.getuid !== 'function') return null;
  const gid = process.getgid();
  const paths = [files?.passwdPath, files?.groupPath, files?.nsswitchPath];
  if (gid === 0 || !paths.every(p => typeof p === 'string' && path.isAbsolute(p))) return null;
  const ownerUid = files.ownerUid ?? 0;
  if (!Number.isInteger(ownerUid)) return null;
  try {
    return await loadIdentityVerdict(paths, { uid: process.getuid(), gid, ownerUid, openFile });
  } catch { return null; }
}

/** Per-request lazy identity probe: loads at most once, only when a dir needs it. */
function createIdentityProbe(identityFiles) {
  let pending = null;
  return () => (pending ??= loadPrivateGid(identityFiles));
}

/** Apply {@link trustedDirectory}, consulting identity only for group-writable dirs. */
async function directoryIsTrusted(info, { sticky, probe }) {
  const needsGroup = (info.mode & 0o020) !== 0 && (info.mode & 0o002) === 0;
  const privateGid = needsGroup ? await probe() : null;
  return trustedDirectory(info, { sticky, privateGid });
}

async function closeImageChain(chain) {
  await Promise.all(chain.map(entry => entry.handle.close().catch(() => {})));
}

/** Open `name` under the chain tip without following links; `trust` null skips the dir-trust check. */
async function appendImageHandle(chain, name, directory, trust = null) {
  const parent = chain.at(-1).handle;
  const handle = await open(`/proc/self/fd/${parent.fd}/${name}`,
    flags.O_RDONLY | flags.O_NOFOLLOW | (directory ? flags.O_DIRECTORY : flags.O_NONBLOCK));
  const entry = { handle, parent, name };
  chain.push(entry);
  entry.stat = await handle.stat();
  if (directory && !entry.stat.isDirectory()) throw denied();
  if (trust && !(await directoryIsTrusted(entry.stat, trust))) throw denied();
}

async function verifyImageChain(chain) {
  for (const entry of chain.slice(1)) {
    const current = await lstat(`/proc/self/fd/${entry.parent.fd}/${entry.name}`);
    if (current.isSymbolicLink() || !sameInode(current, entry.stat)) throw denied();
  }
}

/** Pin the canonical trusted base and never follow a symlink in derived suffixes. */
async function openImageRoot(root, chain, probe) {
  const base = root.base ?? root.path;
  const trusted = root.kind !== 'project';
  const canonicalBase = await realpath(base);
  const handle = await open('/', flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW);
  chain.push({ handle, stat: await handle.stat() });
  const ancestorTrust = trusted ? { sticky: true, probe } : null;
  for (const part of canonicalBase.split('/').filter(Boolean)) {
    await appendImageHandle(chain, part, true, ancestorTrust);
  }
  const baseTrust = { sticky: ['/tmp', '/var/tmp'].includes(base), probe };
  if (trusted && !(await directoryIsTrusted(chain.at(-1).stat, baseTrust))) throw denied();
  const suffix = path.relative(base, root.path);
  if (suffix.startsWith('..') || path.isAbsolute(suffix)) throw denied();
  for (const part of suffix.split('/').filter(Boolean)) {
    await appendImageHandle(chain, part, true, { sticky: false, probe });
  }
  return suffix ? path.join(canonicalBase, suffix) : canonicalBase;
}

/** Inspect and retain a single descriptor; no pathname is reopened for streaming. */
async function openImageWithinRoot(root, requestedPath, identityFiles) {
  const chain = [];
  try {
    if (process.platform !== 'linux') throw denied();
    const canonicalRoot = await openImageRoot(root, chain, createIdentityProbe(identityFiles));
    const canonicalTarget = await realpath(requestedPath);
    if (!canonicalTarget.startsWith(canonicalRoot + path.sep)
      || hasDotSegment(canonicalRoot, canonicalTarget)) throw denied();
    const parts = path.relative(canonicalRoot, canonicalTarget).split(path.sep);
    for (const [index, part] of parts.entries()) await appendImageHandle(chain, part, index < parts.length - 1);
    const leaf = chain.at(-1);
    if (!leaf.stat.isFile()) throw denied(404, 'Image not found');
    if (leaf.stat.size > MAX_IMAGE_BYTES) throw denied(413, 'Image too large');
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await leaf.handle.read(bytes, 0, 16, 0);
    const contentType = detectImageType(bytes.subarray(0, bytesRead));
    if (!contentType) throw denied(415, 'Unsupported image type');
    await verifyImageChain(chain);
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await closeImageChain(chain); } };
    const verify = async () => {
      await verifyImageChain(chain);
      const current = await leaf.handle.stat();
      if (!sameInode(current, leaf.stat) || current.size !== leaf.stat.size
        || current.mtimeMs !== leaf.stat.mtimeMs || current.ctimeMs !== leaf.stat.ctimeMs) throw denied();
    };
    return { ok: true, contentType, realResolved: canonicalTarget, size: leaf.stat.size,
      handle: leaf.handle, close, verify };
  } catch (error) { await closeImageChain(chain); throw error; }
}

/**
 * Resolve against the deepest typed root, with no broader-root fallback.
 *
 * @param {Array<string|object>} allowedRoots Server-derived typed roots.
 * @param {string} requestedPath Absolute path to serve.
 * @param {{ retainHandle?: boolean,
 *   identityFiles?: { passwdPath: string, groupPath: string, nsswitchPath: string, ownerUid?: number } }} [options]
 *   `identityFiles` is a server-side test seam only; it defaults to the frozen system files.
 */
export async function resolveImageWithinRoots(allowedRoots, requestedPath,
  { retainHandle = false, identityFiles = DEFAULT_IDENTITY_FILES } = {}) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)
    || /[\\\x00-\x1f\x7f]/.test(requestedPath)) return { ok: false, status: 400, error: 'Invalid image path' };
  if (requestedPath.split('/').some(part => part === '.' || part === '..')) {
    return { ok: false, status: 403, error: 'Path not allowed' };
  }
  const resolved = path.resolve(requestedPath);
  const roots = allowedRoots.map(root => typeof root === 'string' ? { kind: 'project', path: root } : root);
  const root = roots.filter(item => resolved.startsWith(item.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!root || hasDotSegment(root.path, resolved)) return { ok: false, status: 403, error: 'Path not allowed' };
  try {
    const result = await openImageWithinRoot(root, requestedPath, identityFiles);
    if (!retainHandle) { await result.close(); return { ok: true, contentType: result.contentType,
      realResolved: result.realResolved, size: result.size }; }
    return result;
  } catch (error) {
    const status = error.status ?? (error.code === 'ENOENT' ? 404 : 403);
    return { ok: false, status, error: status === 404 ? 'Image not found' : error.status ? error.message : 'Path not allowed' };
  }
}

/** Apply the hardening + cache headers to an image response. */
function setImageHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
}

/**
 * @param {{
 *   authenticateToken: import('express').RequestHandler,
 *   resolveAllowedRoots: (sessionId: string, userId: unknown) =>
 *     { roots: Array<string|object>, isCurrent: () => boolean } | null,
 *   limiter?: import('express').RequestHandler,
 *   identityFiles?: { passwdPath: string, groupPath: string, nsswitchPath: string, ownerUid?: number },
 * }} deps `identityFiles` is a construction-time test seam; never taken from a request.
 * @returns {import('express').Router}
 */
export function createAssistantImagesRouter({ authenticateToken, resolveAllowedRoots, limiter,
  identityFiles = DEFAULT_IDENTITY_FILES }) {
  const router = express.Router();
  const gate = limiter || createRateLimiter({
    windowMs: 60_000,
    max: 120,
    message: 'Too many image requests, please slow down',
  });

  router.get('/', gate, authenticateToken, async (req, res) => {
    const identityIsCurrent = () => typeof req.assertCurrentIdentity === 'function'
      && req.assertCurrentIdentity() === true;
    if (!identityIsCurrent()) {
      return res.status(409).set('Cache-Control', 'no-store').json({
        error: 'Identity changed during request', code: 'identity_changed', notStarted: true,
      });
    }
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
    if (!requestedPath || !validImageSessionId(sessionId) || !path.isAbsolute(requestedPath)) {
      return res.status(400).json({ error: 'Invalid image request' });
    }

    // Ownership + root derivation happen SERVER-SIDE from session state; a
    // null result means the session is unknown or not owned by the caller.
    const access = resolveAllowedRoots(sessionId, req.user?.id);
    const allowedRoots = access?.roots;
    if (!access || !Array.isArray(allowedRoots) || allowedRoots.length === 0
        || typeof access.isCurrent !== 'function' || access.isCurrent() !== true) {
      return res.status(403).json({ error: 'Session not accessible' });
    }

    let opened;
    try {
      const result = await resolveImageWithinRoots(allowedRoots, requestedPath,
        { retainHandle: true, identityFiles });
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      opened = result;
      await result.verify();
      if (res.destroyed || req.aborted) return undefined;
      if (!identityIsCurrent()) {
        return res.status(409).set('Cache-Control', 'no-store').json({
          error: 'Identity changed during request', code: 'identity_changed',
          notStarted: false, effectState: 'outcome_unknown',
        });
      }
      if (access.isCurrent() !== true) {
        return res.status(409).set('Cache-Control', 'no-store').json({
          error: 'Project access changed during request', code: 'project_access_changed',
          notStarted: false, effectState: 'outcome_unknown',
        });
      }
      const stream = result.handle.createReadStream({ autoClose: false, start: 0, end: result.size - 1 });
      if (!bindDeviceHttpResponseLifetime(req.user, res, () => stream.destroy())) return undefined;
      if (!identityIsCurrent() || access.isCurrent() !== true) {
        stream.destroy();
        return res.status(409).set('Cache-Control', 'no-store').json({
          error: !identityIsCurrent()
            ? 'Identity changed during request' : 'Project access changed during request',
          code: !identityIsCurrent() ? 'identity_changed' : 'project_access_changed',
          notStarted: false, effectState: 'outcome_unknown',
        });
      }
      setImageHeaders(res, result.contentType);
      res.once('close', () => { stream.destroy(); void result.close(); });
      stream.once('close', () => { void result.close(); });
      stream.once('end', () => { void result.close(); });
      opened = null;
      stream.on('error', () => {
        void result.close();
        if (res.headersSent) {
          res.destroy();
        } else {
          res.status(500).json({ error: 'Failed to load image' });
        }
      });
      for await (const chunk of stream) {
        if (!identityIsCurrent() || access.isCurrent() !== true) {
          stream.destroy();
          res.destroy();
          return undefined;
        }
        if (!res.write(chunk)) {
          await once(res, 'drain');
          if (!identityIsCurrent() || access.isCurrent() !== true) {
            stream.destroy();
            res.destroy();
            return undefined;
          }
        }
      }
      if (!identityIsCurrent() || access.isCurrent() !== true) {
        res.destroy();
        return undefined;
      }
      res.end();
      return undefined;
    } catch (error) {
      // No path in the log line (avoids leaking absolute paths into logs).
      console.error('assistant-images: failed to serve image:', error?.code || 'read_failed');
      return res.status(error?.status || 500).json({ error: 'Failed to load image' });
    } finally {
      if (opened) await opened.close();
    }
  });

  return router;
}
