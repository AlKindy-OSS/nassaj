/**
 * Server-side snapshot builder for read-only session share links (ADR-196,
 * T-1970 stage 3). No routes or storage here: stage 4 wires them.
 *
 * Pipeline: read the full history as the requesting user (the read gate stays
 * in sessionsService), re-stamp authors fail-closed, build a NEW allow-listed
 * object per message (never copy-then-delete), sanitize its text, classify
 * human authorship against the SESSION OWNER (not the share creator), and emit
 * a deterministic v1 snapshot with its SHA-256 and gzip blob.
 *
 * Errors are thrown only for failures (409/413 AppError); policy refusals are
 * returned as `blockers` so the preview can show them.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import { gzipSync } from 'node:zlib';

import { sessionsDb } from '@/modules/database/index.js';
import {
  listParticipantUserIdsStrict,
  resolveStrictSpawnOwnerUserId,
} from '@/modules/database/repositories/participants.db.js';
import { HistoryMemorySink, snapshotTooLargeError } from '@/modules/providers/services/history-memory-sink.js';
import { sessionsService, stampMessageAuthorsStrict } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  normalizeParts, sanitizeShareText, type SharePart, type ShareTextContext, type ShareTextCounts,
} from './session-share-sanitize.js';

export const SHARE_SNAPSHOT_LIMITS = Object.freeze({
  messages: 5000,
  textBytes: 4 * 1024 * 1024,
  /** Raw (pre-sanitization) caps, checked BEFORE sanitizing so its CPU cost stays bounded. */
  rawMessageBytes: 4 * 1024 * 1024,
  rawTotalBytes: 4 * 1024 * 1024,
  rawTitleChars: 16 * 1024,
  blobBytes: 1024 * 1024,
  maxPages: 64,
});

export type ShareSnapshotMessage = {
  role: 'user' | 'assistant';
  author: 'owner' | 'assistant';
  at?: string;
  parts: SharePart[];
};
export type ShareSnapshot = {
  v: 1;
  title: string;
  createdAt?: string;
  providerLabel: string;
  toolCount: number;
  messages: ShareSnapshotMessage[];
};
export type ShareSnapshotCounts = ShareTextCounts & { toolCount: number; thinking: number; other: number };
export type ShareBlockerCode =
  | 'FOREIGN_AUTHOR'
  | 'UNATTRIBUTED_MULTI_PARTICIPANT'
  | 'UNATTRIBUTED_NEEDS_CONFIRMATION'
  | 'UNATTRIBUTED_PARTICIPANTS_UNVERIFIED';
export type ShareBlocker = { code: ShareBlockerCode; count: number };
export type ShareSnapshotResult = {
  /** Null whenever `blockers` is non-empty, so a blocked snapshot cannot be stored. */
  snapshot: ShareSnapshot | null;
  sha256: string | null;
  blob: Buffer | null;
  upToMessageId: string | null;
  counts: ShareSnapshotCounts;
  possibleSecretsNote: true;
  blockers: ShareBlocker[];
};
export type ShareAuthorContext = {
  sessionOwnerUserId: number;
  provider: string;
  participantUserIds: number[];
  confirmUnattributed: boolean;
};
export type AssembleOptions = ShareAuthorContext & {
  title?: string;
  createdAt?: string;
  upToMessageId?: string;
  projectRoot?: string | null;
  home?: string | null;
};

const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', kimi: 'Kimi', opencode: 'OpenCode',
  qwen: 'Qwen', glm: 'GLM', deepseek: 'DeepSeek', cursor: 'Cursor', hermes: 'Hermes',
});
const DEFAULT_TITLE = 'Shared conversation';
const MAX_TITLE_CHARS = 200;
const SUBAGENT_MARKERS = [
  'originKind', 'parentToolUseId', 'parent_tool_use_id', 'isSidechain', 'agentId', 'subagentId',
  'isSubagent', 'isMeta', 'isSynthetic', 'isReplay', 'isCompactSummary', 'isLocalCommand',
  'isLocalCommandStdout', 'isTaskNotification', 'isSkillLoad',
] as const;

/** Typed 409 helper. */
function conflict(code: string, message: string): AppError {
  return new AppError(message, { code, statusCode: 409 });
}

/** Generic provider label; never a model id. */
export function providerLabelFor(provider: string): string {
  return PROVIDER_LABELS[provider] ?? 'Assistant';
}

/** True for a human/assistant text row with no machine-routing marker. */
function isShareableText(message: NormalizedMessage): boolean {
  if (message.kind !== 'text' || (message.role !== 'user' && message.role !== 'assistant')) return false;
  return SUBAGENT_MARKERS.every((key) => !message[key]);
}

