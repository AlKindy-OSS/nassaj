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
  toolCount: number;
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

function parseToolCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
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
    toolCount: parseToolCount(data.toolCount),
    expiresAt: asString(data.expiresAt),
    messages,
  };
}
