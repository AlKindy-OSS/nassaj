// Hermes (Nous) CLI adapter.
// Mirrors the lifecycle contract of opencode-cli.js so the chat WebSocket layer
// can dispatch `hermes-command` identically to `opencode-command`, but:
//   * the binary is `hermes` invoked headless as `hermes -z PROMPT [-m MODEL]`,
//     which loads its own Nous OAuth from ~/.hermes/auth.json and bypasses tool
//     permissions; it prints a plain-text reply on stdout (no JSON envelope).
//   * because Hermes has no session-id event and its synchronizer returns 0
//     (HermesSessionSynchronizer.synchronize → 0), the routing row in `sessions`
//     is written explicitly at spawn time. Without it getSessionProvider() returns
//     null and a resumed turn is mis-routed to Claude (the very bug T-205 fixes).
//   * plain-text stdout is piped line-by-line as `stream_delta` (the exact path
//     opencode uses for non-JSON lines), closed with `stream_end` before `complete`.
//     TRUTH ABOUT `-z` (measured 2026-08-08, B-592): oneshot prints ONLY the final
//     response text — no banner, no spinner, no tool previews — so that piping
//     arrives in ONE burst at completion, not progressively. There is zero output
//     while hermes works, which is why this adapter adds a start notice, a
//     low-noise progress heartbeat, and an absolute run timeout below.

import { spawn } from 'child_process';
import crypto from 'node:crypto';

import crossSpawn from 'cross-spawn';

import { withRuntimeInstructions as withCoordinationDirective } from './services/runtime-instructions.js';

import { readVendorReceiptInvocation } from './modules/providers/shared/vendor/vendor-receipt-identity.js';
import { createTurnTimer, settleTurnTiming } from './modules/providers/services/turn-timing.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { sessionsDb, participantsDb, messageAuthorsDb } from './modules/database/index.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { resolveCagedLaunch } from './services/isolation/provider-cage-wiring.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, stampCoordinatorId } from './shared/utils.js';
import { resolveCliExecutablePath } from './shared/cli-executable-path.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { beginProviderRun } from './services/provider-run-presence.js';
import { beginHarnessLaunch, refuseSpawnIfHarnessUpdating } from './modules/providers/harness-update/spawn-admission.js';
import { readHermesRuntimeConfig } from './modules/providers/list/hermes/hermes-runtime.js';
import {
  appendVendorTranscriptTurn,
  vendorTranscriptPath,
  writeVendorTranscriptMeta,
} from './modules/providers/shared/vendor/vendor-transcript.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

const activeHermesProcesses = new Map();

const HERMES_NOT_INSTALLED_MESSAGE =
  'Hermes CLI is not installed. Install it and run `hermes setup --portal`.';

// ---------------------------------------------------------------------------
// B-592 run watchdog — `-z` emits NOTHING until the final response lands, so a
// hung hermes is indistinguishable from a working one without our own timers.
// Measured 2026-08-08: a real turn sat 40+ minutes opening fresh Nous sockets
// in silence while the user stared at an empty screen.
//
// Absolute run timeout ONLY — deliberately no idle timeout: `-z` produces no
// progress signal at all, so any idle deadline would kill legitimately long
// turns. An idle watchdog waits for a real progress source (reading hermes'
// state.db) and is deferred until session mapping exists (B-591).
//
// HERMES_RUN_TIMEOUT_MS overrides the default; 0 disables the cap entirely
// (diagnostics only). Out-of-range values clamp instead of throwing.
// ---------------------------------------------------------------------------
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MIN_RUN_TIMEOUT_MS = 10 * 1000;
const MAX_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const KILL_GRACE_MS = 8 * 1000; // SIGTERM → SIGKILL escalation window
const HEARTBEAT_FIRST_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Resolves the absolute run timeout from HERMES_RUN_TIMEOUT_MS (0 = off). */
function resolveRunTimeoutMs() {
  const raw = Number(process.env.HERMES_RUN_TIMEOUT_MS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_RUN_TIMEOUT_MS;
  }
  if (raw === 0) {
    return 0;
  }
  return Math.min(Math.max(raw, MIN_RUN_TIMEOUT_MS), MAX_RUN_TIMEOUT_MS);
}

