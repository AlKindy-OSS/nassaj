/**
 * dsh-acp-runtime — the ONE spawn site of the DeepSeek Harness body (T-2086,
 * ADR-224). Wired like the other harnesses, under exactly Claude's restrictions
 * (owner decision 2026-11-07).
 *
 * Before spawn (each refusal spawns nothing):
 *   - the harness-update refusal (as every chat entry point);
 *   - input: an absolute existing cwd, a well-formed resume id, a dsh effort value,
 *     coordination level `direct` (dsh has no mechanical supervision cell);
 *   - one turn per dsh session (`session_busy`: dsh holds a session lock);
 *   - a resumed session must belong to the sender (ADR-173 shared writing: the
 *     dsh session lives in its starter's home, so another member is refused);
 *   - Claude's permission parity (dsh-permission-parity.js) and, since T-2089 (ADR-225),
 *     Claude's UserPromptSubmit hooks (a block sends nothing to DeepSeek; additional
 *     context is appended to the prompt as text parts);
 *   - the launch seam (dsh-launch.js): own deepseek key, governance, pinned
 *     Nassaj layers, exact env, verified node;
 *   - a LOCAL turn (ADR-227 "DSH local corrector", T-2108, dsh-local-turn.js): a chat
 *     pinned to the member's local model server, or a new chat on a local model,
 *     runs through a per-turn loopback corrector (opened after the prompt hooks,
 *     closed when the run exits or fails) with no DeepSeek key, and is pinned to
 *     that server through the shared local-pin writer; it never moves to DeepSeek,
 *     nor a DeepSeek chat to it.
 * One process per turn (detached; its whole group is killed once it exits):
 *   initialize (pv 1) → session/new | session/resume → set_config_option (model
 *   ["deepseek-official", <model>], reasoning_effort off|low|high|max)
 *   → session/prompt (streamed) → session/close → stdin closed.
 * fd 3 carries the policy plugin's channel: every tool call is decided by the parity
 * engine (Claude's hooks, rules and mode); its asks are Nassaj cards (dsh-permissions.js,
 * Claude's timeouts); the handshake must pass before session/new; a result Nassaj never
 * decided kills the group. A Claude-format transcript mirror backs hooks' transcript_path.
 * the conversation is recorded in Nassaj's vendor transcript (dsh-transcript.js).
 * The WS dispatch holds the ADR-134 LaunchPermit.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reportDshLaunchCapability, reportDshLaunchSuccess } from '@/modules/providers/harness-update/npm-lock/dsh-pipeline-update.js';
import { DSH_CAPABILITY_CODES } from '@/modules/providers/harness-update/npm-lock/dsh-update-pipeline.js';
import { beginHarnessLaunch, refuseSpawnIfHarnessUpdating } from '@/modules/providers/harness-update/spawn-admission.js';

import { participantsDb } from '../../../database/index.js';
import { credentialNotLinkedPayload } from '../../../../services/isolation/credential-gate.js';
import { sanitizeVendorAgentEnv } from '../../../../services/isolation/sanitize-vendor-agent-env.js';
import { recordLocalEnginePinOrThrow } from '../../../../services/isolation/local-engine-pin-writer.js';
import { GOVERNANCE_MISSING_CODE } from '../../../../services/isolation/vendor-cli-governance.js';
import { ClaudeTranscriptMirror, claudeTranscriptMirrorPath }
  from '../../../../services/permission-parity/claude-transcript-mirror.js';
import { DSH_REVIEWED_TOOLS } from '../../../../services/permission-parity/dsh-claude-tools.js';
import { createParityBroker } from '../../../../services/permission-parity/dsh-parity-broker.js';
// Existing cross-tree runtime policy seam (vendor-runtime.js precedent).
// eslint-disable-next-line boundaries/no-unknown
import { getRuntimeInstructions } from '../../../../services/runtime-instructions.js';
import { createNormalizedMessage } from '../../../../shared/utils.js';

import { ACP_PROTOCOL_VERSION, AcpConnection, RPC_METHOD_NOT_FOUND } from './dsh-acp-connection.js';
import { assertDshOverrideSemantics } from './dsh-dump-config-check.js';
import { DSH_LOCAL_ENV_ALLOW_LIST, assertExactDshEnv, prepareDshLaunch } from './dsh-launch.js';
import { dshLocalModelIds, dshLocalPath, openDshLocalTurn, prepareDshLocalLaunch } from './dsh-local-turn.js';
import { DshParityRefusal, resolveDshPermissionParity } from './dsh-permission-parity.js';
import { cancelDshPermissionsForRun, requestDshPermission } from './dsh-permissions.js';
import { DshTranscriptRecorder, readDshSessionRecord } from './dsh-transcript.js';

const PROVIDER = 'dsh';
/** The only dsh model group Nassaj selects (official DeepSeek). */
export const DSH_MODEL_GROUP = 'deepseek-official';
/** reasoning_effort values dsh offers (recorded 0.2.2-rc.1). */
export const DSH_REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);
/** A dsh session id Nassaj will resume (dsh issues UUIDs). */
export const DSH_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
const STOP_GRACE_MS = 2000;
const MESSAGES = Object.freeze({
  [GOVERNANCE_MISSING_CODE]: 'جلسة DeepSeek محجوبة: حوكمة نسّاج غير مُهيّأة.',
  session_busy: 'هذه المحادثة تعمل الآن في DeepSeek Harness، وهو لا يقبل رسالة ثانية قبل انتهاء الأولى. '
    + 'انتظر انتهاء الجولة الحالية ثم أرسل رسالتك.',
  dsh_shared_session_unsupported: 'محادثة DeepSeek Harness هذه تخصّ من بدأها، ولا يكملها عضو آخر بعد. ابدأ محادثة جديدة.',
  dsh_session_unknown: 'لا يوجد سجلّ لهذه المحادثة في نسّاج، فلا يمكن استئنافها.',
  dsh_session_id_invalid: 'معرّف المحادثة غير صالح.',
  dsh_coordination_unsupported: 'DeepSeek Harness يعمل بمستوى «مباشر» فقط؛ التفويض والمراجعة غير متاحين له بعد.',
  dsh_permission_mode_unsupported: 'DeepSeek Harness لا يحاكي بعد وضع الصلاحيات المختار في Claude، '
    + 'فلم تبدأ الجولة؛ اختر وضعاً آخر.',
  dsh_permission_rule_unsupported: 'لديك قواعد صلاحيات في Claude لا يستطيع DeepSeek Harness فرضها، فلم تبدأ الجولة.',
  dsh_claude_hooks_unsupported: 'لديك حُرّاس (hooks) في Claude لا يستطيع DeepSeek Harness تشغيلها، فلم تبدأ الجولة.',
  dsh_claude_sandbox_unsupported: 'Claude يعمل لديك داخل sandbox، ولا يملك DeepSeek Harness طبقة مطابقة بعد، فلم تبدأ الجولة.',
  dsh_prompt_blocked: 'حجب أحد حُرّاس Claude هذه الرسالة.',
  dsh_cap_channel: 'لم يصل ردّ طبقة سياسة نسّاج من DeepSeek Harness (قد يكون إصداره غير متوافق)، فأُوقفت الجولة.',
  dsh_cap_tools_api: 'إصدار DeepSeek Harness هذا لا يوفّر واجهة الأدوات التي يتحقق بها نسّاج، فأُوقفت الجولة.',
  dsh_cap_gate: 'تعذّر إثبات أن نسّاج يقرّر كل أداة في إصدار DeepSeek Harness هذا، فأُوقفت الجولة.',
  dsh_gate_bypassed: 'أوقف نسّاج DeepSeek Harness: وصلت أداة إلى التنفيذ دون قرار نسّاج.',
  dsh_post_hook_skipped: 'أوقف نسّاج DeepSeek Harness: أداة نُفّذت دون أن تمرّ بحُرّاس ما بعد التنفيذ.',
  dsh_override_unverified: 'نسخة DeepSeek Harness المحدّدة يدوياً على الخادم لا تحمل إعدادات الأمان المطلوبة، فلم تبدأ الجولة.',
  dsh_policy_violation: 'أوقف نسّاج DeepSeek Harness: ظهرت نتيجة أداة لم يُقرّها.',
  PERMISSION_EFFECTIVE_POLICY_REQUIRED: 'تعذّر تحديد ملف الصلاحيات لهذه الجولة، فلم تبدأ.',
  dsh_cwd_missing: 'مجلد المشروع لهذه الجولة غير موجود.',
  dsh_effort_unsupported: 'مستوى التفكير المطلوب غير مدعوم في DeepSeek Harness.',
  dsh_handshake_missing: 'لم تصل مصافحة طبقة سياسة نسّاج قبل إرسال الرسالة، فأُوقفت الجولة.',
  launch_refused: 'تعذّر تشغيل DeepSeek Harness على هذا الخادم.',
});

