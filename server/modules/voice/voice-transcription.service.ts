/**
 * voice-transcription.service — ADR-103 / T-1246.
 *
 * Accurate speech-to-text as an OPTIONAL extra: the browser's own recogniser
 * stays the default and costs nothing, and this path exists only when the
 * operator has both switched it on and paid for a key. Everything here follows
 * from that one sentence:
 *
 *  • THE SWITCH IS FAIL-CLOSED. It lives in `app_config` so it can be flipped
 *    from Settings without a redeploy; the price of that is that a missing row,
 *    a garbage value or an unreadable database must all read as OFF. Only the
 *    exact string '1' opens it (same rule and same reason as
 *    services/external-api-config.js).
 *
 *  • THE KEY IS MONEY, SO IT HAS TWO SCOPES. `system` is the operator's own key,
 *    spent by every member; `user` is a member's key, spent by that member only
 *    and invisible to everyone else. Resolution is user-first, so a member who
 *    pastes their own key stops drawing on the operator's budget the moment they
 *    do. Both live in the SAME encrypted store as every other secret
 *    (AES-256-GCM, 0600, inside the member's isolated tree) under a new
 *    namespace — see SECRET_NAMESPACES in provider-secrets-store.js.
 *
 *  • THE AUDIO IS NEVER PERSISTED. It arrives in memory, goes out on one HTTPS
 *    request, and is dropped. Nothing in this module writes it, and nothing logs
 *    the transcript.
 *
 *  • THE ENDPOINT IS CONFIGURABLE BUT NOT ARBITRARY. `base_url` exists so a
 *    cheaper OpenAI-compatible endpoint (Groq, a local whisper.cpp server) can
 *    be used, which means an owner-supplied string decides where a paid key is
 *    sent. It is therefore parsed, not concatenated: https only (http allowed
 *    for loopback alone), no credentials, no query, no fragment, and a path that
 *    matches a conservative shape or is refused outright.
 */

import { appConfigDb } from '@/modules/database/index.js';
import {
  deleteNamespacedSecret,
  getNamespacedSecret,
  hasNamespacedSecret,
  setNamespacedSecret,
  SYSTEM_SECRET_SCOPE,
} from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';

export const VOICE_ENABLED_KEY = 'voice_transcription.enabled';
export const VOICE_BASE_URL_KEY = 'voice_transcription.base_url';
export const VOICE_MODEL_KEY = 'voice_transcription.model';
export const VOICE_MAX_MB_KEY = 'voice_transcription.max_mb';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'whisper-1';
const DEFAULT_MAX_MB = 10;

/**
 * The ceiling the owner's setting may not exceed, mirroring chat-image-store's
 * HARD_MAX_MB. The uploaded audio is held ENTIRELY IN MEMORY (multer's
 * memoryStorage) and then copied again into the outbound multipart body, so the
 * configured megabyte is really two or three; a cap the transport cannot bypass
 * is the only real one.
 */
export const HARD_MAX_MB = 25;

/** The single id under the 'speech' namespace. There is nothing else to name. */
const SPEECH_SECRET_ID = 'whisper';

/**
 * One request, one deadline.
 *
 * Raised from 60s: that ceiling assumed a hosted endpoint answering in seconds,
 * and it silently truncated the CPU-only local engine, which needs roughly as
 * long as the clip itself. The client caps a recording at 120s, so a deadline
 * below that guarantees the longest allowed recording fails — the deadline must
 * clear the cap with room for decode, not sit under it.
 *
 * Still bounded, and still shorter than any proxy's idle timeout: an endpoint
 * that has said nothing for three minutes is hung, not slow.
 */
const REQUEST_TIMEOUT_MS = 180_000;

/** Hosts for which plain http is tolerated: nothing leaves the machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Accepted upload types. A whitelist, because the value is a client-supplied
 * header: it cannot prove what the bytes are, but it can refuse the shapes we
 * never intend to forward. These are what MediaRecorder actually produces across
 * the browsers this app supports, plus the two common hand-picked file types.
 */
export const ALLOWED_AUDIO_MIME_TYPES = Object.freeze([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-m4a',
]);

export type TranscriptionKeyScope = 'system' | 'user';

export type VoiceTranscriptionConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  maxMb: number;
  /** maxMb expressed in bytes — the multer limit. */
  maxBytes: number;
};

export type VoiceTranscriptionSettingsPatch = {
  enabled?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  maxMb?: unknown;
};

