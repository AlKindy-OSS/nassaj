/**
 * ADR-199 Addendum A §5: seeds a live run's progress fold from the session's
 * full transcript, so a resumed run continues the task list and can settle
 * delegations started in earlier runs.
 *
 * Only lines that can carry Task* calls/results, a delegation or a human
 * prompt (a turn boundary, B-1563) are parsed; every other line is skipped by a
 * substring check, so seeding a long
 * transcript costs one sequential read. The transcript is resolved through the
 * containment-checked resolver (realpath under a Claude projects root); a
 * missing, unreadable or uncontained transcript leaves the fold empty.
 *
 * Seeding is bounded (T-1988): a transcript above PROGRESS_SEED_MAX_BYTES is not
 * read, and a fold that does not finish within the time budget is abandoned for
 * a fresh one, so the first live event is never delayed beyond the budget.
 */

import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';

import { createClaudeProgressFold, type ClaudeProgressFold } from './claude-progress-fold.js';
import { ClaudeSessionsProvider } from './claude-sessions.provider.js';
import { resolveClaudeTranscriptPath } from './claude-transcript-path.js';

const SEED_MARKERS = ['"TaskCreate"', '"TaskUpdate"', '"task":{', '"statusChange"', '"updatedFields"', '"subagent_type"'];
const USER_ROW_MARKER = '"type":"user"';

/** Lines worth parsing: Task* calls/results, delegations, and (B-1563) user rows. */
function seedRelevant(line: string): boolean {
  return line.includes(USER_ROW_MARKER) || SEED_MARKERS.some((marker) => line.includes(marker));
}

/**
 * A user row that only carries tool results (no seed marker) folds nothing and
 * is not a turn boundary. Decided on the parsed content blocks, so a human
 * prompt whose text mentions "tool_result" still closes its turn. The substring
 * check is only a fast path: a row without it cannot hold a tool_result block.
 */
function isBareToolResultRow(line: string, entry: Record<string, unknown>): boolean {
  if (!line.includes('"tool_result"') || SEED_MARKERS.some((marker) => line.includes(marker))) return false;
  const message = entry.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) && message.content.some((block) =>
    typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result');
}

/** Transcripts larger than this are not seeded (the run starts with an empty fold). */
export const PROGRESS_SEED_MAX_BYTES = 32 * 1024 * 1024;
/** Longest a resumed run's first live event may wait for the seed. */
export const PROGRESS_SEED_BUDGET_MS = 1500;

export type ProgressSeedOptions = {
  /** User whose Claude projects roots bound the transcript path. */
  userId?: string | number | null;
  /** Project cwd, used only when the session row has no stored path. */
  projectPath?: string | null;
  maxBytes?: number;
  /** Aborts the read; the fold keeps whatever was folded so far. */
  signal?: AbortSignal;
};

/** Contained transcript path of `sessionId`, or null when none is trusted. */
async function transcriptPath(sessionId: string, options: ProgressSeedOptions): Promise<string | null> {
  const row = sessionsDb.getSessionById(sessionId);
  return resolveClaudeTranscriptPath({
    session_id: sessionId,
    jsonl_path: row?.jsonl_path ?? null,
    project_path: row?.project_path ?? options.projectPath ?? null,
  }, options.userId ?? null);
}

/** Folds the matching lines of `file` into `fold` until EOF or abort. */
async function foldTranscript(fold: ClaudeProgressFold, file: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  const provider = new ClaudeSessionsProvider();
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const stop = (): void => { input.destroy(); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const line of lines) {
      if (signal?.aborted) return;
      if (!seedRelevant(line)) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a torn line from a concurrent write
      }
      if (entry.sessionId !== sessionId || isBareToolResultRow(line, entry)) continue;
      fold.seed(entry, provider.normalizeMessage(entry, sessionId));
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    lines.close();
    input.destroy();
  }
}

/**
 * Replays the transcript of `sessionId` into `fold` with history turn
 * boundaries (fold.seed), then closes the last seeded turn so buffered updates
 * from earlier turns are dropped; later live events use fold.observe. Never rejects.
 * @returns true when the whole transcript was folded, false when it was
 *   skipped (no trusted path, over the size cap, aborted, or unreadable).
 */
export async function seedClaudeProgressFold(
  fold: ClaudeProgressFold, sessionId: string, options: ProgressSeedOptions = {},
): Promise<boolean> {
  try {
    const file = await transcriptPath(sessionId, options);
    if (!file || options.signal?.aborted) return false;
    if ((await stat(file)).size > (options.maxBytes ?? PROGRESS_SEED_MAX_BYTES)) return false;
    await foldTranscript(fold, file, sessionId, options.signal);
    return !options.signal?.aborted;
  } catch (error) {
    // Same convention as the history loader in claude-sessions.provider.ts.
    console.warn(`[ClaudeProgressSeed] seed skipped for ${sessionId}:`, (error as Error).message);
    return false;
  } finally {
    fold.endTurn();
  }
}

/**
 * The live fold for a resumed run: seeded when the seed completes within
 * `budgetMs`, otherwise a fresh fold (a partial seed is discarded, never mixed
 * with live events). Never rejects and never waits longer than the budget.
 */
export async function createSeededLiveFold(
  liveSessionId: string | null, resumeId: string, options: ProgressSeedOptions & { budgetMs?: number } = {},
): Promise<ClaudeProgressFold> {
  const seeded = createClaudeProgressFold('live', liveSessionId);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), options.budgetMs ?? PROGRESS_SEED_BUDGET_MS);
  });
  try {
    const done = await Promise.race([
      seedClaudeProgressFold(seeded, resumeId, { ...options, signal: controller.signal }),
      timeout,
    ]);
    if (done) return seeded;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return createClaudeProgressFold('live', liveSessionId);
}