/** Sends one normalized frame to the turn's writer. */
function emit(writer, sessionId, fields) {
  try {
    writer?.send?.(createNormalizedMessage({ ...fields, sessionId: sessionId ?? '', provider: PROVIDER }));
  } catch {
    // a closed socket never breaks the turn
  }
}

/** A pre-start refusal: nothing was spawned and no session state was written. */
function refuse(writer, sessionId, code, extra = {}) {
  emit(writer, sessionId, {
    kind: 'complete', exitCode: 1, success: false, notStarted: true, code,
    error: extra.error ?? MESSAGES[code] ?? MESSAGES.launch_refused, ...extra,
  });
}

/** Typed local-engine refusals (T-2108) whose message the member must read intact. */
const LOCAL_REFUSAL_CODES = new Set(['ENGINE_PROVIDER_UNAVAILABLE', 'ENGINE_PIN_WRITE_FAILED']);

/** Maps a pre-spawn error to its refusal; false for an unexpected error. */
function refuseLaunchError(writer, sessionId, error) {
  const credential = credentialNotLinkedPayload(error);
  if (credential) {
    refuse(writer, sessionId, 'CREDENTIAL_NOT_LINKED', { credential, error: error.message });
    return true;
  }
  if (error instanceof DshParityRefusal || error?.code === GOVERNANCE_MISSING_CODE) {
    refuse(writer, sessionId, error.code);
    return true;
  }
  // ADR-227 / T-2108: a local-engine refusal reads intact (it names no key and no address).
  if (LOCAL_REFUSAL_CODES.has(error?.code)) {
    refuse(writer, sessionId, error.code, { error: error.message, ...(error.reason ? { reason: error.reason } : {}) });
    return true;
  }
  if (error?.name === 'DshLaunchError' || error?.code === 'HARNESS_BINARY_UNRESOLVED'
    || error?.code === 'CREDENTIAL_ACTOR_REQUIRED') {
    refuse(writer, sessionId, error.code, { error: MESSAGES.launch_refused });
    return true;
  }
  return false;
}

