/**
 * Shared pinned HTTP engine (ADR-194 D7, T-1962 S2). Used by `pinnedFetchJson`
 * and by the connector safe fetch; each front end supplies its own address
 * classifier, per-hop checks and error codes.
 *
 * Guarantees: every A/AAAA answer must pass the classifier and match its
 * family; the connection goes to the validated address with Host and SNI set
 * to the original hostname (TLS verified against it); proxy environment
 * variables are ignored (`agent: false`); a changed DNS answer between hops
 * is refused; redirects are bounded and every hop is re-validated; the
 * authorization header never crosses origins; bodies are size- and
 * deadline-bounded; transport details never reach the caller.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export type PinnedMethod = 'GET' | 'POST';

export type PinnedResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Immediately aborts the underlying response stream without draining it. */
  cancel?: () => void;
}>;

export type PinnedTransport = (input: Readonly<{
  url: URL;
  address: string;
  family: 4 | 6;
  method: PinnedMethod;
  headers: Readonly<Record<string, string>>;
  body: Buffer | null;
  timeoutMs: number;
  signal: AbortSignal;
}>) => Promise<PinnedResponse>;

export type PinnedResolver = (hostname: string) => Promise<readonly Readonly<{
  address: string;
  family: 4 | 6;
}>[]>;

/** Engine-level failure reasons; each front end maps them to its own codes. */
export type PinnedFailure =
  | 'dns_failed' | 'dns_empty' | 'address_blocked' | 'dns_rebinding' | 'tls_failed'
  | 'transport_failed' | 'timeout' | 'redirect_limit' | 'redirect_invalid' | 'redirect_method'
  | 'http_status' | 'too_large' | 'content_type' | 'json_invalid' | 'body_failed';

/** `fail` builds the front end's error; `owns` recognizes it so it passes through unchanged. */
export type PinnedErrorKit = Readonly<{
  fail: (failure: PinnedFailure, detail?: string) => Error;
  owns: (error: unknown) => boolean;
}>;

export const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/iu;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TLS_ERROR_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/u;

export const defaultResolver: PinnedResolver = async hostname =>
  (await lookup(hostname, { all: true, verbatim: true })).map(answer => {
    if (answer.family !== 4 && answer.family !== 6) throw new Error('dns_family_unknown');
    return { address: answer.address, family: answer.family };
  });

const transportErrorCode = (error: unknown): PinnedFailure => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TLS_ERROR_CODE.test(code) ? 'tls_failed' : 'transport_failed';
};

/**
 * TLS SNI for a request hostname (S9 L2): the bare DNS name, or undefined for
 * an IP literal (RFC 6066 forbids an IP address as server_name; certificate
 * checks still run against the original host).
 */
export const sniServername = (hostname: string): string | undefined => {
  const host = hostname.replace(/^\[|\]$/gu, '');
  return isIP(host) === 0 ? host : undefined;
};

/** Node http(s) transport connecting to the pinned address; never uses a proxy agent. */
export const createDefaultTransport = (errors: PinnedErrorKit): PinnedTransport => input =>
  new Promise((resolve, reject) => {
    const request = (input.url.protocol === 'http:' ? httpRequest : httpsRequest)(input.url, {
      method: input.method,
      headers: input.headers,
      ...(sniServername(input.url.hostname) === undefined ? {} : { servername: sniServername(input.url.hostname) }),
      signal: input.signal,
      agent: false,
      lookup: (_hostname, options, callback) => (options as { all?: boolean } | undefined)?.all
        ? (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
          null, [{ address: input.address, family: input.family }])
        : callback(null, input.address, input.family),
    }, response => {
      const headers: Record<string, string | readonly string[] | undefined> = {};
      for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value;
      resolve({ status: response.statusCode ?? 0, headers, body: response, cancel: () => response.destroy() });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(errors.fail('timeout')));
    request.once('error', error => reject(errors.owns(error) ? error : errors.fail(transportErrorCode(error))));
    if (input.body) request.write(input.body);
    request.end();
  });

export const firstHeader = (headers: PinnedResponse['headers'], name: string): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : value?.[0];
};

