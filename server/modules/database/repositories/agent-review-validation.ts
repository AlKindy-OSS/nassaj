import { createHash } from 'node:crypto';

/** An expected review rejection; transport maps conflicts without leaking stored rows. */
export class AgentReviewError extends Error {
  constructor(readonly code: string, readonly agentId: string | null = null) {
    super(code); this.name = 'AgentReviewError';
    if (agentId !== null) assertReviewToken(agentId, 'agent');
  }
}

/** Reject malformed Unicode rather than hashing replacement characters. */
export function assertReviewString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new AgentReviewError('invalid_input');
  }
}

/** Validate a session id using Unicode scalar count, not UTF-16 code units. */
export function assertReviewSession(value: unknown): asserts value is string {
  assertReviewString(value);
  if (Array.from(value).length < 1 || Array.from(value).length > 128 || value.includes('\0')) {
    throw new AgentReviewError('invalid_input');
  }
}

/** Validate one nonnegative safe JSON integer, optionally with a positive minimum. */
export function assertReviewInteger(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new AgentReviewError('invalid_input');
}

/** Validate an ASCII identifier against a fixed server-owned domain. */
export function assertReviewToken(value: unknown, domain: 'agent' | 'key' | 'sha'): asserts value is string {
  const patterns = { agent: /^[A-Za-z0-9_-]{1,128}$/, key: /^[A-Za-z0-9._:-]{1,160}$/, sha: /^[0-9a-f]{64}$/ };
  if (typeof value !== 'string' || !patterns[domain].test(value)) throw new AgentReviewError('invalid_input');
}

/** Require exactly the declared own keys on an ordinary JSON object. */
export function assertReviewKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new AgentReviewError('invalid_input');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { assertReviewString(value); return JSON.stringify(value); }
  if (typeof value === 'number') { assertReviewInteger(value, Number.MIN_SAFE_INTEGER); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => {
      assertReviewString(key);
      return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`;
    }).join(',')}}`;
  }
  throw new AgentReviewError('invalid_input');
}

/** Hash a validated bounded JSON tuple without copying payload text into stored identity. */
export function hashReviewTuple(value: Record<string, unknown>): string {
  const bytes = canonical(value);
  if (Buffer.byteLength(bytes, 'utf8') > 65_536) throw new AgentReviewError('invalid_input');
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
