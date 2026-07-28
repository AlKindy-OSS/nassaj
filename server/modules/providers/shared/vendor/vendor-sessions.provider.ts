import { readFile } from 'node:fs/promises';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';

import { vendorTranscriptPath } from './vendor-transcript.js';

/**
 * Shared sessions facet for hosted vendor providers (kimi/deepseek/glm).
 *
 * `normalizeMessage` converts one Anthropic-compatible streaming/message event
 * into the app's `NormalizedMessage[]`. The three providers speak the Anthropic
 * Messages event vocabulary (their base URLs end in `/anthropic`), so the bulk of
 * the mapping is shared. Provider-specific quirks are injected as hooks:
 *
 *   - DeepSeek: ~11% of tool calls can arrive as plain text carrying a tool_call
 *     JSON object instead of a real `tool_use` block. `extractTextualToolCall`
 *     lets the DeepSeek provider rescue those into proper tool_use messages.
 *   - GLM: long streams must not drop trailing text — the JSONL transcript (one
 *     line per event) plus full-history replay below makes streaming length
 *     irrelevant to history correctness.
 *   - Kimi: tool_choice/temperature constraints are enforced at request build
 *     time in the seam, not here.
 *
 * `fetchHistory` reads the nassaj-owned JSONL transcript (see vendor-transcript)
 * line by line, re-normalizes each recorded event, attaches tool results to their
 * tool_use, and paginates with the project's standard semantics.
 */

export type VendorTextualToolCall = {
  toolName: string;
  toolInput: unknown;
  toolId?: string;
};

