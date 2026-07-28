import { Check, Copy, Link2, LogIn, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button } from '../../../../../../../shared/view/ui';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import { isApiKeyCandidateProvider } from '../../../../../../provider-auth/providerApiKeyMeta';
import type { AgentProvider, AuthStatus } from '../../../../../types/types';
import ProviderApiKeySection from './ProviderApiKeySection';

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
  /** Owner is symbolically linked by the backend; never forced to onboard. */
  isOwner: boolean;
  /** i18n prefix of the subscription-link texts in the settings namespace. */
  i18nPrefix: 'claudeConnection' | 'agyConnection';
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

type AgentVisualConfig = {
  name: string;
  bgClass: string;
  borderClass: string;
  textClass: string;
  subtextClass: string;
  buttonClass: string;
  description?: string;
};

const agentConfig: Record<AgentProvider, AgentVisualConfig> = {
  claude: {
    name: 'Claude',
    bgClass: 'bg-blue-50 dark:bg-blue-900/20',
    borderClass: 'border-blue-200 dark:border-blue-800',
    textClass: 'text-blue-900 dark:text-blue-100',
    subtextClass: 'text-blue-700 dark:text-blue-300',
    buttonClass: 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800',
  },
  cursor: {
    name: 'Cursor',
    bgClass: 'bg-purple-50 dark:bg-purple-900/20',
    borderClass: 'border-purple-200 dark:border-purple-800',
    textClass: 'text-purple-900 dark:text-purple-100',
    subtextClass: 'text-purple-700 dark:text-purple-300',
    buttonClass: 'bg-purple-600 hover:bg-purple-700 active:bg-purple-800',
  },
  codex: {
    name: 'Codex',
    bgClass: 'bg-muted/50',
    borderClass: 'border-gray-300 dark:border-gray-600',
    textClass: 'text-gray-900 dark:text-gray-100',
    subtextClass: 'text-gray-700 dark:text-gray-300',
    buttonClass: 'bg-gray-800 hover:bg-gray-900 active:bg-gray-950 dark:bg-gray-700 dark:hover:bg-gray-600 dark:active:bg-gray-500',
  },
  gemini: {
    name: 'Gemini',
    description: 'Google Gemini AI assistant',
    bgClass: 'bg-indigo-50 dark:bg-indigo-900/20',
    borderClass: 'border-indigo-200 dark:border-indigo-800',
    textClass: 'text-indigo-900 dark:text-indigo-100',
    subtextClass: 'text-indigo-700 dark:text-indigo-300',
    buttonClass: 'bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800',
  },
  antigravity: {
    name: 'Antigravity (agy)',
    description: 'Google AI Pro via the agy CLI',
    bgClass: 'bg-emerald-50 dark:bg-emerald-900/20',
    borderClass: 'border-emerald-200 dark:border-emerald-800',
    textClass: 'text-emerald-900 dark:text-emerald-100',
    subtextClass: 'text-emerald-700 dark:text-emerald-300',
    buttonClass: 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800',
  },
  opencode: {
    name: 'OpenCode',
    description: 'OpenCode CLI assistant',
    bgClass: 'bg-zinc-50 dark:bg-zinc-900/20',
    borderClass: 'border-zinc-200 dark:border-zinc-700',
    textClass: 'text-zinc-900 dark:text-zinc-100',
    subtextClass: 'text-zinc-700 dark:text-zinc-300',
    buttonClass: 'bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-950 dark:bg-zinc-700 dark:hover:bg-zinc-600',
  },
  kimi: {
    name: 'Kimi',
    description: 'Moonshot Kimi — native CLI (device-code login) or API key',
    bgClass: 'bg-rose-50 dark:bg-rose-900/20',
    borderClass: 'border-rose-200 dark:border-rose-800',
    textClass: 'text-rose-900 dark:text-rose-100',
    subtextClass: 'text-rose-700 dark:text-rose-300',
    buttonClass: 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800',
  },
  deepseek: {
    name: 'DeepSeek',
    description: 'DeepSeek via API key',
    bgClass: 'bg-sky-50 dark:bg-sky-900/20',
    borderClass: 'border-sky-200 dark:border-sky-800',
    textClass: 'text-sky-900 dark:text-sky-100',
    subtextClass: 'text-sky-700 dark:text-sky-300',
    buttonClass: 'bg-sky-600 hover:bg-sky-700 active:bg-sky-800',
  },
  glm: {
    name: 'GLM',
    description: 'Zhipu / Z.ai GLM via API key',
    bgClass: 'bg-violet-50 dark:bg-violet-900/20',
    borderClass: 'border-violet-200 dark:border-violet-800',
    textClass: 'text-violet-900 dark:text-violet-100',
    subtextClass: 'text-violet-700 dark:text-violet-300',
    buttonClass: 'bg-violet-600 hover:bg-violet-700 active:bg-violet-800',
  },
  hermes: {
    name: 'Hermes',
    description: 'Hermes assistant',
    bgClass: 'bg-violet-50 dark:bg-violet-900/20',
    borderClass: 'border-violet-200 dark:border-violet-800',
    textClass: 'text-violet-900 dark:text-violet-100',
    subtextClass: 'text-violet-700 dark:text-violet-300',
    buttonClass: 'bg-violet-600 hover:bg-violet-700 active:bg-violet-800',
  },
  sakana: {
    name: 'Sakana',
    description: 'Sakana assistant',
    bgClass: 'bg-teal-50 dark:bg-teal-900/20',
    borderClass: 'border-teal-200 dark:border-teal-800',
    textClass: 'text-teal-900 dark:text-teal-100',
    subtextClass: 'text-teal-700 dark:text-teal-300',
    buttonClass: 'bg-teal-500 hover:bg-teal-600 active:bg-teal-700',
  },
};

