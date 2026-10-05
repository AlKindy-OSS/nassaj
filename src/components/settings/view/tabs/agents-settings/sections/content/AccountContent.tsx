import { AlertTriangle, Calendar, Check, Clock, Copy, ExternalLink, Link2, LogIn, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../../shared/view/ui';
import SettingsCard from '../../../../SettingsCard';
import SettingsCollapsible from '../../../../SettingsCollapsible';
import SettingsGroup from '../../../../SettingsGroup';
import SettingsRow from '../../../../SettingsRow';
import StatusBadge from '../../../../StatusBadge';
import type { AgentProvider, AuthStatus } from '../../../../../types/types';
import { useProviderCycles } from '../../../../../../quick-settings-panel/hooks/useProviderCycles';
import { findCycleRow, resolveCycleDisplay } from '../../../../../../quick-settings-panel/providerCycleHelpers';

import { hasDualAuthPaths } from './authPaths';
import { BILLING_LINKS } from './billingLinks';
import { formatExpiryMoment, resolveLinkExpiryDisplay } from './linkExpiryHelpers';

/**
 * Per-user isolated credential link state (B-MU-ONBOARD / ADR-023), supplied
 * for credential-isolating agents (claude, antigravity). When present, its
 * onboarding affordances (Re-check, link banner + modal CTA, owner note) are
 * merged into the single account card so connection state is shown exactly
 * once per agent.
 */
export type UserCredentialLink = {
  connected: boolean;
  loading: boolean;
  error: string | null;
  /**
   * دور الحساب `owner`. **لا يعني أنّ اعتماده مربوط** — الربط الرمزي الذي كان
   * الخادم يصنعه لكل حساب دوره `owner` أُزيل ويُقتلع (ADR-105 / B-486)، والمالك
   * يصادق لنفسه كسائر الأعضاء. يبقى أثره هنا في **لافتة الدعوة** وحدها: نداءُ
   * التعريف بالتدفّق لمن لم يبدأه. أمّا مسارا الإكمال — صفّ الدخول وحقل لصق
   * الرمز — فلا يشترطان الدور.
   */
  isOwner: boolean;
  /** i18n prefix of the subscription-link texts in the settings namespace. */
  i18nPrefix: 'claudeConnection' | 'agyConnection';
  /**
   * B-1260 — الاعتماد موجودٌ لكنّه ربطٌ **ناقص** لا كامل (توكن inference-only،
   * أو ملفُّ اعتمادٍ بلا `refreshToken`). حالةٌ متمايزة عن «غير مربوط»: تُعرض
   * دعوةٌ صريحة لإعادة الربط الكامل بدل أن يُقدَّم الناقص «متصلاً».
   */
  incompleteLink?: boolean;
  /** CLI command shown in the onboarding hint (runs inside the link modal). */
  command: string;
  /** Opens the link modal (terminal running the onboarding command). */
  onLink: () => void;
  /** Re-checks the per-user credential link status. */
  onRecheck: () => void;
};

type AccountContentProps = {
  agent: AgentProvider;
  authStatus: AuthStatus;
  onLogin: () => void;
  userLink?: UserCredentialLink;
  /** Re-probes `/auth/status` after a vendor key is set/removed. */
  onRefreshAuthStatus?: () => void;
};

/** Display names used in login copy; the description lines were dropped with the per-agent header. */
const AGENT_DISPLAY_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  antigravity: 'Antigravity (agy)',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  hermes: 'Hermes',
  sakana: 'Sakana',
};

const INSTALL_INFO: Partial<Record<AgentProvider, { label: string; command: string; note?: string }>> = {
  codex: {
    label: 'Codex CLI is not installed',
    command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    note: 'Official standalone installer → ~/.local/bin/codex. An npm -g copy is not detected.',
  },
  opencode: {
    label: 'OpenCode CLI is not installed',
    command: 'curl -fsSL https://opencode.ai/install | bash',
    note: 'Official installer → ~/.opencode/bin/opencode. An npm -g copy is not detected.',
  },
};

