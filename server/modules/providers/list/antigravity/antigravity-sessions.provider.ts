import fsSync from 'node:fs';
import readline from 'node:readline';

import { providerRunFailuresDb, sessionsDb  } from '@/modules/database/index.js';
import type { ProviderRunFailureRow } from '@/modules/database/index.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';
import { readResponseModel } from '@/modules/providers/shared/response-model.js';

import { agyTranscriptMessageId } from './agy-transcript-identity.js';

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
  model?: string;
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
  const baseId = agyTranscriptMessageId(sessionId,line.step_index);
  if (!baseId) return [];

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
          model: readResponseModel(line.model),
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

/**
 * Renders a recorded run failure as the `kind:'error'` row the chat already
 * knows how to draw (useChatMessages maps it to a `type:'error'` bubble), so the
 * cause reads identically whether it arrived live or came back with the history.
 *
 * The id is derived from the session rather than random: `fetchHistory` runs on
 * every load and a fresh id each time would present the same failure as a new
 * message to any consumer keyed by id.
 *
 * Content is agy's own sentence, verbatim and untranslated. It is the provider's
 * report of its own state — rewording it would put nassaj's paraphrase where the
 * evidence should be, and the reset countdown inside it is the actionable part.
 */
function buildFailureMessage(
  sessionId: string,
  failure: ProviderRunFailureRow
): NormalizedMessage {
  return createNormalizedMessage({
    id: `${sessionId}_run_failure`,
    sessionId,
    timestamp: new Date(failure.failedAtMs ?? Date.now()).toISOString(),
    provider: PROVIDER,
    kind: 'error',
    content: failure.reason,
  });
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

    // T-1191: the last run's failure, if it failed. Read BEFORE the transcript
    // early-return: a run that died on `Individual quota reached` may have
    // produced no transcript at all, and that is precisely the conversation the
    // user opens wondering why it is empty.
    const failure = providerRunFailuresDb.getFailure(sessionId);

    const sessionRow = sessionsDb.getSessionById(sessionId);
    const transcriptPath = sessionRow?.jsonl_path ?? null;
    if (!transcriptPath) {
      const only = failure ? [buildFailureMessage(sessionId, failure)] : [];
      return { messages: only, total: only.length, hasMore: false, offset: 0, limit: null };
    }

    let normalized: NormalizedMessage[];
    try {
      normalized = await readAgyTranscript(transcriptPath, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AntigravityProvider] Failed to load session ${sessionId}:`, message);
      const only = failure ? [buildFailureMessage(sessionId, failure)] : [];
      return { messages: only, total: only.length, hasMore: false, offset: 0, limit: null };
    }

    // Appended, never interleaved: the marker describes the LAST run, so it
    // belongs after every step the transcript holds. It is cleared by the next
    // successful run, so it can only ever describe the conversation's current
    // tail rather than an old stumble resurfacing under newer replies.
    if (failure) {
      normalized = [...normalized, buildFailureMessage(sessionId, failure)];
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
