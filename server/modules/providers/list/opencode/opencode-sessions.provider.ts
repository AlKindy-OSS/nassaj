import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { readResponseModel } from '@/modules/providers/shared/response-model.js';
import { formatToolContent, openCodeToolPart } from '@/modules/providers/list/opencode/opencode-tool-part.js';
import { redactLiteralSecrets } from '@/services/isolation/opencode-qwen-plan.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { buildProgressSubagent } from '@/shared/progress-normalize.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
} from '@/shared/utils.js';

import {
  findOpenCodeDatabaseForSession,
  operatorOpenCodeDatabasePath,
  resolveOpenCodeDataHomeOwner,
} from './opencode-home.js';
import { collectOpenCodeSessionSecrets } from './opencode-redaction-secrets.js';

const PROVIDER = 'opencode';

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

type OpenCodeChildTool = { name: string; status: string };

export function readChildTools(
  db: Database.Database,
  parentSessionId: string,
): Map<string, OpenCodeChildTool[]> {
  const grouped = new Map<string, Map<string, OpenCodeChildTool>>();
  const rows = db.prepare(`
    SELECT p.session_id AS session_id, p.id AS part_id, p.data AS part_data
    FROM session child
    JOIN part p ON p.session_id = child.id
    WHERE child.parent_id = ?
    ORDER BY COALESCE(p.time_created, 0), p.id
  `).all(parentSessionId) as Array<{
    session_id: string; part_id: string; part_data: string | null;
  }>;
  for (const row of rows) {
    const part = readJsonRecord(row.part_data);
    if (part?.type !== 'tool') continue;
    const state = readObjectRecord(part.state);
    const name = readOptionalString(part.tool);
    if (!name) continue;
    const status = readOptionalString(state?.status) ?? 'running';
    const tools = grouped.get(row.session_id) ?? new Map<string, OpenCodeChildTool>();
    tools.set(row.part_id, { name, status: status === 'error' ? 'failed' : status });
    grouped.set(row.session_id, tools);
  }
  return new Map([...grouped].map(([id, tools]) => [id, [...tools.values()]]));
}

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type OpenedOpenCodeDatabase = { db: Database.Database; dbPath: string };

/**
 * B-1669: opens the opencode.db that holds `sessionId` — the operator DB or a
 * member's own DB — falling back to the operator DB (empty history) when no
 * DB has the id. Null only when that fallback file is absent too.
 */
const openOpenCodeDatabase = (sessionId: string): OpenedOpenCodeDatabase | null => {
  const dbPath = findOpenCodeDatabaseForSession(sessionId) ?? operatorOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return { db: new Database(dbPath, { readonly: true, fileMustExist: true }), dbPath };
};

/**
 * OpenCode can persist the first prompt as a JSON string literal inside a text
 * part, for example `"hello"` instead of `hello`. Decode only complete JSON
 * string literals so normal assistant/user prose remains untouched.
 */
const unwrapJsonStringLiteral = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

const hasUserRole = (value: unknown): boolean => {
  const record = readObjectRecord(value);
  return readOptionalString(record?.role) === 'user';
};

/**
 * B-1298(b): non-secret error codes surfaced to the client so it can show a specific
 * message (auth vs context overflow) instead of the generic dispatch fallback. The
 * codes are fixed strings — no provider text, URL or key is ever placed in them.
 */
export const OPENCODE_AUTH_ERROR_CODE = 'provider_auth_failed';
export const OPENCODE_CONTEXT_OVERFLOW_CODE = 'provider_context_overflow';

/** Reads an HTTP status from an error event or its nested error/data object. */
const readErrorStatus = (value: unknown): number | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }
  const candidate = record.statusCode ?? record.status;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return candidate;
  }
  if (typeof candidate === 'string' && /^\d{3}$/u.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
};

/**
 * Classifies an OpenCode `type:'error'` event into a specific non-secret code, or
 * undefined when it is an ordinary error. Auth is detected from a 401/403 status
 * (nested or top-level) or an unmistakable auth phrase; context overflow from the
 * usual "context length/window exceeded" wording. Matching runs on the message text
 * only for classification — the emitted code never carries that text.
 */
