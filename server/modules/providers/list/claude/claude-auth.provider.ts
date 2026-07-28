import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { isCliInstalled, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    return isCliInstalled(cliPath);
  }

  /**
   * Install-only probe (IProviderAuth.isInstalled): reports whether the Claude
   * Code CLI is present WITHOUT reading, resolving, or LOGGING any credential
   * state. `providerAuthService.isProviderInstalled` prefers this so a bare
   * "is claude installed?" check — e.g. the spawn error handler in claude-sdk.js
   * building a clearer message — never runs the credentials diagnostic below.
   *
   * B-190: without this seam that install check ran the full getStatus() with NO
   * userId, which falls back to the OPERATOR ~/.claude and logged a misleading
   * "[claude-auth] credentials check failed ... configDir=~/.claude" WARN about an
   * expired operator token even though every isolated user's real spawn env (their
   * own CLAUDE_CONFIG_DIR) was valid and auto-renewing.
   */
  isInstalled(): boolean {
    return this.checkInstalled();
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth
   * priority, reported against the SAME environment a spawn for this user would
   * use. `userId` is resolved through resolveProviderEnv so an isolated user is
   * checked against their own CLAUDE_CONFIG_DIR, while a shared/anonymous check
   * falls back to the operator's ~/.claude — i.e. the status always reflects the
   * real spawn environment instead of a fixed operator path.
   */
  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    // Build the same env the spawn path uses for this user. When claude is
    // shared (admin policy) or there is no user, this returns the base env
    // unchanged so the operator credential at ~/.claude is checked.
    const env = resolveProviderEnv(userId ?? null, 'claude', process.env);
    const credentials = await this.checkCredentials(env);

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Resolves the Claude config directory for the given (already-resolved) env.
   * Honors CLAUDE_CONFIG_DIR (set by resolveProviderEnv when isolated) and falls
   * back to the operator's ~/.claude when unset (shared / anonymous).
   */
  private resolveConfigDir(env: NodeJS.ProcessEnv): string {
    const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR);
    return configDir ?? path.join(os.homedir(), '.claude');
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server
   * process env is empty. Reads from the resolved config dir so an isolated
   * user's own settings.json is consulted.
   */
  private async loadSettingsEnv(configDir: string): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(configDir, 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Reads the login email from the CLI's .claude.json (`oauthAccount.emailAddress`).
   * `.credentials.json` only stores tokens, so this is the sole offline source of
   * the account identity. With CLAUDE_CONFIG_DIR set the CLI keeps .claude.json
   * inside that dir; otherwise it lives at the home-directory ROOT (~/.claude.json),
   * not inside ~/.claude.
   */
  private async readOauthAccountEmail(env: NodeJS.ProcessEnv): Promise<string | null> {
    const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR);
    const configFile = configDir
      ? path.join(configDir, '.claude.json')
      : path.join(os.homedir(), '.claude.json');

    try {
      const content = await readFile(configFile, 'utf8');
      const config = readObjectRecord(JSON.parse(content));
      const account = readObjectRecord(config?.oauthAccount);
      return readOptionalString(account?.emailAddress) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Logs a single structured diagnostic line (no secrets) whenever a credential
   * check fails, so "user appears unauthenticated" incidents (e.g. T-115: the
   * `claude setup-token` flow prints a token but never persists it) can be
   * diagnosed from server logs without inspecting user dirs by hand.
   */
  private logCredentialsFailure(configDir: string, reason: string): void {
    console.warn(
      `[WARN] [claude-auth] credentials check failed: reason=${reason} configDir=${configDir} ` +
      '(checked: env ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN, ' +
      'settings.json env, .credentials.json claudeAiOauth.accessToken)'
    );
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code,
   * against the resolved environment for the user being checked.
   */
  private async checkCredentials(env: NodeJS.ProcessEnv): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    if (readOptionalString(env.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key' };
    }

    if (readOptionalString(env.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    // `claude setup-token` mints a long-lived OAuth token (sk-ant-oat01...) and
    // instructs the user to export it as CLAUDE_CODE_OAUTH_TOKEN — the CLI honors
    // that variable, so the status check must too (T-115).
    if (readOptionalString(env.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'OAuth Token', method: 'oauth_token' };
    }

    const configDir = this.resolveConfigDir(env);

    const settingsEnv = await this.loadSettingsEnv(configDir);
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'oauth_token' };
    }

    try {
      const credPath = path.join(configDir, '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email)
          ?? readOptionalString(creds.user)
          ?? await this.readOauthAccountEmail(env);
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        this.logCredentialsFailure(
          configDir,
          `credentials-file-expired(expiresAt=${new Date(expiresAt).toISOString()})`
        );
        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      this.logCredentialsFailure(configDir, 'credentials-file-missing-claudeAiOauth.accessToken');
      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';
      let failureReason = 'credentials-file-unreadable';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
        failureReason = 'credentials-file-not-found';
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
        failureReason = 'credentials-file-invalid-json';
      }

      this.logCredentialsFailure(configDir, failureReason);
      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }
}
