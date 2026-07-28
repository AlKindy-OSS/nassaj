import fsSync from 'node:fs';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';

const PROVIDER = 'antigravity' as const;

type AgyTranscriptLine = {
  step_index: number;
  source: 'USER_EXPLICIT' | 'SYSTEM' | 'MODEL';
  type:
    | 'USER_INPUT'
    | 'CONVERSATION_HISTORY'
    | 'PLANNER_RESPONSE'
    | 'RUN_COMMAND'
    | 'SYSTEM_MESSAGE';
  status: 'DONE' | 'RUNNING';
  created_at: string;
  content?: string;
  thinking?: string;
};

/**
 * Extracts the user-authored text from a USER_INPUT transcript line.
 *
 * agy wraps the actual prompt in `<USER_REQUEST>...</USER_REQUEST>` and appends
 * environment metadata blocks after it. If the markers are missing we fall back
 * to the raw content so we never drop a user turn just because the wrapper drifts.
 *
 * `<instructions>...</instructions>` blocks are stripped because agy injects them
 * as system-level directives (e.g. response-language rules); they are not part of
 * what the human typed, so surfacing them as the user turn would be misleading.
 * The match is global so every injected block is removed, not just the first.
 */
function extractUserRequest(rawContent: string | undefined): string {
  if (!rawContent) {
    return '';
  }

  let text = rawContent;
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (match && typeof match[1] === 'string') {
    text = match[1];
  }

  text = text.replace(/<instructions>[\s\S]*?<\/instructions>/gi, '');

  return text.trim();
}

/**
 * Pulls the task result body out of a SYSTEM_MESSAGE transcript line.
 *
 * SYSTEM_MESSAGE entries occasionally carry sub-task output wrapped in
 * `<TASK_RESULT>` or `<RESULT>` tags. When neither tag exists we return the
 * cleaned content directly so tool_result still surfaces useful text.
 */
function extractSystemResult(rawContent: string | undefined): string {
  if (!rawContent) {
    return '';
  }

  const taskResult = rawContent.match(/<TASK_RESULT>\s*([\s\S]*?)\s*<\/TASK_RESULT>/);
  if (taskResult && typeof taskResult[1] === 'string') {
    return taskResult[1].trim();
  }

  const result = rawContent.match(/<RESULT>\s*([\s\S]*?)\s*<\/RESULT>/);
  if (result && typeof result[1] === 'string') {
    return result[1].trim();
  }

  return rawContent.trim();
}

/**
 * Converts one agy transcript line into zero or more normalized messages.
 *
 * - USER_INPUT becomes a single text turn from the user.
 * - PLANNER_RESPONSE may emit both a thinking message and an assistant text turn.
 * - RUN_COMMAND is surfaced as a Task tool_use so the UI can render a sub-agent badge.
 * - SYSTEM_MESSAGE is rendered as a tool_result; CONVERSATION_HISTORY is skipped.
 */
function mapAgyLineToNormalized(
  line: AgyTranscriptLine,
  sessionId: string,
): NormalizedMessage[] {
  const ts = line.created_at || new Date().toISOString();
  const baseId = generateMessageId(`antigravity_${line.step_index}`);

  if (line.type === 'CONVERSATION_HISTORY') {
    return [];
  }

  if (line.type === 'USER_INPUT') {
    const text = extractUserRequest(line.content);
    if (!text) {
      return [];
    }

    return [
      createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content: text,
      }),
    ];
  }

  if (line.type === 'PLANNER_RESPONSE') {
    const messages: NormalizedMessage[] = [];

    const thinking = typeof line.thinking === 'string' ? line.thinking.trim() : '';
    if (thinking) {
      messages.push(
        createNormalizedMessage({
          id: `${baseId}_thinking`,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'thinking',
          role: 'assistant',
          content: thinking,
        }),
      );
    }

    const content = typeof line.content === 'string' ? line.content.trim() : '';
    if (content) {
      messages.push(
        createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content,
        }),
      );
    }

    return messages;
  }

  if (line.type === 'RUN_COMMAND') {
    const description = typeof line.content === 'string' ? line.content.trim() : '';
    return [
      createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: 'Task',
        toolInput: { description },
        toolId: baseId,
      }),
    ];
  }

  if (line.type === 'SYSTEM_MESSAGE') {
    const content = extractSystemResult(line.content);
    if (!content) {
      return [];
    }

    return [
      createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: baseId,
        content,
      }),
    ];
  }

  return [];
}

/**
 * Streams an agy transcript.jsonl file and produces normalized messages.
 *
 * We stream line by line so very large transcripts do not require loading the
 * whole file into memory. Malformed lines are skipped silently to keep one bad
 * row from masking the rest of the conversation.
 */
async function readAgyTranscript(
  filePath: string,
  sessionId: string,
): Promise<NormalizedMessage[]> {
  const messages: NormalizedMessage[] = [];

  try {
    const fileStream = fsSync.createReadStream(filePath);
    const lineReader = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const rawLine of lineReader) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const record = readObjectRecord(parsed);
      if (!record) {
        continue;
      }

      messages.push(...mapAgyLineToNormalized(record as AgyTranscriptLine, sessionId));
    }
  } catch {
    return [];
  }

  return messages;
}

export class AntigravitySessionsProvider implements IProviderSessions {
  /**
   * agy currently has no realtime streaming integration with the app.
   *
   * History is loaded only from on-disk transcript files via `fetchHistory`, so
   * the live normalizer returns no messages until a streaming bridge is wired up.
   */
  normalizeMessage(_raw: unknown, _sessionId: string | null): NormalizedMessage[] {
    return [];
  }

  /**
   * Loads a normalized message history from the agy transcript file on disk.
   *
   * The session row in the DB is the authoritative source for the transcript
   * path. We never construct the path from the session id alone so callers that
   * point us at a renamed brain directory still resolve correctly.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    const sessionRow = sessionsDb.getSessionById(sessionId);
    const transcriptPath = sessionRow?.jsonl_path ?? null;
    if (!transcriptPath) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    let normalized: NormalizedMessage[];
    try {
      normalized = await readAgyTranscript(transcriptPath, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AntigravityProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const start = Math.max(0, offset);
    const pageLimit = limit === null ? null : Math.max(0, limit);
    const messages = pageLimit === null
      ? normalized.slice(start)
      : normalized.slice(start, start + pageLimit);

    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }

    return {
      messages,
      total,
      hasMore: pageLimit === null ? false : start + pageLimit < normalized.length,
      offset: start,
      limit: pageLimit,
    };
  }
}
