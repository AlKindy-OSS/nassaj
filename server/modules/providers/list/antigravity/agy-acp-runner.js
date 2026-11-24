/**
 * Antigravity over ACP (T-2094, ADR-232) — the agy specifics on top of the
 * generic shared/acp client and pool. Behind NASSAJ_AGY_ACP (off by default,
 * read on every turn); agy-cli.js keeps the `agy -p` path as the fallback.
 *
 * One turn is three phases, so agy-cli.js can keep its run-fence contract
 * (no await between the last fence check and the spawn):
 *   A. prepareAgyAcpLaunch (async): member env, caged launch, binary identity,
 *      cached capability probe, env fingerprint. May answer `fallback`.
 *   B. admitAgyAcpTurn (sync): beginHarnessLaunch + pool acquire (lazy spawn).
 *   C. driveAgyAcpTurn (async): initialize, new/resume/load, set_model,
 *      prompt with live text, stopReason → exit code.
 */

import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import { resolveProviderEnv } from '../../../../services/isolation/resolve-provider-env.js';
import { resolveCagedLaunch } from '../../../../services/isolation/provider-cage-wiring.js';
import { resolveCredentialPrincipal } from '../../../../services/isolation/credential-principal.js';
import { registerWarmCredentialProcess } from '../../../../services/isolation/warm-credential-processes.js';
import { assertModelRunActor, isMemberActor } from '../../../../services/isolation/credential-actor.js';
import { resolveHarnessBinary } from '../../../../shared/harness-binaries.js';
import { beginHarnessLaunch } from '../../harness-update/spawn-admission.js';
import { computeAcpCapacity, createAcpProcessPool } from '../../shared/acp/acp-process-pool.js';
import { createAcpSessionClient, createAutoAllowPermissionPolicy, isAcpAuthRequired } from '../../shared/acp/acp-session-client.js';

/** Spawn argv after the binary; `--add-dir <cwd>` is appended per launch. */
export const AGY_ACP_ARGS = Object.freeze(['acp', '--dangerously-skip-permissions', '--disable-telemetry']);
const KILL_GRACE_MS = 5000;
const CANCEL_WAIT_MS = 5000;
const PROBE_TIMEOUT_MS = 15_000;

let capacityOverride = null;
export const agyAcpPool = createAcpProcessPool({
  provider: 'antigravity',
  capacity: () => (capacityOverride ? capacityOverride() : computeAcpCapacity()),
});

/** Test seam: pin the pool capacity (null restores the memory-derived cap). */
export function _setAgyAcpCapacityForTests(fn) {
  capacityOverride = fn;
}

/** NASSAJ_AGY_ACP, re-read on every turn (QA 5). */
export function isAgyAcpEnabled(env = process.env) {
  return ['1', 'true', 'on', 'yes'].includes(String(env.NASSAJ_AGY_ACP ?? '').trim().toLowerCase());
}

/**
 * Pool key: one process per member per conversation (brain UUID). A missing
 * member is refused (ADR-152 A1): there is no operator process to share.
 */
export function agyAcpPoolKey(userId, brainUUID) {
  return `${assertModelRunActor(userId)}:${brainUUID}`;
}

/** QA 5: a `-p` run on a conversation first kills its pooled ACP process. */
export function killPooledAgyForConversation(userId, brainUUID) {
  if (!brainUUID || !isMemberActor(userId)) return false;
  return agyAcpPool.killKey(agyAcpPoolKey(userId, brainUUID), 'print_mode_run');
}

/** Grant revocation / member removal: kill the member's processes now. */
export function killPooledAgyForMember(userId, options = {}) {
  return agyAcpPool.killMember(userId, options);
}

/** Server shutdown. */
export function shutdownAgyAcp() {
  agyAcpPool.shutdown();
}

/** realpath + inode + mtime of the binary (QA 2): a replaced binary is a new identity. */
export function agyBinaryIdentity(binaryPath, deps = fs) {
  try {
    const real = deps.realpathSync(binaryPath);
    const stat = deps.statSync(real);
    return `${real}:${stat.ino}:${stat.mtimeMs}`;
  } catch {
    return `unresolved:${binaryPath}`;
  }
}

/**
 * QA 3: what a pooled process was started with. Credential identity is the
 * principal/grant ids only — never a token or a token hash. Never logged.
 */
export function fingerprintAgyLaunch({ env, principal, binaryId, launch }) {
  return createHash('sha256').update(JSON.stringify({
    home: env?.HOME ?? null,
    principalId: principal?.principalId ?? null,
    grantedBy: principal?.grantedBy ?? null,
    binaryId,
    cmd: launch.cmd,
    args: launch.args,
  })).digest('hex');
}