export type VendorSessionsOptions = {
  provider: LLMProvider;
  /**
   * Optional rescue hook for providers (DeepSeek) that sometimes emit a tool call
   * as text. Return a tool-call descriptor to convert the text into a tool_use
   * message, or null to keep it as ordinary text.
   */
  extractTextualToolCall?: (text: string) => VendorTextualToolCall | null;
};

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export class VendorSessionsProvider implements IProviderSessions {
  protected readonly provider: LLMProvider;
  private readonly extractTextualToolCall?: (text: string) => VendorTextualToolCall | null;

  constructor(options: VendorSessionsOptions) {
    this.provider = options.provider;
    this.extractTextualToolCall = options.extractTextualToolCall;
  }

  /**
   * Normalizes one parsed vendor event. Accepts both streaming events
   * (`content_block_*`, `*_delta`) and full non-streaming message objects.
   */
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    // A bare string chunk (non-JSON line) is surfaced as a stream delta.
    if (typeof raw === 'string') {
      const text = raw.trim();
      return text ? [this.textDelta(text, sessionId)] : [];
    }

    const event = readObjectRecord(raw);
    if (!event) {
      return [];
    }

    const type = typeof event.type === 'string' ? event.type : '';

    switch (type) {
      case 'content_block_delta':
        return this.normalizeContentBlockDelta(event, sessionId);
      case 'content_block_start':
        return this.normalizeContentBlockStart(event, sessionId);
      case 'message':
      case 'assistant':
        return this.normalizeFullMessage(event, sessionId);
      case 'error':
        return [createNormalizedMessage({
          kind: 'error',
          content: this.readErrorText(event),
          sessionId,
          provider: this.provider,
        })];
      default:
        // message_start / message_delta / message_stop / ping carry no renderable
        // content for the transcript and are intentionally ignored.
        return [];
    }
  }

  private textDelta(text: string, sessionId: string | null): NormalizedMessage {
    return createNormalizedMessage({
      kind: 'stream_delta',
      content: text,
      sessionId,
      provider: this.provider,
    });
  }

  private readErrorText(event: AnyRecord): string {
    const error = readObjectRecord(event.error);
    return readString(error?.message) ?? readString(event.message) ?? 'Vendor stream error';
  }

  private normalizeContentBlockDelta(event: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const delta = readObjectRecord(event.delta);
    if (!delta) {
      return [];
    }

    if (delta.type === 'text_delta') {
      const text = readString(delta.text);
      if (!text) {
        return [];
      }
      const rescued = this.extractTextualToolCall?.(text);
      if (rescued) {
        return [this.toolUse(rescued, sessionId)];
      }
      return [this.textDelta(text, sessionId)];
    }

    if (delta.type === 'thinking_delta') {
      const thinking = readString(delta.thinking);
      return thinking
        ? [createNormalizedMessage({ kind: 'thinking', content: thinking, sessionId, provider: this.provider })]
        : [];
    }

    return [];
  }

  private normalizeContentBlockStart(event: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const block = readObjectRecord(event.content_block);
    if (!block) {
      return [];
    }

    if (block.type === 'tool_use') {
      return [this.toolUse(
        {
          toolName: readString(block.name) ?? 'tool',
          toolInput: block.input ?? {},
          toolId: readString(block.id) ?? undefined,
        },
        sessionId,
      )];
    }

    if (block.type === 'text') {
      const text = readString(block.text);
      return text ? [this.textDelta(text, sessionId)] : [];
    }

    return [];
  }

  private normalizeFullMessage(event: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const message = readObjectRecord(event.message) ?? event;
    const role = message.role === 'user' ? 'user' : 'assistant';
    const content = message.content;
    const out: NormalizedMessage[] = [];

    if (typeof content === 'string') {
      const text = content.trim();
      if (text) {
        out.push(createNormalizedMessage({ kind: 'text', role, content: text, sessionId, provider: this.provider }));
      }
      return out;
    }

    if (!Array.isArray(content)) {
      return out;
    }

    for (const part of content) {
      const record = readObjectRecord(part);
      if (!record) {
        continue;
      }
      if (record.type === 'text') {
        const text = readString(record.text)?.trim();
        if (!text) {
          continue;
        }
        const rescued = role === 'assistant' ? this.extractTextualToolCall?.(text) : null;
        if (rescued) {
          out.push(this.toolUse(rescued, sessionId));
        } else {
          out.push(createNormalizedMessage({ kind: 'text', role, content: text, sessionId, provider: this.provider }));
        }
      } else if (record.type === 'tool_use') {
        out.push(this.toolUse(
          {
            toolName: readString(record.name) ?? 'tool',
            toolInput: record.input ?? {},
            toolId: readString(record.id) ?? undefined,
          },
          sessionId,
        ));
      } else if (record.type === 'tool_result') {
        out.push(createNormalizedMessage({
          kind: 'tool_result',
          toolId: readString(record.tool_use_id) ?? '',
          content: this.readToolResultContent(record.content),
          isError: Boolean(record.is_error),
          sessionId,
          provider: this.provider,
        }));
      }
    }

    return out;
  }

  private readToolResultContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const record = readObjectRecord(part);
          return record && typeof record.text === 'string' ? record.text : '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  private toolUse(call: VendorTextualToolCall, sessionId: string | null): NormalizedMessage {
    return createNormalizedMessage({
      kind: 'tool_use',
      toolName: call.toolName,
      toolInput: call.toolInput,
      toolId: call.toolId ?? '',
      sessionId,
      provider: this.provider,
    });
  }

  /**
   * Reads the nassaj-owned JSONL transcript for one session and re-normalizes it
   * into a paginated history result. Missing transcripts (a brand-new session, or
   * one that produced no recorded events) return an empty result, never throw.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { projectPath = '', limit = null, offset = 0 } = options;

    let lines: string[];
    try {
      const filePath = vendorTranscriptPath(this.provider, sessionId, projectPath);
      const content = await readFile(filePath, 'utf8');
      lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const all: NormalizedMessage[] = [];
    const toolUseById = new Map<string, NormalizedMessage>();
    for (const line of lines) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      for (const message of this.normalizeMessage(event, sessionId)) {
        all.push(message);
        if (message.kind === 'tool_use' && message.toolId) {
          toolUseById.set(message.toolId, message);
        }
      }
    }

    // Attach tool results to their originating tool_use so the UI can render the
    // call/result pair, then drop standalone tool_result rows from the page.
    for (const message of all) {
      if (message.kind === 'tool_result' && message.toolId && toolUseById.has(message.toolId)) {
        const toolUse = toolUseById.get(message.toolId);
        if (toolUse) {
          toolUse.toolResult = {
            content: typeof message.content === 'string' ? message.content : '',
            isError: message.isError,
          };
        }
      }
    }

    const renderable = all.filter((message) => message.kind !== 'tool_result');
    const total = renderable.length;

    if (limit !== null) {
      const page = limit === 0 ? [] : renderable.slice(offset, offset + limit);
      const hasMore = limit === 0 ? offset < total : offset + limit < total;
      return { messages: page, total, hasMore, offset, limit };
    }

    return { messages: renderable, total, hasMore: false, offset: 0, limit: null };
  }
}
