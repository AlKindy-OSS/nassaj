import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { Dialog, DialogContent } from '../../shared/view/ui/Dialog';

import ShareList from './ShareList';
import {
  SHARE_EXPIRIES, announceSharesChanged, createShare, listSessionShares, shareErrorKey,
  type ShareExpiry, type ShareSummary,
} from './sessionShareApi';

const DISCLOSURE_KEYS = ['liveAccess', 'future', 'secrets', 'binary', 'history', 'attachments'] as const;

type Props = { sessionId: string; canShare: boolean; open: boolean; onOpenChange: (open: boolean) => void };

function CreatedLink({ url }: { url: string }) {
  const { t } = useTranslation('chat');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <section className="space-y-3" aria-labelledby="share-created-title">
      <h3 id="share-created-title" className="text-base font-semibold text-foreground">{t('sessionShare.created.title')}</h3>
      <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
        {t('sessionShare.created.once')}
      </p>
      <label htmlFor="share-created-url" className="block text-sm text-muted-foreground">{t('sessionShare.created.linkLabel')}</label>
      <input
        id="share-created-url" readOnly dir="ltr" value={url} onFocus={(event) => event.currentTarget.select()}
        className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button type="button" onClick={() => void doCopy()}>
        {copy === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copy === 'copied' ? t('sessionShare.created.copied') : t('sessionShare.created.copy')}
      </Button>
      {copy === 'failed' && <p role="status" className="text-sm text-danger">{t('sessionShare.created.copyFailed')}</p>}
    </section>
  );
}

function CreateForm({ canShare, expiry, onExpiry, submitting, error, onSubmit }: {
  canShare: boolean; expiry: ShareExpiry; onExpiry: (value: ShareExpiry) => void;
  submitting: boolean; error: string | null; onSubmit: () => void;
}) {
  const { t } = useTranslation('chat');
  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground">{t('sessionShare.intro')}</p>
      <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
        {DISCLOSURE_KEYS.map((key) => <li key={key}>{t(`sessionShare.disclosure.${key}`)}</li>)}
      </ul>
      {canShare ? (
        <div className="space-y-3">
          <div>
            <label htmlFor="share-expiry" className="mb-1 block text-sm text-muted-foreground">{t('sessionShare.expiryLabel')}</label>
            <select id="share-expiry" value={expiry} onChange={(event) => onExpiry(event.target.value as ShareExpiry)}
              className="h-11 w-full rounded-md border border-input bg-background pe-8 ps-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto">
              {SHARE_EXPIRIES.map((value) => <option key={value} value={value}>{t(`sessionShare.expiry.${value}`)}</option>)}
            </select>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{t(`sessionShare.errors.${error}`)}</p>}
          <Button type="button" disabled={submitting} onClick={onSubmit}>
            {submitting ? t('sessionShare.creating') : t('sessionShare.create')}
          </Button>
        </div>
      ) : (
        <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t('sessionShare.ownerOnlyCreate')}
        </p>
      )}
    </div>
  );
}

function LiveShareFlow({ sessionId, canShare, onClose }: { sessionId: string; canShare: boolean; onClose: () => void }) {
  const { t } = useTranslation('chat');
  const [expiry, setExpiry] = useState<ShareExpiry>('7d');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [existing, setExisting] = useState<ShareSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadExisting = useCallback(async () => {
    setListError(null);
    try {
      setExisting((await listSessionShares(sessionId)).shares);
    } catch (caught) {
      setListError(shareErrorKey(caught));
    }
  }, [sessionId]);

  useEffect(() => { void loadExisting(); }, [loadExisting]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createShare(sessionId, { expiry });
      setCreatedUrl(result.shareUrl);
      announceSharesChanged();
      void loadExisting();
    } catch (caught) {
      setSubmitError(shareErrorKey(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {createdUrl
        ? <CreatedLink url={createdUrl} />
        : <CreateForm canShare={canShare} expiry={expiry} onExpiry={setExpiry}
            submitting={submitting} error={submitError} onSubmit={() => void submit()} />}
      <section aria-labelledby="share-existing-title" className="space-y-2 border-t border-border pt-3">
        <h3 id="share-existing-title" className="text-sm font-semibold text-foreground">{t('sessionShare.list.title')}</h3>
        {listError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-danger">{t(`sessionShare.errors.${listError}`)}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadExisting()}>{t('sessionShare.retry')}</Button>
          </div>
        )}
        {existing && (
          <ShareList shares={existing}
            onRevoked={(id) => setExisting((current) => current?.map((item) => (
              item.id === id ? { ...item, revokedAt: new Date().toISOString(), active: false } : item)) ?? null)} />
        )}
      </section>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>{createdUrl ? t('sessionShare.close') : t('sessionShare.cancel')}</Button>
      </div>
    </div>
  );
}

/** Live read-link dialog (ADR-205 D5). Its state, and so the one-time link, dies when it closes. */
export default function LiveShareDialog({ sessionId, canShare, open, onOpenChange }: Props) {
  const { t } = useTranslation('chat');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-labelledby="share-dialog-title"
        className="max-h-[92dvh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto p-4 sm:p-6"
      >
        <h2 id="share-dialog-title" className="mb-3 text-lg font-semibold text-foreground">{t('sessionShare.dialogTitle')}</h2>
        <LiveShareFlow sessionId={sessionId} canShare={canShare} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
