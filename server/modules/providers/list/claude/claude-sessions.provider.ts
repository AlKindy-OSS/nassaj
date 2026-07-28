import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  findLatestStoppedNotificationMs,
  reconcileWorkflowMessages,
} from '@/modules/providers/list/claude/workflow-reconcile.service.js';
import { reconcileAgentMessages } from '@/modules/providers/list/claude/agent-reconcile.service.js';

const PROVIDER = 'claude';

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

/**
 * Lists the subagent transcript file names in a session's `subagents` directory.
 *
 * Returns an empty array when the directory does not exist yet — a session with
 * no spawned subagents simply has no such folder, and that must not be treated
 * as an error. Only `agent-*.jsonl` files are returned (the sidecar
 * `agent-*.meta.json` files are ignored).
 */
async function readAgentFileNames(subagentsDir: string): Promise<string[]> {
  try {
    const files = await fsp.readdir(subagentsDir);
    return files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== 'ENOENT') {
      console.warn(`Error reading subagents directory ${subagentsDir}:`, fileError.message);
    }
    return [];
  }
}

async function parseAgentTools(filePath: string): Promise<AnyRecord[]> {
  const tools: AnyRecord[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  return tools;
}

async function getSessionMessages(
  sessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    // Claude writes subagent transcripts into a per-session `subagents`
    // subdirectory NEXT TO the main transcript, not into the project directory
    // itself: `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl`. The old
    // `path.dirname(jsonLPath)` lookup scanned the project directory, where no
    // `agent-*.jsonl` ever exists, so subagent tool output was never attached
    // (B-30). The session id is the transcript file's basename.
    const projectDir = path.dirname(jsonLPath);
    const transcriptSessionId = path.basename(jsonLPath, '.jsonl');
    const subagentsDir = path.join(projectDir, transcriptSessionId, 'subagents');
    const agentFiles = await readAgentFileNames(subagentsDir);

    const messages: AnyRecord[] = [];
    const agentToolsCache = new Map<string, AnyRecord[]>();

    const fileStream = fs.createReadStream(jsonLPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        if (entry.sessionId === sessionId) {
          messages.push(entry);
        }
      } catch {
        // Skip malformed JSONL lines that can happen during concurrent writes.
      }
    }

    const agentIds = new Set<string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    for (const agentId of agentIds) {
      const agentFileName = `agent-${agentId}.jsonl`;
      if (!agentFiles.includes(agentFileName)) {
        continue;
      }

      const agentFilePath = path.join(subagentsDir, agentFileName);
      const tools = await parseAgentTools(agentFilePath);
      agentToolsCache.set(agentId, tools);
    }

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const agentTools = agentToolsCache.get(String(agentId));
      if (agentTools && agentTools.length > 0) {
        message.subagentTools = agentTools;
      }
    }

    // ADR-048: derive a background-workflow completion correction when this
    // session carries a `run.stopped` notification that was emitted before the
    // orphaned workflow finished writing its results on disk. Read-only,
    // fail-safe, behind the WORKFLOW_RECONCILE flag (no-op when OFF). Reuses the
    // already-parsed `messages` (to find the stopped row) and the `subagentsDir`
    // computed above (its parent is the session dir holding `subagents/`), so no
    // new disk walk or path coupling is introduced. Derived rows are appended,
    // never written to the SDK-owned transcript.
    const stoppedAtMs = findLatestStoppedNotificationMs(messages);
    const reconcileMessages = await reconcileWorkflowMessages(
      sessionId,
      path.dirname(subagentsDir),
      stoppedAtMs,
    );
    for (const reconcileMessage of reconcileMessages) {
      messages.push(reconcileMessage as unknown as AnyRecord);
    }

    // T-873(2): recover `Agent` task-notifications the harness enqueued to this
    // transcript but never handed to the conversation (measured: 100% of
    // `killed` and 24% of `completed` notifications in this project were lost in
    // that in-memory hop). Purely a fold over the `messages` array already
    // parsed above — no extra disk read, no path coupling. Read-only, behind the
    // AGENT_RECONCILE flag (no-op when OFF), and strictly informational: the
    // derived card states the fact and never resumes anything.
    const agentMessages = reconcileAgentMessages(sessionId, messages);
    for (const agentMessage of agentMessages) {
      messages.push(agentMessage as unknown as AnyRecord);
    }

    const sortedMessages = messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    // THE DERIVED-ROW PASS-THROUGH. getSessionMessages injects rows that are
    // ALREADY in NormalizedMessage shape (workflow-reconcile's ADR-048
    // correction, and T-873(2)'s undelivered-`Agent` card) into the same raw
    // history stream that fetchHistory re-normalizes. Such a row carries no
    // `type` and no `message`, so it matches NO branch below and would be
    // dropped as an unrecognized entry — silently turning the whole feature into
    // dead code. Every derived `kind` MUST therefore be named here.
    //
    // Collision safety: `kind` is a field this codebase adds; it never appears on
    // a raw Claude JSONL row or SDK stream event (verified across the corpus), so
    // this guard cannot swallow a genuine transcript row.
    if (
      raw.kind === 'task_reconcile'
      || raw.kind === 'workflow_reconciled'
      || raw.kind === 'task_notification'
    ) {
      return [raw as unknown as NormalizedMessage];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      /**
       * Provenance of the user-role message (SDKMessageOrigin): absent or
       * 'human' means keyboard input from the user; any other kind
       * (coordinator → subagent prompts via the Task tool, peer, channel,
       * task-notification) is machine-routed and must not be displayed or
       * attributed as the human's own message. Present on both live SDK
       * stream events and persisted JSONL transcript rows.
       */
      const rawOriginKind = (raw.origin as AnyRecord | undefined)?.kind;
      const originKind = typeof rawOriginKind === 'string' && rawOriginKind !== 'human'
        ? rawOriginKind
        : undefined;

      if (Array.isArray(raw.message.content)) {
        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            if (text && !isInternalContent(text)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: text,
              }));
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
            }));
          }
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        if (text && !isInternalContent(text)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
          }));
        }
      }
      // Mark non-human user text with its origin kind so downstream consumers
      // (live userId stamping, history attribution, frontend rendering) can
      // distinguish coordinator/peer-routed prompts from the human's own input.
      if (originKind) {
        for (const message of messages) {
          if (message.kind === 'text' && message.role === 'user') {
            message.originKind = originKind;
          }
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

    const totalNormalized = normalized.length;
    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const messages = normalizedLimit === null
      ? normalized
      : normalized.slice(
          Math.max(0, totalNormalized - normalizedOffset - normalizedLimit),
          Math.max(0, totalNormalized - normalizedOffset),
        );
    const hasMore = normalizedLimit === null
      ? false
      : Math.max(0, totalNormalized - normalizedOffset - normalizedLimit) > 0;

    return {
      messages,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
