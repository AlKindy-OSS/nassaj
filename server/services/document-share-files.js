import { constants as flags, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
const EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.txt', '.md', '.csv', '.html', '.htm', '.xhtml']);

/** A public, deliberately path-free document error. */
export class DocumentShareError extends Error {
  constructor(code, status = 404) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Accept only ordinary documents below the project's doc/docs directory. */
export function isShareableDocument(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length > 1024) return false;
  const parts = relativePath.split('/');
  return ['doc', 'docs'].includes(parts[0]) && parts.length > 1
    && parts.every((part) => part && !part.startsWith('.') && !/[\\\x00-\x1f\x7f:%]/.test(part))
    && EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function assertRoot(root) {
  if (process.platform !== 'linux' || typeof root !== 'string' || !path.isAbsolute(root)
      || root === '/' || path.resolve(root) !== root || /[\x00-\x1f]/.test(root)
      || /^\/(?:tmp|proc|sys|dev)(?:\/|$)/.test(root)
      || root.split('/').some((part) => part.startsWith('.') || /^(?:dist|dist-server|node_modules|releases)$/.test(part))) {
    throw new DocumentShareError('SHARE_UNAVAILABLE');
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function assertOrdinary(stat) {
  if (!stat.isFile() || stat.nlink !== 1) throw new DocumentShareError('SHARE_UNAVAILABLE');
  if (stat.size > DOCUMENT_MAX_BYTES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
}

/** Recheck every pinned edge, not merely a lexical prefix or final symlink. */
async function verifyChain(chain) {
  for (const entry of chain.slice(1)) {
    const current = await fs.lstat(`/proc/self/fd/${entry.parent.fd}/${entry.name}`);
    if (current.isSymbolicLink() || !sameFile(current, entry.stat)) {
      throw new DocumentShareError('DOCUMENT_BUSY', 409);
    }
  }
}

async function closeChain(chain) {
  await Promise.all(chain.map(({ handle }) => handle.close().catch(() => {})));
}

async function appendHandle(chain, name, directory) {
  const parent = chain.at(-1).handle;
  const mode = flags.O_RDONLY | flags.O_NOFOLLOW | (directory ? flags.O_DIRECTORY : flags.O_NONBLOCK);
  const handle = await fs.open(`/proc/self/fd/${parent.fd}/${name}`, mode);
  const entry = { handle, parent, name, stat: null };
  chain.push(entry);
  entry.stat = await handle.stat();
  if (directory && !entry.stat.isDirectory()) throw new DocumentShareError('SHARE_UNAVAILABLE');
}

async function openVerifiedFile(root, relativePath, identity, validatePath) {
  assertRoot(root);
  if (!validatePath(relativePath)) throw new DocumentShareError('INVALID_INPUT', 400);
  const handle = await fs.open('/', flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW);
  const chain = [{ handle, stat: await handle.stat() }];
  try {
    for (const segment of root.slice(1).split('/')) await appendHandle(chain, segment, true);
    const rootStat = chain.at(-1).stat;
    if (identity && (String(rootStat.dev) !== identity.root_dev || String(rootStat.ino) !== identity.root_ino)) {
      throw new DocumentShareError('SHARE_UNAVAILABLE');
    }
    const parts = relativePath.split('/');
    for (let i = 0; i < parts.length; i++) await appendHandle(chain, parts[i], i < parts.length - 1);
    assertOrdinary(chain.at(-1).stat);
    await verifyChain(chain);
    return { chain, rootStat, leaf: chain.at(-1) };
  } catch (error) {
    await closeChain(chain);
    throw error;
  }
}

async function openDocument(root, relativePath, identity) {
  return openVerifiedFile(root, relativePath, identity, isShareableDocument);
}

/** Inspect a pinned regular document and close every descriptor on all paths. */
export async function inspectSharedDocument(root, relativePath, identity) {
  const opened = await openDocument(root, relativePath, identity);
  try {
    return { size: opened.leaf.stat.size, modifiedAt: opened.leaf.stat.mtime.toISOString(),
      root_dev: String(opened.rootStat.dev), root_ino: String(opened.rootStat.ino) };
  } finally {
    await closeChain(opened.chain);
  }
}

/** Read a bounded complete version from the verified descriptor, never its pathname. */
export async function readSharedDocument(root, relativePath, identity, signal, maxBytes = DOCUMENT_MAX_BYTES) {
  const opened = await openDocument(root, relativePath, identity);
  try {
    const { handle, stat: before } = opened.leaf;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || before.size > maxBytes) {
      throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw new DocumentShareError('REQUEST_CANCELLED', 499);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!bytesRead) throw new DocumentShareError('DOCUMENT_BUSY', 409);
      offset += bytesRead;
    }
    const after = await handle.stat();
    assertOrdinary(after);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new DocumentShareError('DOCUMENT_BUSY', 409);
    }
    // An atomic save replaces the leaf; retry instead of sending stale mixed data.
    await verifyChain(opened.chain);
    return bytes;
  } finally {
    await closeChain(opened.chain);
  }
}

function pageAssetPath(pagePath, reference, sourcePath = pagePath) {
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 512
    || reference.includes('\\') || /[\x00-\x1f\x7f]/.test(reference)
    || /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) return null;
  const pageDirectory = path.posix.dirname(pagePath);
  const stem = path.posix.basename(pagePath, path.posix.extname(pagePath));
  const scope = path.posix.join(pageDirectory, `${stem}.assets`);
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), reference));
  const segments = candidate.split('/');
  return candidate.startsWith(`${scope}/`) && segments.every((part) => part && !part.startsWith('.') && !/[\\\x00-\x1f\x7f:%]/.test(part)) ? candidate : null;
}

