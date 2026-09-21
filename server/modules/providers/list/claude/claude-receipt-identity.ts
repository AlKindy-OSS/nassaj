import { createHash, randomUUID } from 'node:crypto';

import type { FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { messageCoordinationDb } from '@/modules/database/index.js';
import { readVendorReceiptInvocation } from '@/modules/providers/shared/vendor/vendor-receipt-identity.js';

import type { HistoryReadLease } from '../../services/history-budget.service.js';

const MAX_BYTES = 1024 * 1024;
const MAX_BLOCKS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type ObjectRow = Record<string, any>;
type NativeReceipt = { uuid: string; payloadSha256: string; messageIds: string[] };
const histories = new WeakMap<FetchHistoryResult, readonly NativeReceipt[]>();

/** Version 1: ordered text blocks, each tagged and UTF-8 length-prefixed; images are unsupported. */
export function claudeTextPayloadHash(content: unknown): string | null {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > MAX_BLOCKS) return null;
  const hash = createHash('sha256').update('nassaj:claude:text-payload:v1\0');
  let bytes = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Object.keys(block).sort().join(',') !== 'text,type'
      || block.type !== 'text' || typeof block.text !== 'string' || !block.text.length || !block.text.isWellFormed()) return null;
    const length = Buffer.byteLength(block.text);
    bytes += length;
    if (bytes > MAX_BYTES) return null;
    const size = Buffer.alloc(4); size.writeUInt32BE(length);
    hash.update('text\0').update(size).update(block.text);
  }
  return hash.digest('hex');
}

/** All fallback generators share this invocation's single-use latch, set before the SDK yield. */
export function createClaudeReceiptPrompt(input: {
  capability: unknown; command: string; content: unknown; userId: unknown;
  sessionId: string | null; persistSession?: boolean; release: Promise<unknown>;
}, bind = messageCoordinationDb.bindClaudeIdentity) {
  const receipt = readVendorReceiptInvocation(input.capability, input.command, input.userId);
  const payloadSha256 = claudeTextPayloadHash(input.content);
  const content = payloadSha256 && Array.isArray(input.content)
    ? input.content.map(block => ({ type: 'text', text: block.text })) : input.content;
  let consumed = false;
  const make = async function* () {
    if (consumed) throw new Error('CLAUDE_PROMPT_ALREADY_DISPATCHED');
    consumed = true;
    let uuid: string | undefined;
    if (receipt && payloadSha256 && input.persistSession !== false) {
      uuid = randomUUID();
      if (!bind({ clientMsgId: receipt.clientMsgId as string, userId: receipt.userId as number,
        provider: 'claude', sessionId: input.sessionId, uuid, payloadSha256 })) {
        throw new Error('CLAUDE_RECEIPT_BINDING_CONFLICT');
      }
    }
    yield { type: 'user', session_id: '', parent_tool_use_id: null,
      ...(uuid ? { uuid } : {}), message: { role: 'user', content } };
    await input.release;
  };
  return { make, wasConsumed: () => consumed };
}

/** Raw model activity only: synthetic auth failures and replay cannot prove acceptance. */
export function isTrustedClaudeActivity(raw: ObjectRow): boolean {
  if (!raw || raw.isReplay === true || raw.isSidechain === true || raw.isMeta === true
    || raw.parent_tool_use_id != null || raw.parentToolUseId != null || raw.error != null
    || raw.isApiErrorMessage === true || (raw.origin != null && raw.origin.kind !== 'human')) return false;
  const assistant = raw.type === 'assistant' ? raw.message
    : raw.type === 'stream_event' && raw.event?.type === 'message_start' ? raw.event.message : null;
  return assistant?.role === 'assistant' && typeof assistant.model === 'string'
    && assistant.model.length > 0 && !assistant.model.startsWith('<') && assistant.error == null;
}