/** Reads a bounded JSON object body; buffers are zeroed afterwards. */
export const readJsonBody = async (
  response: PinnedResponse,
  maxBytes: number,
  errors: PinnedErrorKit,
  accept: RegExp = JSON_CONTENT_TYPE,
): Promise<Record<string, unknown>> => {
  const contentType = firstHeader(response.headers, 'content-type');
  if (!contentType || !accept.test(contentType)) throw errors.fail('content_type');
  const chunks: Buffer[] = [];
  let total = 0;
  let joined: Buffer | null = null;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw errors.fail('too_large');
      chunks.push(buffer);
    }
    joined = Buffer.concat(chunks, total);
    return parseJsonObject(joined, errors);
  } catch (error) {
    if (errors.owns(error)) throw error;
    throw errors.fail('body_failed');
  } finally {
    joined?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
};

function parseJsonObject(buffer: Buffer, errors: PinnedErrorKit): Record<string, unknown> {
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed as Record<string, unknown>;
  } catch {
    throw errors.fail('json_invalid');
  }
}

/** Drains (and discards) a bounded body; for endpoints that may answer with no JSON. */
export const discardBoundedBody = async (
  response: PinnedResponse,
  maxBytes: number,
  errors: PinnedErrorKit,
): Promise<Record<string, unknown>> => {
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw errors.fail('too_large');
    }
  } catch (error) {
    if (errors.owns(error)) throw error;
    throw errors.fail('body_failed');
  }
  return {};
};

export const cancelResponse = (response: PinnedResponse): void => {
  try {
    response.cancel?.();
  } catch {
    // Transport cleanup must never leak provider/socket details to callers.
  }
};

