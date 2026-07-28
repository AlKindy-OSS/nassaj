/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fs, realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { recordBrokenModel } from './modules/providers/list/claude/claude-broken-models.store.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createNormalizedMessage, stampCoordinatorId, stampHumanUserId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { assertAnthropicBaseUrlAllowed, assertSettingsEnvAllowed } from './services/isolation/anthropic-base-url-guard.js';
import { buildCagedSdkSpawn } from './services/isolation/provider-cage-wiring.js';
import { applyClaudeEngineProviderEnvOrThrow } from './services/isolation/apply-claude-engine-provider-env.js';
import { collectSettingsBaseUrls } from './services/isolation/collect-settings-base-urls.js';
import { buildVendorDelegateMcp } from './modules/providers/shared/vendor/vendor-delegate-mcp.js';
// T-822 (§ج-4): the per-conversation chat-turn lock. BOTH imports are
// side-effect-free (pure function/flag modules — no top-level I/O/timers). The
// lock is engaged ONLY when isChatTurnLockEnabled() (master + the dedicated
// WORKFLOW_SUPERVISOR_CHAT_LOCK sub-flag) is true AND this is a resume; otherwise
// the seam below is a synchronous no-op (byte-identical critical path).
import { isChatTurnLockEnabled } from './modules/workflow-supervisor/config.js';
import { acquireChatTurnLockForLiveTurn } from './modules/workflow-supervisor/chat-turn-lock.js';
import { buildGitAuthorEnv } from './utils/gitIdentity.js';
// T-937 (ADR-064 baseline): neutral, disk-derived ground-truth injected into the
// coordinator session at delegation time to counter replay self-execution. Every
// entry point is fail-safe (never throws / never blocks) — see the module header.
import {
  isCoordinatorInjectionEnabled,
  buildGroundTruthContext,
} from './services/coordinator-ground-truth.js';
// T-938 (ADR-064 baseline ④): phrasing-resistant marker-lock layered on ① to catch
// RE-PHRASED replays of an already-dispatched delegation. WARN-ONLY (soak) and
// absolutely fail-safe — see the module header. Merged into ①'s additionalContext.
import { evaluateMarkerLock } from './services/coordinator-marker-lock.js';
// T-939 (ADR-064 baseline ②): SessionStart-time ground-truth injection. Closes the
// compaction door ① misses — a compaction that never routes through a delegation.
// PreCompact cannot inject; SessionStart (source: compact/resume/startup) can via
// additionalContext. Absolutely fail-safe — see the module header.
import { buildSessionStartContext } from './services/coordinator-session-start.js';
import {
  PROCESS_TAG_ENV_VAR,
  registerSessionProcess,
  unregisterSessionProcess
} from './services/session-process-monitor.js';
import { messageAuthorsDb, participantsDb } from './modules/database/index.js';
import { SessionRegistry } from './session-registry.js';
// ADR-042 (B-80c) ghost-detach: read-only listener-detection seam. Imported one
// way only (writer service NEVER imports claude-sdk — verified, no circularity).
import { countLiveMirrors } from './modules/websocket/services/websocket-writer.service.js';

// ADR-041 (B-80): per-session read-only replay registry for claude, isolated in
// its OWN SessionRegistry instance gated behind SESSION_REGISTRY_claude. When the
// flag is OFF every call here is a cheap no-op and the live stream path is
// byte-for-byte the pre-slice behaviour (coexistence contract). This is a SECOND
// instance of the same engine agy uses — session-registry.js itself is reused
// unchanged. Exported so the websocket layer (check-session-status / attach)
// reads the SAME instance: one source of truth for both the replay buffer and
// the active flag. It NEVER swaps the active writer and NEVER aborts the run —
// it only re-emits buffered payloads (seq > lastSeq) to a reconnecting socket,
// honouring the ADR-021 `if(!isActive)` no-swap veto.
const claudeSessionRegistry = new SessionRegistry('SESSION_REGISTRY_claude', { capacity: 500 });

// B-N-DROP (mirrors agy-cli.js): how long a session's replay buffer is retained
// AFTER the run reaches a terminal state (complete/error) before it is dropped —
// the post-close replay window. A socket that reconnects within this grace
// period can still receive the final payloads via differential attach. After it
// elapses the entry is dropped so the registry never grows unbounded across
// uptime. The timer is cancelled if the same key is reopened/reused first.
const CLAUDE_BUFFER_RETENTION_MS = 120000;

// Pending post-close drop timers keyed by sessionId, so a reopen/reuse of the key
// (resume) can cancel the scheduled drop and keep the buffer alive for the run.
const claudePendingDropTimers = new Map();

// Cancel any scheduled post-close drop for `key`. Called whenever the key is
// reopened or reused before its retention window elapses.
function cancelClaudePendingDrop(key) {
  if (!key) return;
  const timer = claudePendingDropTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    claudePendingDropTimers.delete(key);
  }
}

// B-N-DROP: schedule a deferred drop of `key` after CLAUDE_BUFFER_RETENTION_MS.
// Replaces any previously scheduled drop for the same key. `.unref()` so a
// pending drop never holds the event loop open at shutdown.
function scheduleClaudeBufferDrop(key) {
  if (!key) return;
  cancelClaudePendingDrop(key);
  const timer = setTimeout(() => {
    claudePendingDropTimers.delete(key);
    claudeSessionRegistry.drop(key);
  }, CLAUDE_BUFFER_RETENTION_MS);
  timer.unref?.();
  claudePendingDropTimers.set(key, timer);
}

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Per-connection active-session index (abort robustness, B-ABORT-FALLBACK).
// Maps a raw WebSocket → an insertion-ordered Set of the claude sessionIds that
// are currently active on THAT socket. Lets abortClaudeSDKSession fall back to
// the connection's own newest active run when the client-supplied sessionId is
// missing or stale (the brand-new-session race: the user hits STOP before the
// SDK has reported its real session_id, so the front end has no concrete id to
// send yet). A WeakMap so a closed socket's entry is GC'd with the socket; we
// still prune explicitly in removeSession to keep getNewestSessionForSocket
// accurate while the socket lives.
const sessionsByConnection = new WeakMap(); // rawWs → Set<sessionId> (ordered)

/** Returns the raw underlying socket for a session's writer, or null. */
function rawSocketForSession(session) {
  const ws = session?.writer?.ws ?? session?.writer ?? null;
  return ws && typeof ws === 'object' ? ws : null;
}

/**
 * Resolves the newest still-active claude sessionId bound to a given raw socket.
 * Used as the abort fallback when the supplied id does not resolve. Returns null
 * when the socket has no live session.
 */
function getNewestSessionForSocket(rawWs) {
  if (!rawWs) return null;
  const ids = sessionsByConnection.get(rawWs);
  if (!ids || ids.size === 0) return null;
  let newest = null;
  // Insertion order is preserved by Set; the last live id is the newest run.
  for (const id of ids) {
    if (activeSessions.has(id)) newest = id;
  }
  return newest;
}
// Guards the race window between removeSession() and the next addSession() for
// the same sessionId — a writer swap during this gap would mismatch the new ws.
const recentlyEndedSessions = new Map(); // sessionId → expiry timestamp
const RECENTLY_ENDED_GRACE_MS = 2000;

// ─── ADR-042 (B-80c): ghost-session DETACH (not abort) ──────────────────────
// A claude run keeps its for-await loop consuming the SDK child's stdout even
// after every listener (primary socket + read-only mirrors) is gone — the loop
// is a stdout CONSUMER, not the CLI turn driver. The child owns the session and
// writes its <sessionId>.jsonl incrementally regardless of the socket, so the
// work is on disk independent of the stream. The remaining problem is purely
// the DRAIN COUNT: such a "ghost" stays counted active in `activeSessions`, so
// every `pm2 restart` enters the unbounded graceful drain and hangs until PM2's
// kill_timeout (5min). Fix = DETACH: after a grace period with no listener, flag
// the session `detached` so the drain stops counting it — WITHOUT aborting. We
// never call child.kill()/interrupt/close and never stop the generator; the
// child finishes the turn and writes complete jsonl (zero work lost, matching
// the B-N-DRAIN philosophy that children complete). detach only changes whether
// the session BLOCKS the drain; it never touches the no-swap veto or the stream
// (the writer still fans out to any returning mirror normally).
const GHOST_DETACH_SWEEP_MS = parseInt(process.env.CLAUDE_GHOST_DETACH_SWEEP_MS, 10) || 30000;
const GHOST_DETACH_GRACE_MS = parseInt(process.env.CLAUDE_GHOST_DETACH_GRACE_MS, 10) || 180000;
let ghostSweepTimer = null;

// Separate flag from SESSION_REGISTRY_claude (which gates B-80a replay/buffer —
// an orthogonal concern). OFF by default: the sweep never starts, no session is
// ever flagged detached, and index.js keeps using getActiveClaudeSDKSessions()
// for the drain count byte-for-byte. Coexistence: zero behaviour change until
// explicitly enabled.
function ghostDetachEnabled() {
  const raw = process.env.CLAUDE_GHOST_DETACH;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// One pass over activeSessions: any session whose primary socket is dead AND has
// zero live mirrors for longer than the grace period gets flagged `detached`.
// A session that still has any listener resets its grace counter. NO abort: the
// generator is left to complete and clean itself up via the normal removeSession
// path when the turn ends. Exported for unit tests (ADR-042 test plan).
function sweepGhostSessions(now = Date.now()) {
  if (activeSessions.size === 0) {
    stopGhostSweep();
    return;
  }
  for (const [sid, session] of activeSessions) {
    if (session.detached) continue; // already excluded from the drain count
    const writerAlive = session.writer?.isPrimarySocketAlive?.() === true;
    const liveMirrors = countLiveMirrors(sid);
    if (writerAlive || liveMirrors > 0) {
      // Still has a listener — reset the no-listener clock.
      session.lastListenerSeenAt = now;
      session.noListenerSince = null;
      continue;
    }
    // No listener. Start/continue the grace countdown.
    if (!session.noListenerSince) session.noListenerSince = now;
    if (now - session.noListenerSince >= GHOST_DETACH_GRACE_MS) {
      session.detached = true; // ← excluded from getDrainBlockingClaudeSessions()
      console.log(
        `[GHOST-DETACH] session=${sid} detached after no-listener grace; `
          + 'generator left to complete and write jsonl (no abort)'
      );
    }
  }
}

// Lazy periodic sweep, mirroring session-process-monitor.js: started on first
// addSession (only when the flag is ON), stopped when activeSessions empties.
// .unref() so it never keeps the event loop alive at shutdown/drain.
function startGhostSweep() {
  if (ghostSweepTimer || !ghostDetachEnabled()) return;
  ghostSweepTimer = setInterval(() => sweepGhostSessions(), GHOST_DETACH_SWEEP_MS);
  ghostSweepTimer.unref?.();
}

function stopGhostSweep() {
  if (!ghostSweepTimer) return;
  clearInterval(ghostSweepTimer);
  ghostSweepTimer = null;
}
// ────────────────────────────────────────────────────────────────────────────

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// B-117: how long the streaming-input prompt (and therefore the control channel
// the CLI answers hook callbacks / permission prompts on) is held open after a
// `result` before we close it and let the CLI exit. Long enough to cover a
// continuation that starts right after a result — a background-task notification
// or a queued message re-entering the loop — short enough that an idle run does
// not keep a CLI process alive. Any CLI message re-disarms the timer. Read per
// run (not frozen at import) so it stays overridable in tests and by env.
const sdkInputCloseGraceMs = () =>
  parseInt(process.env.CLAUDE_SDK_INPUT_CLOSE_GRACE_MS, 10) || 8000;

// B-SEC-APPROVAL-WEDGE: hard ceiling for the INTERACTIVE tools below, which used
// to be handed `timeoutMs: 0` — "wait forever" (see waitForToolApproval). A user
// who closed the tab on an AskUserQuestion/ExitPlanMode prompt wedged the SDK
// generator permanently: its `activeSessions` entry was never removed, so the
// safe-restart gate counted a live session for the rest of the process's life and
// deferred EVERY deployment (ghost-detach is not armed in production and
// DRAIN_TIMEOUT_MS=0). 30 minutes is far beyond any realistic human answer time
// (the non-interactive default is 55s) while guaranteeing the wedge always ends.
const INTERACTIVE_APPROVAL_MAX_WAIT_MS =
  parseInt(process.env.CLAUDE_INTERACTIVE_APPROVAL_TIMEOUT_MS, 10) || 1800000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// [B117-SIGNATURE] Monitoring only (T-250, docs/plans/B117-DIAGNOSIS.md §1.1 + §5).
// The literal "Tool permission request failed: Stream closed" is emitted INSIDE
// the bundled CLI binary (CLI→SDK direction) when it cannot send the can_use_tool
// control_request over a closed stdin — it is returned to the model as a deny and
// therefore surfaces in the message STREAM (result text / tool_result content),
// NOT through the nassaj canUseTool callback. So the callback-level [B117-DENY]
// probe alone cannot catch this string; this scanner over the read loop is the
// only nassaj-side point that can. Pure read: it inspects likely carriers and
// returns the matched text (or null); it never mutates the message or the stream.
const B117_FAILURE_SIGNATURE = 'Tool permission request failed';
function scanB117Signature(message) {
  try {
    if (typeof message?.result === 'string' && message.result.includes(B117_FAILURE_SIGNATURE)) {
      return message.result;
    }
    const content = message?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        // tool_result blocks: `content` is a string or an array of {type,text}
        const inner = block.content;
        if (typeof inner === 'string' && inner.includes(B117_FAILURE_SIGNATURE)) return inner;
        if (Array.isArray(inner)) {
          for (const part of inner) {
            const t = part && typeof part.text === 'string' ? part.text : '';
            if (t.includes(B117_FAILURE_SIGNATURE)) return t;
          }
        }
        // assistant text narrating the failure
        if (typeof block.text === 'string' && block.text.includes(B117_FAILURE_SIGNATURE)) {
          return block.text;
        }
      }
    }
  } catch { /* monitoring must never break the read loop */ }
  return null;
}

/**
 * Detects the Claude Code "stale resume" failure: a `--resume <id>` (SDK
 * `resume` option) request whose conversation no longer exists on disk. The
 * CLI/SDK surfaces this as a thrown error or an error result whose text reads
 * e.g. "No conversation found with session ID: <uuid>". We match defensively on
 * the stable substring so we can transparently restart as a fresh session
 * instead of dead-ending the user's message. Narrowly scoped on purpose: any
 * other resume failure keeps the original error behaviour.
 */
function isResumeSessionMissingError(value) {
  if (!value) {
    return false;
  }
  const text = typeof value === 'string' ? value : (value.message || String(value));
  return /no conversation found with session id/i.test(text);
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

/**
 * Hands a decision to the waiting canUseTool promise with NO authorization
 * check. Reserved for the SERVER's own lifecycle paths (abort, run error, loss
 * of every listener) which are authorized by construction. Every CLIENT-sourced
 * answer must go through {@link resolveToolApproval}.
 *
 * @returns {boolean} true when a pending approval was actually settled.
 */
function settleToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (!resolver) {
    return false;
  }
  resolver(decision);
  return true;
}

/**
 * B-SEC-APPROVAL-WEDGE: cancels a pending approval the moment the run loses its
 * LAST listener, so a closed tab can no longer wedge the SDK generator forever.
 *
 * Registers a one-shot `close` listener on the raw socket the writer is bound to
 * NOW. When it fires we re-check the run's CURRENT listeners with the same seam
 * ADR-042's ghost sweep uses — the writer's live socket (which may have been
 * swapped to a reconnecting tab in the meantime) plus the read-only mirrors — and
 * only cancel when there is genuinely nobody left to answer. That keeps the
 * documented mirror behaviour intact: a second viewer can still answer an
 * approval whose originating socket is gone.
 *
 * Returns a detach function (call it once the approval settles so the listener is
 * never accumulated on a long-lived socket), or null when the writer exposes no
 * EventEmitter surface (SSE writers, test doubles) — in which case the hard
 * timeout ceiling remains the backstop.
 */
