/**
 * codex-credentials.writer — T-866/B4, ADR-200 S3: configures a user's OpenAI
 * API key for Codex in `<CODEX_HOME>/auth.json`, never touching ChatGPT OAuth.
 *
 * ADR-200 S3 measurement (codex-cli 0.160.0, throwaway CODEX_HOME under
 * /var/tmp, dummy values only, no network credential): `codex login
 * --with-api-key` REPLACES the whole file. Before:
 *   { "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
 *     "tokens": { id_token, access_token, refresh_token, account_id },
 *     "last_refresh": "…" }
 * after: { "auth_mode": "apikey", "OPENAI_API_KEY": "<redacted>" } — `tokens`
 * and `last_refresh` are WIPED. The CLI writes 2-space JSON with no trailing
 * newline. Hence, per ADR-200 C2:
 *   - auth.json holds `tokens` → an atomic MERGE of OPENAI_API_KEY (and of
 *     auth_mode, which decides precedence — see resolveCodexEffectiveAuth);
 *     `tokens` is preserved byte for byte;
 *   - no `tokens` → the CLI login as before (nothing to wipe): the key goes
 *     over STDIN only, never argv, through the permission/identity admission.
 * Either way the file is re-read and verified after the write (L4), under a
 * per-file lock (in-process queue + cross-process lock file). A merge that
 * fails verification puts the previous bytes back.
 *
 * deleteApiKey removes the key and, where OAuth tokens and a recorded mode
 * exist, hands auth_mode back to "chatgpt" with a null key — the exact shape
 * the CLI writes — so OAuth → set key → delete key leaves the file identical.
 * No key material and no CLI output is ever logged or put in an error.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  acquireCodexLaunchIdentity,
  assertCodexIdentityUnchanged,
  codexIdentityFromExecution,
  codexLaunchOptions,
  CODEX_MACHINE_CLI_MISSING_MESSAGE,
  isCodexMachineCliMissing,
} from '@/shared/codex-executable.js';
import {
  readJsonObjectOrEmpty,
  writeJsonObjectAtomic,
} from '@/modules/providers/shared/credentials/atomic-json-file.js';
import { assertNotClaudeSubscriptionToken } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
// Runtime-only leaf imports avoid eagerly evaluating unrelated gateway exports.
// eslint-disable-next-line boundaries/dependencies
import { runPermissionExecutionAdapter } from '@/modules/execution-permissions/adapter.js';
// eslint-disable-next-line boundaries/dependencies
import { createAuthenticatedLaunchActor, isAuthenticatedLaunchActorCurrent } from '@/modules/execution-permissions/actor.js';
// eslint-disable-next-line boundaries/dependencies
import { authorizeRuntimeUserProviderEffect } from '@/modules/execution-permissions/runtime-user-effect.js';
import { assertHarnessNotUpdating } from '@/modules/providers/harness-update/spawn-admission.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type {
  IProviderCredentialWriter,
  ProviderCredentialStatus,
  ProviderCredentialWriterCapability,
} from '@/shared/interfaces.js';
import { AppError, readOptionalString } from '@/shared/utils.js';

import { resolveCodexEffectiveAuth } from './codex-auth.provider.js';
import {
  CODEX_API_KEY_FIELD,
  withCodexApiKey,
  withoutCodexApiKey,
} from './codex-auth-shape.js';
import { operatorCodexHome } from './codex-home.js';

/** Hard cap on how long the login CLI may run before it is killed. */
const LOGIN_TIMEOUT_MS = 20_000;

/** A waiter outlasts one full CLI login held under the lock. */
const LOCK_WAIT_MS = LOGIN_TIMEOUT_MS + 5_000;
/** A lock file older than this, or whose owner pid is gone, is abandoned. */
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 25;

type SpawnFn = typeof nodeSpawn;
type CodexLaunchIdentity = ReturnType<typeof acquireCodexLaunchIdentity>;
type AuthObject = Record<string, unknown>;

/** auth.json as found before a write: exact bytes, parsed object, newline style. */
export type CodexAuthSnapshot = { raw: string | null; auth: AuthObject; trailingNewline: boolean };

const hasOwn = (value: AuthObject, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, field);

const authUnreadable = (): AppError =>
  new AppError('The Codex credentials file is unreadable; it was left unchanged.', {
    code: 'CODEX_AUTH_UNREADABLE', statusCode: 409,
  });

const verifyFailed = (): AppError =>
  new AppError('The Codex credential change could not be verified.', {
    code: 'CODEX_AUTH_VERIFY_FAILED', statusCode: 500,
  });

