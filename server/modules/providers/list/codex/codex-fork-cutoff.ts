import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import type { AnyRecord } from '@/shared/types.js';
import { logicalProjectPathForWorkspace } from '@/modules/session-workspaces/index.js';

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !/\s|[\x00-\x1f\x7f]/.test(value);

export type CodexForkCutoff = {
  turnId: string;
  messageId: string;
  messageDigest: string;
  hasLaterTurns: boolean;
};

/** Resolve one exact durable final response and its completed native turn; never a text/time match. */
export function parseCodexForkCutoff(text: string, sessionId: string, projectPath: string,
  messageId: string): CodexForkCutoff {
  if (!validId(messageId) || messageId.startsWith('item_') || messageId.startsWith('codex-history-')) {
    throw new Error('unsupported_cutoff');
  }
  const rows = text.split('\n');
  const trailingFragment = !text.endsWith('\n') ? rows.pop() : '';
  const entries: AnyRecord[] = rows.filter(Boolean).map((line) => JSON.parse(line));
  const first = entries[0];
  if (first?.type !== 'session_meta' || first.payload?.id !== sessionId
    || first.payload?.cwd !== projectPath) throw new Error('unsupported_cutoff');
  const matching = entries.filter((entry) => entry.type === 'response_item' && entry.payload?.id === messageId);
  if (matching.length !== 1) throw new Error('unsupported_cutoff');
  const selected = matching[0].payload;
  const turnId = selected?.internal_chat_message_metadata_passthrough?.turn_id;
  if (selected?.type !== 'message' || selected.role !== 'assistant'
    || selected.phase !== 'final_answer' || !validId(turnId)) throw new Error('unsupported_cutoff');
  const cutoff = inspectCutoffBoundary(entries, selected, turnId, messageId);
  return { ...cutoff, hasLaterTurns: cutoff.hasLaterTurns || Boolean(trailingFragment?.trim()) };
}

function inspectCutoffBoundary(entries: AnyRecord[], selected: AnyRecord, turnId: string,
  messageId: string): CodexForkCutoff {
  let activeTurn: string | undefined;
  let seen = false;
  let completed = false;
  let hasLaterTurns = false;
  for (const entry of entries) {
    const p = entry.payload;
    if (entry.type === 'turn_context' || (entry.type === 'event_msg' && p?.type === 'task_started')) {
      activeTurn = validId(p?.turn_id) ? p.turn_id : undefined;
      if (seen && !completed && activeTurn !== turnId) throw new Error('unsupported_cutoff');
      if (completed) hasLaterTurns = true;
    }
    if (completed && (entry.type === 'response_item' || (entry.type === 'event_msg' && p?.type === 'user_message'))) {
      hasLaterTurns = true;
      if (p?.internal_chat_message_metadata_passthrough?.turn_id === turnId) throw new Error('unsupported_cutoff');
    }
    if (seen && !completed && entry.type === 'response_item' && p?.role === 'user') throw new Error('unsupported_cutoff');
    if (entry.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') {
      const responseTurn = p.internal_chat_message_metadata_passthrough?.turn_id ?? activeTurn;
      if (p.id === messageId) {
        if (activeTurn && activeTurn !== turnId) throw new Error('unsupported_cutoff');
        seen = true;
      } else if (seen && !completed) throw new Error('unsupported_cutoff');
      if (completed || (seen && responseTurn !== turnId)) hasLaterTurns = true;
    }
    if (entry.type === 'event_msg' && p?.type === 'turn_aborted' && (p.turn_id ?? activeTurn) === turnId) {
      if (seen) throw new Error('unsupported_cutoff');
    }
    if (entry.type === 'event_msg' && p?.type === 'task_complete' && p.turn_id === turnId) {
      if (!seen || completed) throw new Error('unsupported_cutoff');
      completed = true; activeTurn = undefined;
    }
  }
  if (!completed) throw new Error('unsupported_cutoff');
  return { turnId, messageId, messageDigest: digest(JSON.stringify(selected)), hasLaterTurns };
}

async function readPrefix(file: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) throw new Error('unsupported_cutoff');
    offset += bytesRead;
  }
  return buffer;
}

