import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { isStrictlyUnder } from './contained-file.js';
import { descriptorPath, listPinnedDirectory, openPinned, PinnedOpenError, type PinnedHandle, type PinnedRefusal } from './pinned-fd.js';
import {
  createArtifactContext, removeArtifactsOf, type ArtifactContext, type ArtifactOutcome, type ArtifactPass,
} from './session-artifact-removal.js';
import { parkedOriginalOf } from './session-transcript-park.js';
import {
  confiningRootOf, isTranscriptHandle, openRecordedTranscript, type RecordedTranscriptRow, type SessionTranscriptHandle,
  type SessionTranscriptResult, type TranscriptPurpose, type TranscriptRefusal,
} from './session-transcript-reader.js';
import { removalSpecOf } from './session-transcript-specs.js';
import { scanHeaderRecords } from './transcript-header-scan.js';
import { recordVerifiedPark } from './transcript-park-ledger.js';

/**
 * B-1596 — the only way server code removes a session transcript.
 *
 * A stored `jsonl_path` handed to `unlink` is an arbitrary-delete primitive:
 * a forged path, or a symlink planted at the name, at its directory or at a
 * member root, would remove another member's transcript or any file the
 * nassaj uid can write. A transcript is removed here only when ALL hold:
 *   1. it is admitted exactly like a read (openRecordedTranscript): the
 *      recorded tree's provider root only (H1 member-root rule, `/1` vs `/10`
 *      safe), pinned with O_NOFOLLOW as a single-link regular file, and bound
 *      to the session id by its name and header;
 *   2. its directory is pinned (O_DIRECTORY|O_NOFOLLOW) at the realpath the
 *      admitted file lies in, inside the same root;
 *   3. the name is moved, through the pinned directory
 *      (`/proc/self/fd/<dirfd>/<name>`), to a random sibling name, and the
 *      moved entry is still the admitted file (same dev/ino, one link). Only
 *      then is it unlinked; anything else — including a failed unlink — is
 *      linked back to its name (never over another entry). If even that fails
 *      the file stays under the parked name and the reason is `parked_left`.
 * Any refusal skips the file with one warning (session id, provider, reason —
 * never a path) and removes nothing. Leaving a file behind is acceptable;
 * removing the wrong one is not. Callers tell a SECURITY refusal (the file is
 * not this session's to remove: drop the row, keep the file) from a RETRYABLE
 * one (I/O or a concurrent change: keep the row so the user can retry) with
 * {@link isRetryableRefusal}. A permission denial (`unreadable`, `unwritable`)
 * is a security refusal: a member must not block the owner's delete with chmod.
 *
 * B-1607: the files a provider derives from the session (Claude
 * `<id>/subagents` and `<id>/workflows`, Codex child rollouts, the agy brain
 * directory) are removed with it, before the transcript, through the same
 * park / verify / unlink step and from the same pinned parent directory
 * (session-artifact-removal.ts). A retryable refusal there refuses the whole
 * removal (the transcript stays, so a retry re-binds them); a security
 * refusal keeps that file only.
 *
 * B-1612 N2: a retry after `parked_left` finds the file under its park name
 * (either form, session-transcript-park.ts) when its original name is gone;
 * exactly one parked file bound to the session (by name and header, pinned)
 * is linked back and removed, several or an unbindable B-1596 park of this
 * name report `parked_left` again — never a silent `missing`.
 *
 * T1 — threat model: the racer this primitive defeats is a process of the
 * SAME uid (every harness runs as the nassaj uid; ADR-201 Context). Such a
 * racer can always delete or rewrite its own tree's files; what it must not
 * achieve is making this code remove a file of ANOTHER tree or outside every
 * tree. Every name is therefore acted on through a pinned directory
 * descriptor and re-checked by dev/ino/nlink after the park, and nothing is
 * ever followed. Residual, accepted windows: a racer in the same directory
 * can swap an emptied artifact directory for another empty one between the
 * check and `rmdir` (only an empty directory of that tree can go), and can
 * replace a parked name before it is linked back (the restore never
 * overwrites; the name is then reported `parked_left`). A different-uid
 * racer (per-member isolation, T-898) is weaker still: it cannot write the
 * pinned directories at all.
 */

