/**
 * spawn-admission (T-1749 / ADR-159 item 4 — qa-critic gate) — the guard every
 * provider spawn site consults so a NEW spawn that races a harness update gets a
 * clear, retryable refusal instead of running against a binary being replaced
 * mid-swap (the pin-mismatch outage D2 guards against).
 *
 * WHY A SEPARATE, DEPENDENCY-LIGHT MODULE. `update.service.ts` already exposes
 * `isHarnessSpawnBlocked`, but it reaches it through `descriptors.ts`, which
 * imports the provider CLI resolvers (`resolveCursorBinaryPath` etc.) — so a CLI
 * spawn file importing the service would form an import cycle CLI → service →
 * descriptors → CLI. This module depends ONLY on the lease (`lease.ts`, which
 * imports nothing) plus a frozen run-provider→harness map, so any spawn file can
 * import it without a cycle. The map is parity-tested against the descriptor
 * `runProviders` (spawn-admission.test.ts) so the two never drift.
 *
 * A spawn is refused when an update job holds the single-flight lease for the
 * harness that owns that run-provider id. glm rides the opencode harness, so a
 * glm-via-opencode spawn is blocked while opencode updates; the pure-HTTP hosted
 * vendors (deepseek, and the glm/kimi chat runtimes) have no updatable binary and
 * are never blocked.
 */

/**
 * SPAWN-SITE AUDIT (T-1749 item 1, 2026-09-11). Enumerated from
 * `scripts/permission-launch-inventory.mjs` (131 launch sites) plus a manual
 * sweep of the resume/runner/supervisor/probe paths. site → guard:
 *
 * A. Chat entry points — `refuseSpawnIfHarnessUpdating` (writer frame):
 *    claude-sdk.js queryClaudeSDK → claude · openai-codex.js queryCodex → codex
 *    cursor-cli.js → cursor · qwen-cli.js → qwen · hermes-cli.js → hermes
 *    kimi-agent-cli.js → kimi · opencode-cli.js → opencode · agy-cli.js → antigravity
 *
 * B. Writer-less spawns — `assertHarnessNotUpdating` / `isSpawnBlockedForRunProvider`:
 *    claude-sdk.js probeClaudeBuiltInCommands → claude
 *    claude-sdk.js spawnClaudeSideQuery (/btw fork) → claude
 *    list/claude/claude-catalog.client.ts (SDK catalog probe) → claude
 *    services/isolation/managed-claude-launcher.ts (managed terminal) → claude
 *    workflow-supervisor/systemd.ts launchScope (wf unit → task-runner → claude -p) → claude
 *    workflow-supervisor/resume-turn-runner.ts (claude -p --resume) → claude
 *    services/codex-app-server.js ×3 (rpc, side query, compaction) → codex
 *    list/codex/codex-credentials.writer.ts (`codex login`) → codex
 *    turn-supervisor/adapters/claude-sdk-adapter.ts (probe+invoke) → claude
 *    turn-supervisor/adapters/codex-cli-adapter.ts (probe+invoke) → codex
 *    turn-supervisor/adapters/extended-cli-adapter.ts (probe+invoke) → qwen|opencode|hermes
 *    list/cursor/cursor-models.provider.ts (`cursor-agent --list-models`) → cursor
 *    list/opencode/opencode-models.provider.ts (`opencode models`) → opencode
 *    list/antigravity/antigravity-models-cli.client.ts (`agy models`) → antigravity
 *    turn-supervisor/cli-capability.ts (`--version`/`--help`) → qwen|hermes
 *    websocket/shell-websocket.service.ts (provider PTY lifecycle) → selected harness
 *
 * C. Covered transitively (reach a guarded function, no own guard):
 *    websocket/chat-websocket.service.ts dispatch, routes/agent.js REST dispatch,
 *    routes/git.js commit-message dispatch, routes/commands.js,
 *    services/isolation/provider-cage-wiring.js (helper of the guarded callers),
 *    turn-supervisor/adapters/registry.ts + orchestrator.ts (go through the adapters),
 *    workflow-supervisor/task-runner.ts (runs inside the unit launchScope gates),
 *    hosted-vendor-adapter.ts + shared/vendor/vendor-runtime.js (HTTP only, no binary).
 *
 * D. Deliberately NOT guarded:
 *    git / shell / systemd / source-updater / MCP-server spawns (routes/agent.js,
 *      routes/git.js, routes/system.js, cli.js, project-clone, gitConfig,
 *      writer-lock, supervisor-lock, session-workspace-overlay, mcp-servers/*) —
 *      not provider harnesses.
 */