/**
 * Locale-neutral fallback for a live runner heartbeat.
 *
 * The wire also carries the raw `elapsedMs` value (the client is responsible
 * for its localized presentation).  Keeping this fallback in the same
 * day/hour/minute/second shape means older clients do not regress to a rounded
 * seconds-only counter.  Calendar months and years are intentionally not
 * inferred from a duration: without a calendar anchor, "month" is ambiguous.
 */
export function formatHermesElapsed(ms) {
  const totalMs = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
  if (totalMs < 1_000) return `${totalMs}ms`;

  const totalTenths = Math.floor(totalMs / 100);
  let wholeSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const days = Math.floor(wholeSeconds / 86_400);
  wholeSeconds %= 86_400;
  const hours = Math.floor(wholeSeconds / 3_600);
  wholeSeconds %= 3_600;
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || tenths || parts.length === 0) parts.push(`${seconds}.${tenths}s`);
  return parts.join(' ');
}

/**
 * Kills the hermes PROCESS GROUP (children first matter: hermes may spawn
 * tools). The spawn uses `detached: true` so the child owns its own pgid,
 * hence `-pid`. Falls back to killing the parent alone when the group kill is
 * refused (e.g. the group already collapsed).
 *
 * @param {import('child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function killHermesGroup(child, signal) {
  if (!child?.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone — close/error will finalise the lifecycle.
    }
  }
}

/**
 * Maps well-known Hermes stderr patterns to user-friendly messages.
 * The raw stderr is always written to the server log by the caller before
 * this function is invoked, so no diagnostic information is lost.
 *
 * @param {string} raw - Raw stderr text from the Hermes CLI process.
 * @returns {string} A human-friendly error string suitable for display.
 */
function mapHermesStderrToFriendlyMessage(raw) {
  const lower = raw.toLowerCase();

  // B-403 correction: this line was read as "free-tier quota exhausted" (B-91)
  // and that reading was wrong. `hermes -z` prints it for ANY turn that ends
  // without a final block — and the case measured on 2026-08-03 was an id the
  // endpoint rejects (`model_not_supported`, HTTP 400), which is what nassaj's
  // own invented catalog produced on every single pick. Quota is one cause
  // among several, so the message now names the real first suspect and points
  // at the request dump, where hermes writes the upstream error verbatim.
  if (lower.includes('no final response')) {
    return 'Hermes ended the turn without a response. The usual cause is a model '
      + 'the configured provider does not serve (HTTP 400 model_not_supported) — '
      + 'pick another model, or check the provider in ~/.hermes/config.yaml. '
      + 'The upstream error is in the newest ~/.hermes/sessions/request_dump_*.json.';
  }

  // The configured provider has no usable credential — hermes names it in the
  // message ("No access token found for Nous Portal login"). Re-login is per
  // provider, so keep hermes' own wording instead of assuming Nous.
  // One language must not be hard-coded into a layer the UI translates around
  // it (B-522): this string is rendered verbatim in chat, so the Arabic tail it
  // used to carry appeared mid-sentence in an English session. Hermes' own
  // wording leads; the advice follows in the same language as the rest of this
  // file's messages.
  if (lower.includes('no access token found')) {
    return `${raw.trim()} — sign in to the running provider from the re-authenticate `
      + 'button, or point `model.provider` in ~/.hermes/config.yaml at a provider '
      + 'that has a valid credential.';
  }

  // Authentication / token errors.
  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('invalid token')) {
    return 'Hermes authentication failed. Run `hermes setup --portal` to refresh your credentials.';
  }

  // Generic network connectivity issues.
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) {
    return 'Could not connect to the Hermes service. Check your network connection and try again.';
  }

  // Fallback: trim whitespace so multi-line blobs do not spill into the chat.
  return raw.trim();
}

