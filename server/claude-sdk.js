import { runLocalUpdateBackground } from './services/update-writer-lease.js';
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

import crypto from 'crypto';
import { promises as fs, realpathSync } from 'fs';
import path from 'path';
import os from 'os';

import { query } from '@anthropic-ai/claude-agent-sdk';

// T-1315 (الموجة الثانية): نصّ التوجيه لم يعد محبوساً هنا — صار في shared/ ليقرأه
// كل مُشعِل مزوّد. القيم منقولة حرفياً فجولة Claude مطابقة لما كانت عليه.
import { getRuntimeInstructions } from './services/runtime-instructions.js';
import { engineProviderLabel } from '../shared/engineProviders.js';

import { claudeDelegationProfile, prepareClaudeReviewedDelegation } from './services/claude-delegation-admission.js';
import { evaluatePublicPageWrite } from './services/public-page-agent-guidance.js';
import { createClaudeReceiptPrompt, isTrustedClaudeActivity } from './modules/providers/list/claude/claude-receipt-identity.js';
import { claudeCacheSnapshot, claudeCacheTtlMinutes, claudeContextSnapshot, readClaudeContextSnapshot } from './modules/providers/list/claude/claude-token-usage.js';
import { messageCoordinationDb, providerRunFailuresDb, auditLogDb, messageAuthorsDb, participantsDb, sessionsDb  } from './modules/database/index.js';
import {
  classifyEngineFailure,
  engineFailureMessage,
} from './modules/providers/services/engine-quota-failure.js';
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
import { isModelActivity, settleTurnTiming } from './modules/providers/services/turn-timing.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createNormalizedMessage, stampCoordinatorId, stampHumanUserId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { saveChatImages } from './services/chat-image-store.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { assertAnthropicBaseUrlAllowed, assertSettingsEnvAllowed } from './services/isolation/anthropic-base-url-guard.js';
import { buildCagedSdkSpawn } from './services/isolation/provider-cage-wiring.js';
import {
  OFFICIAL_ENGINE,
  PIN_SOURCE,
  pickEngineModel,
} from './services/isolation/engine-pin.js';
import { resolveClaudeRunProfileOrThrow } from './services/isolation/resolve-claude-run-profile.js';
import { runAuthorizedProviderCatalog } from './modules/execution-permissions/runtime-catalog.js';
import { buildVendorDelegateMcp } from './modules/providers/shared/vendor/vendor-delegate-mcp.js';
// T-822 (§ج-4): the per-conversation chat-turn lock. BOTH imports are
// side-effect-free (pure function/flag modules — no top-level I/O/timers). The
// lock is engaged ONLY when isChatTurnLockEnabled() (master + the dedicated
// WORKFLOW_SUPERVISOR_CHAT_LOCK sub-flag) is true AND this is a resume; otherwise
// the seam below is a synchronous no-op (byte-identical critical path).
import { isChatTurnLockEnabled } from './modules/workflow-supervisor/config.js';
import { acquireChatTurnLockForLiveTurn } from './modules/workflow-supervisor/chat-turn-lock.js';
import { buildGitAuthorEnv } from './utils/gitIdentity.js';
import { repairResumeTranscript } from './services/transcript-block-repair.js';
import { collapseNpxLaunchers } from './services/mcp-npx-direct.js';
import { splitSdkMcpServers, writeMcpConfigFile } from './services/mcp-config-file.js';
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

/**
 * B-515 — يُخزَّن **ثم** يُرسَل، ولا يُرهَن الإرسال بالتخزين.
 *
 * كانت حمولات الفشل والإذن (`error` و`permission_request`
 * و`permission_cancelled`) تتجاوز المخزن الحلقي بـ`ws.send` مباشر «كي لا يُرهَن
 * الفشل بالسجل». والمبرَّر صحيح، لكن التنفيذ جعل الحمولة **غير قابلة
 * للاسترجاع**: مقبس يموت قبل التسليم (حادثة 2026-08-06: ‏`code=1006`
 * و`hadActiveStreamAtClose=true`) يُضيع الخطأ نهائياً — لا إعادة البثّ
 * التفاضلية تعيده لأنه لم يُخزَّن قط، ولا دمج الذيل عبر REST يجده لأن الأخطاء
 * ليست صفوفاً في سجلّ المحادثة.
 *
 * فالمبرَّر الأصلي محفوظ هنا بالترتيب لا بالحذف: التخزين داخل `try/catch`
 * وشرطُه معرّفُ جلسة، والإرسال بعده **بلا شرط**. فشل التخزين يخسر إعادة البثّ
 * وحدها، ولا يخسر معها وصول الخطأ إلى صاحبه.
 *
 * والحمولة تُرسَل مرّة واحدة على المقبس الحيّ: هذه الدالة تحلّ محلّ `ws.send`
 * ولا تُضاف إليه.
 *
 * @param {Object} ws - الكاتب (WebSocketWriter أو بديل اختباري).
 * @param {string|null} sessionKey - مفتاح المخزن؛ `null` ⇒ إرسالٌ بلا تخزين
 *   (نافذة ما قبل التقاط معرّف الجلسة، وهي النافذة نفسها التي يتركها
 *   `sendAndBuffer` بلا تخزين).
 * @param {Object} payload - حمولة `createNormalizedMessage`.
 */
