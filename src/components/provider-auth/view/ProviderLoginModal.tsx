import { ExternalLink, Info, KeyRound, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { DEFAULT_PROJECT_FOR_EMPTY_SHELL } from '../../../constants/config';
import type { LLMProvider } from '../../../types/app';

import ProviderLoginTerminal from './ProviderLoginTerminal';
import QwenConnectTerminal from './QwenConnectTerminal';

type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  provider?: LLMProvider;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
  isAuthenticated?: boolean;
};

const getProviderCommand = ({
  provider,
  customCommand,
  isAuthenticated: _isAuthenticated,
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated: boolean;
}) => {
  if (customCommand) {
    return customCommand;
  }

  if (provider === 'claude') {
    // Claude Code removed the interactive `/login` command (unavailable under a
    // PTY with no localhost callback; it drops into onboarding and exits 64).
    // `claude setup-token` is the official replacement: it prints an OAuth link
    // + code in the terminal for the user to complete in their own browser,
    // mirroring the codex --device-auth flow. Must match the allowlist in
    // shell-websocket.service.ts exactly.
    return 'claude setup-token';
  }

  if (provider === 'cursor') {
    return 'cursor-agent login';
  }

  if (provider === 'codex') {
    // nassaj always runs on a remote server — the standard localhost:1455 callback
    // flow can never complete. Use --device-auth unconditionally: it prints a
    // link + device code in the terminal; the user opens the link in their own
    // browser and enters the code without needing localhost.
    return 'codex login --device-auth';
  }

  if (provider === 'opencode') {
    return 'opencode auth login';
  }

  if (provider === 'kimi') {
    // ADR-062: kimi is BOTH an API-key vendor and a native-CLI agent
    // (@moonshot-ai/kimi-code). The CLI's own auth is `kimi login` — a
    // device-code flow (its --help: "Authenticate with Kimi Code CLI via the
    // device-code flow"), which is the only way to link a Kimi SUBSCRIPTION
    // rather than a metered API key. Must match PROVIDER_LOGIN_COMMAND_ALLOWLIST
    // in shell-websocket.service.ts exactly.
    return 'kimi login';
  }

  if (provider === 'hermes') {
    // Bare `hermes` opens the interactive chat REPL, not an auth flow.
    // `hermes setup --portal` runs the one-shot Nous Portal onboarding
    // (OAuth login + pick a model + set Nous as provider) and skips the rest
    // of the wizard, so it does not reconfigure existing terminal/tools setup.
    // `hermes login` is deprecated and intentionally avoided.
    return 'hermes setup --portal';
  }

  if (provider === 'antigravity') {
    return 'agy';
  }

  return `echo "No login command configured for ${provider}"`;
};

/**
 * English fallbacks for the per-agent modal title. Brand and CLI names stay
 * latin in every locale — only the surrounding wording is translated.
 */
const PROVIDER_TITLE_DEFAULTS: Partial<Record<LLMProvider, string>> = {
  claude: 'Claude CLI Login',
  cursor: 'Cursor CLI Login',
  codex: 'Codex CLI Login',
  opencode: 'OpenCode CLI Login',
  kimi: 'Kimi Code CLI Login',
  hermes: 'Hermes Agent',
  antigravity: 'Antigravity (agy) Configuration',
  gemini: 'Gemini CLI Configuration',
  qwen: 'Connect Qwen',
};

/** Latin command/identifier inside a translated sentence — never mirrored. */
const INLINE_CODE_CLASS =
  'rounded bg-amber-100 px-1 font-mono text-xs whitespace-nowrap dark:bg-amber-900/50';

/**
 * أمرٌ لاتيني داخل جملةٍ عربية. **`dir="ltr"` وحده لا يكفي**: خوارزمية الاتجاهين
 * تدمج المقطع في سياق الفقرة ما لم يُعزَل، فينزلق ما يليه من ترقيمٍ إلى الطرف
 * الخطأ — قِيس في هذه الإفادة نفسها: `sk-ant-oat01-` انكسر سطرين ووقعت نقطتُه
 * قبل بقيّته. `unicode-bidi: isolate` يقطع المقطع عن جواره، و`whitespace-nowrap`
 * يمنع كسرَ معرّفٍ يُنسخ حرفياً. (نفس علاج AccountContent، ADR بصري واحد.)
 */
