import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';


import type {
  TrustedLegacySessionAttestation,
  TrustedShadowAuthorization,
  UniversalConversationShadowHook,
} from '@/modules/conversations/index.js';
import type {
  CanonicalLaunchContext,
  PermissionExecutionHandle,
  PermissionGatewayResult,
} from '@/modules/execution-permissions/index.js';
// Runtime-only leaf import avoids evaluating the database-backed public barrel in partial mocks.
// eslint-disable-next-line boundaries/dependencies
import { runPermissionExecutionAdapter } from '@/modules/execution-permissions/adapter.js';
// Namespace import (not `import { projectsDb, sessionsDb }`): the realtime
// visibility gate below reads `sessionsDb`, but some unit tests module-mock this
// barrel with only the subset they exercise. A namespace binding tolerates a
// member a mock omits (it is only dereferenced on the gate's own code path),
// whereas a static named import would fail ESM linking against such a mock.
import * as databaseModule from '@/modules/database/index.js';
import { sendOpenSessionsCount } from '@/modules/websocket/services/open-sessions.service.js';
import {
  presenceConnect,
  presenceDisconnect,
} from '@/modules/websocket/services/presence.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { resolveQuestionRequest } from '@/modules/websocket/services/session-outcome.service.js';
// Namespace import (not named imports) for the SAME reason as the database
// barrel above: several unit tests module-mock this service with only the
// members they exercise (`addSessionMirror` + `WebSocketWriter`). A static named
// import of a member such member-mocks omit fails ESM linking outright, whereas
// a namespace binding is only dereferenced on the code path that uses it (the
// socket-close mirror cleanup guards its call). The class is additionally
// imported as a TYPE so the dependency signatures below stay unchanged.
import * as websocketWriterService from '@/modules/websocket/services/websocket-writer.service.js';
import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  parseIncomingJsonObject,
  validateWorkspacePath,
  readCodexCompletionProof,
} from '@/shared/utils.js';
import {
  bindSessionWorkspace,
  resolveSessionWorkspaceForLaunch,
} from '@/modules/session-workspaces/index.js';

import { reportWriterLeaseRefusal, withLocalUpdateWriterLease } from '../../../services/update-writer-lease.js';
// Top-level shared/ (compiled into dist-server/shared/) — the single source of
// truth for globally disabled providers (T-864). Relative on purpose: the `@/`
// alias maps to server/* only.
import { isProviderGloballyDisabled } from '../../../../shared/disabledProviders.js';
import {
  normalizeCoordinationLevel,
  type CoordinationLevel,
} from '../../../../shared/coordinationDirectives.js';

type ChatIncomingMessage = AnyRecord & {
  type?: string;
  command?: string;
  options?: AnyRecord;
  provider?: string;
  sessionId?: string;
  requestId?: string;
  allow?: unknown;
  updatedInput?: unknown;
  message?: unknown;
  rememberEntry?: unknown;
  lastSeq?: unknown;
};

const DEFAULT_PROVIDER: LLMProvider = 'claude';
const MAX_CHAT_IMAGES = 15;
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const CHAT_IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([a-zA-Z0-9+/]+={0,2})$/u;

type AttachmentIdentity =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'images'; fingerprint: string; dataUrls: string[] };

/** Validate and fingerprint the ordered image bytes received from the upload API. */
function readAttachmentIdentity(images: unknown): AttachmentIdentity {
  if (images === undefined || (Array.isArray(images) && images.length === 0)) return { kind: 'none' };
  if (!Array.isArray(images) || images.length > MAX_CHAT_IMAGES) return { kind: 'invalid' };
  const digests: string[] = [], dataUrls: string[] = [];
  for (const image of images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) return { kind: 'invalid' };
    const data = (image as AnyRecord).data;
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES * 4 / 3) + 64) {
      return { kind: 'invalid' };
    }
    const match = data.match(CHAT_IMAGE_DATA_URL);
    if (!match) return { kind: 'invalid' };
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.length > MAX_CHAT_IMAGE_BYTES
      || bytes.toString('base64') !== match[2]) return { kind: 'invalid' };
    digests.push(createHash('sha256').update(bytes).digest('hex'));
    dataUrls.push(data);
  }
  return {
    kind: 'images',
    fingerprint: createHash('sha256').update(JSON.stringify(digests)).digest('hex'),
    dataUrls,
  };
}

// T-881 (A-4): a per-USER concurrent /btw cap, shared across ALL of a user's
// sockets/tabs and layered ABOVE the per-socket single-flight guard. It stops one
// user from opening many tabs to spawn many simultaneous read-only forks (each a
// real Claude child process). The counter is incremented only once all gates pass
// and the fork is about to spawn, and released in every terminal path (success,
// error, timeout, interrupt, socket close) — see releaseBtw below.
const BTW_MAX_INFLIGHT_PER_USER = 2;
// Correlation ids should normally be UUIDs. 128 UTF-8 bytes leaves room for
// prefixed/custom clients without allowing an attacker-controlled echo payload.
const BTW_MAX_ID_BYTES = 128;
// A side question is a prompt, not an attachment. 32 KiB accommodates long code
// excerpts while bounding the App Server/SDK prompt and diagnostic path.
const BTW_MAX_QUESTION_BYTES = 32 * 1024;
const btwInFlightByUser = new Map<string, number>();

function btwUserKey(userId: string | number | null): string {
  return userId === null || userId === undefined ? '__anon__' : String(userId);
}
function btwUserInFlight(userId: string | number | null): number {
  return btwInFlightByUser.get(btwUserKey(userId)) ?? 0;
}
function acquireBtwUserSlot(userId: string | number | null): void {
  const key = btwUserKey(userId);
  btwInFlightByUser.set(key, (btwInFlightByUser.get(key) ?? 0) + 1);
}
function releaseBtwUserSlot(userId: string | number | null): void {
  const key = btwUserKey(userId);
  const next = (btwInFlightByUser.get(key) ?? 0) - 1;
  if (next <= 0) {
    btwInFlightByUser.delete(key);
  } else {
    btwInFlightByUser.set(key, next);
  }
}

// T-1090: the SAME shape of cap for `/btw` FORKS, kept on its own counter rather
// than sharing the side-query one. A fork spends no model quota — it copies a
// transcript — so it must not consume a query slot (nor be blocked by one), but
// it does write a file as large as the source (41 MB is a production-shaped synthetic transcripts size
// here), so a user with many tabs still cannot pile up unbounded copies.
const BTW_MAX_FORKS_PER_USER = 2;
const btwForksByUser = new Map<string, number>();

function btwUserForks(userId: string | number | null): number {
  return btwForksByUser.get(btwUserKey(userId)) ?? 0;
}
function acquireBtwForkSlot(userId: string | number | null): void {
  const key = btwUserKey(userId);
  btwForksByUser.set(key, (btwForksByUser.get(key) ?? 0) + 1);
}
function releaseBtwForkSlot(userId: string | number | null): void {
  const key = btwUserKey(userId);
  const next = (btwForksByUser.get(key) ?? 0) - 1;
  if (next <= 0) {
    btwForksByUser.delete(key);
  } else {
    btwForksByUser.set(key, next);
  }
}

/**
 * Test-only: clears the module-level per-user /btw in-flight counters between
 * unit tests. A unit test that leaves a fork "in flight" (a never-resolving spy)
 * would otherwise leak a per-user slot into the next test. Never used in prod.
 */
export function __resetBtwFloodStateForTests(): void {
  btwInFlightByUser.clear();
  btwForksByUser.clear();
}

type ChatWebSocketDependencies = {
  /** Source-update reader lease retained for the full provider process lifetime. */
  acquireWriterLease?: (kind: string) => Promise<{ release(): void }>;
  /** Server-authoritative permission admission. Production composition supplies this. */
  authorizeProviderExecution: (
    authenticatedPrincipal: unknown,
    context: CanonicalLaunchContext,
  ) => PermissionGatewayResult;
  /** Phase-0 observer only; it never dispatches or changes client payloads. */
  universalConversationShadow?: UniversalConversationShadowHook;
  /**
   * Core-issued authorization. The callback must resolve client locators
   * through authoritative project/session state and fail closed on any
   * unknown, mismatched, or non-writable scope.
   */
  authorizeUniversalConversationShadow?: (input: {
    principalId: string | number | null;
    clientMsgId: string;
    requestedProvider: string;
    requestedLegacySessionId: string | null;
    requestedProjectPath: string | null;
  }) => TrustedShadowAuthorization | null;
  /**
   * Separately verifies an emitted `session_created` physical reference. The
   * adapter payload is only a candidate; it is never link authority by itself.
   */
  attestUniversalConversationLegacySession?: (input: {
    authorization: TrustedShadowAuthorization;
    provider: string;
    legacySessionId: string;
  }) => TrustedLegacySessionAttestation | null;
  queryClaudeSDK: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnCursor: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  queryCodex: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGemini: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnAntigravity: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnOpenCode: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnHermes: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnKimi: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  /**
   * KM-3 (ADR-062 §4.2): the Kimi NATIVE agent launcher
   * (server/kimi-agent-cli.js → spawnKimiAgent), distinct from
   * `spawnKimi` (the toolless CHAT path, server/kimi-cli.js). OPTIONAL: injected by
   * the composition root only once the kimi-agent path is wired. When absent, a
   * kimi `mode==='agent'` turn is NOT eligible for the ADR-062 agent revival, so it
   * is never routed here and never bypasses the T-864 chat disable (no silent
   * downgrade). Every existing dependency harness that omits it keeps today's exact
   * behavior.
   */
  spawnKimiAgent?: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnDeepSeek: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGlm: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  /**
   * Server-owned mechanical coordinator for hosted, toolless harnesses. It is
   * optional so an unarmed deployment fails closed without changing direct
   * dispatch. Internal planner/worker/reviewer output never reaches this writer.
   */
  hostedTurnSupervisor?: {
    enabled(input: {
      provider: 'kimi' | 'deepseek' | 'glm' | 'claude';
      mode: 'chat' | 'agent';
    }): boolean;
    supports(input: {
      provider: 'kimi' | 'deepseek' | 'glm' | 'claude';
      mode: 'chat' | 'agent';
      coordinationLevel: CoordinationLevel;
      model?: string;
    }): boolean;
    execute(input: {
      provider: 'kimi' | 'deepseek' | 'glm' | 'claude';
      mode: 'chat' | 'agent';
      coordinationLevel: CoordinationLevel;
      model?: string;
      prompt: string;
      userId: number;
      clientMsgId: string;
      vendorReceiptInvocation?: object;
      sessionId: string | null;
      projectPath?: string;
      onSession: (sessionId: string, isNew: boolean) => void;
    }): Promise<{ text: string; model: string; sessionId: string; isNewSession: boolean }>;
    cancel(input: {
      provider: 'kimi' | 'deepseek' | 'glm' | 'claude';
      sessionId: string;
      userId: number | null;
    }): boolean;
  };
  /** Server-owned ephemeral CLI supervisor. Unsupported legacy CLI cells are
   * rejected before dispatch; they never fall back to textual coordination. */
  cliTurnSupervisor?: {
    enabledCell(input: { provider: string; mode: string }): boolean;
    supports(input: {
      provider: string; mode: string; coordinationLevel: CoordinationLevel; model?: string;
    }): boolean;
    execute(input: {
      provider: 'codex' | 'qwen' | 'opencode' | 'hermes'; mode: 'chat'; coordinationLevel: CoordinationLevel; model?: string;
      prompt: string; userId: number; clientMsgId: string; sessionId: string | null;
      projectPath?: string; onSession: (sessionId: string, isNew: boolean) => void;
    }): Promise<{ text: string; model: string; sessionId: string; isNewSession: boolean }>;
    cancel(input: { provider: 'codex' | 'qwen' | 'opencode' | 'hermes'; sessionId: string; userId: number | null }): boolean;
  };
  spawnQwen?: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  /**
   * Resolves the authoritative provider for an existing session from the
   * database. Returns null when the session is unknown (e.g. a brand-new
   * conversation that has not been persisted yet).
   */
  getSessionProvider: (sessionId: string) => LLMProvider | null;
  /**
   * T-881: runs a read-only /btw side query by FORKING the resumed live session
   * (resume + forkSession) — never registered in activeSessions, never fanned out
   * to mirrors. Streams the answer through the callbacks; the WS layer forwards
   * them to the requesting socket ALONE. Never rejects; invokes exactly one of
   * onError | onComplete.
   */
  spawnClaudeSideQuery: (
    params: {
      sessionId: string;
      question: string;
      upToMessageId: string | null;
      userId: string | number | null;
      authenticatedPrincipal: unknown;
      cwd: string | null;
    },
    callbacks: {
      // A-1: fired once with an interrupt handle when the fork is constructed, so
      // the socket-close handler can tear the fork down mid-flight.
      onStarted?: (handle: { interrupt: () => void }) => void;
      onChunk: (text: string) => void;
      onError: (code: string, message: string) => void;
      // B-270: carries the FULL accumulated answer so the terminal `btw-complete`
      // frame holds the whole text (survives dropped intermediate `btw-chunk`s).
      onComplete: (fullAnswer: string) => void;
    }
  ) => Promise<void>;
  spawnCodexSideQuery?: ChatWebSocketDependencies['spawnClaudeSideQuery'];
  /**
   * T-1090: promotes a finished `/btw` exchange into a REAL session by branching
   * the source transcript on disk and appending the question + the answer the
   * user already read. Injected (not imported) so this module's import graph
   * stays free of the sessions watcher/synchronizer, which several WS unit tests
   * would otherwise load for real. Rejects with a `SessionForkError`-shaped
   * error carrying `.code`; the handler maps it to a `btw-fork-error` frame.
   */
  forkSessionFromSideQuery: (params: {
    sessionId: string;
    question: string;
    answer: string;
    userId: number | null;
    upToMessageId: string | null;
    // T-1091: 'full' carries the whole conversation (the CLI's behaviour),
    // 'fresh' carries only the exchange. Always sent explicitly by this layer.
    mode: 'full' | 'fresh';
  }) => Promise<{
    sessionId: string;
    title: string;
    projectPath: string | null;
    mode?: 'full' | 'fresh';
  }>;
  /**
   * Creates a real Claude session from the persisted transcript prefix ending at
   * one selected assistant message. No client-supplied text is appended.
   */
  forkSessionAtMessage?: (params: {
    sessionId: string;
    upToMessageId: string;
    userId: number | null;
    requestId?: string;
    authenticatedPrincipal?: unknown;
    retryRegistrationOnly?: boolean;
    expectedForkedSessionId?: string;
  }) => Promise<{
    sessionId: string;
    title: string;
    projectPath: string | null;
  }>;
  abortClaudeSDKSession: (
    sessionId: string,
    rawWs?: unknown,
  ) => Promise<boolean | { aborted: boolean; reason: string; sessionId: string | null }>;
  abortCursorSession: (sessionId: string) => boolean;
  abortCodexSession: (sessionId: string) => boolean;
  abortGeminiSession: (sessionId: string) => boolean;
  abortAntigravitySession: (sessionId: string) => boolean;
  abortOpenCodeSession: (sessionId: string) => boolean;
  abortHermesSession: (sessionId: string) => boolean;
  abortKimiSession: (sessionId: string) => boolean;
  abortDeepSeekSession: (sessionId: string) => boolean;
  abortGlmSession: (sessionId: string) => boolean;
  abortQwenSession?: (sessionId: string) => boolean;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
      /**
       * B-SEC-APPROVAL-OWNERSHIP: the JWT-authenticated identity of the socket
       * that answered the prompt, stamped by the server (NEVER read from the
       * client payload). claude-sdk compares it against the owner captured when
       * the approval was created and refuses / downgrades a foreign answer.
       * Optional so every existing injection site keeps compiling; the single
       * production caller (below) always supplies it.
       */
      requesterUserId?: string | number | null;
    }
  ) => void | { resolved: boolean; sessionId: string | null };
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
  isCursorSessionActive: (sessionId: string) => boolean;
  isCodexSessionActive: (sessionId: string) => boolean;
  isGeminiSessionActive: (sessionId: string) => boolean;
  isAntigravitySessionActive: (sessionId: string) => boolean;
  isOpenCodeSessionActive: (sessionId: string) => boolean;
  isHermesSessionActive: (sessionId: string) => boolean;
  isKimiSessionActive: (sessionId: string) => boolean;
  isDeepSeekSessionActive: (sessionId: string) => boolean;
  isGlmSessionActive: (sessionId: string) => boolean;
  isQwenSessionActive?: (sessionId: string) => boolean;
  reconnectSessionWriter: (sessionId: string, ws: WebSocket) => boolean;
  /**
   * Returns true when the session's primary WebSocket is still OPEN (socket alive).
   * Used alongside isClaudeSDKSessionActive to detect an orphaned-but-active writer
   * (run still streaming but primary socket is dead) so a reconnecting socket can
   * safely claim the writer without SDK desync risk.
   */
  isPrimarySocketAlive: (sessionId: string) => boolean;
  /**
   * B-N-ATTACH (PHASE-SR-0): read-only differential replay for agy. Re-emits the
   * buffered payloads with `seq > lastSeq` via `send`, oldest-first, and returns
   * the highest seq replayed. It performs NO writer swap and NO session abort —
   * it strictly reads the per-session RingBuffer. No-op (returns lastSeq) when the
   * SESSION_REGISTRY_agy flag is off.
   */
  attachAntigravitySession: (
    sessionId: string,
    lastSeq: number,
    send: (payload: unknown) => void
  ) => number;
  /**
   * ADR-041 (B-80): read-only differential replay for claude — same contract as
   * attachAntigravitySession, on a separate SESSION_REGISTRY_claude-gated
   * registry instance. Re-emits buffered payloads with `seq > lastSeq` via
   * `send`, oldest-first, and returns the highest seq replayed. It performs NO
   * writer swap and NO session abort (the `if(!isActive)` no-swap veto stays
   * intact); it strictly reads the per-session RingBuffer. No-op (returns
   * lastSeq) when the SESSION_REGISTRY_claude flag is off.
   */
  attachClaudeSDKSession: (
    sessionId: string,
    lastSeq: number,
    send: (payload: unknown) => void
  ) => number;
  getPendingApprovalsForSession: (sessionId: string) => unknown[];
  getActiveClaudeSDKSessions: () => unknown;
  getActiveCursorSessions: () => unknown;
  getActiveCodexSessions: () => unknown;
  getActiveGeminiSessions: () => unknown;
  getActiveAntigravitySessions: () => unknown;
  getActiveOpenCodeSessions: () => unknown;
  getActiveHermesSessions: () => unknown;
  getActiveKimiSessions: () => unknown;
  getActiveDeepSeekSessions: () => unknown;
  getActiveGlmSessions: () => unknown;
  getActiveQwenSessions?: () => unknown;
};