/** The set_config_option value selecting `model`, or null when not offered. */
export function modelConfigValue(configOptions, model) {
  if (typeof model !== 'string' || model === '') return null;
  const wanted = JSON.stringify([DSH_MODEL_GROUP, model]);
  const option = (configOptions ?? []).find((entry) => entry?.id === 'model');
  const offered = (option?.options ?? []).flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry]));
  return offered.some((entry) => entry?.value === wanted) ? wanted : null;
}

/**
 * The prompt: the member's text, then (T-1315) Nassaj's runtime instructions as a
 * separate text block — dsh's only input channel.
 */
export function promptBlocks(command, coordinationLevel) {
  const blocks = [{ type: 'text', text: String(command ?? '') }];
  const instructions = getRuntimeInstructions(coordinationLevel ?? 'direct');
  if (typeof instructions === 'string' && instructions.trim()) blocks.push({ type: 'text', text: instructions });
  return blocks;
}

/** The options of a Nassaj ask card (the policy plugin never asks dsh itself). */
const ASK_OPTIONS = Object.freeze([{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }]);
const HANDSHAKE_TIMEOUT_MS = Number(process.env.NASSAJ_DSH_HANDSHAKE_TIMEOUT_MS || 15000);
const claudeToolName = (title) => DSH_REVIEWED_TOOLS[title]?.claude ?? title;

