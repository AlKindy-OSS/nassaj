import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { isSessionId } from '@/shared/session-id.js';

import {
  claudeTranscriptContextSnapshot,
  latestClaudeCacheTtlMinutes,
  latestClaudeTokenUsage,
  readClaudeTranscriptForSession,
} from '../list/claude/claude-token-usage.js';
import { extractCodexTokenBudget } from '../list/codex/codex-token-budget.js';
import { knownOpenCodeDatabasePaths } from '../list/opencode/opencode-home.js';
import { TRANSCRIPT_TAIL_MAX_BYTES } from '../shared/pinned-tail.js';
import { isTranscriptHandle, openRecordedTranscript } from '../shared/session-transcript-reader.js';

/**
 * GET /api/projects/:projectId/sessions/:sessionId/token-usage (B-1643, T-2034).
 *
 * The session ROW is the authority: it must exist, belong to the project whose
 * visibility the route already checked, and its own `provider` picks the
 * reader. Nothing is located by searching a tree for a name, every transcript
 * is opened through the ADR-201 pinned reader (tree-confined, bound to the id
 * by name and header) and read only from its tail, and no response carries a
 * filesystem path.
 */

export type TokenUsageReply = { status: number; body: Record<string, unknown> };

type SessionRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  jsonl_path: string | null;
};

/** Collaborators the route injects (the DB repositories in production). */
export type TokenUsageDeps = {
  getSessionById: (sessionId: string) => SessionRow | null;
  getProjectPathById: (projectId: string) => string | null | Promise<string | null>;
  /** opencode.db files to search; defaults to {@link existingOpenCodeDatabasePaths}. */
  openCodeDatabasePaths?: () => string[];
};

export type TokenUsageRequest = {
  projectId: string;
  sessionId: unknown;
  provider: unknown;
};

const reply = (status: number, body: Record<string, unknown>): TokenUsageReply => ({ status, body });
const SESSION_NOT_FOUND = reply(404, { error: 'Session not found' });
const TRANSCRIPT_UNAVAILABLE = reply(404, { error: 'Session file not found', reason: 'transcript_unavailable' });
const EMPTY_CODEX_BUDGET = { used: null, total: null, contextSnapshot: null, cacheSnapshot: null };

/**
 * Resolves the token usage of one session after the caller has passed the
 * project-visibility gate. Returns the HTTP status and JSON body to send.
 */
export async function readSessionTokenUsage(
  request: TokenUsageRequest, deps: TokenUsageDeps,
): Promise<TokenUsageReply> {
  if (!isSessionId(request.sessionId)) return reply(400, { error: 'Invalid sessionId' });
  const projectPath = await deps.getProjectPathById(request.projectId);
  if (!projectPath) return reply(404, { error: 'Project not found' });
  const row = deps.getSessionById(request.sessionId);
  // Same 404 for "no such session" and "session of another project": no disclosure.
  if (!row || row.project_path !== projectPath) return SESSION_NOT_FOUND;
  if (request.provider !== undefined && request.provider !== row.provider) {
    return reply(400, { error: 'Provider does not match session' });
  }

  switch (row.provider) {
    case 'cursor': return reply(200, CURSOR_UNSUPPORTED);
    case 'opencode': return readOpenCodeUsage(row, (deps.openCodeDatabasePaths ?? existingOpenCodeDatabasePaths)());
    case 'codex': return readCodexUsage(row);
    case 'claude': return readClaudeUsage(row, projectPath);
    default: return TRANSCRIPT_UNAVAILABLE;
  }
}

const CURSOR_UNSUPPORTED = {
  used: 0,
  total: 0,
  inputTokens: 0,
  outputTokens: 0,
  breakdown: { input: 0, output: 0 },
  unsupported: true,
  message: 'Token usage tracking not available for Cursor sessions',
};