export type RemovalPurpose = Extract<TranscriptPurpose, 'project-delete' | 'session-delete'>;

export type RemovalRefusal = TranscriptRefusal | 'swapped' | 'unlink_failed' | 'parked_left' | 'unwritable';

export type TranscriptRemoval = { removed: true } | { removed: false; reason: RemovalRefusal };

/** Reasons that need no warning: there was nothing to remove. */
const QUIET = new Set<RemovalRefusal>(['missing', 'no_transcript']);
/**
 * I/O failures and concurrent changes: nothing proves the file is foreign, so a
 * retry may succeed. Never a permission denial (`unreadable`, `unwritable`) or
 * a host without /proc (`proc_unavailable`): a retry cannot change those, and a
 * member who denies access to a file must not block the owner's delete (N1, N6).
 */
const RETRYABLE = new Set<RemovalRefusal>([
  'io_error', 'unlink_failed', 'swapped', 'parked_left', 'changed_during_open',
]);
const PROC_FD_DIR = '/proc/self/fd';
/** Directory entries listed while looking for a parked file (N2). */
const PARKED_LIST_MAX = 100_000;

/**
 * True when a refused removal may succeed on retry (keep the row and report
 * it); false for a security refusal or an absent file (drop the row, keep any file).
 */
export function isRetryableRefusal(reason: RemovalRefusal): boolean {
  return RETRYABLE.has(reason);
}

/** One structured warning per skipped file; no paths, no content. */
function skip(row: RecordedTranscriptRow, purpose: RemovalPurpose, reason: RemovalRefusal): TranscriptRemoval {
  if (!QUIET.has(reason)) {
    console.warn('Session transcript removal skipped', {
      event: 'session_transcript_removal_skipped', sessionId: row.session_id, provider: row.provider, purpose, reason,
    });
  }
  return { removed: false, reason };
}

/** True when `stat` is the admitted single-link regular file `pinned`. */
function isAdmittedFile(stat: BigIntStats | null, pinned: BigIntStats): boolean {
  return stat !== null && stat.isFile() && stat.dev === pinned.dev && stat.ino === pinned.ino && stat.nlink === 1n;
}

/** `lstat` that maps any failure to null (the entry is gone or unreadable). */
async function lstatOrNull(target: string): Promise<BigIntStats | null> {
  return fsp.lstat(target, { bigint: true }).catch(() => null);
}

/** Pinned directory at the realpath `directory`, inside `root`; or the refusal. */
async function pinDirectoryIn(directory: string, root: string | undefined): Promise<PinnedHandle | RemovalRefusal> {
  if (!root || (directory !== root && !isStrictlyUnder(directory, root))) return 'outside_tree';
  try {
    return await openPinned(directory, 'directory');
  } catch (error) {
    return error instanceof PinnedOpenError ? error.reason satisfies PinnedRefusal : 'io_error';
  }
}

/** Pinned parent directory of the admitted transcript, inside its root; or the refusal. */
function pinParentHandle(transcript: SessionTranscriptHandle): Promise<PinnedHandle | RemovalRefusal> {
  return pinDirectoryIn(path.dirname(transcript.realpath), transcript.root);
}

/**
 * Puts the entry at `parked` back at `original` without replacing anything
 * (`link` never overwrites), then drops the parked name only if it still names
 * the entry just linked. False when the entry could not be linked back, or
 * its parked name could not be dropped: a parked name is left (`parked_left`).
 */
async function restoreParked(parked: string, original: string, moved: BigIntStats | null): Promise<boolean> {
  try {
    await fsp.link(parked, original);
  } catch {
    return false;
  }
  const again = await lstatOrNull(parked);
  if (!moved || !again || again.dev !== moved.dev || again.ino !== moved.ino) return true;
  return fsp.unlink(parked).then(() => true, () => false);
}

