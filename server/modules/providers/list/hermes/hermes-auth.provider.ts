import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { isCliInstalled, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type HermesCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class HermesProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
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

    const credentials = await this.checkCredentials();
    return {
      installed: true,
      provider: 'hermes',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Hermes' OAuth store (`~/.hermes/auth.json`). A provider is considered
   * authenticated when it has a stored access token or a non-empty pooled
   * credential entry. Token values are never read into the response or logs.
   */
  private async checkCredentials(): Promise<HermesCredentialsStatus> {
    try {
      const authPath = path.join(os.homedir(), '.hermes', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      const providers = readObjectRecord(auth.providers) ?? {};
      for (const [providerId, providerAuth] of Object.entries(providers)) {
        const providerRecord = readObjectRecord(providerAuth);
        if (providerRecord && readOptionalString(providerRecord.access_token)) {
          return {
            authenticated: true,
            email: `${providerId} credentials`,
            method: 'oauth',
          };
        }
      }

      const credentialPool = readObjectRecord(auth.credential_pool) ?? {};
      for (const [providerId, entries] of Object.entries(credentialPool)) {
        if (Array.isArray(entries) && entries.length > 0) {
          return {
            authenticated: true,
            email: `${providerId} credentials`,
            method: 'oauth',
          };
        }
      }
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
