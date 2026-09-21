/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Codex } from '@openai/codex-sdk';

import { getRuntimeInstructions } from './services/runtime-instructions.js';

import { codexLaunchOptions } from './shared/codex-executable.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { assertHistorySourceAccessible, sessionsService } from './modules/providers/services/sessions.service.js';
import { HISTORY_LIMITS, HistoryBudgetError, historyTransferLedger } from './modules/providers/services/history-budget.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createNormalizedMessage, stampCoordinatorId, attachCodexCompletionProof } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { auditLogDb, participantsDb } from './modules/database/index.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { beginProviderRun } from './services/provider-run-presence.js';
import { PROCESS_TAG_ENV_VAR } from './services/session-process-monitor.js';
import { classifyCodexFailure } from './modules/providers/list/codex/codex-failure.js';
import {
  accumulateCodexCoordinatorUsage,
  extractCodexTokenBudget,
  selectCodexPostTurnUsage,
} from './modules/providers/list/codex/codex-token-budget.js';
import {
  ensureCodexGovernance,
  GOVERNANCE_MISSING_CODE,
  GOVERNANCE_MISSING_MESSAGE,
} from './modules/providers/list/codex/codex-governance.js';
import { materializeCoordinatorAgents } from './services/isolation/codex-coordinator-agents.js';
import { materializePersonaCopy } from './services/isolation/codex-governance-material.js';
import {
  codexHomeForSessionFile,
  resolveCodexHomeForUser,
} from './modules/providers/list/codex/codex-home.js';
import {
  buildCodexBranchInput,
  wrapCodexBranchInput,
} from './modules/providers/list/codex/codex-branch-context.js';
import {
  captureCodexTurnBaseline,
  resolveCompletedCodexTurn,
} from './modules/providers/list/codex/codex-turn-metrics.js';
import { settleTurnTiming } from './modules/providers/services/turn-timing.service.js';
import { markRunVerdictSeen } from './modules/websocket/index.js';
import { captureCodexReceiptWindow, resolveCodexUserProof, codexReceiptPayloadHash } from './modules/providers/list/codex/codex-receipt-proof.js';

// Track active sessions
const activeCodexSessions = new Map();
const activeCodexTurnLocks = new Set();

async function prepareCodexInput(command, images) {
  const imageList = Array.isArray(images) ? images : [];
  if (imageList.length === 0) {
    return { input: command, tempDir: null };
  }

  // Create the scratch dir first, then guard everything after it with a
  // try/finally. A mid-loop failure (e.g. fs.writeFile throwing before the
  // caller captures `tempDir` into `imagesTempDir`) would otherwise orphan the
  // directory, because the caller's deterministic cleanup only fires once it
  // holds the handle. The dir is handed to the caller — and cleanup skipped
  // here — solely on the committed success path.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nassaj-codex-images-'));
  let committed = false;
  try {
    const input = [{ type: 'text', text: command }];
    for (const [index, image] of imageList.entries()) {
      const match = typeof image?.data === 'string'
        ? image.data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/)
        : null;
      if (!match) {
        continue;
      }
      const extension = match[1].split('/')[1].replace(/[^a-zA-Z0-9]/g, '') || 'png';
      const imagePath = path.join(tempDir, `image-${index}.${extension}`);
      await fs.writeFile(imagePath, Buffer.from(match[2], 'base64'), { mode: 0o600 });
      input.push({ type: 'local_image', path: imagePath });
    }

    if (input.length === 1) {
      // No decodable image survived — hand back the plain command; the finally
      // block below removes the now-empty scratch dir.
      return { input: command, tempDir: null };
    }
    committed = true;
    return { input, tempDir };
  } finally {
    if (!committed) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch((error) => {
        console.warn('[Codex] Failed to clean temporary images:', error?.message || error);
      });
    }
  }
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            // Transport-local id (`item_0`, `item_1`, ...). It is NOT the
            // durable rollout `payload.id` (`msg_<hex>`) and never appears in
            // the JSONL, so it can only identify the live row — see
            // codex-turn-metrics.newestCompletedTurnFromJsonl (B-822).
            uuid: typeof item.id === 'string' ? item.id : undefined,
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map a nassaj permission mode to Codex SDK sandbox options.
 *
 * SECURITY CEILING (T-884, committee decision 2026-07-14). Both live spawn paths
 * — REST (/api/agent) and the interactive WS path, which forwards CLIENT-supplied
 * options straight through — funnel through this single parser, so the ceiling is
 * enforced here rather than at any call site. On a shared uid the default MUST NOT
 * be danger-full-access:
 *   - 'bypassPermissions' (the mode both paths historically pinned) is CAPPED to the
 *     same workspace-write ceiling as 'acceptEdits'. A client selecting it over WS
 *     can no longer elevate itself to full disk/network access.
 *   - danger-full-access is reachable ONLY behind the explicit operator deployment
 *     flag CODEX_ALLOW_FULL_ACCESS==='true' (default OFF, read from the SERVER env —
 *     never a per-user or client-controlled value).
 *
 * OPERATOR PARITY OVERRIDE (owner decision 2026-08-10, B-603 — amends ADR-058 and
 * OVERRIDES its qa-critic red line). The measured reality that motivated this: the
 * workspace-write sandbox was never a security boundary between members on this
 * deployment. From inside it a turn already writes `dist-server/` (the live server
 * code) and `.env`, and READS every other member's `.credentials.json` and
 * JWT_SECRET — while being blocked from the one thing nassaj governance REQUIRES of
 * it (writing a row to the command-board queue, B-601). The sandbox withheld the
 * obligation and left the danger, so Codex alone was crippled relative to Claude,
 * which runs with no OS sandbox at all.
 *
 * The owner's instruction is parity by LEVELLING UP: remove Codex's OS wall so it
 * writes the whole machine exactly like Claude does, while KEEPING every textual
 * and structural governance layer intact (the fingerprinted AGENTS.md gate, the
 * always-on coordinator layer, approval policy per mode).
 *
 * So when CODEX_ALLOW_FULL_ACCESS==='true' the flag no longer unlocks ONE mode; it
 * declares the deployment unsandboxed for Codex, and EVERY write-capable mode maps
 * to danger-full-access. Each mode KEEPS its own approvalPolicy, which is what makes
 * this true parity rather than a blanket escalation: 'default' still asks the user
 * ('untrusted') exactly like Claude's default permission prompts, and only the modes
 * that already meant "don't ask me" ('acceptEdits'/'bypassPermissions') run
 * unattended. The OS wall is what is removed — not the consent layer above it.
 *
 * With the flag OFF (the FLEET DEFAULT, and what every other node still gets) the
 * original T-884 ceiling below is untouched, so this is a per-deployment opt-in and
 * `git revert` is not needed to undo it — unset the env var and restart.
 *
 * COORDINATOR ROLE (T-886, redirected 2026-07-15): coordination is NO LONGER a sandbox
 * mode. It is a PERMANENT, always-on textual governance layer applied to EVERY Codex
 * launch across all three modes below — mirroring Claude Code's zero-rule (governance
 * sits ABOVE the modes; it is not a mode you pick). That layer lives at the spawn
 * chokepoint (queryCodexUnlocked), not here. This parser therefore has no coordinator
 * branch: the sandbox always follows the session's actual mode. There is no OS-enforced
 * read-only floor for the root anymore — the delegate-first guarantee is textual (the
 * root contract), exactly like the zero-rule; a structural Codex-root guard is a separate
 * future follow-up.
 *
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @param {object} [env] - environment carrying the escape-hatch flag (defaults to process.env)
 * @returns {{ sandboxMode: string, approvalPolicy: string }}
 */