/** Restores the parked entry; `reason` when it is back at its name, else `parked_left`. */
async function putBack(parked: string, original: string, moved: BigIntStats | null, reason: RemovalRefusal) {
  return (await restoreParked(parked, original, moved)) ? reason : 'parked_left' as const;
}

/**
 * Random sibling name a transcript is parked under before its unlink. Fixed
 * length, never derived from the transcript's name: a name near NAME_MAX left
 * no room for a suffix and the rename failed with ENAMETOOLONG on every retry
 * (B-1613).
 */
function parkName(): string {
  return `.nassaj-removing-${randomBytes(8).toString('hex')}`;
}

/**
 * Step 3 through the pinned directory: park the name under a random sibling,
 * confirm the parked entry is the admitted file, then unlink it; otherwise —
 * or when the unlink fails — restore it. Never follows a link: rename, link
 * and unlink act on the entry itself.
 */
async function unlinkThroughDir(dirFd: number, name: string, pinned: BigIntStats): Promise<RemovalRefusal | null> {
  const base = path.join(PROC_FD_DIR, String(dirFd));
  const original = path.join(base, name);
  if (!isAdmittedFile(await lstatOrNull(original), pinned)) return 'swapped';
  const parked = path.join(base, parkName());
  try {
    await fsp.rename(original, parked);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' ? 'unwritable' : 'unlink_failed';
  }
  const moved = await lstatOrNull(parked);
  if (!isAdmittedFile(moved, pinned)) return putBack(parked, original, moved, 'swapped');
  try {
    await fsp.unlink(parked);
    return null;
  } catch {
    const refused = await putBack(parked, original, moved, 'unlink_failed');
    // qa 2: a verified file left parked is the only kind the boot sweep may remove.
    if (refused === 'parked_left' && moved) await ledgerPark(dirFd, path.basename(parked), moved);
    return refused;
  }
}

/** Ledgers the verified entry left at `name` in the pinned directory `dirFd`; never throws. */
async function ledgerPark(dirFd: number, name: string, moved: BigIntStats): Promise<void> {
  const dir = await descriptorPath(dirFd).catch(() => null);
  if (dir) await recordVerifiedPark(dir, name, moved);
}

/** One artifact pass over the pinned parent `dir` of the admitted transcript. */
function artifactPass(
  transcript: SessionTranscriptHandle, dir: PinnedHandle, pass: ArtifactPass, context: ArtifactContext,
): Promise<ArtifactOutcome> {
  const parent = { handle: dir.handle, realpath: path.dirname(transcript.realpath), stat: dir.stat };
  return removeArtifactsOf(transcript, parent, pass, unlinkThroughDir,
    (reason) => isRetryableRefusal(reason as RemovalRefusal), context);
}

/**
 * Shared state of the removals of ONE delete (T8): pass the same context to
 * every {@link removeSessionTranscript} call of a project delete so each Codex
 * day directory is indexed once. Never reuse it across deletes.
 */
export type RemovalContext = ArtifactContext;
export const createRemovalContext = createArtifactContext;

/** One structured warning when derived files were kept; counts only, no paths. */
function reportArtifacts(row: RecordedTranscriptRow, purpose: RemovalPurpose, outcome: ArtifactOutcome): void {
  if (outcome.kept === 0) return;
  console.warn('Session artifacts kept', {
    event: 'session_artifacts_kept', sessionId: row.session_id, provider: row.provider, purpose,
    removed: outcome.removed, kept: outcome.kept, retryable: outcome.retry !== null,
  });
}

/**
 * Steps 2–3 on an admitted transcript, with its derived files (B-1607) before
 * it and the agy directories it kept non-empty after it; null when removed.
 */