/** The fd-3 broker of one run: engine decisions, Nassaj ask cards, kill on violation. */
function attachBroker(run, engine) {
  const askMember = (card) => requestDshPermission({
    runId: run.runId, ownerUserId: run.userId, sessionId: run.sessionId, writer: run.writer,
    toolName: card.claude?.tool_name ?? card.tool, input: card.claude?.tool_input ?? {}, options: ASK_OPTIONS,
  }).then((outcome) => (outcome.outcome === 'selected' && outcome.optionId === 'allow-once' ? 'approve' : 'reject'));
  run.broker = createParityBroker({
    engine, askMember,
    kill: () => {
      const code = run.broker?.state.refusal ?? run.broker?.state.killCode;
      run.policyViolation = code && MESSAGES[code] ? code : 'dsh_policy_violation';
      killGroup(run.child, 'SIGKILL');
    },
    onIncident: (incident) => console.warn('[dsh] policy incident', { userId: run.userId, ...incident }),
  });
  run.broker.attach(run.child.stdio[3]);
}

/** Resolves once the policy plugin's handshake was accepted; throws on refusal, exit or timeout. */
async function awaitHandshake(run) {
  let timer;
  const ok = await Promise.race([
    run.broker.handshake,
    run.exited.then(() => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), HANDSHAKE_TIMEOUT_MS); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (!ok) {
    const code = run.broker.state.refusal && MESSAGES[run.broker.state.refusal] ? run.broker.state.refusal : 'dsh_cap_channel';
    throw Object.assign(new Error(MESSAGES[code]), { code });
  }
}

/** Kills the child's whole process group; a group already gone is fine. */
function killGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // ESRCH: nothing left in the group
  }
}

/**
 * Ends a run: stdin closed, SIGTERM then SIGKILL to the group while the leader
 * lives, and ALWAYS a final SIGKILL to the group once it exited, so a grandchild
 * that outlived its leader dies with the turn.
 */
function endChild(run, graceMs = STOP_GRACE_MS) {
  const term = setTimeout(() => killGroup(run.child, 'SIGTERM'), graceMs);
  const kill = setTimeout(() => killGroup(run.child, 'SIGKILL'), graceMs * 2);
  try { run.child.stdin?.end(); } catch { /* closed */ }
  return run.exited.finally(() => {
    clearTimeout(term);
    clearTimeout(kill);
    killGroup(run.child, 'SIGKILL');
  });
}

/** Forwards one session/update of the run's session to the writer and transcript. */
function onSessionUpdate(run, params) {
  const update = params?.update;
  if (!run.sessionId || params?.sessionId !== run.sessionId || !update) return;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    run.recorder.addText(update.content.text);
    run.mirror?.addText(update.content.text);
    emit(run.writer, run.sessionId, { kind: 'stream_delta', role: 'assistant', content: update.content.text });
  } else if (update.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') {
    const toolName = typeof update.title === 'string' ? update.title : 'tool';
    run.toolCalls.set(update.toolCallId, { toolName, input: update.rawInput ?? {} });
    run.recorder.toolUse(update.toolCallId, toolName, update.rawInput);
    run.mirror?.toolUse(update.toolCallId, claudeToolName(toolName), update.rawInput);
    emit(run.writer, run.sessionId, { kind: 'tool_use', toolId: update.toolCallId, toolName, toolInput: update.rawInput ?? {} });
  } else if (update.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
    const text = (update.content ?? []).map((entry) => entry?.content?.text).filter((t) => typeof t === 'string').join('\n');
    const isError = update.status === 'failed';
    run.broker?.acpToolUpdate({ callId: update.toolCallId, status: update.status, rawInput: run.toolCalls.get(update.toolCallId)?.input });
    run.recorder.toolResult(update.toolCallId, text, isError);
    run.mirror?.toolResult(update.toolCallId, text, isError);
    emit(run.writer, run.sessionId, { kind: 'tool_result', toolId: update.toolCallId, content: text, isError });
  }
}

/** Agent → client requests: escalations go to the member; nothing else is offered. */
function onAgentRequest(run, method, params) {
  if (method !== 'session/request_permission') {
    throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: RPC_METHOD_NOT_FOUND });
  }
  const tool = run.toolCalls.get(params?.toolCall?.toolCallId) ?? { toolName: 'tool', input: {} };
  return requestDshPermission({
    runId: run.runId, ownerUserId: run.userId, sessionId: run.sessionId, writer: run.writer,
    toolName: tool.toolName, input: tool.input, options: params?.options,
  }).then((outcome) => ({ outcome }));
}