async function readClaudeUsage(row: SessionRow, projectPath: string): Promise<TokenUsageReply> {
  const fileContent = await readClaudeTranscriptForSession(row, projectPath);
  if (fileContent === null) return TRANSCRIPT_UNAVAILABLE;
  const { inputTokens, outputTokens, modelName, breakdown, cacheSnapshot } = latestClaudeTokenUsage(fileContent, row.session_id);
  // A restored transcript exposes request input, not a fresh native context measurement;
  // B-1356: the window comes from the model id, or stays null when it is not known.
  const contextSnapshot = claudeTranscriptContextSnapshot(row.session_id, modelName, inputTokens);
  return reply(200, {
    used: null,
    total: null,
    contextSnapshot,
    cacheSnapshot,
    inputTokens,
    outputTokens,
    breakdown,
    cacheTtlMinutes: latestClaudeCacheTtlMinutes(fileContent),
  });
}

// ---------------------------------------------------------------- Codex

/** First tail window; widened ×4 per step up to TRANSCRIPT_TAIL_MAX_BYTES. */
export const CODEX_USAGE_INITIAL_WINDOW_BYTES = 1024 * 1024;
const UNKNOWN_MODEL = Symbol('unknown-model');

type CodexScan = { budget: Record<string, unknown> | null; settled: boolean };

/**
 * Replays the Codex rollout rules over `text`: the last `token_count` read with
 * the model of the last `turn_context` before it, reset by a compaction or a
 * model switch after it. `complete` says `text` starts at the file start. The
 * answer is `settled` when the window already decides it: the model at the last
 * token_count is known, or a compaction after it voids it.
 */
export function scanCodexUsage(text: string, sessionId: string, complete: boolean): CodexScan {
  let budget: Record<string, unknown> | null = null;
  let model: string | null | typeof UNKNOWN_MODEL = complete ? null : UNKNOWN_MODEL;
  let modelKnownAtCount = false;
  let compactedAfterCount = false;
  for (const line of text.split('\n')) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === 'turn_context') {
      const next = entry.payload?.model ?? null;
      // A count read before the window's first turn_context keeps its usage:
      // the model in effect there is unknown, not known to differ.
      if (model !== UNKNOWN_MODEL && model !== next) budget = null;
      model = next;
    }
    if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count') {
      budget = extractCodexTokenBudget(entry, model === UNKNOWN_MODEL ? null : model, sessionId, 'history');
      modelKnownAtCount = model !== UNKNOWN_MODEL;
      compactedAfterCount = false;
    }
    if (entry?.type === 'compacted' || entry?.payload?.type === 'context_compacted') {
      budget = null;
      compactedAfterCount = true;
    }
  }
  return { budget, settled: complete || modelKnownAtCount || compactedAfterCount };
}