function bufferThenSend(ws, sessionKey, payload) {
  try {
    const seq = sessionKey ? claudeSessionRegistry.record(sessionKey, payload) : null;
    if (seq !== null && seq !== undefined) {
      payload.sequence = seq;
    }
  } catch (bufferError) {
    console.warn(
      '[ADR-041] failed to buffer a payload for replay; delivering it anyway:',
      bufferError?.message || bufferError
    );
  }
  ws.send(payload);
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

// B-ABORT-CROSSKILL: how recently a run must have started for the empty-id abort
// fallback to accept it. The fallback exists for ONE race only — the user hits
// STOP in the seconds between spawn and the SDK reporting its session_id — so a
// run older than this window is by definition not the run being raced.
const ABORT_FALLBACK_MAX_AGE_MS = 60000;

/**
 * Resolves the newest still-active claude sessionId bound to a given raw socket.
 * Used as the abort fallback ONLY when the client supplied no id at all.
 *
 * B-ABORT-CROSSKILL: a browser tab holds ONE socket for every session it opens,
 * so this index routinely lists several unrelated live runs. Returning the newest
 * unconditionally is therefore a cross-session kill whenever the caller's own run
 * is not the newest — measured 2026-08-05 06:18 and 08:51 in [WS-DIAG]: a second
 * STOP on an already-finished session resolved to a stranger's run and killed it,
 * once per press, walking down the socket's session list. Two guards now bound
 * it: the caller must pass no id (enforced in abortClaudeSDKSession), and the
 * candidate must be young enough to be the run being raced.
 *
 * @returns {string|null} The candidate id, or null when the socket has no live
 *   session young enough to be the pre-id run.
 */
function getNewestSessionForSocket(rawWs) {
  if (!rawWs) return null;
  const ids = sessionsByConnection.get(rawWs);
  if (!ids || ids.size === 0) return null;
  let newest = null;
  const now = Date.now();
  // Insertion order is preserved by Set; the last live id is the newest run.
  for (const id of ids) {
    const session = activeSessions.get(id);
    if (!session) continue;
    if (now - (session.startTime ?? 0) > ABORT_FALLBACK_MAX_AGE_MS) continue;
    newest = id;
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
  ghostSweepTimer = setInterval(() => {
    void runLocalUpdateBackground('claude-ghost-sweep', () => sweepGhostSessions()).catch(() => { /* retry next sweep */ });
  }, GHOST_DETACH_SWEEP_MS);
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

// B-1120: a background task still running when its turn's `result` lands finishes
// minutes later, and its notification re-enters the SAME CLI process — whose next
// Agent/Task call then dies at entry if the grace above already closed the control
// channel. While such tasks are pending the channel is held instead, bounded by this
// idle ceiling (re-armed on every CLI message) so a task that never reports back
// cannot keep a CLI process alive for ever. Read per run, like the grace above.
// Note: `parseInt('0') || default` yields the default, so 0 can NOT disable the
// hold — the smallest effective value is 1ms (same for the continuation wait below).
const sdkBackgroundHoldIdleMaxMs = () =>
  parseInt(process.env.CLAUDE_SDK_BACKGROUND_HOLD_IDLE_MAX_MS, 10) || 3600000;

// B-1120: once a task ends after the main loop went quiet, its notification starts a
// new cycle (system/init → assistant …). Until that cycle is seen the channel waits
// this long — not the 8s grace, which a slow CLI can outlast before its first message.
const sdkContinuationWaitMs = () =>
  parseInt(process.env.CLAUDE_SDK_CONTINUATION_WAIT_MS, 10) || 120000;

// B-1120: `task_updated` statuses that end a task (`task_notification` ends it at any
// status), and the top-level message types that mean the main loop is working again.
// A top-level system/init counts too: measured on CLI 2.1.269, a notification cycle
// starts with init and NO user message, and without partial messages the model may
// then think for longer than the grace before anything else arrives.
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);
const MAIN_LOOP_ACTIVITY_TYPES = new Set(['assistant', 'user', 'stream_event']);
const startsMainLoopActivity = (message) => !message?.parent_tool_use_id && (
  MAIN_LOOP_ACTIVITY_TYPES.has(message?.type)
  || (message?.type === 'system' && message.subtype === 'init'));

/**
 * B-1120: per-run view of the CLI's tasks, fed with RAW SDK messages. Measured on
 * CLI 2.1.269: every task (foreground or background, agent or bash) emits
 * system/task_started{task_id,is_backgrounded}, then task_updated{patch.status} and
 * task_notification{status} for the same id — so every start counts and either end
 * event clears it. Unknown ids are ignored, so the count can never go negative.
 * `quiet` is true from a `result` until the MAIN loop (not a subagent) speaks again.
 * `continuationExpected`: a known task ended while quiet, so its notification cycle is
 * due; cleared when that cycle (or any main-loop activity) starts, or on a `result`.
 * `backgrounded`: this message started (or moved) a task into the background.
 * @returns {{ observe: (message: object) => { quiet: boolean, pending: number,
 *   continuationExpected: boolean, backgrounded: boolean } }}
 */
function createBackgroundTaskTracker() {
  const pendingTasks = new Map();
  let quiet = false;
  let continuationExpected = false;
  const endsTask = (message) => message.subtype === 'task_notification'
    || (message.subtype === 'task_updated' && TERMINAL_TASK_STATUSES.has(message.patch?.status));
  return {
    observe(message) {
      let backgrounded = false;
      if (message?.type === 'system' && typeof message.task_id === 'string' && message.task_id) {
        if (message.subtype === 'task_started') {
          pendingTasks.set(message.task_id, { startedAt: Date.now() });
          backgrounded = message.is_backgrounded === true;
        } else if (endsTask(message)) {
          if (pendingTasks.delete(message.task_id) && quiet) continuationExpected = true;
        } else if (message.subtype === 'task_updated') {
          backgrounded = message.patch?.is_backgrounded === true;
        }
      }
      if (message?.type === 'result') {
        quiet = true;
        continuationExpected = false;
      } else if (startsMainLoopActivity(message)) {
        quiet = false;
        continuationExpected = false;
      }
      return { quiet, pending: pendingTasks.size, continuationExpected, backgrounded };
    },
  };
}

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

/**
 * Reads a tool_result block's text, whose `content` is either a string or an
 * array of {type,text} parts. Returns '' for anything else. Never throws.
 */
function toolResultText(block) {
  const inner = block?.content;
  if (typeof inner === 'string') return inner;
  if (Array.isArray(inner)) {
    return inner.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

// NARROWED (B-503). The previous version matched the signature ANYWHERE — in a
// `result` string, in assistant prose, in any tool_result — with `includes`. In a
// repo that documents this very bug, that matches the documentation: every one of
// the last live [B117-SIGNATURE] lines was a session merely READING the diagnosis
// file or grepping the source, i.e. 100% echo, 0% signal. Three constraints kill
// it without losing a real emission: the CLI puts this string in a tool_result, it
// sets is_error, and the string is the START of the text (an echo never is).
function scanB117Signature(message) {
  try {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block?.type !== 'tool_result' || block.is_error !== true) continue;
      const text = toolResultText(block);
      if (text.startsWith(B117_FAILURE_SIGNATURE)) return text;
    }
  } catch { /* monitoring must never break the read loop */ }
  return null;
}

// [DELEGATION-CANCELLED] (B-503) — the tool was cancelled at ENTRY, before any
// permission check, because the CLI could not run its PreToolUse SDK-callback on a
// closed control stream. What the model then reads is byte-identical to a human
// refusal, which is why four separate diagnoses mistook it for one.
//
// The CLI does carry the discriminator: `toolDenialKind` is "cancelled" here and
// "user-rejected" for a real refusal (measured in this project's transcripts: 21
// vs 31 vs 76 "permission-rule"). It sits at the TOP LEVEL of the record, beside
// `message` — verified on disk. Whether the SDK message stream carries it too is
// NOT verified, so this falls back to the structural shape (an errored tool_result
// whose text STARTS with the CLI's fixed cancellation string, extracted verbatim
// from the 2.1.221 binary). Returns which test matched, so the log tells us if the
// fallback is doing all the work and the field check can then be dropped.
const CLI_CANCELLATION_TEXT = "The user doesn't want to take this action right now.";
function scanDelegationCancellation(message) {
  try {
    if (message?.toolDenialKind === 'cancelled') return 'toolDenialKind';
    const content = message?.message?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block?.type !== 'tool_result' || block.is_error !== true) continue;
      if (toolResultText(block).startsWith(CLI_CANCELLATION_TEXT)) return 'text-shape';
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
    return { resolved: false, sessionId: null };
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
    return { resolved: false, sessionId };
  }

  if (verdict.role === 'collaborator') {
    console.log(
      `[SEC-APPROVAL] collaborator answered requestId=${requestId} session=${sessionId || 'none'} `
      + `requester=${JSON.stringify(requesterUserId)} (updatedInput/rememberEntry stripped)`
    );
  }

  resolver(verdict.decision);
  return { resolved: true, sessionId };
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
  const { sessionId, cwd, toolsSettings } = options;
  const parityEnforced = options.permissionExecution?.mode === 'enforce';
  if (parityEnforced && options.permissionExecution?.effectivePolicy?.profileId !== 'full_delegation') {
    throw new Error('PERMISSION_EFFECTIVE_POLICY_REQUIRED');
  }
  const permissionMode = parityEnforced ? 'bypassPermissions' : options.permissionMode;

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

  // Coordination limits are per spawn, never process-wide policy. Write every
  // key in every case so a PM2/shell environment cannot silently widen a turn.
  // Unknown client input fails closed to the direct profile.
  // القيم مقيسة على CLI 2.1.226، لا مقدَّرة. حارس العمق في الثنائية `if (m >= h) throw`
  // ورتبةُ المنسّق صفر — فالعمق 1 يُبقي تفويضَ المنسّق مفتوحاً ويمنع الوكيلَ من
  // التعشيش، والعمق 2 يسمح بدرجةٍ واحدة أعمق. وكان `delegate_review` عند 3 وهو
  // افتراضُ الـCLI نفسه، أي صفرُ أثرٍ ووعدٌ بحدٍّ لا يُفرَض (فيتو qa-critic 2026-08-10).
  //
  // `direct` و`delegate` يتساويان عمقاً **عمداً**: الفارق بينهما نصٌّ محقون لا إنفاذ،
  // وهو مقيسٌ ومعلَن في التصميم — لا تُضِف لهما فرقاً وهمياً هنا.
  //
  // ولا يُضبط `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`: مسحُ الثنائية لا يجد له قارئاً
  // وظيفياً (ثلاث ورودات كلها قوائم أسماء)، بخلاف نظيره MAX_WEB_SEARCHES_PER_SESSION
  // الذي له قارئ صريح. ضبطُ اسمٍ لا يقرؤه أحد هو بعينه B-548.
  const coordinationProfiles = {
    direct: { depth: '1', concurrent: '20' },
    delegate: { depth: '1', concurrent: '20' },
    delegate_review: { depth: '2', concurrent: '20' },
  };
  const coordinationLevel = Object.hasOwn(coordinationProfiles, options.coordinationLevel)
    ? options.coordinationLevel
    : 'direct';
  const coordinationProfile = claudeDelegationProfile(coordinationLevel);
  sdkOptions.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = coordinationProfile.depth;
  sdkOptions.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = coordinationProfile.concurrent;

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
  if (parityEnforced) {
    sdkOptions.permissionMode = 'bypassPermissions';
    sdkOptions.allowDangerouslySkipPermissions = true;
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
  if (!parityEnforced) {
    for (const tool of ['Task', 'Agent']) {
      if (!allowedTools.includes(tool)) allowedTools.push(tool);
    }
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

  sdkOptions.disallowedTools = parityEnforced
    ? [...new Set([...(settings.disallowedTools || []), 'Task', 'Agent'])]
    : (settings.disallowedTools || []);

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
    // A vendor id on an engine-driven run is EXPECTED here and is restored right
    // before the request (see the injectedHosts block in runClaudeSDKQuery), so
    // warning about it announces a substitution that does not happen — a false
    // trail for the next person debugging an engine run.
    if (requested && !options.engineProvider) {
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
    preset: 'claude_code',  // Required to use CLAUDE.md
    append: getRuntimeInstructions(coordinationLevel),
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
async function probeClaudeBuiltInCommands(context = {}) {
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

/** Runs the Claude command-catalog subprocess under its own ADR-134 permit. */
async function getClaudeBuiltInCommands(context = {}) {
  return runAuthorizedProviderCatalog(
    'claude',
    context?.userId ?? null,
    context?.authenticatedPrincipal,
    () => probeClaudeBuiltInCommands(context),
  );
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
/**
 * Tools fenced off when the Claude body runs on a VENDOR ENGINE (T-1209).
 *
 * The same list `BTW_DISALLOWED_TOOLS` fences for a different reason, minus the
 * network reads: a side query is fenced because it must not act, whereas an
 * engine run is fenced because a light model's tool calls cannot be trusted to
 * be well-formed enough to act SAFELY. WebFetch/WebSearch are therefore left
 * available here — they read, and a garbled read costs only a turn.
 */
const ENGINE_FENCED_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Bash', 'BashOutput', 'KillShell',
]);

/**
 * Is the engine write fence on? Default ON, and the flag exists to turn it OFF.
 *
 * Fail-safe rather than fail-open: the fence protects the working tree, and the
 * cost of being wrong is asymmetric — a needless denial wastes a turn and says
 * exactly why, whereas a needless permission can truncate a file. An operator
 * who has measured their engine and wants it to write sets
 * `NASSAJ_ENGINE_WRITE_FENCE=0`.
 *
 * Read per spawn, not cached at import: the operator may flip it without a
 * restart, and a module-level constant would silently ignore that.
 */
function isEngineWriteFenceEnabled() {
  const raw = String(process.env.NASSAJ_ENGINE_WRITE_FENCE ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

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
 * ADR-088: records the engine this spawn ACTUALLY ran with onto the session
 * row, from the resolved verdict — never from the client's request.
 *
 * Write discipline (all enforced in sessionsDb.setSessionEnginePin):
 *   - an ENGINE verdict may fill an unknown pin or upgrade an 'inferred' one;
 *   - an OFFICIAL verdict is recorded only for sessions BORN this spawn
 *     (`bornThisSpawn`) — an old NULL row is unknown, and a leaked official
 *     turn on it must never masquerade as ground truth (qa-critic حرج 1/2);
 *   - a lineage child (resume minted a NEW id) first inherits its parent's pin.
 */
function recordSessionEnginePin({ newSessionId, parentSessionId, engagedEngine, bornThisSpawn }) {
  try {
    if (parentSessionId && parentSessionId !== newSessionId) {
      const parentPin = sessionsDb.getSessionEnginePin(parentSessionId);
      if (parentPin?.engine) {
        sessionsDb.setSessionEnginePin(
          newSessionId,
          parentPin.engine,
          parentPin.source === PIN_SOURCE.INFERRED ? PIN_SOURCE.INFERRED : PIN_SOURCE.SERVER_VERDICT,
        );
        return;
      }
    }
    if (engagedEngine) {
      sessionsDb.setSessionEnginePin(newSessionId, engagedEngine, PIN_SOURCE.SERVER_VERDICT);
    } else if (bornThisSpawn) {
      sessionsDb.setSessionEnginePin(newSessionId, OFFICIAL_ENGINE, PIN_SOURCE.SERVER_VERDICT);
    }
  } catch (error) {
    console.warn(`[engine-pin] pin write failed for ${newSessionId}: ${error?.message ?? error}`);
  }
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
 * @param {string} [params.engineProvider] - Optional explicit engine override
 *   (ADR-037). Undefined in normal operation — the fork then resolves the
 *   session's own server-side pin (sessions.engine_provider, ADR-088/B-358)
 *   instead of silently defaulting to official Anthropic.
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
    authenticatedPrincipal = undefined,
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
    // B-421: a /btw fork replays the live session's history too, so it inherits
    // the same poisoned-block failure. Repair the SOURCE transcript (`liveSid`)
    // before the fork reads it — same fail-open contract as the live path.
    repairResumeTranscript({
      sessionId: liveSid,
      cwd: sdkOptions.cwd ?? projectRoot ?? null,
      configDir: sdkOptions.env?.CLAUDE_CONFIG_DIR ?? null,
    });
    // B-222/B-358: when a fork's session is pinned to a vendor engine, that
    // engine is honoured or the fork FAILS — never quietly answered by official
    // Anthropic. The caller does NOT send an engine (the confirmed B-358 leak:
    // this seam trusted a parameter the WS layer never passed), so the pin is
    // read from the server's own record — sessions.engine_provider (ADR-088),
    // falling back to the conservative history inference for legacy NULL rows.
    // Throws ENGINE_PROVIDER_UNAVAILABLE; the catch below turns it into the
    // sdk_error the caller shows. Unknown/ambiguous/unreadable pin also refuses
    // the resume before query construction; it never guesses the official path.
    const sideProfile = await resolveClaudeRunProfileOrThrow({
      userId,
      authenticatedPrincipal,
      sessionId: liveSid,
      clientEngine: engineProvider,
      baseEnv: sdkOptions.env,
      envAlreadyIsolated: true,
      authoritativeStoredPin: true,
      requireKnownResumePin: true,
      failOnAmbiguous: true,
    });
    sdkOptions.env = sideProfile.env;
    const sideQueryEngine = sideProfile.effectiveEngine;
    const injectedHosts = sideProfile.engineHosts;

    // ADR-088 (بند 9): an engine-driven fork must run an ENGINE-catalog model —
    // the SDK's own default is an Anthropic id, and sending it to the vendor
    // endpoint is a guaranteed dead turn. Prefer the session's transcript-
    // resolved model when it belongs to the engine's catalog (the transcript
    // may be polluted by a leaked official turn), else the engine default.
    if (injectedHosts !== null && sideQueryEngine) {
      let engineCatalog = null;
      try {
        engineCatalog = (await providerModelsService.getProviderModels(
          sideQueryEngine, {}, userId, authenticatedPrincipal,
        )).models ?? null;
      } catch {
        engineCatalog = null;
      }
      let transcriptModel = null;
      try {
        transcriptModel = (await providerModelsService.resolveResumeModel('claude', liveSid, null)) ?? null;
      } catch {
        transcriptModel = null;
      }
      const engineModel = pickEngineModel({
        engine: sideQueryEngine,
        resolvedModel: transcriptModel,
        clientModel: null,
        catalog: engineCatalog,
        warn: (msg) => console.warn(`[btw] ${msg}`),
      });
      if (engineModel) {
        sdkOptions.model = engineModel;
      }
    }

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
        // B-1286 notification-cycle guard (CLI ≥2.1.273): forking a
        // session that still has a PENDING background-task notification (the /btw
        // case by design — the main task keeps running elsewhere) makes the CLI
        // emit a SUCCESS `result` with `num_turns:0` and no text BEFORE the prompt
        // is processed; it then RE-INITs and answers in a SECOND result. Without
        // this guard the B-1084 empty-answer path below fired on that first
        // no-turn result and `break`-ed the loop, so the /btw overlay ALWAYS
        // showed `empty_response` even for a trivial question (field repro:
        // task_notification → init → result num_turns=0 empty → init → assistant
        // text → result num_turns=1). Skip the notification-delivery cycle and
        // keep reading for the real answer turn. Fingerprint kept tight (success,
        // zero turns, nothing produced yet) so a genuine one-turn empty answer
        // (num_turns≥1) still surfaces as empty_response below.
        const numTurns = typeof message.num_turns === 'number' ? message.num_turns : null;
        if (numTurns === 0 && !emittedText && resultText.length === 0) {
          console.warn(
            `[BTW] notification-cycle result skipped session=${liveSid || '<none>'} `
            + `subtype=${subtype || '<none>'} num_turns=0`
          );
          continue;
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
        // B-1084: when the fork reports success but produced NO visible text (e.g.
        // the model used extended thinking and emitted only `thinking` content
        // blocks with no accompanying `text` block, leaving both resultText and
        // accumulatedAnswer empty), surface this as `empty_response` instead of
        // calling onComplete('') — which the WS layer sends as a btw-complete
        // frame without `text`, and the client renders as a silent blank answer.
        if (!finalAnswer) {
          console.warn(
            `[BTW] empty answer session=${liveSid || '<none>'} subtype=${subtype || '<none>'} `
            + `userIdType=${typeof userId} userIdValue=${String(userId)}`
          );
          finish(onError, 'empty_response',
            'The model did not produce a visible text answer. Try rephrasing the question.');
        } else {
          finish(onComplete, finalAnswer);
        }
        break;
      }
    }

    // Stream ended without an explicit result (e.g. maxTurns cutoff).
    // B-1084: apply the same empty-answer guard as the success-result branch above.
    if (accumulatedAnswer) {
      finish(onComplete, accumulatedAnswer);
    } else {
      finish(onError, 'empty_response',
        'The model produced no text before the stream ended. Try rephrasing the question.');
    }
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
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, runTag = null, projectPath = null, runToken = null, releaseInput = null, forceStop = null) {
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
    // B-1136: kills this run's CLI through its SDK abort controller. The abort
    // path uses it only when interrupt() does not answer in time. Null for
    // callers that pass no handle.
    forceStop,
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
 * ADR-099: may this session's engine pin be re-stamped right now?
 *
 * Deliberately a THIRD predicate rather than a reuse of the two above, because
 * neither expresses what this question needs (qa-critic مهم 7):
 *
 *   • `isSessionRunLive` answers FALSE for a listener-less ghost ON PURPOSE — so
 *     a stale entry can never lock a user out of SENDING. Re-using it here would
 *     re-stamp the engine out from under a turn that is still executing, and the
 *     env of a running process cannot be changed: that turn would finish on the
 *     old vendor while the DB claims the new one.
 *   • `isClaudeSDKSessionActive` is the right breadth but its name and contract
 *     belong to the `session-status` frame; binding a security decision to it
 *     would make any future tweak there silently change who may re-stamp.
 *
 * So: ANY registered entry still marked 'active' blocks the switch, detached
 * included. Fail-closed. A ghost that outlives its process is cleared by the
 * orphan reconcile/ghost sweep, so the block is bounded in time, never permanent.
 *
 * @returns {{busy: boolean, reason: 'live'|'detached'|null}}
 */
export function isSessionEngineSwitchBlocked(sessionId) {
  const existing = activeSessions.get(sessionId);
  if (!existing || existing.status !== 'active') return { busy: false, reason: null };
  return { busy: true, reason: existing.detached ? 'detached' : 'live' };
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
 * Reads only the main-chain assistant request. Result/modelUsage totals are
 * cumulative and cannot describe the current context.
 *
 * `inputTokens` reflects the FULL input (raw input + cache read + cache
 * creation) so the budget counter is accurate under prompt caching.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage, sessionId = null) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Result usage is cumulative, and subagent usage belongs to another context.
  if (sdkMessage.type !== 'assistant' || sdkMessage.parent_tool_use_id
    || !sdkMessage.message?.usage) return null;
  const cacheSnapshot = claudeCacheSnapshot(sdkMessage, sessionId || sdkMessage.session_id || null);
  const { full, cacheRead, cacheCreation } = readInputTokens(sdkMessage.message.usage);
  const outputTokens = readNumber(sdkMessage.message.usage.output_tokens);
  return {
    cacheSnapshot,
    used: null, total: null, inputTokens: full, outputTokens,
    breakdown: { input: full, output: outputTokens, cacheRead, cacheCreation },
    contextSnapshot: claudeContextSnapshot(null, {
      sessionId: sessionId || sdkMessage.session_id || null,
      modelId: sdkMessage.message.model || null,
    }, full),
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to the durable chat-image store and returns the prompt
 * annotated with their file paths.
 *
 * B-430: these files used to live under os.tmpdir() and were deleted by
 * cleanupTempFiles as soon as the query settled. The transcript keeps only the
 * path note, so once the optimistic message was replaced by its transcript twin
 * the picture was unrecoverable and the chat showed a dead path. The bytes now
 * outlive the query (chat-image-store), which is what lets the UI re-render an
 * attached image after a reload — hence `tempImagePaths` stays EMPTY here: it is
 * strictly the cleanup list, and these files must not be cleaned up.
 *
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory (unused; images are app data, not repo data)
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir, failures}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  const tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir, failures: [] };
  }

  try {
    const { paths: storedPaths, failures } = await saveChatImages(images);

    // Include the full image paths in the prompt.
    //
    // The note is appended whenever anything was stored, INCLUDING for an empty
    // prompt (qa-critic): the old `command.trim()` condition meant a bare
    // pasted screenshot wrote its bytes to disk, told the model nothing, and
    // left a bucket no reader could ever reach — a permanent leak that the
    // pre-B-430 temp-file cleanup at least used to sweep.
    let modifiedCommand = command;
    if (storedPaths.length > 0) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${storedPaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = (command || '') + imageNote;
    }

    // Images processed
    return { modifiedCommand, tempImagePaths, tempDir, failures };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return {
      modifiedCommand: command,
      tempImagePaths,
      tempDir,
      failures: [{ index: -1, reason: error.message || 'image processing failed' }],
    };
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
 * Loads MCP server configurations from the spawning user's `.claude.json`.
 *
 * B-344 — the project key. The writer (`claude-mcp.provider.ts`) stores project
 * entries under `config.projects[<ws>]`, which is also what the Claude CLI
 * itself writes; this reader looked for `claudeProjects`, a key nothing has ever
 * produced. Every project- and local-scoped MCP registration was therefore
 * written and never read. Fixed on the READER: the writer matches the CLI's own
 * file, and changing it would orphan the entries the CLI already owns.
 *
 * B-346 — whose file. The path was `os.homedir()/.claude.json`, i.e. the
 * OPERATOR's config, for every user's session — while `resolveProviderEnv` had
 * already given this spawn its own `CLAUDE_CONFIG_DIR`. So each member's session
 * loaded the operator's MCP servers (and none of their own). The config dir the
 * child will actually read is the one to read here.
 *
 * @param {string} cwd - Current working directory for project-specific configs
 * @param {string} [configDir] - CLAUDE_CONFIG_DIR of this spawn; defaults to the
 *   process home, which is the correct answer only for the operator's own runs.
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd, configDir) {
  try {
    const configRoot = typeof configDir === 'string' && configDir.trim() !== ''
      ? configDir
      : os.homedir();
    const claudeConfigPath = path.join(configRoot, '.claude.json');

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
      console.error(`Failed to parse ${claudeConfigPath}:`, error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers (B-344: `projects`, the key
    // the writer and the Claude CLI both use — not `claudeProjects`).
    if (claudeConfig.projects && cwd) {
      const projectConfig = claudeConfig.projects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    // T-1297: an `npx -y <pkg>` entry costs `npm exec` + `sh` + the server on
    // EVERY spawn (~250MB of supervisors per session, measured). When the
    // package is installed in a root nassaj owns, hand the CLI the resolved bin
    // under this same node instead. Applied on the READ, not on the stored
    // config: the entries on disk stay in their portable `npx` form, so nothing
    // has to be re-distributed and an install that loses the local copy simply
    // falls back to npx again.
    return collapseNpxLaunchers(mcpServers);
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
  // T-1295 — هويةُ الجولة كما ولّدها العميل، تُصدى بها كلُّ حمولة **حكم** على
  // هذه الجولة (`session_created`, `complete`, `error`). بها وحدها يربط العميل
  // الحكمَ بإدخال صندوق الصادر الصحيح؛ وبدونها كان يربطه بـ«أحدث معلَّق لهذه
  // الجلسة» — تخمينٌ يُصيب تشغيلاً آخر فيُعيد إرسال حمولةٍ إلى محادثة ليست لها.
  //
  // كائن (لا سلسلة) لأنه يُنشَر بـ`...`: عميلٌ لم يرسله يُنتج `{}` فلا يظهر
  // الحقل أصلاً في الحمولة، وكلُّ ما يقرأ هذه الحمولات يبقى كما هو حرفياً.
  const clientMsgIdField =
    typeof options.clientMsgId === 'string' && options.clientMsgId
      ? { clientMsgId: options.clientMsgId }
      : {};
  // Turn timing is attested by this runner, never inferred from transcript
  // order.  It remains local to this invocation so concurrent sessions cannot
  // borrow another turn's start or completion timestamp.
  const responseToMessageIdField = typeof options.clientMsgId === 'string' && options.clientMsgId
    ? { responseToMessageId: options.clientMsgId }
    : {};
  let turnStartedAt = null;
  let sawSuccessfulResult = false;
  const permissionExecution = options.permissionExecution;
  let permissionConsumed = false;
  let permissionStarted = false;
  let permissionOutcome = null;
  if (permissionExecution !== undefined && (
    !permissionExecution
    || typeof permissionExecution.consume !== 'function'
    || typeof permissionExecution.markStarted !== 'function'
    || typeof permissionExecution.settle !== 'function'
    || typeof permissionExecution.notStarted !== 'function'
  )) {
    throw new Error('PERMISSION_EXECUTION_HANDLE_INVALID');
  }
  // Server-generated durable id. It is never sent to the browser and is only
  // committed once a final assistant message gives us a stable history key.
  const responseTurnId = crypto.randomUUID();
  let durableFinalAssistantMessageId = null;
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
    // B-515 — هذا الموضع وحده **يبقى** إرسالاً مباشراً بلا تخزين، عن قصد: لا
    // مخزن لهذه المحاولة المرفوضة أصلاً، والمخزن القائم تحت هذا المعرّف ملكُ
    // الجولة الحيّة التي رفضنا مزاحمتها. والكتابة فيه هي بعينها ما بُني
    // B-SEC-DUP-RUN لمنعه («both interleaved writes into the same replay
    // RingBuffer»): ستُعطي الرفضَ رقماً تسلسلياً من عدّاد جولةٍ ليس منها، وتُعيد
    // بثّه لاحقاً لكل مقبس يستأنف تلك الجولة السليمة فيرى فشلاً انقضى.
    ws.send(createNormalizedMessage({
      kind: 'error',
      code: 'session_busy',
      content:
        'This conversation already has a run in progress. '
        + 'Wait for it to finish (or stop it) before sending another message.',
      sessionId,
      provider: 'claude',
      ...clientMsgIdField,
    }));
    permissionExecution?.notStarted();
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
      // ‏`buildCwdMissingPayload` يبني حقولَه صراحةً ولا يمرّر ما لا يعرف، فصدى
      // الهوية يُضاف فوق ناتجه لا داخل وسائطه.
      ws.send(createNormalizedMessage({
        ...buildCwdMissingPayload(cwdCheck.error, {
          sessionId: sessionId || null,
          provider: 'claude',
          isNewSessionError: !sessionId,
        }),
        ...clientMsgIdField,
      }));
      permissionExecution?.notStarted();
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

  // B-524: the 0600 file that carries this run's MCP servers (and with them the
  // connector credentials) instead of the command line. Declared out here so the
  // finally can unlink it on every exit path, including the ones that throw.
  let mcpConfigFile = null;

  // B-117 — keep the CONTROL channel alive past the first `result`.
  //
  // Handing the SDK a STRING prompt sets isSingleUserTurn, and the SDK then does
  // this (sdk.mjs, Query.readMessages): on the FIRST `result` message it calls
  // transport.endInput() — "First result received for single-turn query, closing
  // stdin". stdin is not just the user-input pipe: every control_response the SDK
  // owes the CLI rides it too (SDK-callback hooks, canUseTool). So the moment a
  // run produces one result, the CLI can still keep working — background-agent
  // notifications and queued messages re-enter the loop — but it can no longer
  // reach us. Measured on the live incident (debug log, SampleTwo session
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
  // B-503: closing this stream is a ONE-WAY door — stdin cannot be reopened, so a
  // delegation issued after this point dies for the rest of the process's life. Yet
  // nothing recorded the moment it happened, which is why every past investigation
  // had to infer it from timestamps in the CLI's own debug file. One line, once, with
  // the reason: `result-immediate` (no continuation predicted), `grace-expired` (the
  // prediction was wrong and the run kept going), `background-idle-cap` (B-1120:
  // background tasks never reported back within the idle ceiling), `abort`, or
  // `run-ended` (the finally).
  let inputReleasedAt = null;
  const releaseInput = (reason) => {
    if (inputReleasedAt === null) {
      inputReleasedAt = Date.now();
      try {
        console.log(
          `[CONTROL-STREAM-CLOSE] session=${capturedSessionId || sessionId || 'NEW'} `
          + `reason=${reason} graceMs=${sdkInputCloseGraceMs()}`
        );
      } catch { /* logging must never break the run */ }
    }
    releaseInputStream();
  };
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
  const armInputClose = (delayMs = sdkInputCloseGraceMs(), reason = 'grace-expired') => {
    disarmInputClose();
    inputCloseTimer = setTimeout(() => {
      inputCloseTimer = null;
      releaseInput(reason);
    }, delayMs);
    if (typeof inputCloseTimer.unref === 'function') inputCloseTimer.unref();
  };
  // B-1120: the close decision, re-taken after EVERY CLI message — not only on a
  // `result`, since a message landing after the last result used to disarm the
  // timer for good. Nothing is armed while the main loop is working. Once it is
  // quiet: no pending task → the B-117 path unchanged (immediate close unless a
  // continuation is possible, else the grace); pending tasks → hold the channel,
  // bounded by the idle ceiling, so their notification finds it still open; a task
  // just ended → wait for its notification cycle (longer than the grace).
  const reconsiderInputClose = (taskState, continuationPossible) => {
    disarmInputClose();
    if (inputReleasedAt !== null || !taskState.quiet) return;
    if (taskState.pending > 0) {
      armInputClose(sdkBackgroundHoldIdleMaxMs(), 'background-idle-cap');
    } else if (taskState.continuationExpected) {
      armInputClose(sdkContinuationWaitMs(), 'continuation-wait-expired');
    } else if (continuationPossible) {
      armInputClose();
    } else {
      releaseInput('result-immediate');
    }
  };

  // قرارُ المحرّك يُقرأ في `catch` أدناه (B-411، ‏96f5752b)، فيلزم أن يعيش خارج
  // `try`. كان كلاهما `const` داخل `try`، فكان كل فشلٍ في هذه الجولة يرتدّ
  // `ReferenceError: injectedHosts is not defined` **قبل** بناء حمولة الخطأ
  // بأسطر — فلا خطأ يصل صاحبه ولا إشعار فشل يُطلق، والجولة تنتهي صامتة تماماً.
  // القيمة الابتدائية `null` هي بعينها معنى «لم يُشتبك محرّك»، فمسار الفشل
  // المبكّر يقرأ الحقيقة لا صدفةً.
  let injectedHosts = null;
  let effectiveEngineProvider = null;
  // B-1136: declared out here so the catch below can tell a STOP-driven kill apart.
  let runAbortController = null;

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
      const { models: catalog } = await providerModelsService.getProviderModels(
        'claude',
        {},
        ws?.userId ?? null,
        options.authenticatedPrincipal,
      );
      validModelValues = buildValidClaudeModelValues(catalog);
    } catch {
      validModelValues = undefined;
    }

    // T-1665: a RESUMED session's model is read back from its own transcript
    // (resolveResumeModel → getCurrentActiveModel), so it arrives as the API id
    // the run actually used (`claude-opus-5`), while the catalog lists picker
    // aliases (`opus[1m]`). Validating that id against the alias list rejected
    // it and coerced the session to `default` — a different model — on every
    // turn: the whole prompt cache was rewritten (~130–330k tokens each time)
    // and the user was silently moved off the model they chose. 67 such
    // substitutions were logged in the two weeks before this fix. A model the
    // session is already running on is, by construction, one the account can
    // run, so it is accepted verbatim for a resume. A brand-new session (no
    // sessionId) still validates the picker value exactly as before.
    if (sessionId && typeof resolvedModel === 'string' && resolvedModel.trim()) {
      validModelValues = new Set(validModelValues instanceof Set ? validModelValues : buildValidClaudeModelValues(null));
      validModelValues.add(resolvedModel.trim());
    }

    // Map CLI options to SDK format
    const requestedModelForRun = resolvedModel || options.model;
    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: requestedModelForRun,
    }, validModelValues);

    // T-1665: a substitution must never be silent to the USER — a console.warn
    // is invisible from the chat. Surface it as a status line so the person who
    // picked a model sees which one is actually running.
    if (
      typeof requestedModelForRun === 'string'
      && requestedModelForRun.trim()
      && requestedModelForRun.trim() !== 'auto'
      && sdkOptions.model !== requestedModelForRun.trim()
    ) {
      bufferThenSend(ws, sessionId || null, createNormalizedMessage({
        kind: 'status',
        text: `النموذج المطلوب "${requestedModelForRun.trim()}" غير متاح في هذا الحساب — تعمل الجولة على "${sdkOptions.model}"`,
        sessionId: sessionId || null,
        provider: 'claude',
        canInterrupt: true,
      }));
    }

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
      authenticatedPrincipal: options.authenticatedPrincipal,
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

    // B-1136: this run's hard-stop handle. interrupt() is a control request and
    // never settles once the control stream is closed, so STOP needs a path that
    // does not use that channel: aborting this controller makes the SDK close the
    // transport and SIGTERM→SIGKILL the CLI child (the caged spawn forwards it).
    runAbortController = new AbortController();
    sdkOptions.abortController = runAbortController;

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

    // Load MCP configuration from THIS spawn's config dir (B-346), not the
    // operator's home. sdkOptions.env was rebuilt by resolveProviderEnv above.
    if (permissionExecution?.mode !== 'enforce') {
      const mcpServers = await loadMcpConfig(options.cwd, sdkOptions.env.CLAUDE_CONFIG_DIR);
      if (mcpServers) {
        sdkOptions.mcpServers = mcpServers;
      }
    } else {
      delete sdkOptions.mcpServers;
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
    if (options.allowVendorDelegation && permissionExecution?.mode === 'enforce') {
      throw Object.assign(
        new Error('External provider delegation is unavailable under permission-parity v1.'),
        { code: 'PERMISSION_EXTERNAL_DELEGATION_DENIED' },
      );
    }
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
    //
    // ADR-088 (B-258/B-262): the engine to engage is no longer the client's
    // word alone. resolveSessionEnginePinForSpawn consults the server's own
    // pin (sessions.engine_provider) and the conservative history inference,
    // then applies the decision table. Enforcement is server-authoritative by
    // default; an explicit NASSAJ_ENGINE_PIN_ENFORCE=0 is rollback shadow mode.
    // Throws ENGINE_PIN_AMBIGUOUS only under enforcement (fail-closed instead
    // of guessing which vendor should see the payload).
    const runProfile = await resolveClaudeRunProfileOrThrow({
      userId: ws?.userId ?? null,
      authenticatedPrincipal: options.authenticatedPrincipal,
      sessionId: sessionId || null,
      clientEngine: options.engineProvider,
      baseEnv: sdkOptions.env,
      envAlreadyIsolated: true,
      requireKnownResumePin: Boolean(sessionId),
      failOnAmbiguous: Boolean(sessionId),
    });
    sdkOptions.env = runProfile.env;
    effectiveEngineProvider = runProfile.effectiveEngine ?? null;
    injectedHosts = runProfile.engineHosts;

    // B-421: a resume replays the ENTIRE transcript to the API every turn, so a
    // single malformed content block is permanent — the session 400s forever and
    // never heals itself. The one that bit us came from a vendor ENGINE
    // (ADR-037): z.ai answered with its own `call_…` id inside a
    // `server_tool_use` block, which the API validates against `^srvtoolu_`.
    //
    // Placed AFTER the engine pin resolves so the audit row names the engine the
    // SERVER decided on (ADR-088), not the client's word — the whole diagnostic
    // value here is knowing WHICH vendor writes rejectable blocks. Still before
    // query(), and only on a resume: a new session has no file to fix.
    //
    // Fail-open twice over: the repair swallows every error, and the audit write
    // never throws. A session that would have spawned still spawns.
    if (sdkOptions.resume) {
      const repair = repairResumeTranscript({
        sessionId: sdkOptions.resume,
        cwd: sdkOptions.cwd ?? options.cwd ?? null,
        configDir: sdkOptions.env?.CLAUDE_CONFIG_DIR ?? null,
      });
      if (repair.repaired > 0) {
        // Without this row the repair is invisible: a SECOND occurrence under a
        // different API-validated field would again surface only as a user's
        // dead session. Types and tool names only — no ids, inputs or results.
        auditLogDb.record('transcript_block_repaired', {
          userId: ws?.userId ?? null,
          metadata: {
            sessionId: sdkOptions.resume,
            engineProvider: effectiveEngineProvider ?? OFFICIAL_ENGINE,
            blocks: repair.blocks,
            lines: repair.lines.length,
            kinds: [...new Set((repair.seen ?? []).map((s) => `${s.type}:${s.name ?? '-'}`))],
          },
        });
      }
    }

    // T-1209: the write fence follows the ENGAGED engine — `injectedHosts !== null`
    // is the same proof of engagement `recordSessionEnginePin` trusts, never the
    // client's word. The official Anthropic path leaves this false, so nothing
    // about it changes.
    const engineWriteFenceActive = injectedHosts !== null && isEngineWriteFenceEnabled();

    // When (and only when) an engine provider was actually engaged, re-assert the
    // caller's model id verbatim.
    //
    // ⚠️ DO NOT DELETE — this is load-bearing, not documentation. The comment that
    // stood here called it "a behavioural no-op … no coercion exists here"; that
    // was simply false. `mapCliOptionsToSDK` (claude-sdk.js:886-902) validates the
    // model against the CLAUDE catalog and rewrites anything outside it to
    // CLAUDE_FALLBACK_MODELS.DEFAULT — and a vendor id like `kimi-k3` or `glm-5.2`
    // is by definition outside it. These three lines are the ONLY thing that puts
    // the user's actual model back before the request leaves. Remove them and
    // every run on a vendor engine asks Moonshot/z.ai for an Anthropic model id
    // and dies, while the comment tells the next reader it was safe.
    //
    // With no engine engaged we leave sdkOptions.model exactly as mapped.
    //
    // ADR-088 (بند 9) hardening of the restore itself: prefer `resolvedModel`
    // (the session's transcript truth — what resolveResumeModel actually
    // computed before mapCliOptionsToSDK squashed it) over the client's
    // options.model, and verify MEMBERSHIP in the engine's catalog before
    // sending. A vendor session polluted by a leaked official turn resolves to
    // a claude-* id (incident 43b0dc60), and sending that to Moonshot/z.ai is
    // a guaranteed dead turn; the engine's own default is the safe landing.
    if (injectedHosts !== null && effectiveEngineProvider) {
      let engineCatalog = null;
      try {
        engineCatalog = (await providerModelsService.getProviderModels(
          effectiveEngineProvider,
          {},
          ws?.userId ?? null,
          options.authenticatedPrincipal,
        )).models ?? null;
      } catch {
        engineCatalog = null;
      }
      const engineModel = pickEngineModel({
        engine: effectiveEngineProvider,
        resolvedModel,
        clientModel: options.model,
        catalog: engineCatalog,
        warn: (msg) => console.warn(`[engine-pin] ${msg}`),
      });
      if (engineModel) {
        sdkOptions.model = engineModel;
      }
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    // A rejected image (too large, unsanitizable SVG, unwritable) must reach the
    // person who attached it. Silently dropping it left the model answering
    // about pictures it never received, which reads as a hallucination.
    if (imageResult.failures && imageResult.failures.length > 0) {
      console.warn('[chat-images] rejected attachments:', imageResult.failures);
      // B-515: مخزَّنة ثم مُرسَلة. المفتاح `sessionId` لأن الجولة لم تلتقط
      // معرّفها بعد؛ ومحادثة وليدة (بلا معرّف) تمرّ بلا تخزين كما يمرّ أوّلُ
      // بثّها في `sendAndBuffer` سواءً بسواء.
      bufferThenSend(ws, sessionId || null, createNormalizedMessage({
        kind: 'error',
        code: 'image_rejected',
        content:
          `${imageResult.failures.length} attached image(s) were not sent: `
          + imageResult.failures.map((f) => f.reason).join('; '),
        sessionId: sessionId || null,
        provider: 'claude',
      }));
    }
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
    // project cwd. When neither is known it stays undefined and nothing is
    // injected (B-1250: there is no fallback root). Captured once here so the
    // hook closure below never recomputes it.
    const coordinatorRepoRoot =
      (typeof options.cwd === 'string' && options.cwd.trim())
        ? options.cwd.trim()
        : (typeof options.projectPath === 'string' && options.projectPath.trim())
          ? options.projectPath.trim()
          : undefined;
    const coordinatorProjectId =
      typeof options.projectId === 'string' && options.projectId.trim()
        ? options.projectId.trim()
        : undefined;
    const coordinatorActorId = ws?.userId ?? null;

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
      // B-503 — the coordinator-injection flag gates REGISTRATION, not the hook body.
      //
      // Why this line and not the `if` inside each hook: the CLI cancels a tool whose
      // PreToolUse SDK-callback it cannot reach over a closed control stream, and it
      // does so at tool ENTRY — before the body runs, so a guard inside the body can
      // never fire. Registering the pair unconditionally therefore bought the failure
      // mode without ever buying the feature. Measured over the transcripts: 41
      // cancelled `Agent` delegations between 2026-07-24 and 2026-08-05, against 0 in
      // the 437 delegations that preceded these hooks — while the flag was never once
      // live on a running server (it is declared in an untracked ecosystem file that
      // pm2 has not re-read). Spread the pair in only when the flag is up: a node that
      // does not run the coordinator hands the CLI no SDK-callback hook on Agent/Task,
      // so a dead control stream has nothing to cancel. Byte-identical once it IS up.
      //
      // The `isCoordinatorInjectionEnabled` checks inside the bodies below are kept as
      // defence in depth; this spread is the load-bearing gate.
      ...(isCoordinatorInjectionEnabled(process.env) ? {
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
              projectId: coordinatorProjectId,
              actorId: coordinatorActorId,
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
              projectId: coordinatorProjectId,
              actorId: coordinatorActorId,
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
      }],
      } : {}),
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

      // T-1209 — the ENGINE write fence, and it sits ABOVE the bypass check on
      // purpose. `bypassPermissions` returns `allow` before `disallowedTools` is
      // ever consulted, so a fence expressed only in settings would be dead code
      // in exactly the mode that needs it most — the `cleanSpawnEnv` shape this
      // repo has already paid for once.
      //
      // WHY A FENCE AT ALL. A light vendor model driving the full Claude harness
      // is not merely "lower quality": `extractDeepSeekTextualToolCall` exists
      // because ~11% of one vendor's tool calls arrive as plain prose, and that
      // repair lives on the hosted-chat path, NOT here. On the engine path a
      // malformed call reaches the SDK as no `tool_use` at all. A garbled Read
      // costs a wasted turn; a garbled Write or Bash costs a file.
      //
      // Read-only work is untouched, which is the whole point: the free engine
      // is meant for summarising, classifying and reading (T-1209), and those
      // tools never reach this branch.
      if (engineWriteFenceActive && ENGINE_FENCED_TOOLS.has(toolName)) {
        return denyWithLog(
          `The ${engineProviderLabel(effectiveEngineProvider)} engine runs read-only in nassaj: `
          + `${toolName} is not available on a vendor engine. Switch this chat to the official `
          + 'Claude engine to edit files or run commands.',
          'engine-write-fence',
        );
      }

      // T-1804 — قفص النشر العام، وهو فوق فحص `bypassPermissions` للسبب نفسه
      // المشروح في سياج المحرّك أعلاه بالضبط: الوضعُ يُرجِع `allow` قبل أن
      // يُستشار `disallowedTools`، فقاعدةٌ في الإعدادات وحدها كودٌ ميّت في
      // الوضع الذي يحتاجها أكثر من غيره (درس `cleanSpawnEnv`).
      //
      // ما يمنعه: كتابةُ محتوى داخل `dist/`/`dist-server/` لتثبيت نسّاج — وهي
      // الطريقةُ الخاطئة التي كسرت تحديث العقدة فعلاً. والرسالةُ تحمل الأمرَ
      // البديل، فالوكيل لا يخرج من هنا ليبتكر طريقاً خاطئاً ثانياً.
      //
      // حدودُ التغطية بصدق: هذا الـcallback ليس حائطاً لا يُخترق. محرّك أذونات
      // الـSDK يُقيّم قواعد `permissions.allow` (من settingSources ومن طبقة
      // `/etc` المُدارة) **قبله**، والمطابقةُ تختصر الطريق إلى `allow` بلا أن
      // يُستدعى `canUseTool` أصلاً (الشرح الكامل عند قفص `/btw` أعلاه، B-171).
      // فقاعدةُ `Edit(...)` مسموحةٌ على هذا المضيف تتجاوز هذا القفص. الحائط
      // الذي لا تتجاوزه قاعدةُ سماحٍ هو hook من نوع PreToolUse، ولم يُستعمل هنا
      // لأنّ مسار الجلسة التفاعلية يُركّب hooks بشروط أخرى؛ رفعُ القفص إلى
      // PreToolUse بندٌ مستقلّ. ما يضمنه هذا الموضع اليوم: التغطية في كلّ وضعٍ
      // لا قاعدةَ سماحٍ صريحةً فيه للأداة، بما فيها `bypassPermissions`.
      const publicPageVerdict = evaluatePublicPageWrite(toolName, input, {
        cwd: sdkOptions.cwd ?? process.cwd(),
      });
      if (!publicPageVerdict.ok) {
        return denyWithLog(publicPageVerdict.message, 'public-page-build-output');
      }

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
      // B-515: مخزَّن ثم مُرسَل. طلبُ إذنٍ يموت مقبسُه قبل عرضه كان يُجمِّد
      // الجولة حتى السقف الزمني بلا أن يرى أحدٌ سؤالاً. والتكرار مأمون: العميل
      // يُلغي المكرَّر بـ`requestId`، و`get-pending-permissions` عند كل إعادة
      // اتصال يستبدل القائمة كاملةً بما هو معلَّق فعلاً — وإعادةُ البثّ محكومة
      // ببوابة الرؤية نفسها التي تحكم الإرسال الحيّ.
      bufferThenSend(ws, capturedSessionId || sessionId || null, createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
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
            // B-515: يُخزَّن للسبب الذي خُزِّن لأجله طلبُه — لولاه لأعادت إعادةُ
            // البثّ إحياء سؤالٍ أُلغي، ولبقي معلَّقاً على الشاشة بلا مُجيب.
            bufferThenSend(ws, capturedSessionId || sessionId || null, createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
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
    const reviewedDelegationReady = options.permissionExecution?.mode !== 'enforce' && await prepareClaudeReviewedDelegation(sdkOptions, options.coordinationLevel);
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    // B-524 — the LAST touch of sdkOptions.mcpServers, deliberately here, after
    // every contributor (loadMcpConfig, vendor-delegate) has had its say.
    //
    // Anything the SDK leaves on `mcpServers` that is not an in-process `sdk`
    // entry gets JSON.stringify'd into `--mcp-config <json>` — argv, i.e.
    // `/proc/<pid>/cmdline`, i.e. `ps aux` for every account on a host where uid
    // `nassaj` is shared between the server and the members' sessions. Connector
    // entries carry their credential in `env`, so that is a live secret leak.
    // Moving the external half to a 0600 file and handing the CLI the PATH via
    // extraArgs leaves argv with a filename and nothing else. In-process `sdk`
    // servers stay put: they never reach argv and cannot be serialised anyway.
    //
    // Deliberately NOT wrapped in a try: if the file cannot be written (disk
    // full, permissions) the only fallback is to put the credential back on the
    // command line, which is the bug. Let it throw inside the run's try/catch so
    // the member sees an error instead of a silent re-leak.
    if (sdkOptions.mcpServers) {
      const { inProcess, external } = splitSdkMcpServers(sdkOptions.mcpServers);
      // B-530: the destination is derived from the MEMBER, not from the env.
      // `sdkOptions.env` carries no XDG_DATA_HOME on the claude path (only the
      // opencode case of resolveProviderEnv sets one), so passing the env alone
      // put every member's connector secrets in one shared directory that every
      // other member's engine could read under the shared uid.
      mcpConfigFile = writeMcpConfigFile(external, {
        env: sdkOptions.env,
        userId: ws?.userId ?? null,
      });
      if (mcpConfigFile) {
        sdkOptions.mcpServers = inProcess;
        sdkOptions.extraArgs = { ...(sdkOptions.extraArgs || {}), 'mcp-config': mcpConfigFile.path };
      }
    }

    let queryInstance;
    // B-117: the streaming-input prompt. Yields this turn's single user message —
    // byte-identical text to the string form, which the SDK itself wrapped the
    // same way — then parks on `inputStreamRelease` so stdin (and with it the
    // control channel) stays open until we close it.
    const receiptPrompt = createClaudeReceiptPrompt({
      capability: options.vendorReceiptInvocation, command, content: finalCommand,
      userId: ws?.userId, sessionId: sessionId || null,
      persistSession: sdkOptions.persistSession, release: inputStreamRelease,
    });
    const makePromptStream = receiptPrompt.make;
    // B-SEC-ENV-LEAK: the restore MUST be in a finally welded to the query block.
    // It used to be a plain statement after the try/catch, so when BOTH attempts
    // threw (the retry-without-hooks path rethrows) the exception escaped before
    // the restore and this PROCESS-GLOBAL env var stayed at 300000 for the rest of
    // the process's life — inherited by every later spawn (every provider CLI,
    // every child), silently changing their stream-close behaviour.
    if (permissionExecution) {
      permissionExecution.consume();
      permissionConsumed = true;
    }
    try {
      try {
        queryInstance = query({
          prompt: makePromptStream(),
          options: sdkOptions
        });
      } catch (hookError) {
        if (receiptPrompt.wasConsumed() || reviewedDelegationReady) throw hookError;
        // Older/newer SDK versions may not accept hook shapes yet.
        // Keep notification behavior operational via runtime events even if hook registration fails.
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        delete sdkOptions.hooks;
        // The logical execution permit covers this broker-managed retry. It is
        // intentionally not consumed a second time.
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

    if (permissionExecution) {
      permissionExecution.markStarted();
      permissionStarted = true;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, processRunTag, options.cwd || options.projectPath || null, runToken, () => releaseInput('abort'), () => runAbortController.abort());
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
    //
    // B-515: حمولات الفشل والإذن كانت تتجاوز هذا المسار بـ`ws.send` مباشر «كي لا
    // يُرهَن الفشل بالسجل»، فصارت غير قابلة للاسترجاع أصلاً. صارت اليوم تمرّ على
    // `bufferThenSend` نفسها التي يُبنى عليها هذا المُغلِق: تخزينٌ داخل try/catch
    // ثم إرسالٌ غير مشروط، فالمبرَّر قائم والحمولة قابلة لإعادة البثّ.
    const sendAndBuffer = (payload) => {
      bufferThenSend(ws, capturedSessionId || sessionId || null, payload);
    };

    let wsDiagOrphanLogged = false;
    let wsDiagMessageCount = 0;
    // B-117: set once this run shows work that can resume after a `result`.
    let continuationPossible = false;
    // B-1120: this run's pending CLI tasks and whether the main loop is quiet.
    const backgroundTasks = createBackgroundTaskTracker();
    // Count Workflow tool_use calls so the complete event can signal
    // that background work is still in flight after the assistant turn ends.
    let pendingWorkflows = 0;
    // T-1765: prompt-cache lifetime Anthropic reported for this run's latest
    // main-chain cache write (60 or 5 minutes); null until one is reported.
    let lastCacheTtlMinutes = null;
    let contextModelId = null;
    let lastCacheSnapshot = null;
    for await (const message of queryInstance) {
      // B-117: the CLI is talking, so it is not done — cancel any pending close of
      // the input/control stream. Re-decided further below once this message has
      // been handled (B-1120: after every message, not only a `result`).
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

      // [DELEGATION-CANCELLED] (B-503) — a tool cancelled at ENTRY reads to the model
      // exactly like a human refusal. Nothing in nassaj could tell the two apart, so
      // four investigations re-derived it from scratch and one coordinator halted on a
      // refusal nobody made. Pair the detector with `inputReleasedAt`: if we closed the
      // control channel first, this line carries the whole causal chain by itself.
      const cancelKind = scanDelegationCancellation(message);
      if (cancelKind) {
        const sinceRelease = inputReleasedAt === null ? 'channel-open' : `${Date.now() - inputReleasedAt}ms`;
        console.log(
          `[DELEGATION-CANCELLED] session=${capturedSessionId || sessionId || 'NEW'} `
          + `matchedBy=${cancelKind} sinceControlStreamClose=${sinceRelease} `
          + `permissionMode=${sdkOptions.permissionMode || 'default'} `
          + `messagesSoFar=${wsDiagMessageCount} — NOT a human refusal`
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
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, processRunTag, options.cwd || options.projectPath || null, runToken, () => releaseInput('abort'), () => runAbortController.abort());
        recordParticipant(capturedSessionId);
        // ADR-088: record the engine this spawn ACTUALLY engaged (the resolved
        // verdict, never the client's word) onto the session row. Runs AFTER
        // recordParticipant so the sessions row exists (its absence is reported,
        // not silent). `bornThisSpawn` limits the official-engine stamp to
        // sessions minted this turn — an old NULL row stays UNKNOWN, and a
        // lineage child (resume minted a new id) inherits its parent's pin.
        recordSessionEnginePin({
          newSessionId: capturedSessionId,
          parentSessionId: sessionId || null,
          engagedEngine: injectedHosts !== null ? effectiveEngineProvider : null,
          bornThisSpawn: !sessionId,
        });

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions.
        //
        // `parentSessionId` يقول **لمن** هذا الحدث: معرّف الجلسة التي جرى
        // استئنافها، أو null لمحادثة وُلدت الآن. بدونه كان العميل يفترض أن كل
        // `session_created` يخصّ الجلسة المعروضة أمامه، فإن كان المستخدم قد فتح
        // محادثة أخرى أثناء إقلاع الأولى نسَخ محتوى المعروضة إلى الجديدة وسمّاها
        // باسمها (B-426).
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          sendAndBuffer(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: capturedSessionId,
            sessionId: capturedSessionId,
            parentSessionId: sessionId || null,
            provider: 'claude',
            ...clientMsgIdField,
          }));
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

      // B-1120: count this run's tasks on the RAW message, before any transform or
      // normalisation. A background task — even one that ends during this turn —
      // re-enters the loop with its notification, possibly after the `result`, and
      // so does a known task ending after the main loop went quiet. A background
      // Bash is not caught by the tool_use scan below, yet re-enters the same way.
      const taskState = backgroundTasks.observe(message);
      if (taskState.backgrounded || taskState.continuationExpected) continuationPossible = true;

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;
      if (sid && options.clientMsgId && isTrustedClaudeActivity(message)) {
        try {
          messageCoordinationDb.markStarted({ clientMsgId: options.clientMsgId,
            userId: ws?.userId, provider: 'claude', sessionId: sid });
        } catch {
          // Receipt persistence is independent from transport; absence remains unresolved.
        }
      }

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // A thinking/tool/text delta is model activity.  User echoes and tool
        // results are not: the latter can arrive long after model work began.
        // Shared, unit-tested predicate (turn-timing.service): thinking counts,
        // so `startedAt` lands on the reasoning start, not the first text.
        if (isModelActivity(msg) && !turnStartedAt) turnStartedAt = new Date().toISOString();
        // Only a top-level SDK `assistant` transcript record with a UUID is
        // durable final evidence. A content delta is transport activity, not a
        // history identity, and must never unlock a persisted/live metric.
        if (
          transformedMessage.type === 'assistant'
          && transformedMessage.isSidechain !== true
          && typeof transformedMessage.uuid === 'string'
          && transformedMessage.uuid
          && msg.kind === 'text'
          && msg.role === 'assistant'
          && typeof msg.content === 'string'
          && msg.content.trim()
        ) {
          durableFinalAssistantMessageId = msg.id;
        }
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
        // Live response timing is valid only when the delta carries the exact
        // client turn that spawned this run. This is transient UI correlation;
        // history remains intentionally unmeasured until its transcript format
        // persists an equivalent parent/run relationship.
        Object.assign(msg, clientMsgIdField);
        Object.assign(msg, responseToMessageIdField);
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
      // later result and disarmed by any message in between. B-1120: while tasks
      // are still pending the hold lasts until they report back (idle-capped).
      if (message.type === 'result') {
        if (!message.is_error && message.subtype !== 'error_during_execution') {
          sawSuccessfulResult = true;
        }
        if (taskState.pending > 0) {
          console.log(
            `[CONTROL-STREAM-HOLD] session=${capturedSessionId || sessionId || 'NEW'} `
            + `pending=${taskState.pending}`
          );
        }
      }
      if (message.type === 'system' && message.subtype === 'compact_boundary' && !message.parent_tool_use_id) {
        contextModelId = null;
        lastCacheSnapshot = null;
        sendAndBuffer(createNormalizedMessage({ kind: 'status', text: 'token_budget',
          tokenBudget: { used: null, total: null, cacheSnapshot: null, contextSnapshot: claudeContextSnapshot(null, {
            sessionId: capturedSessionId || sessionId || null, modelId: null,
          }) }, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        if (contextModelId !== (message.message?.model || null)) lastCacheSnapshot = null;
        contextModelId = message.message?.model || null;
      }
      // A single native control request at the result boundary; no model inference or polling.
      if (message.type === 'result' && !message.parent_tool_use_id) {
        // B-1295: use the picker alias (sdkOptions.model) as the snapshot identity
        // so it matches sessionCurrentModel on the client (both come from the same
        // resolveResumeModel source). Fall back to the native contextModelId only
        // when sdkOptions.model is the 'default' sentinel (no resolved model).
        const snapshotModelId = (sdkOptions.model && sdkOptions.model !== CLAUDE_FALLBACK_MODELS.DEFAULT
          ? sdkOptions.model : contextModelId) || null;
        const contextSnapshot = await readClaudeContextSnapshot(queryInstance, {
          sessionId: capturedSessionId || sessionId || null,
          modelId: snapshotModelId,
        });
        sendAndBuffer(createNormalizedMessage({ kind: 'status', text: 'token_budget',
          tokenBudget: { used: contextSnapshot.usageKind === 'native_reported_context' ? contextSnapshot.usedTokens : null,
            total: contextSnapshot.windowTokens, contextSnapshot,
            cacheSnapshot: lastCacheSnapshot?.modelId === contextSnapshot.modelId && lastCacheSnapshot?.sessionId === contextSnapshot.sessionId ? lastCacheSnapshot : null, cacheTtlMinutes: lastCacheTtlMinutes },
          sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      reconsiderInputClose(taskState, continuationPossible);

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
      //
      // The `injectedHosts === null` clause is a FORWARD guard, and deliberately
      // so: today it can never fire on an engine run, because
      // runModelForDiscovery is computed from the already-coerced sdkOptions.model
      // and therefore equals the Claude default (excluded above). But the natural
      // "fix" for that — moving the computation below the restore at
      // `injectedHosts !== null` — would immediately start filing vendor ids like
      // `kimi-k3` into the CLAUDE broken-models store on any transient 404 at
      // Moonshot, hiding a model from a catalog that never served it. The store is
      // Claude's; only the official path may write to it.
      if (
        runModelForDiscovery
        && injectedHosts === null
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
      const tokenBudgetData = extractTokenBudget(message, capturedSessionId || sessionId || null);
      if (tokenBudgetData) {
        lastCacheSnapshot = tokenBudgetData.cacheSnapshot;
        // Subagent requests keep their own cache, so only main-chain writes count.
        if (!message.parent_tool_use_id) {
          lastCacheTtlMinutes = claudeCacheTtlMinutes(message.message?.usage || message.usage) ?? lastCacheTtlMinutes;
        }
        tokenBudgetData.cacheTtlMinutes = lastCacheTtlMinutes;
        sendAndBuffer(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // An explicit abort removes its active entry while interrupting the same
    // iterator.  Do not turn that successful interruption into a `complete`
    // verdict (and, crucially, never attach a completed duration to it).
    const turnAborted = Boolean(queryInstance?.__nassajAborted);

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
    if (turnAborted) {
      permissionOutcome = 'cancelled';
      return { ok: true, aborted: true };
    }
    const completedAt = new Date().toISOString();
    let durableTiming = {};
    if (sawSuccessfulResult) {
      const timing = settleTurnTiming({
        sessionId: capturedSessionId,
        assistantMessageId: durableFinalAssistantMessageId,
        startedAt: turnStartedAt,
        completedAt,
        turnId: responseTurnId,
      });
      if (timing.responseTurnMetric) {
        durableTiming = { ...responseToMessageIdField, ...timing };
      }
    }
    sendAndBuffer(createNormalizedMessage({ kind: 'complete', exitCode: 0, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude', pendingWorkflows, ...clientMsgIdField, ...durableTiming }));
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
    permissionOutcome = 'succeeded';
    return { ok: true };

  } catch (error) {
    permissionOutcome = permissionStarted ? 'failed' : 'spawn_failed';
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
    // mirroring the success path. No-op when SESSION_REGISTRY_claude is off.
    //
    // B-515 — ترتيبٌ مقصود: الخطأ أدناه يُخزَّن **بعد** هذا الإطفاء، وهو مأمون
    // لأن `record` لا يرفع `active` إلا حين يُنشئ مدخلاً جديداً، والمدخل هنا
    // قائم. وإن لم يكن قائماً (فشلٌ سبق `addSession`) فالمدخل الذي يُنشئه
    // الخطأ يلتقطه إسقاطُ المهلة المجدوَل في هذا السطر نفسه، فلا يتسرّب.
    if (capturedSessionId || sessionId) {
      claudeSessionRegistry.setActive(capturedSessionId || sessionId, false);
      scheduleClaudeBufferDrop(capturedSessionId || sessionId);
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // B-1136: a STOP that had to kill the CLI ends the stream with the SDK's abort
    // error. The abort handler already sent the aborted frame, so no error frame
    // or failure notification follows it.
    if (runAbortController?.signal.aborted) {
      return { ok: false };
    }

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

    // B-411: when an ENGINE was actually engaged, ask whether the vendor refused
    // us for quota before falling through to the generic mapper. Without this
    // the reply is `spawn_failed` with the SDK's own wording, which names
    // neither the engine nor the cause — a spent free tier then reads as "the
    // run stopped", the Hermes B-91 shape. Only consulted on the engine path, so
    // the official Anthropic path is untouched.
    const engagedEngine = injectedHosts !== null ? effectiveEngineProvider : null;
    const engineFailure = engagedEngine && !engineRefused
      ? classifyEngineFailure(error, Date.now())
      : null;
    const engineQuotaMessage = engineFailure
      ? engineFailureMessage(engineFailure, engineProviderLabel(engagedEngine))
      : null;

    // Persist an exhaustion so it survives a reload, and so the provider-level
    // block endpoint can report it. Recorded ONLY for a real exhaustion, never
    // for throttling: a per-second limit clears itself in a moment, and a marker
    // for it would present a working engine as a dead one. Best-effort by the
    // repository's contract — a failure to record must not become a second
    // failure on the error path.
    if (engineFailure?.kind === 'quota_exhausted' && (capturedSessionId || sessionId)) {
      providerRunFailuresDb.recordFailure({
        sessionId: capturedSessionId || sessionId,
        provider: engagedEngine,
        reason: engineQuotaMessage || 'Engine quota exhausted',
        exitCode: null,
        quotaResetsAtMs: engineFailure.quotaResetsAtMs,
      });
    }

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
    } else if (engineQuotaMessage) {
      errorCode = engineFailure.kind === 'quota_exhausted' ? 'usage_limit' : 'rate_limited';
      errorContent = engineQuotaMessage;
    } else {
      const mapped = mapSpawnError(error);
      errorCode = mapped.code;
      errorContent = mapped.fallbackMessage;
    }

    // B-33: for a new session (no prior sessionId), include a requestId so the
    // frontend can correlate the error with the originating spawn request.
    const errorSessionId = capturedSessionId || sessionId || null;
    // B-515: الحمولة الطرفية للفشل — مخزَّنة ثم مُرسَلة. هي بعينها ما ضاع في
    // حادثة 2026-08-06 حين مات المقبس والبثّ جارٍ.
    bufferThenSend(ws, errorSessionId, createNormalizedMessage({
      kind: 'error',
      code: errorCode,
      content: errorContent,
      ...clientMsgIdField,
      // B-222: only the deliberate engine refusal carries a `reason`, so no
      // other error's rendering changes. B-411 joins it: an engine quota/throttle
      // verdict is likewise a cause we KNOW, and the frontend renders `reason` as
      // the detail beside the localized headline — without it the sentence naming
      // the engine would be dropped on the floor.
      ...(engineRefused || engineQuotaMessage ? { reason: errorContent } : {}),
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
    if (permissionExecution && permissionConsumed) {
      try {
        permissionExecution.settle(permissionOutcome
          || (permissionStarted ? 'reconciled_unknown' : 'spawn_failed'));
      } catch (permissionError) {
        console.error('[Claude] permission terminal reconciliation required', {
          code: permissionError?.code || permissionError?.message || 'PERMISSION_SETTLE_FAILED',
        });
      }
    } else if (permissionExecution) {
      try {
        permissionExecution.notStarted();
      } catch (permissionError) {
        console.error('[Claude] permission not-started reconciliation required', {
          code: permissionError?.code || permissionError?.message || 'PERMISSION_NOT_STARTED_FAILED',
        });
      }
    }
    // B-117: never let a streaming-input prompt outlive the run. On EVERY exit
    // (normal end, error, abort, early return) drop the pending close timer and
    // release the generator so the SDK ends stdin and the CLI can exit. Without
    // this a thrown/aborted run would park on `inputStreamRelease` forever and
    // leak a live CLI process — which is also what would keep safe-restart's
    // drain waiting.
    disarmInputClose();
    releaseInput('run-ended');
    // T-822 (§ج-4): release the per-conversation chat-turn lock on EVERY exit
    // (success, error, any return in the loop). No-op when the seam left it null
    // (flag off / new session / fail-open) so it is inert on the default path.
    if (chatTurnLock) {
      chatTurnLock.release();
    }
    // B-524: the credential file dies with the run. Reaching here means the
    // message loop is over and stdin has been released, so the CLI is on its way
    // out and has long since read the file. dispose() is idempotent and swallows
    // ENOENT, so a double exit or a sweep that got there first is a no-op.
    if (mcpConfigFile) {
      mcpConfigFile.dispose();
      mcpConfigFile = null;
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
  //
  // B-515: مخزَّنة ثم مُرسَلة، وهي أولى الحمولات بذلك: تحمل نصّ رسالة المستخدم
  // نفسه (`command`) وزرَّ استئنافها، فضياعها يُسقط الرسالة لا الإشعار وحده.
  // الجولة الداخلية جدولت إسقاط مخزن هذا المفتاح قبل أن تعود، فما يُنشئه
  // التخزين هنا — إن لم يكن قائماً — مشمولٌ بذلك الإسقاط.
  bufferThenSend(ws, sessionId, createNormalizedMessage({
    kind: 'error',
    code: 'conversation_not_found',
    content: 'The previous session could not be resumed — it has expired or been removed.',
    staleSessionId: sessionId,
    command,
    sessionId,
    provider: 'claude',
    // T-1295: صدى هوية الجولة — الجولة الداخلية ابتلعت خطأها عمداً
    // (`suppressResumeMissError`) فهذه هي حمولة الحكم الوحيدة التي يراها العميل.
    ...(typeof options.clientMsgId === 'string' && options.clientMsgId
      ? { clientMsgId: options.clientMsgId }
      : {}),
  }));
}

/**
 * B-1136: interrupt() with a deadline. It is a control request, so on a run whose
 * control stream is already closed it never settles. A rejection before the
 * deadline still reaches the caller's catch, as before.
 *
 * @param {{ interrupt: () => Promise<void> }} instance - SDK query handle.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {Promise<boolean>} true when interrupt() answered, false on timeout.
 */
async function interruptWithin(instance, timeoutMs) {
  const answered = instance.interrupt().then(() => true);
  // A rejection arriving after the deadline (the SDK rejects pending control
  // requests when the transport closes) must not surface as an unhandled one.
  answered.catch(() => {});
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
  try {
    return await Promise.race([answered, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Interrupt deadline in ms. As elsewhere in this file, 0 falls back to the default. */
function interruptTimeoutMs() {
  return Number.parseInt(process.env.CLAUDE_SDK_INTERRUPT_TIMEOUT_MS, 10) || 3000;
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

  // B-ABORT-CROSSKILL: the by-connection fallback is for the pre-id race ONLY, so
  // it is unreachable once the client named a session. A named-but-unmatched id
  // means that run already ended (a second STOP press, or a stale id) — and since
  // one browser socket carries every session the tab opened, falling back there
  // aborted an unrelated live run instead, one per press. A resumed run needs no
  // fallback either: addSession registers it under the resume id as well as under
  // the newly captured one, so the client's id still matches directly.
  if (!session && !sessionId && rawWs) {
    const fallbackId = getNewestSessionForSocket(rawWs);
    if (fallbackId) {
      resolvedId = fallbackId;
      session = getSession(resolvedId);
      console.log(
        `[WS-DIAG] sdk-abort fallback: requested=none resolved-by-connection=${resolvedId}`
      );
    }
  }

  if (!session) {
    const reason = sessionId
      ? `no active claude session matched id=${sessionId} (already ended? no cross-session fallback)`
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
    // B-1136: bounded. An unanswered interrupt used to hang this await forever,
    // leaving the run active and every later STOP press a no-op.
    const interrupted = await interruptWithin(session.instance, interruptTimeoutMs());
    if (!interrupted && typeof session.forceStop !== 'function') {
      const reason = `session ${sessionId} did not answer interrupt() and has no force-stop handle`;
      console.error(`[WS-DIAG] sdk-abort failed: ${reason}`);
      return { aborted: false, reason, sessionId };
    }
    session.instance.__nassajAborted = true;
    if (!interrupted) {
      console.log(`[WS-DIAG] sdk-abort fallback reason=interrupt-timeout session=${sessionId} action=kill-cli`);
      session.forceStop();
    }

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

    return { aborted: true, reason: interrupted ? 'interrupted' : 'force-stopped', sessionId };
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
