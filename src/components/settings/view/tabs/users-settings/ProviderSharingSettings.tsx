import { useCallback, useState } from 'react';
import { AlertTriangle, Check, Loader2, Lock, Save, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle, Button } from '../../../../../shared/view/ui';
import { cn } from '../../../../../lib/utils';
import {
  SHARING_PROVIDERS,
  useProviderSharing,
  type SharingMode,
  type SharingProvider,
} from '../../../hooks/useProviderSharing';

/** Per-provider accent color used for the leading dot/avatar (decorative). */
const PROVIDER_ACCENT: Record<SharingProvider, string> = {
  claude: 'bg-orange-500',
  gemini: 'bg-blue-500',
  codex: 'bg-emerald-500',
  agy: 'bg-purple-500',
  cursor: 'bg-slate-500',
  kimi: 'bg-rose-500',
  deepseek: 'bg-sky-500',
  glm: 'bg-violet-500',
};

const SHARING_MODES: SharingMode[] = ['shared', 'isolated'];

type FeedbackState = { kind: 'success' | 'error'; message: string } | null;

interface ProviderSharingSettingsProps {
  /** Caller-resolved role; the section renders only for admin/owner. */
  role?: string;
}

/**
 * Admin/owner-only section to choose, per provider, whether credentials are
 * shared across all users or isolated per user. Local edits are batched and
 * committed together via the Save button (C-UI provider sharing).
 */
export default function ProviderSharingSettings({ role }: ProviderSharingSettingsProps) {
  const { t } = useTranslation('settings');
  const isAdmin = role === 'admin' || role === 'owner';

  const { config, loading, saving, error, dirty, updateConfig, saveConfig } =
    useProviderSharing(isAdmin);

  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const handleSave = useCallback(async () => {
    setFeedback(null);
    const result = await saveConfig();
    setFeedback(
      result.success
        ? { kind: 'success', message: t('providerSharing.saveStatus.success') }
        : { kind: 'error', message: result.error || t('providerSharing.saveStatus.error') },
    );
  }, [saveConfig, t]);

  // Render nothing for non-privileged roles; the server enforces the same rule.
  if (!isAdmin) {
    return null;
  }

  return (
    <section aria-labelledby="provider-sharing-heading" className="space-y-4">
      <div>
        <h3
          id="provider-sharing-heading"
          className="text-sm font-medium text-foreground"
        >
          {t('providerSharing.heading')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('providerSharing.subtitle')}
        </p>
      </div>

      {error && !feedback && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {feedback && (
        <Alert variant={feedback.kind === 'error' ? 'destructive' : 'default'}>
          {feedback.kind === 'error' ? <AlertTriangle /> : <Check />}
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('providerSharing.loading')}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {SHARING_PROVIDERS.map((provider) => {
            const mode = config[provider];
            const selectId = `provider-sharing-${provider}`;
            const isAgy = provider === 'agy';
            return (
              <li key={provider} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white',
                        PROVIDER_ACCENT[provider],
                      )}
                    >
                      {mode === 'shared' ? (
                        <Users className="h-4 w-4" />
                      ) : (
                        <Lock className="h-4 w-4" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <span className="block font-medium text-foreground">
                        {t(`providerSharing.providers.${provider}`)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t(`providerSharing.modeDescription.${mode}`)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={selectId}>
                      {t('providerSharing.modeLabel', {
                        provider: t(`providerSharing.providers.${provider}`),
                      })}
                    </label>
                    <select
                      id={selectId}
                      value={mode}
                      disabled={saving}
                      onChange={(event) => {
                        setFeedback(null);
                        updateConfig(provider, event.target.value as SharingMode);
                      }}
                      className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    >
                      {SHARING_MODES.map((value) => (
                        <option key={value} value={value}>
                          {t(`providerSharing.modes.${value}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {isAgy && (
                  <Alert variant="default" className="mt-3 border-amber-300 dark:border-amber-800">
                    <AlertTriangle className="text-amber-600 dark:text-amber-500" />
                    <AlertTitle>{t('providerSharing.agyWarning.title')}</AlertTitle>
                    <AlertDescription>
                      {t('providerSharing.agyWarning.description')}
                    </AlertDescription>
                  </Alert>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving || loading || !dirty}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          <span className="ms-1.5">
            {saving ? t('providerSharing.saving') : t('providerSharing.save')}
          </span>
        </Button>
      </div>
    </section>
  );
}