function watchApprovalListenerLoss(requestId, writer, sessionKey) {
  const rawWs = writer && typeof writer === 'object' ? writer.ws : null;
  if (!rawWs || typeof rawWs.once !== 'function') {
    return null;
  }

  const onClose = () => {
    if (writer.isPrimarySocketAlive?.() === true) {
      return; // the writer already moved to a live socket (reconnect)
    }
    let liveMirrors = 0;
    try {
      liveMirrors = sessionKey ? countLiveMirrors(sessionKey) : 0;
    } catch {
      liveMirrors = 0;
    }
    if (liveMirrors > 0) {
      return; // another viewer is still watching and can answer
    }
    if (settleToolApproval(requestId, { allow: false, cancelled: true })) {
      console.log(
        `[SEC-APPROVAL] cancelled pending approval requestId=${requestId} `
        + `session=${sessionKey || 'none'} reason=no-listener-left`
      );
    }
  };

  rawWs.once('close', onClose);
  return () => {
    try {
      if (typeof rawWs.off === 'function') {
        rawWs.off('close', onClose);
      } else if (typeof rawWs.removeListener === 'function') {
        rawWs.removeListener('close', onClose);
      }
    } catch {
      /* detaching must never break the permission path */
    }
  };
}

/** Normalizes an identity to a comparable string, or null when absent. */
function normalizeApprovalIdentity(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

/**
 * B-SEC-APPROVAL-OWNERSHIP — the authorization core for a tool-approval answer.
 *
 * A `claude-permission-response` used to be applied to whatever `requestId` it
 * named, with NO ownership check whatsoever, which made three things possible
 * for any authenticated socket that learned a requestId (and
 * `get-pending-permissions` handed those out for any active session):
 *   1. approving/denying another user's tool prompt;
 *   2. `updatedInput` — the SDK executes `decision.updatedInput ?? input`, so the
 *      attacker's payload REPLACES the model's tool input (e.g. the Bash command
 *      the user is being asked to confirm);
 *   3. `rememberEntry` — pushed into the run's `allowedTools`, permanently
 *      auto-approving a tool (e.g. `Bash`) for the rest of the session.
 *
 * Roles:
 *   - OWNER (the JWT identity that spawned the run, captured when the prompt was
 *     created): full decision, `updatedInput`/`rememberEntry` honoured — this is
 *     the UI's legitimate "edit before approving" / "always allow" feature.
 *   - COLLABORATOR (a recorded participant/author of that same session — the
 *     live-viewer case the read-only mirrors exist for): may only ALLOW or DENY.
 *     `updatedInput` and `rememberEntry` are STRIPPED, so a second viewer can
 *     unblock a prompt but can never rewrite what runs nor widen the session's
 *     standing permissions.
 *   - STRANGER: refused outright; the approval stays pending for its real owner.
 *
 * Identity comparison is string-normalized, so a deployment with no identities at
 * all (single-user / unauthenticated, owner === requester === null) behaves
 * exactly as before. Pure function — no I/O, no mutation of the input decision —
 * exported for unit tests.
 *
 * @param {object} params
 * @param {string|number|null} params.ownerUserId Identity captured at prompt creation.
 * @param {string|number|null} params.requesterUserId JWT identity of the answering socket.
 * @param {boolean|(() => boolean)} [params.isCollaborator] Session-membership predicate,
 *   evaluated ONLY when the requester is not the owner (so the database is never
 *   touched on the hot owner path).
 * @param {object} params.decision Raw decision payload from the transport.
 * @returns {{ allowed: boolean, role: 'owner'|'collaborator'|'stranger', decision: object|null }}
 */
function authorizeApprovalDecision({ ownerUserId, requesterUserId, isCollaborator = false, decision }) {
  const safeDecision = decision && typeof decision === 'object' ? decision : {};
  const owner = normalizeApprovalIdentity(ownerUserId);
  const requester = normalizeApprovalIdentity(requesterUserId);

  if (owner === requester) {
    return { allowed: true, role: 'owner', decision: safeDecision };
  }

  const collaborator =
    typeof isCollaborator === 'function' ? isCollaborator() === true : isCollaborator === true;
  if (!collaborator) {
    return { allowed: false, role: 'stranger', decision: null };
  }

  // Strip the two privileged fields; everything else (allow/message) passes.
  const { updatedInput: _droppedInput, rememberEntry: _droppedRemember, ...rest } = safeDecision;
  return { allowed: true, role: 'collaborator', decision: rest };
}

/**
 * Is `requesterUserId` a recorded participant/author of `sessionId`? The same
 * B-105 predicate the REST layer uses to authorize session content. Fail-closed:
 * an unresolvable id, an unknown session or any database error answers false.
 */
function isApprovalSessionCollaborator(sessionId, requesterUserId) {
  if (!sessionId) {
    return false;
  }
  const numericUserId = Number.parseInt(requesterUserId, 10);
  if (!Number.isInteger(numericUserId)) {
    return false;
  }
  try {
    return participantsDb.isParticipant(sessionId, numericUserId) === true;
  } catch {
    return false;
  }
}

/**
 * Client-facing entry point for answering a tool-approval prompt. Enforces
 * {@link authorizeApprovalDecision} before the decision can reach the waiting
 * SDK callback. `decision.requesterUserId` is stamped by the websocket layer
 * from the JWT-authenticated socket — never read from the client payload.
 */
function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (!resolver) {
    return;
  }

  const payload = decision && typeof decision === 'object' ? decision : {};
  const requesterUserId = payload.requesterUserId ?? null;
  const sessionId = resolver._sessionId ?? null;

  const verdict = authorizeApprovalDecision({
    ownerUserId: resolver._ownerUserId ?? null,
    requesterUserId,
    isCollaborator: () => isApprovalSessionCollaborator(sessionId, requesterUserId),
    decision: payload,
  });

  if (!verdict.allowed) {
    console.warn(
      `[SEC-APPROVAL] refused foreign permission response requestId=${requestId} `
      + `session=${sessionId || 'none'} owner=${JSON.stringify(resolver._ownerUserId ?? null)} `
      + `requester=${JSON.stringify(requesterUserId)}`
    );
    return;
  }

  if (verdict.role === 'collaborator') {
    console.log(
      `[SEC-APPROVAL] collaborator answered requestId=${requestId} session=${sessionId || 'none'} `
      + `requester=${JSON.stringify(requesterUserId)} (updatedInput/rememberEntry stripped)`
    );
  }

  resolver(verdict.decision);
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Builds the set of model values the send path will accept.
 *
 * Union of the LIVE/cached dynamic Claude catalog (same source the picker reads)
 * and the static {@link CLAUDE_FALLBACK_MODELS} OPTIONS as a safety net. The
 * static list alone does NOT contain dynamically-discovered models (e.g.
 * `claude-opus-4-9`), so validating against it rejected real picker selections
 * and coerced them to default. Including the dynamic catalog fixes that while
 * keeping the static list as a floor for when the catalog is unavailable.
 *
 * Pure/synchronous: it accepts an already-resolved catalog definition (the
 * caller pulls it from the cached, non-blocking SWR layer) so the hot send path
 * never awaits a live probe here.
 *
 * @param {ProviderModelsDefinition|null|undefined} catalog - Dynamic catalog
 *   (e.g. from providerModelsService.getProviderModels('claude')). May be null
 *   when the catalog is unavailable; only the static list is used then.
 * @returns {Set<string>} Valid model values.
 */
function buildValidClaudeModelValues(catalog) {
  const values = new Set();
  // Static safety net first — always valid even if the catalog is empty/broken.
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    if (option && typeof option.value === 'string') {
      values.add(option.value);
    }
  }
  // Dynamic catalog (the live/stored source the picker uses), if available.
  const dynamicOptions = Array.isArray(catalog?.OPTIONS) ? catalog.OPTIONS : [];
  for (const option of dynamicOptions) {
    if (option && typeof option.value === 'string') {
      values.add(option.value);
    }
  }
  return values;
}

/**
 * Lazy model-discovery backstop (B-MODEL-DISCOVERY): detects, from a streamed SDK
 * message, that the model this run launched with is not actually usable for the
 * account — i.e. it was advertised by the authenticated catalog but Anthropic has
 * not enabled it. The SDK surfaces this two ways:
 *   - an `assistant` message whose `error` is 'model_not_found'
 *     (SDKAssistantMessageError union), or
 *   - a `result` message carrying `api_error_status === 404`
 *     (HTTP 404 from the models endpoint; present on SDKResultSuccess).
 * Pure read — it inspects the message only and returns a boolean. It never
 * mutates the message, the stream, the registry, or any session state, so it is
 * safe to call inside the B-80 send loop alongside the existing result/token
 * inspection. When true, the caller records the offending model in the per-user
 * broken-models store so the catalog hides it next time.
 *
 * @param {Object} message - One streamed SDK message.
 * @returns {boolean} True when the message signals the run's model is unreleased.
 */
function isUnreleasedModelFailure(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  if (message.type === 'assistant' && message.error === 'model_not_found') {
    return true;
  }
  if (message.type === 'result' && message.api_error_status === 404) {
    return true;
  }
  return false;
}

/**
 * Effort levels natively accepted by the Agent SDK `Options.effort` field
 * (EffortLevel in @anthropic-ai/claude-agent-sdk sdk.d.ts). The SDK forwards
 * the value verbatim to the CLI as `--effort <level>`.
 */
const SDK_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * UI-contract values that are NOT SDK effort levels but are part of the
 * terminal `/effort` vocabulary:
 *  - 'auto'      → "use the model's default effort" → omit the SDK option.
 *  - 'ultracode' → the UI's maximum-intensity mode (intensity 4). It is NOT a
 *    value the SDK `Options.effort` type accepts, and the underlying CLI does
 *    not recognize 'ultracode' as an effort level either (its effort vocabulary
 *    is low|medium|high|xhigh|max). 'ultracode' is two things at once:
 *      1. Maximum reasoning effort — mapped here to the SDK level 'max' (the
 *         true ceiling, intensity 4; previously this was downgraded to 'xhigh',
 *         which made ultracode indistinguishable from the xhigh mode).
 *      2. The CLI's prompt-keyword super-modes ("deeper reasoning" + "multi-agent
 *         workflow orchestration"), which the SDK `effort` field cannot express.
 *         The CLI activates these from magic keywords in the prompt text (it
 *         scans for /\bultrathink\b/i and /\bultrawork\b/i). That half is applied
 *         in runClaudeSDKQuery via maybeApplyUltracodeKeywords(), keyed off
 *         resolveEffortLevel(...).alias === 'ultracode'.
 */
const EFFORT_ALIASES = new Map([
  ['auto', null],
  ['ultracode', 'max'],
]);

/**
 * Magic keywords the Claude Code CLI scans for in the prompt text to activate
 * its highest-tier session behaviors — the half of "ultracode" that the SDK
 * `Options.effort` field cannot carry:
 *   - 'ultrathink' → "Deeper reasoning requested for this turn" (max extended thinking).
 *   - 'ultrawork'  → "Multi-agent workflow requested for this turn" (the CLI is
 *     instructed to use the Workflow tool / dynamic-workflow orchestration).
 * Verified against the bundled CLI binary's keyword detectors (`/\bultrathink\b/i`,
 * `/\bultrawork\b/i`). Both are appended on their own line, separated from the
 * user's prompt, so the words are detected without colliding with prompt text.
 */
const ULTRACODE_PROMPT_KEYWORDS = 'ultrathink ultrawork';

/**
 * Appends the ultracode CLI keywords to the prompt when the UI requested the
 * 'ultracode' effort mode. Mirrors how the terminal `/effort ultracode` flow
 * surfaces those keywords to the CLI. No-op (returns the command unchanged) for
 * every other effort value, so normal prompts are never mutated.
 *
 * @param {string} command - The (possibly image-annotated) prompt text.
 * @param {unknown} effortValue - Raw `effort` field from the chat options.
 * @returns {string} The prompt, with the ultracode keywords appended when applicable.
 */
function maybeApplyUltracodeKeywords(command, effortValue) {
  const { alias } = resolveEffortLevel(effortValue);
  if (alias !== 'ultracode') {
    return command;
  }
  const base = typeof command === 'string' ? command : '';
  // Separate the keywords onto their own line so word-boundary detection in the
  // CLI fires cleanly regardless of how the user's prompt ends.
  return base ? `${base}\n\n${ULTRACODE_PROMPT_KEYWORDS}` : ULTRACODE_PROMPT_KEYWORDS;
}

/**
 * Validates a UI-supplied effort value against the allowlist and resolves it
 * to an SDK-compatible level.
 *
 * @param {unknown} value - Raw `effort` field from the chat message options.
 * @returns {{ level: string|null, alias: string|null, rejected: string|null }}
 *   level    - SDK effort level to apply, or null to omit the option.
 *   alias    - The original alias when a mapping occurred (e.g. 'ultracode').
 *   rejected - The original value when it was not in the allowlist (safe-ignore).
 */