/** Read one ordinary local preview asset confined to the page's sibling assets directory. */
export async function readSharedPageAsset(root, pagePath, reference, identity, signal, sourcePath = pagePath) {
  const relativePath = pageAssetPath(pagePath, reference, sourcePath);
  if (!relativePath) throw new DocumentShareError('SHARE_UNAVAILABLE');
  const opened = await openVerifiedFile(root, relativePath, identity, (value) => value === relativePath);
  try {
    const { handle, stat: before } = opened.leaf;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw new DocumentShareError('REQUEST_CANCELLED', 499);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!bytesRead) throw new DocumentShareError('DOCUMENT_BUSY', 409);
      offset += bytesRead;
    }
    const after = await handle.stat();
    assertOrdinary(after);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new DocumentShareError('DOCUMENT_BUSY', 409);
    }
    await verifyChain(opened.chain);
    return { bytes, relativePath };
  } finally {
    await closeChain(opened.chain);
  }
}

/** Returns the visible, fixed asset scope without resolving a caller supplied path. */
export function sharedPageAssetScope(pagePath) {
  if (!isShareableDocument(pagePath) || !['.html', '.htm', '.xhtml'].includes(path.extname(pagePath).toLowerCase())) return null;
  return path.posix.join(path.posix.dirname(pagePath), `${path.posix.basename(pagePath, path.posix.extname(pagePath))}.assets`);
}

/** Atomically save supported editor documents while retaining ordinary permission bits. */
export async function saveSharedDocumentAtomically(root, relativePath, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > DOCUMENT_MAX_BYTES) {
    throw new DocumentShareError('INVALID_INPUT', 400);
  }
  const opened = await openDocument(root, relativePath);
  const directory = `/proc/self/fd/${opened.leaf.parent.fd}`;
  const temporary = `${directory}/.nassaj-document-${randomUUID()}`;
  let staged;
  try {
    staged = await fs.open(temporary, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, opened.leaf.stat.mode & 0o777);
    await staged.chmod(opened.leaf.stat.mode & 0o777);
    await staged.writeFile(content, 'utf8');
    await staged.sync();
    await staged.close();
    staged = null;
    await verifyChain(opened.chain);
    await fs.rename(temporary, `${directory}/${opened.leaf.name}`);
    await opened.leaf.parent.sync();
  } finally {
    await staged?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    await closeChain(opened.chain);
  }
}