/** Bytes [start, end) of the pinned descriptor, read positionally. */
async function readRange(fd: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await fd.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** UTF-8 text of `bytes`, dropping the partial first line unless it starts the file. */
function recordText(bytes: Buffer, startsFile: boolean): string {
  if (startsFile) return bytes.toString('utf8');
  const boundary = bytes.indexOf(0x0a);
  return boundary < 0 ? '' : bytes.subarray(boundary + 1).toString('utf8');
}

/**
 * Latest Codex usage from the END of the pinned rollout. Starts with a small
 * window and widens backwards only while the answer is not settled (the model
 * in effect at the last token_count lies further back), never reading more
 * than `maxBytes` and never reading a byte twice.
 */
export async function latestCodexUsageFromTail(
  fd: FileHandle, sessionId: string, maxBytes: number = TRANSCRIPT_TAIL_MAX_BYTES,
): Promise<Record<string, unknown> | null> {
  const { size } = await fd.stat();
  const floor = Math.max(0, size - maxBytes);
  let window = Math.min(CODEX_USAGE_INITIAL_WINDOW_BYTES, maxBytes);
  let start = size;
  let bytes = Buffer.alloc(0);
  for (;;) {
    const next = Math.max(floor, size - window);
    bytes = Buffer.concat([await readRange(fd, next, start), bytes]);
    start = next;
    const scan = scanCodexUsage(recordText(bytes, start === 0), sessionId, start === 0);
    if (scan.settled || start === floor) return scan.budget;
    window *= 4;
  }
}

async function readCodexUsage(row: SessionRow): Promise<TokenUsageReply> {
  const opened = await openRecordedTranscript(
    { session_id: row.session_id, provider: 'codex', jsonl_path: row.jsonl_path ?? null }, 'token-usage',
  );
  if (!isTranscriptHandle(opened)) return TRANSCRIPT_UNAVAILABLE;
  try {
    return reply(200, (await latestCodexUsageFromTail(opened.fd, row.session_id)) ?? EMPTY_CODEX_BUDGET);
  } catch (error) {
    console.warn('Codex token usage read failed', {
      event: 'token_usage_read_failed', sessionId: row.session_id, code: (error as NodeJS.ErrnoException)?.code ?? null,
    });
    return TRANSCRIPT_UNAVAILABLE;
  } finally {
    await opened.fd.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- OpenCode

const OPENCODE_TOKEN_COLUMNS = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];

type OpenCodeTokenRow = {
  inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
};

/**
 * Existing opencode.db files a session may live in: the operator DB and every
 * member's own DB (ADR-089: every member of a visible project reads all its
 * sessions, whoever spawned them). Pure path computation, no provisioning.
 */
export function existingOpenCodeDatabasePaths(): string[] {
  return knownOpenCodeDatabasePaths().filter((dbPath) => fs.existsSync(dbPath));
}

type OpenCodeLookup = { unsupported: true } | { row: OpenCodeTokenRow | null };

function lookupOpenCodeTokens(dbPath: string, sessionId: string): OpenCodeLookup {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!OPENCODE_TOKEN_COLUMNS.every((column) => columns.has(column))) return { unsupported: true };
    const row = db.prepare(`
      SELECT tokens_input AS inputTokens, tokens_output AS outputTokens, tokens_reasoning AS reasoningTokens,
             tokens_cache_read AS cacheReadTokens, tokens_cache_write AS cacheWriteTokens
      FROM session WHERE id = ?
    `).get(sessionId) as OpenCodeTokenRow | undefined;
    return { row: row ?? null };
  } finally {
    db.close();
  }
}

function openCodeUsageBody(row: OpenCodeTokenRow): Record<string, unknown> {
  const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
  const outputTokens = Number(row.outputTokens || 0);
  const used = Number(row.inputTokens || 0) + outputTokens + Number(row.reasoningTokens || 0)
    + Number(row.cacheReadTokens || 0) + Number(row.cacheWriteTokens || 0);
  return { used, inputTokens, outputTokens, breakdown: { input: inputTokens, output: outputTokens } };
}

const OPENCODE_UNSUPPORTED_SCHEMA = {
  used: 0,
  inputTokens: 0,
  outputTokens: 0,
  breakdown: { input: 0, output: 0 },
  unsupported: true,
  message: 'Token usage tracking is not available in this OpenCode database schema',
};

/**
 * Looks the authorised row up by exact id in each database. A database with an
 * older schema, or one that cannot be read, does not hide a later match.
 */
function readOpenCodeUsage(row: SessionRow, paths: string[]): TokenUsageReply {
  if (paths.length === 0) return reply(404, { error: 'OpenCode database not found' });
  let sawUnsupportedSchema = false;
  for (const dbPath of paths) {
    let found: OpenCodeLookup;
    try {
      found = lookupOpenCodeTokens(dbPath, row.session_id);
    } catch (error) {
      console.warn('OpenCode token usage lookup failed', {
        event: 'token_usage_read_failed', sessionId: row.session_id, code: (error as { code?: string })?.code ?? null,
      });
      continue;
    }
    if ('unsupported' in found) sawUnsupportedSchema = true;
    else if (found.row) return reply(200, openCodeUsageBody(found.row));
  }
  return sawUnsupportedSchema
    ? reply(200, OPENCODE_UNSUPPORTED_SCHEMA)
    : reply(404, { error: 'OpenCode session not found' });
}
