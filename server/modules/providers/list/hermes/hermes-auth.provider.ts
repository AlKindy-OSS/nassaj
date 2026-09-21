import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { isCliInstalled, readObjectRecord } from '@/shared/utils.js';

import { readHermesRuntimeConfig, selectHermesCredential } from './hermes-runtime.js';

type HermesCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class HermesProviderAuth implements IProviderAuth {
  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    const installed = isCliInstalled('hermes');
    if (!installed) {
      return {
        installed: false,
        provider: 'hermes',
        authenticated: false,
        email: null,
        method: null,
        error: 'Hermes is not installed',
      };
    }

    const credentials = await this.checkCredentials(this.resolveHermesHome(userId));
    return {
      installed: true,
      provider: 'hermes',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /** Resolves the same HOME that a Hermes process for this user receives. */
  private resolveHermesHome(userId?: string | number | null): string {
    const env = resolveProviderEnv(userId ?? null, 'hermes', process.env);
    return env.HOME || os.homedir();
  }

  /**
   * Reads Hermes' OAuth store (`~/.hermes/auth.json`) FOR THE PROVIDER THAT WILL
   * ACTUALLY RUN (B-404) — `model.provider` in `~/.hermes/config.yaml`, the only
   * endpoint a headless `hermes -z` ever talks to.
   *
   * The previous version accepted ANY credential anywhere in the file. On
   * 2026-08-03 that painted the badge green off a pooled `copilot` entry while
   * the configured provider, `nous`, carried `last_auth_error.invalid_grant` +
   * `relogin_required` and refused every turn with "No access token found for
   * Nous Portal login". A badge that is true about a credential nobody uses is
   * worse than no badge: it sends the owner looking for the fault in nassaj.
   *
   * Token values are never read into the response or logs; a stored
   * `last_auth_error` message IS surfaced, because that string is the whole
   * reason the run fails and hermes already prints it to the user's terminal.
   */
  private async checkCredentials(home: string): Promise<HermesCredentialsStatus> {
    const { provider: runtimeProvider } = await readHermesRuntimeConfig(home);

    try {
      const authPath = path.join(home, '.hermes', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      return selectHermesCredential(auth, runtimeProvider);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof Error ? error.message : 'Failed to read Hermes auth',
        };
      }
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'Hermes not configured',
    };
  }
}