/**
 * Normalizes potentially invalid provider names coming from websocket payloads.
 */
function readProvider(value: unknown): LLMProvider | null {
  if (
    value === 'claude'
    || value === 'cursor'
    || value === 'codex'
    || value === 'gemini'
    || value === 'antigravity'
    || value === 'opencode'
    || value === 'hermes'
    || value === 'kimi'
    || value === 'deepseek'
    || value === 'glm'
    || value === 'qwen'
  ) {
    return value;
  }

  return null;
}

/**
 * Resolves the authoritative provider for a session-scoped CONTROL message
 * (currently `abort-session`). Mirrors {@link dispatchProviderCommand}'s resume
 * routing: an existing session's persisted provider (the database source of
 * truth) wins over the client-declared provider, which on a control message may
 * carry the user's CURRENT global picker selection rather than THIS session's
 * provider (T-874(3)). Aborting through the wrong provider's handler silently
 * no-ops, leaving the run alive.
 *
 * Falls back to the client-declared provider for a brand-new or unpersisted
 * session — an empty or unknown id — which preserves the Claude empty-sessionId
 * abort-race handling (route to Claude and let it resolve the newest active run
 * on the connection).
 *
 * Exported for unit tests.
 */
export function resolveSessionControlProvider(
  sessionId: string,
  requestedProvider: LLMProvider | null,
  getSessionProvider: (sessionId: string) => LLMProvider | null
): LLMProvider | null {
  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!trimmed) {
    return requestedProvider;
  }
  return getSessionProvider(trimmed) ?? requestedProvider;
}

/**
 * Maps each chat command message type to the provider its payload was authored
 * for by the client. Used as the *default* routing target before the database
 * provider (the source of truth for resumed sessions) is consulted.
 */
const COMMAND_TYPE_TO_PROVIDER: Record<string, LLMProvider> = {
  'claude-command': 'claude',
  'cursor-command': 'cursor',
  'codex-command': 'codex',
  'gemini-command': 'gemini',
  'antigravity-command': 'antigravity',
  'hermes-command': 'hermes',
  'kimi-command': 'kimi',
  'deepseek-command': 'deepseek',
  'glm-command': 'glm',
  'qwen-command': 'qwen',
  'opencode-command': 'opencode',
};

/**
 * Reads the resume session id carried by a chat command payload. The client
 * places it on `options.sessionId` for every provider and additionally on the
 * top-level `sessionId` for the CLI providers, so we accept either form.
 */
function readResumeSessionId(data: ChatIncomingMessage): string | null {
  const options = (data.options ?? {}) as { sessionId?: unknown };
  const fromOptions = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (fromOptions) {
    return fromOptions;
  }

  const fromTop = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return fromTop || null;
}

/**
 * B-PRIV spawn guard. A run is started against `options.cwd` (a project path).
 * If that path maps to a KNOWN private project the user is not a member of, the
 * run is refused so a non-member cannot start a session inside a private
 * project's directory (which would also leak its content through the stream).
 *
 * Unregistered paths (no projects row yet) are allowed — that is the creation
 * flow, which records the spawner as the project's participant/creator. Returns
 * true when the spawn may proceed.
 */
function isSpawnProjectVisible(
  data: ChatIncomingMessage,
  userId: string | number | null
): boolean {
  const options = (data.options ?? {}) as { cwd?: unknown };
  const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
  return isProjectPathVisibleToUser(cwd, userId);
}

/**
 * Path-based form of the B-PRIV spawn guard, shared with the `/shell` PTY
 * handler (B-36): given a raw project path and the JWT-authenticated user id,
 * returns true when a run/terminal may be started inside that path. Empty and
 * unregistered paths are allowed (creation/first-run flow); a KNOWN private
 * project is only visible to its members.
 */
export function isProjectPathVisibleToUser(
  projectPath: string,
  userId: string | number | null
): boolean {
  const trimmedPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!trimmedPath) {
    return true;
  }

  const projectRow = databaseModule.projectsDb.getProjectPath(trimmedPath);
  if (!projectRow) {
    // Path not yet registered as a project — creation/first-run flow.
    return true;
  }

  return databaseModule.projectsDb.isProjectVisibleToUser(
    projectRow.project_id,
    toNumericUserId(userId)
  );
}

/**
 * Normalizes the JWT-derived socket identity to the integer the database
 * predicates expect, or null when it cannot be resolved (anonymous socket /
 * non-numeric id). Extracted verbatim from the visibility gate so the read and
 * write gates below coerce identically — a divergence here would silently make
 * one gate stricter than the other.
 */
function toNumericUserId(userId: string | number | null): number | null {
  const parsed =
    typeof userId === 'number'
      ? userId
      : typeof userId === 'string' && userId.trim() !== ''
        ? Number.parseInt(userId, 10)
        : null;
  return Number.isInteger(parsed) ? parsed : null;
}

type SharedWorkspaceAttestationInput = {
  logicalProjectPath: string;
  cwd: string;
  sessionId: string | null;
  clientProjectPath: string;
  principalId: string | number | null;
};

/** Re-attest a declared shared cwd immediately before provider dispatch. */
async function attestSharedSessionWorkspace(input: SharedWorkspaceAttestationInput): Promise<void> {
  const validation = await validateWorkspacePath(input.logicalProjectPath);
  if (!validation.valid || !validation.resolvedPath) {
    const error = new Error(validation.error ?? 'workspace path is unsafe') as NodeJS.ErrnoException;
    error.code = 'SESSION_WORKSPACE_PATH_UNSAFE';
    throw error;
  }
  let physicalPath: string;
  try {
    physicalPath = fs.realpathSync(input.logicalProjectPath);
  } catch (cause) {
    const error = new Error('shared workspace path is missing') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    error.cause = cause;
    throw error;
  }
  if (physicalPath !== validation.resolvedPath
      || physicalPath !== input.logicalProjectPath
      || physicalPath !== input.cwd) {
    const error = new Error('shared workspace canonical path changed') as NodeJS.ErrnoException;
    error.code = 'SESSION_WORKSPACE_PATH_UNSAFE';
    throw error;
  }
  if (input.clientProjectPath
      && fs.realpathSync(input.clientProjectPath) !== physicalPath) {
    const error = new Error('shared workspace client path mismatch') as NodeJS.ErrnoException;
    error.code = 'SESSION_WORKSPACE_PATH_UNSAFE';
    throw error;
  }

  const userId = toNumericUserId(input.principalId);
  const project = databaseModule.projectsDb.getProjectPath(physicalPath);
  if (userId == null || !project) {
    const error = new Error('shared workspace is not a registered writable project') as NodeJS.ErrnoException;
    error.code = 'SESSION_WORKSPACE_FORBIDDEN';
    throw error;
  }
  const authorized = input.sessionId
    ? (databaseModule.participantsDb.isParticipant(input.sessionId, userId) === true
      || databaseModule.projectsDb.isProjectWritableByUser(project.project_id, userId) === true)
    : databaseModule.projectsDb.isProjectWritableByUser(project.project_id, userId) === true;
  if (!authorized) {
    const error = new Error('shared workspace is not writable by this user') as NodeJS.ErrnoException;
    error.code = 'SESSION_WORKSPACE_FORBIDDEN';
    throw error;
  }
}

/**
 * WRITE authorization gate for the session-scoped CONTROL messages that MUTATE
 * somebody's live run — `abort-session` and `cursor-abort` today.
 *
 * `isSessionVisibleToUser` (B-137) is a READ predicate: it returns true for every
 * PUBLIC project to any authenticated team member, which is correct for
 * mirroring/attaching a stream but far too weak for killing a run. Gating an
 * abort on it alone let any authenticated user stop any teammate's work (and,
 * before this gate existed, ANY user's run — the abort handlers took a raw
 * client-supplied sessionId with no check at all).
 *
 * Layered exactly like the REST write gate (B-138 `isProjectWritableByUser`):
 *   1. the READ gate must pass first (a session in a project the user cannot see
 *      is refused with the same 404-equivalent, never disclosed);
 *   2. then MEMBERSHIP, not visibility, decides: a participant/author of THIS
 *      session (B-105 `participantsDb.isParticipant` — the spawner is recorded by
 *      every provider's run path at spawn time, so the run's own owner always
 *      passes), or a creator/member/participant of the owning project.
 *
 * Fail-OPEN cases are exactly the two the read gate already documents, and for
 * the same reason — there is nothing to protect and refusing would break a
 * legitimate flow:
 *   - an EMPTY sessionId: the claude abort path resolves it against the newest
 *     active run on THIS SOCKET (the brand-new-session STOP race), so it is
 *     connection-scoped by construction; every other provider does an exact map
 *     lookup that an empty id can never match;
 *   - a session that resolves to no known project row (unpersisted brand-new run
 *     — the run path outruns the synchronizer): no membership data exists yet,
 *     and its SDK-generated id has never left its own socket/mirrors.
 * Everything else fails CLOSED, including an unresolvable (anonymous) user id on
 * a KNOWN project and any database error inside the membership probes.
 *
 * Exported for unit tests.
 */
export function isSessionWritableByUser(
  sessionId: string,
  userId: string | number | null
): boolean {
  if (!sessionId) {
    return true;
  }

  // (1) Read gate first — never disclose, never widen.
  if (!isSessionVisibleToUser(sessionId, userId)) {
    return false;
  }

  let projectPath = '';
  try {
    projectPath = databaseModule.sessionsDb.getSessionById(sessionId)?.project_path ?? '';
  } catch {
    projectPath = '';
  }
  if (!projectPath.trim()) {
    return true;
  }

  let projectRow: { project_id: string } | null = null;
  try {
    projectRow = databaseModule.projectsDb.getProjectPath(projectPath.trim()) ?? null;
  } catch {
    projectRow = null;
  }
  if (!projectRow) {
    return true;
  }

  // (2) Known project ⇒ membership-based write gate, fail-closed from here on.
  const numericUserId = toNumericUserId(userId);
  if (numericUserId === null) {
    return false;
  }

  try {
    if (databaseModule.participantsDb.isParticipant(sessionId, numericUserId)) {
      return true;
    }
  } catch {
    // Fall through to the project-level predicate rather than fail-open.
  }

  try {
    return databaseModule.projectsDb.isProjectWritableByUser(projectRow.project_id, numericUserId);
  } catch {
    return false;
  }
}

/**
 * B-137 content-visibility gate for the realtime session paths that take a
 * client-supplied sessionId and expose a session's LIVE stream to the requesting
 * socket — the `check-session-status` mirror/attach/reconnect handler and the
 * `get-active-sessions` listing. Unlike the spawn guard there is no cwd on these
 * paths, so the session is resolved to its project_path (the sessions table) and
 * the SAME project-visibility predicate the spawn guard uses
 * (`isProjectPathVisibleToUser`) is applied: a public project's live session
 * stays visible to the team (the legitimate refreshed-tab / second-viewer case
 * the mirror exists for), while a private project's session is only
 * mirrored/attached/listed for a member (ADR-052).
 *
 * Fail-OPEN only when the session resolves to no known project_path — an
 * unpersisted brand-new session (the run path can outrace the synchronizer) or a
 * null-path session carries no private-project association to protect, matching
 * the spawn guard's unregistered-path allowance and the presence layer's
 * treatment of null-path runs. The lookup is wrapped so a database hiccup never
 * throws on the realtime path (same discipline as participation tracking): an
 * unresolved lookup falls through to that unregistered-path allowance. The actual
 * exploit path — a KNOWN private session whose row resolves — never errors, so
 * the guarantee against a non-member is not weakened by the fail-open.
 */
export function isSessionVisibleToUser(
  sessionId: string,
  userId: string | number | null
): boolean {
  if (!sessionId) {
    return true;
  }

  let projectPath = '';
  try {
    projectPath = databaseModule.sessionsDb.getSessionById(sessionId)?.project_path ?? '';
  } catch {
    return true;
  }

  // Empty / unregistered project_path defers to the unregistered-path allowance
  // inside isProjectPathVisibleToUser (returns true); a KNOWN private project is
  // only visible to its members there.
  return isProjectPathVisibleToUser(projectPath, userId);
}

/**
 * Dispatches a chat command to the handler that owns the resolved provider.
 *
 * Routing is provider-driven, not message-type-driven: when a command carries a
 * resume session id, the persisted provider for that session (looked up in the
 * database) overrides the message type chosen by the client. This prevents a
 * stale client provider selection from resuming, say, an antigravity session
 * through the Claude SDK — which would fail with "No conversation found".
 *
 * Globally disabled providers (T-864, shared/disabledProviders.ts) are refused
 * here — defence in depth behind the UI filtering. The check runs on the
 * RESOLVED target provider so it also covers a resume of a historical session
 * that belongs to a now-disabled provider (its transcript stays readable over
 * the REST history path; only new runs are blocked).
 *
 * Exported for unit tests.
 */

/**
 * GL-8 (ADR-062): reads the fleet flag that gates the GLM OpenCode carrier. The
 * SINGLE SOURCE OF TRUTH lives in server/opencode-cli.js (isOpenCodeCarrierEnabled);
 * this websocket module cannot import that CLI directly (it stays decoupled behind
 * dependency injection), so the identical predicate is duplicated here as a tiny
 * pure reader kept byte-aligned with the launcher's normalization. Default OFF: an
 * unset / blank / non-truthy flag NEVER enables the carrier, so a GLM `agent` turn
 * is not eligible and falls through to the unchanged (disabled/chat) path.
 *
 * Exported for unit tests.
 */
