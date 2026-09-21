/**
 * Private, process-local authority for managed Claude terminals.
 *
 * A terminal never receives a principal or a bearer credential.  Its PATH shim
 * can only present an opaque selector over this process' 0600 Unix socket; the
 * broker binds that selector to the registered PTY process tree and retains the
 * canonical authentication snapshot on the server side.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import util from 'node:util';

import type { PermissionChildIdentity } from '@/modules/database/index.js';
import { readRuntimeProcessIdentity, type PermissionExecutionHandle } from '@/modules/execution-permissions/index.js';

import type { ManagedClaudeTerminalMode } from './managed-claude-terminal-env.js';

export const MANAGED_CLAUDE_BROKER_SOCKET_ENV = 'NASSAJ_MANAGED_CLAUDE_BROKER_SOCKET';
export const MANAGED_CLAUDE_BROKER_SELECTOR_ENV = 'NASSAJ_MANAGED_CLAUDE_BROKER_SELECTOR';
const TTL_MS = 30 * 60_000;
const REQUEST_LIMIT = 64 * 1024;
// Opt-in via NODE_DEBUG=nassaj-claude-broker; silent in production.
const debug = util.debuglog('nassaj-claude-broker');

type Registration = {
  selector: string;
  actor: unknown;
  userId: number;
  mode: ManagedClaudeTerminalMode;
  sessionId: string | null;
  cwd: string;
  realBinary: string;
  baseEnv: NodeJS.ProcessEnv;
  createdAt: number;
  ptyPid: number | null;
  ptyStartTicks: string | null;
  revoked: boolean;
};
function readBootId(): string {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || 'boot-unavailable'; }
  catch { return 'boot-unavailable'; }
}
type Pending = { registration: Registration; env: NodeJS.ProcessEnv; execution: PermissionExecutionHandle | null; expiresAt: number; started: boolean; identity: PermissionChildIdentity | null };
const registrations = new Map<string, Registration>();
const pending = new Map<string, Pending>();
let server: net.Server | null = null;
let socketPath: string | null = null;
let socketDirectory: string | null = null;
let exitCleanupInstalled = false;

const readStartTicks = (pid: number): string | null => {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const suffix = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);
    return suffix[19] ?? null;
  } catch { return null; }
};
const isDescendant = (pid: number, ancestor: number): boolean => {
  for (let current = pid, steps = 0; current > 1 && steps < 64; steps += 1) {
    if (current === ancestor) return true;
    try {
      const stat = fs.readFileSync(`/proc/${current}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
      current = Number(fields[1]); // PPID follows process state.
    } catch { return false; }
  }
  return false;
};
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const resumeFromArgv = (argv: string[]): string | null => {
  let session: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--') break;
    if (value === '--continue' || value === '-c') return fail('BROKER_RESUME_INVALID');
    let candidate: string | null = null;
    if (value === '--resume' || value === '-r') candidate = argv[++index] ?? '';
    else if (value.startsWith('--resume=')) candidate = value.slice(9);
    else if (value.startsWith('-r=')) candidate = value.slice(3);
    else if (value.startsWith('-r') && value.length > 2) candidate = value.slice(2);
    if (candidate !== null) {
      if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(candidate) || session !== null) return fail('BROKER_RESUME_INVALID');
      session = candidate;
    }
  }
  return session;
};
const validate = (record: Registration, pid: unknown, startTicks: unknown): number => {
  const callerPid = typeof pid === 'number' && Number.isSafeInteger(pid) ? pid : fail('BROKER_CALLER_PID_INVALID');
  if (record.revoked || Date.now() - record.createdAt > TTL_MS) fail('BROKER_SELECTOR_EXPIRED');
  if (record.ptyPid === null || record.ptyStartTicks === null) return fail('BROKER_PTY_UNBOUND');
  const rootPid = record.ptyPid;
  const rootStartTicks = record.ptyStartTicks;
  if (!isDescendant(callerPid, rootPid) || readStartTicks(rootPid) !== rootStartTicks
    || readStartTicks(callerPid) !== startTicks) fail('BROKER_PTY_IDENTITY_MISMATCH');
  return callerPid;
};

async function authorize(record: Registration, pid: unknown, startTicks: unknown, argv: unknown): Promise<Record<string, unknown>> {
  validate(record, pid, startTicks);
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string' || value.length > 8192)) fail('BROKER_ARGV_INVALID');
  const requestedSession = resumeFromArgv(argv as string[]);
  if (record.mode === 'session-bound' && requestedSession !== record.sessionId) fail('BROKER_SESSION_SCOPE_MISMATCH');
  const targetSessionId = record.mode === 'session-bound' ? record.sessionId : requestedSession;
  const [{ assertSessionAccessible }, { resolveClaudeRunProfileOrThrow }, { authorizeRuntimeUserProviderEffect }] = await Promise.all([
    import('@/modules/providers/index.js'),
    import('./resolve-claude-run-profile.js'),
    // eslint-disable-next-line boundaries/dependencies
    import('@/modules/execution-permissions/runtime-user-effect.js'),
  ]);
  if (targetSessionId) assertSessionAccessible(targetSessionId, record.userId, 'write');
  const profile = await resolveClaudeRunProfileOrThrow({
    userId: record.userId, authenticatedPrincipal: record.actor, sessionId: targetSessionId,
    baseEnv: record.baseEnv, envAlreadyIsolated: true, authoritativeStoredPin: targetSessionId !== null,
    requireKnownResumePin: targetSessionId !== null, failOnAmbiguous: true,
  });
  const execution = authorizeRuntimeUserProviderEffect({
    authenticatedPrincipal: record.actor, provider: 'claude', engine: profile.effectiveEngine ?? 'anthropic',
    entrypoint: 'terminal.managed-claude', purpose: 'spawn', effectFootprint: 'local', sessionId: targetSessionId,
    projectId: targetSessionId ? `session:${targetSessionId}` : `terminal:${record.mode}`,
    workspacePath: record.cwd,
  });
  const launch = crypto.randomUUID();
  pending.set(launch, { registration: record, env: profile.env, execution, expiresAt: Date.now() + 30_000, started: false, identity: null });
  return { launch, env: profile.env };
}
function start(record: Registration, pid: unknown, startTicks: unknown, launch: unknown): Record<string, unknown> {
  // validate() re-proves the caller is a live descendant of the registered pty
  // leader with matching start ticks, so its returned pid is the wrapper's exact
  // identity — safe to record for boot reconciliation and for revoke-time kill.
  const callerPid = validate(record, pid, startTicks);
  const item = typeof launch === 'string' ? pending.get(launch) : undefined;
  if (!item || item.registration !== record || item.expiresAt <= Date.now() || item.started) return fail('BROKER_LAUNCH_INVALID');
  const active = item;
  // T-1593/B-1074: record the wrapper's kernel identity (pid + boot id + start
  // ticks). The wrapper is not the CLI child, but it is a local process whose
  // death boot reconciliation can prove by itself — so a closed terminal no
  // longer settles reconciled_unknown and fences 1:claude:spawn.
  const identity = readRuntimeProcessIdentity(callerPid);
  try { active.execution?.consume(); active.execution?.markStarted(identity ?? undefined); active.started = true; active.identity = identity; }
  catch (error) { pending.delete(launch as string); throw error; }
  return { ok: true };
}
function settle(record: Registration, pid: unknown, startTicks: unknown, launch: unknown, exitCode: unknown): Record<string, unknown> {
  validate(record, pid, startTicks);
  const item = typeof launch === 'string' ? pending.get(launch) : undefined;
  if (!item || item.registration !== record || !item.started) return fail('BROKER_LAUNCH_INVALID');
  const active = item;
  pending.delete(launch as string);
  active.execution?.settle(exitCode === 0 ? 'succeeded' : 'failed');
  return { ok: true };
}
async function handle(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = typeof message.selector === 'string' ? message.selector : '';
  const record = registrations.get(selector);
  if (!record) return fail('BROKER_SELECTOR_UNKNOWN');
  if (message.action === 'authorize') return authorize(record, message.pid, message.startTicks, message.argv);
  if (message.action === 'start') return start(record, message.pid, message.startTicks, message.launch);
  if (message.action === 'settle') return settle(record, message.pid, message.startTicks, message.launch, message.exitCode);
  return fail('BROKER_ACTION_INVALID');
}
function ensureServer(): string {
  if (server && socketPath) return socketPath;
  // The parent directory is private before the socket exists.  This closes the
  // old listen/chmod race: an unprivileged process can neither replace nor
  // connect to the pathname while Node finishes binding the socket.
  socketDirectory = fs.mkdtempSync(path.join('/var/tmp', `nassaj-claude-${process.pid}-`));
  fs.chmodSync(socketDirectory, 0o700);
  const candidate = path.join(socketDirectory, 'broker.sock');
  // The client half-closes immediately after one request.  Keep the writable
  // half open until the asynchronous authorization result is written back.
  // Best-effort pre-write guard only. The shim client half-closes after one
  // request and may reset the connection before authorization resolves (its 5s
  // timeout, or the PTY dying mid-handshake). In the actual reset-before-reply
  // race this guard does NOT fire — the socket is still `writable` and not yet
  // `destroyed` when we call end(), and end() does not throw synchronously.
  // The EPIPE arrives LATER as an async 'error' event, so the socket.on('error')
  // handler below is the real crash barrier; this check/try-catch is only
  // defense-in-depth for a peer that is already visibly gone.
  const writeReply = (socket: net.Socket, payload: Record<string, unknown>): void => {
    if (socket.destroyed || !socket.writable) return;
    try { socket.end(JSON.stringify(payload)); } catch { /* client vanished before reply */ }
  };
  server = net.createServer({ allowHalfOpen: true }, socket => {
    let body = '';
    socket.setEncoding('utf8');
    // THE crash barrier: a client that resets before the reply makes the reply
    // write fail as an async 'error' event; without a listener that EPIPE/
    // ECONNRESET becomes an unhandled exception and takes down the whole
    // process (the pm2 restart loop this fixed). Reset errors are expected and
    // dropped; anything else is surfaced under NODE_DEBUG=nassaj-claude-broker.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') debug('broker socket error: %s', error.message);
    });
    socket.on('data', value => { body += value; if (body.length > REQUEST_LIMIT) socket.destroy(); });
    socket.on('end', () => { void (async () => {
      try {
        const result = await handle(JSON.parse(body) as Record<string, unknown>);
        writeReply(socket, { ok: true, result });
      } catch (error) { writeReply(socket, { ok: false, code: (error as { code?: string }).code ?? 'BROKER_REFUSED' }); }
    })(); });
  });
  server.listen(candidate, () => {
    // listen is asynchronous; chmodming before this callback was an ENOENT
    // race that could leave terminal creation failing under load.
    try { fs.chmodSync(candidate, 0o600); } catch { server?.close(); }
  });
  socketPath = candidate;
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.once('exit', () => {
      if (socketDirectory) fs.rmSync(socketDirectory, { recursive: true, force: true });
    });
  }
  return candidate;
}

