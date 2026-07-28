import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Pill, PillBar } from '../../../../../../../shared/view/ui';
import { useProviderApiKey } from '../../../../../../provider-auth/hooks/useProviderApiKey';
import { useProviderApiKeyCapability } from '../../../../../../provider-auth/hooks/useProviderApiKeyCapability';
import {
  PROVIDER_API_KEY_META,
  formatCredentialTargetFallback,
  resolveApiKeyUrl,
} from '../../../../../../provider-auth/providerApiKeyMeta';
import type { LLMProvider } from '../../../../../../../types/app';

type ProviderApiKeySectionProps = {
  provider: LLMProvider;
  /** Refreshes the shared `/auth/status` badge after a key is set/removed. */
  onConfiguredChange?: () => void;
};

/**
 * Generalized, capability-led API-key management panel (T-866/F1). Replaces
 * the old vendor-only (kimi/deepseek/glm) section: it renders for any
 * provider whose live capability descriptor
 * (`GET /:provider/api-key/capability`) reports a write method other than
 * `'none'` — claude/opencode/codex included — and hides itself otherwise, so
 * a backend policy change is reflected without a frontend redeploy.
 *
 * A provider with more than one credential target (opencode:
 * anthropic/openai/openrouter) gets a target selector; the key input, save
 * and remove actions below it operate on whichever target is selected. The
 * backend never returns the stored value — only whether one is configured —
 * so this panel only ever offers set / replace / remove against
 * `/api/providers/:provider/api-key`.
 */
export default function ProviderApiKeySection({ provider, onConfiguredChange }: ProviderApiKeySectionProps) {
  const { t } = useTranslation('settings');
  const { capability, loading: capabilityLoading } = useProviderApiKeyCapability(provider);
  const targets = capability?.targets;

  // Explicit user pick, if any; cleared whenever the provider changes so a
  // manually-chosen target never survives a switch to a different provider.
  const [pickedTarget, setPickedTarget] = useState<string | undefined>(undefined);
  useEffect(() => {
    setPickedTarget(undefined);
  }, [provider]);

  // Falls back to the capability's first target (its implicit default) until
  // the user picks one explicitly — avoids a one-frame flash with no target
  // selected while still reacting instantly once `targets` resolves.
  const effectiveTarget = pickedTarget ?? targets?.[0];

  if (capabilityLoading) {
    return (
      <div className="border-t border-border/50 pt-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{t('agents.apiKey.checkingCapability', { defaultValue: 'Checking key entry support…' })}</span>
        </div>
      </div>
    );
  }

  if (!capability || capability.method === 'none') {
    return null;
  }

  return (
    <ProviderApiKeyFields
      key={`${provider}:${effectiveTarget ?? ''}`}
      provider={provider}
      target={effectiveTarget}
      targets={targets}
      onSelectTarget={setPickedTarget}
      onConfiguredChange={onConfiguredChange}
    />
  );
}

type ProviderApiKeyFieldsProps = {
  provider: LLMProvider;
  target?: string;
  targets?: readonly string[];
  onSelectTarget: (target: string) => void;
  onConfiguredChange?: () => void;
};

/** Target-scoped fields, remounted (via the parent's `key`) whenever the
 *  selected target changes so draft/feedback state never leaks across targets. */
function ProviderApiKeyFields({
  provider,
  target,
  targets,
  onSelectTarget,
  onConfiguredChange,
}: ProviderApiKeyFieldsProps) {
  const { t } = useTranslation('settings');
  const meta = PROVIDER_API_KEY_META[provider];
  const providerName = meta?.name ?? provider;
  const apiKeyUrl = resolveApiKeyUrl(provider, target);
  const { configured, loading, saving, error, saveKey, deleteKey } = useProviderApiKey(provider, target);

  const [draftKey, setDraftKey] = useState('');
  const [localFeedback, setLocalFeedback] = useState<string | null>(null);

  const inputId = `provider-api-key-${provider}${target ? `-${target}` : ''}`;

  const handleSave = async () => {
    setLocalFeedback(null);
    const result = await saveKey(draftKey);
    if (result.success) {
      setDraftKey('');
      setLocalFeedback(t('agents.apiKey.saved', { defaultValue: 'API key saved.' }));
      onConfiguredChange?.();
    }
  };

  const handleDelete = async () => {
    setLocalFeedback(null);
    const result = await deleteKey();
    if (result.success) {
      setLocalFeedback(t('agents.apiKey.removed', { defaultValue: 'API key removed.' }));
      onConfiguredChange?.();
    }
  };

  return (
    <div className="border-t border-border/50 pt-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        <span>
          {configured
            ? t('agents.apiKey.replaceTitle', { defaultValue: 'Replace API key' })
            : t('agents.apiKey.title', { defaultValue: 'Add API key' })}
        </span>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        {t('agents.apiKey.description', {
          provider: providerName,
          defaultValue:
            'Paste a {{provider}} API key to enable this provider. It is stored encrypted and never shown again.',
        })}
        {apiKeyUrl && (
          <>
            {' '}
            <a
              href={apiKeyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('agents.apiKey.getKey', { defaultValue: 'Get a key' })}
              <ExternalLink className="h-3 w-3" />
            </a>
          </>
        )}
      </p>

      {targets && targets.length > 1 && (
        <div className="mb-3">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t('agents.apiKey.targetLabel', { defaultValue: 'Credential target' })}
          </span>
          <PillBar>
            {targets.map((candidateTarget) => (
              <Pill
                key={candidateTarget}
                isActive={candidateTarget === target}
                onClick={() => onSelectTarget(candidateTarget)}
              >
                {t(`agents.apiKey.targets.${candidateTarget}`, {
                  defaultValue: formatCredentialTargetFallback(candidateTarget),
                })}
              </Pill>
            ))}
          </PillBar>
        </div>
      )}

      <label className="sr-only" htmlFor={inputId}>
        {t('agents.apiKey.inputLabel', {
          provider: providerName,
          defaultValue: '{{provider}} API key',
        })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draftKey}
          disabled={saving || loading}
          onChange={(event) => setDraftKey(event.target.value)}
          placeholder={
            configured
              ? t('agents.apiKey.placeholderConfigured', { defaultValue: '•••••••• (configured)' })
              : t('agents.apiKey.placeholder', { defaultValue: 'Paste API key' })
          }
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <Button size="sm" onClick={handleSave} disabled={saving || loading || draftKey.trim().length === 0}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          <span className="ms-1.5">{t('agents.apiKey.save', { defaultValue: 'Save' })}</span>
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleDelete}
            disabled={saving || loading}
            className="text-red-600 hover:text-red-700 dark:text-red-400"
          >
            <Trash2 className="h-4 w-4" />
            <span className="ms-1.5">{t('agents.apiKey.remove', { defaultValue: 'Remove' })}</span>
          </Button>
        )}
      </div>

      <div className="mt-2 min-h-5 text-sm" aria-live="polite">
        {error ? (
          <span className="text-red-600 dark:text-red-400">{error}</span>
        ) : localFeedback ? (
          <span className="text-green-600 dark:text-green-400">{localFeedback}</span>
        ) : configured ? (
          <span className="text-muted-foreground">
            {t('agents.apiKey.configuredNote', { defaultValue: 'An API key is configured.' })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
