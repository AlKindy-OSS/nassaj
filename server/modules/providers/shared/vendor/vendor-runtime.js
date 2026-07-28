/**
 * vendor-runtime — shared run seam for hosted vendor providers (kimi/deepseek/glm).
 *
 * This is the execution path for the three hosted models. It is DELIBERATELY and
 * COMPLETELY independent of the Claude path:
 *   - It uses the platform `fetch` directly. It does NOT import @anthropic-ai/*
 *     and does NOT route through claude-sdk.js. (Enforced by a static test.)
 *   - It talks to a base URL hard-coded in vendor-config.ts, never a value read
 *     from ANTHROPIC_BASE_URL.
 *   - It authenticates with the provider-specific key resolved through
 *     resolveProviderEnv (per-user, from the encrypted secrets store) — never
 *     ANTHROPIC_AUTH_TOKEN and never the raw shared process.env (unlike
 *     cursor-cli.js:166, which leaks {...process.env}).
 *
 * The wire format is Anthropic Messages streaming (these gateways expose an
 * `/anthropic` base). We POST `{model, messages, stream:true}` and parse the SSE
 * `data:` events, handing each parsed event to the provider's sessions facet for
 * normalization. Every normalized event is sent to the websocket writer AND
 * appended to the nassaj-owned JSONL transcript so history survives the remote
 * session having no local store of its own.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { resolveProviderEnv } from '../../../../services/isolation/resolve-provider-env.js';
import { sessionsService } from '../../services/sessions.service.js';
import { providerModelsService } from '../../services/provider-models.service.js';
import { createNormalizedMessage, normalizeSessionName } from '../../../../shared/utils.js';

import { VENDOR_RUNTIME } from './vendor-config.js';
import { vendorTranscriptPath } from './vendor-transcript.js';

/** Default response cap; vendors accept large values, this is a safety bound. */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Per-provider registry of in-flight requests so abort/active-session lookups
 * work exactly like the CLI providers. Keyed by provider id → Map<sessionId, ctrl>.
 * @type {Record<string, Map<string, AbortController>>}
 */
const activeByProvider = {
  kimi: new Map(),
  deepseek: new Map(),
  glm: new Map(),
};