const bad = (message: string, code: string): AppError =>
  new AppError(message, { code, statusCode: 400 });

/**
 * True only when the owner has explicitly switched accurate transcription on.
 * Unset, malformed or unreadable ⇒ false.
 */
export function isVoiceTranscriptionEnabled(): boolean {
  return appConfigDb.get(VOICE_ENABLED_KEY) === '1';
}

/**
 * Validates and canonicalises a transcription endpoint.
 *
 * This is the one field where an owner's typo has a security cost: the key is
 * attached as a bearer token to whatever host comes out of here. So the string
 * is parsed as a URL and every part of it is checked — a "starts with https"
 * test would accept `https://evil.example@api.openai.com` (credentials), and a
 * plain concatenation would accept a `?` that swallows the `/audio/transcriptions`
 * suffix into a query string.
 */
export function normalizeTranscriptionBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw bad('A transcription endpoint is required.', 'INVALID_BASE_URL');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw bad('The transcription endpoint must be a valid absolute URL.', 'INVALID_BASE_URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw bad('The transcription endpoint must not carry credentials.', 'INVALID_BASE_URL');
  }
  if (url.search !== '' || url.hash !== '') {
    throw bad(
      'The transcription endpoint must not carry a query string or fragment.',
      'INVALID_BASE_URL',
    );
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw bad(
        'The transcription endpoint must use https (http is allowed for localhost only).',
        'INVALID_BASE_URL',
      );
    }
  } else if (url.protocol !== 'https:') {
    throw bad('The transcription endpoint must use https.', 'INVALID_BASE_URL');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '' && !/^(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(pathname)) {
    throw bad('The transcription endpoint path is not in an accepted form.', 'INVALID_BASE_URL');
  }
  return `${url.origin}${pathname}`;
}

/** Model ids are vendor-defined; accept a conservative slug and nothing else. */
export function normalizeTranscriptionModel(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw bad('A transcription model is required.', 'INVALID_MODEL');
  }
  const model = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(model)) {
    throw bad('The transcription model id is not in an accepted form.', 'INVALID_MODEL');
  }
  return model;
}

/** Whole megabytes, at least one, never above the hard ceiling. */
export function normalizeTranscriptionMaxMb(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > HARD_MAX_MB) {
    throw bad(`The upload ceiling must be a whole number of MB between 1 and ${HARD_MAX_MB}.`, 'INVALID_MAX_MB');
  }
  return value;
}

/**
 * The effective configuration, read per call rather than cached: these are
 * changed from the UI and must take effect on the next recording, not on the
 * next restart. A stored value that fails validation degrades to the default
 * instead of throwing — a bad row must not brick the surface, and the write path
 * already refuses to create one.
 */
export function readVoiceTranscriptionConfig(): VoiceTranscriptionConfig {
  let baseUrl = DEFAULT_BASE_URL;
  let model = DEFAULT_MODEL;
  let maxMb = DEFAULT_MAX_MB;
  try {
    baseUrl = normalizeTranscriptionBaseUrl(appConfigDb.get(VOICE_BASE_URL_KEY));
  } catch {
    baseUrl = DEFAULT_BASE_URL;
  }
  try {
    model = normalizeTranscriptionModel(appConfigDb.get(VOICE_MODEL_KEY));
  } catch {
    model = DEFAULT_MODEL;
  }
  try {
    maxMb = normalizeTranscriptionMaxMb(appConfigDb.get(VOICE_MAX_MB_KEY));
  } catch {
    maxMb = DEFAULT_MAX_MB;
  }
  return {
    enabled: isVoiceTranscriptionEnabled(),
    baseUrl,
    model,
    maxMb,
    maxBytes: maxMb * 1024 * 1024,
  };
}

/**
 * Applies an owner's settings patch. Every field is validated BEFORE anything is
 * written, so a request that carries one bad value leaves the stored config
 * untouched rather than half-applied.
 */
export function updateVoiceTranscriptionSettings(
  patch: VoiceTranscriptionSettingsPatch,
): VoiceTranscriptionConfig {
  const writes: Array<[string, string]> = [];

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw bad('`enabled` must be a boolean.', 'INVALID_ENABLED');
    }
    writes.push([VOICE_ENABLED_KEY, patch.enabled ? '1' : '0']);
  }
  if (patch.baseUrl !== undefined) {
    writes.push([VOICE_BASE_URL_KEY, normalizeTranscriptionBaseUrl(patch.baseUrl)]);
  }
  if (patch.model !== undefined) {
    writes.push([VOICE_MODEL_KEY, normalizeTranscriptionModel(patch.model)]);
  }
  if (patch.maxMb !== undefined) {
    writes.push([VOICE_MAX_MB_KEY, String(normalizeTranscriptionMaxMb(patch.maxMb))]);
  }

  for (const [key, value] of writes) {
    appConfigDb.set(key, value);
  }
  return readVoiceTranscriptionConfig();
}

