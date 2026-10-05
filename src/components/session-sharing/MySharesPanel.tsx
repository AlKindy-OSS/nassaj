import { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOptionalAuth } from '../auth/context/AuthContext';
import SettingsSection from '../settings/view/SettingsSection';

import ShareList from './ShareList';
import { listMyShares, shareErrorKey, type ShareSummary } from './sessionShareApi';

/** "روابطي المشتركة": every share link the user created or owns, with revoke. */
export default function MySharesPanel() {
  const { t } = useTranslation('chat');
  const auth = useOptionalAuth();
  const hasBearer = Boolean(auth?.token);
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setShares((await listMyShares()).shares);
    } catch (caught) {
      setShares(null);
      setError(shareErrorKey(caught));
    }
  }, []);

  useEffect(() => {
    if (hasBearer) void load();
  }, [hasBearer, load]);

  return (
    <SettingsSection title={t('sessionShare.panel.title')} description={t('sessionShare.panel.description')} icon={Link2}>
      {!hasBearer && <p role="status" className="text-sm text-muted-foreground">{t('sessionShare.panel.unavailable')}</p>}
      {hasBearer && error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-danger">{t(`sessionShare.errors.${error}`)}</p>
          <button type="button" className="min-h-9 rounded-md border border-input px-3 text-sm" onClick={() => void load()}>
            {t('sessionShare.retry')}
          </button>
        </div>
      )}
      {hasBearer && !error && shares === null && (
        <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> {t('sessionShare.loading')}
        </p>
      )}
      {hasBearer && shares !== null && (
        <ShareList
          shares={shares}
          onRevoked={(id) => setShares((current) => current?.map((item) => (
            item.id === id ? { ...item, revokedAt: new Date().toISOString(), active: false } : item)) ?? null)}
        />
      )}
    </SettingsSection>
  );
}
