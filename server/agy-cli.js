// Antigravity (agy) CLI adapter.
// Mirrors the lifecycle contract of gemini-cli.js so the chat WebSocket layer
// can dispatch antigravity-command identically to gemini-command, but:
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
import os from 'os';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import sessionManager from './sessionManager.js';
import { messageAuthorsDb, participantsDb, sessionsDb } from './modules/database/index.js';
import {
    clearAntigravityProjectPath,
    registerAntigravityProjectPath,
} from './modules/providers/list/antigravity/antigravity-project-registry.js';
import {
    openSessionStarted,
    openSessionStopped,
} from './modules/websocket/services/open-sessions.service.js';
import {
    presenceRunStarted,
    presenceRunStopped,
} from './modules/websocket/services/presence.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { resolveCagedLaunch } from './services/isolation/provider-cage-wiring.js';
import { userConfigDir } from './services/isolation/provision-user-dirs.js';
import { isProviderIsolated } from './services/provider-sharing.js';
import { SessionRegistry } from './session-registry.js';

const AGY_PATH = process.env.AGY_PATH || path.join(os.homedir(), '.local', 'bin', 'agy');

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

// Brain store location. When agy is isolated for this user (admin policy) the
// spawn env sets HOME to the per-user root, so agy materializes its brain under
// that user's ~/.gemini/antigravity-cli/brain. The filesystem-based brain
// discovery and transcript-path logic must read from the SAME directory, so we
// compute it from the per-user home whenever isolation is active. When agy is
// shared (default / ADR-016) or there is no authenticated user, fall back to the
// operator home — identical to the previous static BRAIN_DIR.
function getBrainDir(userId = null) {
    const shouldIsolate =
        userId !== null && userId !== undefined && userId !== '' && isProviderIsolated('agy');
    const homeRoot = shouldIsolate ? userConfigDir(userId, '') : os.homedir();
    return path.join(homeRoot, '.gemini', 'antigravity-cli', 'brain');
}

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