/**
 * Turns a (scope, caller) pair into a store scope. `user` REQUIRES a caller id:
 * an implicit scope is what silently wrote a member's secret into the shared
 * store in B-342, and provider-secrets-store now throws on it by design.
 */
function storeScopeFor(scope: TranscriptionKeyScope, userId: number | null): string {
  if (scope === 'system') {
    return SYSTEM_SECRET_SCOPE;
  }
  if (userId === null || userId === undefined) {
    throw new AppError('Authentication required.', { code: 'AUTH_REQUIRED', statusCode: 401 });
  }
  return String(userId);
}

/** Which keys exist, as booleans. Never returns, and cannot return, a key. */
export function transcriptionKeyPresence(userId: number | null): {
  system: boolean;
  user: boolean;
} {
  let system = false;
  let user = false;
  try {
    system = hasNamespacedSecret(SYSTEM_SECRET_SCOPE, 'speech', SPEECH_SECRET_ID);
  } catch {
    system = false;
  }
  if (userId !== null && userId !== undefined) {
    try {
      user = hasNamespacedSecret(String(userId), 'speech', SPEECH_SECRET_ID);
    } catch {
      user = false;
    }
  }
  return { system, user };
}

/**
 * Stores a key. The plaintext is validated for SHAPE only (non-empty, no
 * whitespace or control characters, bounded length) — never echoed, never
 * logged, never returned.
 */
export function setTranscriptionKey(
  scope: TranscriptionKeyScope,
  userId: number | null,
  apiKey: unknown,
): void {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw bad('An API key is required.', 'INVALID_KEY');
  }
  const key = apiKey.trim();
  // Whitespace or a control character in a bearer credential is either a paste
  // accident or an attempt at header injection — both are refused.
  if (key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)) {
    throw bad('The API key is not in an accepted form.', 'INVALID_KEY');
  }
  setNamespacedSecret(storeScopeFor(scope, userId), 'speech', SPEECH_SECRET_ID, key);
}

/** Removes a key. Idempotent; reports whether a record was actually removed. */
export function deleteTranscriptionKey(
  scope: TranscriptionKeyScope,
  userId: number | null,
): boolean {
  return deleteNamespacedSecret(storeScopeFor(scope, userId), 'speech', SPEECH_SECRET_ID).removed;
}

/**
 * The resolution order, in one place: the member's own key first, the operator's
 * second, nothing third. Order is the cost model — a member who pastes a key
 * spends their own money from that moment on.
 */
function resolveTranscriptionKey(
  userId: number | null,
): { key: string; scope: TranscriptionKeyScope } | null {
  if (userId !== null && userId !== undefined) {
    try {
      const own = getNamespacedSecret(String(userId), 'speech', SPEECH_SECRET_ID);
      if (own) {
        return { key: own, scope: 'user' };
      }
    } catch {
      // An unreadable member store must fall through to the operator key, not
      // fail the request.
    }
  }
  try {
    const shared = getNamespacedSecret(SYSTEM_SECRET_SCOPE, 'speech', SPEECH_SECRET_ID);
    if (shared) {
      return { key: shared, scope: 'system' };
    }
  } catch {
    // Same reasoning: treat an unreadable store as "no key".
  }
  return null;
}

/** True when a usable key exists for this caller (either scope). */
export function hasUsableTranscriptionKey(userId: number | null): boolean {
  const presence = transcriptionKeyPresence(userId);
  return presence.user || presence.system;
}

/**
 * Strips anything key-shaped out of a provider error body before it reaches a
 * log. Providers do echo a partially-masked key back on a 401 ("Incorrect API
 * key provided: sk-abc…"), and a partially-masked key is still key material.
 */
function redactProviderBody(body: string, key: string): string {
  return body
    .split(key)
    .join('[redacted]')
    .replace(/\b(?:sk|gsk|api)[-_][A-Za-z0-9._-]{4,}/gi, '[redacted]')
    .slice(0, 200);
}

