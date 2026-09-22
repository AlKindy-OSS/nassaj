import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { resolveClaudeCodeExecutablePath, wellKnownClaudeInstallCandidates } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus, ProviderLinkExpiry } from '@/shared/types.js';
import { isCliInstalled, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  linkExpiry?: ProviderLinkExpiry | null;
  /** B-1260: credential present but a PARTIAL link (see ProviderAuthStatus.incompleteLink). */
  incompleteLink?: boolean;
};

/**
 * B-1260 — the scopes a FULL Claude subscription link carries. `claude auth
 * login` mints access + refresh with the profile+inference set below; `claude
 * setup-token` mints an inference-only token (`inferenceOnly:true` in the
 * bundled CLI). A credentials file whose stored `scopes` array is present but
 * omits the profile scope is therefore an inference-only link — usable for a
 * turn but unable to read usage/profile — so it is reported as incomplete, not
 * fully linked. Both the short (`profile`) and namespaced (`user:profile`)
 * spellings are accepted, since the on-disk array uses the short form.
 */
const FULL_LINK_PROFILE_SCOPES = ['profile', 'user:profile'] as const;

/**
 * Classifies a `.credentials.json` claudeAiOauth block into a link quality,
 * shared in spirit with claude-onboarding.service.js (kept in parity by
 * claude-auth.provider.test.ts + claude-onboarding.test.ts). Pure over `now`.
 *
 *   - 'none'       no access token at all;
 *   - 'expired'    both the access token AND the refresh token are dead;
 *   - 'incomplete' usable-looking but not a FULL link: no refresh token (cannot
 *                  renew — the B-1260 false-"linked" case), or a scopes array
 *                  that omits the profile scope (inference-only);
 *   - 'linked'     access token present, a refresh token exists, at least one of
 *                  the two is alive, and scopes (when present) include profile.
 */
function classifyOauthLink(
  oauth: Record<string, unknown> | null | undefined,
  now: number,
): 'none' | 'expired' | 'incomplete' | 'linked' {
  const accessToken = readOptionalString(oauth?.accessToken);
  if (!accessToken) return 'none';

  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
  const linkExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
    ? oauth.refreshTokenExpiresAt
    : undefined;
  const refreshToken = readOptionalString(oauth?.refreshToken);

  const accessAlive = expiresAt === undefined || now < expiresAt;
  const refreshAlive = Boolean(refreshToken)
    && (linkExpiresAt === undefined || now < linkExpiresAt);

  if (!accessAlive && !refreshAlive) return 'expired';

  // A full link MUST be renewable. Without a refresh token the access token dies
  // (silently, at ~8h) with no way back — and the reported B-1260 credential had
  // exactly this shape (accessToken, no refreshToken, no expiresAt) yet showed
  // "linked". Treat it as incomplete: the honest "re-link" state, not "connected".
  if (!refreshToken) return 'incomplete';

  const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : null;
  if (scopes) {
    const hasProfile = scopes.some(
      (s) => typeof s === 'string' && FULL_LINK_PROFILE_SCOPES.includes(s as never),
    );
    if (!hasProfile) return 'incomplete';
  }

  return 'linked';
}

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

const MS_PER_DAY = 86_400_000;

/**
 * حدُّ **نبرة التحذير** لا حدُّ العرض، مطابقةً لثابت الـCLI (`3 * يوم`) الذي يحكم
 * بانر «‏Your login expires in N days» — فالعضو يرى الرقم نفسه في طرفيّته وفي
 * نسّاج ولا يُنذَر هنا قبل أن يُنذَر هناك.
 *
 * والتاريخُ نفسُه يُعرض **دائماً**: البطاقة تعرض موعد تجديد الاشتراك في كل حال،
 * فحجبُ موعد انتهاء الربط خارج النافذة كان يجعل تسجيلَ دخولٍ ناجحاً يبدو بلا أثر
 * — يُجدّد العضو فيختفي السطر بدل أن يُظهر الموعد الجديد.
 */
const LINK_EXPIRY_WARNING_DAYS = 3;