/** Register a freshly authenticated PTY before it is spawned. */
export function registerManagedClaudeTerminal(input: Omit<Registration, 'selector' | 'actor' | 'createdAt' | 'ptyPid' | 'ptyStartTicks' | 'revoked'> & { authenticatedPrincipal: unknown }): { selector: string; socketPath: string } {
  const rawActor = input.authenticatedPrincipal as { id?: unknown; userId?: unknown } | null;
  const rawId = rawActor?.id ?? rawActor?.userId;
  if (Number(rawId) !== input.userId) fail('BROKER_ACTOR_USER_MISMATCH');
  // Snapshot only an authenticated middleware result. The broker reconstructs
  // the strict immutable actor immediately before authorization, after PID
  // binding; this avoids serializing it into the terminal environment.
  const actor = Object.freeze({ ...(rawActor as Record<string, unknown>) });
  const selector = crypto.randomUUID();
  registrations.set(selector, { ...input, selector, actor, createdAt: Date.now(), ptyPid: null, ptyStartTicks: null, revoked: false });
  return { selector, socketPath: ensureServer() };
}
/** Bind the selector to the actual node-pty leader; failure revokes it. */
export function bindManagedClaudeTerminal(selector: string, ptyPid: number): void {
  const record = registrations.get(selector);
  const startTicks = readStartTicks(ptyPid);
  if (!record || !startTicks) return fail('BROKER_PTY_BIND_FAILED');
  record.ptyPid = ptyPid; record.ptyStartTicks = startTicks;
}
type ChildAliveCheck = (bootId: string, identity: PermissionChildIdentity) => boolean;
type TerminateDeps = {
  childAlive?: ChildAliveCheck;
  kill: (pid: number, signal: NodeJS.Signals | number) => void;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  bootId: () => string;
};
const TERMINATE_POLL_MS = 100;
const TERMINATE_WINDOW_MS = 3_000;
let terminateDeps: TerminateDeps = {
  childAlive: undefined,
  kill: (pid, signal) => { process.kill(pid, signal); },
  now: () => Date.now(),
  delay: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
  bootId: readBootId,
};

