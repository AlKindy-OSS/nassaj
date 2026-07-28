import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { useAuth } from '../../../auth';
import { useBranding } from '../../../../contexts/BrandingContext';
import { api } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

// 48 KB raw → ≤ 64 KB as base64 data-URI (base64 adds ~33% overhead).
const NODE_ICON_MAX_BYTES = 49152;
const NODE_ICON_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

type Feedback = { kind: 'success' | 'error'; message: string } | null;

/**
 * Owner-only branding section inside the Appearance settings tab.
 *
 * Lets the server owner upload a small "node icon" shown next to the nassaj
 * logo in the sidebar — useful for distinguishing different server instances
 * (traventure / alrukhaimi / alkindy …). The icon is stored as a base64
 * data-URI in app_config, so no new static route or server/index.js change is
 * required.
 */
export default function BrandingSettingsSection() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const { nodeIconDataUri, nodeIconPosition, refresh } = useBranding();

  // All hooks must be declared before any conditional return (rules-of-hooks).
  // Pending new icon (not yet saved). null = no change.
  const [pendingDataUri, setPendingDataUri] = useState<string | null>(null);
  // Local position override. null = inherit from context (no change pending).
  const [localPosition, setLocalPosition] = useState<'start' | 'end' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSaving, setIsSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFeedback(null);

    if (!NODE_ICON_ALLOWED_TYPES.includes(file.type)) {
      setFeedback({ kind: 'error', message: t('appearanceSettings.branding.nodeIcon.errors.unsupported') });
      event.target.value = '';
      return;
    }

    if (file.size > NODE_ICON_MAX_BYTES) {
      setFeedback({ kind: 'error', message: t('appearanceSettings.branding.nodeIcon.errors.tooBig') });
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setPendingDataUri(reader.result as string);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }, [t]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const dataUri = pendingDataUri ?? nodeIconDataUri;
      const effectivePosition = localPosition ?? nodeIconPosition;
      const resp = await api.branding.updateNodeIcon(dataUri, effectivePosition);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Failed to save');
      }
      await refresh();
      setPendingDataUri(null);
      setLocalPosition(null);
      setFeedback({ kind: 'success', message: t('appearanceSettings.branding.nodeIcon.success') });
    } catch {
      setFeedback({ kind: 'error', message: t('appearanceSettings.branding.nodeIcon.errors.saveFailed') });
    } finally {
      setIsSaving(false);
    }
  }, [pendingDataUri, nodeIconDataUri, localPosition, nodeIconPosition, refresh, t]);

  const handleClear = useCallback(async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const resp = await api.branding.clearNodeIcon();
      if (!resp.ok) throw new Error();
      await refresh();
      setPendingDataUri(null);
      // Position is intentionally NOT reset — remembered for re-upload.
      setFeedback({ kind: 'success', message: t('appearanceSettings.branding.nodeIcon.cleared') });
    } catch {
      setFeedback({ kind: 'error', message: t('appearanceSettings.branding.nodeIcon.errors.saveFailed') });
    } finally {
      setIsSaving(false);
    }
  }, [refresh, t]);

  // Only owners can manage server-level branding.
  if (user?.role !== 'owner') {
    return null;
  }

  const effectivePosition = localPosition ?? nodeIconPosition;
  const previewUri = pendingDataUri ?? nodeIconDataUri;
  const hasChanges = pendingDataUri !== null || localPosition !== null;

  return (
    <SettingsSection
      title={t('appearanceSettings.branding.title')}
      description={t('appearanceSettings.branding.description')}
    >
      <SettingsCard className="space-y-5 p-4">

        {/* Icon upload row */}
        <div>
          <p className="mb-1 text-sm font-medium text-foreground">
            {t('appearanceSettings.branding.nodeIcon.label')}
          </p>
          <p className="mb-3 text-sm text-muted-foreground">
            {t('appearanceSettings.branding.nodeIcon.description')}
          </p>

          <div className="flex items-center gap-3">
            {/* Preview box */}
            {previewUri && (
              <div
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30"
                aria-hidden="true"
              >
                <img
                  src={previewUri}
                  alt={t('appearanceSettings.branding.nodeIcon.preview')}
                  className="h-7 w-7 rounded-sm object-contain"
                />
              </div>
            )}

            {/* Hidden file input triggered by Upload button */}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={handleFileChange}
              className="sr-only"
              aria-label={t('appearanceSettings.branding.nodeIcon.upload')}
              tabIndex={-1}
            />

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={isSaving}
            >
              {previewUri
                ? t('appearanceSettings.branding.nodeIcon.change')
                : t('appearanceSettings.branding.nodeIcon.upload')}
            </Button>

            {previewUri && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={isSaving}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {isSaving
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : t('appearanceSettings.branding.nodeIcon.clear')}
              </Button>
            )}
          </div>
        </div>

        {/* Position selector */}
        <div>
          <p className="mb-1 text-sm font-medium text-foreground">
            {t('appearanceSettings.branding.nodeIcon.position.label')}
          </p>
          <p className="mb-2 text-sm text-muted-foreground">
            {t('appearanceSettings.branding.nodeIcon.position.description')}
          </p>
          <div className="flex items-center gap-5">
            {(['start', 'end'] as const).map((pos) => (
              <label
                key={pos}
                className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
              >
                <input
                  type="radio"
                  name="node-icon-position"
                  value={pos}
                  checked={effectivePosition === pos}
                  onChange={() => setLocalPosition(pos)}
                  className="h-4 w-4 accent-primary"
                />
                {t(`appearanceSettings.branding.nodeIcon.position.${pos}`)}
              </label>
            ))}
          </div>
        </div>

        {/* Inline feedback */}
        {feedback && (
          <p
            role="status"
            className={cn(
              'text-sm',
              feedback.kind === 'success'
                ? 'text-green-600 dark:text-green-400'
                : 'text-destructive',
            )}
          >
            {feedback.message}
          </p>
        )}

        {/* Save button — only visible when there are pending changes */}
        {hasChanges && (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {isSaving
                ? t('appearanceSettings.branding.nodeIcon.saving')
                : t('appearanceSettings.branding.nodeIcon.save')}
            </Button>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
