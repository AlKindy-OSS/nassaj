import type { BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';

import { listPinnedDirectory, openPinned, PinnedOpenError, type PinnedHandle, type PinnedRefusal } from './pinned-fd.js';
import type { SessionTranscriptHandle } from './session-transcript-reader.js';
import { verifyClaudeHeader, type HeaderVerdict } from './session-transcript-specs.js';
import { AMBIGUOUS_HEADER_VALUE, scanHeaderRecords } from './transcript-header-scan.js';

/**
 * B-1607 — removal of the files a provider derives from one session, beside
 * its admitted transcript: Claude `<id>/subagents` and `<id>/workflows`,
 * Codex child rollouts, and the agy brain directory `<brain>/<id>`.
 *
 * Every directory is reached from the pinned parent of the admitted
 * transcript (never from a stored path) and opened with
 * `O_DIRECTORY|O_NOFOLLOW` through its pinned parent descriptor, so a symlink
 * anywhere on the way is refused, never followed. A child file is pinned the
 * same way as a single-link regular file and removed through the transcript
 * primitive's own park / verify / unlink step (passed in as `unlink`). A
 * symlink, a hard-linked file, a special file, or a file whose header names
 * another session is kept. An emptied directory is removed only while it is
 * still the directory that was walked. Leaving a file behind is acceptable;
 * removing the wrong one is not.
 *
 * Binding per provider:
 *   - Claude: the `<id>` directory is named after the admitted `<id>.jsonl`;
 *     a `.jsonl` child whose header carries another `sessionId` is kept.
 *   - Codex: a rollout in the transcript's day directory or the next
 *     {@link CODEX_CHILD_DAYS} days is a child only when its name ends with
 *     the UUID its `session_meta.payload.id` carries, that id is not the
 *     session's and has no `sessions` row of its own, its
 *     `payload.session_id` is the session id, and its `thread_source` marks
 *     a subagent (never a user fork).
 *   - agy: the brain directory is removed only when its name (the first
 *     segment below the provider root) equals the session id.
 */

/** Removal of one child through its pinned directory; null when removed (see session-transcript-removal.ts). */
export type ChildUnlink = (dirFd: number, name: string, pinned: BigIntStats) => Promise<string | null>;

/** What happened to the derived files of one session. `retry` is the first retryable refusal. */
export type ArtifactOutcome = { removed: number; kept: number; retry: string | null };

type PinnedDir = { handle: PinnedHandle['handle']; realpath: string; stat: BigIntStats };

type Walk = {
  unlink: ChildUnlink;
  isRetryable: (reason: string) => boolean;
  /** False keeps a pinned child file (not this session's). */
  accept: (child: PinnedHandle) => Promise<boolean>;
  /** Identity never touched by the walk (the transcript itself). */
  spare: BigIntStats | null;
  outcome: ArtifactOutcome;
  budget: { entries: number };
};

const PROC_FD_DIR = '/proc/self/fd';
/** Deepest directory level walked below an artifact root (agy brains reach 4). */
const MAX_DEPTH = 8;
/** Entries listed per session before the walk stops (the rest is left behind). */
const MAX_ENTRIES = 50_000;
/** Day directories after the transcript's own that may hold Codex children (host max observed: 7). */
export const CODEX_CHILD_DAYS = 7;
const CLAUDE_ARTIFACT_DIRS = ['subagents', 'workflows'];
const CODEX_ROLLOUT = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** `/proc/self/fd/<dir>/<name>`: the child spelled through its pinned directory. */
function through(dir: PinnedDir, name: string): string {
  return path.join(PROC_FD_DIR, String(dir.handle.fd), name);
}

function refusalOf(error: unknown): PinnedRefusal {
  return error instanceof PinnedOpenError ? error.reason : 'io_error';
}

/** Pinned subdirectory `name` of `dir`, opened through its descriptor; or the refusal. */
async function openChildDir(dir: PinnedDir, name: string): Promise<PinnedDir | PinnedRefusal> {
  try {
    return await openPinned(path.join(dir.realpath, name), 'directory', { via: through(dir, name) });
  } catch (error) {
    return refusalOf(error);
  }
}

/** Pinned directory at the absolute realpath `expected`; or the refusal. */
async function openDirAt(expected: string): Promise<PinnedDir | PinnedRefusal> {
  try {
    return await openPinned(expected, 'directory');
  } catch (error) {
    return refusalOf(error);
  }
}

/** Counts a refused child: kept, and the first retryable reason is remembered. */
function keep(walk: Walk, reason: string): void {
  if (reason === 'missing') return;
  walk.outcome.kept += 1;
  if (walk.isRetryable(reason)) walk.outcome.retry ??= reason;
}

/** Removes the empty directory `name` of `dir` only while it is still `walked`; failures leave it. */
async function removeEmptyDir(dir: PinnedDir, name: string, walked: BigIntStats): Promise<void> {
  const now = await fsp.lstat(through(dir, name), { bigint: true }).catch(() => null);
  if (!now?.isDirectory() || now.dev !== walked.dev || now.ino !== walked.ino) return;
  await fsp.rmdir(through(dir, name)).catch(() => undefined);
}

/** One regular child file of `dir`: pinned single-link, bound by `accept`, then unlinked. */
async function removeChildFile(dir: PinnedDir, name: string, walk: Walk): Promise<void> {
  let child: PinnedHandle;
  try {
    child = await openPinned(path.join(dir.realpath, name), 'file', { singleLink: true, via: through(dir, name) });
  } catch (error) {
    keep(walk, refusalOf(error));
    return;
  }
  try {
    if (walk.spare && child.stat.dev === walk.spare.dev && child.stat.ino === walk.spare.ino) return;
    if (!(await walk.accept(child))) {
      walk.outcome.kept += 1;
      return;
    }
    const refused = await walk.unlink(dir.handle.fd, name, child.stat);
    if (refused === null) walk.outcome.removed += 1;
    else keep(walk, refused);
  } finally {
    await child.handle.close().catch(() => undefined);
  }
}

/** One entry of `dir`, by its own (never followed) kind. */
async function removeEntry(dir: PinnedDir, name: string, depth: number, walk: Walk): Promise<void> {
  const stat = await fsp.lstat(through(dir, name), { bigint: true }).catch(() => null);
  if (!stat) return;
  if (stat.isFile()) return removeChildFile(dir, name, walk);
  if (!stat.isDirectory() || depth >= MAX_DEPTH) {
    walk.outcome.kept += 1;
    return;
  }
  await removeSubtree(dir, name, depth + 1, walk);
}

/** Walks `dir` (already pinned) and removes what it may; never throws. */
async function removeContents(dir: PinnedDir, depth: number, walk: Walk): Promise<void> {
  let names: string[];
  try {
    names = await listPinnedDirectory(dir.handle, walk.budget.entries);
  } catch (error) {
    keep(walk, refusalOf(error));
    return;
  }
  walk.budget.entries -= names.length;
  for (const name of names) await removeEntry(dir, name, depth, walk);
}

/** Subdirectory `name` of `dir`: pinned, emptied, then removed if it is empty and unchanged. */
async function removeSubtree(dir: PinnedDir, name: string, depth: number, walk: Walk): Promise<void> {
  const child = await openChildDir(dir, name);
  if (typeof child === 'string') {
    keep(walk, child);
    return;
  }
  try {
    await removeContents(child, depth, walk);
  } finally {
    await child.handle.close().catch(() => undefined);
  }
  await removeEmptyDir(dir, name, child.stat);
}

function newWalk(unlink: ChildUnlink, isRetryable: (reason: string) => boolean, spare: BigIntStats | null,
  accept: Walk['accept'] = async () => true): Walk {
  return { unlink, isRetryable, accept, spare, outcome: { removed: 0, kept: 0, retry: null }, budget: { entries: MAX_ENTRIES } };
}

/** Claude: a `.jsonl` child is kept when its header names another session. */
function claudeChildBinder(sessionId: string): Walk['accept'] {
  return async (child) => {
    if (!child.realpath.endsWith('.jsonl')) return true;
    const verdict: HeaderVerdict = await verifyClaudeHeader(sessionId,
      (paths, visit) => scanHeaderRecords(child.handle, paths, visit)).catch(() => 'id_mismatch' as const);
    return verdict === null || verdict === 'header_missing';
  };
}

/** Claude `<parent>/<id>/{subagents,workflows}`, then `<id>` itself when it is left empty. */
async function removeClaudeArtifacts(transcript: SessionTranscriptHandle, parent: PinnedDir, walk: Walk): Promise<void> {
  const stem = path.basename(transcript.realpath, '.jsonl');
  if (stem !== transcript.sessionId) return;
  const sessionDir = await openChildDir(parent, stem);
  if (typeof sessionDir === 'string') {
    keep(walk, sessionDir);
    return;
  }
  try {
    const present = new Set(await listPinnedDirectory(sessionDir.handle, MAX_ENTRIES));
    for (const name of CLAUDE_ARTIFACT_DIRS) if (present.has(name)) await removeSubtree(sessionDir, name, 1, walk);
  } catch (error) {
    keep(walk, refusalOf(error));
  } finally {
    await sessionDir.handle.close().catch(() => undefined);
  }
  await removeEmptyDir(parent, stem, sessionDir.stat);
}

/**
 * Conversation the pinned rollout `childId` is a SUBAGENT thread of: its first
 * record is `session_meta` with `payload.id` = `childId` (its file name), a
 * different `payload.session_id`, and `payload.thread_source` present and not
 * `'user'`; null otherwise. qa C1: a back-reference alone also marks a MANUAL
 * user fork (thread_source `'user'`), which is its own conversation and row
 * (classifyCodexThread, codex-session-synchronizer.provider.ts) — so the legacy
 * back-reference-only shape is never treated as a child here. A thread marked
 * only by a `source` object (no thread_source; none on this host, 2026-10-13:
 * all 1,938 children carry thread_source 'subagent') is left behind.
 */
async function codexParentOf(child: PinnedHandle, childId: string): Promise<string | null> {
  let parent: string | null = null;
  const paths = [['type'], ['payload', 'id'], ['payload', 'session_id'], ['payload', 'thread_source']];
  const end = await scanHeaderRecords(child.handle, paths, (record) => {
    const root = record['payload.session_id'];
    const source = record['payload.thread_source'];
    const subagent = Boolean(source) && source !== 'user' && source !== AMBIGUOUS_HEADER_VALUE;
    if (record.type === 'session_meta' && record['payload.id'] === childId && root && root !== childId && subagent) parent = root;
    return 'stop';
  }).catch(() => 'oversize' as const);
  return end === 'oversize' ? null : parent;
}

/** qa C1: a thread with its own `sessions` row is a conversation of its own, never a child to remove. */
function hasOwnRow(threadId: string): boolean {
  try {
    return sessionsDb.getSessionById(threadId) !== null;
  } catch {
    return true;
  }
}

/** True when the pinned rollout is a child thread of `parentId` named after its own id. */
async function isCodexChildOf(parentId: string, child: PinnedHandle, childId: string): Promise<boolean> {
  return (await codexParentOf(child, childId)) === parentId;
}

/** Child rollout names of one day directory, by the conversation they belong to. */
type CodexDayIndex = Map<string, string[]>;

/**
 * Shared by the removals of one delete (T8): each Codex day directory is
 * indexed once (one header read per rollout) instead of once per session. The
 * index only nominates candidates; every child is pinned and bound again
 * right before its removal.
 */
export type ArtifactContext = { codexDays: Map<string, Promise<CodexDayIndex | PinnedRefusal>> };

export function createArtifactContext(): ArtifactContext {
  return { codexDays: new Map() };
}

/** Parent of the rollout `name` in `dir` (pinned single-link, header-bound), or null. */
async function indexedParentOf(dir: PinnedDir, name: string, childId: string): Promise<string | null> {
  try {
    const child = await openPinned(path.join(dir.realpath, name), 'file', { singleLink: true, via: through(dir, name) });
    try {
      return await codexParentOf(child, childId);
    } finally {
      await child.handle.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

async function indexCodexDay(dayDir: string): Promise<CodexDayIndex | PinnedRefusal> {
  const dir = await openDirAt(dayDir);
  if (typeof dir === 'string') return dir;
  try {
    const index: CodexDayIndex = new Map();
    for (const name of await listPinnedDirectory(dir.handle, MAX_ENTRIES)) {
      const match = CODEX_ROLLOUT.exec(name);
      const parent = match ? await indexedParentOf(dir, name, match[2]) : null;
      if (parent) index.set(parent, [...(index.get(parent) ?? []), name]);
    }
    return index;
  } catch (error) {
    return refusalOf(error);
  } finally {
    await dir.handle.close().catch(() => undefined);
  }
}

function codexDayIndex(context: ArtifactContext, dayDir: string): Promise<CodexDayIndex | PinnedRefusal> {
  let index = context.codexDays.get(dayDir);
  if (!index) {
    index = indexCodexDay(dayDir);
    context.codexDays.set(dayDir, index);
  }
  return index;
}

/** `YYYY/MM/DD` day directories from the transcript's own day through {@link CODEX_CHILD_DAYS} days later. */
function codexDayDirs(root: string, realpath: string): string[] {
  const segments = path.relative(root, realpath).split(path.sep);
  if (segments.length !== 4 || !segments.slice(0, 3).every((segment) => /^\d+$/.test(segment))) return [];
  const [year, month, day] = segments.slice(0, 3).map(Number);
  return Array.from({ length: CODEX_CHILD_DAYS + 1 }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    const pad = (value: number) => String(value).padStart(2, '0');
    return path.join(root, String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate()));
  });
}

/**
 * One name-matched rollout: removed only when pinned single-link and bound to
 * `parentId` by its header. Anything that cannot be pinned or bound is not
 * provably this session's child and is left without being counted.
 */
async function removeCodexChild(dir: PinnedDir, name: string, parentId: string, childId: string, walk: Walk): Promise<void> {
  let child: PinnedHandle;
  try {
    child = await openPinned(path.join(dir.realpath, name), 'file', { singleLink: true, via: through(dir, name) });
  } catch {
    return;
  }
  try {
    if (hasOwnRow(childId) || !(await isCodexChildOf(parentId, child, childId))) return;
    const refused = await walk.unlink(dir.handle.fd, name, child.stat);
    if (refused === null) walk.outcome.removed += 1;
    else keep(walk, refused);
  } finally {
    await child.handle.close().catch(() => undefined);
  }
}

/** Child rollouts of `parentId` in one day directory (indexed by header, then re-bound one by one). */
async function removeCodexChildrenIn(
  dayDir: string, parentId: string, stamp: string, walk: Walk, context: ArtifactContext,
): Promise<void> {
  const index = await codexDayIndex(context, dayDir);
  if (typeof index === 'string') {
    if (index !== 'missing') keep(walk, index);
    return;
  }
  // A child starts at or after its parent; same-format stamps compare as text.
  const names = (index.get(parentId) ?? []).filter((name) => {
    const match = CODEX_ROLLOUT.exec(name);
    return match !== null && match[2] !== parentId && match[1] >= stamp;
  });
  if (names.length === 0) return;
  const dir = await openDirAt(dayDir);
  if (typeof dir === 'string') {
    keep(walk, dir);
    return;
  }
  try {
    for (const name of names) await removeCodexChild(dir, name, parentId, CODEX_ROLLOUT.exec(name)![2], walk);
  } finally {
    await dir.handle.close().catch(() => undefined);
  }
}

/** Codex child rollouts of a conversation-root rollout under the sessions root. */
async function removeCodexChildren(transcript: SessionTranscriptHandle, walk: Walk, context: ArtifactContext): Promise<void> {
  const root = transcript.root;
  const match = CODEX_ROLLOUT.exec(path.basename(transcript.realpath));
  if (!root || !match || match[2] !== transcript.sessionId) return;
  for (const dayDir of codexDayDirs(root, transcript.realpath)) {
    await removeCodexChildrenIn(dayDir, transcript.sessionId, match[1], walk, context);
  }
}

/** agy `<root>/<id>`: everything but the transcript (removed by the caller), when `<id>` is the session id. */
async function removeAgyBrain(transcript: SessionTranscriptHandle, walk: Walk): Promise<void> {
  const root = transcript.root;
  if (!root || path.relative(root, transcript.realpath).split(path.sep)[0] !== transcript.sessionId) return;
  const rootDir = await openDirAt(root);
  if (typeof rootDir === 'string') {
    keep(walk, rootDir);
    return;
  }
  try {
    await removeSubtree(rootDir, transcript.sessionId, 1, walk);
  } finally {
    await rootDir.handle.close().catch(() => undefined);
  }
}

export type ArtifactPass = 'before' | 'after';

/**
 * Removes the derived files of the admitted `transcript`; never throws.
 * `parent` is the pinned directory of the transcript. The `before` pass runs
 * while the transcript still exists (it is spared, so a retryable refusal can
 * keep the row and a retry re-binds everything); the `after` pass, once the
 * transcript is gone, removes the agy directories that only it kept non-empty.
 */
export async function removeArtifactsOf(
  transcript: SessionTranscriptHandle, parent: PinnedDir, pass: ArtifactPass,
  unlink: ChildUnlink, isRetryable: (reason: string) => boolean, context: ArtifactContext = createArtifactContext(),
): Promise<ArtifactOutcome> {
  const spare = pass === 'before' ? transcript.stat : null;
  try {
    if (transcript.provider === 'claude' && pass === 'before') {
      const walk = newWalk(unlink, isRetryable, spare, claudeChildBinder(transcript.sessionId));
      await removeClaudeArtifacts(transcript, parent, walk);
      return walk.outcome;
    }
    const walk = newWalk(unlink, isRetryable, spare);
    if (transcript.provider === 'codex' && pass === 'before') await removeCodexChildren(transcript, walk, context);
    if (transcript.provider === 'antigravity') await removeAgyBrain(transcript, walk);
    return walk.outcome;
  } catch {
    return { removed: 0, kept: 1, retry: 'io_error' };
  }
}