/** Observe ALL raw records before session/role filtering; ambiguity or bounds disable correlation. */
export function createClaudeRawIdentityCollector(sessionId: string) {
  const counts = new Map<string, number>();
  const candidates = new Map<string, ObjectRow>();
  let totalBytes = 0, records = 0, invalid = false;
  return {
    observe(raw: ObjectRow, bytes: number) {
      totalBytes += bytes; records++;
      if (records > 100000 || totalBytes > 32 * MAX_BYTES) { invalid = true; candidates.clear(); counts.clear(); }
      if (invalid || !raw || typeof raw.uuid !== 'string' || !UUID.test(raw.uuid)) return;
      counts.set(raw.uuid, (counts.get(raw.uuid) ?? 0) + 1);
      if (counts.size > 10000) { invalid = true; candidates.clear(); counts.clear(); return; }
      if (raw.type !== 'user' || raw.sessionId !== sessionId || raw.message?.role !== 'user'
        || raw.isSidechain === true || raw.isMeta === true || raw.isSynthetic === true
        || raw.isCompactSummary === true || raw.isReplay === true || raw.shouldQuery === false
        || raw.agentId != null || raw.sourceToolAssistantUUID != null
        || ['images', 'files', 'attachments'].some(key => raw[key] !== undefined || raw.message[key] !== undefined)
        || raw.parent_tool_use_id != null || raw.parentToolUseId != null
        || (raw.origin != null && (typeof raw.origin !== 'object' || raw.origin.kind !== 'human'))
        || !claudeTextPayloadHash(raw.message.content)) return;
      candidates.set(raw.uuid, raw);
    },
    reject() { invalid = true; candidates.clear(); },
    attach(result: FetchHistoryResult, normalize: (raw: unknown) => NormalizedMessage[]) {
      const rows: NativeReceipt[] = [];
      if (!invalid) for (const [uuid, raw] of candidates) {
        if (counts.get(uuid) !== 1) continue;
        const normalized = normalize(raw);
        const texts = typeof raw.message.content === 'string' ? [raw.message.content]
          : raw.message.content.map((block: ObjectRow) => block.text);
        if (normalized.length !== texts.length || normalized.some((message, i) => message.role !== 'user'
          || message.kind !== 'text' || message.content !== texts[i] || message.sessionId !== sessionId
          || message.provider !== 'claude')) continue;
        rows.push({ uuid, payloadSha256: claudeTextPayloadHash(raw.message.content)!, messageIds: normalized.map(m => m.id) });
      }
      histories.set(result, rows);
      return result;
    },
  };
}

/** Preserve non-serializable native metadata through the existing cache clone seam. */
export function copyClaudeHistoryReceipts(source: FetchHistoryResult, clone: FetchHistoryResult): FetchHistoryResult {
  const rows = histories.get(source); if (rows) histories.set(clone, rows);
  return clone;
}

type ClaudeIdentityRow = ReturnType<typeof messageCoordinationDb.readClaudeIdentities>[number];

/** Outbox deletion proof: only an accepted, terminal, successful turn may prune the optimistic row. */
function isSuccessfulTerminalReceipt(receipt: ClaudeIdentityRow, lease?: HistoryReadLease): boolean {
  if (!receipt.acceptedAt || receipt.lifecycleStatus !== 'terminal') return false;
  let verdict: ObjectRow;
  try { verdict = (lease ? lease.parseNested(receipt.verdictJson ?? 'null') : JSON.parse(receipt.verdictJson ?? 'null')); } catch { return false; }
  // Until errors have independent durable presentation, only successful completed turns may prune.
  return !!verdict && verdict.kind === 'complete' && verdict.success !== false && verdict.isError !== true
    && (verdict.success === true || verdict.exitCode === 0);
}

/**
 * Fresh owner-scoped DB evidence is projected only after authorization, never into the shared cache.
 *
 * Two stages (B-1078). Identity: exactly one of the requester's receipts matches uuid + payload hash and
 * every normalized part is a unique claude user text row of this session; the first part then carries
 * `displayClientMsgId` (render pairing only) whatever the lifecycle. Pruning: `clientMsgId` stays behind
 * the successful-terminal gate because the client outbox deletes on it. Both fields are stripped from
 * every row first, so cache or normalizer values never reach the response.
 */
export function projectClaudeHistoryReceipts(result: FetchHistoryResult, sessionId: string, requester: number | null,
  read = messageCoordinationDb.readClaudeIdentities, lease?: HistoryReadLease): FetchHistoryResult {
  const clone = { ...result, messages: result.messages.map(message => {
    const copy = { ...message }; delete copy.clientMsgId; delete copy.displayClientMsgId; return copy;
  }) };
  if (requester === null || !histories.has(result)) return clone;
  let receipts: ReturnType<typeof read>;
  try { receipts = read(requester, sessionId, lease); } catch { return clone; }
  const messageCounts = new Map<string, number>();
  for (const message of clone.messages) messageCounts.set(message.id, (messageCounts.get(message.id) ?? 0) + 1);
  for (const native of histories.get(result) ?? []) {
    lease?.charge('comparisons', receipts.length + native.messageIds.length * clone.messages.length);
    const matches = receipts.filter(row => row.uuid === native.uuid && row.payloadSha256 === native.payloadSha256);
    if (matches.length !== 1) continue;
    const parts = native.messageIds.map(id => clone.messages.find(message => message.id === id));
    if (parts.some(part => !part || messageCounts.get(part.id) !== 1 || part.role !== 'user'
      || part.kind !== 'text' || part.provider !== 'claude' || part.sessionId !== sessionId)) continue;
    parts[0]!.displayClientMsgId = matches[0].clientMsgId;
    if (isSuccessfulTerminalReceipt(matches[0], lease)) parts[0]!.clientMsgId = matches[0].clientMsgId;
  }
  return clone;
}
