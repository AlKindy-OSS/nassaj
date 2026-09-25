import { Info, X } from 'lucide-react';
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
    // B-1260: FULL OAuth is the default link. `claude setup-token` mints an
    // INFERENCE-ONLY token (consent shows two lines; no usage/profile), so it
    // linked an account that never fully worked. `claude auth login` mints
    // access + refresh with full scopes and, when no localhost callback exists
    // (nassaj is remote), prints an authorize URL and a "Paste code here if
    // prompted >" prompt — verified in the bundled CLI 2.1.273 — so it completes
    // headless. The CLI writes .credentials.json itself; no token is pasted into
    // nassaj. Must match PROVIDER_LOGIN_COMMAND_ALLOWLIST in
    // shell-websocket.service.ts exactly. (setup-token stays as the API-panel
    // fallback there, not here.)
    return 'claude auth login';
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
 * `claude` belongs here. B-1260: the command is now `claude auth login` (FULL
 * OAuth), not `claude setup-token` (inference-only). auth login prints an
 * authorize URL and, when no localhost callback exists (nassaj is remote), a
 * "Paste code here if prompted >" prompt: the operator authorizes in their own
 * browser, copies the code, and pastes it straight BACK INTO THIS TERMINAL. The
 * CLI then writes the credential itself — there is no separate "copy the token
 * into a card" step anymore, so the notice names the in-terminal paste, not a
 * second field.
 *
 * An entry may override the banner heading; `title` defaults to
 * "Device Authorization", which is right for a device-code flow and wrong for
 * Claude's authorize-and-paste-back one.
 */
const DEVICE_AUTH_NOTICES: Partial<
  Record<LLMProvider, { title?: ReactNode; body: ReactNode[] }>
> = {
  claude: {
    title: (
      <Trans
        ns="settings"
        i18nKey="providerLogin.deviceAuth.claude.title"
        defaults="Two steps: authorize, then paste the code into the terminal"
      />
    ),
    body: [
      <Trans
        key="intro"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.claude.intro"
        defaults="The terminal below runs <cmd>claude auth login</cmd>. It prints a sign-in link — open it in your own browser and authorize (no localhost required). This links your full Claude subscription, not an inference-only token."
        components={{ cmd: <InlineCode /> }}
      />,
      <Trans
        key="paste"
        ns="settings"
        i18nKey="providerLogin.deviceAuth.claude.paste"
        defaults="After you authorize, the browser shows a code. Copy it and paste it back <b>into this terminal</b> at the <cmd>Paste code here</cmd> prompt, then press Enter. nassaj stores nothing itself — the Claude CLI saves the credential. When it finishes, the account card behind this dialog shows the new state."
        components={{ b: <strong />, cmd: <InlineCode /> }}
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