import { createNormalizedMessage } from '../../../shared/utils.js';
// eslint-disable-next-line boundaries/dependencies -- synchronous admission must read the durable recovery marker without importing the database barrel graph.
import { appConfigDb } from '../../database/repositories/app-config.js';

import { isHarnessLeased } from './lease.js';

const RECOVERY_BLOCK_PREFIX = 'harness_update_recovery_failed:';

/** A failed rollback is a persistent launch block until an operator repairs it. */
export function isHarnessRecoveryBlocked(harnessId, readConfig = appConfigDb.getStrict) {
  try {
    return readConfig(`${RECOVERY_BLOCK_PREFIX}${harnessId}`) === '1';
  } catch {
    // The permissive app-config read intentionally hides early-startup errors;
    // admission cannot. An unreadable durable recovery fence must fail closed.
    return true;
  }
}

/** Persists a fail-closed recovery marker across server restarts. */
export function markHarnessRecoveryBlocked(harnessId) {
  appConfigDb.set(`${RECOVERY_BLOCK_PREFIX}${harnessId}`, '1');
}

/** Test/repair seam; callers must only clear after independently verifying bytes. */
export function clearHarnessRecoveryBlocked(harnessId) {
  appConfigDb.set(`${RECOVERY_BLOCK_PREFIX}${harnessId}`, '');
}

/**
 * Run-registry provider id → the canonical harness id whose lease governs it.
 * Frozen; MUST mirror the descriptor `runProviders` (asserted in the test).
 * @type {Readonly<Record<string,string>>}
 */
export const RUN_PROVIDER_TO_HARNESS = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  agy: 'antigravity',
  cursor: 'cursor',
  opencode: 'opencode',
  glm: 'opencode',
  qwen: 'qwen',
  kimi: 'kimi',
  hermes: 'hermes',
  deepseek: 'deepseek',
});

/**
 * True when a spawn of `runProviderId` must be refused because its harness is
 * mid-update. Unknown run ids (no updatable harness) are never blocked.
 * @param {string} runProviderId
 * @returns {boolean}
 */
export function isSpawnBlockedForRunProvider(runProviderId) {
  const harnessId = RUN_PROVIDER_TO_HARNESS[runProviderId];
  return harnessId ? isHarnessLeased(harnessId) || isHarnessRecoveryBlocked(harnessId) : false;
}

/** User-facing (generic, retryable) refusal message. */
export function harnessUpdatingMessage(runProviderId) {
  return `The ${runProviderId} runtime is being updated right now. Please try again in a moment.`;
}

/**
 * The one call every spawn entry point makes. When the harness is mid-update it
 * sends a terminal, retryable "complete" frame through `writer` (if provided)
 * and returns true so the caller can `return` without spawning. Returns false
 * (and does nothing) when the spawn is allowed.
 *
 * @param {string} runProviderId run-registry provider id of the spawn
 * @param {{ send?: (m: unknown) => void } | null | undefined} writer
 * @param {{ sessionId?: string|null, clientMsgId?: string|null }} [options]
 * @returns {boolean} true when the spawn was refused
 */