export function isOpenCodeCarrierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env?.NASSAJ_OPENCODE_CARRIER;
  if (typeof raw !== 'string') {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * KM-3/GL-8: true when a command explicitly requests the governed AGENT mode
 * (`options.mode === 'agent'`). Absent/any-other value is the default CHAT mode,
 * so an untouched client payload keeps today's exact routing.
 */
function isAgentModeRequested(data: ChatIncomingMessage): boolean {
  const options = (data.options ?? {}) as { mode?: unknown };
  return options.mode === 'agent';
}

function hostedProvider(provider: string): provider is 'kimi' | 'deepseek' | 'glm' {
  return provider === 'kimi' || provider === 'deepseek' || provider === 'glm';
}

function mechanicallyCoordinatedCliProvider(provider: string): provider is 'codex' | 'qwen' | 'opencode' | 'hermes' {
  return provider === 'codex' || provider === 'qwen' || provider === 'opencode' || provider === 'hermes';
}

export function abortCliSupervisedTurn(
  supervisor: ChatWebSocketDependencies['cliTurnSupervisor'],
  provider: string | null,
  sessionId: string,
  userId: number | null,
): boolean {
  return Boolean(
    supervisor && provider && mechanicallyCoordinatedCliProvider(provider) && sessionId
    && supervisor.cancel({ provider, sessionId, userId }),
  );
}

/** Shared abort bridge: supervised HTTP turns are asked first; a false result
 * lets the caller preserve the legacy hosted-session abort path. */
export function abortHostedSupervisedTurn(
  supervisor: ChatWebSocketDependencies['hostedTurnSupervisor'],
  provider: string | null,
  sessionId: string,
  userId: number | null,
): boolean {
  return Boolean(
    supervisor
    && provider
    && (hostedProvider(provider) || provider === 'claude')
    && sessionId
    && supervisor.cancel({ provider, sessionId, userId }),
  );
}

/**
 * Reads the per-turn coordination request from the same options envelope as
 * composer mode. Absence uses the product default (`delegate`); an explicit
 * unknown value still fails closed to `direct`.
 */
function readCoordinationLevel(data: ChatIncomingMessage): CoordinationLevel {
  const options = (data.options ?? {}) as { coordinationLevel?: unknown };
  return normalizeCoordinationLevel(options.coordinationLevel);
}

function withCoordinationMetadata(
  writer: WebSocketWriter,
  data: ChatIncomingMessage,
  principalId: string | number | null,
  knownSessionId: string | null,
  provider: string,
  coordinationLevel: CoordinationLevel,
): WebSocketWriter {
  const options = (data.options ?? {}) as { clientMsgId?: unknown };
  const clientMsgId = normalizeBoundedOptionalText(options.clientMsgId, 128);
  const userId = toNumericUserId(principalId);
  let boundSessionId: string | null = null;
  const bind = (sessionId: string | null): void => {
    if (boundSessionId || !sessionId || !clientMsgId || userId == null) return;
    if (databaseModule.messageCoordinationDb?.bindSession(clientMsgId, userId, sessionId, provider) === true) {
      boundSessionId = sessionId;
    }
  };
  return transparentWriterWithSend(writer, (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') {
      writer.send(payload);
      return;
    }
    const event = payload as Record<string, unknown>;
    const matchesTurn = (!Object.hasOwn(event, 'clientMsgId') || event.clientMsgId === clientMsgId)
      && (!Object.hasOwn(event, 'provider') || event.provider === provider)
      && (!knownSessionId || !event.sessionId || event.sessionId === knownSessionId)
      && (!boundSessionId || !event.sessionId || event.sessionId === boundSessionId)
      && (!event.actualSessionId || event.actualSessionId === (boundSessionId ?? knownSessionId))
      && (!event.newSessionId || !event.sessionId || event.newSessionId === event.sessionId);
    const isTerminalEvent = event.kind === 'complete' || event.kind === 'error';
    const provesNotStarted = event.notStarted === true || event.code === 'session_busy';
    const enriched = {
      ...event,
      ...(Object.hasOwn(event, 'coordinationLevel') ? {} : { coordinationLevel }),
      ...(event.code === 'session_busy' && event.notStarted !== true ? { notStarted: true } : {}),
      ...(isTerminalEvent ? { sameClientMsgIdRetryable: provesNotStarted } : {}),
    };
    try {
      if (matchesTurn) bind(knownSessionId);
      if (matchesTurn && event.kind === 'session_created') {
        bind(normalizeBoundedOptionalText(event.sessionId ?? event.newSessionId, 256));
      }
      if (matchesTurn && clientMsgId && userId != null) {
        // Claude acceptance comes from raw trusted SDK model frames, never synthetic normalized text.
        if (provider !== 'claude' && boundSessionId && isModelActivityFrame(event)) {
          databaseModule.messageCoordinationDb?.markStarted?.({ clientMsgId, userId, provider, sessionId: boundSessionId });
        }
        if (isTerminalEvent && (boundSessionId || provesNotStarted || !knownSessionId)) {
          const durableVerdict = clientMsgId && !Object.hasOwn(enriched, 'clientMsgId')
            ? { ...enriched, clientMsgId }
            : enriched;
          const codexUserProof = provider === 'codex' && event.kind === 'complete' ? readCodexCompletionProof(event) : undefined;
          databaseModule.messageCoordinationDb?.recordVerdict?.(
            { clientMsgId, userId, provider, sessionId: boundSessionId ?? knownSessionId },
            provesNotStarted ? 'not_started' : 'terminal',
            codexUserProof ? { ...durableVerdict, codexUserProof } : durableVerdict,
          );
        }
      }
    } catch (error) {
      // B-726/B-727: coordination metadata is a replay sidecar, never the
      // transport itself. A legacy DB missing its newly-added lifecycle columns
      // must not swallow model activity or the terminal complete/error frame;
      // otherwise process teardown invents a false silent-stop error.
      console.error('Failed to persist message coordination metadata', {
        clientMsgId,
        eventKind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const { codexUserProof: _privateCodexProof, ...publicEvent } = enriched as typeof enriched & { codexUserProof?: unknown };
      writer.send(publicEvent);
    }
  });
}

/**
 * T-1295 — صدى هوية الجولة التي ولّدها العميل (`options.clientMsgId`).
 *
 * يُنشَر بـ`...` على حمولات **الرفض قبل الإقلاع** الصادرة من هذه الطبقة: مزوّد
 * مُعطَّل، ومشروع غير مرئي. هاتان الحمولتان `kind:'complete'` بـ`success:false`،
 * ولولا الصدى لبقي إدخال صندوق الصادر معلَّقاً إلى الأبد — الرسالة رُفضت ولن
 * يصل عنها حكمٌ آخر أبداً.
 *
 * كائن لا سلسلة: عميلٌ لم يُرسل الحقل يُنتج `{}`، فالحمولة تبقى كما هي حرفياً.
 */
function clientMsgIdEcho(data: ChatIncomingMessage): Record<string, string> {
  const options = (data.options ?? {}) as { clientMsgId?: unknown };
  return typeof options.clientMsgId === 'string' && options.clientMsgId
    ? { clientMsgId: options.clientMsgId }
    : {};
}

/** Capture only bounded command identifiers, never the socket's mutable writer identity. */
/**
 * B-1298(b): the only provider error codes allowed to reach the client from a
 * rejected run. An allowlist guarantees no provider message, URL or key can ever be
 * echoed through this field — an unknown value is dropped rather than forwarded.
 */
const CLIENT_SAFE_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  'provider_auth_failed',
  'provider_context_overflow',
]);

/** Extracts a client-safe provider error code from a rejected run, else null. */
function readProviderErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('providerErrorCode' in error)) return null;
  const code = (error as { providerErrorCode?: unknown }).providerErrorCode;
  return typeof code === 'string' && CLIENT_SAFE_PROVIDER_ERROR_CODES.has(code) ? code : null;
}

function readFailedCommandIdentity(data: ChatIncomingMessage): Record<string, string> | null {
  const type = data.type;
  if (typeof type !== 'string' || !(Object.hasOwn(COMMAND_TYPE_TO_PROVIDER, type)
    || type === 'cursor-resume')) return null;
  if (!data.options || typeof data.options !== 'object' || Array.isArray(data.options)
    || (data.command !== undefined && typeof data.command !== 'string')) return null;
  const id = data.options.clientMsgId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) return null;
  const sessionId = readResumeSessionId(data);
  if (sessionId && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(sessionId)) return null;
  return {
    clientMsgId: id,
    provider: COMMAND_TYPE_TO_PROVIDER[type] ?? 'cursor',
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * ‏B-553/م1 — الحمولات التي يُبنى عليها حكمُ صندوق الصادر، ولا شيء غيرها.
 *
 * ‏`session_created` قبولٌ مؤكَّد (الجولة بدأت والرسالة في سجلّها)، و`complete`
 * و`error` حكمان نهائيان. أما نشاط النموذج الحي (نص/تفكير/نداء أداة) فهو دليل
 * الاستجابة الأول: يحتاجه العميل لربط زمن أول استجابة بالرسالة التي أطلقت هذه
 * الجولة، لا بالتخمين من ترتيب السجل. لا نوسم صدى المستخدم ولا `tool_result`؛
 * فهما ليسا بداية استجابة من النموذج.
 */
const OUTBOX_VERDICT_KINDS: ReadonlySet<string> = new Set([
  'session_created',
  'complete',
  'error',
]);

/**
 * Whether a live frame proves that the model has started this turn.
 *
 * Codex does not emit `stream_delta`: its first observable output can be an
 * `item` normalized as assistant `text`, `thinking`, or `tool_use`.  Limiting
 * the turn identity to deltas made the browser fall back to transcript order
 * and associate historical replies with the latest prompt.  Keep this check
 * deliberately allow-listed: a user echo and a tool result must never start a
 * response timer.
 */
function isModelActivityFrame(payload: { kind?: unknown; role?: unknown }): boolean {
  const kind = String(payload.kind ?? '');
  if (kind === 'stream_delta' || kind === 'thinking' || kind === 'tool_use') {
    return true;
  }
  if (kind === 'text') {
    return payload.role === 'assistant';
  }

  // Legacy/raw provider frames that have not crossed a sessions adapter yet.
  // They are named assistant artifacts, unlike a `tool_result` or user echo.
  return kind === 'agent_message' || kind === 'commentary' || kind === 'reasoning' || kind === 'tool';
}

/**
 * ‏B-553/م1 — يُلبس الكاتبَ هويةَ الجولة، فيصدي بها كلُّ مزوّد بلا أن يعلم.
 *
 * العلّة المقيسة (مراجعة qa-critic 2026-08-07): `clientMsgId` كان يُصدَّى في
 * `claude-sdk.js` وحده. وتسعة مزوّدات — codex وgemini وcursor وkimi وhermes
 * وopencode وagy وdeepseek والحامل — تبعث أحداثها عاريةً،
 * فإدخالُ صندوق الصادر عندها **لا يُقبل ولا يفشل أبداً**: يبقى معلَّقاً حتى
 * تنقضي اثنتا عشرة ساعة، وإن كان أُرسل من محادثة جديدة بقي يتيماً (‏`sessionId:
 * null`) فظهر على **كل** شاشة محادثة جديدة — وهو ما رآه المالك.
 *
 * والعلاج هنا لا في تسعة ملفات: كلّها تُرسل عبر هذا الكاتب، فلفّةٌ واحدة حول
 * ‏`send` تكفي. ولفّةٌ **لكل جولة** لا خريطةٌ على المقبس: المقبس الواحد قد
 * يشغّل جولتين على محادثتين، فمعرّفٌ واحد مخزَّن عليه كان سيُذيّل حكمَ هذه
 * بهوية تلك — فيُحذف إدخالُ رسالةٍ لم تصل. اللفّة تحمل هوية جولتها وحدها،
 * فالخلط ممتنعٌ بنيوياً لا بالحذر.
 *
 * ولا تدهس ما وضعه المزوّد بنفسه (claude يضعه): الموجود أدقّ من المفروض.
 * بهذا يملك كل `stream_delta` رابط الجولة الدقيق نفسه الذي استلمه المشغّل؛
 * لا ننشئ علاقة محفوظة في التاريخ ولا نستنتجها من رسالة سابقة.
 */
function transparentWriterWithSend(
  writer: WebSocketWriter,
  send: (payload: unknown) => void,
): WebSocketWriter {
  return new Proxy(writer, {
    get(target, property): unknown {
      if (property === 'send') return send;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    set(target, property, value): boolean {
      return Reflect.set(target, property, value, target);
    },
    defineProperty(target, property, descriptor): boolean {
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property): boolean {
      return Reflect.deleteProperty(target, property);
    },
  }) as WebSocketWriter;
}

function withClientMsgIdEcho(writer: WebSocketWriter, data: ChatIncomingMessage): WebSocketWriter {
  const echo = clientMsgIdEcho(data);
  if (!echo.clientMsgId) {
    return writer;
  }
  return transparentWriterWithSend(writer, (payload: unknown): void => {
    if (
      payload
      && typeof payload === 'object'
      && (
        OUTBOX_VERDICT_KINDS.has(String((payload as { kind?: unknown }).kind))
        || isModelActivityFrame(payload as { kind?: unknown; role?: unknown })
      )
      && !(payload as { clientMsgId?: unknown }).clientMsgId
    ) {
      writer.send({ ...(payload as Record<string, unknown>), ...echo });
      return;
    }
    writer.send(payload);
  });
}

function normalizeBoundedOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  const normalized = value.trim();
  return normalized || null;
}

function readOwnEnumerableDataValue(payload: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(payload, field);
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

function shadowErrorCode(error: unknown): string {
  try {
    if (!error || typeof error !== 'object') return 'SHADOW_ACCEPT_FAILED';
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code = descriptor && 'value' in descriptor ? descriptor.value : null;
    return typeof code === 'string'
      && code.length > 0
      && code.length <= 128
      && /^[A-Z0-9_:-]+$/.test(code)
      ? code
      : 'SHADOW_ACCEPT_FAILED';
  } catch {
    return 'SHADOW_ACCEPT_FAILED';
  }
}

function readOwnBoundedString(value: object, field: string, maxLength: number): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && 'value' in descriptor
      && typeof descriptor.value === 'string'
      && descriptor.value.length <= maxLength
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function readOwnMethod<T extends (...args: never[]) => unknown>(
  value: object,
  field: string,
): T | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'function'
      ? descriptor.value.bind(value) as T
      : null;
  } catch {
    return null;
  }
}

type ActiveShadowObservation = {
  shadow: UniversalConversationShadowHook;
  principalId: string | number | null;
  conversationId?: string;
  runId?: string;
  markLegacyDispatchStarted: (() => void) | null;
  finishLegacyDispatch: (() => void) | null;
  recordLegacyFailure: ((code: string) => void) | null;
};

const activeShadowByWriter = new WeakMap<object, ActiveShadowObservation>();

function recordShadowFailureSafely(
  shadow: UniversalConversationShadowHook,
  input: Parameters<UniversalConversationShadowHook['recordHookFailure']>[0],
): void {
  try {
    shadow.recordHookFailure(input);
  } catch {
    // Metrics are subordinate to the legacy path; even an injected faulty
    // metrics implementation cannot turn a successful dispatch into a failure.
  }
}

async function runLegacyProviderCallWithShadow(
  writer: WebSocketWriter,
  call: () => Promise<unknown>,
): Promise<void> {
  const active = activeShadowByWriter.get(writer);
  if (active?.markLegacyDispatchStarted) {
    try {
      active.markLegacyDispatchStarted();
    } catch {
      recordShadowFailureSafely(active.shadow, {
        principalId: active.principalId,
        phase: 'observe',
        code: 'SHADOW_DISPATCH_MARK_FAILED',
        conversationId: active.conversationId,
        runId: active.runId,
      });
    }
  }
  try {
    await call();
  } catch (error) {
    if (active?.recordLegacyFailure) {
      try {
        active.recordLegacyFailure('LEGACY_PROVIDER_THROW_WITHOUT_VERDICT');
      } catch {
        recordShadowFailureSafely(active.shadow, {
          principalId: active.principalId,
          phase: 'observe',
          code: 'SHADOW_PROVIDER_FAILURE_RECORDING_FAILED',
          conversationId: active.conversationId,
          runId: active.runId,
        });
      }
    }
    throw error;
  } finally {
    if (active?.finishLegacyDispatch) {
      try {
        active.finishLegacyDispatch();
      } catch {
        recordShadowFailureSafely(active.shadow, {
          principalId: active.principalId,
          phase: 'observe',
          code: 'SHADOW_DISPATCH_FINISH_FAILED',
          conversationId: active.conversationId,
          runId: active.runId,
        });
      }
    }
  }
}

/**
 * Starts the optional Phase-0 shadow acceptance before legacy dispatch and
 * observes only safe response envelopes. Every failure is isolated: the exact
 * writer supplied by the legacy path is returned when shadow recording fails.
 */