async function spawnHermes(command, options = {}, ws) {
  // T-1749/ADR-159: refuse a new spawn while hermes is mid-update. hermes is
  // managed-external (never leased today), so this is a no-op guard kept for
  // parity/future-proofing across every spawn site.
  if (refuseSpawnIfHarnessUpdating('hermes', ws, { sessionId: options.sessionId, clientMsgId: options.clientMsgId })) return;
  // Mirror opencode B-31: verify the project directory exists before spawning.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      if (ws) {
        ws.send(createNormalizedMessage(
          buildCwdMissingPayload(cwdCheck.error, { sessionId: options.sessionId || null, provider: 'hermes' })
        ));
      }
      return;
    }
  }

  // B-592: ONE live run per nassaj session. A double-click or a client retry
  // while a turn is in flight must not spawn a second hermes: it would create a
  // second hermes session (double cost), and activeHermesProcesses keeps a
  // single entry per key, so the first run would become unreachable —
  // un-abortable and overwriting the terminal notifications of the second.
  // The rejection happens BEFORE any session row is created.
  if (options.sessionId && activeHermesProcesses.has(options.sessionId)) {
    if (ws) {
      // B-1078: the busy frame fans out to every mirror socket; echo the rejected
      // send's clientMsgId so only that bubble is withdrawn (as queryCodex does).
      const clientMsgIdField = typeof options.clientMsgId === 'string' && options.clientMsgId
        ? { clientMsgId: options.clientMsgId } : {};
      ws.send(createNormalizedMessage({
        kind: 'error',
        code: 'session_busy',
        content: 'This Hermes session is already processing a turn. Wait for it to finish or abort it first.',
        sessionId: options.sessionId,
        provider: 'hermes',
        ...clientMsgIdField,
      }));
    }
    return;
  }

  // T-1854 (qa H1b): last await is above; from here to spawn + registration
  // everything is synchronous, so a revoked run fence never spawns.
  if (ws?.runFenceRevoked) return;

  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, sessionSummary } = options;
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    const isNewSession = !sessionId;
    let capturedSessionId = sessionId || null;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    // B-599: what the user will see when they reopen this conversation. Hermes
    // keeps no transcript nassaj can read (`-z` starts a fresh hermes session
    // per turn), so the reply is accumulated here and written to nassaj's own
    // JSONL — the same store kimi/deepseek/glm use.
    const assistantChunks = [];
    // B-913: the app-owned transcript returns the persisted assistant ID used
    // by both final-response history and the successful-turn timing sidecar.
    const turnTimer = createTurnTimer();
    // Transcript writes are ordered but never block the stream: each append is
    // chained onto the previous one so meta → user → assistant keep their order,
    // and a rejection is swallowed (the append helper is best-effort by
    // contract).
    let transcriptChain = Promise.resolve();
    const queueTranscript = (write) => {
      transcriptChain = transcriptChain.then(() => {
        if (ws?.isRunOutputRevoked?.()) return undefined;
        return write();
      }).catch(() => {});
    };
    let hermesProcess = null;
    // B-395: assigned once the child is spawned (below); notifyTerminalState can
    // run before that on a pre-spawn failure, hence the null-safe declaration
    // here rather than a const at the spawn site (TDZ would throw).
    let runPresence = null;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      runPresence?.end(); // B-395: every terminal path funnels through here.
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'hermes',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'hermes',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Hermes CLI exited with code ${code}`,
      });
    };

    // New session: generate the UUID, write the routing row, announce session_created.
    if (isNewSession) {
      capturedSessionId = crypto.randomUUID();

      // Write the `sessions` routing row BEFORE the synchronizer (Hermes has none:
      // HermesSessionSynchronizer.synchronize returns 0). Since B-599 nassaj owns
      // the hermes transcript as a JSONL file (its own ~/.hermes store starts a
      // fresh session per turn and cannot reconstruct the conversation), so record
      // that file's path in jsonl_path — matching qwen-cli — instead of null; a
      // null column forced history reads onto the hash-only fallback and blanked
      // overlay-launched sessions whose file lived under a legacy hash. Without
      // this row getSessionProvider() returns null and the resumed turn is
      // mis-routed to Claude. Wrapped in try/catch (agy-cli pattern) so a DB
      // hiccup never blocks the run; the row also gives recordSpawn its parent for
      // the B-PRIV guard.
      try {
        const hermesTranscriptPath = vendorTranscriptPath('hermes', capturedSessionId, workingDir);
        sessionsDb.createSession(
          capturedSessionId, 'hermes', workingDir, undefined, undefined, undefined, hermesTranscriptPath,
        );
      } catch (err) {
        console.error('[hermes] failed to register session in DB:', err?.message || err);
      }

      // Transcript header first: it carries the project path and the session
      // title, and it must precede the turns for the file to read in order.
      queueTranscript(() => writeVendorTranscriptMeta('hermes', capturedSessionId, workingDir, command));

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'hermes',
      }));

      // T-874(2): hermes has no per-session model memory of its own (and its
      // adapter's changeActiveModel is intentionally not implemented), so pin this
      // new session to its creation-time model in nassaj's per-session store. For a
      // fresh session `model` IS the resolved selection; seeding is idempotent +
      // best-effort (no-op on an empty selection).
      // .catch() guards against an unhandled rejection escaping this
      // fire-and-forget seed and crashing the spawn (B-136 regression).
      void providerModelsService
        .seedSessionModel('hermes', capturedSessionId, model)
        .catch(() => {});
    }

    // Record the authenticated human who spawned this hermes run. Idempotent at
    // the DB layer; skipped for unauthenticated (single-user) runs. B-29: a
    // session enters the conversations list ONLY with a session_participants or
    // message_authors row — without this the hermes chat the user just started
    // never appears, even though its routing row was written above. recordSpawn
    // also bumps last_seen on resume. Both writes never throw (same policy as the
    // other adapters), so they need no try/catch.
    if (ws?.userId) {
      const participantSessionId = capturedSessionId || sessionId || processKey;
      participantsDb.recordSpawn(participantSessionId, ws.userId, {
        provider: 'hermes',
        projectPath: workingDir,
      });
      // Sender attribution (B-MU-UX-FIX-MSG-AUTHOR): record WHO authored this
      // prompt so history loads can stamp userId onto the matching user turn.
      if (command) {
        messageAuthorsDb.recordUserMessage(participantSessionId, ws.userId, command);
      }
    }

    // The user's own turn, recorded for BOTH sides of the conversation to survive
    // a reload — an assistant reply with no prompt above it is unreadable.
    if (command) {
      queueTranscript(() => appendVendorTranscriptTurn(
        'hermes',
        capturedSessionId || sessionId || processKey,
        workingDir,
        'user',
        command,
        { receipt: readVendorReceiptInvocation(options.vendorReceiptInvocation, command, ws?.userId) },
      ));
    }

    // Stream a single stdout line as stream_delta (opencode's non-JSON path). The
    // coordinator id stamp attributes the assistant text to the JWT-sourced spawner
    // so viewers/mirrors render the author correctly (B-MU-UX-FIX-ASSISTANT-AUTHOR).
    const emitLine = (line) => {
      if (!line || !line.trim() || ws?.isRunOutputRevoked?.()) {
        return;
      }
      turnTimer.markModelActivity();
      assistantChunks.push(line);
      ws.send(stampCoordinatorId(createNormalizedMessage({
        kind: 'stream_delta',
        content: line,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'hermes',
      }), ws?.userId));
    };

    // B-592: the run watchdog needs the same HOME the child will see, resolved
    // once up front (the spawn env below uses this exact object).
    const hermesEnv = resolveProviderEnv(ws?.userId ?? null, 'hermes', { ...process.env });
    const runTimeoutMs = resolveRunTimeoutMs();
    let runTimeoutTimer = null;
    let killEscalationTimer = null;
    let heartbeatTimer = null;
    let firstBeatTimer = null;
    let timedOut = false;
    let terminalError = null;
    const startedAt = Date.now();

    /** Single gate for every terminal path: stops the watchdog + heartbeat. */
    const clearRunTimers = () => {
      if (runTimeoutTimer) {
        clearTimeout(runTimeoutTimer);
        runTimeoutTimer = null;
      }
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
        killEscalationTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (firstBeatTimer) {
        clearTimeout(firstBeatTimer);
        firstBeatTimer = null;
      }
    };

    void Promise.all([
      providerModelsService.resolveResumeModel('hermes', sessionId, model),
      // B-592: read the runtime config from the SAME home the child process
      // receives below — the member's isolated tree, not the operator's.
      readHermesRuntimeConfig(hermesEnv.HOME),
    ]).then(([resolvedModel, hermesConfig]) => {
      // T-1854 (qa H1b): the model/config reads above are real I/O, so a
      // revocation can land here; from this point to spawn nothing awaits.
      if (ws?.runFenceRevoked) {
        resolve();
        return;
      }
      // Security: the prompt is a standalone argv entry, never string-concatenated.
      // `hermes -z` runs headless (loads OAuth, bypasses permissions); there is no
      // resume/conversation flag, so prior context is not replayed in this phase.
      // T-1315: مستوى تنسيق الجولة على المطالبة — قناة هرمز الوحيدة، والمطالبة
      // تبقى مدخلاً مستقلاً في argv بلا دمج نصّي (كما نصّ التعليق أعلاه).
      // الإنفاذ نصّي؛ لا مفتاح عمقٍ في هرمز.
      const args = ['-z', withCoordinationDirective(command, options?.coordinationLevel)];
      // B-403: `-m` alone NEVER switches endpoint. Measured on hermes 0.17.0:
      // `-m gpt-4o` auto-detects provider `openai` (unconfigured → hard error),
      // and a prefixed `-m copilot/gpt-4o` is ignored outright — the run still
      // goes to `model.provider` from config.yaml. So a pinned model is only
      // safe alongside the provider that hosts it, and hermes itself refuses
      // `--provider` without `--model` (oneshot.py: exit 2). Either both flags
      // or neither: with neither, hermes uses its own configured pair, which is
      // always internally consistent.
      if (resolvedModel && hermesConfig.provider) {
        args.push('-m', resolvedModel, '--provider', hermesConfig.provider);
      }

      // T-897: cage the hermes spawn behind NASSAJ_PROVIDER_CAGE (default OFF ⇒
      // launch returned unchanged; byte-identical to the previous spawn).
      const hermesLaunch = resolveCagedLaunch({
        userId: ws?.userId ?? null,
        provider: 'hermes',
        cmd: resolveCliExecutablePath('hermes'),
        args,
        cwd: workingDir,
      });
      // B-592: `detached: true` puts the child in its own process group so the
      // run watchdog can signal the WHOLE group (`process.kill(-pid, …)`) —
      // hermes spawns tool children that would otherwise outlive the parent and
      // keep a timed-out turn alive. stdout/stderr stay piped; `detached` does
      // not detach stdio.
      const releaseHarnessLaunch = beginHarnessLaunch('hermes');
      try {
        hermesProcess = spawnFunction(hermesLaunch.cmd, hermesLaunch.args, {
          cwd: workingDir, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: hermesEnv,
        });
      } catch (error) {
        releaseHarnessLaunch();
        throw error;
      }

      activeHermesProcesses.set(processKey, hermesProcess);
      hermesProcess.sessionId = processKey;

      // B-395: register the run with the process monitor so a Hermes turn gets
      // the same "Running" badge / busy dot / active-conversations entry a Claude
      // turn gets, plus frozen (kill -STOP) detection from the known pid.
      runPresence = beginProviderRun({
        provider: 'hermes',
        writer: ws,
        sessionId: capturedSessionId || processKey,
        projectPath: workingDir,
        pid: hermesProcess.pid,
        launchReservation: releaseHarnessLaunch,
      });
      // Re-key the active map to the real session id so abort/check-status from the
      // client (which carry the UUID) match the live process.
      if (capturedSessionId && capturedSessionId !== processKey) {
        activeHermesProcesses.delete(processKey);
        activeHermesProcesses.set(capturedSessionId, hermesProcess);
        hermesProcess.sessionId = capturedSessionId;
        runPresence.rekey(capturedSessionId); // B-395
      }
      hermesProcess.stdin.end();

      // B-592: tell the user a turn is running IMMEDIATELY. `-z` prints nothing
      // until completion, so without this the screen stays empty for the whole
      // run (minutes on a long turn). Status line only — not persisted.
      ws.send(createNormalizedMessage({
        kind: 'status',
        text: `Hermes is working — output appears when the reply is complete${runTimeoutMs > 0
          ? ` (timeout ${Math.round(runTimeoutMs / 60000)}m)`
          : ''}`,
        sessionId: capturedSessionId || processKey,
        provider: 'hermes',
      }));

      // Low-noise heartbeat: one beat at 30s, then every 60s while still silent.
      // The interval is created inside the first-beat callback so the cadence is
      // 30s / 90s / 150s… Both timers are unref'd: they must never keep the
      // server process alive, and every terminal path calls clearRunTimers().
      const sendHeartbeat = () => {
        if (!hermesProcess || timedOut) {
          return;
        }
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: `Hermes is still working — ${formatHermesElapsed(Date.now() - startedAt)} elapsed`,
          // Raw elapsed time is the authority for the client-side common
          // duration formatter.  Do not make clients parse the English fallback
          // string above.
          elapsedMs: Math.max(0, Date.now() - startedAt),
          sessionId: capturedSessionId || processKey,
          provider: 'hermes',
        }));
      };
      firstBeatTimer = setTimeout(() => {
        firstBeatTimer = null;
        sendHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref();
      }, HEARTBEAT_FIRST_MS);
      firstBeatTimer.unref();

      // Absolute run cap: SIGTERM the process group, escalate to SIGKILL after
      // the grace window, and tell the user ONCE what happened.
      if (runTimeoutMs > 0) {
        runTimeoutTimer = setTimeout(() => {
          timedOut = true;
          clearRunTimers();
          const finalSessionId = capturedSessionId || sessionId || processKey;
          ws.send(createNormalizedMessage({
            kind: 'error',
            code: 'timeout',
            content: `Hermes did not respond within ${Math.round(runTimeoutMs / 60000)} minutes `
              + `and the run was terminated. Tune HERMES_RUN_TIMEOUT_MS or retry.`,
            sessionId: finalSessionId,
            provider: 'hermes',
          }));
          killHermesGroup(hermesProcess, 'SIGTERM');
          killEscalationTimer = setTimeout(() => {
            killHermesGroup(hermesProcess, 'SIGKILL');
            killEscalationTimer = null;
          }, KILL_GRACE_MS);
          killEscalationTimer.unref();
        }, runTimeoutMs);
        runTimeoutTimer.unref();
      }

      hermesProcess.stdout.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';
        completeLines.forEach((line) => emitLine(line));
      });

      hermesProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        if (!stderrText.trim()) {
          return;
        }
        // Always log the raw stderr so operators can diagnose issues.
        console.error('[hermes] stderr:', stderrText.trimEnd());
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: mapHermesStderrToFriendlyMessage(stderrText),
          sessionId: capturedSessionId || sessionId || null,
          provider: 'hermes',
        }));
      });

      hermesProcess.on('close', async (code, signal) => {
        clearRunTimers();
        const succeeded = code === 0 && !signal && !timedOut && !terminalError
          && !hermesProcess.nassajAbortRequested;
        const exitCode = !succeeded && code === 0 ? 1 : code;
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeHermesProcesses.delete(finalSessionId);
        activeHermesProcesses.delete(processKey);

        // Flush any trailing partial line, then close the stream BEFORE complete so
        // the converter finalises the streaming assistant bubble (stream_end is a
        // control event) ahead of the terminal `complete`.
        if (stdoutLineBuffer.trim() && !ws?.isRunOutputRevoked?.()) {
          emitLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        // Capture after terminal parsing, before awaiting transcript storage.
        const processCompletedAt = new Date().toISOString();

        // Recorded on EVERY exit code, not just 0: a run that died halfway still
        // produced real text on screen, and history that silently drops it reads
        // as "the assistant never answered".
        const sawAssistantOutput = assistantChunks.length > 0;
        let assistantMessageId = null;
        if (assistantChunks.length > 0 && !ws?.isRunOutputRevoked?.()) {
          const finalText = assistantChunks.join('\n');
          queueTranscript(async () => {
            assistantMessageId = await appendVendorTranscriptTurn(
              'hermes', finalSessionId, workingDir, 'assistant', finalText,
              { finalAnswer: succeeded },
            );
          });
          assistantChunks.length = 0;
        }
        if (ws?.isRunOutputRevoked?.()) assistantChunks.length = 0;
        await transcriptChain;

        ws.send(createNormalizedMessage({
          kind: 'stream_end',
          sessionId: finalSessionId,
          provider: 'hermes',
        }));

        const durableTiming = succeeded && sawAssistantOutput && assistantMessageId
          ? settleTurnTiming({
            sessionId: finalSessionId,
            assistantMessageId,
            startedAt: turnTimer.startedAt(),
            completedAt: processCompletedAt,
          })
          : {};

        ws.send(createNormalizedMessage({
          kind: 'complete',
          exitCode,
          success: succeeded,
          isNewSession: isNewSession && !!command,
          sessionId: finalSessionId,
          provider: 'hermes',
          ...durableTiming,
        }));

        if (succeeded) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        // The timeout path already told the user exactly what happened (one
        // `timeout` error). Do not layer a second diagnosis on the same event;
        // close merely finalises the stream after the watchdog's kill.
        if (!timedOut && (code === 127 || code === null)) {
          const installed = await providerAuthService.isProviderInstalled('hermes');
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: HERMES_NOT_INSTALLED_MESSAGE,
              sessionId: finalSessionId,
              provider: 'hermes',
            }));
          }
        }

        notifyTerminalState({ code: exitCode, error: terminalError });
        reject(new Error(timedOut
          ? 'Hermes CLI run timed out and was terminated'
          : terminalError?.message || (hermesProcess.nassajAbortRequested || signal || code === null
            ? 'Hermes CLI process was terminated' : `Hermes CLI exited with code ${code}`)));
      });

      hermesProcess.on('error', async (error) => {
        terminalError = error;
        clearRunTimers();
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeHermesProcesses.delete(finalSessionId);
        activeHermesProcesses.delete(processKey);

        const installed = await providerAuthService.isProviderInstalled('hermes');
        let errorCode;
        let errorContent;
        if (!installed) {
          errorCode = 'cli_not_installed';
          errorContent = HERMES_NOT_INSTALLED_MESSAGE;
        } else {
          const mapped = mapSpawnError(error);
          errorCode = mapped.code;
          errorContent = mapped.fallbackMessage;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          code: errorCode,
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'hermes',
        }));
        notifyTerminalState({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

function abortHermesSession(sessionId) {
  const process = activeHermesProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  // B-592: signal the process GROUP — the child owns its pgid (detached spawn),
  // and tool children spawned by hermes must die with it.
  process.nassajAbortRequested = true;
  killHermesGroup(process, 'SIGTERM');
  activeHermesProcesses.delete(sessionId);
  return true;
}

function isHermesSessionActive(sessionId) {
  return activeHermesProcesses.has(sessionId);
}

function getActiveHermesSessions() {
  return Array.from(activeHermesProcesses.keys());
}

export {
  spawnHermes,
  abortHermesSession,
  isHermesSessionActive,
  getActiveHermesSessions,
};
