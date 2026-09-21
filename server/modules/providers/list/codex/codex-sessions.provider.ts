import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fsSync from 'node:fs';
import readline from 'node:readline';

import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { AppError, createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';

import type { HistoryReadLease } from '../../services/history-budget.service.js';

import { isCodexBootstrapContext, isCodexGoalContext } from './codex-receipt-proof.js';
import { createCodexFinalResponseTracker } from './codex-fork-cutoff.js';
import { extractCodexBranchCommand } from './codex-branch-context.js';
import { extractCodexTokenBudget } from './codex-token-budget.js';
import { createCodexReceiptCollector, codexHistoryIdentity, setCodexHistoryIdentities } from './codex-receipt-identity.js';

const PROVIDER = 'codex';
const CURSOR_VERSION = 2;
const MAX_HISTORY_IMAGES_PER_MESSAGE = 15;
const MAX_HISTORY_IMAGE_DATA_URL_LENGTH = 7 * 1024 * 1024;
const MAX_HISTORY_IMAGE_CHARS_PER_MESSAGE = 16 * 1024 * 1024;
const MAX_HISTORY_IMAGE_CHARS_PER_REQUEST = 32 * 1024 * 1024;
const CODEX_HISTORY_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-zA-Z0-9+/]+={0,2}$/;

type CodexTurnModel = { turnId?: string; model?: string };

/** Accept only a bounded provider model identifier, never a UI selection. */
function readCodexModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const model = value.trim();
  return model && model.length <= 256 && !/\s|[\x00-\x1f\x7f]/.test(model) ? model : undefined;
}

/** Follow forward-only rollout context; missing/new turn context cannot inherit a model. */
function updateCodexTurnModel(context: CodexTurnModel, entry: AnyRecord): CodexTurnModel {
  const turnId = readNonEmptyString(entry.payload?.turn_id);
  if (entry.type === 'turn_context') {
    return { turnId, model: readCodexModel(entry.payload?.model) };
  }
  if (entry.type !== 'event_msg') return context;
  if (entry.payload?.type === 'task_started') {
    return turnId && turnId === context.turnId ? context : { turnId };
  }
  if (['task_complete', 'turn_aborted'].includes(entry.payload?.type)
    && (!turnId || !context.turnId || turnId === context.turnId)) return {};
  return context;
}

/** Prefer message-attested metadata and reject a context explicitly belonging to another turn. */
function codexAssistantModel(payload: AnyRecord, context: CodexTurnModel): string | undefined {
  const model = readCodexModel(payload.model);
  if (model) return model;
  const turnId = readNonEmptyString(payload.internal_chat_message_metadata_passthrough?.turn_id);
  if (turnId && context.turnId && turnId !== context.turnId) return undefined;
  return context.model;
}

type CodexHistoryCursor = {
  v: number;
  sessionId: string;
  beforeId: string;
  snapshotTailId: string;
  totalAtSnapshot: number;
};

/** History may consume existing cursor authority, never create signing material. */
function cursorAuthority(lease?: HistoryReadLease): string {
  if (!lease) return appConfigDb.getOrCreateJwtSecret();
  const secret = appConfigDb.get('jwt_secret');
  if (typeof secret !== 'string' || !secret || secret.length > 4096) return lease.fail('HISTORY_SOURCE_UNAVAILABLE');
  return secret;
}

function encodeHistoryCursor(cursor: CodexHistoryCursor, lease?: HistoryReadLease): string {
  if (lease && lease.reserveDto(cursor) > 1536) lease.fail('HISTORY_BUDGET_EXCEEDED');
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  const signature = createHmac('sha256', cursorAuthority(lease)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeHistoryCursor(value: string, sessionId: string, lease?: HistoryReadLease): CodexHistoryCursor {
  if (Buffer.byteLength(value) > 2048) throw new AppError('Invalid history cursor.', { code: 'INVALID_QUERY_PARAMETER', statusCode: 400 });
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) {
    throw new AppError('Invalid Codex history cursor.', { code: 'CURSOR_STALE', statusCode: 409 });
  }
  const expected = createHmac('sha256', cursorAuthority(lease)).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    throw new AppError('Invalid Codex history cursor.', { code: 'CURSOR_STALE', statusCode: 409 });
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new AppError('Invalid Codex history cursor.', { code: 'CURSOR_STALE', statusCode: 409 });
  }

  let decoded: CodexHistoryCursor;
  try {
    decoded = (lease ? lease.parseNested(Buffer.from(payload, 'base64url').toString('utf8')) : JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))) as CodexHistoryCursor;
  } catch {
    throw new AppError('Invalid Codex history cursor.', { code: 'CURSOR_STALE', statusCode: 409 });
  }
  if (
    decoded.v !== CURSOR_VERSION
    || decoded.sessionId !== sessionId
    || typeof decoded.beforeId !== 'string'
    || typeof decoded.snapshotTailId !== 'string'
    || !Number.isInteger(decoded.totalAtSnapshot)
    || decoded.totalAtSnapshot < 0
  ) {
    throw new AppError('Invalid Codex history cursor.', { code: 'CURSOR_STALE', statusCode: 409 });
  }
  return decoded;
}