/** Marks the member as a participant of the session (visibility), best effort. */
function recordParticipant(run, cwd) {
  try {
    if (run.userId) participantsDb.recordSpawn(run.sessionId, run.userId, { provider: PROVIDER, projectPath: cwd });
  } catch {
    // participation is a listing aid, never a turn blocker
  }
}

/** Opens (new) or resumes the dsh session, then applies model and reasoning effort. */
async function openSession(run, { requested, cwd, model, effort, command }, busySessions) {
  const { connection } = run;
  await connection.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'nassaj', version: '0' },
  });
  await awaitHandshake(run);
  reportDshLaunchSuccess(run.operatorHome ?? os.homedir()); // T-2091: proves a fresh switch
  let opened;
  if (requested) {
    opened = await connection.request('session/resume', { sessionId: requested, cwd, mcpServers: [] });
    run.sessionId = requested;
  } else {
    opened = await connection.request('session/new', { cwd, mcpServers: [] });
    run.sessionId = opened.sessionId;
    busySessions.add(run.sessionId);
    run.writer?.setSessionId?.(run.sessionId);
    emit(run.writer, run.sessionId, { kind: 'session_created', newSessionId: run.sessionId });
    // Hooks of the rest of this turn see dsh's session id and its Claude-format mirror.
    const transcriptPath = claudeTranscriptMirrorPath(run.home, run.sessionId);
    run.mirror?.rename(run.sessionId, transcriptPath);
    run.engine?.setSession({ sessionId: run.sessionId, transcriptPath });
  }
  run.recorder.start(run.sessionId, {
    isNew: !requested, command, ownerUserId: run.userId, localModel: run.local ? dshLocalModelIds(run.local).recorded : null,
  });
  recordParticipant(run, cwd);
  // ADR-227 / T-2108: a new local chat's pin must settle, or the run stops.
  if (run.local && !requested) recordLocalEnginePinOrThrow({ newSessionId: run.sessionId, parentSessionId: null, pin: run.local.pin });
  if (model) {
    const value = modelConfigValue(opened.configOptions, model);
    if (!value) throw Object.assign(new Error(`dsh does not offer model ${model}`), { code: 'dsh_model_unavailable' });
    await connection.request('session/set_config_option', { sessionId: run.sessionId, configId: 'model', value });
  }
  if (effort) {
    await connection.request('session/set_config_option', {
      sessionId: run.sessionId, configId: 'reasoning_effort', value: effort,
    });
  }
}

/** Runs the ACP exchange of one turn; resolves with the failure, if any. */
async function exchange(run, input, busySessions) {
  try {
    await openSession(run, input, busySessions);
    // T-2108 qa condition 1: nothing reaches the model unless the policy plugin's hello was accepted.
    if (!run.broker?.state?.hello) throw Object.assign(new Error(MESSAGES.dsh_handshake_missing), { code: 'dsh_cap_channel' });
    const context = (run.promptContext ?? []).map((text) => ({ type: 'text', text }));
    const result = await run.connection.request('session/prompt', {
      sessionId: run.sessionId, prompt: [...promptBlocks(input.command, input.coordinationLevel), ...context],
    });
    if (result?.stopReason === 'cancelled') run.aborted = true;
    await run.connection.request('session/close', { sessionId: run.sessionId }).catch(() => {});
    return null;
  } catch (error) {
    return error;
  }
}

/** Stderr summary for the log: its length and last line only (never the body); every secret redacted. */
function stderrSummary(run) {
  const secrets = [run.apiKey, run.localToken].filter((value) => typeof value === 'string' && value !== '');
  const tail = secrets.reduce((text, secret) => text.replaceAll(secret, '[key]'), run.stderrTail);
  const lines = tail.trim().split('\n');
  return { stderrBytes: run.stderrBytes, stderrLastLine: (lines.at(-1) ?? '').slice(0, 200) };
}

