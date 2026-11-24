// Antigravity (agy) CLI adapter.
// Follows the shared CLI lifecycle contract so the chat WebSocket layer can
// dispatch antigravity-command like the other CLI providers, but:
//   * the binary is `agy` and accepts the prompt as a positional argument (-p)
//   * conversations are addressed by a `brain` UUID stored under
//     ~/.gemini/antigravity-cli/brain/<UUID>/ rather than a CLI-reported session id
//   * output is plain text streamed on stdout; no JSON envelope to parse.
//
// Brain UUID discovery is filesystem-based: we snapshot existing UUID folders
// before spawn and pick the newly-created one after the process exits. This
// avoids depending on agy emitting any structured "session created" event.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import { withRuntimeInstructions as withCoordinationDirective } from './services/runtime-instructions.js';

import { finalAgyTranscriptMessage } from './modules/providers/list/antigravity/agy-transcript-identity.js';
import { getAgyBrainDir } from './modules/providers/list/antigravity/agy-brain-dir.js';
import {
    agyChecklistPlan,
    buildAgyTurnProgressRows,
    readAgyTaskFile,
    summarizeAgyTranscript,
} from './modules/providers/list/antigravity/agy-progress.js';
import { AGY_SPAWN_KEY_PATTERN } from './modules/providers/list/antigravity/agy-session-ids.js';
import sessionManager from './sessionManager.js';
import { messageAuthorsDb, participantsDb, providerRunFailuresDb, sessionsDb } from './modules/database/index.js';
import { classifyAgyFailure, isQuotaFailure, parseQuotaResetMs } from './modules/providers/list/antigravity/agy-failure-reason.js';
import {
    clearAntigravityProjectPath,
    registerAntigravityProjectPath,
} from './modules/providers/list/antigravity/antigravity-project-registry.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { beginProviderRun } from './services/provider-run-presence.js';
import { beginHarnessLaunch, refuseSpawnIfHarnessUpdating } from './modules/providers/harness-update/spawn-admission.js';
import { createTurnTimer, settleTurnTiming } from './modules/providers/services/turn-timing.service.js';
import { createNormalizedMessage } from './shared/utils.js';
import { resolveHarnessBinary } from './shared/harness-binaries.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { assertModelRunActor } from './services/isolation/credential-actor.js';
import { resolveCagedLaunch } from './services/isolation/provider-cage-wiring.js';
import { SessionRegistry } from './session-registry.js';
import {
    abortAgyAcpTurn,
    admitAgyAcpTurn,
    driveAgyAcpTurn,
    agyAcpPool,
    isAgyAcpEnabled,
    killPooledAgyForConversation,
    prepareAgyAcpLaunch,
} from './modules/providers/list/antigravity/agy-acp-runner.js';


// Per-session replay registry for agy (ADR-021 / PHASE-SR-0). Gated behind
// SESSION_REGISTRY_agy: when the flag is off every call is a no-op and the
// legacy stream path is byte-for-byte unchanged. Exported so the websocket
// layer (check-session-status / attach) reads the SAME instance — there is one
// source of truth for both the replay buffer and the active flag.
const agySessionRegistry = new SessionRegistry('SESSION_REGISTRY_agy');

// B-N-DROP: how long a session's replay buffer is retained AFTER the run reaches
// a terminal state (close/error) before it is dropped. This is the post-close
// replay window: a socket that reconnects within this grace period can still
// receive the final payloads via differential attach. After it elapses the entry
// is dropped so the registry never grows unbounded across uptime. The timer is
// cancelled if the same key is reopened/reused before it fires.
const BUFFER_RETENTION_MS = 120000;

// Pending post-close drop timers keyed by registryKey, so a reopen/reuse of the
// key (resume, attach-driven touch) can cancel the scheduled drop and keep the
// buffer alive for the new run.
const pendingDropTimers = new Map();

// Cancel any scheduled post-close drop for `key`. Called whenever the key is
// reopened or reused before its retention window elapses.
function cancelPendingDrop(key) {
    if (!key) return;
    const timer = pendingDropTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        pendingDropTimers.delete(key);
    }
}

// B-N-DROP: schedule a deferred drop of `key` after BUFFER_RETENTION_MS. Replaces
// any previously scheduled drop for the same key. `.unref()` so a pending drop
// never holds the event loop open at shutdown.
function scheduleBufferDrop(key) {
    if (!key) return;
    cancelPendingDrop(key);
    const timer = setTimeout(() => {
        pendingDropTimers.delete(key);
        agySessionRegistry.drop(key);
    }, BUFFER_RETENTION_MS);
    timer.unref?.();
    pendingDropTimers.set(key, timer);
}

// Stable per-connection id minted lazily on the raw socket. Used as the
// temporary registry key while a fresh run has no sessionId yet (B-N5). We key
// off the underlying ws of the WebSocketWriter so the id survives writer reuse.
let connectionIdCounter = 0;
function connectionIdFor(ws) {
    if (!ws) return null;
    const raw = ws.ws ?? ws; // WebSocketWriter wraps the raw socket on `.ws`
    if (!raw.__agyConnectionId) {
        connectionIdCounter += 1;
        raw.__agyConnectionId = `agy-conn-${connectionIdCounter}`;
    }
    return raw.__agyConnectionId;
}

// Brain store location for this run's user (see agy-brain-dir.js).
const getBrainDir = getAgyBrainDir;

// Project-level instructions filename, mirrored at both the project root and the
// global config dir (~/.claude). agy has no native equivalent of CLAUDE.md, so we
// inject these instructions ourselves on the first message of a fresh conversation.
const INSTRUCTIONS_FILENAME = 'NASSAJ.md';

// Read a UTF-8 file, returning trimmed content or null on any failure (missing
// file, permission error, etc.). Silent by design: instruction files are
// optional and their absence must never block a run.
async function readInstructionFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const trimmed = content.trim();
        return trimmed ? trimmed : null;
    } catch {
        return null;
    }
}

// Optional response-language rule injected at the start of every new conversation.
//
// CONFIGURATION, NOT A SHIPPED CONSTANT: agy defaults to answering in English and
// ignores the UI locale, so an operator who works in another language needs this
// pinned. But WHICH language is the operator's preference — hardcoding one forces
// it on every install. Set NASSAJ_RESPONSE_LANGUAGE (e.g. "formal Arabic (العربية
// الفصحى)") to enable it; unset (the default) injects no language rule at all.
const RESPONSE_LANGUAGE = (process.env.NASSAJ_RESPONSE_LANGUAGE || '').trim();
const BASE_INSTRUCTIONS = RESPONSE_LANGUAGE
    ? `IMPORTANT: Always respond exclusively in ${RESPONSE_LANGUAGE}. Never switch to another language under any circumstances, even for technical terms — transliterate or translate them instead.`
    : null;

// Build the instructions prefix injected ahead of the user's first message in a
// new conversation. Merges: the language rule (only when configured) +
// project-specific file (<projectPath>/NASSAJ.md or CLAUDE.md, if present).
// Returns '' when neither exists — the call site skips injection on a falsy value.
// The operator-home ~/.claude/NASSAJ.md is NOT injected: it is operator governance
// and would mislead agy when it works inside an unrelated project.
async function buildInstructionsPrefix(projectPath) {
    const parts = BASE_INSTRUCTIONS ? [BASE_INSTRUCTIONS] : [];

    if (projectPath) {
        const projectInstructions =
            (await readInstructionFile(path.join(projectPath, INSTRUCTIONS_FILENAME))) ||
            (await readInstructionFile(path.join(projectPath, 'CLAUDE.md')));
        if (projectInstructions) parts.push(projectInstructions);
    }

    if (parts.length === 0) return '';
    return `<instructions>\n${parts.join('\n\n')}\n</instructions>`;
}