/**
 * Reads auth.json for a write. Unlike the status readers this is fail-CLOSED:
 * a file that exists but is not a JSON object is never overwritten.
 */
function readCodexAuthSnapshot(authPath: string): CodexAuthSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, auth: {}, trailingNewline: false };
    }
    throw authUnreadable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw authUnreadable();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw authUnreadable();
  return { raw, auth: parsed as AuthObject, trailingNewline: raw.endsWith('\n') };
}

/**
 * L4: re-read after the write and prove the intended state — the key is (or
 * is no longer) the effective credential, and `tokens` serializes identically.
 */
function verifyCodexAuth(authPath: string, before: AuthObject, apiKey: string | null): void {
  let after: AuthObject;
  try {
    after = readCodexAuthSnapshot(authPath).auth;
  } catch {
    throw verifyFailed();
  }
  const effective = resolveCodexEffectiveAuth(after);
  const keyOk = apiKey === null
    ? effective !== 'api_key' && readOptionalString(after[CODEX_API_KEY_FIELD]) === undefined
    : effective === 'api_key' && after[CODEX_API_KEY_FIELD] === apiKey;
  const tokensOk = !hasOwn(before, 'tokens')
    || JSON.stringify(before.tokens) === JSON.stringify(after.tokens);
  if (!keyOk || !tokensOk) throw verifyFailed();
}