function resolveEffortLevel(value) {
  if (typeof value !== 'string') {
    return { level: null, alias: null, rejected: null };
  }
  const requested = value.trim().toLowerCase();
  if (requested === '') {
    return { level: null, alias: null, rejected: null };
  }
  if (SDK_EFFORT_LEVELS.has(requested)) {
    return { level: requested, alias: null, rejected: null };
  }
  if (EFFORT_ALIASES.has(requested)) {
    return { level: EFFORT_ALIASES.get(requested), alias: requested, rejected: null };
  }
  return { level: null, alias: null, rejected: requested };
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @param {Set<string>} [validModelValues] - Set of accepted model values. When
 *   provided (by queryClaudeSDK), it is the union of the dynamic Claude catalog
 *   and the static fallback list. When omitted, validation falls back to the
 *   static CLAUDE_FALLBACK_MODELS.OPTIONS only (preserves prior behavior and
 *   keeps the function usable standalone, e.g. in unit tests).
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}, validModelValues) {
  const { sessionId, cwd, toolsSettings, permissionMode } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  //
  // Vendor-resilience iron rule (fail-closed): before forwarding, refuse to spawn
  // if ANTHROPIC_BASE_URL points the Claude/Anthropic path at a non-approved host.
  // No-op when unset (default Anthropic). See anthropic-base-url-guard.js. The
  // final env is re-validated at the spawn site below after per-user isolation,
  // since that step also carries the host env through.
  assertAnthropicBaseUrlAllowed(process.env);
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Delegation must never depend on a permission round-trip.
  //
  // NOTE — this allow-listing was NOT the cure for the phantom "the user doesn't
  // want to proceed" refusals; the earlier diagnosis recorded here was wrong and
  // the refusals continued after it shipped. The real cause is the control stream
  // closing at the first `result` (see the B-117 block in queryClaudeSDK): the
  // tool is cancelled at ENTRY, before any permission check, because its
  // PreToolUse SDK-callback hook cannot be run. That is fixed by the streaming
  // prompt, not here.
  //
  // What this still buys: Task/Agent answer from a settings rule instead of a
  // round-trip, which matches the policy already declared in managed-settings
  // (`Agent(*)`), and it does NOT widen what a subagent may then do — the child
  // runs under its own permission gates. Both spellings are listed because the
  // tool name varies across SDK versions (the codebase already checks for either
  // — see the PreToolUse matcher below).
  for (const tool of ['Task', 'Agent']) {
    if (!allowedTools.includes(tool)) allowedTools.push(tool);
  }

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // Map model with validation against the accepted-model set.
  // The set is the union of the LIVE/cached dynamic Claude catalog (same source
  // the picker reads, e.g. claude-opus-4-9) and the static CLAUDE_FALLBACK_MODELS
  // safety net. queryClaudeSDK passes it in from the cached SWR layer; when it is
  // omitted (e.g. standalone/unit callers) we fall back to the static list only.
  // Any value not in the set (the UI's "auto" sentinel, empty, whitespace, a
  // truly unknown string) is rejected by the SDK, so we coerce it to the provider
  // default here and emit a non-silent warning (no silent substitution).
  const acceptedModels = validModelValues instanceof Set && validModelValues.size > 0
    ? validModelValues
    : buildValidClaudeModelValues(null);
  const requested = typeof options.model === 'string' ? options.model.trim() : '';
  const isKnownModel = requested !== '' && acceptedModels.has(requested);
  if (isKnownModel) {
    sdkOptions.model = requested;
  } else {
    sdkOptions.model = CLAUDE_FALLBACK_MODELS.DEFAULT;
    if (requested) {
      const sessionTag = sessionId ? ` [session=${sessionId}]` : '';
      const userTag = options.userId ? ` [user=${options.userId}]` : '';
      console.warn(
        `model "${requested}" not in CLAUDE OPTIONS; falling back to "${CLAUDE_FALLBACK_MODELS.DEFAULT}"${sessionTag}${userTag}`
      );
    }
  }
  // Model logged at query start below

  // Map effort (B: structured effort field from the UI, same path as model).
  // Allowlist: low|medium|high|xhigh|max (SDK EffortLevel) plus the UI aliases
  // 'auto' (omit → model default) and 'ultracode' (mapped to 'max' — the SDK
  // ceiling, intensity 4). The "deeper reasoning + multi-agent workflow" half of
  // ultracode is applied separately in runClaudeSDKQuery via prompt keywords,
  // because the SDK Options.effort field cannot express it. Anything else is
  // ignored safely with a non-silent warning — never forwarded to the SDK.
  const { level: effortLevel, alias: effortAlias, rejected: rejectedEffort } =
    resolveEffortLevel(options.effort);
  if (effortLevel) {
    sdkOptions.effort = effortLevel;
    if (effortAlias) {
      console.warn(
        `effort "${effortAlias}" mapped to SDK level "${effortLevel}" (alias outside SDK EffortLevel)`
      );
    }
  } else if (rejectedEffort) {
    const sessionTag = sessionId ? ` [session=${sessionId}]` : '';
    console.warn(
      `effort "${rejectedEffort}" not in allowlist (low|medium|high|xhigh|max|ultracode|auto); ignoring${sessionTag}`
    );
  }

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Probes the Claude Agent SDK for its built-in slash commands.
 *
 * Uses a streaming-input (async generator) `query` that NEVER yields a turn:
 * `supportedCommands()` is a control request that the SDK answers from the
 * init handshake alone — no model call, no token cost, no user input. We then
 * `interrupt()` and let the never-resolving generator be GC'd so the SDK child
 * process tears down immediately.
 *
 * Guarantees:
 *  - No turn/prompt is ever sent (the generator awaits a release promise and
 *    only ends after cleanup — it yields nothing before then).
 *  - Hard timeout (default 4s): on overrun we interrupt and resolve `null`.
 *  - Every error path swallows and returns `null` (never throws upward).
 *  - The SDK process is always interrupted/released, even on error/timeout, so
 *    no child process leaks.
 *
 * @param {Object} [context] - Optional context. `userId` selects the per-user
 *   Claude config dir via resolveProviderEnv; `cwd` sets the working directory.
 * @returns {Promise<Array<{name:string,description?:string,aliases?:string[],argumentHint?:string}>|null>}
 *   Normalized command list, or `null` on any failure/timeout/old SDK.
 */
async function getClaudeBuiltInCommands(context = {}) {
  const { userId = null, cwd = null } = context;
  const PROBE_TIMEOUT_MS = 4000;

  // Controls the async generator's lifetime. The generator awaits this promise
  // and yields nothing, so no turn is ever produced. Resolving it ends the
  // generator (after we've already pulled supportedCommands()).
  let releaseGenerator;
  const releasePromise = new Promise((resolve) => {
    releaseGenerator = resolve;
  });

  // A streaming-input prompt: an async generator that emits zero turns.
  async function* emptyPromptStream() {
    await releasePromise;
    // Intentionally yields nothing — keeps the session in streaming-input mode
    // without sending any user message to the model.
  }

  let queryInstance = null;
  let timeoutHandle = null;

  // Resolve env the same way the live chat path does so the probe runs under
  // the correct Claude config dir / credentials (no elevated privileges).
  let probeEnv = { ...process.env };
  try {
    probeEnv = resolveProviderEnv(userId, 'claude', probeEnv);
  } catch {
    // Fall back to the base env; never let env resolution break the probe.
    probeEnv = { ...process.env };
  }

  const cleanup = async () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    // Release the generator so it completes and the SDK can shut down.
    if (releaseGenerator) {
      releaseGenerator();
      releaseGenerator = null;
    }
    if (queryInstance && typeof queryInstance.interrupt === 'function') {
      try {
        await queryInstance.interrupt();
      } catch {
        // Interrupt failures are non-fatal — the released generator + GC still
        // tears the process down.
      }
    }
  };

  try {
    const sdkOptions = {
      env: probeEnv,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      // No tools/prompt/model work happens; keep options minimal & deterministic.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };
    if (cwd) {
      sdkOptions.cwd = cwd;
    }

    // Iron-rule guard: this probe also spawns the Claude/Anthropic subprocess,
    // so fail-closed if ANTHROPIC_BASE_URL targets a non-approved host. No-op
    // when unset (default Anthropic). Also validate the per-user settings.json
    // env block the CLI applies from CLAUDE_CONFIG_DIR (same bypass surface).
    assertAnthropicBaseUrlAllowed(sdkOptions.env);
    assertSettingsEnvAllowed(sdkOptions.env.CLAUDE_CONFIG_DIR, sdkOptions.env);

    // T-897: cage this probe's Claude spawn too (flag OFF ⇒ undefined ⇒ unset).
    const cagedProbeSpawn = buildCagedSdkSpawn({ userId, cwd: cwd ?? null });
    if (cagedProbeSpawn) {
      sdkOptions.spawnClaudeCodeProcess = cagedProbeSpawn;
    }

    queryInstance = query({
      prompt: emptyPromptStream(),
      options: sdkOptions,
    });

    const commandsPromise = queryInstance.supportedCommands();

    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve('__probe_timeout__'), PROBE_TIMEOUT_MS);
    });

    const result = await Promise.race([commandsPromise, timeoutPromise]);

    if (result === '__probe_timeout__' || !Array.isArray(result)) {
      return null;
    }

    // Normalize to the shape the route merges. Drop entries without a name.
    return result
      .filter((cmd) => cmd && typeof cmd.name === 'string' && cmd.name.length > 0)
      .map((cmd) => ({
        name: cmd.name,
        description: typeof cmd.description === 'string' ? cmd.description : '',
        ...(Array.isArray(cmd.aliases) && cmd.aliases.length > 0 ? { aliases: cmd.aliases } : {}),
        ...(typeof cmd.argumentHint === 'string' && cmd.argumentHint
          ? { argumentHint: cmd.argumentHint }
          : {}),
      }));
  } catch {
    // Any failure (old SDK without supportedCommands, spawn error, etc.) → null.
    return null;
  } finally {
    await cleanup();
  }
}

// ── /btw side query (T-881, ADR "البديل 2") ─────────────────────────────────
// A TRANSIENT, read-only "by the way" question answered against a LIVE session's
// conversation WITHOUT touching the live stream. It FORKS the resumed session via
// the SDK (`resume` + `forkSession:true`) so neither the original `<liveSid>.jsonl`
// nor the live run is ever disturbed, streams the answer straight back to the
// requesting socket, and is NEVER registered in `activeSessions` — so the drain
// count, the ghost-detach sweep and the WebSocketWriter fan-out mirrors never see
// it. This is deliberately a sibling of getClaudeBuiltInCommands (an ephemeral,
// non-registered query), NOT of runClaudeSDKQuery (the live, registered stream).
//
// qa-critic gate mapping (C1–C5):
//   C1 — HARD gate: `resume` + `forkSession:true` ONLY. A bare `resume` would
//        append this turn to `<liveSid>.jsonl` AND overwrite the live
//        `activeSessions[liveSid]` writer. `persistSession:false` is layered on
//        top so the FORK writes nothing to disk at all (belt-and-suspenders; even
//        without it, forkSession routes writes to a NEW id, so the original is
//        never appended to).
//   C2 — no addSession(): the fork is a private query for THIS requester; it is
//        invisible to the drain-blocking set, ghost-detach and the mirror fan-out.
//        Output goes ONLY to the caller-supplied callbacks (the WS layer forwards
//        them to the requesting socket alone — no NormalizedMessage, no sessionId
//        key, so WebSocketWriter fan-out is structurally impossible).
//   C3 — env is rebuilt via resolveProviderEnv for the REQUESTING user (their own
//        Claude config dir / credentials, never the session owner's quota); the
//        Anthropic base-URL iron guard + engine-provider guard + settings-env
//        guard all run fail-closed before spawn; and a canUseTool ALLOWLIST wall
//        (A-2) admits only Read/Grep/Glob/NotebookRead, each confined to the root, and
//        denies every other tool — a read-only, project-scoped query.
//   C4 — resumeSessionAt := upToMessageId when the client pins one (SDK 0.3.152
//        exposes Options.resumeSessionAt — verified in sdk.d.ts:1706).
//   C5 — the fork materialises from the LAST MESSAGE PERSISTED ON DISK in
//        `<liveSid>.jsonl`. A live turn still mid-flight (its half not yet flushed)
//        is NOT visible to the fork — the side answer reflects the conversation as
//        of the last saved message, not the in-progress one.
//
// A-2.1: a read-only side query may run ONLY these inspection tools. The answer
// can read files, grep and glob WITHIN the session's project, but nothing may
// write, execute, browse the web, or prompt interactively. This allowlist is the
// authoritative gate inside canUseTool below.
//
// NotebookRead (added 2026-07-29, owner-approved widening): a .ipynb is a file the
// fork could already Read as raw JSON — NotebookRead only renders the SAME bytes
// cell-by-cell. It reaches no new resource, no network and no execution, and it is
// path-confined exactly like Read (its `notebook_path`, see the REQUIRED-path map
// in confineBtwToolPathToProject). Net widening of the threat model: none.
//
// ⚠️ DELIBERATELY NOT ADDED — ReadMcpResource / ListMcpResources. They read a
// CONNECTED MCP SERVER, not the project: on this host that set includes external,
// credential-backed connectors (mail/drive/notes/accounting). Admitting them would
// hand a side query a data-egress path far WIDER than the WebFetch/WebSearch the
// design already refuses, while wearing a "read-only" label — and no path
// confinement applies to a `server`/`uri` pair. They stay denied, and are listed in
// BTW_DISALLOWED_TOOLS below so the exclusion is explicit rather than incidental.
const BTW_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'NotebookRead'];
const BTW_ALLOWED_TOOL_SET = new Set(BTW_ALLOWED_TOOLS);

// A-2.2 companions to the allowlist: HOW each allowed tool's target path is found,
// so confineBtwToolPathToProject can anchor it to the project root. A tool absent
// from BOTH tables is refused by that function even if it is allowlisted — the
// allowlist and the confinement map must be extended together, by construction.
const BTW_REQUIRED_PATH_FIELD = { Read: 'file_path', NotebookRead: 'notebook_path' };
const BTW_OPTIONAL_PATH_TOOLS = new Set(['Grep', 'Glob']);

// Mutating/execution/web tools refused outright at the config layer (read-only
// posture, C3 + A-2.1). WebFetch/WebSearch are denied here too so a /btw fork can
// never reach the network, and the MCP resource readers so it can never reach a
// connected server's data (see the note above). Belt-and-suspenders: even without
// this list the canUseTool allowlist would deny anything outside BTW_ALLOWED_TOOLS.
const BTW_DISALLOWED_TOOLS = [
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Bash', 'BashOutput', 'KillShell',
  'WebFetch', 'WebSearch',
  'ReadMcpResource', 'ListMcpResources',
];
// B-270/T-1045: the fork inherits the LIVE session context (its CLAUDE.md habits,
// its "delegate to Agent" reflex, its Bash usage). On a general question the model
// reaches for a tool OUTSIDE the read-only allowlist on its very first turn; the
// PreToolUse hook denies it, and with only 2 turns the fork exhausts its budget
// and returns an is_error result with no text (→ the bare "Side query failed." the
// owner saw). Ceilings raised to leave room for a legitimate read or two plus a
// final answer, still bounded so a fork can never run away:
//   - MAX_TURNS 2 → 8: one denied first attempt no longer starves the budget; the
//     model can issue one or two in-project Read/Grep/Glob calls (each ≈ a turn to
//     call + a turn to consume the result) and still emit a text answer.
//   - TIMEOUT 60s → 120s: a pure-text answer on a ~1.9MB session was measured at
//     56s; adding a legitimate file read plus a larger transcript needs headroom.
//     The client fallback timer (BTW_FALLBACK_TIMEOUT_MS = 20s) is cleared by the
//     `btw-accepted` frame sent BEFORE the fork spawns, so it does not cap this.
const BTW_MAX_TURNS = 8;
const BTW_DEFAULT_TIMEOUT_MS = 120000;

// B-270/T-1045: steering appended to the claude_code preset (SDK 0.3.152 supports
// `append` on a preset systemPrompt — sdk.d.ts:1908). It does NOT widen the fork's
// permissions (the allowlist + hook are unchanged and authoritative); it tells the
// model to answer from the conversation already in context and NOT to reach for the
// tools the cage hard-denies, so a general question no longer burns its whole turn
// budget on doomed Agent/Bash attempts.
const BTW_SIDE_QUERY_DIRECTIVE = [
  'SIDE-QUESTION MODE (this overrides the surrounding conversation for THIS reply).',
  'A one-off "by the way" (/btw) question has been opened about the CURRENT',
  'conversation while the main task keeps running elsewhere. For this single reply:',
  '- You are NOT continuing the task and you are NOT acting as the coordinator or any',
  '  agent. You do not launch, run, fix, deploy, or delegate anything. Even if the',
  '  question reads like an instruction to do work, treat it ONLY as a question to',
  '  answer in words.',
  '- Answer briefly and directly from the conversation already in context: a few',
  '  sentences, no preamble, no restating the question, then STOP.',
  '- The ONLY tools you may use are Read, Grep, Glob and NotebookRead, and ONLY inside',
  '  this project directory, and only to confirm a detail the transcript lacks. Use them',
  '  sparingly.',
  '- You MUST NOT use the Agent or Task tool (no subagents/delegation), MUST NOT run',
  '  Bash or any command, MUST NOT edit anything, and MUST NOT use the network. These',
  '  are hard-denied for a side query: every attempt is rejected and only burns your',
  '  small turn budget, so do not attempt them even once.',
  '- If the answer is not in context and an in-project read cannot find it, say so',
  '  briefly instead of reaching for any other tool.',
].join('\n');

// B-270/T-1045: the appended system directive alone was overpowered by a heavily
// delegation-primed live session (field repro: the fork tried the Agent tool anyway
// and hung to timeout). The LAST user message is the strongest, most recent signal
// the model weighs, so the question is also wrapped with a terse framing line —
// belt-and-suspenders steering, NOT a permission change.
function frameBtwPrompt(question) {
  return (
    '[/btw side question — answer briefly from the conversation context. Do NOT '
    + 'delegate (no Agent/Task), do NOT run commands (Bash) or edit/deploy anything; '
    + 'only Read/Grep/Glob/NotebookRead inside this project are available. Answer in '
    + 'words, then stop.]'
    + '\n\n'
    + question
  );
}

/**
 * Resolve symlinks on the deepest EXISTING ancestor of an absolute path and
 * re-attach the trailing not-yet-existing components verbatim. This lets a real
 * (symlink-following) boundary check be applied even to paths that don't exist
 * yet — a Read of a not-created-yet file, or a Glob root — without falsely
 * rejecting them, while STILL resolving every symlink COMPONENT that does exist.
 *
 * @param {string} targetAbs Absolute (already path.resolve'd) path.
 * @returns {string|null} An absolute, symlink-resolved path, or null when the
 *   chain cannot be resolved safely (a permission / ELOOP error, or nothing on
 *   the chain exists). Callers MUST treat null as "refuse".
 */
function realpathBestEffort(targetAbs) {
  let current = targetAbs;
  const trailing = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        // Non-ENOENT (EACCES, ELOOP, …) ⇒ cannot resolve safely ⇒ refuse.
        return null;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null; // Reached the filesystem root with nothing existing.
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * A-2.2 path confinement for the /btw read-only tools. The fork may only inspect
 * paths INSIDE the session's project root:
 *   - Read         → input.file_path (required — no/blank path is denied)
 *   - NotebookRead → input.notebook_path (required — same rule as Read)
 *   - Grep/Glob    → input.path (optional; omitted/blank ⇒ resolved on the project
 *     cwd, so it is allowed)
 *   - anything else → DENIED (fail-closed; see the else branch)
 * A relative or omitted path resolves against the project root (allowed); an
 * ABSOLUTE path outside the root — or a relative path that climbs out with ".."
 * — is refused.
 *
 * B-171/T-920 (review condition 1): the boundary is enforced on the REAL,
 * symlink-resolved paths, not merely on path.resolve()'d strings. A lexical-only
 * check is bypassable — a symlink INSIDE the root that points OUT (e.g.
 * `<root>/link -> /etc`) resolves lexically to inside the root while the real
 * file is outside. So both the root and the candidate are run through realpath
 * (best-effort for not-yet-existing leaves) before the containment comparison,
 * closing symlink-traversal escapes without rejecting legitimate in-root reads
 * of paths that do not exist yet.
 *
 * @param {string} toolName
 * @param {any} input
 * @param {string} projectRoot  Absolute project root (the fork's cwd).
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function confineBtwToolPathToProject(toolName, input, projectRoot) {
  const rootAbs = path.resolve(projectRoot);
  let candidate;
  const requiredPathField = BTW_REQUIRED_PATH_FIELD[toolName];
  if (requiredPathField) {
    // Read → file_path, NotebookRead → notebook_path. The field names the ONE file
    // being opened, so it is mandatory: with nothing to confine we deny.
    candidate = input?.[requiredPathField];
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      return {
        ok: false,
        message: `The /btw side query needs a ${requiredPathField} inside the project.`,
      };
    }
  } else if (BTW_OPTIONAL_PATH_TOOLS.has(toolName)) {
    // Grep / Glob: `path` is optional. Omitted/blank ⇒ search the project cwd.
    candidate = input?.path;
    if (
      candidate === undefined ||
      candidate === null ||
      (typeof candidate === 'string' && candidate.trim() === '')
    ) {
      return { ok: true };
    }
    if (typeof candidate !== 'string') {
      return { ok: false, message: 'The /btw side query received an invalid path.' };
    }
  } else {
    // Fail-closed: a tool this function does not know how to confine is REFUSED,
    // never waved through. Previously the optional-path branch was the catch-all,
    // so any newly allowlisted tool whose path lives under a different field would
    // have silently escaped confinement (an unconfined read of any file on the
    // host). Adding a tool to BTW_ALLOWED_TOOLS now REQUIRES declaring its path
    // field in one of the two tables above, or it simply cannot run.
    return { ok: false, message: 'The /btw side query cannot confine this tool to the project.' };
  }
  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(rootAbs, candidate);
  // REAL confinement: compare symlink-resolved paths (see the note above). The
  // root must itself resolve (it is the live fork cwd); if it cannot, refuse.
  let rootReal;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    return { ok: false, message: 'The /btw side query cannot resolve its project root.' };
  }
  const candidateReal = realpathBestEffort(resolved);
  if (
    candidateReal === null ||
    (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep))
  ) {
    return { ok: false, message: 'The /btw side query cannot access paths outside its project.' };
  }
  return { ok: true };
}