// Map agy CLI exit codes to actionable messages so the chat surface stays
// consistent across providers.
function getAgyExitMessage(code) {
    const messages = {
        1: 'agy CLI general error. Check if agy is installed: ~/.local/bin/agy --version',
        2: 'agy CLI authentication error. Run: agy -p "hello" to re-authenticate',
        126: 'agy CLI permission denied. Check file permissions: chmod +x ~/.local/bin/agy',
        127: 'agy CLI not found. Install from: https://developers.google.com/gemini/antigravity',
        130: 'agy CLI was interrupted (SIGINT)',
        143: 'agy CLI was terminated (SIGTERM)',
    };
    return messages[code] || `agy exited with code ${code}`;
}

// Track active sessions keyed by nassaj-side sessionId.
// Value: { process, brainUUID } — brainUUID is the agy conversation id, populated
// either from the resumed session or discovered on close for new sessions.
const activeSessions = new Map();

async function listBrainIds(userId = null) {
    try {
        const entries = await fs.readdir(getBrainDir(userId));
        return new Set(entries);
    } catch {
        // The brain dir may not exist yet on a fresh install; treat as empty set.
        return new Set();
    }
}

// True when the agy brain folder backing a resume still exists on disk. A
// missing folder is the agy equivalent of Claude's "No conversation found":
// the conversation we were asked to resume is gone. Detecting it on the
// filesystem before spawn is more reliable than parsing agy's plain-text output.
async function brainExists(brainUUID, userId = null) {
    try {
        const stats = await fs.stat(path.join(getBrainDir(userId), brainUUID));
        return stats.isDirectory();
    } catch {
        return false;
    }
}

// B-ISO-AGYLOCK: narrow in-process mutex over the brain-UUID discovery window.
//
// agy reports no session id; we identify a fresh brain by diffing the BRAIN_DIR
// snapshot taken before spawn against the dir after the brain folder appears. If
// two fresh spawns interleave their snapshots, both could diff the same newly
// created folder and bind the wrong conversation. We serialize ONLY the window
// from "snapshot prior ids" to "new UUID assigned" — a few hundred ms — so it
// never blocks conversation reads or other providers' spawns. Implemented as a
// promise chain (no async-mutex dependency): each acquirer awaits the previous
// release before snapshotting.
let agyDiscoveryChain = Promise.resolve();

function acquireDiscoveryLock() {
    let release;
    const ready = agyDiscoveryChain;
    agyDiscoveryChain = new Promise((resolve) => {
        release = resolve;
    });
    return ready.then(() => release);
}

