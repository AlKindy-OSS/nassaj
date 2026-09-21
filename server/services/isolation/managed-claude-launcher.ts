/**
 * Managed `claude` PATH launcher for internal terminals (B-456).
 *
 * It prevents accidental engine fallback by resolving every resume target from
 * the server-side session pin immediately before the real CLI is spawned.
 * This is an internal single-operator guard, not a hostile-shell sandbox: an
 * operator deliberately invoking the real binary by absolute path can bypass
 * PATH and is outside this contract.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PermissionExecutionHandle } from '@/modules/execution-permissions/index.js';
// Runtime-only leaf imports keep the managed launcher independent of the broad barrel graph.
// eslint-disable-next-line boundaries/dependencies
import { readRuntimeProcessIdentity, runPermissionExecutionAdapter } from '@/modules/execution-permissions/adapter.js';
// eslint-disable-next-line boundaries/dependencies
import { authorizeRuntimeUserProviderEffect } from '@/modules/execution-permissions/runtime-user-effect.js';
import { assertSessionAccessible } from '@/modules/providers/index.js';

import { requestManagedClaudeBroker } from './managed-claude-launch-broker.js';
import { resolveClaudeRunProfileOrThrow } from './resolve-claude-run-profile.js';
import {
  MANAGED_CLAUDE_MODE_ENV,
  MANAGED_CLAUDE_REAL_BIN_ENV,
  MANAGED_CLAUDE_SESSION_ENV,
  MANAGED_CLAUDE_USER_ENV,
  MANAGED_CLAUDE_WRAPPER,
  MANAGED_CLAUDE_BROKER_SOCKET_ENV,
  MANAGED_CLAUDE_BROKER_SELECTOR_ENV,
  stripManagedClaudeTerminalEnv,
  type ManagedClaudeTerminalMode,
} from './managed-claude-terminal-env.js';

export type ParsedResume =
  | { ok: true; sessionId: string | null }
  | { ok: false; error: string };

const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Parse Claude resume argv without evaluating or joining it through a shell. */
export function parseClaudeResumeArgv(argv: readonly string[]): ParsedResume {
  let sessionId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    // Claude treats everything after `--` as positional prompt data. Resume-like
    // text there must never affect the managed-session contract.
    if (arg === '--') break;
    if (arg === '--continue' || arg === '-c') {
      return { ok: false, error: '--continue cannot be resolved to a server-pinned session' };
    }
    let candidate: string | null = null;
    if (arg === '--resume' || arg === '-r') {
      candidate = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--resume=')) {
      candidate = arg.slice('--resume='.length);
    } else if (arg.startsWith('-r=')) {
      candidate = arg.slice(3);
    } else if (arg.startsWith('-r') && arg.length > 2) {
      // Claude/Commander accepts the compact short-option form: `-rSESSION`.
      candidate = arg.slice(2);
    }
    if (candidate === null) continue;
    if (!SESSION_ID_RE.test(candidate) || sessionId !== null) {
      return { ok: false, error: 'Claude resume requires exactly one valid session id' };
    }
    sessionId = candidate;
  }
  return { ok: true, sessionId };
}

type LauncherDeps = {
  spawnImpl?: typeof spawn;
  resolveProfile?: typeof resolveClaudeRunProfileOrThrow;
  authorizeSession?: typeof assertSessionAccessible;
  permissionExecution?: PermissionExecutionHandle | null;
  authenticatedPrincipal?: unknown;
};