/** Pin the authorized rollout fd/path and recheck its unchanged prefix before submitting a fork. */
export async function openCodexForkCutoff(input: {
  filePath: string; codexHome: string; sessionId: string; projectPath: string; messageId: string; allowAppend?: boolean;
}) {
  const root = await realpath(path.join(input.codexHome, 'sessions'));
  const canonical = await realpath(input.filePath);
  const relative = path.relative(root, canonical);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsupported_cutoff');
  const initial = await lstat(input.filePath);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new Error('unsupported_cutoff');
  const file = await open(input.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const pinned = await file.stat();
    if (!pinned.isFile() || pinned.nlink !== 1 || pinned.ino !== initial.ino || pinned.dev !== initial.dev
      || pinned.uid !== process.getuid?.() || pinned.size > MAX_TRANSCRIPT_BYTES) throw new Error('unsupported_cutoff');
    const bytes = await readPrefix(file, pinned.size);
    const prefixDigest = digest(bytes);
    const text = bytes.toString('utf8');
    const declaredCwd = JSON.parse(text.slice(0, text.indexOf('\n'))).payload?.cwd;
    if (typeof declaredCwd !== 'string'
      || await realpath(logicalProjectPathForWorkspace(declaredCwd)) !== await realpath(input.projectPath)) {
      throw new Error('unsupported_cutoff');
    }
    const cutoff = parseCodexForkCutoff(text, input.sessionId, declaredCwd, input.messageId);
    const verify = async () => {
      const current = await lstat(input.filePath);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== pinned.ino
        || current.dev !== pinned.dev || current.uid !== pinned.uid || current.size < pinned.size
        || (input.allowAppend === false && current.size !== pinned.size)
        || await realpath(input.filePath) !== canonical || digest(await readPrefix(file, pinned.size)) !== prefixDigest) {
        throw new Error('unsupported_cutoff');
      }
    };
    await verify();
    return { cutoff, canonical, declaredCwd, identity: `${pinned.dev}:${pinned.ino}:${pinned.size}:${prefixDigest}`, verify, close: () => file.close() };
  } catch (error) { await file.close(); throw error; }
}


/** History hint only: expose a durable final id once its exact native turn completes. Fork execution revalidates disk. */
export function createCodexFinalResponseTracker() {
  type Candidate = { id: string; turnId: string; raw?: AnyRecord; invalid?: boolean };
  const byId = new Map<string, Candidate>();
  const completed = new Map<string, Candidate>();
  let pending: Candidate | undefined;
  let activeTurn: string | undefined;
  let invalidTranscript = false;
  const invalidate = (candidate?: Candidate) => {
    if (!candidate) return;
    candidate.invalid = true;
    if (candidate.raw) delete candidate.raw.transcriptMessageId;
  };
  return {
    observe(entry: AnyRecord) {
      if (invalidTranscript) return;
      const p = entry.payload;
      if (entry.type === 'turn_context' || (entry.type === 'event_msg' && p?.type === 'task_started')) {
        activeTurn = p?.turn_id;
        if (pending && pending.turnId !== activeTurn) { invalidate(pending); pending = undefined; }
      }
      if (entry.type === 'response_item' && p?.type === 'message') {
        const turnId = p.internal_chat_message_metadata_passthrough?.turn_id;
        if (completed.has(turnId)) invalidate(completed.get(turnId));
        if (pending) { invalidate(pending); pending = undefined; }
        if (byId.has(p.id)) { invalidate(byId.get(p.id)); return; }
        const candidate: Candidate = { id: p.id, turnId };
        if (validId(p.id)) byId.set(p.id, candidate);
        if (p.role === 'assistant' && p.phase === 'final_answer' && validId(p.id) && validId(turnId)
          && !p.id.startsWith('item_') && !p.id.startsWith('codex-history-')
          && (!activeTurn || activeTurn === turnId)) pending = candidate;
      }
      if (entry.type === 'event_msg' && p?.type === 'turn_aborted') {
        invalidate(completed.get(p.turn_id ?? activeTurn)); invalidate(pending); pending = undefined;
      }
      if (entry.type === 'event_msg' && p?.type === 'task_complete') {
        if (completed.has(p.turn_id)) invalidate(completed.get(p.turn_id));
        if (pending && pending.turnId === p.turn_id && !pending.invalid) {
          if (pending.raw) pending.raw.transcriptMessageId = pending.id;
          completed.set(p.turn_id, pending); pending = undefined; activeTurn = undefined;
        }
      }
    },
    bind(raw: AnyRecord) { if (pending && pending.id === raw.uuid) pending.raw = raw; },
    invalidateAll() { invalidTranscript = true; for (const value of byId.values()) invalidate(value); pending = undefined; },
  };
}
