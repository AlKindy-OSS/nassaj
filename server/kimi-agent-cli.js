/**
 * kimi-agent-cli — KM-1 (ADR-062 §4.2, wave W3-A): the SOLE, governed launch
 * seam for the Kimi NATIVE agent CLI (`@moonshot-ai/kimi-code`, KG-1). Woven on
 * `server/gemini-cli.js` (the raw-spawn CLI precedent) + the codex governance
 * gate, this is a NEW file (not `server/kimi-cli.js`, the toolless chat path) so
 * the two Kimi surfaces never collide.
 *
 * THE MANDATORY SEAM ORDER (ADR-062 §4.2 KM-1 — do not reorder):
 *
 *   1. resolveProviderEnv(userId,'kimi', baseEnv,'agent')   [SL-5]
 *        → injects the user's KIMI_API_KEY + isolates KIMI_CODE_HOME per user.
 *   2. verifyVendorBinaryDigest('kimi', resolvedPath)       [SL-7/M-4]
 *        → refuses the spawn (throws) when the on-disk binary drifts from the
 *          root-of-trust pin. Verified AFTER the final path (KIMI_PATH override
 *          + PATH fallback) is resolved.
 *   3. ensureVendorCliGovernance('kimi', home, source)      [SL-2]
 *        → fail-closed: throws VendorGovernanceMissingError when nassaj
 *          governance (the neutral AGENTS.md COPY) cannot be attested. (Kimi's
 *          runtime OBEDIENCE is soft — enforced:false, no native bypass block,
 *          KM-4 — but nassaj still gates the LAUNCH on the governance file being
 *          present; the badge honesty is a separate concern.)
 *   4. mapPermissionModeToVendorFlags('kimi', mode, env)    [SL-4]
 *        → the one permission-ceiling chokepoint; a client mode can never widen
 *          the ceiling past an operator SERVER flag.
 *   5. resolveCagedLaunch({..., mode:'agent'})              [SL-6]
 *        → bwrap sandbox (per-user, credential-masked) when the cage flag is on.
 *   6. sanitizeVendorAgentEnv(env)  ★LAST STEP BEFORE spawn★ [SL-3/M-2]
 *        → strips CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_* / *_BASE_URL and sibling
 *          vendor keys from the child env. Applied LAST, on the env actually
 *          handed to spawn, so nothing between resolve and spawn can re-introduce
 *          a leak. This is the load-bearing IRON RULE / ToS defense (M-2/M-3).
 *
 * SINGLE LAUNCHER: this is the ONE registered spawn site for the kimi binary
 * (VENDOR_AGENT_LAUNCHER_REGISTRY, sanitized:true). The grep-gate
 * (vendor-single-launcher.guard.test.ts) fails the build if a second, unregistered
 * kimi launcher appears — forcing it through this sanitized seam.
 *
 * TRANSPORT: headless `-p/--prompt` + `--output-format stream-json` + `-S/-c`
 * session resume (KG-1 §1.1). A DESIGN NOTE (KM-1): `kimi acp` (Agent Client
 * Protocol over stdio) is a cleaner future seam than raw stdout parsing; it is
 * left for a follow-up once the CLI is installed and the ACP surface is verified
 * live (G-KIMI-LIVE). The stream-json field names are field-CONFIRMED there too —
 * the response handler is defensive until then.
 */

import { spawn as spawnRaw } from 'child_process';
import os from 'os';
import path from 'path';

import crossSpawn from 'cross-spawn';

import { createNormalizedMessage, stampCoordinatorId } from './shared/utils.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { mapSpawnError } from './shared/spawn-error.js';
import sessionManager from './sessionManager.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { participantsDb } from './modules/database/index.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { verifyVendorBinaryDigest, VendorBinaryIntegrityError } from './services/isolation/vendor-binary-integrity.js';
import {
  ensureVendorCliGovernance,
  VendorGovernanceMissingError,
  GOVERNANCE_MISSING_CODE,
} from './services/isolation/vendor-cli-governance.js';
import { mapPermissionModeToVendorFlags } from './services/isolation/vendor-cli-permissions.js';
import { resolveCagedLaunch } from './services/isolation/provider-cage-wiring.js';
import { sanitizeVendorAgentEnv } from './services/isolation/sanitize-vendor-agent-env.js';
import { neutralGovernanceSource } from './services/isolation/codex-governance-material.js';
import { KIMI_HOME_SUBDIR } from './services/isolation/provision-user-dirs.js';
import { KimiAgentResponseHandler, KIMI_RATE_LIMIT_MESSAGE } from './kimi-agent-response-handler.js';

