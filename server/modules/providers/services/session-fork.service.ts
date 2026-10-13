import path from 'node:path';

// Pure actor validation avoids importing the execution gateway barrel back into providers.
// eslint-disable-next-line boundaries/dependencies
import { createAuthenticatedLaunchActor } from '@/modules/execution-permissions/actor.js';
import { participantsDb, sessionsDb } from '@/modules/database/index.js';
import {
  forkClaudeTranscript,
  TranscriptForkError,
  type ForkClaudeTranscriptOptions,
  type ForkClaudeTranscriptResult,
  type ForkExtraMessage,
} from '@/modules/providers/list/claude/claude-transcript-fork.js';
import { isLinkModeRunRefusal } from '@/modules/providers/services/harness-link-mode.service.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { notifySessionMetadataChanged } from '@/modules/providers/services/sessions-watcher.service.js';

import { openCodexForkCutoff } from '../list/codex/codex-fork-cutoff.js';
import type { CodexForkCutoff } from '../list/codex/codex-fork-cutoff.js';
import {
  isTranscriptHandle, openRecordedTranscript, type SessionTranscriptHandle,
} from '../shared/session-transcript-reader.js';
import { removeSessionTranscript } from '../shared/session-transcript-removal.js';

/**
 * Session FORK orchestration (T-1090) — turns the one-shot `/btw` side question
 * into a real, continuable conversation.
 *
 * `/btw` answers from an SDK fork that persists NOTHING (ADR-077 / C1), which is
 * exactly right for a throwaway question and exactly wrong the moment the answer
 * is worth following up on: there is no thread to reply into. Forking branches
 * the session's transcript on disk and appends the question and the answer the
 * user just read, so the side thread opens as an ordinary session — same project,
 * same context, resumable by the CLI and the SDK alike.
 *
 * The heavy lifting (the upstream-faithful transcript rewrite) is in
 * claude-transcript-fork.ts. This layer owns everything AROUND the file:
 *   - resolving the source transcript (DB `jsonl_path`, else the encoded path),
 *   - indexing the new file so it has a sessions row without waiting for the
 *     6-second watcher poll,
 *   - recording the FORKER as the new session's participant. That is not
 *     cosmetic: a session with no participant and no message author fails the
 *     "native session" predicate (sessions.db.ts) and would never appear in the
 *     sidebar — the same orphan guard that hides out-of-band CLI runs,
 *   - broadcasting the sidebar refresh.
 *
 * Authorization is re-checked here before provider/path inspection or writes;
 * caller-side websocket gates are defense in depth, not the trust boundary.
 *
 * ── Two boundaries worth stating plainly ─────────────────────────────────────
 *
 * 1. The appended answer is CLIENT-SUPPLIED, and structurally has to be: the
 *    side query ran with `persistSession:false`, so the server kept no copy of
 *    what it streamed. A caller could therefore append an assistant turn the
 *    model never produced. That is not a privilege boundary — the branch is a
 *    new session the requester owns, and anyone can already type anything as a
 *    user message — but in a SHARED project a fabricated turn would read as
 *    Claude's words to other members. Recovering server-side ground truth would
 *    mean persisting every side query (the thing ADR-077 deliberately refuses),
 *    so the honest fix, if this ever matters, is to persist the answer for the
 *    life of the overlay and fork from THAT, not to trust harder.
 *
 * 2. The branch is cut from what is ON DISK, which is the same C5 contract the
 *    side query itself carries: a turn still mid-flight has not been flushed and
 *    is not in the branch. Forking during a live run is therefore allowed and
 *    safe — it reads a consistent prefix and never touches the running session.
 */

/** Upstream's own cap for the `btw: …` session title. */
const FORK_TITLE_MAX_LEN = 80;

/** Guards the appended pair against a pathological payload. */
const FORK_MAX_MESSAGE_CHARS = 100_000;
const messageForkLocks = new Map<string, Promise<void>>();

