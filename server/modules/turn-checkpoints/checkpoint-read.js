/**
 * T-2095 candidate reader. Opens a work-tree path through a held directory
 * descriptor chain (no parent symlink can redirect it), never follows the final
 * component, reads the bytes once and returns exactly those bytes. Symlinks
 * yield their link text. Anything that is not a regular file or a symlink is
 * reported, never read.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

import { classifyCheckpointStat } from './checkpoint-filter.js';

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const GONE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

async function openParentChain(workTree, segments) {
  const handles = [await fs.open(workTree, DIR_FLAGS)];
  try {
    for (const segment of segments.slice(0, -1)) {
      handles.push(await fs.open(`/proc/self/fd/${handles.at(-1).fd}/${segment}`, DIR_FLAGS));
    }
    return handles;
  } catch (error) {
    await closeAll(handles);
    throw error;
  }
}

async function closeAll(handles) {
  for (const handle of handles.reverse()) await handle.close().catch(() => {});
}

async function readRegularFile(location, fileBytes) {
  const handle = await fs.open(location, FILE_FLAGS);
  try {
    const stat = await handle.stat();
    const reason = classifyCheckpointStat(stat, fileBytes);
    if (reason) return { kind: 'withheld', reason, ...(reason === 'too_large' ? { size: stat.size } : {}) };
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > fileBytes) return { kind: 'withheld', reason: 'too_large', size: bytesRead };
    return { kind: 'file', body: buffer.subarray(0, bytesRead), mode: stat.mode & 0o111 ? '100755' : '100644' };
  } finally {
    await handle.close();
  }
}

/**
 * Reads one candidate path.
 * @param {string} workTree absolute overlay root
 * @param {string} relativePath git path (forward slashes)
 * @param {number} fileBytes per-file cap
 * @returns {Promise<{kind: 'deleted'} | {kind: 'skip'} | {kind: 'withheld', reason: string, size?: number}
 *   | {kind: 'file', body: Buffer, mode: string}>}
 */
export async function readCandidate(workTree, relativePath, fileBytes) {
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return { kind: 'skip' };
  let handles;
  try {
    handles = await openParentChain(workTree, segments);
  } catch (error) {
    if (GONE.has(error?.code)) return { kind: 'deleted' };
    throw error;
  }
  try {
    const location = `/proc/self/fd/${handles.at(-1).fd}/${segments.at(-1)}`;
    let stat;
    try { stat = await fs.lstat(location); } catch (error) {
      if (GONE.has(error?.code)) return { kind: 'deleted' };
      throw error;
    }
    if (stat.isDirectory()) return { kind: 'skip' };
    if (stat.isSymbolicLink()) return { kind: 'file', body: await fs.readlink(location, { encoding: 'buffer' }), mode: '120000' };
    const reason = classifyCheckpointStat(stat, fileBytes);
    if (reason) return { kind: 'withheld', reason, ...(reason === 'too_large' ? { size: stat.size } : {}) };
    return await readRegularFile(location, fileBytes);
  } finally {
    await closeAll(handles);
  }
}
