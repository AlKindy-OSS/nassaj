import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { revokeShare, shareErrorKey, type ShareSummary } from './sessionShareApi';

type ShareListProps = {
  shares: ShareSummary[];
  onRevoked: (shareId: string) => void;
};

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function statusOf(share: ShareSummary): 'active' | 'expired' | 'revoked' {
  if (share.revokedAt) return 'revoked';
  return share.active ? 'active' : 'expired';
}

function ShareRow({ share, onRevoked }: Omit<ShareListProps, 'shares'> & { share: ShareSummary }) {
  const { t, i18n } = useTranslation('chat');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = statusOf(share);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await revokeShare(share.id);
      onRevoked(share.id);
    } catch (caught) {
      setError(shareErrorKey(caught));
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {share.sessionTitle ? <bdi>{share.sessionTitle}</bdi> : (
            <>{t('sessionShare.list.session')} <bdi dir="ltr" className="font-mono text-xs">{share.sessionId.split('-', 1)[0]}</bdi></>
          )}
        </span>
        <span
          data-status={status}
          className={status === 'active'
            ? 'rounded-full bg-success/15 px-2 py-0.5 text-xs text-success'
            : 'rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground'}
        >
          {t(`sessionShare.list.status.${status}`)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <div><dt>{t('sessionShare.list.created')}</dt><dd className="text-foreground">{formatDate(share.createdAt, i18n.language)}</dd></div>
        <div><dt>{t('sessionShare.list.expires')}</dt><dd className="text-foreground">{formatDate(share.expiresAt, i18n.language)}</dd></div>
        <div><dt>{t('sessionShare.list.views')}</dt><dd className="text-foreground">{share.viewCount.toLocaleString(i18n.language)}</dd></div>
        <div><dt>{t('sessionShare.list.messages')}</dt><dd className="text-foreground">{share.messageCount.toLocaleString(i18n.language)}</dd></div>
      </dl>
      {!share.createdBySelf && (
        <p className="text-xs text-muted-foreground">{t('sessionShare.list.createdBy', { name: share.createdByName })}</p>
      )}
      {error && <p role="alert" className="text-xs text-danger">{t(`sessionShare.errors.${error}`)}</p>}
      {status === 'active' && (
        <div className="flex flex-wrap gap-2">
          {confirming ? (
            <>
              <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void revoke()}>
                {busy ? t('sessionShare.list.revoking') : t('sessionShare.list.revokeConfirm')}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                {t('sessionShare.list.revokeCancel')}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
              {t('sessionShare.list.revoke')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Existing share links; the token/URL is never available here (shown once at creation). */
export default function ShareList({ shares, onRevoked }: ShareListProps) {
  const { t } = useTranslation('chat');
  if (shares.length === 0) return <p className="text-sm text-muted-foreground">{t('sessionShare.list.empty')}</p>;
  return (
    <ul className="space-y-2">
      {shares.map((share) => (
        <ShareRow key={share.id} share={share} onRevoked={onRevoked} />
      ))}
    </ul>
  );
}
