import { spawn } from 'child_process';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import { withRuntimeInstructions as withCoordinationDirective } from './services/runtime-instructions.js';
import { messageAuthorsDb, participantsDb, sessionsDb } from './modules/database/index.js';
// Namespace import: a test that mocks the barrel without auditLogDb still links.
import * as databaseModule from './modules/database/index.js';
import { providerSecretsService } from './modules/providers/services/provider-secrets.service.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { createTurnTimer, settleTurnTiming } from './modules/providers/services/turn-timing.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, resolveOpenCodeBinaryPath, stampCoordinatorId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import { resolveInboxAttachment } from './utils/attachment-inbox.js';
import { provisionUserDirs, userConfigDir } from './services/isolation/provision-user-dirs.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { beginProviderRun } from './services/provider-run-presence.js';
import { refuseSpawnIfHarnessUpdating } from './modules/providers/harness-update/spawn-admission.js';
import { resolveCagedLaunch } from './services/isolation/provider-cage-wiring.js';
import { sanitizeVendorAgentEnv } from './services/isolation/sanitize-vendor-agent-env.js';
import {
  OPENCODE_CONFIG_SOURCE_ENV,
  OPENCODE_DISABLE_PROJECT_CONFIG_ENV,
  OPENCODE_PROJECT_CONFIG_SCOPE,
  assertOpenCodeBaseUrlAllowed,
  assertOpenCodeCarrierServerLocal,
  assertOpenCodeInlineConfigAllowed,
  assertOpenCodeProjectConfigAllowed,
  resolveOpenCodeConfigPath,
} from './services/isolation/opencode-baseurl-guard.js';
import {
  isOpenCodeSessionOnlyOnGrantTree,
  resolveOpenCodeDatabasePathForUser,
} from './modules/providers/list/opencode/opencode-home.js';
import { collectOpenCodeTurnSecrets } from './modules/providers/list/opencode/opencode-redaction-secrets.js';
import {
  createOpenCodeStderrReader,
  resolveOpenCodePermissionLaunch,
  withOpenCodePermissionEnv,
} from './modules/providers/list/opencode/opencode-run-permissions.js';
import {
  assertLocalModelAvailable,
  authorizedLocalModelServers,
  isLocalModel,
  localModelsEnabled,
} from './services/isolation/local-model-config.js';
import { watchLocalModelProgress } from './services/isolation/local-model-timeout.js';
import { materializeOpenCodeConfig } from './services/isolation/opencode-config-material.js';
import { ensureOpenCodeGovernance } from './modules/providers/list/opencode/opencode-governance.js';
import {
  authorizeQwenPlanLaunch,
  createRedactingLineAssembler,
  isQwenPlanModel,
  redactLiteralSecrets,
  withQwenPlanEnv,
} from './services/isolation/opencode-qwen-plan.js';
import {
  authorizeSpawnVendorLaunch,
  canonicalSpawnVendorModel,
  sessionOnGrantTreeRefusal,
  spawnVendorAuditModel,
  spawnVendorOrigins,
  spawnVendorRunOf,
  withSpawnVendorEnv,
} from './services/isolation/opencode-spawn-vendor.js';

/** User-facing text per qwen-plan refusal code (codes are the contract). */
const QWEN_PLAN_REFUSAL_TEXT = Object.freeze({
  qwen_plan_disabled: 'تشغيل Alibaba Token Plan عبر OpenCode غير مفعّل على هذا الخادم.',
  missing_key: 'لا يوجد مفتاح Alibaba Token Plan شخصي محفوظ لحسابك.',
  legacy_profile: 'المفتاح المحفوظ من خطة قديمة لم تعد مدعومة؛ احذفه واحفظ مفتاح Token Plan.',
});