// Use cross-spawn on Windows for correct .cmd resolution (parity with gemini/cursor).
// Bound to the name `spawn` deliberately: this is the ONE governed kimi spawn site,
// and the single-launcher grep-gate (SL-3) matches a literal `spawn(` primitive — so
// the launcher is DISCOVERED and its registry entry (sanitized:true) stays honest.
const spawn = process.platform === 'win32' ? crossSpawn : spawnRaw;

/** The npm package whose `kimi` bin this seam governs (KG-1 §1.1, pinned by SL-7). */
export const KIMI_CODE_PACKAGE = '@moonshot-ai/kimi-code';

/** Bare bin name resolved through $PATH when no KIMI_PATH override is set. */
const KIMI_BIN = 'kimi';

/** The governance filename kimi ingests from its config-home (a 0444 neutral COPY). */
export const KIMI_AGENTS_FILENAME = 'AGENTS.md';

/** Catalog default (mirrors vendor-config KIMI_FALLBACK_MODELS.DEFAULT — KM-4 owns the catalog). */
const KIMI_DEFAULT_MODEL = 'kimi-k2.6';

/**
 * Sibling HOSTED-vendor key namespaces stripped from a kimi child via
 * sanitizeVendorAgentEnv's extraDeny, so a non-target vendor key (e.g. a GLM/ZAI
 * key present in the operator env) never rides along into a kimi turn. The TARGET
 * key namespace (KIMI_*) is deliberately preserved by the sanitizer.
 * @type {ReadonlyArray<string>}
 */
export const KIMI_SIBLING_VENDOR_KEYS = Object.freeze([
  'DEEPSEEK_API_KEY',
  'GLM_API_KEY',
  'ZAI_API_KEY',
]);

/** User-facing (Arabic) message when a kimi launch is refused for missing governance. */
export const KIMI_GOVERNANCE_MISSING_MESSAGE = 'جلسة Kimi محجوبة: حوكمة نسّاج غير مُهيّأة.';

/** User-facing (Arabic) message when the kimi binary fails its integrity pin. */
export const KIMI_INTEGRITY_MESSAGE =
  'تعذّر إطلاق Kimi: فشل تحقّق سلامة الملف التنفيذي (تعارض مع البصمة المعتمدة).';

/** Active kimi-agent child processes keyed by session id (abort/liveness). */
const activeKimiAgentProcesses = new Map();

/**
 * Resolves the FINAL kimi binary spawn target: the KIMI_PATH override when set,
 * else the bare `kimi` bin (resolved through $PATH by the OS — and, for the SL-7
 * digest pin, walked through $PATH by resolveExecutableForHashing so the pin
 * covers the exact binary exec would run — M-4).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveKimiBinaryPath(env = process.env) {
  const override = typeof env?.KIMI_PATH === 'string' ? env.KIMI_PATH.trim() : '';
  return override || KIMI_BIN;
}

/**
 * Resolves the kimi config-home for governance/session purposes: the isolated
 * KIMI_CODE_HOME set by resolveProviderEnv (agent mode) when present, else the
 * operator home fallback (`~/.kimi`, the SAME KIMI_HOME_SUBDIR the provisioner
 * materializes — single source of truth, no drift).
 *
 * @param {NodeJS.ProcessEnv} env the already-resolved provider env
 * @returns {string}
 */
export function resolveKimiHome(env) {
  const home = typeof env?.KIMI_CODE_HOME === 'string' ? env.KIMI_CODE_HOME.trim() : '';
  return home || path.join(os.homedir(), KIMI_HOME_SUBDIR);
}

/**
 * Builds the kimi headless argv (KG-1 §1.1). Order: prompt, stream-json output,
 * model, session resume, then the permission-ceiling flags (SL-4) — the ceiling
 * flags come LAST so nothing the caller passes can precede/override them.
 *
 * @param {{ command?: string, cliSessionId?: string|null, model?: string,
 *           permissionFlags?: string[] }} spec
 * @returns {string[]}
 */
export function buildKimiAgentArgs({ command, cliSessionId, model, permissionFlags = [] }) {
  const args = [];
  if (command && command.trim()) {
    args.push('-p', command);
  }
  args.push('--output-format', 'stream-json');
  if (model) {
    args.push('--model', model);
  }
  // Session resume (KG-1 `-S/-c`): continue the previously-created kimi session.
  // The exact continue-vs-select flag semantics are field-CONFIRMED at G-KIMI-LIVE;
  // `-c <id>` (continue a specific session) is the conservative choice here.
  if (cliSessionId) {
    args.push('-c', cliSessionId);
  }
  args.push(...permissionFlags);
  return args;
}