async function withMessageForkLock<T>(sourceSessionId: string, action: () => Promise<T>): Promise<T> {
  const previous = messageForkLocks.get(sourceSessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  messageForkLocks.set(sourceSessionId, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (messageForkLocks.get(sourceSessionId) === queued) {
      messageForkLocks.delete(sourceSessionId);
    }
  }
}

export type SessionForkErrorCode =
  | 'session_not_found'
  | 'unsupported_provider'
  | 'transcript_not_found'
  | 'source_empty'
  | 'source_too_large'
  | 'message_not_found'
  | 'unsupported_cutoff'
  | 'runtime_not_ready'
  | 'outcome_unknown'
  | 'registration_failed'
  | 'registration_evidence_expired'
  | 'busy'
  | 'fork_failed'
  /** B-1546/B-1547: the link-mode run gate refused the Codex fork before any submit. */
  | 'LINK_MODE_KEY_MISSING'
  | 'LINK_MODE_RECORD_UNREADABLE';

export class SessionForkError extends Error {
  readonly code: SessionForkErrorCode;
  forkedSessionId?: string;

  constructor(code: SessionForkErrorCode, message: string) {
    super(message);
    this.name = 'SessionForkError';
    this.code = code;
  }
}

/**
 * T-1091 — how much of the source conversation the branch carries:
 *   full  — the whole conversation, then the exchange (the CLI's own behaviour;
 *           the follow-up keeps every bit of context, and pays for it)
 *   fresh — ONLY the exchange, in the same project (a clean thread for a side
 *           question that stands on its own)
 */
export type SessionForkMode = 'full' | 'fresh';

export const SESSION_FORK_MODES: readonly SessionForkMode[] = ['full', 'fresh'];

export function isSessionForkMode(value: unknown): value is SessionForkMode {
  return value === 'full' || value === 'fresh';
}

export interface ForkSessionParams {
  /** The live session being branched. */
  sessionId: string;
  /** The `/btw` question — appended as the branch's next user message. */
  question: string;
  /** The answer already streamed to the overlay — appended as the reply. */
  answer: string;
  /** Numeric user id of the requester; they own the resulting session. */
  userId: number | null;
  /** Optional context pin (the same id `/btw` answered against). */
  upToMessageId?: string | null;
  /** Defaults to 'full' — the upstream-faithful branch. */
  mode?: SessionForkMode;
}

export interface ForkSessionResult {
  sessionId: string;
  title: string;
  projectPath: string | null;
  mode: SessionForkMode;
}

export interface ForkSessionAtMessageParams {
  /** The session whose persisted transcript is branched. */
  sessionId: string;
  /** The assistant transcript UUID at which the new conversation ends. */
  upToMessageId: string;
  /** Numeric user id of the requester; they own the resulting session. */
  userId: number | null;
  requestId?: string;
  authenticatedPrincipal?: unknown;
  retryRegistrationOnly?: boolean;
  expectedForkedSessionId?: string;
}

/** `btw: <question>` clipped to the upstream title budget. */
export function buildForkTitle(question: string): string {
  const normalized = (question ?? '').replace(/\s+/g, ' ').trim();
  const title = `btw: ${normalized}`;
  return title.length > FORK_TITLE_MAX_LEN
    ? `${title.slice(0, FORK_TITLE_MAX_LEN - 1)}…`
    : title;
}

/**
 * Claude's on-disk project folder name: every character outside [A-Za-z0-9-]
 * becomes '-'. Used only when the DB has no `jsonl_path` yet (a session row the
 * run path created before the synchronizer indexed its file).
 */
function encodeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function clip(text: string): string {
  const value = typeof text === 'string' ? text : '';
  return value.length > FORK_MAX_MESSAGE_CHARS ? value.slice(0, FORK_MAX_MESSAGE_CHARS) : value;
}

function requireForkAuthorization(sessionId: string, userId: number | null): void {
  let authorized = false;
  try {
    authorized = Number.isInteger(userId) && userId !== null
      && participantsDb.isParticipant(sessionId, userId);
  } catch {
    authorized = false;
  }
  if (!authorized) {
    throw new SessionForkError('session_not_found', 'Session not found.');
  }
}

const UNTRUSTED_SOURCE = 'This session has no trusted transcript to fork.';

/**
 * B-1597 (ADR-201 L2): the fork source, opened only through the pinned reader
 * (openRecordedTranscript) — confined to the ONE tree that holds the recorded
 * path (operator or member), pinned single-link with O_NOFOLLOW, and bound to
 * `sessionId` by its name and header. It must also sit directly in the
 * session's own project folder of that tree, where the branch is written.
 * The caller closes the returned descriptor.
 */
async function openForkSource(
  sessionId: string, recorded: string, projectPath: string,
): Promise<SessionTranscriptHandle> {
  const opened = await openRecordedTranscript(
    { session_id: sessionId, provider: 'claude', jsonl_path: recorded }, 'session-fork',
  ).catch(() => null);
  if (!opened || !isTranscriptHandle(opened)) {
    throw new SessionForkError('transcript_not_found', UNTRUSTED_SOURCE);
  }
  const folder = path.dirname(opened.realpath);
  if (path.basename(folder) !== encodeClaudeProjectDir(projectPath) || path.dirname(folder) !== opened.root) {
    await opened.fd.close().catch(() => undefined);
    throw new SessionForkError('transcript_not_found', UNTRUSTED_SOURCE);
  }
  return opened;
}

/**
 * Rolls back a fork whose registration failed: the new branch is removed only
 * through the confined deletion primitive (bound to the forked id by name and
 * header, inside the source's tree), never by name. A refused removal leaves
 * the file; the orphan prune is the backstop.
 */
async function removeFailedFork(filePath: string, sessionId: string): Promise<void> {
  await removeSessionTranscript({ session_id: sessionId, provider: 'claude', jsonl_path: filePath }, 'session-delete');
  try {
    sessionsDb.deleteSessionById(sessionId);
  } catch {
    // Preserve the primary registration error; later orphan pruning is a backstop.
  }
}

/**
 * Writes the branch from the pinned source (the fork reads the descriptor,
 * never the name) and closes it. Fork errors map to stable codes; anything
 * else is logged by `onUnexpected` (no raw filesystem message) and becomes
 * `fork_failed`.
 */
async function forkFromSource(
  source: SessionTranscriptHandle,
  options: Omit<ForkClaudeTranscriptOptions, 'sourceFilePath' | 'sourceHandle'>,
  onUnexpected: () => void,
): Promise<ForkClaudeTranscriptResult> {
  try {
    return await forkClaudeTranscript({ ...options, sourceFilePath: source.realpath, sourceHandle: source.fd });
  } catch (error) {
    if (error instanceof TranscriptForkError) {
      if (error.code === 'source_unreadable') {
        throw new SessionForkError('transcript_not_found', 'This session has no transcript to fork.');
      }
      if (error.code === 'source_empty' || error.code === 'source_too_large' || error.code === 'message_not_found') {
        throw new SessionForkError(error.code, error.message);
      }
    }
    onUnexpected();
    throw new SessionForkError('fork_failed', 'The conversation could not be forked.');
  } finally {
    await source.fd.close().catch(() => undefined);
  }
}

/**
 * Branches `sessionId` into a new session carrying the `/btw` exchange.
 *
 * Never partially registers: the transcript is renamed into place first, and
 * only an existing file is indexed and attributed.
 */
export async function forkSessionFromSideQuery(
  params: ForkSessionParams,
): Promise<ForkSessionResult> {
  const {
    sessionId, question, answer, userId, upToMessageId = null, mode = 'full',
  } = params;

  let row: { provider: string; project_path: string | null; jsonl_path: string | null } | null =
    null;
  try {
    row = sessionsDb.getSessionById(sessionId) ?? null;
  } catch {
    row = null;
  }
  if (!row) {
    throw new SessionForkError('session_not_found', 'Session not found.');
  }
  requireForkAuthorization(sessionId, userId);
  if (row.provider !== 'claude') {
    throw new SessionForkError(
      'unsupported_provider',
      `Forking a side question supports Claude sessions only (this session runs on "${row.provider}").`,
    );
  }

  const projectPath = (row.project_path ?? '').trim() || null;
  if (!projectPath) {
    throw new SessionForkError('transcript_not_found', 'This session has no transcript to fork.');
  }
  // A row the run path created before the synchronizer stamped its file: the
  // requester's own Claude home is where their launch wrote it. Loaded on use:
  // it pulls in the user and provider-env stores.
  const recorded = (row.jsonl_path ?? '').trim() || path.join(
    (await import('../list/claude/claude-home.js')).resolveClaudeHomeForUser(userId),
    'projects', encodeClaudeProjectDir(projectPath), `${sessionId}.jsonl`,
  );
  const source = await openForkSource(sessionId, recorded, projectPath);

  const title = buildForkTitle(question);
  const extraMessages: ForkExtraMessage[] = [
    { role: 'user', content: clip(question) },
    { role: 'assistant', content: clip(answer) },
  ];

  const forked = await forkFromSource(source, {
    sourceSessionId: sessionId,
    upToMessageId,
    // 'fresh' carries no history: the branch is the exchange alone, seeded
    // with the source's cwd/version so it still belongs to this project.
    includeHistory: mode !== 'fresh',
    extraMessages,
    title,
  }, () => console.error('[BTW] fork write failed', { sessionId }));

  // Registration is all-or-nothing: a transcript without an indexed session and
  // participant is an unauthorized orphan, so remove both file and partial row.
  try {
    await sessionSynchronizerService.synchronizeProviderFile('claude', forked.filePath);
    const spawnProjectPath = projectPath ?? forked.cwd;
    participantsDb.recordSpawn(
      forked.forkedSessionId,
      userId as number,
      spawnProjectPath ? { provider: 'claude', projectPath: spawnProjectPath } : undefined,
    );
  } catch {
    await removeFailedFork(forked.filePath, forked.forkedSessionId);
    throw new SessionForkError('fork_failed', 'The fork could not be registered.');
  }

  try {
    notifySessionMetadataChanged('claude', forked.forkedSessionId);
  } catch {
    // Broadcast is best-effort; the watcher's own poll still refreshes clients.
  }

  console.log(
    `[BTW] fork created source=${sessionId} forked=${forked.forkedSessionId} `
    + `mode=${mode} entries=${forked.entryCount} userIdValue=${String(userId)}`,
  );

  return {
    sessionId: forked.forkedSessionId,
    title,
    projectPath: projectPath ?? forked.cwd,
    mode,
  };
}

/**
 * Branches an ordinary Claude conversation at one persisted transcript message.
 *
 * Unlike `forkSessionFromSideQuery`, this deliberately appends NO synthetic
 * exchange: the new session ends at the assistant response the user selected.
 * `upToMessageId` is required so a hand-rolled client cannot accidentally fork
 * the moving tail of a live transcript.
 */
export async function forkSessionAtMessage(
  params: ForkSessionAtMessageParams,
): Promise<ForkSessionResult> {
  requireForkAuthorization(params.sessionId, params.userId);
  if (sessionsDb.getSessionById(params.sessionId)?.provider === 'codex') return forkCodexMessage(params);
  if (params.retryRegistrationOnly || params.expectedForkedSessionId !== undefined) {
    throw new SessionForkError('registration_evidence_expired', 'Registration evidence unavailable. No new fork was created.');
  }
  return withMessageForkLock(params.sessionId, () => forkSessionAtMessageLocked(params));
}

async function forkSessionAtMessageLocked(
  params: ForkSessionAtMessageParams,
): Promise<ForkSessionResult> {
  const { sessionId, upToMessageId, userId } = params;
  const cutoff = typeof upToMessageId === 'string' ? upToMessageId.trim() : '';
  if (!cutoff) {
    throw new SessionForkError('message_not_found', 'No message was specified for the fork.');
  }

  let row: { provider: string; project_path: string | null; jsonl_path: string | null } | null = null;
  try {
    row = sessionsDb.getSessionById(sessionId) ?? null;
  } catch {
    row = null;
  }
  if (!row) {
    throw new SessionForkError('session_not_found', 'Session not found.');
  }
  requireForkAuthorization(sessionId, userId);
  if (row.provider !== 'claude') {
    throw new SessionForkError(
      'unsupported_provider',
      `Forking a message supports Claude sessions only (this session runs on "${row.provider}").`,
    );
  }

  const projectPath = (row.project_path ?? '').trim() || null;
  const recorded = (row.jsonl_path ?? '').trim();
  // No constructed fallback here: this direct-navigation path must fork only a
  // synchronizer-indexed, DB-attested transcript in a known project.
  if (!projectPath || !recorded) {
    throw new SessionForkError('transcript_not_found', UNTRUSTED_SOURCE);
  }
  const source = await openForkSource(sessionId, recorded, projectPath);

  const title = 'Forked conversation';
  const forked = await forkFromSource(source, {
    sourceSessionId: sessionId,
    upToMessageId: cutoff,
    includeHistory: true,
    extraMessages: [],
    title,
    requireAssistantCutoff: true,
  }, () => console.error('[MESSAGE-FORK] fork write failed'));

  // A successful response must be immediately openable and visible to its
  // creator. Unlike the best-effort legacy /btw promotion, this action is a
  // direct navigation contract, so fail closed if either registration step fails.
  if (!Number.isInteger(userId) || userId === null) {
    throw new SessionForkError('fork_failed', 'A signed-in user is required to create a fork.');
  }
  try {
    await sessionSynchronizerService.synchronizeProviderFile('claude', forked.filePath);
    participantsDb.recordSpawn(
      forked.forkedSessionId,
      userId,
      { provider: 'claude', projectPath: projectPath ?? forked.cwd ?? undefined },
    );
  } catch (error) {
    console.error('[MESSAGE-FORK] registration failed');
    await removeFailedFork(forked.filePath, forked.forkedSessionId);
    throw new SessionForkError('fork_failed', 'The fork could not be registered.');
  }
  try {
    notifySessionMetadataChanged('claude', forked.forkedSessionId);
  } catch {
    // The watcher will refresh clients if this best-effort notification fails.
  }

  console.log('[MESSAGE-FORK] created');
  return {
    sessionId: forked.forkedSessionId,
    title,
    projectPath: projectPath ?? forked.cwd,
    mode: 'full',
  };
}

type CodexForkAttempt = {
  cutoffKey: string; expiresAt: number; promise?: Promise<ForkSessionResult>;
  error?: SessionForkError; result?: ForkSessionResult;
  target?: { sessionId: string; filePath: string; codexHome: string; projectPath: string; cutoff: CodexForkCutoff; identity: string };
};
const codexForkAttempts = new Map<string, CodexForkAttempt>();
const codexForkFlights = new Map<string, CodexForkAttempt>();

async function authorizeCodexFork(params: ForkSessionAtMessageParams) {
  requireForkAuthorization(params.sessionId, params.userId);
  try {
    const actor = createAuthenticatedLaunchActor(params.authenticatedPrincipal as never);
    if (actor.userId !== params.userId) throw new Error('principal mismatch');
  } catch { throw new SessionForkError('session_not_found', 'Session not found.'); }
  const { assertSessionAccessible } = await import('./sessions.service.js');
  let row;
  try { row = assertSessionAccessible(params.sessionId, params.userId, 'write'); }
  catch { throw new SessionForkError('session_not_found', 'Session not found.'); }
  if (row.provider !== 'codex') {
    throw new SessionForkError('session_not_found', 'Session not found.');
  }
  return row;
}

async function forkCodexMessage(params: ForkSessionAtMessageParams): Promise<ForkSessionResult> {
  await authorizeCodexFork(params);
  if (params.retryRegistrationOnly !== undefined && typeof params.retryRegistrationOnly !== 'boolean') {
    throw new SessionForkError('registration_evidence_expired', 'Invalid registration-only retry.');
  }
  if (typeof params.upToMessageId !== 'string' || params.upToMessageId.length > 256
    || typeof params.sessionId !== 'string' || params.sessionId.length > 256) {
    throw new SessionForkError('unsupported_cutoff', 'Invalid selected response.');
  }
  if (!params.requestId || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.requestId)) {
    throw new SessionForkError('unsupported_cutoff', 'A valid request identifier is required.');
  }
  const cutoffKey = JSON.stringify([params.userId, params.sessionId, params.upToMessageId]);
  const key = JSON.stringify([params.userId, params.sessionId, params.requestId]);
  for (const [id, attempt] of codexForkAttempts) {
    if (!attempt.promise && attempt.expiresAt < Date.now()) codexForkAttempts.delete(id);
  }
  let attempt = codexForkAttempts.get(key);
  if (params.retryRegistrationOnly) {
    if (!attempt?.target || attempt.expiresAt <= Date.now() || attempt.cutoffKey !== cutoffKey
      || typeof params.expectedForkedSessionId !== 'string'
      || attempt.target.sessionId !== params.expectedForkedSessionId) {
      throw new SessionForkError('registration_evidence_expired', 'Registration evidence expired. No new fork was created.');
    }
  } else if (params.expectedForkedSessionId !== undefined) {
    throw new SessionForkError('unsupported_cutoff', 'Registration-only intent is required.');
  }
  if (attempt && attempt.cutoffKey !== cutoffKey) throw new SessionForkError('unsupported_cutoff', 'Request changed.');
  if (!attempt) {
    const shared = codexForkFlights.get(cutoffKey);
    if (codexForkAttempts.size >= 64 || (!shared && codexForkFlights.size >= 4)) {
      throw new SessionForkError('busy', 'Too many conversation forks are pending.');
    }
    attempt = shared ?? { cutoffKey, expiresAt: Date.now() + 10 * 60_000 };
    codexForkAttempts.set(key, attempt);
  }
  if (!attempt.promise && !attempt.result) {
    if (attempt.error && !attempt.target) throw attempt.error;
    if (!attempt.target) codexForkFlights.set(cutoffKey, attempt);
    const current = attempt;
    current.promise = (current.target ? registerCodexFork(params, current) : createCodexFork(params, current))
      .then((result) => { current.result = result; return result; })
      .catch((error) => { current.error = error; throw error; })
      .finally(() => {
        current.promise = undefined;
        if (codexForkFlights.get(cutoffKey) === current) codexForkFlights.delete(cutoffKey);
      });
  }
  let result;
  try { result = attempt.result ?? await attempt.promise!; }
  catch (error) { await authorizeCodexFork(params); throw error; }
  await authorizeCodexFork(params);
  const { assertSessionAccessible } = await import('./sessions.service.js');
  assertSessionAccessible(result.sessionId, params.userId, 'read');
  return result;
}

