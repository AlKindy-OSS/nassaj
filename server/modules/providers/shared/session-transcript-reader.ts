import type { BigIntStats } from 'node:fs';
import { lstat, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { sessionsDb } from '@/modules/database/index.js';

import { isStrictlyUnder, realRoots, recordedTreeRoots } from './contained-file.js';
import { headerVerdicts } from './header-verdict-cache.js';
import {
  listPinnedDirectory, openFileNoFollow, openPinned, PinnedOpenError, type PinnedHandle, type PinnedRefusal,
} from './pinned-fd.js';
import {
  transcriptSpecOf, type FileBinder, type HeaderScan, type HeaderVerdict, type TranscriptSpec,
} from './session-transcript-specs.js';
import { scanHeaderRecords } from './transcript-header-scan.js';

export { claudeFileBinder, codexThreadBinder, type FileBinder } from './session-transcript-specs.js';

/**
 * ADR-201 A1 steps 2–6 — the reader behind `openSessionTranscript`
 * (session-transcript.ts), for code that runs only after the session was
 * authorised (the history service and the provider readers it calls). It has
 * no authorisation dependency, so provider modules can import it without the
 * access predicate. A transcript is opened only when:
 *   1. the caller has authorised the session (see session-transcript.ts);
 *   2. the candidate comes from the row's recorded `jsonl_path` (Claude legacy
 *      spellings via `locateClaudeTranscript`);
 *   3. its realpath lies in the provider root of the ONE tree holding the
 *      recorded path (member `<n>` or the operator/shared root);
 *   4. it is pinned (pinned-fd.ts) as a single-link regular file;
 *   5. its name and its leading record(s), scanned from the pinned descriptor
 *      (≤16 MiB, usually one short line), bind it to the session id
 *      (session-transcript-specs.ts); the verdict is reused for an unchanged,
 *      settled file (header-verdict-cache.ts).
 * The caller owns the returned descriptor and must close it.
 */

export type TranscriptPurpose =
  | 'history' | 'history-lease' | 'search' | 'agent-status' | 'workflow-status'
  | 'models' | 'turn-metrics' | 'receipt-proof' | 'token-usage' | 'progress-seed' | 'rollout-tail'
  | 'agents' | 'cost' | 'handoff' | 'steer' | 'sync-discovery' | 'transcript-repair' | 'skill-observations'
  | 'project-delete' | 'session-delete' | 'session-fork';

export type TranscriptRefusal =
  | 'not_found' | 'unsupported_provider' | 'no_transcript' | 'outside_tree'
  | Exclude<HeaderVerdict, null> | PinnedRefusal;

export type SessionTranscriptHandle = {
  fd: FileHandle; realpath: string; stat: BigIntStats; sessionId: string; provider: string;
  /** Realpath of the provider root of the tree that holds it (set by the reader). */
  root?: string;
};

export type SessionTranscriptResult = SessionTranscriptHandle | { reason: TranscriptRefusal };

/** Row fields the reader needs; the caller has already authorised the session. */
export type RecordedTranscriptRow = { session_id: string; provider: string; jsonl_path: string | null };

/** Narrowing guard for a successful open. */
export function isTranscriptHandle(result: SessionTranscriptResult): result is SessionTranscriptHandle {
  return 'fd' in result;
}

const QUIET_REASONS = new Set<TranscriptRefusal>(['not_found', 'no_transcript', 'missing', 'unsupported_provider']);
/** Purposes whose caller logs its own single warning per refused file (session-transcript-removal.ts). */
const SELF_LOGGING_PURPOSES = new Set<TranscriptPurpose>(['project-delete', 'session-delete']);
const loggedRefusals = new Set<string>();
const LOGGED_REFUSALS_MAX = 2048;

/** Structured warning once per session/reason per process; no paths of other members, no content. */
function refuse(row: RecordedTranscriptRow, purpose: TranscriptPurpose, reason: TranscriptRefusal) {
  const key = `${row.session_id}\0${reason}`;
  if (!QUIET_REASONS.has(reason) && !SELF_LOGGING_PURPOSES.has(purpose) && !loggedRefusals.has(key)) {
    if (loggedRefusals.size >= LOGGED_REFUSALS_MAX) loggedRefusals.clear();
    loggedRefusals.add(key);
    console.warn('Session transcript refused', {
      event: 'session_transcript_refused', sessionId: row.session_id, provider: row.provider, purpose, reason,
    });
  }
  return { reason };
}

/** Realpath of the containing root of the recorded tree, or null. */
async function containingRoot(recorded: string, candidate: string, spec: TranscriptSpec): Promise<string | null> {
  const roots = await realRoots(await recordedTreeRoots(recorded, await spec.sharedRoots(), spec.underHome));
  return roots.find((root) => isStrictlyUnder(candidate, root)) ?? null;
}

async function pinTranscript(real: string): Promise<PinnedHandle | PinnedRefusal> {
  try {
    return await openPinned(real, 'file', { singleLink: true });
  } catch (error) {
    return error instanceof PinnedOpenError ? error.reason : 'io_error';
  }
}

/**
 * A1.5: the candidate's directory is canonicalised (legacy spellings and
 * symlinked config homes resolve), its last component never is — the pinned
 * open then refuses a symlink at the recorded name, even one that stays in
 * the tree. Null when the directory does not exist.
 */
async function noFollowSpelling(candidate: string): Promise<string | null> {
  const directory = await realpath(path.dirname(candidate)).catch(() => null);
  return directory ? path.join(directory, path.basename(candidate)) : null;
}

/**
 * True when `recorded` exists but this process may not reach it (N1): such a
 * row is tried at its recorded spelling, so the pinned open names the refusal
 * (`unreadable`) instead of the lookup reporting the file as missing.
 */
async function isDenied(recorded: string): Promise<boolean> {
  return lstat(recorded).then(() => false, (error: NodeJS.ErrnoException) =>
    error.code === 'EACCES' || error.code === 'EPERM');
}

/** Candidate (canonical directory + literal name) and its containing root, or the refusal reason. */
async function confinedCandidate(
  row: RecordedTranscriptRow, spec: TranscriptSpec,
): Promise<{ real: string; root: string } | TranscriptRefusal> {
  const recorded = (row.jsonl_path ?? '').trim();
  if (!recorded || !path.isAbsolute(recorded)) return 'no_transcript';
  const candidate = (await spec.locate(recorded)) ?? (await isDenied(recorded) ? recorded : null);
  const real = candidate ? await noFollowSpelling(candidate) : null;
  if (!real) return 'missing';
  const root = await containingRoot(recorded, real, spec);
  return root ? { real, root } : 'outside_tree';
}

/** Steps 4–5 on a confined candidate: pinned single-link open, then the name/header id check. */
async function admitCandidate(
  row: RecordedTranscriptRow, purpose: TranscriptPurpose, spec: TranscriptSpec, located: { real: string; root: string },
): Promise<SessionTranscriptResult> {
  const pinned = await pinTranscript(located.real);
  if (typeof pinned === 'string') return refuse(row, purpose, pinned);
  try {
    const scan: HeaderScan = (paths, visit) => scanHeaderRecords(pinned.handle, paths, visit);
    const subject = {
      rules: spec, provider: row.provider, sessionId: row.session_id, realpath: located.real, root: located.root, stat: pinned.stat,
    };
    // L6: an unchanged, settled file is not scanned again (see header-verdict-cache.ts).
    const verdict = await headerVerdicts.verify(subject, () => spec.verify(row.session_id, located.real, scan, located.root));
    if (verdict === null) {
      return {
        fd: pinned.handle, realpath: located.real, stat: pinned.stat,
        sessionId: row.session_id, provider: row.provider, root: located.root,
      };
    }
    await pinned.handle.close();
    return refuse(row, purpose, verdict);
  } catch {
    await pinned.handle.close().catch(() => undefined);
    return refuse(row, purpose, 'io_error');
  }
}

/** True for a session id usable as a path leaf (no separators, not empty). */
function isLeafId(sessionId: string): boolean {
  return Boolean(sessionId) && sessionId === path.basename(sessionId);
}

/**
 * Steps 2–6 for a row the caller has ALREADY authorised (the history service
 * after its own gate, or a provider reader reached only through it). Every
 * other caller uses {@link openSessionTranscript}. `specOf` defaults to the
 * reader's rules; removal passes `removalSpecOf` (adds Cursor).
 */
export async function openRecordedTranscript(
  row: RecordedTranscriptRow, purpose: TranscriptPurpose,
  specOf: (provider: string) => TranscriptSpec | null = transcriptSpecOf,
): Promise<SessionTranscriptResult> {
  const spec = specOf(row.provider);
  if (!spec) return refuse(row, purpose, 'unsupported_provider');
  if (!isLeafId(row.session_id)) return refuse(row, purpose, 'not_found');
  const located = await confinedCandidate(row, spec);
  if (typeof located === 'string') return refuse(row, purpose, located);
  return admitCandidate(row, purpose, spec, located);
}

/** A transcript named by a live run itself (its own thread id), before any row may exist. */
export type RunTranscriptInput = {
  provider: string; sessionId: string; candidate: string; root: string; purpose: TranscriptPurpose;
};

/**
 * Steps 3–5 for a transcript a server-internal run names itself (e.g. the
 * Codex thread id announced by `thread.started`): there is no requester and
 * possibly no row yet, so the candidate is confined to the ONE root the run
 * writes to (its principal's provider home), then pinned and bound to the id
 * by its name and header exactly as a recorded transcript is.
 */
export async function openRunTranscript(input: RunTranscriptInput): Promise<SessionTranscriptResult> {
  const row: RecordedTranscriptRow = { session_id: input.sessionId, provider: input.provider, jsonl_path: input.candidate };
  const spec = transcriptSpecOf(input.provider);
  if (!spec) return refuse(row, input.purpose, 'unsupported_provider');
  if (!isLeafId(input.sessionId) || !path.isAbsolute(input.candidate)) return refuse(row, input.purpose, 'not_found');
  const [real, root] = await Promise.all([
    noFollowSpelling(input.candidate), realpath(input.root).catch(() => null),
  ]);
  if (!real) return refuse(row, input.purpose, 'missing');
  if (!root || !isStrictlyUnder(real, root)) return refuse(row, input.purpose, 'outside_tree');
  return admitCandidate(row, input.purpose, spec, { real, root });
}

/**
 * Runs `read` on the pinned transcript of `sessionId`'s recorded row and closes
 * it; null when there is no row, the provider differs, or the open is refused.
 * Authorization-free: only for server-internal readers that run inside an
 * already-authorised action (a live run, a fenced route) — see each caller.
 */
export async function withRecordedTranscript<T>(
  sessionId: string, provider: string | null, purpose: TranscriptPurpose,
  read: (transcript: SessionTranscriptHandle) => Promise<T>,
): Promise<T | null> {
  let row: ReturnType<typeof sessionsDb.getHistorySource> = null;
  try {
    row = sessionsDb.getHistorySource(sessionId);
  } catch {
    return null;
  }
  if (!row || (provider !== null && row.provider !== provider)) return null;
  const opened = await openRecordedTranscript(row, purpose);
  if (!isTranscriptHandle(opened)) return null;
  try {
    return await read(opened);
  } finally {
    await opened.fd.close().catch(() => undefined);
  }
}

export type ConfinedFile = PinnedHandle & { root: string };

/** Pinned no-follow open, mapped to a refusal reason instead of a throw. */
async function noFollow(candidate: string): Promise<PinnedHandle | PinnedRefusal> {
  try {
    return await openFileNoFollow(candidate);
  } catch (error) {
    return error instanceof PinnedOpenError ? error.reason : 'io_error';
  }
}

/**
 * Steps 2–4 (no id binding) for a path the server holds for `provider` — a
 * recorded `jsonl_path` handed down by a server-internal reader whose caller
 * binds the content identity itself (the Codex link manifest, cost ingestion).
 * The file is pinned single-link without following its last component, and
 * its realpath must lie in the provider root of the ONE tree holding
 * `recorded`. Returns the handle with that root, or the refusal reason.
 */
export async function openConfinedFile(provider: string, recorded: string): Promise<ConfinedFile | { reason: TranscriptRefusal }> {
  const spec = transcriptSpecOf(provider);
  if (!spec) return { reason: 'unsupported_provider' };
  if (!path.isAbsolute(recorded)) return { reason: 'no_transcript' };
  const pinned = await noFollow((await spec.locate(recorded)) ?? recorded);
  if (typeof pinned === 'string') return { reason: pinned };
  const root = await containingRoot(recorded, pinned.realpath, spec).catch(() => null);
  if (root) return { ...pinned, root };
  await pinned.handle.close().catch(() => undefined);
  return { reason: 'outside_tree' };
}

/**
 * Realpath of the provider root of the ONE tree holding `recorded` (a
 * server-held transcript path) that contains its directory, or null. Lets a
 * reader confine files it derives beside a transcript (a Claude subagent dir)
 * even when the transcript itself is absent.
 */
export async function confiningRootOf(provider: string, recorded: string): Promise<string | null> {
  const spec = transcriptSpecOf(provider);
  if (!spec || !path.isAbsolute(recorded)) return null;
  const directory = await realpath(path.dirname(recorded)).catch(() => null);
  if (!directory) return null;
  return containingRoot(recorded, path.join(directory, path.basename(recorded)), spec).catch(() => null);
}

/**
 * A file the server derived from an already confined transcript (a linked
 * child rollout, a subagent file): pinned single-link, last component never
 * followed, realpath strictly under `root` (the anchor's containing root).
 */
export async function openAnchoredFile(root: string, candidate: string): Promise<PinnedHandle | { reason: TranscriptRefusal }> {
  const pinned = await noFollow(candidate);
  if (typeof pinned === 'string') return { reason: pinned };
  if (isStrictlyUnder(pinned.realpath, root)) return pinned;
  await pinned.handle.close().catch(() => undefined);
  return { reason: 'outside_tree' };
}

/** A refused bound open; `reason` carries no path or content. */
export class TranscriptRefusedError extends Error {
  constructor(readonly reason: TranscriptRefusal) {
    super(`transcript refused: ${reason}`);
    this.name = 'TranscriptRefusedError';
  }
}

/**
 * A file the server derived itself (a subagent file, a linked child rollout,
 * a rollout found by a provider-root scan): pinned single-link, last component
 * never followed, realpath strictly under `root`, then bound to its expected
 * id by `bind` reading the pinned descriptor (ADR-201 A-P2c). The caller owns
 * the returned handle.
 */
export async function openBoundFile(
  root: string, candidate: string, bind: FileBinder,
): Promise<PinnedHandle | { reason: TranscriptRefusal }> {
  const opened = await openAnchoredFile(root, candidate);
  if ('reason' in opened) return opened;
  let verdict: HeaderVerdict | 'io_error' = 'io_error';
  try {
    verdict = await bind(opened.realpath, (paths, visit) => scanHeaderRecords(opened.handle, paths, visit));
  } catch {
    // An unreadable header binds nothing.
  }
  if (verdict === null) return opened;
  await opened.handle.close().catch(() => undefined);
  return { reason: verdict };
}

/**
 * True for a derived child file that vanished or carries no id at all (a
 * workflow `journal.jsonl` beside Claude subagents): it is skipped unread —
 * nothing in it is attributed — without marking the read incomplete.
 */
export function isQuietChildRefusal(reason: TranscriptRefusal): boolean {
  return reason === 'missing' || reason === 'header_missing';
}

/** {@link openBoundFile} that throws {@link TranscriptRefusedError} on refusal. */
export async function requireBoundFile(root: string, candidate: string, bind: FileBinder): Promise<PinnedHandle> {
  const opened = await openBoundFile(root, candidate, bind);
  if ('reason' in opened) throw new TranscriptRefusedError(opened.reason);
  return opened;
}

/** Read stream over a pinned descriptor from offset 0; the descriptor stays open. */
export function pinnedReadStream(fd: FileHandle): Readable {
  return fd.createReadStream({ start: 0, autoClose: false });
}

export type SessionArtifactKind = 'subagents' | 'workflows';

const ARTIFACT_SEGMENTS: Readonly<Record<SessionArtifactKind, readonly string[]>> = Object.freeze({
  subagents: ['subagents'],
  workflows: ['subagents', 'workflows'],
});
const ARTIFACT_LIST_MAX = 10_000;
const PROC_FD_DIR = '/proc/self/fd';

function validChildSegments(relative: string): string[] | null {
  const segments = relative.split('/');
  const valid = segments.length <= 2 && segments.every((segment) =>
    segment !== '' && segment !== '.' && segment !== '..' && segment.length <= 255 && !segment.includes('\0'));
  return valid ? segments : null;
}

/** A pinned artifact directory of one session; children are pinned through its descriptor. */
export class SessionArtifactDir {
  private readonly children = new Set<FileHandle>();

  constructor(readonly dir: FileHandle, readonly realpath: string) {}

  /** Entry names, read through the pinned descriptor (bounded). */
  list(): Promise<string[]> {
    return listPinnedDirectory(this.dir, ARTIFACT_LIST_MAX);
  }

  /** Pinned single-link regular file at `relative` (≤2 segments), or the refusal reason. */
  async openFile(relative: string): Promise<PinnedHandle | { reason: PinnedRefusal }> {
    const segments = validChildSegments(relative);
    if (!segments) return { reason: 'not_absolute' };
    try {
      const child = await openPinned(path.join(this.realpath, ...segments), 'file', {
        singleLink: true, via: path.join(PROC_FD_DIR, String(this.dir.fd), ...segments),
      });
      this.children.add(child.handle);
      return child;
    } catch (error) {
      return { reason: error instanceof PinnedOpenError ? error.reason : 'io_error' };
    }
  }

  /** Closes one child opened through {@link openFile} before the directory closes. */
  async closeFile(child: PinnedHandle): Promise<void> {
    this.children.delete(child.handle);
    await child.handle.close().catch(() => undefined);
  }

  /** Closes every child opened through this directory, then the directory. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.children].map((child) => child.close()));
    this.children.clear();
    await this.dir.close().catch(() => undefined);
  }
}

/**
 * Opens `<parent>/<stem>/subagents` (or `…/subagents/workflows`) of a pinned
 * Claude transcript with `O_DIRECTORY|O_NOFOLLOW`, derived from the pinned
 * file's realpath — never from a stored path. A symlinked or missing directory
 * yields `{ reason }`.
 */
export async function openSessionArtifactDir(
  transcript: SessionTranscriptHandle, kind: SessionArtifactKind,
): Promise<SessionArtifactDir | { reason: TranscriptRefusal }> {
  if (transcript.provider !== 'claude') return { reason: 'unsupported_provider' };
  const stem = path.basename(transcript.realpath, '.jsonl');
  return openArtifactDirAt(path.join(path.dirname(transcript.realpath), stem, ...ARTIFACT_SEGMENTS[kind]));
}

/**
 * Pinned artifact directory at the absolute realpath `expected`. Production
 * code reaches it only through {@link openSessionArtifactDir}, which derives
 * `expected` from a pinned transcript; parser tests use it on fixture dirs.
 */
export async function openArtifactDirAt(expected: string): Promise<SessionArtifactDir | { reason: PinnedRefusal }> {
  try {
    const { handle } = await openPinned(expected, 'directory');
    return new SessionArtifactDir(handle, expected);
  } catch (error) {
    return { reason: error instanceof PinnedOpenError ? error.reason : 'io_error' };
  }
}

export type HistoryTranscript = { transcript: SessionTranscriptHandle; owned: boolean };

/**
 * Transcript a provider history reader uses: the one the history service
 * supplied (`null` = refused, read nothing), or — for direct callers that did
 * not go through the service — its own pinned open of the row's recorded path.
 * `owned` tells the reader to close it.
 */
export async function historyTranscript(
  sessionId: string, provider: string, supplied: SessionTranscriptHandle | null | undefined,
): Promise<HistoryTranscript | null> {
  if (supplied !== undefined) return supplied ? { transcript: supplied, owned: false } : null;
  let row: ReturnType<typeof sessionsDb.getHistorySource> = null;
  try {
    row = sessionsDb.getHistorySource(sessionId);
  } catch {
    return null;
  }
  if (!row || row.provider !== provider) return null;
  const opened = await openRecordedTranscript(row, 'history');
  return isTranscriptHandle(opened) ? { transcript: opened, owned: true } : null;
}

/** Closes a reader-owned transcript; a supplied one stays with its owner. */
export async function releaseHistoryTranscript(source: HistoryTranscript | null): Promise<void> {
  if (source?.owned) await source.transcript.fd.close().catch(() => undefined);
}
