import { ExternalLink, Info, KeyRound, X } from 'lucide-react';
import type { ReactNode } from 'react';

import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import { DEFAULT_PROJECT_FOR_EMPTY_SHELL } from '../../../constants/config';
import type { LLMProvider } from '../../../types/app';

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
    return 'claude --dangerously-skip-permissions /login';
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

const getProviderTitle = (provider: LLMProvider) => {
  if (provider === 'claude') return 'Claude CLI Login';
  if (provider === 'cursor') return 'Cursor CLI Login';
  if (provider === 'codex') return 'Codex CLI Login';
  if (provider === 'opencode') return 'OpenCode CLI Login';
  if (provider === 'kimi') return 'Kimi Code CLI Login';
  if (provider === 'hermes') return 'Hermes Agent';
  if (provider === 'antigravity') return 'Antigravity (agy) Configuration';
  if (provider === 'gemini') return 'Gemini CLI Configuration';
  return `${provider} CLI Configuration`;
};

/**
 * Providers whose CLI login is a DEVICE-CODE flow. nassaj always runs on a
 * remote server, so any localhost-callback login is unusable; these CLIs print a
 * link + a short code the operator opens in their own browser. The banner is
 * rendered above the embedded terminal so the flow is explained before the codes
 * scroll past.
 */
const DEVICE_AUTH_NOTICES: Partial<Record<LLMProvider, { title: string; body: ReactNode[] }>> = {
  codex: {
    title: 'Device Authorization',
    body: [
      <>
        The terminal below will display a link and a device code. Open the link in your browser and
        enter the code to authorize Codex — no localhost required.
      </>,
      <>
        Enable device code authorization for Codex in ChatGPT Security Settings, then run{' '}
        <code className="rounded bg-amber-100 px-1 font-mono text-xs dark:bg-amber-900/50">
          codex login --device-auth
        </code>{' '}
        again.
      </>,
    ],
  },
  kimi: {
    title: 'Device Authorization',
    body: [
      <>
        The terminal below runs{' '}
        <code className="rounded bg-amber-100 px-1 font-mono text-xs dark:bg-amber-900/50">
          kimi login
        </code>
        , which prints a link and a device code. Open the link in your browser and enter the code to
        link your Kimi account — no localhost required.
      </>,
      <>
        This links a Kimi <strong>subscription</strong>. If you would rather use a metered API key,
        skip this and set the key in the API-key panel on the account card instead.
      </>,
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
  if (!isOpen) {
    return null;
  }

  const command = getProviderCommand({ provider, customCommand, isAuthenticated });
  const title = getProviderTitle(provider);
  const deviceAuthNotice = DEVICE_AUTH_NOTICES[provider];

  const handleComplete = (exitCode: number) => {
    onComplete?.(exitCode);
    // Keep the modal open so users can read terminal output before closing.
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close login modal"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          {deviceAuthNotice ? (
            <div className="flex h-full flex-col">
              <div className="flex-shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/50 dark:bg-amber-900/20">
                <div className="flex gap-3">
                  <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      {deviceAuthNotice.title}
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
              <div className="flex-1 overflow-hidden">
                <StandaloneShell
                  project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
                  command={command}
                  provider={provider}
                  onComplete={handleComplete}
                  minimal={true}
                />
              </div>
            </div>
          ) : provider === 'gemini' ? (
            <div className="flex h-full flex-col items-center justify-center bg-gray-50 p-8 text-center dark:bg-gray-900/50">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                <KeyRound className="h-8 w-8 text-blue-600 dark:text-blue-400" />
              </div>

              <h4 className="mb-3 text-xl font-medium text-gray-900 dark:text-white">Setup Gemini API Access</h4>

              <p className="mb-8 max-w-md text-gray-600 dark:text-gray-400">
                The Gemini CLI requires an API key to function. Configure it in your terminal first.
              </p>

              <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 text-start shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <ol className="space-y-4">
                  <li className="flex gap-4">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-medium text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
                      1
                    </div>
                    <div>
                      <p className="mb-1 text-sm font-medium text-gray-900 dark:text-white">Get your API key</p>
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
                      <p className="mb-1 text-sm font-medium text-gray-900 dark:text-white">Run configuration</p>
                      <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">Open your terminal and run:</p>
                      <code className="block rounded bg-gray-100 px-3 py-2 font-mono text-sm text-pink-600 dark:bg-gray-900 dark:text-pink-400">
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
                Done
              </button>
            </div>
          ) : (
            <StandaloneShell
              project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
              command={command}
              provider={provider}
              onComplete={handleComplete}
              minimal={true}
            />
          )}
        </div>
      </div>
    </div>
  );
}
