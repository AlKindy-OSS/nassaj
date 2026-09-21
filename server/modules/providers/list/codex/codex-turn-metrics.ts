import { open } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';

type RecordValue = Record<string, unknown>;

export type DurableCodexCompletedTurn = {
  turnId: string;
  assistantMessageId: string;
};

export type CodexTurnBaseline = {
  filePath: string;
  device: number;
  inode: number;
  byteOffset: number;
};

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null;

/**
 * Resolves the turn Codex durably completed inside this run's append window.
 *
 * The join is positional-in-time, not identity based: SDK `item_N` identifiers
 * are transport-local and never appear in the rollout, so they cannot be
 * compared with the durable `payload.id`.  What proves ownership is the
 * inode/offset-bound append window (readCodexJsonlAppend) plus Codex's own
 * `task_complete` attestation for the same `turn_id`.
 *
 * Only the NEWEST final answer is eligible.  An older completion that shares
 * the window can therefore never win, and a newest answer still waiting for its
 * `task_complete` yields null so the caller keeps retrying instead of stamping
 * a stale turn.
 */
export function newestCompletedTurnFromJsonl(
  text: string,
  excludedTurnIds: ReadonlySet<string> = new Set(),
): DurableCodexCompletedTurn | null {
  const finalAssistantByTurn = new Map<string, string>();
  const completedTurnIds = new Set<string>();

  for (const line of text.split('\n')) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isRecord(entry) || !isRecord(entry.payload)) continue;
    const payload = entry.payload;

    if (
      entry.type === 'response_item'
      && payload.type === 'message'
      && payload.role === 'assistant'
      && payload.phase === 'final_answer'
      && typeof payload.id === 'string'
      && isRecord(payload.internal_chat_message_metadata_passthrough)
      && typeof payload.internal_chat_message_metadata_passthrough.turn_id === 'string'
    ) {
      finalAssistantByTurn.set(
        payload.internal_chat_message_metadata_passthrough.turn_id,
        payload.id,
      );
      continue;
    }

    if (
      entry.type === 'event_msg'
      && payload.type === 'task_complete'
      && typeof payload.turn_id === 'string'
    ) {
      completedTurnIds.add(payload.turn_id);
    }
  }

  const candidates = [...finalAssistantByTurn].filter(([turnId]) => !excludedTurnIds.has(turnId));
  const newest = candidates.at(-1);
  if (!newest || !completedTurnIds.has(newest[0])) return null;
  return { turnId: newest[0], assistantMessageId: newest[1] };
}

const MAX_APPEND_BYTES = 4 * 1024 * 1024;
const RETRIES = 6;

export async function readCodexJsonlAppend(baseline: CodexTurnBaseline): Promise<string | null> {
  const filePath = baseline.filePath;
  const handle = await open(filePath, 'r');
  try {
    const file = await handle.stat();
    if (
      file.dev !== baseline.device
      || file.ino !== baseline.inode
      || file.size < baseline.byteOffset
      || file.size - baseline.byteOffset > MAX_APPEND_BYTES
    ) return null;
    const bytes = file.size - baseline.byteOffset;
    if (bytes === 0) return '';
    const buffer = Buffer.allocUnsafe(bytes);
    let read = 0;
    while (read < bytes) {
      const chunk = await handle.read(buffer, read, bytes - read, baseline.byteOffset + read);
      if (chunk.bytesRead === 0) return null;
      read += chunk.bytesRead;
    }
    return buffer.toString('utf8', 0, read);
  } finally {
    await handle.close();
  }
}

/**
 * Captures the durable state before a run starts.  This baseline IS the join:
 * every byte read afterwards was appended by this run, on the same inode, so a
 * completion that predates the run can never be seen at all.
 */
export async function captureCodexTurnBaseline(sessionId: string): Promise<CodexTurnBaseline | null> {
  const filePath = sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null;
  if (!filePath) return null;
  try {
    const handle = await open(filePath, 'r');
    try {
      const file = await handle.stat();
      return { filePath, device: file.dev, inode: file.ino, byteOffset: file.size };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Codex flushes its JSONL independently from the SDK stream.  A small bounded
 * retry waits for that durable proof; absence remains absence, never a guess.
 */
export async function resolveCompletedCodexTurn(
  sessionId: string,
  baseline: CodexTurnBaseline | null,
): Promise<DurableCodexCompletedTurn | null> {
  if (!baseline) return null;
  const filePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
  if (!filePath) return null;
  // A changed path means the indexed session was replaced/re-synchronized
  // during this run. Do not join timing across two physical transcripts.
  if (baseline.filePath !== filePath) return null;

  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const text = await readCodexJsonlAppend(baseline);
      if (text === null) return null;
      const found = newestCompletedTurnFromJsonl(text);
      if (found) return found;
    } catch {
      return null;
    }
    if (attempt + 1 < RETRIES) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}