function generateNassajSessionId() {
    // Pattern matches the cursor/codex adapters: timestamp + random suffix.
    // We avoid using brainUUID as the nassaj session id so multiple resumes of
    // the same brain don't collide in activeSessions before discovery.
    return `agy_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * True for an id minted by generateNassajSessionId — a spawn key, never a
 * conversation identity. Used to decide whether the client must be handed the
 * brain UUID at the end of the run; a session already addressed by its brain
 * UUID needs no swap.
 */
function isRuntimeSpawnKey(sessionId) {
    return typeof sessionId === 'string' && AGY_SPAWN_KEY_PATTERN.test(sessionId);
}

/**
 * Asks the launch's isolation layer to accept `from` -> `to`. Synchronous by
 * contract: the verdict must be known before the caller adopts and emits.
 * A launch with no workspace binding has nothing to rebind, so it proceeds as
 * before; a workspace-bound launch without an explicit acceptance fails closed.
 * @returns {{accepted: boolean, reason: string}}
 */
function requestAgySessionHandover(ws, { from, to, spawnStartedAtMs, workspaceBound }) {
    if (ws?.runFenceRevoked === true) return { accepted: false, reason: 'run_fence_revoked' };
    if (!workspaceBound) return { accepted: true, reason: 'launch_not_workspace_bound' };
    if (typeof ws?.requestSessionHandover !== 'function') {
        return { accepted: false, reason: 'handover_unavailable' };
    }
    let verdict;
    try {
        verdict = ws.requestSessionHandover({ from, to, spawnStartedAtMs });
    } catch (err) {
        return { accepted: false, reason: `handover_error: ${err?.message || err}` };
    }
    if (verdict && typeof verdict === 'object' && verdict.accepted === true) {
        return { accepted: true, reason: String(verdict.reason || 'accepted') };
    }
    return { accepted: false, reason: String(verdict?.reason || 'handover_rejected') };
}

/**
 * Moves a finished run from its spawn key onto the brain UUID: ensure the
 * destination row, get the handover accepted, adopt the stub, announce the id.
 * qa M3: everything from the verdict to the emit is synchronous — no `await`
 * may be inserted between adopt and the `session_created` send, or a reader
 * could observe the stub gone while the client still addresses it.
 */
function handOverSpawnKey({ ws, from, to, spawnStartedAtMs, workspaceBound, cleanCwd, userId, safeSend }) {
    try {
        // The destination row must exist before the handover checks it and
        // before the client is sent to it. The upsert preserves custom_name
        // and the archived flag.
        sessionsDb.recordDiscoveredSession({
            sessionId: to,
            provider: 'antigravity',
            projectPath: cleanCwd,
            jsonlPath: buildTranscriptPath(to, userId),
        });
    } catch (err) {
        console.error('[agy] failed to register handover target row:', err?.message || err);
    }
    const verdict = requestAgySessionHandover(ws, { from, to, spawnStartedAtMs, workspaceBound });
    if (!verdict.accepted) {
        console.warn(JSON.stringify({
            event: 'agy_session_handover_rejected',
            spawnKey: from,
            brainUUID: to,
            reason: verdict.reason,
        }));
        return false;
    }
    try {
        sessionsDb.adoptRuntimeSessionId(from, to);
    } catch (err) {
        // The handover is committed; the swap below still gives the user a
        // working conversation even if the stub cleanup is lost.
        console.error('[agy] failed to adopt runtime session id:', err?.message || err);
    }
    // qa M5: parentSessionId lets the client migrate only the view that is
    // actually on the spawn key (a user who switched chats is left alone).
    safeSend({
        kind: 'session_created',
        newSessionId: to,
        sessionId: to,
        parentSessionId: from,
    });
    return true;
}

function buildTranscriptPath(brainUUID, userId = null) {
    return path.join(getBrainDir(userId), brainUUID, '.system_generated', 'logs', 'transcript.jsonl');
}

// Snapshot of a brain transcript taken before a resumed spawn:
//   * lastStepIndex — highest step_index present (-1 when missing/empty), used
//     to fence off pre-existing steps so only THIS turn's planner output is
//     surfaced to the client (agy's print mode replays prior output on stdout).
//   * hasInstructions — whether any USER_INPUT step already carries our
//     <instructions> prefix. Conversations born outside the UI (Antigravity
//     IDE, raw terminal) never received it.
async function readTranscriptState(brainUUID, userId = null) {
  const state = { lastStepIndex: -1, hasInstructions: false, readable: false };
    let content;
    try {
        content = await fs.readFile(buildTranscriptPath(brainUUID, userId), 'utf8');
    } catch {
        return state;
    }
  state.readable = true;
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (typeof entry.step_index === 'number' && entry.step_index > state.lastStepIndex) {
                state.lastStepIndex = entry.step_index;
            }
            if (!state.hasInstructions
                && entry.type === 'USER_INPUT'
                && typeof entry.content === 'string'
                && entry.content.includes('<instructions>')) {
                state.hasInstructions = true;
            }
        } catch {
            // Skip malformed lines; the transcript is append-only jsonl.
        }
    }
    return state;
}

// Collects the PLANNER_RESPONSE text agy appended to the transcript AFTER the
// given step index — i.e. the model's actual reply for the current turn.
async function readNewPlannerText(brainUUID, userId, afterStepIndex) {
    let content;
    try {
        content = await fs.readFile(buildTranscriptPath(brainUUID, userId), 'utf8');
    } catch {
        return '';
    }
    const parts = [];
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'PLANNER_RESPONSE'
                && entry.source === 'MODEL'
                && typeof entry.step_index === 'number'
                && entry.step_index > afterStepIndex
                && typeof entry.content === 'string') {
                const text = entry.content.trim();
                if (text) parts.push(text);
            }
        } catch {
            // Skip malformed lines.
        }
    }
    return parts.join('\n\n');
}

// The transcript write can lag the process exit by a beat; retry briefly so a
// just-finished turn is not misread as "no new output".
async function readNewPlannerTextWithRetry(brainUUID, userId, afterStepIndex, attempts = 5, delayMs = 400) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const text = await readNewPlannerText(brainUUID, userId, afterStepIndex);
        if (text) return text;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return '';
}

// ADR-199 P5: at turn end, the plan (brain task.md) and invoked subagents of
// THIS turn only (steps after the pre-spawn fence), read from the run's own
// credential-principal brain root (getBrainDir(userId)); readAgyTaskFile
// enforces the realpath containment. An aborted run or an unreadable
// transcript yields no rows, never a guess.
async function readTurnProgressRows(brainUUID, userId, afterStepIndex, sessionId, aborted) {
    if (!brainUUID || aborted) return [];
    try {
        const transcript = await fs.readFile(buildTranscriptPath(brainUUID, userId), 'utf8');
        const taskText = await readAgyTaskFile(getBrainDir(userId), brainUUID);
        return buildAgyTurnProgressRows({
            steps: summarizeAgyTranscript(transcript),
            afterStepIndex,
            brainUUID,
            sessionId,
            plan: taskText ? agyChecklistPlan(taskText) : null,
        });
    } catch {
        return [];
    }
}

// Extract the brain UUID embedded in a transcript jsonl_path, i.e. the path
// segment immediately under the brain root: .../brain/<UUID>/.system_generated/...
// Returns null when the path does not match the expected antigravity layout.
function extractBrainUUIDFromJsonlPath(jsonlPath) {
    if (typeof jsonlPath !== 'string' || !jsonlPath) {
        return null;
    }
    const marker = `${path.sep}brain${path.sep}`;
    const markerIndex = jsonlPath.indexOf(marker);
    if (markerIndex === -1) {
        return null;
    }
    const afterBrain = jsonlPath.slice(markerIndex + marker.length);
    const uuid = afterBrain.split(path.sep)[0];
    return uuid || null;
}

// Recover the agy brain UUID for a resumed session from the persisted DB row.
// Used when the in-memory sessionManager has no `cliSessionId` (server restart,
// or a conversation opened from history). Only antigravity rows are honoured so
// a Claude/cursor session id can never be misread as a brain UUID. The brain
// UUID is taken from the jsonl_path when present and otherwise from the
// session_id itself, which for antigravity sessions equals the brain UUID.
function resolveBrainUUIDFromDb(sessionId) {
    let row;
    try {
        row = sessionsDb.getSessionById(sessionId);
    } catch (err) {
        console.error('[agy] failed to look up session for resume:', err?.message || err);
        return null;
    }

    if (!row || row.provider !== 'antigravity') {
        return null;
    }

    return extractBrainUUIDFromJsonlPath(row.jsonl_path) || row.session_id || null;
}

// Discovers the brain UUID created by a fresh agy run and binds it to its real
// workspace path. Runs at most once per spawn (idempotent via the shared state
// object). We register the real path in two places so a concurrent synchronize()
// can never file the placeholder for this conversation:
//   * the in-process registry the synchronizer consults before falling back, and
//   * the DB row itself, so the binding survives once written.
// Discovery is filesystem diff-based, so it works as soon as agy materializes the
// brain folder (on first output) rather than waiting for process exit.
async function discoverAndRegisterBrainSession(state, priorBrainIds, cleanCwd, finalSessionId, userId = null) {
    if (state.discovered) {
        return;
    }

    let currentBrainIds;
    try {
        currentBrainIds = await listBrainIds(userId);
    } catch {
        return;
    }

    const discoveredBrainUUID = [...currentBrainIds].find((id) => !priorBrainIds.has(id)) || null;
    if (!discoveredBrainUUID) {
        // The brain folder may not exist yet on the first chunk; retry on a later
        // chunk or at close. Leave state.discovered false so we try again.
        return;
    }

    state.discovered = true;
    state.brainUUID = discoveredBrainUUID;
    bindBrainToRun(discoveredBrainUUID, cleanCwd, finalSessionId, userId);
}

/**
 * Binds a fresh conversation's brain UUID to its real workspace path and to
 * the run's session record. Shared by the `-p` discovery (snapshot diff) and
 * the ACP path (session/new answers the UUID directly, T-2094).
 */
function bindBrainToRun(brainUUID, cleanCwd, finalSessionId, userId) {
    // Bind for the synchronizer first: this is synchronous and closes the race
    // window even if the DB write below is delayed or fails.
    registerAntigravityProjectPath(brainUUID, cleanCwd);

    const persisted = sessionManager.getSession(finalSessionId);
    if (persisted) {
        persisted.cliSessionId = brainUUID;
        sessionManager.saveSession(finalSessionId);
    }

    try {
        sessionsDb.recordDiscoveredSession({
            sessionId: brainUUID,
            provider: 'antigravity',
            projectPath: cleanCwd,
            jsonlPath: buildTranscriptPath(brainUUID, userId),
        });
    } catch (err) {
        console.error('[agy] failed to register session in DB:', err?.message || err);
    }
}

// agy's `--model` flag expects the model's DISPLAY LABEL, not the catalog
// modelId. Verified against agy 1.x: `agy models` prints labels like
// "Gemini 3.5 Flash (Low)", and `agy --model "<label>" --log-file ...` logs
// `model_config_manager.go: Propagating selected model override to backend:
// label="<label>"` while an unknown id logs `resolver.go: Model ID <X> not in
// local config, defaulting to CCPA` (silent default, no error). The dynamic
// catalog (antigravity-catalog.client.ts) carries each model's `value` (the
// modelId the UI sends) and its `label` (the displayName agy wants), so we map
// value -> label here.
//
// Pure, synchronous core so it is unit-testable without the network or a spawn.
// Rules:
//   * falsy / 'auto' (case-insensitive) / empty  -> null  (no --model; agy default)
//   * exact match on a catalog OPTION value       -> that option's label
//   * value already equals a catalog OPTION label -> that label (UI sent a label)
//   * no catalog match                            -> the raw value (best-effort;
//                                                    caller warns) so a brand-new
//                                                    model not yet in the cached
//                                                    catalog still reaches agy
//                                                    rather than silently dropping.
// Returns { label, matched } so the async wrapper can decide whether to warn.
function pickAgyModelLabel(model, catalogOptions) {
    if (typeof model !== 'string') {
        return { label: null, matched: false };
    }
    let trimmed = model.trim();
    if (!trimmed || trimmed.toLowerCase() === 'auto') {
        return { label: null, matched: false };
    }

    const options = Array.isArray(catalogOptions) ? catalogOptions : [];

    // Repair stale cached options from the period when `<id>\t<label>` was
    // stored as one value, then resolve against the current catalog normally.
    if (trimmed.includes('\t')) {
        const [rawValue, ...rawLabelParts] = trimmed.split('\t');
        const value = rawValue.trim();
        const label = rawLabelParts.join(' ').trim();
        const tabMatch = options.find((opt) => opt && (
            opt.value === value || opt.label === value || opt.value === label || opt.label === label
        ));
        if (tabMatch && typeof tabMatch.label === 'string' && tabMatch.label.trim()) {
            return { label: tabMatch.label.trim(), matched: true };
        }
        trimmed = label || value;
    }

    // Prefer an exact value (modelId) match — this is what the UI sends.
    const byValue = options.find((opt) => opt && opt.value === trimmed);
    if (byValue && typeof byValue.label === 'string' && byValue.label.trim()) {
        return { label: byValue.label.trim(), matched: true };
    }

    // The UI might already be sending a label (or value === label in fallback
    // catalogs); accept that too so we still pass a known-good label.
    const byLabel = options.find((opt) => opt && opt.label === trimmed);
    if (byLabel && typeof byLabel.label === 'string' && byLabel.label.trim()) {
        return { label: byLabel.label.trim(), matched: true };
    }

    // Unknown to the cached catalog: pass through as best-effort.
    return { label: trimmed, matched: false };
}

// Async wrapper: resolves the agy `--model` label for the UI-supplied model
// using the CACHED provider-models catalog (memory -> disk -> stale-while-
// revalidate). It never forces a blocking live fetch on this spawn hot path,
// and any failure (no catalog, lookup error) degrades to a best-effort
// pass-through of the raw value instead of breaking the run. Returns the label
// string to pass to `--model`, or null to omit the flag entirely (agy default).
async function resolveAgyModelLabel(model, userId = null, authenticatedPrincipal = undefined) {
    if (typeof model !== 'string' || !model.trim() || model.trim().toLowerCase() === 'auto') {
        return null;
    }

    let options = [];
    try {
        // Lazy import so loading agy-cli.js does not eagerly pull in the whole
        // provider-models / provider-registry module graph at module-eval time.
        // We only need the catalog when a concrete (non-auto) model is selected.
        const { providerModelsService } = await import(
            './modules/providers/services/provider-models.service.js'
        );
        const result = await providerModelsService.getProviderModels(
            'antigravity', {}, userId, authenticatedPrincipal
        );
        options = result?.models?.OPTIONS ?? [];
    } catch (err) {
        // Catalog unavailable: fall through with an empty option list so
        // pickAgyModelLabel best-effort passes the raw value.
        console.warn('[agy] model catalog lookup failed; passing model as-is:', err?.message || err);
    }

    const { label, matched } = pickAgyModelLabel(model, options);
    if (label && !matched) {
        console.warn(`[agy] model "${model.trim()}" not found in catalog; passing it to --model as-is.`);
    }
    return label;
}

// Lazy service accessor so loading agy-cli.js does not eagerly pull in the whole
// provider-models module graph at module-eval time (mirrors resolveAgyModelLabel).
async function defaultGetChangedAgyModel(sessionId) {
    const { providerModelsService } = await import(
        './modules/providers/services/provider-models.service.js'
    );
    return providerModelsService.getChangedActiveModel('antigravity', sessionId);
}

// Decide which model (if any) should drive agy's --model flag for this spawn.
// Mirrors provider-models.service.resolveResumeModel's intent, but for agy's
// brain-backed sessions (T-874(1) / T-875):
//   * fresh conversation (no brain to resume) -> honour the caller's
//     creation-time selection, so a NEW agy session starts on the picked model;
//   * resume WITH an explicit in-conversation re-pick -> that re-picked model;
//   * plain resume (no re-pick) -> null: omit --model entirely so agy keeps its
//     brain's OWN persisted model. The agy brain IS agy's per-session model
//     memory, so forwarding the caller's (frontend-global) model on every resumed
//     turn would let a model pick made in ANOTHER conversation bleed onto this one.
// Returns the model string to resolve into an agy label, or null to omit --model.
// `deps.getChangedActiveModel(sessionId)` is injectable for tests.
async function resolveAgySpawnModel({ existingBrainUUID, sessionId, requestedModel }, deps = {}) {
    if (!existingBrainUUID) {
        // Fresh conversation: pass the creation-time selection through;
        // resolveAgyModelLabel normalizes 'auto'/empty/unknown downstream.
        return typeof requestedModel === 'string' ? requestedModel : null;
    }

    const trimmedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!trimmedSessionId) {
        return null;
    }

    const getChanged = deps.getChangedActiveModel || defaultGetChangedAgyModel;
    try {
        const changed = await getChanged(trimmedSessionId);
        if (changed
            && changed.supported
            && changed.changed
            && typeof changed.model === 'string'
            && changed.model.trim()) {
            return changed.model.trim();
        }
    } catch (err) {
        console.warn('[agy] resume model-change lookup failed; keeping brain default:', err?.message || err);
    }
    return null;
}