function InlineCode({ children }: { children?: ReactNode }) {
  return (
    <code dir="ltr" style={{ unicodeBidi: 'isolate' }} className={INLINE_CODE_CLASS}>
      {children}
    </code>
  );
}

/**
 * Providers whose CLI login is a DEVICE-CODE flow. nassaj always runs on a
 * remote server, so any localhost-callback login is unusable; these CLIs print a
 * link + a short code the operator opens in their own browser. The banner is
 * rendered above the embedded terminal so the flow is explained before the codes
 * scroll past.
 *
 * `claude` belongs here and its absence was an OVERSIGHT, not an exemption: this
 * map was born in `efa5a0b5e` (2026-07-26) when the Claude command was still the
 * interactive `/login`, and `b1de1d0e7` (2026-09-06) switched it to
 * `claude setup-token` without touching this file. The gap matters more for
 * Claude than for the other two, because `setup-token` does NOT end the flow: it
 * PRINTS a token, shown once, and stores nothing. Nothing in nassaj reads that
 * token out of the PTY — deliberately, since scraping it would turn a passing
 * secret into a retained one, kept in the session buffer and the terminal
 * scrollback. So the notice must name the second step and where to perform it,
 * or the operator closes a terminal that has already destroyed the only copy.
 *
 * An entry may override the banner heading; `title` defaults to
 * "Device Authorization", which is right for a device-code flow and wrong for
 * Claude's print-and-paste one.
 */
const DEVICE_AUTH_NOTICES: Partial<
  Record<LLMProvider, { title?: ReactNode; body: ReactNode[] }>
> = {
  claude: {
    title: (
      <Trans
        ns="settings"
        i18nKey="providerLogin.deviceAuth.claude.title"
        defaults="Two steps: authorize, then paste the token"
      />
    ),
    body: [
      <Trans
        key="intro"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.claude.intro"
        defaults="The terminal below runs <cmd>claude setup-token</cmd>. Follow it to authorize in your own browser — no localhost required. When it finishes it prints a token starting with <cmd>sk-ant-oat01-</cmd>."
        components={{ cmd: <InlineCode /> }}
      />,
      <Trans
        key="paste"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.claude.paste"
        defaults="That token is shown <b>once only</b> and nassaj does not capture it from the terminal. Copy it before closing this dialog, then paste it into the <b>Setup token</b> field on the Claude card behind this dialog (Settings → Agents → Claude → Account) and press Save token."
        components={{ b: <strong /> }}
      />,
    ],
  },
  codex: {
    body: [
      <Trans
        key="intro"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.codex.intro"
        defaults="The terminal below will display a link and a device code. Open the link in your browser and enter the code to authorize Codex — no localhost required."
      />,
      <Trans
        key="retry"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.codex.retry"
        defaults="Enable device code authorization for Codex in ChatGPT Security Settings, then run <cmd>codex login --device-auth</cmd> again."
        components={{ cmd: <InlineCode /> }}
      />,
    ],
  },
  kimi: {
    body: [
      <Trans
        key="intro"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.kimi.intro"
        defaults="The terminal below runs <cmd>kimi login</cmd>, which prints a link and a device code. Open the link in your browser and enter the code to link your Kimi account — no localhost required."
        components={{ cmd: <InlineCode /> }}
      />,
      <Trans
        key="subscription"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.kimi.subscription"
        defaults="This links a Kimi <b>subscription</b>. If you would rather use a metered API key, skip this and set the key in the API-key panel on the account card instead."
        components={{ b: <strong /> }}
      />,
    ],
  },
};