export function withUniversalConversationShadow(
  messageType: string,
  data: ChatIncomingMessage,
  writer: WebSocketWriter,
  principalId: string | number | null,
  dependencies: ChatWebSocketDependencies,
): WebSocketWriter {
  const shadow = dependencies.universalConversationShadow;
  if (!shadow) return writer;
  try {
    if (!shadow.isEnabled()) return writer;
  } catch {
    recordShadowFailureSafely(shadow, {
      principalId,
      phase: 'accept',
      code: 'SHADOW_ENABLEMENT_CHECK_FAILED',
    });
    return writer;
  }
  if (messageType === 'cursor-resume') return writer;

  const requestedProvider =
    COMMAND_TYPE_TO_PROVIDER[messageType]
    ?? (messageType === 'opencode-command' ? 'opencode' : 'cursor');
  const legacySessionId = readResumeSessionId(data);
  const selectedProvider = legacySessionId
    ? dependencies.getSessionProvider(legacySessionId) ?? requestedProvider
    : requestedProvider;
  const options = (data.options ?? {}) as {
    clientMsgId?: unknown;
    cwd?: unknown;
    model?: unknown;
  };
  const clientMsgId = normalizeBoundedOptionalText(options.clientMsgId, 128);
  if (!clientMsgId) {
    recordShadowFailureSafely(shadow, {
      principalId,
      phase: 'accept',
      code: 'MISSING_CLIENT_MSG_ID',
    });
    return writer;
  }
  let authorization: TrustedShadowAuthorization | null = null;
  try {
    authorization = dependencies.authorizeUniversalConversationShadow?.({
      principalId,
      clientMsgId,
      requestedProvider: selectedProvider,
      requestedLegacySessionId: legacySessionId,
      requestedProjectPath: normalizeBoundedOptionalText(options.cwd, 8_192),
    }) ?? null;
  } catch {
    recordShadowFailureSafely(shadow, {
      principalId,
      phase: 'accept',
      code: 'SHADOW_AUTHORIZER_FAILED',
    });
    return writer;
  }
  if (!authorization) {
    recordShadowFailureSafely(shadow, {
      principalId,
      phase: 'accept',
      code: 'UNVERIFIED_SHADOW_AUTHORIZATION',
    });
    return writer;
  }

  try {
    const handle = shadow.beginLegacyTurn({
      principalId,
      clientMsgId,
      requestedProvider: selectedProvider,
      requestedModel: normalizeBoundedOptionalText(options.model, 128),
      command: data.command ?? '',
      authorization,
    });
    if (!handle || typeof handle !== 'object') return writer;
    const observeLegacyPayload = readOwnMethod<(
      payload: unknown,
      attestation?: TrustedLegacySessionAttestation | null,
      context?: { preInspectionFailed?: boolean },
    ) => void>(handle, 'observeLegacyPayload');
    if (!observeLegacyPayload) return writer;
    const active: ActiveShadowObservation = {
      shadow,
      principalId,
      conversationId: readOwnBoundedString(handle, 'conversationId', 128),
      runId: readOwnBoundedString(handle, 'runId', 128),
      markLegacyDispatchStarted: readOwnMethod<() => void>(handle, 'markLegacyDispatchStarted'),
      finishLegacyDispatch: readOwnMethod<() => void>(handle, 'finishLegacyDispatch'),
      recordLegacyFailure: readOwnMethod<(code: string) => void>(handle, 'recordLegacyFailure'),
    };

    const observed = transparentWriterWithSend(writer, (payload: unknown): void => {
      let attestation: TrustedLegacySessionAttestation | null = null;
      let preInspectionFailed = false;
      try {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const kind = normalizeBoundedOptionalText(
            readOwnEnumerableDataValue(payload, 'kind'),
            64,
          );
          const emittedSessionId = normalizeBoundedOptionalText(
            readOwnEnumerableDataValue(payload, 'sessionId'),
            512,
          ) ?? normalizeBoundedOptionalText(
            readOwnEnumerableDataValue(payload, 'newSessionId'),
            512,
          );
          if (authorization.kind === 'resume' && kind === 'session_created' && emittedSessionId) {
            try {
              attestation = dependencies.attestUniversalConversationLegacySession?.({
                authorization,
                provider: selectedProvider,
                legacySessionId: emittedSessionId,
              }) ?? null;
            } catch {
              recordShadowFailureSafely(shadow, {
                principalId,
                phase: 'observe',
                code: 'SHADOW_ATTESTER_FAILED',
                conversationId: active.conversationId,
                runId: active.runId,
              });
            }
          }
        }
      } catch {
        preInspectionFailed = true;
        recordShadowFailureSafely(shadow, {
          principalId,
          phase: 'observe',
          code: 'SHADOW_PRE_INSPECTION_FAILED',
          conversationId: active.conversationId,
          runId: active.runId,
        });
      }
      try {
        observeLegacyPayload(payload, attestation, { preInspectionFailed });
      } catch {
        recordShadowFailureSafely(shadow, {
          principalId,
          phase: 'observe',
          code: 'SHADOW_OBSERVER_FAILED',
          conversationId: active.conversationId,
          runId: active.runId,
        });
      } finally {
        writer.send(payload);
      }
    });
    activeShadowByWriter.set(observed, active);
    return observed;
  } catch (error) {
    const code = shadowErrorCode(error);
    recordShadowFailureSafely(shadow, {
      principalId,
      phase: 'accept',
      code,
    });
    console.warn('[universal-conversation-shadow] acceptance isolated from legacy dispatch', {
      code,
    });
    return writer;
  }
}