/**
 * Runs a one-shot, read-only /btw side query against a live session's transcript.
 *
 * @param {Object} params
 * @param {string} params.sessionId   - The LIVE session id to fork from (liveSid).
 * @param {string} params.question    - The user's /btw question.
 * @param {string|null} [params.upToMessageId] - Optional SDKAssistantMessage.uuid
 *   to branch from (→ SDK resumeSessionAt). Null/omitted ⇒ fork from the tail.
 * @param {string|number|null} [params.userId] - The REQUESTING user (env isolation).
 * @param {string|null} [params.cwd]  - Project path so CLAUDE.md / settingSources
 *   load in the session's own context. REQUIRED (A-2.3): a null/blank path is
 *   refused with sdk_error rather than inheriting the server cwd.
 * @param {string} [params.engineProvider] - Optional per-session sealed engine
 *   provider (ADR-037). Undefined in normal operation ⇒ default Anthropic engine.
 * @param {number} [params.timeoutMs] - Hard cap on the fork's lifetime.
 * @param {{onStarted?:(handle:{interrupt:()=>void})=>void,onChunk?:(text:string)=>void,onError?:(code:string,message:string)=>void,onComplete?:(fullAnswer:string)=>void}} callbacks
 *   onStarted fires once with an interrupt handle when the fork is constructed
 *   (A-1). Exactly ONE terminal callback (onError | onComplete) is invoked; onChunk
 *   may fire zero+ times before it. This function never rejects.
 *   B-270 (btw-complete carries the answer): onComplete receives the FULL answer
 *   text accumulated across the run (SDK `result` when present, else the joined
 *   assistant chunks). The caller attaches it to the terminal `btw-complete` frame
 *   so the answer survives even if every intermediate `btw-chunk` is dropped.
 * @returns {Promise<void>}
 */
async function spawnClaudeSideQuery(params = {}, callbacks = {}) {
  const {
    sessionId = null,
    question = '',
    upToMessageId = null,
    userId = null,
    cwd = null,
    engineProvider = undefined,
    timeoutMs = BTW_DEFAULT_TIMEOUT_MS,
  } = params;
  const onChunk = typeof callbacks.onChunk === 'function' ? callbacks.onChunk : () => {};
  const onErrorRaw = typeof callbacks.onError === 'function' ? callbacks.onError : () => {};
  const onComplete = typeof callbacks.onComplete === 'function' ? callbacks.onComplete : () => {};
  // A-1: invoked once with an { interrupt } handle as soon as the fork is
  // constructed, so the caller (the WS layer) can tear the fork down if the
  // requesting socket closes before the one-shot answer arrives.
  const onStarted = typeof callbacks.onStarted === 'function' ? callbacks.onStarted : () => {};

  const liveSid = typeof sessionId === 'string' ? sessionId.trim() : '';
  const prompt = typeof question === 'string' ? question.trim() : '';
  // [BTW] diagnostic: log EVERY terminal error of the side query (many of the
  // suspect throwers below sit inside a try/catch that otherwise swallows them
  // silently). Code + session + userId type/value + message ONLY — never the
  // question text, conversation content, cwd, env, or any credential/token.
  const onError = (code, message) => {
    console.warn(
      `[BTW] side-query error session=${liveSid || '<none>'} code=${code} `
      + `userIdType=${typeof userId} userIdValue=${String(userId)} `
      + `msg=${typeof message === 'string' ? message : String(message)}`
    );
    onErrorRaw(code, message);
  };
  // Exactly-one-terminal guard: onError/onComplete fire at most once total.
  let settled = false;
  const finish = (fn, ...args) => {
    if (settled) return;
    settled = true;
    fn(...args);
  };

  if (!liveSid) {
    finish(onError, 'session_not_found', 'No session to query.');
    return;
  }
  if (!prompt) {
    finish(onError, 'sdk_error', 'Empty question.');
    return;
  }
  // A-2.3: a /btw fork MUST run inside the session's project. When the project
  // path is unknown we REFUSE rather than inherit the server's cwd — inheriting
  // it would let the fork's Read/Grep/Glob roam the whole server filesystem, and
  // the A-2.2 confinement below has no root to anchor against.
  const projectRoot = typeof cwd === 'string' ? cwd.trim() : '';
  if (!projectRoot) {
    finish(onError, 'sdk_error', 'The project path for this session could not be determined.');
    return;
  }

  // Per-user credential isolation (C3): the fork runs under the REQUESTER's Claude
  // config dir, never the session owner's. Falls back to base env on any failure.
  let env = { ...process.env };
  try {
    env = resolveProviderEnv(userId, 'claude', env);
  } catch {
    env = { ...process.env };
  }

  let queryInstance = null;
  let timeoutHandle = null;

  try {
    // A-2 + B-171: the SINGLE read-only confinement decision, shared verbatim by
    // BOTH enforcement gates below (the canUseTool prompt handler AND the
    // PreToolUse hook) so the two can never drift. Allowlist membership + the
    // project-root path confinement (A-2.2). Returns confineBtwToolPathToProject's
    // { ok:true } | { ok:false, message } shape.
    const evaluateBtwToolAccess = (toolName, input) => {
      if (!BTW_ALLOWED_TOOL_SET.has(toolName)) {
        return {
          ok: false,
          message: 'The /btw side query is read-only (Read/Grep/Glob/NotebookRead only).',
        };
      }
      return confineBtwToolPathToProject(toolName, input, projectRoot);
    };
    const sdkOptions = {
      resume: liveSid,        // C1
      forkSession: true,      // C1 — HARD: never a bare resume
      persistSession: false,  // C1/C2 — ephemeral: the fork writes nothing to disk
      maxTurns: BTW_MAX_TURNS,
      env,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      // B-270/T-1045: keep the claude_code preset (so CLAUDE.md/governance context
      // still loads) and APPEND the side-query steering — never replace the preset,
      // which would drop the session's own context the answer draws from.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: BTW_SIDE_QUERY_DIRECTIVE },
      settingSources: ['project', 'user', 'local'],
      cwd: projectRoot,
      disallowedTools: [...BTW_DISALLOWED_TOOLS], // C3 + A-2.1 config belt
      // Read-only wall (C3 + A-2): an ALLOWLIST — only BTW_ALLOWED_TOOLS may run,
      // each confined to the session's project root (A-2.2). Every other tool
      // (mutating, executing, web, or interactive — a side query has NO approval
      // channel, so an interactive tool would otherwise hang the fork) is denied.
      // Runs in default permission mode — bypassPermissions is NEVER used here (it
      // would auto-ALLOW the very tools we must deny).
      canUseTool: async (toolName, input) => {
        const verdict = evaluateBtwToolAccess(toolName, input);
        if (!verdict.ok) {
          return { behavior: 'deny', message: verdict.message };
        }
        return { behavior: 'allow', updatedInput: input };
      },
      // B-171 HARD GATE — canUseTool alone is NOT sufficient. The SDK permission
      // engine evaluates settings `permissions.allow` rules FIRST, and a match
      // short-circuits to `behavior:"allow"` *without ever calling canUseTool*
      // (verified against Claude Code CLI 2.1.214: deny → ask → ALLOW-rule → only
      // then the ask/canUseTool fallthrough). Those allow-rules come from
      // settingSources (user/project/local) AND the always-loaded /etc managed
      // policy tier — on this host the effective read-allow set already includes
      // `Read(/etc/**)` (managed + user), `Read(//proc/**)` and
      // `Read(//home/dev/.pm2/logs/**)` — so a fork could read OUTSIDE its
      // project root silently, never touching the canUseTool cage. Neither
      // settingSources filtering nor managedSettings can empty that set (the /etc
      // tier loads unconditionally; SDK-supplied managedSettings is dropped when
      // an on-disk admin tier is present). A PreToolUse hook, however, is
      // evaluated ABOVE the rule engine and its `deny` is authoritative — no
      // allow-rule at any tier can override it (the very mechanism nassaj's own
      // config-protection / zero-rule governance hooks rely on to beat the broad
      // Bash(*)/Edit(~/.claude/**) allow-rules). We re-enforce the SAME
      // confinement here (allowlist + the REAL, symlink-resolved project-root
      // boundary of confineBtwToolPathToProject) so our cage is the decisive gate
      // for every read that no settings allow-rule can bypass, while
      // settingSources stays intact so CLAUDE.md / governance load.
      //
      // ⚠️ CLI-VERSION DEPENDENCY (re-verify on upgrade): the "PreToolUse deny
      // takes precedence over allow-rules" ordering is an INTERNAL behaviour of
      // the Claude Code CLI's hook-permission pipeline (the `pYr`/hookPermission
      // result "Blocked by PreToolUse hook" short-circuit in CLI 2.1.x) — it is
      // NOT part of the public SDK contract. If the bundled CLI is upgraded and
      // that ordering changes (or PreToolUse hooks stop firing for a forked
      // resume, e.g. via a `bareFork`-style path), B-171 could silently reopen.
      // A CLI-upgrade smoke test (real fork + broad allow-rule + out-of-root
      // read must be DENIED) is tracked as a separate gating task.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                const toolName = hookInput?.tool_name;
                const input =
                  hookInput && typeof hookInput.tool_input === 'object' && hookInput.tool_input !== null
                    ? hookInput.tool_input
                    : {};
                const verdict = evaluateBtwToolAccess(toolName, input);
                if (!verdict.ok) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: verdict.message,
                    },
                  };
                }
                // In-bounds ⇒ no permission opinion: defer to the normal flow
                // (canUseTool / working-dir), which allows the in-project read.
                return { continue: true };
              },
            ],
          },
        ],
      },
    };
    // C4: branch from a specific message when the client pins one.
    if (upToMessageId && typeof upToMessageId === 'string') {
      sdkOptions.resumeSessionAt = upToMessageId;
    }

    // C3 fail-closed guards on the FINAL env handed to query() — mirror the live
    // path exactly so a /btw fork can never reach a non-approved Anthropic host.
    assertAnthropicBaseUrlAllowed(sdkOptions.env);
    assertSettingsEnvAllowed(sdkOptions.env.CLAUDE_CONFIG_DIR, sdkOptions.env);
    // B-222: when a fork's session is sealed to a vendor engine, that engine is
    // honoured or the fork FAILS — it is never quietly answered by official
    // Anthropic. Throws ENGINE_PROVIDER_UNAVAILABLE; the catch below turns it
    // into the sdk_error the caller shows. No engine requested ⇒ null ⇒ the
    // official path, unchanged.
    const injectedHosts = applyClaudeEngineProviderEnvOrThrow(sdkOptions.env, userId, engineProvider);
    const settingsBaseUrls = await collectSettingsBaseUrls(sdkOptions.env);
    assertAnthropicBaseUrlAllowed(sdkOptions.env, {
      engineProviderHosts: injectedHosts ?? undefined,
      extraValues: settingsBaseUrls,
    });

    // T-897 provider cage: flag OFF ⇒ undefined ⇒ option unset ⇒ stock local spawn.
    const cagedSpawn = buildCagedSdkSpawn({ userId: userId ?? null, cwd: sdkOptions.cwd ?? null });
    if (cagedSpawn) {
      sdkOptions.spawnClaudeCodeProcess = cagedSpawn;
    }

    // B-270/T-1045: the framed prompt (steering line + the question) is what the
    // fork actually receives; the raw `prompt` guard above stays the empty-question
    // gate. Framing is guidance only — it changes no permission.
    queryInstance = query({ prompt: frameBtwPrompt(prompt), options: sdkOptions });

    // A-1: hand the caller an interrupt handle now that the fork exists, so a
    // socket close can tear it down mid-flight. Best-effort — interrupt failures
    // are swallowed (the generator + GC still reap the child).
    onStarted({
      interrupt: () => {
        if (queryInstance && typeof queryInstance.interrupt === 'function') {
          queryInstance.interrupt().catch(() => {});
        }
      },
    });

    // Hard lifetime cap: on overrun, mark failed and interrupt the fork.
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        finish(onError, 'sdk_error', 'Side query timed out.');
        if (queryInstance && typeof queryInstance.interrupt === 'function') {
          queryInstance.interrupt().catch(() => {});
        }
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    let emittedText = false;
    // B-270: accumulate the full answer as it streams so the terminal onComplete
    // (and thus the `btw-complete` frame) can carry it. This makes the final text
    // survive even when every intermediate `btw-chunk` frame is lost client-side.
    let accumulatedAnswer = '';
    // NOTE (C2): intentionally NO addSession() here. The fork is never tracked as
    // an active session — the drain/ghost/mirror machinery must never see it.
    for await (const message of queryInstance) {
      if (settled) break;

      // Stream assistant text as cumulative deltas (one chunk per text block).
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            emittedText = true;
            accumulatedAnswer += block.text;
            onChunk(block.text);
          }
        }
      }

      if (message.type === 'result') {
        const resultText = typeof message.result === 'string' ? message.result : '';
        const subtype = typeof message.subtype === 'string' ? message.subtype : '';
        const isErrorResult =
          message.is_error === true ||
          subtype === 'error_during_execution' ||
          subtype === 'error' ||
          subtype === 'error_max_turns' ||
          subtype === 'error_max_budget_usd' ||
          subtype === 'error_max_structured_output_retries';

        // [BTW] diagnostic: when the fork attempted tools the read-only cage denied
        // (an Agent/Bash/etc. reflex inherited from the live session), surface HOW
        // MANY and WHICH tools — names + counts ONLY. Never the tool_input (it can
        // carry file paths or content) and never any question/conversation text.
        const denials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
        if (denials.length > 0) {
          const counts = Object.create(null);
          for (const d of denials) {
            const name = d && typeof d.tool_name === 'string' ? d.tool_name : '<unknown>';
            counts[name] = (counts[name] || 0) + 1;
          }
          const summary = Object.keys(counts).map((n) => `${n}:${counts[n]}`).join(',');
          console.warn(
            `[BTW] tool denials session=${liveSid || '<none>'} subtype=${subtype || '<none>'} `
            + `count=${denials.length} tools=${summary}`
          );
        }

        if (isErrorResult) {
          if (isResumeSessionMissingError(resultText)) {
            finish(onError, 'session_not_found', 'The session could not be resumed.');
          } else if (subtype === 'error_max_turns') {
            // B-270/T-1045: the fork ran out of turns before answering — DON'T let
            // the empty `result` fall through to the generic "Side query failed."
            // Explain the cause (and the tool-reach if that is why) and how to
            // recover, so the user sees a real reason rather than silence.
            const denialHint = denials.length > 0
              ? ' It tried tools a /btw side query cannot use.'
              : '';
            finish(
              onError,
              'sdk_error',
              'The side query reached its step limit before it could answer.'
              + denialHint
              + ' Try asking a narrower, more specific question.'
            );
          } else if (
            subtype === 'error_max_budget_usd' ||
            subtype === 'error_max_structured_output_retries'
          ) {
            finish(onError, 'sdk_error', resultText || 'The side query stopped before it could answer.');
          } else {
            finish(onError, 'sdk_error', resultText || 'Side query failed.');
          }
          break;
        }
        // Success terminal. Some SDK result shapes carry the full text only on the
        // result (no incremental assistant blocks); emit it once as a fallback.
        if (!emittedText && resultText.length > 0) {
          accumulatedAnswer += resultText;
          onChunk(resultText);
        }
        // B-270: prefer the SDK `result` string as the authoritative full answer
        // (it is the complete text); fall back to the joined assistant chunks.
        const finalAnswer = resultText.length > 0 ? resultText : accumulatedAnswer;
        finish(onComplete, finalAnswer);
        break;
      }
    }

    // Stream ended without an explicit result (e.g. maxTurns cutoff) → complete.
    finish(onComplete, accumulatedAnswer);
  } catch (error) {
    const msg = error?.message || String(error);
    if (isResumeSessionMissingError(msg)) {
      finish(onError, 'session_not_found', 'The session could not be resumed.');
    } else {
      finish(onError, 'sdk_error', msg);
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    // Always tear the fork's child process down — even on the happy path (the
    // one-shot answer is complete, nothing more to consume).
    if (queryInstance && typeof queryInstance.interrupt === 'function') {
      try {
        await queryInstance.interrupt();
      } catch {
        // Interrupt failures are non-fatal — the generator + GC still tear down.
      }
    }
  }
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 * @param {Object|null} writer - WebSocketWriter for this session
 * @param {string|null} runTag - PROCESS_TAG_ENV_VAR value injected into the
 *   spawned CLI env; lets the process monitor resolve the child pid from
 *   /proc and surface frozen (kill -STOP) state to the UI.
 * @param {string|null} projectPath - Working dir of the run, forwarded to the
 *   process monitor so the live presence panel can show what the user is on.
 * @param {symbol|string|null} runToken - B-SEC-DUP-RUN identity of the RUN that
 *   owns this entry. `removeSession` refuses to delete an entry stamped with a
 *   different token, so a run that ends late can never tear down the entry a
 *   NEWER run created for the same sessionId (which left the newer run
 *   unstoppable: abort/`isActive` resolve by sessionId only). Defaults to null =
 *   the legacy unconditional behaviour, so existing callers/tests are unchanged.
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, runTag = null, projectPath = null, runToken = null, releaseInput = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer,
    runToken,
    // B-117: closes this run's streaming-input prompt. The abort path calls it
    // right after interrupt() so a stopped run does not sit out the input-close
    // grace before the CLI can exit. Null for callers that pass no handle.
    releaseInput,
    // ADR-042 (B-80c) ghost-detach bookkeeping. `detached` excludes the session
    // from the drain count ONLY (never aborts). The clocks are managed by the
    // lazy sweep; harmless dead fields when CLAUDE_GHOST_DETACH is OFF.
    detached: false,
    noListenerSince: null,
    lastListenerSeenAt: Date.now()
  });
  // ADR-041: mark the session live in the replay registry (single source of
  // truth for the active flag + replay buffer). Cancel any pending post-close
  // drop first so a quick resume reuses the entry instead of losing it. No-op
  // when SESSION_REGISTRY_claude is off. addSession is called twice on a fresh
  // run (once eagerly with the resume id when present, once with the real
  // captured session_id); open() is idempotent so the double call is safe.
  if (sessionId) {
    cancelClaudePendingDrop(sessionId);
    claudeSessionRegistry.open(sessionId);
  }
  if (writer && runTag) {
    registerSessionProcess(sessionId, { provider: 'claude', writer, runTag, projectPath });
  }
  // B-ABORT-FALLBACK: index this session under its originating socket so an
  // abort can be resolved by connection even before/without a matching id.
  const rawWs = rawSocketForSession({ writer });
  if (sessionId && rawWs) {
    let ids = sessionsByConnection.get(rawWs);
    if (!ids) {
      ids = new Set();
      sessionsByConnection.set(rawWs, ids);
    }
    // Re-insert to keep newest-last ordering for getNewestSessionForSocket.
    ids.delete(sessionId);
    ids.add(sessionId);
  }
  // ADR-042 (B-80c): start the lazy ghost sweep (no-op unless the flag is ON or
  // the timer already runs). Stopped again in removeSession when the map empties.
  startGhostSweep();
}

