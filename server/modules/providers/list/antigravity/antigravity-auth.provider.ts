import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Auth adapter for the Antigravity (agy) CLI.
 *
 * agy ships as a single binary at `~/.local/bin/agy` and persists conversation
 * state under `~/.gemini/antigravity-cli/brain/<UUID>/`. There is no dedicated
 * credentials file: presence of at least one brain UUID is the signal that the
 * user has completed Google OAuth at least once. We additionally try to extract
 * a display email from common Google credential locations so the UI can show a
 * meaningful identity label.
 */
export class AntigravityProviderAuth implements IProviderAuth {
  private readonly agyCliPath = path.join(os.homedir(), '.local', 'bin', 'agy');
  private readonly brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
  private readonly logDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = existsSync(this.agyCliPath);

    if (!installed) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: 'agy CLI not found at ~/.local/bin/agy',
      };
    }

    const hasSession = this.hasBrainSession();
    const email = this.readGoogleEmail() ?? this.readEmailFromCliLogs();

    return {
      installed: true,
      provider: 'antigravity',
      authenticated: hasSession,
      email,
      method: 'google-oauth',
      error: hasSession ? undefined : 'No sessions found. Run: agy -p "hello"',
    };
  }

  /**
   * Returns true when the brain directory holds at least one session UUID folder.
   *
   * agy creates a brain UUID per chat after a successful OAuth + first run, so
   * a non-empty brain directory is treated as proof of authentication.
   */
  private hasBrainSession(): boolean {
    try {
      const entries = readdirSync(this.brainDir);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Tries common Google credential file locations for a display email.
   *
   * The candidate list is intentionally narrow: we never request live tokens or
   * refresh tokens, only an offline label suitable for UI rendering.
   */
  private readGoogleEmail(): string | null {
    const credPaths = [
      path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'),
      path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    ];

    for (const credPath of credPaths) {
      if (!existsSync(credPath)) {
        continue;
      }

      try {
        const parsed = JSON.parse(readFileSync(credPath, 'utf-8')) as unknown;
        const creds = readObjectRecord(parsed);
        if (!creds) {
          return null;
        }

        return readOptionalString(creds.client_email)
          ?? readOptionalString(creds.email)
          ?? null;
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Falls back to the agy CLI's own logs for the OAuth identity.
   *
   * The Go server inside agy logs `applyAuthResult: email=<addr>, ...` on every
   * successful Google OAuth (server_oauth.go). Logs are small (a few KB each),
   * so scanning the newest few files is cheap. Newest match wins so a re-login
   * with a different account is reflected.
   */
  private readEmailFromCliLogs(): string | null {
    const emailPattern = /applyAuthResult: email=([^,\s]+@[^,\s]+)/g;

    let logFiles: string[];
    try {
      logFiles = readdirSync(this.logDir)
        .filter((name) => name.startsWith('cli-') && name.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, 5);
    } catch {
      return null;
    }

    for (const logFile of logFiles) {
      try {
        const content = readFileSync(path.join(this.logDir, logFile), 'utf-8');
        let lastMatch: string | null = null;
        for (const match of content.matchAll(emailPattern)) {
          lastMatch = match[1];
        }
        if (lastMatch) {
          return lastMatch;
        }
      } catch {
        // Unreadable log file: try the next-newest one.
      }
    }

    return null;
  }
}