/** Settles one turn: permissions, process group, transcript, terminal frame. */
async function finishRun(run, requested, failure) {
  cancelDshPermissionsForRun(run.runId);
  const { code, error: spawnError } = await endChild(run);
  await run.recorder.finish();
  run.mirror?.flushText();
  const violation = run.policyViolation
    ? Object.assign(new Error(MESSAGES[run.policyViolation]), { code: run.policyViolation }) : null;
  const failed = violation ?? failure ?? (spawnError && !run.aborted ? spawnError : null);
  if (failed && !run.aborted) {
    console.error('[dsh] turn failed', { userId: run.userId, error: failed.message, ...stderrSummary(run) });
    emit(run.writer, run.sessionId ?? requested, { kind: 'error', code: failed.code ?? 'dsh_turn_failed', content: failed.message });
    // T-2091: a capability failure right after a pipeline switch rolls the update back.
    if (DSH_CAPABILITY_CODES.includes(failed.code)) void reportDshLaunchCapability(failed.code, run.operatorHome ?? os.homedir());
  }
  const exitCode = run.aborted ? 0 : (failed ? 1 : (code ?? 1));
  emit(run.writer, run.sessionId ?? requested, {
    kind: 'complete', exitCode, success: exitCode === 0 && !run.aborted, isNewSession: !requested,
    ...(run.aborted ? { aborted: true } : {}),
  });
}

/** Validates the turn input that needs no process; returns a refusal code or null. */
function checkInput({ cwd, effort, requested, coordinationLevel }) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return 'dsh_cwd_missing';
  }
  if (requested !== null && !DSH_SESSION_ID.test(requested)) return 'dsh_session_id_invalid';
  if (effort !== null && !DSH_REASONING_EFFORTS.includes(effort)) return 'dsh_effort_unsupported';
  if (coordinationLevel !== undefined && coordinationLevel !== null && coordinationLevel !== 'direct') {
    return 'dsh_coordination_unsupported';
  }
  return null;
}

/** The turn input read once from the client options. */
function readTurnInput(options) {
  const requested = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : null;
  const cwd = options.cwd || options.projectPath;
  return {
    requested, cwd, projectPath: options.projectPath || cwd,
    // The committed client (377c1f2df) sends `reasoningEffort`; `effort` is accepted too.
    effort: [options.reasoningEffort, options.effort].find((v) => typeof v === 'string' && v !== '') ?? null,
    coordinationLevel: options.coordinationLevel,
  };
}

/**
 * Builds a dsh runtime. The default instance below is what the server uses;
 * tests build their own with their seams.
 * @param {{ claudeEnv?: (userId: unknown) => NodeJS.ProcessEnv|null, managedSettingsDir?: string,
 *   serverEnv?: NodeJS.ProcessEnv, localDeps?: Record<string, Function>, localRunsRoot?: string }} [deps]
 *   `claudeEnv`/`managedSettingsDir` go to the Claude permission parity resolver; `localDeps`
 *   (resolveDshLocalEngineOrThrow) and `localRunsRoot` are the local-turn seams (T-2108)
 */
