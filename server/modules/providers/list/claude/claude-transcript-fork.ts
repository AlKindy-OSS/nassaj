import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Claude transcript FORK — branches a session's `<sid>.jsonl` into a NEW,
 * fully resumable session file (T-1090, the `/btw` fork).
 *
 * This is a faithful re-implementation of the fork the Claude Code CLI performs
 * itself (verified byte-level against the shipped CLI 2.1.219 bundle, the
 * function behind `f to fork` in its own `/btw` overlay). Matching it exactly
 * matters: the forked file must be resumable by the SAME CLI/SDK that wrote the
 * original, so every rule below mirrors upstream rather than inventing one.
 *
 *   1. Only the five TRANSCRIPT entry types are carried over; sidecar metadata
 *      lines (`ai-title`, `last-prompt`, `mode`, `queue-operation`, …) are NOT
 *      part of the conversation and are dropped, exactly as upstream drops them.
 *   2. `isSidechain` entries (subagent traffic) are excluded.
 *   3. `upToMessageId` (when given) truncates the branch after that uuid.
 *   4. Every uuid is REMAPPED to a fresh one, and `parentUuid` is rewritten to
 *      the remapped parent — walking UP past `progress` entries, which upstream
 *      drops from the output while still honouring them as chain links.
 *   5. `sessionId` is rewritten on every line. This is load-bearing twice over:
 *      the CLI keys resume on it, and nassaj's own reader keeps only lines whose
 *      `sessionId` matches the file (claude-sessions.provider.ts) — a fork that
 *      kept the old id would open as an EMPTY conversation.
 *   6. The last carried entry is re-stamped with the fork time so the branch
 *      sorts as new; earlier timestamps are preserved.
 *   7. `forkedFrom: {sessionId, messageUuid}` records provenance per entry, and
 *      a `model_refusal_fallback` system row is neutralised, as upstream does.
 *
 * On top of the upstream copy this adds `extraMessages` — the `/btw` question
 * and the answer the user just read — appended as an ordinary user/assistant
 * pair so the side thread CONTINUES from the answer instead of re-asking it.
 * Upstream passes the identical pair (`[user(question), assistant(answer)]`) to
 * its own branch call, so this is the same contract, not an extension.
 *
 * Cost: ZERO inference. The branch reuses the answer already streamed to the
 * overlay; nothing is re-asked and no provider quota is spent by forking.
 *
 * Not carried over: `content-replacement` and `relocated` sidecar rows. Upstream
 * re-emits them from its in-memory session model; they do not occur in any
 * transcript on this host (verified across every project directory), so parsing
 * them back out of the file would be untested code on a path that never runs.
 *
 * I/O is streamed in TWO passes and never holds the transcript in memory: real
 * transcripts here reach 41 MB, and a fork must not spike RSS by that much.
 * Pass 1 collects only uuid → {newUuid, parentUuid, type}; pass 2 rewrites.
 */

/**
 * The entry types that ARE the conversation. Everything else in the file is
 * sidecar metadata about the session, not a message in it.
 */
const TRANSCRIPT_ENTRY_TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'progress']);

/**
 * Refuse to duplicate a pathologically large transcript. The largest real
 * transcript on this host is 41 MB, so 256 MB is far above any legitimate
 * session while still bounding what a fork request can write to disk.
 */
export const FORK_MAX_SOURCE_BYTES = 256 * 1024 * 1024;

/** Flush the pending output every N lines instead of awaiting each write. */
const WRITE_BATCH_LINES = 512;

export type ForkErrorCode =
  | 'source_unreadable'
  | 'source_empty'
  | 'source_too_large'
  | 'message_not_found'
  | 'write_failed';

/** Fork failure with a stable, client-mappable code (never a raw fs message). */
export class TranscriptForkError extends Error {
  readonly code: ForkErrorCode;

  constructor(code: ForkErrorCode, message: string) {
    super(message);
    this.name = 'TranscriptForkError';
    this.code = code;
  }
}