/**
 * ما يُقال عن قرب انقطاع الربط، أو `null` حين يكون الصمت هو الجواب الصادق.
 *
 * الشروط منقولةٌ عن دالّة العرض في ثنائية الـCLI (‏2.1.221) لا مجتهَدٌ فيها،
 * وأهمُّها الثالث: انتهاءُ توكن وصولٍ يقع بعد موعد الربط بأكثر من النافذة يعني
 * ملفاً متناقضاً مع نفسه — والصمت أصدق من تحذيرٍ مبنيٍّ على تناقض.
 *
 * `nowMs` مُمرَّرٌ لا مقروءٌ من الساعة داخلاً ليبقى العدّاد قابلاً للتثبيت في
 * الاختبار.
 */
function resolveLinkExpiry(
  linkExpiresAtMs: number | undefined,
  accessExpiresAtMs: number | undefined,
  nowMs: number,
): ProviderLinkExpiry | null {
  if (linkExpiresAtMs === undefined || !isRenderableStamp(linkExpiresAtMs)) return null;

  const windowMs = LINK_EXPIRY_WARNING_DAYS * MS_PER_DAY;
  if (accessExpiresAtMs !== undefined && accessExpiresAtMs > linkExpiresAtMs + windowMs) {
    return null;
  }

  const remainingMs = linkExpiresAtMs - nowMs;

  return {
    expiresAt: new Date(linkExpiresAtMs).toISOString(),
    // انحرافٌ واعٍ عن الـCLI: هو يصمت عند `r <= 0` لأن مساره يعرض حينها شيئاً
    // آخر. ونحن نُبقي `0` لأن الميقاتَ المُنقضي عندنا لا يقطع الاتصال ما دام
    // توكنُ الوصول حيّاً — فالصمتُ هنا يعني انكساراً مفاجئاً بلا سابق إنذار.
    daysLeft: Math.max(0, Math.ceil(remainingMs / MS_PER_DAY)),
  };
}

/** حدُّ ما يقبله `new Date(...).toISOString()` قبل أن يرمي `RangeError`. */
const MAX_TIME_VALUE = 8.64e15;

const isRenderableStamp = (ms: number): boolean => (
  Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_VALUE
);

/**
 * ختمٌ للسجلّ التشخيصي لا يُسقط التشخيص. رقمٌ خارج مدى `Date` — و`-1e308` سلسلةُ
 * JSON صحيحة — كان يُطلق `RangeError` داخل `try` فيبتلعه الـ`catch` ويُبدّل السببَ
 * إلى «ملفٌّ غير مقروء»، فيُرسل المشغّلَ خلف أذونات ملفٍ سليم.
 */
