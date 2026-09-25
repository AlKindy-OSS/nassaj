import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { withTranscriptReadPermit } from './codex-rollout-links.js';

const LIMIT = 64n * 1024n * 1024n;
const pins = new WeakSet<object>();
export type NativeRecord = Readonly<{ ordinal: number; lineSha256: string; rawLine: string; value: Readonly<Record<string, unknown>> }>;
export type ActorSource = Readonly<{ canonical: string; devDecimal: string; inoDecimal: string;
  prefixBytesDecimal: string; prefixSha256: string; records: readonly NativeRecord[];
  verify: () => Promise<void>; close: () => Promise<void> }>;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const failure = () => new Error('actor_source_unavailable');

/** Canonical bigint serialization never rounds identities through Number. */
export function actorStatDecimal(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n) throw failure();
  return value.toString(10);
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.nlink === b.nlink && a.size === b.size;
}
function ownedFile(stat: BigIntStats): boolean {
  return stat.isFile() && stat.nlink === 1n && stat.uid === BigInt(process.getuid!()) && stat.size <= LIMIT;
}
async function prefix(file: FileHandle, size: bigint, signal?: AbortSignal): Promise<Buffer> {
  const parts: Buffer[] = [];
  let position = 0n;
  while (position < size) {
    signal?.throwIfAborted();
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead || position + BigInt(bytesRead) > size) throw failure();
    parts.push(buffer.subarray(0, bytesRead)); position += BigInt(bytesRead);
  }
  return Buffer.concat(parts);
}
function immutable(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) immutable(child);
  Object.freeze(value);
}
function records(bytes: Buffer): readonly NativeRecord[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text || !text.endsWith('\n')) throw failure();
  const lines = text.slice(0, -1).split('\n');
  return Object.freeze(lines.map((line, ordinal) => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
    immutable(value);
    return Object.freeze({ ordinal, lineSha256: digest(line), rawLine: line, value: value as Readonly<Record<string, unknown>> });
  }));
}
async function openBeneath(root: string, canonical: string): Promise<FileHandle> {
  const relative = path.relative(root, canonical);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure();
  const parts = relative.split(path.sep);
  const directories = [await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  let file: FileHandle | undefined;
  try {
    for (const part of parts.slice(0, -1)) {
      directories.push(await open(`/proc/self/fd/${directories.at(-1)!.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    file = await open(`/proc/self/fd/${directories.at(-1)!.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return file;
  } finally {
    const closed = await Promise.allSettled(directories.map(directory => directory.close()));
    if (closed.some(result => result.status === 'rejected')) {
      await file?.close();
      throw failure();
    }
  }
}

/** Pin one authorized source beneath a server-derived sessions root; caller retains and finally closes it. */
export async function openActorSource(sessionsRoot: string, filePath: string, signal?: AbortSignal): Promise<ActorSource> {
  return withTranscriptReadPermit(signal, async () => {
    const root = await realpath(sessionsRoot), canonical = await realpath(filePath);
    const rootStat = await lstat(root, { bigint: true });
    const initial = await lstat(filePath, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.uid !== BigInt(process.getuid!()) || !ownedFile(initial) || initial.isSymbolicLink()) throw failure();
    const file = await openBeneath(root, canonical);
    let closed = false;
    let witness: ActorSource | undefined;
    const close = async () => { if (!closed) { closed = true; if (witness) pins.delete(witness); await file.close(); } };
    try {
      const pinned = await file.stat({ bigint: true });
      if (!ownedFile(pinned) || !sameIdentity(initial, pinned) || await realpath(`/proc/self/fd/${file.fd}`) !== canonical) throw failure();
      const bytes = await prefix(file, pinned.size, signal), prefixSha256 = digest(bytes);
      const verifyPinned = async () => {
        signal?.throwIfAborted();
        const current = await lstat(filePath, { bigint: true }), currentRoot = await lstat(root, { bigint: true });
        if (closed || !ownedFile(current) || !sameIdentity(pinned, current) || !sameIdentity(pinned, await file.stat({ bigint: true }))
          || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino || await realpath(sessionsRoot) !== root
          || await realpath(filePath) !== canonical || await realpath(`/proc/self/fd/${file.fd}`) !== canonical
          || digest(await prefix(file, pinned.size, signal)) !== prefixSha256) throw failure();
        if (!sameIdentity(pinned, await file.stat({ bigint: true }))
          || !sameIdentity(pinned, await lstat(filePath, { bigint: true })) || await realpath(filePath) !== canonical) throw failure();
      };
      const source = Object.freeze({ canonical, devDecimal: actorStatDecimal(pinned.dev), inoDecimal: actorStatDecimal(pinned.ino),
        prefixBytesDecimal: actorStatDecimal(pinned.size), prefixSha256, records: records(bytes),
        verify: () => withTranscriptReadPermit(signal, verifyPinned), close });
      await verifyPinned(); witness = source; pins.add(source); return source;
    } catch (error) { await close(); throw error; }
  });
}

/** Reject caller-created record containers; this marker is provenance, never session authorization. */
export function assertPinnedActorSource(source: ActorSource): void {
  if (!pins.has(source)) throw failure();
}