function mapPermissionModeToCodexOptions(permissionMode, env = process.env, permissionExecution = null) {
  if (permissionExecution?.mode === 'enforce') {
    if (permissionExecution.effectivePolicy?.profileId !== 'full_delegation') {
      throw new Error('PERMISSION_EFFECTIVE_POLICY_REQUIRED');
    }
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
  }
  // The safe autonomous ceiling: writes confined to the workspace, no approval
  // prompts (so headless/REST turns don't stall). Reused for acceptEdits AND the
  // capped bypassPermissions mode — one source of truth, no re-typed literal.
  const workspaceWriteAutonomous = {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  };

  // Owner parity override (B-603): the flag declares the whole deployment unsandboxed
  // for Codex, so the sandbox dimension collapses to danger-full-access for every
  // write-capable mode. approvalPolicy is resolved per-mode BELOW and deliberately
  // preserved — the OS wall goes, the consent layer stays.
  const unsandboxed = env?.CODEX_ALLOW_FULL_ACCESS === 'true';
  const writeCeiling = unsandboxed ? 'danger-full-access' : 'workspace-write';

  switch (permissionMode) {
    case 'acceptEdits':
      return { sandboxMode: writeCeiling, approvalPolicy: 'never' };
    case 'bypassPermissions':
      // Absent the flag (the fleet default) bypassPermissions stays indistinguishable
      // from acceptEdits — capped to workspace-write, the original T-884 ceiling.
      return unsandboxed ? { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } : workspaceWriteAutonomous;
    case 'default':
    default:
      // Was 'untrusted' (ask before each action); see B-CODEX-0153 note below.
      // default mode. Under the parity override the sandbox no longer ALSO refuses
      // what the user just approved.
      // B-CODEX-0153: codex-cli 0.153 dropped 'untrusted' ("no longer supported"); 'on-request'
      // is the closest surviving policy — the model asks before risky actions.
      return { sandboxMode: writeCeiling, approvalPolicy: 'on-request' };
  }
}

/**
 * Resolve whether Codex network access should be enabled for a workspace-write turn.
 *
 * SERVER-FLAG-ONLY (T-895/B-169). Network is OFF by default and can be turned on
 * EXCLUSIVELY by the operator deployment flag CODEX_WORKSPACE_NETWORK==='true'.
 * The per-session CLIENT opt-in (`options.networkAccess` / `options.networkAccessEnabled`)
 * that used to enable it is REMOVED and is now IGNORED entirely: the interactive WS
 * path forwards raw client options into queryCodex, so under a shared uid — where
 * reads across users stay open until read isolation lands (T-893) — a client opt-in
 * let any authenticated user open an outbound channel and exfiltrate another user's
 * auth.json in a single turn. The per-session opt-in can be reintroduced safely once
 * T-893 provides system-level read isolation. Returns `undefined` (not `false`) when
 * off so the caller OMITS the field and the SDK never emits a network_access config
 * line, leaving Codex's own workspace-write default (OFF).
 *
 * @param {object} [_options] - per-run options; network fields are intentionally IGNORED (T-895)
 * @param {object} [env] - environment carrying the deployment flag (defaults to process.env)
 * @returns {true|undefined}
 */
function resolveCodexNetworkAccess(_options = {}, env = process.env) {
  // Client-supplied network opt-in is deliberately NOT consulted (T-895/B-169);
  // the server deployment flag is the ONLY enable path until read isolation (T-893).
  return env?.CODEX_WORKSPACE_NETWORK === 'true' ? true : undefined;
}

/**
 * Board/docs writable root for the workspace-write sandbox.
 *
 * nassaj's MANDATORY board gate writes through `docs/project-state.json`, and the
 * project's decision/plan/architecture artifacts sit beside it — but every one of
 * those paths is a SYMLINK into the shared nassaj-core product tree
 * (`nassaj-core/products/<product>/docs`). Codex's sandbox resolves the REALPATH
 * before checking writability, so under workspace-write (writable roots = cwd +
 * /tmp) the lock file lands outside every root and `board.mjs add` dies with
 * `EROFS: read-only file system` on `.project-state.lock`. Measured 2026-08-03:
 * the coordinator AND all three delegates (architect/backend_dev/devops) stopped
 * at that gate before touching a single file — the board rule made the work
 * unstartable rather than merely unrecorded.
 *
 * Granting the resolved docs directory (and nothing above it) is the minimum that
 * lets a Codex run OBEY the board rule instead of stalling on it. Derived from the
 * session's own working directory rather than hardcoded, so other products under
 * the same symlink convention (SampleOne, SampleTwo) get the same narrow grant. Returns
 * [] when docs/ is absent or already inside cwd (the ordinary repo layout), so no
 * project without the symlink convention widens its sandbox by accident.
 *
 * @param {string} workingDirectory - the session's resolved cwd
 * @returns {string[]} zero or one absolute path to add to sandbox writable roots
 */
