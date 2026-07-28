import type { WebSocket } from 'ws';

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
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

// Top-level shared/ (compiled into dist-server/shared/) — the single source of
// truth for globally disabled providers (T-864). Relative on purpose: the `@/`
// alias maps to server/* only.
import { isProviderGloballyDisabled } from '../../../../shared/disabledProviders.js';

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

// T-881 (A-4): a per-USER concurrent /btw cap, shared across ALL of a user's
// sockets/tabs and layered ABOVE the per-socket single-flight guard. It stops one
// user from opening many tabs to spawn many simultaneous read-only forks (each a
// real Claude child process). The counter is incremented only once all gates pass
// and the fork is about to spawn, and released in every terminal path (success,
// error, timeout, interrupt, socket close) — see releaseBtw below.
const BTW_MAX_INFLIGHT_PER_USER = 2;
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

/**
 * Test-only: clears the module-level per-user /btw in-flight counters between
 * unit tests. A unit test that leaves a fork "in flight" (a never-resolving spy)
 * would otherwise leak a per-user slot into the next test. Never used in prod.
 */
export function __resetBtwFloodStateForTests(): void {
  btwInFlightByUser.clear();
}

type ChatWebSocketDependencies = {
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
  ) => void;
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
};

/**
 * Normalizes potentially invalid provider names coming from websocket payloads.
 */