async function removeAdmitted(
  row: RecordedTranscriptRow, purpose: RemovalPurpose, transcript: SessionTranscriptHandle, context: RemovalContext,
): Promise<RemovalRefusal | null> {
  const dir = await pinParentHandle(transcript);
  if (typeof dir === 'string') return dir;
  try {
    const before = await artifactPass(transcript, dir, 'before', context);
    reportArtifacts(row, purpose, before);
    if (before.retry !== null) return before.retry as RemovalRefusal;
    const refused = await unlinkThroughDir(dir.handle.fd, path.basename(transcript.realpath), transcript.stat);
    if (refused === null) await artifactPass(transcript, dir, 'after', context);
    return refused;
  } finally {
    await dir.handle.close().catch(() => undefined);
  }
}

/**
 * B-1607: removes only the derived files of an admitted transcript (not the
 * transcript itself); never throws. Lets a caller holding a pinned transcript
 * clean up what the provider derived from it.
 */
export async function removeSessionArtifacts(
  transcript: SessionTranscriptHandle, context: RemovalContext = createRemovalContext(),
): Promise<ArtifactOutcome> {
  const dir = await pinParentHandle(transcript);
  if (typeof dir === 'string') return { removed: 0, kept: 0, retry: isRetryableRefusal(dir) ? dir : null };
  try {
    return await artifactPass(transcript, dir, 'before', context);
  } finally {
    await dir.handle.close().catch(() => undefined);
  }
}

/** Step 1 (admission) without logging; never throws. */
async function admit(row: RecordedTranscriptRow, purpose: RemovalPurpose): Promise<SessionTranscriptResult> {
  if (!(row.jsonl_path ?? '').trim()) return { reason: 'no_transcript' };
  try {
    return await openRecordedTranscript(row, purpose, removalSpecOf);
  } catch {
    return { reason: 'io_error' };
  }
}

type ParkedCandidate = { name: string; stat: BigIntStats };
type ParkedSearch = { dir: PinnedHandle; base: string; bound: ParkedCandidate[]; unbound: number };

/** Header-bearing transcripts: a short park name (no original name in it) can be bound by content only. */
function headerBinds(provider: string, base: string): boolean {
  return provider === 'claude' || (provider === 'codex' && base.startsWith('rollout-'));
}

/** True when the pinned parked file binds to `row` as if it were still at its name `base`. */
async function bindsParked(row: RecordedTranscriptRow, real: string, root: string, child: PinnedHandle): Promise<boolean> {
  const spec = removalSpecOf(row.provider);
  if (!spec) return false;
  const verdict = await spec.verify(row.session_id, real, (paths, visit) => scanHeaderRecords(child.handle, paths, visit), root)
    .catch(() => 'io_error');
  return verdict === null;
}

/** Pins one park-named entry of `dir` and binds it; null when it is not this session's. */
async function parkedCandidate(
  row: RecordedTranscriptRow, dir: PinnedHandle, name: string, base: string, root: string,
): Promise<ParkedCandidate | 'unbound' | null> {
  const original = parkedOriginalOf(name);
  if (original === undefined || (original !== null && original !== base)) return null;
  if (original === null && !headerBinds(row.provider, base)) return null;
  let child: PinnedHandle;
  try {
    child = await openPinned(path.join(dir.realpath, name), 'file', {
      singleLink: true, via: path.join(PROC_FD_DIR, String(dir.handle.fd), name),
    });
  } catch {
    return original === null ? null : 'unbound';
  }
  try {
    if (await bindsParked(row, path.join(dir.realpath, base), root, child)) return { name, stat: child.stat };
    return original === null ? null : 'unbound';
  } finally {
    await child.handle.close().catch(() => undefined);
  }
}

/**
 * N2: the parked files of `row` in its recorded directory (inside its tree),
 * read-only. Null when the directory cannot be pinned there (nothing to find).
 */