/** ADR-200 S8: user-facing text per spawn-vendor refusal code (Moonshot / DeepSeek). */
const SPAWN_VENDOR_REFUSAL_TEXT = Object.freeze({
  missing_key: 'لا يوجد مفتاح API شخصي محفوظ لحسابك لهذا المورّد. احفظ مفتاحك في إعدادات المورّدين.',
  subscription_token_refused: 'المفتاح المحفوظ لهذا المورّد ليس مفتاح API صالحاً له. احفظ مفتاح المورّد الصحيح.',
  session_on_grant_tree: 'هذه المحادثة محفوظة في مساحة العضو الذي منحك صلاحيته، ونماذج Moonshot وDeepSeek تعمل بمفتاحك وفي مساحتك أنت. ابدأ محادثة جديدة بهذا النموذج.',
});

/**
 * One audit row per qwen-plan launch decision (T-1906). Never the key or prompt.
 * @param {'qwen_execution_allowed'|'qwen_execution_rejected'} action
 * @param {string|number|null|undefined} userId
 * @param {Record<string, unknown>} metadata
 */
function auditQwenPlanTurn(action, userId, metadata) {
  const id = Number(userId);
  databaseModule.auditLogDb?.record(action, {
    userId: Number.isInteger(id) && id > 0 ? id : undefined,
    metadata: { engine: 'opencode', provider: 'qwen-plan', ...metadata },
  });
}

/**
 * One audit row per spawn-vendor launch decision (ADR-200 S8, M3). Metadata is
 * { vendor, model, code? } only — never the key or prompt.
 * @param {'spawn_vendor_execution_allowed'|'spawn_vendor_execution_rejected'} action
 * @param {string|number|null|undefined} userId
 * @param {{ id: string }} vendor
 * @param {Record<string, unknown>} metadata
 */
function auditSpawnVendorTurn(action, userId, vendor, metadata) {
  const id = Number(userId);
  databaseModule.auditLogDb?.record(action, {
    userId: Number.isInteger(id) && id > 0 ? id : undefined,
    metadata: { engine: 'opencode', vendor: vendor.id, ...metadata },
  });
}

/**
 * The user-facing error frame for a blocked carrier launch. A project-level opencode
 * config refusal (B-1367) gets its own code so the client can say exactly what to
 * fix; the offending file is named relative to the project, never as a host path.
 *
 * @param {any} guardError the thrown guard error
 * @param {Readonly<Record<string, string>>|null} refusalTexts the per-code texts of a
 *   qwen-plan or spawn-vendor run, or null for any other carrier run
 * @param {string} workingDir the project root
 * @returns {{ kind: 'error', code: string, content: string }}
 */
function carrierRefusalPayload(guardError, refusalTexts, workingDir) {
  if (guardError?.scope === OPENCODE_PROJECT_CONFIG_SCOPE) {
    const file = typeof guardError.file === 'string' ? guardError.file : '';
    const relative = file ? path.relative(workingDir, file) : '';
    const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative
      : path.basename(file || 'opencode.json');
    return {
      kind: 'error',
      code: 'opencode_project_config_refused',
      content: `تعذّر التشغيل: ملف إعداد OpenCode «${shown}» يحدّد عناوين مزوّدين أو MCP، وهذا ممنوع في هذا الوضع. أزِل أقسام provider وmcp منه أو احذفه ثم أعد الإرسال.`,
    };
  }
  return {
    kind: 'error',
    code: guardError?.code || 'opencode_carrier_blocked',
    content: guardError?.code === 'ENGINE_PROVIDER_UNAVAILABLE'
      ? 'خادم النموذج المحلي غير متاح. راجع إعدادات الخادم وصلاحية الوصول.'
      : refusalTexts?.[guardError?.code]
        || 'تعذّر تشغيل النموذج بسبب إعدادات الحوكمة أو الاتصال.',
  };
}

/**
 * @param {boolean} qwenPlanRun
 * @param {object|null} spawnVendor
 * @returns {Readonly<Record<string, string>>|null} the refusal texts of this run kind
 */