/** Counts a dropped row in its category. */
function countDropped(message: NormalizedMessage, counts: ShareSnapshotCounts): void {
  if (message.kind === 'tool_use') counts.toolCount += 1;
  else if (message.kind === 'thinking') counts.thinking += 1;
  else if (message.kind === 'text') counts.system += 1;
  else if (message.kind !== 'tool_result') counts.other += 1;
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Stable-key JSON: identical input always yields identical bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Title as plain text: sanitized like a message (same project/home context, so
 * paths are redacted identically), markers flattened, length capped. Pure in
 * (title, ctx), so preview and create of the same session hash the same title.
 */
export function sanitizeTitle(title: string | undefined, ctx: ShareTextContext = {}): string {
  // An oversized raw title is replaced, not truncated: a cut could split a secret past its pattern.
  if ((title?.length ?? 0) > SHARE_SNAPSHOT_LIMITS.rawTitleChars) return DEFAULT_TITLE;
  const scratch = emptyCounts();
  const parts = normalizeParts(sanitizeShareText(title ?? '', ctx, scratch));
  const text = parts.map((part) => (part.t === 'text' ? part.text : part.text ?? '[redacted]')).join('')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  return text || DEFAULT_TITLE;
}

/** Cuts the history at `upToMessageId` inclusive; a missing id means the session moved. */
function truncateAt(messages: NormalizedMessage[], upToMessageId?: string): NormalizedMessage[] {
  if (upToMessageId === undefined) return messages;
  const index = messages.findIndex((message) => message.id === upToMessageId);
  if (index === -1) throw conflict('SNAPSHOT_CHANGED', 'The conversation changed since the preview.');
  return messages.slice(0, index + 1);
}

/**
 * Classifies included human rows against the session owner and returns the
 * policy blockers (fail-closed). An unattributed row passes only when the
 * participant list is exactly the session owner: silently for Claude, whose
 * transcripts mark machine prompts reliably, and with explicit confirmation
 * for every other provider.
 */
export function evaluateAuthorBlockers(userIds: Array<number | null>, ctx: ShareAuthorContext): ShareBlocker[] {
  const other = userIds.filter((id) => id !== null && id !== ctx.sessionOwnerUserId).length;
  const unknown = userIds.filter((id) => id === null).length;
  const blockers: ShareBlocker[] = [];
  if (other > 0) blockers.push({ code: 'FOREIGN_AUTHOR', count: other });
  if (unknown === 0) return blockers;
  const ids = ctx.participantUserIds;
  const soleOwner = ids.length === 1 && ids[0] === ctx.sessionOwnerUserId;
  if (ids.length > 1) blockers.push({ code: 'UNATTRIBUTED_MULTI_PARTICIPANT', count: unknown });
  else if (!soleOwner) blockers.push({ code: 'UNATTRIBUTED_PARTICIPANTS_UNVERIFIED', count: unknown });
  else if (ctx.provider !== 'claude' && !ctx.confirmUnattributed) {
    blockers.push({ code: 'UNATTRIBUTED_NEEDS_CONFIRMATION', count: unknown });
  }
  return blockers;
}

function emptyCounts(): ShareSnapshotCounts {
  return { toolCount: 0, thinking: 0, image: 0, system: 0, secret: 0, path: 0, network: 0, other: 0 };
}

/**
 * Rejects (413) a message whose raw text, alone or added to `rawSoFar`, is past
 * the raw caps; runs before sanitization so its cost is bounded.
 * @returns the message's raw byte length.
 */
function assertRawWithinLimits(raw: string, rawSoFar: number): number {
  const bytes = Buffer.byteLength(raw);
  if (bytes > SHARE_SNAPSHOT_LIMITS.rawMessageBytes || rawSoFar + bytes > SHARE_SNAPSHOT_LIMITS.rawTotalBytes) {
    throw snapshotTooLargeError();
  }
  return bytes;
}

/** Allow-lists and sanitizes the rows; returns output rows, their source ids and human authors. */
function selectMessages(messages: NormalizedMessage[], options: AssembleOptions, counts: ShareSnapshotCounts) {
  const rows: ShareSnapshotMessage[] = [];
  const humanAuthors: Array<number | null> = [];
  let lastId: string | null = null;
  let textBytes = 0;
  let rawBytes = 0;
  const ctx = { projectRoot: options.projectRoot, home: options.home };
  for (const message of messages) {
    if (!isShareableText(message)) { countDropped(message, counts); continue; }
    const raw = typeof message.content === 'string' ? message.content : '';
    rawBytes += assertRawWithinLimits(raw, rawBytes);
    const parts = sanitizeShareText(raw, ctx, counts);
    if (parts.length === 0) continue;
    for (const part of parts) if (part.t === 'text') textBytes += Buffer.byteLength(part.text);
    if (textBytes > SHARE_SNAPSHOT_LIMITS.textBytes || rows.length >= SHARE_SNAPSHOT_LIMITS.messages) {
      throw snapshotTooLargeError();
    }
    const role = message.role as 'user' | 'assistant';
    if (role === 'user') humanAuthors.push(Number.isInteger(message.userId) ? (message.userId as number) : null);
    rows.push({ role, author: role === 'user' ? 'owner' : 'assistant', at: isoOrUndefined(message.timestamp), parts });
    lastId = message.id;
  }
  return { rows, humanAuthors, lastId };
}

/**
 * Pure assembly from already-loaded, author-stamped messages.
 * @throws AppError 409 SNAPSHOT_CHANGED, 413 SNAPSHOT_TOO_LARGE.
 */
export function assembleShareSnapshot(messages: NormalizedMessage[], options: AssembleOptions): ShareSnapshotResult {
  const counts = emptyCounts();
  const { rows, humanAuthors, lastId } = selectMessages(truncateAt(messages, options.upToMessageId), options, counts);
  const blockers = evaluateAuthorBlockers(humanAuthors, options);
  const base = { upToMessageId: lastId, counts, possibleSecretsNote: true as const, blockers };
  if (blockers.length > 0) return { ...base, snapshot: null, sha256: null, blob: null };
  const createdAt = isoOrUndefined(options.createdAt);
  const snapshot: ShareSnapshot = {
    v: 1,
    title: sanitizeTitle(options.title, { projectRoot: options.projectRoot, home: options.home }),
    ...(createdAt === undefined ? {} : { createdAt }),
    providerLabel: providerLabelFor(options.provider),
    toolCount: counts.toolCount,
    messages: rows,
  };
  const json = canonicalJson(snapshot);
  const blob = gzipSync(Buffer.from(json, 'utf8'));
  if (blob.length > SHARE_SNAPSHOT_LIMITS.blobBytes) throw snapshotTooLargeError();
  return { ...base, snapshot, sha256: createHash('sha256').update(json).digest('hex'), blob };
}

export type LoadHistory = (sessionId: string, readerUserId: number, sink: HistoryMemorySink) => Promise<void>;

/** Reads every history page into the sink, through the bounded reader when the session uses it. */
export const loadFullHistory: LoadHistory = async (sessionId, readerUserId, sink) => {
  if (sessionsService.usesBoundedHistory(sessionId)) {
    await sessionsService.withHistoryLeaseCallback(sessionId, readerUserId, { payloadMode: 'full' }, sink.signal,
      (payload) => { sink.acceptOlderPage(payload.messages); });
    return;
  }
  let cursor: string | undefined;
  for (let page = 0; page < SHARE_SNAPSHOT_LIMITS.maxPages; page += 1) {
    const result = await sessionsService.fetchHistory(sessionId, readerUserId, { payloadMode: 'full', cursor });
    sink.acceptOlderPage(result.messages);
    if (!result.hasMore || !result.nextCursor) return;
    cursor = result.nextCursor;
  }
  throw snapshotTooLargeError();
};

export type SnapshotDeps = {
  loadHistory: LoadHistory;
  stampAuthors: (sessionId: string, messages: NormalizedMessage[]) => void;
  resolveSessionOwner: (sessionId: string) => number | null;
  listParticipantIds: (sessionId: string) => number[];
  getSession: (sessionId: string) => { provider: string; project_path: string | null } | null;
  home: () => string;
};

export const defaultSnapshotDeps: SnapshotDeps = {
  loadHistory: loadFullHistory,
  stampAuthors: stampMessageAuthorsStrict,
  resolveSessionOwner: resolveStrictSpawnOwnerUserId,
  listParticipantIds: listParticipantUserIdsStrict,
  getSession: (sessionId) => sessionsDb.getSessionById(sessionId),
  home: () => os.homedir(),
};

export type BuildShareSnapshotInput = {
  sessionId: string;
  /** The authenticated share creator; history is read under their read gate. */
  readerUserId: number;
  upToMessageId?: string;
  confirmUnattributed?: boolean;
  title?: string;
  createdAt?: string;
};

/** Participant ids for authorship; an unreadable list is unverifiable, never "empty". */
function readParticipants(deps: SnapshotDeps, sessionId: string): number[] {
  try {
    return deps.listParticipantIds(sessionId);
  } catch {
    throw conflict('AUTHOR_UNVERIFIABLE', 'Message authorship could not be verified.');
  }
}

/**
 * Builds a share snapshot (or its preview) for one session.
 * @throws AppError 404 (read gate), 409 OWNER_UNRESOLVED / AUTHOR_UNVERIFIABLE /
 *   SNAPSHOT_CHANGED, 413 SNAPSHOT_TOO_LARGE.
 */
export async function buildSessionShareSnapshot(
  input: BuildShareSnapshotInput,
  deps: SnapshotDeps = defaultSnapshotDeps,
): Promise<ShareSnapshotResult> {
  const sink = new HistoryMemorySink();
  await deps.loadHistory(input.sessionId, input.readerUserId, sink);
  const session = deps.getSession(input.sessionId);
  if (!session) throw new AppError('Session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  const sessionOwnerUserId = deps.resolveSessionOwner(input.sessionId);
  if (sessionOwnerUserId === null) throw conflict('OWNER_UNRESOLVED', 'The session owner could not be resolved.');
  const messages = sink.messages();
  deps.stampAuthors(input.sessionId, messages);
  return assembleShareSnapshot(messages, {
    sessionOwnerUserId,
    provider: session.provider,
    participantUserIds: readParticipants(deps, input.sessionId),
    confirmUnattributed: input.confirmUnattributed === true,
    title: input.title,
    createdAt: input.createdAt,
    upToMessageId: input.upToMessageId,
    projectRoot: session.project_path,
    home: deps.home(),
  });
}
