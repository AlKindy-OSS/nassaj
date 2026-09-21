import type { FetchHistoryResult, LLMProvider } from '@/shared/types.js';

export type VendorReceiptInput = {
  userId: unknown; clientMsgId: unknown; textOnly: unknown;
};
type Receipt = { userId: number; clientMsgId: string; provider: LLMProvider; sessionId: string; nativeId: string };
const receipts = new WeakMap<FetchHistoryResult, readonly Receipt[]>();
const providers = new Set(['qwen', 'hermes', 'kimi', 'deepseek', 'glm']);
const validClientId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const validOwner = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const invocations = new WeakMap<object, { command: string; receipt: VendorReceiptInput }>();

const validAttachmentCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1024;

/** Validate the sticky text-payload declaration and mint a non-serializable invocation capability. */
export function createVendorReceiptInvocation(data: Record<string, unknown>, userId: unknown, clientMsgId: unknown): object | undefined {
  const options = data.options && typeof data.options === 'object' && !Array.isArray(data.options)
    ? data.options as Record<string, unknown> : {};
  const manifest = options.receiptPayload;
  if (!validOwner(userId) || !validClientId(clientMsgId) || options.clientMsgId !== clientMsgId || typeof data.command !== 'string' || !data.command.trim()
    || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined;
  const proof = manifest as Record<string, unknown>;
  if (Object.keys(proof).sort().join(',') !== 'fileCount,imageCount,kind,version'
    || proof.version !== 1 || proof.kind !== 'text' || !validAttachmentCount(proof.imageCount) || !validAttachmentCount(proof.fileCount)) return undefined;
  // B-1078: image/file messages also mint identity. The engine still receives a
  // single TEXT payload — image and file attachments are folded into a text path
  // annotation (handleImages/handleFiles) before dispatch, so `kind` stays 'text'.
  // `images`/`files` are the app attachment lists carried on `options`; the manifest
  // must declare their exact lengths so a tampered count cannot claim a receipt for a
  // different payload. Any OTHER multipart shape (raw content blocks, parts) is still
  // refused. This only relaxes the WRITE gate: the read side (readVendorReceipt and the
  // Claude raw collector) correlates a pure-text transcript record only, so a mismatch
  // here can never manufacture a false pairing — it only declines to mint.
  if (data.images !== undefined || data.files !== undefined) return undefined;
  const attachmentCount = (key: string): number | null => {
    const value = options[key];
    if (value === undefined) return 0;
    return Array.isArray(value) ? value.length : null;
  };
  const imageCount = attachmentCount('images');
  const fileCount = attachmentCount('files');
  if (imageCount === null || fileCount === null || imageCount !== proof.imageCount || fileCount !== proof.fileCount) return undefined;
  for (const payload of [data, options]) {
    for (const key of ['attachments', 'parts', 'content', 'image', 'file', 'multipart']) {
      const value = payload[key];
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) return undefined;
    }
  }
  const capability = Object.freeze({});
  invocations.set(capability, { command: data.command, receipt: Object.freeze({ userId, clientMsgId, textOnly: true }) });
  return capability;
}

/** Only the authenticated invocation, unchanged complete prompt and owner may reach a trusted writer. */
export function readVendorReceiptInvocation(capability: unknown, command: unknown, userId: unknown): VendorReceiptInput | undefined {
  if (!capability || typeof capability !== 'object') return undefined;
  const input = invocations.get(capability);
  return input && input.command === command && input.receipt.userId === userId ? input.receipt : undefined;
}

/** Only trusted invocation metadata can mark a newly written complete text user record. */
export function vendorReceiptMetadata(provider: LLMProvider, sessionId: string, role: string, input?: VendorReceiptInput): object {
  if (role !== 'user' || !providers.has(provider) || input?.textOnly !== true
    || !validOwner(input.userId) || !validClientId(input.clientMsgId)) return {};
  return { nassajReceipt: { version: 1, provider, sessionId, userId: input.userId,
    clientMsgId: input.clientMsgId, textOnly: true } };
}

