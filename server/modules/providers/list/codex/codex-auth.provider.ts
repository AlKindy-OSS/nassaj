import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { resolveCodexMachineRuntime } from '@/shared/codex-executable.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { operatorCodexHome } from './codex-home.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  authMode: ProviderAuthStatus['authMode'];
  error?: string;
};

/** The credential the Codex CLI actually runs on, after its own precedence. */
export type CodexEffectiveAuth = 'api_key' | 'subscription' | 'none';

/** auth.json `auth_mode` values whose behaviour was measured (ADR-200 S3). */
const MEASURED_AUTH_MODES = new Set(['apikey', 'chatgpt']);

/** True when auth.json holds a usable ChatGPT (subscription) token pair. */
export function hasCodexOAuthTokens(auth: Record<string, unknown>): boolean {
  const tokens = readObjectRecord(auth.tokens) ?? {};
  return Boolean(readOptionalString(tokens.id_token) || readOptionalString(tokens.access_token));
}

/**
 * ADR-200 S3 — the Codex credential precedence, measured against codex-cli
 * 0.160.0 (`codex login status`, throwaway CODEX_HOME, dummy values only):
 *
 *   auth_mode "apikey"  + key + tokens  → API key      (tokens ignored)
 *   auth_mode "chatgpt" + key + tokens  → ChatGPT      (key ignored)
 *   auth_mode "apikey"  + tokens, no key → error "API key auth is missing a key"
 *   no auth_mode        + key + tokens  → API key      (a key field that is not
 *                                                       null wins, even "")
 *   no auth_mode        + tokens        → ChatGPT
 *   env OPENAI_API_KEY / CODEX_API_KEY over a "chatgpt" file → ChatGPT as
 *     reported by `login status` (nassaj injects neither into a codex spawn)
 *
 * So `auth_mode`, when present, decides alone; when absent, a non-null
 * OPENAI_API_KEY decides. A mode with no usable credential behind it is
 * `none`. An unmeasured `auth_mode` value falls back to the no-mode rule.
 */
export function resolveCodexEffectiveAuth(auth: Record<string, unknown>): CodexEffectiveAuth {
  const mode = typeof auth.auth_mode === 'string' && MEASURED_AUTH_MODES.has(auth.auth_mode)
    ? auth.auth_mode
    : (auth.OPENAI_API_KEY ?? null) !== null ? 'apikey' : 'chatgpt';
  if (mode === 'apikey') {
    return readOptionalString(auth.OPENAI_API_KEY) ? 'api_key' : 'none';
  }
  return hasCodexOAuthTokens(auth) ? 'subscription' : 'none';
}

/** Which credentials are present on disk, independent of which one runs. */
function presentAuthMode(auth: Record<string, unknown>): ProviderAuthStatus['authMode'] {
  const hasKey = readOptionalString(auth.OPENAI_API_KEY) !== undefined;
  const hasTokens = hasCodexOAuthTokens(auth);
  if (hasKey && hasTokens) return 'both';
  if (hasKey) return 'api_key';
  return hasTokens ? 'subscription_oauth' : null;
}

/** True when the machine Codex release (T-1872) resolves with a valid layout on this host. */
const isCodexMachineRuntimeAvailable = (): boolean => {
  try {
    resolveCodexMachineRuntime();
    return true;
  } catch {
    return false;
  }
};

export class CodexProviderAuth implements IProviderAuth {
  /** @param machineRuntimeAvailable test seam for the machine-release probe. */
  constructor(private readonly machineRuntimeAvailable: () => boolean = isCodexMachineRuntimeAvailable) {}

  /**
   * Checks whether Codex is available to the server runtime. Every launch runs
   * the machine release (resolveCodexMachineRuntime), never PATH and never the
   * SDK-bundled copy — so that release alone is the truth for "installed".
   */
  private checkInstalled(): boolean {
    return this.machineRuntimeAvailable();
  }

  /**
   * Returns Codex SDK availability and credential status, checked against the
   * SAME CODEX_HOME a spawn for this user would use. `userId` is resolved through
   * resolveProviderEnv (B-136/B-152) so an isolated user's status reflects their
   * own ~/.nassaj-users/<userId>/.codex/auth.json, while a shared/anonymous check
   * falls back to the operator ~/.codex — never a fixed operator path.
   */
  async getStatus(userId?: string | number | null): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials(this.resolveCodexHome(userId));

    return {
      installed,
      provider: 'codex',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      authMode: credentials.authMode,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Resolves the Codex home for the given user via the central B-136 resolver.
   * Isolated → ~/.nassaj-users/<userId>/.codex; shared/anonymous → ~/.codex.
   */
  private resolveCodexHome(userId?: string | number | null): string {
    const env = resolveProviderEnv(userId ?? null, 'codex', process.env);
    return readOptionalString(env.CODEX_HOME) ?? operatorCodexHome();
  }

  /**
   * Reads Codex auth.json and reports the credential the CLI would actually
   * use (resolveCodexEffectiveAuth), plus which credentials are present.
   */
  private async checkCredentials(codexHome: string): Promise<CodexCredentialsStatus> {
    try {
      const content = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};
      const authMode = presentAuthMode(auth);
      const effective = resolveCodexEffectiveAuth(auth);
      if (effective === 'subscription') {
        const idToken = readOptionalString((readObjectRecord(auth.tokens) ?? {}).id_token);
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
          authMode,
        };
      }
      if (effective === 'api_key') {
        return { authenticated: true, email: 'API Key Auth', method: 'api_key', authMode };
      }
      return { authenticated: false, email: null, method: null, authMode, error: 'No valid tokens found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        authMode: null,
        error: code === 'ENOENT' ? 'Codex not configured' : error instanceof Error ? error.message : 'Failed to read Codex auth',
      };
    }
  }

  /**
   * Extracts the user email from a Codex id_token when a readable JWT payload exists.
   */
  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // Fall back to a generic authenticated marker if the token payload is not readable.
    }

    return 'Authenticated';
  }
}
