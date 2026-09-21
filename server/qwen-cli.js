// Qwen Code foreground adapter (ADR-101 / T-1376).
// One direct browser gesture launches one bounded headless process. The personal
// Alibaba plan key is injected into the child environment only; it is never put
// in argv, a Qwen settings file, a transcript, or a log entry.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { withRuntimeInstructions as withCoordinationDirective } from './services/runtime-instructions.js';

import { readVendorReceiptInvocation } from './modules/providers/shared/vendor/vendor-receipt-identity.js';
import { sessionsDb, participantsDb, messageAuthorsDb } from './modules/database/index.js';
import { qwenExecutionContract } from './modules/providers/list/qwen/qwen-execution-contract.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createTurnTimer, settleTurnTiming } from './modules/providers/services/turn-timing.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerSecretsService } from './modules/providers/services/provider-secrets.service.js';
import { qwenModelsForPlan } from './modules/providers/list/qwen/qwen.provider.js';
import {
  appendVendorTranscriptTurn,
  vendorTranscriptPath,
  writeVendorTranscriptMeta,
} from './modules/providers/shared/vendor/vendor-transcript.js';
import { credentialPrincipalId } from './services/isolation/credential-principal.js';
import { resolveProviderEnv } from './services/isolation/resolve-provider-env.js';
import { materializeQwenSettings, QWEN_HOME_SUBDIR } from './services/isolation/qwen-settings-material.js';
import { resolveCagedLaunch } from './services/isolation/provider-cage-wiring.js';
import { sanitizeVendorAgentEnv } from './services/isolation/sanitize-vendor-agent-env.js';
import { beginProviderRun } from './services/provider-run-presence.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { checkCwdExists, buildCwdMissingPayload } from './shared/cwd-check.js';
import { createNormalizedMessage, stampCoordinatorId } from './shared/utils.js';
import { resolveCliExecutablePath } from './shared/cli-executable-path.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;
const activeQwenProcesses = new Map();

const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_RUN_TIMEOUT_MS = 10 * 1000;
const MAX_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const KILL_GRACE_MS = 8 * 1000;

// Qwen Code's own API_ERROR_PREFIX (0.23.0). Matching the vendor's named
// constant rather than inventing a pattern of our own.
const QWEN_API_ERROR_PREFIX = '[API Error: ';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function runTimeoutMs() {
  return boundedInteger(process.env.QWEN_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS);
}

export function resolveQwenApprovalMode(options) {
  if (options?.skipPermissions || options?.permissionMode === 'yolo') return 'yolo';
  if (options?.permissionMode === 'plan') return 'plan';
  if (options?.permissionMode === 'auto_edit') return 'auto-edit';
  return 'auto';
}

const QWEN_RUNTIME = Object.freeze({
  coding_plan: Object.freeze({
    envKey: 'BAILIAN_CODING_PLAN_API_KEY',
    china: 'https://coding.dashscope.aliyuncs.com/v1',
    international: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  }),
  token_plan: Object.freeze({
    envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
    china: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    international: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  }),
});

export function resolveQwenRuntime(plan, region) {
  const runtime = QWEN_RUNTIME[plan];
  if (!runtime || (region !== 'china' && region !== 'international')) {
    throw new Error('Invalid Qwen credential profile');
  }
  return { envKey: runtime.envKey, baseUrl: runtime[region] };
}

function killQwenGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function readObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => readObject(part)?.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('');
}