/** Parse internal correlation only from the canonical complete human text record. */
export function readVendorReceipt(event: unknown, provider: LLMProvider, sessionId: string): Receipt | null {
  if (!event || typeof event !== 'object' || !providers.has(provider)) return null;
  const e = event as Record<string, unknown>;
  const m = e.message && typeof e.message === 'object' ? e.message as Record<string, unknown> : null;
  const r = m?.nassajReceipt && typeof m.nassajReceipt === 'object'
    ? m.nassajReceipt as Record<string, unknown> : null;
  if (e.type !== 'message' || m?.role !== 'user' || typeof m.content !== 'string' || !m.content.trim()
    || typeof m.id !== 'string' || !m.id || Buffer.byteLength(m.id) > 256 || /[\x00-\x1f\x7f]/u.test(m.id)
    || !r || r.version !== 1 || r.textOnly !== true || r.provider !== provider || r.sessionId !== sessionId
    || !validOwner(r.userId) || !validClientId(r.clientMsgId)) return null;
  if (['images', 'files', 'attachments', 'parts'].some(key => m[key] !== undefined || e[key] !== undefined)) return null;
  return { userId: r.userId, clientMsgId: r.clientMsgId, provider, sessionId, nativeId: m.id };
}

/** Associate private metadata without adding serializable fields to history or messages. */
export function setVendorHistoryReceipts(result: FetchHistoryResult, rows: readonly Receipt[]): FetchHistoryResult {
  const ids = new Set(result.messages.map(message => message.id));
  const natives = new Map<string, number>();
  const clients = new Map<string, number>();
  const key = (row: Receipt, value: string) => JSON.stringify([row.provider, row.sessionId, row.userId, value]);
  for (const row of rows) {
    const native = key(row, row.nativeId), client = key(row, row.clientMsgId);
    natives.set(native, (natives.get(native) ?? 0) + 1);
    clients.set(client, (clients.get(client) ?? 0) + 1);
  }
  receipts.set(result, rows.filter(row => ids.has(row.nativeId)
    && natives.get(key(row, row.nativeId)) === 1 && clients.get(key(row, row.clientMsgId)) === 1));
  return result;
}

/** Preserve the internal sidecar through the shared history cache's existing clone seam. */
export function copyVendorHistoryReceipts(source: FetchHistoryResult, clone: FetchHistoryResult): FetchHistoryResult {
  const rows = receipts.get(source);
  if (rows) receipts.set(clone, rows);
  return clone;
}

/** Fresh authorized response: never disclose another receipt owner or mutate a shared snapshot. */
export function projectVendorHistoryReceipts(result: FetchHistoryResult, provider: LLMProvider, sessionId: string, requester: number | null): FetchHistoryResult {
  const rows = receipts.get(result) ?? [];
  const matching = rows.filter(row => row.provider === provider && row.sessionId === sessionId && row.userId === requester);
  const nativeCounts = new Map<string, number>();
  const clientCounts = new Map<string, number>();
  const messageCounts = new Map<string, number>();
  const byNative = new Map<string, Receipt>();
  for (const row of matching) {
    nativeCounts.set(row.nativeId, (nativeCounts.get(row.nativeId) ?? 0) + 1);
    clientCounts.set(row.clientMsgId, (clientCounts.get(row.clientMsgId) ?? 0) + 1);
    byNative.set(row.nativeId, row);
  }
  for (const message of result.messages) messageCounts.set(message.id, (messageCounts.get(message.id) ?? 0) + 1);
  return { ...result, messages: result.messages.map(message => {
    const clone = { ...message };
    // displayClientMsgId is set only by the Claude owner projection (B-1078), for every provider here.
    delete clone.displayClientMsgId;
    if (!providers.has(provider)) return clone;
    delete clone.clientMsgId;
    const row = byNative.get(message.id);
    if (row && message.role === 'user' && message.kind === 'text' && message.provider === provider
      && message.sessionId === sessionId && nativeCounts.get(row.nativeId) === 1 && clientCounts.get(row.clientMsgId) === 1
      && messageCounts.get(row.nativeId) === 1) clone.clientMsgId = row.clientMsgId;
    return clone;
  }) };
}
