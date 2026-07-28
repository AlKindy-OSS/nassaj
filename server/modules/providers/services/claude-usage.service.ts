import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type {
  ClaudeExtraUsage,
  ClaudeUsageSummary,
  ClaudeUsageWindow,
} from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

/**
 * Upstream Anthropic usage endpoint. Called from the backend ONLY so the OAuth
 * access token is never exposed to the browser.
 */
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/**
 * OAuth token-refresh endpoint and public client id used by Claude Code. Used
 * to recover from a 401 by exchanging the stored refresh token. These are the
 * fixed, non-secret values the official CLI uses.
 */
const ANTHROPIC_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

/**
 * Aggressive upstream rate limiting forces us to cache. 180s is the documented
 * floor. The cache is keyed per resolved credentials path so an isolated user
 * sees THEIR subscription usage while users sharing the operator credential
 * still share one cache slot (and one upstream call).
 */
const CACHE_TTL_MS = 180_000;

/**
 * Network timeout for the upstream call. Short enough to fail fast and serve a
 * stale copy rather than hang the request.
 */
const UPSTREAM_TIMEOUT_MS = 12_000;

/** Fallback CLI version when `claude --version` cannot be read. */
const FALLBACK_CLI_VERSION = '2.1.150';

const CLAUDE_USAGE_UNAVAILABLE = 'CLAUDE_USAGE_UNAVAILABLE';

type CacheEntry = {
  summary: ClaudeUsageSummary;
  expiresAt: number;
};

type OAuthCredential = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
};

/**
 * Resolves a Claude usage summary from Anthropic with an in-memory cache keyed
 * per resolved credentials path, fresh-on-every-request credential reads, and
 * transparent OAuth refresh on 401.
 *
 * Credential isolation (ADR-014): the credentials path is resolved through
 * resolveProviderEnv for the REQUESTING user, so an isolated user's usage is
 * fetched with their own OAuth token (their subscription), never the
 * operator's. When claude is policy-shared, every user resolves to the same
 * operator path and shares one cache slot — identical to the old behavior.
 */
class ClaudeUsageService {
  private cache = new Map<string, CacheEntry>();

  private cliVersionPromise: Promise<string> | null = null;

  /** In-flight fetch dedupe (per credentials path) so concurrent requests share one upstream call. */
  private inFlight = new Map<string, Promise<ClaudeUsageSummary>>();

  /**
   * Returns the Claude usage summary for the given user, serving a fresh cache
   * hit when available and falling back to a stale copy on transient upstream
   * failures.
   *
   * Throws an AppError with code CLAUDE_USAGE_UNAVAILABLE when no data can be
   * produced (missing/expired credential that cannot be refreshed, and no cache).
   */
  async getUsage(userId: string | number | null = null): Promise<ClaudeUsageSummary> {
    const credPath = this.resolveCredentialsPath(userId);

    const cached = this.cache.get(credPath);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.summary;
    }

    const inFlight = this.inFlight.get(credPath);
    if (inFlight) {
      return inFlight;
    }

    const refresh = this.refresh(credPath).finally(() => {
      this.inFlight.delete(credPath);
    });
    this.inFlight.set(credPath, refresh);