const stampForLog = (ms: number | undefined): string => (
  ms !== undefined && isRenderableStamp(ms) ? new Date(ms).toISOString() : String(ms)
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
   * Human-readable "where we looked" for the not-installed error, derived from
   * the SAME candidate list the resolver probes (B-1091) so the message can never
   * drift from the actual search. `cliPath` is the already-resolved value.
   */
  private describeMissingCli(cliPath: string): string {
    if (cliPath.includes(path.sep)) {
      return `resolved to "${cliPath}" but it is not runnable (missing, not a file, or not executable)`;
    }
    const searched = wellKnownClaudeInstallCandidates(os.homedir(), cliPath).join(', ');
    return `"${cliPath}" was not found on PATH or in the known install dirs (${searched})`;
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
    // Resolve once and reuse for both the install probe and the error detail.
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    const installed = isCliInstalled(cliPath);

    if (!installed) {
      // B-1091: the resolver already probes PATH and the well-known install dirs,
      // so surface where it looked. This keeps a "Connected" credential badge from
      // silently contradicting an opaque "not installed" error — the operator sees
      // exactly which path failed and can set CLAUDE_CLI_PATH to fix it.
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: `Claude Code CLI is not installed: ${this.describeMissingCli(cliPath)}. `
          + 'Set CLAUDE_CLI_PATH to the absolute path of the claude binary.',
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
      // يُملأ في فرع ملفّ الاعتماد وحده، فمسارُ مفتاح API لا يحمله أصلاً — وهو
      // الشرط الذي يمنع عرض «ينتهي ربطك» على من لا ربطَ اشتراكٍ له.
      linkExpiry: credentials.linkExpiry ?? null,
      // B-1260: اعتمادٌ جزئيٌّ (setup-token inference-only أو ملفٌّ بلا refresh)
      // يُعلَّم ناقصاً كي لا تعرضه الواجهة «متصلاً» كاملاً.
      incompleteLink: credentials.incompleteLink ?? false,
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
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude setup-token or configure ANTHROPIC_API_KEY.';

    if (readOptionalString(env.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key' };
    }

    if (readOptionalString(env.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    // `claude setup-token` mints a long-lived OAuth token (sk-ant-oat01...) and
    // instructs the user to export it as CLAUDE_CODE_OAUTH_TOKEN — the CLI honors
    // that variable, so the status check must too (T-115). B-1260: this token is
    // inference-only (`inferenceOnly:true` in the CLI), so it runs a turn but
    // cannot read usage/profile — a PARTIAL link. It stays authenticated (the
    // agent works) but is flagged incomplete so the card nudges a full re-link
    // instead of claiming a complete subscription link.
    if (readOptionalString(env.CLAUDE_CODE_OAUTH_TOKEN)) {
      return {
        authenticated: true, email: 'OAuth Token', method: 'oauth_token', incompleteLink: true,
      };
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
      // B-1260: inference-only setup-token stored in settings.json — partial link.
      return {
        authenticated: true,
        email: 'Configured via settings.json',
        method: 'oauth_token',
        incompleteLink: true,
      };
    }

    try {
      const credPath = path.join(configDir, '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        // B-586: الحكم على الربط لا على توكن الوصول. `expiresAt` عمرُ توكن الوصول
        // (ثماني ساعاتٍ متدحرجة)، و`refreshTokenExpiresAt` موعدُ انقطاع الربط.
        // ويُقرأ كلاهما بفحص نوعٍ صريح لا بـ`!x` كي لا يُقرأ الختمُ الصفريُّ «بلا
        // انتهاء». المنطقُ كلُّه في `classifyOauthLink` كي تتطابق ساقُه مع
        // claude-onboarding.service.js حرفاً بحرف (حارس التطابق).
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const linkExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
          ? oauth.refreshTokenExpiresAt
          : undefined;
        const now = Date.now();
        const email = readOptionalString(creds.email)
          ?? readOptionalString(creds.user)
          ?? await this.readOauthAccountEmail(env);

        const link = classifyOauthLink(oauth, now);

        // ميت: انقطع توكنا الوصول والتحديث معاً. الميقاتُ المُنقضي وحدَه لا يقتل —
        // الـCLI لا يستعمله بوّابةً — فلا يُحجب عضوٌ طرفيّتُه تعمل.
        if (link === 'expired') {
          const reason = linkExpiresAt !== undefined && now >= linkExpiresAt
            ? `link-expired(refreshTokenExpiresAt=${stampForLog(linkExpiresAt)})`
            : `access-expired-no-refresh(expiresAt=${stampForLog(expiresAt)})`;
          this.logCredentialsFailure(configDir, `credentials-file-${reason}`);
          return {
            authenticated: false,
            email: null,
            method: null,
            error: 'Claude login has expired. Run claude auth login again.',
          };
        }

        // B-1260: ربطٌ ناقص — ملفٌّ بلا `refreshToken` (لا يُنعَش فينكسر، وهو شكلُ
        // العطل المُبلَّغ) أو نطاقاتٌ بلا profile (inference-only). لا يُقدَّم على
        // أنه متصلٌ كامل: `authenticated: false` مع `incompleteLink` ورسالةُ
        // «أعِد الربط الكامل»، فلا يبقى المستخدم على اعتمادٍ لا يعمل ويظنّه موصولاً.
        if (link === 'incomplete') {
          this.logCredentialsFailure(configDir, 'credentials-file-incomplete-link-no-refresh-or-scope');
          return {
            authenticated: false,
            email: null,
            method: null,
            incompleteLink: true,
            error: 'Claude link is incomplete. Run claude auth login for full access.',
          };
        }

        return {
          authenticated: true,
          email,
          method: 'credentials_file',
          linkExpiry: resolveLinkExpiry(linkExpiresAt, expiresAt, now),
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
      let errorMessage = 'Unable to read Claude credentials. Run claude setup-token again.';
      let failureReason = 'credentials-file-unreadable';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
        failureReason = 'credentials-file-not-found';
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude setup-token again.';
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