/** Puts the exact previous bytes back atomically (tmp + rename, 0600). */
function restoreRaw(authPath: string, raw: string): void {
  const tmpPath = `${authPath}.restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, raw, { mode: 0o600 });
  fs.renameSync(tmpPath, authPath);
}

const changedConcurrently = (): AppError =>
  new AppError('The Codex credentials file changed during the update; it was left as found.', {
    code: 'CODEX_AUTH_CHANGED_CONCURRENTLY', statusCode: 409,
  });

/** The current bytes of auth.json, or null when it cannot be read. */
function readRawOrNull(authPath: string): string | null {
  try {
    return fs.readFileSync(authPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Atomic merge-write, verified. A failed verification is a COMPARE-AND-RESTORE
 * (ADR-200 S4, G1 M-3): the previous bytes go back only when the file still
 * holds exactly what this write produced. If anything else changed it since
 * (the CLI refreshing its ChatGPT tokens, say), restoring would wipe that
 * change, so the file is left as found and the write is refused.
 *
 * `hooks.afterWrite` is a test seam that runs between the write and the verify.
 */
export function writeCodexAuthVerified(
  authPath: string,
  before: CodexAuthSnapshot,
  next: AuthObject,
  apiKey: string | null,
  hooks: { afterWrite?: () => void } = {},
): void {
  const written = `${JSON.stringify(next, null, 2)}${before.trailingNewline ? '\n' : ''}`;
  writeJsonObjectAtomic(authPath, next, { trailingNewline: before.trailingNewline });
  hooks.afterWrite?.();
  try {
    verifyCodexAuth(authPath, before.auth, apiKey);
  } catch (error) {
    if (readRawOrNull(authPath) !== written) throw changedConcurrently();
    if (before.raw !== null) restoreRaw(authPath, before.raw);
    throw error;
  }
}

/** True when the lock file's owner pid is gone or the lock is older than LOCK_STALE_MS. */
function isStaleLock(lockPath: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown; at?: unknown };
    if (typeof owner.at === 'number' && Date.now() - owner.at > LOCK_STALE_MS) return true;
    if (typeof owner.pid !== 'number') return false;
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

/** Cross-process exclusive lock file next to auth.json; returns its owner token. */
async function acquireLockFile(lockPath: string): Promise<string> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), {
        flag: 'wx', mode: 0o600,
      });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (isStaleLock(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new AppError('Codex credentials are being changed; try again.', {
        code: 'CODEX_AUTH_LOCKED', statusCode: 409,
      });
    }
    await new Promise((resolve) => { setTimeout(resolve, LOCK_POLL_MS); });
  }
}

/** Removes the lock file only while it still carries our token. */
function releaseLockFile(lockPath: string, token: string): void {
  try {
    if ((JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown }).token === token) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Already gone, or reclaimed as stale by another owner: nothing of ours to release.
  }
}

/** Generic login failure; the structured log carries the reason only — never key or CLI output. */
function loginFailed(userId: string | number | null | undefined, reason: string): AppError {
  console.error('[codex-credentials] codex login --with-api-key failed', { userId: userId ?? null, code: reason });
  return new AppError('Codex API-key login failed. Check the key and try again.', {
    code: 'CODEX_LOGIN_FAILED', statusCode: 502, details: { reason },
  });
}

const inProcessLocks = new Map<string, Promise<void>>();

/**
 * ADR-200 L4 per-file lock: one in-process queue per auth.json plus a lock
 * file, so a set and a delete (or two processes) never interleave
 * read → write → verify.
 */
export async function withCodexAuthLock<T>(authPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(authPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
  inProcessLocks.set(authPath, tail);
  await previous;
  try {
    fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
    const lockPath = `${authPath}.nassaj-lock`;
    const token = await acquireLockFile(lockPath);
    try {
      return await operation();
    } finally {
      releaseLockFile(lockPath, token);
    }
  } finally {
    release();
    if (inProcessLocks.get(authPath) === tail) inProcessLocks.delete(authPath);
  }
}

export class CodexCredentialsWriter implements IProviderCredentialWriter {
  private readonly spawnFn: SpawnFn;

  /** @param spawnFn child-process seam. */
  constructor(spawnFn: SpawnFn = nodeSpawn) {
    this.spawnFn = spawnFn;
  }

  getWriterCapability(): ProviderCredentialWriterCapability {
    return { method: 'cli_stdin' };
  }

  /** Codex has exactly one credential target; any explicit target is a 400. */
  private rejectTarget(target?: string): void {
    if (target !== undefined && target !== '') {
      throw new AppError(`Provider "codex" does not support credential targets.`, {
        code: 'INVALID_CREDENTIAL_TARGET',
        statusCode: 400,
      });
    }
  }

  /**
   * The caller's OWN resolved CODEX_HOME (isolated tree, or operator ~/.codex).
   *
   * B-1251 (sibling of the Claude writer): `honorGrants: false` because every
   * use of this path is a credential WRITE, DELETE or its status. With grants
   * honored — the resolver's default, correct for a spawn — a member holding a
   * grant from another member would log their own OpenAI key into the GRANTOR's
   * `~/.nassaj-users/<grantor>/.codex/auth.json`, and "remove my key" would
   * delete the grantor's. A credential act always lands on one's own tree.
   */
  private resolveCodexHome(userId: string | number | null | undefined): string {
    const env = this.ownProviderEnv(userId);
    return readOptionalString(env.CODEX_HOME) ?? operatorCodexHome();
  }

  /** The caller's own codex environment — never a grantor's (see resolveCodexHome). */
  private ownProviderEnv(userId: string | number | null | undefined): NodeJS.ProcessEnv {
    return resolveProviderEnv(userId ?? null, 'codex', process.env, 'chat', { honorGrants: false });
  }

  async setApiKey(
    userId: string | number | null | undefined,
    apiKey: string,
    target?: string,
    authenticatedPrincipal?: unknown,
  ): Promise<ProviderCredentialStatus> {
    this.rejectTarget(target);
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new AppError('API key is required and must not be empty.', {
        code: 'INVALID_API_KEY',
        statusCode: 400,
      });
    }
    // B-1252: refuse a Claude subscription token before anything is written —
    // `codex login --with-api-key` would persist it into auth.json verbatim.
    assertNotClaudeSubscriptionToken(apiKey, 'codex');
    const key = apiKey.trim();

    // Bind the credential destination to the current authenticated actor before
    // resolving an environment (which may provision directories).
    const actor = createAuthenticatedLaunchActor(authenticatedPrincipal as never);
    if (String(userId) !== String(actor.userId) || !isAuthenticatedLaunchActorCurrent(actor)) {
      throw new AppError('Credential authentication is no longer valid.', {
        code: 'CREDENTIAL_ACTOR_INVALID', statusCode: 403,
      });
    }
    const env = this.ownProviderEnv(userId);
    const authPath = path.join(readOptionalString(env.CODEX_HOME) ?? operatorCodexHome(), 'auth.json');
    await withCodexAuthLock(authPath, async () => {
      const before = readCodexAuthSnapshot(authPath);
      if (hasOwn(before.auth, 'tokens')) {
        // ADR-200 C2: the CLI would wipe `tokens` (measured) — merge instead.
        writeCodexAuthVerified(authPath, before, withCodexApiKey(before.auth, key), key);
        return;
      }
      await this.loginViaCli(userId, env, key, authenticatedPrincipal);
      verifyCodexAuth(authPath, before.auth, key);
    });
    return { provider: 'codex', configured: true };
  }

  /** Admits the `codex login` spawn (T-1872 identity) and runs it under the permit. */
  private async loginViaCli(
    userId: string | number | null | undefined,
    env: NodeJS.ProcessEnv,
    apiKey: string,
    authenticatedPrincipal: unknown,
  ): Promise<void> {
    // Injecting a child-process implementation must never bypass admission.
    const permissionExecution = authorizeRuntimeUserProviderEffect({
      authenticatedPrincipal,
      provider: 'codex',
      engine: 'codex_cli_login',
      entrypoint: 'provider.credentials.codex-login',
      purpose: 'spawn',
      effectFootprint: 'external',
      projectId: 'system:provider-credentials',
      workspacePath: process.cwd(),
    });
    // T-1872: the login runs exactly the machine release the admission measured;
    // an admission without one refuses with its recorded cause (never re-acquires).
    let launchIdentity: CodexLaunchIdentity;
    try {
      launchIdentity = codexIdentityFromExecution(permissionExecution) as CodexLaunchIdentity;
    } catch (error) {
      permissionExecution.notStarted();
      throw new AppError(isCodexMachineCliMissing(error)
        ? CODEX_MACHINE_CLI_MISSING_MESSAGE
        : 'The Codex installation on this machine is not usable.', {
        code: 'CODEX_NOT_INSTALLED', statusCode: 503,
      });
    }
    await runPermissionExecutionAdapter(permissionExecution, () =>
      this.spawnLogin(userId, env, apiKey, launchIdentity));
  }

  /** Spawns `codex login --with-api-key`, key on STDIN only; failures are generic. */
  private spawnLogin(
    userId: string | number | null | undefined,
    env: NodeJS.ProcessEnv,
    apiKey: string,
    launchIdentity: CodexLaunchIdentity,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (reason?: string): void => {
        if (settled) return;
        settled = true;
        if (reason === undefined) {
          resolve();
          return;
        }
        reject(loginFailed(userId, reason));
      };
      // T-1749/ADR-159: `codex login` is a codex harness spawn too — refuse it
      // (retryably) while the codex binary is being replaced by an update.
      try {
        assertHarnessNotUpdating('codex');
      } catch (error) {
        reject(error);
        return;
      }
      let child: ReturnType<SpawnFn>;
      try {
        // No shell, key via stdin ONLY — argv stays constant and secret-free.
        assertCodexIdentityUnchanged(launchIdentity);
        const launch = codexLaunchOptions(env, launchIdentity);
        child = this.spawnFn(launch.codexPathOverride, ['login', '--with-api-key'], {
          env: launch.env, shell: false, stdio: ['pipe', 'ignore', 'ignore'],
          timeout: LOGIN_TIMEOUT_MS, killSignal: 'SIGTERM',
        });
      } catch {
        settle('spawn_failed');
        return;
      }
      child.on('error', () => settle('spawn_failed'));
      child.on('close', (code, signal) => settle(code === 0 ? undefined
        : signal ? 'timeout_or_killed' : `exit_${code ?? 'unknown'}`));
      try {
        child.stdin?.write(`${apiKey}\n`);
        child.stdin?.end();
      } catch {
        settle('stdin_write_failed');
      }
    });
  }

  /**
   * Removes the key under the per-file lock; OAuth `tokens` stay byte-identical
   * and, where present, become the effective credential again (withoutCodexApiKey).
   */
  async deleteApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    this.rejectTarget(target);
    const authPath = path.join(this.resolveCodexHome(userId), 'auth.json');
    await withCodexAuthLock(authPath, async () => {
      const before = readCodexAuthSnapshot(authPath);
      const next = withoutCodexApiKey(before.auth);
      if (before.raw === null || JSON.stringify(next) === JSON.stringify(before.auth)) return;
      writeCodexAuthVerified(authPath, before, next, null);
    });
    return { provider: 'codex', configured: false };
  }

  /**
   * ADR-200 S6: the stored `OPENAI_API_KEY`, or null, for the fan-out ownership
   * check and re-read verify. Fail-closed like a write: an unreadable auth.json
   * throws `CODEX_AUTH_UNREADABLE` rather than reading as "no key". `tokens`
   * are never read.
   */
  async readApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<string | null> {
    this.rejectTarget(target);
    const { auth } = readCodexAuthSnapshot(path.join(this.resolveCodexHome(userId), 'auth.json'));
    return readOptionalString(auth[CODEX_API_KEY_FIELD]) ?? null;
  }

  async isConfigured(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<boolean> {
    this.rejectTarget(target);
    const authPath = path.join(this.resolveCodexHome(userId), 'auth.json');
    const auth = readJsonObjectOrEmpty(authPath);
    return readOptionalString(auth[CODEX_API_KEY_FIELD]) !== undefined;
  }
}