export type ForkExtraMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export interface ForkClaudeTranscriptOptions {
  /** Absolute path of the session transcript to branch from. */
  sourceFilePath: string;
  /** The source session id — recorded in each entry's `forkedFrom`. */
  sourceSessionId: string;
  /** Branch only up to (and including) this message uuid. */
  upToMessageId?: string | null;
  /**
   * false ⇒ carry NO history: the branch holds only `extraMessages`, seeded with
   * the source session's cwd/version/gitBranch so it is still a valid, resumable
   * transcript in the same project. This is the "fresh thread" mode (T-1091) —
   * beyond what the CLI's own fork does, and deliberately so: a side question is
   * often self-contained, and inheriting a 6 MB conversation to follow up on one
   * answer costs context the user did not ask to spend. Defaults to true (the
   * upstream-faithful full branch).
   */
  includeHistory?: boolean;
  /** Appended after the branch, in order. */
  extraMessages?: ForkExtraMessage[];
  /** Session title written as the trailing `custom-title` row. */
  title?: string | null;
  /** Injectable for tests; defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** Injectable for tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

export interface ForkClaudeTranscriptResult {
  forkedSessionId: string;
  filePath: string;
  /** Entries written, excluding the trailing `custom-title` row. */
  entryCount: number;
  /** The branch's working directory, read from the source entries. */
  cwd: string | null;
}

type ScannedEntry = {
  newUuid: string;
  parentUuid: string | null;
  isProgress: boolean;
};

type AnyEntry = Record<string, unknown>;

/** Narrow view of an entry's `message` object, for the model lookup only. */
type MessageWithModel = { model?: unknown };

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * True for a line that belongs in the branch: a transcript type, not a
 * sidechain, and carrying a usable uuid (an entry with no uuid cannot be
 * remapped or referenced as a parent, so it is dropped rather than guessed at).
 */
function isBranchableEntry(entry: AnyEntry): boolean {
  const type = asString(entry.type);
  if (!type || !TRANSCRIPT_ENTRY_TYPES.has(type)) {
    return false;
  }
  if (entry.isSidechain === true) {
    return false;
  }
  return asString(entry.uuid) !== null;
}

/** Parses one JSONL line, returning null for blank or malformed lines. */
function parseLine(line: string): AnyEntry | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as AnyEntry)
      : null;
  } catch {
    return null;
  }
}

/**
 * Pass 1 — walks the source once and records, for every branchable entry in the
 * window, the uuid it will get and the link data the parent rewrite needs.
 * Returns the ordered uuid list so pass 2 knows where the window ends and which
 * carried entry is last (the one re-stamped with the fork time).
 */