export async function dispatchProviderCommand(
  messageType: string,
  data: ChatIncomingMessage,
  writer: WebSocketWriter,
  dependencies: ChatWebSocketDependencies,
  principalId: string | number | null = null,
  authenticatedPrincipal: unknown = null,
): Promise<void> {
  const command = typeof data.command === 'string' ? data.command : '';
  const invalidCommand = data.command !== undefined && typeof data.command !== 'string';
  const requestedProvider = COMMAND_TYPE_TO_PROVIDER[messageType]
    ?? (messageType === 'opencode-command' ? 'opencode' : messageType === 'cursor-resume' ? 'cursor' : null);

  // B-553/م1: من هنا فصاعداً كلُّ ما يخرج إلى العميل يحمل هوية هذه الجولة —
  // فيصير حكمُ صندوق الصادر واصلاً على المزوّدات التسعة التي لا تصدي بنفسها.
  writer = withClientMsgIdEcho(writer, data);

  // Only existing (resumed) sessions can be re-routed; a fresh conversation has
  // no persisted provider yet, so we honour the client's chosen handler.
  const resumeSessionId = readResumeSessionId(data);
  const persistedProvider = resumeSessionId
    ? dependencies.getSessionProvider(resumeSessionId)
    : null;
  const targetProvider = persistedProvider ?? requestedProvider;

  if (!targetProvider) {
    writer.send({
      kind: 'complete',
      exitCode: 1,
      success: false,
      error: `Message type "${messageType}" has no provider runtime handler.`,
      ...clientMsgIdEcho(data),
      notStarted: true,
    });
    return;
  }

  if (persistedProvider && persistedProvider !== requestedProvider) {
    console.log(
      `[INFO] Re-routing resumed session ${resumeSessionId} from `
      + `${requestedProvider} to persisted provider ${persistedProvider}`
      + (data.options?.effort ? ` (effort=${data.options.effort} will be dropped)` : '')
    );
  }

  // KM-3/GL-8 (ADR-062): a GOVERNED agent run for kimi/glm is the ADR-062 revival
  // of these ids AS agent environments and is therefore NOT subject to the T-864
  // "plain API vendor" global disable — that disable blocks only their toolless
  // CHAT surface. The bypass is kept as NARROW as the actually-available agent
  // launcher, so nothing is re-enabled by accident:
  //   • kimi: only when the native agent launcher is actually wired
  //     (spawnKimiAgent injected). An unwired deployment gets NO bypass — the run
  //     is refused rather than silently downgraded to the disabled chat path.
  //   • glm : only when the OpenCode carrier fleet flag is armed
  //     (NASSAJ_OPENCODE_CARRIER). Flag OFF ⇒ no bypass ⇒ glm stays refused, which
  //     is exactly "flag OFF does not enable glm".
  // Chat mode (no `mode`), and any agent request whose path is unavailable, keep
  // the existing disable/refuse behavior.
  //
  // 2026-07-26 (owner decision, the GLM fold): `glm` is back in DISABLED_PROVIDERS
  // — not as "a vendor we switched off" but because it is not an agent SYSTEM at
  // all: no CLI, no tools, no sessions of its own. It is now reached only as an
  // OpenCode model (`glm/*`), so nothing NEW arrives here under the `glm` id. This
  // bypass survives for the sessions that predate the fold: a historical GLM agent
  // session keeps running through its carrier instead of dying with its card,
  // while a GLM chat turn (the tool-less raw-HTTP `spawnGlm` body) is refused.
  const agentRequested = isAgentModeRequested(data);
  const kimiAgentRun =
    agentRequested
    && targetProvider === 'kimi'
    && typeof dependencies.spawnKimiAgent === 'function';
  const glmCarrierRun =
    agentRequested
    && targetProvider === 'glm'
    && isOpenCodeCarrierEnabled();
  const immutableCoordinationLevel = readCoordinationLevel(data);
  const hostedMode = agentRequested ? 'agent' : 'chat';
  const requestedModel = typeof data.options?.model === 'string' && data.options.model.trim()
    ? data.options.model.trim()
    : undefined;
  const hostedSupervisorCellEnabled =
    (hostedProvider(targetProvider) || targetProvider === 'claude')
    && dependencies.hostedTurnSupervisor?.enabled({
      provider: targetProvider, mode: hostedMode,
    }) === true;
  const requestsHostedSupervision = hostedSupervisorCellEnabled;
  const hostedSupervisionSupported = requestsHostedSupervision
    && dependencies.hostedTurnSupervisor?.supports({
      provider: targetProvider,
      mode: hostedMode,
      coordinationLevel: immutableCoordinationLevel,
      model: requestedModel,
    }) === true;
  const cliSupervisionSupported = mechanicallyCoordinatedCliProvider(targetProvider)
    && dependencies.cliTurnSupervisor?.supports({
      provider: targetProvider,
      mode: hostedMode,
      coordinationLevel: immutableCoordinationLevel,
      model: requestedModel,
    }) === true;
  const cliCellEnabled = dependencies.cliTurnSupervisor?.enabledCell({
    provider: targetProvider, mode: hostedMode,
  }) === true;

  // An OFF cell is completely inert and preserves the legacy provider path.
  // Once armed, every advertised coordination level (including direct) is
  // mechanical; an unsupported armed request is refused before provider start.
  if (requestsHostedSupervision && !hostedSupervisionSupported) {
    writer.send(createNormalizedMessage({
      kind: 'complete',
      provider: targetProvider,
      exitCode: 1,
      success: false,
      code: 'hosted_turn_supervisor_unsupported',
      error:
        `Mechanical coordination is unavailable for ${targetProvider} `
        + `${hostedMode}/${immutableCoordinationLevel}; no textual fallback was used.`,
      ...clientMsgIdEcho(data),
      notStarted: true,
    }));
    return;
  }

  if (cliCellEnabled && !cliSupervisionSupported) {
    writer.send(createNormalizedMessage({
      kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
      code: 'cli_turn_supervisor_unsupported', notStarted: true,
      error:
        `Mechanical coordination is unavailable for ${targetProvider} `
        + `${hostedMode}/${immutableCoordinationLevel}; no textual fallback was used.`,
      ...clientMsgIdEcho(data),
    }));
    return;
  }

  const isRevivedAgentRun = kimiAgentRun || glmCarrierRun || hostedSupervisionSupported;

  if (isProviderGloballyDisabled(targetProvider) && !isRevivedAgentRun) {
    console.log(`[INFO] Refusing dispatch for globally disabled provider "${targetProvider}"`);
    writer.send(
      createNormalizedMessage({
        kind: 'complete',
        provider: targetProvider,
        exitCode: 1,
        success: false,
        error:
          `Provider "${targetProvider}" is disabled on this deployment. `
          + 'Existing sessions remain readable, but new runs are rejected.',
        ...clientMsgIdEcho(data),
        // B-577 (بند أمني): رفضٌ قبل أن تبدأ جولةٌ أصلاً. بلا هذا العلَم يكتب
        // **المُحاوِل المرفوض** شارةَ خطأ على محادثةٍ سليمة يراها أصحابها —
        // والحالة صارت مشتركة، فتُبثّ الكذبة إلى الأعضاء الشرعيين.
        notStarted: true,
      })
    );
    return;
  }

  // Shadow acceptance occurs only after this layer's preflight gates pass.
  const ingressOptions = (data.options ?? {}) as { clientMsgId?: unknown; images?: unknown };
  const ingressClientMsgId = normalizeBoundedOptionalText(ingressOptions.clientMsgId, 128);
  const ingressUserId = toNumericUserId(principalId);
  if (ingressOptions.clientMsgId !== undefined && !ingressClientMsgId) {
    writer.send(createNormalizedMessage({
      kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
      code: 'invalid_client_msg_id',
      notStarted: true,
      error: 'The turn identity is invalid and cannot be claimed safely.',
      ...clientMsgIdEcho(data),
    }));
    return;
  }
  if (invalidCommand) {
    writer.send(createNormalizedMessage({
      kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
      code: 'invalid_turn_content', notStarted: true,
      error: 'The message content is invalid and cannot be dispatched safely.',
      ...clientMsgIdEcho(data),
    }));
    return;
  }
  const attachmentIdentity = readAttachmentIdentity(ingressOptions.images);
  if (attachmentIdentity.kind === 'invalid') {
    writer.send(createNormalizedMessage({
      kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
      code: 'invalid_image_attachments', notStarted: true,
      error: 'The image attachments are invalid and cannot be dispatched safely.',
      ...clientMsgIdEcho(data),
    }));
    return;
  }
  if (!command.trim() && attachmentIdentity.kind === 'none' && messageType !== 'cursor-resume') {
    writer.send(createNormalizedMessage({
      kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
      code: 'empty_turn', notStarted: true,
      error: 'A message or a valid image attachment is required.',
      ...clientMsgIdEcho(data),
    }));
    return;
  }
  if (targetProvider === 'codex' && attachmentIdentity.kind === 'images'
    && !(await import('@/modules/providers/index.js')).codexReceiptPayloadHash(command, attachmentIdentity.dataUrls)) {
    writer.send(createNormalizedMessage({
      kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
      code: 'codex_image_receipt_unsupported', notStarted: true,
      error: 'These images exceed the supported Codex delivery-proof format or size.',
      ...clientMsgIdEcho(data),
    }));
    return;
  }
  if (ingressClientMsgId && ingressUserId != null && databaseModule.messageCoordinationDb?.claim) {
    let claim:
      | { action: 'dispatch' }
      | { action: 'fingerprint_mismatch' }
      | { action: 'ambiguous_started' }
      | { action: 'replay_verdict'; verdict: Record<string, unknown> };
    try {
      claim = databaseModule.messageCoordinationDb.claim({
        sessionId: resumeSessionId,
        clientMsgId: ingressClientMsgId,
        userId: ingressUserId,
        provider: targetProvider,
        canonicalContent: command,
        coordinationLevel: immutableCoordinationLevel,
        ...(attachmentIdentity.kind === 'images'
          ? { attachmentFingerprint: attachmentIdentity.fingerprint }
          : {}),
      });
    } catch (error) {
      console.error('Coordination ingress claim failed', {
        clientMsgId: ingressClientMsgId,
        error: error instanceof Error ? error.message : String(error),
      });
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
        code: 'coordination_ingress_unavailable', notStarted: true,
        error: 'The turn could not be claimed safely. Please retry with a new message id.',
        ...clientMsgIdEcho(data),
      }));
      return;
    }
    if (claim.action === 'replay_verdict') {
      const { codexUserProof: _privateCodexProof, ...publicVerdict } = claim.verdict;
      writer.send(publicVerdict);
      return;
    }
    const durableSupervisorReplayCandidate = claim.action === 'ambiguous_started'
      && (
        (hostedSupervisionSupported
          && (hostedProvider(targetProvider) || targetProvider === 'claude'))
        || (cliSupervisionSupported && mechanicallyCoordinatedCliProvider(targetProvider))
      );
    if (claim.action !== 'dispatch' && !durableSupervisorReplayCandidate) {
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
        code: claim.action === 'fingerprint_mismatch'
          ? 'client_msg_id_fingerprint_mismatch'
          : 'client_msg_id_already_started',
        sameClientMsgIdRetryable: false,
        error: claim.action === 'fingerprint_mismatch'
          ? 'This message id is already bound to a different turn payload.'
          : 'This message id may already be running; it will not be dispatched twice.',
        ...clientMsgIdEcho(data),
      }));
      return;
    }
  }

  writer = withCoordinationMetadata(
    writer,
    data,
    principalId,
    resumeSessionId,
    targetProvider,
    immutableCoordinationLevel,
  );

  // Every local provider launch crosses this boundary. The database migration
  // ledger is the only authority that can admit an unbound pre-cutover session
  // to the shared repository; post-cutover sessions fail closed.
  const clientProjectPath = typeof data.options?.cwd === 'string'
    ? data.options.cwd.trim()
    : '';
  const resumedSession = resumeSessionId
    ? databaseModule.sessionsDb?.getSessionById?.(resumeSessionId)
    : null;
  const logicalProjectPath = resumeSessionId
    ? (resumedSession?.project_path ?? '')
    : clientProjectPath;
  const workspaceModesRepository = databaseModule.sessionWorkspaceModesDb;
  const legacyEligibility = resumeSessionId && resumedSession?.project_path
    ? workspaceModesRepository.readLegacyEligibility(
      resumeSessionId, resumedSession.project_path, resumedSession.provider,
    )
    : null;
  let sessionWorkspace: ReturnType<typeof resolveSessionWorkspaceForLaunch> | null = null;
  if (resumeSessionId && !logicalProjectPath) {
    writer.send(createNormalizedMessage({
      kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
      code: 'session_workspace_unavailable', notStarted: true,
      error: 'The resumed session has no trusted project workspace.',
      ...clientMsgIdEcho(data),
    }));
    return;
  }
  if (logicalProjectPath) {
    try {
      sessionWorkspace = resolveSessionWorkspaceForLaunch({
        projectPath: logicalProjectPath,
        sessionId: resumeSessionId,
        launchKey: ingressClientMsgId,
        principalId,
        legacyEligible: Boolean(legacyEligibility),
      });

      if (resumeSessionId && sessionWorkspace.isolation === 'overlay') {
        // Self-heal a ledger write interrupted after the atomic filesystem bind.
        workspaceModesRepository.markOverlay(
          resumeSessionId, sessionWorkspace.logicalProjectPath, resumedSession?.provider ?? targetProvider,
        );
      }

      if (sessionWorkspace.isolation === 'legacy_shared') {
        await attestSharedSessionWorkspace({
          logicalProjectPath: sessionWorkspace.logicalProjectPath,
          cwd: sessionWorkspace.cwd,
          sessionId: resumeSessionId,
          clientProjectPath,
          principalId,
        });
      }
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
      const errorMessage = error instanceof Error ? error.message : String(error);
      const classified = errorCode === 'ENOENT'
        ? {
          code: 'session_workspace_missing',
          message: 'The project workspace no longer exists. Restore or remove the project before retrying.',
        }
        : errorCode === 'SESSION_WORKSPACE_PATH_UNSAFE'
          || /canonical physical path|client path mismatch/.test(errorMessage)
          ? {
            code: 'session_workspace_path_unsafe',
            message: 'The project workspace path is unsafe or changed during validation.',
          }
          : errorCode === 'SESSION_WORKSPACE_FORBIDDEN'
            ? {
              code: 'session_workspace_forbidden',
              message: 'This shared project workspace is not registered or writable by this user.',
            }
            : {
              code: 'session_workspace_unavailable',
              message: 'The session workspace binding is unavailable or inconsistent.',
            };
      console.error('Session workspace isolation failed before provider launch', {
        provider: targetProvider,
        resumed: Boolean(resumeSessionId),
        classification: classified.code,
        error: errorMessage,
      });
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
        code: classified.code, notStarted: true,
        error: classified.message,
        ...clientMsgIdEcho(data),
      }));
      return;
    }

    if (sessionWorkspace && !resumeSessionId
        && (sessionWorkspace.isolation === 'legacy_shared' || ingressClientMsgId)) {
      const downstreamWriter = writer;
      let workspaceBindFailed = false;
      let boundProviderSessionId: string | null = null;
      writer = transparentWriterWithSend(downstreamWriter, (payload: unknown): void => {
        if (workspaceBindFailed) return;
        let forwardedPayload = payload;
        try {
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const frame = payload as Record<string, unknown>;
            const kind = typeof frame.kind === 'string' ? frame.kind : '';
            const emittedSessionId = typeof frame.sessionId === 'string'
              ? frame.sessionId
              : (typeof frame.newSessionId === 'string' ? frame.newSessionId : '');
            if (kind === 'session_created' && emittedSessionId) {
              if (boundProviderSessionId) {
                if (emittedSessionId === boundProviderSessionId) return;
                throw new Error('provider emitted conflicting session identities for one launch');
              }
              if (sessionWorkspace?.isolation === 'legacy_shared') {
                workspaceModesRepository.markShared(
                  emittedSessionId, sessionWorkspace.logicalProjectPath, targetProvider,
                );
                forwardedPayload = { ...frame, workspaceIsolation: 'legacy_shared' };
              } else {
                const boundWorkspace = bindSessionWorkspace({
                  projectPath: logicalProjectPath,
                  launchKey: ingressClientMsgId!,
                  sessionId: emittedSessionId,
                  principalId,
                });
                workspaceModesRepository.markOverlay(
                  emittedSessionId, boundWorkspace.logicalProjectPath, targetProvider,
                );
                forwardedPayload = { ...frame, workspaceGeneration: boundWorkspace.generation };
              }
              boundProviderSessionId = emittedSessionId;
            }
          }
          downstreamWriter.send(forwardedPayload);
        } catch (error) {
          workspaceBindFailed = true;
          console.error('Failed to bind provider session to its isolated workspace', {
            provider: targetProvider,
            error: error instanceof Error ? error.message : String(error),
          });
          downstreamWriter.send(createNormalizedMessage({
            kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
            code: 'session_workspace_bind_failed', notStarted: false,
            error: 'The provider session could not be bound to its isolated workspace.',
            ...clientMsgIdEcho(data),
          }));
        }
      });
    }
  }
  writer = withUniversalConversationShadow(
    messageType,
    data,
    writer,
    principalId,
    dependencies,
  );

  // T-1315 (الموجة الثانية، قرار المالك 2026-08-17): مستوى التنسيق يصل **كل**
  // المحرّكات لا Claude وحده. يُضيَّق مرّةً واحدة هنا fail-closed ثم يُمرَّر على
  // كل فرع، فلا يبقى فرعٌ منسيّ يُرسل بلا مستوى بصمت — وهو بالضبط ما كان يحدث
  // قبل هذه الموجة (‏grep على `coordinationLevel` كان يجد ملفّين خادميّين فقط).
  //
  // درجةُ الإنفاذ تتفاوت بين المحرّكات (ميكانيكي/نصّي)، وهي معلَنة للمستخدم في
  // واصف القدرات؛ أمّا **التوصيل** فموحّد: كل مُشعِل يستلم القيمة ويقرّر قناته.
  const vendorReceiptInvocation = data.options?.receiptPayload
    ? (await import('@/modules/providers/index.js')).createVendorReceiptInvocation(data, ingressUserId, ingressClientMsgId)
    : undefined;
  const dispatchOptions = Object.freeze({
    ...(data.options ?? {}),
    ...(sessionWorkspace ? {
      cwd: sessionWorkspace.cwd,
      projectPath: sessionWorkspace.logicalProjectPath,
      nassajWorkspaceIsolation: sessionWorkspace.isolation,
    } : {}),
    coordinationLevel: immutableCoordinationLevel,
    authenticatedPrincipal,
    vendorReceiptInvocation,
  });

  const permissionOptionsFor = (
    provider: LLMProvider,
    body: string,
    engine: string,
    purpose: CanonicalLaunchContext['purpose'],
  ): Record<string, unknown> | null => {
    const project = logicalProjectPath
      ? databaseModule.projectsDb?.getProjectPath?.(logicalProjectPath)
      : null;
    const projectId = typeof project?.project_id === 'string' ? project.project_id : '';
    const workspacePath = sessionWorkspace?.cwd
      ?? (typeof data.options?.cwd === 'string' ? data.options.cwd : '');
    if (ingressUserId == null || !projectId || !workspacePath) {
      writer.send(createNormalizedMessage({
        kind: 'complete', provider, exitCode: 1, success: false,
        code: 'permission_launch_context_invalid', notStarted: true,
        error: 'The provider launch context could not be authenticated.',
        ...clientMsgIdEcho(data),
      }));
      return null;
    }
    let permission: PermissionGatewayResult;
    try {
      permission = dependencies.authorizeProviderExecution(authenticatedPrincipal, {
        launchId: ingressClientMsgId ?? `server:${randomUUID()}`,
        principalId: `user:${ingressUserId}`,
        sessionId: resumeSessionId,
        projectId,
        workspacePath,
        provider,
        body,
        engine,
        entrypoint: 'ws.chat',
        purpose,
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code).toLowerCase()
        : 'permission_admission_unavailable';
      writer.send(createNormalizedMessage({
        kind: 'complete', provider, exitCode: 1, success: false,
        code, notStarted: true, error: 'Permission admission failed closed.',
        ...clientMsgIdEcho(data),
      }));
      return null;
    }
    if (permission.kind === 'denied') {
      writer.send(createNormalizedMessage({
        kind: 'complete', provider, exitCode: 1, success: false,
        code: 'permission_denied', reasonCodes: permission.reasonCodes,
        notStarted: true, error: 'The requested permission profile is unavailable.',
        ...clientMsgIdEcho(data),
      }));
      return null;
    }
    return Object.freeze({
      ...dispatchOptions,
      permissionExecution: permission.execution,
    });
  };

  const runAdmittedAdapter = async <T>(
    provider: LLMProvider,
    body: string,
    engine: string,
    purpose: CanonicalLaunchContext['purpose'],
    adapter: (options: Record<string, unknown>) => Promise<T>,
  ): Promise<{ admitted: boolean; value?: T }> => {
    const options = permissionOptionsFor(provider, body, engine, purpose);
    if (!options) return { admitted: false };
    const execution = options.permissionExecution as PermissionExecutionHandle | undefined;
    if (!execution) return { admitted: true, value: await adapter(options) };
    const value = await runPermissionExecutionAdapter(execution, () => adapter(options));
    return { admitted: true, value };
  };

  const runAdmittedLegacyProvider = (
    provider: LLMProvider,
    body: string,
    engine: string,
    adapter: (options: Record<string, unknown>) => Promise<unknown>,
  ) => runAdmittedAdapter(provider, body, engine, 'spawn', options =>
    runLegacyProviderCallWithShadow(writer, () => adapter(options)));

  if (
    hostedSupervisionSupported
    && (hostedProvider(targetProvider) || targetProvider === 'claude')
  ) {
    if (!ingressClientMsgId || ingressUserId == null) {
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
        code: 'hosted_turn_identity_required', notStarted: true,
        error: 'Mechanical hosted coordination requires an authenticated durable turn identity.',
        ...clientMsgIdEcho(data),
      }));
      return;
    }
    try {
      const admission = await runAdmittedAdapter(
        targetProvider,
        targetProvider,
        'hosted_supervisor',
        'external_agent_dispatch',
        () => dependencies.hostedTurnSupervisor!.execute({
        provider: targetProvider,
        mode: hostedMode,
        coordinationLevel: immutableCoordinationLevel,
        model: requestedModel,
        prompt: command,
        userId: ingressUserId,
        clientMsgId: ingressClientMsgId,
        vendorReceiptInvocation: dispatchOptions.vendorReceiptInvocation,
        sessionId: resumeSessionId,
        projectPath: sessionWorkspace?.cwd
          ?? (typeof data.options?.cwd === 'string' ? data.options.cwd : undefined),
        onSession(sessionId, isNew): void {
          if (isNew && typeof writer.setSessionId === 'function') writer.setSessionId(sessionId);
          if (isNew) {
            writer.send(createNormalizedMessage({
              kind: 'session_created', provider: targetProvider,
              sessionId, newSessionId: sessionId,
            }));
          }
        },
        }),
      );
      if (!admission.admitted || !admission.value) return;
      const supervised = admission.value;
      writer.send(createNormalizedMessage({
        kind: 'text', role: 'assistant', provider: targetProvider,
        sessionId: supervised.sessionId, model: supervised.model,
        content: supervised.text,
      }));
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, sessionId: supervised.sessionId,
        model: supervised.model, exitCode: 0, success: true,
        isNewSession: supervised.isNewSession,
      }));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'HOSTED_TURN_SUPERVISOR_FAILED';
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
        code: code.toLowerCase(),
        error: 'The mechanically supervised hosted turn could not complete.',
        ...clientMsgIdEcho(data),
      }));
    }
    return;
  }

  if (cliSupervisionSupported && mechanicallyCoordinatedCliProvider(targetProvider)) {
    if (!ingressClientMsgId || ingressUserId == null) {
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
        code: 'cli_turn_identity_required', notStarted: true,
        error: 'Mechanical CLI coordination requires an authenticated durable turn identity.',
        ...clientMsgIdEcho(data),
      }));
      return;
    }
    try {
      const admission = await runAdmittedAdapter(
        targetProvider,
        targetProvider,
        'cli_supervisor',
        'external_agent_dispatch',
        () => dependencies.cliTurnSupervisor!.execute({
        provider: targetProvider, mode: 'chat', coordinationLevel: immutableCoordinationLevel,
        model: requestedModel, prompt: command, userId: ingressUserId,
        clientMsgId: ingressClientMsgId, sessionId: resumeSessionId,
        projectPath: sessionWorkspace?.cwd
          ?? (typeof data.options?.cwd === 'string' ? data.options.cwd : undefined),
        onSession(sessionId, isNew): void {
          if (isNew && typeof writer.setSessionId === 'function') writer.setSessionId(sessionId);
          if (isNew) writer.send(createNormalizedMessage({
            kind: 'session_created', provider: targetProvider, sessionId, newSessionId: sessionId,
          }));
        },
        }),
      );
      if (!admission.admitted || !admission.value) return;
      const supervised = admission.value;
      writer.send(createNormalizedMessage({
        kind: 'text', role: 'assistant', provider: targetProvider,
        sessionId: supervised.sessionId, model: supervised.model, content: supervised.text,
      }));
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, sessionId: supervised.sessionId,
        model: supervised.model, exitCode: 0, success: true,
        isNewSession: supervised.isNewSession,
      }));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code) : 'CLI_TURN_SUPERVISOR_FAILED';
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: targetProvider, exitCode: 1, success: false,
        code: code.toLowerCase(), error: 'The mechanically supervised CLI turn could not complete.',
        ...clientMsgIdEcho(data),
      }));
    }
    return;
  }

  if (targetProvider === 'cursor') {
    await runAdmittedLegacyProvider('cursor', 'cursor', 'cli', options =>
      dependencies.spawnCursor(command, options, writer));
    return;
  }
  if (targetProvider === 'codex') {
    const codexOptions = permissionOptionsFor('codex', 'codex', 'sdk', 'sdk_turn');
    if (!codexOptions) return;
    await runLegacyProviderCallWithShadow(writer, () =>
      dependencies.queryCodex(command, codexOptions, writer));
    return;
  }
  if (targetProvider === 'gemini') {
    await runAdmittedLegacyProvider('gemini', 'gemini', 'cli', options =>
      dependencies.spawnGemini(command, options, writer));
    return;
  }
  if (targetProvider === 'antigravity') {
    await runAdmittedLegacyProvider('antigravity', 'antigravity', 'cli', options =>
      dependencies.spawnAntigravity(command, options, writer));
    return;
  }
  if (targetProvider === 'hermes') {
    await runAdmittedLegacyProvider('hermes', 'hermes', 'cli', options =>
      dependencies.spawnHermes(command, options, writer));
    return;
  }
  if (targetProvider === 'opencode') {
    await runAdmittedLegacyProvider('opencode', 'opencode', 'cli', options =>
      dependencies.spawnOpenCode(command, options, writer));
    return;
  }
  if (targetProvider === 'kimi') {
    // KM-3: agent mode → the governed native launcher; else the unchanged chat
    // path. `kimiAgentRun` already encodes "agent requested AND launcher wired",
    // so the else branch is only ever reached for a chat turn (or a future
    // re-enable of kimi chat).
    if (kimiAgentRun) {
      await runAdmittedLegacyProvider('kimi', 'kimi', 'native_agent', options =>
        dependencies.spawnKimiAgent!(command, options, writer));
    } else {
      await runAdmittedLegacyProvider('kimi', 'kimi', 'chat', options =>
        dependencies.spawnKimi(command, options, writer));
    }
    return;
  }
  if (targetProvider === 'deepseek') {
    await runAdmittedLegacyProvider('deepseek', 'deepseek', 'vendor_cli', options =>
      dependencies.spawnDeepSeek(command, options, writer));
    return;
  }
  if (targetProvider === 'glm') {
    // GL-8: agent mode + carrier armed → run GLM through the OpenCode carrier
    // (provider-prefixed `glm/<model>`, options.carrier=true so opencode-cli.js
    // takes its governed carrier path). Chat / flag-OFF keeps the unchanged path.
    if (glmCarrierRun) {
      const options = dispatchOptions as AnyRecord;
      const rawModel = typeof options.model === 'string' ? options.model.trim() : '';
      const carrierModel = rawModel
        ? (rawModel.startsWith('glm/') ? rawModel : `glm/${rawModel}`)
        : undefined;
      await runAdmittedLegacyProvider('glm', 'glm', 'opencode_carrier', admittedOptions =>
        dependencies.spawnOpenCode(
          command,
          { ...admittedOptions, carrier: true, ...(carrierModel ? { model: carrierModel } : {}) },
          writer,
        ));
    } else {
      await runAdmittedLegacyProvider('glm', 'glm', 'vendor_cli', options =>
        dependencies.spawnGlm(command, options, writer));
    }
    return;
  }
  if (targetProvider === 'qwen') {
    if (!dependencies.spawnQwen) {
      writer.send(createNormalizedMessage({
        kind: 'complete', provider: 'qwen', exitCode: 1, success: false,
        error: 'Qwen runtime adapter is unavailable on this server.', notStarted: true,
        ...clientMsgIdEcho(data),
      }));
      return;
    }
    await runAdmittedLegacyProvider('qwen', 'qwen', 'cli', options =>
      dependencies.spawnQwen!(command, options, writer));
    return;
  }

  if (targetProvider === 'claude') {
    const claudeOptions = permissionOptionsFor('claude', 'claude', 'sdk', 'sdk_turn');
    if (!claudeOptions) return;
    await runLegacyProviderCallWithShadow(writer, () =>
      dependencies.queryClaudeSDK(
        command,
        claudeOptions,
        writer,
      ));
    return;
  }

  writer.send(createNormalizedMessage({
    kind: 'complete',
    provider: targetProvider,
    exitCode: 1,
    success: false,
    error: `Provider "${targetProvider}" has no runtime handler on this deployment.`,
    ...clientMsgIdEcho(data),
    notStarted: true,
  }));
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 *
 * Exported so the shell (PTY) path resolves the JWT-authenticated user id with
 * the exact same precedence as chat (B-MU-PTY-AUTH), keeping a single source of
 * truth for `request.user → userId` across both websocket routes.
 */
