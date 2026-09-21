import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAgyExecutablePath } from '@/shared/cli-executable-path.js';
import { isRunnableClaudeExecutable } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { isProviderIsolated } from '../../../../services/provider-sharing.js';
import { credentialPrincipalId } from '../../../../services/isolation/credential-principal.js';
import { userConfigDir } from '../../../../services/isolation/provision-user-dirs.js';

/**
 * Auth adapter for the Antigravity (agy) CLI.
 *
 * agy ships as a single binary at `~/.local/bin/agy` and persists conversation
 * state under `<HOME>/.gemini/antigravity-cli/brain/<UUID>/`. There is no
 * dedicated credentials file: presence of at least one brain UUID is the signal
 * that the user has completed Google OAuth at least once. We additionally try to
 * extract a display email from common Google credential locations so the UI can
 * show a meaningful identity label.
 *
 * B-357 — THE STATE ROOT IS PER CALL, NOT PER PROCESS. These paths used to be
 * instance fields resolved once from `os.homedir()`, so every member saw the
 * OPERATOR's brain, logs and Google e-mail no matter who asked. Under the
 * default `agy: 'shared'` policy that is correct and intended — a shared
 * provider deliberately inherits the operator's tree. Under `isolated` it is a
 * cross-user leak: `resolveProviderEnv` points a spawned agy at
 * `~/.nassaj-users/<id>/`, so the status panel was describing a different tree
 * than the one the user actually runs on.
 *
 * The root is therefore resolved per call from (userId × sharing policy) — the
 * same pair `resolveProviderEnv` uses at spawn, so read and write can no longer
 * disagree. A field cannot express this: policy is admin-mutable at runtime and
 * userId differs per request.
 */
export class AntigravityProviderAuth implements IProviderAuth {
  /**
   * The HOME agy state is read from for this caller. Isolated + a known user →
   * that user's provisioned root; otherwise the operator's home, which is what
   * `shared` means.
   */
  private stateHome(userId?: string | number | null): string {
    if (userId !== undefined && userId !== null && isProviderIsolated('agy')) {
      // T-1675: a grantee's state home is the OWNER's tree, as on the spawn path.
      return userConfigDir(credentialPrincipalId(userId, 'agy'));
    }
    return os.homedir();
  }

  private brainDir(userId?: string | number | null): string {
    return path.join(this.stateHome(userId), '.gemini', 'antigravity-cli', 'brain');
  }

  private logDir(userId?: string | number | null): string {
    return path.join(this.stateHome(userId), '.gemini', 'antigravity-cli', 'log');
  }

  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    // The agy binary is a host install, never per-user; resolved exactly as the
    // spawn resolves it (AGY_PATH → PATH → well-known dirs, B-1138).
    const installed = isRunnableClaudeExecutable(resolveAgyExecutablePath());

    if (!installed) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: 'agy CLI not found (AGY_PATH, PATH, ~/.local/bin)',
      };
    }

    const hasSession = this.hasBrainSession(userId);
    const email = this.readGoogleEmail(userId) ?? this.readEmailFromCliLogs(userId);

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
  private hasBrainSession(userId?: string | number | null): boolean {
    try {
      const entries = readdirSync(this.brainDir(userId));
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
  private readGoogleEmail(userId?: string | number | null): string | null {
    const home = this.stateHome(userId);
    const credPaths = [
      path.join(home, '.config', 'gcloud', 'application_default_credentials.json'),
      path.join(home, '.gemini', 'oauth_creds.json'),
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
  private readEmailFromCliLogs(userId?: string | number | null): string | null {
    const emailPattern = /applyAuthResult: email=([^,\s]+@[^,\s]+)/g;
    const logDir = this.logDir(userId);

    let logFiles: string[];
    try {
      logFiles = readdirSync(logDir)
        .filter((name) => name.startsWith('cli-') && name.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, 5);
    } catch {
      return null;
    }

    for (const logFile of logFiles) {
      try {
        const content = readFileSync(path.join(logDir, logFile), 'utf-8');
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
