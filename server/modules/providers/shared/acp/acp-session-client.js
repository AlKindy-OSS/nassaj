/**
 * Generic ACP session client (T-2094) over one agent process's stdio.
 *
 * Agent-neutral: initialize / authenticate / session new-resume-load /
 * prompt / cancel / set_model / close, an injectable permission policy and a
 * normalizer from `session/update` payloads to neutral events
 * (`text` | `thought` | `tool` | `plan` | `other`).
 *
 * Replay safety (qa-critic condition 1-b): from the moment a resume/load of a
 * session starts until its next `session/prompt` is sent, EVERY
 * `session/update` of that session is dropped. Whether an agent replays
 * history on resume therefore never reaches the user. Notifications arrive in
 * order on one stream and the prompt is written only after the resume/load
 * answer, so the replay always lands inside the suppressed window.
 */

import { AcpRpcError, createAcpConnection } from './acp-connection.js';

export const ACP_PROTOCOL_VERSION = 1;
const AUTH_REQUIRED_CODE = -32000;
const SETUP_TIMEOUT_MS = 60_000;
const AUTH_TIMEOUT_MS = 30_000;

/** True for the agent's "Authentication required" answer. */
export function isAcpAuthRequired(error) {
  return error instanceof AcpRpcError
    && error.code === AUTH_REQUIRED_CODE
    && /auth/i.test(String(error.message));
}

/** Maps one `session/update` payload to a neutral event. */
export function normalizeSessionUpdate(update) {
  const kind = update && typeof update === 'object' ? update.sessionUpdate : null;
  const text = update?.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text : '';
  switch (kind) {
    case 'agent_message_chunk':
      return { type: 'text', text };
    case 'agent_thought_chunk':
      return { type: 'thought', text };
    case 'tool_call':
    case 'tool_call_update':
      return { type: 'tool', toolCallId: update.toolCallId ?? null, status: update.status ?? null, title: update.title ?? null };
    case 'plan':
      return { type: 'plan', entries: Array.isArray(update.entries) ? update.entries.length : 0 };
    default:
      return { type: 'other', kind: typeof kind === 'string' ? kind : null };
  }
}

const CANCELLED = Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) });

/**
 * Owner decision (T-2094): full control, no approval prompts. A permission
 * request is answered with its `allow_always` option, else `allow_once`, else
 * cancelled. Questions to the user (`isQuestion`) are NOT permissions and go to
 * `onQuestion` instead (default: cancelled).
 */
export function createAutoAllowPermissionPolicy({ isQuestion = () => false, onQuestion = () => CANCELLED } = {}) {
  return (params) => {
    if (isQuestion(params?.toolCall)) return onQuestion(params);
    const options = Array.isArray(params?.options) ? params.options : [];
    const pick = options.find((o) => o?.kind === 'allow_always') || options.find((o) => o?.kind === 'allow_once');
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : CANCELLED;
  };
}

/**
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
 *   permissionPolicy?: (params: any) => any, onFatal?: (error: Error) => void,
 *   maxLineBytes?: number, logger?: Pick<Console, 'warn'> }} spec
 */
export function createAcpSessionClient(spec) {
  const logger = spec.logger ?? console;
  const policy = spec.permissionPolicy ?? createAutoAllowPermissionPolicy();
  const suppressed = new Set();
  const listeners = new Map();

  const onNotification = (method, params) => {
    if (method !== 'session/update') return;
    const sessionId = params?.sessionId;
    if (suppressed.has(sessionId)) return;
    const listener = listeners.get(sessionId);
    if (!listener) return;
    try {
      listener(normalizeSessionUpdate(params.update));
    } catch (error) {
      logger.warn(JSON.stringify({ event: 'acp_listener_failed', error: String(error?.message || error) }));
    }
  };

  const onRequest = (method, params) => {
    if (method === 'session/request_permission') return policy(params);
    // fs/* and terminal/* are declared unsupported in initialize.
    return undefined;
  };

  const connection = createAcpConnection({
    input: spec.input,
    output: spec.output,
    onRequest,
    onNotification,
    onFatal: spec.onFatal,
    maxLineBytes: spec.maxLineBytes,
    logger,
  });

  return createClientApi({ connection, suppressed, listeners });
}

/** initialize: protocol 1 only; fs and terminal declared unsupported. */
async function initializeAcp(request) {
  const result = await request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  if (result?.protocolVersion !== ACP_PROTOCOL_VERSION) {
    const error = new Error(`ACP protocol ${result?.protocolVersion} is not supported`);
    error.code = 'acp_protocol_unsupported';
    throw error;
  }
  return result;
}

/** Opens a stored session: session/resume, else session/load; both suppressed until the prompt. */
async function openExistingAcpSession(request, suppressed, { sessionId, cwd }) {
  suppressed.add(sessionId);
  const params = { sessionId, cwd, mcpServers: [] };
  try {
    return { method: 'session/resume', result: await request('session/resume', params) };
  } catch (error) {
    if (isAcpAuthRequired(error)) throw error;
    return { method: 'session/load', result: await request('session/load', params) };
  }
}

/** Runs one turn; resolves with the stopReason. Ends the suppression window first. */
async function promptAcp({ request, suppressed, listeners }, { sessionId, text, onEvent }) {
  listeners.set(sessionId, onEvent);
  suppressed.delete(sessionId);
  try {
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 0);
    return typeof result?.stopReason === 'string' ? result.stopReason : 'unknown';
  } finally {
    listeners.delete(sessionId);
  }
}

/** Calls `run`; on "Authentication required" authenticates once and retries once. */
async function withAcpAuth(request, run, resolveMethodId) {
  try {
    return await run();
  } catch (error) {
    const methodId = isAcpAuthRequired(error) ? resolveMethodId() : null;
    if (!methodId) throw error;
    await request('authenticate', { methodId }, AUTH_TIMEOUT_MS);
    return run();
  }
}

/** The method surface of the client. */
function createClientApi({ connection, suppressed, listeners }) {
  const request = (method, params, timeoutMs = SETUP_TIMEOUT_MS) => connection.request(method, params, { timeoutMs });
  return {
    initialize: () => initializeAcp(request),
    withAuth: (run, resolveMethodId) => withAcpAuth(request, run, resolveMethodId),
    openExistingSession: (spec) => openExistingAcpSession(request, suppressed, spec),
    prompt: (spec) => promptAcp({ request, suppressed, listeners }, spec),
    newSession: ({ cwd }) => request('session/new', { cwd, mcpServers: [] }),
    setModel: (sessionId, modelId) => request('session/set_model', { sessionId, modelId }),
    cancel: (sessionId) => connection.notify('session/cancel', { sessionId }),
    dispose: (reason) => connection.close(reason),
    get closed() {
      return connection.closed;
    },
  };
}