export type TranscribeInput = {
  userId: number | null;
  audio: Buffer;
  mimeType: string;
  filename?: string;
  /** Explicit language hint. ABSENT means auto-detect, which is the default. */
  language?: string;
};

export type TranscribeResult = {
  text: string;
  language?: string;
  /** Which key paid for this call. For the audit row — never sent to a client. */
  keyScope: TranscriptionKeyScope;
};

/**
 * Forwards one in-memory recording to the configured OpenAI-compatible endpoint.
 *
 * `fetchImpl` is injectable so the tests exercise this function without a
 * network; production passes nothing and gets the global fetch.
 */
export async function transcribeAudio(
  input: TranscribeInput,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<TranscribeResult> {
  if (!(input.audio instanceof Buffer) || input.audio.length === 0) {
    throw bad('The recording is empty.', 'EMPTY_AUDIO');
  }
  if (!ALLOWED_AUDIO_MIME_TYPES.includes(input.mimeType)) {
    throw new AppError('That audio type is not supported.', {
      code: 'UNSUPPORTED_AUDIO_TYPE',
      statusCode: 415,
    });
  }

  const config = readVoiceTranscriptionConfig();
  const resolved = resolveTranscriptionKey(input.userId);
  if (!resolved) {
    // 409, not 403: the caller is permitted, the install is simply not finished.
    // The client uses this code to point the member at the settings page.
    throw new AppError('No transcription key is configured.', {
      code: 'NO_TRANSCRIPTION_KEY',
      statusCode: 409,
    });
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
    input.filename ?? 'recording',
  );
  form.append('model', config.model);
  // Sent ONLY when the caller asked for it: whisper auto-detects, and pinning a
  // wrong language silently mistranscribes rather than failing.
  if (input.language) {
    form.append('language', input.language);
  }

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resolved.key}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AppError('The transcription service took too long to answer.', {
        code: 'TRANSCRIPTION_TIMEOUT',
        statusCode: 504,
      });
    }
    console.error('[voice] transcription request failed', { name });
    throw new AppError('The transcription service could not be reached.', {
      code: 'TRANSCRIPTION_UNREACHABLE',
      statusCode: 502,
    });
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    console.error('[voice] transcription provider refused', {
      status: response.status,
      body: redactProviderBody(raw, resolved.key),
    });
    // NOTE: never 401/403 to the client. The browser treats a 401 as "your
    // session died" and logs the user out (B-88); a rejected THIRD-PARTY key is
    // an upstream failure, not an authentication failure of this app.
    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        resolved.scope === 'user'
          ? 'Your transcription key was rejected by the provider.'
          : 'The installation transcription key was rejected by the provider.',
        { code: 'INVALID_TRANSCRIPTION_KEY', statusCode: 502 },
      );
    }
    if (response.status === 429) {
      throw new AppError('The transcription service is rate-limiting this key.', {
        code: 'TRANSCRIPTION_RATE_LIMITED',
        statusCode: 429,
      });
    }
    if (response.status === 413) {
      throw new AppError('The transcription service refused the recording as too large.', {
        code: 'AUDIO_TOO_LARGE',
        statusCode: 413,
      });
    }
    throw new AppError('The transcription service returned an error.', {
      code: 'TRANSCRIPTION_FAILED',
      statusCode: 502,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError('The transcription service returned an unreadable answer.', {
      code: 'TRANSCRIPTION_FAILED',
      statusCode: 502,
    });
  }
  const body = (payload ?? {}) as { text?: unknown; language?: unknown };
  if (typeof body.text !== 'string') {
    throw new AppError('The transcription service returned no text.', {
      code: 'TRANSCRIPTION_FAILED',
      statusCode: 502,
    });
  }
  return {
    text: body.text,
    language: typeof body.language === 'string' ? body.language : undefined,
    keyScope: resolved.scope,
  };
}

/**
 * Express gate for the surfaces that only make sense when the feature is on.
 *
 * 404, not 403: a switched-off surface should be indistinguishable from a route
 * that was never mounted (same rule as requireExternalApiEnabled). It is
 * deliberately NOT applied to GET /transcription/settings — the client needs to
 * learn WHY the microphone offers no accurate mode — and deliberately NOT
 * applied to PUT /transcription/settings, which is the only way to turn the
 * switch back on and would otherwise lock the owner out of their own feature.
 */
export function requireVoiceTranscriptionEnabled(
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  next: () => void,
): void {
  if (!isVoiceTranscriptionEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}