async function findParked(row: RecordedTranscriptRow): Promise<ParkedSearch | null> {
  const recorded = (row.jsonl_path ?? '').trim();
  const root = await confiningRootOf(row.provider, recorded).catch(() => null);
  const directory = root ? await fsp.realpath(path.dirname(recorded)).catch(() => null) : null;
  if (!root || !directory) return null;
  const dir = await pinDirectoryIn(directory, root);
  if (typeof dir === 'string') return null;
  const search: ParkedSearch = { dir, base: path.basename(recorded), bound: [], unbound: 0 };
  try {
    for (const name of await listPinnedDirectory(dir.handle, PARKED_LIST_MAX)) {
      const found = await parkedCandidate(row, dir, name, search.base, root);
      if (found === 'unbound') search.unbound += 1;
      else if (found) search.bound.push(found);
    }
    return search;
  } catch {
    await dir.handle.close().catch(() => undefined);
    return null;
  }
}

/** True when `search` names exactly one parked file of the session and nothing ambiguous. */
function isRecoverable(search: ParkedSearch): boolean {
  return search.bound.length === 1 && search.unbound === 0;
}

/** Outcome of N2 for an admission that found the name `missing`. */
async function recoverParked(row: RecordedTranscriptRow): Promise<'none' | 'restored' | 'parked_left'> {
  const search = await findParked(row);
  if (!search) return 'none';
  try {
    if (search.bound.length === 0 && search.unbound === 0) return 'none';
    if (!isRecoverable(search)) return 'parked_left';
    const base = path.join(PROC_FD_DIR, String(search.dir.handle.fd));
    const [parked] = search.bound;
    return (await restoreParked(path.join(base, parked.name), path.join(base, search.base), parked.stat))
      ? 'restored' : 'parked_left';
  } finally {
    await search.dir.handle.close().catch(() => undefined);
  }
}

/** Read-only N2 for a probe: `parked_left` when a retry could not settle the parked files, else null. */
async function probeParked(row: RecordedTranscriptRow): Promise<RemovalRefusal | null> {
  const search = await findParked(row);
  if (!search) return null;
  await search.dir.handle.close().catch(() => undefined);
  const nothing = search.bound.length === 0 && search.unbound === 0;
  return nothing || isRecoverable(search) ? null : 'parked_left';
}

/**
 * Admission only (step 1), without removing or logging: the reason a removal
 * would refuse before touching the directory, or null when it would proceed.
 * Lets a caller refuse a retryable case before an irreversible commit.
 */
export async function probeSessionTranscript(
  row: RecordedTranscriptRow, purpose: RemovalPurpose,
): Promise<RemovalRefusal | null> {
  const opened = await admit(row, purpose);
  if (!isTranscriptHandle(opened)) return opened.reason === 'missing' ? (await probeParked(row)) ?? 'missing' : opened.reason;
  await opened.fd.close().catch(() => undefined);
  return null;
}

/** Admission, after N2 recovery of a parked file when the name is `missing`. */
async function admitOrRecover(
  row: RecordedTranscriptRow, purpose: RemovalPurpose,
): Promise<SessionTranscriptResult | { reason: 'parked_left' }> {
  const opened = await admit(row, purpose);
  if (isTranscriptHandle(opened) || opened.reason !== 'missing') return opened;
  const recovered = await recoverParked(row);
  if (recovered === 'parked_left') return { reason: 'parked_left' };
  return recovered === 'restored' ? admit(row, purpose) : opened;
}

/**
 * Removes the recorded transcript of `row` and its derived files (see the
 * module comment). Never throws: every failure is a skipped file with its
 * reason, logged once. A batch passes one `context` to every call.
 */
export async function removeSessionTranscript(
  row: RecordedTranscriptRow, purpose: RemovalPurpose, context: RemovalContext = createRemovalContext(),
): Promise<TranscriptRemoval> {
  const opened = await admitOrRecover(row, purpose);
  if (!('fd' in opened)) return skip(row, purpose, opened.reason);
  try {
    const refused = await removeAdmitted(row, purpose, opened, context);
    return refused === null ? { removed: true } : skip(row, purpose, refused);
  } catch {
    return skip(row, purpose, 'io_error');
  } finally {
    await opened.fd.close().catch(() => undefined);
  }
}