export const closeResponseBody = (response: PinnedResponse): void => {
  cancelResponse(response);
  try {
    const pendingReturn = response.body[Symbol.asyncIterator]().return?.();
    if (pendingReturn) void pendingReturn.catch(() => undefined);
  } catch {
    // A broken iterator cannot delay or replace the redacted fetch error.
  }
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  errors: PinnedErrorKit,
  onTimeout?: () => void,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch { /* cleanup is best-effort */ }
          reject(errors.fail('timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Resolves `hostname` and requires every answer to pass `classify` and match
 * its declared family; a fingerprint change against an earlier hop is refused.
 */
export async function resolvePinnedAddress(
  hostname: string,
  resolver: PinnedResolver,
  classify: (address: string) => string | null,
  priorAnswers: Map<string, string>,
  errors: PinnedErrorKit,
): Promise<Readonly<{ address: string; family: 4 | 6 }>> {
  let answers: Awaited<ReturnType<PinnedResolver>>;
  try {
    answers = await resolver(hostname);
  } catch {
    throw errors.fail('dns_failed');
  }
  if (answers.length === 0) throw errors.fail('dns_empty');
  for (const answer of answers) {
    const category = classify(answer.address);
    if (category !== null) throw errors.fail('address_blocked', category);
  }
  if (answers.some(answer => isIP(answer.address) !== answer.family)) {
    throw errors.fail('address_blocked', 'family_mismatch');
  }
  const fingerprint = [...new Set(answers.map(answer => `${answer.family}:${answer.address.toLowerCase()}`))]
    .sort().join(',');
  const prior = priorAnswers.get(hostname);
  if (prior !== undefined && prior !== fingerprint) throw errors.fail('dns_rebinding');
  priorAnswers.set(hostname, fingerprint);
  return answers[0];
}

export type PinnedRequestOptions = Readonly<{
  url: URL;
  method: PinnedMethod;
  headers: Readonly<Record<string, string>>;
  body: Buffer | null;
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  /** `json`: 2xx must be a JSON object. `discard`: 2xx body is drained and ignored. */
  responseMode: 'json' | 'discard';
  /** When true a non-2xx JSON object is returned (json null when unreadable) instead of failing. */
  readErrorBody: boolean;
  acceptJson: RegExp;
  classifyAddress: (address: string) => string | null;
  /** Runs before every hop's DNS lookup; throws the front end's error to refuse. */
  checkHop: (url: URL, method: PinnedMethod) => void;
  /** Runs on every parsed redirect target before it becomes the next hop. */
  checkRedirect: (next: URL, current: URL) => void;
  resolver: PinnedResolver;
  transport: PinnedTransport;
  errors: PinnedErrorKit;
}>;

export type PinnedResult = Readonly<{ status: number; json: Record<string, unknown> | null }>;

type HopState = { url: URL; headers: Readonly<Record<string, string>>; deadline: number; prior: Map<string, string> };

async function sendHop(options: PinnedRequestOptions, state: HopState) {
  const remaining = state.deadline - Date.now();
  if (remaining <= 0) throw options.errors.fail('timeout');
  const hostname = state.url.hostname.replace(/^\[|\]$/gu, '');
  const address = await withTimeout(
    resolvePinnedAddress(hostname, options.resolver, options.classifyAddress, state.prior, options.errors),
    remaining, options.errors);
  const abort = new AbortController();
  try {
    const response = await withTimeout(options.transport({
      url: state.url, address: address.address, family: address.family, method: options.method,
      headers: state.headers, body: options.body, timeoutMs: remaining, signal: abort.signal,
    }), remaining, options.errors, () => abort.abort());
    return { response, abort };
  } catch (error) {
    if (options.errors.owns(error)) throw error;
    throw options.errors.fail('transport_failed');
  }
}

function readBody(options: PinnedRequestOptions, response: PinnedResponse, success: boolean) {
  if (!success) {
    return readJsonBody(response, options.maxBytes, options.errors, options.acceptJson).catch(() => null);
  }
  return options.responseMode === 'discard'
    ? discardBoundedBody(response, options.maxBytes, options.errors)
    : readJsonBody(response, options.maxBytes, options.errors, options.acceptJson);
}

async function finishResponse(
  options: PinnedRequestOptions,
  state: HopState,
  response: PinnedResponse,
  abort: AbortController,
): Promise<PinnedResult> {
  const success = response.status >= 200 && response.status < 300;
  if (!success && !options.readErrorBody) {
    closeResponseBody(response);
    throw options.errors.fail('http_status', String(response.status));
  }
  const bodyRemaining = state.deadline - Date.now();
  if (bodyRemaining <= 0) {
    closeResponseBody(response);
    throw options.errors.fail('timeout');
  }
  try {
    const json = await withTimeout(readBody(options, response, success), bodyRemaining, options.errors, () => {
      abort.abort();
      cancelResponse(response);
    });
    return { status: response.status, json };
  } catch (error) {
    cancelResponse(response);
    throw error;
  }
}

function nextHop(options: PinnedRequestOptions, state: HopState, response: PinnedResponse): void {
  const location = firstHeader(response.headers, 'location');
  if (!location) throw options.errors.fail('redirect_invalid');
  if (options.method === 'POST' && response.status !== 307 && response.status !== 308) {
    throw options.errors.fail('redirect_method');
  }
  let next: URL;
  try {
    next = new URL(location, state.url);
  } catch {
    throw options.errors.fail('redirect_invalid');
  }
  options.checkRedirect(next, state.url);
  if (next.origin !== state.url.origin) {
    const { authorization: _authorization, ...withoutAuthorization } = state.headers;
    state.headers = withoutAuthorization;
  }
  state.url = next;
}

/** Runs one pinned request with bounded, fully re-validated redirects. */
export async function runPinnedRequest(options: PinnedRequestOptions): Promise<PinnedResult> {
  const state: HopState = {
    url: options.url, headers: options.headers, deadline: Date.now() + options.timeoutMs, prior: new Map(),
  };
  for (let redirects = 0; ; redirects += 1) {
    options.checkHop(state.url, options.method);
    // S9 L1: a POST body (e.g. a token request carrying the client secret)
    // never follows a 307/308 to another origin. Checked after the caller's
    // hop policy so a stricter caller refusal keeps its own code.
    if (options.method === 'POST' && state.url.origin !== options.url.origin) {
      throw options.errors.fail('redirect_method');
    }
    const { response, abort } = await sendHop(options, state);
    if (!REDIRECT_STATUSES.has(response.status)) return finishResponse(options, state, response, abort);
    closeResponseBody(response);
    if (redirects >= options.maxRedirects) throw options.errors.fail('redirect_limit');
    nextHop(options, state, response);
  }
}