export function createDshRuntime(deps = {}) {
  /** @type {Map<string, any>} live runs by run id */
  const runs = new Map();
  /** dsh session ids with a turn admitted or running. */
  const busySessions = new Set();

  /**
   * The session record of a resume: a refusal (ownership), or the model recorded
   * for a local chat (T-2108 qa HIGH 4: the server's own record of it).
   */
  async function sessionRecord(input, userId) {
    if (!input.requested) return { refusal: null, model: null };
    const record = await readDshSessionRecord(input.requested, input.projectPath);
    if (record === null) return { refusal: 'dsh_session_unknown', model: null };
    return record.ownerUserId === String(userId)
      ? { refusal: null, model: record.model } : { refusal: 'dsh_shared_session_unsupported', model: null };
  }

  /** Spawns the prepared launch (the one dsh spawn site) and wires its ACP connection. */
  function startRun(launch, input, writer, base) {
    const env = assertExactDshEnv(sanitizeVendorAgentEnv(launch.env), base.local ? DSH_LOCAL_ENV_ALLOW_LIST : undefined);
    // fd 3: the policy plugin's channel (T-2089); the plugin decides nothing on its own.
    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false, detached: true,
    });
    const run = { ...base, child, writer, home: launch.home, toolCalls: new Map(), stderrTail: '', stderrBytes: 0 };
    attachBroker(run, base.engine);
    run.exited = new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stderr.on('data', (chunk) => {
      run.stderrBytes += chunk.length;
      run.stderrTail = (run.stderrTail + chunk).slice(-1024);
    });
    child.stdin.on('error', () => {});
    run.connection = new AcpConnection({
      input: child.stdout, output: child.stdin,
      onNotification: (method, params) => { if (method === 'session/update') onSessionUpdate(run, params); },
      onRequest: (method, params) => onAgentRequest(run, method, params),
    });
    run.exited.then(() => run.connection.close(new Error('dsh exited')));
    runs.set(run.runId, run);
    return run;
  }

  /** Every pre-spawn check that needs the member: parity, the launch seam (local or cloud), the turn's engine. */
  async function prepare(options, input, userId, runId, localPath, recordedModel) {
    const parity = resolveDshPermissionParity(options, { userId, cwd: input.cwd }, deps);
    const local = localPath ? await prepareDshLocalLaunch({
      userId, storedEngine: localPath.storedEngine, requestedModel: options.model ?? null, recordedModel,
    }, deps) : null;
    const launch = local?.launch ?? prepareDshLaunch({ userId });
    if (!local) assertDshOverrideSemantics(launch, deps.serverEnv ?? process.env);
    const sessionId = input.requested ?? `pending-${runId}`;
    const transcriptPath = claudeTranscriptMirrorPath(launch.home, sessionId);
    const engine = parity.createEngine({ home: launch.home, sessionId, transcriptPath });
    const mirror = new ClaudeTranscriptMirror({ file: transcriptPath, sessionId, cwd: input.cwd });
    return { launch, engine, mirror, resolved: local?.resolved ?? null };
  }

  /** The run's fixed fields; a local turn records its qualified model id and carries its token. */
  function runBase({ runId, userId, input, options, prepared, promptContext, token }) {
    const local = prepared.resolved?.local ?? null;
    const model = local ? dshLocalModelIds(local).recorded : (options.model || null);
    return {
      runId, userId, sessionId: input.requested, local, localToken: token ?? null,
      recorder: new DshTranscriptRecorder({ projectPath: input.projectPath, model }),
      apiKey: prepared.launch.env.DEEPSEEK_API_KEY, engine: prepared.engine, mirror: prepared.mirror, promptContext,
    };
  }

  /** Claude's UserPromptSubmit hooks, before any process exists: a block sends nothing to DeepSeek. */
  async function promptGate(engine, mirror, command, writer, input) {
    const gate = await engine.userPromptSubmit({ prompt: String(command ?? '') });
    for (const notice of gate.notices ?? []) console.warn('[dsh] UserPromptSubmit hook error', { notice: String(notice).slice(0, 200) });
    if (gate.blocked) {
      refuse(writer, input.requested, 'dsh_prompt_blocked', { error: gate.reason || MESSAGES.dsh_prompt_blocked });
      return null;
    }
    mirror.user(command);
    return gate.additionalContext ?? [];
  }

  /** Prepares, gates and spawns an admitted turn; `cleanup` collects what a failure must undo. */
  async function spawnAdmitted(options, writer, input, command, localPath, cleanup) {
    const userId = writer?.userId ?? null;
    const record = await sessionRecord(input, userId);
    if (record.refusal) throw Object.assign(new Error(record.refusal), { refusal: record.refusal });
    const runId = crypto.randomUUID();
    const prepared = await prepare(options, input, userId, runId, localPath, record.model);
    const promptContext = await promptGate(prepared.engine, prepared.mirror, command, writer, input);
    if (promptContext === null) throw Object.assign(new Error('dsh_prompt_blocked'), { refused: true });
    if (refuseSpawnIfHarnessUpdating(PROVIDER, writer, { sessionId: input.requested, clientMsgId: options.clientMsgId })) {
      throw Object.assign(new Error('harness_updating'), { refused: true });
    }
    cleanup.push(beginHarnessLaunch(PROVIDER));
    // T-2108 qa condition 4: the corrector opens only after the prompt hooks admitted the turn.
    const opened = prepared.resolved
      ? await openDshLocalTurn({ launch: prepared.launch, resolved: prepared.resolved, runId },
        { serverEnv: deps.serverEnv, runsRoot: deps.localRunsRoot })
      : null;
    if (opened) cleanup.push(() => void opened.close().catch(() => {}));
    const run = startRun(opened?.launch ?? prepared.launch, input, writer,
      runBase({ runId, userId, input, options, prepared, promptContext, token: opened?.token }));
    const undo = cleanup.splice(0);
    run.exited.then(() => { for (const step of undo) step(); });
    return run;
  }

  /** Admits, prepares and spawns one turn; returns the run, or null after a refusal frame. */
  async function launchTurn(options, writer, input, command) {
    const inputRefusal = checkInput(input);
    if (inputRefusal) return void refuse(writer, input.requested, inputRefusal);
    let localPath;
    try {
      localPath = dshLocalPath(input, options.model);
    } catch (error) {
      if (refuseLaunchError(writer, input.requested, error)) return null;
      throw error;
    }
    if (input.requested && busySessions.has(input.requested)) return void refuse(writer, input.requested, 'session_busy');
    if (input.requested) busySessions.add(input.requested);
    const cleanup = [];
    try {
      return await spawnAdmitted(options, writer, input, command, localPath, cleanup);
    } catch (error) {
      for (const step of cleanup) step();
      if (input.requested) busySessions.delete(input.requested);
      if (error?.refusal) return void refuse(writer, input.requested, error.refusal);
      if (error?.refused) return null;
      if (refuseLaunchError(writer, input.requested, error)) return null;
      throw error;
    }
  }

  /**
   * Runs one dsh turn for the member on `writer.userId` and streams it to `writer`.
   * @param {string} command the member's message
   * @param {{ sessionId?: string|null, cwd?: string, projectPath?: string, model?: string|null,
   *   reasoningEffort?: string|null, coordinationLevel?: string, permissionMode?: string,
   *   toolsSettings?: object, permissionExecution?: object, clientMsgId?: string }} options
   * @param {{ userId: number, send: Function, setSessionId?: Function, ws?: any }} writer
   * @returns {Promise<void>} resolves after the terminal frame
   */
  async function spawnDsh(command, options = {}, writer) {
    const input = readTurnInput(options);
    const run = await launchTurn(options, writer, input, command);
    if (!run) return;
    try {
      const failure = await exchange(run, {
        requested: input.requested, cwd: input.cwd, model: run.local ? dshLocalModelIds(run.local).selected : (options.model || null),
        effort: input.effort,
        command, coordinationLevel: input.coordinationLevel,
      }, busySessions);
      await finishRun(run, input.requested, failure);
    } finally {
      runs.delete(run.runId);
      busySessions.delete(run.sessionId);
      if (input.requested) busySessions.delete(input.requested);
    }
  }

  /**
   * Cancels the running turn of `sessionId`; with no id, the newest run on
   * `rawWs` (Claude's empty-id abort race). Returns true when one was running.
   */
  function abortDshSession(sessionId, rawWs = null) {
    const live = [...runs.values()];
    const run = sessionId
      ? live.find((entry) => entry.sessionId === sessionId)
      : live.filter((entry) => rawWs && entry.writer?.ws === rawWs).at(-1);
    if (!run) return false;
    run.aborted = true;
    cancelDshPermissionsForRun(run.runId);
    if (run.sessionId) run.connection.notify('session/cancel', { sessionId: run.sessionId });
    void endChild(run);
    return true;
  }

  /** Session ids with a live dsh turn. */
  const getActiveDshSessions = () => [...runs.values()].map((run) => run.sessionId).filter(Boolean);

  return {
    spawnDsh,
    abortDshSession,
    getActiveDshSessions,
    isDshSessionActive: (sessionId) => getActiveDshSessions().includes(sessionId),
    /** Live dsh runs, including those whose session id is not known yet (drain). */
    countDshRuns: () => runs.size,
    /** Ends every live dsh turn (drain, shutdown, tests). */
    stopDshProcesses: async () => {
      await Promise.all([...runs.values()].map((run) => {
        cancelDshPermissionsForRun(run.runId);
        return endChild(run, 200);
      }));
    },
  };
}

const runtime = createDshRuntime();
export const {
  spawnDsh, abortDshSession, getActiveDshSessions, isDshSessionActive, countDshRuns, stopDshProcesses,
} = runtime;

export { cancelAllDshPermissions, resolveDshPermission } from './dsh-permissions.js';