/** The auth method whose credential exists in the member HOME, else null (never a browser login). */
export function resolveAgyAuthMethod(env, exists = fs.existsSync) {
  const home = env?.HOME;
  if (home && exists(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))) return 'oauth-personal';
  if (typeof env?.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim()) return 'gemini-api-key';
  return null;
}

/**
 * Questions from agy (`interaction_*` tool calls) are not permissions. The
 * `-p` path cannot answer them either (stdin is closed); here they are
 * cancelled and logged. See ADR-232 for the unverified behavioural difference.
 */
export const agyPermissionPolicy = createAutoAllowPermissionPolicy({
  isQuestion: (toolCall) => String(toolCall?.toolCallId ?? '').startsWith('interaction_'),
  onQuestion: (params) => {
    console.warn(JSON.stringify({ event: 'agy_acp_question_cancelled', sessionId: params?.sessionId ?? null }));
    return { outcome: { outcome: 'cancelled' } };
  },
});

const capabilityCache = new Map();

/** Clears the capability cache (tests). */
export function _resetAgyAcpCapability() {
  capabilityCache.clear();
}

/** Runs one short probe child for `member`; resolves { code, stdout } (child for initialize). */
function runProbeChild(launch, { member, env, cwd, stdin = 'ignore' }) {
  assertModelRunActor(member);
  const release = beginHarnessLaunch('antigravity');
  const child = spawn(launch.cmd, launch.args, { cwd, env, stdio: [stdin, 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
  timer.unref?.();
  const done = new Promise((resolve) => {
    let stdout = '';
    child.stdout?.on('data', (b) => { if (stdout.length < 65536) stdout += b; });
    child.on('error', () => resolve({ code: null, stdout }));
    child.on('close', (code) => resolve({ code, stdout }));
  }).finally(() => { clearTimeout(timer); release(); });
  return { child, done };
}

/** `agy acp --help` succeeds AND initialize answers protocol 1. Definitive answers are cached. */
async function probeCapability({ member, helpLaunch, launch, env, cwd }) {
  const help = await runProbeChild(helpLaunch, { member, env, cwd }).done;
  if (help.code === null) return { ok: false, cache: false };
  if (help.code !== 0 || !/Agent Client Protocol/i.test(help.stdout)) return { ok: false, cache: true };
  const probe = runProbeChild(launch, { member, env, cwd, stdin: 'pipe' });
  probe.child.stdin.on('error', () => {});
  const client = createAcpSessionClient({ input: probe.child.stdout, output: probe.child.stdin });
  // A probe child that dies must end the probe now, not at the initialize timeout.
  probe.done.then(() => client.dispose());
  try {
    await client.initialize();
    return { ok: true, cache: true };
  } catch (error) {
    return { ok: false, cache: error?.code === 'acp_protocol_unsupported' };
  } finally {
    client.dispose();
    probe.child.kill('SIGKILL');
    await probe.done;
  }
}

/** Cached per binary identity; a failed probe sends the turn to `-p`. */
function isAgyAcpCapable(binaryId, spec) {
  if (!capabilityCache.has(binaryId)) {
    const pending = probeCapability(spec).then((verdict) => {
      if (!verdict.cache) capabilityCache.delete(binaryId);
      return verdict.ok;
    }, () => {
      capabilityCache.delete(binaryId);
      return false;
    });
    capabilityCache.set(binaryId, pending);
  }
  return capabilityCache.get(binaryId);
}

/**
 * Phase A. Recomputed on EVERY turn (QA 3): env, credential identity, binary
 * identity and the caged launch feed the fingerprint the pool compares.
 * Throws when the member's env is refused (no spawn happens).
 * @returns {Promise<{fallback: string}|{key: string, env: object, launch: object, fingerprint: string, cwd: string}>}
 */
export async function prepareAgyAcpLaunch({ userId, cwd, brainUUID }) {
  // ADR-152 A1 (T-2083): a model run names a real member, as the `-p` path does.
  const member = assertModelRunActor(userId);
  const env = resolveProviderEnv(member, 'agy', process.env);
  const cmd = resolveHarnessBinary('antigravity');
  const binaryId = agyBinaryIdentity(cmd);
  const launch = resolveCagedLaunch({ userId: member, provider: 'agy', cmd, args: [...AGY_ACP_ARGS, '--add-dir', cwd], cwd });
  const helpLaunch = resolveCagedLaunch({ userId: member, provider: 'agy', cmd, args: ['acp', '--help'], cwd });
  if (!(await isAgyAcpCapable(binaryId, { member, helpLaunch, launch, env, cwd }))) return { fallback: 'capability' };
  const principal = resolveCredentialPrincipal(member, 'agy');
  const fingerprint = fingerprintAgyLaunch({ env, principal, binaryId, launch });
  const key = agyAcpPoolKey(member, brainUUID ?? `new:${randomUUID()}`);
  return { key, env, launch, fingerprint, cwd, member, principalId: Number(principal.principalId) };
}

/** Keeps the last `Error:` line of agy's stderr for the failure reason (B-394). */
function watchStderr(child, state) {
  const decoder = new StringDecoder('utf8');
  child.stderr?.on('data', (chunk) => {
    const msg = decoder.write(chunk);
    if (!msg || msg.includes('DeprecationWarning') || msg.includes('[DEP')) return;
    console.error('[agy acp stderr]', msg.trim());
    const line = msg.split('\n').map((l) => l.trim()).filter((l) => /^error:/i.test(l)).pop();
    if (line) state.lastStderrError = line;
  });
}

/** Spawns one long-lived `agy acp` child and wraps it as a pool handle. */
function spawnAgyAcpChild(plan, state) {
  const child = spawn(plan.launch.cmd, plan.launch.args, { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin?.on('error', () => {});
  const exits = [];
  let exited = false;
  const onGone = () => {
    if (exited) return;
    exited = true;
    state.client?.dispose(Object.assign(new Error('agy ACP process exited'), { code: 'acp_process_exited' }));
    exits.forEach((cb) => cb());
  };
  child.on('exit', onGone);
  child.on('error', (err) => { state.spawnError = err; onGone(); });
  watchStderr(child, state);
  state.client = createAcpSessionClient({
    input: child.stdout,
    output: child.stdin,
    permissionPolicy: agyPermissionPolicy,
    onFatal: (error) => { state.fatal = error; handle.kill('SIGTERM'); },
  });
  const handle = {
    pid: child.pid ?? null,
    child,
    kill(signal = 'SIGTERM') {
      if (exited) return;
      try { child.kill(signal); } catch { /* already gone */ }
      const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, KILL_GRACE_MS);
      timer.unref?.();
    },
    onExit: (cb) => exits.push(cb),
  };
  return handle;
}

/**
 * ADR-152 A1 §3.5: a pooled process outlives its turn on the credential it was
 * spawned on, so it is a warm credential process. A revoked or declined grant,
 * or a disabled grant owner, terminates it through warm-credential-processes.
 * Registered under unit 'agy', the unit the admission gate checks and sweeps
 * (credential-gate.js), and unregistered when the process exits.
 */
function registerWarmAgyProcess(entry, plan) {
  const unregister = registerWarmCredentialProcess({
    userId: plan.member,
    unit: 'agy',
    principalId: plan.principalId,
    terminate: (reason) => agyAcpPool.kill(entry, reason),
  });
  entry.handle.onExit(unregister);
}

/**
 * Phase B (synchronous: no await between the caller's fence check and the
 * spawn). Reserves the launch for this turn, then takes the pooled process.
 * @returns {{status:'full'|'busy'}|{status:'ready', entry:any, releaseLaunch:() => void}}
 */
export function admitAgyAcpTurn(plan) {
  const releaseLaunch = beginHarnessLaunch('antigravity');
  let acquired;
  try {
    const state = {};
    acquired = agyAcpPool.acquire({
      key: plan.key, userId: plan.member, fingerprint: plan.fingerprint, cwd: plan.cwd,
      spawn: () => spawnAgyAcpChild(plan, state),
    });
    if (acquired.status === 'spawned') {
      acquired.entry.state.live = state;
      registerWarmAgyProcess(acquired.entry, plan);
    }
  } catch (error) {
    releaseLaunch();
    throw error;
  }
  if (acquired.status !== 'spawned' && acquired.status !== 'reused') {
    releaseLaunch();
    return { status: acquired.status };
  }
  const live = acquired.entry.state.live;
  live.lastStderrError = null;
  live.fatal = null;
  return { status: 'ready', entry: acquired.entry, releaseLaunch };
}

/** Opens (or reuses) the conversation inside this process; returns the brain UUID. */
async function ensureAgySession(entry, turn) {
  const live = entry.state.live;
  const client = live.client;
  const authMethod = () => resolveAgyAuthMethod(turn.env);
  if (!live.initialized) {
    await client.initialize();
    live.initialized = true;
  }
  if (turn.brainUUID && live.sessionId === turn.brainUUID) return { brainUUID: turn.brainUUID, isNew: false };
  if (turn.brainUUID) {
    await client.withAuth(() => client.openExistingSession({ sessionId: turn.brainUUID, cwd: turn.cwd }), authMethod);
    live.sessionId = turn.brainUUID;
    return { brainUUID: turn.brainUUID, isNew: false };
  }
  const created = await client.withAuth(() => client.newSession({ cwd: turn.cwd }), authMethod);
  if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new Error('agy ACP session/new returned no sessionId');
  live.sessionId = created.sessionId;
  agyAcpPool.rekey(entry, agyAcpPoolKey(turn.userId, created.sessionId));
  return { brainUUID: created.sessionId, isNew: true };
}

/** Best effort: agy keeps its brain model when this fails (like an unknown `--model`). */
async function applyAgyModel(client, brainUUID, turn) {
  if (!turn.modelLabel) return;
  try {
    await client.setModel(brainUUID, turn.modelValue || turn.modelLabel);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'agy_acp_set_model_failed', error: String(error?.message || error) }));
  }
}

/** User-facing failure text for a failed turn (stderr wins, as in B-394). */
function agyAcpFailureReason(live, error, killReason) {
  if (live.lastStderrError) return live.lastStderrError;
  if (killReason) return `agy run was stopped (${killReason}).`;
  if (live.fatal) return 'agy ACP output exceeded the line limit; the process was stopped.';
  if (isAcpAuthRequired(error)) return 'agy authentication required for this account. Sign in to Antigravity and try again.';
  if (error?.code === 'acp_process_exited' || live.spawnError) return 'agy ACP process exited unexpectedly.';
  return String(error?.message || error || 'agy ACP turn failed');
}

/** Streams one prompt; text goes to `turn.onText` until the run fence is revoked. */
async function promptAgy(live, brainUUID, turn) {
  let cancelSent = false;
  const onEvent = (event) => {
    if (turn.isRevoked()) {
      if (!cancelSent) { cancelSent = true; live.client.cancel(brainUUID); }
      return;
    }
    if (event.type === 'text' && event.text) turn.onText(event.text);
    else if (event.type !== 'text') console.debug?.(JSON.stringify({ event: 'agy_acp_update', type: event.type }));
  };
  return live.client.prompt({ sessionId: brainUUID, text: turn.text, onEvent });
}

/**
 * Phase C. `turn`: { userId, env, cwd, brainUUID, text, modelValue, modelLabel,
 * isRevoked(), onText(text), onSessionReady({brainUUID,isNew}) }.
 * Never throws: every failure becomes `{ code: 1, failureReason }`.
 * @returns {Promise<{code: number, brainUUID: string|null, stopReason: string|null, failureReason: string|null}>}
 */
export async function driveAgyAcpTurn(entry, turn) {
  const live = entry.state.live;
  live.turnId = (live.turnId ?? 0) + 1;
  live.turnSettled = false;
  let brainUUID = turn.brainUUID ?? null;
  try {
    const session = await ensureAgySession(entry, turn);
    brainUUID = session.brainUUID;
    turn.onSessionReady(session);
    await applyAgyModel(live.client, brainUUID, turn);
    if (turn.isRevoked()) return { code: 1, brainUUID, stopReason: null, failureReason: null };
    const stopReason = await promptAgy(live, brainUUID, turn);
    const code = stopReason === 'end_turn' && !live.fatal ? 0 : 1;
    return { code, brainUUID, stopReason, failureReason: code === 0 || stopReason === 'cancelled' ? null : `agy stopped: ${stopReason}` };
  } catch (error) {
    return { code: 1, brainUUID, stopReason: null, failureReason: agyAcpFailureReason(live, error, entry.killReason) };
  } finally {
    live.turnSettled = true;
    agyAcpPool.release(entry, { keep: !live.fatal && !live.client.closed });
  }
}

/**
 * Abort: session/cancel, wait ≤5 s for the turn to settle (stopReason
 * cancelled), then SIGTERM → SIGKILL. Returns synchronously. The kill is bound
 * to the turn that was aborted: if it settled and the same process started
 * another turn within the wait, the stale timer leaves that turn alone.
 */
export function abortAgyAcpTurn(entry) {
  const live = entry?.state?.live;
  if (!live?.client) return false;
  const abortedTurnId = live.turnId;
  if (live.sessionId) live.client.cancel(live.sessionId);
  const timer = setTimeout(() => {
    if (live.turnId === abortedTurnId && !live.turnSettled) agyAcpPool.kill(entry, 'abort_timeout');
  }, CANCEL_WAIT_MS);
  timer.unref?.();
  return true;
}