export function refuseSpawnIfHarnessUpdating(runProviderId, writer, options = {}) {
  if (!isSpawnBlockedForRunProvider(runProviderId)) {
    return false;
  }
  if (writer && typeof writer.send === 'function') {
    const clientMsgIdField = typeof options.clientMsgId === 'string' && options.clientMsgId
      ? { clientMsgId: options.clientMsgId }
      : {};
    writer.send(createNormalizedMessage({
      kind: 'complete',
      provider: runProviderId,
      sessionId: options.sessionId ?? null,
      exitCode: 1,
      success: false,
      code: 'harness_updating',
      retryable: true,
      error: harnessUpdatingMessage(runProviderId),
      ...clientMsgIdField,
    }));
  }
  return true;
}

/**
 * UNREGISTERED-LAUNCH REGISTRY (T-1749 item 6 — qa-critic finding).
 *
 * The no-live-session gate reads `session-process-monitor.hasActiveRunForProviders`,
 * which only knows about runs that registered for the presence badge. Four launch
 * paths spawn a REAL harness binary without registering there — the managed
 * terminal (`isolation/managed-claude-launcher.ts`), the workflow resume-turn
 * runner, the codex app-server RPC/side-query/compaction children, and the
 * workflow systemd unit — so the gate was blind to them and an update could swap
 * bytes under a live child. These sites now bracket their child with
 * `beginHarnessLaunch()`, and the update service consults `hasLiveHarnessLaunch`
 * in addition to the presence registry. (The systemd unit outlives this process,
 * so it is covered by its own `systemctl` probe in the update service, not here.)
 *
 * A plain counter per RUN-PROVIDER id: no pids, no session ids, nothing to leak.
 * The release handle is idempotent, so the belt-and-braces `close`+`error`+
 * `finally` calls every spawn site already makes are safe.
 *
 * @type {Map<string, number>}
 */
const liveLaunches = new Map();

/**
 * Marks one live, unregistered launch of `runProviderId`. Returns the release
 * handle; call it exactly once per outcome path (idempotent).
 * @param {string} runProviderId
 * @returns {() => void}
 */
export function beginHarnessLaunch(runProviderId) {
  // This check and the reservation below are deliberately synchronous. The
  // updater takes the lease synchronously before it inspects liveLaunches, so
  // JavaScript cannot interleave a lease acquisition between these two steps.
  // Callers may use the earlier writer-friendly guard for UX, but this is the
  // authoritative admission seam immediately before child creation.
  assertHarnessNotUpdating(runProviderId);
  liveLaunches.set(runProviderId, (liveLaunches.get(runProviderId) ?? 0) + 1);
  let released = false;
  return function releaseHarnessLaunch() {
    if (released) return;
    released = true;
    const next = (liveLaunches.get(runProviderId) ?? 1) - 1;
    if (next > 0) liveLaunches.set(runProviderId, next);
    else liveLaunches.delete(runProviderId);
  };
}

/**
 * True when at least one unregistered launch of any of `runProviderIds` is live.
 * @param {Iterable<string>} runProviderIds
 * @returns {boolean}
 */
export function hasLiveHarnessLaunch(runProviderIds) {
  for (const id of runProviderIds) {
    if ((liveLaunches.get(id) ?? 0) > 0) return true;
  }
  return false;
}

/** Test hook: drop every tracked launch. Never used on the request path. */
export function _resetHarnessLaunches() {
  liveLaunches.clear();
}

/**
 * Throwing form of the guard for spawn sites that have NO websocket writer
 * (probes, supervisor adapters, managed terminal launcher, headless runners).
 * Callers surface the thrown error through their own error channel; the error
 * carries the same `harness_updating` code and `retryable` flag as the frame
 * `refuseSpawnIfHarnessUpdating` sends.
 *
 * @param {string} runProviderId
 * @returns {void}
 * @throws {Error & { code: string, retryable: boolean }} when mid-update
 */
export function assertHarnessNotUpdating(runProviderId) {
  if (!isSpawnBlockedForRunProvider(runProviderId)) {
    return;
  }
  const error = new Error(harnessUpdatingMessage(runProviderId));
  error.code = 'harness_updating';
  error.retryable = true;
  throw error;
}