export function parseQwenEvent(raw, state, ws, sessionId) {
  const event = readObject(raw);
  if (!event) return;

  if (event.type === 'stream_event') {
    const streamEvent = readObject(event.event);
    const delta = readObject(streamEvent?.delta);
    if (streamEvent?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      state.assistantText += delta.text;
      ws.send(stampCoordinatorId(createNormalizedMessage({
        kind: 'stream_delta', content: delta.text, sessionId, provider: 'qwen',
      }), ws?.userId));
    } else if (streamEvent?.type === 'content_block_delta'
      && (delta?.type === 'thinking_delta' || delta?.type === 'reasoning_delta')) {
      const thinking = typeof delta.thinking === 'string' ? delta.thinking : delta.text;
      if (typeof thinking === 'string' && thinking) {
        ws.send(stampCoordinatorId(createNormalizedMessage({
          kind: 'thinking', content: thinking, sessionId, provider: 'qwen',
        }), ws?.userId));
      }
    }
    return;
  }

  if (event.type === 'assistant') {
    const message = readObject(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    // Partial stream events own text rendering. Full assistant events are used
    // for tool cards and as a text fallback when a CLI version emits no deltas.
    if (!state.assistantText) state.assistantFallback = textFromContent(content);
    for (const part of content) {
      const block = readObject(part);
      if (block?.type === 'tool_use') {
        ws.send(stampCoordinatorId(createNormalizedMessage({
          kind: 'tool_use',
          toolName: typeof block.name === 'string' ? block.name : 'tool',
          toolInput: block.input ?? {},
          toolId: typeof block.id === 'string' ? block.id : '',
          sessionId,
          provider: 'qwen',
        }), ws?.userId));
      }
    }
    return;
  }

  if (event.type === 'result') {
    state.resultSeen = true;
    const resultText = typeof event.result === 'string' ? event.result : '';
    // An upstream API failure arrives as a SUCCESSFUL result: subtype "success",
    // is_error false, exit code 0, num_turns 1, with the failure only in the
    // text under the CLI's API_ERROR_PREFIX. Measured 2026-09-07 — an invalid
    // key returned exactly that. Classified as success, the turn is recorded as
    // completed and "[API Error: 401 …]" is persisted as the member's answer.
    state.resultError = event.is_error === true
      || event.subtype === 'error'
      || resultText.trimStart().startsWith(QWEN_API_ERROR_PREFIX);
    if (!state.assistantText && !state.assistantFallback && resultText) {
      state.assistantFallback = resultText;
    }
    if (state.resultError) {
      // `error` is an OBJECT ({ message }) on the configuration failures — the
      // "No auth type is selected" launch refusal among them — and a string on
      // others. Reading only the string form threw the reason away and left the
      // member with a bare "exited with code 1".
      const errorObject = readObject(event.error);
      state.error = typeof event.error === 'string'
        ? event.error
        : typeof errorObject?.message === 'string' && errorObject.message
          ? errorObject.message
          : resultText || 'Qwen Code reported a failed result.';
    }
  }
}

async function spawnQwen(command, options = {}, ws) {
  const cwdToCheck = options.cwd || options.projectPath;
  if (cwdToCheck) {
    const cwdCheck = await checkCwdExists(cwdToCheck);
    if (!cwdCheck.ok) {
      ws?.send(createNormalizedMessage(buildCwdMissingPayload(
        cwdCheck.error,
        { sessionId: options.sessionId || null, provider: 'qwen' },
      )));
      return;
    }
  }

  const actorUserId = ws?.userId;
  if (actorUserId === null || actorUserId === undefined) {
    ws?.send(createNormalizedMessage({
      kind: 'error', code: 'qwen_personal_auth_required',
      content: 'Qwen runs require an authenticated member.',
      sessionId: options.sessionId || null, provider: 'qwen',
    }));
    return;
  }

  if (!providerSecretsService.getStatus(actorUserId, 'qwen').configured) {
    ws?.send(createNormalizedMessage({
      kind: 'error', code: 'qwen_credential_missing',
      content: 'Connect an Alibaba Coding Plan or Token Plan before starting a Qwen turn.',
      sessionId: options.sessionId || null, provider: 'qwen',
    }));
    return;
  }
  if (!await providerAuthService.isProviderInstalled('qwen')) {
    ws?.send(createNormalizedMessage({
      kind: 'error', code: 'qwen_not_installed',
      content: 'Qwen Code CLI is not installed on this host.',
      sessionId: options.sessionId || null, provider: 'qwen',
    }));
    return;
  }

  const workingDir = options.cwd || options.projectPath || process.cwd();
  const isNewSession = !options.sessionId;
  const sessionId = options.sessionId || crypto.randomUUID();
  if (activeQwenProcesses.has(sessionId)) {
    // B-1078: the busy frame fans out to every mirror socket; echo the rejected
    // send's clientMsgId so only that bubble is withdrawn (as queryCodex does).
    const clientMsgIdField = typeof options.clientMsgId === 'string' && options.clientMsgId
      ? { clientMsgId: options.clientMsgId } : {};
    ws?.send(createNormalizedMessage({
      kind: 'error', code: 'session_busy',
      content: 'This Qwen session is already processing a turn.',
      sessionId, provider: 'qwen', ...clientMsgIdField,
    }));
    return;
  }

  if (isNewSession) {
    const transcriptPath = vendorTranscriptPath('qwen', sessionId, workingDir);
    sessionsDb.createSession(sessionId, 'qwen', workingDir, undefined, undefined, undefined, transcriptPath);
    await writeVendorTranscriptMeta('qwen', sessionId, workingDir, command);
    ws?.setSessionId?.(sessionId);
    ws?.send(createNormalizedMessage({
      kind: 'session_created', newSessionId: sessionId, sessionId, provider: 'qwen',
    }));
  }
  ws?.setSessionId?.(sessionId);

  // Mint only after the authoritative session row exists, then consume at the
  // final pre-spawn seam. No client field can request a background class.
  const gestureToken = qwenExecutionContract.issueGesture({ actorUserId, sessionId });
  qwenExecutionContract.authorizeSpawn({
    actorUserId,
    sessionId,
    executionClass: 'foreground_interactive',
    triggerSource: 'user_chat',
    gestureToken,
    autoContinue: false,
    autoResume: false,
  });

  // T-1675: under a credential grant the Coding Plan key is the grantor's.
  const credential = providerSecretsService.getQwenProfile(credentialPrincipalId(actorUserId, 'qwen'));
  if (!credential) {
    ws?.send(createNormalizedMessage({
      kind: 'error', code: 'qwen_credential_missing',
      content: 'Connect an Alibaba Coding Plan or Token Plan before starting a Qwen turn.',
      sessionId, provider: 'qwen',
    }));
    return;
  }

  participantsDb.recordSpawn(sessionId, actorUserId, { provider: 'qwen', projectPath: workingDir });
  if (command) {
    messageAuthorsDb.recordUserMessage(sessionId, actorUserId, command);
    await appendVendorTranscriptTurn('qwen', sessionId, workingDir, 'user', command, {
      receipt: readVendorReceiptInvocation(options.vendorReceiptInvocation, command, actorUserId),
    });
  }

  const resolvedModel = await providerModelsService.resolveResumeModel('qwen', options.sessionId, options.model);
  const planModels = qwenModelsForPlan(credential.plan);
  const model = planModels.OPTIONS.some((option) => option.value === resolvedModel)
    ? resolvedModel
    : planModels.DEFAULT;
  if (isNewSession) void providerModelsService.seedSessionModel('qwen', sessionId, model).catch(() => {});

  const baseEnv = resolveProviderEnv(actorUserId, 'qwen', { ...process.env });
  // Qwen Code takes its model registry — and the `envKey` indirection that names
  // the BAILIAN_* variable carrying this member's key — from
  // <HOME>/.qwen/settings.json, and refuses a non-interactive turn without it.
  // The environment alone is not enough; see qwen-settings-material.js for the
  // probes that pinned the contract. No fallback to process.env.HOME:
  // resolveProviderEnv is what makes this tree the member's, and guessing the
  // operator's home would write over the operator's own settings. The key itself
  // stays in baseEnv, where it already was.
  materializeQwenSettings(
    baseEnv.HOME ? path.join(baseEnv.HOME, QWEN_HOME_SUBDIR) : '',
    resolveQwenRuntime(credential.plan, credential.region),
    planModels.OPTIONS,
  );

  const { args, env } = buildQwenProcessSpec({
    command,
    options,
    isNewSession,
    sessionId,
    model,
    credential,
    baseEnv,
  });

  const binary = resolveCliExecutablePath('qwen', { override: process.env.QWEN_PATH });
  const launch = resolveCagedLaunch({
    userId: actorUserId,
    provider: 'qwen',
    cmd: binary,
    args,
    cwd: workingDir,
  });

  return new Promise((resolve) => {
    const child = spawnFunction(launch.cmd, launch.args, {
      cwd: workingDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    activeQwenProcesses.set(sessionId, child);
    const presence = beginProviderRun({
      provider: 'qwen', writer: ws, sessionId, projectPath: workingDir, pid: child.pid,
    });
    const state = {
      assistantText: '', assistantFallback: '', resultSeen: false,
      resultError: false, error: '', stderr: '', buffer: '', finalized: false,
    };
    // B-822: Qwen exposes no per-message id, so timing is recorded under a
    // minted id — a correct conversation total without a history stamp.
    const turnTimer = createTurnTimer();
    let escalationTimer = null;
    const timeout = setTimeout(() => {
      state.error = 'Qwen Code exceeded the foreground run time limit.';
      killQwenGroup(child, 'SIGINT');
      escalationTimer = setTimeout(() => killQwenGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    }, runTimeoutMs());

    const finalize = async (code, spawnError = null) => {
      // Stop the measured turn before transcript persistence or native-history polling.
      const processCompletedAt = new Date().toISOString();
      if (child.nassajAborted || child.nassajCloseSignal) state.error ||= 'Qwen turn was interrupted.';
      if (state.finalized) return;
      state.finalized = true;
      clearTimeout(timeout);
      if (escalationTimer) clearTimeout(escalationTimer);
      activeQwenProcesses.delete(sessionId);
      presence.end();
      const answer = state.assistantText || state.assistantFallback;
      const assistantMessageId = answer ? await appendVendorTranscriptTurn(
        'qwen', sessionId, workingDir, 'assistant', answer,
        { finalAnswer: code === 0 && !state.error && !state.resultError && !spawnError },
      ) : null;
      const failure = spawnError?.code === 'ENOENT'
        ? 'Qwen Code CLI is not installed on this host.'
        : state.error || spawnError?.message || (code === 0 && !state.resultError ? '' : `Qwen Code exited with code ${code}.`);
      const durableTiming = !failure && answer && assistantMessageId
        ? settleTurnTiming({
          sessionId,
          assistantMessageId,
          startedAt: turnTimer.startedAt(),
          completedAt: processCompletedAt,
        })
        : {};
      ws?.send(createNormalizedMessage({ kind: 'stream_end', sessionId, provider: 'qwen' }));
      ws?.send(createNormalizedMessage({
        kind: 'complete', exitCode: failure ? (code || 1) : 0,
        success: !failure, error: failure || undefined, sessionId, provider: 'qwen',
        ...durableTiming,
      }));
      if (failure) {
        notifyRunFailed({ userId: actorUserId, provider: 'qwen', sessionId, sessionName: options.sessionSummary, error: failure });
      } else {
        notifyRunStopped({ userId: actorUserId, provider: 'qwen', sessionId, sessionName: options.sessionSummary, stopReason: 'completed' });
      }
      resolve();
    };

    child.stdout.on('data', (chunk) => {
      state.buffer += chunk.toString('utf8');
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Model activity, not spawn: `system`/init frames precede any work.
          if (event?.type === 'stream_event' || event?.type === 'assistant') {
            turnTimer.markModelActivity();
          }
          parseQwenEvent(event, state, ws, sessionId);
        }
        catch { /* stdout is an NDJSON protocol; malformed diagnostics are ignored */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      // Keep bounded diagnostics in memory. Never echo raw stderr: a third-party
      // CLI error could include request headers or environment-derived secrets.
      state.stderr = `${state.stderr}${chunk.toString('utf8')}`.slice(-8_192);
    });
    child.once('error', (error) => void finalize(null, error));
    child.once('close', (code, signal) => {
      child.nassajCloseSignal = signal || null;
      if (state.buffer.trim()) {
        try {
          const event = JSON.parse(state.buffer);
          // The final NDJSON record is valid even when qwen exits without a
          // trailing newline. Keep its timing semantics identical to records
          // consumed in the stdout `data` handler above.
          if (event?.type === 'stream_event' || event?.type === 'assistant') {
            turnTimer.markModelActivity();
          }
          parseQwenEvent(event, state, ws, sessionId);
        } catch { /* ignore */ }
      }
      void finalize(code);
    });
  });
}

/** Builds the measured Qwen headless contract without spawning or doing I/O. */
export function buildQwenProcessSpec({ command, options, isNewSession, sessionId, model, credential, baseEnv }) {
  const approvalMode = resolveQwenApprovalMode(options);
  // T-1315 (الموجة الثانية): مستوى تنسيق الجولة على قناة `--prompt` — قناة qwen
  // الوحيدة. الإنفاذ **نصّي**: لا مفتاح عمقٍ للوكلاء موثَّقاً في qwen-code، فلا
  // يُضبط اسمٌ بلا قارئ (‏B-548).
  const args = [
    '--prompt', withCoordinationDirective(command, options?.coordinationLevel),
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--approval-mode', approvalMode,
    '--max-session-turns', String(boundedInteger(process.env.QWEN_MAX_SESSION_TURNS, 30, 1, 200)),
    '--max-tool-calls', String(boundedInteger(process.env.QWEN_MAX_TOOL_CALLS, 100, 0, 1_000)),
    '--max-wall-time', `${Math.ceil(runTimeoutMs() / 1000)}s`,
    '--exclude-tools', 'cron_create,cron_list,cron_delete,monitor,get_goal,update_goal',
    '--disabled-slash-commands', 'goal,loop,cron,monitor',
  ];
  args.push(isNewSession ? '--session-id' : '--resume', sessionId);
  if (model) args.push('--model', model);

  // Strip every inherited host/vendor credential before injecting the one
  // actor-bound Qwen credential. The target OPENAI_* routing variables must be
  // added after sanitizing because the deny policy intentionally removes all
  // inherited OPENAI_* names and arbitrary *_BASE_URL redirects.
  const env = sanitizeVendorAgentEnv(baseEnv);
  // Remove inherited operator/provider credentials before setting the one
  // actor-bound personal subscription. Qwen's documented precedence makes the
  // process environment win over project .env and settings files.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;
  delete env.QWEN_MODEL;
  delete env.DASHSCOPE_API_KEY;
  delete env.BAILIAN_CODING_PLAN_API_KEY;
  delete env.BAILIAN_TOKEN_PLAN_API_KEY;
  const runtime = resolveQwenRuntime(credential.plan, credential.region);
  env[runtime.envKey] = credential.key;
  env.OPENAI_BASE_URL = runtime.baseUrl;
  if (model) env.OPENAI_MODEL = model;
  if (approvalMode === 'yolo') {
    env.QWEN_CODE_SUPPRESS_YOLO_WARNING = '1';
  } else {
    delete env.QWEN_CODE_SUPPRESS_YOLO_WARNING;
  }
  return { args, env };
}

function abortQwenSession(sessionId) {
  const child = activeQwenProcesses.get(sessionId);
  if (!child) return false;
  child.nassajAborted = true;
  killQwenGroup(child, 'SIGINT');
  setTimeout(() => {
    if (activeQwenProcesses.get(sessionId) === child) killQwenGroup(child, 'SIGKILL');
  }, KILL_GRACE_MS);
  return true;
}

function isQwenSessionActive(sessionId) {
  return activeQwenProcesses.has(sessionId);
}

function getActiveQwenSessions() {
  return [...activeQwenProcesses.keys()];
}

export { spawnQwen, abortQwenSession, isQwenSessionActive, getActiveQwenSessions };
