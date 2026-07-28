import { spawn } from 'child_process';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import { messageAuthorsDb, participantsDb } from './modules/database/index.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, resolveOpenCodeBinaryPath, stampCoordinatorId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { resolveCagedLaunch } from './services/isolation/provider-cage-wiring.js';
import { verifyVendorBinaryDigest } from './services/isolation/vendor-binary-integrity.js';
import { sanitizeVendorAgentEnv } from './services/isolation/sanitize-vendor-agent-env.js';
import {
  assertOpenCodeBaseUrlAllowed,
  assertOpenCodeCarrierServerLocal,
  resolveOpenCodeConfigPath,
} from './services/isolation/opencode-baseurl-guard.js';
import { resolveOpenCodeDatabasePathForUser } from './modules/providers/list/opencode/opencode-home.js';
import { ensureOpenCodeGovernance } from './modules/providers/list/opencode/opencode-governance.js';

/** Fleet flag gating the GLM OpenCode carrier (GL-8 / OCC-15). Default OFF. */
const OPENCODE_CARRIER_FLAG = 'NASSAJ_OPENCODE_CARRIER';

/** @param {NodeJS.ProcessEnv} [env] @returns {boolean} whether the carrier flag is armed */
function isOpenCodeCarrierEnabled(env = process.env) {
  const raw = env?.[OPENCODE_CARRIER_FLAG];
  if (typeof raw !== 'string') {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/** The opencode provider id GLM is carried under (GL-9): model ids read `glm/<id>`. */
const OPENCODE_CARRIER_MODEL_PREFIX = 'glm/';

/**
 * True when the model actually handed to `opencode run --model` is a GLM carrier
 * model. This is the honest signal for "this turn talks to z.ai", independent of
 * which provider id the UI used to start it.
 *
 * @param {unknown} model
 * @returns {boolean}
 */
function isOpenCodeCarrierModel(model) {
  return typeof model === 'string' && model.trim().startsWith(OPENCODE_CARRIER_MODEL_PREFIX);
}

/**
 * A run is a CARRIER run only when the fleet flag is armed AND the turn is
 * GLM-bound — either because the dispatch explicitly asked for carrier mode
 * (options.carrier === true, wired by GL-8 for the historical `glm` provider id)
 * or because the RESOLVED model is a `glm/*` id.
 *
 * The model clause exists because GLM is no longer selectable as a provider of
 * its own (owner decision 2026-07-26): the only way to reach it is picking
 * OpenCode + a `glm/*` model, which arrives here with `carrier` unset. Without
 * this clause that — now sole — path would silently skip the whole ADR-062 guard
 * chain (governance gate, baseURL allowlist, binary pin, loopback confinement,
 * env sanitization) that the old provider-`glm` path always ran through.
 *
 * Flag OFF keeps the byte-for-byte-unchanged legacy path on every branch.
 *
 * @param {{ carrier?: boolean }} options
 * @param {NodeJS.ProcessEnv} [env]
 * @param {unknown} [resolvedModel] The model id actually passed to `--model`.
 * @returns {boolean}
 */
function isOpenCodeCarrierRun(options, env = process.env, resolvedModel = undefined) {
  if (!isOpenCodeCarrierEnabled(env)) {
    return false;
  }
  return options?.carrier === true
    || isOpenCodeCarrierModel(resolvedModel)
    || isOpenCodeCarrierModel(options?.model);
}

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

const activeOpenCodeProcesses = new Map();

function readOpenCodeSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.sessionID || event.sessionId || null;
}

function readOpenCodeTokenUsage(sessionId, userId = null) {
  // OC-07: read the token totals from the SPAWNING user's opencode.db (their
  // isolated XDG data dir under isolation, the operator dir when shared).
  const dbPath = resolveOpenCodeDatabasePathForUser(userId);
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session)').all();
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(sessionId);

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * OC-22: prepares attachment file paths for `opencode run --file`.
 *
 * opencode's `-f/--file` flag takes on-disk file PATHS (an array). Images arrive
 * as base64 data URLs, so they are written to per-run temp files; uploaded files
 * already live under the project's .nassaj-uploads/inbox as cwd-relative paths,
 * so they are resolved against the working dir. Returns the absolute paths to
 * attach plus the temp dir to clean up after the run (null when no images were
 * materialized). Fully defensive: a malformed entry is skipped, never thrown, so
 * a bad attachment can never abort the run.
 *
 * @param {Array<{data?: string}>} images base64 data-URL image objects
 * @param {Array<{path?: string, name?: string}>} files cwd-relative file refs
 * @param {string} cwd working directory the file paths resolve against
 * @returns {Promise<{ filePaths: string[], tempDir: string|null }>}
 */
async function prepareOpenCodeAttachments(images, files, cwd) {
  const filePaths = [];
  let tempDir = null;

  const imageList = Array.isArray(images) ? images : [];
  if (imageList.length > 0) {
    try {
      tempDir = path.join(os.tmpdir(), 'nassaj-opencode-images', Date.now().toString());
      await fs.mkdir(tempDir, { recursive: true });
      for (const [index, image] of imageList.entries()) {
        const matches = typeof image?.data === 'string'
          ? image.data.match(/^data:([^;]+);base64,(.+)$/)
          : null;
        if (!matches) {
          continue;
        }
        const [, mimeType, base64Data] = matches;
        const extension = mimeType.split('/')[1] || 'png';
        const filepath = path.join(tempDir, `image_${index}.${extension}`);
        await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
        filePaths.push(filepath);
      }
    } catch (error) {
      console.error('[OpenCode] Failed to materialize image attachments:', error?.message || error);
    }
  }

  const fileList = Array.isArray(files) ? files : [];
  for (const file of fileList) {
    const relOrAbs = typeof file?.path === 'string' ? file.path : null;
    if (!relOrAbs) {
      continue;
    }
    filePaths.push(path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(cwd, relOrAbs));
  }

  return { filePaths, tempDir };
}

/** Best-effort removal of the per-run temp image dir (OC-22). Never throws. */
async function cleanupOpenCodeTempDir(tempDir) {
  if (!tempDir) {
    return;
  }
  await fs.rm(tempDir, { recursive: true, force: true }).catch((error) => {
    console.error('[OpenCode] Failed to remove temp attachment dir:', error?.message || error);
  });
}

async function spawnOpenCode(command, options = {}, ws) {
  // B-31: verify the project directory exists before spawning OpenCode.
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      if (ws) {
        ws.send(createNormalizedMessage(
          buildCwdMissingPayload(cwdCheck.error, { sessionId: options.sessionId || null, provider: 'opencode' })
        ));
      }
      return;
    }
  }

  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, sessionSummary, images, files } = options;
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = sessionId || null;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let opencodeProcess = null;
    // OC-22: temp dir holding materialized image attachments, cleaned on close.
    let attachmentsTempDir = null;
    let participantRecorded = false;

    // Record the authenticated human who spawned this opencode run as a session
    // participant + prompt author, mirroring claude-sdk.js:1321/1328 (T-857,
    // part أ). Once per spawn (idempotent at the DB layer too) and only when the
    // WS is authenticated — anonymous/single-user runs carry no userId. This is
    // what makes a UI-started opencode session pass the "native session"
    // predicate and appear in the conversations list; the synchronizer's
    // data-provenance attribution (part ب) covers only externally-created (TUI)
    // sessions that never reach this spawn path.
    const recordParticipant = (sid) => {
      if (participantRecorded || !sid || !ws?.userId) {
        return;
      }
      participantRecorded = true;
      participantsDb.recordSpawn(sid, ws.userId, {
        provider: 'opencode',
        projectPath: workingDir,
      });
      messageAuthorsDb.recordUserMessage(sid, ws.userId, command);
    };

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'opencode',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `OpenCode CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      if (processKey !== capturedSessionId && opencodeProcess) {
        activeOpenCodeProcesses.delete(processKey);
        activeOpenCodeProcesses.set(capturedSessionId, opencodeProcess);
      }
      if (opencodeProcess) {
        opencodeProcess.sessionId = capturedSessionId;
      }

      // New-session case: the id only exists once opencode emits it, so this is
      // the earliest point participation can be recorded (resume runs already
      // recorded upfront from the known sessionId below).
      recordParticipant(capturedSessionId);

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'opencode',
        }));
      }
    };

    const processOpenCodeOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR).
        ws.send(stampCoordinatorId(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }), ws?.userId));
        return;
      }

      try {
        registerSession(readOpenCodeSessionId(response));
        const normalized = sessionsService.normalizeMessage(
          'opencode',
          response,
          capturedSessionId || sessionId || null,
        );
        for (const msg of normalized) {
          // Coordinator attribution (B-MU-UX-FIX-ASSISTANT-AUTHOR): tag assistant
          // output with the JWT-sourced spawner so viewers attribute it correctly.
          stampCoordinatorId(msg, ws?.userId);
          ws.send(msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[OpenCode] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      }
    };

    Promise.all([
      providerModelsService.resolveResumeModel('opencode', sessionId, model),
      prepareOpenCodeAttachments(images, files, workingDir),
    ]).then(([resolvedModel, attachments]) => {
      attachmentsTempDir = attachments.tempDir;
      // Resume case: the session id is known before the process runs, and
      // registerSession short-circuits when it re-sees the same id, so record
      // participation here so a resumed opencode conversation stays "native".
      recordParticipant(sessionId);
      const args = ['run', '--format', 'json'];
      if (sessionId) {
        args.push('--session', sessionId);
      }
      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }
      // OC-22: attach images (materialized) and files via -f/--file, one per path.
      for (const attachmentPath of attachments.filePaths) {
        args.push('--file', attachmentPath);
      }
      if (command && command.trim()) {
        args.push(command.trim());
      }

      // OC-06: resolve the binary through the OPENCODE_PATH knob instead of a
      // bare PATH lookup (PM2 does not see ~/.opencode/bin from .bashrc).
      // OC-07: build the child env through resolveProviderEnv so an isolated
      // user's XDG_* dirs point into their tree; shared mode returns the base
      // env unchanged (byte-for-byte the previous {...process.env}).
      const carrierRun = isOpenCodeCarrierRun(options, process.env, resolvedModel);
      const opencodeBinary = resolveOpenCodeBinaryPath();
      let childEnv = resolveProviderEnv(ws?.userId ?? null, 'opencode');

      if (carrierRun) {
        // CARRIER MODE ONLY (GL-3/GL-5/GL-6, ADR-062). Every step below is skipped on
        // the legacy path so it stays byte-for-byte identical. Any refusal here BLOCKS
        // the spawn (fail-closed) and surfaces a generic user error.
        try {
          // GL-5: fail-closed governance gate — refuses an ungoverned carrier turn.
          ensureOpenCodeGovernance(ws?.userId ?? null);
          // GL-3: baseURL allowlist over the per-user opencode.json (expands
          // ${VAR}/{env:…} BEFORE comparing the host to the vetted carrier host).
          assertOpenCodeBaseUrlAllowed(resolveOpenCodeConfigPath(childEnv), childEnv);
          // GL-6: MANDATORY sha256 pin of the opencode binary in carrier mode
          // (independent of the NASSAJ_VENDOR_BINARY_PIN flag) — checks the FINAL
          // resolved path (M-4), refusing spawn on any deviation from 1.17.18.
          verifyVendorBinaryDigest('opencode', opencodeBinary, { enforced: true });
          // GL-6: confine opencode's embedded local HTTP server to loopback so the
          // one-shot `run` never exposes a boot token/endpoint off-box.
          assertOpenCodeCarrierServerLocal(args);
          // SL-3: sanitize env as the LAST step before spawn — strip
          // CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_*/CLAUDE_* / inherited *_BASE_URL so the
          // carrier child can never inherit the owner's Claude subscription/routing.
          childEnv = sanitizeVendorAgentEnv(childEnv);
        } catch (guardError) {
          const finalSessionId = capturedSessionId || sessionId || processKey;
          console.error('[OpenCode] carrier launch BLOCKED by a governance/compliance guard', {
            code: guardError?.code || null,
            reason: guardError?.reason || null,
            error: guardError instanceof Error ? guardError.message : String(guardError),
          });
          ws.send(createNormalizedMessage({
            kind: 'error',
            code: guardError?.code || 'opencode_carrier_blocked',
            content: 'OpenCode carrier launch blocked: nassaj governance/compliance guard.',
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
          notifyTerminalState({ error: guardError });
          reject(guardError instanceof Error ? guardError : new Error(String(guardError)));
          return;
        }
      }

      // T-897: cage the opencode spawn behind NASSAJ_PROVIDER_CAGE (default OFF
      // ⇒ launch returned unchanged; byte-identical to the previous spawn).
      const opencodeLaunch = resolveCagedLaunch({
        userId: ws?.userId ?? null,
        provider: 'opencode',
        cmd: opencodeBinary,
        args,
        cwd: workingDir,
      });
      opencodeProcess = spawnFunction(opencodeLaunch.cmd, opencodeLaunch.args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      });

      activeOpenCodeProcesses.set(processKey, opencodeProcess);
      opencodeProcess.sessionId = processKey;
      opencodeProcess.stdin.end();

      opencodeProcess.stdout.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processOpenCodeOutputLine(line.trim());
        });
      });

      opencodeProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        if (!stderrText.trim()) {
          return;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      });

      opencodeProcess.on('close', async (code) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        // OC-22: remove materialized image temp files once the run has ended.
        await cleanupOpenCodeTempDir(attachmentsTempDir);
        attachmentsTempDir = null;

        if (stdoutLineBuffer.trim()) {
          processOpenCodeOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        const tokenBudget = readOpenCodeTokenUsage(finalSessionId, ws?.userId ?? null);
        if (tokenBudget) {
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
        }

        ws.send(createNormalizedMessage({
          kind: 'complete',
          exitCode: code,
          isNewSession: !sessionId && !!command,
          sessionId: finalSessionId,
          provider: 'opencode',
        }));

        if (code === 0) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        if (code === 127 || code === null) {
          const installed = await providerAuthService.isProviderInstalled('opencode');
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/',
              sessionId: finalSessionId,
              provider: 'opencode',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${code}`));
      });

      opencodeProcess.on('error', async (error) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        // OC-22: clean up materialized image temp files on spawn failure too.
        await cleanupOpenCodeTempDir(attachmentsTempDir);
        attachmentsTempDir = null;

        // B-32: map spawn errors to structured codes.
        const installed = await providerAuthService.isProviderInstalled('opencode');
        let errorCode;
        let errorContent;
        if (!installed) {
          errorCode = 'cli_not_installed';
          errorContent = 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/';
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
          provider: 'opencode',
        }));
        notifyTerminalState({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

function abortOpenCodeSession(sessionId) {
  const process = activeOpenCodeProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  process.kill('SIGTERM');
  activeOpenCodeProcesses.delete(sessionId);
  return true;
}

function isOpenCodeSessionActive(sessionId) {
  return activeOpenCodeProcesses.has(sessionId);
}

function getActiveOpenCodeSessions() {
  return Array.from(activeOpenCodeProcesses.keys());
}

export {
  spawnOpenCode,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
  // Exported for behavioral tests of the carrier-detection seam (no source grep).
  isOpenCodeCarrierRun,
};