/**
 * Wraps the binary in `sh -c exec` on POSIX so a shebang-less script does not
 * ENOEXEC and signals reach the CLI directly (gemini precedent). On Windows the
 * command is spawned directly (cross-spawn handles .cmd). The wrapper is caged as
 * a unit by resolveCagedLaunch.
 *
 * @param {string} binaryPath
 * @param {string[]} args
 * @returns {{ spawnCmd: string, spawnArgs: string[] }}
 */
function wrapForShell(binaryPath, args) {
  if (os.platform() === 'win32') {
    return { spawnCmd: binaryPath, spawnArgs: args };
  }
  return { spawnCmd: 'sh', spawnArgs: ['-c', 'exec "$0" "$@"', binaryPath, ...args] };
}

/**
 * The PURE governed launch seam: runs the mandatory ordered pipeline and returns
 * everything needed to spawn, WITHOUT performing the spawn. Kept pure (and dep-
 * injectable) so the isolation test can assert (a) the exact step ORDER with
 * sanitize LAST, (b) the child env after the cage is clean, and (c) the two
 * fail-closed refusals (digest drift, governance missing) — all without a real
 * kimi binary.
 *
 * Throws (fail-closed) on digest drift (VendorBinaryIntegrityError, step 2) or
 * missing governance (VendorGovernanceMissingError, step 3): the caller never
 * receives a launch, so an ungoverned/untrusted turn cannot spawn.
 *
 * @param {{ userId?: string|number|null, command?: string,
 *           cliSessionId?: string|null, model?: string,
 *           permissionMode?: string, cwd?: string|null,
 *           baseEnv?: NodeJS.ProcessEnv }} params
 * @param {{ resolveProviderEnv?: Function, verifyVendorBinaryDigest?: Function,
 *           ensureVendorCliGovernance?: Function,
 *           mapPermissionModeToVendorFlags?: Function,
 *           resolveCagedLaunch?: Function, sanitizeVendorAgentEnv?: Function,
 *           neutralGovernanceSource?: Function }} [deps] test seam (spies/overrides)
 * @returns {{ binaryPath: string, kimiHome: string,
 *            permission: import('./vendor-cli-permissions.js').VendorPermissionFlags,
 *            args: string[], launch: { cmd: string, args: string[] },
 *            env: NodeJS.ProcessEnv }}
 */
export function prepareKimiAgentLaunch(params, deps = {}) {
  const {
    userId = null,
    command = '',
    cliSessionId = null,
    model,
    permissionMode = 'default',
    cwd,
    baseEnv = process.env,
  } = params || {};

  const resolveEnvFn = deps.resolveProviderEnv ?? resolveProviderEnv;
  const verifyDigestFn = deps.verifyVendorBinaryDigest ?? verifyVendorBinaryDigest;
  const ensureGovernanceFn = deps.ensureVendorCliGovernance ?? ensureVendorCliGovernance;
  const mapPermsFn = deps.mapPermissionModeToVendorFlags ?? mapPermissionModeToVendorFlags;
  const cagedLaunchFn = deps.resolveCagedLaunch ?? resolveCagedLaunch;
  const sanitizeFn = deps.sanitizeVendorAgentEnv ?? sanitizeVendorAgentEnv;
  const governanceSourceFn = deps.neutralGovernanceSource ?? neutralGovernanceSource;

  // (1) Per-user env: injects KIMI_API_KEY (value) + isolates KIMI_CODE_HOME (agent mode).
  const resolvedEnv = resolveEnvFn(userId, 'kimi', baseEnv, 'agent');

  // (2) Digest pin on the FINAL resolved path (throws on drift/unverifiable when armed).
  const binaryPath = resolveKimiBinaryPath(resolvedEnv);
  verifyDigestFn('kimi', binaryPath, { env: resolvedEnv });

  // (3) Fail-closed governance gate (throws VendorGovernanceMissingError when unattested).
  const kimiHome = resolveKimiHome(resolvedEnv);
  ensureGovernanceFn('kimi', kimiHome, governanceSourceFn(), { filename: KIMI_AGENTS_FILENAME });

  // (4) Permission ceiling — the single chokepoint (client mode can't widen it).
  const permission = mapPermsFn('kimi', permissionMode, resolvedEnv);

  // (5) Build argv, then cage the shell-wrapped command as a unit.
  const args = buildKimiAgentArgs({ command, cliSessionId, model, permissionFlags: permission.flags });
  const { spawnCmd, spawnArgs } = wrapForShell(binaryPath, args);
  const launch = cagedLaunchFn({ userId, provider: 'kimi', mode: 'agent', cmd: spawnCmd, args: spawnArgs, cwd });

  // (6) ★ sanitize LAST ★ — the env actually handed to spawn. Nothing runs after
  // this before the child is created, so no leak can be re-introduced.
  const env = sanitizeFn(resolvedEnv, { extraDeny: KIMI_SIBLING_VENDOR_KEYS });

  return { binaryPath, kimiHome, permission, args, launch, env };
}