export function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  // [WS-DIAG] Socket birth marker — used to compute socket lifetime at close and
  // to correlate a reconnecting socket with a prior active stream. Diagnostic only.
  const wsDiagOpenedAt = Date.now();
  const wsDiagSocketId = `s${wsDiagOpenedAt.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  console.log(
    `[WS-DIAG] open socket=${wsDiagSocketId} activeClaudeSessions=`
    + `${JSON.stringify(dependencies.getActiveClaudeSDKSessions())}`
  );
  connectedClients.add(ws);

  // Live presence (B-MU-UX-PRESENCE): register this authenticated socket as
  // "connected". The userId is read strictly from the JWT-authenticated request
  // (same precedence as the chat writer), never from client input.
  const presenceUserId = readRequestUserId(request);
  presenceConnect(ws, request.user, presenceUserId);

  // Stamp the JWT-derived identity on the shared socket so broadcasters (e.g.
  // the sessions watcher's `projects_updated`) can compute per-user fields like
  // `isMember` for each client (B-MU-UX-FIX-WSMEMBER).
  (ws as RealtimeClientConnection).userId = presenceUserId;

  // Open-sessions counter: push the initial server-wide count to this client
  // immediately; afterwards it only receives change broadcasts.
  sendOpenSessionsCount(ws as RealtimeClientConnection);

  const writer: WebSocketWriter = new websocketWriterService.WebSocketWriter(ws, presenceUserId);

  /**
   * Raw, UNICAST send to THIS socket: bypasses WebSocketWriter entirely, so a
   * payload carrying a `sessionId` is never fanned out to that session's mirrors.
   * Used for the /btw side channel (contract C2) and for attach-replay, where the
   * payloads belong to the requesting socket alone.
   */
  const sendRawToThisSocket = (payload: unknown): void => {
    if ((ws as { readyState?: number }).readyState === WS_OPEN_STATE) {
      ws.send(JSON.stringify(payload));
    }
  };

  // T-881 flood guard: at most ONE in-flight /btw side query per socket. The
  // second is refused with `busy` until the first reaches a terminal state.
  let btwInFlight = false;
  // A-1 teardown state for the socket's current in-flight /btw fork. `interrupt`
  // tears the fork down; `release` frees both flood slots (per-socket + per-user).
  // Both are null between queries. `btwSocketClosed` guards the race where the
  // socket closes before the fork's onStarted handle has arrived.
  let btwSocketClosed = false;
  let btwActiveInterrupt: (() => void) | null = null;
  let btwActiveRelease: (() => void) | null = null;
  // T-1090: one in-flight `/btw` FORK per socket (its own guard, so a fork and a
  // side query never block each other — they cost different resources).
  let btwForkInFlight = false;
  // /btw replies go to THIS requesting socket ALONE (contract C2): a raw send
  // that bypasses WebSocketWriter entirely, so there is no sessionId-keyed
  // fan-out to mirrors. btw payloads carry `btwId`, never `sessionId`.
  const sendBtwRaw = (payload: Record<string, unknown>): void => {
    sendRawToThisSocket(payload);
  };

  ws.on('message', async (rawMessage) => {
    return withLocalUpdateWriterLease('websocket-message', async () => {
    let failedCommandIdentity: Record<string, string> | null = null;
    let providerDispatchEntered = false;
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as ChatIncomingMessage;
      failedCommandIdentity = readFailedCommandIdentity(data);
      const messageType = data.type;
      if (!messageType) {
        throw new Error('Message type is required');
      }

      const isProviderEffectMessage = messageType in COMMAND_TYPE_TO_PROVIDER
        || messageType === 'opencode-command'
        || messageType === 'cursor-resume'
        || messageType === 'btw-query';
      if (isProviderEffectMessage
        && request.user?.authenticationKind === 'platform_unverified') {
        if (messageType === 'btw-query') {
          sendRawToThisSocket({
            type: 'btw-error',
            btwId: typeof data.btwId === 'string' ? data.btwId : '',
            code: 'platform_actor_unverified',
            message: 'Platform provider effects require a verified actor.',
          });
        } else {
          writer.send(createNormalizedMessage({
            kind: 'complete',
            provider: COMMAND_TYPE_TO_PROVIDER[messageType]
              ?? (messageType === 'opencode-command' ? 'opencode' : 'cursor'),
            exitCode: 1,
            success: false,
            code: 'platform_actor_unverified',
            error: 'Platform provider effects require a verified actor.',
            notStarted: true,
            ...clientMsgIdEcho(data),
          }));
        }
        return;
      }

      // B-PRIV: refuse to start/resume a run inside a private project the
      // authenticated user is not a member of (404-equivalent over WS).
      const isSpawnMessage =
        messageType in COMMAND_TYPE_TO_PROVIDER ||
        messageType === 'opencode-command' ||
        messageType === 'cursor-resume';
      if (isSpawnMessage && !isSpawnProjectVisible(data, presenceUserId)) {
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            provider: COMMAND_TYPE_TO_PROVIDER[messageType]
              ?? (messageType === 'opencode-command' ? 'opencode' : 'cursor'),
            exitCode: 1,
            success: false,
            error: 'Project not found',
            ...clientMsgIdEcho(data),
            // B-577 (بند أمني): رفضٌ قبل الإقلاع لا يُنتج حالةً على محادثة
            // لم تعمل — انظر الموضع الأول أعلاه.
            notStarted: true,
          })
        );
        return;
      }

      if (messageType in COMMAND_TYPE_TO_PROVIDER) {
        let lease: { release(): void } | null = null;
        try {
          lease = await dependencies.acquireWriterLease?.('provider-turn') ?? null;
          providerDispatchEntered = true;
          await dispatchProviderCommand(
            messageType,
            data,
            writer,
            dependencies,
            presenceUserId,
            request.user,
          );
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('update_')) {
            writer.send(createNormalizedMessage({
              kind: 'complete', provider: COMMAND_TYPE_TO_PROVIDER[messageType],
              exitCode: 1, success: false, code: 'update_maintenance_active',
              error: 'Source update maintenance is active.', notStarted: true,
              ...clientMsgIdEcho(data),
            }));
            return;
          }
          throw error;
        } finally {
          lease?.release();
        }
        return;
      }

      if (messageType === 'cursor-resume') {
        let lease: { release(): void } | null = null;
        try {
          lease = await dependencies.acquireWriterLease?.('provider-turn') ?? null;
          providerDispatchEntered = true;
          await dispatchProviderCommand(
            'cursor-resume',
            {
              ...data,
              command: '',
              options: {
                ...(data.options ?? {}),
                sessionId: data.sessionId,
                resume: true,
              },
            },
            writer,
            dependencies,
            presenceUserId,
            request.user,
          );
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('update_')) {
            writer.send(createNormalizedMessage({
              kind: 'complete', provider: 'cursor', exitCode: 1, success: false,
              code: 'update_maintenance_active', error: 'Source update maintenance is active.',
              notStarted: true, ...clientMsgIdEcho(data),
            }));
            return;
          }
          throw error;
        } finally {
          lease?.release();
        }
        return;
      }

      if (messageType === 'abort-session') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        // B-SEC-ABORT-GUARD: the spawn guard above (`isSpawnMessage`) covers only
        // LAUNCH commands, so until now this handler killed whatever sessionId a
        // client typed — any user could abort any user's run. Aborting is a WRITE
        // on someone's live work, so it takes the write gate (visibility + the
        // B-105/B-138 membership predicates), not the read gate. An empty id is
        // deliberately still allowed: it resolves against the newest active run on
        // THIS socket (the brand-new-session STOP race) and can never match another
        // provider's map. Refusal echoes the same 404-equivalent shape a miss does.
        if (sessionId && !isSessionWritableByUser(sessionId, presenceUserId)) {
          console.log(
            `[WS-SEC] abort-session refused socket=${wsDiagSocketId} `
            + `session=${sessionId} user=${JSON.stringify(presenceUserId)} reason=not-writable`
          );
          const requestedControlProvider = readProvider(data.provider);
          const refusal = {
              kind: 'complete',
              exitCode: 1,
              aborted: true,
              success: false,
              sessionId,
              abortFailed: true,
              error: 'Session not found',
              // B-577: ردٌّ على أمرِ إيقافٍ لجلسةٍ لا يملكها الطالب أو لا وجود
              // لها — ليس حكماً على جولة، فلا يكتب حالةً على محادثة أحد.
              notStarted: true,
          } as const;
          writer.send(requestedControlProvider
            ? createNormalizedMessage({ ...refusal, provider: requestedControlProvider })
            : refusal);
          return;
        }
        // T-874(3): abort the session's OWN persisted provider, not the
        // client-declared one (which may be the current global picker selection).
        // Empty/unknown id falls back to the client provider, preserving Claude's
        // empty-sessionId abort-race fallback below.
        const provider = resolveSessionControlProvider(
          sessionId,
          readProvider(data.provider),
          dependencies.getSessionProvider
        );
        let success = false;
        // The session the abort actually resolved to (claude may fall back to the
        // newest active run on this connection when the id is missing entirely).
        let resolvedSessionId: string | null = sessionId || null;
        let abortReason: string | null = null;

        if (abortHostedSupervisedTurn(
          dependencies.hostedTurnSupervisor,
          provider,
          sessionId,
          toNumericUserId(presenceUserId),
        )) {
          success = true;
        } else if (abortCliSupervisedTurn(
          dependencies.cliTurnSupervisor,
          provider,
          sessionId,
          toNumericUserId(presenceUserId),
        )) {
          success = true;
        } else if (provider === 'cursor') {
          success = dependencies.abortCursorSession(sessionId);
        } else if (provider === 'codex') {
          success = dependencies.abortCodexSession(sessionId);
        } else if (provider === 'gemini') {
          success = dependencies.abortGeminiSession(sessionId);
        } else if (provider === 'antigravity') {
          success = dependencies.abortAntigravitySession(sessionId);
        } else if (provider === 'opencode') {
          success = dependencies.abortOpenCodeSession(sessionId);
        } else if (provider === 'hermes') {
          success = dependencies.abortHermesSession(sessionId);
        } else if (provider === 'kimi') {
          success = dependencies.abortKimiSession(sessionId);
        } else if (provider === 'deepseek') {
          success = dependencies.abortDeepSeekSession(sessionId);
        } else if (provider === 'glm') {
          success = dependencies.abortGlmSession(sessionId);
        } else if (provider === 'qwen') {
          success = dependencies.abortQwenSession?.(sessionId) ?? false;
        } else if (provider === 'claude') {
          // Claude: pass the raw socket so the SDK can fall back to this
          // connection's newest active run when `sessionId` is EMPTY (the
          // brand-new-session abort race). B-ABORT-CROSSKILL: a named-but-stale
          // id no longer falls back — one socket carries every session the tab
          // opened, so that killed a bystander run. Result is structured.
          const result = await dependencies.abortClaudeSDKSession(sessionId, ws);
          if (typeof result === 'boolean') {
            success = result;
          } else {
            success = result.aborted;
            abortReason = result.reason;
            if (result.sessionId) {
              resolvedSessionId = result.sessionId;
            }
          }
        } else {
          abortReason = 'provider runtime unavailable';
        }

        const abortPayload = {
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            // Echo the session the abort resolved to so the client clears the
            // right run's spinner even when it sent an empty/stale id.
            sessionId: resolvedSessionId ?? sessionId,
            ...(success ? {} : { abortFailed: true, error: abortReason ?? 'abort failed' }),
        } as const;
        writer.send(provider
          ? createNormalizedMessage({ ...abortPayload, provider })
          : abortPayload);
        return;
      }

      // T-881: /btw side query — a read-only "by the way" question answered
      // against a LIVE session by forking it, WITHOUT touching the live stream.
      // The design gate approved "البديل 2" (SDK fork); every gate is enforced
      // here (visibility, provider, flood) and in spawnClaudeSideQuery (fork
      // isolation, read-only tools, per-user env). Replies go to THIS socket ONLY.
      if (messageType === 'btw-query') {
        const btwId = typeof data.btwId === 'string' ? data.btwId : '';
        // Without a correlation id the client cannot match the reply — drop it.
        if (!btwId) {
          return;
        }
        if (Buffer.byteLength(btwId, 'utf8') > BTW_MAX_ID_BYTES) {
          // Do not reflect the attacker-controlled oversized id. The empty id
          // deliberately cannot be mistaken for a valid correlation token.
          sendBtwRaw({
            type: 'btw-error',
            btwId: '',
            code: 'invalid_request',
            message: `The /btw id exceeds ${BTW_MAX_ID_BYTES} UTF-8 bytes.`,
          });
          return;
        }
        const btwSessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
        const question = typeof data.question === 'string' ? data.question : '';
        const upToMessageId =
          typeof data.upToMessageId === 'string' && data.upToMessageId.trim() !== ''
            ? data.upToMessageId.trim()
            : null;

        // [BTW] diagnostic: log EVERY /btw error emitted at the WS layer (gate
        // rejections here + fork errors forwarded from spawnClaudeSideQuery's
        // onError). Code + session + userId type/value + message ONLY — never the
        // question text, conversation content, or any credential/token/secret.
        const emitBtwError = (code: string, message: string): void => {
          console.warn(
            `[BTW] ws emit-error session=${btwSessionId || '<none>'} code=${code} `
            + `userIdType=${typeof presenceUserId} userIdValue=${String(presenceUserId)} `
            + `msg=${message}`
          );
          sendBtwRaw({ type: 'btw-error', btwId, code, message });
        };

        if (Buffer.byteLength(question, 'utf8') > BTW_MAX_QUESTION_BYTES) {
          emitBtwError(
            'invalid_request',
            `The /btw question exceeds ${BTW_MAX_QUESTION_BYTES} UTF-8 bytes.`
          );
          return;
        }

        // Flood guard (C: busy): one in-flight /btw per socket.
        if (btwInFlight) {
          emitBtwError('busy', 'Another /btw query is already running on this connection.');
          return;
        }
        if (!btwSessionId) {
          emitBtwError('session_not_found', 'No session was specified for the /btw query.');
          return;
        }
        // C3 content-visibility gate: a non-member never forks a private-project
        // session (same 404-equivalent the mirror/attach path returns). Checked
        // BEFORE any fork is spawned.
        if (!isSessionVisibleToUser(btwSessionId, presenceUserId)) {
          emitBtwError('not_visible', 'Session not found.');
          return;
        }
        // Restricted to providers with a native, isolated thread-fork path.
        // An unknown session (no persisted row) is session_not_found; another session is
        // unsupported_provider. Neither spawns a fork.
        //
        // Engine axis (B-358): this caller does NOT resolve or pass an
        // engineProvider — a comment here used to claim the engine was "sealed
        // with the session" while nothing passed it, so every /btw on a
        // vendor-pinned session ran on official Anthropic. The fork now reads
        // the pin server-side itself (spawnClaudeSideQuery →
        // sessions.engine_provider, ADR-088); do not add a client-supplied
        // engine parameter back here.
        const sessionProvider = dependencies.getSessionProvider(btwSessionId);
        if (sessionProvider === null) {
          emitBtwError('session_not_found', 'Session not found.');
          return;
        }
        if (sessionProvider !== 'claude' && sessionProvider !== 'codex') {
          emitBtwError(
            'unsupported_provider',
            `/btw does not support "${sessionProvider}" sessions.`
          );
          return;
        }
        if (sessionProvider === 'codex' && typeof dependencies.spawnCodexSideQuery !== 'function') {
          emitBtwError('unsupported_provider', 'Codex /btw is not available on this server.');
          return;
        }
        // Fork cwd = the session's project path so CLAUDE.md / project settings
        // load in the session's own context. Best-effort lookup (null on any miss).
        let btwProjectPath: string | null = null;
        try {
          btwProjectPath = databaseModule.sessionsDb.getSessionById(btwSessionId)?.project_path ?? null;
        } catch {
          btwProjectPath = null;
        }
        // A-2.3 / A-3 gate: a /btw fork MUST run inside the session's project. If
        // the path is unknown we refuse (sdk_error) rather than let the fork
        // inherit the server cwd — the fork layer enforces the same, this is the
        // gate that must pass BEFORE the accept frame below.
        if (!btwProjectPath || btwProjectPath.trim() === '') {
          emitBtwError('sdk_error', 'The project path for this session could not be determined.');
          return;
        }
        // A-4 per-user flood cap (busy): across ALL of this user's sockets.
        if (btwUserInFlight(presenceUserId) >= BTW_MAX_INFLIGHT_PER_USER) {
          emitBtwError('busy', 'You have too many /btw queries running. Try again shortly.');
          return;
        }

        // A-3: every gate has passed — ACK acceptance to the requester BEFORE the
        // fork spawns, so the client can cancel its fallback timeout. Then reserve
        // both flood slots (per-socket + per-user).
        let btwWriterLease: { release(): void } | null = null;
        try {
          btwWriterLease = await dependencies.acquireWriterLease?.('provider-side-query') ?? null;
        } catch {
          emitBtwError('update_maintenance_active', 'Source update maintenance is active.');
          return;
        }
        let btwPermissionExecution: PermissionExecutionHandle | null = null;
        {
          const project = databaseModule.projectsDb?.getProjectPath?.(btwProjectPath);
          const projectId = typeof project?.project_id === 'string' ? project.project_id : '';
          if (presenceUserId == null || !projectId) {
            btwWriterLease?.release();
            emitBtwError('permission_launch_context_invalid', 'Permission context is unavailable.');
            return;
          }
          try {
            const permission = dependencies.authorizeProviderExecution(request.user, {
              launchId: `btw:${btwId}`,
              principalId: `user:${presenceUserId}`,
              sessionId: btwSessionId,
              projectId,
              workspacePath: btwProjectPath,
              provider: sessionProvider,
              body: sessionProvider,
              engine: sessionProvider === 'codex' ? 'app_server' : 'sdk_side_query',
              entrypoint: 'ws.btw',
              purpose: 'sdk_turn',
              effectFootprint: 'external',
            });
            if (permission.kind === 'denied') {
              btwWriterLease?.release();
              emitBtwError('permission_denied', 'The side-query permission is unavailable.');
              return;
            }
            btwPermissionExecution = permission.execution;
          } catch {
            btwWriterLease?.release();
            emitBtwError('permission_admission_unavailable', 'Permission admission failed closed.');
            return;
          }
        }
        sendBtwRaw({ type: 'btw-accepted', btwId });
        // [BTW] diagnostic: request accepted — ALL pre-launch gates passed, logged
        // BEFORE the fork spawns so a silent pre-query() failure still leaves a
        // trail. Session + userId type/value ONLY (never the question/content).
        console.log(
          `[BTW] ws accepted session=${btwSessionId} `
          + `userIdType=${typeof presenceUserId} userIdValue=${String(presenceUserId)}`
        );
        btwInFlight = true;
        acquireBtwUserSlot(presenceUserId);
        let btwReleased = false;
        const releaseBtw = (): void => {
          if (btwReleased) {
            return;
          }
          btwReleased = true;
          btwInFlight = false;
          releaseBtwUserSlot(presenceUserId);
          btwWriterLease?.release();
          btwWriterLease = null;
          btwActiveInterrupt = null;
          btwActiveRelease = null;
        };
        btwActiveRelease = releaseBtw;

        const spawnSideQuery = sessionProvider === 'codex'
          ? dependencies.spawnCodexSideQuery!
          : dependencies.spawnClaudeSideQuery;
        let btwPermissionStarted = false;
        let btwPermissionSettled = false;
        const settleBtwPermission = (
          outcome: 'succeeded' | 'failed' | 'spawn_failed' | 'reconciled_unknown',
        ): void => {
          if (!btwPermissionExecution || btwPermissionSettled) return;
          btwPermissionSettled = true;
          try {
            btwPermissionExecution.settle(outcome);
          } catch {
            // The gateway durably blocks the generation on terminal ambiguity.
          }
        };
        try {
          btwPermissionExecution?.consume();
        } catch {
          releaseBtw();
          emitBtwError('permission_permit_invalid', 'The side-query permit could not be consumed.');
          return;
        }
        void spawnSideQuery(
            {
              sessionId: btwSessionId,
              question,
              upToMessageId,
              userId: presenceUserId, // C3: the REQUESTER's creds, not the owner's
              authenticatedPrincipal: request.user,
              cwd: btwProjectPath,
            },
            {
              // A-1: remember the fork's interrupt handle so the close handler can
              // tear it down. If the socket already closed in the (tiny) window
              // before the fork materialised, interrupt it at once.
              onStarted: (handle: { interrupt: () => void }) => {
                if (btwPermissionExecution) {
                  try {
                    btwPermissionExecution.markStarted();
                    btwPermissionStarted = true;
                  } catch {
                    try { handle.interrupt(); } catch { /* best-effort */ }
                    settleBtwPermission('reconciled_unknown');
                    releaseBtw();
                    emitBtwError('permission_start_unrecorded', 'The side query was stopped safely.');
                    return;
                  }
                }
                if (btwSocketClosed) {
                  try {
                    handle.interrupt();
                  } catch {
                    /* best-effort teardown */
                  }
                  return;
                }
                btwActiveInterrupt = handle.interrupt;
              },
              onChunk: (text: string) => sendBtwRaw({ type: 'btw-chunk', btwId, text }),
              onError: (code: string, message: string) => {
                settleBtwPermission(btwPermissionStarted ? 'failed' : 'reconciled_unknown');
                releaseBtw();
                emitBtwError(code, message);
              },
              onComplete: (fullAnswer: string) => {
                settleBtwPermission('succeeded');
                releaseBtw();
                // B-270: attach the full answer to the terminal frame. The client
                // adopts it as the source of truth, so the reply is correct even
                // if every intermediate `btw-chunk` frame was lost in transit.
                sendBtwRaw({
                  type: 'btw-complete',
                  btwId,
                  ...(typeof fullAnswer === 'string' && fullAnswer.length > 0
                    ? { text: fullAnswer }
                    : {}),
                });
              },
            }
          )
          // spawnClaudeSideQuery is contracted never to reject; this is a pure
          // safety net that only frees the slots (no double error emission).
          .catch(() => {
            settleBtwPermission(btwPermissionStarted ? 'failed' : 'reconciled_unknown');
            releaseBtw();
          });
        return;
      }

      // T-1090: promote a FINISHED /btw exchange into a real, continuable
      // session. `/btw` deliberately persists nothing (ADR-077 / C1), so once the
      // answer turns out to be worth following up on there is no thread to reply
      // into — this creates one: the source transcript is branched on disk (new
      // ids, new sessionId, `forkedFrom` provenance) and the question plus the
      // answer already shown are appended. No model call, no quota: the answer is
      // reused, never re-asked.
      //
      // The gate posture DIFFERS from `btw-query` on purpose. Asking is a READ of
      // a session, so it takes the visibility gate; forking CREATES a session
      // inside that session's project, so it takes the same WRITE gate
      // `abort-session` uses (visibility first, then B-105/B-138 membership) — a
      // read-only viewer of a public project must not be able to write new
      // conversations into it.
      if (messageType === 'btw-fork') {
        const btwId = typeof data.btwId === 'string' ? data.btwId : '';
        // Without a correlation id the client cannot match the reply — drop it.
        if (!btwId) {
          return;
        }
        if (Buffer.byteLength(btwId, 'utf8') > BTW_MAX_ID_BYTES) {
          sendBtwRaw({
            type: 'btw-fork-error',
            btwId: '',
            code: 'invalid_request',
            message: `The /btw id exceeds ${BTW_MAX_ID_BYTES} UTF-8 bytes.`,
          });
          return;
        }
        const forkSessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
        const forkQuestion = typeof data.question === 'string' ? data.question.trim() : '';
        const forkAnswer = typeof data.answer === 'string' ? data.answer : '';
        const forkUpToMessageId =
          typeof data.upToMessageId === 'string' && data.upToMessageId.trim() !== ''
            ? data.upToMessageId.trim()
            : null;
        // T-1091: the branch shape the user picked. Anything unrecognised (an
        // older or hand-rolled client) falls back to 'full' — the behaviour that
        // shipped first and the one the CLI itself has.
        const forkMode: 'full' | 'fresh' = data.mode === 'fresh' ? 'fresh' : 'full';

        // Same discipline as the /btw diagnostics: code + session + userId only,
        // never the question, the answer, or any conversation content.
        const emitForkError = (code: string, message: string): void => {
          console.warn(
            `[BTW] ws fork-error session=${forkSessionId || '<none>'} code=${code} `
            + `userIdType=${typeof presenceUserId} userIdValue=${String(presenceUserId)} `
            + `msg=${message}`
          );
          sendBtwRaw({ type: 'btw-fork-error', btwId, code, message });
        };

        if (Buffer.byteLength(forkQuestion, 'utf8') > BTW_MAX_QUESTION_BYTES) {
          emitForkError(
            'invalid_request',
            `The /btw question exceeds ${BTW_MAX_QUESTION_BYTES} UTF-8 bytes.`
          );
          return;
        }

        if (btwForkInFlight) {
          emitForkError('busy', 'A fork is already running on this connection.');
          return;
        }
        if (!forkSessionId) {
          emitForkError('session_not_found', 'No session was specified for the fork.');
          return;
        }
        // The branch is only worth creating with BOTH halves of the exchange; an
        // empty answer would leave a dangling question at the tip of the branch.
        if (!forkQuestion || forkAnswer.trim() === '') {
          emitForkError('invalid_request', 'A fork needs both the side question and its answer.');
          return;
        }
        if (!isSessionWritableByUser(forkSessionId, presenceUserId)) {
          emitForkError('not_writable', 'You cannot create a session in this project.');
          return;
        }
        const forkProvider = dependencies.getSessionProvider(forkSessionId);
        if (forkProvider === null) {
          emitForkError('session_not_found', 'Session not found.');
          return;
        }
        if (forkProvider !== 'claude') {
          emitForkError(
            'unsupported_provider',
            `Forking a side question supports Claude sessions only (this session runs on "${forkProvider}").`
          );
          return;
        }
        if (btwUserForks(presenceUserId) >= BTW_MAX_FORKS_PER_USER) {
          emitForkError('busy', 'You have too many forks running. Try again shortly.');
          return;
        }
        // A composition root that never wired the fork service must say so
        // instead of throwing an opaque TypeError into the socket handler.
        if (typeof dependencies.forkSessionFromSideQuery !== 'function') {
          emitForkError('fork_failed', 'Forking is not available on this server.');
          return;
        }

        let forkWriterLease: { release(): void } | null = null;
        try {
          forkWriterLease = await dependencies.acquireWriterLease?.('provider-side-query') ?? null;
        } catch {
          emitForkError('update_maintenance_active', 'Source update maintenance is active.');
          return;
        }
        btwForkInFlight = true;
        acquireBtwForkSlot(presenceUserId);
        let forkReleased = false;
        const releaseFork = (): void => {
          if (forkReleased) {
            return;
          }
          forkReleased = true;
          btwForkInFlight = false;
          releaseBtwForkSlot(presenceUserId);
          forkWriterLease?.release();
          forkWriterLease = null;
        };

        void dependencies
          .forkSessionFromSideQuery({
            sessionId: forkSessionId,
            question: forkQuestion,
            answer: forkAnswer,
            userId: toNumericUserId(presenceUserId),
            upToMessageId: forkUpToMessageId,
            mode: forkMode,
          })
          .then((result) => {
            releaseFork();
            console.log(
              `[BTW] ws forked source=${forkSessionId} forked=${result.sessionId} `
              + `mode=${forkMode} `
              + `userIdType=${typeof presenceUserId} userIdValue=${String(presenceUserId)}`
            );
            // C2 unicast, and the id is deliberately NOT on a `sessionId` key:
            // every btw frame stays free of that field so no present or future
            // writer path can mistake it for a fan-out target.
            sendBtwRaw({
              type: 'btw-forked',
              btwId,
              forkedSessionId: result.sessionId,
              title: result.title,
              mode: forkMode,
            });
          })
          .catch((error: unknown) => {
            releaseFork();
            // Duck-typed on purpose: the service is INJECTED, so an `instanceof`
            // against this module's class would depend on module identity.
            const rawCode = (error as { code?: unknown })?.code;
            const code = typeof rawCode === 'string' && rawCode ? rawCode : 'fork_failed';
            const message =
              error instanceof Error && error.message
                ? error.message
                : 'The conversation could not be forked.';
            emitForkError(code, message);
          });
        return;
      }

      // Branch a normal conversation from the exact persisted assistant reply
      // chosen in the transcript. This is intentionally distinct from
      // `btw-fork`: there is no side-question exchange to append, so the branch
      // ends exactly at `upToMessageId` and can continue naturally in a new chat.
      if (messageType === 'message-fork') {
        const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
        // A reply without the caller's request id cannot safely be associated
        // with the clicked message, so do not create an unobservable branch.
        if (!requestId || requestId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(requestId)) {
          return;
        }
        const forkSessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
        const upToMessageId =
          typeof data.upToMessageId === 'string' ? data.upToMessageId.trim() : '';
        const emitMessageForkError = (code: string, message: string, forkedSessionId?: string): void => {
          console.warn(
            `[MESSAGE-FORK] ws error session=${forkSessionId || '<none>'} code=${code} `
            + `userIdType=${typeof presenceUserId} userIdValue=${String(presenceUserId)}`,
          );
          sendRawToThisSocket({ type: 'message-fork-error', requestId, code, message,
            ...(forkedSessionId ? { forkedSessionId } : {}),
          });
        };

        if ((data.retryRegistrationOnly !== undefined && typeof data.retryRegistrationOnly !== 'boolean')
          || (data.retryRegistrationOnly === true && (typeof data.expectedForkedSessionId !== 'string'
            || !data.expectedForkedSessionId || data.expectedForkedSessionId.length > 256))
          || (data.expectedForkedSessionId !== undefined && data.retryRegistrationOnly !== true)) {
          emitMessageForkError('registration_evidence_expired', 'Invalid registration-only retry. No new fork was created.');
          return;
        }
        if (!forkSessionId) {
          emitMessageForkError('session_not_found', 'No session was specified for the fork.');
          return;
        }
        if (!upToMessageId || upToMessageId.length > 256 || forkSessionId.length > 256) {
          emitMessageForkError('message_not_found', 'No message was specified for the fork.');
          return;
        }
        // Creating a branch writes a new session in the source project: use the
        // same membership-aware gate as `btw-fork` and abort controls.
        if (!isSessionWritableByUser(forkSessionId, presenceUserId)) {
          emitMessageForkError('not_writable', 'You cannot create a session in this project.');
          return;
        }
        const forkProvider = dependencies.getSessionProvider(forkSessionId);
        if (forkProvider === null) {
          emitMessageForkError('session_not_found', 'Session not found.');
          return;
        }
        if (forkProvider !== 'claude' && forkProvider !== 'codex') {
          emitMessageForkError(
            'unsupported_provider',
            'This provider does not support continuing from a selected response.',
          );
          return;
        }
        if (btwForkInFlight || btwUserForks(presenceUserId) >= BTW_MAX_FORKS_PER_USER) {
          emitMessageForkError('busy', 'A fork is already running. Try again shortly.');
          return;
        }
        if (typeof dependencies.forkSessionAtMessage !== 'function') {
          emitMessageForkError('fork_failed', 'Forking is not available on this server.');
          return;
        }

        let messageForkWriterLease: { release(): void } | null = null;
        try {
          messageForkWriterLease = await dependencies.acquireWriterLease?.('provider-side-query') ?? null;
        } catch {
          emitMessageForkError('update_maintenance_active', 'Source update maintenance is active.');
          return;
        }
        btwForkInFlight = true;
        acquireBtwForkSlot(presenceUserId);
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          btwForkInFlight = false;
          releaseBtwForkSlot(presenceUserId);
          messageForkWriterLease?.release();
          messageForkWriterLease = null;
        };
        void dependencies.forkSessionAtMessage({
          sessionId: forkSessionId,
          upToMessageId,
          userId: toNumericUserId(presenceUserId),
          requestId,
          authenticatedPrincipal: request.user,
          retryRegistrationOnly: data.retryRegistrationOnly === true,
          expectedForkedSessionId: typeof data.expectedForkedSessionId === 'string' ? data.expectedForkedSessionId : undefined,
        })
          .then((result) => {
            release();
            // The resulting id is deliberately named `forkedSessionId`: raw
            // unicast frames must never look like writer payloads to a session.
            sendRawToThisSocket({
              type: 'message-forked',
              requestId,
              forkedSessionId: result.sessionId,
              title: result.title,
            });
          })
          .catch((error: unknown) => {
            release();
            const rawCode = (error as { code?: unknown })?.code;
            const code = typeof rawCode === 'string' && rawCode ? rawCode : 'fork_failed';
            const message = error instanceof Error && error.message
              ? error.message
              : 'The conversation could not be forked.';
            const target = (error as { forkedSessionId?: unknown })?.forkedSessionId;
            emitMessageForkError(code, message,
              code === 'registration_failed' && typeof target === 'string' ? target : undefined);
          });
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          const result = dependencies.resolveToolApproval(data.requestId, {
            allow: Boolean(data.allow),
            updatedInput: data.updatedInput,
            message: typeof data.message === 'string' ? data.message : undefined,
            rememberEntry: data.rememberEntry,
            // B-SEC-APPROVAL-OWNERSHIP: stamp the JWT-authenticated answerer.
            // The request itself carries no sessionId (the server owns the
            // requestId → session/owner mapping), so ownership CANNOT be checked
            // here; claude-sdk resolves the owner captured when the prompt was
            // created and refuses a foreign answer / strips its updatedInput and
            // rememberEntry. Never sourced from the client payload.
            requesterUserId: presenceUserId,
          });
          // لا نحذف الطلب لمجرد وصول جواب من العميل: resolver هو بوابة الملكية
          // والوجود. بعد نجاحه فقط نحسم requestId ونبث زوال آخر سؤال معلق.
          if (result?.resolved && result.sessionId) {
            resolveQuestionRequest(result.sessionId, data.requestId);
          }
        }
        return;
      }

      if (messageType === 'cursor-abort') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        // B-SEC-ABORT-GUARD: same write gate as `abort-session` — this legacy
        // cursor-only alias reached abortCursorSession with an unchecked id.
        if (sessionId && !isSessionWritableByUser(sessionId, presenceUserId)) {
          console.log(
            `[WS-SEC] cursor-abort refused socket=${wsDiagSocketId} `
            + `session=${sessionId} user=${JSON.stringify(presenceUserId)} reason=not-writable`
          );
          writer.send(
            createNormalizedMessage({
              kind: 'complete',
              exitCode: 1,
              aborted: true,
              success: false,
              sessionId,
              provider: 'cursor',
              abortFailed: true,
              error: 'Session not found',
              // B-577: ردٌّ على أمرِ إيقافٍ لجلسةٍ لا يملكها الطالب أو لا وجود
              // لها — ليس حكماً على جولة، فلا يكتب حالةً على محادثة أحد.
              notStarted: true,
            })
          );
          return;
        }
        const success = dependencies.abortCursorSession(sessionId);
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider: 'cursor',
          })
        );
        return;
      }

      if (messageType === 'check-session-status') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let isActive = false;

        // B-137: the mirror + attach-replay + writer-reconnect below all expose
        // this session's live stream (transcript, permission prompts, tool
        // output) to the requesting socket. Refuse them when the session's
        // project is not visible to this user — a private project they are not a
        // member of — returning the same 404-equivalent an unknown/inactive
        // session would: NO mirror registered, NO buffered payloads replayed, NO
        // writer swapped, and the activity is never even probed.
        if (sessionId && !isSessionVisibleToUser(sessionId, presenceUserId)) {
          writer.send({
            type: 'session-status',
            sessionId,
            provider,
            isProcessing: false,
          });
          return;
        }

        // B-SEC-REPLAY-UNICAST (ordering, part 1/2): the mirror used to be
        // registered HERE, before the attach-replay below. Because replay payloads
        // are buffered live payloads that carry their own `sessionId`,
        // `writer.send` opened a fan-out keyed by that id and every replayed
        // payload was broadcast to EVERY mirror of the session instead of the one
        // socket that asked for it — a reconnecting tab re-played the backlog into
        // all other viewers. The registration now happens AFTER the attach (below)
        // and the replay sink is a unicast raw send, so a replay can never fan out.
        // The whole handler body is synchronous, so no live payload can slip
        // through the (zero-await) window between the attach and the registration.

        if (provider === 'cursor') {
          isActive = dependencies.isCursorSessionActive(sessionId);
        } else if (provider === 'codex') {
          isActive = dependencies.isCodexSessionActive(sessionId);
        } else if (provider === 'gemini') {
          isActive = dependencies.isGeminiSessionActive(sessionId);
        } else if (provider === 'antigravity') {
          isActive = dependencies.isAntigravitySessionActive(sessionId);
          // B-N-ATTACH: read-only differential replay. A reconnecting socket gets
          // only the buffered payloads it has not seen (seq > lastSeq) re-emitted
          // to ITS writer. This deliberately does NOT call reconnectSessionWriter
          // and never aborts the run — the active writer of the live session is
          // left untouched, honouring the documented `if(!isActive)` veto. No-op
          // when SESSION_REGISTRY_agy is off.
          const rawLastSeq = typeof data.lastSeq === 'number' ? data.lastSeq : Number(data.lastSeq);
          const lastSeq = Number.isFinite(rawLastSeq) ? rawLastSeq : 0;
          // B-SEC-REPLAY-UNICAST: unicast to the requesting socket (see note
          // above `if (provider === 'cursor')`) — `writer.send` would fan the
          // replay out to every mirror of this session.
          dependencies.attachAntigravitySession(sessionId, lastSeq, sendRawToThisSocket);
        } else if (provider === 'opencode') {
          isActive = dependencies.isOpenCodeSessionActive(sessionId);
        } else if (provider === 'hermes') {
          isActive = dependencies.isHermesSessionActive(sessionId);
        } else if (provider === 'qwen') {
          isActive = dependencies.isQwenSessionActive?.(sessionId) ?? false;
        } else if (provider === 'claude') {
          isActive = dependencies.isClaudeSDKSessionActive(sessionId);
          // [WS-DIAG] Re-subscribe decision for a reconnecting socket (point #4).
          // Decision matrix for the writer reclaim below:
          //   isActive=true  + primarySocketAlive=true  → NO swap (live run, live
          //     socket: swapping mid-run risks tool_use desync as before).
          //   isActive=true  + primarySocketAlive=false → SWAP (orphaned writer:
          //     SDK is already dropping to a dead socket; reclaiming it lets the
          //     rest of the stream reach the reconnecting client safely).
          //   isActive=false + any                      → SWAP (idle session).
          // The orphaned-writer reclaim (the `!primarySocketAlive` extension) is
          // gated the SAME way as the replay above: isPrimarySocketAlive reports
          // the socket as ALIVE when SESSION_REGISTRY_claude is off (or when the
          // dependency is not wired, e.g. legacy callers/tests), so the condition
          // collapses to the pre-T-932 `!isActive` no-swap veto and an active run
          // is NEVER swapped while the flag is off (ADR-041 no-op contract).
          const primarySocketAlive =
            typeof dependencies.isPrimarySocketAlive === 'function'
              ? dependencies.isPrimarySocketAlive(sessionId)
              : true;
          console.log(
            `[WS-DIAG] check-session-status claude socket=${wsDiagSocketId} `
            + `session=${sessionId} isActive=${isActive} `
            + `primarySocketAlive=${primarySocketAlive} mirrorRegistered=${Boolean(sessionId)} `
            + `writerSwapAttempted=${!isActive || !primarySocketAlive}`
          );
          // ADR-041 (B-80): read-only differential replay for claude, mirroring the
          // antigravity branch above. A reconnecting socket gets ONLY the buffered
          // payloads it has not seen (seq > lastSeq) re-emitted to ITS writer,
          // running BEFORE the writer-reclaim veto so an ACTIVE stream (the freeze
          // case) is caught up without any writer swap or run abort.
          // No-op when SESSION_REGISTRY_claude is off (returns lastSeq, sends
          // nothing). The mirror registration below (addSessionMirror) still
          // delivers FUTURE payloads; this replay closes the gap between socket
          // death and mirror registration.
          const rawLastSeq = typeof data.lastSeq === 'number' ? data.lastSeq : Number(data.lastSeq);
          const lastSeq = Number.isFinite(rawLastSeq) ? rawLastSeq : 0;
          // B-SEC-REPLAY-UNICAST: unicast to the requesting socket — the buffered
          // payloads carry their own sessionId, so `writer.send` fanned the whole
          // backlog out to every other viewer of this session.
          dependencies.attachClaudeSDKSession(sessionId, lastSeq, sendRawToThisSocket);
          // Writer reclaim: swap only when safe.
          // Safe = session is idle (!isActive) OR session is active but its primary
          // socket is dead (orphaned writer — primarySocketAlive=false). When the
          // primary socket is still alive AND the run is live, swapping would
          // desynchronise the SDK from a live connection and abort tool_use.
          if (!isActive || !primarySocketAlive) {
            const swapped = dependencies.reconnectSessionWriter(sessionId, ws);
            console.log(
              `[WS-DIAG] reconnectSessionWriter claude socket=${wsDiagSocketId} `
              + `session=${sessionId} swapped=${swapped}`
            );
          }
        } else {
          // Unknown and foundation-only providers (currently Qwen) must never
          // fall through to Claude's activity/reconnect machinery.
          isActive = false;
        }

        // B-SEC-REPLAY-UNICAST (ordering, part 2/2): register the read-only
        // mirror only AFTER the attach-replay has finished, so the differential
        // backlog this socket just asked for was delivered to it ALONE while
        // FUTURE live payloads still fan out to every viewer exactly as before.
        // Unchanged otherwise: same predicate (`sessionId` truthy), same
        // read-only semantics, never touches the active writer (no-swap veto).
        if (sessionId) {
          websocketWriterService.addSessionMirror(sessionId, ws as RealtimeClientConnection);
        }

        // ج1 (2026-07-26): `isProcessing` MUST serialize as an explicit boolean.
        // The claude probe used to return `undefined` for an unknown session
        // (`session && session.status === 'active'`), and JSON.stringify DROPS an
        // undefined value — the client got a frame with NO `isProcessing` key and
        // could not distinguish "idle" from "field missing". The probe itself is
        // fixed at the source (claude-sdk.js isClaudeSDKSessionActive), and this
        // coercion pins the WIRE contract so a future provider probe that leaks a
        // non-boolean can never silently delete the field again.
        writer.send({
          type: 'session-status',
          sessionId,
          provider,
          isProcessing: Boolean(isActive),
        });
        return;
      }

      if (messageType === 'get-pending-permissions') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        // B-SEC-PENDING-VISIBILITY: this handler hands out a live approval's
        // requestId + toolName + full tool INPUT for any id whose run is active —
        // the exact material needed to hijack another user's tool approval (and a
        // disclosure of a private session's command/file arguments on its own).
        // Gate it with the SAME predicate `check-session-status` uses (B-137) so
        // the mirror path and the pending-prompt path cannot diverge; a hidden
        // session answers with silence, exactly as an inactive one does.
        if (sessionId && !isSessionVisibleToUser(sessionId, presenceUserId)) {
          console.log(
            `[WS-SEC] get-pending-permissions refused socket=${wsDiagSocketId} `
            + `session=${sessionId} user=${JSON.stringify(presenceUserId)} reason=not-visible`
          );
          return;
        }
        if (sessionId && dependencies.isClaudeSDKSessionActive(sessionId)) {
          const pending = dependencies.getPendingApprovalsForSession(sessionId);
          writer.send({
            type: 'pending-permissions-response',
            sessionId,
            data: pending,
          });
        }
        return;
      }

      if (messageType === 'get-active-sessions') {
        // B-144: (a) never leak the ids of runs this user cannot see — filter
        // every provider's active-id list through the SAME visibility predicate
        // as check-session-status (a private-project run is dropped for a
        // non-member, an unknown/null-path run stays visible like presence);
        // (b) surface the kimi/deepseek/glm providers that were silently omitted
        // from this listing.
        const visibleIds = (ids: unknown): string[] =>
          (Array.isArray(ids) ? ids : []).filter(
            (id): id is string =>
              typeof id === 'string' && isSessionVisibleToUser(id, presenceUserId)
          );

        writer.send({
          type: 'active-sessions',
          sessions: {
            claude: visibleIds(dependencies.getActiveClaudeSDKSessions()),
            cursor: visibleIds(dependencies.getActiveCursorSessions()),
            codex: visibleIds(dependencies.getActiveCodexSessions()),
            gemini: visibleIds(dependencies.getActiveGeminiSessions()),
            antigravity: visibleIds(dependencies.getActiveAntigravitySessions()),
            opencode: visibleIds(dependencies.getActiveOpenCodeSessions()),
            hermes: visibleIds(dependencies.getActiveHermesSessions()),
            kimi: visibleIds(dependencies.getActiveKimiSessions()),
            deepseek: visibleIds(dependencies.getActiveDeepSeekSessions()),
            glm: visibleIds(dependencies.getActiveGlmSessions()),
            qwen: visibleIds(dependencies.getActiveQwenSessions?.() ?? []),
          },
        });
      }
    } catch (error) {
      // No raw exception text or mutable writer session can escape this callback.
      const disposition = providerDispatchEntered ? 'unknown' : 'not_started';
      const code = failedCommandIdentity
        ? (providerDispatchEntered ? 'message_dispatch_unconfirmed' : 'message_dispatch_not_started')
        : 'websocket_request_failed';
      // B-1298(b): a provider run may reject carrying a fixed, non-secret code
      // (auth failure / context overflow). Surface it as a SEPARATE field the
      // client can display, leaving `code` and the delivery disposition intact.
      const providerErrorCode = readProviderErrorCode(error);
      console.error('[ERROR] Chat WebSocket request failed', { code, providerErrorCode });
      sendRawToThisSocket({
        type: 'error', kind: 'error', code,
        ...(providerErrorCode ? { providerErrorCode } : {}),
        error: 'The request could not be completed.',
        ...(failedCommandIdentity ? {
          ...failedCommandIdentity,
          deliveryDisposition: disposition,
          sameClientMsgIdRetryable: !providerDispatchEntered,
          ...(!providerDispatchEntered ? { notStarted: true } : {}),
        } : {}),
      });
    }
    }).catch((frameError) => {
      // Same classification and the same server-side trace as every other
      // refusal surface; a pinned code hid which gate condition actually fired.
      // This catch also sees rejections of the wrapped message handler, so the
      // gate is only named when the gate actually refused. Either way the
      // message is refused and `notStarted` stays true: nothing was dispatched.
      const refusal = reportWriterLeaseRefusal('Chat WebSocket rejected: message', frameError);
      sendRawToThisSocket({ type: 'error', kind: 'error', code: refusal.code,
        error: refusal.gateDenial
          ? 'Update maintenance is active.'
          : 'The request could not be completed.',
        notStarted: true });
    });
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log('[INFO] Chat client disconnected');
    // [WS-DIAG] Socket close forensics (point #1). The current production code
    // ignores (code, reason); capture them to distinguish:
    //   1006 = abnormal/no-close-frame (proxy/network drop, Cloudflare idle, keepalive terminate)
    //   1001 = going away (page reload / nav) — server graceful drain also uses 1001
    //   1000 = normal closure
    // `activeClaudeSessions` at close is the key signal: if it is non-empty, a run
    // was streaming when this socket died — the writer is now detached (its this.ws
    // points at this dead socket) and the run keeps consuming SDK output into a
    // no-op send until it completes or aborts. `writerSessionId` is the session this
    // socket's writer was bound to (the spawner of the run), null for a viewer/mirror.
    const wsDiagActiveClaude = dependencies.getActiveClaudeSDKSessions();
    const writerSessionId = writer.getSessionId();
    console.log(
      `[WS-DIAG] close socket=${wsDiagSocketId} code=${code} `
      + `reason=${JSON.stringify(reason?.toString() ?? '')} `
      + `lifetimeMs=${Date.now() - wsDiagOpenedAt} `
      + `writerSessionId=${JSON.stringify(writer.getSessionId())} `
      + `activeClaudeSessions=${JSON.stringify(wsDiagActiveClaude)} `
      + `hadActiveStreamAtClose=${Array.isArray(wsDiagActiveClaude) && wsDiagActiveClaude.length > 0}`
    );
    // ADR-101: Qwen Coding Plan is foreground-interactive only. Losing the
    // socket that supplied the human gesture ends model/tool execution; cleanup
    // may continue during the adapter's bounded SIGINT→SIGKILL grace period.
    if (writerSessionId && dependencies.isQwenSessionActive?.(writerSessionId)) {
      dependencies.abortQwenSession?.(writerSessionId);
    }
    // T-881 (A-1): the requester is gone, so any in-flight /btw fork bound to this
    // socket is moot — interrupt it and free its flood slots (per-socket +
    // per-user). `btwSocketClosed` also covers the race where onStarted arrives
    // after close (it interrupts immediately then). Capture the handles before
    // calling: releaseBtw() nulls them, and the fork's own terminal callback will
    // call releaseBtw() again — the idempotency guard makes that a no-op.
    btwSocketClosed = true;
    const btwInterruptOnClose = btwActiveInterrupt;
    const btwReleaseOnClose = btwActiveRelease;
    if (btwInterruptOnClose) {
      try {
        btwInterruptOnClose();
      } catch {
        /* best-effort teardown */
      }
    }
    if (btwReleaseOnClose) {
      btwReleaseOnClose();
    }
    connectedClients.delete(ws);
    // B-SEC-MIRROR-LEAK: drop this socket from EVERY session it mirrors. Until
    // now `close` cleaned connectedClients + presence + /btw and never mentioned
    // the mirrors, and the only mirror cleanup was the lazy prune inside
    // `fanOutToMirrors` — which runs only if that same session broadcasts again.
    // So every page refresh left a permanent map entry pinning a dead WebSocket
    // (the measured ~7MB/h leak). Read-only w.r.t. the run: no writer swap, no
    // abort, no buffer touched.
    const removedMirrors =
      websocketWriterService.removeSessionMirrorsForSocket?.(ws as RealtimeClientConnection) ?? 0;
    if (removedMirrors > 0) {
      console.log(
        `[WS-DIAG] mirrors-unregistered socket=${wsDiagSocketId} count=${removedMirrors}`
      );
    }
    // Drop this socket from presence; the user stays "connected" while any of
    // their other tabs/devices keep a socket open (multi-tab dedupe).
    presenceDisconnect(ws);
  });

  // B-SEC-WS-ERROR: `ws` emits 'error' on the SOCKET object (protocol violation,
  // ECONNRESET, a failed send…). An EventEmitter with NO 'error' listener makes
  // Node THROW the error, which — with no process-level handler — killed the
  // whole server process and every other user's live session over one bad
  // socket. The shell (`shell-websocket.service.ts`) and terminal
  // (`terminal-websocket.service.ts`) handlers have always registered this
  // listener; chat was the only route missing it. Registration-only, mirroring
  // its peers: the socket's own 'close' (always emitted after 'error') keeps
  // owning the teardown, so no cleanup is duplicated here. The message differs
  // from the message-handler log above ('Chat WebSocket error') on purpose, so
  // the two failure classes stay distinguishable in the logs.
  ws.on('error', (error) => {
    console.error('[ERROR] Chat WebSocket socket error:', error);
  });
}