/** Run the real Claude CLI with a server-resolved, session-pinned environment. */
export async function runManagedClaudeLauncher(
  argv: readonly string[],
  sourceEnv: NodeJS.ProcessEnv,
  deps: LauncherDeps = {},
): Promise<number> {
  const mode = sourceEnv[MANAGED_CLAUDE_MODE_ENV] as ManagedClaudeTerminalMode | undefined;
  const userId = Number(sourceEnv[MANAGED_CLAUDE_USER_ENV]);
  const boundSessionId = sourceEnv[MANAGED_CLAUDE_SESSION_ENV] ?? null;
  const realBinary = sourceEnv[MANAGED_CLAUDE_REAL_BIN_ENV] ?? '';
  if ((mode !== 'general' && mode !== 'session-bound') || !Number.isInteger(userId) || userId <= 0) {
    throw new Error('Invalid managed Claude terminal contract');
  }
  if (!path.isAbsolute(realBinary) || path.resolve(realBinary) === path.resolve(MANAGED_CLAUDE_WRAPPER)) {
    throw new Error('Invalid real Claude executable in managed terminal contract');
  }
  if (mode === 'session-bound' && (!boundSessionId || !SESSION_ID_RE.test(boundSessionId))) {
    throw new Error('Invalid session-bound Claude terminal contract');
  }

  const parsed = parseClaudeResumeArgv(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  if (mode === 'session-bound' && parsed.sessionId && parsed.sessionId !== boundSessionId) {
    const error = new Error('A session-bound terminal cannot resume a different Claude session');
    (error as Error & { code?: string }).code = 'CLAUDE_TERMINAL_CROSS_SESSION';
    throw error;
  }

  if (mode === 'session-bound') {
    const optionArgv = argv.slice(0, argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--'));
    const escapesBoundSession = optionArgv.some((arg) =>
      arg === '--fork-session'
      || arg.startsWith('--fork-session=')
      || arg === '--session-id'
      || arg.startsWith('--session-id='));
    if (escapesBoundSession) {
      const error = new Error('A session-bound terminal cannot fork or select another Claude session');
      (error as Error & { code?: string }).code = 'CLAUDE_TERMINAL_SESSION_ESCAPE';
      throw error;
    }
  }

  const targetSessionId = mode === 'session-bound' ? boundSessionId : parsed.sessionId;
  const childArgv = mode === 'session-bound' && parsed.sessionId === null
    ? ['--resume', boundSessionId!, ...argv]
    : [...argv];
  const baseEnv = stripManagedClaudeTerminalEnv(sourceEnv);
  const brokered = Boolean(sourceEnv[MANAGED_CLAUDE_BROKER_SOCKET_ENV] && sourceEnv[MANAGED_CLAUDE_BROKER_SELECTOR_ENV]);
  if (brokered && deps.permissionExecution === undefined && !deps.authenticatedPrincipal && !deps.authorizeSession && !deps.resolveProfile) {
    const authorization = await requestManagedClaudeBroker(sourceEnv, 'authorize', { argv: childArgv });
    const launch = authorization.launch;
    const profileEnv = authorization.env;
    if (typeof launch !== 'string' || !profileEnv || typeof profileEnv !== 'object') {
      throw new Error('BROKER_RESPONSE_INVALID');
    }
    await requestManagedClaudeBroker(sourceEnv, 'start', { launch });
    const spawnImpl = deps.spawnImpl ?? spawn;
    return new Promise<number>((resolve, reject) => {
      let child: ChildProcess;
      try { child = spawnImpl(realBinary, childArgv, { env: profileEnv as NodeJS.ProcessEnv, stdio: 'inherit', shell: false }); }
      catch (error) { void requestManagedClaudeBroker(sourceEnv, 'settle', { launch, exitCode: 1 }); reject(error); return; }
      child.once('error', error => { void requestManagedClaudeBroker(sourceEnv, 'settle', { launch, exitCode: 1 }); reject(error); });
      child.once('exit', (code, signal) => { void requestManagedClaudeBroker(sourceEnv, 'settle', { launch, exitCode: code ?? (signal ? 1 : 1) }); resolve(code ?? (signal ? 128 : 1)); });
    });
  }
  const authorizeSession = deps.authorizeSession ?? assertSessionAccessible;
  const authorizedSession = targetSessionId
    ? authorizeSession(targetSessionId, userId, 'write')
    : null;
  if (deps.permissionExecution === undefined && !deps.authenticatedPrincipal) {
    throw new Error('RUNTIME_EFFECT_AUTHENTICATED_PRINCIPAL_REQUIRED');
  }
  if (targetSessionId) {
    // Same 404-shaped authorization primitive as every session mutation. This
    // happens before pin lookup and before child construction, so a foreign id
    // is neither disclosed nor sent to Claude.
    // `authorizedSession` above is retained to bind the permit to the server's project.
  }
  const profile = await (deps.resolveProfile ?? resolveClaudeRunProfileOrThrow)({
    userId,
    authenticatedPrincipal: deps.authenticatedPrincipal,
    sessionId: targetSessionId,
    baseEnv,
    envAlreadyIsolated: true,
    authoritativeStoredPin: targetSessionId !== null,
    requireKnownResumePin: targetSessionId !== null,
    failOnAmbiguous: true,
  });

  const spawnImpl = deps.spawnImpl ?? spawn;
  const permissionExecution = deps.permissionExecution !== undefined
    ? deps.permissionExecution
    : deps.authorizeSession
      ? null
      : authorizeRuntimeUserProviderEffect({
        authenticatedPrincipal: deps.authenticatedPrincipal,
        provider: 'claude',
        engine: profile.effectiveEngine ?? 'anthropic',
        entrypoint: 'terminal.managed-claude',
        purpose: 'spawn',
        effectFootprint: 'local',
        sessionId: targetSessionId,
        projectId: targetSessionId ? `session:${targetSessionId}` : `terminal:${mode}`,
        workspacePath: authorizedSession?.project_path || process.cwd(),
      });
  // T-1593: the executor runs synchronously inside the adapter call, so the child exists
  // before markStarted records its exact identity as the proof a local effect can end.
  let spawnedChild: ChildProcess | null = null;
  return runPermissionExecutionAdapter(permissionExecution, () => new Promise<number>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(realBinary, childArgv, {
        env: profile.env,
        stdio: 'inherit',
        shell: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    spawnedChild = child;

    const forward = (signal: NodeJS.Signals) => {
      try { child.kill(signal); } catch { /* child already exited */ }
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const cleanup = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 : 1));
    });
  }), () => (spawnedChild?.pid ? readRuntimeProcessIdentity(spawnedChild.pid) : null));
}

/** Fence refusals get a plain explanation; the bare code told the owner nothing (T-1770). */
const FENCE_CODES = new Set(['GENERATION_BLOCKED', 'EFFECT_SCOPE_FENCED']);
const FENCE_HINT = 'Launches are paused: an earlier run ended with an unknown effect. The owner can review '
  + 'and lift the fence in Settings > Command board > Permission fences.\n'
  + 'التشغيل موقوف احتياطاً بعد عملية مجهولة النتيجة. يراجعه المالك ويرفعه من '
  + 'الإعدادات > لوحة الأوامر > حجوب الصلاحيات.\n';

async function main(): Promise<void> {
  try {
    process.exitCode = await runManagedClaudeLauncher(process.argv.slice(2), process.env);
  } catch (error) {
    const code = (error as Error & { code?: string })?.code ?? 'CLAUDE_TERMINAL_REFUSED';
    process.stderr.write(`[nassaj:${code}] ${(error as Error)?.message ?? String(error)}\n`);
    if (FENCE_CODES.has(code)) process.stderr.write(FENCE_HINT);
    process.exitCode = 64;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main();
}
