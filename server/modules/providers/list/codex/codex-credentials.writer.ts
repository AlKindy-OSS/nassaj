/**
 * codex-credentials.writer — T-866/B4: configures a user's OpenAI API key for
 * Codex by driving the Codex CLI's own login flow: `codex login --with-api-key`
 * reads the key from STDIN. The key is NEVER placed in argv (visible in
 * /proc/<pid>/cmdline to every local process) and never logged; the child env
 * comes from the central isolation seam (resolveProviderEnv → CODEX_HOME), so
 * the CLI persists the key into the user's isolated ~/.nassaj-users/<id>/.codex.
 *
 * spawn is dependency-injected (defaults to node:child_process.spawn, no shell)
 * so tests can capture the exact argv/stdin without a real CLI. A CLI failure
 * or timeout rejects with a clean, generic AppError — no key material, no raw
 * CLI output, in either the error or the log line.
 *
 * deleteApiKey removes ONLY the `OPENAI_API_KEY` field from the native
 * `<CODEX_HOME>/auth.json` (atomic merge-write), preserving any OAuth tokens —
 * the CLI has no "logout api-key only" verb, and `codex logout` would nuke the
 * whole auth file.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

import { resolveCliExecutablePath } from '@/shared/cli-executable-path.js';
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

import { operatorCodexHome } from './codex-home.js';

/** auth.json field the Codex CLI stores an API-key login under. */
const CODEX_API_KEY_FIELD = 'OPENAI_API_KEY';

/** Hard cap on how long the login CLI may run before it is killed. */
const LOGIN_TIMEOUT_MS = 20_000;

type SpawnFn = typeof nodeSpawn;

export class CodexCredentialsWriter implements IProviderCredentialWriter {
  private readonly spawnFn: SpawnFn;

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
    // B-1252: refuse a Claude subscription token before the CLI is spawned —
    // `codex login --with-api-key` would persist it into auth.json verbatim.
    assertNotClaudeSubscriptionToken(apiKey, 'codex');

    // Bind the credential destination to the current authenticated actor before
    // resolving an environment (which may provision directories).
    const actor = createAuthenticatedLaunchActor(authenticatedPrincipal as never);
    if (String(userId) !== String(actor.userId) || !isAuthenticatedLaunchActorCurrent(actor)) {
      throw new AppError('Credential authentication is no longer valid.', {
        code: 'CREDENTIAL_ACTOR_INVALID', statusCode: 403,
      });
    }
    const env = this.ownProviderEnv(userId);
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
    await runPermissionExecutionAdapter(permissionExecution, () => new Promise<void>((resolve, reject) => {
      // Generic user-facing failure — carries no key material and no CLI output.
      const loginFailed = (reason: string): AppError =>
        new AppError('Codex API-key login failed. Check the key and try again.', {
          code: 'CODEX_LOGIN_FAILED',
          statusCode: 502,
          details: { reason },
        });

      let settled = false;
      const settle = (error?: AppError): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          // Structured log: reason only — never the key, never CLI output.
          console.error('[codex-credentials] codex login --with-api-key failed', {
            userId: userId ?? null,
            code: error.details && (error.details as { reason?: string }).reason,
          });
          reject(error);
          return;
        }
        resolve();
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
        child = this.spawnFn(resolveCliExecutablePath('codex'), ['login', '--with-api-key'], {
          env,
          shell: false,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: LOGIN_TIMEOUT_MS,
          killSignal: 'SIGTERM',
        });
      } catch {
        settle(loginFailed('spawn_failed'));
        return;
      }

      child.on('error', () => settle(loginFailed('spawn_failed')));
      child.on('close', (code, signal) => {
        if (code === 0) {
          settle();
          return;
        }
        settle(loginFailed(signal ? 'timeout_or_killed' : `exit_${code ?? 'unknown'}`));
      });

      try {
        child.stdin?.write(`${apiKey.trim()}\n`);
        child.stdin?.end();
      } catch {
        settle(loginFailed('stdin_write_failed'));
      }
    }));

    return { provider: 'codex', configured: true };
  }

  async deleteApiKey(
    userId: string | number | null | undefined,
    target?: string,
  ): Promise<ProviderCredentialStatus> {
    this.rejectTarget(target);
    const authPath = path.join(this.resolveCodexHome(userId), 'auth.json');
    const auth = readJsonObjectOrEmpty(authPath);
    if (Object.prototype.hasOwnProperty.call(auth, CODEX_API_KEY_FIELD)) {
      delete auth[CODEX_API_KEY_FIELD];
      // Merge-write: OAuth tokens and any other fields are preserved.
      writeJsonObjectAtomic(authPath, auth);
    }
    return { provider: 'codex', configured: false };
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
