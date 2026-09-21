/**
 * Minimal Codex App Server client for native thread actions that the
 * non-interactive TypeScript SDK does not expose (currently manual compaction).
 */

import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';

import { assertSessionAccessible } from '../modules/providers/services/sessions.service.js';
import { ensureCodexGovernance } from '../modules/providers/list/codex/codex-governance.js';
import { runPermissionExecutionAdapter } from '../modules/execution-permissions/adapter.js';
import { authorizeRuntimeUserProviderEffect } from '../modules/execution-permissions/runtime-user-effect.js';
import { codexLaunchOptions, readCodexExecutableIdentity } from '../shared/codex-executable.js';

import { resolveProviderEnv } from './isolation/resolve-provider-env.js';

const START_TIMEOUT_MS = 20_000;
const COMPLETION_TIMEOUT_MS = 5 * 60_000;
const MAX_ACTIVE_COMPACTIONS = 4;
const MAX_ACTIVE_COMPACTIONS_PER_USER = 2;
const activeCompactions = new Map();
const MAX_ACTIVE_RPCS = 8;
const MAX_ACTIVE_RPCS_PER_USER = 3;
const activeRpcs = new Map();

/** Gate the selected-turn fork against the native build whose schema was reviewed. No model turn runs. */
export function assertCodexMessageForkRuntimeReady() {
  const identity = readCodexExecutableIdentity();
  const version = execFileSync(identity.executablePath, ['--version'], {
    encoding: 'utf8', shell: false, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (version !== 'codex-cli 0.153.2') throw new Error('runtime_not_ready');
  return identity;
}

/** Bound bytes before readline can retain an unbounded incomplete JSON frame. */
function boundedRpcOutput() {
  let total = 0;
  let frame = 0;
  return new Transform({ transform(chunk, _encoding, done) {
    total += chunk.length;
    for (const byte of chunk) {
      frame = byte === 10 ? 0 : frame + 1;
      if (frame > 1024 * 1024 || total > 4 * 1024 * 1024) {
        done(new Error('Codex App Server response exceeded its byte limit.'));
        return;
      }
    }
    done(null, chunk);
  } });
}

const SIDE_QUERY_DIRECTIVE = [
  'This is a /btw side question about the parent conversation.',
  'Answer the question directly and concisely using the forked conversation context.',
  'This side turn is read-only: do not modify files, run mutating commands, or continue the parent task.',
].join(' ');

// A concise side answer should remain comfortably below this. The hard byte
// ceiling prevents an unbounded App Server stream from growing server memory or
// producing an unbounded sequence of WebSocket frames.
export const CODEX_SIDE_QUERY_MAX_ANSWER_BYTES = 1024 * 1024;

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateCodexSession(sessionId, userId, accessMode, authorizeImpl) {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('A Codex session id is required.');
  }
  if (!Number.isInteger(userId)) {
    throw new Error('An authenticated user is required.');
  }

  const session = authorizeImpl(sessionId, userId, accessMode);
  if (session.provider !== 'codex') {
    throw new Error('The selected session is not a Codex thread.');
  }
  return session;
}

function bindRpcParamsToAuthorizedSession(method, params, sessionId, session) {
  const bound = { ...params };
  if (
    method.startsWith('thread/') ||
    method === 'mcpServerStatus/list' ||
    method === 'app/list'
  ) {
    bound.threadId = sessionId;
  }
  if (method === 'skills/list' || method === 'hooks/list') {
    bound.cwds = session.project_path ? [session.project_path] : [];
  }
  return bound;
}

/**
 * Runs one bounded App Server RPC under the authorized user's Codex environment.
 * This is intentionally limited to request/response operations: actions whose
 * work continues through turn notifications (such as compaction and review)
 * need a long-lived client instead.
 */
async function executeCodexAppServerRpc(sessionId, userId, method, params = {}, options = {}) {
  if (typeof method !== 'string' || method.length === 0) {
    throw new Error('A Codex App Server method is required.');
  }

  const authorizeImpl = options.authorizeImpl || assertSessionAccessible;
  const envResolver = options.envResolver || resolveProviderEnv;
  const accessMode = options.accessMode === 'write' ? 'write' : 'read';
  const session = validateCodexSession(sessionId, userId, accessMode, authorizeImpl);
  const permissionExecution = options.permissionExecution !== undefined
    ? options.permissionExecution
    : authorizeImpl !== assertSessionAccessible
      ? null
      : authorizeRuntimeUserProviderEffect({
      authenticatedPrincipal: options.authenticatedPrincipal,
      provider: 'codex',
      engine: 'codex_app_server',
      entrypoint: 'codex.app-server.rpc',
      purpose: method === 'mcpServerStatus/list' ? 'mcp' : 'sdk_turn',
      sessionId,
      projectId: String(session.project_id ?? `session:${sessionId}`),
      workspacePath: session.project_path || process.cwd(),
      });
  return runPermissionExecutionAdapter(permissionExecution, async () => {
    const authorizedParams = bindRpcParamsToAuthorizedSession(
      method,
      params,
      sessionId,
      session,
    );
    const spawnImpl = options.spawnImpl || spawn;
    const launch = codexLaunchOptions(envResolver(userId, 'codex', process.env));
    const child = spawnImpl(launch.codexPathOverride, ['app-server'], {
      cwd: session.project_path || process.cwd(),
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const boundedOutput = boundedRpcOutput();
    const lines = createInterface({ input: boundedOutput });
  child.stderr?.on?.('data', () => {});
  const pending = new Map();
  let requestId = 0;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    lines.close();
    child.stdout.unpipe(boundedOutput);
    boundedOutput.destroy();
    stopChild(child);
  };
  const failPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const call = (rpcMethod, rpcParams = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex App Server timed out during ${rpcMethod}.`));
    }, START_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      if (rpcMethod === method) options.onRequestSent?.();
      child.stdin.write(`${JSON.stringify({ method: rpcMethod, id, params: rpcParams })}\n`);
    } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });

  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id == null || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(rpcError(message));
    else waiter.resolve(message.result);
  });
  child.once('error', (error) => { failPending(error); cleanup(); });
  boundedOutput.once('error', (error) => { failPending(error); cleanup(); });
  lines.once('error', (error) => { failPending(error); cleanup(); });
  child.stdout.pipe(boundedOutput);
  child.stdin.once('error', (error) => { failPending(error); cleanup(); });
  child.once('exit', (code, signal) => {
    if (pending.size > 0) {
      failPending(new Error(`Codex App Server exited during ${method} (${code ?? signal}).`));
    }
  });

    try {
      await call('initialize', {
        clientInfo: { name: 'nassaj', title: 'Nassaj', version: '1' },
        ...(options.experimentalApi === true ? { capabilities: { experimentalApi: true } } : {}),
      });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      if (options.resumeThread) {
        await call('thread/resume', { threadId: sessionId });
      }
      await options.beforeRequest?.();
      return await call(method, authorizedParams);
    } finally {
      cleanup();
    }
  });
}

/**
 * Single-flighted and concurrency-bounded entry point for short App Server RPCs.
 */
export function callCodexAppServer(sessionId, userId, method, params = {}, options = {}) {
  const key = `${userId}:${sessionId}:${method}:${stableSerialize(params)}`;
  const existing = activeRpcs.get(key);
  if (existing) return existing.promise;

  if (activeRpcs.size >= MAX_ACTIVE_RPCS) {
    throw Object.assign(
      new Error('Too many Codex commands are already running. Try again shortly.'),
      { code: 'CODEX_RPC_LIMIT', statusCode: 429 },
    );
  }
  const activeForUser = [...activeRpcs.values()]
    .filter((entry) => entry.userId === userId).length;
  if (activeForUser >= MAX_ACTIVE_RPCS_PER_USER) {
    throw Object.assign(
      new Error('You already have the maximum number of Codex commands running.'),
      { code: 'CODEX_RPC_LIMIT', statusCode: 429 },
    );
  }

  const promise = executeCodexAppServerRpc(sessionId, userId, method, params, options)
    .finally(() => {
      if (activeRpcs.get(key)?.promise === promise) activeRpcs.delete(key);
    });
  activeRpcs.set(key, { promise, userId });
  return promise;
}

export function isCodexRpcActive(sessionId, userId, method) {
  const prefix = `${userId}:${sessionId}:${method}:`;
  return [...activeRpcs.keys()].some((key) => key.startsWith(prefix));
}

function rpcError(message) {
  const detail = message?.error?.message || message?.error || 'Unknown Codex App Server error';
  return new Error(String(detail));
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
}

/**
 * Runs an ephemeral, read-only Codex side turn from a native App Server fork.
 * The TypeScript SDK cannot fork threads; `thread/fork` is the Codex-native
 * operation that preserves the source context without adding a turn to it.
 */
export async function spawnCodexSideQuery(params = {}, callbacks = {}, options = {}) {
  const onChunk = typeof callbacks.onChunk === 'function' ? callbacks.onChunk : () => {};
  const onError = typeof callbacks.onError === 'function' ? callbacks.onError : () => {};
  const onComplete = typeof callbacks.onComplete === 'function' ? callbacks.onComplete : () => {};
  const authorizeImpl = options.authorizeImpl || assertSessionAccessible;
  const envResolver = options.envResolver || resolveProviderEnv;
  const spawnImpl = options.spawnImpl || spawn;
  const governanceImpl = options.governanceImpl || ensureCodexGovernance;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  const userId = Number.isInteger(params.userId) ? params.userId : null;

  let session;
  try {
    session = validateCodexSession(sessionId, userId, 'read', authorizeImpl);
  } catch (error) {
    onError('session_not_found', error instanceof Error ? error.message : String(error));
    return;
  }
  let governance;
  try {
    governance = governanceImpl(userId);
  } catch {
    governance = null;
  }
  if (!governance?.ok) {
    onError('sdk_error', 'Codex governance could not be established for this side query.');
    return;
  }
  const cwd = session.project_path || params.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    onError('sdk_error', 'The project path for this session could not be determined.');
    return;
  }

  const launch = codexLaunchOptions(envResolver(userId, 'codex', process.env));
  const child = spawnImpl(launch.codexPathOverride, ['app-server', '-c', 'project_doc_max_bytes=0'], {
    cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr?.on?.('data', () => {});
  const pending = new Map();
  let requestId = 0;
  let forkThreadId = null;
  let turnId = null;
  let answer = '';
  let answerBytes = 0;
  let terminal = false;
  let completionTimer = null;
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });

  const cleanup = () => {
    if (completionTimer) clearTimeout(completionTimer);
    lines.close();
    stopChild(child);
  };
  const finishError = (code, error) => {
    if (terminal) return;
    terminal = true;
    cleanup();
    onError(code, error instanceof Error ? error.message : String(error));
    resolveTerminal();
  };
  const finishComplete = () => {
    if (terminal) return;
    terminal = true;
    cleanup();
    onComplete(answer);
    resolveTerminal();
  };
  const failPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const call = (method, rpcParams = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex App Server timed out during ${method}.`));
    }, START_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ method, id, params: rpcParams })}\n`);
  });

  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(rpcError(message));
      else waiter.resolve(message.result);
      return;
    }
    // Fail closed on unexpected server requests. A read-only /btw must never
    // wait for (or silently grant) a command/file approval.
    if (message.id != null && typeof message.method === 'string') {
      child.stdin.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32601, message: 'Interactive requests are disabled for /btw.' },
      })}\n`);
      return;
    }
    if (
      message.method === 'item/agentMessage/delta'
      && message.params?.threadId === forkThreadId
      && (!turnId || message.params?.turnId === turnId)
      && typeof message.params?.delta === 'string'
    ) {
      const deltaBytes = Buffer.byteLength(message.params.delta, 'utf8');
      const nextBytes = answerBytes + deltaBytes;
      if (nextBytes > CODEX_SIDE_QUERY_MAX_ANSWER_BYTES) {
        finishError(
          'response_too_large',
          `The Codex /btw answer exceeded ${CODEX_SIDE_QUERY_MAX_ANSWER_BYTES} UTF-8 bytes.`,
        );
        return;
      }
      answer += message.params.delta;
      answerBytes = nextBytes;
      onChunk(message.params.delta);
      return;
    }
    if (
      message.method === 'turn/completed'
      && message.params?.threadId === forkThreadId
      && (!turnId || message.params?.turn?.id === turnId)
    ) {
      const status = message.params?.turn?.status;
      if (status === 'completed') finishComplete();
      else finishError('sdk_error', message.params?.turn?.error?.message || `Codex side turn ${status || 'failed'}.`);
    }
  });
  child.once('error', (error) => { failPending(error); finishError('sdk_error', error); });
  child.stdin.once('error', (error) => { failPending(error); finishError('sdk_error', error); });
  child.once('exit', (code, signal) => {
    if (!terminal) finishError('sdk_error', `Codex App Server exited (${code ?? signal}).`);
  });

  const interrupt = () => {
    if (terminal) return;
    if (forkThreadId && turnId && child.stdin?.writable) {
      child.stdin.write(`${JSON.stringify({
        method: 'turn/interrupt', id: ++requestId, params: { threadId: forkThreadId, turnId },
      })}\n`);
    }
    terminal = true;
    failPending(new Error('Codex side query interrupted.'));
    cleanup();
    resolveTerminal();
  };
  callbacks.onStarted?.({ interrupt });
  if (terminal) return;

  try {
    await call('initialize', { clientInfo: { name: 'nassaj', title: 'Nassaj', version: '1' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const forkResult = await call('thread/fork', {
      threadId: sessionId,
      // Nassaj's visible message ids are transcript-row ids, not Codex turn ids.
      // Fork the latest persisted source state; passing a row id as lastTurnId
      // would make App Server reject an otherwise valid side query.
      ephemeral: true,
      // Do not set excludeTurns: it selects App Server's paginated fork path,
      // whose history projection can fail when source ordinals are inconsistent.
    });
    forkThreadId = forkResult?.thread?.id;
    if (!forkThreadId) throw new Error('Codex did not return a forked thread id.');
    const question = typeof params.question === 'string' ? params.question.trim() : '';
    if (!question) throw new Error('A /btw question is required.');
    const turnResult = await call('turn/start', {
      threadId: forkThreadId,
      input: [{ type: 'text', text: `${question}\n\n${SIDE_QUERY_DIRECTIVE}` }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    turnId = turnResult?.turn?.id || null;
    if (!terminal) {
      completionTimer = setTimeout(
        () => finishError('timeout', 'The Codex /btw query timed out.'),
        COMPLETION_TIMEOUT_MS,
      );
    }
    await terminalPromise;
  } catch (error) {
    finishError('sdk_error', error);
  }
}

/**
 * Starts native manual compaction for one authorized Codex thread.
 * The promise resolves only after the contextCompaction item and its turn complete and
 * rejects failed, interrupted, exited, or timed-out compactions.
 */
export async function startCodexCompaction(sessionId, userId, options = {}) {
  const authorizeImpl = options.authorizeImpl || assertSessionAccessible;
  const envResolver = options.envResolver || resolveProviderEnv;
  const session = validateCodexSession(sessionId, userId, 'write', authorizeImpl);
  const key = sessionId;
  if (activeCompactions.has(key)) {
    const result = await activeCompactions.get(key).promise;
    return { ...result, alreadyRunning: true };
  }
  if (activeCompactions.size >= MAX_ACTIVE_COMPACTIONS) {
    throw new Error('Too many Codex compactions are already running. Try again shortly.');
  }
  const activeForUser = [...activeCompactions.values()]
    .filter((entry) => entry.userId === userId).length;
  if (activeForUser >= MAX_ACTIVE_COMPACTIONS_PER_USER) {
    throw new Error('You already have the maximum number of Codex compactions running.');
  }

  const permissionExecution = options.permissionExecution !== undefined
    ? options.permissionExecution
    : authorizeImpl !== assertSessionAccessible
      ? null
      : authorizeRuntimeUserProviderEffect({
      authenticatedPrincipal: options.authenticatedPrincipal,
      provider: 'codex',
      engine: 'codex_app_server',
      entrypoint: 'codex.app-server.compaction',
      purpose: 'sdk_turn',
      effectFootprint: 'external',
      sessionId,
      projectId: String(session.project_id ?? `session:${sessionId}`),
      workspacePath: session.project_path || process.cwd(),
      });
  return runPermissionExecutionAdapter(permissionExecution, async () => {
    const spawnImpl = options.spawnImpl || spawn;
    const launch = codexLaunchOptions(envResolver(userId, 'codex', process.env));
    const child = spawnImpl(launch.codexPathOverride, ['app-server'], {
      cwd: session.project_path || process.cwd(),
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const lines = createInterface({ input: child.stdout });
  // Drain diagnostics so a chatty child can never block on a full stderr pipe.
  child.stderr?.on?.('data', () => {});
  const pending = new Map();
  let compactRequested = false;
  let compactTurnId = null;
  let compactItemId = null;
  let compactItemCompleted = false;
  let terminalReceived = false;
  let finished = false;
  let requestId = 0;
  let completionTimer = null;
  let resolveCompletion;
  let rejectCompletion;
  const completionPromise = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  completionPromise.catch(() => {});
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (completionTimer) clearTimeout(completionTimer);
    lines.close();
    stopChild(child);
    if (activeCompactions.get(key)?.child === child) activeCompactions.delete(key);
  };

  const failPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex App Server timed out during ${method}.`));
    }, START_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  });

  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(rpcError(message));
      else waiter.resolve(message.result);
      return;
    }
    const params = message.params;
    if (!compactRequested || finished || terminalReceived || params?.threadId !== sessionId) return;
    if ((message.method === 'item/started' || message.method === 'item/completed') &&
        params.item?.type === 'contextCompaction' &&
        typeof params.turnId === 'string' && params.turnId.length > 0 &&
        typeof params.item.id === 'string' && params.item.id.length > 0) {
      // The start RPC returns {}. Only the native compaction item identifies its
      // turn; a preceding turn/started or terminal can belong to another run.
      if (compactTurnId === null) {
        compactTurnId = params.turnId;
        compactItemId = params.item.id;
      }
      if (params.turnId === compactTurnId && params.item.id === compactItemId &&
          message.method === 'item/completed') compactItemCompleted = true;
      return;
    }
    // Error notifications may be retryable. The matching terminal turn is the
    // outcome authority; uncorrelated errors must not terminate this operation.
    if (message.method !== 'turn/completed' || compactTurnId === null ||
        params.turn?.id !== compactTurnId) return;
    terminalReceived = true;
    const status = params.turn.status;
    if (status === 'completed' && compactItemCompleted) {
      resolveCompletion({ status: 'completed', alreadyRunning: false });
    } else {
      const detail = params.turn.error?.message;
      rejectCompletion(new Error(status === 'completed'
        ? 'Codex context compaction ended without a completed contextCompaction item.'
        : `Codex context compaction ${status || 'ended without a completed status'}${detail ? `: ${detail}` : '.'}`));
    }
  });

  child.once('error', (error) => {
    failPending(error);
    rejectCompletion(error);
    cleanup();
  });
  child.stdin.once('error', (error) => {
    failPending(error);
    rejectCompletion(error);
    cleanup();
  });
  child.once('exit', (code, signal) => {
    if (pending.size > 0) {
      failPending(new Error(`Codex App Server exited before accepting /compact (${code ?? signal}).`));
    }
    if (!finished) {
      rejectCompletion(new Error(`Codex App Server exited before /compact completed (${code ?? signal}).`));
    }
    cleanup();
  });

  activeCompactions.set(key, { child, userId, promise: resultPromise });
    try {
      await call('initialize', {
        clientInfo: { name: 'nassaj', title: 'Nassaj', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      await call('thread/resume', { threadId: sessionId });
      compactRequested = true;
      await call('thread/compact/start', { threadId: sessionId });
      if (!finished && !terminalReceived) {
        completionTimer = setTimeout(() => {
          cleanup();
          rejectCompletion(new Error('Codex context compaction timed out before completion.'));
        }, COMPLETION_TIMEOUT_MS);
        completionTimer.unref?.();
      }
      // Do not kill the child before an ACK following early notifications.
      const result = await completionPromise;
      resolveResult(result);
      return result;
    } catch (error) {
      rejectCompletion(error);
      rejectResult(error);
      throw error;
    } finally {
      cleanup();
    }
  });
}

export function isCodexCompactionActive(sessionId, userId) {
  void userId;
  return activeCompactions.has(sessionId);
}