/** Reuse the reconciliation liveness check (runtime-gateway.processAlive) rather than duplicate it. */
async function resolveChildAlive(): Promise<ChildAliveCheck> {
  if (terminateDeps.childAlive) return terminateDeps.childAlive;
  // eslint-disable-next-line boundaries/dependencies
  const module = await import('@/modules/execution-permissions/runtime-gateway.js');
  return module.processAlive;
}

/** Settle once; a wrapper `settle` that raced revoke already lost at validate(), so this cannot double-settle. */
function settleQuietly(execution: PermissionExecutionHandle, outcome: 'failed' | 'reconciled_unknown'): void {
  try { execution.settle(outcome); } catch { /* durable fence or prior settle is authoritative */ }
}

/**
 * Terminate the recorded WRAPPER — the launcher process that called `start`
 * (managed-claude-launcher.ts), NOT the `claude` grandchild it spawns afterwards
 * — and settle its lease from proven evidence. A wrapper proven dead settles
 * 'failed' and writes no fence; a wrapper still alive after a bounded
 * SIGTERM/SIGKILL window settles 'reconciled_unknown'. Identity is re-verified
 * before every signal, guarding against PID reuse.
 *
 * The grandchild's death is NOT enforced here. It rides the pty SIGHUP that every
 * production revoke path fires at/before revoke: shell-websocket.service kills the
 * pty before calling revoke, and standalone-terminal-registry likewise. A wrapper
 * proven dead while a detached grandchild survived would release the scope with no
 * fence — an accepted limit, tracked as a board issue by the coordinator.
 *
 * Any unexpected throw (e.g. a rejected dynamic import in resolveChildAlive) still
 * settles 'reconciled_unknown' so the lease is never left unsettled. Runs async so
 * callers keep a synchronous contract (fire-and-forget from revoke).
 */