type CodexHistoryResult =
  | AnyRecord[]
  | {
      messages?: AnyRecord[];
      total?: number;
      hasMore?: boolean;
      offset?: number;
      limit?: number | null;
      tokenUsage?: unknown;
    };

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

function extractCodexTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractCodexToolOutput(output: unknown, lease?: HistoryReadLease): string {
  if (typeof output === 'string') {
    return output;
  }

  if (!Array.isArray(output)) {
    return output == null ? '' : lease ? lease.stringify(output) : JSON.stringify(output);
  }

  return output
    .map((item) => {
      const record = readObjectRecord(item);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
}

function readRunningExecOutput(output: string): { cellId: string; content: string } | null {
  const runningCell = /Script running with cell ID\s+(\S+)/i.exec(output);
  if (!runningCell) {
    return null;
  }

  const outputMarker = /\r?\nOutput:\r?\n/i.exec(output);
  return {
    cellId: runningCell[1],
    content: outputMarker ? output.slice((outputMarker.index || 0) + outputMarker[0].length) : '',
  };
}

function decodeJavaScriptStringLiteral(literal: string, lease?: HistoryReadLease): string {
  if (literal.startsWith('"')) {
    try {
      return (lease ? lease.parseNested(literal) : JSON.parse(literal)) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }

  return literal
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([\\'`])/g, '$1');
}

function extractNestedCodexCommands(source: string, lease?: HistoryReadLease): string[] {
  const commands: string[] = [];
  const commandPattern = /\bcommand\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;
  for (const match of source.matchAll(commandPattern)) {
    commands.push(decodeJavaScriptStringLiteral(match[1], lease));
  }

  if (commands.length === 0) {
    const arrayPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g;
    const stringPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;

    for (const arrayMatch of source.matchAll(arrayPattern)) {
      const arrayName = arrayMatch[1];
      if (!new RegExp(`\\b${arrayName}\\.map\\s*\\(`).test(source)) {
        continue;
      }
      for (const stringMatch of arrayMatch[2].matchAll(stringPattern)) {
        commands.push(decodeJavaScriptStringLiteral(stringMatch[1], lease));
      }
    }
  }

  return commands;
}

/**
 * Newer Codex rollouts persist the orchestration wrapper (`exec`) instead of
 * the nested tool name. Recover the useful UI-level operation so history does
 * not degrade into rows labelled only "exec / Parameters".
 */
function translateCodexExecInput(input: unknown, lease?: HistoryReadLease): { toolName: string; toolInput: string } | null {
  const source = typeof input === 'string' ? input : String(input || '');
  if (/\btools\.shell_command\s*\(/.test(source)) {
    const commands = extractNestedCodexCommands(source, lease);
    if (commands.length > 0) {
      return {
        toolName: 'Bash',
        toolInput: lease ? lease.stringify({ command: commands.join('\n') }) : JSON.stringify({ command: commands.join('\n') }),
      };
    }
  }

  return null;
}

function humanizeCodexToolName(toolName: string): string {
  return toolName
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

type CodexSubagentRecord = {
  toolCallId: string;
  agentPath?: string;
  isComplete: boolean;
};

function parseCodexSubagentMessage(payload: AnyRecord): {
  author: string;
  messageType: string;
  result: string;
} | null {
  const text = extractCodexTextContent(payload.content);
  const header = /Message Type:\s*([^\r\n]+)[\s\S]*?Sender:\s*([^\r\n]+)[\s\S]*?Payload:\s*\r?\n([\s\S]*)/i.exec(text);
  const author = readNonEmptyString(payload.author) || header?.[2]?.trim();
  if (!author) {
    return null;
  }

  return {
    author,
    messageType: header?.[1]?.trim().toUpperCase() || 'MESSAGE',
    result: header?.[3]?.trim() || '',
  };
}

const CODEX_COLLABORATION_CONTROL_TOOLS = new Set([
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'wait_agent',
]);

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extracts only inert raster data URLs emitted by Codex for local_image inputs.
 * Rollout files live in a user's isolated CODEX_HOME, but history is still an
 * HTTP response surface: strict media/count/size limits keep a malformed file
 * from turning into an SVG execution vector or an unbounded response.
 */
function sanitizeCodexEmbeddedImageUrls(
  candidates: unknown,
): { images: string[]; omitted: number; retainedChars: number } {
  if (!Array.isArray(candidates)) {
    return { images: [], omitted: 0, retainedChars: 0 };
  }

  const images: string[] = [];
  let omitted = 0;
  let retainedChars = 0;
  for (const candidate of candidates) {
    // extractCodexEmbeddedImages maps non-image content blocks to null. Reject
    // those before applying image ceilings so ordinary input_text blocks never
    // inflate imagesOmitted after the 15th real image.
    if (typeof candidate !== 'string') {
      continue;
    }
    if (
      candidate.length > MAX_HISTORY_IMAGE_DATA_URL_LENGTH
      || !CODEX_HISTORY_IMAGE_PATTERN.test(candidate)
    ) {
      omitted += 1;
      continue;
    }
    if (
      images.length >= MAX_HISTORY_IMAGES_PER_MESSAGE
      || retainedChars + candidate.length > MAX_HISTORY_IMAGE_CHARS_PER_MESSAGE
    ) {
      omitted += 1;
      continue;
    }
    images.push(candidate);
    retainedChars += candidate.length;
  }
  return { images, omitted, retainedChars };
}

function extractCodexEmbeddedImages(
  content: unknown,
): { images: string[]; omitted: number; retainedChars: number } {
  if (!Array.isArray(content)) {
    return { images: [], omitted: 0, retainedChars: 0 };
  }
  return sanitizeCodexEmbeddedImageUrls(content.map((item) => {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const record = item as AnyRecord;
    return record.type === 'input_image' ? record.image_url : null;
  }));
}

function isLegacyCodexBootstrapContext(item: unknown): boolean {
  const record = readObjectRecord(item);
  if (record?.type !== 'input_text' || typeof record.text !== 'string') return false;
  const text = record.text.trim();
  // Native CLI persists these generated context blocks as user-role records.
  // Match complete wrappers only; mentions inside a human prompt remain visible.
  return /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/.test(text)
    || /^<environment_context>[\s\S]*<\/environment_context>$/.test(text)
    || /^# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/.test(text);
}

function visibleCodexResponseItemText(content: unknown, lease?: HistoryReadLease): string {
  const raw = extractCodexTextContent(content);
  const hasImage = Array.isArray(content)
    && content.some((item) => readObjectRecord(item)?.type === 'input_image');
  if (!hasImage) return extractCodexBranchCommand(raw, lease) ?? raw;
  const text = raw
    .split('\n')
    .filter((line) => !/^<\/?image(?:\s[^>]*)?>$/.test(line.trim()))
    .join('\n');
  return extractCodexBranchCommand(text, lease) ?? text;
}

function visibleCodexUserText(payload: AnyRecord, lease?: HistoryReadLease): string {
  const raw = typeof payload.message === 'string'
    ? payload.message
    : extractCodexTextContent(payload.content);
  return extractCodexBranchCommand(raw, lease) ?? raw;
}

async function getCodexSessionMessages(
  sessionId: string,
  lease?: HistoryReadLease,
): Promise<CodexHistoryResult> {
  const stringify = (value: unknown) => lease ? lease.stringify(value) : JSON.stringify(value);
  try {
    const sessionFilePath = lease?.mainFile ?? sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const messages: AnyRecord[] = [];
    let tokenUsage: AnyRecord | null = null;
    let tokenUsageBoundaryAt: number | null = null;
    const ignoredToolCallIds = new Set<string>();
    const execToolCallIds = new Set<string>();
    const execCallByCellId = new Map<string, string>();
    const waitCallToExecCall = new Map<string, string>();
    const pendingExecOutput = new Map<string, string>();
    const completedExecCalls = new Set<string>();
    const subagentsByCallId = new Map<string, CodexSubagentRecord>();
    const subagentsByPath = new Map<string, CodexSubagentRecord>();
    const fileStream = lease ? lease.stream(sessionFilePath) : fsSync.createReadStream(sessionFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });
    const lineHashOccurrences = new Map<string, number>();
    let adjacentEmbeddedUserMessage: { raw: AnyRecord; text: string } | null = null;
    const retainedImageRows: Array<{ raw: AnyRecord; retainedChars: number }> = [];
    let retainedImageChars = 0;
    let seenUserRecord = false;
    let turnModel: CodexTurnModel = {};
    const finalResponses = createCodexFinalResponseTracker();
    const receiptIdentities = createCodexReceiptCollector();
    let endsWithNewline = false;
    fileStream.on('data', (chunk: Buffer | string) => { endsWithNewline = typeof chunk === 'string' ? chunk.endsWith('\n') : chunk[chunk.length - 1] === 10; });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = (lease ? lease.parse(line) : JSON.parse(line)) as AnyRecord;
        const previousContextModel = turnModel.model;
        turnModel = updateCodexTurnModel(turnModel, entry);
        if ((entry.type === 'turn_context' && previousContextModel !== turnModel.model)
          || entry.type === 'compacted' || entry.payload?.type === 'context_compacted') {
          tokenUsage = null;
          const boundaryTimestamp = typeof entry.timestamp === 'string'
            ? Date.parse(entry.timestamp)
            : Number.NaN;
          // Once the model/context boundary changes, an older delayed token row
          // must not revive the invalidated sample. A missing boundary timestamp
          // fails closed until a later, timestamped native sample can be proven.
          tokenUsageBoundaryAt = Number.isFinite(boundaryTimestamp)
            ? boundaryTimestamp
            : Number.POSITIVE_INFINITY;
        }
        finalResponses.observe(entry);
        receiptIdentities.observe(entry);
        const lineHash = createHash('sha256').update(line).digest('base64url').slice(0, 22);
        const occurrence = (lineHashOccurrences.get(lineHash) ?? 0) + 1;
        lineHashOccurrences.set(lineHash, occurrence);
        const historyId = `codex-history-${lineHash}-${occurrence}`;
        // Codex writes the clean event_msg echo immediately after response_item.
        // Consume the candidate now: any intervening valid JSONL record breaks
        // adjacency and therefore cannot suppress a later human message.
        const precedingEmbeddedUserMessage = adjacentEmbeddedUserMessage;
        adjacentEmbeddedUserMessage = null;

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
          const latestRoleUsage = extractCodexTokenBudget(entry, turnModel.model, sessionId, 'history');
          const observedAt = latestRoleUsage?.contextSnapshot?.observedAt;
          const observedTimestamp = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN;
          const priorObservedAt = tokenUsage?.contextSnapshot?.observedAt;
          const priorTimestamp = typeof priorObservedAt === 'string' ? Date.parse(priorObservedAt) : Number.NaN;
          const afterBoundary = tokenUsageBoundaryAt === null
            || (Number.isFinite(observedTimestamp) && observedTimestamp >= tokenUsageBoundaryAt);
          const notOlderThanCurrent = !Number.isFinite(priorTimestamp)
            || (Number.isFinite(observedTimestamp) && observedTimestamp >= priorTimestamp);
          if (latestRoleUsage && afterBoundary && notOlderThanCurrent) {
            tokenUsage = latestRoleUsage as AnyRecord;
          }
        }

        if (
          entry.type === 'event_msg'
          && entry.payload?.type === 'sub_agent_activity'
          && entry.payload.kind === 'started'
        ) {
          const eventId = readNonEmptyString(entry.payload.event_id);
          const agentPath = readNonEmptyString(entry.payload.agent_path);
          const subagent = eventId ? subagentsByCallId.get(eventId) : undefined;
          if (subagent && agentPath) {
            subagent.agentPath = agentPath;
            subagentsByPath.set(agentPath, subagent);
          }
        }

        if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
          const visibleText = visibleCodexUserText(entry.payload as AnyRecord, lease);
          const sourceTimestamp = precedingEmbeddedUserMessage?.raw.timestamp;
          const echoTimestamp = entry.timestamp;
          const matchingTime = !sourceTimestamp || !echoTimestamp
            || (Number.isFinite(Date.parse(sourceTimestamp))
              && Number.isFinite(Date.parse(echoTimestamp))
              && Date.parse(echoTimestamp) >= Date.parse(sourceTimestamp)
              && Date.parse(echoTimestamp) - Date.parse(sourceTimestamp) <= 1000);
          const duplicateOfEmbedded = precedingEmbeddedUserMessage
            && matchingTime
            && precedingEmbeddedUserMessage.text.trim() === visibleText.trim();

          if (duplicateOfEmbedded && precedingEmbeddedUserMessage) {
            // event_msg is Codex's clean text echo of the preceding response_item.
            // Keep the response_item row because it alone owns input_image bytes,
            // but replace its wrapper-stripped fallback text with this canonical one.
            precedingEmbeddedUserMessage.raw.message.content = visibleText;
          } else {
            messages.push({
              uuid: `${historyId}-user`,
              type: 'user',
              timestamp: entry.timestamp,
              message: {
                role: 'user',
                content: visibleText,
              },
            });
          }
        }

        if (
          entry.type === 'response_item'
          && entry.payload?.type === 'message'
          && entry.payload.role === 'user'
        ) {
          // Provider provenance, not text: do this before display and receipt association.
          if (isCodexGoalContext(entry.payload)) continue;
          const content = entry.payload.content;
          const attestedBootstrap = isCodexBootstrapContext(entry.payload);
          const legacyBootstrap = !seenUserRecord
            && entry.payload.internal_chat_message_metadata_passthrough?.content_item_kinds === undefined
            && Array.isArray(content) && content.length >= 2
            && content.every(isLegacyCodexBootstrapContext);
          const bootstrap = attestedBootstrap || legacyBootstrap;
          seenUserRecord = true;
          if (bootstrap) continue;
          const { images, omitted, retainedChars } = extractCodexEmbeddedImages(content);
          const textContent = visibleCodexResponseItemText(entry.payload.content, lease);
          if (textContent || images.length > 0 || omitted > 0) {
            const raw: AnyRecord = {
              uuid: `${historyId}-${images.length > 0 || omitted > 0 ? 'user-images' : 'user'}`,
              type: 'user',
              timestamp: entry.timestamp,
              message: {
                role: 'user',
                content: textContent,
                images,
                ...(omitted > 0 ? { imagesOmitted: omitted } : {}),
              },
            };
            messages.push(raw);
            receiptIdentities.associate(entry.payload, raw);
            adjacentEmbeddedUserMessage = { raw, text: textContent };

            // The JSONL reader necessarily materializes the current line once,
            // but retained history images never grow without bound: evict whole
            // image sets from the oldest rows until the newest row fits. Text
            // remains, and imagesOmitted tells clients exactly what was removed.
            if (retainedChars > 0) {
              while (
                retainedImageRows.length > 0
                && retainedImageChars + retainedChars > MAX_HISTORY_IMAGE_CHARS_PER_REQUEST
              ) {
                const evicted = retainedImageRows.shift();
                if (!evicted) break;
                const evictedImages = Array.isArray(evicted.raw.message?.images)
                  ? evicted.raw.message.images.length
                  : 0;
                evicted.raw.message.images = [];
                evicted.raw.message.imagesOmitted = Number(evicted.raw.message.imagesOmitted || 0)
                  + evictedImages;
                retainedImageChars -= evicted.retainedChars;
              }
              retainedImageRows.push({ raw, retainedChars });
              retainedImageChars += retainedChars;
            }
          }
        }

        if (
          entry.type === 'response_item' &&
          entry.payload?.type === 'message' &&
          entry.payload.role === 'assistant'
        ) {
          const textContent = extractCodexTextContent(entry.payload.content);
          const model = codexAssistantModel(entry.payload, turnModel);
          if (textContent.trim()) {
            messages.push({
              // `payload.id` is Codex's DURABLE rollout id (`msg_<hex>`), which
              // the live SDK never emits — it streams transport-local `item_N`.
              // Unlike a line hash it survives history reloads, so it is the
              // response-metrics sidecar's exact, non-positional join key; the
              // durable id is read back from the rollout, not from the stream
              // (B-822).
              uuid: typeof entry.payload.id === 'string' && entry.payload.id
                ? entry.payload.id
                : `${historyId}-assistant`,
              type: 'assistant',
              timestamp: entry.timestamp,
              message: {
                role: 'assistant',
                content: textContent,
                ...(model ? { model } : {}),
              },
              ...(entry.payload.phase === 'final_answer' ? { phase: 'final_answer' } : {}),
            });
            finalResponses.bind(messages[messages.length - 1]);
          }
          if (entry.payload.phase === 'final_answer') turnModel = {};
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
          const summaryText = Array.isArray(entry.payload.summary)
            ? entry.payload.summary
                .map((item: AnyRecord) => item?.text)
                .filter(Boolean)
                .join('\n')
            : '';

          if (summaryText.trim()) {
            messages.push({
              uuid: `${historyId}-thinking`,
              type: 'thinking',
              timestamp: entry.timestamp,
              message: {
                role: 'assistant',
                content: summaryText,
              },
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'agent_message') {
          const agentMessage = parseCodexSubagentMessage(entry.payload as AnyRecord);
          if (agentMessage && agentMessage.messageType === 'FINAL_ANSWER' && agentMessage.result) {
            let subagent = subagentsByPath.get(agentMessage.author);
            if (!subagent) {
              const fallbackCallId = entry.payload.id || generateMessageId('codex-subagent');
              const taskName = agentMessage.author.split('/').filter(Boolean).pop() || 'agent';
              messages.push({
                uuid: fallbackCallId,
                type: 'tool_use',
                timestamp: entry.timestamp,
                toolName: 'Task',
                toolInput: stringify({
                  subagent_type: 'Codex',
                  description: humanizeCodexToolName(taskName),
                }),
                toolCallId: fallbackCallId,
              });
              subagent = {
                toolCallId: fallbackCallId,
                agentPath: agentMessage.author,
                isComplete: false,
              };
              subagentsByCallId.set(fallbackCallId, subagent);
              subagentsByPath.set(agentMessage.author, subagent);
            }

            if (!subagent.isComplete) {
              messages.push({
                uuid: `${historyId}-subagent-result`,
                type: 'tool_result',
                timestamp: entry.timestamp,
                toolCallId: subagent.toolCallId,
                output: agentMessage.result,
              });
              subagent.isComplete = true;
            }
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          let toolName = entry.payload.name;
          let toolInput = entry.payload.arguments;

          if (toolName === 'spawn_agent') {
            let taskName = 'agent';
            let prompt: string | undefined;
            try {
              const args = (lease ? lease.parseNested(String(entry.payload.arguments || '{}')) : JSON.parse(String(entry.payload.arguments || '{}'))) as AnyRecord;
              taskName = readNonEmptyString(args.task_name) || taskName;
              const candidatePrompt = readNonEmptyString(args.prompt);
              // `message` is usually an encrypted blob (`gAAAAA...`), not
              // human-readable prompt text. Surface only a real plain prompt.
              if (candidatePrompt) {
                prompt = candidatePrompt;
              }
            } catch {
              // The activity event can still provide the canonical agent path.
            }

            messages.push({
              uuid: entry.payload.call_id,
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName: 'Task',
              toolInput: stringify({
                subagent_type: 'Codex',
                description: humanizeCodexToolName(taskName),
                ...(prompt ? { prompt } : {}),
              }),
              toolCallId: entry.payload.call_id,
            });
            subagentsByCallId.set(entry.payload.call_id, {
              toolCallId: entry.payload.call_id,
              isComplete: false,
            });
            ignoredToolCallIds.add(entry.payload.call_id);
            continue;
          }

          if (toolName === 'wait') {
            try {
              const args = (lease ? lease.parseNested(String(entry.payload.arguments || '{}')) : JSON.parse(String(entry.payload.arguments || '{}'))) as AnyRecord;
              const cellId = String(args.cell_id || '');
              const execCallId = execCallByCellId.get(cellId);
              if (execCallId) {
                waitCallToExecCall.set(entry.payload.call_id, execCallId);
              }
            } catch {
              // Suppress the orchestration wait even when its payload is malformed.
            }
            ignoredToolCallIds.add(entry.payload.call_id);
            continue;
          }

          if (CODEX_COLLABORATION_CONTROL_TOOLS.has(toolName)) {
            ignoredToolCallIds.add(entry.payload.call_id);
            continue;
          }

          if (toolName === 'shell_command') {
            toolName = 'Bash';
            try {
              const args = (lease ? lease.parseNested(entry.payload.arguments) : JSON.parse(entry.payload.arguments)) as AnyRecord;
              toolInput = stringify({ command: args.command });
            } catch {
              // Keep original arguments when parsing fails.
            }
          }

          messages.push({
            uuid: `${historyId}-tool-use`,
            type: 'tool_use',
            timestamp: entry.timestamp,
            toolName,
            toolInput,
            toolCallId: entry.payload.call_id,
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
          const waitExecCallId = waitCallToExecCall.get(entry.payload.call_id);
          if (waitExecCallId) {
            const output = extractCodexToolOutput(entry.payload.output, lease);
            const runningOutput = readRunningExecOutput(output);
            const accumulatedOutput = `${pendingExecOutput.get(waitExecCallId) || ''}${runningOutput?.content ?? output}`;
            pendingExecOutput.set(waitExecCallId, accumulatedOutput);

            if (!runningOutput && !completedExecCalls.has(waitExecCallId)) {
              messages.push({
                uuid: `${historyId}-wait-result`,
                type: 'tool_result',
                timestamp: entry.timestamp,
                toolCallId: waitExecCallId,
                output: accumulatedOutput,
              });
              completedExecCalls.add(waitExecCallId);
            }
            continue;
          }

          const subagent = subagentsByCallId.get(entry.payload.call_id);
          if (subagent) {
            const output = extractCodexToolOutput(entry.payload.output, lease);
            try {
              const taskPath = readNonEmptyString(((lease ? lease.parseNested(output) : JSON.parse(output)) as AnyRecord).task_name);
              if (taskPath) {
                subagent.agentPath = taskPath;
                subagentsByPath.set(taskPath, subagent);
              }
            } catch {
              // The sub_agent_activity event normally supplies the path.
            }
            continue;
          }

          if (ignoredToolCallIds.has(entry.payload.call_id)) {
            continue;
          }

          messages.push({
            uuid: `${historyId}-tool-result`,
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id,
            output: extractCodexToolOutput(entry.payload.output, lease),
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
          let toolName = entry.payload.name || 'custom_tool';
          const input = entry.payload.input || '';

          if (toolName === 'exec') {
            const translated = translateCodexExecInput(input, lease);
            if (!translated) {
              ignoredToolCallIds.add(entry.payload.call_id);
              continue;
            }
            toolName = translated.toolName;
            messages.push({
              uuid: `${historyId}-tool-use`,
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName,
              toolInput: translated.toolInput,
              toolCallId: entry.payload.call_id,
            });
            execToolCallIds.add(entry.payload.call_id);
            continue;
          }

          if (toolName === 'apply_patch') {
            const fileMatch = String(input).match(/\*\*\* Update File: (.+)/);
            const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
            const lines = String(input).split('\n');
            const oldLines: string[] = [];
            const newLines: string[] = [];

            for (const lineContent of lines) {
              if (lineContent.startsWith('-') && !lineContent.startsWith('---')) {
                oldLines.push(lineContent.slice(1));
              } else if (lineContent.startsWith('+') && !lineContent.startsWith('+++')) {
                newLines.push(lineContent.slice(1));
              }
            }

            messages.push({
              uuid: `${historyId}-tool-use`,
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName: 'Edit',
              toolInput: stringify({
                file_path: filePath,
                old_string: oldLines.join('\n'),
                new_string: newLines.join('\n'),
              }),
              toolCallId: entry.payload.call_id,
            });
          } else {
            messages.push({
              uuid: `${historyId}-tool-use`,
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName,
              toolInput: input,
              toolCallId: entry.payload.call_id,
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
          const output = extractCodexToolOutput(entry.payload.output, lease);
          if (execToolCallIds.has(entry.payload.call_id)) {
            const runningOutput = readRunningExecOutput(output);
            if (runningOutput) {
              execCallByCellId.set(runningOutput.cellId, entry.payload.call_id);
              pendingExecOutput.set(entry.payload.call_id, runningOutput.content);
              continue;
            }
            completedExecCalls.add(entry.payload.call_id);
          }

          messages.push({
            uuid: `${historyId}-tool-result`,
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id,
            output,
          });
        }
      } catch {
        finalResponses.invalidateAll();
        receiptIdentities.reject();
        // Skip malformed lines.
      }
    }

    if (!endsWithNewline) { finalResponses.invalidateAll(); receiptIdentities.reject(); }
    receiptIdentities.finish();
    return { messages, tokenUsage };
  } catch (error) {
    lease?.check();
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

export class CodexSessionsProvider implements IProviderSessions {
  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Live Codex SDK events are transformed before they reach normalizeMessage(),
   * while history entries already use a compact message/tool shape from projects.js.
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string'
        ? raw.message.content
        : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : String(raw.message.content || '');
      // Re-validate at the normalization boundary as well. fetchHistory already
      // sanitized these, but normalizeMessage is also a public provider method.
      const sanitizedImages = sanitizeCodexEmbeddedImageUrls(raw.message.images);
      const recordedOmitted = Number(raw.message.imagesOmitted);
      const imagesOmitted = (
        Number.isSafeInteger(recordedOmitted) && recordedOmitted > 0 ? recordedOmitted : 0
      ) + sanitizedImages.omitted;
      if (!content.trim() && sanitizedImages.images.length === 0 && imagesOmitted === 0) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content,
        ...(sanitizedImages.images.length > 0 ? { images: sanitizedImages.images } : {}),
        ...(imagesOmitted > 0 ? { imagesOmitted } : {}),
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
        ...(readCodexModel(raw.message.model) ? { model: readCodexModel(raw.message.model) } : {}),
        // Codex persists the phase on the message itself. Keep this attested
        // discriminator so the history timing sidecar never has to infer the
        // final response from row position or matching prose.
        ...(raw.phase === 'final_answer' ? { isFinalAnswer: true } : {}),
        ...(typeof raw.transcriptMessageId === 'string' ? { transcriptMessageId: raw.transcriptMessageId } : {}),
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Normalizes either a Codex history entry or a transformed live SDK event.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.message?.role) {
      return this.normalizeHistoryEntry(raw, sessionId);
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'item') {
      switch (raw.itemType) {
        case 'agent_message':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: raw.message?.content || '',
          })];
        case 'reasoning':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: raw.message?.content || '',
          })];
        case 'command_execution':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: raw.command },
            toolId: baseId,
            output: raw.output,
            exitCode: raw.exitCode,
            status: raw.status,
          })];
        case 'file_change':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'FileChanges',
            toolInput: raw.changes,
            toolId: baseId,
            status: raw.status,
          })];
        case 'mcp_tool_call':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.tool || 'MCP',
            toolInput: raw.arguments,
            toolId: baseId,
            server: raw.server,
            result: raw.result,
            error: raw.error,
            status: raw.status,
          })];
        case 'web_search':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'WebSearch',
            toolInput: { query: raw.query },
            toolId: baseId,
          })];
        case 'todo_list':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'TodoList',
            toolInput: { items: raw.items },
            toolId: baseId,
          })];
        case 'error':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'error',
            content: raw.message?.content || 'Unknown error',
          })];
        default:
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.itemType || 'Unknown',
            toolInput: raw.item || raw,
            toolId: baseId,
          })];
      }
    }

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }

    return [];
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when projects.js
   * provides it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0, cursor } = options;

    let result: CodexHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getCodexSessionMessages(sessionId, options.historyLease);
    } catch (error) {
      options.historyLease?.check();
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    options.historyLease?.check();
    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const tokenUsage = Array.isArray(result) ? undefined : result.tokenUsage;

    const normalized: NormalizedMessage[] = [];
    const nativeIdentities = [];
    for (const raw of rawMessages) {
      options.historyLease?.reserveDto(raw);
      const rows = this.normalizeHistoryEntry(raw, sessionId);
      for (const row of rows) {
        const identity = codexHistoryIdentity(raw, row);
        if (identity) nativeIdentities.push(identity);
      }
      normalized.push(...rows);
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = { content: toolResult.content, isError: toolResult.isError };
        }
      }
    }

    // Tool results are carried on their tool-use row. Keeping them as independent
    // pagination rows made `total`, `offset`, and the rendered page describe three
    // different lists. One display list now owns all three values.
    const displayRows = normalized.filter((msg) => msg.kind !== 'tool_result');
    const total = displayRows.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    let endIndex = Math.max(0, total - normalizedOffset);
    let snapshotTailId = displayRows.at(-1)?.id ?? '';
    let totalAtSnapshot = total;
    if (cursor) {
      const decoded = decodeHistoryCursor(cursor, sessionId, options.historyLease);
      const snapshotTailIndex = displayRows.findIndex((msg) => msg.id === decoded.snapshotTailId);
      const beforeIndex = displayRows.findIndex((msg) => msg.id === decoded.beforeId);
      if (snapshotTailIndex < 0 || beforeIndex < 0 || beforeIndex > snapshotTailIndex) {
        throw new AppError('The Codex history changed while older messages were loading.', {
          code: 'CURSOR_STALE',
          statusCode: 409,
        });
      }
      endIndex = beforeIndex;
      snapshotTailId = decoded.snapshotTailId;
      totalAtSnapshot = decoded.totalAtSnapshot;
    }

    let startIndex = normalizedLimit === null
      ? 0
      : Math.max(0, endIndex - normalizedLimit);
    if (normalizedLimit !== null && startIndex > 0) {
      // A fixed event count can land in the middle of a long tool-heavy turn.
      // Extend backwards to the human prompt so the first page is coherent and
      // never makes the conversation's originating request look deleted.
      for (let index = startIndex; index >= 0; index -= 1) {
        const row = displayRows[index];
        if (row?.kind === 'text' && row.role === 'user') {
          startIndex = index;
          break;
        }
      }
    }

    const messages = displayRows.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return setCodexHistoryIdentities({
      messages,
      total: totalAtSnapshot,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      nextCursor: hasMore && messages[0] && snapshotTailId
        ? encodeHistoryCursor({
            v: CURSOR_VERSION,
            sessionId,
            beforeId: messages[0].id,
            snapshotTailId,
            totalAtSnapshot,
          }, options.historyLease)
        : null,
      tokenUsage,
    }, nativeIdentities);
  }
}