const INSTALL_INFO: Partial<Record<AgentProvider, { label: string; command: string; note?: string }>> = {
  cursor: {
    label: 'Cursor Agent is not installed',
    command: '# Install Cursor IDE from cursor.com',
    note: 'cursor-agent ships with Cursor IDE — there is no standalone npm package.',
  },
  codex: {
    label: 'Codex CLI is not installed',
    command: 'npm install -g @openai/codex',
  },
  opencode: {
    label: 'OpenCode CLI is not installed',
    command: 'curl -fsSL https://opencode.ai/install | bash',
    note: 'Or via npm: npm install -g opencode-ai',
  },
  hermes: {
    label: 'Hermes Agent is not installed',
    command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
  },
  kimi: {
    label: 'Kimi Code CLI is not installed',
    command: 'npm install -g @moonshot-ai/kimi-code',
    note: 'Only the native CLI needs installing — the API-key path is pure HTTP.',
  },
};

/**
 * Pure API providers (no CLI, no login modal — configure via the API-key panel).
 *
 * `kimi` is deliberately NOT here (ADR-062): unlike the other hosted vendors it
 * ALSO ships a native CLI (`@moonshot-ai/kimi-code`) with its own device-code
 * login, which is the only way to link a Kimi SUBSCRIPTION instead of a metered
 * API key. While it was listed here the account card hid the login row, so there
 * was no route in the whole UI to open a Kimi terminal and complete that login.
 * `glm` stays: it has no binary of its own — the carrier is OpenCode (GL-1), so
 * its key is written into opencode's auth.json and its "terminal" is OpenCode's.
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
      className="flex-shrink-0 rounded p-1.5 text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-800/30"
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
 * glm, T-866/F1) render `ProviderApiKeySection` alongside whatever else the
 * agent shows — it is capability-led (a live `/:provider/api-key/capability`
 * check) and independent of the CLI-login row / subscription-link block, so a
 * provider can offer both an API key AND an interactive CLI login (opencode,
 * codex, kimi) or both an API key AND the per-user subscription link (claude).
 * deepseek / glm have no CLI login at all — the API-key panel is their only
 * connection path (ADR-036 / ADR-030). kimi is the exception among the hosted
 * vendors: it ships the native `@moonshot-ai/kimi-code` CLI (ADR-062), so it
 * gets BOTH the API-key panel and the device-code login row.
 */