async function terminateWrapperAndSettle(
  execution: PermissionExecutionHandle | null,
  identity: PermissionChildIdentity | null,
): Promise<void> {
  if (!execution) return;
  try { await settleWrapperFromLiveness(execution, identity); }
  catch { settleQuietly(execution, 'reconciled_unknown'); }
}

/** Signal the recorded wrapper and settle from proven liveness; only ever thrown from by the unexpected. */
async function settleWrapperFromLiveness(
  execution: PermissionExecutionHandle,
  identity: PermissionChildIdentity | null,
): Promise<void> {
  if (!identity) { settleQuietly(execution, 'reconciled_unknown'); return; }
  const bootId = terminateDeps.bootId();
  const childAlive = await resolveChildAlive();
  const alive = (): boolean => childAlive(bootId, identity);
  const signal = (sig: NodeJS.Signals): void => {
    if (!alive()) return; // Already dead, or PID reused by a stranger: never signal.
    try { terminateDeps.kill(identity.pid, sig); } catch { /* raced to exit, or unsignalable (EPERM) */ }
  };
  if (!alive()) { settleQuietly(execution, 'failed'); return; }
  signal('SIGTERM');
  const deadline = terminateDeps.now() + TERMINATE_WINDOW_MS;
  while (terminateDeps.now() < deadline) {
    await terminateDeps.delay(TERMINATE_POLL_MS);
    if (!alive()) { settleQuietly(execution, 'failed'); return; }
  }
  signal('SIGKILL');
  await terminateDeps.delay(TERMINATE_POLL_MS);
  settleQuietly(execution, alive() ? 'reconciled_unknown' : 'failed');
}