/**
 * B-1546/B-1547: a link-mode run refusal keeps its own code and credential-free
 * message instead of collapsing into `runtime_not_ready`; anything else → null.
 */
function linkModeForkRefusal(error: unknown): SessionForkError | null {
  const code = (error as { code?: unknown })?.code;
  if (!isLinkModeRunRefusal(code) || !(error instanceof Error)) return null;
  return new SessionForkError(code, error.message);
}

async function createCodexFork(params: ForkSessionAtMessageParams, attempt: CodexForkAttempt) {
  const row = await authorizeCodexFork(params);
  // ADR-B913 extends the existing legacy App Server transport; no parallel transport service.
  // eslint-disable-next-line boundaries/no-unknown
  const { callCodexAppServer, assertCodexMessageForkRuntimeReady, assertCodexMessageForkRuntimeUnchanged } = await import('../../../services/codex-app-server.js');
  let runtime: ReturnType<typeof assertCodexMessageForkRuntimeReady>;
  try { runtime = assertCodexMessageForkRuntimeReady(); }
  catch { throw new SessionForkError('runtime_not_ready', 'This runtime cannot fork the selected Codex response.'); }
  const { resolveProviderEnv } = await import('../../../services/isolation/resolve-provider-env.js');
  const codexHome = resolveProviderEnv(params.userId, 'codex', process.env).CODEX_HOME;
  if (!codexHome || !row.project_path || !row.jsonl_path) {
    throw new SessionForkError('unsupported_cutoff', 'The selected response has no trusted transcript.');
  }
  let source;
  try {
    source = await openCodexForkCutoff({ filePath: row.jsonl_path, codexHome,
      sessionId: params.sessionId, projectPath: row.project_path, messageId: params.upToMessageId });
  } catch { throw new SessionForkError('unsupported_cutoff', 'Select a completed final response with a durable identity.'); }
  let submitted = false;
  try {
    const result = await callCodexAppServer(params.sessionId, params.userId, 'thread/fork', {
      lastTurnId: source.cutoff.turnId, ephemeral: false, excludeTurns: true, threadSource: 'user',
    }, {
      accessMode: 'write', authenticatedPrincipal: params.authenticatedPrincipal, experimentalApi: true,
      beforeRequest: async () => {
        await authorizeCodexFork(params); await source.verify();
        try { assertCodexMessageForkRuntimeUnchanged(runtime); }
        catch { throw new SessionForkError('runtime_not_ready', 'The Codex runtime changed before the fork.'); }
      },
      onRequestSent: () => { submitted = true; },
    });
    await source.verify();
    await validateCodexForkTarget(params, attempt, result, codexHome, row.project_path, source.cutoff);
    return await registerCodexFork(params, attempt);
  } catch (error) {
    if (attempt.target) throw error;
    if (submitted) throw new SessionForkError('outcome_unknown', 'The fork may have been created. Check your sessions before creating another.');
    if (error instanceof SessionForkError) throw error;
    throw linkModeForkRefusal(error) ?? new SessionForkError('runtime_not_ready', 'The Codex fork could not be submitted.');
  } finally { await source.close(); }
}