function resolveCodexDocsWritableRoots(workingDirectory) {
  if (!workingDirectory) {
    return [];
  }
  try {
    const realCwd = realpathSync(workingDirectory);
    const realDocs = realpathSync(path.join(workingDirectory, 'docs'));
    // Already inside the workspace → cwd covers it, grant nothing.
    if (realDocs === realCwd || realDocs.startsWith(realCwd + path.sep)) {
      return [];
    }
    return [realDocs];
  } catch {
    // No docs/, broken symlink, or unreadable path: stay at the default roots.
    // The board gate will still fail loudly, which is strictly better than
    // widening the sandbox on a path we could not resolve.
    return [];
  }
}

// SDK-accepted ModelReasoningEffort values (codex-sdk/dist/index.d.ts). The
// composer UI (ChatComposer.tsx via providerCapabilities.ts codex.effort.modes)
// only ever offers a subset of these ('none'/low/medium/high/xhigh, no 'minimal'),
// but this validator is the SERVER's own safety net — the one chokepoint both live
// spawn paths (WS + REST /api/agent) funnel through — so a client sending anything
// outside the SDK's real enum can never reach `codex.startThread`/`resumeThread` raw.
const CODEX_REASONING_EFFORT_VALUES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
// Clamp map for UI-only tiers that have no ModelReasoningEffort equivalent
// ('max'/'ultracode' — Claude-only concepts in effortModes.ts) to the nearest
// real Codex tier, in case a stale/hand-crafted client payload ever sends them.
const CODEX_REASONING_EFFORT_CLAMP = { max: 'xhigh', ultracode: 'xhigh' };

/**
 * Resolve `options.reasoningEffort` (T-905/T-884-follow-up) to a value safe to
 * hand the Codex SDK's `modelReasoningEffort`, or `undefined` to omit the field
 * entirely (Codex then falls back to its own config.toml default, "medium").
 * `undefined`/`'none'`/anything unrecognized (and not clampable) all omit the
 * field — the SDK is NEVER handed a raw, unvalidated client string.
 *
 * @param {unknown} reasoningEffort - client-supplied options.reasoningEffort
 * @returns {string|undefined}
 */
function resolveCodexReasoningEffort(reasoningEffort) {
  if (typeof reasoningEffort !== 'string' || !reasoningEffort) {
    return undefined;
  }
  const normalized = reasoningEffort.toLowerCase();
  if (CODEX_REASONING_EFFORT_VALUES.has(normalized)) {
    return normalized;
  }
  return CODEX_REASONING_EFFORT_CLAMP[normalized];
}

// Exported for unit/regression coverage (T-884/T-905). The live code paths call
// these internally; the tests import them to assert the ceiling without a real
// subprocess.
export {
  mapPermissionModeToCodexOptions,
  resolveCodexNetworkAccess,
  resolveCodexReasoningEffort,
  resolveCodexDocsWritableRoots,
};

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export function queryCodex(command, options = {}, ws) {
  let lockKey = null, locked = false;
  try {
    const clientMsgIdField = typeof options.clientMsgId === 'string' && options.clientMsgId
      ? { clientMsgId: options.clientMsgId } : {};
    lockKey = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : null;
    if (lockKey && activeCodexTurnLocks.has(lockKey)) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'error', code: 'session_busy', content: 'This Codex conversation is already processing another message.',
        sessionId: lockKey, provider: 'codex', ...clientMsgIdField,
      }));
      return Promise.resolve();
    }
    if (lockKey) { activeCodexTurnLocks.add(lockKey); locked = true; }
    // A synchronous entry has no suspended formal-argument register retaining command's backing string.
    const running = queryCodexUnlocked(command, options, ws);
    command = undefined;
    return running.catch(error => {
      if (!(error instanceof HistoryBudgetError)) throw error;
      options.permissionExecution?.notStarted();
      sendMessage(ws, createNormalizedMessage({
        kind: 'error', code: error.code, content: error.message, provider: 'codex',
        sessionId: lockKey, ...clientMsgIdField,
        ...(error.code === 'HISTORY_BUSY' ? { retryAfter: 1 } : {}),
      }));
    }).finally(() => { if (lockKey) activeCodexTurnLocks.delete(lockKey); });
  } catch (error) {
    if (locked) activeCodexTurnLocks.delete(lockKey);
    return Promise.reject(error);
  }
}

