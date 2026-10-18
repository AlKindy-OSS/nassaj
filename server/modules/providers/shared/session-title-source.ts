/**
 * Where a conversation's title comes from when the provider has not named it
 * (B-1668 item 3): the FIRST real user prompt, read from a bounded head of the
 * transcript and cleaned of injected blocks.
 *
 * The head read is bounded in bytes and records, and a line longer than the
 * line bound is skipped without `JSON.parse` — a first prompt can carry a
 * multi-megabyte image or paste, and whole-file reads OOM'd before (B-954).
 */
import { open } from 'node:fs/promises';

// eslint-disable-next-line boundaries/no-unknown -- B-1668: the one title text pipeline shared with every viewer egress.
import { isPlaceholderSessionTitle, toTitleText } from '@/services/session-title-text.js';

import { isInternalUserText } from './internal-content.js';

export { isPlaceholderSessionTitle };

type JsonRecord = Record<string, unknown>;

export type JsonlHeadLimits = { maxBytes: number; maxRecords: number; maxLineChars: number };

export const DEFAULT_TITLE_HEAD_LIMITS: JsonlHeadLimits = {
  maxBytes: 512 * 1024,
  maxRecords: 200,
  maxLineChars: 128 * 1024,
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses the complete lines of a bounded head of a JSONL file; [] when unreadable. */
export async function readJsonlHeadRecords(
  filePath: string,
  limits: JsonlHeadLimits = DEFAULT_TITLE_HEAD_LIMITS,
): Promise<JsonRecord[]> {
  let content: string;
  let truncated: boolean;
  try {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(limits.maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.toString('utf8', 0, bytesRead);
      truncated = bytesRead === buffer.length;
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }

  const lines = content.split('\n');
  if (truncated) lines.pop();
  const records: JsonRecord[] = [];
  for (const line of lines) {
    if (records.length >= limits.maxRecords) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > limits.maxLineChars) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // A malformed line never costs the remaining records.
    }
  }
  return records;
}

const textParts = (content: unknown, partType: string): string | null => {
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((part) => isRecord(part) && part.type === partType && typeof part.text === 'string')
    .map((part) => String((part as JsonRecord).text));
  return texts.length > 0 ? texts.join(' ') : null;
};

/** The user-typed text of one Claude transcript record, or null for anything else. */
export function claudePromptText(record: JsonRecord): string | null {
  if (record.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary) return null;
  const message = isRecord(record.message) ? record.message : null;
  if (!message || message.role !== 'user') return null;
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.some((part) => isRecord(part) && part.type === 'tool_result')) return null;
  return textParts(content, 'text');
}

/** The user-typed text of one Codex rollout record, or null for anything else. */
export function codexPromptText(record: JsonRecord): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;
  if (record.type === 'event_msg' && payload.type === 'user_message') {
    const plain = !payload.kind || payload.kind === 'plain';
    return plain && typeof payload.message === 'string' ? payload.message : null;
  }
  if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    return textParts(payload.content, 'input_text');
  }
  return null;
}

/**
 * Title text of one user prompt: injected blocks removed, collapsed to a line.
 * '' for harness output, a placeholder, or a prompt that was only a block.
 */
export function promptTitleText(raw: string | null | undefined): string {
  if (!raw || isInternalUserText(raw)) return '';
  const title = toTitleText(raw);
  return isPlaceholderSessionTitle(title) ? '' : title;
}

/**
 * The cleaned title text of the first record whose user text survives
 * cleaning; undefined when none does. A prompt that is only an injected block
 * (Codex's AGENTS.md envelope, an image-only message) is skipped, never stored
 * as an empty title.
 */
export function firstRealPromptTitle(
  records: readonly JsonRecord[],
  extract: (record: JsonRecord) => string | null,
): string | undefined {
  for (const record of records) {
    const title = promptTitleText(extract(record));
    if (title) return title;
  }
  return undefined;
}

/**
 * True when a stored name must be re-derived: absent, a provider placeholder,
 * or nothing left once injected blocks are removed (a title frozen as
 * `<nassaj_document_sharing>…`). Anything else — a user rename included — is
 * kept as it is.
 */
export function isReplaceableStoredTitle(stored: string | null | undefined): boolean {
  return !stored || isPlaceholderSessionTitle(stored) || toTitleText(stored) === '';
}