/**
 * B-SEC-DUP-RUN: is there a LIVE, still-watched run on this sessionId?
 *
 * "Live" = registered, not aborted, not ADR-042-detached, AND still has at least
 * one listener (primary socket open or a live read-only mirror) — the exact
 * listener test the ghost sweep uses. A listener-less ghost deliberately answers
 * FALSE so a stale entry can never permanently lock a conversation out of
 * sending (that would turn a leak into a denial of service).
 */
function isSessionRunLive(sessionId) {
  const existing = activeSessions.get(sessionId);
  if (!existing || existing.status !== 'active' || existing.detached) {
    return false;
  }
  if (existing.writer?.isPrimarySocketAlive?.() === true) {
    return true;
  }
  try {
    return countLiveMirrors(sessionId) > 0;
  } catch {
    return false;
  }
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {symbol|string|null} [expectedRunToken] - B-SEC-DUP-RUN: when supplied,
 *   the entry is removed ONLY if it still belongs to that run. Protects a newer
 *   run that reused the same sessionId from being de-registered by an older run's
 *   completion/error path. Omitted ⇒ unconditional removal (legacy behaviour).
 * @returns {boolean} true when an entry was (or was already not) owned by this
 *   run and the teardown ran; false when the teardown was skipped because the
 *   entry belongs to a different run.
 */
function removeSession(sessionId, expectedRunToken = null) {
  // B-ABORT-FALLBACK: drop the per-connection index entry before deleting the
  // session, so getNewestSessionForSocket never returns a torn-down id.
  const ending = activeSessions.get(sessionId);
  if (
    expectedRunToken !== null
    && ending
    && ending.runToken !== null
    && ending.runToken !== undefined
    && ending.runToken !== expectedRunToken
  ) {
    console.log(
      `[SEC-DUP-RUN] removeSession skipped for ${sessionId} — the entry belongs to a newer run`
    );
    return false;
  }
  const rawWs = rawSocketForSession(ending);
  if (rawWs) {
    const ids = sessionsByConnection.get(rawWs);
    if (ids) {
      ids.delete(sessionId);
      if (ids.size === 0) sessionsByConnection.delete(rawWs);
    }
  }
  activeSessions.delete(sessionId);
  // ADR-042 (B-80c): tear down the lazy ghost sweep once no session remains.
  if (activeSessions.size === 0) stopGhostSweep();
  // Stop process-state monitoring and tell every viewer the session is idle.
  // ADR-053 (T-53-B1): this ends the PRESENCE/idle lifecycle at turn-end (which
  // is correct — the user's turn is done), but it deliberately does NOT cancel
  // WORKFLOW PID tracking. That lives in the independent workflow-liveness
  // registry (server/services/workflow-liveness.js), which is populated from the
  // resolved child pid while the run was live and is NOT torn down here, so a
  // background workflow whose coordinator turn already ended (B-103) stays
  // probeable by /proc until the child process actually exits. Keeping the pid
  // survival OUT of this call is the minimal critical-path touch: no line is
  // added to the query()/for-await hot path that caused the 502 incidents.
  unregisterSessionProcess(sessionId);
  // Mark as recently ended to block writer swaps during the race window
  recentlyEndedSessions.set(sessionId, Date.now() + RECENTLY_ENDED_GRACE_MS);
  setTimeout(() => recentlyEndedSessions.delete(sessionId), RECENTLY_ENDED_GRACE_MS);
  return true;
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolves the real context window (in tokens) for a given model.
 *
 * Priority:
 *  1. `CONTEXT_WINDOW` env var when explicitly set (respects user override).
 *  2. Inferred from the model name: Opus, Fable, and Sonnet 4.6+ ship a 1M
 *     window; other known models default to 200000.
 *  3. When the model name is unavailable, defaults to 1000000 (the modern
 *     Opus/Sonnet long-context default) instead of the stale 160000 value.
 *
 * Returns the model's true window — the frontend applies its own effective
 * factor on top of this number.
 * @param {string} [modelName] - Model identifier (e.g. "claude-opus-4-8")
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(modelName) {
  const override = parseInt(process.env.CONTEXT_WINDOW, 10);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }

  const name = typeof modelName === 'string' ? modelName.toLowerCase() : '';

  // Opus (all current generations) ships a 1M context window.
  if (name.includes('opus')) {
    return 1000000;
  }

  // Fable (5 and later) ships a 1M context window with 128K max output.
  if (name.includes('fable')) {
    return 1000000;
  }

  // Sonnet 4.6 and later ship a 1M context window.
  if (name.includes('sonnet')) {
    const versionMatch = name.match(/sonnet[^0-9]*(\d+)(?:[.-](\d+))?/);
    if (versionMatch) {
      const major = Number(versionMatch[1]);
      const minor = Number(versionMatch[2] || 0);
      if (major > 4 || (major === 4 && minor >= 6)) {
        return 1000000;
      }
    }
    return 200000;
  }

  // Known model name but not long-context → conservative default.
  if (name) {
    return 200000;
  }

  // Model name unavailable → modern long-context default (was 160000).
  return 1000000;
}

/**
 * Sums the full input token count, including cached tokens.
 * Anthropic's `input_tokens` excludes both `cache_read_input_tokens` and
 * `cache_creation_input_tokens`; with prompt caching enabled (the default)
 * counting `input_tokens` alone wildly underreports real context usage.
 * @param {Object} usage - Usage object (snake_case or camelCase fields)
 * @returns {{ input: number, cacheRead: number, cacheCreation: number, full: number }}
 */
function readInputTokens(usage) {
  const input = readNumber(usage.input_tokens ?? usage.inputTokens);
  const cacheRead = readNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheCreation = readNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  return { input, cacheRead, cacheCreation, full: input + cacheRead + cacheCreation };
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 *
 * `inputTokens` reflects the FULL input (raw input + cache read + cache
 * creation) so the budget counter is accurate under prompt caching.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Model name (when present) lets us pick the correct context window.
  const modelName = sdkMessage.message?.model
    || sdkMessage.model
    || (sdkMessage.modelUsage && Object.keys(sdkMessage.modelUsage)[0]);

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const { full: fullInput, cacheRead, cacheCreation } = readInputTokens(messageUsage);
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = fullInput + outputTokens;
    const contextWindow = resolveContextWindow(modelName);

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens: fullInput,
      outputTokens,
      breakdown: {
        input: fullInput,
        output: outputTokens,
        cacheRead,
        cacheCreation,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const rawInput = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const cacheRead = readNumber(
    modelData.cumulativeCacheReadInputTokens
    ?? modelData.cacheReadInputTokens
    ?? modelData.cache_read_input_tokens
  );
  const cacheCreation = readNumber(
    modelData.cumulativeCacheCreationInputTokens
    ?? modelData.cacheCreationInputTokens
    ?? modelData.cache_creation_input_tokens
  );
  const fullInput = rawInput + cacheRead + cacheCreation;
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = fullInput + outputTokens;
  const contextWindow = resolveContextWindow(modelKey);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens: fullInput,
    outputTokens,
    breakdown: {
      input: fullInput,
      output: outputTokens,
      cacheRead,
      cacheCreation,
    },
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // B-40f: use os.tmpdir() instead of a hard-coded project path so temp
    // images never land inside the project tree (avoids accidental git tracking
    // and works regardless of the project cwd).
    tempDir = path.join(os.tmpdir(), 'nassaj-claude-images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    // Images processed
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Appends agent attachment paths to the prompt so the model can read them. The
 * files already live on disk (the upload endpoint copied them into the project's
 * .nassaj-uploads/inbox); here we only annotate the prompt with their paths.
 *
 * Mirrors handleImages: the note is appended AFTER the command text, and an
 * empty/absent file list is a total no-op (returns the command unchanged) so the
 * authorship hash of fileless messages is identical to before this feature.
 *
 * @param {string} command - Prompt text (already image-annotated)
 * @param {Array<{path: string, name?: string}>} files - paths are cwd-relative
 * @returns {{ modifiedCommand: string }}
 */
function handleFiles(command, files) {
  if (!files || files.length === 0) {
    return { modifiedCommand: command };
  }

  const fileNote = `\n\n[Files provided at the following paths:]\n${files.map((f, i) => `${i + 1}. ${f.path}`).join('\n')}`;
  return { modifiedCommand: command + fileNote };
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) {
    return;
  }

  try {
    // Delete individual temp files
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(err =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }

    // Delete temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }

    // Temp files cleaned
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function runClaudeSDKQuery(command, options = {}, ws, internalOptions = {}) {
  const { suppressResumeMissError = false } = internalOptions;
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let participantRecorded = false;
  // Exact prompt text handed to the SDK (and therefore written verbatim into
  // the transcript). Updated to the image-annotated form after handleImages so
  // the authorship hash recorded below matches the transcript line.
  let promptTextForAuthorship = command;
  // B-SEC-DUP-RUN: identity of THIS run, stamped on its activeSessions entry so a
  // late teardown from another run can never remove it (see removeSession).
  const runToken = Symbol('claude-run');

  // B-SEC-DUP-RUN: refuse a SECOND concurrent run on a sessionId that already has
  // a live, still-watched run. `activeSessions` is keyed by sessionId alone, so
  // two runs on one id silently collided: the second overwrote the first's entry
  // (leaving run #1 orphaned — unstoppable by abort and still burning quota),
  // the first to finish removed the OTHER's entry (so its `complete`/idle event
  // fired while the other was still streaming), and both interleaved writes into
  // the same replay RingBuffer. A listener-less ghost is deliberately NOT treated
  // as live, so a stale entry can never lock a conversation out of sending.
  if (sessionId && isSessionRunLive(sessionId)) {
    console.warn(`[SEC-DUP-RUN] refused a concurrent run on session ${sessionId}`);
    ws.send(createNormalizedMessage({
      kind: 'error',
      code: 'session_busy',
      content:
        'This conversation already has a run in progress. '
        + 'Wait for it to finish (or stop it) before sending another message.',
      sessionId,
      provider: 'claude',
    }));
    return { ok: false };
  }

  // B-31: verify the project directory exists before attempting spawn.
  // A missing cwd causes a confusing ENOENT after SDK init; surface it early
  // with a classified error the frontend can translate via the error code.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      // B-31/B-33: surface the cwd-missing error once, with the isNewSessionError
      // flag set when there is no sessionId yet so the frontend can correlate the
      // failure with the originating request. A second identical message is NOT
      // sent — one classified error is sufficient.
      ws.send(createNormalizedMessage(
        buildCwdMissingPayload(cwdCheck.error, {
          sessionId: sessionId || null,
          provider: 'claude',
          isNewSessionError: !sessionId,
        })
      ));
      return { ok: false };
    }
  }

  // Record the authenticated human who spawned this run as a session
  // participant. Once per spawn (idempotent at the DB layer too) and only when
  // the WS is authenticated — anonymous/single-user runs carry no userId.
  const recordParticipant = (sid) => {
    if (participantRecorded || !sid || !ws?.userId) {
      return;
    }
    participantRecorded = true;
    participantsDb.recordSpawn(sid, ws.userId, {
      provider: 'claude',
      projectPath: options.cwd || options.projectPath || process.cwd(),
    });
    // Sender attribution (B-MU-UX-FIX-MSG-AUTHOR): remember WHO authored this
    // prompt so history loads can stamp userId onto the transcript's user
    // message (the transcript itself carries no identity). Never throws.
    messageAuthorsDb.recordUserMessage(sid, ws.userId, promptTextForAuthorship);
  };

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // T-822 (§ج-4): held across query()+for-await, released in the finally on EVERY
  // exit path. Declared here (not in the try) so the finally can see it. Stays
  // null unless the seam below engages the lock.
  let chatTurnLock = null;

  // B-117 — keep the CONTROL channel alive past the first `result`.
  //
  // Handing the SDK a STRING prompt sets isSingleUserTurn, and the SDK then does
  // this (sdk.mjs, Query.readMessages): on the FIRST `result` message it calls
  // transport.endInput() — "First result received for single-turn query, closing
  // stdin". stdin is not just the user-input pipe: every control_response the SDK
  // owes the CLI rides it too (SDK-callback hooks, canUseTool). So the moment a
  // run produces one result, the CLI can still keep working — background-agent
  // notifications and queued messages re-enter the loop — but it can no longer
  // reach us. Measured on the live incident (debug log, AlNuman session
  // e3c36199, 2026-07-26T23:29:09.568Z):
  //   "PreToolUse SDK callback hook cancelled (control stream closed)"
  // and 1ms later the tool result the model saw:
  //   "The user doesn't want to take this action right now. STOP what you are
  //    doing and wait for the user to tell you how to proceed."
  // Nobody denied anything: the CLI cancels a tool whose PreToolUse hook it
  // cannot run (toolDenialKind "cancelled" — same text as a human refusal).
  // Only Agent/Task showed it because they are the only tools matched by an SDK
  // CALLBACK hook; Bash/Edit/Read match COMMAND hooks, which the CLI runs itself
  // and which never touch the control stream. That is why the earlier allowlist
  // fix could not work — the cancellation happens at tool ENTRY, before any
  // permission check.
  //
  // Streaming-input mode (an async generator) leaves stdin — and therefore the
  // control channel — open. We then own the close, and defer it until the run is
  // actually quiet (see armInputClose below). The generator is a factory because
  // the query() call site may run twice (the retry-without-hooks path) and a
  // generator object can only be consumed once.
  let releaseInputStream = () => {};
  const inputStreamRelease = new Promise((resolve) => { releaseInputStream = resolve; });
  let inputCloseTimer = null;
  const disarmInputClose = () => {
    if (inputCloseTimer) {
      clearTimeout(inputCloseTimer);
      inputCloseTimer = null;
    }
  };
  // Arm only on `result`, and re-arm on every later `result`; ANY message from
  // the CLI disarms it. So the channel stays open across a back-to-back
  // continuation (the failure case: queued task-notifications finish one
  // invocation, the real user message starts the next), and closes shortly after
  // the run really goes quiet — from that point the behaviour is exactly what it
  // was before this fix, so nothing that used to work can regress.
  const armInputClose = () => {
    disarmInputClose();
    inputCloseTimer = setTimeout(() => {
      inputCloseTimer = null;
      releaseInputStream();
    }, sdkInputCloseGraceMs());
    if (typeof inputCloseTimer.unref === 'function') inputCloseTimer.unref();
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );

    // Build the accepted-model set from the dynamic Claude catalog so any model
    // the picker offers (e.g. claude-fable-5) passes validation. This reads the
    // existing cached SWR layer (fast, in-memory; refresh runs in the background),
    // so it never blocks or slows the send hot path. On any failure we leave the
    // set undefined, and mapCliOptionsToSDK falls back to the static list — the
    // send path is never broken by catalog issues.
    let validModelValues;
    try {
      const { models: catalog } = await providerModelsService.getProviderModels('claude');
      validModelValues = buildValidClaudeModelValues(catalog);
    } catch {
      validModelValues = undefined;
    }

    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
    }, validModelValues);

    // Lazy model-discovery: the exact model value the SDK will run with (after
    // validation/coercion in mapCliOptionsToSDK). If this run later fails with a
    // model_not_found / 404 the model is recorded as broken for this user. Skip
    // the provider default sentinel — 'default' is never an unreleased model and
    // must never be hidden.
    const runModelForDiscovery =
      typeof sdkOptions.model === 'string' && sdkOptions.model !== CLAUDE_FALLBACK_MODELS.DEFAULT
        ? sdkOptions.model
        : null;
    let unreleasedModelRecorded = false;

    // Per-user credential isolation (B-ISO-CLAUDE): rebuild the spawn env via the
    // central resolver so each authenticated user gets their own CLAUDE_CONFIG_DIR
    // while conversations/instructions stay shared via symlinks. Falls back to the
    // base env unchanged when no userId is present (single-user / platform mode).
    sdkOptions.env = resolveProviderEnv(ws?.userId ?? null, 'claude', sdkOptions.env);

    // Iron-rule re-check on the FINAL env actually handed to the subprocess.
    // resolveProviderEnv spreads the base env (ANTHROPIC_BASE_URL included) and
    // never strips it, so validate again here — fail-closed before query().
    assertAnthropicBaseUrlAllowed(sdkOptions.env);
    // The CLI also applies env.ANTHROPIC_BASE_URL (and Bedrock/Vertex siblings)
    // from settings.json INSIDE the per-user CLAUDE_CONFIG_DIR, downstream of the
    // spawn env. Validate that file under the same allowlist so a competitor base
    // URL placed there cannot bypass the OS-env guard above.
    assertSettingsEnvAllowed(sdkOptions.env.CLAUDE_CONFIG_DIR, sdkOptions.env);

    // T-897: unified provider cage (behind NASSAJ_PROVIDER_CAGE, default OFF).
    // When on, route the SDK's Claude Code spawn through bwrap so it cannot read
    // other users' ~/.nassaj-users trees or reach host runtime sockets. Returns
    // undefined when the flag is off ⇒ the option is never set and the SDK keeps
    // its stock local spawn (byte-identical off path).
    const cagedClaudeSpawn = buildCagedSdkSpawn({
      userId: ws?.userId ?? null,
      cwd: sdkOptions.cwd ?? null,
    });
    if (cagedClaudeSpawn) {
      sdkOptions.spawnClaudeCodeProcess = cagedClaudeSpawn;
    }

    // Per-user commit authorship (B-MU-UX-GIT-ID): inject GIT_AUTHOR_*/
    // GIT_COMMITTER_* for the authenticated user so any commit the agent makes
    // during this run is attributed to the brother who spawned it — independent
    // of the credential-isolation policy above (attribution, not isolation).
    // Empty when the user has no stored identity -> the agent's commits fall
    // back to the system git config (current behavior). No global config write.
    Object.assign(sdkOptions.env, buildGitAuthorEnv(ws?.userId ?? null));

    // Frozen-session indicator: the SDK never exposes the spawned CLI's pid,
    // so tag the child env with a unique value the process monitor can match
    // against /proc/<pid>/environ to find the pid and watch for kill -STOP.
    const processRunTag = crypto.randomUUID();
    sdkOptions.env[PROCESS_TAG_ENV_VAR] = processRunTag;

    // B-86: when the control flag is enabled, pass CLAUDE_CODE_WORKFLOWS=1 to the
    // CLI to activate the Workflow/multi-agent orchestration (ultrawork) tier of
    // ultracode. Applied here, AFTER resolveProviderEnv rebuilds sdkOptions.env,
    // so it survives onto the final env handed to query(). Disabled by default
    // (flag '0'/'false'/unset) — no behaviour change for any existing run. This
    // only adds one env var to the spawn; it never touches the SDK tool
    // definitions, allowedTools/disallowedTools, or the prompt-keyword path.
    Object.assign(sdkOptions.env, (process.env.ENABLE_ULTRACODE_WORKFLOWS === 'true' || process.env.ENABLE_ULTRACODE_WORKFLOWS === '1'
      ? { CLAUDE_CODE_WORKFLOWS: '1' }
      : {}));

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // ADR-037 (B-248/T-1031): both options.allowVendorDelegation (below) and
    // options.engineProvider (B-ENG, further down) are now LIVE, user-reachable
    // features — the UI surface has landed, this is no longer a dormant seam.
    // Client path for allowVendorDelegation: the "allow delegating subtasks to other
    // models" checkbox in PermissionsContent.tsx (default false, seeded in
    // useSettingsController.ts) sets toolsSettings.allowVendorDelegation, which
    // useChatComposerState.ts copies onto claudeOptions.allowVendorDelegation before
    // send; engineProvider is set the same way from the pinned engine. The transport
    // forwards them unchanged — chat-websocket.service passes data.options verbatim to
    // queryClaudeSDK with no allow-list/strip — so they arrive here exactly as the
    // user set them. NO environment flag gates either path (unlike the ultracode
    // workflows var above); the *effective* precondition for a working delegation is
    // the settings toggle AND a per-user stored vendor key — buildVendorDelegateMcp
    // registers the tool whenever the toggle is on, but the tool itself returns an
    // error unless getProviderKey(userId, provider) yields a key. When both options
    // are unset (the default) engineProvider is undefined (injectedHosts stays null,
    // the base-URL guard is a no-op, the Claude model is untouched) and
    // allowVendorDelegation is falsy (no vendor-delegate MCP is registered), so the
    // normal official path is unchanged.
    //
    // B-DEL-6: when the agent is permitted to delegate subtasks to hosted vendor
    // models, register the per-spawn vendor-delegate MCP server. Built fresh here
    // with the spawning user's id captured in its closure — no global instance —
    // so each user's delegation uses only their own stored vendor key.
    if (options.allowVendorDelegation) {
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers || {}),
        'vendor-delegate': buildVendorDelegateMcp(ws?.userId ?? null),
      };
    }

    // B-ENG-4: "Claude engine on a vendor endpoint" (ADR-037).
    // 1) Optionally point the SDK's ANTHROPIC_BASE_URL/AUTH_TOKEN at the selected
    //    per-user engine provider (returns the authorized host set, or null when
    //    no engine provider is engaged — never half-injects).
    // 2) Collect any *_BASE_URL declared in the resolved settings.json (the same
    //    channel Claude Code reads at spawn) so the guard vets them too.
    // 3) Fail-closed guard: throw unless every base URL the SDK will see points at
    //    the official Anthropic host, this spawn's engine host, or an operator
    //    escape hatch (Bedrock/Vertex flags or NASSAJ_ALLOWED_ANTHROPIC_HOSTS).
    // This runs before BOTH query() calls below (the no-hooks retry reuses the
    // same sdkOptions.env), so it covers every spawn path.
    //
    // B-222: an engine the user PINNED to this chat but that cannot be honoured
    // (no stored key, or not an eligible engine) throws
    // ENGINE_PROVIDER_UNAVAILABLE here instead of falling through to official
    // Anthropic. Substituting a different vendor for the one the user chose is
    // never a safe degradation — the catch below surfaces it as a visible error.
    const injectedHosts = applyClaudeEngineProviderEnvOrThrow(
      sdkOptions.env,
      ws?.userId ?? null,
      options.engineProvider,
    );
    const settingsBaseUrls = await collectSettingsBaseUrls(sdkOptions.env);
    assertAnthropicBaseUrlAllowed(sdkOptions.env, {
      engineProviderHosts: injectedHosts ?? undefined,
      extraValues: settingsBaseUrls,
    });

    // When (and only when) an engine provider was actually engaged, re-assert the
    // caller's model id verbatim. mapCliOptionsToSDK already passes options.model
    // through without coercion (claude-sdk.js: `options.model || DEFAULT`), so for
    // the current code path this is a behavioural no-op — it does NOT undo any
    // existing coercion because none exists here. It is kept as an explicit,
    // narrowly-gated guard (injectedHosts !== null) documenting that a vendor model
    // id must survive untouched, so that if a Claude-model normalizer is ever added
    // to the mapping step it cannot silently rewrite an engaged vendor model. With
    // no engine engaged we leave sdkOptions.model exactly as mapped.
    if (injectedHosts !== null && options.model) {
      sdkOptions.model = options.model;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    // Handle attachment files - append their paths after the image annotation.
    // No-op (returns the same string) when options.files is empty, so the
    // authorship hash for fileless messages is unchanged.
    const fileResult = handleFiles(imageResult.modifiedCommand, options.files);
    // Ultracode (UI intensity 4): besides the SDK effort='max' set above, the
    // CLI's "deeper reasoning + multi-agent workflow" super-modes are activated
    // by magic keywords in the prompt text. Append them here so ultracode takes
    // real effect (no-op for every other effort value). Applied after the image
    // annotation so the keywords ride along on the exact text the CLI receives.
    const finalCommand = maybeApplyUltracodeKeywords(fileResult.modifiedCommand, options.effort);
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;
    // The transcript stores the prompt exactly as handed to the SDK, so
    // authorship must hash the same text (recordParticipant runs only after
    // this point).
    promptTextForAuthorship = finalCommand;

    // T-937 (ADR-064 baseline, path ①): the repo root whose ground-truth this
    // session's coordinator delegations are anchored against — the session's own
    // project cwd, falling back to the module default. Captured once here so the
    // hook closure below never recomputes it.
    const coordinatorRepoRoot =
      (typeof options.cwd === 'string' && options.cwd.trim())
        ? options.cwd.trim()
        : (typeof options.projectPath === 'string' && options.projectPath.trim())
          ? options.projectPath.trim()
          : undefined;

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }],
      // T-937 (ADR-064 baseline ① + discrimination): inject neutral, disk-derived
      // ground-truth as `additionalContext` when the COORDINATOR delegates via the
      // Agent/Task tool, so replay/compaction can't make it re-run finished work.
      // FAIL-SAFE ABSOLUTE — every branch is guarded so this hook can NEVER throw,
      // NEVER block, and NEVER deny: on any doubt it returns {} and the delegation
      // proceeds unchanged. It carries NO permissionDecision, so it never touches
      // the permission flow (canUseTool still runs). Gated on the instance-level
      // NASSAJ_COORDINATOR=1 opt-in (default OFF ⇒ instant no-op everywhere else).
      // The `Agent|Task` matcher is a coarse first filter; an EXACT tool_name check
      // inside rejects near-misses (TaskCreate/TaskUpdate/…).
      PreToolUse: [{
        matcher: 'Agent|Task',
        hooks: [async (hookInput) => {
          try {
            if (!isCoordinatorInjectionEnabled(process.env)) return {};
            const toolName = hookInput?.tool_name;
            if (toolName !== 'Agent' && toolName !== 'Task') return {};
            const delegationPrompt =
              hookInput && typeof hookInput.tool_input === 'object' && hookInput.tool_input !== null
                ? hookInput.tool_input.prompt
                : undefined;
            const description =
              hookInput && typeof hookInput.tool_input === 'object' && hookInput.tool_input !== null
                ? hookInput.tool_input.description
                : undefined;
            // ① neutral disk-derived facts + ④ phrasing-resistant marker-lock WARN.
            // Both fail-safe: on any failure each yields null and is simply omitted;
            // ④'s failure can never affect ①. Merge both into one additionalContext.
            let markerWarning = null;
            try {
              const res = await evaluateMarkerLock({
                delegationPrompt,
                description,
                repoRoot: coordinatorRepoRoot,
              });
              markerWarning = res && typeof res.warning === 'string' ? res.warning : null;
            } catch {
              markerWarning = null;
            }
            const groundTruth = await buildGroundTruthContext({
              delegationPrompt,
              repoRoot: coordinatorRepoRoot,
            });
            const additionalContext = [markerWarning, groundTruth]
              .filter((s) => typeof s === 'string' && s.length > 0)
              .join('\n\n');
            if (!additionalContext) return {};
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext,
              },
            };
          } catch {
            // Never let injection break a delegation.
            return {};
          }
        }]
      }],
      // T-939 (ADR-064 baseline ②): inject the SAME neutral disk-derived ground-truth
      // as `additionalContext` at SessionStart, so a compaction/resume that never
      // passes through a delegation (which ① would catch) still can't erase the
      // "what I already did" state and trigger replay self-execution. PreCompact is a
      // no-op for injection; SessionStart is the confirmed channel and fires on
      // source: compact/resume. FAIL-SAFE ABSOLUTE — every branch returns {} on any
      // doubt so the session hydrates unchanged. Gated on the same instance-level
      // NASSAJ_COORDINATOR=1 opt-in (default OFF ⇒ instant no-op everywhere else).
      // matcher '' = all sources; the source relevance filter lives in the builder.
      SessionStart: [{
        matcher: '',
        hooks: [async (hookInput) => {
          try {
            if (!isCoordinatorInjectionEnabled(process.env)) return {};
            const source = hookInput?.source;
            const additionalContext = await buildSessionStartContext({
              source,
              repoRoot: coordinatorRepoRoot,
            });
            if (!additionalContext) return {};
            return {
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext,
              },
            };
          } catch {
            // Never let injection break a session start/resume.
            return {};
          }
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      // [B117-DENY] Monitoring only — zero behaviour change (T-250,
      // docs/plans/B117-DIAGNOSIS.md §5.2). Every deny this callback returns for
      // the interactive tools is logged with the session/request id and the raw
      // socket state so a live B-117 occurrence can be correlated to an
      // endInput/abort sequence. The returned object is byte-identical to the
      // former inline literal; logging never mutates the permission decision and
      // is wrapped so it can never throw into the permission path.
      const denyWithLog = (denyMessage, reason, requestId = null) => {
        try {
          const rawState = ws && ws.ws ? ws.ws.readyState : 'no-ws';
          console.log(
            `[B117-DENY] tool=${toolName} requiresInteraction=${requiresInteraction} `
            + `reason=${reason} session=${capturedSessionId || sessionId || 'NEW'} `
            + `requestId=${requestId || 'none'} `
            + `permissionMode=${sdkOptions.permissionMode || 'default'} `
            + `rawSocketReadyState=${rawState} message=${JSON.stringify(denyMessage)}`
          );
        } catch { /* logging must never break the permission path */ }
        return { behavior: 'deny', message: denyMessage };
      };

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return denyWithLog('Tool disallowed by settings', 'disallowed-by-settings');
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      // B-SEC-APPROVAL-WEDGE: cancel this prompt as soon as the run loses EVERY
      // listener, instead of leaving the generator (and its activeSessions entry,
      // and therefore every safe-restart) hanging on a closed tab. The websocket
      // layer cannot do this — the composition root injects no cancel hook and the
      // client answer carries no sessionId — so the run owns its own teardown here.
      const detachApprovalWatch = watchApprovalListenerLoss(
        requestId,
        ws,
        capturedSessionId || sessionId || null
      );
      let decision;
      try {
        decision = await waitForToolApproval(requestId, {
          // B-SEC-APPROVAL-WEDGE: a hard ceiling replaces the former `0` =
          // "wait forever" for the interactive tools.
          timeoutMs: requiresInteraction ? INTERACTIVE_APPROVAL_MAX_WAIT_MS : undefined,
          signal: context?.signal,
          metadata: {
            _sessionId: capturedSessionId || sessionId || null,
            // B-SEC-APPROVAL-OWNERSHIP: the JWT identity that owns this run,
            // captured at prompt-creation time. resolveToolApproval compares the
            // answering socket against it (see authorizeApprovalDecision).
            _ownerUserId: ws?.userId ?? null,
            _toolName: toolName,
            _input: input,
            _receivedAt: new Date(),
          },
          onCancel: (reason) => {
            ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          }
        });
      } finally {
        detachApprovalWatch?.();
      }
      if (!decision) {
        return denyWithLog('Permission request timed out', 'timeout', requestId);
      }

      if (decision.cancelled) {
        // decision.cancelled originates from a runtime/transport abort (e.g. a
        // transient SDK/transport disconnect), NOT from the user denying the
        // request. We keep the { behavior: 'deny', message } contract but return
        // an honest, retryable message instead of implying the user cancelled.
        return denyWithLog('Tool use was cancelled by the runtime (not by the user). This is likely a transient SDK/transport abort — the request can be retried.', 'runtime-cancelled', requestId);
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return denyWithLog(decision.message ?? 'User denied tool use', 'user-denied', requestId);
    };

    // T-822 (§ج-4) — the ONLY critical-path touch, GATED at the line start. When
    // the sub-flag is off (default) OR this is a NEW session (no resume target,
    // so nothing an injector can collide with), the whole expression short-
    // circuits to null WITHOUT evaluating the await — no fs, no spawn, no async
    // suspension, no env-var-timing shift ⇒ byte-identical path. When on AND
    // resuming, take the per-conversation lock so this live turn's `<sid>.jsonl`
    // appends never interleave with a Tier-B injection. Bounded wait; fail-OPEN
    // for the human on timeout (§ح-3); released in the finally below.
    chatTurnLock = (isChatTurnLockEnabled() && sessionId)
      ? await acquireChatTurnLockForLiveTurn(sessionId, ws?.userId ?? null)
      : null;

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance;
    // B-117: the streaming-input prompt. Yields this turn's single user message —
    // byte-identical text to the string form, which the SDK itself wrapped the
    // same way — then parks on `inputStreamRelease` so stdin (and with it the
    // control channel) stays open until we close it.
    const makePromptStream = async function* () {
      yield {
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: finalCommand },
      };
      await inputStreamRelease;
    };
    // B-SEC-ENV-LEAK: the restore MUST be in a finally welded to the query block.
    // It used to be a plain statement after the try/catch, so when BOTH attempts
    // threw (the retry-without-hooks path rethrows) the exception escaped before
    // the restore and this PROCESS-GLOBAL env var stayed at 300000 for the rest of
    // the process's life — inherited by every later spawn (every provider CLI,
    // every child), silently changing their stream-close behaviour.
    try {
      try {
        queryInstance = query({
          prompt: makePromptStream(),
          options: sdkOptions
        });
      } catch (hookError) {
        // Older/newer SDK versions may not accept hook shapes yet.
        // Keep notification behavior operational via runtime events even if hook registration fails.
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        delete sdkOptions.hooks;
        queryInstance = query({
          prompt: makePromptStream(),
          options: sdkOptions
        });
      }
    } finally {
      // Restore immediately — Query constructor already captured the value
      if (prevStreamTimeout !== undefined) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
      } else {
        delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      }
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, processRunTag, options.cwd || options.projectPath || null, runToken, releaseInputStream);
      recordParticipant(capturedSessionId);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    // [WS-DIAG] Active-stream lifecycle (point #2). Records the writer's bound raw
    // socket readyState at stream start, and arms a one-time orphan probe: if the
    // socket closes mid-stream, ws.send() below becomes a silent no-op (readyState
    // guard in WebSocketWriter.send) while THIS generator keeps consuming SDK output.
    // The SDK query is NOT aborted on socket close. We log the first iteration where
    // the socket is no longer OPEN so the freeze is provable: stream alive, socket
    // dead, payloads dropped, and (point #4) no re-subscribe re-binds the writer
    // because the run is still 'active' so reconnectSessionWriter is vetoed.
    // readyState codes: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED.
    const wsDiagRawAtStart = ws && ws.ws ? ws.ws.readyState : 'no-raw-ws';
    console.log(
      `[WS-DIAG] stream-start session=${capturedSessionId || 'NEW'} `
      + `rawSocketReadyState=${wsDiagRawAtStart} isWebSocketWriter=${Boolean(ws && ws.isWebSocketWriter)}`
    );

    // ADR-041 (B-80): RingBuffer injection point. Buffer each LIVE payload under
    // the current session key, stamp it with the assigned monotonic `sequence`,
    // THEN forward it to the socket. A socket that reconnects mid-stream is then
    // brought up to date by differential replay (attach re-emits seq > lastSeq)
    // — read-only, no writer swap, no abort. record() returns null when the flag
    // is OFF (then we forward the payload untouched, no `sequence` field, exactly
    // as before). Buffering is keyed off `capturedSessionId` resolved at call
    // time (it may be null for the very first payloads of a brand-new run, before
    // the SDK reports session_id; those are not buffered — identical to agy,
    // where the pre-id window is covered by a connectionId we do not have here).
    // Only the live-stream payloads inside the for-await loop route through this;
    // the terminal `error` payload keeps a direct ws.send so a failure is never
    // gated on the registry.
    const sendAndBuffer = (payload) => {
      const sid = capturedSessionId || sessionId || null;
      const seq = sid ? claudeSessionRegistry.record(sid, payload) : null;
      if (seq !== null && seq !== undefined) {
        payload.sequence = seq;
      }
      ws.send(payload);
    };

    let wsDiagOrphanLogged = false;
    let wsDiagMessageCount = 0;
    // B-117: set once this run shows work that can resume after a `result`.
    let continuationPossible = false;
    // Count Workflow tool_use calls so the complete event can signal
    // that background work is still in flight after the assistant turn ends.
    let pendingWorkflows = 0;
    for await (const message of queryInstance) {
      // B-117: the CLI is talking, so it is not done — cancel any pending close of
      // the input/control stream. Re-armed further below when this message is a
      // `result`.
      disarmInputClose();
      // [WS-DIAG] One-time orphan detection: socket went away but the stream lives on.
      wsDiagMessageCount += 1;
      // OPEN readyState is the literal 1 (WebSocket.OPEN); avoid importing the
      // websocket-state constant here to keep the diagnostic footprint local.
      if (
        !wsDiagOrphanLogged
        && ws && ws.ws
        && ws.ws.readyState !== 1
      ) {
        wsDiagOrphanLogged = true;
        console.log(
          `[WS-DIAG] stream-orphaned session=${capturedSessionId || sessionId || 'NEW'} `
          + `rawSocketReadyState=${ws.ws.readyState} messagesSoFar=${wsDiagMessageCount} `
          + `note=socket-closed-but-generator-still-running-sends-now-dropped`
        );
      }

      // [B117-SIGNATURE] Live capture of the CLI-internal B-117 deny surfacing in
      // the stream (see scanB117Signature). Logs the matched text + raw socket
      // state so the emission can be tied to a session/message; monitoring only.
      const b117Match = scanB117Signature(message);
      if (b117Match) {
        const rawState = ws && ws.ws ? ws.ws.readyState : 'no-ws';
        console.log(
          `[B117-SIGNATURE] session=${capturedSessionId || sessionId || 'NEW'} `
          + `messageType=${message.type} messagesSoFar=${wsDiagMessageCount} `
          + `rawSocketReadyState=${rawState} matched=${JSON.stringify(b117Match.slice(0, 300))}`
        );
      }

      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        // ADR-041 / B-N-RESUME clean buffer (mirrors agy-cli.js): the SDK reports
        // its real session_id only now. A resumed run for a sessionId that carries
        // a prior, already-terminated registry entry must NOT inherit the previous
        // run's buffered payloads. Drop the stale INACTIVE entry (and cancel its
        // pending post-close drop) BEFORE addSession re-opens a fresh one, so the
        // new run's seq line starts at 0 and a client reconnecting with lastSeq
        // absent/0 replays only THIS run. A still-active entry under the same id is
        // a live run we must never disturb, so it is left untouched. No-op when the
        // flag is off.
        if (
          claudeSessionRegistry.enabled
          && claudeSessionRegistry.entries.has(capturedSessionId)
          && !claudeSessionRegistry.isActive(capturedSessionId)
        ) {
          claudeSessionRegistry.drop(capturedSessionId);
        }
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, processRunTag, options.cwd || options.projectPath || null, runToken, releaseInputStream);
        recordParticipant(capturedSessionId);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          sendAndBuffer(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Detect Workflow tool invocations so the complete event can signal
      // that background work continues after the assistant turn ends.
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block && block.type === 'tool_use' && block.name === 'Workflow') {
            pendingWorkflows += 1;
          }
        }
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        // Sender attribution (B-MU-UX-FIX-MSG-AUTHOR): user-authored text
        // echoed by this run is stamped with the JWT-sourced socket userId so
        // mirrors (other viewers) can render the true author — but ONLY for
        // human-origin text. SDK user messages whose origin is non-human
        // (origin.kind 'coordinator' = coordinator → subagent prompt via the
        // Task tool, also 'peer'/'channel'/'task-notification') carry
        // `originKind` from the adapter and are never attributed to the
        // human, otherwise agent directives render as user bubbles.
        stampHumanUserId(msg, ws?.userId);
        // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR): every
        // assistant-driven payload this run emits was spawned by the human on
        // this socket. Stamp the JWT-sourced coordinatorId so live viewers (and
        // the spawner's mirrors) attribute the reply to the real participant
        // instead of the session owner. No-op for the user echo handled above.
        stampCoordinatorId(msg, ws?.userId);
        sendAndBuffer(msg);
      }

      // B-117: track whether anything in this run can re-enter the loop AFTER a
      // `result` — that is the only situation where holding the control channel
      // open buys anything. Background agents and Workflows do (their completion
      // notification starts a new invocation), and a `<task-notification>` that
      // arrives from a PREVIOUS process does too (the live incident: the queued
      // notifications finished one invocation, then the owner's real message ran
      // the next one with the channel already dead).
      if (!continuationPossible) {
        if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
          for (const block of message.message.content) {
            if (block?.type !== 'tool_use') continue;
            const isBackgroundAgent = (block.name === 'Agent' || block.name === 'Task')
              && block.input?.run_in_background !== false;
            if (block.name === 'Workflow' || isBackgroundAgent) {
              continuationPossible = true;
              break;
            }
          }
        } else if (message.type === 'user') {
          const content = message.message?.content;
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('')
              : '';
          if (text.includes('<task-notification>')) continuationPossible = true;
        }
      }

      // B-117: a `result` ends this invocation, not necessarily the run. With no
      // continuation in sight, close input immediately — byte-identical to what
      // single-turn mode did, so an ordinary turn ends exactly as fast as before.
      // Otherwise hold the channel open through the grace, re-armed on every
      // later result and disarmed by any message in between.
      if (message.type === 'result') {
        if (continuationPossible) {
          armInputClose();
        } else {
          releaseInputStream();
        }
      }

      // Fork: stale `resume` surfaces as an error result whose text names the
      // missing conversation. Throw a tagged error so the shared catch path
      // can trigger the fresh-session fallback instead of streaming a
      // dead-end error to the user. (result-only guard — keep inside this block.)
      if (message.type === 'result') {
        if (message.is_error || message.subtype === 'error_during_execution') {
          const resultText = typeof message.result === 'string' ? message.result : '';
          if (isResumeSessionMissingError(resultText)) {
            const resumeError = new Error(resultText);
            resumeError.resumeSessionMissing = true;
            throw resumeError;
          }
        }
      }

      // Lazy model-discovery backstop (B-MODEL-DISCOVERY): if THIS run's model
      // failed because Anthropic has not released it for the account
      // (model_not_found / api_error_status 404), record it as broken for this
      // user so the catalog hides it next time. Once per run (the flag stops a
      // multi-message result from recording twice). Pure observation: this does
      // NOT swap the writer, touch the replay registry / detach, abort the run,
      // or alter the stream — the message still flows through sendAndBuffer
      // above exactly as before, so the user still sees the native error. The
      // store write is fire-and-forget and never throws into this loop.
      if (
        runModelForDiscovery
        && !unreleasedModelRecorded
        && isUnreleasedModelFailure(message)
      ) {
        unreleasedModelRecorded = true;
        const brokenUserId = ws?.userId ?? null;
        void recordBrokenModel(brokenUserId, runModelForDiscovery)
          .then((added) => {
            if (added) {
              console.warn(
                `[claude-discovery] model "${runModelForDiscovery}" reported `
                + `unreleased (model_not_found/404); hiding from catalog`
                + `${brokenUserId ? ` [user=${brokenUserId}]` : ''}`
              );
            }
          })
          .catch(() => {
            // Store failure is non-fatal; the live catalog still works.
          });
      }

      // Extract and send token budget updates from assistant/result usage payloads (#807)
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        sendAndBuffer(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      // B-SEC-DUP-RUN: only tear down OUR OWN entry (see removeSession).
      removeSession(capturedSessionId, runToken);
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send completion event. ADR-041: routed through sendAndBuffer so the
    // terminal `complete` is buffered too — a socket reconnecting inside the
    // post-close retention window then replays it (re-emitting `complete` is
    // read-only and idempotent on the client, so it is safe unlike the live
    // critical path). The active flag is flipped to inactive immediately AFTER,
    // so the buffer survives for the retention window but the session is no
    // longer reported processing.
    sendAndBuffer(createNormalizedMessage({ kind: 'complete', exitCode: 0, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude', pendingWorkflows }));
    // ADR-041: terminal state — flip the single source of truth to inactive and
    // schedule a deferred buffer drop (post-close replay window, not an immediate
    // drop). No-op when SESSION_REGISTRY_claude is off.
    if (capturedSessionId || sessionId) {
      claudeSessionRegistry.setActive(capturedSessionId || sessionId, false);
      scheduleClaudeBufferDrop(capturedSessionId || sessionId);
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: 'completed'
    });
    // Complete
    return { ok: true };

  } catch (error) {
    console.error('SDK query error:', error);

    // B-40a: cancel dangling tool approvals so approval promises resolve
    // immediately rather than leaking until TOOL_APPROVAL_TIMEOUT_MS.
    if (capturedSessionId) {
      cancelPendingApprovalsForSession(capturedSessionId);
    }

    // Clean up session on error
    if (capturedSessionId) {
      // B-SEC-DUP-RUN: only tear down OUR OWN entry (see removeSession).
      removeSession(capturedSessionId, runToken);
    }
    // ADR-041: terminal (error) state — flip the registry's active flag to
    // inactive and schedule the deferred buffer drop (post-close replay window),
    // mirroring the success path. The structured `error` payload below keeps its
    // direct ws.send so a failure is never gated on the registry; we only manage
    // the lifecycle here. No-op when SESSION_REGISTRY_claude is off.
    if (capturedSessionId || sessionId) {
      claudeSessionRegistry.setActive(capturedSessionId || sessionId, false);
      scheduleClaudeBufferDrop(capturedSessionId || sessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Stale-resume fallback: when the caller is allowed to retry, swallow the
    // missing-conversation error here (no UI error, no failure notification) and
    // hand control back so the wrapper can restart as a fresh session.
    if (suppressResumeMissError && (error?.resumeSessionMissing || isResumeSessionMissingError(error))) {
      return { ok: false, resumeSessionMissing: true };
    }

    // B-222: a refused engine provider is NOT a spawn failure — the run was
    // stopped deliberately, before anything reached any provider, because the
    // engine the user pinned to this chat could not be honoured. It needs no
    // CLI-installed probe, and its message must reach the user intact: the
    // frontend renders `reason` as the detail beside the localized headline, so
    // the user reads "no GLM API key stored" instead of a generic failure.
    const engineRefused = error?.code === 'ENGINE_PROVIDER_UNAVAILABLE';
    // Check if Claude CLI is installed for a clearer error message
    // B-32: map spawn/runtime errors to structured codes.
    const installed = engineRefused || await providerAuthService.isProviderInstalled('claude');
    let errorCode;
    let errorContent;
    if (!installed) {
      errorCode = 'cli_not_installed';
      errorContent = 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code';
    } else if (engineRefused) {
      errorCode = 'spawn_failed';
      errorContent = error.message;
    } else {
      const mapped = mapSpawnError(error);
      errorCode = mapped.code;
      errorContent = mapped.fallbackMessage;
    }

    // B-33: for a new session (no prior sessionId), include a requestId so the
    // frontend can correlate the error with the originating spawn request.
    const errorSessionId = capturedSessionId || sessionId || null;
    ws.send(createNormalizedMessage({
      kind: 'error',
      code: errorCode,
      content: errorContent,
      // B-222: only the deliberate engine refusal carries a `reason`, so no
      // other error's rendering changes.
      ...(engineRefused ? { reason: errorContent } : {}),
      sessionId: errorSessionId,
      provider: 'claude',
      ...(!errorSessionId ? { isNewSessionError: true } : {}),
    }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
    return { ok: false };
  } finally {
    // B-117: never let a streaming-input prompt outlive the run. On EVERY exit
    // (normal end, error, abort, early return) drop the pending close timer and
    // release the generator so the SDK ends stdin and the CLI can exit. Without
    // this a thrown/aborted run would park on `inputStreamRelease` forever and
    // leak a live CLI process — which is also what would keep safe-restart's
    // drain waiting.
    disarmInputClose();
    releaseInputStream();
    // T-822 (§ج-4): release the per-conversation chat-turn lock on EVERY exit
    // (success, error, any return in the loop). No-op when the seam left it null
    // (flag off / new session / fail-open) so it is inert on the default path.
    if (chatTurnLock) {
      chatTurnLock.release();
    }
  }
}

/**
 * Public entry point. Wraps {@link runClaudeSDKQuery} and, when a `--resume`
 * (SDK `resume`) target no longer exists, surfaces an explicit
 * `conversation_not_found` signal to the client instead of silently starting a
 * fresh conversation.
 *
 * Rationale: a silent auto-restart loses the user's expectation that they are
 * continuing a specific conversation. Instead, the client renders a clear error
 * with a "start new session" button so the restart is a deliberate user action.
 * Every other error keeps the original behaviour, and runs that never asked to
 * resume skip the detection path entirely.
 *
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId } = options;

  // No resume requested → nothing to detect. Run once, plain.
  if (!sessionId) {
    await runClaudeSDKQuery(command, options, ws);
    return;
  }

  const result = await runClaudeSDKQuery(command, options, ws, {
    suppressResumeMissError: true,
  });

  if (!result?.resumeSessionMissing) {
    return;
  }

  // The previous conversation is gone. Do NOT auto-restart: emit an explicit
  // signal carrying the stale session id and the original command so the client
  // can offer a "start new session" action that re-sends this same prompt.
  ws.send(createNormalizedMessage({
    kind: 'error',
    code: 'conversation_not_found',
    content: 'The previous session could not be resumed — it has expired or been removed.',
    staleSessionId: sessionId,
    command,
    sessionId,
    provider: 'claude',
  }));
}

/**
 * Aborts an active SDK session.
 *
 * Resolution order (B-ABORT-FALLBACK):
 *   1. Exact match on the supplied sessionId.
 *   2. If that misses AND a raw socket is supplied, fall back to the newest
 *      active session bound to that same connection. This covers the brand-new
 *      session race where the user hits STOP before the SDK has reported its
 *      real session_id, so the client had no concrete id (or a stale one) to
 *      send. Aborting "the run this socket just started" is always the user's
 *      intent on STOP, so the fallback is safe and connection-scoped.
 *
 * @param {string} sessionId - Session identifier supplied by the client.
 * @param {object|null} [rawWs] - The raw WebSocket the abort arrived on, used
 *   only for the connection fallback above.
 * @returns {Promise<{ aborted: boolean, reason: string, sessionId: string|null }>}
 *   Structured result; `aborted` is the boolean the WS layer maps to success.
 */
async function abortClaudeSDKSession(sessionId, rawWs = null) {
  let resolvedId = sessionId;
  let session = getSession(resolvedId);

  if (!session && rawWs) {
    const fallbackId = getNewestSessionForSocket(rawWs);
    if (fallbackId) {
      resolvedId = fallbackId;
      session = getSession(resolvedId);
      console.log(
        `[WS-DIAG] sdk-abort fallback: requested=${sessionId || 'none'} `
        + `resolved-by-connection=${resolvedId}`
      );
    }
  }

  if (!session) {
    const reason = sessionId
      ? `no active claude session matched id=${sessionId} (and none active on this connection)`
      : 'abort carried no sessionId and the connection has no active claude session';
    console.log(`[WS-DIAG] sdk-abort no-op: ${reason}`);
    return { aborted: false, reason, sessionId: null };
  }

  sessionId = resolvedId;

  try {
    console.log(`Aborting SDK session: ${sessionId}`);
    // [WS-DIAG] Abort path (point #2). Distinguishes an explicit user/abort-driven
    // teardown of the SDK query from the silent orphaning that happens on socket
    // close (where NO abort is issued and the run keeps streaming into a dead
    // socket). If a freeze occurs WITHOUT this line, the run was orphaned, not aborted.
    const wsDiagAbortRaw = session?.writer?.ws ? session.writer.ws.readyState : 'no-raw-ws';
    console.log(
      `[WS-DIAG] sdk-abort session=${sessionId} status=${session?.status ?? 'unknown'} `
      + `writerRawReadyState=${wsDiagAbortRaw}`
    );

    // B-40a: cancel any tool approval that is waiting for user interaction
    // so the approval promise resolves immediately instead of blocking for
    // TOOL_APPROVAL_TIMEOUT_MS after the session is already aborted.
    cancelPendingApprovalsForSession(sessionId);

    // Call interrupt() on the query instance
    if (!session.instance || typeof session.instance.interrupt !== 'function') {
      const reason = `session ${sessionId} has no interruptable SDK instance`;
      console.error(`[WS-DIAG] sdk-abort failed: ${reason}`);
      return { aborted: false, reason, sessionId };
    }
    await session.instance.interrupt();

    // B-117: close this run's streaming-input prompt now. interrupt() ends the
    // turn, but with input still open the CLI would wait for more instead of
    // exiting, so the run would sit out the input-close grace before the loop
    // (and the user's stop) actually finished. No-op for runs registered without
    // a handle.
    try {
      session.releaseInput?.();
    } catch {
      // Releasing input must never turn a successful abort into a failure.
    }

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return { aborted: true, reason: 'interrupted', sessionId };
  } catch (error) {
    const detail = error?.message || String(error);
    console.error(`[WS-DIAG] sdk-abort interrupt() threw for session ${sessionId}:`, error);
    return { aborted: false, reason: `interrupt() failed: ${detail}`, sessionId };
  }
}

/**
 * Checks if an SDK session is currently active.
 *
 * ج1 (2026-07-26): the body used to be `session && session.status === 'active'`,
 * which returns the *session object's* falsy value — `undefined` — whenever the
 * id is unknown, instead of `false`. Every truthiness consumer was unaffected,
 * but the one consumer that SERIALIZES the result (the `session-status` frame in
 * chat-websocket.service.ts) shipped `isProcessing: undefined`, and
 * `JSON.stringify` DROPS an undefined value: the client received a frame with no
 * `isProcessing` key at all — "field absent", not `false` (measured on a live
 * log: 415 undefined vs 202 true). Wrapping in `Boolean(...)` makes the declared
 * `@returns {boolean}` true for every branch. No truthiness consumer changes
 * behaviour (`!undefined === !false`).
 *
 * DEFINITION (unchanged, deliberately): "active" is `status === 'active'` and
 * nothing else. A DETACHED session (`session.detached`) is still active here —
 * see getDrainBlockingClaudeSessions below for why the drain, and ONLY the
 * drain, subtracts detached ghosts from its own count.
 *
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * ADR-042 (B-80c): the claude sessions the DRAIN must still wait for — active
 * sessions that are NOT detached. A detached ghost (lost every listener past the
 * grace period) keeps running in the background and writes complete jsonl, so it
 * must not hold `pm2 restart` hostage until kill_timeout. Consumed EXCLUSIVELY
 * by the drain count in index.js (behind the CLAUDE_GHOST_DETACH flag).
 *
 * `getActiveClaudeSDKSessions()` stays unchanged — a detached session is still
 * "active" for display (UI / get-active-sessions / WS-DIAG); it is just no
 * longer "drain-blocking". Clean split between the two concepts.
 * @returns {Array<string>} Active, non-detached session IDs.
 */
function getDrainBlockingClaudeSessions() {
  const out = [];
  for (const [sid, session] of activeSessions) {
    if (!session.detached) out.push(sid);
  }
  return out;
}

/**
 * B-40a: Cancel all pending tool-approval callbacks for a session and signal
 * each one as cancelled. Called on abort and on session error so dangling
 * approval promises are resolved instead of waiting for TOOL_APPROVAL_TIMEOUT_MS.
 *
 * @param {string} sessionId - The session ID whose approvals should be cancelled
 */
function cancelPendingApprovalsForSession(sessionId) {
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      // Resolve with a cancelled decision so the permission_request flow
      // returns a deny rather than blocking until the timeout fires.
      resolver({ allow: false, cancelled: true });
      // Note: resolver itself removes itself from pendingToolApprovals via the
      // cleanup() registered in waitForToolApproval, so no manual delete here.
    }
  }
}

/**
 * Cancel EVERY pending tool approval, whatever session it belongs to.
 *
 * Called at the first instant of drain, before the websocket clients are closed.
 * Without it, a restart orphans any approval still waiting on a socket that is
 * about to be shut: the request simply dies on the wire and the CLI reports it as
 * "The user doesn't want to proceed with this tool use" — a rejection the user
 * never made, arriving with no explanation, in the middle of their work.
 * Measured 2026-07-27: those refusals land in the same SECOND as
 * `[DRAIN] SIGINT: listener closed` (01:12:24 ⇒ refusal at 01:12).
 *
 * Resolving them here routes each one through the honest `decision.cancelled`
 * branch instead — "cancelled by the runtime (not by the user) … can be retried"
 * — and logs a [B117-DENY] line, so the next occurrence is diagnosable rather
 * than invisible. It cannot help a request whose stdio the exiting process has
 * already torn down; it closes the window nassaj itself owns.
 *
 * @returns {number} how many approvals were cancelled
 */
function cancelAllPendingApprovals() {
  let cancelled = 0;
  for (const [, resolver] of pendingToolApprovals.entries()) {
    try {
      resolver({ allow: false, cancelled: true });
      cancelled += 1;
    } catch { /* one bad resolver must never stop the drain */ }
  }
  return cancelled;
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  // Block swap during the grace window after session end — prevents race
  // between removeSession() and the next addSession() for the same sessionId.
  if (recentlyEndedSessions.has(sessionId)) {
    console.log(`[RECONNECT] Skipped writer swap for ${sessionId} — in grace period`);
    // [WS-DIAG] (point #4) Re-bind refused because the session just ended (grace
    // window). The new socket will not receive the stream; expected for completed runs.
    console.log(`[WS-DIAG] writer-swap-skipped session=${sessionId} reason=grace-period`);
    return false;
  }
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) {
    // [WS-DIAG] (point #4) No writer to swap (session unknown or no writer). A
    // reconnecting socket finds nothing to re-bind — stream cannot be resumed here.
    console.log(
      `[WS-DIAG] writer-swap-skipped session=${sessionId} `
      + `reason=no-writer hasSession=${Boolean(session)}`
    );
    return false;
  }
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  // [WS-DIAG] (point #4) Writer successfully re-bound to the new socket. This only
  // happens when the run is IDLE (isActive===false at the caller); an ACTIVE run is
  // vetoed by the `if(!isActive)` guard in chat-websocket.service and never reaches here.
  console.log(`[WS-DIAG] writer-swap-applied session=${sessionId}`);
  return true;
}

/**
 * Returns true when the primary WebSocket of a session's writer is still OPEN.
 *
 * Used by the check-session-status handler to distinguish:
 *   - isActive=true + primarySocketAlive=true  → live run, live socket → NO swap
 *     (swapping mid-run risks SDK tool_use desync as before)
 *   - isActive=true + primarySocketAlive=false → live run, dead socket (orphaned
 *     writer) → SAFE to reclaim: the SDK is already dropping payloads into a
 *     closed socket; giving it the reconnecting socket lets the remainder of the
 *     stream reach the client without any additional desync risk.
 *
 * The orphaned-writer reclaim (T-932 شق ب) is part of the same freeze/replay
 * machinery gated by SESSION_REGISTRY_claude. When that flag is OFF we must not
 * report a dead socket: doing so would let the caller swap the writer of an
 * ACTIVE run, violating the ADR-041 flag-off no-op contract (no replay, no
 * sequence, NO swap). So report the socket as alive while the flag is off — the
 * caller's `!isActive || !primarySocketAlive` then collapses to the legacy
 * `!isActive` veto. When the flag is ON, report the real socket state so the
 * reclaim engages for a genuinely orphaned writer.
 *
 * @param {string} sessionId
 * @returns {boolean}
 */
function isSessionPrimarySocketAlive(sessionId) {
  if (!claudeSessionRegistry.enabled) return true;
  const session = getSession(sessionId);
  return session?.writer?.isPrimarySocketAlive() ?? false;
}

/**
 * ADR-041 (B-80): read-only differential replay for a reconnecting socket on a
 * claude session. Re-emits ONLY the buffered payloads with `seq > lastSeq` to
 * `send`, oldest-first. Performs NO writer swap and NO abort of the running SDK
 * query — it strictly reads the per-session RingBuffer (the active writer of the
 * live session is left untouched, honouring the ADR-021 `if(!isActive)` no-swap
 * veto). Returns the highest seq replayed, or the supplied `lastSeq` when nothing
 * newer exists / the flag is off / the session is unknown. Mirrors
 * attachAntigravitySession in agy-cli.js exactly.
 *
 * @param {string} sessionId - The session ID whose buffer to replay.
 * @param {number} lastSeq - The highest seq the client already received.
 * @param {(payload: unknown) => void} send - Sink for each replayed payload.
 * @returns {number} Highest seq replayed (or lastSeq when nothing newer).
 */
function attachClaudeSDKSession(sessionId, lastSeq, send) {
  const result = claudeSessionRegistry.attach(sessionId, lastSeq, send);
  return result === null ? (Number.isFinite(lastSeq) ? lastSeq : 0) : result;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  cancelPendingApprovalsForSession,
  cancelAllPendingApprovals,
  // B-SEC-APPROVAL-OWNERSHIP: the pure authorization core (unit-tested directly)
  // and the REAL pending-approval registrar, exported as a test seam so the
  // ownership tests drive production code instead of re-implementing the map
  // (same discipline as the addSession/sweepGhostSessions ghost-detach seam).
  authorizeApprovalDecision,
  waitForToolApproval,
  reconnectSessionWriter,
  isSessionPrimarySocketAlive,
  attachClaudeSDKSession,
  claudeSessionRegistry,
  resolveContextWindow,
  getClaudeBuiltInCommands,
  // T-881: read-only /btw side query (resume + forkSession, never registered).
  spawnClaudeSideQuery,
  mapCliOptionsToSDK,
  buildValidClaudeModelValues,
  // Lazy model-discovery (B-MODEL-DISCOVERY): pure detector for the
  // model_not_found/404 signal. Exported for unit testing only.
  isUnreleasedModelFailure,
  resolveEffortLevel,
  maybeApplyUltracodeKeywords,
  // ADR-042 (B-80c) ghost-detach.
  getDrainBlockingClaudeSessions,
  ghostDetachEnabled,
  // Test seam for the ghost sweep (ADR-042 test plan). addSession/removeSession
  // are the real production paths — using them keeps the unit tests faithful.
  sweepGhostSessions,
  addSession,
  removeSession,
  getSession,
  // Pure helpers — exported for unit testing only (no side effects, no I/O).
  handleFiles
};
