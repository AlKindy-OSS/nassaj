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
};

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
        // B-586: الحكم على الربط لا على توكن الوصول. كان هذا الفرع يُعلن
        // `authenticated: false` بمجرّد مُضيّ `expiresAt` — وهو ثماني ساعاتٍ
        // يجدّدها الـCLI صامتاً بتوكن التحديث، فكانت البطاقة تقول «انتهى تسجيل
        // دخولك» لعضوٍ أمامه أسبوعان (قِيس: عضوٌ عند +13.35 يوماً يرى بطاقةً
        // حمراء). والموعدُ الذي ينكسر عنده الربط فعلاً هو `refreshTokenExpiresAt`.
        //
        // ويُقرأ `expiresAt` بفحص نوعٍ صريح لا بـ`!expiresAt`: الصيغة الأخيرة
        // كانت تقرأ الختم الصفري «بلا انتهاء» فتُعلن اعتماداً ميتاً موصولاً.
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const linkExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
          ? oauth.refreshTokenExpiresAt
          : undefined;
        const refreshToken = readOptionalString(oauth?.refreshToken);
        const now = Date.now();
        const email = readOptionalString(creds.email)
          ?? readOptionalString(creds.user)
          ?? await this.readOauthAccountEmail(env);

        // طريقان يُبقيان الاعتماد صالحاً، والموتُ انقطاعُهما معاً: إمّا توكنُ وصولٍ
        // لم ينتهِ بعد (يعمل الآن)، أو توكنُ تحديثٍ لم يمضِ ميقاتُه (يُنعشه عند
        // اللزوم). وغيابُ `refreshTokenExpiresAt` (اعتمادٌ كتبه إصدارٌ أقدم) ليس
        // موتاً — تُترك الحياةُ لتوكن التحديث حينئذٍ.
        //
        // والميقاتُ المُنقضي وحدَه **لا يقتل**: الـCLI نفسه لا يستعمله بوّابةً — في
        // ثنائيّته موضعٌ واحدٌ يقارنه بالساعة وهو دالّةُ عرض التحذير لا أيُّ مسار
        // تنفيذ. فلو حكمنا بالإنقضاء وحده لحُجب عضوٌ عن اختيار نماذج كلود
        // (`isProviderDisabled = installed && !authenticated`) بينما طرفيّتُه تعمل.
        const accessAlive = expiresAt === undefined || now < expiresAt;
        const refreshAlive = Boolean(refreshToken)
          && (linkExpiresAt === undefined || now < linkExpiresAt);

        if (!accessAlive && !refreshAlive) {
          const reason = linkExpiresAt !== undefined && now >= linkExpiresAt
            ? `link-expired(refreshTokenExpiresAt=${stampForLog(linkExpiresAt)})`
            : `access-expired-no-refresh(expiresAt=${stampForLog(expiresAt)})`;
          this.logCredentialsFailure(configDir, `credentials-file-${reason}`);
          return {
            authenticated: false,
            email: null,
            method: null,
            error: 'Claude login has expired. Run claude setup-token again.',
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