/**
 * Providers with NO interactive login flow — the account card hides the login
 * row and the operator configures them through the API-key panel (Settings →
 * Vendors) instead. Opening a login terminal for any of these would land on the
 * generic `echo "No login command configured…"` fallback — the very bug this
 * list prevents by never showing the button.
 *
 * `kimi` is deliberately NOT here (ADR-062): unlike the other hosted vendors it
 * ALSO ships a native CLI (`@moonshot-ai/kimi-code`) with its own device-code
 * login, which is the only way to link a Kimi SUBSCRIPTION instead of a metered
 * API key. While it was listed here the account card hid the login row, so there
 * was no route in the whole UI to open a Kimi terminal and complete that login.
 * `glm` stays: it has no binary of its own — the carrier is OpenCode (GL-1), so
 * its key is written into opencode's auth.json and its "terminal" is OpenCode's.
 * Qwen is deliberately NOT here. Its discontinued `qwen-oauth` free tier does
 * not make the account action disappear: the action routes to Alibaba Coding
 * Plan in the sole encrypted credential surface. It must stay visible so a
 * disconnected account never reports a missing key without offering a way to
 * add it. The action does not open a terminal or create a second credential in
 * `~/.qwen`; Settings owns the routing to the encrypted store.
 */
const PURE_API_PROVIDERS: AgentProvider[] = ['deepseek', 'glm', 'sakana'];

/**
 * Providers that authenticate by EITHER a stored API key OR an interactive CLI
 * login. For these an already-configured key must not hide the login row — that
 * row is precisely how the operator switches from a metered key to a
 * subscription login.
 */
const DUAL_AUTH_PROVIDERS: AgentProvider[] = ['kimi'];

/** Inline copy button: icon toggles to checkmark for 1 second after click. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied
        ? <Check className="h-4 w-4" aria-hidden />
        : <Copy className="h-4 w-4" aria-hidden />}
    </button>
  );
}

/**
 * Single unified credential card per agent [C-MU-UX-AGENT-CREDS].
 *
 * One card shows connection state exactly once: status badge + account email,
 * a Re-login row for re-authentication, and — for credential-isolating agents
 * (claude / antigravity) — the per-user subscription link merged in: a
 * Re-check button next to the badge, an onboarding banner + "Link account"
 * CTA when the current user's isolated credential is missing (the modal is
 * owned by the parent section), and the owner auto-link note.
 *
 * The provider auth status endpoint already reports the *current user's*
 * resolved environment for isolating providers, so the badge and the per-user
 * link reflect the same credential and are rendered as one status.
 *
 * API-key-capable providers (claude / opencode / codex / kimi / deepseek /
 * glm) once showed only a POINTER here, after key entry moved to Settings →
 * Vendors (B-350 / ADR-085) and `ProviderApiKeySection` was deleted with the
 * orphan sweep (T-1139). T-1205 closed that loop: the standalone Vendors tab is
 * gone and the company card renders on this tab again — but as ONE shared
 * component (`CompanyCredentialCard`) driven by the vendor catalog, not as the
 * per-provider form that was deleted. THIS component still holds no key input
 * of its own; the card is a sibling rendered by `AgentCategoryContentSection`.
 * What stays here is what genuinely belongs to the agent: its own CLI login and
 * the per-user subscription link. A provider can
 * still have both an API key (over in Vendors) AND an interactive CLI login
 * (opencode, codex, kimi), or both a key AND the subscription link (claude).
 * deepseek / glm have no CLI login at all — a stored key is their only
 * connection path (ADR-036 / ADR-030). kimi is the exception among the hosted
 * vendors: it ships the native `@moonshot-ai/kimi-code` CLI (ADR-062), so it
 * gets BOTH the API-key panel and the device-code login row.
 */