/**
 * Runs one agy turn. Shared preparation, then the ACP path when
 * NASSAJ_AGY_ACP is on (T-2094, read every turn), else — or when ACP declines
 * the turn (capability probe, pool full) — the `agy -p` path.
 */
async function spawnAntigravity(command, options = {}, ws) {
    const opts = options && typeof options === 'object' ? options : {};
    const { sessionId } = opts;

    if (refuseSpawnIfHarnessUpdating('antigravity', ws, {
        sessionId,
        clientMsgId: opts.clientMsgId,
    })) return;

    // The authenticated user driving this run. Drives both the spawn env
    // (resolveProviderEnv) and which brain dir we read, so an isolated agy
    // reads/writes the same per-user brain store.
    const userId = ws?.userId ?? null;

    // Brain UUID for resume: the in-memory sessionManager (`cliSessionId`) is
    // populated only during the run that created the conversation; after a
    // server restart or a resume from history the persisted row answers (for
    // antigravity the nassaj session_id IS the brain UUID). Without this
    // fallback a resume would start a new brain instead of continuing.
    const existingSession = sessionId ? sessionManager.getSession(sessionId) : null;
    const existingBrainUUID = existingSession?.cliSessionId
        || (sessionId ? resolveBrainUUIDFromDb(sessionId) : null);

    // Stale-resume guard: a resume whose brain folder is gone must not
    // silently start a fresh conversation; the client offers a deliberate
    // "start new session" that re-sends this prompt.
    if (existingBrainUUID && !(await brainExists(existingBrainUUID, userId))) {
        if (ws) {
            ws.send(createNormalizedMessage({
                kind: 'error',
                code: 'conversation_not_found',
                content: 'The previous session could not be resumed — it has expired or been removed.',
                staleSessionId: sessionId,
                command: command || '',
                sessionId,
                provider: 'antigravity',
            }));
        }
        return { code: 0, sessionId };
    }

    const turn = await prepareAgyTurnInput(command, opts, ws, { userId, existingBrainUUID });
    if (turn.result) return turn.result;
    if (isAgyAcpEnabled()) {
        const acpResult = await runAgyAcpTurn(turn);
        if (acpResult) return acpResult;
    }
    return runAgyPrintTurn(turn);
}

/**
 * Preparation shared by both paths: transcript fence, instruction prefix,
 * coordination directive, workspace check and the model to pass.
 * @returns {Promise<object>} the turn, or `{ result }` when the run ends here
 */