function readProvider(value: unknown): LLMProvider {
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
  ) {
    return value;
  }

  return DEFAULT_PROVIDER;
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
  requestedProvider: LLMProvider,
  getSessionProvider: (sessionId: string) => LLMProvider | null
): LLMProvider {
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

export async function dispatchProviderCommand(
  messageType: string,
  data: ChatIncomingMessage,
  writer: WebSocketWriter,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const command = data.command ?? '';
  const requestedProvider = COMMAND_TYPE_TO_PROVIDER[messageType] ?? DEFAULT_PROVIDER;

  // Only existing (resumed) sessions can be re-routed; a fresh conversation has
  // no persisted provider yet, so we honour the client's chosen handler.
  const resumeSessionId = readResumeSessionId(data);
  const persistedProvider = resumeSessionId
    ? dependencies.getSessionProvider(resumeSessionId)
    : null;
  const targetProvider = persistedProvider ?? requestedProvider;

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
  const isRevivedAgentRun = kimiAgentRun || glmCarrierRun;

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
      })
    );
    return;
  }

  if (targetProvider === 'cursor') {
    await dependencies.spawnCursor(command, data.options, writer);
    return;
  }
  if (targetProvider === 'codex') {
    await dependencies.queryCodex(command, data.options, writer);
    return;
  }
  if (targetProvider === 'gemini') {
    await dependencies.spawnGemini(command, data.options, writer);
    return;
  }
  if (targetProvider === 'antigravity') {
    await dependencies.spawnAntigravity(command, data.options, writer);
    return;
  }
  if (targetProvider === 'hermes') {
    await dependencies.spawnHermes(command, data.options, writer);
    return;
  }
  if (targetProvider === 'kimi') {
    // KM-3: agent mode → the governed native launcher; else the unchanged chat
    // path. `kimiAgentRun` already encodes "agent requested AND launcher wired",
    // so the else branch is only ever reached for a chat turn (or a future
    // re-enable of kimi chat).
    if (kimiAgentRun) {
      await dependencies.spawnKimiAgent!(command, data.options, writer);
    } else {
      await dependencies.spawnKimi(command, data.options, writer);
    }
    return;
  }
  if (targetProvider === 'deepseek') {
    await dependencies.spawnDeepSeek(command, data.options, writer);
    return;
  }
  if (targetProvider === 'glm') {
    // GL-8: agent mode + carrier armed → run GLM through the OpenCode carrier
    // (provider-prefixed `glm/<model>`, options.carrier=true so opencode-cli.js
    // takes its governed carrier path). Chat / flag-OFF keeps the unchanged path.
    if (glmCarrierRun) {
      const options = (data.options ?? {}) as AnyRecord;
      const rawModel = typeof options.model === 'string' ? options.model.trim() : '';
      const carrierModel = rawModel
        ? (rawModel.startsWith('glm/') ? rawModel : `glm/${rawModel}`)
        : undefined;
      await dependencies.spawnOpenCode(
        command,
        { ...options, carrier: true, ...(carrierModel ? { model: carrierModel } : {}) },
        writer,
      );
    } else {
      await dependencies.spawnGlm(command, data.options, writer);
    }
    return;
  }

  await dependencies.queryClaudeSDK(command, data.options, writer);
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
  // /btw replies go to THIS requesting socket ALONE (contract C2): a raw send
  // that bypasses WebSocketWriter entirely, so there is no sessionId-keyed
  // fan-out to mirrors. btw payloads carry `btwId`, never `sessionId`.
  const sendBtwRaw = (payload: Record<string, unknown>): void => {
    sendRawToThisSocket(payload);
  };

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as ChatIncomingMessage;
      const messageType = data.type;
      if (!messageType) {
        throw new Error('Message type is required');
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
            provider: COMMAND_TYPE_TO_PROVIDER[messageType] ?? DEFAULT_PROVIDER,
            exitCode: 1,
            success: false,
            error: 'Project not found',
          })
        );
        return;
      }

      if (messageType in COMMAND_TYPE_TO_PROVIDER) {
        await dispatchProviderCommand(messageType, data, writer, dependencies);
        return;
      }

      if (messageType === 'opencode-command') {
        await dependencies.spawnOpenCode(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-resume') {
        await dependencies.spawnCursor(
          '',
          {
            sessionId: data.sessionId,
            resume: true,
            cwd: data.options?.cwd,
          },
          writer
        );
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
          writer.send(
            createNormalizedMessage({
              kind: 'complete',
              exitCode: 1,
              aborted: true,
              success: false,
              sessionId,
              provider: readProvider(data.provider),
              abortFailed: true,
              error: 'Session not found',
            })
          );
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
        // newest active run on this connection when the id is missing/stale).
        let resolvedSessionId: string | null = sessionId || null;
        let abortReason: string | null = null;

        if (provider === 'cursor') {
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
        } else {
          // Claude: pass the raw socket so the SDK can fall back to this
          // connection's newest active run when `sessionId` is empty/stale
          // (the brand-new-session abort race). Result is structured.
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
        }

        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            // Echo the session the abort resolved to so the client clears the
            // right run's spinner even when it sent an empty/stale id.
            sessionId: resolvedSessionId ?? sessionId,
            provider,
            ...(success ? {} : { abortFailed: true, error: abortReason ?? 'abort failed' }),
          })
        );
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
        // Restricted to the claude provider (engineProvider sealed with the
        // session). An unknown session (no persisted row) is session_not_found;
        // a non-claude session is unsupported_provider. Neither spawns a fork.
        const sessionProvider = dependencies.getSessionProvider(btwSessionId);
        if (sessionProvider === null) {
          emitBtwError('session_not_found', 'Session not found.');
          return;
        }
        if (sessionProvider !== 'claude') {
          emitBtwError(
            'unsupported_provider',
            `/btw supports Claude sessions only (this session runs on "${sessionProvider}").`
          );
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
          btwActiveInterrupt = null;
          btwActiveRelease = null;
        };
        btwActiveRelease = releaseBtw;

        void dependencies
          .spawnClaudeSideQuery(
            {
              sessionId: btwSessionId,
              question,
              upToMessageId,
              userId: presenceUserId, // C3: the REQUESTER's creds, not the owner's
              cwd: btwProjectPath,
            },
            {
              // A-1: remember the fork's interrupt handle so the close handler can
              // tear it down. If the socket already closed in the (tiny) window
              // before the fork materialised, interrupt it at once.
              onStarted: (handle: { interrupt: () => void }) => {
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
                releaseBtw();
                emitBtwError(code, message);
              },
              onComplete: (fullAnswer: string) => {
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
          .catch(() => releaseBtw());
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          dependencies.resolveToolApproval(data.requestId, {
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
        } else {
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
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      writer.send({
        type: 'error',
        error: message,
      });
    }
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
    console.log(
      `[WS-DIAG] close socket=${wsDiagSocketId} code=${code} `
      + `reason=${JSON.stringify(reason?.toString() ?? '')} `
      + `lifetimeMs=${Date.now() - wsDiagOpenedAt} `
      + `writerSessionId=${JSON.stringify(writer.getSessionId())} `
      + `activeClaudeSessions=${JSON.stringify(wsDiagActiveClaude)} `
      + `hadActiveStreamAtClose=${Array.isArray(wsDiagActiveClaude) && wsDiagActiveClaude.length > 0}`
    );
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
