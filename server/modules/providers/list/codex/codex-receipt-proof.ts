import { createHash } from 'node:crypto';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

import * as database from '@/modules/database/index.js';
import type { CodexUserProof } from '@/shared/utils.js';
export type { CodexUserProof } from '@/shared/utils.js';

import { validateCodexImageInput } from '../../../../../shared/codex-image-input.js';

import type { CodexTurnBaseline } from './codex-turn-metrics.js';

type Row = Record<string, any>;
export type CodexReceiptWindow = CodexTurnBaseline & { mode: 'resume' | 'new'; sessionId: string; birthtimeMs: number; boundarySha256: string };
const MAX_BYTES = 4 * 1024 * 1024;
const boundedId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/u.test(value);

/** Fingerprint complete supported display parts; never use this to select a user identity. */
export function codexReceiptPayloadHash(text: unknown, images: unknown = []): string | null {
  const validation = validateCodexImageInput(text, images);
  if (!validation.ok) return null;
  const digests: string[] = [];
  for (const image of validation.dataUrls) {
    // The SDK may normalize MIME spelling; the image bytes themselves must remain identical.
    const body = image.slice(image.indexOf(',') + 1);
    const decoded = Buffer.from(body, 'base64');
    if (decoded.toString('base64') !== body) return null;
    digests.push(createHash('sha256').update(decoded).digest('hex'));
  }
  if (typeof text !== 'string') return null;
  return createHash('sha256').update(JSON.stringify([text, digests])).digest('hex');
}

/** Preserve the old line-filter semantics while retaining ranges, not one array slot per line. */
function withoutCodexImageDelimiters(text: string): string {
  const ranges: string[] = [];
  let start = 0, runStart: number | null = null;
  for (;;) {
    const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
    const omitted = /^<\/?image(?:\s[^>]*)?>$/u.test(text.slice(start, end).trim());
    if (omitted && runStart !== null) {
      ranges.push(text.slice(runStart, start - 1)); runStart = null;
    } else if (!omitted && runStart === null) runStart = start;
    if (newline < 0) {
      if (runStart !== null) ranges.push(text.slice(runStart));
      return ranges.join('\n');
    }
    start = end + 1;
  }
}

/** Native completeness accepts only known text/image blocks, including SDK image delimiters. */
export function codexNativePayloadHash(payload: Row): string | null {
  if (!Array.isArray(payload.content) || payload.content.length > 64) return null;
  const texts: string[] = [], images: string[] = [];
  for (const part of payload.content) {
    if (part?.type === 'input_text' && typeof part.text === 'string') texts.push(part.text);
    else if (part?.type === 'input_image' && typeof part.image_url === 'string') images.push(part.image_url);
    else return null;
  }
  const joined = texts.filter(Boolean).join('\n');
  const text = images.length ? withoutCodexImageDelimiters(joined) : joined;
  return codexReceiptPayloadHash(text, images);
}

/** Hide only native goal-only records; literal wrappers and mixed human content stay visible. */
export function isCodexGoalContext(payload: Row): boolean {
  const content = payload.content;
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return Array.isArray(content) && content.length > 0
    && Array.isArray(kinds) && kinds.length === content.length
    && kinds.every((kind) => kind === 'goal.internal_context')
    && content.every((item) => item !== null && typeof item === 'object' && item.type === 'input_text');
}

/** Generated bootstrap context is not human input; require attested kinds and whole wrappers. */
export function isCodexBootstrapContext(payload: Row): boolean {
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const patterns: Record<string, RegExp> = {
    'plugins.recommendations': /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/u,
    'agents_md.instructions': /^# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/u,
    'environments.environment_context': /^<environment_context>[\s\S]*<\/environment_context>$/u,
  };
  return Array.isArray(kinds) && kinds.length >= 1 && Array.isArray(payload.content)
    && kinds.length === payload.content.length && kinds.every((kind, index) => typeof kind === 'string'
      && patterns[kind]?.test(payload.content[index]?.text?.trim() ?? '')
      && payload.content[index]?.type === 'input_text');
}

const RECEIPT_LIMITS = Object.freeze({
  chunk: 64 * 1024, window: 64 * 1024 * 1024, record: 32 * 1024 * 1024,
  work: 128 * 1024 * 1024, records: 65536, ids: 8192, depth: 64,
  recordTokens: 65536, tokens: 1048576, deadlineMs: 1500,
});
class InvalidReceipt extends Error {}
function invalid(): never { throw new InvalidReceipt(); }