// Explicit iteration lets existing run cancellation reach the owned teardown boundary.
function nextCodexHistoryEvent(iterator, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(Object.assign(new Error('Codex run aborted'), { name: 'AbortError' })); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return iterator.next(); }).then(
      step => { signal.removeEventListener('abort', abort); resolve(step); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function queryCodexUnlocked(command, options = {}, ws) {
  return queryCodexOwned({ command, options, ws });
}

async function queryCodexOwned(invocation) {
  let command = invocation.command;
  const options = invocation.options, ws = invocation.ws;
  invocation.command = undefined; invocation = undefined;
  // Ownership begins before the first awaited preflight, including branch/model/baseline failures.
  const abortController = new AbortController();
  let transferHandle, branchContext = null, coordinatorTokenBudget = null;
  let codex, thread, preparedInput, streamedTurn, streamIterator;
  let transferEffectEntered = false, iteratorDone = false;
  let receiptWindow = null, reservedNewReceiptSession = null, receiptPayloadHash = null;
  try {
  const clientMsgIdField = typeof options.clientMsgId === 'string' && options.clientMsgId
    ? { clientMsgId: options.clientMsgId }
    : {};
  const responseToMessageIdField = typeof options.clientMsgId === 'string' && options.clientMsgId
    ? { responseToMessageId: options.clientMsgId }
    : {};
  let turnStartedAt = null;
  let turnUsageBoundaryAt = null;
  const permissionExecution = options.permissionExecution;
  let permissionConsumed = false;
  let permissionStarted = false;
  let permissionEffectAttempted = false;
  let permissionCaughtFailure = false;
  if (permissionExecution !== undefined && (
    !permissionExecution
    || typeof permissionExecution.consume !== 'function'
    || typeof permissionExecution.markStarted !== 'function'
    || typeof permissionExecution.settle !== 'function'
    || typeof permissionExecution.notStarted !== 'function'
  )) {
    throw new Error('PERMISSION_EXECUTION_HANDLE_INVALID');
  }
  let sawFinalAssistant = false;
  // B-31: verify the project directory exists before spawning Codex.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      if (ws) {
        ws.send(createNormalizedMessage({
          ...buildCwdMissingPayload(cwdCheck.error, { sessionId: options.sessionId || null, provider: 'codex' }),
          ...clientMsgIdField,
        }));
      }
      permissionExecution?.notStarted();
      return;
    }
  }

  // Fail-closed governance gate (ADR-057 §5, owner decision 2026-07-12): Codex —
  // like any agent engine — must NEVER run outside nassaj governance. BEFORE any
  // thread is spawned, verify (and self-heal once) that the spawner's effective
  // $CODEX_HOME/AGENTS.md resolves to non-empty neutral governance. If it still
  // cannot be established after a single re-provision/relink attempt, REFUSE the
  // launch with a structural error — no Codex process is constructed, no turn runs.
  const governance = ensureCodexGovernance(ws?.userId ?? null);
  if (!governance.ok) {
    console.error('[Codex] launch REFUSED — nassaj governance not established', {
      userId: ws?.userId ?? null,
      codexHome: governance.codexHome,
      agentsPath: governance.agentsPath,
      reason: governance.reason,
    });
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      code: GOVERNANCE_MISSING_CODE,
      content: GOVERNANCE_MISSING_MESSAGE,
      sessionId: options.sessionId || null,
      provider: 'codex',
      ...clientMsgIdField,
    }));
    permissionExecution?.notStarted();
    return;
  }

  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    images,
    permissionMode = 'default',
    reasoningEffort,
  } = options;

  const requesterUserId = Number.isInteger(ws?.userId) ? ws.userId : null;
  if (sessionId) {
    const sourceSession = assertHistorySourceAccessible(sessionId, requesterUserId, 'restamp');
    const sourceHome = sourceSession.jsonl_path
      ? codexHomeForSessionFile(sourceSession.jsonl_path)
      : resolveCodexHomeForUser(requesterUserId);
    const requesterHome = resolveCodexHomeForUser(requesterUserId);
    if (path.resolve(sourceHome) !== path.resolve(requesterHome)) {
      await sessionsService.withHistoryLeaseCallback(sessionId, requesterUserId, {
        limit: null, offset: 0, access: 'restamp',
      }, abortController.signal, (history, lease) => {
        transferHandle = historyTransferLedger.acquire('branch');
        const built = buildCodexBranchInput(sessionId, history.messages, command, lease);
        lease.charge('copyBytes', command.length * 6, HISTORY_LIMITS.jobBytes);
        // Preserve JS code units while severing any slice/rope backing owned by the caller.
        command = Buffer.from(command, 'utf16le').toString('utf16le');
        branchContext = transferHandle.commitBranch(wrapCodexBranchInput(built.input), {
          includedMessages: built.includedMessages, includedBytes: built.includedBytes, omittedMessages: built.omittedMessages,
        });
      });
    }
  }

  const resolvedModel = await providerModelsService.resolveResumeModel(
    'codex',
    sessionId,
    model,
  );

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(
    permissionMode,
    process.env,
    permissionExecution,
  );
  // Network access is only a workspace-write concern (danger-full-access already
  // has the network; read-only has no writes to exfiltrate through). Under
  // workspace-write it stays OFF unless the operator deployment flag is set; the
  // client opt-in was removed (T-895/B-169) so `options` is not consulted here —
  // see resolveCodexNetworkAccess.
  const networkAccessEnabled =
    sandboxMode === 'workspace-write' ? resolveCodexNetworkAccess() : undefined;
  // T-905: the ThinkingModeSelector's chosen effort, validated/clamped against the
  // SDK's real ModelReasoningEffort enum (see resolveCodexReasoningEffort above) —
  // omitted entirely when absent/invalid so Codex falls back to its config.toml
  // default ("medium") rather than ever receiving a raw unvalidated client string.
  const modelReasoningEffort = resolveCodexReasoningEffort(reasoningEffort);
  // B-405: resolved once per launch — see resolveCodexDocsWritableRoots.
  const docsWritableRoots =
    sandboxMode === 'workspace-write' ? resolveCodexDocsWritableRoots(workingDirectory) : [];

  // Coordinator governance layer (T-886, redirected 2026-07-15): nassaj's "delegate,
  // don't execute" rule is a PERMANENT, always-on layer applied to EVERY Codex launch —
  // across all three modes (default/acceptEdits/bypassPermissions) — not an opt-in mode.
  // It mirrors Claude Code's zero-rule: governance sits ABOVE the modes. This is the one
  // spawn chokepoint (queryCodexUnlocked) that BOTH live paths funnel through — REST
  // (/api/agent) and the interactive WS path — so applying it here covers both.
  //
  // FAIL-OPEN (deliberate — the exact opposite of the earlier opt-in's fail-closed):
  // materialize the delegate agents (architect, qa-critic) into $CODEX_HOME/agents/ bound
  // to the session-resolved model. If that fails (missing card, no model, unwritable dir,
  // transient fs error), LOG loudly and STILL launch — a permanent layer that refused on a
  // transient glitch would take down ALL Codex. The root contract below is a constant
  // string that cannot fail, so the delegate-first instruction is ALWAYS injected even
  // when the TOMLs could not be written. The model is passed explicitly (Gate 1B: a
  // delegate REQUIRES a bare Codex model, no `@`). NOTE: T-883 governance (the AGENTS.md
  // fingerprint) stays fail-closed and is entirely separate — untouched here.
  //
  // OWNER-ONLY NOT ENFORCED (T-903 §3, honest scope): this coordinator layer is a
  // capability REDUCTION — "delegate, don't execute" is a subset (⊂) of the session's
  // actual sandbox capability — applied UNIFORMLY to EVERY user's every Codex launch. It
  // is NOT restricted to (nor gated on) the owner in code, and the root sandbox still
  // follows the session's real mode (no OS-enforced read-only floor — see
  // mapPermissionModeToCodexOptions). The delegate-first guarantee is TEXTUAL (the root
  // contract), like Claude's zero-rule. That is an ACCEPTED gap until system-level read
  // isolation lands (T-893): on the shared uid a per-user owner-only privilege can't be
  // meaningfully enforced anyway. Revisit owner-scoping once T-893 gives real isolation.
  const materialized = materializeCoordinatorAgents(governance.codexHome, resolvedModel);
  if (!materialized.ok) {
    console.warn('[Codex] coordinator delegate agents unavailable — launching WITHOUT them (fail-open)', {
      userId: ws?.userId ?? null,
      codexHome: governance.codexHome,
      agentsDir: materialized.agentsDir,
      reason: materialized.reason,
    });
  }

  // Persona reference material (T-909, best-effort, non-blocking): re-check/refresh
  // $CODEX_HOME/.agents/agents.md on every launch too — unlike AGENTS.md governance,
  // whose fingerprint match short-circuits ensureCodexGovernance's repair path above
  // and so never revisits this file, an already-provisioned user's tree would
  // otherwise keep a missing/stale persona copy until their next fresh provision.
  // Failure here only leaves AGENTS.md's `.agents/agents.md` cross-reference
  // unresolved; it never affects governance or delegation and must never block launch.
  materializePersonaCopy(governance.codexHome);

  const isCrossHomeBranch = branchContext !== null;
  let capturedSessionId = isCrossHomeBranch ? null : sessionId;
  let sessionCreatedSent = false;
  let terminalFailure = null;
  let turnAborted = false;
  let participantRecorded = false;
  let imagesTempDir = null;
  let turnBaseline = capturedSessionId
    ? await captureCodexTurnBaseline(capturedSessionId)
    : null;

  // B-395: the "Running" badge / busy dot / active-conversations count all come
  // from the process monitor, and codex-sdk hides the CLI's pid — so tag the
  // child env the way claude-sdk does and let the monitor resolve the pid from
  // /proc. Registration itself waits for a session id (a fresh thread only
  // learns one at `thread.started`), see runPresence.rekey below.
  const processRunTag = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const runPresence = beginProviderRun({
    provider: 'codex',
    writer: ws,
    sessionId,
    projectPath: workingDirectory,
    runTag: processRunTag,
  });

  // Record the authenticated human who spawned this run once a session id is
  // known. Idempotent; skipped for unauthenticated runs (no ws.userId).
  const recordParticipant = (sid) => {
    if (participantRecorded || !sid || !ws?.userId) {
      return;
    }
    participantRecorded = true;
    participantsDb.recordSpawn(sid, ws.userId, {
      provider: 'codex',
      projectPath: workingDirectory,
    });
  };

  try {
    // Seed the persisted budget so the live update can retain the coordinator's
    // separate cumulative total. The gauge itself uses only a persisted native
    // token_count context sample, never SDK turn usage or the cumulative total.
    if (capturedSessionId && requesterUserId !== null) {
      try {
        await sessionsService.withHistoryLeaseCallback(capturedSessionId, requesterUserId, {
          limit: 1, offset: 0,
        }, abortController.signal, (history) => {
          if (history.tokenUsage == null) return;
          const acquired = !transferHandle;
          transferHandle ??= historyTransferLedger.acquire('usage');
          try { coordinatorTokenBudget = transferHandle.commitUsage(history.tokenUsage); }
          catch (error) { if (acquired) { transferHandle.release(); transferHandle = undefined; } throw error; }
        });
      } catch (error) {
        coordinatorTokenBudget = null;
        if (!branchContext) { transferHandle?.release(); transferHandle = undefined; }
        console.warn('[Codex] could not seed cumulative coordinator usage', {
          sessionId: capturedSessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Per-user credential isolation (B-136 / B-ISO-CODEX): build the child env via
    // the central resolver so each authenticated user spawns Codex against their own
    // CODEX_HOME (~/.nassaj-users/<userId>/.codex) instead of inheriting the shared
    // operator ~/.codex — where auth.json is the owner's OpenAI subscription (ToS
    // violation) and sessions/ hold other users' transcripts (resumeThread leak).
    // codex-sdk does NOT inherit process.env once `env` is supplied, so hand it the
    // FULL resolved env (resolveProviderEnv spreads process.env). Anonymous/single-
    // user (null userId) returns the base env unchanged — no non-isolated regression.
    // ADR-134 vertical slice: consume the server-issued, one-use permit at the
    // final SDK seam. A serialized/client-shaped object has no callable handle.
    if (permissionExecution) {
      permissionExecution.consume();
      permissionConsumed = true;
    }
    codex = new Codex({
      // B-395: PROCESS_TAG_ENV_VAR rides along in the child env so the process
      // monitor can match this run to a pid in /proc (codex-sdk exposes none).
      // Appended AFTER the isolation resolver so it can never displace a
      // per-user credential var.
      ...codexLaunchOptions({
        ...resolveProviderEnv(ws?.userId ?? null, 'codex', process.env),
        [PROCESS_TAG_ENV_VAR]: processRunTag,
      }),
      // Governance-bypass block (ADR-057 §5, 2026-07-12 remediation): Codex merges a
      // local AGENTS.md found in the working directory — and any ancestor up to the
      // project/repo root — INTO the model-visible prompt alongside the neutral
      // $CODEX_HOME/AGENTS.md governance, and a more-deeply-nested AGENTS.md takes
      // precedence on conflict, so a project could override nassaj governance.
      // project_doc_max_bytes=0 sets the byte budget for project-level AGENTS.md docs
      // to zero, dropping them entirely while the global governance survives
      // (empirically verified on codex-cli 0.144.1 via `codex debug prompt-input`).
      // Passed as a per-spawn `--config` CLI arg (not written to config.toml), so a
      // danger-full-access turn cannot strip it from the parent-controlled spawn.
      //
      // ADR-134 v1 supersedes the earlier depth-1 delegation allowance: external
      // delegation is denied, so every launch pins depth to zero.
      //
      // T-1315 (الموجة الثانية) — **لم يُرفع عمداً.** كان المطلوب أن يتبع مستوى
      // التنسيق صعوداً (1 → 2) عند `delegate_review`، وهذا بالضبط نقضٌ لضابط أمني
      // قائم لا سدُّ ثغرة: رفعه يسمح للحفيد بالولادة على uid مشترك. تعديل قرارٍ
      // أمني سابق يستوجب إذن مالك مستقلاً بعينه (لم يُمنح)، فبقي 1 غير مشروط،
      // ودرجةُ إنفاذ كودكس أُعلنت **نصّية** في الواصف — لا وعدَ بحدٍّ لا يُفرض.
      //
      // Board gate (B-405): under workspace-write, add the resolved docs realpath to
      // the sandbox writable roots so the MANDATORY `board.mjs` write can actually
      // land — docs/project-state.json symlinks into nassaj-core and the sandbox
      // checks realpaths, so without this every run dies at the board gate with
      // EROFS before doing any work. Empty array under danger-full-access (no
      // sandbox to widen) and for repos whose docs/ is not a symlink.
      config: {
        project_doc_max_bytes: 0,
        // ADR-134 v1 denies MCP and external delegation as surfaces, not merely
        // as UI choices. These parent-controlled overrides replace any entries
        // in the user's config before the CLI starts.
        'features.multi_agent': false,
        mcp_servers: {},
        developer_instructions: getRuntimeInstructions(options?.coordinationLevel),
        ...(sandboxMode === 'workspace-write' && docsWritableRoots.length > 0
          ? { 'sandbox_workspace_write.writable_roots': docsWritableRoots }
          : {}),
      },
    });

    // Thread options with sandbox and approval settings. networkAccessEnabled is
    // included ONLY when the operator flag enabled it (workspace-write); omitting it
    // leaves the SDK from emitting any network_access config, so the default is OFF.
    // Defense in depth (T-895/B-169): pin the built-in web-search channel OFF
    // explicitly — the SDK otherwise leaves it to a default we don't control, and on
    // a shared uid an implicit outbound search tool is another exfiltration path.
    // Both keys of the SDK's ThreadOptions surface are set (webSearchEnabled:false +
    // webSearchMode:'disabled').
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      webSearchEnabled: false,
      webSearchMode: 'disabled',
      ...(networkAccessEnabled === true ? { networkAccessEnabled: true } : {}),
      ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    };

    // Start or resume thread
    if (sessionId && !isCrossHomeBranch) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    const registerSession = (id) => {
      if (!id) {
        return;
      }
      activeCodexSessions.set(id, {
        thread,
        codex,
        status: 'running',
        abortController,
        startedAt: new Date().toISOString()
      });
    };

    // Existing sessions can be tracked immediately; new sessions are tracked after thread.started.
    if (capturedSessionId) {
      registerSession(capturedSessionId);
      recordParticipant(capturedSessionId);
    }

    // Coordinator contract (T-886, D3): ALWAYS injected at the ROOT turn input — never
    // into AGENTS.md (keeps the T-883 fingerprint intact) and never inherited by spawned
    // children (they carry their own leaf contract from their TOML, so the root contract
    // does not leak into their context). This is the permanent "delegate, don't execute"
    // instruction that authorizes the root to spawn specialists; sub-agents receive the
    // coordinator's per-delegation prompt instead. A constant string, so this never fails
    // even when delegate materialization above did (fail-open).
    // T-1283 (supersedes T-886/D3's injection): the contract is no longer prepended
    // here — it reaches the model from $CODEX_HOME/AGENTS.md, whose source is now the
    // COMPOSED coordinator+neutral file (codexGovernanceSource). Three reasons the
    // file beats the injection: it is Codex's own sanctioned channel (its base
    // instructions gate sub-agent spawning on "applicable AGENTS.md instructions"), it
    // is fail-CLOSED rather than fail-open (a fingerprint mismatch refuses the launch,
    // where a prepended constant merely rode along), and it stops the contract from
    // appearing as prose at the head of every single message. Delegates are unaffected:
    // they still carry their own leaf contract from their TOML.
    //
    // T-1315 (الموجة الثانية، قرار المالك 2026-08-17): مستوى تنسيق **هذه الجولة**
    // يُحقن هنا في مُدخَل الجولة — وهو موضعٌ مختلف تماماً عن عقد المنسّق أعلاه:
    // ذاك ثابتٌ دائم مكانه `$CODEX_HOME/AGENTS.md` المبصوم (مادّة لا تُحقن فيها،
    // وأي مسٍّ بها يُفشل بصمة T-1283 fail-closed)، وهذا قرارٌ يتغيّر بين رسالة
    // وأخرى فلا موضع له إلا مُدخَل الجولة. `direct` لا يضيف حرفاً.
    //
    // ADR-134 v1 يفرض منع التفويض الخارجي ميكانيكياً؛ لذلك يبقى
    // `features.multi_agent=false` حتى يدخل التفويض عقداً مستقلاً في إصدار لاحق.
    preparedInput = await prepareCodexInput(branchContext ? branchContext.input : command, images);
    imagesTempDir = preparedInput.tempDir;
    // Identity selection is native; this bounded hash only verifies all submitted/displayed parts.
    receiptPayloadHash = !branchContext && !options.files?.length && !options.attachments?.length
      ? codexReceiptPayloadHash(command, Array.isArray(images) ? images.map(image => image?.data) : []) : null;
    receiptWindow = capturedSessionId ? await captureCodexReceiptWindow(capturedSessionId, 'resume') : null;

    // `runStreamed` is the SDK effect seam. A failure after entering it is
    // ambiguous (the child/turn may already exist), so it must never be
    // rewritten as the stronger `spawn_failed` fact.
    abortController.signal.throwIfAborted();
    permissionEffectAttempted = true;
    transferEffectEntered = Boolean(transferHandle);
    turnUsageBoundaryAt = new Date().toISOString();
    streamedTurn = await thread.runStreamed(preparedInput.input, {
      signal: abortController.signal
    });
    streamIterator = streamedTurn.events[Symbol.asyncIterator]();
    if (permissionExecution) {
      try {
        permissionExecution.markStarted();
        permissionStarted = true;
      } catch (error) {
        abortController.abort();
        throw error;
      }
    }

    while (true) {
      const step = transferHandle ? await nextCodexHistoryEvent(streamIterator, abortController.signal) : await streamIterator.next();
      if (step.done) { iteratorDone = true; break; }
      const event = step.value;
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || event.id || null;
        if (discoveredSessionId && !capturedSessionId) {
          // Reserve the SDK-minted ID before any observer can submit a resumed turn.
          if (activeCodexTurnLocks.has(discoveredSessionId)) throw new Error('CODEX_NEW_THREAD_ID_COLLISION');
          activeCodexTurnLocks.add(discoveredSessionId);
          reservedNewReceiptSession = discoveredSessionId;
          capturedSessionId = discoveredSessionId;
          registerSession(capturedSessionId);
          recordParticipant(capturedSessionId);
          // Capture the physical transcript before consuming any model item.
          // If the synchronizer has not indexed it yet, persistence remains
          // unavailable for this turn; a late baseline would skip evidence.
          turnBaseline = await captureCodexTurnBaseline(capturedSessionId);
          receiptWindow = await captureCodexReceiptWindow(capturedSessionId, 'new');
          if (isCrossHomeBranch && requesterUserId !== null) {
            auditLogDb.record('codex_session_branch', {
              userId: requesterUserId,
              metadata: {
                parentSessionId: sessionId,
                childSessionId: capturedSessionId,
                includedMessages: branchContext.includedMessages,
                includedBytes: branchContext.includedBytes,
                omittedMessages: branchContext.omittedMessages,
              },
            });
          }
          // B-395: move the badge onto the real id (a fresh run registered
          // under none, a resumed run under the resume id).
          runPresence.rekey(capturedSessionId);

          // T-874(2): codex has no per-session model memory of its own, so pin this
          // new session to its creation-time model in nassaj's per-session store —
          // a later model pick in ANOTHER conversation must not make this session
          // resume on the catalog default. Idempotent + best-effort.
          // .catch() guards against an unhandled rejection escaping this
          // fire-and-forget seed and crashing the spawn (B-136 regression).
          void providerModelsService
            .seedSessionModel('codex', capturedSessionId, resolvedModel)
            .catch(() => {});

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if ((!sessionId || isCrossHomeBranch) && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({
              kind: 'session_created',
              newSessionId: capturedSessionId,
              sessionId: capturedSessionId,
              parentSessionId: isCrossHomeBranch ? sessionId : null,
              forked: isCrossHomeBranch,
              provider: 'codex',
              ...clientMsgIdField,
            }));
          }
        }
      }

      // Check if session was aborted
      if (abortController.signal.aborted) {
        turnAborted = true;
        break;
      }
      if (capturedSessionId) {
        const session = activeCodexSessions.get(capturedSessionId);
        if (session?.status === 'aborted') {
          turnAborted = true;
          break;
        }
      }

      // Codex item events are the first provider-attested indication of model
      // work (reasoning/tool activity may precede prose).  Do not use
      // thread.started: it only says the transport created a thread.
      if (
        (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
        && event.item
        && !turnStartedAt
      ) {
        turnStartedAt = new Date().toISOString();
      }
      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      if ((event.type === 'turn.failed' || event.type === 'error') && !terminalFailure) {
        terminalFailure = event.error || event.message || new Error('Turn failed');
        const failure = classifyCodexFailure(
          terminalFailure,
          capturedSessionId || sessionId || null,
          command,
        );
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          provider: 'codex',
          ...clientMsgIdField,
          sessionId: capturedSessionId || sessionId || null,
          ...failure,
        }));
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
        continue;
      }

      if (event.type === 'turn.completed') {
        // B-726: Codex has already attested terminal success here, but its
        // process may disappear before the stream closes and before the single
        // normalized `complete` frame below is emitted. Latch only the verdict
        // (do not persist `done` early) so PID teardown cannot infer a false
        // silent-stop error during that gap.
        markRunVerdictSeen(capturedSessionId || sessionId || null);
        const turnBudget = extractCodexTokenBudget(event, resolvedModel, capturedSessionId || sessionId || null);
        if (turnBudget) {
          coordinatorTokenBudget = accumulateCodexCoordinatorUsage(
            coordinatorTokenBudget,
            turnBudget,
          );
          if (transferHandle) coordinatorTokenBudget = transferHandle.commitUsage(coordinatorTokenBudget);
          sendMessage(ws, createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: coordinatorTokenBudget,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'codex',
          }));
        }
        // The single terminal `complete` is emitted after the stream closes.
        continue;
      }

      const transformed = transformCodexEvent(event);

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = sessionsService.normalizeMessage('codex', transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        if (
          msg.kind === 'text'
          && msg.role === 'assistant'
          && typeof msg.content === 'string'
          && msg.content.trim()
        ) {
          sawFinalAssistant = true;
        }
        // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR): tag assistant
        // output with the JWT-sourced spawner so viewers attribute it correctly.
        stampCoordinatorId(msg, ws?.userId);
        Object.assign(msg, clientMsgIdField, responseToMessageIdField);
        sendMessage(ws, msg);
      }

    }

    // Send completion event
    if (!terminalFailure && !turnAborted) {
      const completedAt = new Date().toISOString();
      const completedSessionId = capturedSessionId || sessionId || null;
      let durableTiming = {};
      const codexUserProof = completedSessionId && !abortController.signal.aborted
        ? await resolveCodexUserProof(completedSessionId, receiptWindow,
          reservedNewReceiptSession === completedSessionId, receiptPayloadHash) : null;
      // The durable ids come from the rollout, never from the live stream: the
      // SDK emits `item_N` while Codex files the answer under `msg_<hex>`, so
      // ownership is proven by the inode/offset-bound append window instead.
      if (turnStartedAt && sawFinalAssistant && completedSessionId) {
        const durableTurn = await resolveCompletedCodexTurn(completedSessionId, turnBaseline);
        if (durableTurn) {
          const timing = settleTurnTiming({
            sessionId: completedSessionId,
            assistantMessageId: durableTurn.assistantMessageId,
            startedAt: turnStartedAt,
            completedAt,
            turnId: durableTurn.turnId,
          });
          if (timing.responseTurnMetric) {
            // يظل رد البث الحيّ تحت `item_N`، لكن الكلفة والتاريخ يستخدمان
            // `msg_<hex>` المتين من rollout. يحمل إطار الإكمال المفتاحين كي
            // تلصق الواجهة المعرف المتين بالرد الحي قبل مطابقة تذييل الكلفة.
            durableTiming = {
              ...responseToMessageIdField,
              transcriptMessageId: durableTurn.assistantMessageId,
              ...timing,
            };
          }
        }
      }
      // The SDK's turn.completed usage is aggregate consumption, not context
      // occupancy. Once the stream has ended and Codex has flushed the rollout,
      // re-read the newest persisted token_count through the authorized history
      // lease. The selector rejects pre-turn, cross-model and cross-session rows.
      if (completedSessionId && requesterUserId !== null && turnStartedAt && turnUsageBoundaryAt) {
        try {
          let refreshed = false;
          await sessionsService.withHistoryLeaseCallback(completedSessionId, requesterUserId, {
            limit: 1, offset: 0,
          }, abortController.signal, (history) => {
            const latest = selectCodexPostTurnUsage(history.tokenUsage, {
              sessionId: completedSessionId,
              modelId: resolvedModel,
              notBefore: turnUsageBoundaryAt,
            });
            if (!latest) return;
            const acquired = !transferHandle;
            transferHandle ??= historyTransferLedger.acquire('usage');
            try {
              coordinatorTokenBudget = transferHandle.commitUsage(latest);
              refreshed = true;
            } catch (error) {
              if (acquired) { transferHandle.release(); transferHandle = undefined; }
              throw error;
            }
          });
          if (refreshed) {
            sendMessage(ws, createNormalizedMessage({
              kind: 'status',
              text: 'token_budget',
              tokenBudget: coordinatorTokenBudget,
              sessionId: completedSessionId,
              provider: 'codex',
            }));
          }
        } catch (error) {
          console.warn('[Codex] post-turn context usage unavailable', {
            sessionId: completedSessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      sendMessage(ws, attachCodexCompletionProof(createNormalizedMessage({
        kind: 'complete',
        actualSessionId: capturedSessionId || thread.id || sessionId || null,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
        ...clientMsgIdField,
        ...durableTiming,
      }), codexUserProof));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        stopReason: 'completed'
      });
    }

  } catch (error) {
    permissionCaughtFailure = true;
    const session = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // B-32: map spawn/runtime errors to structured codes.
      const installed = await providerAuthService.isProviderInstalled('codex');
      // Classify once and reuse: both the mapped code/content below and the
      // conversation_not_found metadata attached to the error message derive
      // from the same classification result.
      const classified = classifyCodexFailure(error, capturedSessionId || sessionId || null, command);
      let errorCode;
      let errorContent;
      if (!installed) {
        errorCode = 'cli_not_installed';
        errorContent = 'Codex CLI is not configured. Please set up authentication first.';
      } else {
        const mapped = mapSpawnError(error);
        errorCode = classified.code === 'codex_turn_failed' ? mapped.code : classified.code;
        errorContent = classified.code === 'codex_turn_failed' ? mapped.fallbackMessage : classified.content;
      }

      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        code: errorCode,
        content: errorContent,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
        ...clientMsgIdField,
        ...(errorCode === 'conversation_not_found'
          ? { staleSessionId: classified.staleSessionId, command: classified.command }
          : {}),
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    if (permissionExecution && permissionConsumed) {
      const permissionOutcome = permissionStarted
        ? (turnAborted ? 'cancelled' : (permissionCaughtFailure || terminalFailure ? 'failed' : 'succeeded'))
        : (permissionEffectAttempted ? 'reconciled_unknown' : 'spawn_failed');
      try {
        permissionExecution.settle(permissionOutcome);
      } catch (permissionError) {
        // Process truth wins; the durable unfinished decision is reconciled on
        // the next readiness pass rather than rewriting the provider outcome.
        console.error('[Codex] permission terminal reconciliation required', {
          code: permissionError?.code || permissionError?.message || 'PERMISSION_SETTLE_FAILED',
        });
      }
    }
    // B-395: clear the badge on EVERY exit path (success, turn.failed, thrown
    // spawn error, abort) — this finally is the only one all of them share.
    runPresence.end();
    if (imagesTempDir) {
      await fs.rm(imagesTempDir, { recursive: true, force: true }).catch((error) => {
        console.warn('[Codex] Failed to clean temporary images:', error?.message || error);
      });
    }
    // Update session status
    if (capturedSessionId) {
      activeCodexSessions.delete(capturedSessionId);
    }
  }
  } finally {
    // Async generator completion/return owns SDK input until teardown actually settles.
    let teardownConfirmed = !transferEffectEntered || iteratorDone;
    if (!iteratorDone && streamIterator && typeof streamIterator.return === 'function') {
      let cleanupTimer;
      try {
        // A timed-out return remains alive and charged; this timeout never grants release.
        teardownConfirmed = await Promise.race([
          Promise.resolve(streamIterator.return()).then(result => result.done === true),
          ...(transferHandle ? [new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), HISTORY_LIMITS.executionMs); })] : []),
        ]);
      } catch { teardownConfirmed = false; }
      finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
    }
    if (!teardownConfirmed) transferHandle?.markStuck();
    branchContext = null; coordinatorTokenBudget = null; preparedInput = undefined; command = undefined;
    streamedTurn = undefined; streamIterator = undefined; thread = undefined; codex = undefined;
    transferHandle?.release(); transferHandle = undefined;
    if (reservedNewReceiptSession) activeCodexTurnLocks.delete(reservedNewReceiptSession);
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