function refusalTextsFor(qwenPlanRun, spawnVendor) {
  if (qwenPlanRun) return QWEN_PLAN_REFUSAL_TEXT;
  return spawnVendor ? SPAWN_VENDOR_REFUSAL_TEXT : null;
}

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
  if (isLocalModel(resolvedModel) || isLocalModel(options?.model)) return true;
  // ADR-200 S8: a `moonshot/*` or `deepseek/*` turn under the spawn-vendor flag
  // (NASSAJ_OPENCODE_SPAWN_VENDORS, B-1575) runs the whole guard chain, independent of the GLM carrier flag.
  if (spawnVendorRunOf(resolvedModel, env) || spawnVendorRunOf(options?.model, env)) return true;
  if (!isOpenCodeCarrierEnabled(env)) {
    return false;
  }
  return options?.carrier === true
    || isOpenCodeCarrierModel(resolvedModel)
    || isOpenCodeCarrierModel(options?.model);
}

/**
 * Maps every local provider block the caller is allowed to run to ITS own endpoint
 * (ADR-163 §8, B-1268). Empty whenever the feature is off or the caller owns no
 * server, which keeps the GL-3 allowlist at the single vetted carrier host.
 *
 * @param {string|number|null} callerId
 * @returns {Record<string, string>} providerId → baseUrl
 */
function localServerOrigins(callerId) {
  return Object.fromEntries(authorizedLocalModelServers(callerId).map(server => [server.providerId, server.baseUrl]));
}

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

const activeOpenCodeProcesses = new Map();

function readOpenCodeSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.sessionID || event.sessionId || null;
}