/** One monotonic budget includes IO, lexer work, parsing, retries and waits. */
class ReceiptBudget {
  readonly deadline = performance.now() + RECEIPT_LIMITS.deadlineMs;
  private bytes = 0;
  private records = 0;
  private tokens = 0;
  private processedMessageIds = 0;
  check() { if (performance.now() >= this.deadline) invalid(); }
  read(bytes: number) {
    this.check();
    if (bytes < 0 || this.bytes + bytes > RECEIPT_LIMITS.work) invalid();
    this.bytes += bytes;
  }
  record() { this.check(); if (++this.records > RECEIPT_LIMITS.records) invalid(); }
  messageId() { this.check(); if (++this.processedMessageIds > RECEIPT_LIMITS.ids) invalid(); }
  token() { if (++this.tokens > RECEIPT_LIMITS.tokens) invalid(); }
  async yield() { this.check(); await yieldImmediate(); this.check(); }
}

/** Bound JSON structure before parse, ignoring punctuation inside escaped strings. */
class ReceiptStructure {
  private string = false;
  private escaped = false;
  private primitive = false;
  private depth = 0;
  private tokens = 0;
  constructor(private readonly budget: ReceiptBudget) {}
  private token() {
    if (++this.tokens > RECEIPT_LIMITS.recordTokens) invalid();
    this.budget.token();
  }
  push(bytes: Buffer) {
    for (const byte of bytes) {
      if (this.string) {
        if (this.escaped) this.escaped = false;
        else if (byte === 92) this.escaped = true;
        else if (byte === 34) this.string = false;
        continue;
      }
      if (byte === 32 || byte === 9 || byte === 10 || byte === 13) { this.primitive = false; continue; }
      if (byte === 34) { this.token(); this.string = true; this.primitive = false; continue; }
      if (byte === 123 || byte === 91) {
        this.token(); this.primitive = false;
        if (++this.depth > RECEIPT_LIMITS.depth) invalid();
      } else if (byte === 125 || byte === 93) {
        this.token(); this.primitive = false;
        if (--this.depth < 0) invalid();
      } else if (byte === 58 || byte === 44) { this.token(); this.primitive = false; }
      else if (!this.primitive) { this.token(); this.primitive = true; }
    }
  }
  finish() { if (this.string || this.escaped || this.depth !== 0) invalid(); }
}

/** Scalar native proof state is private to one snapshot, never shared by retries. */
class ReceiptReducer {
  private user: { id: string; turnId: string; hash: string } | undefined;
  private final: { id: string; turnId: string } | undefined;
  private completed: string | undefined;
  private turn: string | undefined;
  private metas = 0;
  private bootstrap = 0;
  private starts = 0;
  private readonly ids = new Set<string>();
  constructor(private readonly sessionId: string, private readonly mode: 'resume' | 'new', private readonly hash: string, private readonly budget: ReceiptBudget) {}
  observe(entry: Row) {
    const p = entry?.payload;
    if (!p || typeof p !== 'object') invalid();
    if (entry.type === 'session_meta' && (this.mode !== 'new' || ++this.metas !== 1 || this.turn || this.user
      || p.id !== this.sessionId || p.forked_from_id || p.parent_thread_id
      || (p.session_id !== undefined && p.session_id !== this.sessionId) || (p.source && typeof p.source === 'object'))) invalid();
    if (entry.type === 'event_msg' && ['turn_aborted', 'task_failed'].includes(p.type)) invalid();
    if (entry.type === 'event_msg' && p.type === 'task_started' && ++this.starts > 1) invalid();
    const turn = p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id;
    if (turn !== undefined) {
      if (this.mode === 'new' && this.metas === 0) invalid();
      if (!boundedId(turn) || (this.turn !== undefined && this.turn !== turn)) invalid();
      this.turn = turn;
    }
    if (entry.type === 'response_item' && p.type === 'message') {
      if (p.id !== undefined) {
        if (!boundedId(p.id) || this.ids.has(p.id) || this.ids.size >= RECEIPT_LIMITS.ids) invalid();
        this.budget.messageId();
        this.ids.add(p.id);
      }
      if (p.role === 'user') {
        if (isCodexGoalContext(p)) {
          if (p.isSidechain || p.isSynthetic || p.isReplay || p.parent_tool_use_id || p.agentId) invalid();
          return;
        }
        if (isCodexBootstrapContext(p)) {
          if (this.user || ++this.bootstrap > 1
            || p.isSidechain || p.isSynthetic || p.isReplay || p.parent_tool_use_id || p.agentId) invalid();
          return;
        }
        this.acceptUser(p);
      }
      if (p.role === 'assistant' && p.phase === 'final_answer') {
        if (this.final || !this.user || this.completed || !boundedId(p.id)
          || p.internal_chat_message_metadata_passthrough?.turn_id !== this.user.turnId) invalid();
        this.final = { id: p.id, turnId: this.user.turnId };
      }
    }
    if (entry.type === 'event_msg' && p.type === 'task_complete') {
      if (this.completed || !this.final || !boundedId(p.turn_id)) invalid();
      this.completed = p.turn_id;
    }
  }
  private acceptUser(p: Row) {
    const turnId = p.internal_chat_message_metadata_passthrough?.turn_id;
    if (this.user || p.isSidechain || p.isSynthetic || p.isReplay || p.parent_tool_use_id || p.agentId
      || !boundedId(p.id) || !boundedId(turnId)) invalid();
    const hash = codexNativePayloadHash(p);
    if (hash === null || hash !== this.hash) invalid();
    this.user = { id: p.id, turnId, hash };
  }
  finish(): CodexUserProof | null {
    if ((this.mode === 'new' && this.metas !== 1) || !this.user || !this.final
      || this.turn !== this.user.turnId || this.completed !== this.user.turnId) return null;
    return { version: 'codex_user_v1', userMessageId: this.user.id, turnId: this.user.turnId, payloadSha256: this.user.hash };
  }
}