/**
 * Spawns a governed Kimi native-agent turn and streams its stream-json output to
 * the WebSocket as normalized messages. The single live launcher.
 *
 * @param {string} command the user prompt
 * @param {{ sessionId?: string, projectPath?: string, cwd?: string,
 *           model?: string, permissionMode?: string, sessionSummary?: string }} [options]
 * @param {{ send: Function, userId?: number|null, getSessionId?: Function,
 *           setSessionId?: Function }} ws
 * @returns {Promise<void>}
 */
export async function spawnKimiAgent(command, options = {}, ws) {
  const { sessionId, projectPath, cwd, permissionMode = 'default', sessionSummary } = options;

  // Validate cwd before spawning (B-31 parity).
  const cwdToCheck = cwd || projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      if (ws) {
        ws.send(createNormalizedMessage(
          buildCwdMissingPayload(cwdCheck.error, { sessionId: sessionId || null, provider: 'kimi' }),
        ));
      }
      return;
    }
  }

  const workingDir = (cwd || projectPath || process.cwd()).replace(/[^\x20-\x7E]/g, '').trim();
  const resolvedModel =
    (await providerModelsService.resolveResumeModel('kimi', sessionId, options.model)) || KIMI_DEFAULT_MODEL;

  // Resume: map the nassaj session to the kimi CLI session id, if known.
  let cliSessionId = null;
  if (sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.cliSessionId) {
      cliSessionId = session.cliSessionId;
    }
  }

  // Run the ordered governed seam. A fail-closed refusal (digest drift / missing
  // governance) surfaces a graceful user error and STOPS — no ungoverned spawn.
  let prepared;
  try {
    prepared = prepareKimiAgentLaunch({
      userId: ws?.userId ?? null,
      command,
      cliSessionId,
      model: resolvedModel,
      permissionMode,
      cwd: workingDir,
      baseEnv: process.env,
    });
  } catch (err) {
    const finalSessionId = sessionId || null;
    if (err instanceof VendorGovernanceMissingError || err?.code === GOVERNANCE_MISSING_CODE) {
      console.error('[Kimi] launch REFUSED — nassaj governance not established', {
        userId: ws?.userId ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
      ws?.send(createNormalizedMessage({
        kind: 'error',
        code: GOVERNANCE_MISSING_CODE,
        content: KIMI_GOVERNANCE_MISSING_MESSAGE,
        sessionId: finalSessionId,
        provider: 'kimi',
      }));
      return;
    }
    if (err instanceof VendorBinaryIntegrityError) {
      console.error('[Kimi] launch REFUSED — binary integrity pin failed', {
        userId: ws?.userId ?? null,
        reason: err.reason,
        resolvedPath: err.resolvedPath,
      });
      ws?.send(createNormalizedMessage({
        kind: 'error',
        code: 'vendor_binary_integrity',
        content: KIMI_INTEGRITY_MESSAGE,
        sessionId: finalSessionId,
        provider: 'kimi',
      }));
      return;
    }
    throw err;
  }

  const { launch, env: spawnEnv } = prepared;

  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let assistantBlocks = [];
  let participantRecorded = false;

  const recordParticipant = (sid) => {
    if (participantRecorded || !sid || !ws?.userId) {
      return;
    }
    participantRecorded = true;
    participantsDb.recordSpawn(sid, ws.userId, { provider: 'kimi', projectPath: workingDir });
  };

  return new Promise((resolve, reject) => {
    const kimiProcess = spawn(launch.cmd, launch.args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    });

    let terminalNotificationSent = false;
    let terminalFailureReason = null;
    const processKey = capturedSessionId || sessionId || Date.now().toString();
    activeKimiAgentProcesses.set(processKey, kimiProcess);
    kimiProcess.sessionId = processKey;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }
      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'kimi',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'kimi',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || terminalFailureReason || `Kimi CLI exited with code ${code}`,
      });
    };

    try {
      kimiProcess.stdin.end();
    } catch {
      // stdin may already be closed on an immediate spawn error.
    }

    if (command && capturedSessionId) {
      sessionManager.addMessage(capturedSessionId, 'user', command);
    }
    recordParticipant(capturedSessionId);

    const responseHandler = ws
      ? new KimiAgentResponseHandler(ws, {
          onContentFragment: (content) => {
            const last = assistantBlocks[assistantBlocks.length - 1];
            if (last && last.type === 'text') {
              last.text += content;
            } else {
              assistantBlocks.push({ type: 'text', text: content });
            }
          },
          onToolUse: (event) => {
            assistantBlocks.push({
              type: 'tool_use',
              id: event.toolId,
              name: event.toolName,
              input: event.input,
            });
          },
          onToolResult: (event) => {
            if (capturedSessionId) {
              if (assistantBlocks.length > 0) {
                sessionManager.addMessage(capturedSessionId, 'assistant', [...assistantBlocks]);
                assistantBlocks = [];
              }
              sessionManager.addMessage(capturedSessionId, 'user', [{
                type: 'tool_result',
                tool_use_id: event.toolId,
                content: event.output === undefined ? null : event.output,
                is_error: event.isError === true,
              }]);
            }
          },
          onRateLimit: (message) => {
            terminalFailureReason = message;
          },
          onInit: (discoveredSessionId) => {
            if (capturedSessionId || !discoveredSessionId) {
              // Still record the CLI session id for resume even on a known session.
              const known = sessionManager.getSession(capturedSessionId);
              if (known && !known.cliSessionId && discoveredSessionId) {
                known.cliSessionId = discoveredSessionId;
                sessionManager.saveSession(capturedSessionId);
              }
              return;
            }
            capturedSessionId = discoveredSessionId;
            recordParticipant(capturedSessionId);
            sessionManager.createSession(capturedSessionId, workingDir);
            if (command) {
              sessionManager.addMessage(capturedSessionId, 'user', command);
            }
            void providerModelsService
              .seedSessionModel('kimi', capturedSessionId, resolvedModel)
              .catch(() => {});
            if (processKey !== capturedSessionId) {
              activeKimiAgentProcesses.delete(processKey);
              activeKimiAgentProcesses.set(capturedSessionId, kimiProcess);
            }
            kimiProcess.sessionId = capturedSessionId;
            if (typeof ws.setSessionId === 'function') {
              ws.setSessionId(capturedSessionId);
            }
            const sess = sessionManager.getSession(capturedSessionId);
            if (sess && !sess.cliSessionId) {
              sess.cliSessionId = discoveredSessionId;
              sessionManager.saveSession(capturedSessionId);
            }
            if (!sessionId && !sessionCreatedSent) {
              sessionCreatedSent = true;
              ws.send(createNormalizedMessage({
                kind: 'session_created',
                newSessionId: capturedSessionId,
                sessionId: capturedSessionId,
                provider: 'kimi',
              }));
            }
          },
        })
      : null;

    // 120s inactivity timeout, re-armed on each chunk (gemini parity).
    const timeoutMs = 120000;
    let timeout;
    const startTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        const socketSessionId =
          typeof ws?.getSessionId === 'function' ? ws.getSessionId() : (capturedSessionId || sessionId || processKey);
        terminalFailureReason = `Kimi CLI timeout - no response received for ${timeoutMs / 1000} seconds`;
        ws?.send(createNormalizedMessage({ kind: 'error', content: terminalFailureReason, sessionId: socketSessionId, provider: 'kimi' }));
        try {
          kimiProcess.kill('SIGTERM');
        } catch {
          // process already gone
        }
      }, timeoutMs);
    };
    startTimeout();

    kimiProcess.stdout.on('data', (data) => {
      startTimeout();
      const raw = data.toString();
      if (responseHandler) {
        responseHandler.processData(raw);
      } else if (raw) {
        const socketSessionId =
          typeof ws?.getSessionId === 'function' ? ws.getSessionId() : (capturedSessionId || sessionId);
        ws?.send(stampCoordinatorId(
          createNormalizedMessage({ kind: 'stream_delta', content: raw, sessionId: socketSessionId, provider: 'kimi' }),
          ws?.userId,
        ));
      }
    });

    kimiProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      if (
        errorMsg.includes('DeprecationWarning') ||
        errorMsg.includes('--trace-deprecation') ||
        errorMsg.includes('Loaded cached credentials')
      ) {
        return;
      }
      const socketSessionId =
        typeof ws?.getSessionId === 'function' ? ws.getSessionId() : (capturedSessionId || sessionId);
      ws?.send(createNormalizedMessage({ kind: 'error', content: errorMsg, sessionId: socketSessionId, provider: 'kimi' }));
    });

    kimiProcess.on('close', async (code) => {
      clearTimeout(timeout);
      if (responseHandler) {
        responseHandler.forceFlush();
        responseHandler.destroy();
      }
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeKimiAgentProcesses.delete(finalSessionId);
      activeKimiAgentProcesses.delete(processKey);

      if (finalSessionId && assistantBlocks.length > 0) {
        sessionManager.addMessage(finalSessionId, 'assistant', assistantBlocks);
      }

      ws?.send(createNormalizedMessage({
        kind: 'complete',
        exitCode: code,
        isNewSession: !sessionId && !!command,
        sessionId: finalSessionId,
        provider: 'kimi',
      }));

      if (code === 0) {
        notifyTerminalState({ code });
        resolve();
        return;
      }

      const socketSessionId = typeof ws?.getSessionId === 'function' ? ws.getSessionId() : finalSessionId;
      // Shell "command not found" — the binary isn't installed.
      if (code === 127) {
        const installed = await providerAuthService.isProviderInstalled('kimi').catch(() => false);
        if (!installed) {
          terminalFailureReason = `Kimi CLI is not installed. Install it first: npm i -g ${KIMI_CODE_PACKAGE}`;
          ws?.send(createNormalizedMessage({ kind: 'error', content: terminalFailureReason, sessionId: socketSessionId, provider: 'kimi' }));
        }
      } else if (!terminalFailureReason) {
        // A rate-limit was already surfaced by the response handler if it occurred;
        // otherwise keep the generic exit-code reason.
        terminalFailureReason = `Kimi CLI exited with code ${code}`;
      }

      notifyTerminalState({ code, error: code === null ? 'Kimi CLI process was terminated or timed out' : null });
      reject(new Error(terminalFailureReason || `Kimi CLI exited with code ${code}`));
    });

    kimiProcess.on('error', async (error) => {
      clearTimeout(timeout);
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeKimiAgentProcesses.delete(finalSessionId);
      activeKimiAgentProcesses.delete(processKey);

      const installed = await providerAuthService.isProviderInstalled('kimi').catch(() => false);
      let errorCode;
      let errorContent;
      if (!installed) {
        errorCode = 'cli_not_installed';
        errorContent = `Kimi CLI is not installed. Install it first: npm i -g ${KIMI_CODE_PACKAGE}`;
      } else {
        const mapped = mapSpawnError(error);
        errorCode = mapped.code;
        errorContent = mapped.fallbackMessage;
      }

      const errorSessionId = typeof ws?.getSessionId === 'function' ? ws.getSessionId() : finalSessionId;
      ws?.send(createNormalizedMessage({
        kind: 'error',
        code: errorCode,
        content: errorContent,
        sessionId: errorSessionId,
        provider: 'kimi',
      }));
      notifyTerminalState({ error });
      reject(error);
    });
  });
}

/**
 * Aborts a live kimi-agent turn by session id (SIGTERM, then SIGKILL after 2s).
 * @param {string} sessionId
 * @returns {boolean} whether a process was found and signaled
 */
export function abortKimiAgentSession(sessionId) {
  let proc = activeKimiAgentProcesses.get(sessionId);
  let processKey = sessionId;
  if (!proc) {
    for (const [key, p] of activeKimiAgentProcesses.entries()) {
      if (p.sessionId === sessionId) {
        proc = p;
        processKey = key;
        break;
      }
    }
  }
  if (!proc) {
    return false;
  }
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (activeKimiAgentProcesses.has(processKey)) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 2000);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} sessionId @returns {boolean} */
export function isKimiAgentSessionActive(sessionId) {
  return activeKimiAgentProcesses.has(sessionId);
}

/** @returns {string[]} */
export function getActiveKimiAgentSessions() {
  return Array.from(activeKimiAgentProcesses.keys());
}

export { KIMI_RATE_LIMIT_MESSAGE };
