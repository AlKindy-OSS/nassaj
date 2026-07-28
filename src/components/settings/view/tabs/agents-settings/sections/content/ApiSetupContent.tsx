import { Check, Copy, ExternalLink, Terminal } from 'lucide-react';
import { useState } from 'react';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider } from '../../../../../types/types';

type ApiProviderInfo =
  | {
      kind: 'api';
      name: string;
      platform: string;
      platformUrl: string;
      endpoint: string;
      defaultModel: string;
      note: string;
    }
  | {
      kind: 'cli';
      name: string;
      platform: string;
      platformUrl: string;
      installCommand: string;
      note: string;
    }
  | {
      kind: 'coming-soon';
      name: string;
      platform: string;
      platformUrl: string;
      note: string;
    };

// deepseek and glm are removed — their API key is entered directly in the
// Account tab via ProviderApiKeySection (ADR-076 §3, T-1033 Wave 1a).
// hermes is removed — it has no setup tab (not in API_ONLY_PROVIDERS).
const API_PROVIDER_INFO: Partial<Record<AgentProvider, ApiProviderInfo>> = {
  sakana: {
    kind: 'coming-soon',
    name: 'Sakana AI',
    platform: 'sakana.ai',
    platformUrl: 'https://sakana.ai',
    note: 'Sakana AI models do not have a public API compatible with Claude Code yet.',
  },
};

/** Inline copy button: icon toggles to checkmark for 1 second after click. */
function CopyButton({ text, className }: { text: string; className?: string }) {
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
      className={className ?? 'flex-shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'}
    >
      {copied
        ? <Check className="h-4 w-4" aria-hidden />
        : <Copy className="h-4 w-4" aria-hidden />}
    </button>
  );
}

type ApiSetupContentProps = {
  agent: AgentProvider;
};

export default function ApiSetupContent({ agent }: ApiSetupContentProps) {
  const info = API_PROVIDER_INFO[agent];

  if (!info) return null;

  const subtitle =
    info.kind === 'api'
      ? 'API-based provider — no CLI installation needed'
      : info.kind === 'cli'
        ? 'CLI agent — install on the server to activate'
        : 'Not available yet';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <SessionProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{info.name}</h3>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      {/* API providers: ANTHROPIC_BASE_URL mechanism */}
      {info.kind === 'api' && (
        <>
          <section aria-labelledby="how-it-works-heading">
            <h4 id="how-it-works-heading" className="mb-3 text-sm font-medium text-foreground">
              How it works
            </h4>
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Claude Code supports Anthropic-compatible API endpoints. These providers work by
                setting two environment variables:
              </p>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
                    {`ANTHROPIC_BASE_URL=${info.endpoint}`}
                  </code>
                  <CopyButton text={`ANTHROPIC_BASE_URL=${info.endpoint}`} />
                </div>
                <div className="flex items-center gap-2">
                  <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground">
                    ANTHROPIC_API_KEY=&lt;your-api-key&gt;
                  </code>
                </div>
              </div>
            </div>
          </section>

          <section aria-labelledby="setup-steps-heading">
            <h4 id="setup-steps-heading" className="mb-3 text-sm font-medium text-foreground">
              Setup steps
            </h4>
            <ol className="space-y-3" aria-label="Setup steps">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  1
                </span>
                <span className="text-sm text-muted-foreground pt-0.5">
                  Get an API key from{' '}
                  <a
                    href={info.platformUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                  >
                    {info.platform}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  2
                </span>
                <span className="text-sm text-muted-foreground pt-0.5">
                  Add the variables to{' '}
                  <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    ~/.nassaj/envs/{agent}.env
                  </code>
                </span>
              </li>
            </ol>
          </section>

          <section aria-labelledby="cli-test-heading">
            <h4 id="cli-test-heading" className="mb-3 text-sm font-medium text-foreground">
              Quick CLI test
            </h4>
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
              <p className="text-sm text-muted-foreground">
                Try the provider immediately from your terminal:
              </p>
              <div className="flex items-center gap-2">
                <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground break-all">
                  {`ANTHROPIC_BASE_URL=${info.endpoint} ANTHROPIC_API_KEY=sk-... claude`}
                </code>
                <CopyButton text={`ANTHROPIC_BASE_URL=${info.endpoint} ANTHROPIC_API_KEY=sk-... claude`} />
              </div>
            </div>
          </section>

          <p className="text-xs text-muted-foreground">{info.note}</p>
        </>
      )}

      {/* CLI providers: install script */}
      {info.kind === 'cli' && (
        <>
          <section aria-labelledby="install-heading">
            <h4 id="install-heading" className="mb-3 text-sm font-medium text-foreground">
              Installation
            </h4>
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Terminal className="h-4 w-4 flex-shrink-0" aria-hidden />
                <span>Run this command on the nassaj server:</span>
              </div>
              <div className="flex items-center gap-2">
                <code dir="ltr" className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground break-all">
                  {info.installCommand}
                </code>
                <CopyButton text={info.installCommand} />
              </div>
            </div>
          </section>

          <section aria-labelledby="cli-setup-steps-heading">
            <h4 id="cli-setup-steps-heading" className="mb-3 text-sm font-medium text-foreground">
              After installation
            </h4>
            <ol className="space-y-3" aria-label="After installation steps">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  1
                </span>
                <span className="text-sm text-muted-foreground pt-0.5">
                  Get your API key or credentials from{' '}
                  <a
                    href={info.platformUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                  >
                    {info.platform}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  2
                </span>
                <span className="text-sm text-muted-foreground pt-0.5">
                  Run the auth command from the terminal after installation completes.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  3
                </span>
                <span className="text-sm text-muted-foreground pt-0.5">
                  Restart nassaj-dev — the Account tab will show the connection status.
                </span>
              </li>
            </ol>
          </section>

          <p className="text-xs text-muted-foreground">{info.note}</p>
        </>
      )}

      {/* Coming soon */}
      {info.kind === 'coming-soon' && (
        <div
          role="status"
          className="rounded-lg border border-border bg-muted/30 p-4 space-y-2"
        >
          <p className="text-sm font-medium text-foreground">Coming Soon</p>
          <p className="text-sm text-muted-foreground">{info.note}</p>
          <a
            href={info.platformUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
          >
            {info.platform}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>
      )}
    </div>
  );
}