async function prepareAgyTurnInput(command, opts, ws, { userId, existingBrainUUID }) {
    const { sessionId, projectPath, cwd, model } = opts;
    // Resumed runs read THIS turn's steps after the pre-spawn step index (agy's
    // print mode replays prior output on stdout), and learn whether the
    // conversation already carries our <instructions> prefix.
    const preSpawnTranscript = existingBrainUUID
        ? await readTranscriptState(existingBrainUUID, userId)
        : { lastStepIndex: -1, hasInstructions: false, readable: true };

    // Instructions go to agy only (sessionManager records the raw message):
    // on a fresh conversation, and once on a resumed one born outside the UI.
    let commandToSend = command || '';
    if (!existingBrainUUID || !preSpawnTranscript.hasInstructions) {
        const instructionsPrefix = await buildInstructionsPrefix(projectPath || cwd);
        if (instructionsPrefix) {
            commandToSend = `${instructionsPrefix}\n\n${commandToSend}`;
        }
    }
    // T-1315: the coordination level is this turn's decision, applied after
    // the instructions on every turn; textual (agy has no documented knob).
    commandToSend = withCoordinationDirective(commandToSend, opts.coordinationLevel);

    // Strip non-printable chars that leak in from terminal copy/paste. This is
    // both the process cwd AND the explicit agy workspace (--add-dir).
    const cleanCwd = (cwd || projectPath || process.cwd())
        .replace(/[^\x20-\x7E]/g, '')
        .trim();

    // B-31: verify the project directory exists before spawning agy.
    if (cwd || projectPath) {
        const cwdCheck = await checkCwdExists(cleanCwd);
        if (!cwdCheck.ok) {
            if (ws) {
                ws.send(createNormalizedMessage(
                    buildCwdMissingPayload(cwdCheck.error, { sessionId: sessionId || null, provider: 'antigravity' })
                ));
            }
            return { result: { code: 1, sessionId } };
        }
    }

    // T-874(1)/T-875: a model only on creation or an explicit re-pick; a plain
    // resume keeps the brain's own model. The label is what agy's --model wants.
    const spawnModel = await resolveAgySpawnModel({ existingBrainUUID, sessionId, requestedModel: model });
    const agyModelLabel = await resolveAgyModelLabel(spawnModel, userId, opts.authenticatedPrincipal);
    return {
        command, opts, ws, userId, sessionId, existingBrainUUID, preSpawnTranscript,
        commandToSend, cleanCwd, spawnModel, agyModelLabel,
    };
}

/**
 * Opens the run's session bookkeeping: replay registry key, nassaj session
 * id, writer stamp, user message, and the send/terminal helpers. Synchronous:
 * callers run it after their last run-fence check, with no await in between.
 */
function openAgyRun(turn) {
    const { ws, userId, command, opts } = turn;
    const cwd = opts.cwd || opts.projectPath || process.cwd();
    // B-N5: open the registry under a temporary connectionId so any payload
    // buffered before the real sessionId is known is retained, then rekey.
    const connectionId = connectionIdFor(ws);
    let registryKey = connectionId;
    if (connectionId) {
        // A connectionId may be reused across runs on one socket: never let
        // this run inherit a prior, already-terminated buffer.
        cancelPendingDrop(connectionId);
        if (agySessionRegistry.enabled
            && agySessionRegistry.entries.has(connectionId)
            && !agySessionRegistry.isActive(connectionId)) {
            agySessionRegistry.drop(connectionId);
        }
        agySessionRegistry.open(connectionId);
    }

    let finalSessionId = turn.sessionId;
    let isNewSession = false;
    if (!finalSessionId) {
        finalSessionId = generateNassajSessionId();
        isNewSession = true;
        sessionManager.createSession(finalSessionId, cwd);
    }
    // B-40e: stamp sessionId on the writer as early as possible.
    if (ws && ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(finalSessionId);
    }
    registryKey = rekeyAgyRegistry(connectionId, finalSessionId) ?? registryKey;
    // B-N7: mark the session active in the single source of truth.
    agySessionRegistry.open(registryKey);
    if (command) {
        sessionManager.addMessage(finalSessionId, 'user', command);
    }

    // Timing joins the native DONE planner step under its stable brain/step identity.
    const turnTimer = createTurnTimer();
    const run = {
        finalSessionId, isNewSession, registryKey, runPresence: null,
        turnTimer, terminalNotified: false,
    };
    run.safeSend = createAgySafeSend(ws, userId, registryKey);
    run.notifyTerminal = (outcome) => notifyAgyTerminal(run, turn, outcome);
    return run;
}

/**
 * B-N-RESUME + B-N5: drops an inactive prior buffer under `finalSessionId`
 * and moves the connection buffer onto it. Returns the new key, or null.
 */
function rekeyAgyRegistry(connectionId, finalSessionId) {
    if (!finalSessionId) return null;
    cancelPendingDrop(finalSessionId);
    if (agySessionRegistry.enabled
        && finalSessionId !== connectionId
        && agySessionRegistry.entries.has(finalSessionId)
        && !agySessionRegistry.isActive(finalSessionId)) {
        agySessionRegistry.drop(finalSessionId);
    }
    if (!connectionId || connectionId === finalSessionId) return null;
    // B-40b: a concurrent rekey collision must not crash the spawn pipeline.
    try {
        agySessionRegistry.rekey(connectionId, finalSessionId);
    } catch (rekeyErr) {
        console.warn('[agy] rekey failed (concurrent resume?); opening fresh entry:', rekeyErr?.message || rekeyErr);
    }
    return finalSessionId;
}

/** The run's single send path: coordinator stamp, replay buffer, then the socket. */
function createAgySafeSend(ws, userId, registryKey) {
    return (payload) => {
        // B-MU-UX-FIX-ASSISTANT-AUTHOR: stamp the human who spawned this run on
        // the reply chunks; control events carry no coordinatorId.
        const withCoordinator =
            payload.kind === 'stream_delta' && Number.isInteger(userId)
                ? { ...payload, coordinatorId: userId }
                : payload;
        const normalized = createNormalizedMessage({ ...withCoordinator, provider: 'antigravity' });
        // ADR-021 replay buffer; T-1854 (qa M2): a revoked run fence also stops it.
        if (ws?.runFenceRevoked !== true) {
            // ADR-210: stamp the ring seq on the buffered original before sending.
            const seq = agySessionRegistry.record(registryKey, normalized);
            if (seq !== null && seq !== undefined) normalized.sequence = seq;
        }
        if (!ws) return;
        try {
            ws.send(normalized);
        } catch (err) {
            // ws may close mid-stream; avoid crashing the spawn pipeline.
            console.error('[agy] failed to forward ws payload:', err?.message || err);
        }
    };
}

/** Run-end notification (once): presence end + stopped/failed notification. */
function notifyAgyTerminal(run, turn, { code = null, error = null } = {}) {
    if (run.terminalNotified) return;
    run.terminalNotified = true;
    // B-395: the process monitor emits presence + open-sessions on end().
    run.runPresence?.end();
    const base = {
        userId: turn.ws?.userId || null,
        provider: 'antigravity',
        sessionId: run.finalSessionId,
        sessionName: turn.opts.sessionSummary,
    };
    if (code === 0 && !error) {
        notifyRunStopped({ ...base, stopReason: 'completed' });
        return;
    }
    notifyRunFailed({ ...base, error: error || getAgyExitMessage(code) });
}

/** B-395 presence + participant/author records, shared by both paths. */
function registerAgyRunPresence(turn, run, { pid, launchReservation }) {
    run.runPresence = beginProviderRun({
        provider: 'antigravity',
        writer: turn.ws,
        sessionId: run.finalSessionId,
        projectPath: turn.cleanCwd,
        pid,
        launchReservation,
    });
    if (turn.ws?.userId) {
        participantsDb.recordSpawn(run.finalSessionId, turn.ws.userId, {
            provider: 'antigravity',
            projectPath: turn.cleanCwd,
        });
        // B-MU-UX-FIX-MSG-AUTHOR: who authored this prompt (best-effort hash match).
        messageAuthorsDb.recordUserMessage(run.finalSessionId, turn.ws.userId, turn.command);
    }
}

/** The `session_created` frame of a fresh conversation (spawn key; B-1666 parent null). */
function sendAgySessionCreated(turn, run) {
    run.safeSend({
        kind: 'session_created',
        newSessionId: run.finalSessionId,
        sessionId: run.finalSessionId,
        parentSessionId: null,
        ...(typeof turn.opts.clientMsgId === 'string' && turn.opts.clientMsgId
            ? { clientMsgId: turn.opts.clientMsgId }
            : {}),
    });
}

