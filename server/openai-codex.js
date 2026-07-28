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

import { Codex } from '@openai/codex-sdk';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createNormalizedMessage, stampCoordinatorId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { participantsDb } from './modules/database/index.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { classifyCodexFailure } from './modules/providers/list/codex/codex-failure.js';
import { extractCodexTokenBudget } from './modules/providers/list/codex/codex-token-budget.js';
import {
  ensureCodexGovernance,
  GOVERNANCE_MISSING_CODE,
  GOVERNANCE_MISSING_MESSAGE,
} from './modules/providers/list/codex/codex-governance.js';
import {
  materializeCoordinatorAgents,
  COORDINATOR_ROOT_CONTRACT,
} from './services/isolation/codex-coordinator-agents.js';
import { materializePersonaCopy } from './services/isolation/codex-governance-material.js';

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
function mapPermissionModeToCodexOptions(permissionMode, env = process.env) {
  // The safe autonomous ceiling: writes confined to the workspace, no approval
  // prompts (so headless/REST turns don't stall). Reused for acceptEdits AND the
  // capped bypassPermissions mode — one source of truth, no re-typed literal.
  const workspaceWriteAutonomous = {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  };

  switch (permissionMode) {
    case 'acceptEdits':
      return workspaceWriteAutonomous;
    case 'bypassPermissions':
      // Escape hatch: full access ONLY when the operator has explicitly opted the
      // whole deployment in. Absent the flag (the fleet default), bypassPermissions
      // is indistinguishable from acceptEdits — capped to workspace-write.
      if (env?.CODEX_ALLOW_FULL_ACCESS === 'true') {
        return {
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
        };
      }
      return workspaceWriteAutonomous;
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted',
      };
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
export { mapPermissionModeToCodexOptions, resolveCodexNetworkAccess, resolveCodexReasoningEffort };

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const lockKey = typeof options.sessionId === 'string' && options.sessionId
    ? options.sessionId
    : null;
  if (lockKey && activeCodexTurnLocks.has(lockKey)) {
    sendMessage(ws, createNormalizedMessage({
      kind: 'error',
      code: 'session_busy',
      content: 'This Codex conversation is already processing another message.',
      sessionId: lockKey,
      provider: 'codex',
    }));
    return;
  }
  if (lockKey) {
    activeCodexTurnLocks.add(lockKey);
  }

  try {
    await queryCodexUnlocked(command, options, ws);
  } finally {
    if (lockKey) {
      activeCodexTurnLocks.delete(lockKey);
    }
  }
}

async function queryCodexUnlocked(command, options = {}, ws) {
  // B-31: verify the project directory exists before spawning Codex.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      if (ws) {
        ws.send(createNormalizedMessage(
          buildCwdMissingPayload(cwdCheck.error, { sessionId: options.sessionId || null, provider: 'codex' })
        ));
      }
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
    }));
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

  const resolvedModel = await providerModelsService.resolveResumeModel(
    'codex',
    sessionId,
    model,
  );

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
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

  let codex;
  let thread;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let terminalFailure = null;
  let participantRecorded = false;
  let imagesTempDir = null;
  const abortController = new AbortController();

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
    // Per-user credential isolation (B-136 / B-ISO-CODEX): build the child env via
    // the central resolver so each authenticated user spawns Codex against their own
    // CODEX_HOME (~/.nassaj-users/<userId>/.codex) instead of inheriting the shared
    // operator ~/.codex — where auth.json is the owner's OpenAI subscription (ToS
    // violation) and sessions/ hold other users' transcripts (resumeThread leak).
    // codex-sdk does NOT inherit process.env once `env` is supplied, so hand it the
    // FULL resolved env (resolveProviderEnv spreads process.env). Anonymous/single-
    // user (null userId) returns the base env unchanged — no non-isolated regression.
    codex = new Codex({
      env: resolveProviderEnv(ws?.userId ?? null, 'codex', process.env),
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
      // Gate 2 (T-886): cap agent recursion at depth 1 on EVERY launch so a delegate
      // cannot spawn a grandchild (defense-in-depth against delegation loops). Part of
      // the always-on coordinator layer now, so it is unconditional.
      config: {
        project_doc_max_bytes: 0,
        'agents.max_depth': 1,
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
    if (sessionId) {
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
    const effectiveCommand = `${COORDINATOR_ROOT_CONTRACT}\n\n${command}`;
    const preparedInput = await prepareCodexInput(effectiveCommand, images);
    imagesTempDir = preparedInput.tempDir;

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(preparedInput.input, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || event.id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession(capturedSessionId);
          recordParticipant(capturedSessionId);

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

          if (!sessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      // Check if session was aborted
      if (abortController.signal.aborted) {
        break;
      }
      if (capturedSessionId) {
        const session = activeCodexSessions.get(capturedSessionId);
        if (session?.status === 'aborted') {
          break;
        }
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
        const tokenBudget = extractCodexTokenBudget(event, resolvedModel);
        if (tokenBudget) {
          sendMessage(ws, createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
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
        // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR): tag assistant
        // output with the JWT-sourced spawner so viewers attribute it correctly.
        stampCoordinatorId(msg, ws?.userId);
        sendMessage(ws, msg);
      }

    }

    // Send completion event
    if (!terminalFailure) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'complete',
        actualSessionId: capturedSessionId || thread.id || sessionId || null,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex'
      }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        stopReason: 'completed'
      });
    }

  } catch (error) {
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