    return refresh;
  }

  /**
   * Performs the credential read + upstream fetch, updates the cache on success,
   * and returns a stale cached copy (flagged `stale: true`) on transient errors.
   */
  private async refresh(credPath: string): Promise<ClaudeUsageSummary> {
    let credential: OAuthCredential;
    try {
      credential = await this.readCredential(credPath);
    } catch (error) {
      // A missing/unreadable credential is terminal only when we have no cache
      // to fall back on. Otherwise surface the stale copy.
      return this.serveStaleOrThrow(credPath, error);
    }

    try {
      const raw = await this.fetchUsage(credPath, credential);
      const summary = this.normalize(raw, credential, false);
      this.cache.set(credPath, { summary, expiresAt: Date.now() + CACHE_TTL_MS });
      return summary;
    } catch (error) {
      return this.serveStaleOrThrow(credPath, error);
    }
  }

  /**
   * Returns the cached summary marked stale when present; otherwise rethrows a
   * normalized AppError so the route never emits a silent 500.
   */
  private serveStaleOrThrow(credPath: string, error: unknown): ClaudeUsageSummary {
    const cached = this.cache.get(credPath);
    if (cached) {
      return { ...cached.summary, stale: true, fetchedAt: cached.summary.fetchedAt };
    }

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Claude usage is currently unavailable.', {
      code: CLAUDE_USAGE_UNAVAILABLE,
      statusCode: 502,
    });
  }

  /**
   * Calls the Anthropic usage endpoint with the mandatory headers. On a 401 it
   * attempts a single OAuth refresh and retries once.
   */
  private async fetchUsage(
    credPath: string,
    credential: OAuthCredential,
    allowRefresh = true,
  ): Promise<Record<string, unknown>> {
    const userAgent = `claude-code/${await this.resolveCliVersion()}`;

    const response = await this.requestUsage(credential.accessToken, userAgent);

    if (response.status === 401 && allowRefresh) {
      const refreshed = await this.refreshAccessToken(credPath, credential);
      return this.fetchUsage(credPath, refreshed, false);
    }

    if (response.status === 429) {
      throw new AppError('Claude usage endpoint is rate limited.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 429,
      });
    }

    if (!response.ok) {
      throw new AppError('Claude usage request failed.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 502,
      });
    }

    const body = (await response.json()) as unknown;
    const record = readObjectRecord(body);
    if (!record) {
      throw new AppError('Claude usage response was malformed.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 502,
      });
    }

    return record;
  }

  /**
   * Issues the raw HTTP GET with an abort-based timeout. Separated so the
   * header contract (User-Agent is critical — absence triggers an instant 429)
   * lives in exactly one place.
   */
  private async requestUsage(accessToken: string, userAgent: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      return await fetch(ANTHROPIC_USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': ANTHROPIC_BETA_HEADER,
          'User-Agent': userAgent,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch {
      throw new AppError('Claude usage endpoint is unreachable.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 502,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Exchanges the stored refresh token for a new access token and persists the
   * rotated tokens back to the credentials file (matching Claude Code, which
   * keeps the file as the single source of truth).
   */
  private async refreshAccessToken(credPath: string, credential: OAuthCredential): Promise<OAuthCredential> {
    if (!credential.refreshToken) {
      throw new AppError('Claude OAuth token expired and cannot be refreshed.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 401,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
          client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
        }),
        signal: controller.signal,
      });
    } catch {
      throw new AppError('Claude OAuth refresh request failed.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 401,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AppError('Claude OAuth refresh was rejected.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 401,
      });
    }

    const record = readObjectRecord(await response.json());
    const accessToken = readOptionalString(record?.access_token);
    if (!accessToken) {
      throw new AppError('Claude OAuth refresh returned no access token.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 401,
      });
    }

    const refreshToken = readOptionalString(record?.refresh_token) ?? credential.refreshToken;
    const expiresInSeconds = typeof record?.expires_in === 'number' ? record.expires_in : null;
    const expiresAt = expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : credential.expiresAt;

    await this.persistRefreshedCredential(credPath, { accessToken, refreshToken, expiresAt });

    return { ...credential, accessToken, refreshToken, expiresAt };
  }

  /**
   * Writes the rotated OAuth fields back into `.credentials.json` while
   * preserving every other field already on disk.
   */
  private async persistRefreshedCredential(credPath: string, update: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number | null;
  }): Promise<void> {
    try {
      const content = await readFile(credPath, 'utf8');
      const root = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(root.claudeAiOauth) ?? {};
      const next = {
        ...root,
        claudeAiOauth: {
          ...oauth,
          accessToken: update.accessToken,
          refreshToken: update.refreshToken,
          ...(update.expiresAt !== null ? { expiresAt: update.expiresAt } : {}),
        },
      };
      await writeFile(credPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Persisting is best-effort: the refreshed token still works in-memory for
      // this request even if the write fails. Never block the response on it.
    }
  }

  /**
   * Reads the Claude credentials file fresh on every call. Claude Code rotates
   * the token in this file out-of-band, so caching the token in memory would
   * risk using a stale one.
   */
  private async readCredential(credPath: string): Promise<OAuthCredential> {
    let oauth: ReturnType<typeof readObjectRecord>;
    try {
      const content = await readFile(credPath, 'utf8');
      const root = readObjectRecord(JSON.parse(content)) ?? {};
      oauth = readObjectRecord(root.claudeAiOauth);
    } catch {
      throw new AppError('Claude credentials are not available.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 401,
      });
    }

    const accessToken = readOptionalString(oauth?.accessToken);
    if (!accessToken) {
      throw new AppError('Claude is not authenticated.', {
        code: CLAUDE_USAGE_UNAVAILABLE,
        statusCode: 401,
      });
    }

    return {
      accessToken,
      refreshToken: readOptionalString(oauth?.refreshToken) ?? null,
      expiresAt: typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null,
      subscriptionType: readOptionalString(oauth?.subscriptionType) ?? null,
      rateLimitTier: readOptionalString(oauth?.rateLimitTier) ?? null,
    };
  }

  /**
   * Resolves the credentials file path for the requesting user through the
   * central isolation seam (resolveProviderEnv), so usage is fetched against
   * the SAME credential a claude spawn for this user would use. An isolated
   * user resolves to their own CLAUDE_CONFIG_DIR; shared/anonymous resolves to
   * the operator env (its CLAUDE_CONFIG_DIR or ~/.claude).
   */
  private resolveCredentialsPath(userId: string | number | null): string {
    const env = resolveProviderEnv(userId, 'claude', process.env);
    const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR)
      ?? path.join(os.homedir(), '.claude');
    return path.join(configDir, '.credentials.json');
  }

  /**
   * Resolves the real CLI version for the User-Agent (memoized). Anthropic
   * returns an instant 429 without a `claude-code/<version>` User-Agent, so a
   * sane fallback version is used when the CLI cannot be invoked.
   */
  private async resolveCliVersion(): Promise<string> {
    if (!this.cliVersionPromise) {
      this.cliVersionPromise = this.readCliVersion();
    }
    return this.cliVersionPromise;
  }

  private async readCliVersion(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 });
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      return match?.[1] ?? FALLBACK_CLI_VERSION;
    } catch {
      return FALLBACK_CLI_VERSION;
    }
  }

  /**
   * Maps the raw Anthropic payload onto the stable frontend contract, deriving a
   * human-readable plan name from the rate-limit tier / subscription type.
   */
  private normalize(
    raw: Record<string, unknown>,
    credential: OAuthCredential,
    stale: boolean,
  ): ClaudeUsageSummary {
    return {
      plan: this.derivePlanName(credential),
      session: this.toWindow(raw.five_hour),
      weeklyAllModels: this.toWindow(raw.seven_day),
      weeklySonnet: this.toWindow(raw.seven_day_sonnet),
      // Opus surfaces null like every other window when upstream omits it
      // (current Max plans report seven_day_opus: null — opus burn rolls into
      // seven_day/five_hour). The UI hides null windows; if Anthropic later
      // populates seven_day_opus, the row appears automatically.
      weeklyOpus: this.toWindow(raw.seven_day_opus),
      extraUsage: this.toExtraUsage(raw.extra_usage),
      fetchedAt: new Date().toISOString(),
      stale,
    };
  }

  private toWindow(value: unknown): ClaudeUsageWindow | null {
    const record = readObjectRecord(value);
    if (!record) {
      return null;
    }
    const utilization = typeof record.utilization === 'number' ? record.utilization : 0;
    return {
      utilization,
      resetsAt: readOptionalString(record.resets_at) ?? null,
    };
  }

  private toExtraUsage(value: unknown): ClaudeExtraUsage | null {
    const record = readObjectRecord(value);
    if (!record) {
      return null;
    }
    return {
      enabled: record.is_enabled === true,
      monthlyLimit: typeof record.monthly_limit === 'number' ? record.monthly_limit : null,
      usedCredits: typeof record.used_credits === 'number' ? record.used_credits : null,
      utilization: typeof record.utilization === 'number' ? record.utilization : null,
      currency: readOptionalString(record.currency) ?? null,
    };
  }

  /**
   * Derives the display plan name (e.g. "Max 20x") from rateLimitTier first,
   * then subscriptionType. The upstream API does not return a plan name.
   */
  private derivePlanName(credential: OAuthCredential): string | null {
    const tier = credential.rateLimitTier?.toLowerCase() ?? '';
    if (tier.includes('max_20x') || tier.includes('max20x')) {
      return 'Max 20x';
    }
    if (tier.includes('max_5x') || tier.includes('max5x')) {
      return 'Max 5x';
    }
    if (tier.includes('pro')) {
      return 'Pro';
    }

    const subscription = credential.subscriptionType?.toLowerCase() ?? '';
    if (subscription === 'max') {
      return 'Max';
    }
    if (subscription === 'pro') {
      return 'Pro';
    }
    if (subscription) {
      return subscription.charAt(0).toUpperCase() + subscription.slice(1);
    }

    return null;
  }
}

export const claudeUsageService = new ClaudeUsageService();