function consumeReceiptRecord(bytes: Buffer, budget: ReceiptBudget, reducer: ReceiptReducer) {
  budget.check();
  if (bytes.length === 0) return;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  budget.check();
  const row = JSON.parse(text);
  budget.check();
  reducer.observe(row);
  budget.check();
}

/** Preserve the legacy four-MiB string helper, without allocating a split-line array. */
export function codexUserProofFromJsonl(text: string, sessionId: string, mode: 'resume' | 'new', expectedHash: string): CodexUserProof | null {
  if (!text.endsWith('\n') || Buffer.byteLength(text) > MAX_BYTES) return null;
  const budget = new ReceiptBudget(), reducer = new ReceiptReducer(sessionId, mode, expectedHash, budget);
  try {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      if (end < 0) return null;
      budget.record();
      const bytes = Buffer.from(text.slice(start, end)), structure = new ReceiptStructure(budget);
      for (let offset = 0; offset < bytes.length; offset += RECEIPT_LIMITS.chunk) {
        budget.check(); structure.push(bytes.subarray(offset, offset + RECEIPT_LIMITS.chunk));
      }
      structure.finish(); consumeReceiptRecord(bytes, budget, reducer);
      start = end + 1;
    }
    budget.check(); return reducer.finish();
  } catch { return null; }
}

/** Pin a real complete-line boundary; a new-thread window is explicitly zero-offset. */
export async function captureCodexReceiptWindow(sessionId: string, mode: 'resume' | 'new'): Promise<CodexReceiptWindow | null> {
  const filePath = database.sessionsDb.getSessionById(sessionId)?.jsonl_path;
  if (!filePath) return null;
  try {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return null;
      if (mode === 'resume' && stat.size) {
        const last = Buffer.alloc(1); await file.read(last, 0, 1, stat.size - 1);
        if (last[0] !== 10) return null;
      }
      const byteOffset = mode === 'new' ? 0 : stat.size;
      const boundary = Buffer.alloc(Math.min(4096, byteOffset));
      await file.read(boundary, 0, boundary.length, byteOffset - boundary.length);
      return { sessionId, mode, filePath, device: stat.dev, inode: stat.ino, byteOffset,
        birthtimeMs: stat.birthtimeMs, boundarySha256: createHash('sha256').update(boundary).digest('hex') };
    } finally { await file.close(); }
  } catch { return null; }
}

/** Read once with immutable file identity and size; mutation or oversize preserves the local copy. */
export async function readCodexReceiptWindow(window: CodexReceiptWindow): Promise<string | null> {
  if (database.sessionsDb.getSessionById(window.sessionId)?.jsonl_path !== window.filePath) return null;
  const file = await open(window.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    const bytes = before.size - window.byteOffset;
    if (!before.isFile() || before.dev !== window.device || before.ino !== window.inode || before.birthtimeMs !== window.birthtimeMs
      || bytes < 0 || bytes > MAX_BYTES) return null;
    const boundary = Buffer.alloc(Math.min(4096, window.byteOffset));
    await file.read(boundary, 0, boundary.length, window.byteOffset - boundary.length);
    if (createHash('sha256').update(boundary).digest('hex') !== window.boundarySha256) return null;
    const buffer = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      const read = await file.read(buffer, offset, bytes - offset, window.byteOffset + offset);
      if (!read.bytesRead) return null;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
    const named = await lstat(window.filePath);
    if (!named.isFile() || named.dev !== after.dev || named.ino !== after.ino || named.birthtimeMs !== after.birthtimeMs) return null;
    return buffer.toString('utf8');
  } finally { await file.close(); }
}