let lastTerminationForTest: Promise<void> = Promise.resolve();

/**
 * Terminal websocket closed: revoke the selector and settle every started launch.
 * A started launch is no longer blindly settled reconciled_unknown (which fences
 * `<user>:claude:spawn`); its recorded WRAPPER is killed and, once the wrapper is
 * proven dead, settled 'failed'. This proves the WRAPPER dead, not the `claude`
 * grandchild — that death rides the pty SIGHUP each production revoke path fires
 * first (see terminateWrapperAndSettle). The kill/poll runs async and keeps this
 * call synchronous.
 */
export function revokeManagedClaudeTerminal(selector: string | undefined): void {
  if (!selector) return;
  const record = registrations.get(selector);
  if (record) record.revoked = true;
  registrations.delete(selector);
  for (const [key, item] of pending) if (item.registration === record) {
    pending.delete(key);
    if (item.started) { lastTerminationForTest = terminateWrapperAndSettle(item.execution, item.identity); }
    else { try { item.execution?.notStarted(); } catch { /* best effort */ } }
  }
}

/** Test seam: override liveness/kill/clock deps; returns a restore function. */
export function __setTerminateDepsForTest(overrides: Partial<TerminateDeps>): () => void {
  const previous = terminateDeps;
  terminateDeps = { ...terminateDeps, ...overrides };
  return () => { terminateDeps = previous; };
}

/** Test seam: await the async settlement started by the most recent revoke. */
export function __whenTerminationSettledForTest(): Promise<void> {
  return lastTerminationForTest;
}

/** Client used only by the PATH shim; selector is opaque and contains no actor data. */
export async function requestManagedClaudeBroker(env: NodeJS.ProcessEnv, action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const socket = env[MANAGED_CLAUDE_BROKER_SOCKET_ENV]; const selector = env[MANAGED_CLAUDE_BROKER_SELECTOR_ENV];
  if (!socket || !selector) fail('BROKER_CONTRACT_MISSING');
  const payload = JSON.stringify({ action, selector, pid: process.pid, startTicks: readStartTicks(process.pid), ...extra });
  const deadline = Date.now() + 5_000;
  const connect = (): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const client = net.createConnection(socket as string);
    let result = '';
    const timeout = setTimeout(() => client.destroy(Object.assign(new Error('BROKER_TIMEOUT'), { code: 'BROKER_TIMEOUT' })), 5_000);
    client.setEncoding('utf8'); client.on('connect', () => client.end(payload)); client.on('data', chunk => { result += chunk; });
    client.on('error', error => {
      clearTimeout(timeout);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && Date.now() < deadline) {
        setTimeout(() => { void connect().then(resolve, reject); }, 10);
        return;
      }
      reject(error);
    });
    client.on('end', () => { clearTimeout(timeout); try {
      const parsed = JSON.parse(result) as { ok: boolean; result?: Record<string, unknown>; code?: string };
      if (!parsed.ok) fail(parsed.code ?? 'BROKER_REFUSED'); resolve(parsed.result ?? {});
    } catch (error) { reject(error); } });
  });
  return connect();
}
