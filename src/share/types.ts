/**
 * Wire format of a shared transcript (GET /api/session-shares/:id), version 1.
 * Mirrors ShareSnapshot in server/services/session-share-snapshot.ts.
 */
export const REDACTION_CATEGORIES = ['secret', 'path', 'network', 'image', 'system'] as const;
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];

export type SharePart =
  | { t: 'text'; text: string }
  | { t: 'redacted'; cat?: RedactionCategory; text?: string };

export interface ShareMessage {
  role: 'user' | 'assistant';
  author: 'owner' | 'assistant';
  at?: string;
  parts: SharePart[];
}

export interface ShareTranscriptData {
  v: 1;
  title: string;
  createdAt?: string;
  providerLabel?: string;
  /** Not sent by the v1 API today; rendered when a later version provides it. */
  expiresAt?: string;
  messages: ShareMessage[];
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function parsePart(raw: unknown): SharePart | null {
  const part = raw as Record<string, unknown> | null;
  if (part?.t === 'text' && typeof part.text === 'string') return { t: 'text', text: part.text };
  if (part?.t !== 'redacted') return null;
  // An unknown category is still a redaction: it renders as the generic chip.
  const cat = REDACTION_CATEGORIES.find((known) => known === part.cat);
  return { t: 'redacted', cat, text: asString(part.text) };
}

function parseMessage(raw: unknown): ShareMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Record<string, unknown>;
  if ((message.role !== 'user' && message.role !== 'assistant') || !Array.isArray(message.parts)) return null;
  const parts: SharePart[] = [];
  for (const rawPart of message.parts) {
    const part = parsePart(rawPart);
    if (!part) return null;
    parts.push(part);
  }
  const author = message.author === 'owner' || message.author === 'assistant'
    ? message.author
    : message.role === 'user' ? 'owner' : 'assistant';
  return { role: message.role, author, at: asString(message.at), parts };
}

/** Narrow untrusted JSON to the v1 transcript shape; anything else is rejected. */
export function parseTranscript(value: unknown): ShareTranscriptData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.v !== 1 || typeof data.title !== 'string' || !Array.isArray(data.messages)) return null;
  const messages: ShareMessage[] = [];
  for (const raw of data.messages) {
    const message = parseMessage(raw);
    if (!message) return null;
    messages.push(message);
  }
  return {
    v: 1,
    title: data.title,
    createdAt: asString(data.createdAt),
    providerLabel: asString(data.providerLabel),
    expiresAt: asString(data.expiresAt),
    messages,
  };
}

// ---- v2 live wire format (GET /api/share-view/:id/{meta,messages}) ----

export type LivePart =
  | { t: 'text'; text: string }
  | { t: 'redacted'; cat?: RedactionCategory | 'truncated' }
  | { t: 'image'; ref: string }
  | { t: 'file'; ref: string; name: string }
  | { t: 'attachment-unavailable'; kind: 'image' | 'file' };

export interface LiveMessage {
  k: string;
  c: string;
  role: 'user' | 'assistant';
  author: 'owner' | 'member' | 'assistant';
  at?: string;
  parts: LivePart[];
}

export interface LiveMeta {
  title: string;
  providerLabel?: string;
  expiresAt?: string;
}

export interface LivePage {
  revision: string;
  running: boolean;
  stale: boolean;
  moreBefore: boolean;
  moreAfter: boolean;
  retryAfterMs: number;
  messages: LiveMessage[];
}

export type MetaResponse = { mode: 'live'; meta: LiveMeta } | { mode: 'snapshot' };

const CURSOR = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{22}$/;
const REF = /^[A-Za-z0-9_.-]{1,160}$/;
const LIVE_CATS = [...REDACTION_CATEGORIES, 'truncated'] as const;
const DEFAULT_RETRY_MS = 5000;

export const isCursor = (value: unknown): value is string => typeof value === 'string' && CURSOR.test(value);

function parseLivePart(raw: unknown): LivePart | null {
  const part = raw as Record<string, unknown> | null;
  if (!part || typeof part !== 'object') return null;
  if (part.t === 'text' && typeof part.text === 'string') return { t: 'text', text: part.text };
  if (part.t === 'redacted') return { t: 'redacted', cat: LIVE_CATS.find((known) => known === part.cat) };
  if (part.t === 'image' && typeof part.ref === 'string' && REF.test(part.ref)) return { t: 'image', ref: part.ref };
  if (part.t === 'file' && typeof part.ref === 'string' && REF.test(part.ref)) {
    return { t: 'file', ref: part.ref, name: typeof part.name === 'string' && part.name ? part.name : 'file' };
  }
  if (part.t === 'attachment-unavailable') {
    return { t: 'attachment-unavailable', kind: part.kind === 'image' ? 'image' : 'file' };
  }
  return null;
}

function parseLiveMessage(raw: unknown): LiveMessage | null {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== 'object' || typeof m.k !== 'string' || !KEY.test(m.k) || !isCursor(m.c)) return null;
  if ((m.role !== 'user' && m.role !== 'assistant') || !Array.isArray(m.parts)) return null;
  const parts: LivePart[] = [];
  for (const rawPart of m.parts) {
    const part = parseLivePart(rawPart);
    if (part) parts.push(part);
  }
  const author = m.author === 'owner' || m.author === 'member' || m.author === 'assistant'
    ? m.author
    : m.role === 'user' ? 'member' : 'assistant';
  return { k: m.k, c: m.c, role: m.role, author, at: asString(m.at), parts };
}

/** Narrow a v2 messages response; null when the shape is not recognisable. */
export function parseLivePage(value: unknown): LivePage | null {
  const data = value as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data.v !== 2 || !Array.isArray(data.messages)) return null;
  const messages: LiveMessage[] = [];
  for (const raw of data.messages) {
    const message = parseLiveMessage(raw);
    if (!message) return null;
    messages.push(message);
  }
  const retry = typeof data.retryAfterMs === 'number' && data.retryAfterMs > 0 ? data.retryAfterMs : DEFAULT_RETRY_MS;
  return {
    revision: typeof data.revision === 'string' ? data.revision : '',
    running: data.running === true,
    stale: data.stale === true,
    moreBefore: data.moreBefore === true,
    moreAfter: data.moreAfter === true,
    retryAfterMs: Math.min(retry, 60_000),
    messages,
  };
}

/** Narrow the meta response; an unknown shape is treated as unavailable (null). */
export function parseMeta(value: unknown): MetaResponse | null {
  const data = value as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data.v !== 2) return null;
  if (data.mode === 'snapshot') return { mode: 'snapshot' };
  if (data.mode !== 'live') return null;
  return {
    mode: 'live',
    meta: {
      title: typeof data.title === 'string' ? data.title : '',
      providerLabel: asString(data.providerLabel),
      expiresAt: asString(data.expiresAt),
    },
  };
}