/**
 * The `agy -p` path (unchanged behaviour): snapshot-diff brain discovery for a
 * fresh conversation, transcript-derived reply for a resumed one.
 */
async function runAgyPrintTurn(turn) {
    const { ws, userId, existingBrainUUID, cleanCwd, sessionId } = turn;
    // T-2094 QA 5: never two agy processes on one conversation.
    killPooledAgyForConversation(userId, existingBrainUUID);

    // B-ISO-AGYLOCK: only fresh conversations race on UUID discovery, so only
    // they serialize the window from "snapshot prior ids" to "UUID bound".
    const releaseDiscoveryLock = existingBrainUUID ? null : await acquireDiscoveryLock();
    let discoveryLockReleased = false;
    const freeDiscoveryLock = () => {
        if (releaseDiscoveryLock && !discoveryLockReleased) {
            discoveryLockReleased = true;
            releaseDiscoveryLock();
        }
    };
    // The clock is read first: a brain born before it cannot belong to this run,
    // which the session handover re-checks against the brain dir's birth time.
    const spawnStartedAtMs = Date.now();
    const priorBrainIds = await listBrainIds(userId);

    // T-1854 (qa H1b): last await before spawn — everything below through
    // spawn + activeSessions.set is synchronous, so a revoked run fence stops here.
    if (ws?.runFenceRevoked) { freeDiscoveryLock(); return { code: 1, sessionId }; }
    // agy in --print mode ignores the OS cwd; pin the workspace with --add-dir.
    const args = ['-p', turn.commandToSend, '--dangerously-skip-permissions'];
    if (cleanCwd) {
        args.push('--add-dir', cleanCwd);
    }
    if (turn.agyModelLabel) {
        args.push('--model', turn.agyModelLabel);
    }
    if (existingBrainUUID) {
        args.push('--conversation', existingBrainUUID);
    }
    const run = openAgyRun(turn);
    const { agProcess, releaseHarnessLaunch } = spawnAgyPrintProcess(turn, run, args, freeDiscoveryLock);
    activeSessions.set(run.finalSessionId, { process: agProcess, brainUUID: existingBrainUUID });
    registerAgyRunPresence(turn, run, { pid: agProcess.pid, launchReservation: releaseHarnessLaunch });
    return watchAgyPrintProcess(turn, run, agProcess, {
        freeDiscoveryLock, priorBrainIds, spawnStartedAtMs,
    });
}