async function readReceiptBytes(file: FileHandle, buffer: Buffer, length: number, position: number, budget: ReceiptBudget) {
  budget.read(length);
  const result = await file.read(buffer, 0, length, position);
  budget.check();
  if (result.bytesRead !== length) invalid();
}

async function verifyReceiptBoundary(file: FileHandle, window: CodexReceiptWindow, budget: ReceiptBudget) {
  budget.check();
  const boundary = Buffer.alloc(Math.min(4096, window.byteOffset));
  await readReceiptBytes(file, boundary, boundary.length, window.byteOffset - boundary.length, budget);
  if (createHash('sha256').update(boundary).digest('hex') !== window.boundarySha256) invalid();
}

function matchesReceiptFile(stat: Stats, window: CodexReceiptWindow): boolean {
  return stat.isFile() && stat.dev === window.device && stat.ino === window.inode && stat.birthtimeMs === window.birthtimeMs;
}

async function verifyReceiptSnapshot(file: FileHandle, window: CodexReceiptWindow, before: Stats, budget: ReceiptBudget) {
  await verifyReceiptBoundary(file, window, budget);
  const after = await file.stat(), named = await lstat(window.filePath);
  budget.check();
  if (!matchesReceiptFile(after, window) || !matchesReceiptFile(named, window)
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs
    || database.sessionsDb.getSessionById(window.sessionId)?.jsonl_path !== window.filePath) invalid();
}

async function scanReceiptRecords(file: FileHandle, window: CodexReceiptWindow, size: number,
  budget: ReceiptBudget, reducer: ReceiptReducer) {
  budget.check();
  const chunk = Buffer.allocUnsafe(Math.min(RECEIPT_LIMITS.chunk, size));
  const record = Buffer.allocUnsafe(Math.min(RECEIPT_LIMITS.record, size));
  let position = window.byteOffset, length = 0, sinceYield = 0;
  let structure = new ReceiptStructure(budget);
  while (position < window.byteOffset + size) {
    const count = Math.min(chunk.length, window.byteOffset + size - position);
    await readReceiptBytes(file, chunk, count, position, budget); position += count;
    let start = 0;
    while (start < count) {
      const newline = chunk.indexOf(10, start);
      const end = newline >= 0 && newline < count ? newline + 1 : count;
      const segment = chunk.subarray(start, end);
      if (length + segment.length > RECEIPT_LIMITS.record) invalid();
      structure.push(segment); segment.copy(record, length); length += segment.length;
      sinceYield += segment.length; start = end;
      if (newline >= 0 && newline < count) {
        budget.record(); structure.finish();
        consumeReceiptRecord(record.subarray(0, length - 1), budget, reducer);
        length = 0; structure = new ReceiptStructure(budget); sinceYield = 0;
        await budget.yield();
      } else if (sinceYield >= 1024 * 1024) { sinceYield = 0; await budget.yield(); }
    }
  }
  if (length !== 0) invalid();
}

async function readCodexProofSnapshot(window: CodexReceiptWindow, expectedHash: string, budget: ReceiptBudget): Promise<CodexUserProof | null> {
  budget.check();
  if (database.sessionsDb.getSessionById(window.sessionId)?.jsonl_path !== window.filePath) invalid();
  const file = await open(window.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    budget.check();
    const before = await file.stat(), size = before.size - window.byteOffset;
    if (!matchesReceiptFile(before, window) || size < 0 || size > RECEIPT_LIMITS.window) invalid();
    await verifyReceiptBoundary(file, window, budget);
    const reducer = new ReceiptReducer(window.sessionId, window.mode, expectedHash, budget);
    await scanReceiptRecords(file, window, size, budget, reducer);
    await verifyReceiptSnapshot(file, window, before, budget);
    budget.check(); return reducer.finish();
  } finally { await file.close(); }
}

/** One shared budget; only stable incomplete snapshots or delayed new indexing can retry. */
export async function resolveCodexUserProof(sessionId: string, window: CodexReceiptWindow | null,
  newThread: boolean, expectedHash: string | null): Promise<CodexUserProof | null> {
  if (!expectedHash || (!window && !newThread)) return null;
  const budget = new ReceiptBudget();
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      budget.check();
      window ??= newThread ? await captureCodexReceiptWindow(sessionId, 'new') : null;
      budget.check();
      if (window) {
        const proof = await readCodexProofSnapshot(window, expectedHash, budget);
        budget.check();
        if (proof) return proof;
      }
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, budget.deadline - performance.now()))));
        budget.check();
      }
    }
  } catch { return null; }
  return null;
}