// Map agy CLI exit codes to actionable messages. Mirrors mapGeminiExitCodeToMessage
// in gemini-cli.js so the chat surface stays consistent across providers.
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
    return typeof sessionId === 'string' && /^agy_\d+_[a-z0-9]+$/.test(sessionId);
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
    const state = { lastStepIndex: -1, hasInstructions: false };
    let content;
    try {
        content = await fs.readFile(buildTranscriptPath(brainUUID, userId), 'utf8');
    } catch {
        return state;
    }
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

    // Bind for the synchronizer first: this is synchronous and closes the race
    // window even if the DB write below is delayed or fails.
    registerAntigravityProjectPath(discoveredBrainUUID, cleanCwd);

    const persisted = sessionManager.getSession(finalSessionId);
    if (persisted) {
        persisted.cliSessionId = discoveredBrainUUID;
        sessionManager.saveSession(finalSessionId);
    }

    try {
        sessionsDb.createSession(
            discoveredBrainUUID,
            'antigravity',
            cleanCwd,
            undefined,
            undefined,
            undefined,
            buildTranscriptPath(discoveredBrainUUID, userId),
        );
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
    const trimmed = model.trim();
    if (!trimmed || trimmed.toLowerCase() === 'auto') {
        return { label: null, matched: false };
    }

    const options = Array.isArray(catalogOptions) ? catalogOptions : [];

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
async function resolveAgyModelLabel(model) {
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
        const result = await providerModelsService.getProviderModels('antigravity');
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

async function spawnAntigravity(command, options = {}, ws) {
    const opts = options && typeof options === 'object' ? options : {};
    const { sessionId, projectPath, cwd, sessionSummary, model } = opts;

    // The authenticated user driving this run. Drives both the spawn env
    // (resolveProviderEnv) and which brain dir we read for UUID discovery, so
    // an isolated agy reads/writes the same per-user brain store.
    const userId = ws?.userId ?? null;

    // Resolve the brain UUID for resume. Primary source is the in-memory
    // sessionManager (`cliSessionId`, matching the gemini adapter naming). It is
    // populated only during the run that created the conversation, so it is
    // empty after a server restart or when the chat was resumed from history.
    // Fall back to the persisted session row in that case: for antigravity
    // sessions the nassaj session_id IS the brain UUID (see
    // discoverAndRegisterBrainSession below, which writes the row keyed by the
    // discovered brain UUID), and the jsonl_path embeds the same UUID. Without
    // this fallback a resume would be misdetected as a fresh conversation and
    // start a new brain instead of continuing the existing transcript.
    const existingSession = sessionId ? sessionManager.getSession(sessionId) : null;
    const existingBrainUUID = existingSession?.cliSessionId
        || (sessionId ? resolveBrainUUIDFromDb(sessionId) : null);

    // Stale-resume guard: a resume request whose backing brain folder no longer
    // exists must not silently start a fresh conversation. Emit an explicit
    // `conversation_not_found` signal carrying the stale session id and the
    // original command so the client can offer a deliberate "start new session"
    // action that re-sends this prompt.
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

    // B-ISO-AGYLOCK: only fresh conversations (no brain to resume) race on UUID
    // discovery, so serialize the discovery window for those only. Resumed
    // conversations carry an explicit --conversation id and need no lock.
    const needsDiscovery = !existingBrainUUID;
    const releaseDiscoveryLock = needsDiscovery ? await acquireDiscoveryLock() : null;
    let discoveryLockReleased = false;
    const freeDiscoveryLock = () => {
        if (releaseDiscoveryLock && !discoveryLockReleased) {
            discoveryLockReleased = true;
            releaseDiscoveryLock();
        }
    };

    // Snapshot brain UUIDs *before* spawn so we can detect the new one after close.
    const priorBrainIds = await listBrainIds(userId);

    // Resumed runs: agy's print mode REPLAYS the conversation's previous planner
    // output on stdout before (or instead of) the new turn's response — observed
    // on agy 1.x, where a resumed turn's stored reply began with the prior
    // turn's full text. The brain transcript, not stdout, is the reliable source
    // for this turn's reply, so snapshot its last step_index before spawn; the
    // close handler reads only steps appended after it.
    const preSpawnTranscript = existingBrainUUID
        ? await readTranscriptState(existingBrainUUID, userId)
        : { lastStepIndex: -1, hasInstructions: false };

    // Inject project + global instructions on a fresh conversation (no brain to
    // resume) — and, once, on a resumed conversation whose transcript never
    // received the prefix (born outside the UI: Antigravity IDE, raw terminal).
    // Re-sending on every turn would duplicate it, so resumed conversations that
    // already carry an <instructions> USER_INPUT are left untouched. The
    // injected prefix is sent to agy only — sessionManager records the original
    // user message below — so the chat history stays free of boilerplate.
    let commandToSend = command || '';
    if (!existingBrainUUID || !preSpawnTranscript.hasInstructions) {
        const instructionsPrefix = await buildInstructionsPrefix(projectPath || cwd);
        if (instructionsPrefix) {
            commandToSend = `${instructionsPrefix}\n\n${commandToSend}`;
        }
    }

    // Resolve and sanitize the workspace dir up front — strip non-printable chars
    // that can leak in from terminal copy/paste. This value is both the process
    // cwd AND the explicit agy workspace (--add-dir) below.
    const cleanCwd = (cwd || projectPath || process.cwd())
        .replace(/[^\x20-\x7E]/g, '')
        .trim();

    // B-31: verify the project directory exists before acquiring the discovery
    // lock and spawning agy. Release the lock if already held (shouldn't be at
    // this point, but guard defensively).
    if (cwd || projectPath) {
        const cwdCheck = await checkCwdExists(cleanCwd);
        if (!cwdCheck.ok) {
            freeDiscoveryLock();
            if (ws) {
                ws.send(createNormalizedMessage(
                    buildCwdMissingPayload(cwdCheck.error, { sessionId: sessionId || null, provider: 'antigravity' })
                ));
            }
            return { code: 1, sessionId };
        }
    }

    // agy in --print mode ignores the OS process cwd and defaults to its internal
    // scratch directory (~/.gemini/antigravity-cli/scratch). Without an explicit
    // workspace it wanders the home tree and latches onto unrelated projects
    // (e.g. it reads ~/nassaj-core/NASSAJ.md while the user is in diwan). Pin the
    // workspace to the selected project with --add-dir so agy stays scoped to it.
    const args = ['-p', commandToSend, '--dangerously-skip-permissions'];
    if (cleanCwd) {
        args.push('--add-dir', cleanCwd);
    }
    // T-874(1)/T-875: pass --model only on session CREATION, or on a resume that
    // carries an EXPLICIT in-conversation re-pick. A plain resume omits --model so
    // agy keeps its brain's own model (the brain is agy's per-session model
    // memory), preventing a model pick made in another conversation from bleeding
    // in. The UI sends the catalog `value`; agy's --model wants the display label,
    // so resolveAgyModelLabel maps it (and returns null for auto/empty/unknown).
    const spawnModel = await resolveAgySpawnModel({ existingBrainUUID, sessionId, requestedModel: model });
    const agyModelLabel = await resolveAgyModelLabel(spawnModel);
    if (agyModelLabel) {
        args.push('--model', agyModelLabel);
    }
    if (existingBrainUUID) {
        args.push('--conversation', existingBrainUUID);
    }

    // B-N5: open the registry under a temporary connectionId so any payload
    // buffered before the real sessionId is known is retained, then rekey to the
    // sessionId below without loss/duplication. No-op when the flag is off.
    const connectionId = connectionIdFor(ws);
    let registryKey = connectionId;
    if (connectionId) {
        // A connectionId is per-socket and may be reused across runs on the same
        // long-lived socket. Cancel any pending post-close drop and clear a stale,
        // already-terminated buffer under it so this run's preamble never inherits
        // a prior run's payloads (B-N-RESUME clean buffer at the temporary key).
        cancelPendingDrop(connectionId);
        if (agySessionRegistry.enabled
            && agySessionRegistry.entries.has(connectionId)
            && !agySessionRegistry.isActive(connectionId)) {
            agySessionRegistry.drop(connectionId);
        }
        agySessionRegistry.open(connectionId);
    }

    // Establish (or reuse) the nassaj-side session id and persist it so the
    // chat history layer can correlate streamed messages with their session.
    let finalSessionId = sessionId;
    let isNewSession = false;
    if (!finalSessionId) {
        finalSessionId = generateNassajSessionId();
        isNewSession = true;
        sessionManager.createSession(finalSessionId, cwd || projectPath || process.cwd());
    }

    // B-40e: stamp sessionId on the writer as early as possible so SSE / API
    // callers that read ws.sessionId before the first stdout chunk get the correct
    // value rather than the temporary connectionId or a stale previous run's id.
    if (ws && ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(finalSessionId);
    }

    // B-N-RESUME (clean buffer): a new run for a sessionId that carries a prior,
    // already-terminated entry must NOT inherit the previous run's transcript.
    // Drop the stale entry (and cancel its pending post-close drop) before the
    // rekey so the buffer never crosses a run boundary. The fresh open() below
    // re-initialises an empty entry whose seq line starts at 0 — so a client that
    // reconnects with lastSeq absent/0 replays only THIS run from its start,
    // bounded by the current run (<= ring capacity), never a previous transcript.
    // We only reset an INACTIVE prior entry: a still-active entry under the same
    // sessionId means a live run we must not disturb (and the rekey below would
    // legitimately throw on that collision).
    if (finalSessionId) {
        cancelPendingDrop(finalSessionId);
        if (
            agySessionRegistry.enabled
            && finalSessionId !== connectionId
            && agySessionRegistry.entries.has(finalSessionId)
            && !agySessionRegistry.isActive(finalSessionId)
        ) {
            agySessionRegistry.drop(finalSessionId);
        }
    }

    // B-N5 rekey: hand the temporary connectionId buffer over to the real
    // sessionId. After this, registryKey is the sessionId and all subsequent
    // live payloads (and attach/isActive lookups) address the session directly.
    // B-40b: wrap in try/catch so a concurrent rekey collision (simultaneous
    // resume on the same socket) does not crash the spawn pipeline — fall back
    // to a fresh open under the finalSessionId instead.
    if (connectionId && finalSessionId && connectionId !== finalSessionId) {
        try {
            agySessionRegistry.rekey(connectionId, finalSessionId);
            registryKey = finalSessionId;
        } catch (rekeyErr) {
            console.warn('[agy] rekey failed (concurrent resume?); opening fresh entry:', rekeyErr?.message || rekeyErr);
            registryKey = finalSessionId;
        }
    }
    // Mark the session active in the single source of truth (B-N7). open() also
    // re-initialises a fresh empty entry after a clean-buffer drop above, so the
    // new run's seq line starts at 0 with no carried-over payloads.
    agySessionRegistry.open(registryKey);

    if (command) {
        sessionManager.addMessage(finalSessionId, 'user', command);
    }

    let sessionCreatedSent = false;
    let assistantText = '';
    let terminalNotified = false;

    // UTF-8 streaming decoder for agy's plain-text stdout. A multibyte char (e.g.
    // an Arabic letter = 2 bytes in UTF-8) can straddle a chunk boundary; decoding
    // each Buffer chunk independently with .toString() would split the sequence and
    // emit U+FFFD (�) mid-word. StringDecoder holds the incomplete trailing bytes
    // and prepends them to the next chunk, so characters are only emitted once whole.
    const stdoutDecoder = new StringDecoder('utf8');

    const safeSend = (payload) => {
        // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR): agy streams its
        // reply as stream_delta chunks (live deltas for new sessions, and the
        // transcript-derived final reply at close). Stamp the JWT-sourced
        // coordinatorId of the human who spawned this run so live viewers and
        // the spawner's mirrors attribute the reply to the real participant
        // instead of the session owner. Control events (session_created,
        // complete, error) carry no coordinatorId.
        const withCoordinator =
            payload.kind === 'stream_delta' && Number.isInteger(userId)
                ? { ...payload, coordinatorId: userId }
                : payload;
        const normalized = createNormalizedMessage({ ...withCoordinator, provider: 'antigravity' });
        // RingBuffer injection point (ADR-021): buffer the live payload under the
        // current registry key BEFORE forwarding, so a reconnecting socket can be
        // brought up to date via differential replay even if the original ws has
        // gone away. No-op when SESSION_REGISTRY_agy is off; buffering does not
        // depend on `ws` being present (the live stream may outlive the socket).
        agySessionRegistry.record(registryKey, normalized);
        if (!ws) return;
        try {
            ws.send(normalized);
        } catch (err) {
            // ws may close mid-stream; avoid crashing the spawn pipeline.
            console.error('[agy] failed to forward ws payload:', err?.message || err);
        }
    };

    const notifyTerminal = ({ code = null, error = null } = {}) => {
        if (terminalNotified) return;
        terminalNotified = true;

        // Live presence (B-MU-UX-PRESENCE): this brother is no longer active on
        // the session. agy does not flow through the process monitor, so the run
        // start/stop are reported to presence directly here.
        presenceRunStopped({ userId: ws?.userId ?? null, sessionId: finalSessionId });
        // Open-sessions counter: terminal state for this run. Safe even on the
        // spawn-failure path where the started call below never executed.
        openSessionStopped(finalSessionId);

        if (code === 0 && !error) {
            notifyRunStopped({
                userId: ws?.userId || null,
                provider: 'antigravity',
                sessionId: finalSessionId,
                sessionName: sessionSummary,
                stopReason: 'completed',
            });
            return;
        }

        notifyRunFailed({
            userId: ws?.userId || null,
            provider: 'antigravity',
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            error: error || getAgyExitMessage(code),
        });
    };

    let agProcess;
    try {
        // T-897: cage the agy spawn behind NASSAJ_PROVIDER_CAGE (default OFF ⇒
        // launch is returned unchanged, byte-identical to the previous spawn).
        const agyLaunch = resolveCagedLaunch({
            userId,
            provider: 'agy',
            cmd: AGY_PATH,
            args,
            cwd: cleanCwd,
        });
        agProcess = spawn(agyLaunch.cmd, agyLaunch.args, {
            cwd: cleanCwd,
            // Single source of truth for the spawn env. When agy is isolated for
            // this user (admin policy) the resolver overrides HOME to the per-user
            // root so the brain store lands in the isolated tree; when shared it
            // returns the operator env unchanged (ADR-016 default).
            env: resolveProviderEnv(userId, 'agy', process.env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        freeDiscoveryLock();
        // B-32: map spawn error to a structured code.
        const mapped = mapSpawnError(err);
        safeSend({ kind: 'error', code: mapped.code, content: mapped.fallbackMessage, sessionId: finalSessionId });
        notifyTerminal({ error: err });
        throw err;
    }

    activeSessions.set(finalSessionId, { process: agProcess, brainUUID: existingBrainUUID });

    // Live presence (B-MU-UX-PRESENCE): mark this brother active on the session
    // with its project path. userId is JWT-sourced (set on the writer), never
    // from client input; paired with the presenceRunStopped in notifyTerminal.
    presenceRunStarted({
        userId: ws?.userId ?? null,
        sessionId: finalSessionId,
        projectPath: cleanCwd,
        provider: 'antigravity',
    });

    // Open-sessions counter: agy does not flow through the process monitor, so
    // the run is reported here directly; paired with the openSessionStopped in
    // notifyTerminal. Counted regardless of userId — the counter is global.
    openSessionStarted(finalSessionId);

    // Record the authenticated human who spawned this agy run. Idempotent at the
    // DB layer; skipped for unauthenticated (single-user) runs with no userId.
    if (ws?.userId) {
        participantsDb.recordSpawn(finalSessionId, ws.userId, {
            provider: 'antigravity',
            projectPath: cleanCwd,
        });
        // Sender attribution (B-MU-UX-FIX-MSG-AUTHOR): record WHO authored this
        // prompt so history loads can stamp userId onto the matching USER_INPUT
        // turn. Best-effort — turns agy rewrites (e.g. injected resume
        // instructions) simply won't hash-match and stay unattributed.
        messageAuthorsDb.recordUserMessage(finalSessionId, ws.userId, command);
    }

    // Shared discovery state so the early stdout hook and the close-time safety
    // net cooperate and never double-register the same brain UUID.
    const discoveryState = { discovered: false, brainUUID: existingBrainUUID };

    return new Promise((resolve, reject) => {
        // Emit session_created on the first stdout chunk for new sessions so the
        // frontend can pin the conversation id before the stream finishes.
        agProcess.stdout.on('data', (chunk) => {
            // Decode through the streaming decoder so a multibyte char split across
            // this and the previous/next chunk is reassembled instead of producing �.
            const text = stdoutDecoder.write(chunk);
            if (!text) return;

            if (!sessionCreatedSent && isNewSession) {
                sessionCreatedSent = true;
                safeSend({
                    kind: 'session_created',
                    newSessionId: finalSessionId,
                    sessionId: finalSessionId,
                });
            }

            // Bind the real workspace path as early as possible — agy has already
            // materialized the brain folder by the time it streams output — so any
            // synchronize() that fires mid-run resolves the real project instead of
            // racing the close handler and writing the placeholder.
            if (!existingBrainUUID && !discoveryState.discovered) {
                discoverAndRegisterBrainSession(discoveryState, priorBrainIds, cleanCwd, finalSessionId, userId)
                    .then(() => {
                        // Release the discovery lock the moment a UUID is bound, so the
                        // window stays narrow and concurrent fresh spawns proceed.
                        if (discoveryState.discovered) {
                            freeDiscoveryLock();
                        }
                    })
                    .catch(() => { /* retried on next chunk / at close */ });
            }

            assistantText += text;
            // Resumed runs: raw stdout contains agy's replay of PREVIOUS turns,
            // so forwarding it live would re-show the old reply. Suppress the
            // live deltas and emit the transcript-derived reply at close;
            // assistantText is kept as a fallback only.
            if (!existingBrainUUID) {
                safeSend({ kind: 'stream_delta', content: text, sessionId: finalSessionId });
            }
        });

        agProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            // agy inherits node's deprecation noise; suppress it to keep the
            // chat transcript clean and avoid false error toasts on the client.
            if (!msg) return;
            if (msg.includes('DeprecationWarning') || msg.includes('[DEP')) return;
            console.error('[agy stderr]', msg.trim());
        });

        agProcess.on('close', async (code) => {
            activeSessions.delete(finalSessionId);

            // Flush any bytes the decoder is still holding. With well-formed UTF-8
            // this is empty (every char was completed by its following chunk); it
            // only yields content if agy emitted a truncated final sequence, in
            // which case StringDecoder substitutes � at the very end (correct: the
            // input itself was malformed) rather than mid-stream.
            const tail = stdoutDecoder.end();
            if (tail) {
                assistantText += tail;
                if (!existingBrainUUID) {
                    safeSend({ kind: 'stream_delta', content: tail, sessionId: finalSessionId });
                }
            }

            // Resumed run: surface the reply from the transcript steps appended
            // by THIS run, replacing the stdout text (which carries the replay
            // of previous turns). Falls back to the raw stdout text when the
            // transcript yields nothing new (write lag, layout change) so the
            // user never receives an empty reply.
            if (existingBrainUUID) {
                const newPlannerText = await readNewPlannerTextWithRetry(
                    existingBrainUUID,
                    userId,
                    preSpawnTranscript.lastStepIndex,
                );
                assistantText = newPlannerText || assistantText;
                if (assistantText) {
                    safeSend({ kind: 'stream_delta', content: assistantText, sessionId: finalSessionId });
                }
            }
            // B-N7: the run is terminal — flip the single source of truth to
            // inactive. The buffer is retained for a bounded post-close replay
            // window so a socket that reconnects right after close can still
            // replay the final payloads (attach is read-only and bounded by the
            // run's last seq); it is then dropped by scheduleBufferDrop below
            // (B-N-DROP), not "on the next run".
            agySessionRegistry.setActive(registryKey, false);

            // Safety net: a run that produced no stdout (or whose brain folder
            // appeared only at exit) skips the early discovery hook, so retry here.
            // discoverAndRegisterBrainSession is idempotent via discoveryState.
            if (!existingBrainUUID) {
                await discoverAndRegisterBrainSession(discoveryState, priorBrainIds, cleanCwd, finalSessionId, userId);
            }
            // Always release the discovery lock at close — covers runs that never
            // produced stdout or where discovery never bound a UUID.
            freeDiscoveryLock();
            const discoveredBrainUUID = existingBrainUUID ? null : discoveryState.brainUUID;

            // The DB row now carries the real path durably; drop the in-process
            // binding so the registry never grows unbounded across long uptimes.
            if (discoveredBrainUUID) {
                clearAntigravityProjectPath(discoveredBrainUUID);
            }

            if (assistantText) {
                sessionManager.addMessage(finalSessionId, 'assistant', assistantText);
            }

            // PDPL audit log — metadata only, never message content.
            // Session id is sufficient as an audit trail; client IP is intentionally omitted.
            console.log(JSON.stringify({
                audit: true,
                event: 'antigravity_session_end',
                timestamp: new Date().toISOString(),
                sessionId: finalSessionId,
                brainUUID: discoveredBrainUUID || existingBrainUUID || null,
                exitCode: code,
                provider: 'antigravity',
            }));

            safeSend({
                kind: 'complete',
                exitCode: code,
                isNewSession,
                sessionId: finalSessionId,
            });

            // Hand the conversation over to the id agy actually files it under.
            //
            // `agy_<ts>_<rand>` is a SPAWN KEY (see generateNassajSessionId) — the
            // brain UUID is the conversation identity: it is what the synchronizer
            // indexes, what carries jsonl_path, and what resolveBrainUUIDFromDb
            // resumes from. While the run is live, participants.recordSpawn creates
            // a stub sessions row for the spawn key to satisfy its FK, and nothing
            // ever reconciles it. The result is the reported symptom: the reply
            // streams in fine, then the chat is empty on the next load, because
            // fetchHistory reads jsonl_path and the stub has none — while the real
            // conversation shows up beside it as a second, separate chat.
            //
            // Codex already solves this by announcing its real id via
            // `session_created`; the client's handler is provider-agnostic and
            // migrates the open view (messages + pending permissions) onto the new
            // id. Sent AFTER `complete` on purpose: `complete` only clears the
            // spinner when its sessionId is the one on screen, so swapping first
            // would leave the view spinning.
            const boundBrainUUID = discoveryState.brainUUID || existingBrainUUID || null;
            if (boundBrainUUID && isRuntimeSpawnKey(finalSessionId)) {
                try {
                    // Make sure the destination exists before handing the client to
                    // it. On a fresh run discovery already wrote it; on a RESUME of
                    // a chat still addressed by an old spawn key it may only exist
                    // once the synchronizer has scanned. Sending the client to a
                    // row that is not there yet would show an empty chat — the very
                    // symptom this fixes. The upsert preserves custom_name and the
                    // archived flag.
                    sessionsDb.createSession(
                        boundBrainUUID,
                        'antigravity',
                        cleanCwd,
                        undefined,
                        undefined,
                        undefined,
                        buildTranscriptPath(boundBrainUUID, userId),
                    );
                    sessionsDb.adoptRuntimeSessionId(finalSessionId, boundBrainUUID);
                } catch (err) {
                    // Losing the stub cleanup must never break the turn; the swap
                    // below still gives the user a working conversation.
                    console.error('[agy] failed to adopt runtime session id:', err?.message || err);
                }
                safeSend({
                    kind: 'session_created',
                    newSessionId: boundBrainUUID,
                    sessionId: boundBrainUUID,
                });
            }

            if (code !== 0) {
                safeSend({
                    kind: 'error',
                    content: getAgyExitMessage(code),
                    sessionId: finalSessionId,
                });
                notifyTerminal({ code });
                // B-N-DROP: schedule the buffer drop AFTER the terminal error is
                // emitted, so a socket reconnecting inside the retention window can
                // still replay the final payloads.
                scheduleBufferDrop(registryKey);
                // Resolve rather than reject so the WS dispatcher does not turn
                // a non-zero exit into a generic "websocket error" toast — the
                // structured error message above already informs the user.
                resolve({ code, sessionId: finalSessionId });
                return;
            }

            notifyTerminal({ code });
            // B-N-DROP: schedule the deferred buffer drop AFTER `complete` is
            // emitted — a post-close replay window, not an immediate drop.
            scheduleBufferDrop(registryKey);
            resolve({ code, sessionId: finalSessionId });
        });

        agProcess.on('error', (err) => {
            activeSessions.delete(finalSessionId);
            agySessionRegistry.setActive(registryKey, false);
            freeDiscoveryLock();
            safeSend({ kind: 'error', content: err.message, sessionId: finalSessionId });
            notifyTerminal({ error: err });
            // B-N-DROP: schedule the deferred buffer drop AFTER the terminal error
            // is emitted (post-close replay window), mirroring the close handler.
            scheduleBufferDrop(registryKey);
            reject(err);
        });
    });
}

function abortAntigravitySession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session?.process) return false;

    try {
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
    // Match the gemini adapter shape (array of session ids) so the
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