/** Clamps a temperature into the [0,1] window some vendors (Kimi) require. */
function clampTemperature(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Appends one raw event object as a JSONL line to the session transcript,
 * creating the directory on first write. Never throws into the stream path.
 */
async function appendTranscript(provider, sessionId, projectPath, event) {
  try {
    const filePath = vendorTranscriptPath(provider, sessionId, projectPath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`);
  } catch {
    // Transcript persistence is best-effort; a write failure must not break the
    // live stream the user is watching.
  }
}

/** Writes the transcript header (project path + title) for a fresh session. */
async function writeTranscriptMeta(provider, sessionId, projectPath, command) {
  const sessionName = normalizeSessionName(
    (command || '').split('\n')[0],
    `Untitled ${provider} Session`,
  );
  await appendTranscript(provider, sessionId, projectPath, {
    type: 'meta',
    projectPath: projectPath || process.cwd(),
    sessionName,
  });
}

/**
 * Parses an SSE buffer into discrete `data:` JSON events. Returns the parsed
 * events and the unparsed tail to carry into the next chunk.
 */
function drainSseEvents(buffer) {
  const events = [];
  const segments = buffer.split('\n');
  const tail = segments.pop() ?? '';
  for (const line of segments) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Partial/non-JSON keepalive lines are ignored.
    }
  }
  return { events, tail };
}

/**
 * Builds the spawn function for one hosted vendor provider. The returned function
 * matches the CLI providers' signature: spawn<Provider>(command, options, ws).
 *
 * @param {'kimi'|'deepseek'|'glm'} provider
 */
function createVendorSpawn(provider) {
  const config = VENDOR_RUNTIME[provider];
  const active = activeByProvider[provider];

  return async function spawnVendor(command, options = {}, ws) {
    const { sessionId, projectPath, cwd, model, temperature } = options || {};
    const workspacePath = cwd || projectPath || process.cwd();
    const isResume = Boolean(sessionId);
    const effectiveSessionId = sessionId || `${provider}_${crypto.randomUUID()}`;

    // Per-user isolated env: this is the ONLY place the API key comes from. No raw
    // process.env spread, no ANTHROPIC_* var.
    const env = resolveProviderEnv(ws?.userId ?? null, provider, process.env);
    const apiKey = env[config.keyEnv];

    const send = (fields) => {
      if (ws && typeof ws.send === 'function') {
        ws.send(createNormalizedMessage({ ...fields, provider, sessionId: effectiveSessionId }));
      }
    };

    if (!apiKey) {
      send({
        kind: 'error',
        content: `No ${provider} API key configured. Add one in provider settings to use ${provider}.`,
      });
      send({ kind: 'complete', exitCode: 1 });
      return;
    }

    const resolvedModel = await providerModelsService
      .resolveResumeModel(provider, sessionId, model)
      .catch(() => model || config.fallbackModels.DEFAULT);
    const chosenModel = resolvedModel || config.fallbackModels.DEFAULT;

    if (!isResume) {
      if (ws && typeof ws.setSessionId === 'function') {
        ws.setSessionId(effectiveSessionId);
      }
      send({ kind: 'session_created', newSessionId: effectiveSessionId });
      await writeTranscriptMeta(provider, effectiveSessionId, workspacePath, command);

      // T-874(2): hosted vendors are stateless HTTP with no per-session model
      // memory, so pin this new session to its creation-time model in nassaj's
      // per-session store — a later pick in ANOTHER conversation must not change
      // which model this session resumes on. Idempotent + best-effort.
      // .catch() guards against an unhandled rejection escaping this
      // fire-and-forget seed and crashing the spawn (B-136 regression).
      void providerModelsService
        .seedSessionModel(provider, effectiveSessionId, model)
        .catch(() => {});
    }

    // Record the user's own turn in the transcript so history shows both sides.
    if (command && command.trim()) {
      await appendTranscript(provider, effectiveSessionId, workspacePath, {
        type: 'message',
        message: { role: 'user', content: command },
      });
    }

    const controller = new AbortController();
    active.set(effectiveSessionId, controller);

    const requestBody = {
      model: chosenModel,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: command ?? '' }],
    };
    const clampedTemp = clampTemperature(temperature);
    if (clampedTemp !== undefined) {
      requestBody.temperature = clampedTemp;
    }

    try {
      const response = await fetch(config.messagesUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          // Vendor key as a transient header value only. Both header forms are
          // accepted by these Anthropic-compatible gateways. `anthropic-version`
          // selects the Messages wire format; it is a protocol header, not an
          // ANTHROPIC_* credential/base-url.
          'x-api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        await response.body?.cancel?.();
        send({
          kind: 'error',
          content: `${provider} request failed (HTTP ${response.status}).${detail ? ` ${detail.slice(0, 200)}` : ''}`,
        });
        send({ kind: 'complete', exitCode: 1 });
        return;
      }

      await streamResponse({
        provider,
        sessionId: effectiveSessionId,
        projectPath: workspacePath,
        body: response.body,
        ws,
      });

      send({ kind: 'complete', exitCode: 0, isNewSession: !isResume && Boolean(command) });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      if (!aborted) {
        send({ kind: 'error', content: error instanceof Error ? error.message : String(error) });
      }
      send({ kind: 'complete', exitCode: aborted ? 0 : 1, aborted });
    } finally {
      active.delete(effectiveSessionId);
    }
  };
}

/**
 * Consumes the SSE response body, normalizes each event through the provider's
 * sessions facet, forwards normalized messages to the writer, and appends the raw
 * event to the transcript.
 */
async function streamResponse({ provider, sessionId, projectPath, body, ws }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = async (event) => {
    await appendTranscript(provider, sessionId, projectPath, event);
    let normalized = [];
    try {
      normalized = sessionsService.normalizeMessage(provider, event, sessionId);
    } catch {
      normalized = [];
    }
    for (const message of normalized) {
      if (ws && typeof ws.send === 'function') {
        ws.send(message);
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const { events, tail } = drainSseEvents(buffer);
    buffer = tail;
    for (const event of events) {
      await handleEvent(event);
    }
  }

  // Flush any trailing buffered event.
  const { events } = drainSseEvents(`${buffer}\n`);
  for (const event of events) {
    await handleEvent(event);
  }
}

/** Aborts an in-flight request for one provider session. */
function abortVendorSession(provider, sessionId) {
  const controller = activeByProvider[provider]?.get(sessionId);
  if (!controller) {
    return false;
  }
  controller.abort();
  activeByProvider[provider].delete(sessionId);
  return true;
}

/** Whether a request is currently in flight for one provider session. */
function isVendorSessionActive(provider, sessionId) {
  return Boolean(activeByProvider[provider]?.has(sessionId));
}

/** Lists active session ids for one provider. */
function getActiveVendorSessions(provider) {
  return Array.from(activeByProvider[provider]?.keys() ?? []);
}

export {
  createVendorSpawn,
  abortVendorSession,
  isVendorSessionActive,
  getActiveVendorSessions,
};