const classifyOpenCodeError = (raw: AnyRecord, message: string): string | undefined => {
  const status = readErrorStatus(raw) ?? readErrorStatus(raw.error) ?? readErrorStatus(raw.data);
  if (status === 401 || status === 403) {
    return OPENCODE_AUTH_ERROR_CODE;
  }
  const text = message.toLowerCase();
  if (/context[\s_-]*(?:length|window|limit|size)|maximum context|exceeds?[^.]*context|context[^.]*(?:exceed|overflow)|too many tokens|reduce the length of the messages/u.test(text)) {
    return OPENCODE_CONTEXT_OVERFLOW_CODE;
  }
  if (status === undefined && /\b(?:401|403|unauthori[sz]ed|forbidden|invalid api key|authentication failed|missing api key)\b/u.test(text)) {
    return OPENCODE_AUTH_ERROR_CODE;
  }
  return undefined;
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
};

const buildTokenUsage = (totals: OpenCodeTokenTotals | undefined): AnyRecord | undefined => {
  if (!totals) {
    return undefined;
  }

  const inputTokens = totals.inputTokens;
  const displayInputTokens = inputTokens + totals.cacheReadTokens;
  const outputTokens = totals.outputTokens;
  const used = inputTokens
    + outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens: displayInputTokens,
    outputTokens,
    breakdown: {
      input: displayInputTokens,
      output: outputTokens,
    },
  };
};

const readOpenCodeSessionColumnTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return undefined;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM session
    WHERE id = ?
  `).get(sessionId) as OpenCodeTokenTotals | undefined;

  if (!row) {
    return undefined;
  }

  return buildTokenUsage({
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
  });
};

/**
 * OpenCode stores per-message token counts on assistant `message.data` objects
 * (see MessageV2.Assistant). Older DBs also had session-level counters; this
 * matches current `opencode.db` layouts that only persist message JSON.
 */
const aggregateOpenCodeSessionTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionColumnUsage = readOpenCodeSessionColumnTokenUsage(db, sessionId);
  if (sessionColumnUsage) {
    return sessionColumnUsage;
  }

  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(info?.tokens);
    if (!tokens) {
      continue;
    }

    inputTokens += Number(tokens.input ?? 0);
    outputTokens += Number(tokens.output ?? 0);
    reasoningTokens += Number(tokens.reasoning ?? 0);
    const cache = readObjectRecord(tokens.cache);
    cacheReadTokens += Number(cache?.read ?? 0);
    cacheWriteTokens += Number(cache?.write ?? 0);
  }

  return buildTokenUsage({
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
};

/**
 * ADR-205 D9: OpenCode keeps a user's attached images and files as separate
 * `file` parts whose bytes live in a temp dir or are passed by path, so the
 * history cannot serve them. Each is counted onto the user text row of the
 * same message as `attachmentsUnavailable`, in whichever order the parts come.
 */
class UserAttachmentTally {
  private readonly texts = new Map<string, NormalizedMessage>();
  private readonly pending = new Map<string, { image: number; file: number }>();

  /** Records the user text row of `messageId` and applies counts seen before it. */
  text(messageId: string, message: NormalizedMessage): void {
    this.texts.set(messageId, message);
    const early = this.pending.get(messageId);
    if (!early) return;
    this.pending.delete(messageId);
    message.attachmentsUnavailable = early;
  }

  /** Counts one user `file` part by its MIME type. */
  file(messageId: string, partData: Record<string, unknown>): void {
    const kind = (readOptionalString(partData.mime) ?? '').startsWith('image/') ? 'image' : 'file';
    const target = this.texts.get(messageId);
    const counts = target?.attachmentsUnavailable ?? this.pending.get(messageId) ?? {};
    const next = { image: counts.image ?? 0, file: counts.file ?? 0 };
    next[kind] += 1;
    if (target) target.attachmentsUnavailable = next;
    else this.pending.set(messageId, next);
  }
}

export class OpenCodeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live `opencode run --format json` events into frontend messages.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionID) ?? readOptionalString(raw.sessionId) ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const baseId = readOptionalString(raw.id)
      ?? readOptionalString(raw.messageID)
      ?? generateMessageId('opencode');

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw)) {
        return [];
      }

      // Real `opencode run --format json` text lines nest the content under
      // `part` (`{type:'text', part:{type:'text', text:'…'}}`), so `raw.part`
      // must be read first — reading `raw.text` alone left content empty and the
      // whole live reply was dropped (B-1296). Kept consistent with the history
      // path below, which normalizes the same `{type,text}` part shape.
      // Fall through on an EMPTY part, not merely an absent one: a present part
      // that carries no text (`part:{type:'text'}` beside a top-level `text`)
      // would otherwise re-introduce the same dropped-reply defect.
      const content = extractText(raw.part) || extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content,
        model: readResponseModel(raw.modelID ?? raw.message?.modelID),
      })];
    }

    if (type === 'reasoning') {
      // B-1296: reasoning parts nest identically under `part`; read it first and
      // fall through on an empty one for the same reason as the text branch.
      const content = extractText(raw.part) || extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      // B-1560: real lines nest the tool under `part` (`part.tool`, `part.callID`,
      // `part.state.{status,input,output}`); the flat `raw.*` reads stay a fallback.
      const tool = openCodeToolPart(raw.part, raw);
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: tool.toolName,
        toolInput: tool.toolInput,
        toolId: tool.toolId ?? baseId,
        ...(tool.toolResult ? { toolResult: tool.toolResult } : {}),
        // ADR-199 Addendum B §16: live stamps every todowrite snapshot.
        ...(tool.plan ? { plan: tool.plan } : {}),
        ...(tool.subagent ? { subagent: tool.subagent } : {}),
      })];
    }

    if (type === 'error') {
      const errorRecord = readObjectRecord(raw.error) ?? readObjectRecord(raw.data);
      const content = readOptionalString(raw.error)
        ?? readOptionalString(raw.message)
        ?? readOptionalString(errorRecord?.message)
        ?? readOptionalString(errorRecord?.name)
        ?? 'Unknown OpenCode error';
      // B-1298(b): attach a fixed non-secret code (auth / context-overflow) when the
      // event is one of those, so the client can show a specific message. `content`
      // keeps the provider's own error text; only the code is added.
      const code = classifyOpenCodeError(raw, content);
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content,
        ...(code ? { code } : {}),
      })];
    }

    if (type === 'step_finish') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history from the opencode.db that holds the session (the
   * operator DB or a member's own DB). The caller must already have authorised
   * the session row: sessionsService.fetchHistory runs isSessionAccessibleByUser
   * first, and any new direct caller must keep that gate.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const opened = openOpenCodeDatabase(sessionId);
    if (!opened) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null, readFailed: true };
    }
    const { db, dbPath } = opened;

    try {
      const rows = db.prepare(`
        SELECT
          m.id AS message_id,
          m.time_created AS message_time_created,
          m.data AS message_data,
          p.id AS part_id,
          p.time_created AS part_time_created,
          p.data AS part_data
        FROM message m
        LEFT JOIN part p
          ON p.session_id = m.session_id
         AND p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY
          COALESCE(m.time_created, 0),
          m.id,
          COALESCE(p.time_created, 0),
          p.id
      `).all(sessionId) as OpenCodeHistoryRow[];

      // M-6: redact for the owner (and auth.json) of the DB actually read.
      const dataHome = path.dirname(dbPath);
      const secrets = collectOpenCodeSessionSecrets(sessionId, {
        dataHome,
        extraUserIds: [resolveOpenCodeDataHomeOwner(dataHome)],
      });
      let childTools = new Map<string, OpenCodeChildTool[]>();
      try {
        childTools = readChildTools(db, sessionId);
      } catch (error) {
        console.warn('[OpenCodeProvider] Child tool enrichment unavailable:',
          error instanceof Error ? error.message : String(error));
      }
      const normalized = this.normalizeHistoryRows(rows, sessionId, childTools, secrets);
      const tokenUsage = aggregateOpenCodeSessionTokenUsage(db, sessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const messages = normalizedLimit === null
        ? normalized
        : normalized.slice(
            Math.max(0, total - normalizedOffset - normalizedLimit),
            Math.max(0, total - normalizedOffset),
          );

      return {
        messages,
        total,
        hasMore: normalizedLimit === null
          ? false
          : Math.max(0, total - normalizedOffset - normalizedLimit) > 0,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null, readFailed: true };
    } finally {
      db.close();
    }
  }

  private normalizeHistoryRows(
    rows: OpenCodeHistoryRow[],
    sessionId: string,
    childTools: Map<string, OpenCodeChildTool[]> = new Map(),
    secrets: ReadonlyArray<unknown> = [],
  ): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();
    // ADR-200 §8 / M-5: under ADR-089 every member reads every session, so the
    // current vendor keys of EVERY sender in it are redacted, not the reader's.
    // M-6: the owner of the data dir this history is read from, and the
    // auth.json in that dir, are covered too (same rule as the synchronizer).
    // ADR-199 Addendum B §16: each todowrite is a full snapshot, so history
    // stamps only the last one of each turn (a user message opens a turn).
    let turnPlan: { message: NormalizedMessage; plan: NonNullable<NormalizedMessage['plan']> } | null = null;
    const attachments = new UserAttachmentTally();
    const closeTurn = (): void => {
      if (turnPlan) turnPlan.message.plan = turnPlan.plan;
      turnPlan = null;
    };

    for (const storedRow of rows) {
      // A key a model echoed into opencode.db is redacted on read, before any
      // field is parsed or returned.
      const row: OpenCodeHistoryRow = {
        ...storedRow,
        message_data: redactLiteralSecrets(storedRow.message_data, secrets),
        part_data: redactLiteralSecrets(storedRow.part_data, secrets),
      };
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);
      if (messageRole === 'user') {
        closeTurn();
      }

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        normalized.push(createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      if (!row.part_id) {
        continue;
      }

      const partData = readJsonRecord(row.part_data) ?? {};
      const partType = readOptionalString(partData.type);
      if (!partType) {
        continue;
      }

      if (partType === 'text') {
        const content = extractText(partData);
        if (content.trim()) {
          const message = createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            model: messageRole === 'assistant' ? readResponseModel(messageInfo?.modelID) : undefined,
            content,
          });
          if (messageRole === 'user') attachments.text(row.message_id, message);
          normalized.push(message);
        }
        continue;
      }

      if (partType === 'file' && messageRole === 'user') {
        attachments.file(row.message_id, partData);
        continue;
      }

      if (partType === 'reasoning') {
        const content = extractText(partData);
        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          }));
        }
        continue;
      }

      if (partType === 'tool') {
        const tool = openCodeToolPart(partData);
        const childSessionId = readOptionalString(readObjectRecord(
          readObjectRecord(partData.state)?.metadata,
        )?.sessionId);
        const childSessionTools = childSessionId
          ? childTools.get(childSessionId) : undefined;
        const toolMessage = createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: tool.toolName,
          toolInput: tool.toolInput,
          toolId: tool.toolId ?? row.part_id,
          ...(tool.toolResult ? { toolResult: tool.toolResult } : {}),
          ...(tool.subagent ? {
            subagent: buildProgressSubagent({
              ...tool.subagent,
              ...(childSessionTools ? { tools: childSessionTools.map((childTool) => ({
                ...childTool,
                name: redactLiteralSecrets(childTool.name, secrets),
                status: redactLiteralSecrets(childTool.status, secrets),
              })) } : {}),
            }) ?? tool.subagent,
          } : {}),
        });
        if (tool.plan) {
          turnPlan = { message: toolMessage, plan: tool.plan };
        }

        normalized.push(toolMessage);
        continue;
      }

      if (partType === 'step-finish') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
        continue;
      }

      if (partType === 'patch' || partType === 'agent') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: partType === 'patch' ? 'Patch' : 'Agent',
          toolInput: partData,
          toolId: row.part_id,
        }));
      }
    }

    closeTurn();
    return normalized;
  }
}