export default function ProviderLoginModal({
  isOpen,
  onClose,
  provider = 'claude',
  onComplete,
  customCommand,
  isAuthenticated = false,
}: ProviderLoginModalProps) {
  const { t } = useTranslation('settings');

  if (!isOpen) {
    return null;
  }

  const command = getProviderCommand({ provider, customCommand, isAuthenticated });
  const titleDefault = PROVIDER_TITLE_DEFAULTS[provider];
  const title = titleDefault
    ? t(`providerLogin.title.${provider}`, { defaultValue: titleDefault })
    : t('providerLogin.title.generic', {
        provider,
        defaultValue: '{{provider}} CLI Configuration',
      });
  const deviceAuthNotice = DEVICE_AUTH_NOTICES[provider];

  const handleComplete = (exitCode: number) => {
    onComplete?.(exitCode);
    // Keep the modal open so users can read terminal output before closing.
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="provider-login-title" className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-card shadow-xl max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 id="provider-login-title" className="text-lg font-semibold text-foreground">{title}</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('providerLogin.close', { defaultValue: 'Close login modal' })}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          {provider === 'qwen' ? (
            <QwenConnectTerminal
              onComplete={handleComplete}
              onClose={onClose}
            />
          ) : deviceAuthNotice ? (
            <div className="flex h-full flex-col">
              <div className="flex-shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/50 dark:bg-amber-900/20">
                <div className="flex gap-3">
                  <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      {deviceAuthNotice.title
                        ?? t('providerLogin.deviceAuth.title', { defaultValue: 'Device Authorization' })}
                    </p>
                    {deviceAuthNotice.body.map((paragraph, index) => (
                      <p
                        // Static, provider-keyed copy: the array never reorders.
                        key={index}
                        className="text-sm text-amber-800 dark:text-amber-200"
                      >
                        {paragraph}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ProviderLoginTerminal
                  project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
                  command={command}
                  provider={provider}
                  onComplete={handleComplete}
                  onClose={onClose}
                />
              </div>
            </div>
          ) : provider === 'gemini' ? (
            <div className="flex h-full flex-col items-center justify-center bg-muted p-8 text-center">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                <KeyRound className="h-8 w-8 text-blue-600 dark:text-blue-400" />
              </div>

              <h4 className="mb-3 text-xl font-medium text-foreground">
                {t('providerLogin.gemini.title', { defaultValue: 'Setup Gemini API Access' })}
              </h4>

              <p className="mb-8 max-w-md text-muted-foreground">
                {t('providerLogin.gemini.description', {
                  defaultValue:
                    'The Gemini CLI requires an API key to function. Configure it in your terminal first.',
                })}
              </p>

              <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 text-start shadow-sm">
                <ol className="space-y-4">
                  <li className="flex gap-4">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-medium text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
                      1
                    </div>
                    <div>
                      <p className="mb-1 text-sm font-medium text-foreground">
                        {t('providerLogin.gemini.step1', { defaultValue: 'Get your API key' })}
                      </p>
                      <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noreferrer"
                        className="flex inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Google AI Studio <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </li>
                  <li className="flex gap-4">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-medium text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
                      2
                    </div>
                    <div>
                      <p className="mb-1 text-sm font-medium text-foreground">
                        {t('providerLogin.gemini.step2', { defaultValue: 'Run configuration' })}
                      </p>
                      <p className="mb-2 text-sm text-muted-foreground">
                        {t('providerLogin.gemini.step2Hint', {
                          defaultValue: 'Open your terminal and run:',
                        })}
                      </p>
                      <code dir="ltr" className="block rounded bg-muted px-3 py-2 font-mono text-sm text-pink-600 dark:text-pink-400">
                        gemini config set api_key YOUR_KEY
                      </code>
                    </div>
                  </li>
                </ol>
              </div>

              <button
                onClick={onClose}
                className="mt-8 rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white transition-colors hover:bg-blue-700"
              >
                {t('providerLogin.gemini.done', { defaultValue: 'Done' })}
              </button>
            </div>
          ) : (
            <ProviderLoginTerminal
              project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
              command={command}
              provider={provider}
              onComplete={handleComplete}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}
