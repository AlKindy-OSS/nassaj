/**
 * T-1910: the request descriptor accepted by the in-process read helper, and its validator.
 * Pure (no I/O, no process identity), so it is safe to export through the module barrel.
 */

/** Reviewed origins of provider quota endpoints read in-process (codex, glm, kimi). */
export const IN_PROCESS_READ_ORIGINS: readonly string[] = Object.freeze([
  'https://chatgpt.com',
  'https://api.z.ai',
  'https://api.kimi.com',
]);

/** Must stay below the gateway lease TTL (30 s) so a live read never outlives its lease. */
export const IN_PROCESS_READ_MAX_DEADLINE_MS = 15_000;
const MAX_HEADERS = 16;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'cookie']);

export type InProcessReadDescriptor = Readonly<{
  url: string;
  method: 'GET';
  headers: Readonly<Record<string, string>>;
  deadlineMs: number;
}>;

export type InProcessReadResult =
  | Readonly<{ kind: 'response'; status: number; body: string }>
  | Readonly<{ kind: 'failed'; reason: 'timeout' | 'network' | 'redirect' | 'too_large' }>;

/** A descriptor the in-process read helper will not send. Thrown before any admission is created. */
export class InProcessReadRefusedError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'InProcessReadRefusedError';
  }
}

const refuse = (code: string): never => {
  throw new InProcessReadRefusedError(code);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validateHeaders = (value: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(value)) return refuse('IN_PROCESS_READ_HEADERS_INVALID');
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) refuse('IN_PROCESS_READ_HEADERS_INVALID');
  const headers: Record<string, string> = {};
  for (const [name, header] of entries) {
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())
      || typeof header !== 'string' || header.length > 8_192 || /[\r\n\0]/u.test(header)) {
      refuse('IN_PROCESS_READ_HEADERS_INVALID');
    }
    headers[name] = header as string;
  }
  return Object.freeze(headers);
};

const validateUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 2_048) return refuse('IN_PROCESS_READ_URL_INVALID');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return refuse('IN_PROCESS_READ_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || !IN_PROCESS_READ_ORIGINS.includes(parsed.origin)) {
    refuse('IN_PROCESS_READ_ORIGIN_REFUSED');
  }
  return parsed.href;
};

/** Validates an untrusted descriptor; unknown keys, other methods and other origins refuse. */
export const validateInProcessReadDescriptor = (value: unknown): InProcessReadDescriptor => {
  if (!isRecord(value)) return refuse('IN_PROCESS_READ_DESCRIPTOR_INVALID');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'deadlineMs,headers,method,url') refuse('IN_PROCESS_READ_DESCRIPTOR_INVALID');
  if (value.method !== 'GET') refuse('IN_PROCESS_READ_METHOD_REFUSED');
  const deadlineMs = value.deadlineMs;
  if (typeof deadlineMs !== 'number' || !Number.isSafeInteger(deadlineMs)
    || deadlineMs <= 0 || deadlineMs > IN_PROCESS_READ_MAX_DEADLINE_MS) {
    refuse('IN_PROCESS_READ_DEADLINE_INVALID');
  }
  return Object.freeze({
    url: validateUrl(value.url),
    method: 'GET',
    headers: validateHeaders(value.headers),
    deadlineMs: deadlineMs as number,
  });
};