/** Spawns the `agy -p` child (synchronous; the caller's fence check precedes it). */
function spawnAgyPrintProcess(turn, run, args, freeDiscoveryLock) {
    const { userId, cleanCwd } = turn;
    let agProcess;
    let releaseHarnessLaunch = null;
    try {
        // T-897: cage the agy spawn behind NASSAJ_PROVIDER_CAGE (default OFF ⇒
        // launch is returned unchanged, byte-identical to the previous spawn).
        const agyLaunch = resolveCagedLaunch({
            userId,
            provider: 'agy',
            cmd: resolveHarnessBinary('antigravity'),
            args,
            cwd: cleanCwd,
        });
        releaseHarnessLaunch = beginHarnessLaunch('antigravity');
        agProcess = spawn(agyLaunch.cmd, agyLaunch.args, {
            cwd: cleanCwd,
            // Single source of truth for the spawn env: the resolver points HOME
            // at the member's own root (or grant home) so the brain store lands
            // in their tree. No member ⇒ refused (ADR-152 A1 §3.4).
            env: resolveProviderEnv(assertModelRunActor(userId), 'agy', process.env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        releaseHarnessLaunch?.();
        freeDiscoveryLock();
        // B-32: map spawn error to a structured code.
        const mapped = mapSpawnError(err);
        run.safeSend({ kind: 'error', code: mapped.code, content: mapped.fallbackMessage, sessionId: run.finalSessionId });
        run.notifyTerminal({ error: err });
        throw err;
    }
    return { agProcess, releaseHarnessLaunch };
}

/** Streams and settles one `agy -p` child. */
function watchAgyPrintProcess(turn, run, agProcess, discovery) {
    const { existingBrainUUID, cleanCwd, userId } = turn;
    const { finalSessionId, safeSend } = run;
    // Shared discovery state so the early stdout hook and the close-time
    // safety net never double-register the same brain UUID.
    const discoveryState = { discovered: false, brainUUID: existingBrainUUID };
    // UTF-8 streaming decoder: a multibyte char may straddle a chunk boundary.
    const stdoutDecoder = new StringDecoder('utf8');
    const state = { assistantText: '', sessionCreatedSent: false, lastStderrError: null, terminalFailure: null };

    return new Promise((resolve, reject) => {
        agProcess.stdout.on('data', (chunk) => {
            const text = stdoutDecoder.write(chunk);
            if (!text) return;
            if (!state.sessionCreatedSent && run.isNewSession) {
                state.sessionCreatedSent = true;
                sendAgySessionCreated(turn, run);
            }
            // Bind the real workspace path as early as possible (agy has the
            // brain folder by its first output) so a mid-run synchronize()
            // resolves the real project, then free the discovery lock.
            if (!existingBrainUUID && !discoveryState.discovered) {
                discoverAndRegisterBrainSession(discoveryState, discovery.priorBrainIds, cleanCwd, finalSessionId, userId)
                    .then(() => { if (discoveryState.discovered) discovery.freeDiscoveryLock(); })
                    .catch(() => { /* retried on next chunk / at close */ });
            }
            run.turnTimer.markModelActivity();
            state.assistantText += text;
            // Resumed runs: stdout replays PREVIOUS turns — the reply is read
            // from the transcript at close instead.
            if (!existingBrainUUID) {
                safeSend({ kind: 'stream_delta', content: text, sessionId: finalSessionId });
            }
        });
        agProcess.stderr.on('data', (data) => captureAgyStderr(data, state));
        agProcess.on('close', (code, signal) => {
            settleAgyPrintProcess(turn, run, agProcess, { code, signal, state, stdoutDecoder, discoveryState, discovery })
                .then(resolve, reject);
        });
        agProcess.on('error', (err) => {
            state.terminalFailure = err.message || 'Antigravity process error';
            failAgyPrintProcess(run, err, discovery);
            reject(err);
        });
    });
}

/** `error` event of a `-p` child: inactive, error frame, notification, drop window. */
function failAgyPrintProcess(run, err, discovery) {
    activeSessions.delete(run.finalSessionId);
    agySessionRegistry.setActive(run.registryKey, false);
    discovery.freeDiscoveryLock();
    run.safeSend({ kind: 'error', content: err.message, sessionId: run.finalSessionId });
    run.notifyTerminal({ error: err });
    // B-N-DROP: post-close replay window, mirroring the close handler.
    scheduleBufferDrop(run.registryKey);
}

/**
 * B-394: keep the LAST real `Error:` line of agy's stderr. agy reports quota,
 * auth and model failures there and exits non-zero without a transcript step.
 */
function captureAgyStderr(data, state) {
    const msg = data.toString();
    // agy inherits node's deprecation noise; keep it out of the chat.
    if (!msg) return;
    if (msg.includes('DeprecationWarning') || msg.includes('[DEP')) return;
    console.error('[agy stderr]', msg.trim());
    const line = msg
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('Error:') || l.startsWith('error:'))
        .pop();
    if (line) {
        state.lastStderrError = line;
        state.terminalFailure = line;
    }
}

/** Close handler of a `-p` child: flush, transcript reply, discovery, then the shared finish. */
async function settleAgyPrintProcess(turn, run, agProcess, { code, signal, state, stdoutDecoder, discoveryState, discovery }) {
    const { existingBrainUUID, userId, cleanCwd } = turn;
    const processCompletedAt = new Date().toISOString();
    if (state.terminalFailure || agProcess.nassajAborted || signal) code = code === 0 ? 1 : code;
    activeSessions.delete(run.finalSessionId);
    // A truncated final UTF-8 sequence surfaces as � at the very end only.
    const tail = stdoutDecoder.end();
    if (tail) {
        state.assistantText += tail;
        if (!existingBrainUUID) {
            run.safeSend({ kind: 'stream_delta', content: tail, sessionId: run.finalSessionId });
        }
    }
    // Resumed run: the reply comes from the transcript steps of THIS run; the
    // stdout text (which carries the replay) is only the fallback.
    if (existingBrainUUID) {
        const newPlannerText = await readNewPlannerTextWithRetry(
            existingBrainUUID, userId, turn.preSpawnTranscript.lastStepIndex,
        );
        state.assistantText = newPlannerText || state.assistantText;
        if (state.assistantText) {
            run.safeSend({ kind: 'stream_delta', content: state.assistantText, sessionId: run.finalSessionId });
        }
    }
    // B-N7: the run is terminal (buffer kept for the B-N-DROP window).
    agySessionRegistry.setActive(run.registryKey, false);
    // Safety net: a run without stdout skipped the early discovery hook.
    if (!existingBrainUUID) {
        await discoverAndRegisterBrainSession(discoveryState, discovery.priorBrainIds, cleanCwd, run.finalSessionId, userId);
    }
    discovery.freeDiscoveryLock();
    return finishAgyTurn(turn, run, {
        code,
        assistantText: state.assistantText,
        discoveredBrainUUID: existingBrainUUID ? null : discoveryState.brainUUID,
        failureReason: state.lastStderrError,
        failed: Boolean(state.terminalFailure),
        aborted: Boolean(agProcess.nassajAborted),
        processCompletedAt,
        spawnStartedAtMs: discovery.spawnStartedAtMs,
    });
}

/**
 * B-394 / T-1191: the failure cause precedes `complete` and `session_created`
 * (sent after them it reached a view that had already moved), uses agy's own
 * words, and is persisted under the brain UUID so a reload still shows it.
 */
function recordAgyTurnFailure(run, { code, failureReason, failureKey }) {
    const reason = failureReason || getAgyExitMessage(code);
    run.safeSend({
        kind: 'error',
        code: classifyAgyFailure(reason, code),
        content: reason,
        sessionId: run.finalSessionId,
    });
    providerRunFailuresDb.recordFailure({
        sessionId: failureKey,
        provider: 'antigravity',
        reason,
        exitCode: code,
        quotaResetsAtMs: isQuotaFailure(reason) ? parseQuotaResetMs(reason, Date.now()) : null,
    });
}

/** Durable reply identity + timing from the native transcript (identity only). */
async function readAgyDurableTiming(turn, run, { timingSessionId, processCompletedAt, eligible }) {
    if (!eligible || !timingSessionId || !turn.preSpawnTranscript.readable) return {};
    let finalTranscriptMessage = null;
    for (let attempt = 0; attempt < 5 && !finalTranscriptMessage; attempt++) {
        try {
            const transcript = await fs.readFile(buildTranscriptPath(timingSessionId, turn.userId), 'utf8');
            finalTranscriptMessage = finalAgyTranscriptMessage(
                transcript, timingSessionId, turn.preSpawnTranscript.lastStepIndex,
            );
        } catch {
            // No durable identity without readable native evidence.
        }
        if (!finalTranscriptMessage && attempt < 4) {
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    const { turnTimer } = run;
    const durableTiming = finalTranscriptMessage
        ? settleTurnTiming({
            sessionId: timingSessionId,
            assistantMessageId: finalTranscriptMessage.id,
            startedAt: turnTimer.startedAt(),
            completedAt: processCompletedAt,
        }) : {};
    return durableTiming;
}

/**
 * The end of a turn, shared by both paths: persist the reply, audit, failure
 * record, timing, progress rows, `complete`, then the spawn-key handover and
 * the terminal notification. Resolves with `{ code, sessionId }`.
 */
async function finishAgyTurn(turn, run, outcome) {
    const { existingBrainUUID, userId, ws } = turn;
    const { code, discoveredBrainUUID } = outcome;
    const { finalSessionId } = run;
    // The DB row carries the real path durably; drop the in-process binding.
    if (discoveredBrainUUID) clearAntigravityProjectPath(discoveredBrainUUID);
    if (outcome.assistantText && !ws?.isRunOutputRevoked?.()) {
        sessionManager.addMessage(finalSessionId, 'assistant', outcome.assistantText);
    }
    // PDPL audit log — metadata only, never message content or client IP.
    console.log(JSON.stringify({
        audit: true,
        event: 'antigravity_session_end',
        timestamp: new Date().toISOString(),
        sessionId: finalSessionId,
        brainUUID: discoveredBrainUUID || existingBrainUUID || null,
        exitCode: code,
        provider: 'antigravity',
    }));
    // Recorded under the BRAIN UUID: the spawn key is adopted by it on handover.
    const failureKey = discoveredBrainUUID || existingBrainUUID || finalSessionId;
    if (code !== 0) recordAgyTurnFailure(run, { code, failureReason: outcome.failureReason, failureKey });
    else providerRunFailuresDb.clearFailure(failureKey);

    const timingSessionId = discoveredBrainUUID || existingBrainUUID;
    const durableTiming = await readAgyDurableTiming(turn, run, {
        timingSessionId,
        processCompletedAt: outcome.processCompletedAt,
        eligible: code === 0 && !outcome.failed && !outcome.aborted,
    });
    for (const row of await readTurnProgressRows(timingSessionId, userId, turn.preSpawnTranscript.lastStepIndex,
        finalSessionId, outcome.aborted)) {
        run.safeSend(row);
    }
    run.safeSend({ kind: 'complete', exitCode: code, isNewSession: run.isNewSession, sessionId: finalSessionId, ...durableTiming });
    handOverAfterTurn(turn, run, discoveredBrainUUID || existingBrainUUID || null, outcome.spawnStartedAtMs);
    run.notifyTerminal({ code });
    // B-N-DROP: deferred drop AFTER the terminal frames (post-close replay window).
    scheduleBufferDrop(run.registryKey);
    // Resolve, never reject, on a non-zero exit: the error frame above informs the user.
    return { code, sessionId: finalSessionId };
}

/**
 * Hands the conversation over from the spawn key to the brain UUID — after
 * `complete`, which only clears the spinner on the id on screen.
 */
function handOverAfterTurn(turn, run, boundBrainUUID, spawnStartedAtMs) {
    if (!boundBrainUUID || !isRuntimeSpawnKey(run.finalSessionId)) return;
    handOverSpawnKey({
        ws: turn.ws,
        from: run.finalSessionId,
        to: boundBrainUUID,
        spawnStartedAtMs,
        workspaceBound: Boolean(turn.opts.nassajWorkspaceIsolation),
        cleanCwd: turn.cleanCwd,
        userId: turn.userId,
        safeSend: run.safeSend,
    });
}

/** An ACP launch refused before the run opened (env guard, harness update, spawn error). */
function refuseAgyAcpLaunch(turn, err) {
    // B-32: the same structured mapping the `-p` spawn failure uses.
    const mapped = mapSpawnError(err);
    if (turn.ws) {
        turn.ws.send(createNormalizedMessage({
            kind: 'error', code: mapped.code, content: mapped.fallbackMessage, sessionId: turn.sessionId || null, provider: 'antigravity',
        }));
    }
    throw err;
}

/**
 * One conversation already has a turn in its ACP process (one process per
 * member per session): the project-standard `session_busy` refusal, as Claude
 * and Codex send it — one error frame, no `complete`.
 */
function refuseAgyAcpBusy(turn) {
    if (turn.ws) {
        const clientMsgId = turn.opts.clientMsgId;
        turn.ws.send(createNormalizedMessage({
            kind: 'error',
            code: 'session_busy',
            content: 'This conversation is still answering the previous message.',
            sessionId: turn.sessionId || null,
            provider: 'antigravity',
            ...(typeof clientMsgId === 'string' && clientMsgId ? { clientMsgId } : {}),
        }));
    }
    return { code: 1, sessionId: turn.sessionId };
}

/**
 * T-2094: the ACP path. Returns null when ACP declines this turn (capability
 * probe failed, pool full with nothing idle) so the caller runs `agy -p`.
 */
async function runAgyAcpTurn(turn) {
    const { ws, userId, existingBrainUUID, cleanCwd } = turn;
    let plan;
    try {
        plan = await prepareAgyAcpLaunch({ userId, cwd: cleanCwd, brainUUID: existingBrainUUID });
    } catch (err) {
        return refuseAgyAcpLaunch(turn, err);
    }
    if (plan.fallback) {
        console.warn(JSON.stringify({ event: 'agy_acp_fallback', reason: plan.fallback }));
        return null;
    }
    // T-1854 (qa H1b): last await before the spawn — admit + open are synchronous.
    if (ws?.runFenceRevoked) { return { code: 1, sessionId: turn.sessionId }; }
    let admitted;
    try {
        admitted = admitAgyAcpTurn(plan);
    } catch (err) {
        return refuseAgyAcpLaunch(turn, err);
    }
    if (admitted.status === 'busy') return refuseAgyAcpBusy(turn);
    if (admitted.status === 'full') {
        console.warn(JSON.stringify({ event: 'agy_acp_fallback', reason: 'pool_full' }));
        return null;
    }
    const started = startAdmittedAgyAcpRun(turn, admitted);
    return driveAgyAcpRun(turn, started.run, admitted.entry, { env: plan.env, active: started.active, spawnStartedAtMs: Date.now() });
}

/**
 * Opens the run for an admitted ACP turn. Anything that throws here (session
 * bookkeeping, presence, participant records) must not leak the admission:
 * the pooled process is dropped (`keep: false`), the launch reservation and
 * presence are released, the client is told, and the error is rethrown.
 */
function startAdmittedAgyAcpRun(turn, admitted) {
    let run = null;
    try {
        run = openAgyRun(turn);
        const active = { process: admitted.entry.handle.child, brainUUID: turn.existingBrainUUID, acpEntry: admitted.entry, aborted: false };
        activeSessions.set(run.finalSessionId, active);
        registerAgyRunPresence(turn, run, { pid: admitted.entry.handle.pid, launchReservation: admitted.releaseLaunch });
        return { run, active };
    } catch (err) {
        agyAcpPool.release(admitted.entry, { keep: false });
        admitted.releaseLaunch();
        if (run) {
            activeSessions.delete(run.finalSessionId);
            agySessionRegistry.setActive(run.registryKey, false);
            run.runPresence?.end();
        }
        const mapped = mapSpawnError(err);
        const send = run ? run.safeSend : (payload) => turn.ws?.send(createNormalizedMessage({ ...payload, provider: 'antigravity' }));
        send({ kind: 'error', code: mapped.code, content: mapped.fallbackMessage, sessionId: run?.finalSessionId ?? turn.sessionId ?? null });
        throw err;
    }
}

/** Drives the admitted ACP turn and hands its outcome to the shared finish. */
async function driveAgyAcpRun(turn, run, entry, { env, active, spawnStartedAtMs }) {
    let assistantText = '';
    let discoveredBrainUUID = null;
    const outcome = await driveAgyAcpTurn(entry, {
        userId: turn.userId,
        env,
        cwd: turn.cleanCwd,
        brainUUID: turn.existingBrainUUID,
        text: turn.commandToSend,
        modelValue: turn.spawnModel,
        modelLabel: turn.agyModelLabel,
        isRevoked: () => turn.ws?.runFenceRevoked === true || active.aborted,
        onSessionReady: ({ brainUUID, isNew }) => {
            if (!isNew) return;
            discoveredBrainUUID = brainUUID;
            active.brainUUID = brainUUID;
            // session/new answered the brain UUID: no snapshot diff, no lock.
            bindBrainToRun(brainUUID, turn.cleanCwd, run.finalSessionId, turn.userId);
            if (run.isNewSession) sendAgySessionCreated(turn, run);
        },
        onText: (text) => {
            run.turnTimer.markModelActivity();
            assistantText += text;
            run.safeSend({ kind: 'stream_delta', content: text, sessionId: run.finalSessionId });
        },
    });
    activeSessions.delete(run.finalSessionId);
    agySessionRegistry.setActive(run.registryKey, false);
    const code = active.aborted ? 1 : outcome.code;
    return finishAgyTurn(turn, run, {
        code,
        assistantText,
        discoveredBrainUUID,
        failureReason: outcome.failureReason || (active.aborted ? 'agy run was stopped.' : null),
        failed: code !== 0,
        aborted: active.aborted,
        processCompletedAt: new Date().toISOString(),
        spawnStartedAtMs,
    });
}

function abortAntigravitySession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session?.process) return false;
    // T-2094: an ACP turn is cancelled first (session/cancel, ≤5 s), then killed.
    if (session.acpEntry) {
        session.aborted = true;
        return abortAgyAcpTurn(session.acpEntry);
    }

    try {
      session.process.nassajAborted = true;
        session.process.kill('SIGTERM');
    } catch {
        return false;
    }

    const killTimer = setTimeout(() => {
        if (activeSessions.has(sessionId)) {
            try {
                session.process.kill('SIGKILL');
            } catch {
                // Best-effort cleanup; process may already be gone.
            }
        }
    }, 5000);
    // Don't hold the event loop open just for the safety-net SIGKILL.
    killTimer.unref?.();
    return true;
}

function isAntigravitySessionActive(sessionId) {
    // B-N7 single source of truth: when the flag is ON, the registry's `active`
    // flag is the ONE authority consumed by both check-session-status (attach)
    // and the drain path — no OR with the legacy map, so the two never diverge.
    // When the flag is OFF this is byte-for-byte the pre-slice behavior: the
    // legacy activeSessions map.
    if (agySessionRegistry.enabled) {
        return agySessionRegistry.isActive(sessionId);
    }
    return activeSessions.has(sessionId);
}

function getActiveAntigravitySessions() {
    // Match the shared CLI adapter shape (array of session ids) so the
    // get-active-sessions endpoint stays uniform across providers.
    return Array.from(activeSessions.keys());
}

// B-N-ATTACH: read-only differential replay for a reconnecting socket. Re-emits
// only buffered payloads with `seq > lastSeq` to `send`, oldest-first. Performs
// NO writer swap and NO abort of the running session — it strictly reads the
// per-session RingBuffer. Returns the highest seq replayed (or the supplied
// lastSeq when nothing newer / disabled / unknown session).
function attachAntigravitySession(sessionId, lastSeq, send) {
    const result = agySessionRegistry.attach(sessionId, lastSeq, send);
    return result === null ? (Number.isFinite(lastSeq) ? lastSeq : 0) : result;
}

export {
    spawnAntigravity,
    abortAntigravitySession,
    isAntigravitySessionActive,
    getActiveAntigravitySessions,
    attachAntigravitySession,
    agySessionRegistry,
    pickAgyModelLabel,
    resolveAgyModelLabel,
    resolveAgySpawnModel,
};