async function validateCodexForkTarget(params: ForkSessionAtMessageParams, attempt: CodexForkAttempt,
  result: unknown, codexHome: string, projectPath: string, cutoff: CodexForkCutoff) {
  const thread = (result as { thread?: Record<string, unknown> })?.thread;
  if (!thread || typeof thread.id !== 'string' || thread.id === params.sessionId || thread.id.length > 256
    || thread.forkedFromId !== params.sessionId || thread.ephemeral !== false
    || typeof thread.path !== 'string' || typeof thread.cwd !== 'string') throw new Error('invalid target');
  const target = await openCodexForkCutoff({ filePath: thread.path, codexHome,
    sessionId: thread.id, projectPath, messageId: params.upToMessageId, allowAppend: false });
  try {
    if (thread.cwd !== target.declaredCwd || target.cutoff.turnId !== cutoff.turnId || target.cutoff.messageDigest !== cutoff.messageDigest
      || target.cutoff.hasLaterTurns) throw new Error('invalid target cutoff');
    await target.verify();
    attempt.target = { sessionId: thread.id, filePath: target.canonical, codexHome, projectPath, cutoff, identity: target.identity };
  } finally { await target.close(); }
}

async function registerCodexFork(params: ForkSessionAtMessageParams, attempt: CodexForkAttempt): Promise<ForkSessionResult> {
  const target = attempt.target!;
  try {
    await authorizeCodexFork(params);
    const proof = await openCodexForkCutoff({ ...target, messageId: params.upToMessageId, allowAppend: false });
    try {
      if (proof.identity !== target.identity || proof.cutoff.turnId !== target.cutoff.turnId
        || proof.cutoff.messageDigest !== target.cutoff.messageDigest || proof.cutoff.hasLaterTurns) throw new Error('changed target');
      await sessionSynchronizerService.synchronizeProviderFile('codex', target.filePath);
      await proof.verify(); await authorizeCodexFork(params);
      const row = sessionsDb.getSessionById(target.sessionId);
      if (row?.provider !== 'codex' || row.jsonl_path !== target.filePath || row.project_path !== target.projectPath) {
        throw new Error('registration missing');
      }
      participantsDb.recordSpawn(target.sessionId, params.userId!, { provider: 'codex', projectPath: target.projectPath });
      sessionsDb.updateSessionCustomName(target.sessionId, 'Forked conversation');
      await proof.verify();
    } finally { await proof.close(); }
    try { notifySessionMetadataChanged('codex', target.sessionId); } catch { /* Best-effort broadcast. */ }
    return { sessionId: target.sessionId, title: 'Forked conversation', projectPath: target.projectPath, mode: 'full' };
  } catch {
    await authorizeCodexFork(params);
    const error = new SessionForkError('registration_failed', 'The fork was created but could not be registered. Retry registration only.');
    error.forkedSessionId = target.sessionId;
    throw error;
  }
}