async function scanSource(
  sourceFilePath: string,
  upToMessageId: string | null,
  generateId: () => string,
): Promise<{ entries: Map<string, ScannedEntry>; order: string[]; foundCutoff: boolean }> {
  const entries = new Map<string, ScannedEntry>();
  const order: string[] = [];
  let foundCutoff = false;

  const stream = createReadStream(sourceFilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const entry = parseLine(line);
      if (!entry || !isBranchableEntry(entry)) {
        continue;
      }
      const uuid = asString(entry.uuid) as string;
      // A duplicate uuid (concurrent-write artifact) keeps its FIRST mapping so
      // the parent chain stays single-valued.
      if (!entries.has(uuid)) {
        entries.set(uuid, {
          newUuid: generateId(),
          parentUuid: asString(entry.parentUuid),
          isProgress: entry.type === 'progress',
        });
        order.push(uuid);
      }
      if (upToMessageId && uuid === upToMessageId) {
        foundCutoff = true;
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { entries, order, foundCutoff };
}

/**
 * Rewrites `parentUuid` into the branch's uuid space, skipping UP past dropped
 * `progress` entries so a carried entry never points at a line that is not in
 * the file (upstream does the same walk).
 */
function remapParent(
  parentUuid: string | null,
  entries: Map<string, ScannedEntry>,
): string | null {
  let cursor = parentUuid;
  while (cursor) {
    const parent = entries.get(cursor);
    if (!parent) {
      // Parent outside the window (truncated branch) — this entry becomes a root.
      return null;
    }
    if (!parent.isProgress) {
      return parent.newUuid;
    }
    cursor = parent.parentUuid;
  }
  return null;
}

/** Builds the branch-space copy of one source entry. */
function rewriteEntry(
  entry: AnyEntry,
  scanned: ScannedEntry,
  entries: Map<string, ScannedEntry>,
  sourceSessionId: string,
  forkedSessionId: string,
  timestamp: string | null,
): AnyEntry {
  const sourceUuid = asString(entry.uuid) as string;
  const logicalParent = entry.logicalParentUuid;
  const rewritten: AnyEntry = {
    ...entry,
    uuid: scanned.newUuid,
    parentUuid: remapParent(scanned.parentUuid, entries),
    sessionId: forkedSessionId,
    isSidechain: false,
    forkedFrom: { sessionId: sourceSessionId, messageUuid: sourceUuid },
  };

  if (logicalParent !== undefined) {
    rewritten.logicalParentUuid =
      logicalParent === null ? null : (entries.get(String(logicalParent))?.newUuid ?? null);
  }
  if (timestamp) {
    rewritten.timestamp = timestamp;
  }
  // A refusal-fallback marker describes the ORIGINAL run, not the branch.
  if (entry.type === 'system' && entry.subtype === 'model_refusal_fallback') {
    rewritten.neutralizedByFork = true;
  }
  // Agent/team scoping belongs to the source run only.
  for (const field of ['teamName', 'agentName', 'sessionKind', 'slug', 'sourceToolAssistantUUID']) {
    delete rewritten[field];
  }

  return rewritten;
}

/** Fields the appended pair inherits so it looks native to the CLI's parser. */
type EntryTemplate = {
  cwd: string | null;
  version: string | null;
  gitBranch: string | null;
  model: string | null;
};

/**
 * Reads ONLY the head of a transcript, far enough to learn the fields a seeded
 * entry must carry (cwd above all — the synchronizer reads it to place the
 * session in its project, and a branch without it is unusable).
 *
 * This is the fresh-thread path's whole read: it must not walk a 41 MB file to
 * write three lines, so it stops at the first entry that supplies cwd + version,
 * and gives up on `model` after a small budget rather than scanning on for it.
 */
async function readTranscriptTemplate(
  sourceFilePath: string,
  maxLines = 400,
): Promise<EntryTemplate> {
  const template: EntryTemplate = { cwd: null, version: null, gitBranch: null, model: null };
  const stream = createReadStream(sourceFilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;

  try {
    for await (const line of rl) {
      const entry = parseLine(line);
      if (!entry || !isBranchableEntry(entry)) {
        continue;
      }
      seen += 1;
      template.cwd = template.cwd ?? asString(entry.cwd);
      template.version = template.version ?? asString(entry.version);
      template.gitBranch = template.gitBranch ?? asString(entry.gitBranch);
      const message = entry.message;
      if (!template.model && message && typeof message === 'object') {
        template.model = asString((message as MessageWithModel).model);
      }
      if ((template.cwd && template.version && template.model) || seen >= maxLines) {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return template;
}

function buildExtraEntry(
  message: ForkExtraMessage,
  template: EntryTemplate,
  forkedSessionId: string,
  parentUuid: string | null,
  uuid: string,
  timestamp: string,
): AnyEntry {
  const base: AnyEntry = {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    type: message.role,
    uuid,
    timestamp,
    sessionId: forkedSessionId,
  };
  if (template.cwd) base.cwd = template.cwd;
  if (template.version) base.version = template.version;
  if (template.gitBranch) base.gitBranch = template.gitBranch;

  if (message.role === 'user') {
    base.message = { role: 'user', content: [{ type: 'text', text: message.content }] };
    return base;
  }

  base.message = {
    id: `msg_fork_${uuid.replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    ...(template.model ? { model: template.model } : {}),
    content: [{ type: 'text', text: message.content }],
    stop_reason: 'end_turn',
    stop_sequence: null,
  };
  return base;
}

/**
 * Branches `sourceFilePath` into a new `<newSessionId>.jsonl` in the SAME
 * directory (the provider's project folder, where the synchronizer and the
 * watcher already look).
 *
 * The file is written to a `.tmp` sibling and renamed into place, so the
 * watcher never indexes a half-written transcript (`**\/*.tmp` is in its ignore
 * list) and a mid-write crash leaves no ghost session.
 */
export async function forkClaudeTranscript(
  options: ForkClaudeTranscriptOptions,
): Promise<ForkClaudeTranscriptResult> {
  const {
    sourceFilePath,
    sourceSessionId,
    upToMessageId = null,
    includeHistory = true,
    extraMessages = [],
    title = null,
    generateId = randomUUID,
    now = () => new Date().toISOString(),
  } = options;
  // The two modes differ ONLY in whether the source conversation is carried
  // over; everything after (the appended pair, the title row, the atomic write)
  // is shared, so a fresh thread is as valid a transcript as a full branch.
  const carryHistory = includeHistory !== false;

  let sourceSize = 0;
  try {
    const stats = await stat(sourceFilePath);
    if (!stats.isFile()) {
      throw new TranscriptForkError('source_unreadable', 'Transcript is not a regular file.');
    }
    sourceSize = stats.size;
  } catch (error) {
    if (error instanceof TranscriptForkError) {
      throw error;
    }
    throw new TranscriptForkError('source_unreadable', 'Transcript file could not be read.');
  }
  if (sourceSize > FORK_MAX_SOURCE_BYTES) {
    throw new TranscriptForkError('source_too_large', 'This conversation is too large to fork.');
  }

  // Fresh thread: the source is read only for its head (cwd/version/model), and
  // the scan + copy below are skipped entirely — a 41 MB transcript costs three
  // written lines, not a full walk.
  let entries = new Map<string, ScannedEntry>();
  let order: string[] = [];
  let carriedUuids: string[] = [];
  let seededTemplate: EntryTemplate | null = null;

  if (carryHistory) {
    const scanned = await scanSource(sourceFilePath, upToMessageId, generateId);
    entries = scanned.entries;
    order = scanned.order;

    if (upToMessageId && !scanned.foundCutoff) {
      throw new TranscriptForkError(
        'message_not_found',
        'The pinned message is not in this session.',
      );
    }
    carriedUuids = order.filter((uuid) => !entries.get(uuid)?.isProgress);
    if (carriedUuids.length === 0) {
      throw new TranscriptForkError('source_empty', 'This conversation has no messages to fork.');
    }
  } else {
    seededTemplate = await readTranscriptTemplate(sourceFilePath);
    // Without a cwd the synchronizer cannot place the session in a project, so
    // the branch would exist on disk and belong nowhere.
    if (!seededTemplate.cwd) {
      throw new TranscriptForkError(
        'source_empty',
        'This session has no usable transcript to start a thread from.',
      );
    }
    if (extraMessages.length === 0) {
      throw new TranscriptForkError('source_empty', 'A new thread needs at least one message.');
    }
  }

  const forkedSessionId = generateId();
  const forkTimestamp = now();
  const targetDir = path.dirname(sourceFilePath);
  const filePath = path.join(targetDir, `${forkedSessionId}.jsonl`);
  const tempPath = path.join(targetDir, `${forkedSessionId}.jsonl.tmp`);

  const lastCarriedUuid = carriedUuids[carriedUuids.length - 1];
  const windowEndUuid = order[order.length - 1];

  const template: EntryTemplate = seededTemplate ?? {
    cwd: null,
    version: null,
    gitBranch: null,
    model: null,
  };
  let lastCarriedNewUuid: string | null = null;
  let entryCount = 0;

  const output = createWriteStream(tempPath, { encoding: 'utf8', flags: 'wx' });
  const writeFailure = new Promise<never>((_resolve, reject) => {
    output.on('error', (error: Error) =>
      reject(new TranscriptForkError('write_failed', error.message)),
    );
  });
  // The rejection is consumed by the Promise.race calls below; this keeps an
  // early stream error from surfacing as an unhandled rejection first.
  writeFailure.catch(() => {});

  let pending: string[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const chunk = pending.join('');
    pending = [];
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        output.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
      writeFailure,
    ]);
  };
  const emit = async (entry: AnyEntry): Promise<void> => {
    pending.push(`${JSON.stringify(entry)}\n`);
    if (pending.length >= WRITE_BATCH_LINES) {
      await flush();
    }
  };

  /** Pass 2 (full-branch mode only): stream the source into the branch. */
  const copySourceEntries = async (): Promise<void> => {
    const stream = createReadStream(sourceFilePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const seen = new Set<string>();

    try {
      for await (const line of rl) {
        const entry = parseLine(line);
        if (!entry || !isBranchableEntry(entry)) {
          continue;
        }
        const uuid = asString(entry.uuid) as string;
        const scanned = entries.get(uuid);
        // Not in the window (past the cutoff), or a duplicate already written.
        if (!scanned || seen.has(uuid)) {
          if (uuid === windowEndUuid) {
            break;
          }
          continue;
        }
        seen.add(uuid);

        if (!scanned.isProgress) {
          // Inherit the branch's shared fields from the newest carried entry, so
          // the appended pair below matches the conversation it continues.
          template.cwd = asString(entry.cwd) ?? template.cwd;
          template.version = asString(entry.version) ?? template.version;
          template.gitBranch = asString(entry.gitBranch) ?? template.gitBranch;
          const message = entry.message;
          if (message && typeof message === 'object') {
            template.model = asString((message as MessageWithModel).model) ?? template.model;
          }

          await emit(
            rewriteEntry(
              entry,
              scanned,
              entries,
              sourceSessionId,
              forkedSessionId,
              uuid === lastCarriedUuid ? forkTimestamp : null,
            ),
          );
          entryCount += 1;
          lastCarriedNewUuid = scanned.newUuid;
        }

        if (uuid === windowEndUuid) {
          break;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  };

  try {
    if (carryHistory) {
      await copySourceEntries();
    }

    // The /btw question + the answer already shown. In a full branch this
    // CONTINUES the conversation; in a fresh thread it IS the conversation.
    for (const message of extraMessages) {
      if (typeof message?.content !== 'string' || message.content === '') {
        continue;
      }
      const uuid = generateId();
      await emit(
        buildExtraEntry(message, template, forkedSessionId, lastCarriedNewUuid, uuid, forkTimestamp),
      );
      entryCount += 1;
      lastCarriedNewUuid = uuid;
    }

    const resolvedTitle = (title ?? '').trim() || 'Forked session';
    await emit({
      type: 'custom-title',
      sessionId: forkedSessionId,
      customTitle: resolvedTitle,
      uuid: generateId(),
      timestamp: forkTimestamp,
    });

    await flush();
    // `end`'s callback fires on finish; a write error arrives through the
    // stream's own 'error' event, which `writeFailure` turns into a rejection.
    await Promise.race([
      new Promise<void>((resolve) => {
        output.end(() => resolve());
      }),
      writeFailure,
    ]);
    await rename(tempPath, filePath);
  } catch (error) {
    output.destroy();
    await unlink(tempPath).catch(() => {});
    if (error instanceof TranscriptForkError) {
      throw error;
    }
    throw new TranscriptForkError(
      'write_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  return { forkedSessionId, filePath, entryCount, cwd: template.cwd };
}