export default function AccountContent({ agent, authStatus, onLogin, userLink, onRefreshAuthStatus }: AccountContentProps) {
  const { t } = useTranslation('settings');
  const config = agentConfig[agent];
  const isAntigravity = agent === 'antigravity';

  const checking = authStatus.loading || Boolean(userLink?.loading);
  const isConnected = authStatus.authenticated || Boolean(userLink?.connected);
  const showLinkBanner = Boolean(
    userLink && !userLink.loading && !userLink.connected && !userLink.isOwner,
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
  // API-only providers (deepseek/glm/sakana) have no CLI login flow — hide the
  // login row entirely and let the API-key panel handle configuration.
  const showLoginRow =
    !isPureApiProvider && Boolean(onReauth) && !apiKeyHidesLoginRow && !showLinkBanner;

  const installInfo = INSTALL_INFO[agent];
  const showInstallBanner = authStatus.installed === false && Boolean(installInfo);

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <SessionProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{config.name}</h3>
          <p className="text-sm text-muted-foreground">
            {t(`agents.account.${agent}.description`, {
              defaultValue: config.description || `${config.name} CLI assistant`,
            })}
          </p>
        </div>
      </div>

      {/* Install banner — shown when the CLI is not installed */}
      {showInstallBanner && installInfo && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/15 p-4 space-y-3">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            {installInfo.label}
          </p>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {installInfo.command}
            </code>
            <CopyButton text={installInfo.command} />
          </div>
          {installInfo.note && (
            <p className="text-xs text-amber-700 dark:text-amber-400">{installInfo.note}</p>
          )}
        </div>
      )}

      <div className={`${config.bgClass} border ${config.borderClass} rounded-lg p-4`}>
        <div className="space-y-4">
          {/* Connection status — shown exactly once per agent */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className={`font-medium ${config.textClass}`}>
                {t('agents.connectionStatus')}
              </div>
              <div className={`text-sm ${config.subtextClass}`}>
                {checking ? (
                  t('agents.authStatus.checkingAuth')
                ) : isConnected ? (
                  t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                ) : (
                  t('agents.authStatus.notConnected')
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {checking ? (
                <Badge variant="secondary" className="bg-muted">
                  {t('agents.authStatus.checking')}
                </Badge>
              ) : isConnected ? (
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                  {t('agents.authStatus.connected')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
                  {t('agents.authStatus.disconnected')}
                </Badge>
              )}
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
          </div>

          {/* Capability-led API-key entry (T-866/F1) — hides itself for a
              provider whose live capability is 'none'; independent of the
              subscription-link block below so a provider can offer both. */}
          {isApiKeyCandidateProvider(agent) && (
            <ProviderApiKeySection provider={agent} onConfiguredChange={onRefreshAuthStatus} />
          )}

          {userLink && (
            /* Per-user subscription link (credential isolation, Phase-MU) */
            <div className="space-y-3 border-t border-border/50 pt-4">
              <p className={`text-sm ${config.subtextClass}`}>
                {t(`${userLink.i18nPrefix}.description`)}
              </p>

              {userLink.error && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {t(`${userLink.i18nPrefix}.loadError`)}
                </p>
              )}

              {/* Onboarding banner + CTA — only when not linked (owner is auto-linked) */}
              {showLinkBanner && (
                <div
                  role="alert"
                  className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/15"
                >
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    {t(`${userLink.i18nPrefix}.banner`)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t(`${userLink.i18nPrefix}.bannerHint`)}{' '}
                    <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {userLink.command}
                    </code>
                    .
                  </p>
                  <Button type="button" size="sm" onClick={userLink.onLink}>
                    <Link2 className="h-4 w-4" aria-hidden />
                    <span className="ms-1.5">{t(`${userLink.i18nPrefix}.linkButton`)}</span>
                  </Button>
                </div>
              )}

              {/* Owner note: linked automatically, no action required */}
              {!userLink.loading && userLink.isOwner && userLink.connected && (
                <p className="text-sm text-muted-foreground">
                  {t(`${userLink.i18nPrefix}.ownerNote`)}
                </p>
              )}
            </div>
          )}

          {showLoginRow && (
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className={`font-medium ${config.textClass}`}>
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className={`text-sm ${config.subtextClass}`}>
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: config.name })}
                  </div>
                </div>
                <Button
                  onClick={onReauth}
                  className={`${config.buttonClass} text-white`}
                  size="sm"
                >
                  <LogIn className="me-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {isAntigravity && (
            <div className="border-t border-border/50 pt-4">
              <p className={`text-xs ${config.subtextClass}`}>
                {t('agents.antigravity.modelNote', {
                  defaultValue:
                    'Uses Google AI Pro via agy CLI (v1.x). The active model is selected inside agy settings, not from this UI.',
                })}
              </p>
            </div>
          )}

          {/* deepseek/glm: key entry is already in ProviderApiKeySection above — no
              extra message needed. sakana: coming soon, no key available yet (ADR-076). */}
          {agent === 'sakana' && (
            <div className="border-t border-border/50 pt-4">
              <p className="text-sm text-muted-foreground">
                This provider is coming soon — no API key is available yet.
              </p>
            </div>
          )}

          {authStatus.error && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-sm text-red-600 dark:text-red-400">
                {t('agents.error', { error: authStatus.error })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
