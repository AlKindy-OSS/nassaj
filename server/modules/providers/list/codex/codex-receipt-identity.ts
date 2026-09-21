import type { FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import type { messageCoordinationDb } from '@/modules/database/index.js';

import { codexNativePayloadHash, codexReceiptPayloadHash, type CodexUserProof } from './codex-receipt-proof.js';

type Row = Record<string, any>;
type NativeIdentity = CodexUserProof & { displayId: string };
const boundedId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x20\x7f]/u.test(value);
const rawIdentities = new WeakMap<object, CodexUserProof>();
const histories = new WeakMap<FetchHistoryResult, readonly NativeIdentity[]>();

/** Count all native IDs before pagination/filtering; ambiguity disables reconciliation. */
export function createCodexReceiptCollector() {
  const counts = new Map<string, number>(), candidates: Array<{ raw: object; proof: CodexUserProof }> = [];
  let valid = true;
  const invalidate = () => { valid = false; counts.clear(); candidates.length = 0; };
  return {
    observe(entry: Row) {
      if (!valid) return;
      const id = entry?.payload?.id;
      if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
      if (counts.size > 100000) invalidate();
    },
    associate(payload: Row, raw: object) {
      if (!valid) return;
      const hash = codexNativePayloadHash(payload), turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
      if (hash && typeof payload.id === 'string' && typeof turnId === 'string') candidates.push({ raw,
        proof: { version: 'codex_user_v1', userMessageId: payload.id, turnId, payloadSha256: hash } });
    },
    reject: invalidate,
    finish() {
      if (valid) for (const { raw, proof } of candidates) {
        if (counts.get(proof.userMessageId) === 1) rawIdentities.set(raw, proof);
      }
    },
  };
}

/** A display row must still contain every submitted part after renderer sanitization and eviction. */
function completeDisplay(message: NormalizedMessage, proof: CodexUserProof): boolean {
  return message.role === 'user' && message.kind === 'text' && message.provider === 'codex'
    && !message.imagesOmitted && codexReceiptPayloadHash(message.content, message.images ?? []) === proof.payloadSha256;
}

/** Preserve stable display IDs; carry native evidence only in a non-serializable sidecar. */
export function codexHistoryIdentity(raw: object, message: NormalizedMessage): NativeIdentity | null {
  const proof = rawIdentities.get(raw);
  return proof && completeDisplay(message, proof) ? { ...proof, displayId: message.id } : null;
}

/** Attach only rows surviving provider pagination. */
export function setCodexHistoryIdentities(result: FetchHistoryResult, rows: readonly NativeIdentity[]): FetchHistoryResult {
  const ids = new Set(result.messages.map(message => message.id));
  histories.set(result, rows.filter(row => ids.has(row.displayId)));
  return result;
}

/** Copy the private sidecar alongside the shared snapshot clone. */
export function copyCodexHistoryIdentities(source: FetchHistoryResult, clone: FetchHistoryResult): FetchHistoryResult {
  const rows = histories.get(source);
  if (rows) histories.set(clone, rows);
  return clone;
}

/** Only exact, successful, scoped stored verdicts may link to a canonical native user. */
function readProof(row: { clientMsgId: string; verdictJson: string }, sessionId: string): CodexUserProof | null {
  try {
    const v = JSON.parse(row.verdictJson), proof = v?.codexUserProof;
    if (v.kind !== 'complete' || v.provider !== 'codex' || v.sessionId !== sessionId || v.clientMsgId !== row.clientMsgId
      || (v.actualSessionId !== undefined && v.actualSessionId !== sessionId)
      || v.error || v.code || v.notStarted === true || v.sameClientMsgIdRetryable === true
      || (v.success !== undefined && v.success !== true) || (v.exitCode !== undefined && v.exitCode !== 0)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(row.clientMsgId)
      || proof?.version !== 'codex_user_v1' || !boundedId(proof.userMessageId) || !boundedId(proof.turnId)
      || !/^[0-9a-f]{64}$/u.test(proof.payloadSha256)) return null;
    return proof;
  } catch { return null; }
}

/** Fresh owner-only projection; never alter a shared cached DTO or infer identity from text. */
export function projectCodexHistoryIdentities(result: FetchHistoryResult, sessionId: string, userId: number | null,
  lease: Parameters<typeof messageCoordinationDb.readCodexVerdicts>[2], read: typeof messageCoordinationDb.readCodexVerdicts): FetchHistoryResult {
  const clone = { ...result, messages: result.messages.map(message => ({ ...message })) };
  // displayClientMsgId is set only by the Claude owner projection (B-1078); never let it through here.
  for (const message of clone.messages) { delete message.clientMsgId; delete message.displayClientMsgId; }
  if (!Number.isSafeInteger(userId) || userId! <= 0) return clone;
  const rows = read(userId!, sessionId, lease);
  const byNative = new Map<string, Array<{ clientMsgId: string; proof: CodexUserProof }>>();
  for (const row of rows) {
    const proof = readProof(row, sessionId);
    if (!proof) continue;
    const matches = byNative.get(proof.userMessageId) ?? [];
    matches.push({ clientMsgId: row.clientMsgId, proof }); byNative.set(proof.userMessageId, matches);
  }
  const natives = histories.get(result) ?? [];
  const nativeCounts = new Map<string, number>(), clientCounts = new Map<string, number>();
  const displayRows = new Map<string, NormalizedMessage[]>();
  for (const native of natives) nativeCounts.set(native.userMessageId, (nativeCounts.get(native.userMessageId) ?? 0) + 1);
  for (const row of rows) clientCounts.set(row.clientMsgId, (clientCounts.get(row.clientMsgId) ?? 0) + 1);
  for (const message of clone.messages) {
    const group = displayRows.get(message.id) ?? []; group.push(message); displayRows.set(message.id, group);
  }
  for (const native of natives) {
    const binding = byNative.get(native.userMessageId);
    if (binding?.length !== 1 || nativeCounts.get(native.userMessageId) !== 1) continue;
    const { proof, clientMsgId } = binding[0];
    if (clientCounts.get(clientMsgId) !== 1 || proof.turnId !== native.turnId || proof.payloadSha256 !== native.payloadSha256) continue;
    const messages = displayRows.get(native.displayId) ?? [];
    if (messages.length === 1 && messages[0].sessionId === sessionId && completeDisplay(messages[0], proof)) messages[0].clientMsgId = clientMsgId;
  }
  return clone;
}