function readOpenCodeTokenUsage(sessionId, userId = null, options = {}) {
  // OC-07: read the token totals from the SPAWNING user's opencode.db (their
  // isolated XDG data dir under isolation, the operator dir when shared).
  // B-1551 M1: a spawn-vendor turn passes honorGrants:false — its own tree.
  const dbPath = resolveOpenCodeDatabasePathForUser(userId, options);
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
 * already live under the project's .nassaj-uploads/inbox as cwd-relative paths.
 * B-1374: a file ref is attached ONLY when it really (realpath) resolves to a
 * regular file inside that inbox — an absolute path, a `..` climb or a symlink
 * leading out is dropped and counted in `rejectedFiles`. Returns the absolute
 * paths to attach plus the temp dir to clean up after the run (null when no
 * images were materialized). Fully defensive: a malformed entry is skipped,
 * never thrown, so a bad attachment can never abort the run.
 *
 * @param {Array<{data?: string}>} images base64 data-URL image objects
 * @param {Array<{path?: string, name?: string}>} files cwd-relative file refs
 * @param {string} cwd working directory (project root) holding the inbox
 * @returns {Promise<{ filePaths: string[], tempDir: string|null, rejectedFiles: number }>}
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
  let rejectedFiles = 0;
  for (const file of fileList) {
    const safePath = resolveInboxAttachment(cwd, file?.path);
    if (safePath) {
      filePaths.push(safePath);
    } else {
      rejectedFiles += 1;
    }
  }

  return { filePaths, tempDir, rejectedFiles };
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
  if (refuseSpawnIfHarnessUpdating('opencode', ws, {
    sessionId: options.sessionId,
    clientMsgId: options.clientMsgId,
  })) return;
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
    // B-822: response duration is server-measured wall clock, so it is
    // provider-neutral. OpenCode normalizes every stdout line into real
    // messages, so first model activity and the final assistant id are both
    // observable here.
    const turnTimer = createTurnTimer();
    let lastAssistantMessageId = null;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let opencodeProcess = null;
    // OC-22: temp dir holding materialized image attachments, cleaned on close.
    let attachmentsTempDir = null;
    let participantRecorded = false;
    let resolvedLocalRun = false;
    let localProgressWatch = null;
    // B-1298(b): the most recent specific provider error code (auth / context
    // overflow) seen on this run. Carried onto the terminal rejection so the WS
    // layer can surface it instead of only the generic dispatch fallback. It is a
    // fixed non-secret string — never the provider's raw message.
    let lastProviderErrorCode = null;
    // T-1906: the sender's Token Plan key on a qwen-plan run (else null).
    let qwenPlanKey = null;
    // ADR-200 S8: the sender's Moonshot / DeepSeek key on a spawn-vendor run (else null).
    let spawnVendorKey = null;
    // B-1551 M1: a spawn-vendor run uses the sender's OWN opencode data dir.
    let ownDataTreeRun = false;
    // ADR-200 §8 / M-6 (ingest): every key that can enter this sender's turn —
    // their vendor slots and auth.json, plus the grantor's under a grant (the
    // data home follows the grantor). Read up front so the resume-path prompt
    // record (made before launch authorization) is redacted too. Every byte of
    // child output and every DB write of user text is redacted before send/persist.
    const ingestSecrets = collectOpenCodeTurnSecrets(ws?.userId ?? null);

    // B-395: feed the process monitor so this run gets the same "Running" badge,
    // project busy dot and active-conversations entry a Claude run gets. A new
    // session has no id yet — registration then starts at registerSession below.
    const runPresence = beginProviderRun({
      provider: 'opencode',
      writer: ws,
      sessionId: capturedSessionId,
      projectPath: workingDir,
    });

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
      messageAuthorsDb.recordUserMessage(sid, ws.userId, redactLiteralSecrets(command, ingestSecrets));
    };

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // B-395: every terminal path (guard block, close, spawn error) funnels
      // through here, so this is the one place that reliably clears the badge.
      runPresence.end();
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
      // B-395: move the badge off the temporary process key onto the real id.
      runPresence.rekey(capturedSessionId);

      // New-session case: the id only exists once opencode emits it, so this is
      // the earliest point participation can be recorded (resume runs already
      // recorded upfront from the known sessionId below).
      recordParticipant(capturedSessionId);
      if (resolvedLocalRun) sessionsDb.setSessionEnginePin(capturedSessionId, 'local', 'server_verdict');

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          // B-1666: a fresh conversation, not a stale resume of the viewed one.
          parentSessionId: null,
          provider: 'opencode',
          ...(typeof options.clientMsgId === 'string' && options.clientMsgId
            ? { clientMsgId: options.clientMsgId }
            : {}),
        }));
      }
    };

    const processOpenCodeOutputLine = (rawLine) => {
      if (!rawLine || !rawLine.trim() || ws?.isRunOutputRevoked?.()) {
        return;
      }
      // T-1906: redact on the ASSEMBLED line, before parse/send/persist.
      const line = redactLiteralSecrets(rawLine, ingestSecrets);

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
          turnTimer.markModelActivity();
          // Live OpenCode text is normalized as `stream_delta` (it has no role),
          // while history is normalized later as `text/assistant`.  Treat the
          // live delta id as the answer id; requiring the history-only shape
          // leaves every live turn unmeasured.
          if (msg.kind === 'stream_delta' && msg.content?.trim()) {
            lastAssistantMessageId = msg.id;
            localProgressWatch?.touch();
          }
          // B-1298(b): remember a specific error code so the terminal rejection
          // can carry it to the client (auth failure / context overflow).
          if (msg.kind === 'error' && typeof msg.code === 'string' && msg.code) {
            lastProviderErrorCode = msg.code;
          }
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
      providerModelsService.resolveResumeModel('opencode', sessionId, model, ws?.userId ?? null),
      prepareOpenCodeAttachments(images, files, workingDir),
    ]).then(([resolvedModel, attachments]) => {
      attachmentsTempDir = attachments.tempDir;
      // B-1374: a rejected attachment refuses the WHOLE send before anything runs.
      // The client treats kind:'error' as the end of the turn, so the error is only
      // truthful when no process is started after it.
      if (attachments.rejectedFiles > 0) {
        console.warn('[OpenCode] send refused: attachment(s) outside the upload inbox', {
          count: attachments.rejectedFiles,
        });
        ws.send(createNormalizedMessage({
          kind: 'error',
          code: 'attachment_rejected',
          content: 'لم تُرسل رسالتك: أحد المرفقات ليس ملفاً مرفوعاً إلى هذا المشروع.',
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        runPresence.end();
        void cleanupOpenCodeTempDir(attachmentsTempDir);
        resolve();
        return;
      }
      // T-1854 (qa H1b): last await is the Promise.all; spawn follows synchronously.
      if (ws?.runFenceRevoked) {
        runPresence.end();
        void cleanupOpenCodeTempDir(attachmentsTempDir);
        resolve();
        return;
      }
      // B-1707 (owner ruling 2026-10-28): the mode Claude would run under for this
      // same request, through Claude's own resolver; refused exactly where Claude
      // refuses (parity enforce without full_delegation).
      let permissionLaunch;
      try {
        permissionLaunch = resolveOpenCodePermissionLaunch(options, {
          userId: ws?.userId ?? null,
          cwd: workingDir,
        });
      } catch (permissionError) {
        console.error('[OpenCode] launch refused by the permission resolver', {
          error: permissionError instanceof Error ? permissionError.message : String(permissionError),
        });
        ws.send(createNormalizedMessage({
          kind: 'error',
          code: 'permission_denied',
          content: 'The requested permission profile is unavailable.',
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        runPresence.end();
        void cleanupOpenCodeTempDir(attachmentsTempDir);
        reject(permissionError instanceof Error ? permissionError : new Error(String(permissionError)));
        return;
      }
      // Resume case: the session id is known before the process runs, and
      // registerSession short-circuits when it re-sees the same id, so record
      // participation here so a resumed opencode conversation stays "native".
      recordParticipant(sessionId);
      // ADR-200 S8: the vendor of a `moonshot/*` / `deepseek/*` RESOLVED model,
      // any case or models.dev alias (B-1551 M2); null unless
      // NASSAJ_OPENCODE_SPAWN_VENDORS is on — legacy path unchanged. Its id is
      // launched in canonical form so it names the inline provider block.
      const spawnVendor = spawnVendorRunOf(resolvedModel);
      ownDataTreeRun = spawnVendor !== null;
      const launchModel = spawnVendor ? canonicalSpawnVendorModel(resolvedModel) : resolvedModel;
      const args = ['run', '--format', 'json'];
      if (sessionId) {
        args.push('--session', sessionId);
      }
      if (launchModel) {
        args.push('--model', launchModel);
      }
      // B-1707: Claude bypass → skip flag, plan → `--agent plan`, else none.
      args.push(...permissionLaunch.args);
      // OC-22: attach images (materialized) and files via -f/--file, one per path.
      for (const attachmentPath of attachments.filePaths) {
        args.push('--file', attachmentPath);
      }
      // T-1315 (الموجة الثانية): مستوى تنسيق الجولة يُحقن في المطالبة — القناة
      // الوحيدة التي يملكها opencode (لا مفتاح عمقٍ موثَّقاً، فلا يُضبط اسمٌ بلا
      // قارئ). الحقن هنا عند بناء argv، بعد recordUserMessage أعلاه، فيبقى نصّ
      // المستخدم في السجلّ نظيفاً. الإنفاذ **نصّي** لا ميكانيكي.
      const promptToSend = withCoordinationDirective(
        command && command.trim() ? command.trim() : '',
        options.coordinationLevel,
      );
      if (promptToSend) {
        args.push(promptToSend);
      }

      // OC-06: resolve the binary through the OPENCODE_PATH knob instead of a
      // bare PATH lookup (PM2 does not see ~/.opencode/bin from .bashrc).
      // OC-07: build the child env through resolveProviderEnv so an isolated
      // user's XDG_* dirs point into their tree; shared mode returns the base
      // env unchanged (byte-for-byte the previous {...process.env}).
      // T-1906: a qwen-plan/* RESOLVED model is a carrier run (sanitized env,
      // binary pin, loopback confinement) regardless of the GLM carrier flag.
      const qwenPlanRun = isQwenPlanModel(resolvedModel);
      const carrierRun = qwenPlanRun || isOpenCodeCarrierRun(options, process.env, resolvedModel);
      resolvedLocalRun = isLocalModel(resolvedModel);
      // B-1268: every local-model step below is inert unless the manager activated the
      // feature AND this very turn resolved to a local model, so a plain GLM carrier
      // turn keeps the exact pre-ADR-163 sequence (no provisioning, no XDG override, no
      // config materialization) while all GL guards still run on the local role.
      const localFeatureOn = localModelsEnabled();
      const localRun = resolvedLocalRun && localFeatureOn;
      const pinnedLocalSession = Boolean(localFeatureOn && sessionId
        && sessionsDb.getSessionEnginePin(sessionId)?.engine === 'local');
      const opencodeBinary = resolveOpenCodeBinaryPath();
      // B-1551 M1 (owner decision): a spawn-vendor turn is not grantable, so it
      // also runs on the SENDER's own opencode data dir — the sender's key and
      // the session it writes never land in a grantor's opencode.db.
      let childEnv = spawnVendor
        ? resolveProviderEnv(ws?.userId ?? null, 'opencode', process.env, 'chat', { honorGrants: false })
        : resolveProviderEnv(ws?.userId ?? null, 'opencode');

      if (carrierRun || pinnedLocalSession) {
        // CARRIER MODE ONLY (GL-3/GL-5/GL-6, ADR-062). Every step below is skipped on
        // the legacy path so it stays byte-for-byte identical. Any refusal here BLOCKS
        // the spawn (fail-closed) and surfaces a generic user error.
        try {
          // GL-5: fail-closed governance gate — refuses an ungoverned carrier turn.
          const callerId = ws?.userId ?? null;
          if (qwenPlanRun) {
            // T-1906 / ADR-200 S7: kill switch and the SENDER's own Token Plan
            // key (ws.userId — never a credential-grant principal). Automation,
            // resume and API-key turns may spend it (D9).
            qwenPlanKey = authorizeQwenPlanLaunch({
              userId: callerId,
              getProfile: (id) => providerSecretsService.getQwenProfile(id),
            }).key;
          }
          if (spawnVendor) {
            // ADR-200 §4: the SENDER's own slot only — a grant holder spends their
            // own key or is refused with missing_key, never the grantor's.
            spawnVendorKey = authorizeSpawnVendorLaunch({
              vendor: spawnVendor,
              userId: callerId,
              getOwnKey: (id, slot) => providerSecretsService.getOwnVendorKey(id, slot),
            }).key;
            if (isOpenCodeSessionOnlyOnGrantTree(callerId, sessionId)) {
              throw sessionOnGrantTreeRefusal(spawnVendor.label);
            }
          }
          // ADR-088: a session pinned to the local engine may not silently continue on
          // another engine when its server/model disappeared.
          if (pinnedLocalSession && !resolvedLocalRun) {
            const error = new Error('خادم النموذج المحلي غير متاح.');
            error.code = 'ENGINE_PROVIDER_UNAVAILABLE';
            throw error;
          }
          assertLocalModelAvailable(callerId, resolvedModel);
          if (localRun && callerId != null) {
            provisionUserDirs(callerId);
            childEnv.XDG_CONFIG_HOME = userConfigDir(callerId, '.config');
          }
          ensureOpenCodeGovernance(callerId, localRun ? path.dirname(resolveOpenCodeConfigPath(childEnv)) : undefined);
          if (localRun && !materializeOpenCodeConfig(path.dirname(resolveOpenCodeConfigPath(childEnv)), { callerId })) {
            throw new Error('تعذّر تهيئة إعداد خادم النماذج.');
          }
          if (localRun && sessionId) sessionsDb.setSessionEnginePin(sessionId, 'local', 'server_verdict');
          // GL-3: baseURL allowlist over the per-user opencode.json (expands
          // ${VAR}/{env:…} BEFORE comparing each block's host to ITS approved origin:
          // `glm` → the vetted carrier host, `nassaj_local_*` → that row's own baseUrl.
          // The map is empty whenever the feature is off, so the allowlist collapses
          // back to api.z.ai alone.
          assertOpenCodeBaseUrlAllowed(resolveOpenCodeConfigPath(childEnv), childEnv, localServerOrigins(callerId));
          // No mandatory binary-digest pin here (owner decision 2026-09-29): the
          // carrier runs whatever opencode release the update button installed.
          // The opt-in NASSAJ_VENDOR_BINARY_PIN still applies at binary resolution.
          // GL-6: confine opencode's embedded local HTTP server to loopback so the
          // one-shot `run` never exposes a boot token/endpoint off-box.
          assertOpenCodeCarrierServerLocal(args);
          // SL-3: sanitize env as the LAST step before spawn — strip
          // CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_*/CLAUDE_* / inherited *_BASE_URL so the
          // carrier child can never inherit the owner's Claude subscription/routing.
          // B-1367: also strip OPENCODE_CONFIG / _DIR / _CONTENT — extra config
          // sources the GL-3 file check never sees (qwen-plan re-adds its own below).
          childEnv = sanitizeVendorAgentEnv(childEnv, { extraDeny: OPENCODE_CONFIG_SOURCE_ENV });
          // B-1367: opencode would merge the working tree's opencode.json(c), its
          // .opencode/ dirs (config, plugins) and project AGENTS.md over the per-user
          // file — a provider `api`, a `{file:…}` header or a plugin there could
          // reroute the carrier key. The switch makes opencode skip ALL of it at read
          // time (no check-then-read race); governance still comes from the per-user
          // $XDG_CONFIG_HOME/opencode/AGENTS.md, which it does not touch.
          childEnv[OPENCODE_DISABLE_PROJECT_CONFIG_ENV] = '1';
          // Defense in depth: still refuse a project file that declares endpoints,
          // in case a future opencode stops honoring the switch.
          assertOpenCodeProjectConfigAllowed(workingDir, childEnv, localServerOrigins(callerId));
          if (qwenPlanRun) {
            // Set AFTER sanitizing: the key and the inline provider block reach
            // this child only. Everything else strips NASSAJ_QWEN_PLAN_API_KEY.
            childEnv = withQwenPlanEnv(childEnv, qwenPlanKey);
            auditQwenPlanTurn('qwen_execution_allowed', callerId, { model: resolvedModel });
          }
          if (spawnVendor) {
            // Set AFTER sanitizing: only this vendor's key and its inline block
            // reach the child; the allowlist gains only this vendor's origin.
            childEnv = withSpawnVendorEnv(childEnv, spawnVendor, spawnVendorKey);
            assertOpenCodeInlineConfigAllowed(childEnv, spawnVendorOrigins(spawnVendor));
            auditSpawnVendorTurn('spawn_vendor_execution_allowed', callerId, spawnVendor, {
              model: spawnVendorAuditModel(resolvedModel),
            });
          }
        } catch (guardError) {
          qwenPlanKey = null;
          spawnVendorKey = null;
          if (qwenPlanRun) {
            auditQwenPlanTurn('qwen_execution_rejected', ws?.userId ?? null, {
              model: resolvedModel,
              code: guardError?.code || 'opencode_carrier_blocked',
            });
          }
          if (spawnVendor) {
            auditSpawnVendorTurn('spawn_vendor_execution_rejected', ws?.userId ?? null, spawnVendor, {
              model: spawnVendorAuditModel(resolvedModel),
              code: guardError?.code || 'opencode_carrier_blocked',
            });
          }
          const finalSessionId = capturedSessionId || sessionId || processKey;
          console.error('[OpenCode] carrier launch BLOCKED by a governance/compliance guard', {
            code: guardError?.code || null,
            reason: guardError?.reason || null,
            error: guardError instanceof Error ? guardError.message : String(guardError),
          });
          ws.send(createNormalizedMessage({
            ...carrierRefusalPayload(guardError, refusalTextsFor(qwenPlanRun, spawnVendor), workingDir),
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
          notifyTerminalState({ error: guardError });
          reject(guardError instanceof Error ? guardError : new Error(String(guardError)));
          return;
        }
      }

      // B-1707: OPENCODE_PERMISSION is nassaj's own (plan = edit/bash deny) or absent;
      // set last, after every sanitize step, so an inherited one never reaches opencode.
      childEnv = withOpenCodePermissionEnv(childEnv, permissionLaunch.permission);

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

      if (resolvedLocalRun) {
        localProgressWatch = watchLocalModelProgress(opencodeProcess, () => {
          ws.send(createNormalizedMessage({
            kind: 'error', code: 'LOCAL_MODEL_TIMEOUT',
            content: 'توقف الخادم المحلي عن تقديم استجابة. تحقق من تشغيل الخادم ثم أعد المحاولة.',
            sessionId: capturedSessionId || sessionId || null, provider: 'opencode',
          }));
        });
      }
      activeOpenCodeProcesses.set(processKey, opencodeProcess);
      // B-395: a real pid buys frozen (kill -STOP) detection and dead-child
      // reaping on top of the badge.
      runPresence.setPid(opencodeProcess.pid);
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

      // T-1906: stderr is line-assembled so a key split across two chunks is
      // still redacted before it reaches ws.send (and so every mirror).
      const stderrLines = createRedactingLineAssembler(ingestSecrets);
      // B-1707: one honest error per auto-rejected permission per turn, and one for a
      // usage dump (refused argv), instead of unclassified stderr cards.
      const stderrReader = createOpenCodeStderrReader();
      const sendStderrLines = (lines) => {
        const plainLines = [];
        for (const line of lines) {
          const verdict = stderrReader.read(line);
          if (verdict.kind === 'plain') {
            plainLines.push(line);
            continue;
          }
          if (verdict.kind === 'drop') continue;
          // The closing frame of a failed run carries the same code (P3).
          lastProviderErrorCode = verdict.error.code;
          ws.send(createNormalizedMessage({
            kind: 'error',
            ...verdict.error,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'opencode',
          }));
        }
        const stderrText = plainLines.join('\n');
        if (!stderrText.trim()) {
          return;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      };
      opencodeProcess.stderr.on('data', (data) => {
        sendStderrLines(stderrLines.push(data.toString()));
      });

      opencodeProcess.on('close', async (code) => {
        if (opencodeProcess.nassajAborted && code === 0) code = 1;
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        // OC-22: remove materialized image temp files once the run has ended.
        await cleanupOpenCodeTempDir(attachmentsTempDir);
        attachmentsTempDir = null;

        if (stdoutLineBuffer.trim() && !ws?.isRunOutputRevoked?.()) {
          processOpenCodeOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }
        sendStderrLines(stderrLines.flush());

        const tokenBudget = readOpenCodeTokenUsage(finalSessionId, ws?.userId ?? null, {
          honorGrants: !ownDataTreeRun,
        });
        if (tokenBudget) {
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
        }

        // Only a clean exit that actually produced an answer is measured;
        // an unknown duration must stay unknown rather than become a zero.
        const durableTiming = code === 0
          ? settleTurnTiming({
            sessionId: finalSessionId,
            assistantMessageId: lastAssistantMessageId,
            startedAt: turnTimer.startedAt(),
            completedAt: new Date().toISOString(),
          })
          : {};

        ws.send(createNormalizedMessage({
          kind: 'complete',
          exitCode: code,
          isNewSession: !sessionId && !!command,
          sessionId: finalSessionId,
          provider: 'opencode',
          ...durableTiming,
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
        const closeError = new Error(code === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${code}`);
        // B-1298(b): attach the fixed non-secret provider code so the WS catch can
        // surface a specific, displayable reason (no raw message travels with it).
        if (lastProviderErrorCode) closeError.providerErrorCode = lastProviderErrorCode;
        reject(closeError);
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

  process.nassajAborted = true;
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
  // Exported for the B-1374 attachment-confinement test.
  prepareOpenCodeAttachments,
};