// `onRefreshAuthStatus` stays in the props type (callers unchanged) but is no
// longer consumed here: the key write it used to refresh moved to the vendors
// tab (ADR-085), and the login path refreshes through its own handler.
/** تنسيق تاريخ ISO للعرض: يحذف السنة إن كانت السنة الحالية. */
function formatDisplayDate(isoString: string, locale: string): string {
  const date = new Date(isoString);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

export default function AccountContent({ agent, authStatus, onLogin, userLink }: AccountContentProps) {
  const { t, i18n } = useTranslation('settings');
  const isAntigravity = agent === 'antigravity';

  const checking = authStatus.loading || Boolean(userLink?.loading);
  const isConnected = authStatus.authenticated || Boolean(userLink?.connected);

  // دورة الفوترة — تُجلَب مرّة واحدة عند الاتصال، بلا استقصاء.
  const cycles = useProviderCycles(isConnected && !checking);
  const cycleRow = cycles.status === 'success'
    ? findCycleRow(cycles.rows, agent)
    : null;
  const cycleDisplay = resolveCycleDisplay(cycleRow, Date.now());

  // قرب انتهاء الربط — من الخادم مباشرةً (commit b4ff85ca).
  const linkExpiryDisplay = resolveLinkExpiryDisplay(authStatus.linkExpiry, Date.now());
  // B-1260: ربطٌ ناقص — حالةٌ متمايزة تسبق لافتة «غير مربوط» وتحجبها، فلا يجتمع
  // على العضو نداءان متناقضان («اربط» و«أعِد الربط الناقص»).
  const showIncompleteLink = Boolean(
    userLink && !userLink.loading && userLink.incompleteLink,
  );
  const showLinkBanner = Boolean(
    userLink && !userLink.loading && !userLink.connected && !userLink.isOwner
      && !userLink.incompleteLink,
  );
  /**
   * **كتلةُ ربط الاشتراك لا تُصيَّر فارغة** (‏T-1700). أبناؤها الثلاثة —
   * الوصف، وسطر الخطأ، ولافتة الربط — كلّهم مشروطون بـ«لم يُربَط بعد»، فحين
   * يكون العضو موصولاً تبقى الكتلة بلا ابنٍ واحد ويبقى حشوُها: شريطٌ ميّت بين
   * صفّ حالة الاتصال وصفّ إعادة المصادقة، أعرضُ فجوةٍ في اللوح كلّه ولا شيء
   * فيها. الشرط هنا هو **اجتماع** شروط أبنائها لا وجود `userLink` وحده.
   */
  const showUserLinkBlock = Boolean(
    userLink
      && ((!userLink.loading && !userLink.connected)
        || userLink.error
        || showLinkBanner),
  );
  // Re-auth affordance: the generic provider login for most agents; for
  // antigravity (no UI-driven login — agy runs Google OAuth in the link
  // modal's terminal) re-linking reopens the same modal. Hidden while the
  // onboarding banner already offers the link CTA — never two competing
  // connect buttons.
  const isPureApiProvider = PURE_API_PROVIDERS.includes(agent);
  const onReauth = isAntigravity ? userLink?.onLink : onLogin;
  // A key-authenticated provider normally needs no login CTA — except for the
  // dual-auth ones (kimi), where the CLI login is the path to a subscription and
  // must stay reachable even once a key is stored.
  const apiKeyHidesLoginRow =
    authStatus.method === 'api_key' && !DUAL_AUTH_PROVIDERS.includes(agent);
  // API-only providers (deepseek/glm/sakana) have no connection action here.
  // Qwen is not in this list: its action opens the managed Alibaba setup
  // terminal for Coding Plan or Token Plan credentials.
  const showLoginRow =
    !isPureApiProvider && Boolean(onReauth) && !apiKeyHidesLoginRow && !showLinkBanner;

  // رابط صفحة الفوترة — موجود لجميع المزوّدين (BILLING_LINKS كامل).
  const billingHref = BILLING_LINKS[agent];

  const installInfo = INSTALL_INFO[agent];
  const showInstallBanner = authStatus.installed === false && Boolean(installInfo);

  /**
   * **طريقان لا أربعة أقسام** (شكوى المالك 2026-08-03).
   *
   * كلّ ما في هذا الملف — حالةُ الاتصال، وربطُ الاشتراك، وإعادةُ المصادقة — جسدٌ
   * واحد لطريقٍ واحد: **الاشتراك المُفعَّل بتسجيل دخول**. والطريق الثاني (مفتاح
   * API) يعيش في `AgentVendorCredentials` تحته. فحين يقبل الوكيل الطريقين معاً
   * يُعنوَن كلٌّ منهما باسمه، ويُطوى **غيرُ المستعمل**.
   *
   * ومقياسُ «المستعمل» ليس تخميناً: `authStatus.method` هو ما ردّ به الخادم عن
   * الاعتماد الذي **صادَق به فعلاً** هذا الوكيل. فإن قال `api_key` فالاشتراك ليس
   * الطريق العامل الآن — يُطوى، وحالتُه تبقى منطوقةً في شارة العنوان المطويّ فلا
   * يُخفي الطيُّ معلومة. وما عدا ذلك (اشتراك، أو لم يُصادَق بعد) يبقى مفتوحاً:
   * وكيلٌ غيرُ موصولٍ أصلاً يحتاج الطريق الأوّل مفتوحاً أمامه لا مطويّاً.
   */
  const dualPaths = hasDualAuthPaths(agent);
  const subscriptionFolded = dualPaths && authStatus.method === 'api_key';

  const statusBadge = (
    /* «اتصالٌ قائم» هو تعريف `success` في خريطة النبرات، فالشارة تحمله. الفحصُ
       وغيرُ الموصول يبقيان محايدَين: «جارٍ الفحص» ليس حكماً، و«غير موصول» ليس
       عطلاً — هو الحالة الافتراضية لوكيلٍ لم يُربَط بعد، وصبغُه أحمر يجعل شاشةَ
       أحد عشر وكيلاً كلَّها إنذاراً. والنقطة الدالّة داخل `StatusBadge` تمنع
       وقوع التمييز على اللون وحده (WCAG 1.4.1). */
    /* والاتصالُ القائم يهبط إلى `warning` حين يكون الربطُ منقضياً أو في يومه
       الأخير: «متصل» و«انتهى تسجيل دخولك» في سطرين متجاورين يقرآن تناقضاً وإن
       صدَقا معاً — الشارةُ تصف «أيعمل الآن؟» والسطرُ يصف «أيمكن تجديده؟».
       فاللونُ هنا رباطٌ بين الجملتين لا معلومةٌ ثالثة، والتمييزُ الحقيقي محمولٌ
       على نصّ السطر وأيقونته لا على لون الشارة وحده (WCAG 1.4.1). */
    <StatusBadge
      tone={
        !checking && isConnected
          ? (linkExpiryDisplay?.tone === 'expired' || linkExpiryDisplay?.tone === 'danger'
            ? 'warning'
            : 'success')
          : 'neutral'
      }
    >
      {checking
        ? t('agents.authStatus.checking')
        : isConnected
          ? t('agents.authStatus.connected')
          : t('agents.authStatus.disconnected')}
    </StatusBadge>
  );

  const subscriptionTitle = t('agents.authPaths.subscription.title', {
    defaultValue: 'الاعتماد باشتراك (تسجيل دخول)',
  });

  /* لا بطاقة تحيط هذه الصفوف (v2 §1): قائمةٌ بفواصل شعرية، والحدّان العلوي
     والسفلي يعطيان القسم بدايةً ونهايةً بلا صندوق. الفواصل الداخلية كانت
     `border-t … pt-4` مكرّرة في خمسة مواضع، وصارت `divide-y` واحدة. */
  const subscriptionRows = (
    <SettingsGroup>
      {/* Connection status — shown exactly once per agent */}
      <SettingsRow
        label={t('agents.connectionStatus')}
        description={
          <>
            {checking
              ? t('agents.authStatus.checkingAuth')
              : isConnected
              ? (
                <>
                  {t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })}
                  {/* سطرا تجديد الاشتراك وقرب انتهاء الربط — يظهران فقط حين
                      تتوفّر البيانات؛ لا نصّ بديل ولا وميض أثناء التحميل.
                      والتجديدُ أوّلاً: دورةُ الاشتراك سياقٌ دائمٌ يصحّ دوماً،
                      وقربُ انتهاء الربط حالةٌ طارئةٌ تعقبه ثم تزول بتسجيل دخول. */}
                  {(cycleDisplay || linkExpiryDisplay) && (
                    <span className="mt-1.5 flex flex-col items-start sm:flex-row sm:flex-wrap sm:items-center">
                      {cycleDisplay && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Calendar className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                          {/* تجزئة النص عند الحامل لعزل قيمة التاريخ ببـunicode-bidi. */}
                          {(() => {
                            // الحامل من Unicode Private Use Area — لن يظهر في أي ترجمة.
                            const sentinel = '\uE001DATE\uE001';
                            const template = t('agents.authStatus.cycleRenews', {
                              date: sentinel,
                            });
                            const parts = template.split(sentinel);
                            return (
                              <>
                                {parts[0]}
                                <span
                                  className="font-medium text-foreground"
                                  style={{ unicodeBidi: 'isolate' }}
                                >
                                  {formatDisplayDate(cycleDisplay.renewsAt, i18n.language)}
                                </span>
                                {parts[1] ?? ''}
                              </>
                            );
                          })()}
                        </span>
                      )}
                      {/* الفاصل: نقطة وسطى على sm+، كسر سطر على الجوال. */}
                      {cycleDisplay && linkExpiryDisplay && (
                        <span
                          className="mx-1.5 hidden text-muted-foreground/40 sm:inline"
                          aria-hidden
                        >
                          ·
                        </span>
                      )}
                      {linkExpiryDisplay && (
                        <span
                          className={
                            linkExpiryDisplay.tone === 'danger' || linkExpiryDisplay.tone === 'expired'
                              ? 'inline-flex items-center gap-1 font-semibold text-danger'
                              : linkExpiryDisplay.tone === 'warning'
                                ? 'inline-flex items-center gap-1 text-warning'
                                : 'inline-flex items-center gap-1 text-muted-foreground'
                          }
                          title={t('agents.authStatus.linkExpirySource', {
                            when: formatExpiryMoment(
                              linkExpiryDisplay.expiresAt,
                              i18n.language,
                              false,
                              'UTC',
                            ),
                          })}
                        >
                          {/* الساعةُ للخبر والمثلّثُ للإنذار: الفرقُ محمولٌ على
                              الشكل لا على اللون وحده (‏WCAG 1.4.1). */}
                          {linkExpiryDisplay.tone === 'neutral'
                            ? <Clock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                            : <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />}
                          {linkExpiryDisplay.tone === 'expired'
                            ? t('agents.authStatus.linkExpired', {
                                when: formatExpiryMoment(
                                  linkExpiryDisplay.expiresAt,
                                  i18n.language,
                                  false,
                                ),
                              })
                            : linkExpiryDisplay.tone === 'neutral'
                            ? t('agents.authStatus.linkExpiresOn', {
                                when: formatExpiryMoment(
                                  linkExpiryDisplay.expiresAt,
                                  i18n.language,
                                  false,
                                ),
                              })
                            : linkExpiryDisplay.daysLeft === 0
                              ? t('agents.authStatus.linkExpiryToday', {
                                  when: formatExpiryMoment(
                                    linkExpiryDisplay.expiresAt,
                                    i18n.language,
                                    true,
                                  ),
                                })
                              : t('agents.authStatus.linkExpiry', {
                                  count: linkExpiryDisplay.daysLeft,
                                  when: formatExpiryMoment(
                                    linkExpiryDisplay.expiresAt,
                                    i18n.language,
                                    false,
                                  ),
                                })}
                        </span>
                      )}
                    </span>
                  )}
                </>
              )
              : t('agents.authStatus.notConnected')}
            {/* رابط الفوترة — يظهر دائماً بصرف النظر عن حالة الاتصال، أسفل سطرَي التاريخ.
                جميع المزوّدين لديهم رابط فوترة (BILLING_LINKS كامل لا Partial). */}
            {billingHref && (
              <span className="mt-1.5 flex items-center gap-1 text-muted-foreground">
                <ExternalLink
                  className="h-3.5 w-3.5 flex-shrink-0 rtl:-scale-x-100"
                  aria-hidden
                />
                <a
                  href={billingHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('agents.authStatus.billingPage')}
                  <span className="sr-only"> ({t('agents.authStatus.billingPageNewTab')})</span>
                </a>
              </span>
            )}
          </>
        }
      >
        <div className="flex items-center gap-2">
          {statusBadge}
          {userLink && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={userLink.onRecheck}
              disabled={checking}
            >
              <RefreshCw className={checking ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
              <span className="ms-1.5">{t(`${userLink.i18nPrefix}.recheck`)}</span>
            </Button>
          )}
        </div>
      </SettingsRow>

      {showUserLinkBlock && userLink && (
        /* Per-user subscription link (credential isolation, Phase-MU) */
        <div className="space-y-3 py-2.5">
          {/*
              **دعوةٌ إلى فعلٍ ثم نفيٌ للحاجة إليه** — الحشو الذي رصده المالك
              (2026-08-03): «اربط اشتراك Claude لاستخدامه في جلساتك» يليها
              مباشرةً «اعتمادك مربوط تلقائياً بصفتك المالك — لا حاجة لأي إجراء»،
              سطران متجاوران يتناقضان.

              والوصف دعوةٌ بطبيعته («اربط…»)، فلا معنى له إلا لمن **لم يُربَط
              بعد**. فصار مشروطاً بذلك، ولا يجتمع مع ملاحظة المالك أبداً.
          */}
          {!userLink.loading && !userLink.connected && !userLink.incompleteLink && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t(`${userLink.i18nPrefix}.description`)}
            </p>
          )}

          {/* B-1260: ربطٌ ناقص — دعوةٌ صريحة لإعادة الربط الكامل. صندوق نبرة
              تحذير لأنّه حائلٌ فعليٌّ دون عمل الوكيل كاملاً (لا يقرأ الاستخدام،
              وقد ينكسر بلا refresh)، ويحمل زرّ الفعل نفسه. */}
          {showIncompleteLink && (
            <SettingsCard tone="warning">
              <div role="alert" className="space-y-2">
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  {t(`${userLink.i18nPrefix}.incompleteLink`, {
                    defaultValue:
                      'Your Claude link is incomplete — it cannot read usage and may stop working. '
                      + 'Re-link with a full sign-in to finish.',
                  })}
                </p>
                <Button type="button" size="sm" onClick={userLink.onLink}>
                  <Link2 className="h-4 w-4" aria-hidden />
                  <span className="ms-1.5">
                    {t(`${userLink.i18nPrefix}.relinkButton`, { defaultValue: 'Re-link' })}
                  </span>
                </Button>
              </div>
            </SettingsCard>
          )}

          {userLink.error && (
            <SettingsCard tone="danger">
              <p role="alert" className="text-[13px] leading-relaxed text-danger">
                {t(`${userLink.i18nPrefix}.loadError`)}
              </p>
            </SettingsCard>
          )}

          {/* Onboarding banner + CTA — only when not linked (owner is auto-linked) */}
          {/* صندوق نبرة لا سطرٌ ملوّن: هذه ليست ملاحظةً في التدفّق بل الحائل
              الوحيد بين العضو وبين تشغيل الوكيل، وهو يحمل زرّ الفعل نفسه. */}
          {showLinkBanner && (
            <SettingsCard tone="warning">
              <div role="alert" className="space-y-2">
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  {t(`${userLink.i18nPrefix}.banner`)}
                </p>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {t(`${userLink.i18nPrefix}.bannerHint`)}{' '}
                  {/* سطحٌ تقني داخل صفّ (معاينة أمر) — الاستثناء الصريح في §1، لا
                      وعاءَ تجميع. */}
                  <code
                    dir="ltr"
                    style={{ unicodeBidi: 'isolate' }}
                    className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground"
                  >
                    {userLink.command}
                  </code>
                  .
                </p>
                <Button type="button" size="sm" onClick={userLink.onLink}>
                  <Link2 className="h-4 w-4" aria-hidden />
                  <span className="ms-1.5">{t(`${userLink.i18nPrefix}.linkButton`)}</span>
                </Button>
              </div>
            </SettingsCard>
          )}

          {/* ADR-105 — the owner note ("your credential is linked automatically
              as the owner") is gone because the linking is gone. It described the
              symlink channel that put the operator's real credential into every
              owner-role tree (B-486), which is precisely the credential sharing
              this release removes. Leaving the sentence would be worse than a
              stale string: it sat directly under a control reading "Isolated",
              telling the reader their credential is somebody else's. Owners now
              authenticate like everyone else, so the ordinary connect/re-login
              rows above already say everything true. */}
        </div>
      )}

      {showLoginRow && (
        <SettingsRow
          label={authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
          description={
            authStatus.authenticated
              ? t('agents.login.reAuthDescription')
              : t('agents.login.description', { agent: AGENT_DISPLAY_NAMES[agent] })
          }
        >
          {/* زرّ النظام بلا صبغة مورّد: `bg-blue-600 text-white` كانت تفرض
              لوناً خارج اللوحة ونصّاً أبيض لم يُقَس تباينه على أي بريست. */}
          <Button
            type="button"
            onClick={onReauth}
            size="sm"
          >
            <LogIn className="me-2 h-4 w-4 rtl:-scale-x-100" />
            {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
          </Button>
        </SettingsRow>
      )}

      {/* sakana: coming soon, no key available yet (ADR-076). */}
      {agent === 'sakana' && (
        <p className="py-2.5 text-[13px] leading-relaxed text-muted-foreground">
          {t('agents.sakana.comingSoon')}
        </p>
      )}
    </SettingsGroup>
  );

  return (
    /* لا رأس للوكيل هنا: شريط الشعارات في أعلى الصفحة يسمّي المفتوح أصلاً،
       فتكرار الشعار والاسم والوصف تحته كان حشواً (شكوى المالك 2026-10-04). */
    <div className="space-y-4">
      {/* Install banner — shown when the CLI is not installed */}
      {/* صندوق نبرة `warning` (v3 §2.4): «الثنائية غائبة عن الخادم» ليس سطراً
          في تدفّق البطاقة — هو الشرط الذي يجعل كل ما تحته بلا أثر، ويحمل أمراً
          يُنسخ. الإطار هنا يحمل معلومة، وهو ما يميّزه عن الإطار المحظور. */}
      {showInstallBanner && installInfo && (
        <SettingsCard tone="warning">
          <div role="status" className="space-y-2">
          <p className="flex items-start gap-2 text-sm font-medium text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {installInfo.label}
          </p>
          <div className="flex items-center gap-2">
            <code
              dir="ltr"
              style={{ unicodeBidi: 'isolate' }}
              className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-[13px] text-foreground"
            >
              {installInfo.command}
            </code>
            <CopyButton text={installInfo.command} />
          </div>
          {installInfo.note && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">{installInfo.note}</p>
          )}
          </div>
        </SettingsCard>
      )}

      {/*
          **الطريقان متمايزان، وغيرُ المستعمل مطويّ** (شكوى المالك 2026-08-03).

          الوكيل الذي يقبل الطريقين معاً (`credential: 'both'` في سجلّ
          المورّدين) يُعنوَن اشتراكُه باسمه هنا، ويُعنوَن مفتاحُه باسمه في
          `AgentVendorCredentials` تحته — فيُقرأ الاثنان خياراً من اثنين لا
          أربع خطواتٍ متتابعة. وغير المطويّ بلا عنوانٍ لأنّ شريط الوكلاء
          أعلاه يكفي (2026-10-04).

          والمطويّ يبقى **ناطقاً بحالته**: الشارة في سطر الطيّ نفسه، فالطيُّ
          يخفي التحكّم لا المعلومة.
      */}
      {subscriptionFolded ? (
        <SettingsCollapsible
          summary={
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-medium text-foreground">{subscriptionTitle}</span>
              {statusBadge}
            </span>
          }
        >
          {subscriptionRows}
        </SettingsCollapsible>
      ) : (
        subscriptionRows
      )}

      {authStatus.error && (
        <SettingsCard tone="danger">
          <p role="alert" className="text-[13px] leading-relaxed text-danger">
            {t('agents.error', { error: authStatus.error })}
          </p>
        </SettingsCard>
      )}
    </div>
  );
}
